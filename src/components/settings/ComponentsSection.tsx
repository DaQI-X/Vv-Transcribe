/**
 * 设置 → 关于与更新里的「按需组件」栏
 *
 * 装的是本地配音的引擎二进制与两份模型。它们不进安装包（合计 500MB 以上，
 * 而大部分用户根本不用本地配音），所以这一栏存在的意义就是把「缺了怎么补上」这件事
 * 放在用户已经知道的地方——和「链接解析组件」并排，不再新开一个 Tab。
 *
 * 三条口径跟着主进程走，界面自己不发明：
 * - 组件名、说明、能装哪些，全在 services/componentService.ts 的 SPECS 白名单里；
 *   界面只印 id/title/hint，未知 id 到不了主进程。
 * - 版本与体积谁说了算看来源：钉了上游指纹的模型不读清单，打开这一栏就答得出「未安装，下载约 135.5MB」；
 *   引擎那一条要等用户点「检查清单」才有远端版本，没查过时那两位是 null，界面就说「还没和清单对过」，
 *   不拿 0 冒充已知。体积数字只有一处算法（主进程按表内字节数报，界面走 utils/formatBytes.ts），
 *   所以组件行和提示语不会出现「129MB」与「135.5MB」并排这种同一份东西两个数。
 * - 下载体积的分母可能是 0（清单没写 bytes），这时只显示已下载的字节数，不给假百分比。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, Square, Trash2 } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import type { ComponentPhase, ComponentProgress, ComponentResult, ComponentState } from '@/types/component'
import { formatBytes } from '@/utils/formatBytes'

/** 阶段名按主进程真正在做的事分三种说；「下载中 30%」套在解压上是骗人 */
const PHASE_LABEL: Record<ComponentPhase, string> = {
  download: '下载中',
  extract: '解压中',
  verify: '校验中',
}

const ACTION_LABEL: Record<ComponentState['action'], string> = {
  install: '下载',
  update: '更新',
  repair: '重新下载',
  none: '',
}

/**
 * 一行状态：已装的说版本和占用，没装的说要多大；清单取不到下载包时不能给「可下载」的错觉。
 * inManifest=false 有三种成因——清单里没本机这个平台、这一版压根没给这个组件钉来源、
 * 以及清单那两个入口都答 404（这一版没发布清单）。界面拿到的是同一个布尔，分不开三者，
 * 所以文案只说三者共同成立的那一半：现在拿不到包。
 */
function describe(s: ComponentState): string {
  if (!s.installed) {
    return s.inManifest === false
      ? '这个版本没有发布对应的下载包'
      : s.remoteBytes !== null
        ? `未安装，下载约 ${formatBytes(s.remoteBytes)}`
        : '未安装'
  }
  const size = `占用 ${formatBytes(s.bytes)}`
  if (s.localVersion === null) return `已在组件目录里（无版本记录），${size}`
  if (s.inManifest === null) return `v${s.localVersion}，${size}（还没和清单对过）`
  if (s.inManifest === false) return `v${s.localVersion}，${size}（清单里没有它的下载包）`
  return s.action === 'none'
    ? `v${s.localVersion}，${size}，已是本版可用的最新`
    : `v${s.localVersion}，${size}；本版认的是 v${s.remoteVersion}`
}

export function ComponentsSection() {
  const [states, setStates] = useState<ComponentState[] | null>(null)
  /** 磁盘那一份读不出来时给的原因；不能只留 null，否则这一栏会一直「读取中...」而没人知道为什么 */
  const [listError, setListError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  /** id → 在跑的阶段进度；不在这里就说明没在下载 */
  const [progress, setProgress] = useState<Record<string, ComponentProgress>>({})
  /** 正在等结果的组件，按动作记，避免下载/删除按钮在 await 期间还能再点一次 */
  const [pending, setPending] = useState<Record<string, 'install' | 'remove' | 'cancel'>>({})
  const [busy, setBusy] = useState<{ engineRunning: boolean; synthesizing: boolean } | null>(null)
  const [stopping, setStopping] = useState(false)
  const api = getElectronAPI()
  /** 卸载时进度流要能退订，否则设置窗关了事件还在往已销毁的组件上 setState */
  const mounted = useRef(true)

  const applyState = useCallback((next: ComponentState | undefined) => {
    if (!next) return
    setStates((prev) => (prev ? prev.map((s) => (s.id === next.id ? next : s)) : prev))
  }, [])

  const refresh = useCallback(async () => {
    if (!api) return
    const [snapshot, busyNow] = await Promise.all([api.listComponents(), api.getComponentBusy()])
    if (!mounted.current) return
    setListError(snapshot.error)
    // 读失败时不回那一份 []：表格里「一个组件都没有」和「磁盘读不出来」是两句话，
    // 后者只有顶部那一行加 toast 能说清
    if (snapshot.error === null) setStates(snapshot.components)
    else toast.error(`按需组件状态读不出来：${snapshot.error}`, 10000)
    setBusy(busyNow)
  }, [api])

  useEffect(() => {
    mounted.current = true
    if (!api) return
    void refresh()
    const unsubscribe = api.onComponentProgress?.((p) => {
      if (mounted.current) setProgress((prev) => ({ ...prev, [p.id]: p }))
    })
    return () => {
      mounted.current = false
      unsubscribe?.()
    }
  }, [api, refresh])

  /** 失败一律走 toast；看着像系统拦住了写入/执行时，顺手给一个能点的「打开隐私设置」 */
  const reportFailure = useCallback((result: ComponentResult) => {
    const message = result.error || '操作失败'
    if (result.systemSettingsHint) {
      toast.error(
        message,
        10000,
        api ? { label: '打开隐私设置', onClick: () => void api.openSystemSettings() } : undefined
      )
    } else {
      toast.error(message, 10000)
    }
  }, [api])

  const setTaskPending = (id: string, kind: 'install' | 'remove' | 'cancel' | null) => {
    setPending((prev) => {
      const next = { ...prev }
      if (kind) next[id] = kind
      else delete next[id]
      return next
    })
  }

  const handleCheck = async () => {
    if (!api || checking) return
    setChecking(true)
    try {
      const result = await api.checkComponents()
      if (!mounted.current) return
      // 清单那一步整个炸了时 components 是空的，不能拿它覆盖已经读到的那一份磁盘状态
      if (result.ok || result.components.length > 0) setStates(result.components)
      if (!result.ok) {
        // 清单读不通时组件列表仍是有用的那一份，所以只报原因，不假装磁盘也坏了
        toast.error(`检查清单失败：${result.error || '未知原因'}`, 10000)
      } else {
        toast.success('已和组件清单对过版本')
      }
    } catch (err) {
      toast.error(`检查清单失败：${err instanceof Error ? err.message : String(err)}`, 10000)
    } finally {
      if (mounted.current) setChecking(false)
    }
  }

  const handleInstall = async (id: string) => {
    if (!api) return
    setTaskPending(id, 'install')
    setProgress((prev) => ({ ...prev, [id]: { id, phase: 'download', done: 0, total: 0 } }))
    try {
      const result = await api.installComponent(id)
      if (!mounted.current) return
      if (result.ok) {
        applyState(result.state)
        toast.success('组件已装上，可以直接用了')
      } else {
        reportFailure(result)
      }
    } catch (err) {
      toast.error(`下载组件失败：${err instanceof Error ? err.message : String(err)}`, 10000)
    } finally {
      if (mounted.current) {
        setTaskPending(id, null)
        setProgress((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        // 中途取消/断流留下的那份半成品不一定改得动磁盘状态，收尾再读一次磁盘为准
        void refresh()
      }
    }
  }

  const handleCancel = async (id: string) => {
    if (!api || pending[id] === 'cancel') return
    setTaskPending(id, 'cancel')
    try {
      const result = await api.cancelComponentInstall(id)
      if (!result.ok && mounted.current) toast.info(result.error || '这个组件现在没有在下载')
    } finally {
      if (mounted.current) setTaskPending(id, null)
    }
  }

  const handleRemove = async (id: string) => {
    if (!api) return
    setTaskPending(id, 'remove')
    try {
      const result = await api.removeComponent(id)
      if (!mounted.current) return
      if (result.ok) {
        applyState(result.state)
        toast.success('已删除，磁盘空间已释放')
      } else {
        reportFailure(result)
      }
    } catch (err) {
      toast.error(`删除组件失败：${err instanceof Error ? err.message : String(err)}`, 10000)
    } finally {
      if (mounted.current) setTaskPending(id, null)
    }
  }

  /** 引擎不会在配完音后自己退，所以「先停引擎」这颗按钮必须在这儿——没有它，同一会话里组件永远动不了 */
  const handleStopEngine = async () => {
    if (!api || stopping) return
    setStopping(true)
    try {
      const result = await api.stopLocalVoiceEngine()
      if (!mounted.current) return
      if (result.ok) toast.success(result.stopped ? '本地配音引擎已停止' : '本地配音引擎本来就没在跑')
      else toast.error(result.error || '停止本地配音引擎失败', 10000)
      // 停没停成以主进程为准，界面不自记一份「我觉得它停了」
      void refresh()
    } catch (err) {
      toast.error(`停止本地配音引擎失败：${err instanceof Error ? err.message : String(err)}`, 10000)
    } finally {
      if (mounted.current) setStopping(false)
    }
  }

  const totalBytes = (states ?? []).reduce((sum, s) => sum + s.bytes, 0)
  const anyInstalling = Object.keys(pending).some((id) => pending[id] === 'install')

  return (
    <div className="settings-form-group">
      <label className="settings-form-label">按需组件</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={handleCheck}
          disabled={checking || anyInstalling}
          className="settings-modal__dict-update-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <RefreshCw size={12} />
          {checking ? '检查中...' : '检查清单'}
        </button>
        {busy?.engineRunning && (
          <button
            type="button"
            onClick={handleStopEngine}
            disabled={stopping || busy.synthesizing}
            className="settings-modal__dict-update-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Square size={12} />
            {stopping ? '停止中...' : '停止本地配音引擎'}
          </button>
        )}
        <span style={{ fontSize: 11, color: '#9AA5B8' }}>
          {states === null
            ? listError
              ? '组件状态读不出来'
              : '读取中...'
            : `合计占用 ${formatBytes(totalBytes)}`}
        </span>
      </div>
      <span className="settings-form-hint">
        本地配音用的引擎和模型不随安装包分发，缺哪个下哪个：引擎取我们仓库的 Release 资产，
        模型取 HuggingFace 上游仓库里钉死的那个提交。两条都按文件指纹校验过才会替换现有组件，
        中途失败或取消都不会留下半份。
        {busy?.synthesizing && '（有一批字幕配音正在逐段合成，等它跑完或先取消这一批，才能动组件）'}
      </span>

      {(states ?? []).map((s) => {
        const p = progress[s.id]
        const task = pending[s.id]
        const percent = p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null
        return (
          <div className="vv-component-row" key={s.id}>
            <div className="vv-component-row__head">
              <span className="vv-component-row__name">{s.title}</span>
              <span className="vv-component-row__meta">{describe(s)}</span>
            </div>
            <div className="vv-component-row__hint">{s.hint}</div>

            {p && (
              <div className="vv-component-progress">
                <div className="media-progress__bar">
                  <div
                    className="media-progress__fill"
                    style={{ width: `${percent === null ? 100 : percent}%`, opacity: percent === null ? 0.35 : 1 }}
                  />
                </div>
                <span className="vv-component-progress__text">
                  {PHASE_LABEL[p.phase]} {formatBytes(p.done)}
                  {p.total > 0 ? ` / ${formatBytes(p.total)}` : ''}
                  {percent !== null ? `（${percent}%）` : ''}
                </span>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {s.action !== 'none' && s.inManifest !== false && (
                <button
                  type="button"
                  onClick={() => void handleInstall(s.id)}
                  disabled={!!p || task === 'remove' || busy?.synthesizing === true}
                  className="settings-modal__save-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', fontSize: 12 }}
                >
                  <Download size={12} />
                  {task === 'install' ? '处理中...' : ACTION_LABEL[s.action]}
                  {s.action === 'update' && s.remoteVersion ? `到 v${s.remoteVersion}` : ''}
                </button>
              )}
              {p && (
                <button
                  type="button"
                  onClick={() => void handleCancel(s.id)}
                  disabled={task === 'cancel'}
                  className="settings-modal__dict-update-btn"
                >
                  {task === 'cancel' ? '取消中...' : '取消下载'}
                </button>
              )}
              {s.installed && !p && (
                <button
                  type="button"
                  onClick={() => void handleRemove(s.id)}
                  disabled={task === 'remove' || busy?.synthesizing === true}
                  className="settings-modal__dict-update-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Trash2 size={12} />
                  {task === 'remove' ? '删除中...' : '删除'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
