/**
 * 按需组件（本地配音引擎与模型）的 IPC 处理器
 *
 * 通道形状照 ytDlp:*：list/check 是拉取式，install 是唯一需要把进度推回来的
 * （129MB 的模型在慢网里要跑几分钟，只有按钮在转圈等于界面坏了）。
 * 统一口径：不跨 IPC 抛错，失败一律走 { error } 让渲染层弹 toast。
 *
 * 组件 id 由渲染层传上来，但白名单在主进程 services/componentService.ts 里：
 * 未知 id 会被拒绝，落点也只可能是那份白名单写死的几个目录。
 */
import { ipcMain } from 'electron'
import {
  cancelInstall,
  checkComponents,
  installComponent,
  listComponents,
  removeComponent,
  type ComponentProgress,
} from '../services/componentService'
import { hasActiveTTSSynthesis } from '../services/ttsService'
import { isLocalTtsEngineRunning } from '../services/localTtsEngine'
import { logger } from '../services/logger'

/** 进度推送通道名，preload 与渲染层按这个订阅 */
const PROGRESS_CHANNEL = 'component:progress'

export function registerComponentHandlers() {
  /** 磁盘在场情况与占用体积，不联网：打开「关于与更新」就读这一份 */
  ipcMain.handle('component:list', () => listComponents())

  /** 读组件清单对版本。国内直连时这一下可能要十几秒，界面上得有「检查中...」 */
  ipcMain.handle('component:check', () => checkComponents())

  /**
   * 下载并装上一个组件。id 之外的东西全在主进程决定：清单从哪读、落到哪、要不要解压。
   * 同一个组件重复发起会复用前一份任务并接上同一条进度流，所以连点不会产生两条下载。
   */
  ipcMain.handle('component:install', async (event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: '组件 id 必须是字符串' }
    const onProgress = (p: ComponentProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send(PROGRESS_CHANNEL, p)
    }
    logger.userAction('Component install requested', { id })
    return installComponent(id, onProgress)
  })

  ipcMain.handle('component:cancel', (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: '组件 id 必须是字符串' }
    if (!cancelInstall(id)) return { ok: false, error: '这个组件现在没有在下载' }
    logger.userAction('Component install canceled', { id })
    return { ok: true, error: null }
  })

  ipcMain.handle('component:remove', (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: '组件 id 必须是字符串' }
    logger.userAction('Component removal requested', { id })
    return removeComponent(id)
  })

  /**
   * 这几个文件现在能不能动。两种占用分开报：引擎进程还活着有「停止」按钮可点，
   * 一批正在逐段合成则只能等或去配音页取消——在这里停引擎会让剩下的段落全失败。
   */
  ipcMain.handle('component:busy', () => ({
    engineRunning: isLocalTtsEngineRunning(),
    synthesizing: hasActiveTTSSynthesis(),
  }))
}
