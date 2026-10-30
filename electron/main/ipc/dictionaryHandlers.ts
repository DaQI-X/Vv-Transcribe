/**
 * 词典服务 IPC 处理器
 * 提供词典查询（单词/批量）、版本检查、更新下载等功能
 * 应用启动时自动初始化词典缓存
 *
 * 两条 lookup 现在没有界面调用点（释义是本地校对在主进程里直接查的），但通道仍对渲染层开着，
 * 所以失败值也要能和「词库里没有这个词」分开——回 `{ found: false }` 听起来像查过了。
 * 收口统一走 guard.ts：日志只落通道名和原因，查询词本身不进日志。
 */
import {
  lookupWord,
  lookupMultipleWords,
  initDictionary,
  checkForUpdate,
  downloadUpdate,
  getCurrentVersion,
} from '../services/dictionaryService'
import { logger } from '../services/logger'
import { failSuccessError, ipcHandle } from './guard'

export function registerDictionaryHandlers() {
  initDictionary().catch((err) => {
    logger.error('Dictionary', 'startup init failed', { message: err instanceof Error ? err.message : String(err) })
  })

  ipcHandle(
    'dictionary:lookup',
    (_event, word: string) => lookupWord(word),
    (message) => ({ found: false, error: message })
  )

  ipcHandle(
    'dictionary:lookupMultiple',
    (_event, words: string[]) => lookupMultipleWords(words),
    // 这一条回的是「表 + 一个 error 键」：词库正好有个词条叫 error 时会混。
    // 这两条 lookup 现在没有界面调用点（释义由主进程本地校对直接查），所以不为此改成信封
    (message) => ({ error: message })
  )

  // 这句必须能被界面拿到：checkForUpdate 内部已经把「连不上词库源」回成 error，
  // 外层这道只兜它没料到的（读版本文件那步整个抛了），形状与它保持一致
  ipcHandle(
    'dictionary:checkUpdate',
    () => checkForUpdate(),
    (message) => ({ hasUpdate: false, currentVersion: '', error: message })
  )

  ipcHandle('dictionary:downloadUpdate', () => downloadUpdate(), failSuccessError)

  // 读的是主进程模块里已经握着的那个字符串，本身炸不了；回空串时界面显示的是「未加载」
  ipcHandle('dictionary:getVersion', () => getCurrentVersion(), () => '')
}
