"""
Vv Transcribe 本地 ASR 服务
基于 FastAPI + faster-whisper 实现本地语音转写
- 首次调用时自动下载并加载宿主指定的 Whisper 档位（base 138MB / small 461MB，本机实测权重体积）
- 使用 hf-mirror.com 镜像加速国内下载
- 支持任意音频格式输入（内部通过 ffmpeg 转换为 16kHz WAV）
- /transcribe 返回 NDJSON 流：每转完一句立刻吐一行，供上层显示真实进度并逐句上屏
- 只绑 127.0.0.1，且宿主下发 VV_ASR_TOKEN 时 /transcribe 要求 Bearer 凭证（1.1.3 #353）
"""

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, Iterator
import gc
import hmac
import json
import os
import sys
import time
import subprocess
import tempfile
import numpy as np
import wave

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_DISABLE_XET'] = '1'

# 宿主用管道接管引擎 stdout，此时 Python 是块缓冲：print 不带 flush，这几句要等缓冲区满了
# 才成批发出去，app.log 里落的时刻是「送达」而不是「发生」（本机实测同一批行时间戳全同，见 README）
def log(msg: str):
    print(msg, file=sys.stdout, flush=True)

app = FastAPI(title="Vv Transcribe ASR Service")

# 这里刻意**没有** CORS 中间件。调用方是 Electron 主进程用 fetch 直连，它不是浏览器，
# 不吃同源策略——add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True)
# 那一段唯一的实际效果，是让任意网站上的任意脚本都能读本机 8000 端口的应答。
# 那个组合本身还不合法（浏览器会拒 * 与 credentials 同时出现），于是它既没给出可用的跨域，
# 又把「装了这台电脑的人」之外的读者放了进来。

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

# 访问凭证：宿主每次应用运行随机生成一份、经环境变量下发，只在开关打开时才有值
# （开关是 settings.json 根上的 asrEngineAuth，界面上没有那一格）。
# 关掉或手动起服务时它是空串，此时不校验——这是唯一的「不开门」例外，
# 写清楚是为了让下一个读代码的人知道：空串不代表忘了配，代表这一趟故意不设防。
#
# 绝不能拿上面那个 BOOT_ID 顶替：它由 /health 原样回显，任何连得上端口的人问一次就拿到了，
# 用它当凭证等于没修。BOOT_ID 答的是「端口上这个进程是不是我这次拉起来的」，
# 和「谁有资格让我转写一段音频」是两件事。
ASR_TOKEN = os.environ.get("VV_ASR_TOKEN", "")


def require_token(request: Request) -> None:
    """FastAPI 依赖：ASR_TOKEN 非空时，请求必须带 `Authorization: Bearer <ASR_TOKEN>`。"""
    if not ASR_TOKEN:
        return
    scheme, _, credential = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(credential.strip(), ASR_TOKEN):
        raise HTTPException(status_code=401, detail="Missing or invalid bearer token")


def load_model(name: str):
    global model, loaded_model_name
    if model is not None and loaded_model_name == name:
        return

    if model is not None:
        # 换档位时必须先放下旧模型：base+small 同时在内存里，低配机直接爆
        model = None
        loaded_model_name = ""
        gc.collect()

    log(f"[ASR] Loading Whisper model '{name}' (first run downloads ~{MODEL_WEIGHTS_MB[name]}MB)...")
    from faster_whisper import WhisperModel
    model = WhisperModel(name, device="cpu", compute_type="int8")
    loaded_model_name = name
    log(f"[ASR] Model loaded successfully: {name}")

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
        log(f"[ASR] Transcription completed in {elapsed:.2f}s, {count} segments")
        yield _event({"type": "done", "segments": count, "elapsed": round(elapsed, 2)})

    except Exception as e:
        # 响应头早已发出（200 + 流），失败只能作为事件下发，由上层转成用户可见的报错
        log(f"[ASR] Error: {e}")
        yield _event({"type": "error", "detail": str(e), "stage": stage})
    finally:
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)

@app.post("/transcribe", dependencies=[Depends(require_token)])
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

    log(f"[ASR] Transcribing: {request.audio_path} (language: {request.language}, model: {tier})")
    # 模型加载与推理都在生成器里做：响应头立刻发出，进度才能逐句流回宿主
    return StreamingResponse(
        _transcribe_events(request.audio_path, request.language, tier),
        media_type="application/x-ndjson",
    )

@app.get("/health")
async def health():
    # 这一条不设凭证，是刻意的：宿主要拿它认「端口上应答的是不是我这次拉起来的那一代」，
    # 那次握手发生在引擎刚起来、宿主还没决定要不要发任何带凭证的请求之前。
    # 它只回档位、协议号和本次 boot_id，一个字节的用户内容都没有。
    return {
        "status": "ok",
        "model_loaded": model is not None,
        # 宿主用它判断「引擎现在吃的是哪一档」：换档位后没重启引擎时，这里和目标对不上
        "model": loaded_model_name,
        "protocol": TRANSCRIBE_PROTOCOL,
        "boot_id": BOOT_ID,
    }

if __name__ == "__main__":
    import multiprocessing

    # PyInstaller onefile 下 multiprocessing 的子进程（本机实测是 resource_tracker，argv 为
    # `-c from multiprocessing.resource_tracker import main;main(14)`）会把这份入口脚本从头再跑
    # 一遍，包括下面的 uvicorn.run：于是每次转写都多冒一个抢 8000 失败才退出的进程。
    multiprocessing.freeze_support()

    import uvicorn

    # 端口可由宿主/冒烟改写，默认仍是 8000（应用内那条链路没设这个变量，行为一字不变）。
    # 加这一位是为了 tests/engineSmoke.test.ts：它要在开发者机器上拉起一份冻结二进制做握手校验，
    # 而 8000 很可能正被那个开着的应用占着——占着就得跳过，等于最该跑的那台机器上跑不到。
    port = int(os.environ.get("VV_ASR_PORT", "8000"))
    log(f"[ASR] Starting Vv Transcribe ASR service on http://127.0.0.1:{port}")
    # 只绑回环：这里吃的是本机盘上的音频路径，绑 0.0.0.0 等于把「谁能读这台电脑的素材」
    # 交给整个局域网。配音那边（python-tts/main.py）从第一天起就是 127.0.0.1。
    # 改这一行的同时要改宿主那边的请求地址：http://localhost 在有些机器上先解析到 ::1，
    # 而这份监听只覆盖 IPv4（宿主已跟着改成 127.0.0.1）。
    uvicorn.run(app, host="127.0.0.1", port=port)
