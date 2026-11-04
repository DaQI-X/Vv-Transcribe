/**
 * 历史记录（#247）的 IPC 处理器
 *
 * 这一层守的是一条边界：界面向记录要 **id**，拿不到路径。
 * `HistoryRecord.source`（产物的原件位置）和 records/keep/<id>/ 的绝对位置都只在主进程用——
 * #281 把日志里的整条路径收成文件名，跨 IPC 也一样收成：渲染层一旦拿到路径就会开始拼自己的
 * 写盘位置，那份账本从此押在两个进程各猜一遍的路径上。「在文件夹里显示」是唯一动到文件管理器的
 * 一条，路径也由主进程自己解出来，回给界面的只有成没成、为什么没成。
 *
 * 唯一从渲染层进来的大字段是「留住稿子」那一份正文：记账那一刻它从没在盘上待过，
 * 这正是「全文按需」这句承诺的全部内容。它只在用户点那一颗勾时过桥一次，落进
 * records/keep/<id>/draft.txt；日志里只留字符数（guard.ts 从不记录入参，这里也不加一句额外）。
 */
import { shell } from 'electron'
import {
  deleteHistoryRecord,
  dropHistoryCopies,
  keepHistory,
  listHistory,
  resolveHistoryKeptFile,
  type HistoryResult,
} from '../services/historyService'
import { logger } from '../services/logger'
import { failOkError, ipcHandle } from './guard'

/**
 * 界面传来的 id 必须是一串非空文本。不是这个形状就是调用点写错了——别拿 undefined 去账本里
 * findIndex，那匹配不出东西，只会回一句「这条记录已经不在了」，把一句编程错误说成用户的错。
 */
function idOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

const BAD_ID: HistoryResult = { ok: false, error: '记录 id 必须是字符串' }

/** history:reveal 的形状跟 app:openLogDirectory 那几条一致（success 而不是 ok），失败值也照那个形状造 */
const failReveal = (message: string) => ({ success: false, error: message })

export function registerHistoryHandlers() {
  /**
   * 列表。失败值里 items 必须是 null 而不是 []：`[]` 在界面上写的是「你还没跑过作业」，
   * 而真实情况可能是这本账读不动——#277 那个「用户还没填 Key」的坑换个门面就会重长一次。
   */
  ipcHandle('history:list', () => listHistory(), (message) => ({ items: null, error: message }))

  /**
   * 那一颗「留住」：产物（主进程记着原件在哪）与稿子（这一刻从渲染层交来的正文）一起留。
   * 第二个参数只有配音/转写那一类才给；没给或不是字符串就当「只留产物」。
   */
  ipcHandle(
    'history:keep',
    (_event, id: unknown, draftText: unknown): Promise<HistoryResult> =>
      idOf(id) === ''
        ? Promise.resolve(BAD_ID)
        : keepHistory(idOf(id), typeof draftText === 'string' ? draftText : undefined),
    failOkError
  )

  /** 反悔：只删那几份副本，记录本身留着（用户是不想再留了，不是要抹掉这笔账） */
  ipcHandle(
    'history:dropCopies',
    (_event, id: unknown): Promise<HistoryResult> =>
      idOf(id) === '' ? Promise.resolve(BAD_ID) : dropHistoryCopies(idOf(id)),
    failOkError
  )

  /** 删掉一条记录，连它留住的东西一起没——这是用户能把自己的痕迹抹干净的唯一入口 */
  ipcHandle(
    'history:delete',
    (_event, id: unknown): Promise<HistoryResult> =>
      idOf(id) === '' ? Promise.resolve(BAD_ID) : deleteHistoryRecord(idOf(id)),
    failOkError
  )

  /**
   * 在文件管理器里选中那一份留住的副本。路径在这主进程里解出来，一个字都不回给界面。
   * `shell.showItemInFolder` 的签名是 void——它不给回执，所以这里的 success 只代表
   * 「这一条确实有留住的副本、它此刻还在盘上」，不代表文件夹一定弹出来了。
   * 那一步之所以要做：用户勾「留住」时我们承诺的是「这份东西归你了」，
   * 只把 <uuid> 目录藏进 userData 深处等于没承诺——`app:openUserDataDirectory` 要他自己认出那一串 id。
   */
  ipcHandle('history:reveal', async (_event, id: unknown) => {
    const recordId = idOf(id)
    if (recordId === '') return { success: false, error: '记录 id 必须是字符串' }
    const { path, error } = await resolveHistoryKeptFile(recordId)
    if (!path) return { success: false, error: error ?? '这一条没有可以显示的副本' }
    // 日志里只落文件名：整条路径进 app.log 会被用户原样发回来，而 records/keep 底下是稿子正文
    logger.userAction('History copy revealed', { name: path.split(/[\\/]/).pop() })
    shell.showItemInFolder(path)
    return { success: true, error: null }
  }, failReveal)
}
