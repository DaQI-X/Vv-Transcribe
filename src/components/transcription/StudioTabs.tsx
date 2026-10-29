/**
 * 顶部 tab 条：转写的两个入口 + 字幕配音
 *
 * 首页和工作台共用这一个组件，两边各写一份必然漂移（统一导航还没排进任何一版，动导航时只改这里）。
 * 有转写结果时前两个 tab 收成「返回转写」：那时候点「本地文件」实际会回到转写视图，
 * 标签写着上传却把人带回结果页，是骗人的。
 */
import { ArrowLeft, AudioLines, Eraser, Link2, Upload } from 'lucide-react'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { useVoiceStudioStore } from '@/stores/useVoiceStudioStore'

export function StudioTabs() {
  const tab = useVoiceStudioStore((s) => s.tab)
  const setTab = useVoiceStudioStore((s) => s.setTab)
  const clearDraft = useVoiceStudioStore((s) => s.clearDraft)
  const hasFile = useTranscriptionStore((s) => !!s.fileName)
  // 按派生的布尔/句子取值订阅：整份 state 拿进来会让人每敲一个字就重画一次 tab
  const running = useVoiceStudioStore((s) => s.phase === 'running')
  const hasDraft = useVoiceStudioStore(
    (s) => s.source === 'text' && (s.text.trim() !== '' || s.preview !== null)
  )
  // 输入框已经空了、试听也没东西时，这颗按钮按下去不改变任何事——那就别让它像能按
  const clearTitle = useVoiceStudioStore((s) => {
    if (s.phase === 'running') return '配音正在跑，先取消或等它跑完'
    if (s.source === 'subtitle') return '「从转写带入」的稿子来自转写结果，这里清的是本页的输入框，不动那份稿'
    if (s.text.trim() === '' && !s.preview) return '输入框已经是空的'
    return '清空输入框里的文稿（已经配好的那条轨不动）'
  })

  if (tab === 'voice') {
    // 已经在配音页了，再摆一排同类入口只会让人怀疑自己走错地方：这里只留一个出口 + 一颗清空。
    // 标签按有没有稿子给——有稿子时回到的是转写结果，写成「首页」是骗人的。
    // 样式沿用转写结果页那颗返回按钮：单个按钮套进首页那枚灰底药丸里，看着像坏掉的 tab。
    return (
      <div className="voice-studio__back">
        <button className="transcript-editor__back-btn" onClick={() => setTab('file')}>
          <ArrowLeft size={14} />
          <span>{hasFile ? '返回转写' : '返回首页'}</span>
        </button>
        <button
          className="transcript-editor__back-btn"
          onClick={clearDraft}
          disabled={running || !hasDraft}
          title={clearTitle}
        >
          <Eraser size={14} />
          <span>清空文稿</span>
        </button>
      </div>
    )
  }

  return (
    <div className="upload-tabs">
      {hasFile ? (
        <button className="upload-tab" onClick={() => setTab('file')}>
          <ArrowLeft size={14} />
          <span>返回转写</span>
        </button>
      ) : (
        <>
          <button className={`upload-tab ${tab === 'file' ? 'active' : ''}`} onClick={() => setTab('file')}>
            <Upload size={14} />
            <span>本地文件</span>
          </button>
          <button className={`upload-tab ${tab === 'url' ? 'active' : ''}`} onClick={() => setTab('url')}>
            <Link2 size={14} />
            <span>音视频链接</span>
          </button>
        </>
      )}
      {/* 走到这里 tab 只可能是 file/url，配音项必定是「还没进来」的状态，不需要 active 样式 */}
      <button className="upload-tab" onClick={() => setTab('voice')}>
        <AudioLines size={14} />
        <span>字幕配音</span>
        {/* 2026-10-28 拍板「离线配音随 1.0.6 发，界面挂实验标」。标打在 tab 而不是只打在本地档：
            两条档共用同一条 ffmpeg 铺轴，而打包版在 Intel / Windows 上的端到端冒烟还没跑过
            （#213、#235；离线那 108 条断言验的是那张图对两份随包二进制成立，不是应用跑通）。 */}
        <span className="upload-tab__beta">实验</span>
      </button>
    </div>
  )
}
