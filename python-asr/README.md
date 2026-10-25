# Vv Transcribe ASR Service

本地 Whisper 语音识别服务，基于 Python + FastAPI + faster-whisper。

正常情况下**不需要手动启动它**：Electron 主进程会 spawn 编译好的 `vv-asr-server[.exe]` 并下发本次的身份标识。下面的手动启动方式只用于调 Python 侧代码。

## 安装

```bash
# 仓库根目录
pnpm setup:asr          # 建 python-asr/venv 并装 requirements.txt（含 PyInstaller）

# 或手动
cd python-asr
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 启动服务

```bash
ASR_BOOT_ID=$(uuidgen) python main.py    # Windows PowerShell: $env:ASR_BOOT_ID=[guid]::NewGuid(); python main.py
```

服务监听 `http://localhost:8000`。

`ASR_BOOT_ID` 是宿主下发的本次身份标识，`/health` 原样回显。宿主只承认 `boot_id` 与 `protocol` 都对得上的应答，所以手动起的服务不会被应用采信——这不是 bug，是防止上一代没退干净的残尸（它的 PyInstaller 临时解包目录已被删）被当成可用引擎。

## API

### GET /health

```json
{ "status": "ok", "model_loaded": false, "model": "", "protocol": 2, "boot_id": "<ASR_BOOT_ID>" }
```

`protocol` 对应宿主的 `TRANSCRIBE_PROTOCOL`：`2` = `/transcribe` 返回 NDJSON 逐句流。`model` 是**此刻真正驻留在内存里的档位**（还没加载过是空串），宿主用它回答「引擎现在吃的是哪一档」——设置里刚改还没生效的值不算数。

### POST /transcribe

请求体：

```json
{ "audio_path": "/path/to/audio.wav", "language": "zh", "model": "base" }
```

`language` 传 Whisper 的语言码（`zh` / `en` / …），传 `"auto"` 表示不指定语言。`model` 是档位，只接受 `MODEL_WEIGHTS_MB` 白名单里的 `base` / `small`，别的直接 400——档位名会被 faster-whisper 拼成 HuggingFace repo 名，不拦就等于给 127.0.0.1 上的请求开了「任意模型名 → 任意 repo 下载」的口子。校验必须在流开始之前做：进了生成器响应头就已经是 200，那时只能以「转写失败」的形式冒出来。

响应是 `application/x-ndjson`，每行一个事件，按顺序为：

```
{"type":"status","stage":"loading_model","model":"small","weightsMb":461}   # 首次要下载模型，体积按档位给，宿主直接拿去显示
{"type":"start","duration":120.5}                             # info.duration，进度百分比的分母
{"type":"segment","startTime":0.0,"endTime":5.2,"text":"你好世界"}   # 转完一句立刻吐一行
...
{"type":"done","segments":42,"elapsed":18.31}
```

出错时下发 `{"type":"error","detail":"...","stage":"transcribing"}`。`stage` 是失败时所在的阶段（`loading_model` / `transcribing`），宿主只在该报「首下模型没完成」的阶段才那么说。响应头在推理开始前就已发出（200 + 流），失败只能作为事件回传，由上层转成用户可见的报错。

推理参数：`beam_size=5`、`vad_filter=True`，模型档位由请求体的 `model` 指定（`base` / `small`）、`device=cpu`、`compute_type=int8`；换档位时先放下旧模型再加载，两档同时在内存里低配机会爆。输入会先用 ffmpeg 转成 16kHz 单声道 WAV（`FFMPEG_PATH` 由宿主注入，因为打包环境里系统 PATH 上没有 ffmpeg；ffprobe 只用在 Electron 主进程那一侧）。

## 模型

首次转写会下载所选档位的 faster-whisper 权重（本机 HF 缓存实测 `model.bin`：`base` 138MB、`small` 461MB），走 `HF_ENDPOINT=https://hf-mirror.com`（国内直连 HuggingFace 常常拿不到），并关闭 Xet 通道。

速度也在这台机器上实测过（10 核 M 系、`device=cpu` + `int8`、105.59 秒中文素材、每档预热 1 次后计时 3 次）：`base` 9.1–16.5 秒（RTF 0.09–0.16x），`small` 26.6–30.3 秒（RTF 0.25–0.29x），按中位数是 `base` 的 2.83 倍。文本差异见应用仓库 `README.md` 的「本地模型档位」。

缓存位置：`~/.cache/huggingface/hub/models--Systran--faster-whisper-<档位>/snapshots/<rev>/model.bin`（宿主按**所选档位**的那条路径判断「权重是否已在本地」，命中时才给子进程下发 `HF_HUB_OFFLINE=1`，避免弱网下卡在版本检查请求上；这个开关在进程内改不了，所以换档位必须重启引擎）。

## 打包

```bash
# 仓库根目录
pnpm build:asr          # 本机架构 → python-asr/dist-<arch>/
pnpm build:asr:x64      # 经 Rosetta 用 x64 解释器构建
```

由 `scripts/build-asr.mjs` 调 PyInstaller（`vv-asr-server.spec`）。产物架构等于构建它的 Python 解释器架构，**无法交叉编译**。
