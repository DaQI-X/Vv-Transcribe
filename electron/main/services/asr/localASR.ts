/**
 * 本地 ASR 转写提供者
 * 通过 HTTP 调用本地 Python ASR 服务（faster-whisper + FastAPI，运行在 localhost:8000）
 * 支持进度回调和任务取消
 */
import type { ASRProvider, ASRSegment, ASRProgress } from './types'

const PYTHON_ASR_URL = 'http://localhost:8000'

export class LocalASRProvider implements ASRProvider {
  readonly name = 'local'
  readonly type = 'local' as const
  private cancelled = false

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${PYTHON_ASR_URL}/health`, { 
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      })
      return response.ok
    } catch (err) {
      console.warn('[LocalASR] Python service not available:', err)
      return false
    }
  }

  async transcribe(
    audioFilePath: string,
    options: {
      language?: string
      onProgress?: (progress: ASRProgress) => void
      signal?: AbortSignal
    },
  ): Promise<ASRSegment[]> {
    this.cancelled = false

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        this.cancelled = true
      })
    }

    options.onProgress?.({ percent: 10 })

    console.log('[LocalASR] Calling Python ASR service:', { audioFilePath, language: options.language })

    try {
      const response = await fetch(`${PYTHON_ASR_URL}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_path: audioFilePath,
          language: options.language || 'zh',
        }),
        signal: options.signal,
      })

      if (this.cancelled) throw new Error('转写已取消')

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || `Python ASR service error: ${response.status}`)
      }

      const result = await response.json()

      if (this.cancelled) throw new Error('转写已取消')

      options.onProgress?.({ percent: 90 })

      const segments: ASRSegment[] = result.segments.map((seg: any) => ({
        startTime: seg.startTime,
        endTime: seg.endTime,
        text: seg.text,
      }))

      console.log('[LocalASR] Transcription completed, segments:', segments.length)
      
      // Send each segment through progress callback
      for (let i = 0; i < segments.length; i++) {
        if (this.cancelled) throw new Error('转写已取消')
        const progress = 90 + (i / segments.length) * 10
        options.onProgress?.({ 
          percent: progress,
          segment: segments[i]
        })
      }
      
      options.onProgress?.({ percent: 100 })

      return segments
    } catch (err) {
      console.error('[LocalASR] Transcription error:', err)
      throw err
    }
  }

  cancel(): void {
    this.cancelled = true
  }
}
