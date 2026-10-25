"""
Vv Transcribe 本地 ASR 服务
基于 FastAPI + faster-whisper 实现本地语音转写
- 首次调用时自动下载并加载宿主指定的 Whisper 档位（base 138MB / small 461MB，本机实测权重体积）
- 使用 hf-mirror.com 镜像加速国内下载
- 支持任意音频格式输入（内部通过 ffmpeg 转换为 16kHz WAV）
- /transcribe 返回 NDJSON 流：每转完一句立刻吐一行，供上层显示真实进度并逐句上屏
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, Iterator
import gc
import json
import os
import time
import subprocess
import tempfile
import numpy as np
import wave

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_DISABLE_XET'] = '1'

app = FastAPI(title="Vv Transcribe ASR Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
loaded_model_name = ""

# 档位白名单，值是本机实测的权重体积（MB）。
# 必须白名单化：档位名会被 faster-whisper 直接拼成 HuggingFace repo 名，
# 不拦就等于给 localhost 上的请求开了「任意模型名 → 任意 repo 下载」的口子。
MODEL_WEIGHTS_MB = {"base": 138, "small": 461}

# /transcribe 的协议版本：2 表示 NDJSON 逐句流式。旧版一次性返回 JSON，
# 宿主靠这个字段拒绝复用端口上残留的旧服务，否则会拿到「不完整结果」这种莫名其妙的报错
TRANSCRIBE_PROTOCOL = 2

# 本次启动的身份标识，由宿主通过环境变量下发，/health 原样回显。
# 宿主只有看到自己给的这个 id 才认为「8000 上的就是我刚拉起的那个引擎」，
# 否则端口上任何应答都可能是上一代没退干净的残尸——它能应答 /health，
# 但 PyInstaller 的临时解包目录已经被父进程删掉，懒加载的模块必然报错。
BOOT_ID = os.environ.get("ASR_BOOT_ID", "")

def load_model(name: str):
    global model, loaded_model_name
    if model is not None and loaded_model_name == name:
        return

    if model is not None:
        # 换档位时必须先放下旧模型：base+small 同时在内存里，低配机直接爆
        model = None
        loaded_model_name = ""
        gc.collect()

    print(f"[ASR] Loading Whisper model '{name}' (first run downloads ~{MODEL_WEIGHTS_MB[name]}MB)...")
    from faster_whisper import WhisperModel
    model = WhisperModel(name, device="cpu", compute_type="int8")
    loaded_model_name = name
    print(f"[ASR] Model loaded successfully: {name}")

def convert_to_16k_wav(input_path: str) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    ffmpeg_bin = os.environ.get("FFMPEG_PATH", "ffmpeg")
    subprocess.run([
        ffmpeg_bin, "-i", input_path,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        "-y", tmp.name
    ], capture_output=True, check=True)
    return tmp.name

def read_wav_as_float32(wav_path: str) -> np.ndarray:
    with wave.open(wav_path, "rb") as f:
        n_channels = f.getnchannels()
        sampwidth = f.getsampwidth()
        n_frames = f.getnframes()
        raw = f.readframes(n_frames)

    if sampwidth == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        samples = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    return samples

class TranscribeRequest(BaseModel):
    audio_path: str
    language: Optional[str] = "zh"
    model: Optional[str] = "base"

def _event(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False) + "\n"

def _transcribe_events(audio_path: str, language: Optional[str], model_name: str) -> Iterator[str]:
    """逐句产出 NDJSON 事件。同步生成器，Starlette 会放进线程池迭代，不阻塞事件循环。"""
    wav_path = None
    started = time.time()
    # 出错时把「挂在哪一步」原样带出去。宿主只见过 status 事件就断言「是模型下载失败」的话，
    # ffmpeg 抽音频失败也会被报成「首次下载的模型没下来」——那是把人往错的网络上引
    stage = "loading_model"
    try:
        # 首次转写要下载档位对应的权重（base 138MB / small 461MB），先下发状态让宿主给出可见说明，
        # 别让用户对着不动的进度条干等；体积按档位给，笼统说「约 150MB」会对 small 用户撒谎
        yield _event({
            "type": "status",
            "stage": stage,
            "model": model_name,
            "weightsMb": MODEL_WEIGHTS_MB[model_name],
        })
        load_model(model_name)
        stage = "transcribing"

        wav_path = convert_to_16k_wav(audio_path)
        audio_data = read_wav_as_float32(wav_path)

        segments_raw, info = model.transcribe(
            audio_data,
            language=language if language != "auto" else None,
            beam_size=5,
            vad_filter=True,
        )

        # info.duration 在生成器被消费之前就可拿到，是进度百分比的分母
        yield _event({"type": "start", "duration": info.duration})

        count = 0
        for segment in segments_raw:
            count += 1
            yield _event({
                "type": "segment",
                "startTime": segment.start,
                "endTime": segment.end,
                "text": segment.text.strip(),
            })

        elapsed = time.time() - started
        print(f"[ASR] Transcription completed in {elapsed:.2f}s, {count} segments")
        yield _event({"type": "done", "segments": count, "elapsed": round(elapsed, 2)})

    except Exception as e:
        # 响应头早已发出（200 + 流），失败只能作为事件下发，由上层转成用户可见的报错
        print(f"[ASR] Error: {e}")
        yield _event({"type": "error", "detail": str(e), "stage": stage})
    finally:
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)

@app.post("/transcribe")
def transcribe(request: TranscribeRequest):
    if not os.path.exists(request.audio_path):
        raise HTTPException(status_code=400, detail=f"Audio file not found: {request.audio_path}")

    # 档位必须在流开始之前校验：进了生成器响应头就已经是 200，那时只能以「转写失败」的形式冒出来
    tier = request.model or "base"
    if tier not in MODEL_WEIGHTS_MB:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model '{tier}', expected one of: {', '.join(sorted(MODEL_WEIGHTS_MB))}",
        )

    print(f"[ASR] Transcribing: {request.audio_path} (language: {request.language}, model: {tier})")
    # 模型加载与推理都在生成器里做：响应头立刻发出，进度才能逐句流回宿主
    return StreamingResponse(
        _transcribe_events(request.audio_path, request.language, tier),
        media_type="application/x-ndjson",
    )

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        # 宿主用它判断「引擎现在吃的是哪一档」：换档位后没重启引擎时，这里和目标对不上
        "model": loaded_model_name,
        "protocol": TRANSCRIBE_PROTOCOL,
        "boot_id": BOOT_ID,
    }

if __name__ == "__main__":
    import uvicorn
    print("[ASR] Starting Vv Transcribe ASR service on http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
