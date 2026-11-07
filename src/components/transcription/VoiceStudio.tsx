/**
 * 字幕配音工作台（页面）
 *
 * 左输入、右结果，两个卡片就完事：
 * - 左边管「要念什么、用哪档模型、哪个音色、多快」，并在点下去之前把「要调用多少次」写在脸上——
 *   云端档每一次都花用户自己 Key 里的钱。
 * - 右边只有一个状态位（待开始 / 合成中 / 完成），不并列摆两块进度。
 *
 * 这一页从上到下就三格：选方案（本地档＝选模型）→ 选音色 → 设倍速（1.1.0 收敛成这样）：
 * - 云端档那一格是「配音方案」下拉：一条方案＝厂商 + 接口地址 + Key + 配音模型这一组凭据（1.1.1
 *   多了「厂商」这一项，它决定请求发往哪条路径、长什么样），
 *   所以「换模型」在这档里本来就是「换一套」，不再有第二个手输的模型格——下拉里那一行念的就是模型名，
 *   旁边再摆一个输入框说的是同一件事，用户只会以为是两件事。
 * - 本地档同一格换成「配音模型」下拉（白名单里那两档）。这是这一次调用的参数，不写回设置。
 * - 音色两档都留着：本地能枚举（引擎报编号），云端能填什么由服务商决定，各家字段名与取值都不一样。
 *   云端这一格是「手输 + 边打边筛」（#340）：厂商自己给「列音色」接口时（四家里只有 MiniMax 给），
 *   进这一页就用用户那把 Key 现取一份挂成 <datalist>，自己复刻过的音色也在里面；取不到或这家没这条接口
 *   就退回纯手输，配一句文档链接的出路。OpenAI 兼容留空＝不指定，请求里干脆不带这一项；
 *   MiniMax 与百炼把音色当必填（1.1.1），留空会在点「开始配音」时被主进程当场拦下并点名这一家——
 *   这里不猜一个默认音色，因为猜错了用户听到的是另一把嗓子，比报错更难发现。
 *   真被模型拒绝了，接口回的原话会出现在结果卡上。
 * - 「云端还是本地」这一档不在页面上给选择：它决定花不花钱、要不要拉起本机进程，
 *   是用户保存过的长期配置，只在「设置 → 配音配置」里改。
 * - 云端那一格（#222 第④步的 ProfileSwitchSelect）做的还是「设为当前使用」，不是「这一次用哪套」：
 *   它决定的是后面每次调用花谁的 Key、打哪家网关。语义、文案、禁用条件跟设置页那颗同一口径，
 *   界面上不留第二种「切方案」。挂这一个控件的只剩校对弹窗和这一页（转写首页原来也有一条，
 *   #222 重写第③步撤了），落盘与话术都在 useProfileStore 一处。
 *
 * 合成中那张卡复用转写的 processing 视觉（徽章 + 波形 + 进度 + 取消），因为它是同一件事：
 * 一个分钟级的活儿在后台跑。段号是主进程推回来的真实段号，不是编出来的百分比。
 *
 * 这一页不改字幕、不动时间轴，产物是一条独立的音轨。
 */
import { useState } from 'react'
import { AlertTriangle, AudioLines, Download, Volume2 } from 'lucide-react'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { useVoiceStudioStore, VOICE_SPEED_OPTIONS } from '@/stores/useVoiceStudioStore'
import { switchableProfiles, useProfileStore } from '@/stores/useProfileStore'
import { ProfileSwitchSelect } from '@/components/settings/ProfileSwitchSelect'
import {
  profileRowTitle,
  ttsVendorClonesVoices,
  ttsVendorLabel,
  ttsVendorNeedsVoice,
  ttsVoiceExample,
  ttsVoiceListUrl,
} from '@/utils/profileSpec'
import { formatBytes } from '@/utils/formatBytes'
import { formatTime } from '@/utils/formatTime'
import {
  LOCAL_TTS_ENGINE_OPTIONS,
  localTtsEngineCaveat,
  localTtsEngineLabel,
  missingModelHint,
  modelPresenceTag,
  voiceSidLabel,
  voiceSidOptions,
} from '@/utils/localTtsEngines'
import { StudioTabs } from './StudioTabs'
import { VoiceCloneDialog } from './VoiceCloneDialog'

/**
 * 「这条轨比原时间轴长多少」那一格不能直接套 formatTime：那把尺 floor 到整秒，2026-10-30
 * 那批 12 段的实测差是 0.11 秒（轨 58.31 / 原时间轴 58.42，见 app.log 的 Voice track assembled），
 * 落进界面就成了「这条不比它长（差 00:00）」。这行的用途是告诉用户要不要拿这条轨去重铺字幕，
 * 而 00:00 读起来像严丝合缝——1 秒以内的差在这儿不是零。
 */
function formatDrift(delta: number): string {
  const abs = Math.abs(delta)
  return abs < 1 ? '差不到 1 秒' : `差 ${formatTime(abs)}`
}

/** file:// 前缀与播放器同源（依赖 webSecurity: false，见 AudioPlayer） */
function toMediaUrl(filePath: string): string {
  return `file://${filePath}`
}

/** 合成中：转写那套 processing 卡的原样复用，只把文案换成配音 */
function RunningCard() {
  const progress = useVoiceStudioStore((s) => s.progress)
  const live = useVoiceStudioStore((s) => s.live)
  const queue = useVoiceStudioStore((s) => s.queue)
  const mode = useVoiceStudioStore((s) => s.mode)
  const cancelRequested = useVoiceStudioStore((s) => s.cancelRequested)
  const cancel = useVoiceStudioStore((s) => s.cancel)

  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.index / progress.total) * 100)) : 0
  const current = progress && progress.index > 0 ? queue[progress.index - 1]?.text ?? '' : ''

  const stageText = (() => {
    if (!progress) return mode === 'local' ? '正在让本机引擎念第一段…' : '正在发起第一批调用…'
    if (progress.stage === 'assembling') return `正在把 ${progress.total} 段拼成一条音轨…`
    if (progress.stage === 'done') return '配音轨已拼好'
    if (progress.stage === 'failed') return `第 ${progress.index} 段失败：${progress.note || '未知原因'}`
    if (progress.stage === 'skipped') return `第 ${progress.index} 段是空的，没合成`
    if (progress.index === 0) return `第 1 段还在${mode === 'local' ? '本机引擎' : '接口'}那边…`
    return `已合成 ${progress.index} / ${progress.total} 段`
  })()

  // 拼接与收尾这两步在主进程没有取消位（tts:cancel 那时返回 'late'）：按钮留着就是承诺一个按下去没用的动作
  const lateStage = progress?.stage === 'assembling' || progress?.stage === 'done'

  return (
    <div className="status-card status-card--processing">
      <div className="processing-header">
        <div className="processing-badge">
          <span className="processing-badge__dot" />
          <span className="processing-badge__text">AI 配音中</span>
        </div>
      </div>

      <div className="processing-waveform">
        <svg className="waveform-svg" viewBox="0 0 400 80" preserveAspectRatio="none">
          <defs>
            <linearGradient id="waveGradientVoice" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#1b55f5" />
              <stop offset="50%" stopColor="#3378ff" />
              <stop offset="100%" stopColor="#1b55f5" />
            </linearGradient>
          </defs>
          <path
            className="waveform-path waveform-path--back"
            d="M0,40 C50,20 100,60 150,40 C200,20 250,60 300,40 C350,20 400,60 400,40"
            fill="none"
            stroke="url(#waveGradientVoice)"
            strokeWidth="2"
            opacity="0.3"
          />
          <path
            className="waveform-path waveform-path--front"
            d="M0,40 C50,60 100,20 150,40 C200,60 250,20 300,40 C350,60 400,20 400,40"
            fill="none"
            stroke="url(#waveGradientVoice)"
            strokeWidth="3"
          />
        </svg>
      </div>

      <div className="processing-text">
        <span className="processing-text__title">{stageText}</span>
        <span className="processing-text__desc">
          {lateStage
            ? mode === 'local'
              ? '拼接读的是已经落盘的片段，本机引擎这一轮已经用完了'
              : '拼接读的是已经下载好的片段，不再调用接口'
            : current
              ? `正在念：${current.slice(0, 40)}${current.length > 40 ? '…' : ''}`
              : mode === 'local'
                ? '逐段串行交给本机引擎，一段一次合成'
                : '逐段串行调用配音接口，一段一次请求'}
        </span>
      </div>

      <div className="processing-progress">
        <div className="processing-progress__bar">
          <div className="processing-progress__fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="processing-progress__text">{percent}%</span>
      </div>

      <div className="voice-studio__tally">
        成功 {live.done} · 失败 {live.failed} · 跳过 {live.skipped}
        {cancelRequested && '（已请求取消，正在收尾）'}
      </div>

      {!lateStage && (
        <button className="processing-cancel-btn" onClick={() => void cancel()} disabled={cancelRequested}>
          {cancelRequested ? '正在取消…' : '取消配音'}
        </button>
      )}

      <p className="voice-studio__note">
        {progress?.stage === 'assembling'
          ? '逐段那一步已经跑完，现在是本地 ffmpeg 在拼这一条轨：不再调接口、不再花钱，但也停不下来——' +
            '拦下来等于把已经合成好的段白扔。所以这一步没有取消按钮，等它跑完轨照常给你。'
          : progress?.stage === 'done'
            ? '配音轨已经拼好了，正在收尾。'
            : mode === 'local'
              ? '取消只拦后面的段落；正在念的那一段要等它跑完，这一段不花钱但省不下来。'
              : '取消只拦后面的段落，正在飞的那一次请求已经发出去了，钱已经花掉。'}
      </p>
    </div>
  )
}

/** 完成 / 失败：一条轨 + 它的花销账目 */
function ResultCard() {
  const result = useVoiceStudioStore((s) => s.result)
  const source = useVoiceStudioStore((s) => s.source)
  const mode = useVoiceStudioStore((s) => s.mode)
  const configProvider = useVoiceStudioStore((s) => s.configProvider)
  const saving = useVoiceStudioStore((s) => s.saving)
  const save = useVoiceStudioStore((s) => s.save)
  const clearResult = useVoiceStudioStore((s) => s.clearResult)
  if (!result) return null

  const track = result.track

  return (
    <div className="voice-studio__result">
      {track ? (
        <>
          <audio className="voice-result__audio" controls src={toMediaUrl(track.filePath)} />
          <ul className="voice-result__stats">
            <li>
              配音轨 <strong>{formatTime(track.duration)}</strong> · {formatBytes(track.bytes)}
              {track.duration === 0 && '（总时长没读到）'}
            </li>
            {source === 'subtitle' ? (
              <li>
                原时间轴到 {formatTime(track.originalEnd)}，这条
                {track.duration > track.originalEnd ? '比它长' : '不比它长'}
                （{formatDrift(track.duration - track.originalEnd)}）
              </li>
            ) : (
              <li>纯文本连续朗读，按顺序首尾相接，没有字幕时间轴</li>
            )}
            {/* 这两条警告说的是「相对字幕槽位」的落点，纯文本没有时间轴，套上去就是自己编一个不存在的问题吓人 */}
            {source === 'subtitle' && track.pushedCount > 0 && (
              <li className="voice-result__stat--warn">
                <AlertTriangle size={13} />
                {track.pushedCount} 段配音比字幕槽位长，已顺延到后面——这条轨和画面越到后面差得越多
              </li>
            )}
            {source === 'subtitle' && track.estimatedCount > 0 && (
              <li className="voice-result__stat--warn">
                <AlertTriangle size={13} />
                {track.estimatedCount} 段解出来是空音频（一个采样都没有），落点按字幕槽位估算
              </li>
            )}
            <li>
              成功 {result.clipCount} 段
              {result.skipped.length > 0 && ` · 空段落跳过 ${result.skipped.length} 段`}
              {result.canceled && (mode === 'local' ? '（你取消了，后面的段没再念）' : '（你取消了，后面的段没调用）')}
            </li>
          </ul>
          {result.abortedReason && (
            <p className="voice-result__abort">
              <AlertTriangle size={13} />
              {result.abortedReason}
            </p>
          )}
          {result.failures.length > 0 && (
            <div className="voice-result__failures">
              <span className="voice-result__failures-title">{result.failures.length} 段失败：</span>
              {result.failures.slice(0, 3).map((failure) => (
                <p key={failure.segmentId} className="voice-result__failure">
                  第 {failure.index} 段：{failure.error}
                </p>
              ))}
              {result.failures.length > 3 && (
                <p className="voice-result__failure">还有 {result.failures.length - 3} 段，原因同上一类</p>
              )}
            </div>
          )}
          <p className="voice-result__scope">字幕与时间轴没有改动，这是一条独立的音轨。</p>
        </>
      ) : (
        <>
          <p className="voice-result__empty">{result.error || '一段都没合成成功，没有可以拼起来的音频。'}</p>
          {result.failures.length > 0 && (
            <div className="voice-result__failures">
              <span className="voice-result__failures-title">
                {mode === 'local' ? '本机引擎回的原话：' : '接口回的原话：'}
              </span>
              <p className="voice-result__failure">{result.failures[0].error}</p>
            </div>
          )}
          <p className="voice-result__scope">
            {mode === 'local'
              ? '本地这一档不看地址和 Key；引擎二进制、模型、音色编号三样里任何一样不对，都长这样。'
              : `厂商、地址、Key、模型这四样里任何一样不对都长这样；${
                  ttsVendorNeedsVoice(configProvider)
                    ? `「${ttsVendorLabel(configProvider)}」还不收空音色——没填音色当场就拦下、不调接口，填了但这家不认这个音色也长这样。`
                    : '音色是可选的，填了而这个模型不认，也是这一句。'
                }`}
          </p>
        </>
      )}

      <div className="voice-studio__result-actions">
        <button className="settings-modal__cancel-btn" onClick={clearResult}>
          清空
        </button>
        {track && (
          <button className="settings-modal__save-btn" onClick={() => void save()} disabled={saving}>
            <Download size={14} />
            {saving ? '保存中…' : '保存配音轨'}
          </button>
        )}
        {!track && (
          <button
            className="settings-modal__save-btn"
            onClick={() => useSettingsModalStore.getState().open('tts')}
          >
            去配音配置测连接
          </button>
        )}
      </div>
      <p className="voice-studio__note">不保存的话，清空或重开一批就把这一版产物删掉。</p>
    </div>
  )
}

export function VoiceStudio() {
  // 声音复刻弹窗（#347）。开合只活在这一页：复刻那几格本来就不落盘，关窗也不取消已经发出去的请求
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  const source = useVoiceStudioStore((s) => s.source)
  const setSource = useVoiceStudioStore((s) => s.setSource)
  const text = useVoiceStudioStore((s) => s.text)
  const setText = useVoiceStudioStore((s) => s.setText)
  const voice = useVoiceStudioStore((s) => s.voice)
  const setVoice = useVoiceStudioStore((s) => s.setVoice)
  const engine = useVoiceStudioStore((s) => s.engine)
  const setEngine = useVoiceStudioStore((s) => s.setEngine)
  const speed = useVoiceStudioStore((s) => s.speed)
  const setSpeed = useVoiceStudioStore((s) => s.setSpeed)
  const mode = useVoiceStudioStore((s) => s.mode)
  const configModel = useVoiceStudioStore((s) => s.configModel)
  const configVoice = useVoiceStudioStore((s) => s.configVoice)
  const configProvider = useVoiceStudioStore((s) => s.configProvider)
  const configEngine = useVoiceStudioStore((s) => s.configEngine)
  const speakers = useVoiceStudioStore((s) => s.speakers)
  const engineModelPresent = useVoiceStudioStore((s) => s.engineModelPresent)
  const vendorVoices = useVoiceStudioStore((s) => s.vendorVoices)
  const vendorVoicesError = useVoiceStudioStore((s) => s.vendorVoicesError)
  const profiles = useProfileStore((s) => s.slice.tts.profiles)
  const profileId = useProfileStore((s) => s.slice.tts.profileId)
  const setProfile = useVoiceStudioStore((s) => s.setProfile)
  const phase = useVoiceStudioStore((s) => s.phase)
  const preview = useVoiceStudioStore((s) => s.preview)
  const previewing = useVoiceStudioStore((s) => s.previewing)
  const previewOne = useVoiceStudioStore((s) => s.previewOne)
  const buildQueue = useVoiceStudioStore((s) => s.buildQueue)
  const start = useVoiceStudioStore((s) => s.start)

  const segments = useTranscriptionStore((s) => s.segments)

  const subtitleQueue = segments.filter((segment) => !!segment && segment.text.trim() !== '')
  const emptyCount = segments.filter((segment) => !!segment && segment.text.trim() === '').length
  const queue = buildQueue()
  const callCount = queue.length
  const charCount = queue.reduce((sum, segment) => sum + segment.text.length, 0)
  const running = phase === 'running'

  const local = mode === 'local'
  /**
   * 方案列表：只在这条档确实有第二套可换时才长成一行控件（判断收在 switchableProfiles，
   * 下拉自己也用它）。null＝这次没读出来，整块收起而不是显示「只有默认那套」——
   * 那句话会把用户已有的方案说成不存在。
   */
  const showProfileSelect = !!switchableProfiles(profiles)
  const currentProfile = (profiles ?? []).find((profile) => profile.id === profileId)
  /** 下拉的当前值：界面上没改过就用设置里那一档/那个编号 */
  const selectedEngine = engine || configEngine
  const voiceValue = voice || (local ? (/^\d+$/.test(configVoice) ? configVoice : '0') : '')
  const sids = voiceSidOptions(speakers, configVoice)
  /** 当前选中的这档模型在不在磁盘上；还没查到（undefined）时按「别拦、别乱标」处理 */
  const selectedPresent = engineModelPresent[selectedEngine] !== false
  /** 这一档「用得起来才知道的坑」，空串＝没有 */
  const engineCaveat = localTtsEngineCaveat(selectedEngine)
  /**
   * 这一批会打到哪家（1.1.1）。这不是装饰：MiniMax 与百炼把音色当必填，
   * 那句「留空＝不发这一项」对它们不成立，而这一格说错的症状是听不出来的——
   * 界面写着 A、出声是 B，只有真去听才知道，所以界面必须自己说准。
   */
  const vendorLabel = ttsVendorLabel(configProvider)
  const voiceRequired = ttsVendorNeedsVoice(configProvider)
  const voiceListUrl = ttsVoiceListUrl(configProvider)
  /**
   * 音色那格的占位：留空时真用哪个名字，看主进程那次回落（`withOverrides` 是 `voice || base.voice`，
   * 而 `base.voice` 只在「这一家收空音色」时才从设置里带过来，见 getTTSConfig）。
   * 必填那两家不能先念 configVoice：那半多半是 1.1.0 从旧方案迁过来的外家名字（alloy），
   * 摆在框里等于劝人照抄一个当场会被拦下的值。
   */
  const voicePlaceholder = voiceRequired
    ? `「${vendorLabel}」的音色必填，例如 ${ttsVoiceExample(configProvider)}`
    : configVoice || '留空＝不发这一项'

  /**
   * 音色那格的候选（#340）：只在厂商自己给「列音色」这条接口时才有东西，是刚才拿用户那把 Key
   * 现取的，所以自己复刻过的也在里面、也不会过期。**没有候选不等于这家没音色**——四家里只有
   * MiniMax 给这条接口，另三家是刻意不接的（理由记在 ttsVendor.ts）。
   * 去重按 id：同一条音色可能同时出现在系统名单和复刻名单里，重复的 <option> 会让候选列表长出两行一样的。
   */
  const vendorVoiceOptions = vendorVoices.filter(
    (item, index) => vendorVoices.findIndex((other) => other.id === item.id) === index
  )
  const hasVendorVoices = vendorVoiceOptions.length > 0

  /** 打开厂商那份系统音色列表；链接由主进程白名单把关，被拦下要说原因，不能静默无反应 */
  const openVoiceList = async () => {
    const api = getElectronAPI()
    if (!api) return
    const result = await api.openExternal(voiceListUrl)
    if (!result.success) toast.error(`打开链接失败：${result.error}`)
  }

  return (
    <div className="voice-studio">
      <StudioTabs />

      <div className="voice-studio__grid">
        <section className="voice-studio__panel voice-studio__panel--form">
          <div className="voice-studio__body">
            <div className="voice-studio__label">要配音的内容</div>

            <div className="voice-studio__sources">
              <button
                className={`voice-source ${source === 'text' ? 'active' : ''}`}
                onClick={() => setSource('text')}
                disabled={running}
              >
                纯文本
              </button>
              <button
                className={`voice-source ${source === 'subtitle' ? 'active' : ''}`}
                onClick={() => setSource('subtitle')}
                disabled={running || subtitleQueue.length === 0}
                title={subtitleQueue.length === 0 ? '先转写出一份稿子，才能按字幕时间轴铺' : undefined}
              >
                从转写带入
                {subtitleQueue.length > 0 && <span className="voice-source__count">{subtitleQueue.length} 段</span>}
              </button>
            </div>

            {source === 'text' ? (
              <>
                <textarea
                  className="voice-studio__input"
                  placeholder="输入或粘贴要朗读的文本，长文会按句读切成多次调用。"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={running}
                />
                <p className="voice-studio__hint">
                  {text.trim() ? `${text.trim().length.toLocaleString()} 字` : '还没输入'}
                  {callCount > 0 && ` · 会切成 ${callCount} 次调用`}
                </p>
              </>
            ) : (
              <div className="voice-studio__readonly">
                <div>
                  共 <strong>{subtitleQueue.length}</strong> 段可配音，约{' '}
                  <strong>{charCount.toLocaleString()}</strong> 字
                </div>
                {emptyCount > 0 && <div className="voice-studio__hint">另外 {emptyCount} 段是空的，会被跳过。</div>}
                <div className="voice-studio__hint">文字要改请回转写页编辑，这里按当前段落原样念。</div>
              </div>
            )}

            <div className="voice-studio__fields">
              {/* 这一格按 mode 分叉，两种模式各问各的「用哪档模型」：
                  本地档＝白名单里那两档，界面上直接换（这一次调用的参数，不写回设置）；
                  云端档＝整套「配音方案」，换的是地址 + Key + 模型这一组凭据，所以它做的是「设为当前使用」，
                  没有「只把模型换一下」这种半套状态。列表没读出来或只有一套时这个控件自己不出现。 */}
              {local ? (
                <label className="voice-studio__field voice-studio__field--wide">
                  <span className="voice-studio__label">配音模型</span>
                  <select
                    className="settings-form-select"
                    value={selectedEngine}
                    onChange={(e) => setEngine(e.target.value)}
                    disabled={running}
                  >
                    {LOCAL_TTS_ENGINE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                        {modelPresenceTag(option.value, engineModelPresent[option.value])}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <ProfileSwitchSelect
                  capability="tts"
                  className="voice-studio__field voice-studio__field--wide"
                  labelClassName="voice-studio__label"
                  disabled={running || previewing}
                  switchTo={(picked) => setProfile(picked)}
                />
              )}
              <label className="voice-studio__field">
                <span className="voice-studio__label">音色</span>
                {local ? (
                  <select
                    className="settings-form-select"
                    value={voiceValue}
                    onChange={(e) => setVoice(e.target.value)}
                    disabled={running}
                  >
                    {sids.map((sid) => (
                      <option key={sid} value={sid}>
                        {voiceSidLabel(sid)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="settings-form-input"
                    type="text"
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    placeholder={voicePlaceholder}
                    disabled={running}
                    // 用原生 <datalist> 而不是自己写一个下拉：它给的就是「边打边筛 + 键盘上下选」，
                    // 而候选是厂商现取来的、可能几百条，自己那套要处理定位、溢出、失焦、Esc，
                    // 换来的还是一个更差的输入框。没有候选时这个属性不写，输入框行为一字不变。
                    list={hasVendorVoices ? 'voice-studio-vendor-voices' : undefined}
                  />
                )}
              </label>
              <label className="voice-studio__field">
                <span className="voice-studio__label">倍速</span>
                <select
                  className="settings-form-select"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  disabled={running}
                >
                  {VOICE_SPEED_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}×
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {!local && hasVendorVoices && (
              <datalist id="voice-studio-vendor-voices">
                {vendorVoiceOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {/* <option> 的文本是候选行右边那列说明：填进输入框的只有 value，所以这里放名字，
                        复刻过的额外标一下——用户账号里的复刻音色和厂商系统音色在这一格里长得一样，
                        不标就分不出哪个是自己那把嗓子 */}
                    {item.source === 'clone' ? `${item.name}（自己复刻）` : item.name}
                  </option>
                ))}
              </datalist>
            )}

            <p className="voice-studio__hint">
              {local
                ? speakers > 0
                  ? `这一档有 ${speakers} 个音色，从 1 开始编号。上游没给名字，只能挨个试听来认。`
                  : // 只报数、不给出路：这一档的模型在不在盘上、能不能下载，这句话都猜不到，
                    // 写一条会被前置检查当场拦下的出路比不写更糟
                    '这一档的音色总数还没报上来，所以现在只列得出默认那一个。'
                : // 音色列表链接要内联在这段话里，所以云端这一支用 fragment；
                  // 同一个 fragment 里相邻的孩子之间不能留裸换行——JSX 会把它折成一个空格，
                  // 中文就成了「起效。 「MiniMax」」，所以每句各自包在一个 {} 里、同行接龙。
                  <>
                    {voiceRequired
                      ? `「${vendorLabel}」要音色才出声，填一个音色 id（例如 ${ttsVoiceExample(configProvider)}）。`
                      : '能念哪些音色由服务商定，这一格手输（OpenAI 兼容常见的六个：alloy、echo、fable、onyx、nova、shimmer）。'}
                    {/* 名单按「取到了什么」三分支，一句都不多说：取到了就说清候选是刚取的（复刻的也在里面），
                        这时再挂文档链接是重复；问了没问到就摆原因，出路是那一份链接；
                        这家根本没这条接口就只挂链接。写「这家没有音色名单」是谎：四家里只有 MiniMax 给接口。 */}
                    {hasVendorVoices ? (
                      `边打边筛：${vendorVoiceOptions.length} 个候选刚从「${vendorLabel}」取来，标「自己复刻」的是你账号里的。`
                    ) : (
                      <>
                        {/* 原因那句多半是接口原话（尾巴有没有标点不由这里定），先收一个句号再接下一句 */}
                        {vendorVoicesError
                          ? `音色名单这次没取到：${vendorVoicesError.replace(/[。.！!？?]$/, '')}。`
                          : ''}
                        {voiceListUrl ? (
                          <>名单见<button className="voice-studio__link" onClick={openVoiceList}>系统音色列表</button>。</>
                        ) : (
                          ''
                        )}
                      </>
                    )}
                    {/* 留空等于什么，先问这一家收不收空音色。反过来写就是说谎：1.1.0 把音色摘出方案后，
                        必填那两家的 `base.voice` 是空串，而设置根上那份旧名字多半属于别家。
                        这句要和「开始配音」当场拦下的那句（ttsConfigProblem）对得上。 */}
                    {voiceRequired
                      ? `留空＝点「开始配音」会被当场拦下${configVoice ? `（设置里存的「${configVoice}」是别家名字）` : ''}。`
                      : configVoice
                        ? `留空＝用设置里存着的「${configVoice}」（只作用于这一批，不写回设置）。`
                        : '留空＝请求里不发这一项，有的模型本来就不收。'}
                  </>}
            </p>

            {local && engineCaveat && <p className="voice-studio__hint">{engineCaveat}</p>}

            {/* 本地档没有复刻这回事（引擎只会念随包的那几把嗓子），所以只在云端档、且这一家真支持时挂。
                这里只留一颗入口（#347）：复刻那几格摊开比这一列剩下的都高，摆进页面就把「开始配音」
                挤到折叠线以下，所以挪进弹窗，用完就关。 */}
            {!local && ttsVendorClonesVoices(configProvider) && (
              <div className="voice-studio__clone-entry">
                <span className="voice-studio__label">声音复刻</span>
                <button className="settings-modal__cancel-btn" onClick={() => setCloneDialogOpen(true)}>
                  <AudioLines size={14} />
                  用自己的录音建一把音色
                </button>
                <span className="voice-studio__hint">建好的音色填进上面那格「音色」，不写回设置。</span>
              </div>
            )}

            <div className="voice-studio__config">
              {/* 本地档不提配音方案：那条下拉只在云端档出现，方案里那四项凭据（厂商/地址/Key/模型）
                  这一档一个都不读，说出去就是「你以为在用的那套其实没参与」 */}
              {!local && !showProfileSelect && currentProfile && (
                <>
                  配音方案 <code>{profileRowTitle('tts', currentProfile)}</code>
                  {' · '}
                </>
              )}
              {local ? '配音引擎：本地（在你这台电脑上跑，不调接口）' : '配音引擎：云端接口'}
              {' · '}
              {local ? (
                <code>{localTtsEngineLabel(selectedEngine)}</code>
              ) : (
                <>
                  {/* 厂商也念出来：同一条网关地址后面接哪条路径、请求长什么样，都是它定的；
                      只看模型名认不出这一批要打到哪家去 */}
                  厂商 <code>{vendorLabel}</code>
                  {' · '}
                  {/* 只有「当前使用那套的模型」这一份：页面上没有手输的覆盖，所以这里念的就是待会儿真发出去的那个 */}
                  模型 <code>{configModel || '未填写'}</code>
                </>
              )}
              {/* 这句只在本地档说：它讲的是「本机那一档模型的权重不在盘上」，而云端档一个字都不读它。
                  1.1.0 本机 CDP 回放时这句话正挂在「配音引擎：云端接口」后面，还补了一句「现在开跑会被拦下」——
                  而云端那次调用根本不会因为本地模型缺失被拦，摆在横幅里就是让界面说一句假话 */}
              {local && !selectedPresent && (
                <>
                  {' '}
                  <span className="voice-studio__hint">{missingModelHint(selectedEngine)}（现在开跑会被拦下）</span>
                </>
              )}
              <button
                className="voice-studio__link"
                onClick={() => useSettingsModalStore.getState().open('tts')}
              >
                去配音配置
              </button>
            </div>

          </div>

          {/* 钉住的这一段（#345）：「试听 + 开始配音」是这一页的主动作，展开复刻那块之后
              上面的字段比面板高，让它们自己滚，按钮不能跟着跑出视野 */}
          <div className="voice-studio__footer">
            <div className="voice-studio__preview">
              <button className="settings-modal__cancel-btn" onClick={() => void previewOne()} disabled={previewing || running}>
                <Volume2 size={14} />
                {previewing ? '试听合成中…' : '试听第一句'}
              </button>
              {preview ? (
                <audio className="voice-preview__audio" controls src={toMediaUrl(preview.filePath)} />
              ) : (
                <span className="voice-studio__hint">
                  {local
                    ? '先听一句再整批跑：编号选错，重跑的是几十分钟的机器活儿。'
                    : '先听一句再整批跑：音色不对跑完一整篇，烧的是额度。'}
                </span>
              )}
            </div>

            <p className="voice-studio__cost">
              {local ? (
                <>
                  本机合成 <strong>{callCount}</strong> 段（逐段串行，不调接口、不花钱）。第一次配音多花几秒：引擎要起来、模型要读进内存。
                </>
              ) : (
                <>
                  将调用 <strong>{callCount}</strong> 次接口（逐段串行，按服务商计费）。倍速是否生效由接口说了算，个别服务商只认固定档位。
                </>
              )}
            </p>

            <button className="voice-studio__cta" onClick={() => void start()} disabled={running || callCount === 0}>
              <AudioLines size={16} />
              {running ? '配音进行中…' : '开始配音'}
            </button>
          </div>
        </section>

        <section className="voice-studio__panel">
          {phase === 'running' ? (
            <RunningCard />
          ) : phase === 'done' ? (
            <ResultCard />
          ) : (
            <div className="voice-studio__placeholder">
              <AudioLines size={28} />
              <span>合成后在这里播放和导出</span>
              <span className="voice-studio__hint">一次一批：这一版产物在你清空或重开之前一直能听。</span>
            </div>
          )}
        </section>
      </div>

      {cloneDialogOpen && (
        <VoiceCloneDialog vendor={configProvider} onClose={() => setCloneDialogOpen(false)} />
      )}
    </div>
  )
}
