/**
 * 设置持久化 IPC 处理器
 * 提供设置的读取、保存，以及「测试连接 / 检查引擎状态」接口
 * 数据存储在 userData/settings.json；三把 API Key 只在主进程解密，回给界面的一律是脱敏视图
 */
import { ipcMain } from 'electron'
import {
  getSettingsView,
  loadSettings,
  saveSettings,
  normalizeLocalModel,
  normalizeTtsEngine,
  SettingsWriteBlockedError,
  type LocalModelTier,
  type SettingsPatch,
  type SettingsView,
} from '../services/settingsService'
import { restartLocalEngine } from '../services/asrServiceManager'
import { hasActiveTranscription } from './asrHandlers'
import {
  testASRConfig,
  testAIConfig,
  testTTSConfig,
  type AsrTestValues,
  type AITestValues,
  type TTSTestValues,
  type TestOutcome,
} from '../services/connectionTestService'
import { logger } from '../services/logger'

/** 保存档位改动后，本地引擎要不要重启、有没有重启成功 */
export type TierRestartOutcome = 'not-needed' | 'done' | 'busy' | 'failed'

export interface SaveSettingsResult {
  settings: SettingsView
  tierRestart: TierRestartOutcome
  /** tierRestart 为 failed 时可直接展示给用户的原因 */
  error: string | null
  /**
   * 这次没能写进磁盘，可直接展示给用户的原因；null＝真的存下了。
   * 界面必须靠它决定接下来做什么：写盘失败却照旧清空 Key 输入框、报「设置已保存」，
   * 就是当面撒慌——而磁盘上那份配置还是旧的（甚至一份都没有）。
   */
  saveError: string | null
}

/**
 * 换档位必须重启引擎：HF_HUB_OFFLINE 是在 spawn 时按「旧档位有没有缓存」定下来的，
 * 运行中改不了。用户从已缓存的 base 切到没下载过的 small，引擎仍带着离线标志，
 * 首次转写会报「模型没下载完」却又下不下来，是个自己解不开的死结。
 */
async function applyTierChange(before: LocalModelTier, after: LocalModelTier): Promise<TierRestartOutcome> {
  if (before === after) return 'not-needed'
  // 重启会截断正在推的 NDJSON 流，半截结果比报错更糟，所以宁可让这一步晚点生效
  if (hasActiveTranscription()) return 'busy'
  return (await restartLocalEngine()).ok ? 'done' : 'failed'
}

/** 除 done/not-needed 外都必须让用户看见：档位此刻其实还没吃到 */
const TIER_RESTART_MESSAGE: Partial<Record<TierRestartOutcome, string>> = {
  busy: '档位已保存，但有转写正在跑，重启引擎会中断它。等这次转写结束后点「重启本地引擎」，新档位才会生效',
  failed: '档位已保存，但本地引擎没能自动重启。点「重启本地引擎」再试一次，成功后新档位才生效',
}

/** 密文解不开＝这台机器读不出那把 Key（换过电脑或系统密钥库被清过）；说「还没填」会让人以为是自己漏填 */
const UNREADABLE_KEY_MESSAGE =
  '这台机器读不出已保存的 API Key（可能换过电脑，或系统密钥库被清过）。重新填一次并保存即可'

/**
 * 写盘失败要说人话。闸门那句话（SettingsWriteBlockedError）本来就是按「为什么拦」挑的措辞，
 * 原样透出去；其余的（ENOSPC、EACCES、只读介质）带着 errno 文本，再加一句「你填的还在界面上」，
 * 免得用户以为白填了一遍去重填。
 */
function saveErrorMessage(err: unknown): string {
  if (err instanceof SettingsWriteBlockedError) return err.message
  const message = err instanceof Error ? err.message : String(err)
  return `设置没能写入（${message}）。界面上填的内容还在，不用重填；清出磁盘空间或修好目录权限后再存一次`
}

export function registerSettingsHandlers() {
  // 脱敏视图：密钥字段在这里就不再返回明文，渲染层拿到的是「有没有、能不能用、是不是明文」
  ipcMain.handle('settings:get', async (): Promise<SettingsView> => {
    return getSettingsView()
  })

  ipcMain.handle(
    'settings:save',
    async (
      _event,
      // 界面上的 Key 输入框留空＝不改，显式清除走 null，非空才是替换（见 saveSettings）。
      // 类型必须和 saveSettings 用同一个：这里写宽了 IPC 收得下、那边收不住，
      // 「清除 Key」按钮的 null 会在跨进程之后变成 undefined，用户看到的是没删掉
      patch: SettingsPatch
    ): Promise<SaveSettingsResult> => {
      try {
        const before = normalizeLocalModel((await loadSettings()).asrLocalModel)
        const saved = await saveSettings(patch)
        const tierRestart = await applyTierChange(before, normalizeLocalModel(saved.asrLocalModel))
        return { settings: saved, tierRestart, error: TIER_RESTART_MESSAGE[tierRestart] ?? null, saveError: null }
      } catch (err) {
        // 不跨 IPC 抛错：让渲染层拿到一句可以直接弹的话，而不是一个它接不住的 reject
        const saveError = saveErrorMessage(err)
        logger.error('Settings', 'settings:save did not reach the disk', saveError)
        return { settings: await getSettingsView(), tierRestart: 'not-needed', error: null, saveError }
      }
    }
  )

  ipcMain.handle(
    'settings:testConnection',
    async (
      _event,
      kind: 'asr' | 'ai' | 'tts',
      values: AsrTestValues | AITestValues | TTSTestValues
    ) => {
      try {
        // 配音这一腿的回落口径必须与 getTTSConfig 一致：接口地址与 Key 留空时用的是校对那套。
        // 测试不跟着回落就会出现「自检报没填、点开始配音却跑得通」这种最难解释的分歧。
        // 但本地配音档例外：Key 与地址根本不参与这一档，跟着回落等于把能用的人拦在门外（#220/#227）。
        const formKey = String((values as { apiKey?: unknown }).apiKey ?? '')
        const formBase = String((values as { apiBase?: unknown }).apiBase ?? '')
        const isLocalTTS =
          kind === 'tts' && normalizeTtsEngine((values as { engine?: unknown }).engine) === 'local'
        const needSavedKey = !isLocalTTS && !formKey.trim()
        const needSavedBase = !isLocalTTS && kind === 'tts' && !formBase.trim()
        let probe = values
        if (needSavedKey || needSavedBase) {
          const view = await getSettingsView()
          const saved = await loadSettings()
          const effectiveKey =
            kind === 'tts'
              ? saved.ttsApiKey || saved.aiApiKey
              : kind === 'ai'
                ? saved.aiApiKey
                : saved.asrApiKey
          const statuses =
            kind === 'tts'
              ? [view.ttsKeyStatus, view.aiKeyStatus]
              : [kind === 'ai' ? view.aiKeyStatus : view.asrKeyStatus]
          if (needSavedKey && !effectiveKey && statuses.includes('unreadable')) {
            return {
              level: 'fail' as const,
              title: '还测不了',
              message: UNREADABLE_KEY_MESSAGE,
            } satisfies TestOutcome
          }
          // 测试用的 Key 必须和真正干活的是同一把：表单留空时回落到已保存的那把，
          // 否则改个接口地址就得重贴 Key，测出来永远是「还没填」
          probe = {
            ...values,
            apiKey: needSavedKey ? effectiveKey : values.apiKey,
            apiBase: needSavedBase ? saved.aiApiBase : values.apiBase,
          }
        }
        if (kind === 'tts') return await testTTSConfig(probe as TTSTestValues)
        return kind === 'ai'
          ? await testAIConfig(probe as AITestValues)
          : await testASRConfig(probe as AsrTestValues)
      } catch (err) {
        // 兜底：任何未预期异常都要变成界面上的结论，而不是让渲染层的 await 直接抛
        const message = err instanceof Error ? err.message : String(err)
        logger.error('ConnTest', 'probe crashed', { kind, message })
        return { level: 'fail' as const, title: '测试没能跑完', message }
      }
    }
  )
}
