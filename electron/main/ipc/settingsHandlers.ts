/**
 * 设置持久化 IPC 处理器
 * 提供设置的读取、保存，多套配置的增删改，以及「测试连接 / 检查引擎状态」接口
 * 数据存储在 userData/settings.json；三把 API Key 只在主进程解密，回给界面的一律是脱敏视图
 *
 * settings:get / settings:listProfiles 失败回 null 而不是回一份空视图：那一份表单每个字段都是空的，
 * 界面会照着说「你还没填 API Key」——磁盘上明明有，只是这次读不出来。
 * null 正好落回界面本来就有的那条分支（按默认值填表、密钥状态一律不标）。
 */
import {
  createProfile,
  deleteProfile,
  getSettingsView,
  listProfiles,
  loadSettings,
  renameProfile,
  saveSettings,
  setDefaultProfile,
  normalizeLocalModel,
  normalizeTtsEngine,
  normalizeAgentApi,
  SettingsProfileRuleError,
  SettingsWriteBlockedError,
  type AgentApiMode,
  type LocalModelTier,
  type ProfileCreateInput,
  type ProfilesView,
  type ProfileSelection,
  type SettingsPatch,
  type SettingsView,
} from '../services/settingsService'
import { restartLocalEngine } from '../services/asrServiceManager'
import { hasActiveTranscription } from '../services/transcribeJob'
import {
  testASRConfig,
  testAIConfig,
  testTTSConfig,
  type AsrTestValues,
  type AITestValues,
  type TTSTestValues,
  type TestOutcome,
} from '../services/connectionTestService'
import { normalizeTtsVendor, ttsVendorNeedsVoice } from '../services/ttsVendor'
import { startAgentFacade, stopAgentFacade } from '../services/agentFacade'
import { logger } from '../services/logger'
import { ipcHandle } from './guard'

/** 保存档位改动后，本地引擎要不要重启、有没有重启成功 */
export type TierRestartOutcome = 'not-needed' | 'done' | 'busy' | 'failed'

/**
 * 这次保存有没有把「本机 agent 入口」的开关切过去。
 * `unchanged` 时界面一句别说：不这么分的话，每次保存——包括只改了转写语言那种——都会报一遍
 * 「已打开」，而那既不是这次做的事，也是门面本来就在听的那一种情况的假话。
 */
export type AgentApiChange = 'unchanged' | 'on' | 'off'

export interface SaveSettingsResult {
  /** null＝连脱敏视图都没读出来（配置坏了或目录权限掉了）；界面按「不知道密钥状态」处理，不许当成「全是 none」 */
  settings: SettingsView | null
  tierRestart: TierRestartOutcome
  /** tierRestart 为 busy / failed 时可直接展示给用户的原因——这两种情况下新档位其实还没生效 */
  error: string | null
  /**
   * 这次没能写进磁盘，可直接展示给用户的原因；null＝真的存下了。
   * 界面必须靠它决定接下来做什么：写盘失败却照旧清空 Key 输入框、报「设置已保存」，
   * 就是当面撒慌——而磁盘上那份配置还是旧的（甚至一份都没有）。
   */
  saveError: string | null
  /** 本次保存切了本机 agent 入口没有；只报告开关，不回端口，也不回 token */
  agentApi: AgentApiChange
  /**
   * 开关切过去了、但门面没能按预期起来时那句要给用户看的原因；null＝不用多说。
   * 这一步挂了**不算**保存失败（磁盘上那份是对的），所以它不能借 `saveError` 那条路出去——
   * 走那条会让界面留着表单、报「没能写入」，而配置其实已经落盘了。
   */
  agentNote: string | null
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

/**
 * 本机 agent 入口（#376）的开关跟着这次保存当场起停（#385）。
 *
 * 为什么在主进程侧做而不是加一条 IPC：门面开的是「别的进程能不能连进来」那道口，
 * 渲染层点一下就能改的口子不该由渲染层来管——它只要把值交给 `settings:save`，
 * 起与停、凭据文件、监听收回全在这一侧。加通道会多出「界面那侧要能拿到端口或 token」的诱惑，
 * 而那两样正是绝不跨 IPC 的东西。
 *
 * 三条规矩：
 * 1. **只在值真的变了时动手**：不这么分就会出现「保存了一次转写语言，门面被重启一遍」，
 *    而重启意味着换 token、掐断正在流式输出的那一单作业。
 * 2. **这一步失败不改成保存失败**：磁盘上那份已经写对了，报 `saveError` 会让界面留着表单、
 *    说「没能写入」，用户再点一次还是同一个结果——那句是假的。它走 `agentNote`。
 * 3. **不起第二份监听**：`startAgentFacade` 自己幂等（已经在听就直接回），这里不重复判。
 */
async function applyAgentFacadeChange(
  before: AgentApiMode,
  after: AgentApiMode
): Promise<{ change: AgentApiChange; note: string | null }> {
  if (before === after) return { change: 'unchanged', note: null }
  try {
    if (after === 'on') {
      const started = await startAgentFacade()
      return {
        change: 'on',
        note: started.listening
          ? null
          : `设置已写入，但本机 agent 入口没能打开：${started.reason}`,
      }
    }
    await stopAgentFacade()
    return { change: 'off', note: null }
  } catch (err) {
    // 起停本身炸了（监听收不回去、凭据文件写不下去之外的意外）也要说得出为什么，
    // 但不许把它冒成「设置没写进去」
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Settings', 'agent facade change failed', message)
    return { change: after, note: `设置已写入，但本机 agent 入口的开关没能切换（${message}）` }
  }
}

/** 密文解不开＝这台机器读不出那把 Key（换过电脑或系统密钥库被清过）；说「还没填」会让人以为是自己漏填 */
const UNREADABLE_KEY_MESSAGE =
  '这台机器读不出已保存的 API Key（可能换过电脑，或系统密钥库被清过）。重新填一次并保存即可'

/**
 * 写盘失败要说人话。闸门那句话（SettingsWriteBlockedError）本来就是按「为什么拦」挑的措辞，
 * 原样透出去；其余的（ENOSPC、EACCES、只读介质）带着 errno 文本，再加一句「你填的还在界面上」，
 * 免得用户以为白填了一遍去重填。
 *
 * 方案的规矩（SettingsProfileRuleError）也必须原样透出去，和 `profilesErrorMessage` 同一口径：
 * 「这一类还没有任何配置方案，请先点『新建一套』」是一句出路清楚的话，套上「清出磁盘空间或修好
 * 目录权限」就把一个点错按钮的事说成磁盘坏了。
 */
function saveErrorMessage(err: unknown): string {
  if (err instanceof SettingsWriteBlockedError) return err.message
  if (err instanceof SettingsProfileRuleError) return err.message
  const message = err instanceof Error ? err.message : String(err)
  return `设置没能写入（${message}）。界面上填的内容还在，不用重填；清出磁盘空间或修好目录权限后再存一次`
}

/**
 * settings:save 的两条失败路径都要再读一次脱敏视图，而那一步自己也会炸（配置文件坏了、
 * 目录权限掉了）。这里把它包住：读不出就回 null，saveError 那一格永远留得住——
 * 界面判断「有没有存下」靠的正是那一位，丢了它就是把「没存下」报成「已保存」。
 */
async function viewForFailure(): Promise<SettingsView | null> {
  try {
    return await getSettingsView()
  } catch {
    return null
  }
}

/**
 * 方案增删改的回执。`profiles` 是改完之后（或没改成时）磁盘上的那份列表，
 * error 非 null 时界面**不许**把它当成「操作成功了列表刷新一下」——
 * 列表照样回，是因为即便这次没写进去，界面上那三条也得还是磁盘上真实的样子。
 */
export interface ProfilesResult {
  profiles: ProfilesView | null
  error: string | null
}

/** 方案操作的失败原因：闸门与规矩那两类文案本来就是给人看的一句话，原样透出去 */
function profilesErrorMessage(err: unknown): string {
  if (err instanceof SettingsWriteBlockedError) return err.message
  if (err instanceof SettingsProfileRuleError) return err.message
  const message = err instanceof Error ? err.message : String(err)
  return `配置没能写入（${message}）。清出磁盘空间或修好目录权限后再试一次`
}

/** 四条改动（新建 / 改名 / 删除 / 换默认）共用的一条出口：出错也要回列表 + 一句话，而不是让渲染层的 await 抛 */
async function profilesAction(run: () => Promise<ProfilesView>): Promise<ProfilesResult> {
  try {
    return { profiles: await run(), error: null }
  } catch (err) {
    const error = profilesErrorMessage(err)
    logger.error('Settings', 'profile change did not reach the disk', error)
    let profiles: ProfilesView | null = null
    try {
      profiles = await listProfiles()
    } catch {
      profiles = null
    }
    return { profiles, error }
  }
}

/**
 * createProfile 那一个对象的入参收口。渲染层递来的东西在我们这边没有类型保证：重写之前
 * 这条通道传的是三个位置参数，要是有人漏改一处调用，`input?.fromProfileId === ''` 那种判断
 * 就会把整根字符串当成字段读——只认对象形状，其余（字符串、数组、没给）一律当「没给」，
 * 走该档当前那条复制。
 */
function asCreateInput(raw: unknown): ProfileCreateInput | undefined {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ProfileCreateInput) : undefined
}

export function registerSettingsHandlers() {
  // 脱敏视图：密钥字段在这里就不再返回明文，渲染层拿到的是「有没有、能不能用、是不是明文」
  ipcHandle('settings:get', () => getSettingsView(), () => null)

  // 三档各自的方案列表（含每条的密钥状态与「当前选哪条」），一次给全
  ipcHandle('settings:listProfiles', () => listProfiles(), () => null)

  // 新建：界面把此刻表单上的凭据整份交过来（`values`），要不要设为当前使用也由 `setDefault` 说；
  // `fromProfileId` 省略＝照当前那条复制，给 id＝照那条，空串＝一条全空白。密钥原样搬运的规则见 settingsService
  ipcHandle(
    'settings:createProfile',
    (_event, capability: unknown, rawInput?: unknown) =>
      profilesAction(() => createProfile(capability, asCreateInput(rawInput))),
    (message) => ({ profiles: null, error: message })
  )

  ipcHandle(
    'settings:renameProfile',
    (_event, capability: unknown, profileId: unknown, name: unknown) =>
      profilesAction(() => renameProfile(capability, profileId, name)),
    (message) => ({ profiles: null, error: message })
  )

  ipcHandle(
    'settings:deleteProfile',
    (_event, capability: unknown, profileId: unknown) =>
      profilesAction(() => deleteProfile(capability, profileId)),
    (message) => ({ profiles: null, error: message })
  )

  ipcHandle(
    'settings:setDefaultProfile',
    (_event, capability: unknown, profileId: unknown) =>
      profilesAction(() => setDefaultProfile(capability, profileId)),
    (message) => ({ profiles: null, error: message })
  )

  ipcHandle(
    'settings:save',
    async (
      _event,
      // 界面上的 Key 输入框留空＝不改，显式清除走 null，非空才是替换（见 saveSettings）。
      // 类型必须和 saveSettings 用同一个：这里写宽了 IPC 收得下、那边收不住，
      // 「清除 Key」按钮的 null 会在跨进程之后变成 undefined，用户看到的是没删掉
      patch: SettingsPatch
    ): Promise<SaveSettingsResult> => {
      try {
        const previous = await loadSettings()
        // 这两样都是「全局段」的字段，不待在任何一条方案里，所以 before/after 都重新
        // load 一次磁盘值来比，不能拿「这次写进去的是哪条方案」来推：只改凭据的保存动不到这两个值，
        // 档位没变却重启一次、还说「新档位才会生效」，就是把用户的好几次转写白白打断了；
        // agentApi 同理——不动它却起停一次，等于每次保存都在换 token、掐断正在流式输出的那一单
        const before = normalizeLocalModel(previous.asrLocalModel)
        const beforeAgent = normalizeAgentApi(previous.agentApi)
        const saved = await saveSettings(patch)
        const next = await loadSettings()
        const after = normalizeLocalModel(next.asrLocalModel)
        const afterAgent = normalizeAgentApi(next.agentApi)
        const tierRestart = await applyTierChange(before, after)
        // 排在档位重启之后：两次都要动本地那台引擎，先把引擎按新档位拉起来再开那道口。
        // 反过来的话新开的门面会先把旧引擎接住，紧接着那次重启把它正在流的作业掐断。
        const facade = await applyAgentFacadeChange(beforeAgent, afterAgent)
        return {
          settings: saved,
          tierRestart,
          error: TIER_RESTART_MESSAGE[tierRestart] ?? null,
          saveError: null,
          agentApi: facade.change,
          agentNote: facade.note,
        }
      } catch (err) {
        // 写盘失败要说得出为什么，还要把界面上那份（没存进去的）视图原样回给它，
        // 否则渲染层会照着默认值重画一遍表单、把用户刚填的清空
        const saveError = saveErrorMessage(err)
        logger.error('Settings', 'settings:save did not reach the disk', saveError)
        // 写盘都没成，就更不该去动门面：那一下会把「磁盘上还是旧值」变成「旧值 + 一个不该开的端口」
        return {
          settings: await viewForFailure(),
          tierRestart: 'not-needed',
          error: null,
          saveError,
          agentApi: 'unchanged',
          agentNote: null,
        }
      }
    },
    // 走到这里的是连兜底都读不出设置视图的情况（配置文件坏了、目录权限掉了）：
    // 照样回一份 saveError，界面就不会报「已保存」
    async (message) => ({
      settings: await viewForFailure(),
      tierRestart: 'not-needed' as const,
      error: null,
      saveError: `设置没能写入（${message}）。界面上填的内容还在，不用重填`,
      agentApi: 'unchanged' as const,
      agentNote: null,
    })
  )

  ipcHandle(
    'settings:testConnection',
    async (
      _event,
      kind: 'asr' | 'ai' | 'tts',
      values: AsrTestValues | AITestValues | TTSTestValues,
      profileId?: unknown
    ) => {
      try {
        // 只带被测这一腿的 id，且**只**带这一腿：回落必须跟真干活用的是同一条方案，
        // 而 getTTSConfig 那里就是这样——它只挑配音那档，配音留空时沿用的「校对那套」固定是
        // 校对档当前默认的那条（settingsService 里写了为什么：一个 id 不该同时指到两档）。
        // 测试要是把界面正在编辑的校对方案也带进来，就会出现「自检按 B 家网关绿了、
        // 点开始配音却走 A 家」——这正是这条链路一路在躲的分歧。
        // 不带 id 时拿的是该档当前默认那条；id 指不到人时按 picker 语义落回默认，与真干活一致。
        const selection: ProfileSelection = {}
        const wantedId = typeof profileId === 'string' ? profileId.trim() : ''
        if (wantedId) selection[kind] = wantedId
        // 配音这一腿的回落口径必须与 getTTSConfig 一致：接口地址与 Key 留空时用的是校对那套。
        // 测试不跟着回落就会出现「自检报没填、点开始配音却跑得通」这种最难解释的分歧。
        // 但本地配音档例外：Key 与地址根本不参与这一档，跟着回落等于把能用的人拦在门外（#220/#227）。
        const formKey = String((values as { apiKey?: unknown }).apiKey ?? '')
        const formBase = String((values as { apiBase?: unknown }).apiBase ?? '')
        const isLocalTTS =
          kind === 'tts' && normalizeTtsEngine((values as { engine?: unknown }).engine) === 'local'
        const needSavedKey = !isLocalTTS && !formKey.trim()
        const needSavedBase = !isLocalTTS && kind === 'tts' && !formBase.trim()
        // 云端这一腿的音色面板上没有格子（1.1.0 起它既不在方案里、也不在这页填，界面上那次覆盖不算），
        // 所以表单传来的永远是空串。空串不能当成「不测音色」——OpenAI 兼容那档真配音发的是
        // 设置里那一份全局值，自检就得按同一份发；要不要回落按厂商分叉，见下面 probeNeedsVoice。
        const needSavedVoice = !isLocalTTS && kind === 'tts' && !String((values as { voice?: unknown }).voice ?? '').trim()
        // 厂商（1.1.1）同音色一个道理：这一格在方案弹窗里，配音页那颗按钮不带它。
        // 不回落就会出现「按 OpenAI 兼容的形状测绿了、实际那一条方案选的是 MiniMax、配音撞 404」。
        const needSavedProvider =
          !isLocalTTS && kind === 'tts' && !String((values as { provider?: unknown }).provider ?? '').trim()
        // 讯飞那一档还有第二把凭据：APISecret（1.1.2，#343）。它和 apiKey 一样只以密文落盘、
        // 明文从不发给渲染层，所以「表单里这一格空着」不代表用户没配过——回落口径必须与 apiKey
        // 一字不差，否则编辑一条已经存好的讯飞方案时点自检，永远报「还缺 APISecret」。
        const needSavedSecret = kind === 'asr' && !String((values as { apiSecret?: unknown }).apiSecret ?? '').trim()
        let probe = values
        if (needSavedKey || needSavedBase || needSavedVoice || needSavedProvider || needSavedSecret) {
          const view = await getSettingsView(selection)
          const saved = await loadSettings(selection)
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
          // 那句话写的是「API Key」，对 APISecret 也照用：成因与出路完全相同（这台机器的密钥库读不出
          // 这一份密文，重填一次并保存就好），为它另写一句只是让用户在两种措辞之间猜是不是两件事
          if (
            (needSavedKey && !effectiveKey && statuses.includes('unreadable')) ||
            (needSavedSecret && !saved.asrApiSecret && view.asrSecretStatus === 'unreadable')
          ) {
            return {
              level: 'fail' as const,
              title: '还测不了',
              message: UNREADABLE_KEY_MESSAGE,
            } satisfies TestOutcome
          }
          // 测试用的 Key 必须和真正干活的是同一把：表单留空时回落到已保存的那把，
          // 否则改个接口地址就得重贴 Key，测出来永远是「还没填」
          //
          // 音色这一项只在「这一家不收空音色」时不回落：根上那份 `ttsVoice` 是 1.1.0 从旧方案
          // 迁过来的历史值（多半还是 alloy），把外家的音色名塞给 MiniMax，自检就会替用户把
          // 界面上那句「这一家不收空音色」绕过去，还可能默默换个音色念一句话。
          // 空着交给 testTTSConfig：它按厂商补一个**实测能用**的系统音色（ttsVendorProbeVoice），
          // 补不出来就说明这一页测不了这一家、要到配音页试听——而不是拿一个外家值蒙过去。
          const probeProvider = needSavedProvider
            ? saved.ttsProvider
            : String((values as { provider?: unknown }).provider ?? '')
          const probeNeedsVoice = ttsVendorNeedsVoice(normalizeTtsVendor(probeProvider))
          probe = {
            ...values,
            apiKey: needSavedKey ? effectiveKey : values.apiKey,
            apiBase: needSavedBase ? saved.aiApiBase : values.apiBase,
            ...(needSavedVoice && !probeNeedsVoice ? { voice: saved.ttsVoice } : {}),
            ...(needSavedProvider ? { provider: saved.ttsProvider } : {}),
            ...(needSavedSecret ? { apiSecret: saved.asrApiSecret } : {}),
          }
        }
        if (kind === 'tts') return await testTTSConfig(probe as TTSTestValues)
        return kind === 'ai'
          ? await testAIConfig(probe as AITestValues)
          : await testASRConfig(probe as AsrTestValues)
      } catch (err) {
        // 兜底：任何未预期异常都要变成界面上的结论，而不是让渲染层的 await 直接抛。
        // 这一份留着是因为日志里要带 kind（测的是哪一腿），guard 那层只有通道名
        const message = err instanceof Error ? err.message : String(err)
        logger.error('ConnTest', 'probe crashed', { kind, message })
        return { level: 'fail' as const, title: '测试没能跑完', message }
      }
    },
    // TestOutcome 的三样都得凑齐，界面才有一行结论可显示；漏一条那一格就空着
    (message) => ({ level: 'fail' as const, title: '测试没能跑完', message })
  )
}
