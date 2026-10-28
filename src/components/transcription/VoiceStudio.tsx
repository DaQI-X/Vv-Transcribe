/**
 * 字幕配音工作台（页面）
 *
 * 左输入、右结果，两个卡片就完事：
 * - 左边管「要念什么、用哪档模型、哪个音色、多快」，并在点下去之前把「要调用多少次」写在脸上——
 *   云端档每一次都花用户自己 Key 里的钱。
 * - 右边只有一个状态位（待开始 / 合成中 / 完成），不并列摆两块进度。
 *
 * 模型与音色按档给两种交互（这是 #238 的本意：用户不知道该填什么）：
 * - 本地档两样都能枚举——模型是白名单里那两档，音色是引擎报的编号，所以下拉。
 * - 云端档枚举不了：能填什么由服务商决定，应用不替用户猜，只能手输 + 一句「先试听验一次」。
 *   把云端也做成下拉就得编一份模型/音色清单，那份清单错了比没有更糟。
 * - 「云端还是本地」这一档不在页面上给选择：它决定花不花钱、要不要拉起本机进程，
 *   是用户保存过的长期配置，只在「设置 → 配音配置」里改。
 *
 * 合成中那张卡复用转写的 processing 视觉（徽章 + 波形 + 进度 + 取消），因为它是同一件事：
 * 一个分钟级的活儿在后台跑。段号是主进程推回来的真实段号，不是编出来的百分比。
 *
 * 这一页不改字幕、不动时间轴，产物是一条独立的音轨。
 */
import { AlertTriangle, AudioLines, Download, Volume2 } from 'lucide-react'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'
import { useVoiceStudioStore, VOICE_SPEED_OPTIONS } from '@/stores/useVoiceStudioStore'
import { LOCAL_TTS_ENGINE_OPTIONS, missingModelHint, voiceSidOptions } from '@/utils/localTtsEngines'
import { StudioTabs } from './StudioTabs'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
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
          {current
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

      <button className="processing-cancel-btn" onClick={() => void cancel()} disabled={cancelRequested}>
        {cancelRequested ? '正在取消…' : '取消配音'}
      </button>

      <p className="voice-studio__note">
        {mode === 'local'
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
                （差 {formatTime(Math.abs(track.duration - track.originalEnd))}）
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
              : '地址、Key、模型、音色四样里任何一样不对，都长这样。'}
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
  const source = useVoiceStudioStore((s) => s.source)
  const setSource = useVoiceStudioStore((s) => s.setSource)
  const text = useVoiceStudioStore((s) => s.text)
  const setText = useVoiceStudioStore((s) => s.setText)
  const voice = useVoiceStudioStore((s) => s.voice)
  const setVoice = useVoiceStudioStore((s) => s.setVoice)
  const model = useVoiceStudioStore((s) => s.model)
  const setModel = useVoiceStudioStore((s) => s.setModel)
  const engine = useVoiceStudioStore((s) => s.engine)
  const setEngine = useVoiceStudioStore((s) => s.setEngine)
  const speed = useVoiceStudioStore((s) => s.speed)
  const setSpeed = useVoiceStudioStore((s) => s.setSpeed)
  const mode = useVoiceStudioStore((s) => s.mode)
  const configModel = useVoiceStudioStore((s) => s.configModel)
  const configVoice = useVoiceStudioStore((s) => s.configVoice)
  const configEngine = useVoiceStudioStore((s) => s.configEngine)
  const speakers = useVoiceStudioStore((s) => s.speakers)
  const engineModelPresent = useVoiceStudioStore((s) => s.engineModelPresent)
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
  /** 下拉的当前值：界面上没改过就用设置里那一档/那个编号 */
  const selectedEngine = engine || configEngine
  const voiceValue = voice || (local ? (/^\d+$/.test(configVoice) ? configVoice : '0') : '')
  const sids = voiceSidOptions(speakers, configVoice)
  /** 当前选中的这档模型在不在磁盘上；还没查到（undefined）时按「别拦、别乱标」处理 */
  const selectedPresent = engineModelPresent[selectedEngine] !== false

  return (
    <div className="voice-studio">
      <StudioTabs />

      <div className="voice-studio__grid">
        <section className="voice-studio__panel">
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
                placeholder="输入或粘贴要朗读的文本。长文会按句读切成多次调用，进度按真实段号走。"
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
              {emptyCount > 0 && <div className="voice-studio__hint">另外 {emptyCount} 段是空的，会被跳过、不占用一次合成。</div>}
              <div className="voice-studio__hint">文字要改请回转写页编辑，这里按当前段落原样念。</div>
            </div>
          )}

          <div className="voice-studio__fields">
            <label className="voice-studio__field">
              <span className="voice-studio__label">模型</span>
              {local ? (
                <select
                  className="settings-form-select"
                  value={selectedEngine}
                  onChange={(e) => setEngine(e.target.value)}
                  disabled={running}
                >
                  {LOCAL_TTS_ENGINE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                      {engineModelPresent[option.value] === false ? '（模型还没下载）' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="settings-form-input"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={configModel || '配音配置里的那个模型'}
                  disabled={running}
                />
              )}
            </label>
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
                      音色 {sid}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="settings-form-input"
                  type="text"
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  placeholder={configVoice || '配音配置里的那个音色'}
                  disabled={running}
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

          <p className="voice-studio__hint">
            {local
              ? speakers > 0
                ? `这一档有 ${speakers} 个音色（引擎加载后自己报的数）。上游没给音色名字，只能按编号挨个试听来认。`
                : '音色总数要等引擎把模型读进内存才知道——先点一次「试听第一句」，这里就会列出全部编号。'
              : '云端能填哪些模型和音色由服务商决定，应用不替你猜，所以这两项手输。留空＝用配音配置里保存的那个。'}
          </p>

          <div className="voice-studio__config">
            {local ? '配音引擎：本地（在你这台电脑上跑，不调接口）' : '配音引擎：云端接口（按服务商计费）'}
            {' · '}
            {local ? (
              <code>{selectedEngine}</code>
            ) : (
              <>
                模型 <code>{model || configModel || '未填写'}</code>
              </>
            )}
            {!selectedPresent && (
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
                  ? '先听一句再整批跑：音色编号选错了，重跑的是几十分钟的机器活儿。'
                  : '整篇跑到第 20 段才发现音色不对，烧的是你的额度。'}
              </span>
            )}
          </div>

          <p className="voice-studio__cost">
            {local ? (
              <>
                本机合成 <strong>{callCount}</strong> 段（逐段串行，不调接口、不花钱）。第一次配音要多花几秒：
                引擎进程要起来、模型要读进内存，之后就快了。
              </>
            ) : (
              <>
                将调用 <strong>{callCount}</strong> 次接口（逐段串行，按服务商计费）。倍速由接口实现，
                个别服务商只提供固定档位或不认这个字段。
              </>
            )}
          </p>

          <button className="voice-studio__cta" onClick={() => void start()} disabled={running || callCount === 0}>
            <AudioLines size={16} />
            {running ? '配音进行中…' : '开始配音'}
          </button>
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
    </div>
  )
}
