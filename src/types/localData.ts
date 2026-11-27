/**
 * 「本机数据与缓存」（#416）的前端数据结构
 * 与 electron/preload/index.d.ts 的同名类型对齐：跨 IPC 的边界只有这一份声明。
 * 清单、说明、默认勾选项全都由主进程那份 SPECS 带来——界面不自己拼目录，也不自己决定删谁。
 */

/** cache=清掉只是重新生成，component=要重新下载，personal=删了找不回来。弹窗按这一位分段 */
export type LocalDataGroup = 'cache' | 'component' | 'personal'

export interface LocalDataItem {
  id: string
  group: LocalDataGroup
  label: string
  /** 一句「这是什么、删了会怎样」，主进程写的，界面直接印 */
  detail: string
  defaultOn: boolean
  bytes: number
  /** 段数/文件数；这一项整个读不出来时为 null */
  files: number | null
  /** 体积读不出来时给的原因；非空时那个 0 不许被读成「没占地方」 */
  error: string | null
}

export interface LocalDataAudit {
  items: LocalDataItem[]
  /** 默认勾上的那几项合计 */
  cacheBytes: number
  totalBytes: number
  error: string | null
}

export interface LocalDataClearResult {
  ok: boolean
  freed: number
  cleared: string[]
  /** 没能清掉的，带原话；界面逐条念 */
  failed: { id: string; error: string }[]
  /** 不算故障、但用户应当知道的那一句（例如「共享缓存里还有别家模型的权重，没动」） */
  note: string | null
  error: string | null
}
