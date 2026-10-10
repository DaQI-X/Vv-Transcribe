/**
 * ASR 转写管理器
 * 实现云端优先、本地兜底的转写策略：
 * 1. 若配置了云端 API Key 且服务可用，优先使用云端转写（OpenAI Whisper API）
 * 2. 云端不可用或失败时，自动降级到本地 Python ASR 服务（faster-whisper）
 */
import type { ASRProvider, ASRSegment, ASROptions, ASRProgress } from './types'
import { CloudASRProvider } from './cloudASR'
import { LocalASRProvider } from './localASR'

let localProvider: LocalASRProvider | null = null

function getLocalProvider(): LocalASRProvider {
  if (!localProvider) localProvider = new LocalASRProvider()
  return localProvider
}

function createCloudProvider(config: Record<string, unknown>): CloudASRProvider | null {
  const apiKey = config.apiKey as string
  if (!apiKey) return null
  return new CloudASRProvider({
    apiKey,
    apiBase: (config.apiBase as string) || 'https://api.openai.com',
    model: (config.model as string) || 'whisper-1',
  })
}

export interface TranscriptionResult {
  segments: ASRSegment[]
  provider: 'local' | 'cloud'
}

export async function runTranscription(
  wavPath: string,
  config: Record<string, unknown>,
  options: ASROptions & {
    onProgress?: (progress: ASRProgress) => void
    signal?: AbortSignal
  },
): Promise<TranscriptionResult> {
  const cloudProvider = createCloudProvider(config)

  if (cloudProvider && (await cloudProvider.isAvailable())) {
    console.log('[ASR] cloud provider available, trying cloud first...')
    try {
      options.onProgress?.({ percent: 2 })
      const segments = await cloudProvider.transcribe(wavPath, options)
      console.log('[ASR] cloud transcription succeeded')
      return { segments, provider: 'cloud' }
    } catch (err) {
      console.warn('[ASR] cloud transcription failed, falling back to local:', err)
    }
  } else {
    console.log('[ASR] no cloud API key, using local transcription')
  }

  console.log('[ASR] using local Whisper model...')
  const local = getLocalProvider()
  const segments = await local.transcribe(wavPath, options)
  return { segments, provider: 'local' }
}
