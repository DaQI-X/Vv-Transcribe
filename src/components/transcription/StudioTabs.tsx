/**
 * 顶部 tab 条：转写的两个入口 + 字幕配音
 *
 * 首页和工作台共用这一个组件，两边各写一份必然漂移（1.0.7 要做统一导航，届时只改这里）。
 * 有转写结果时前两个 tab 收成「返回转写」：那时候点「本地文件」实际会回到转写视图，
 * 标签写着上传却把人带回结果页，是骗人的。
 */
import { ArrowLeft, AudioLines, Link2, Upload } from 'lucide-react'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { useVoiceStudioStore } from '@/stores/useVoiceStudioStore'

export function StudioTabs() {
  const tab = useVoiceStudioStore((s) => s.tab)
  const setTab = useVoiceStudioStore((s) => s.setTab)
  const hasFile = useTranscriptionStore((s) => !!s.fileName)

  // 已经在配音页了，再摆一排同类入口只会让人怀疑自己走错地方：这里只留一个出口。
  // 标签按有没有稿子给——有稿子时回到的是转写结果，写成「首页」是骗人的。
  // 样式沿用转写结果页那颗返回按钮：单个按钮套进首页那枚灰底药丸里，看着像坏掉的 tab。
  if (tab === 'voice') {
    return (
      <div className="voice-studio__back">
        <button className="transcript-editor__back-btn" onClick={() => setTab('file')}>
          <ArrowLeft size={14} />
          <span>{hasFile ? '返回转写' : '返回首页'}</span>
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
      </button>
    </div>
  )
}
