/**
 * 设置 → 关于与更新里的「本机数据与缓存」栏（#416）
 *
 * 这一栏替掉原先并排的两格：「本机数据」只有一颗「打开数据目录」，「配音片段缓存」只能清一样东西。
 * 卸载残留那次实测（#415）说明「自己去访达里挑」对普通用户等于没有——几百 MB 的权重和 461MB 的
 * 共享 blob 就留在 home 目录里，而没人知道自己留了。
 *
 * 为什么不是一个「一键清空」按钮：那会顺手删掉 API Key 和历史记录，而这两样找不回来。
 * 所以这里把主进程 `localDataAudit.ts` 那份 SPECS 摊成可勾选的清单，默认只勾纯派生物
 * （片段缓存、临时媒体、日志、词库更新副本），组件与个人数据必须自己勾上才会被动。
 * 弹窗本身就是那一次「点击前确认」，不再叠一层。
 *
 * 界面不自己拼目录、不自己决定删谁：id、名字、说明、默认勾选项全从主进程来，
 * 未知 id 传到主进程会被整批拒绝。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, FolderOpen, TriangleAlert, X } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import type { LocalDataAudit, LocalDataClearResult, LocalDataGroup, LocalDataItem } from '@/types/localData'
import { formatBytes } from '@/utils/formatBytes'
import { openUserDataDirectory } from '@/utils/userData'

/** 三段的小标题就是「删了会怎样」，顺序按主进程 SPECS 里的 group */
const GROUP_TITLES: Record<LocalDataGroup, string> = {
  cache: '可以直接清，下次用到会自己长回来',
  component: '删了要重新下载',
  personal: '删了找不回来',
}

const GROUP_ORDER: LocalDataGroup[] = ['cache', 'component', 'personal']

/**
 * `files` 这一列在不同项里数的是不同东西（片段数／组件行数／文件数），所以只念一个通用的「项」，
 * 不替主进程猜单位。读体积那一步失败时（`error` 非空）那个 0 不是「没占地方」，得单独说。
 */
function sizeText(item: LocalDataItem): string {
  if (item.error) return '体积读不出来'
  return `${formatBytes(item.bytes)}${item.files ? ` · ${item.files} 项` : ''}`
}

export function LocalDataSection({ onCleared }: { onCleared?: () => void }) {
  const api = getElectronAPI()
  const [audit, setAudit] = useState<LocalDataAudit | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [opening, setOpening] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** 清完之后的逐条结果；非空时弹窗从「勾选」切到「播报」 */
  const [result, setResult] = useState<LocalDataClearResult | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const close = useCallback(() => {
    setAudit(null)
    setPicked([])
    setResult(null)
  }, [])

  // 只有真要打开弹窗时才走这一次磁盘遍历：设置页每次展开都统计一遍毫无意义
  const open = useCallback(async () => {
    if (!api || opening) return
    setOpening(true)
    try {
      const next = await api.getLocalDataInventory()
      if (!mounted.current) return
      if (next.items.length === 0) {
        toast.error(`本机数据清单读不出来：${next.error || '未知原因'}`, 10000)
        return
      }
      setAudit(next)
      setPicked(next.items.filter((item) => item.defaultOn).map((item) => item.id))
    } catch (err) {
      toast.error(`本机数据清单读不出来：${err instanceof Error ? err.message : String(err)}`, 10000)
    } finally {
      if (mounted.current) setOpening(false)
    }
  }, [api, opening])

  const toggle = (id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const clear = useCallback(async () => {
    if (!api || clearing || picked.length === 0) return
    setClearing(true)
    try {
      const out = await api.clearLocalData(picked)
      if (!mounted.current) return
      // 整批被拒（未知 id／一个没勾）时没有逐条结果可念，只弹原因，弹窗留着让人重勾
      if (out.error) {
        toast.error(out.error, 10000)
        return
      }
      setResult(out)
      // 组件那一项删完，上面「按需组件」那栏还是旧状态——不重读就等于在报「已安装」的谎
      onCleared?.()
      if (out.ok) {
        toast.success(`已释放 ${formatBytes(out.freed)}`, 6000)
      } else {
        toast.error(`${out.failed.length} 项没能清掉，原因列在弹窗里`, 10000)
      }
    } catch (err) {
      toast.error(`清理失败：${err instanceof Error ? err.message : String(err)}`, 10000)
    } finally {
      if (mounted.current) setClearing(false)
    }
  }, [api, clearing, onCleared, picked])

  useEffect(() => {
    if (!audit) return
    const onKey = (event: KeyboardEvent) => {
      // 删除正在跑的时候 Esc 不许关：关掉之后用户只看见 toast，看不见那几条失败原因
      if (event.key === 'Escape' && !clearing) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [audit, clearing, close])

  const labelOf = useCallback(
    (id: string) => audit?.items.find((item) => item.id === id)?.label ?? id,
    [audit],
  )
  const pickedBytes = (audit?.items ?? [])
    .filter((item) => picked.includes(item.id))
    .reduce((sum, item) => sum + item.bytes, 0)

  return (
    <div className="settings-form-group">
      <label className="settings-form-label">本机数据与缓存</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void openUserDataDirectory()}
          className="settings-modal__dict-update-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <FolderOpen size={12} />
          打开数据目录
        </button>
        <button
          type="button"
          onClick={() => void open()}
          disabled={opening}
          className="settings-modal__dict-update-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Eraser size={12} />
          {opening ? '统计中...' : '清空本机数据…'}
        </button>
      </div>
      <span className="settings-form-hint">
        这里列的是应用在这台电脑上留下的东西：日志、片段缓存、临时媒体，以及按需下载的组件、
        历史记录和设置（含 API Key）。点开看每一项占多少、勾哪些删哪些——
        默认只勾那些删了会自己长回来的派生物。设置没能解析时，原件会以
        settings.json.corrupt-时间戳 的名字留在同一层，可以从那份文件里找回
      </span>

      {audit &&
        createPortal(
          // 挡住外层遮罩的点击（与 ProfileDialog 同一理由）：不拦一下，点在这个弹窗外面
          // 会把整个设置窗口关掉，用户刚勾好的那几项跟着一起没
          <div className="settings-overlay" onClick={(e) => e.stopPropagation()}>
            <div
              className="settings-modal vv-localdata-dialog"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="settings-modal__header">
                <span className="settings-modal__title">清空本机数据与缓存</span>
                <button
                  className="settings-modal__close"
                  onClick={close}
                  title="关闭"
                  disabled={clearing}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="settings-modal__body">
                {audit.error && (
                  <span className="vv-localdata-note vv-localdata-note--warn">
                    <TriangleAlert size={12} />
                    有些项的体积没读出来：{audit.error}
                  </span>
                )}

                {GROUP_ORDER.map((group) => {
                  const rows = audit.items.filter((item) => item.group === group)
                  if (rows.length === 0) return null
                  return (
                    <div key={group} className="vv-localdata-group">
                      <div className="vv-localdata-group__title">{GROUP_TITLES[group]}</div>
                      {rows.map((item) => (
                        <label className="vv-localdata-item" key={item.id}>
                          <input
                            type="checkbox"
                            checked={picked.includes(item.id)}
                            disabled={clearing}
                            onChange={() => toggle(item.id)}
                          />
                          <span className="vv-localdata-item__main">
                            <span className="vv-localdata-item__head">
                              <span className="vv-localdata-item__label">{item.label}</span>
                              <span className="vv-localdata-item__size">{sizeText(item)}</span>
                            </span>
                            <span className="vv-localdata-item__detail">{item.detail}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )
                })}

                {result && (
                  <div className="vv-localdata-result">
                    <div className="vv-localdata-result__freed">
                      {result.freed > 0
                        ? `已释放 ${formatBytes(result.freed)}`
                        : '没有腾出空间（勾的那些项本来就没什么占用）'}
                    </div>
                    {result.cleared.length > 0 && (
                      <div className="vv-localdata-result__line">
                        清掉了：{result.cleared.map(labelOf).join('、')}
                      </div>
                    )}
                    {result.failed.map((row) => (
                      <div className="vv-localdata-result__line vv-localdata-result__line--fail" key={row.id}>
                        <TriangleAlert size={12} />
                        {labelOf(row.id)}：{row.error}
                      </div>
                    ))}
                    {result.note && <div className="vv-localdata-result__line">{result.note}</div>}
                  </div>
                )}
              </div>

              <div className="settings-modal__footer">
                {!result && (
                  <span className="settings-form-hint" style={{ marginRight: 'auto' }}>
                    已选 {picked.length} 项，约 {formatBytes(pickedBytes)}
                  </span>
                )}
                <button
                  type="button"
                  className="settings-modal__cancel-btn"
                  onClick={close}
                  disabled={clearing}
                >
                  {result ? '关闭' : '取消'}
                </button>
                {result ? null : (
                  <button
                    type="button"
                    className="vv-localdata-confirm"
                    onClick={() => void clear()}
                    disabled={clearing || picked.length === 0}
                  >
                    {clearing ? '清理中...' : `清空选中的 ${picked.length} 项`}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
