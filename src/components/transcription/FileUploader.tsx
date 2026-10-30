/**
 * 文件上传组件
 * 支持两种输入方式：本地文件上传（点击/拖拽）和 视频链接（解析后可选「转写音频」或「下载视频」）
 * 顶部 tab 与字幕配音共用（见 StudioTabs），当前 tab 存在 useVoiceStudioStore 里；
 * 本地文件与音频下载完自动触发转写流程
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { Upload, Link2, Copy, Loader2, AudioLines, Download, Ban } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { useVoiceStudioStore } from '@/stores/useVoiceStudioStore'
import { frontendLogger } from '@/utils/logger'
import { checkTranscriptionReady, raiseReadinessBlock } from '@/utils/readiness'
import { formatBytes } from '@/utils/formatBytes'
import { StudioTabs } from './StudioTabs'

/** 链接这条链路的状态机：input（还没解析）→ resolving → ready（二选一）→ downloading */
type UrlStage = 'input' | 'resolving' | 'ready' | 'downloading'

/** 与 electron/preload/index.d.ts 的 MediaInfo 对齐；沿用本仓库惯例，渲染层自己声明形状 */
interface MediaQualityOption {
  height: number | null
  label: string
  approxBytes: number | null
  streams: number
}

interface MediaInfo {
  title: string
  durationSeconds: number | null
  uploader: string | null
  isLive: boolean
  audioApproxBytes: number | null
  videoOptions: MediaQualityOption[]
}

interface MediaProgress {
  sessionId: string
  kind: 'audio' | 'video'
  stage: 'downloading' | 'merging' | 'converting'
  streamIndex: number
  streamCount: number
  percent: number | null
  speed: string | null
  eta: string | null
}

/** 站点可能不报某一档的体积，这时按钮上要说「大小未知」，不能拿 0B 冒充一个已知的小数 */
function sizeLabel(bytes: number | null): string {
  return bytes === null ? '大小未知' : formatBytes(bytes)
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '时长未知'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

export function FileUploader() {
  const { setFile, setStatus, setProgress, setStage, setModelInfo, setJobId, setAsrProvider, setAsrLanguage, addSegment, setSegments, setError, setUnsubscribeProgress, reset } = useTranscriptionStore()
  const api = getElectronAPI()
  const [isDragging, setIsDragging] = useState(false)
  const tab = useVoiceStudioStore((s) => s.tab)
  const setTab = useVoiceStudioStore((s) => s.setTab)
  /** 上传面板只吃 file/url 两态；tab 走到 voice 时这块根本不渲染 */
  const mode: 'file' | 'url' = tab === 'url' ? 'url' : 'file'
  const [urlInput, setUrlInput] = useState('')
  const [urlStage, setUrlStage] = useState<UrlStage>('input')
  const [media, setMedia] = useState<{ sessionId: string; info: MediaInfo } | null>(null)
  const [mediaProgress, setMediaProgress] = useState<MediaProgress | null>(null)
  const [pickedHeight, setPickedHeight] = useState<number | null>(null)
  const [canceling, setCanceling] = useState(false)
  /**
   * 会话目录里是媒体 + 浏览器 cookies，主进程只在「还会话」时才删。
   * ref 而不是 state：卸载清理要读到最新值，用 state 会拿到闭包里的旧值。
   * handedOff 为真表示音频已经交给转写任务，那时由 asr:start 负责还。
   */
  const sessionRef = useRef<string | null>(null)
  const handedOffRef = useRef(false)

  const releaseSession = useCallback(() => {
    const id = sessionRef.current
    sessionRef.current = null
    if (id && !handedOffRef.current) void api?.releaseMediaSession(id)
    handedOffRef.current = false
  }, [api])

  // 换链接、切回本地文件、直接关掉页面：只要会话还在手上就得还，否则几十 MB 到几 GB 留在 /tmp
  useEffect(() => {
    return () => {
      if (sessionRef.current && !handedOffRef.current) {
        void api?.releaseMediaSession(sessionRef.current)
      }
      sessionRef.current = null
    }
  }, [api])

  useEffect(() => {
    if (api) {
      frontendLogger.setAPI(api)
      frontendLogger.info('FileUploader', 'Component initialized')
    }
  }, [api])

  const startTranscriptionProcess = useCallback(async (
    filePath: string,
    fileName: string,
    fileSize: number,
    mediaSessionId?: string
  ) => {
    frontendLogger.userAction('Start transcription process', { fileName, fileSize })
    if (!api) {
      frontendLogger.error('FileUploader', 'API is null')
      return
    }

    // 开工前置校验：配置不可用时当场拦下并直达设置页，不要等音频提取完才失败
    const blocked = await checkTranscriptionReady()
    if (blocked) {
      frontendLogger.warn('FileUploader', 'Transcription blocked by preflight', { reason: blocked.message })
      raiseReadinessBlock(blocked)
      return
    }

    setFile({ filePath, fileName, fileSize, duration: 0 })
    setStatus('extracting_audio')
    setProgress(0)

    try {
      const unsubscribe = api.onTranscriptionProgress((data) => {
        // jobId 只在 asr:start 的返回值里会有，但那时转写已经结束；取消按钮需要在进行中就拿得到
        setJobId(data.jobId)
        setProgress(data.progress)
        setStage(data.stage ?? null)
        setModelInfo(data.model ?? null)

        if (data.progress < 5) {
          setStatus('extracting_audio')
        } else if (data.progress < 100) {
          setStatus('transcribing')
        }

        if (data.segment) {
          addSegment({
            id: `${data.segment.startTime}-${data.segment.endTime}`,
            startTime: data.segment.startTime,
            endTime: data.segment.endTime,
            text: data.segment.text,
            originalText: data.segment.text,
            isEdited: false,
            isCorrected: false,
            confidence: data.segment.confidence,
          })
        }

        if (data.progress >= 100) {
          setStatus('completed')
          frontendLogger.userAction('Transcription completed', { fileName })
          unsubscribe()
          setUnsubscribeProgress(null)
        }
      })

      setUnsubscribeProgress(unsubscribe)

      // 语言以设置里的「转写语言」为准，不再写死中文；同时记进 store，
      // 校对那条分支要靠它判断中文规则是否成立
      // 读设置失败回的是 null（IPC 收口后不再 reject，见 ipc/guard.ts）：回落 zh 能继续跑，
      // 但必须说一声——用户明明选过英语，静默按中文转出来的稿子他第一眼看不出问题出在哪一步
      const settings = await api.getSettings()
      const language =
        typeof settings?.asrLanguage === 'string' && settings.asrLanguage ? settings.asrLanguage : 'zh'
      setAsrLanguage(language)
      if (settings === null) {
        frontendLogger.warn('FileUploader', '设置读不出来，本次转写按默认语言处理', { language })
        // 回落的必然是 zh（设置整份没读到），这句话要说死，别写成「按 ${language}」演成读到了似的
        toast.info('设置读不出来，本次按默认的中文转写；如果素材不是中文，转完请先检查', 10000)
      }

      frontendLogger.serviceCall('ASR', 'startTranscription', { fileName, language })
      // 带上会话 id：主进程提取完音频就地还会话目录（里面还有 cookies），不用这边记着清
      const result = await api.startTranscription(filePath, { language, mediaSessionId })

      if (!result.success) {
        unsubscribe()
        setUnsubscribeProgress(null)
        if (result.canceled) {
          frontendLogger.userAction('Transcription canceled', { fileName })
          reset()
          return
        }
        frontendLogger.error('FileUploader', 'Transcription failed', result.error)
        setError(result.error || '转写失败')
        return
      }

      setJobId(result.jobId)
      /**
       * 段落是一条条从 asr:progress 推进 store 的，但只有本地引擎会逐段推；
       * 云端一次请求拿整份结果，进度只有 2/10/80/100 这几个点，result.segments 是段落唯一的去处。
       * 只在 store 还空着的时候整份写入——本地流式路径下用户可能已经在改前面那段，不该被盖掉。
       */
      if (result.segments?.length && useTranscriptionStore.getState().segments.length === 0) {
        setSegments(
          result.segments.map((seg) => ({
            id: `${seg.startTime}-${seg.endTime}`,
            startTime: seg.startTime,
            endTime: seg.endTime,
            text: seg.text,
            originalText: seg.text,
            isEdited: false,
            isCorrected: false,
            confidence: seg.confidence,
          }))
        )
      }
      if (result.provider) {
        setAsrProvider(result.provider)
        frontendLogger.info('FileUploader', 'ASR provider set', { provider: result.provider })
      }
    } catch (err) {
      frontendLogger.error('FileUploader', 'Transcription error', err instanceof Error ? err.message : '转写失败')
      setError(err instanceof Error ? err.message : '转写失败')
    }
  }, [api, setFile, setStatus, setProgress, setJobId, setAsrProvider, setAsrLanguage, addSegment, setSegments, setError, setUnsubscribeProgress, reset])

  const handleSelectFile = useCallback(async () => {
    frontendLogger.userAction('File selection dialog opened')
    if (!api) return
    const selectedPath = await api.selectFile()
    if (!selectedPath) {
      frontendLogger.userAction('File selection cancelled')
      return
    }
    frontendLogger.userAction('File selected', { name: selectedPath.split(/[\\/]/).pop() ?? selectedPath })
    const metadata = await api.getFileMetadata(selectedPath)
    if (!metadata) {
      toast.error('无法读取该文件的信息，请确认文件存在且为受支持的音视频格式')
      return
    }

    await startTranscriptionProcess(metadata.path, metadata.name, metadata.size)
  }, [api, startTranscriptionProcess])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (!api) return

    const file: any = e.dataTransfer.files[0]
    if (!file) return

    frontendLogger.userAction('File dropped', { fileName: file.name })
    const filePath = api.getDroppedFilePath(file)
    if (!filePath) {
      toast.error('无法读取拖入文件的路径，请改用点击上传')
      return
    }

    const metadata = await api.getFileMetadata(filePath)
    if (!metadata) {
      toast.error('无法读取该文件的信息，请确认文件存在且为受支持的音视频格式')
      return
    }
    // 拖拽绕过了选择框的 filters，支持与否以主进程返回的 supported 为准
    if (!metadata.supported) {
      frontendLogger.warn('FileUploader', 'Invalid file format', { fileName: file.name, ext: metadata.extension })
      toast.error(`不支持的文件格式「${file.name}」，请换成 MP4 / MOV / MKV / MP3 / WAV / M4A 等常见音视频`)
      return
    }

    await startTranscriptionProcess(metadata.path, metadata.name, metadata.size)
  }, [api, startTranscriptionProcess])

  const handlePasteUrl = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      setUrlInput(text)
    } catch {
      frontendLogger.warn('FileUploader', 'Failed to read clipboard')
    }
  }, [])

  /** 下载进度是事件推回来的（一个 4K 片在慢网里要跑几分钟），不订阅界面就像卡死 */
  useEffect(() => {
    if (urlStage !== 'downloading' || !api) return
    const off = api.onMediaProgress((data) => {
      if (data.sessionId !== sessionRef.current) return
      setMediaProgress(data)
    })
    return off
  }, [urlStage, api])

  /** 解析：只拿标题/时长/清晰度，不落任何媒体。下错了档至少不用重下整片 */
  const handleResolveUrl = useCallback(async () => {
    const url = urlInput.trim()
    if (!url || !api) return
    frontendLogger.userAction('URL resolved', { url })
    releaseSession()
    setMedia(null)
    setMediaProgress(null)
    setUrlStage('resolving')

    try {
      const result = await api.resolveMedia(url)
      if (!result.success || !result.sessionId || !result.info) {
        setUrlStage('input')
        if (result.systemSettingsHint) {
          // 包内二进制被系统拦下执行（macOS 未授权）：给一键直达隐私设置的入口，别只让用户读文字
          toast.error(result.error || '链接解析失败', 8000, {
            label: '打开隐私设置',
            onClick: () => { void api.openSystemSettings() },
          })
        } else {
          // 链接解析不出来时，绝大多数情况的出路只有「换成本地文件」，把这条路直接给出来
          toast.error(result.error || '链接解析失败，请重试', 8000, {
            label: '改传本地文件',
            onClick: () => setTab('file'),
          })
        }
        return
      }
      sessionRef.current = result.sessionId
      setMedia({ sessionId: result.sessionId, info: result.info })
      setPickedHeight(result.info.videoOptions[0]?.height ?? null)
      setUrlStage('ready')
    } catch (err) {
      setUrlStage('input')
      frontendLogger.error('FileUploader', 'Resolve error', err instanceof Error ? err.message : '解析失败')
      toast.error('链接解析失败，请重试', 8000, {
        label: '改传本地文件',
        onClick: () => setTab('file'),
      })
    }
  }, [urlInput, api, releaseSession])

  /** 转写音频：产物直接进现有转写链路，会话交给 asr:start 去还 */
  const handleTranscribeAudio = useCallback(async () => {
    if (!api || !media) return
    setUrlStage('downloading')
    setMediaProgress(null)
    frontendLogger.userAction('Media download started', { kind: 'audio' })

    const result = await api.downloadMedia(media.sessionId, 'audio')
    if (!result.success || !result.filePath) {
      setUrlStage('ready')
      if (result.canceled) {
        toast.info('已取消下载')
      } else if (result.systemSettingsHint) {
        toast.error(result.error || '下载失败', 8000, {
          label: '打开隐私设置',
          onClick: () => { void api.openSystemSettings() },
        })
      } else {
        toast.error(result.error || '下载失败，请重试', 8000)
      }
      return
    }

    const metadata = await api.getFileMetadata(result.filePath)
    if (!metadata) {
      setUrlStage('ready')
      toast.error('下载完成但读不到文件信息，请重试或改传本地文件', 8000)
      return
    }

    handedOffRef.current = true
    sessionRef.current = null
    setUrlStage('input')
    setMedia(null)
    setMediaProgress(null)
    await startTranscriptionProcess(
      metadata.path,
      media.info.title || metadata.name,
      result.fileSizeBytes ?? metadata.size,
      media.sessionId
    )
  }, [api, media, startTranscriptionProcess])

  /** 下载视频：下满临时目录后才问存哪儿，免得用户目录里躺个半成品 */
  const handleDownloadVideo = useCallback(async () => {
    if (!api || !media) return
    setUrlStage('downloading')
    setMediaProgress(null)
    frontendLogger.userAction('Media download started', { kind: 'video', height: pickedHeight })

    const result = await api.downloadMedia(media.sessionId, 'video', pickedHeight)
    if (!result.success || !result.filePath) {
      setUrlStage('ready')
      if (result.canceled) {
        toast.info('已取消下载')
      } else if (result.systemSettingsHint) {
        toast.error(result.error || '下载失败', 8000, {
          label: '打开隐私设置',
          onClick: () => { void api.openSystemSettings() },
        })
      } else {
        toast.error(result.error || '下载失败，请重试', 8000)
      }
      return
    }

    const saved = await api.saveMediaAs(media.sessionId)
    // 存成功和取消这两条路，主进程自己已经把会话还了，这里只清 ref、不能再发一次释放；
    // 只有 copyFile 失败那条它故意留着会话，界面已经退回输入态、没有重试入口，必须由下面还回去
    if (saved.success || saved.canceled) sessionRef.current = null
    else releaseSession()
    setMedia(null)
    setMediaProgress(null)
    setUrlStage('input')
    if (saved.success) {
      const name = saved.savedPath?.split(/[\\/]/).pop() ?? '视频'
      frontendLogger.userAction('Video saved', { name })
      toast.success(`已保存 ${name}`)
      setUrlInput('')
    } else if (saved.canceled) {
      toast.info('已取消保存，临时文件已清理')
    } else {
      toast.error(saved.error || '保存失败', 8000)
    }
  }, [api, media, pickedHeight, releaseSession])

  const handleCancelDownload = useCallback(async () => {
    if (!api || !sessionRef.current) return
    setCanceling(true)
    try {
      const result = await api.cancelMediaDownload(sessionRef.current)
      // 收口后这条不 reject 了，失败是回值（见 ipc/guard.ts）。不读它，「点了取消还在下」就只能干等
      if (!result.success) toast.error(result.error || '取消下载失败')
    } finally {
      // 不在这里收尾：downloadMedia 以 canceled 结束时由上面两条链路统一回到「二选一」
      setCanceling(false)
    }
  }, [api])

  const resetUrlTab = useCallback(() => {
    releaseSession()
    setMedia(null)
    setMediaProgress(null)
    setUrlStage('input')
  }, [releaseSession])

  // 从「音视频链接」切走就把会话还掉：解析过但没下完的链接不该在 /tmp 里留着 cookies。
  // tab 现在由共用的顶部 tab 条控制（切到「字幕配音」是整块卸载，由上面那个卸载清理兜着）。
  useEffect(() => {
    if (tab !== 'url') resetUrlTab()
  }, [tab, resetUrlTab])

  return (
    <div className="upload_zone">
      <StudioTabs />

      {mode === 'file' ? (
        <div
          className={`upload-zone ${isDragging ? 'dragging' : ''}`}
          onClick={handleSelectFile}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="upload-icon-circle">
            <Upload />
          </div>
          <div className="upload-title">
            {isDragging ? '释放以上传文件' : '点击或拖拽上传音视频文件'}
          </div>
          <div className="upload-subtitle">
            支持 MP4, MP3, WAV, M4A 等常见格式
          </div>
        </div>
      ) : (
        <div className="url-input-zone">
          <div className="upload-icon-circle">
            <Link2 />
          </div>
          <div className="upload-title">粘贴音频/视频链接</div>
          <div className="url-input-row">
            <input
              className="url-input"
              type="text"
              placeholder="粘贴公开音视频链接（不需要登录的那种）"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && urlStage === 'input' && handleResolveUrl()}
              disabled={urlStage === 'resolving' || urlStage === 'downloading'}
            />
            <button
              className="url-paste-btn"
              onClick={handlePasteUrl}
              title="粘贴"
              disabled={urlStage === 'resolving' || urlStage === 'downloading'}
            >
              <Copy size={16} />
            </button>
          </div>

          {urlStage === 'ready' && media && (
            <div className="media-card">
              <div className="media-card__title" title={media.info.title}>
                {media.info.title}
              </div>
              <div className="media-card__meta">
                {formatDuration(media.info.durationSeconds)}
                {media.info.uploader ? ` · ${media.info.uploader}` : ''}
              </div>

              <div className="media-card__choices">
                <button className="media-choice-btn media-choice-btn--primary" onClick={handleTranscribeAudio}>
                  <AudioLines size={14} />
                  <span>转写音频</span>
                  <span className="media-choice-btn__size">{sizeLabel(media.info.audioApproxBytes)}</span>
                </button>

                {media.info.videoOptions.length > 0 ? (
                  <div className="media-card__video-row">
                    <select
                      className="settings-form-select media-card__quality"
                      value={String(pickedHeight)}
                      onChange={(e) => setPickedHeight(e.target.value === 'null' ? null : Number(e.target.value))}
                    >
                      {media.info.videoOptions.map((opt) => (
                        <option key={String(opt.height)} value={String(opt.height)}>
                          {opt.label} · {sizeLabel(opt.approxBytes)}
                        </option>
                      ))}
                    </select>
                    <button className="media-choice-btn" onClick={handleDownloadVideo}>
                      <Download size={14} />
                      <span>下载视频</span>
                    </button>
                  </div>
                ) : (
                  <div className="media-card__note">站点没报画面档位，这条链接只能走「转写音频」</div>
                )}
              </div>

              <div className="media-card__hint">
                体积按站点自报估算，实际可能上下浮动；「转写音频」只取音频轨，站点 cookies 提取完音频就删，
                这份临时音频留到退出应用时清理
              </div>
              <button className="media-card__reset" onClick={resetUrlTab}>
                <Ban size={13} />
                换个链接
              </button>
            </div>
          )}

          {urlStage === 'downloading' && (
            <div className="media-progress">
              <div className="media-progress__title">
                <Loader2 size={14} className="animate-spin" />
                {mediaProgress?.kind === 'video' ? '下载视频中' : '下载音频中'}
                {mediaProgress && mediaProgress.streamCount > 1
                  ? ` · 第 ${mediaProgress.streamIndex}/${mediaProgress.streamCount} 路`
                  : ''}
                {mediaProgress && mediaProgress.stage !== 'downloading'
                  ? ` · ${mediaProgress.stage === 'merging' ? '合并音视频轨' : '转码中'}`
                  : ''}
              </div>
              <div className="media-progress__bar">
                <div
                  className="media-progress__fill"
                  style={{ width: `${Math.round(mediaProgress?.percent ?? 0)}%` }}
                />
              </div>
              <div className="media-progress__detail">
                {mediaProgress?.percent !== null && mediaProgress?.percent !== undefined
                  ? `${Math.round(mediaProgress.percent)}%`
                  : '站点没报总大小'}
                {mediaProgress?.speed ? ` · ${mediaProgress.speed}` : ''}
                {mediaProgress?.eta ? ` · 剩余 ${mediaProgress.eta}` : ''}
              </div>
              <button className="media-card__reset" onClick={handleCancelDownload} disabled={canceling}>
                <Ban size={13} />
                {canceling ? '取消中...' : '取消下载'}
              </button>
            </div>
          )}

          {urlStage !== 'ready' && urlStage !== 'downloading' && (
            <>
              <div className="upload-subtitle">
                只能取公开视频。需要登录或会员的视频（抖音、B 站会员片、部分 YouTube）拿不到音频，
                请先在本地下载好，再走「本地文件」上传
              </div>
              <button
                className="url-submit-btn"
                disabled={!urlInput.trim() || urlStage === 'resolving'}
                onClick={handleResolveUrl}
              >
                {urlStage === 'resolving' ? (
                  <><Loader2 size={14} className="animate-spin" /> 正在解析链接...</>
                ) : (
                  '解析链接'
                )}
              </button>
            </>
          )}
        </div>
      )}

      <div className="feature_highlights">
        <span className="feature_highlights_text">
          支持音频、视频转写 · AI 智能校对 · 多格式导出
        </span>
      </div>
    </div>
  )
}
