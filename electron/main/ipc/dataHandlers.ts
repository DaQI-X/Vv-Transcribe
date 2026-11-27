/**
 * 「本机数据与缓存」（#416）的 IPC 处理器
 *
 * 两条通道都是拉取式，没有进度推送：这一层动的全是本地文件，最慢的一条是几百 MB 的权重
 * 目录递归删除，也就一两秒，不像组件下载那样需要一根走动的进度条。
 *
 * 白名单不在这里：`localDataAudit` 里那份 SPECS 同时决定「列得出来」和「删得掉」，
 * 渲染层传上来的 id 只要不在那份表里，整批直接拒绝。所以这里不需要再判一次路径，
 * 也不许在这里拼目录——一旦在这儿发明落点，界面就有了第二条能删到别处的路。
 */
import { auditLocalData, clearLocalData, type LocalDataAudit, type LocalDataClearResult } from '../services/localDataAudit'
import { logger } from '../services/logger'
import { ipcHandle } from './guard'

/** 失败时这一栏要回的形状：`items: []` 会让界面写成「什么都没占」，所以必须带上 error 让界面改口 */
const emptyAudit = (message: string): LocalDataAudit => ({
  items: [],
  cacheBytes: 0,
  totalBytes: 0,
  error: message,
})

const failedClear = (message: string): LocalDataClearResult => ({
  ok: false,
  freed: 0,
  cleared: [],
  failed: [],
  note: null,
  error: message,
})

export function registerDataHandlers() {
  /** 逐项体积与默认勾选项。只读磁盘，不联网 */
  ipcHandle('data:inventory', () => auditLocalData(), emptyAudit)

  /**
   * 按勾选清理。入参必须是字符串数组——渲染层传什么形状本来是它自己的事，
   * 但这一条通道的参数直接决定删哪些目录，所以在这里挡一道：非数组一律当作「没勾」拒掉，
   * 免得 `ids.includes` 那一句炸出个 Node 原话给用户。
   */
  ipcHandle(
    'data:clear',
    (_event, ids: unknown) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        return failedClear('清理项必须是一组 id')
      }
      logger.userAction('Local data clear requested', { count: ids.length })
      return clearLocalData(ids as string[])
    },
    (_message) => failedClear('清理没能完成')
  )
}
