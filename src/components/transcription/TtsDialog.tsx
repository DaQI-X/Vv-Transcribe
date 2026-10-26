/**
 * 配音弹窗
 * 三段走：确认（先花一次钱试听一句）→ 进行中（主进程推回来的真实段号 + 取消）→ 结果（时长、
 * 顺延了多少段、失败清单、保存）。
 *
 * 两个刻意的设计：
 * - 「共 N 段」必须点得下去之前就看得见：每一段都是一次真金白银的接口调用。
 * - 进行中不给关闭留出口，只给「取消」。跑一半关掉就等于把钱和产物一起丢掉，而取消之后
 *   已成功的片段照样能拼成一条轨——这条链路对用户更有用。
 *
 * 时间轴只在渲染层有一份，所以段落（含起止点）由这里打包交给主进程；
 * 它不改字幕，产物是一条独立的音轨。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, AudioLines, Download, Volume2, X } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { checkVoiceReady, raiseReadinessBlock } from '@/utils/readiness'

type Phase = 'confirm' | 'running' | 'result'

/** 与 electron/preload/index.d.ts 的 VoiceProgress 对齐：段号由主进程推回来 */
interface VoiceProgress {
  jobId: string
  stage: 'synthesizing' | 'skipped' | 'failed' | 'assembling' | 'done'
  /** 1 起算的真实段号；0 表示已发起、第一段还在接口那边；assembling/done 时等于总数 */
  index: number
  total: number
  segmentId?: string
  note?: string
}

/** 与 electron/preload/index.d.ts 的 VoiceTrack 对齐 */
interface VoiceTrack {
  filePath: string
  bytes: number
  duration: number
  pushedCount: number
  estimatedCount: number
  originalEnd: number
}

/** 与 electron/preload/index.d.ts 的 TTSSynthesizeResult 对齐 */
interface SynthesizeResult {
  jobId: string | null
  track: VoiceTrack | null
  clipCount: number
  failures: Array<{ segmentId: string; index: number; error: string }>
  skipped: string[]
  canceled: boolean
  abortedReason: string | null
  error: string | null
}

/** 进度实时计数：全部来自推送的事件，不编百分比也不猜剩余时间 */
interface LiveCount {
  done: number
  failed: number
  skipped: number
}

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

export function TtsDialog({ onClose }: { onClose: () => void }) {
  const { segments } = useTranscriptionStore()

  const [phase, setPhase] = useState<Phase>('confirm')
  const [progress, setProgress] = useState<VoiceProgress | null>(null)
  const [live, setLive] = useState<LiveCount>({ done: 0, failed: 0, skipped: 0 })
  const [result, setResult] = useState<SynthesizeResult | null>(null)
  const [preview, setPreview] = useState<{ filePath: string; duration: number } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewText, setPreviewText] = useState(() => {
    const first = segments.find((segment) => !!segment && segment.text.trim() !== '')
    return first ? first.text.trim() : ''
  })
  const [voiceConfig, setVoiceConfig] = useState<{ model: string; voice: string } | null>(null)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [saving, setSaving] = useState(false)

  // 一批的临时目录由主进程按 jobId 记账；弹窗一关就回收，不给用户留一地 mp3
  const jobIdRef = useRef<string | null>(null)

  const queue = useMemo(
    () =>
      segments
        .filter((segment) => !!segment && segment.text.trim() !== '')
        .map((segment) => ({
          id: segment.id,
          startTime: segment.startTime,
          endTime: segment.endTime,
          text: segment.text.trim(),
        })),
    [segments],
  )
  const emptyCount = segments.filter((segment) => !!segment && segment.text.trim() === '').length
  const totalChars = queue.reduce((sum, segment) => sum + segment.text.length, 0)

  useEffect(() => {
    const api = getElectronAPI()
    if (!api) return
    void api
      .getSettings()
      .then((settings) => {
        const model = typeof settings.aiTtsModel === 'string' ? settings.aiTtsModel : ''
        const voice = typeof settings.aiTtsVoice === 'string' ? settings.aiTtsVoice : ''
        setVoiceConfig({ model, voice })
      })
      .catch(() => setVoiceConfig(null))
    // 只在挂载时取一次：这是「要开始花钱了，看清楚在用什么」的确认信息，不是需要跟手的状态
  }, [])

  useEffect(() => {
    const api = getElectronAPI()
    if (!api) return
    const off = api.onVoiceProgress((data) => {
      jobIdRef.current = data.jobId
      setProgress(data)
      if (data.stage === 'synthesizing') {
        setLive((prev) => ({ ...prev, done: data.index, failed: prev.failed, skipped: prev.skipped }))
      } else if (data.stage === 'failed') {
        setLive((prev) => ({ ...prev, failed: prev.failed + 1 }))
      } else if (data.stage === 'skipped') {
        setLive((prev) => ({ ...prev, skipped: prev.skipped + 1 }))
      }
    })
    return off
  }, [])

  // 卸载即回收：试听目录 + 这一批的中间片段。漏调用不会永久泄漏（临时目录带 transcribe-
  // 前缀，启动清扫 24 小时兜得住），但当场能删干净的事不该留给下次启动
  useEffect(() => {
    return () => {
      const api = getElectronAPI()
      if (!api) return
      void api.releaseVoicePreview()
      if (jobIdRef.current) void api.releaseVoiceBatch(jobIdRef.current)
    }
  }, [])

  useEffect(() => {
    if (phase === 'running') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const handlePreview = useCallback(async () => {
    const api = getElectronAPI()
    if (!api) return
    if (!previewText.trim()) {
      toast.info('先给它一点文本')
      return
    }
    setPreviewing(true)
    try {
      const res = await api.previewVoice(previewText)
      if (res.error) {
        setPreview(null)
        toast.error(res.error)
        return
      }
      if (res.clip) {
        setPreview({ filePath: res.clip.filePath, duration: res.clip.duration })
        toast.success(
          res.clip.duration > 0
            ? `试听已生成，${formatTime(res.clip.duration)}`
            : '试听已生成（这条没读到时长，不影响播放）',
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '试听失败')
    } finally {
      setPreviewing(false)
    }
  }, [previewText])

  const handleStart = useCallback(async () => {
    const api = getElectronAPI()
    if (!api) return
    if (queue.length === 0) {
      toast.info('没有非空段落，没什么可以配音')
      return
    }
    const blocked = await checkVoiceReady()
    if (blocked) {
      raiseReadinessBlock(blocked)
      return
    }

    setPhase('running')
    setProgress(null)
    setLive({ done: 0, failed: 0, skipped: 0 })
    setCancelRequested(false)

    try {
      const res = await api.synthesizeVoice(queue)
      setResult(res)
      setPhase('result')
      if (res.error) toast.error(res.error)
      else if (res.abortedReason) toast.error(res.abortedReason)
      else if (res.canceled) toast.info(`已取消，已完成的 ${res.clipCount} 段拼成了一条轨`)
      else toast.success(`配音完成，${res.clipCount} 段`)
    } catch (err) {
      setPhase('confirm')
      toast.error(err instanceof Error ? err.message : '配音失败')
    }
  }, [queue])

  const handleCancel = useCallback(async () => {
    const api = getElectronAPI()
    if (!api) return
    // 第一段还在飞的时候 jobId 还没推回来，这时置标志等它；不这么处理就只能等下一段
    if (!jobIdRef.current) {
      setCancelRequested(true)
      return
    }
    const res = await api.cancelVoiceJob(jobIdRef.current)
    if (res.success) {
      setCancelRequested(true)
      toast.info('已请求取消，正在收尾')
    } else {
      toast.error('这批任务已经不在了')
    }
  }, [])

  const handleSave = useCallback(async () => {
    const api = getElectronAPI()
    const jobId = result?.jobId
    if (!api || !jobId) return
    setSaving(true)
    try {
      const res = await api.saveVoiceTrack(jobId)
      if (res.canceled) return
      if (res.success) toast.success(`已保存 ${res.name}`)
      else toast.error(res.error || '保存失败')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [result])

  // 取消请求发出去了但 jobId 还没到手：一拿到就补发
  useEffect(() => {
    const api = getElectronAPI()
    if (!api || !cancelRequested || !jobIdRef.current) return
    if (progress?.stage === 'synthesizing' || progress?.stage === 'failed' || progress?.stage === 'skipped') {
      void api.cancelVoiceJob(jobIdRef.current)
    }
  }, [cancelRequested, progress])

  const stageText = (() => {
    if (!progress) return '正在发起第一批调用…'
    if (progress.stage === 'assembling') return `正在把 ${progress.total} 段拼成一条音轨…`
    if (progress.stage === 'done') return '配音轨已拼好'
    if (progress.stage === 'failed') return `第 ${progress.index} 段失败：${progress.note || '未知原因'}`
    if (progress.stage === 'skipped') return `第 ${progress.index} 段是空的，没调接口`
    if (progress.index === 0) return '第 1 段还在接口那边…'
    return `已合成 ${progress.index} / ${progress.total} 段`
  })()

  const percent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.index / progress.total) * 100))
    : 0

  return createPortal(
    <div
      className="settings-overlay"
      onClick={() => {
        if (phase !== 'running') onClose()
      }}
    >
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal__header">
          <span className="settings-modal__title">配音</span>
          <button
            className="settings-modal__close"
            onClick={onClose}
            disabled={phase === 'running'}
            title={phase === 'running' ? '进行中，请先点「取消」' : '关闭'}
          >
            <X size={16} />
          </button>
        </div>

        <div className="settings-modal__body">
          {phase === 'confirm' && (
            <>
              <div className="voice-summary">
                <div className="voice-summary__counts">
                  <AudioLines size={16} />
                  <span>
                    共 <strong>{queue.length}</strong> 段可配音，约 <strong>{totalChars.toLocaleString()}</strong> 字
                  </span>
                </div>
                <p className="voice-summary__cost">
                  逐段串行调用配音接口，一段一次请求，按你所在服务商的计费方式扣费。整条耗时取决于接口响应速度。
                  {emptyCount > 0 && `另外 ${emptyCount} 段是空的，不会调用接口。`}
                </p>
                <p className="voice-summary__config">
                  正在使用：模型 <code>{voiceConfig?.model || '未填写'}</code> · 音色 <code>{voiceConfig?.voice || '未填写'}</code>
                  （在「设置 → 校对配置」里改；整条配音轨用同一个音色）
                </p>
              </div>

              <div className="voice-preview">
                <label className="settings-form-label" htmlFor="voice-preview-text">
                  试听一句（默认取第一段）
                </label>
                <textarea
                  id="voice-preview-text"
                  className="voice-preview__input"
                  rows={2}
                  value={previewText}
                  onChange={(e) => setPreviewText(e.target.value)}
                  disabled={previewing}
                  placeholder="打一句你想听的文本"
                />
                <div className="voice-preview__row">
                  <button className="settings-modal__cancel-btn" onClick={handlePreview} disabled={previewing}>
                    <Volume2 size={14} />
                    {previewing ? '试听合成中…' : '试听'}
                  </button>
                  {preview ? (
                    <audio className="voice-preview__audio" controls src={toMediaUrl(preview.filePath)} />
                  ) : (
                    <span className="voice-preview__hint">
                      整条稿子跑到第 20 段才发现音色不对，烧的是你的额度，所以先听这一句。
                    </span>
                  )}
                </div>
              </div>
            </>
          )}

          {phase === 'running' && (
            <div className="voice-progress">
              <div className="voice-progress__bar">
                <div className="voice-progress__fill" style={{ width: `${percent}%` }} />
              </div>
              <p className="voice-progress__stage">{stageText}</p>
              <p className="voice-progress__detail">
                成功 {live.done} · 失败 {live.failed} · 跳过 {live.skipped}
                {cancelRequested && '（已请求取消，正在收尾）'}
              </p>
              <p className="voice-progress__note">
                取消只拦后面的段落，正在飞的那一次请求已经发出去了，钱已经花掉。
              </p>
            </div>
          )}

          {phase === 'result' && result && (
            <div className="voice-result">
              {result.track ? (
                <>
                  <audio className="voice-result__audio" controls src={toMediaUrl(result.track.filePath)} />
                  <ul className="voice-result__stats">
                    <li>
                      配音轨 <strong>{formatTime(result.track.duration)}</strong> · {formatBytes(result.track.bytes)}
                      {result.track.duration === 0 && '（总时长没读到）'}
                    </li>
                    <li>
                      原时间轴到 {formatTime(result.track.originalEnd)}，这条
                      {result.track.duration > result.track.originalEnd ? '比它长' : '不比它长'}
                      （差 {formatTime(Math.abs(result.track.duration - result.track.originalEnd))}）
                    </li>
                    {result.track.pushedCount > 0 && (
                      <li className="voice-result__stat--warn">
                        <AlertTriangle size={13} />
                        {result.track.pushedCount} 段配音比字幕槽位长，已顺延到后面——这条轨和画面越到后面差得越多
                      </li>
                    )}
                    {result.track.estimatedCount > 0 && (
                      <li className="voice-result__stat--warn">
                        <AlertTriangle size={13} />
                        {result.track.estimatedCount} 段解出来是空音频（一个采样都没有），落点按字幕槽位估算
                      </li>
                    )}
                    <li>成功 {result.clipCount} 段{result.skipped.length > 0 && ` · 空段落跳过 ${result.skipped.length} 段`}</li>
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
                <p className="voice-result__empty">
                  {result.error || '一段都没合成成功，没有可以拼起来的音频。'}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="settings-modal__footer proofread-dialog__footer">
          {phase === 'confirm' && (
            <>
              <span className="proofread-dialog__tip">
                {queue.length === 0 ? '没有非空段落' : `将为 ${queue.length} 段各调用一次接口`}
              </span>
              <span className="voice-footer__actions">
                <button className="settings-modal__cancel-btn" onClick={onClose}>
                  取消
                </button>
                <button className="settings-modal__save-btn" onClick={handleStart} disabled={queue.length === 0}>
                  开始配音
                </button>
              </span>
            </>
          )}
          {phase === 'running' && (
            <>
              <span className="proofread-dialog__tip">这一段段调用是花钱的，中途别关窗口</span>
              <button className="settings-modal__cancel-btn" onClick={handleCancel} disabled={cancelRequested}>
                {cancelRequested ? '正在取消…' : '取消'}
              </button>
            </>
          )}
          {phase === 'result' && (
            <>
              <span className="proofread-dialog__tip">不保存的话，关窗就把这批产物删掉</span>
              <span className="voice-footer__actions">
                <button className="settings-modal__cancel-btn" onClick={onClose}>
                  关闭
                </button>
                {result?.track && (
                  <button className="settings-modal__save-btn" onClick={handleSave} disabled={saving}>
                    <Download size={14} />
                    {saving ? '保存中…' : '保存配音轨'}
                  </button>
                )}
              </span>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
