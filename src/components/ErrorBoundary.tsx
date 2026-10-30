/**
 * 渲染层崩溃兜底
 *
 * 没有这一层时，任何一个组件渲染抛错都会把整棵树换成一页空白：用户对着白屏，
 * 不知道是应用挂了还是自己在加载，正在跑的转写/配音结果也就跟着没了地方可看。
 *
 * 三条和主进程 crashWatch 一致的规矩：
 * 1. 先落日志。这张卡片是唯一能出现在用户眼前的现场，但真正能定位的是 app.log 里那一条。
 * 2. 不依赖 toast。崩溃往往就发生在界面本身，toast 容器可能正是坏掉的那部分，
 *    所以提示、复制成功与否都只用自己的状态在卡片里显示。
 * 3. 不替用户决定丢不丢数据。重载会丢掉这份还没导出的结果，所以只提供按钮，不自动刷。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Copy, FolderOpen, RotateCcw, TriangleAlert } from 'lucide-react'
import { getElectronAPI } from '@/hooks/useElectronAPI'

interface Props {
  children: ReactNode
}

interface State {
  message: string
  stack: string
  /** 复制/开目录这些操作的结果，只在这张卡片里说话，不走 toast */
  notice: string
}

/** 拼一段能直接贴进邮件的现场：错误本体 + 版本号 + UA（Electron/系统都能从 UA 读出来） */
function buildDetails(message: string, stack: string): string {
  return [
    `时间：${new Date().toISOString()}`,
    `错误：${message}`,
    stack,
    `环境：${navigator.userAgent}`,
  ].join('\n')
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: '', stack: '', notice: '' }

  static getDerivedStateFromError(err: unknown): Partial<State> {
    return {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? (err.stack ?? '') : '',
      notice: '',
    }
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // 跨 IPC 只送结论，不送用户文稿内容：栈里可能带着组件 props 的片段，
    // 但界面崩溃这条链路本身不该再决定「哪些文本算敏感」，所以原文一律不落日志。
    const api = getElectronAPI()
    api?.log({
      level: 'ERROR',
      module: 'RendererCrash',
      message: err.message,
      data: { stack: err.stack, componentStack: info.componentStack },
    })?.catch(() => {
      // 日志送出去不能再抛：那会被全局 unhandledrejection 接住，于是又发一次注定失败的 IPC
    })
  }

  private copyDetails = async () => {
    const text = buildDetails(this.state.message, this.state.stack)
    try {
      await navigator.clipboard.writeText(text)
      this.setState({ notice: '已复制，可以直接贴进邮件' })
    } catch {
      this.setState({ notice: '复制没成功，可以手动选中下面这段文字' })
    }
  }

  private openLogs = async () => {
    const api = getElectronAPI()
    if (!api) {
      this.setState({ notice: '当前环境拿不到日志目录，请手动打开应用的数据文件夹' })
      return
    }
    try {
      const result = await api.openLogDirectory()
      this.setState({
        notice: result.success ? '已打开日志文件夹，请把 app.log 一并发给开发者' : `打开失败：${result.error || '未知原因'}`,
      })
    } catch {
      this.setState({ notice: '打开日志文件夹失败' })
    }
  }

  render() {
    if (!this.state.message) return this.props.children

    const details = buildDetails(this.state.message, this.state.stack)

    return (
      <div className="crash-card">
        <div className="crash-card__inner">
          <div className="crash-card__head">
            <TriangleAlert size={20} className="crash-card__icon" />
            <h1 className="crash-card__title">界面遇到了意料之外的错误</h1>
          </div>
          <p className="crash-card__lead">
            应用还在运行，这一页只是界面坏了。重新加载会丢掉这次还没导出的结果；
            如果这份结果很重要，请先按下面的方式把日志留下，再决定要不要重载。
          </p>
          <p className="crash-card__message">{this.state.message}</p>

          <div className="crash-card__actions">
            <button type="button" className="crash-card__btn" onClick={() => void this.copyDetails()}>
              <Copy size={14} />
              <span>复制详情</span>
            </button>
            <button type="button" className="crash-card__btn" onClick={() => void this.openLogs()}>
              <FolderOpen size={14} />
              <span>打开日志文件夹</span>
            </button>
            <button
              type="button"
              className="crash-card__btn crash-card__btn--primary"
              onClick={() => window.location.reload()}
            >
              <RotateCcw size={14} />
              <span>重新加载</span>
            </button>
          </div>

          {this.state.notice && <p className="crash-card__notice">{this.state.notice}</p>}

          <details className="crash-card__details">
            <summary>错误详情</summary>
            <pre>{details}</pre>
          </details>
        </div>
      </div>
    )
  }
}
