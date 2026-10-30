/**
 * 按需组件（本地配音引擎与模型）的 IPC 处理器
 *
 * 通道形状照 ytDlp:*：list/check 是拉取式，install 是唯一需要把进度推回来的
 * （129MB 的模型在慢网里要跑几分钟，只有按钮在转圈等于界面坏了）。
 * 统一口径由 guard.ts 落成机制：每条通道在这里声明自己失败回什么，抛出去的东西
 * 一律变成「渲染层能直接弹的一句」。
 *
 * 组件 id 由渲染层传上来，但白名单在主进程 services/componentService.ts 里：
 * 未知 id 会被拒绝，落点也只可能是那份白名单写死的几个目录。
 */
import {
  cancelInstall,
  checkComponents,
  installComponent,
  listComponents,
  removeComponent,
  type ComponentProgress,
  type ComponentState,
} from '../services/componentService'
import { hasActiveTTSSynthesis } from '../services/ttsService'
import { isLocalTtsEngineRunning } from '../services/localTtsEngine'
import { logger } from '../services/logger'
import { failOkError, ipcHandle } from './guard'

/** 进度推送通道名，preload 与渲染层按这个订阅 */
const PROGRESS_CHANNEL = 'component:progress'

/**
 * 磁盘上这一份读不出来的时候不能只回 `[]`：那一行的界面会写成「还没装」，
 * 而真实情况可能是目录权限坏了。所以这条通道自己带一个 error 槽，
 * 界面才能把「读不出来」和「没装」分成两句话说。
 */
export interface ComponentListResult {
  components: ComponentState[]
  error: string | null
}

export function registerComponentHandlers() {
  /** 磁盘在场情况与占用体积，不联网：打开「关于与更新」就读这一份 */
  ipcHandle(
    'component:list',
    async (): Promise<ComponentListResult> => ({ components: await listComponents(), error: null }),
    (message) => ({ components: [], error: message })
  )

  /** 读组件清单对版本。国内直连时这一下可能要十几秒，界面上得有「检查中...」 */
  // checkComponents 自己已经把「清单读不通」回成 { ok:false, error }，外层这道只兜它没料到的
  // （比如读磁盘那一步整个抛了），失败形状与它内部保持一致
  ipcHandle('component:check', () => checkComponents(), (message) => ({
    ok: false,
    error: message,
    components: [],
  }))

  /**
   * 下载并装上一个组件。id 之外的东西全在主进程决定：清单从哪读、落到哪、要不要解压。
   * 同一个组件重复发起会复用前一份任务并接上同一条进度流，所以连点不会产生两条下载。
   */
  ipcHandle(
    'component:install',
    async (event, id: unknown) => {
      if (typeof id !== 'string') return { ok: false, error: '组件 id 必须是字符串' }
      const onProgress = (p: ComponentProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send(PROGRESS_CHANNEL, p)
      }
      logger.userAction('Component install requested', { id })
      return installComponent(id, onProgress)
    },
    failOkError
  )

  ipcHandle(
    'component:cancel',
    (_event, id: unknown) => {
      if (typeof id !== 'string') return { ok: false, error: '组件 id 必须是字符串' }
      if (!cancelInstall(id)) return { ok: false, error: '这个组件现在没有在下载' }
      logger.userAction('Component install canceled', { id })
      return { ok: true, error: null }
    },
    failOkError
  )

  ipcHandle(
    'component:remove',
    (_event, id: unknown) => {
      if (typeof id !== 'string') return { ok: false, error: '组件 id 必须是字符串' }
      logger.userAction('Component removal requested', { id })
      return removeComponent(id)
    },
    failOkError
  )

  /**
   * 这几个文件现在能不能动。两种占用分开报：引擎进程还活着有「停止」按钮可点，
   * 一批正在逐段合成则只能等或去配音页取消——在这里停引擎会让剩下的段落全失败。
   * 两个读的都是主进程内存里的状态，本身炸不了；万一炸了回「没在跑」是安全的一侧，
   * 因为后面真要动文件时 install/remove 各自还有一道 busy 判定兜着。
   */
  ipcHandle(
    'component:busy',
    () => ({
      engineRunning: isLocalTtsEngineRunning(),
      synthesizing: hasActiveTTSSynthesis(),
    }),
    () => ({ engineRunning: false, synthesizing: false })
  )
}

