# Vv Transcribe ASR Service

本地 Whisper 语音识别服务，基于 Python + FastAPI + faster-whisper。

## 安装

```bash
cd python-asr
pip install -r requirements.txt
```

## 启动服务

```bash
python main.py
```

服务将在 `http://localhost:8000` 启动。

## API

### POST /transcribe

转写音频文件。

**请求体：**
```json
{
  "audio_path": "/path/to/audio.wav",
  "language": "zh"
}
```

**响应：**
```json
{
  "success": true,
  "segments": [
    {
      "startTime": 0.0,
      "endTime": 5.2,
      "text": "你好世界"
    }
  ],
  "duration": 120.5,
  "provider": "local-python"
}
```

### GET /health

健康检查。

## 模型

首次运行会自动下载 Whisper base 模型（约 150MB），后续运行会使用缓存。

模型缓存在 `~/.cache/huggingface/` 目录。
