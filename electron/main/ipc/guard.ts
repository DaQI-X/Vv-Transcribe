/**
 * IPC 的统一收口（#280）
 *
 * 「不跨 IPC 抛错」这句口径以前只写在 ttsHandlers.ts 和 componentHandlers.ts 的注释里，
 * 而收口前的 59 条 ipcMain.handle 里有 40 条函数体连一个 try 都搜不到（有的带 try，却把
 * `await getAIConfig()` 那一句留在 try 外面）。抛出去的就是一个 reject：渲染层没接住的地方
 * 表现为「点了按钮什么都没发生」，接住了的地方只能拿到一句 Node 的原始报错。
 *
 * 这一层把口径变成机制：注册通道只能走 ipcHandle，而且**必须**声明失败回什么值。
 * 为什么强制声明而不给一个通用形状——因为各条通道的既有契约本来就不一样，
 * 统一成 `{ error }` 会把界面已有的判断重写一遍，更糟的是它会把
 * 「已经写好的那句人话」换成一句泛泛的失败。所以：
 * - 成功形状里有 error 槽位的（`{ ok, error }` / `{ success, error }` / `{ error }`），
 *   失败就填那个槽位，调用点一个字都不用改；
 * - 只回裸值的（数组、布尔、字符串、void），由调用点当场写一份「这次失败长什么样」。
 *   这里刻意不给默认值：默认值会让人顺手写个 `[]`，而 `[]` 在按需组件那一行显示的是
 *   「没装」——那是句谎，不是个兜底。
 *
 * 日志只带通道名和原因，**绝不带入参**：file:saveText 的入参是用户的整份文稿，
 * asr:start 的是文件路径，这些都不该出现在一份会被用户发回来的 app.log 里。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { logger } from '../services/logger'

const TAG = 'IPC'

/**
 * 一条通道失败时该回什么。拿到原因和原始入参，因为有些通道的失败形状必须带着成功形状的同名信息
 * （ai:correct 要回原文、ai:explainDifferences 与 proofread:explain 要按 differences 的条数
 * 回一份等长的「解释失败」清单——界面按下标取用，条数少了就静默少一句解释）。
 * 允许返回 Promise，构建失败值时还要读一次磁盘的通道（settings:save）靠它，await 收在下面。
 */
export type FailValue<Args extends unknown[] = unknown[]> = (
  message: string,
  event: IpcMainInvokeEvent,
  ...args: Args
) => unknown

/** 跨 IPC 只带这一句：Error.message 优先，非 Error 的抛出物原样转字符串 */
function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  const text = String(err)
  return text && text !== '[object Object]' ? text : '操作失败'
}

/** 已有 `{ ok, error }` 形状的通道用这一份 */
export const failOkError: FailValue = (message) => ({ ok: false, error: message })

/** 已有 `{ success, error }` 形状的通道用这一份 */
export const failSuccessError: FailValue = (message) => ({ success: false, error: message })

/** 已有 `{ error }`（不带 ok 判位）形状的通道用这一份 */
export const failErrorOnly: FailValue = (message) => ({ error: message })

/**
 * 注册一条通道：任何抛出（同步抛的、Promise reject 的）都收在这里，
 * 变成一次 logger.error 加一个 fail() 造出来的值。
 */
export function ipcHandle<Args extends unknown[]>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown | Promise<unknown>,
  // NoInfer 是必需的：Args 只能由 handler 那一头推。写成裸 FailValue<Args> 时，
  // 那个不接参数的 `() => null` 会把 Args 推成 []，于是每个「handler 比 fail 多几个参数」的
  // 通道都报一句「Target signature provides too few arguments」——全是假错
  fail: NoInfer<FailValue<Args>>
): void {
  ipcMain.handle(channel, async (event, ...raw) => {
    const args = raw as Args
    try {
      // await 写在 try 里，所以 handler 同步抛（参数一进来就炸）一样收得住
      return await handler(event, ...args)
    } catch (err) {
      const message = toMessage(err)
      // 只记「哪条通道、为什么」：栈里可能带着组件 props 的片段，而入参本身就是用户文稿
      logger.error(TAG, `${channel} did not complete`, { channel, message })
      try {
        // await 在这里是必需的：失败值也可能是异步的（settings:save 那份要再读一次设置视图），
        // 写成 `return fail(...)` 时它的 reject 会绕过下面这个 catch，等于把这一层要消灭的东西留着
        return await fail(message, event, ...args)
      } catch (failErr) {
        // 兜底代码不许成为新的崩溃源：连失败形状都造不出来时回一句能弹的话，
        // 而不是让这次 invoke 变回 reject（那正好是这一层要消灭的东西）
        logger.error(TAG, `${channel} could not build its failure value`, {
          channel,
          message: toMessage(failErr),
        })
        return { error: message }
      }
    }
  })
}
