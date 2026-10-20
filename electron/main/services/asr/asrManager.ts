/**
 * ASR 转写管理器
 * 转写引擎由设置里的「转写模式」(asrProvider) 决定：
 * 1. provider=cloud 且配置了 API Key、服务可用 → 云端转写（OpenAI Whisper API），失败时降级本地
 * 2. 其余情况（provider=local 为默认）→ 一律本地 Python ASR 服务（faster-whisper），不发出任何网络请求
 */
import type { ASRSegment, ASROptions, ASRProgress } from './types'
import { CloudASRProvider } from './cloudASR'
import { LocalASRProvider } from './localASR'
import { getASRServiceStatus } from '../asrServiceManager'

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
  // 只有用户显式选择「云端优先」才允许把音频发出本机。
  // 仅存在 API Key（例如只为 AI 纠错而填）不构成上传授权。
  const cloudProvider = config.provider === 'cloud' ? createCloudProvider(config) : null
  let cloudError: string | null = null

  if (cloudProvider && (await cloudProvider.isAvailable())) {
    console.log('[ASR] cloud provider available, trying cloud first...')
    try {
      options.onProgress?.({ percent: 2 })
      const segments = await cloudProvider.transcribe(wavPath, options)
      console.log('[ASR] cloud transcription succeeded')
      return { segments, provider: 'cloud' }
    } catch (err) {
      cloudError = err instanceof Error ? err.message : '云端转写失败'
      console.warn('[ASR] cloud transcription failed, falling back to local:', err)
    }
  } else {
    console.log('[ASR] cloud not selected or unavailable (provider=%s), using local transcription', config.provider)
  }

  const status = getASRServiceStatus()
  if (!status.ready) {
    // 云端失败后本地也不可用时，两条原因都要给出，否则真实失败原因会被掩盖
    throw new Error(
      cloudError
        ? `云端转写失败：${cloudError}；本地转写引擎也不可用（${status.error}）`
        : status.error || '本地转写引擎未运行，请重新启动应用',
    )
  }

  console.log('[ASR] using local Whisper model...')
  const local = getLocalProvider()
  const segments = await local.transcribe(wavPath, options)
  return { segments, provider: 'local' }
}
