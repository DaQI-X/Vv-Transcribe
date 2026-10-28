"""
Vv Transcribe 本地配音服务（TTS sidecar）

和 ASR 那份的四点不同，都是有意的：
- 只绑 127.0.0.1。ASR 当年绑了 0.0.0.0，等于把「让这台机器合成任意文本」开在同网段所有人面前，
  新服务不再重复这个决定。
- 模型不随包。引擎 wheel 只有 9–16MB，模型 129–409MB，所以模型目录由宿主按需下载后用
  VV_TTS_MODEL_DIR 指进来；这里只认白名单里的引擎 id。
- 回的是 WAV 字节 + 精确采样数。云端那条要 ffprobe 读 mp3 容器估时长（随包 ffmpeg 是 2018 的构建，
  估出来的东西会偏），本地这条路不需要估。宿主侧铺轴只能用这个精确时长，不能指望「同一段文字下次还这么长」：
  2026-10-28 本机实测，VITS 同文本同音色同语速连跑四次，时长在 2.35–2.67 秒之间抖（±6%），
  Kokoro 抖 0.1%——sherpa-onnx 2.0.1 的 GenerationConfig 里没有 seed / noise_scale 字段，钉不住。
- 一个进程只服务一个引擎（VV_TTS_ENGINE 在启动时钉死）。ASR 那份是同进程换档位、把旧的 gc 掉，
  这条路不能照抄：2026-10-28 本机实测（M4，4 线程）VITS 单进程稳定 370MB、Kokoro 单进程 878MB，
  但同进程先从 Kokoro 切回 VITS 后停在 991MB——onnxruntime 的 arena 不还内存，只退回 103MB。
  也就是说「换引擎」实际上会变成「两份模型一直背着走」，而本地配音和本地转写是可以同时开的。
  所以换引擎由宿主重起进程来做（空载 57MB、加载 0.22–0.86 秒，代价比内存账便宜），这里对不匹配的
  请求直接 409，绝不静默加载第二个引擎。
- 自己的日志逐行 flush。2026-10-28 打冻结包实测：onefile 进程的非 tty stdout 是块缓冲的，
  「启动被拒」「加载耗时」这几行会压在缓冲区里几十秒不出来——宿主按启动失败收尾时，日志里刚好
  是最需要看到的那几行。宿主侧读的是 stdout 管道，不是终端，所以这条对打包前后都成立。
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import os
import sys
import time
import wave
import io
from array import array


def log(msg: str):
    print(msg, file=sys.stdout, flush=True)


app = FastAPI(title="Vv Transcribe TTS Service")

# /synthesize 的协议版本：改请求或响应字段时 +1，宿主靠它拒绝复用旧残尸（同 ASR 的教训）
TTS_PROTOCOL = 1

# 宿主下发的本次身份标识，/health 原样回显；端口上应答的不是这个 id，就不算「我起的引擎」
BOOT_ID = os.environ.get("VV_TTS_BOOT_ID", "")

# 本进程唯一服务的引擎，宿主启动时钉死；请求里带别的引擎一律 409（原因见文件头第四条）
BOUND_ENGINE = os.environ.get("VV_TTS_ENGINE", "").strip()

# 推理线程数：本机实测 4 线程 RTF 0.13（VITS）/ 0.25（Kokoro）。给多了会和转写抢核，
# 界面卡不卡比再快 0.05 的 RTF 重要，所以默认压在 4。
NUM_THREADS = int(os.environ.get("VV_TTS_THREADS", "4"))

# 一次请求的文本上限：宿主侧已经按句读切成 ≤800 字的块，这里只是兜住「绕过宿主直接打 localhost」的情况
MAX_CHARS = 2000

# OpenAI 标准 speed 的取值范围，和云端那条保持一致，避免同一个界面两套倍速语义
SPEED_MIN, SPEED_MAX = 0.25, 4.0

"""
引擎白名单。id 就是模型解压后的目录名，直接对齐上游 HuggingFace 仓库名——
宿主按清单下载、解压，落进 VV_TTS_MODEL_DIR/<id> 就不用再改名对位了。
id 也只接受这里列出的值，绝不能拿外部输入拼目录名（ASR 那边档位名直接拼 HF repo 名，
同样的口子不开第二次）。

weightsMb 是给用户看「要下多少」的账，2026-10-28 本机 du -shL 实测。
files 与 fsts 都是硬要求：少一个 .fst 不会报错，只会让「2026 年」这类读法悄悄退化成逐字念，
那种降级比失败更难发现。speakers 不写死，以引擎加载后的 num_speakers 为准
（sid → 音色名表在宿主的清单里，服务只管 sid 边界）。
"""
ENGINES = {
    "sherpa-onnx-vits-zh-ll": {
        "kind": "vits",
        "weightsMb": 129,
        "files": {
            "model": "model.onnx",
            "tokens": "tokens.txt",
            "lexicon": "lexicon.txt",
            "dict_dir": "dict",
        },
        "fsts": ["date.fst", "number.fst", "phone.fst", "new_heteronym.fst"],
    },
    "kokoro-multi-lang-v1_1": {
        "kind": "kokoro",
        "weightsMb": 409,
        "files": {
            "model": "model.onnx",
            "tokens": "tokens.txt",
            "voices": "voices.bin",
            "lexicon": "lexicon-zh.txt,lexicon-us-en.txt,lexicon-gb-en.txt",
            "dict_dir": "dict",
            "data_dir": "espeak-ng-data",
        },
        "fsts": ["date-zh.fst", "number-zh.fst", "phone-zh.fst"],
    },
}


def model_dir(engine_id: str) -> str:
    root = os.environ.get("VV_TTS_MODEL_DIR", "")
    if not root:
        raise HTTPException(status_code=503, detail="宿主未指定 VV_TTS_MODEL_DIR，本地配音不可用")
    return os.path.join(root, engine_id)


def require_files(engine_id: str, spec: dict, base: str):
    """缺文件要说清缺哪个：模型是下载解压来的，少一份词表是常事，不能让人去猜"""
    missing = []
    for value in spec["files"].values():
        # lexicon 可以是逗号分隔的多份，逐份查
        for part in value.split(","):
            if not os.path.exists(os.path.join(base, part)):
                missing.append(part)
    for fst in spec["fsts"]:
        if not os.path.exists(os.path.join(base, fst)):
            missing.append(fst)
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"模型 {engine_id} 缺少文件：{', '.join(missing)}（目录 {base}）",
        )


tts = None


def load_engine():
    """惰性加载本进程绑定的那一个引擎，加载后常驻（见文件头第四条）"""
    global tts

    if tts is not None:
        return tts

    import sherpa_onnx

    engine_id = BOUND_ENGINE
    spec = ENGINES[engine_id]
    base = model_dir(engine_id)
    require_files(engine_id, spec, base)
    paths = {
        key: ",".join(os.path.join(base, p) for p in value.split(","))
        for key, value in spec["files"].items()
    }
    fsts = ",".join(os.path.join(base, f) for f in spec["fsts"])

    t0 = time.time()
    if spec["kind"] == "vits":
        model_cfg = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=paths["model"],
            tokens=paths["tokens"],
            lexicon=paths["lexicon"],
            data_dir=paths.get("data_dir", ""),
            dict_dir=paths.get("dict_dir", ""),
        )
        kwargs = {"vits": model_cfg}
    elif spec["kind"] == "kokoro":
        model_cfg = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=paths["model"],
            tokens=paths["tokens"],
            voices=paths["voices"],
            lexicon=paths["lexicon"],
            dict_dir=paths.get("dict_dir", ""),
            data_dir=paths.get("data_dir", ""),
            lang="zh",
        )
        kwargs = {"kokoro": model_cfg}
    else:  # 白名单里不该出现别的 kind，出现了就是这份文件和清单没对齐
        raise HTTPException(status_code=500, detail=f"未知的引擎类型 {spec['kind']}")

    try:
        tts = sherpa_onnx.OfflineTts(
            sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(num_threads=NUM_THREADS, **kwargs),
                rule_fsts=fsts,
            )
        )
    except Exception as e:
        # sherpa 的报错是 C++ 抛的一长串，原样甩给用户毫无意义，但日志里要留全
        log(f"[TTS] load failed engine={engine_id}: {e}")
        raise HTTPException(status_code=500, detail=f"本地配音引擎加载失败：{engine_id}（详见日志）")

    log(f"[TTS] Loaded {engine_id} in {time.time() - t0:.2f}s speakers={tts.num_speakers} rate={tts.sample_rate}")
    return tts


def to_wav(samples, sample_rate: int) -> bytes:
    """float 序列 [-1,1] → 16bit 单声道 WAV，写内存不落盘。

    逐样本换算而不是 numpy：2026-10-28 本机实测 8 秒音频 13.8ms（numpy 2.9ms），
    3 分钟音频 208ms——相对同一段约 25 秒的合成时间可以忽略，换来的是 sidecar 少背
    一个约 25MB 的原生依赖和一个要钉的传递依赖版本号。
    另外换算式与 spike 里生成试听样本（用户已听过并选定口味的那批 out-*.wav）那份一致：
    2026-10-28 在同一段 90635 个采样上比过，两条路径输出 181270 字节全等，换写法不会换掉音色。
    """
    pcm = array("h", (max(-32768, min(32767, int(s * 32767))) for s in samples))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class SynthesizeRequest(BaseModel):
    engine: str
    text: str
    sid: int = 0
    speed: float = 1.0


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    # 这里是同步 def，不是 async def：一次合成要占满推理线程几十到几百毫秒，
    # 挂在事件循环上会让 /health 一起卡住，宿主那边轮询存活就会误判「引擎挂了」。
    # ASR 那份同理（def transcribe / async def health）。
    engine = req.engine.strip()
    if engine not in ENGINES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported engine '{engine}', expected one of: {', '.join(sorted(ENGINES))}",
        )
    # 本进程只服务启动时钉死的那一个引擎（原因见文件头第四条）。
    # 这里返回 409 而不是「顺手把另一个也加载了」：静默加载等于把内存账藏进界面。
    if engine != BOUND_ENGINE:
        raise HTTPException(
            status_code=409,
            detail=f"本地配音服务当前绑定 {BOUND_ENGINE or '（未设置）'}，请求的是 {engine}；换引擎请先让宿主重启该服务",
        )

    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 为空，没有可合成的内容")
    if len(text) > MAX_CHARS:
        raise HTTPException(status_code=413, detail=f"单次文本超过 {MAX_CHARS} 字，请在宿主侧分块")

    engine_tts = load_engine()

    if not 0 <= req.sid < engine_tts.num_speakers:
        raise HTTPException(
            status_code=400,
            detail=f"音色 {req.sid} 不在 {engine} 的 0–{engine_tts.num_speakers - 1} 范围内",
        )
    speed = min(max(req.speed, SPEED_MIN), SPEED_MAX)

    t0 = time.time()
    audio = engine_tts.generate(text, sid=req.sid, speed=speed)
    wall_ms = int((time.time() - t0) * 1000)

    samples = audio.samples  # sherpa 交回来的是普通 float list，直接进 to_wav
    rate = int(engine_tts.sample_rate)
    if len(samples) == 0:
        # 空音频在云端那条里被当成「按字幕槽位估算」，本地不需要也不能估算：直接报错
        raise HTTPException(status_code=502, detail=f"引擎 {engine} 返回了 0 个采样")

    return Response(
        content=to_wav(samples, rate),
        media_type="audio/wav",
        headers={
            "X-Vv-Samples": str(len(samples)),
            "X-Vv-Sample-Rate": str(rate),
            "X-Vv-Duration": f"{len(samples) / rate:.6f}",
            "X-Vv-Wall-Ms": str(wall_ms),
            "X-Vv-Engine": engine,
        },
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        # engine = 本进程绑定的引擎；engine_loaded = 模型是否真的在内存里
        "engine": BOUND_ENGINE or None,
        "engine_loaded": BOUND_ENGINE if tts is not None else None,
        "speakers": int(tts.num_speakers) if tts is not None else 0,
        "sample_rate": int(tts.sample_rate) if tts is not None else 0,
        "engines": sorted(ENGINES),
        "protocol": TTS_PROTOCOL,
        "boot_id": BOOT_ID,
    }


if __name__ == "__main__":
    import uvicorn

    if BOUND_ENGINE not in ENGINES:
        # 不拦下来的话，这个进程会一边应答 /health 一边对每个请求报 503，看起来像「引擎坏了」；
        # 直接带着明确原因退出，宿主的启动失败路径能把话说清楚
        log(f"[TTS] 启动被拒：VV_TTS_ENGINE=「{BOUND_ENGINE}」不在白名单 {sorted(ENGINES)} 中")
        raise SystemExit(2)
    log(f"[TTS] engine={BOUND_ENGINE} threads={NUM_THREADS} boot_id={BOOT_ID} model_dir={os.environ.get('VV_TTS_MODEL_DIR', '')}")
    port = int(os.environ.get("VV_TTS_PORT", "8010"))
    log(f"[TTS] Starting Vv Transcribe TTS service on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)
