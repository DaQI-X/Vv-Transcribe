/**
 * 音视频播放器组件
 * 自动识别文件类型，视频文件显示 <video>，音频文件显示波形可视化
 * 功能：播放/暂停、进度条拖拽 seek、播放速率控制、段落高亮同步
 * 通过 file:// 协议加载本地文件（依赖 webSecurity: false）
 */
import { useRef, useEffect, useCallback } from 'react'
import { Play, Pause, Volume2 } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function WaveformDisplay({ currentTime, duration }: { currentTime: number; duration: number }) {
  const bars = Array.from({ length: 60 }, (_, i) => {
    const barTime = (i / 60) * duration
    const isPlayed = barTime < currentTime
    const height = 20 + Math.sin(i * 0.3) * 20 + Math.abs(Math.sin(i * 1.7)) * 15
    return (
      <div
        key={i}
        className={`waveform-display__bar ${isPlayed ? 'active' : ''}`}
        style={{
          height: `${height}px`,
          backgroundColor: isPlayed ? '#1b55f5' : '#E4E8EE',
        }}
      />
    )
  })

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="waveform-display">
      {bars}
      <div className="waveform-display__playhead" style={{ left: `${progressPercent}%` }}>
        <div className="waveform-display__playhead-dot" />
      </div>
    </div>
  )
}

export function AudioPlayer() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { filePath, fileName, fileSize, duration: fileDuration } = useTranscriptionStore()
  const { isPlaying, currentTime, duration, playbackRate, seekTo, setIsPlaying, setCurrentTime, setDuration, setActiveSegment, clearSeek } = usePlayerStore()
  const { segments } = useTranscriptionStore()
  const isDraggingRef = useRef(false)
  const lastSeekValueRef = useRef(0)
  const segmentsRef = useRef(segments)
  const isPlayingRef = useRef(isPlaying)

  const isVideo = filePath && /\.(mp4|mkv|avi|mov|webm|flv)$/i.test(filePath)

  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    const media = isVideo ? videoRef.current : audioRef.current
    if (!media || !filePath) return

    let aborted = false

    const onLoadedMetadata = () => {
      if (!aborted) setDuration(media.duration)
    }
    const onTimeUpdate = () => {
      if (isDraggingRef.current || aborted) return
      const time = media.currentTime
      setCurrentTime(time)
      const activeSeg = segmentsRef.current.find((seg) => seg && time >= seg.startTime && time < seg.endTime)
      setActiveSegment(activeSeg?.id ?? null)
    }
    const onEnded = () => {
      if (!aborted) setIsPlaying(false)
    }
    const onError = () => {
      if (aborted) return
      // 解码失败时 duration 永远是 0、进度条一片空白，不给提示用户只会以为程序卡住
      toast.error('音视频加载失败，可能是编码不受支持或文件已被移动；转写结果仍可正常编辑和导出')
    }

    media.src = `file://${filePath}`
    media.addEventListener('loadedmetadata', onLoadedMetadata)
    media.addEventListener('timeupdate', onTimeUpdate)
    media.addEventListener('ended', onEnded)
    media.addEventListener('error', onError)

    return () => {
      aborted = true
      media.removeEventListener('loadedmetadata', onLoadedMetadata)
      media.removeEventListener('timeupdate', onTimeUpdate)
      media.removeEventListener('ended', onEnded)
      media.removeEventListener('error', onError)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, isVideo])

  useEffect(() => {
    const media = isVideo ? videoRef.current : audioRef.current
    if (!media) return
    media.playbackRate = playbackRate
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackRate, isVideo])

  useEffect(() => {
    if (seekTo === null) return
    const media = isVideo ? videoRef.current : audioRef.current
    if (!media) return
    media.currentTime = seekTo
    setCurrentTime(seekTo)
    clearSeek()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTo, isVideo])

  const togglePlay = useCallback(() => {
    const media = isVideo ? videoRef.current : audioRef.current
    if (!media) return
    if (isPlayingRef.current) {
      media.pause()
      setIsPlaying(false)
    } else {
      const playPromise = media.play()
      if (playPromise !== undefined) {
        playPromise.catch((error: Error) => {
          if (error.name === 'AbortError') return
          setIsPlaying(false)
          toast.error(error.name === 'NotAllowedError'
            ? '播放被系统拦截，请再次点击播放按钮'
            : '播放失败，可能是编码不受支持；转写结果不受影响')
        })
      }
      setIsPlaying(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, setIsPlaying])

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const media = isVideo ? videoRef.current : audioRef.current
    if (!media) return
    const val = Number(e.target.value)
    lastSeekValueRef.current = val
    setCurrentTime(val)
    const activeSeg = segmentsRef.current.find((seg) => seg && val >= seg.startTime && val < seg.endTime)
    setActiveSegment(activeSeg?.id ?? null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, setCurrentTime, setActiveSegment])

  const handleSeekStart = useCallback(() => {
    isDraggingRef.current = true
    const onGlobalMouseUp = () => {
      const media = isVideo ? videoRef.current : audioRef.current
      if (media) {
        media.currentTime = lastSeekValueRef.current
      }
      isDraggingRef.current = false
      document.removeEventListener('mouseup', onGlobalMouseUp)
    }
    document.addEventListener('mouseup', onGlobalMouseUp)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo])

  const handleSeekEnd = useCallback((e: React.SyntheticEvent<HTMLInputElement>) => {
    const val = Number((e.target as HTMLInputElement).value)
    const media = isVideo ? videoRef.current : audioRef.current
    if (!media) return
    media.currentTime = val
    setCurrentTime(val)
    isDraggingRef.current = false
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, setCurrentTime])

  if (!filePath) return null

  const sizeMB = fileSize ? (fileSize / (1024 * 1024)).toFixed(1) : '0'
  const totalDuration = duration || fileDuration || 0

  return (
    <div className="audio-player">
      {isVideo ? (
        <video ref={videoRef} className="audio-player__video" controls={false} />
      ) : (
        <audio ref={audioRef} style={{ display: 'none' }} />
      )}

      <div className="audio-player__header">
        <div className="audio-player__icon">
          <Volume2 size={18} />
        </div>
        <div className="audio-player__file-info">
          <span className="audio-player__file-name">{fileName}</span>
          <span className="audio-player__file-meta">{sizeMB} MB · {formatTime(totalDuration)}</span>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <WaveformDisplay currentTime={currentTime} duration={totalDuration} />
      </div>

      <div className="audio-time">
        <span className="audio-time__current">{formatTime(currentTime)}</span>
        <span className="audio-time__total">{formatTime(totalDuration)}</span>
      </div>

      <div className="audio-progress-section">
        <input
          type="range"
          className="audio-progress"
          min={0} max={totalDuration || 100} step={0.1} value={currentTime}
          onChange={handleSeek}
          onMouseDown={handleSeekStart}
          onMouseUp={handleSeekEnd}
          onTouchStart={handleSeekStart}
          onTouchEnd={handleSeekEnd}
        />
      </div>

      <div className="audio-controls">
        <button onClick={togglePlay} className="audio-controls__play">
          {isPlaying ? <Pause size={30} /> : <Play size={30} />}
        </button>
      </div>

      <div className="result-layout__player-hint">
        <span className="result-layout__player-hint-text">滑动可快速匹配对应时间点的内容</span>
      </div>

    </div>
  )
}
