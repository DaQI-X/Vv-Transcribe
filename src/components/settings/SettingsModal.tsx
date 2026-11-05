/**
 * 设置弹窗组件
 * 提供五个 Tab：
 * - 转写配置（asr）：转写模式（本地/云端）、本地档位、转写语言这三项是本机的全局值；
 *   选「云端优先」才露出「云端转写方案」那一列
 * - 校对配置（ai）：一列「云端校对方案」加本地词典版本与更新——这一档没有全局字段，
 *   服务商／地址／Key／模型四项全在方案里
 * - 配音配置（tts）：先选「云端接口 / 本地配音」这一档（全局字段），本地档给的是「本地模型」一个下拉，
 *   云端档给的是「云端配音方案」那一列（地址／Key／配音模型三项）——音色两档都不在这一页，
 *   它是「这一批要听哪一个」，入口只有配音页那一格
 * - 主题（theme）、关于与更新（about：版本、按需组件下载）
 * 设置通过 IPC 持久化到 userData/settings.json
 *
 * 保存分两处：三档的凭据都在「新建API接入／编辑API接入」那个弹窗里点「保存」当场写盘，
 * 面板上那几个全局字段（转写的模式、档位、语言，配音的引擎与本地模型——换本地模型时
 * 连磁盘上那份默认音色编号一起归回第一个）
 * 仍只在右下角「保存设置」时落盘，且保存后不关窗，方便紧接着点「测试连接」；
 * 校对一档一个全局字段都没有，所以那一页不给这颗按钮——点它只会报一句「设置已保存」，
 * 而盘上什么都没变。有未保存修改时关闭会先二次确认，切 Tab 不重新拉取磁盘值，避免静默丢掉刚填的内容。
 *
 * 三把 API Key 与其他字段不同：主进程只回状态不回值，所以弹窗里那一格不回显、留空＝不修改、
 * 清除要走「清除已保存的 Key」按钮（跟着弹窗那次保存生效）。
 *
 * 三档的方案列表用的是同一个组件（`ProfileList` + `ProfileDialog`，字段表在 `utils/profileSpec`）：
 * 只有新建 / 编辑 / 删除三颗按钮，「当前使用」是弹窗里那颗勾选，跟着那一次「保存」一起落盘。
 * 「当前使用」与「弹窗正在改的那一套」是两件事——编辑一套没在用的配置不影响正在跑的活。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  X,
  Sun,
  Moon,
  FolderOpen,
  Plug,
  RotateCcw,
  CircleCheck,
  CircleX,
  TriangleAlert,
  Mail,
  Copy,
} from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useThemeStore } from '@/stores/useThemeStore'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'
import { useVoiceStudioStore } from '@/stores/useVoiceStudioStore'
import { useProfileStore } from '@/stores/useProfileStore'
import { ASR_LANGUAGE_OPTIONS } from '@/utils/asrLanguage'
import {
  LOCAL_TTS_DEFAULT_ENGINE,
  LOCAL_TTS_ENGINE_OPTIONS,
  ENGINE_BINARY_ROW_NAME,
  binaryManifestTag,
  hasInAppDownload,
  localTtsEngineCaveat,
  localTtsEngineLabel,
  missingBinaryHint,
  missingModelHint,
  modelPresenceTag,
} from '@/utils/localTtsEngines'
import { ComponentsSection } from '@/components/settings/ComponentsSection'
import { ProfileList } from '@/components/settings/ProfileList'
import { ProfileDialog, type ProfileDraft } from '@/components/settings/ProfileDialog'
import { PROFILE_CAP_SPEC, fieldsOf, keyFieldOf, profileRowTitle } from '@/utils/profileSpec'
import type {
  ProfileCapability,
  ProfileView,
  ProfilesResult,
  ProfilesView,
} from '@/types/settingsProfile'
import { openUserDataDirectory } from '@/utils/userData'
import { formatBytes } from '@/utils/formatBytes'

/**
 * 面板上那几个全局字段（=主进程 GLOBAL_FLAT_KEYS 那一层）。
 * 第⑧步之后三档的凭据全部住进方案，面板不再持有它们：`getSettings` 那份脱敏视图里的
 * 地址／Key／模型不是「表单里还没保存的值」，而是「当前使用那一条的读数」，
 * 要显示要改动都从 `profiles` 那一份走，弹窗保存之后也不往这里回填。
 */
interface SettingsValues {
  asrProvider: string
  asrLocalModel: string
  asrLanguage: string
  /**
   * 配音走哪一档，以及本地档用哪一款模型（连同它下面的默认音色编号）。
   * 云端档的三项凭据（地址／Key／配音模型）不在这里：它们属于某一条方案，见 `PROFILE_CAP_SPEC.tts`。
   * 音色两档都不再给输入格——1.1.0 起它是「这一批听哪一个」，入口只有配音页那一格；
   * `ttsLocalVoice` 留在这一份里是因为它还是磁盘上的默认值，换本地模型时跟着归回第一个。
   */
  ttsEngine: string
  /** 本地档的引擎 id（白名单在主进程 localTtsEngine；空＝主进程按默认档处理） */
  ttsLocalEngine: string
  /** 本地档的默认音色编号（0-based sid，界面上写「音色 1…」）；条数主进程先按钉死的模型表给，引擎加载后由实报值覆盖 */
  ttsLocalVoice: string
}

/** 与主进程 connectionTestService 的 TestOutcome 对应 */
interface TestOutcome {
  level: 'pass' | 'warn' | 'fail'
  title: string
  message: string
}

const DEFAULT_VALUES: SettingsValues = {
  asrProvider: 'local',
  asrLocalModel: 'base',
  asrLanguage: 'zh',
  ttsEngine: 'cloud',
  ttsLocalEngine: '',
  ttsLocalVoice: '',
}

/**
 * 这一次保存要带的全局段字段。它比屏幕上摊开的那几格多一项：`ttsLocalVoice` 在 1.1.0
 * 之后没有对应的格子（音色是「这一批听哪一个」，入口只剩配音页），但换本地模型时仍要把它
 * 归回第一个——磁盘上那份默认编号得跟着档位走，配音页起手读的就是它。
 */
const GLOBAL_VALUE_KEYS: (keyof SettingsValues)[] = [
  'asrProvider',
  'asrLocalModel',
  'asrLanguage',
  'ttsEngine',
  'ttsLocalEngine',
  'ttsLocalVoice',
]

/**
 * 本地引擎的 Whisper 档位。数字与错字样本都是本机实测（10 核 M 系、105.59 秒中文素材，每档预热 1 次后计时 3 次）：
 * base 权重 138MB、单次 9.1–16.5 秒（折合转一分钟约 5–9 秒）；small 461MB、26.6–30.3 秒（约 15–17 秒），
 * 按中位数 small 是 base 的 2.83 倍。文本上 base 把「英雄觉醒在即」听成「英雄绝性在急」
 * （20 秒切片那次是「英雄决性在急」），small 两处都听对——改意思的同音错字就是把档位交给用户的理由。
 */
const LOCAL_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'base', label: '快速（base 档）' },
  { value: 'small', label: '精准（small 档）' },
]

/** 只是给关于页显示和「复制」用；真正拼 mailto 的是主进程 app:contactDeveloper，改地址要同步改那边 */
const CONTACT_EMAIL = 'hi@vvscribe.com'

const TAB_TITLES: Record<string, string> = {
  asr: '转写配置',
  ai: '校对配置',
  tts: '配音配置',
  theme: '主题',
  about: '关于与更新',
}

interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  downloadUrl: string
  /** 问不出新版本时的原话；null＝这次真的问到了。不读它就会把「查不到」演成「已是最新版」 */
  error: string | null
}

/** 链接解析组件（yt-dlp）的本机状态；version 为 null 是「那个二进制跑不起来或读不出版本」，不是「没装」 */
interface YtDlpLocal {
  version: string | null
  source: 'updated' | 'bundled' | 'system' | 'path'
  bytes: number | null
}

/** 探测要 spawn 一次组件进程，这条路是会失败的，所以快照包了一层信封（见 ipc/updateHandlers.ts） */
interface YtDlpLocalSnapshot {
  info: YtDlpLocal | null
  error: string | null
}

interface YtDlpCheckResult {
  ok: boolean
  error: string | null
  local?: YtDlpLocal
  remote?: { version: string; bytes: number }
  hasUpdate?: boolean
}

const YTDLP_SOURCE_LABEL: Record<YtDlpLocal['source'], string> = {
  updated: '应用内更新过',
  bundled: '安装包内置',
  system: '本机安装的 yt-dlp',
  path: '系统 PATH 上的 yt-dlp',
}

interface SettingsModalProps {
  tab: string | null
  onClose: () => void
}

const RESULT_ICON = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX } as const

function TestResultView({ result }: { result: TestOutcome }) {
  const Icon = RESULT_ICON[result.level]
  const boxRef = useRef<HTMLDivElement>(null)

  // 「配置自检」在弹窗最底部，结论卡片渲染时往往在滚动区之外，看不到等于白测
  useEffect(() => {
    boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])

  return (
    <div ref={boxRef} className={`settings-test-result settings-test-result--${result.level}`}>
      <Icon size={14} className="settings-test-result__icon" />
      <div>
        <div className="settings-test-result__title">{result.title}</div>
        <div className="settings-test-result__message">{result.message}</div>
      </div>
    </div>
  )
}

function ThemeSettings({ theme, onChange }: { theme: string; onChange: (theme: string) => void }) {
  return (
    <>
      <div className="settings-form-group">
        <label className="settings-form-label">主题模式</label>
        <div className="theme-selector">
          <button
            className={`theme-option ${theme === 'light' ? 'theme-option--active' : ''}`}
            onClick={() => onChange('light')}
          >
            <Sun size={20} />
            <span>亮色</span>
          </button>
          <button
            className={`theme-option ${theme === 'dark' ? 'theme-option--active' : ''}`}
            onClick={() => onChange('dark')}
          >
            <Moon size={20} />
            <span>暗色</span>
          </button>
        </div>
        <span className="settings-form-hint">选择应用的主题</span>
      </div>
    </>
  )
}

export function SettingsModal({ tab, onClose }: SettingsModalProps) {
  const [values, setValues] = useState<SettingsValues>(DEFAULT_VALUES)
  /** 最近一次「磁盘上的值」快照，用来判断有没有未保存的修改 */
  const [snapshot, setSnapshot] = useState(() => JSON.stringify(DEFAULT_VALUES))
  const [hydrated, setHydrated] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dictVersion, setDictVersion] = useState('')
  const [dictUpdating, setDictUpdating] = useState(false)
  const [themeValue, setThemeValue] = useState<string>('light')
  const [appVersion, setAppVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [testingKind, setTestingKind] = useState<'asr' | 'ai' | 'tts' | null>(null)
  const [testResults, setTestResults] = useState<{
    asr?: TestOutcome
    ai?: TestOutcome
    tts?: TestOutcome
  }>({})
  /** 这台机器能不能用系统密钥库：只有这一件是面板级的，三把 Key 的状态各自挂在列表那一行上 */
  const [encryptable, setEncryptable] = useState(true)
  /**
   * 三档的方案列表。null＝这次连列表都没读出来——`ProfileList` 会说明「读不出来」并收起三个动作，
   * 不许按「用户一套都没建过」渲染（磁盘上那几条并没有消失）。
   */
  const [profiles, setProfiles] = useState<ProfilesView | null>(null)
  /** 一次方案增删改在路上：连点会把两次结构改动叠在同一份配置上，第二次读到的还是第一次之前的磁盘 */
  const [profileBusy, setProfileBusy] = useState(false)
  /**
   * 「新建API接入／编辑API接入」弹窗里那份草稿（三档共用，同一时刻只开一个），null＝弹窗收着。
   *
   * 草稿**不进 `values`**：那几格由弹窗自己那颗「保存」当场写盘，右下角「保存设置」碰不到它们。
   * 共用一份表单就会出现两种错账——用户在弹窗里存好了，外面那句「有改动没保存」还挂着；
   * 点「取消」要收回那几格，只能整份重拍 snapshot，把全局段里刚改还没存的那几处一起算成已保存
   * （静默丢改动）。
   */
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null)
  /** 弹窗那颗「保存」在路上：连点会先建两条同样的方案，编辑那半也会把同一份补丁写两遍 */
  const [draftSaving, setDraftSaving] = useState(false)
  /**
   * 磁盘上「当前使用」那一条方案（按档问，没有就是 null）。
   * 面板上的「测试连接」测的是它：凭据住在弹窗里，弹窗收着的时候屏幕上根本没有别的凭据可读，
   * 而真转写／校对／配音取值的也是这一条——测别的套等于给用户一张救不了命的合格证。
   */
  const currentRow = (cap: ProfileCapability): ProfileView | null =>
    profiles?.profiles[cap].find(
      (profile) => profile.id === (profiles?.defaultProfileId[cap] ?? '')
    ) ?? null
  /**
   * 自检按不动时那句「为什么」，三档共用同一个判断。
   *
   * 「列表没读出来」和「一条都没建」「建了但没选谁在干活」是三件事：前一句的出路是重开窗口，
   * 后两句的出路是点这一栏里某一行。混着说会让人去翻一个屏幕上根本没有的行。
   */
  const testBlockedHint = (cap: ProfileCapability): string =>
    !profiles
      ? '方案列表这次没读出来，这颗先按不动：关掉设置窗口重开一次再看（磁盘上已有的方案不会因此消失）'
      : profiles.profiles[cap].length === 0
        ? '还没有方案可测：点上面「新建API接入」，在弹窗里建出第一条'
        : '没有「当前使用」的那一条，这颗按不动：进要用的那一行的「编辑」，勾上再保存'
  const [restarting, setRestarting] = useState(false)
  const [restartingVoice, setRestartingVoice] = useState(false)
  const [ytDlpLocal, setYtDlpLocal] = useState<YtDlpLocalSnapshot | null>(null)
  const [ytDlpRemote, setYtDlpRemote] = useState<YtDlpCheckResult['remote'] | null>(null)
  const [ytDlpHasUpdate, setYtDlpHasUpdate] = useState(false)
  const [ytDlpChecking, setYtDlpChecking] = useState(false)
  const [ytDlpApplying, setYtDlpApplying] = useState(false)
  const [ytDlpProgress, setYtDlpProgress] = useState<{ received: number; total: number } | null>(
    null
  )
  const api = getElectronAPI()
  const { theme, setTheme } = useThemeStore()

  // 主题只在点保存后才落到 store，所以「改了没存」拿 store 当前值和表单值比。
  // 弹窗里那份草稿不参与：它由自己那颗「保存」当场写盘，右下角碰不到——关设置窗口丢掉的
  // 是一份本来就没落盘的东西，不是「还没保存的配置」
  const isDirty = tab === 'theme' ? themeValue !== theme : JSON.stringify(values) !== snapshot

  /**
   * 这次保存会不会重启本地引擎。档位变了必重启，而重启要等 PyInstaller 起进程 + /health 应答
   * （本机实测从点保存到出提示约 9 秒），按钮不说清这 9 秒在干什么，看着就像界面卡死。
   */
  const restartsEngine = (() => {
    try {
      return JSON.parse(snapshot).asrLocalModel !== values.asrLocalModel
    } catch {
      return false
    }
  })()

  /** 改过哪一组就作废那一组的测试结论：留着上一次填法测出来的绿色会误导 */
  const invalidateTest = (kind: 'asr' | 'ai' | 'tts') => {
    setTestResults((prev) => (prev[kind] === undefined ? prev : { ...prev, [kind]: undefined }))
  }

  /**
   * 面板上只剩两组全局字段（转写的模式／档位／语言，配音的引擎／本地模型），
   * 校对一档一个都没有，所以前缀只需要分这两家。
   */
  const updateField = (field: keyof SettingsValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }))
    invalidateTest(field.startsWith('tts') ? 'tts' : 'asr')
  }

  /**
   * 列表读回来之后要刷的两样：列表本身，和三个页面上那条「方案」下拉。
   * 密钥状态不在这里对齐——它跟着列表里那一行（`profile.keyStatus`），弹窗开给哪一条就显那一条的，
   * 面板上从此没有「正在编辑的那条」这个概念了。
   */
  const applyProfiles = (view: ProfilesView) => {
    setProfiles(view)
    // 同一份列表还要推给三个页面的那条下拉（转写首页 / 校对着 / 字幕配音）：
    // 在设置里新建或删掉一套之后，回去的那一页不能还拿着开设置时读到的旧清单。
    useProfileStore.getState().applyView(view)
  }

  /**
   * 配音那一档的方案刚落盘，替配音页补读一次设置。
   * 那页抬头「配音引擎：云端接口 · 模型 X」、云端那一格下拉里显示的行名、以及音色格的 placeholder
   * 读的是主进程按「当前使用」那条方案解析出来的 `ttsModel` 与根上的 `ttsVoice`，
   * 而弹窗与删除只把**方案列表**推回了界面。
   * 不补这一次就出现「盘上已改成 tts-2、回配音页还写着 tts-1」——同一个动作在两个地方两种话。
   * 和 `handleSave` 里那句是同一个道理：那处改的是全局段档位，这处改的是方案里的凭据。
   */
  const refreshVoicePage = (cap: ProfileCapability) => {
    if (cap === 'tts') void useVoiceStudioStore.getState().loadConfig()
  }

  /**
   * 结构改动（弹窗那次「保存」与列表的「删除」）共用的走法：读 {profiles, error} 信封、
   * 把磁盘此刻的样子落回界面、失败一律 toast。回 null＝这次没写进磁盘，
   * 调用方靠它决定弹窗留不留、气泡确认框收不收起——没成功就关掉，用户刚填的那几个字就丢了。
   */
  const runProfileAction = async (
    run: () => Promise<ProfilesResult>
  ): Promise<ProfilesView | null> => {
    if (!api || profileBusy) return null
    setProfileBusy(true)
    try {
      const result = await run()
      if (result?.profiles) applyProfiles(result.profiles)
      if (result?.error) {
        toast.error(result.error, 9000)
        return null
      }
      // error 为 null 却没有列表，只剩「IPC 传输本身挂了」这一种：同样算没改成，别报成功
      if (!result?.profiles) {
        toast.error('这次操作没能确认。关掉设置窗口重开一次，再看列表是不是磁盘上那样', 9000)
        return null
      }
      return result.profiles
    } catch {
      toast.error('这次操作没能确认。关掉设置窗口重开一次，再看列表是不是磁盘上那样', 9000)
      return null
    } finally {
      setProfileBusy(false)
    }
  }

  /**
   * 「新建API接入」＝弹出那几格（#222 重写第⑥步做在转写上，第⑧步三档共用）。这一步**一个字节都不写磁盘**。
   *
   * 以前这颗按钮当场就建一条，用户点完才第一次看见输入框：想改就得改一条已经存在的方案，
   * 点错了还多出一条没人要的。
   * 地址与模型从「列表上此刻在用的那一条」抄过来作起手——同一家网关换个模型是最常见的第二次配置，
   * 不用重打一遍地址；这一档没有「当前使用」那条时抄列表第一条（行上就写着它，抄得不算突然）。
   * Key 那格永远从空开始（密钥从不过 IPC），而且新的一条还没拿到任何密钥，
   * 不能挂着「已保存」那个标记——那说的是别的那一套。
   */
  const openNewDialog = (cap: ProfileCapability) => {
    const source = currentRow(cap) ?? profiles?.profiles[cap][0]
    setProfileDraft({
      capability: cap,
      mode: 'new',
      profileId: '',
      fields: fieldsOf(cap, source?.values ?? {}),
      apiKey: '',
      keyStatus: 'none',
      keyCleared: false,
      // 这一档现在没有「当前使用」那一条（一条都没建过，或上一条刚被删掉）时，建出来这套默认就该勾上，
      // 否则用户还得再进去翻一次开关才能开工；本来就有在用的那条时不顶掉它
      isCurrent: !(profiles?.defaultProfileId[cap] ?? ''),
    })
    invalidateTest(cap)
  }

  /** 某一行的「编辑」＝为那一条开弹窗：草稿照磁盘上这一条的字段起手，Key 一样不回显 */
  const openEditDialog = (cap: ProfileCapability, profileId: string) => {
    const profile = profiles?.profiles[cap].find((item) => item.id === profileId)
    // 方案不在列表里＝列表刚被别处改掉，不能拿旧数据开一份要写盘的草稿
    if (!profile) {
      toast.error('这条方案已经不在列表里了，关掉设置窗口重开一次再看', 9000)
      return
    }
    setProfileDraft({
      capability: cap,
      mode: 'edit',
      profileId: profile.id,
      fields: fieldsOf(cap, profile.values),
      apiKey: '',
      keyStatus: profile.keyStatus,
      keyCleared: false,
      isCurrent: profile.id === (profiles?.defaultProfileId[cap] ?? ''),
    })
    invalidateTest(cap)
  }

  /**
   * 弹窗的「取消」／右上角 X／Esc：草稿整个丢掉。
   * 磁盘没动、`values` 也没动——那几格从没进过表单，所以不存在「要收回哪几个字」的问题，
   * 更不用重拍 snapshot（把全局段里还没保存的改动一起洗成「已保存」的那种错账就是这么来的）。
   */
  const closeDialog = () => setProfileDraft(null)

  /**
   * 档位下拉（转写模式／配音引擎）除了改值，还要把这一档的弹窗一起收掉：
   * 方案列表只在走云端时出现，留着一份看不见的新建草稿，切回云端时它当着用户的面重新弹出来——
   * 那已经不是他要填的东西了。
   */
  const closeDraftOf = (cap: ProfileCapability) => {
    setProfileDraft((prev) => (prev && prev.capability === cap ? null : prev))
  }

  const handleAsrProviderChange = (provider: string) => {
    updateField('asrProvider', provider)
    if (provider !== 'cloud') closeDraftOf('asr')
  }

  const handleTtsEngineChange = (engine: string) => {
    updateField('ttsEngine', engine)
    if (engine !== 'cloud') closeDraftOf('tts')
  }

  /** 弹窗里改一格（服务商那格连带填的地址／模型由 `ProfileDialog` 按字段表发） */
  const setDraftField = (key: string, value: string) =>
    setProfileDraft((prev) => (prev ? { ...prev, fields: { ...prev.fields, [key]: value } } : prev))

  /** 在密钥框里打字＝要替换，之前点的「清除」作废 */
  const setDraftKey = (value: string) =>
    setProfileDraft((prev) =>
      prev ? { ...prev, apiKey: value, keyCleared: value ? false : prev.keyCleared } : prev
    )

  const clearDraftKey = () =>
    setProfileDraft((prev) => (prev ? { ...prev, apiKey: '', keyCleared: true } : prev))

  const setDraftCurrent = (isCurrent: boolean) =>
    setProfileDraft((prev) => (prev ? { ...prev, isCurrent } : prev))

  /**
   * 弹窗底部那颗「保存」：**当场写盘**（用户拍板的口径，第⑥步）。
   *
   * 新建走 `createProfile`，`fromProfileId: ''` 是主进程那侧「一条全空白」的暗号——凭据全部以弹窗里
   * 那几格为准，一家网关的 API Key 不会跟着搬过来（密钥属于那一家，悄悄复制到另一套里，
   * 下一次干活按谁计价就没人说得清了）。编辑走 `settings:save`，补丁里只带这一档那几格和指针，
   * 全局段与另两档一个字节都不动：界面没有「改一条已有方案」的专用通道，凭据的写入本来就是 save 那条路。
   */
  const commitDialog = async () => {
    if (!api || !profileDraft || profileBusy || draftSaving) return
    const draft = profileDraft
    const cap = draft.capability
    const keyField = keyFieldOf(cap)
    const spec = PROFILE_CAP_SPEC[cap]
    const typedKey = draft.apiKey.trim()
    setDraftSaving(true)
    try {
      if (draft.mode === 'new') {
        const before = new Set((profiles?.profiles[cap] ?? []).map((profile) => profile.id))
        const wasEmpty = before.size === 0
        const view = await runProfileAction(() =>
          api.createProfile(cap, {
            fromProfileId: '',
            values: { ...draft.fields, [keyField]: typedKey },
            setDefault: draft.isCurrent,
          })
        )
        if (!view) return
        refreshVoicePage(cap)
        const created = view.profiles[cap].find((profile) => !before.has(profile.id))
        if (!created) {
          toast.error(
            '说好了要新建一条，可列表里没多出来。关掉设置窗口重开一次，再看磁盘上是什么样',
            12000
          )
          return
        }
        const keyNote = created.keyStatus === 'none' ? '' : '，API Key 也一起存好了'
        const currentNote =
          created.id === view.defaultProfileId[cap]
            ? `它现在就是「当前使用」的那一套，下一次${spec.activity}按它走`
            : `当前使用的还是原来那一条——要换过来，进这一行的「编辑」勾上「当前使用」再保存`
        toast.success(
          wasEmpty
            ? `磁盘上一条${spec.listLabel}都没有，已先建好「${profileRowTitle(cap, created)}」${keyNote}，它就是当前使用的那一套`
            : `已建好「${profileRowTitle(cap, created)}」${keyNote}。${currentNote}`,
          6000
        )
        closeDialog()
        return
      }

      const onDisk = profiles?.defaultProfileId[cap] ?? ''
      const patch: Record<string, unknown> = {
        profileIds: { [cap]: draft.profileId },
        ...draft.fields,
      }
      // Key 那格三态：留空＝不改（整个键不发）、点了「清除」＝null、有字＝替换
      if (typedKey) patch[keyField] = typedKey
      else if (draft.keyCleared) patch[keyField] = null
      // 指针只在用户真翻过那颗勾选时才发：没翻过就不带这个键，主进程那边「缺席＝不挪」。
      // 照当前值发下去，用户只是进来改个模型名，出去之后这一档却被拦下说「没有当前使用的方案」
      const pointerChanged = draft.isCurrent !== (draft.profileId === onDisk)
      if (pointerChanged)
        patch.defaultProfileIds = { [cap]: draft.isCurrent ? draft.profileId : '' }
      const result = await api.saveSettings(patch)
      // 没写进磁盘就到此为止：弹窗留着、里面那几个字留着，用户修好磁盘空间或权限可以直接再点一次
      if (result?.saveError) {
        toast.error(result.saveError, 15000, {
          label: '打开数据目录',
          onClick: handleOpenUserDataDirectory,
        })
        return
      }
      const fresh = await api.listProfiles().catch(() => null)
      const row = fresh?.profiles[cap].find((profile) => profile.id === draft.profileId)
      if (fresh) applyProfiles(fresh)
      refreshVoicePage(cap)
      const keyNote = typedKey
        ? '，含新填的 API Key'
        : draft.keyCleared
          ? '，那把已保存的 Key 也从磁盘清掉了'
          : ''
      const pointerNote = pointerChanged
        ? draft.isCurrent
          ? `；它现在是「当前使用」的那一套，下一次${spec.activity}按它走`
          : `；这一档现在没有「当前使用」的方案，${spec.activity}会被拦下，要用的话进某一行的「编辑」勾上再保存`
        : ''
      const staleNote = fresh
        ? ''
        : '；方案列表这次没跟着刷新，关掉设置窗口重开一次看到的才是磁盘上真实的样子'
      // 这一句要说的是列表上那一行显示的东西：行标题是模型名优先，方案名建那条时按当时的模型落定、
      // 之后不跟着改（弹窗里没有改名格），照 `name` 念就成了「已存好「whisper-large-v3」」、
      // 而行上写着刚改的模型名——用户会以为存错了地方
      const rowTitle = profileRowTitle(cap, row, draft.fields[spec.titleKey] || '这一套')
      toast.success(`已存好「${rowTitle}」的凭据${keyNote}${pointerNote}${staleNote}`, 6000)
      closeDialog()
    } catch {
      toast.error('这次保存没能确认。关掉设置窗口重开一次，再看磁盘上是什么样', 9000)
    } finally {
      setDraftSaving(false)
    }
  }

  const handleDeleteProfile = async (
    cap: ProfileCapability,
    profileId: string
  ): Promise<boolean> => {
    if (!api) return false
    const deleted = profiles?.profiles[cap].find((profile) => profile.id === profileId)
    const deletedName = profileRowTitle(cap, deleted, '这一套')
    // 「含它保存的 API Key」要说得有条件：这一套没填过 Key 时（自建网关、或只填了地址的草稿），
    // 括号里那句就是凭空多出来的恐吓，用户会以为删掉了一把还在别处用的密钥
    const keyTail = deleted && deleted.keyStatus !== 'none' ? '（含它保存的 API Key）' : ''
    const view = await runProfileAction(() => api.deleteProfile(cap, profileId))
    if (!view) return false
    refreshVoicePage(cap)
    const spec = PROFILE_CAP_SPEC[cap]
    // 面板上没有表单了（凭据住进弹窗），所以这里要说的是「谁还在干活」，
    // 而不是「正在编辑哪一套」——这时屏幕上根本没有正在编辑的东西。
    // 删到一条不剩说在最前：这一档指针为空时走的是「没有当前使用」那一句，
    // 照那个顺序说就成了「列表照旧」——而列表刚刚空了
    let tail: string
    if (view.profiles[cap].length === 0)
      tail = `${spec.activity}现在一条方案都没有了：点「新建API接入」，在弹窗里填好那几格再点「保存」`
    else {
      const current = view.profiles[cap].find(
        (profile) => profile.id === view.defaultProfileId[cap]
      )
      tail = current
        ? `当前使用的还是「${profileRowTitle(cap, current)}」那一条，它一个字没动`
        : `这几套里现在没有「当前使用」的那一条，${spec.activity}会被拦下：进某一行的「编辑」勾上再保存`
    }
    toast.success(`已删掉「${deletedName}」${keyTail}，${tail}`, 6000)
    return true
  }

  const loadDictVersion = useCallback(async () => {
    if (!api) return
    try {
      const version = await api.getDictionaryVersion()
      setDictVersion(version)
    } catch {
      /* ignore */
    }
  }, [api])

  // 表单值只在窗口打开后拉一次磁盘值；切 Tab 再拉会把用户刚填没存的内容静默冲掉
  useEffect(() => {
    if (!tab) {
      setHydrated(false)
      setConfirmDiscard(false)
      setTestResults({})
      // 关窗就把方案列表一起收掉：下次打开要按磁盘上那一刻的样子重新认一遍有哪几条，
      // 留着旧列表会让弹窗的「保存」带着一条已经不存在的 id 去写盘
      setProfiles(null)
      // 弹窗里那份草稿也一起收掉：窗口开着的时候还没落盘的东西不该跨开关窗活下来，
      // 否则下一次打开先跳出一句「有未保存的修改」，而用户根本不记得它
      setProfileDraft(null)
      return
    }
    if (hydrated || !api) return
    ;(async () => {
      let loaded: SettingsValues = DEFAULT_VALUES
      let settingsRead = false
      try {
        const saved = await api.getSettings()
        settingsRead = saved !== null
        if (saved === null) {
          // 读失败现在回 null（IPC 收口后不再 reject，见 ipc/guard.ts）。表单会落满默认值，
          // 用户看着像「磁盘上本来就是这些」，顺手点保存就把真那份盖掉了——这句必须在他动手前说
          toast.error(
            '设置读不出来。下面显示的是默认值，先别保存，否则会覆盖磁盘上那份。',
            15000,
            {
              label: '打开数据目录',
              onClick: () => void openUserDataDirectory(),
            }
          )
        } else if (Object.keys(saved).length > 0) {
          // 只挑全局段那六格。脱敏视图里还带着各档「当前使用」那条投影出来的凭据
          // （地址／模型／服务商），那些住在列表那一行上、要改走弹窗，
          // 整份盖进表单就成了「屏幕上看不见、却跟着保存发出去」的值
          const picked: Partial<SettingsValues> = {}
          for (const key of GLOBAL_VALUE_KEYS) {
            const value = saved[key]
            if (typeof value === 'string') picked[key] = value
          }
          loaded = { ...DEFAULT_VALUES, ...picked }
          setEncryptable(saved.keyEncryptionAvailable !== false)
        }
      } catch {
        loaded = DEFAULT_VALUES
      }
      setValues(loaded)
      setSnapshot(JSON.stringify(loaded))
      setHydrated(true)
      // 列表和表单值是两次独立的读：getSettings 成功而列表读失败时，字段是真的、只是看不见别的方案。
      // 两边套在同一个 try 里，一次 listProfiles 抖动会把已经读到的字段打回默认值，那才是真丢数据
      let view: ProfilesView | null = null
      try {
        view = await api.listProfiles()
      } catch {
        view = null
      }
      if (view) {
        // 走 applyProfiles 而不是只 setProfiles：开设置这一次读也是「磁盘此刻的样子」，
        // 三个页面那条下拉得跟它一起对齐，否则在别处改过方案（或上一次 CRUD 的回执没回来）时，
        // 回到页面上看到的还是开设置之前那份清单。
        applyProfiles(view)
      } else if (settingsRead) {
        toast.error(
          '配置方案列表这次没读出来。下面那几个全局字段是真值，方案没丢；新建 / 编辑 / 删除先不要用，关掉设置窗口重开一次再看',
          15000
        )
      }
    })()
  }, [tab, api, hydrated])

  useEffect(() => {
    if (!tab || !api) return
    if (tab === 'ai') loadDictVersion()
    if (tab === 'theme') setThemeValue(useThemeStore.getState().theme)
    if (tab === 'about') {
      setUpdateInfo(null)
      setYtDlpRemote(null)
      setYtDlpHasUpdate(false)
      ;(async () => {
        try {
          setAppVersion(await api.getAppVersion())
        } catch {
          /* ignore */
        }
      })()
      // 这一栏要 spawn 一次组件进程（内置那份第一次跑要解包，本机实测一两秒），
      // 所以只在打开关于页时读一次，不进轮询、不在别的 Tab 触发
      setYtDlpLocal(null)
      ;(async () => {
        try {
          const snapshot = await api.getYtDlpLocal()
          setYtDlpLocal(snapshot)
          // 版本栏只会说「读不出来」，原因（多半是那份二进制被系统拦住执行）得靠 toast 才看得到
          if (snapshot.error) toast.error(`链接解析组件读不出来：${snapshot.error}`, 10000)
        } catch (err) {
          setYtDlpLocal({
            info: null,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    }
  }, [tab, api, loadDictVersion])

  /** 保存后保持窗口打开：用户下一步往往就是点「测试连接」，关窗等于逼他重开 */
  const handleSave = async () => {
    if (!api) return
    setSaving(true)
    try {
      // 这次保存只写全局段那六格。三档的凭据都住在「新建API接入／编辑API接入」那个弹窗里，
      // 由它自己那颗「保存」当场写盘（#222 重写第⑥⑦⑧步）。跟着带上凭据键有一个真会撞的坑：
      // 某一档一条方案都没有时，主进程把「补丁带着凭据却没有方案」当成「你要存却没先建」，
      // 整次保存被拦下——本机 CDP 实测过：删掉最后一条方案后只改「转写语言」点保存，
      // 盘上 asrLanguage 停在 zh，而用户从头到尾没碰过凭据那几格。没有归宿的字段就不发。
      const result = await api.saveSettings({ ...values })
      // 没写进磁盘就到此为止。后面那几步——更新快照、报「设置已保存」——
      // 全都建立在「存下了」之上；少弹这一句却多报一句成功，就是当着用户的面撒谎。
      // 界面上填的内容原样留着，用户修好磁盘空间或权限后可以直接再点一次。
      if (result?.saveError) {
        toast.error(result.saveError, 15000, {
          label: '打开数据目录',
          onClick: handleOpenUserDataDirectory,
        })
        return
      }
      setSnapshot(JSON.stringify(values))
      // 这台机器能不能加密，以刚写盘那次的回话为准（前一次不可用、这一次又活了的情况真实存在）
      if (result?.settings) setEncryptable(result.settings.keyEncryptionAvailable !== false)
      if (tab === 'theme') setTheme(themeValue as 'light' | 'dark')
      // 配音页抬头的档位只在「进页」时读一次设置（useVoiceStudioStore.setTab → loadConfig），
      // 就地保存不重读就会继续显示刚换掉的那一档，看着像没保存上。这里替用户补读一次。
      if (tab === 'tts') void useVoiceStudioStore.getState().loadConfig()
      // 换档位要重启引擎（离线标志只能在启动时定），没重启成功就等于新档位还没吃到，必须说
      if (result?.error) {
        toast.error(result.error, 9000)
      } else if (result?.tierRestart === 'done') {
        toast.success('设置已保存，本地引擎已按新档位重启')
      } else {
        toast.success('设置已保存')
      }
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const requestClose = () => {
    if (isDirty) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }

  // 连点守卫只能放 ref：state 在同一次渲染里读不到刚 set 的值，快速点三下会放行三次
  const testingRef = useRef(false)
  const restartingRef = useRef(false)
  const restartingVoiceRef = useRef(false)

  /** 表单里选的配音引擎档位（还没点保存也算）——本地档和云端档要问的不是同一套字段 */
  const ttsLocal = values.ttsEngine === 'local'
  /** 界面当前问的那一档：用户在下拉里换了但没保存，也要按新档去查状态、给建议 */
  const selectedTtsEngine = values.ttsLocalEngine || LOCAL_TTS_DEFAULT_ENGINE
  /** 这一档「用得起来才知道的坑」，空串＝没有 */
  const selectedTtsCaveat = localTtsEngineCaveat(selectedTtsEngine)
  /**
   * 本地档的状态快照（问一次不拉起引擎）：下拉里每一行都得标得出「这一档的模型还没下载」，
   * 所以两档一起问，而不是只问当前选中的那档。null＝还没读到，界面上不许把它当「都不缺」渲染。
   * speakers 只认当前选中那一档的数——VITS 与 Kokoro 的音色数不同，拿别的档的数列编号等于骗人。
   */
  const [localVoiceState, setLocalVoiceState] = useState<{
    speakers: number
    binaryPresent: boolean
    /** 本版清单里有没有引擎这一条：null＝还没读过清单，false＝这一版没有它的下载包 */
    binaryInManifest: boolean | null
    modelPresent: Record<string, boolean>
  } | null>(null)
  /** 测连接、重启跑完引擎就活了，音色数能按 /health 实报的数校正一遍；不留神这里会一直停在档位表那份 */
  const [voiceStateTick, setVoiceStateTick] = useState(0)

  useEffect(() => {
    if (tab !== 'tts' || !api || !ttsLocal) return
    let cancelled = false
    const ids = LOCAL_TTS_ENGINE_OPTIONS.map((option) => option.value)
    void Promise.all(ids.map((id) => api.getLocalVoiceStatus(id).catch(() => null))).then(
      (statuses) => {
        if (cancelled) return
        const modelPresent: Record<string, boolean> = {}
        statuses.forEach((status) => {
          if (status) modelPresent[status.requestedEngine] = status.modelPresent
        })
        // 按主进程回的 requestedEngine 认领那一份：设置里存着白名单外的旧 id 时它会换回默认档，
        // 这边跟着换，否则下拉标的是默认档、提示讲的是用户选的那一档，两句话对不上。
        const current =
          statuses.find((status) => status?.requestedEngine === selectedTtsEngine) ??
          statuses.find((status) => status?.requestedEngine === LOCAL_TTS_DEFAULT_ENGINE) ??
          null
        if (!current) {
          setLocalVoiceState(null)
          return
        }
        setLocalVoiceState({
          speakers: current.speakers,
          binaryPresent: current.binaryPresent,
          binaryInManifest: current.binaryInManifest,
          modelPresent,
        })
      }
    )
    return () => {
      cancelled = true
    }
  }, [tab, api, ttsLocal, selectedTtsEngine, voiceStateTick])

  const handleTestConnection = async (kind: 'asr' | 'ai' | 'tts') => {
    if (!api || testingRef.current) return
    testingRef.current = true
    setTestingKind(kind)
    try {
      // 三档同一口径（#222 重写第⑥⑧步）：凭据住在弹窗里，面板上这次测的是**磁盘上「当前使用」那一条**。
      // 不能拿弹窗里那几个字——它收着时屏幕上根本没有那份内容，开着时那是还没落盘的草稿；
      // 而真转写／校对／配音取值的也正是这一条，按别的套绿了等于给用户一张救不了命的合格证。
      const fields = currentRow(kind)?.values ?? {}
      const payload =
        kind === 'asr'
          ? {
              provider: values.asrProvider,
              apiBase: fields.asrApiBase ?? '',
              apiKey: '',
              model: fields.asrModel ?? '',
            }
          : kind === 'tts'
            ? {
                // 档位与本地引擎取表单当前值：主进程那边「测的就是你刚选的那个组合」，
                // 读已保存设置会测到另一档上去（表单没保存时尤其明显）
                engine: values.ttsEngine,
                localEngine: values.ttsLocalEngine,
                apiBase: fields.ttsApiBase ?? '',
                apiKey: '',
                model: fields.ttsModel ?? '',
                // 本地档的编号跟着表单走（换引擎时上面那个下拉会归回第一个）；
                // 云端档这一页压根没有音色格（1.1.0 起它不在方案里），传空串让主进程回落成
                // 设置里那一份全局值——测的必须是真配音会发的那一份，不然合格证救不了命
                voice: ttsLocal ? values.ttsLocalVoice : '',
              }
            : { apiBase: fields.aiApiBase ?? '', apiKey: '', model: fields.aiModel ?? '' }
      // Key 一律留空（密钥从不过 IPC），主进程那边按这条 id 回落到它保存的那把；
      // 配音这一腿再往回落一次——地址与 Key 留空时沿用的是校对档当前默认那条，和真配音同一条路。
      // 为什么只带被测这一档的 id 而不是三档都带：真配音时那一步读的是校对的**默认**那条
      // （getTTSConfig 只挑 tts 一条）。跟着界面把校对也换成 B 套，就会出现
      // 「自检按 B 家网关绿了、点开始配音却走 A 家」这种最难解释的分歧。
      const profileId = currentRow(kind)?.id ?? ''
      const result = await api.testConnection(kind, payload, profileId || undefined)
      setTestResults((prev) => ({ ...prev, [kind]: result }))
      if (kind === 'tts') setVoiceStateTick((prev) => prev + 1)
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [kind]: {
          level: 'fail',
          title: '测试没能跑完',
          message: '应用内部出错，请关闭设置窗口后重试',
        } as TestOutcome,
      }))
    } finally {
      testingRef.current = false
      setTestingKind(null)
    }
  }

  /**
   * 引擎起不来不必退出应用：首启下载模型失败、被外部杀掉这类情况，重启一次就能恢复。
   * 最长可能等 60 秒（首次要下载模型），所以按钮必须有「重启中」态，否则像坏了。
   */
  const handleRestartEngine = async () => {
    if (!api || restartingRef.current || testingRef.current) return
    restartingRef.current = true
    setRestarting(true)
    try {
      const result = await api.restartLocalEngine()
      if (result.ok) {
        toast.success('本地引擎已重启，可以直接开始转写')
        await handleTestConnection('asr')
      } else {
        toast.error(result.error || '本地引擎重启失败，请稍后再试', 8000)
      }
    } catch {
      toast.error('本地引擎重启失败。可在「关于与更新 → 打开日志文件夹」取日志后重新安装', 8000)
    } finally {
      restartingRef.current = false
      setRestarting(false)
    }
  }

  /**
   * 本地配音引擎起不来时，应用内的出路。主进程那条 IPC 只认磁盘上已保存的那一档
   * （这边表单换了引擎没点保存，重启的还是保存过的），所以文案要把这一点写在按钮旁边。
   * 首启要解包、慢盘更久，所以和转写引擎一样必须有「重启中」态。
   */
  const handleRestartVoiceEngine = async () => {
    if (!api || restartingVoiceRef.current || testingRef.current) return
    restartingVoiceRef.current = true
    setRestartingVoice(true)
    try {
      const result = await api.restartLocalVoiceEngine()
      if (result.ok) {
        toast.success('本地配音引擎已重启，可以去配音页直接跑')
        // 重问一次状态刷新「组件在不在、端口活不活」。模型是第一次真合成才进内存的，重启后
        // /health 那一栏仍是 0，此时音色列表用的是档位表里那份实测值——不是「只列得出一个」。
        setVoiceStateTick((prev) => prev + 1)
      } else {
        toast.error(result.error || '本地配音引擎重启失败，请稍后再试', 8000)
      }
    } catch {
      toast.error('本地配音引擎重启失败。可在「关于与更新 → 打开日志文件夹」取日志后重新下载组件', 8000)
    } finally {
      restartingVoiceRef.current = false
      setRestartingVoice(false)
    }
  }

  const handleCheckDictUpdate = async () => {
    if (!api || dictUpdating) return
    setDictUpdating(true)
    try {
      const result = await api.checkDictionaryUpdate()
      if (result.error) {
        toast.error(`检查词库更新失败：${result.error}`)
        return
      }
      if (!result.hasUpdate) {
        toast.info('词库已是最新版本')
        return
      }
      toast.loading('正在下载词库更新...')
      const download = await api.downloadDictionaryUpdate()
      if (download.success) {
        toast.success('词库更新成功')
        await loadDictVersion()
      } else {
        toast.error(`词库更新失败：${download.error || '未知错误'}`)
      }
    } catch {
      toast.error('检查词库更新失败')
    } finally {
      setDictUpdating(false)
    }
  }

  /**
   * 链接解析组件（yt-dlp）检查更新：清单里的版本比本机这版新才给「更新」按钮。
   * 网络不通时主进程回的是拼好的中文说明，直接 toast 出来，不要转成「未知错误」。
   */
  const handleCheckYtDlpUpdate = async () => {
    if (!api || ytDlpChecking || ytDlpApplying) return
    setYtDlpChecking(true)
    try {
      const result = await api.checkYtDlpUpdate()
      // 检查那一步顺带把本机快照也带回来了；信封里的 error 是「清单/网络」的原因，与本机探测无关，故留 null
      if (result.local) setYtDlpLocal({ info: result.local, error: null })
      if (!result.ok) {
        toast.error(result.error || '检查链接解析组件更新失败', 8000)
        return
      }
      setYtDlpRemote(result.remote ?? null)
      setYtDlpHasUpdate(!!result.hasUpdate)
      if (result.hasUpdate) {
        toast.info(`链接解析组件可更新到 ${result.remote?.version}`, 6000)
      } else {
        // 清单可能比本机这版还旧，那句「已是最新」要带上当前的版本号，否则用户无从判断自己在用哪版
        toast.info(
          `链接解析组件无需更新（本机 ${result.local?.version ?? '版本未知'}，清单 ${result.remote?.version}）`,
          6000
        )
      }
    } catch {
      toast.error('检查链接解析组件更新失败：应用内部出错', 8000)
    } finally {
      setYtDlpChecking(false)
    }
  }

  /**
   * 下载约 37MB，慢网里要跑几分钟，所以必须订阅进度：
   * 只有按钮文字在变而不报字节，用户没法判断是真在动还是卡死了。
   */
  const handleApplyYtDlpUpdate = async () => {
    if (!api || ytDlpApplying || ytDlpChecking) return
    setYtDlpApplying(true)
    setYtDlpProgress(null)
    const unsubscribe = api.onYtDlpProgress?.((data) => setYtDlpProgress(data))
    try {
      const result = await api.applyYtDlpUpdate()
      if (result.success) {
        toast.success(`链接解析组件已更新到 ${result.version}，下次解析链接就用它`, 8000)
        // 换的是 userData/bin 里的那一份，本机生效版本随之改变，要重新探一次再显示
        setYtDlpHasUpdate(false)
        const snapshot = await api.getYtDlpLocal()
        setYtDlpLocal(snapshot)
        if (snapshot.error) toast.error(`更新装上了，但本机这版读不出来：${snapshot.error}`, 10000)
      } else if (result.systemSettingsHint) {
        // 与链接解析失败同一套处理：主进程判定「像是系统拦住执行」时才给一键直达隐私设置的入口
        toast.error(result.error || '链接解析组件更新失败', 10000, {
          label: '打开隐私设置',
          onClick: () => {
            void api.openSystemSettings()
          },
        })
      } else {
        toast.error(result.error || '链接解析组件更新失败', 10000)
      }
    } catch {
      toast.error('链接解析组件更新失败：应用内部出错', 8000)
    } finally {
      unsubscribe?.()
      setYtDlpProgress(null)
      setYtDlpApplying(false)
    }
  }

  /**
   * 「问不出新版本」有两条来路：主进程回值里的 error（IPC 收口后走这条，见 ipc/guard.ts）
   * 和渲染层自己吃到的 reject（通道压根没注册）。两条共用同一个出口——
   * 失败几乎都是国内直连 GitHub 慢/被拦，只甩一句「请检查网络」用户手里没有第二个入口，
   * 所以给可复制的发布页直链，让他开加速或换官网下载。
   */
  const toastReleasePageUnavailable = (reason?: string | null) => {
    const releasePage = 'https://github.com/DaQI-X/Vv-Transcribe/releases/latest'
    toast.error(
      `连不上发布服务器（多为国内直连 GitHub 过慢所致）${reason ? `，主进程那边的原话是：${reason}` : ''}。可复制发布页地址，开网络加速后用浏览器下载，或访问官网 vvscribe.com`,
      9000,
      {
        label: '复制发布页',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(releasePage)
            toast.success('发布页地址已复制，可在浏览器粘贴打开')
          } catch {
            void handleOpenExternal(releasePage)
          }
        },
      }
    )
  }

  const handleCheckUpdate = async () => {
    if (!api || checking) return
    setChecking(true)
    try {
      const info = await api.checkAppUpdate()
      setUpdateInfo(info)
      if (info.error) {
        // 绝不能落到下面那句「当前已是最新版本」——那是没查出来，不是查过了发现没有新版
        toastReleasePageUnavailable(info.error)
      } else if (info.hasUpdate) {
        toast.info(`发现新版本 v${info.latestVersion}`)
      } else {
        toast.info(`当前已是最新版本（v${info.currentVersion}）`)
      }
    } catch {
      toastReleasePageUnavailable()
    } finally {
      setChecking(false)
    }
  }

  const handleOpenLogDirectory = async () => {
    if (!api) return
    try {
      const result = await api.openLogDirectory()
      if (!result.success) {
        toast.error(`打开日志文件夹失败：${result.error || '未知原因'}`)
      }
    } catch {
      toast.error('打开日志文件夹失败')
    }
  }

  /**
   * 设置读不出来时唯一的自救入口：corrupt 留档的原件和上一次的 .bak 都住在这一层。
   * 实现放在 utils/userData，保存失败的 toast 用的是同一个（措辞必须与主进程那句话对上）。
   */
  const handleOpenUserDataDirectory = () => void openUserDataDirectory()

  const copyContactEmail = async (email: string) => {
    try {
      await navigator.clipboard.writeText(email)
      toast.success(`邮箱地址已复制：${email}`)
    } catch {
      toast.error(`复制失败，请手动记下：${email}`)
    }
  }

  const handleContactDeveloper = async () => {
    if (!api) return
    try {
      const result = await api.contactDeveloper()
      if (!result.success) {
        // 系统没配默认邮件客户端时 openExternal 会直接失败，此时复制地址是唯一出路
        toast.error(`打不开邮件客户端：${result.error || '系统可能没有默认的邮件应用'}`, 9000, {
          label: '复制邮箱地址',
          onClick: () => copyContactEmail(result.email || CONTACT_EMAIL),
        })
        return
      }
      // 成功只代表「已经把 mailto 交给系统」，macOS 上没装邮件应用时也不会报错，
      // 所以不把话说成「已打开写信窗口」；面板上的「复制邮箱地址」就是留好的退路。
      toast.info(
        '已把邮件交给系统默认邮件客户端。若没有任何反应，说明没配默认邮件应用，可点「复制邮箱地址」自行发送',
        9000
      )
    } catch {
      toast.error('唤起邮件客户端失败')
    }
  }

  const handleCopyContactEmail = () => copyContactEmail(CONTACT_EMAIL)

  const handleOpenExternal = async (url: string) => {
    if (!api) return
    const result = await api.openExternal(url)
    if (!result.success) {
      toast.error(`打开链接失败：${result.error}`)
    }
  }

  /**
   * 三档「当前使用」那一条＝自检那颗按钮的被测对象。
   * 读列表而不是读表单：弹窗里没点「保存」的那些字还没落盘，而真转写／校对／配音用的正是磁盘上这一条；
   * 这一档没有「当前使用」时按钮按不动，为什么按不动写在每个 Tab 的自检提示里。
   */
  const asrRow = currentRow('asr')
  const aiRow = currentRow('ai')
  const ttsRow = currentRow('tts')

  if (!tab) return null

  /**
   * 这个 Tab 上还有没有「右下角那颗保存设置」写得到的字段。
   * 校对一档从第⑧步起一个全局字段都没有（服务商／地址／Key／模型四格全住在弹窗里，当场落盘），
   * 那里再留一颗按钮，点下去弹的是「设置已保存」——而盘上什么都没变。
   */
  const hasPanelFields = tab !== 'about' && tab !== 'ai'

  return (
    <div className="settings-overlay" onClick={requestClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal__header">
          <span className="settings-modal__title">{TAB_TITLES[tab]}</span>
          <button className="settings-modal__close" onClick={requestClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-modal__body">
          {tab === 'asr' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">转写模式</label>
                <select
                  className="settings-form-select"
                  value={values.asrProvider}
                  onChange={(e) => handleAsrProviderChange(e.target.value)}
                >
                  <option value="local">本地转写（默认）</option>
                  <option value="cloud">云端优先（需配置 API Key）</option>
                </select>
                <span className="settings-form-hint">
                  决定音频在本机转还是发去云端，对整个应用生效。选「云端优先」才会出现下面的方案列表
                </span>
              </div>
              {values.asrProvider !== 'cloud' && (
                <div className="settings-form-group">
                  <label className="settings-form-label">本地模型档位</label>
                  <select
                    className="settings-form-select"
                    value={values.asrLocalModel}
                    onChange={(e) => updateField('asrLocalModel', e.target.value)}
                  >
                    {LOCAL_MODEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <span className="settings-form-hint">
                    {values.asrLocalModel === 'small'
                      ? '精准档实测能把「英雄觉醒在即」听对，快速档这一段听成了「英雄绝性在急」。代价：首次下载约 461MB，耗时约为快速档的 2.8 倍。保存后引擎自动重启一次'
                      : '快速档：权重约 138MB，实测转一分钟音频约 5–9 秒；中文里偶有「英雄觉醒在即」被听成「英雄绝性在急」这类改意思的同音错字，字幕要求严就切精准档。保存后引擎自动重启一次'}
                  </span>
                </div>
              )}
              <div className="settings-form-group">
                <label className="settings-form-label">转写语言</label>
                <select
                  className="settings-form-select"
                  value={values.asrLanguage}
                  onChange={(e) => updateField('asrLanguage', e.target.value)}
                >
                  {ASR_LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="settings-form-hint">
                  本地和云端都按这个语言转写，保存后对下一次生效。选错会整段跑偏、甚至输出成另一种语言的翻译；
                  非中文暂不支持本地校对（误听表和词库都是中文的），要走「校对配置」里的 AI 校对
                </span>
              </div>
              {values.asrProvider === 'cloud' && (
                <ProfileList
                  capability="asr"
                  profiles={profiles}
                  editingId={profileDraft?.profileId ?? ''}
                  pane={profileDraft ? profileDraft.mode : 'closed'}
                  busy={profileBusy || draftSaving}
                  onEdit={(profileId) => openEditDialog('asr', profileId)}
                  onCreate={() => openNewDialog('asr')}
                  onDelete={(profileId) => handleDeleteProfile('asr', profileId)}
                />
              )}
              <div className="settings-form-group">
                <label className="settings-form-label">配置自检</label>
                <button
                  type="button"
                  onClick={() => handleTestConnection('asr')}
                  disabled={testingKind !== null || (values.asrProvider === 'cloud' && !asrRow)}
                  className="settings-modal__dict-update-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Plug size={12} />
                  {testingKind === 'asr'
                    ? '检查中...'
                    : values.asrProvider === 'cloud'
                      ? '测试连接'
                      : '检查引擎状态'}
                </button>
                {values.asrProvider !== 'cloud' && (
                  <button
                    type="button"
                    onClick={handleRestartEngine}
                    disabled={restarting || testingKind !== null}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}
                  >
                    <RotateCcw size={12} />
                    {restarting ? '重启中…' : '重启本地引擎'}
                  </button>
                )}
                <span className="settings-form-hint">
                  {values.asrProvider === 'cloud'
                    ? !asrRow
                      ? testBlockedHint('asr')
                      : `按「当前使用」那一套（${profileRowTitle('asr', asrRow, '没填模型')}）已保存的地址、模型和 Key 真实走一次转写接口：上传 1 秒静音，花费可忽略。弹窗里没点「保存」的那些字不算`
                    : '只检查本机引擎是否在线，不发网络请求；引擎没起来点「重启本地引擎」，不用退出应用'}
                </span>
                {testResults.asr && <TestResultView result={testResults.asr} />}
              </div>
            </>
          )}

          {tab === 'ai' && (
            <>
              {/* 校对这一档没有全局字段：屏幕上从「服务商」到「模型」那四格全住在弹窗里，
                  点这一栏的「新建API接入 / 编辑」当场写盘，右下角那颗「保存设置」在这里一个字都不写。 */}
              <ProfileList
                capability="ai"
                profiles={profiles}
                editingId={profileDraft?.profileId ?? ''}
                pane={profileDraft ? profileDraft.mode : 'closed'}
                busy={profileBusy || draftSaving}
                onEdit={(profileId) => openEditDialog('ai', profileId)}
                onCreate={() => openNewDialog('ai')}
                onDelete={(profileId) => handleDeleteProfile('ai', profileId)}
              />
              <div className="settings-form-group">
                <label className="settings-form-label">配置自检</label>
                <button
                  type="button"
                  onClick={() => handleTestConnection('ai')}
                  disabled={testingKind !== null || !aiRow}
                  className="settings-modal__dict-update-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Plug size={12} />
                  {testingKind === 'ai' ? '检查中...' : '测试连接'}
                </button>
                <span className="settings-form-hint">
                  {!aiRow
                    ? testBlockedHint('ai')
                    : `按「当前使用」那一套（${profileRowTitle('ai', aiRow, '没填模型')}）已保存的地址、模型和 Key 发一条最短的校对请求（花费可忽略），确认这个模型能按我们的 JSON 格式返回。弹窗里没点「保存」的那些字不算`}
                </span>
                {testResults.ai && <TestResultView result={testResults.ai} />}
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">本地词典</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>
                    {dictVersion ? `v${dictVersion}` : '未加载'}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckDictUpdate}
                    disabled={dictUpdating}
                    className="settings-modal__dict-update-btn"
                  >
                    {dictUpdating ? '检查中...' : '检查更新'}
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'tts' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">配音引擎</label>
                <select
                  className="settings-form-select"
                  value={ttsLocal ? 'local' : 'cloud'}
                  onChange={(e) => handleTtsEngineChange(e.target.value)}
                >
                  {/* 括号只写「这一档要不要准备东西」，不写钱：默认档是云端（settingsService 的
                      ttsEngine 默认值就是 cloud），本地档的前置条件是按需组件下载。 */}
                  <option value="cloud">云端接口（默认）</option>
                  <option value="local">本地配音（需下载引擎和模型）</option>
                </select>
                <span className="settings-form-hint">
                  {/* 整句写成一个模板字符串：JSX 里的换行会变成一个空格，落在中文标点后头特别显眼 */}
                  {`本地这一档是实验功能：引擎二进制和模型都不在安装包里，要先在「设置 → 关于与更新 → 按需组件」里下载。引擎是「${ENGINE_BINARY_ROW_NAME}」那一行（${binaryManifestTag(localVoiceState?.binaryInManifest ?? null)}），模型那一行的名字就是下面「本地模型」里选中的那一档。切到这里不会立刻拉起引擎——第一次配音时才启动，那时第一次会多花几秒解包和读模型。`}
                </span>
              </div>

              {ttsLocal && (
                <>
                  <div className="settings-form-group">
                    <label className="settings-form-label">本地模型</label>
                    <select
                      className="settings-form-select"
                      value={values.ttsLocalEngine || LOCAL_TTS_DEFAULT_ENGINE}
                      onChange={(e) => {
                        updateField('ttsLocalEngine', e.target.value)
                        // 编号是「这一档模型里的第几个说话人」，换档后旧编号指的是另一个人，不能留。
                        // 1.1.0 起这一页没有「本地音色」那格了，这一次归零是这个字段在这页唯一的写入点：
                        // 磁盘上那份默认编号还得跟着档位走，配音页打开时读的就是它。
                        updateField('ttsLocalVoice', '0')
                      }}
                    >
                      {LOCAL_TTS_ENGINE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                          {modelPresenceTag(option.value, localVoiceState?.modelPresent[option.value])}
                        </option>
                      ))}
                    </select>
                    <span className="settings-form-hint">
                      {!localVoiceState
                        ? '还没读到本机的组件状态——这一档暂时不能配音。'
                        : !localVoiceState.binaryPresent
                          ? `${missingBinaryHint(localVoiceState.binaryInManifest)}。`
                          : localVoiceState.modelPresent[selectedTtsEngine] === false
                            ? `${missingModelHint(selectedTtsEngine)}。`
                            : `${localTtsEngineLabel(selectedTtsEngine)}的模型已在磁盘上。换档要点「保存设置」才生效；配音页那次换档只对本次调用有效，不会写回这里。`}
                      {/* 音色不在这一页（1.1.0）：它是「这一批想听哪一个」，入口只有配音页那一格。
                          这里只把「这一档有几个可挑」说一句，免得用户以为换档之后人还是那几个。 */}
                      {localVoiceState && (
                        <>
                          <br />
                          {(localVoiceState.speakers ?? 0) > 0
                            ? `这一档共 ${localVoiceState.speakers} 个音色，从 1 开始编号；上游没给音色名字，只能到配音页挨个试听来认。`
                            : '这一档的音色总数要引擎报一次才知道，所以现在只能按默认那一个算。'}
                        </>
                      )}
                      {selectedTtsCaveat && <><br />{selectedTtsCaveat}</>}
                      {localVoiceState &&
                        // 引擎那一行只在「清单里确实有它」或「还没查过清单」时才值得跳过去；
                        // 明确没有包时这一跳就是把人领到一行收着按钮的记录前面
                        ((!localVoiceState.binaryPresent && localVoiceState.binaryInManifest !== false) ||
                          (localVoiceState.modelPresent[selectedTtsEngine] === false &&
                            hasInAppDownload(selectedTtsEngine))) && (
                          <button
                            type="button"
                            className="voice-studio__link"
                            onClick={() => useSettingsModalStore.getState().open('about')}
                          >
                            去按需组件
                          </button>
                        )}
                    </span>
                  </div>
                </>
              )}

              {/* 本地档不看地址、Key、模型这三样：填了也不生效，摆在能切到的地方就是让人往不生效的框里填 Key */}
              {!ttsLocal && (
                <ProfileList
                  capability="tts"
                  profiles={profiles}
                  editingId={profileDraft?.profileId ?? ''}
                  pane={profileDraft ? profileDraft.mode : 'closed'}
                  busy={profileBusy || draftSaving}
                  onEdit={(profileId) => openEditDialog('tts', profileId)}
                  onCreate={() => openNewDialog('tts')}
                  onDelete={(profileId) => handleDeleteProfile('tts', profileId)}
                />
              )}
              <div className="settings-form-group">
                <label className="settings-form-label">配置自检</label>
                <button
                  type="button"
                  onClick={() => handleTestConnection('tts')}
                  disabled={testingKind !== null || (!ttsLocal && !ttsRow)}
                  className="settings-modal__dict-update-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Plug size={12} />
                  {testingKind === 'tts' ? '检查中...' : '测试连接'}
                </button>
                {ttsLocal && (
                  <button
                    type="button"
                    onClick={handleRestartVoiceEngine}
                    disabled={restartingVoice || testingKind !== null}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}
                  >
                    <RotateCcw size={12} />
                    {restartingVoice ? '重启中…' : '重启本地配音引擎'}
                  </button>
                )}
                <span className="settings-form-hint">
                  {ttsLocal
                    ? '按上面选的这一档在本机合成一句话（约 10 个字），不需要先保存。这一档不调接口、不花钱；' +
                      '引擎还没下载或模型还没下载时会直接告诉你缺哪一样，不用等配音跑失败。' +
                      '引擎端口被上一代占住、启动后秒退这类情况点「重启本地配音引擎」，不用退出应用重开——' +
                      '重启用的是已保存的那一档，表单里换了没保存不算。'
                    : !ttsRow
                      ? testBlockedHint('tts')
                      : `按「当前使用」那一套（${profileRowTitle('tts', ttsRow, '没填模型')}）已保存的地址、模型和 Key 合成一句话（约 10 个字），确认这一套能出音频。音色跟磁盘上那一份走——1.1.0 起这一页没有音色格了，旧版存过就用它，没存过干脆不发这一项，不影响这次自检。本次只合成一句，按字符计费的接口上这是最小的一笔；弹窗里没点「保存」的那些字不算，地址和 Key 留空时沿用校对那一套。`}
                </span>
                {testResults.tts && <TestResultView result={testResults.tts} />}
              </div>
            </>
          )}

          {tab === 'theme' && <ThemeSettings theme={themeValue} onChange={setThemeValue} />}

          {tab === 'about' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">当前版本</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>
                    {appVersion ? `v${appVersion}` : '读取中...'}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckUpdate}
                    disabled={checking}
                    className="settings-modal__dict-update-btn"
                  >
                    {checking ? '检查中...' : '检查更新'}
                  </button>
                </div>
                <span className="settings-form-hint">查询 GitHub Release 是否有新版本</span>
              </div>

              {updateInfo?.hasUpdate && (
                <div className="settings-update-notice">
                  <div className="settings-update-notice__title">
                    发现新版本 v{updateInfo.latestVersion}
                  </div>
                  <p className="settings-update-notice__text">
                    当前版本为 v{updateInfo.currentVersion}
                    。本应用不自动安装更新，请前往发布页获取最新安装包并覆盖安装。
                  </p>
                  <div className="settings-update-notice__actions">
                    <button
                      type="button"
                      className="settings-modal__save-btn"
                      onClick={() => handleOpenExternal(updateInfo.downloadUrl)}
                    >
                      前往发布页下载
                    </button>
                  </div>
                </div>
              )}

              <div className="settings-form-group">
                <label className="settings-form-label">链接解析组件</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>
                    {ytDlpLocal === null
                      ? '读取中...'
                      : ytDlpLocal.info === null
                        ? // 探测这一步炸了（原先这里根本没有失败分支，界面会永远停在「读取中...」演成还在查）
                          '本机那份读不出来'
                        : `${ytDlpLocal.info.version ?? '版本未知'}（${
                            YTDLP_SOURCE_LABEL[ytDlpLocal.info.source]
                          }${
                            ytDlpLocal.info.bytes !== null
                              ? `，${formatBytes(ytDlpLocal.info.bytes)}`
                              : ''
                          }）`}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckYtDlpUpdate}
                    disabled={ytDlpChecking || ytDlpApplying}
                    className="settings-modal__dict-update-btn"
                  >
                    {ytDlpChecking ? '检查中...' : '检查更新'}
                  </button>
                  {ytDlpHasUpdate && ytDlpRemote && (
                    <button
                      type="button"
                      onClick={handleApplyYtDlpUpdate}
                      disabled={ytDlpApplying || ytDlpChecking}
                      className="settings-modal__save-btn"
                    >
                      {ytDlpApplying
                        ? ytDlpProgress
                          ? `下载中 ${formatBytes(ytDlpProgress.received)}/${formatBytes(ytDlpProgress.total)}`
                          : '准备中...'
                        : `更新到 ${ytDlpRemote.version}（${formatBytes(ytDlpRemote.bytes)}）`}
                    </button>
                  )}
                </div>
                <span className="settings-form-hint">
                  链接转写用的解析规则由它提供，站点改了规则就要换一版组件。更新只替换应用自己那份副本，
                  不动安装包里的内置版本，失败会自动退回原来的
                </span>
              </div>

              <ComponentsSection />

              <div className="settings-form-group">
                <label className="settings-form-label">运行日志</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={handleOpenLogDirectory}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <FolderOpen size={12} />
                    打开日志文件夹
                  </button>
                </div>
                <span className="settings-form-hint">
                  转写或校对失败时，把这里的日志文件随邮件发给开发者便于排查
                </span>
              </div>

              <div className="settings-form-group">
                <label className="settings-form-label">本机数据</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={handleOpenUserDataDirectory}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <FolderOpen size={12} />
                    打开数据目录
                  </button>
                </div>
                <span className="settings-form-hint">
                  设置（settings.json）、按需下载的配音引擎与组件都在这里。设置没能解析时，
                  原件会以 settings.json.corrupt-时间戳 的名字留在同一层，可以从那份文件里找回
                </span>
              </div>

              <div className="settings-form-group">
                <label className="settings-form-label">问题反馈</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleContactDeveloper}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Mail size={12} />
                    发邮件反馈
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyContactEmail}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Copy size={12} />
                    复制邮箱地址
                  </button>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>{CONTACT_EMAIL}</span>
                </div>
                <span className="settings-form-hint">
                  邮件会自动带上版本号与运行日志位置；附上日志比描述「转写不准」更容易定位问题
                </span>
              </div>
            </>
          )}
        </div>

        <div className="settings-modal__footer">
          {confirmDiscard ? (
            <>
              <span className="settings-modal__dirty-tip">有未保存的修改</span>
              <button
                onClick={() => setConfirmDiscard(false)}
                className="settings-modal__cancel-btn"
              >
                继续编辑
              </button>
              <button onClick={onClose} className="settings-modal__save-btn">
                放弃修改
              </button>
            </>
          ) : (
            <>
              <button onClick={requestClose} className="settings-modal__cancel-btn">
                {hasPanelFields ? '取消' : '关闭'}
              </button>
              {hasPanelFields && (
                <button onClick={handleSave} disabled={saving} className="settings-modal__save-btn">
                  {saving ? (restartsEngine ? '保存中（重启本地引擎…）' : '保存中...') : '保存设置'}
                </button>
              )}
            </>
          )}
        </div>

        {/* 三档共用这一个弹窗（#222 重写第⑧步）：同一时刻只可能为一条方案开着，
            所以挂在设置窗口里、由 `profileDraft.capability` 自己决定画哪一档的那几格。
            它用 createPortal 画到 body 上，点它自己的遮罩不关窗——里面刚敲的地址和 Key 不该被一次误点丢掉。 */}
        {profileDraft && (
          <ProfileDialog
            draft={profileDraft}
            encryptable={encryptable}
            // 新建而这一档本来就一条都没有时不出现那颗勾选：第一条落盘自动是当前使用的
            showCurrentCheck={
              profileDraft.mode === 'edit' ||
              (profiles?.profiles[profileDraft.capability].length ?? 0) > 0
            }
            busy={profileBusy || draftSaving}
            onFieldChange={setDraftField}
            onApiKeyChange={setDraftKey}
            onClearKey={clearDraftKey}
            onCurrentChange={setDraftCurrent}
            onSave={commitDialog}
            onCancel={closeDialog}
          />
        )}
      </div>
    </div>
  )
}
