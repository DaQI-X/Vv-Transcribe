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
import { logger } from '../logger'

const TAG = 'ASRManager'

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
  // 仅存在 API Key（例如只为 AI 校对而填）不构成上传授权。
  const cloudProvider = config.provider === 'cloud' ? createCloudProvider(config) : null
  let cloudError: string | null = null

  if (cloudProvider && (await cloudProvider.isAvailable())) {
    logger.info(TAG, 'Cloud provider available, trying cloud first')
    try {
      options.onProgress?.({ percent: 2 })
      const segments = await cloudProvider.transcribe(wavPath, options)
      logger.info(TAG, 'Cloud transcription succeeded', { segments: segments.length })
      return { segments, provider: 'cloud' }
    } catch (err) {
      cloudError = err instanceof Error ? err.message : '云端转写失败'
      // 只取 message：云端那次失败的 stack 里带的是上传用的临时 wav 路径，对本机排查没别的作用
      logger.warn(TAG, 'Cloud transcription failed, falling back to local', { message: cloudError })
    }
  } else {
    // provider 是设置里的「转写模式」，用户以为自己选了云端时这一条就能看出是没选还是没配 Key
    logger.info(TAG, 'Cloud not selected or unavailable, using local transcription', {
      provider: config.provider,
      hasApiKey: !!config.apiKey,
    })
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

  logger.info(TAG, 'Using local Whisper model', { tier: config.localModel || 'base' })
  const local = getLocalProvider()
  // 档位来自设置的 asrLocalModel，不是 asrModel：后者是云端模型名，用户填的是 API 服务商的型号
  const segments = await local.transcribe(wavPath, { ...options, localModel: config.localModel as string | undefined })
  return { segments, provider: 'local' }
}
