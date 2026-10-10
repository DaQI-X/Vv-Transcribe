"""
Vv Transcribe 本地 ASR 服务
基于 FastAPI + faster-whisper 实现本地语音转写
- 首次调用时自动下载并加载 Whisper base 模型（~150MB）
- 使用 hf-mirror.com 镜像加速国内下载
- 支持任意音频格式输入（内部通过 ffmpeg 转换为 16kHz WAV）
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
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

def load_model():
    global model
    if model is None:
        print("[ASR] Loading Whisper model (first run will download ~150MB)...")
        from faster_whisper import WhisperModel
        model = WhisperModel("base", device="cpu", compute_type="int8")
        print("[ASR] Model loaded successfully")

def convert_to_16k_wav(input_path: str) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    subprocess.run([
        "ffmpeg", "-i", input_path,
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

class Segment(BaseModel):
    startTime: float
    endTime: float
    text: str

class TranscribeResponse(BaseModel):
    success: bool
    segments: List[Segment]
    duration: float
    provider: str = "local-python"

@app.post("/transcribe")
async def transcribe(request: TranscribeRequest):
    wav_path = None
    try:
        load_model()

        if not os.path.exists(request.audio_path):
            raise HTTPException(status_code=400, detail=f"Audio file not found: {request.audio_path}")

        print(f"[ASR] Transcribing: {request.audio_path} (language: {request.language})")
        start_time = time.time()

        wav_path = convert_to_16k_wav(request.audio_path)
        audio_data = read_wav_as_float32(wav_path)
        sample_rate = 16000

        segments_raw, info = model.transcribe(
            audio_data,
            language=request.language if request.language != "auto" else None,
            beam_size=5,
            vad_filter=True,
        )

        segments = []
        for segment in segments_raw:
            segments.append(Segment(
                startTime=segment.start,
                endTime=segment.end,
                text=segment.text.strip()
            ))

        duration = time.time() - start_time
        print(f"[ASR] Transcription completed in {duration:.2f}s, {len(segments)} segments")

        return TranscribeResponse(
            success=True,
            segments=segments,
            duration=info.duration
        )

    except Exception as e:
        print(f"[ASR] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model is not None}

if __name__ == "__main__":
    import uvicorn
    print("[ASR] Starting Vv Transcribe ASR service on http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
