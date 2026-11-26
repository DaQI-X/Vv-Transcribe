/**
 * ASR 转写管理器
 * 转写引擎由设置里的「转写模式」(asrProvider) 决定：
 * 1. provider=cloud 且配置了 API Key、服务可用 → 云端转写（OpenAI Whisper API），失败时降级本地
 * 2. 其余情况（provider=local 为默认）→ 一律本地 Python ASR 服务（faster-whisper），
 *    **一次音频都不发出本机**（与 README「只有云端优先才会把音频交出去」同一句口径）。
 *    注意这里仍然会有网络请求：首次转写要取权重，取的是公开模型文件、不含用户内容
 *
 * 本地这一路在发请求之前还有一步「把权重先装好」（#435，见 fetchLocalWeights）：
 * 首转那 148/486MB 由应用自己的下载器取，进度回流到转写进度条，装不上才退回引擎那条老下载路。
 */
import type { ASRProgress, ASRSegment, ASROptions } from './types'
import { CloudASRProvider } from './cloudASR'
import { LocalASRProvider } from './localASR'
import { asrVendorUsesOrderFlow } from './asrVendor'
import {
  ensureLocalTier,
  getASRServiceStatus,
  restartLocalEngine,
  stopLocalEngineOnRequest,
} from '../asrServiceManager'
import { cancelInstall, installComponent, type ComponentProgress, type ComponentResult } from '../componentService'
import { isModelCached } from '../asrModelUsage'
import { normalizeLocalModel, type LocalModelTier } from '../settingsService'
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
  const vendor = (config.vendor as string) || ''
  const apiBase = (config.apiBase as string) || ''
  // 讯飞那一档地址留空时**不许**落回下面那个 OpenAI 默认地址：那等于把用户的音频
  // POST 到一个他没选过的服务商去（还是境外的一家）。「地址那一格没填」和「选了另一家」
  // 是两件事，混成一件是隐私事故，不是兜底
  if (asrVendorUsesOrderFlow(vendor) && !apiBase.trim()) return null
  return new CloudASRProvider({
    apiKey,
    apiBase: apiBase || 'https://api.openai.com',
    // 模型名不在这里兜底：留空时该落哪一档由厂商说了算（OpenAI 兼容是 whisper-1，
    // MiniMax 是 asr-1.0），在这儿写死一个 whisper-1 就等于替 MiniMax 猜它的清单
    model: (config.model as string) || '',
    vendor,
    // 这两把只有讯飞用（AppID + APISecret），走 multipart 的那几家读不到它们
    appId: (config.appId as string) || '',
    apiSecret: (config.apiSecret as string) || '',
  })
}

export interface TranscriptionResult {
  segments: ASRSegment[]
  provider: 'local' | 'cloud'
}

/**
 * 取件那一段在转写进度里占的那一小条（#435）。
 *
 * 上界必须低于引擎自己那条 `loading_model` 的 10%（见 localASR 里写死的那个数）：转写页的条子
 * 只往前走，装完权重那一刻若把 60% 交回给 10%，用户看到的是进度倒退，而那是这台机器上第一次
 * 真的能转写成功——最难解释的一种怪相。
 */
const FETCH_BAND = { from: 1, to: 9 }

/** 组件下载器的进度 → 转写进度：只有 download 那一段有分母，其余（verify）按「取件已收完」算 */
function fetchRatio(p: ComponentProgress): number {
  if (p.phase !== 'download') return 1
  return p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0
}

/**
 * 这一档的权重在两棵树上都不到时，先由应用自己把它装好（#435）。
 *
 * 为什么不直接让引擎去下载（1.2.4 及以前的唯一出路）：那条路宿主完全看不到进度——
 * 首转要拉 148MB（base）/ 486MB（small），界面只能钉在 10% 干等，弱网时等到超时回来的是一句
 * huggingface_hub 的英文原文。而应用装好那份吃的是 #433 的指纹表：逐文件 SHA256、`.part` 续传、
 * 镜像在前正站在后、换腿按字节判死，且 `status` 事件会自报 `modelSource: directory`（#436），
 * 加载那一步根本不碰网络。
 *
 * 顺序是「停引擎 → 装 → 重起」，这三步都不能省：
 * - 必须先停：那棵目录由组件面板的闸门看着（`asrBusyReason`），引擎进程还在就不许动——
 *   `promote` 用的是改名，Windows 上重命名一个被打开的文件必失败。此刻请求还没发给引擎，停是安全的。
 * - 必须重起：能不能读到刚装的目录，取决于 spawn 那一刻下发的 `VV_ASR_MODEL_DIR`（#434），
 *   不重起就等于白下一趟。
 * - 装失败**不拦路**：原样往下走，让引擎按老路子自己去 hf-mirror 拉。这里最坏的一种指纹表错误
 *   （上游换版、表钉的 commit 取不到件）恰恰是引擎那条活路径能兜住的，拿一次注定失败的下载
 *   把首转彻底堵死不是谨慎，是新增一个单点。
 */
async function fetchLocalWeights(
  tier: LocalModelTier,
  onProgress?: (progress: ASRProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  // 两棵树任一棵齐了就不动手：#434 之前本地转写过的老用户，权重躺在 HF 缓存里，
  // 这里再按指纹表拉一遍等于白占 148/486MB，还会让占用那一行变成两份（#421 报的是真账，真账就是两份）
  if (isModelCached(tier)) return

  const id = `asr-model-${tier}`
  const stopped = await stopLocalEngineOnRequest()
  if (!stopped.ok) {
    throw new Error(stopped.error ?? '本地转写引擎没能停下来，没法安全地替换模型权重')
  }

  // done/total 是「整批」口径（下载器把上一棒的字节数累加进 base，分母取清单那一条的总字节），
  // 所以这里能直接当比例用。只有 verify 那一次例外：它给的是 {done:0,total:1}，数的是「一件事」
  // 不是「一个字节」，透到界面就成了「0B / 1B」——那种回调不改字节数，只把条子推到段尾。
  // 一个字节都还没量到时干脆不带 download 这个字段：界面宁可少说半句，也不报「已取 0B」这种假数
  let bytes: { done: number; total: number } | null = null
  const report = (p: ComponentProgress) => {
    if (p.phase === 'download') bytes = { done: p.done, total: p.total }
    const ratio = fetchRatio(p)
    onProgress?.({
      percent: FETCH_BAND.from + ratio * (FETCH_BAND.to - FETCH_BAND.from),
      stage: 'downloading_model',
      model: { tier, weightsMb: null, ...(bytes ? { download: { ...bytes } } : {}) },
    })
  }
  const onCancel = () => {
    cancelInstall(id)
  }
  signal?.addEventListener('abort', onCancel, { once: true })

  let result: ComponentResult
  try {
    result = await installComponent(id, report)
  } finally {
    signal?.removeEventListener('abort', onCancel)
  }

  if (result.canceled) {
    // 取消那一下不该再等一次引擎重启（好几秒，而界面正卡在「取消中…」等这一单收尾，
    // 见 UploadStatus 那句「等 asr:start 以 canceled 结束」）。后台把它起回来，起不来只记日志
    void restartLocalEngine(tier).then(
      (back) => {
        if (!back.ok) logger.warn(TAG, 'Engine did not come back after the canceled download', { error: back.error })
      },
      (err: unknown) => {
        logger.warn(TAG, 'Engine restart after the canceled download failed', {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    )
    throw new Error('模型权重下载已取消')
  }

  const back = await restartLocalEngine(tier)
  // 装失败 + 起不来时两句都要：只报「引擎没起来」会把人支去重启应用，而真正坏的是那一趟下载
  const installNote = result.ok || !result.error ? '' : `（模型权重下载也没成：${result.error}）`
  if (!back.ok) {
    throw new Error(`${back.error ?? '本地转写引擎没能重新启动，请重新启动应用'}${installNote}`)
  }
  if (!result.ok) {
    logger.warn(TAG, 'App-side weight fetch failed, letting the engine download it', {
      id,
      message: result.error,
    })
    return
  }
  logger.info(TAG, 'Weights installed by the app downloader', { id })
  // 交棒给引擎那一段：这一刻条子停在 9%，文案从「下载」换成「装载」，随后引擎的 status 事件接手
  onProgress?.({ percent: FETCH_BAND.to, stage: 'loading_model', model: { tier, weightsMb: null } })
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
    // （键名不能叫 hasApiKey：那个名字会被日志脱敏按键名吃掉，见 logRedact.ts）
    logger.info(TAG, 'Cloud not selected or unavailable, using local transcription', {
      provider: config.provider,
      keyStatus: !!config.apiKey,
      // 讯飞那一档要三把凭据 + 一个地址才发得出去，缺一样就在这里落回本地。
      // 少了这一项，日志上看不出是「没选云端」还是「选了但没配齐」
      vendor: config.vendor,
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
  // 档位对不上就先换一次引擎：这个档位是全局段的 `asrLocalModel`，而引擎能不能联网下载权重
  // 是 spawn 时按当时的档位钉死的。停在这儿继续发请求，拿回来的是「模型没下载完」
  // 却又下不下来的死结（设置页换档要重启引擎，正是同一个理由；这里兜的是那次自动重启
  // 被跳过或失败的场合——转写任务在跑时保存不重启，下一次请求就得在这儿对齐）。
  const tier = normalizeLocalModel(config.localModel)
  // 先补齐权重再动引擎：这一步自己会停一次引擎，放在 ensureLocalTier 之后就是白停一次
  await fetchLocalWeights(tier, options.onProgress, options.signal)
  const aligned = await ensureLocalTier(tier)
  if (!aligned.ok) {
    throw new Error(aligned.error || '本地转写引擎没能切到这套配置要用的档位，请重试或重启应用')
  }
  const local = getLocalProvider()
  // 档位来自设置的 asrLocalModel，不是 asrModel：后者是云端模型名，用户填的是 API 服务商的型号
  const segments = await local.transcribe(wavPath, { ...options, localModel: tier })
  return { segments, provider: 'local' }
}
