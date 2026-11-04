/**
 * 「云端转写方案」列表（#222 重写第③步 → 第⑤步 → 第⑥步 → 第⑦步，只管转写这一档）。
 *
 * 它替掉转写这一档原来那条通用 ProfileBar。重写之后一条转写方案只剩凭据三项
 * （接口地址 / API Key / 模型），「走不走云端」是全局段那几个开关里的事，所以这一栏只在
 * 「转写模式＝云端优先」时出现；行上给的是模型名与域名——用户分辨两套云端配置靠的就是这两样，
 * 不是「方案 2」这种名字。
 *
 * 第⑥步把「那三格在哪儿填」也挪走了：这一栏只剩列表、那颗「新建API接入」和删除的二次确认。
 * 点了新建或编辑，弹出来的是 AsrProfileDialog 那个小窗，填完点它自己的「保存」当场写盘。
 *
 * 第⑦步改的是这一栏自己的三处手感：行不许换行（模型名和域名各让一半、各自截断，完整那串挂在
 * hover 的 title 上，动作那颗再也不能被顶到第二行）、
 * 「当前使用」改成行的一圈发光边框加右侧一枚小徽标（原来那四个加粗的字夹在模型名和域名中间，
 * 既突兀又会跟着长名字一起被挤走）、删除的二次确认从「整栏末尾长出一行」改成挂在被点那一行
 * 下面的气泡（上一版要往下滑才看到「确定删除」，而它说的正是这一行要没了）。
 *
 * 「设为当前使用」是弹窗里那颗勾选，跟着那一次「保存」一起写（新建走 createProfile 的
 * `setDefault`，编辑走 saveSettings 的 `defaultProfileIds`）；改名去掉了：建那条时主进程就按
 * 模型名落名字，行上显示的又是模型名，让用户再维护一份只有他自己看得懂的别名没有意义。
 *
 * 读写全在 SettingsModal，这里只有列表的样子、那颗入口按钮，和删除那一次二次确认。
 */
import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { ProfileView, ProfilesView } from '@/types/settingsProfile'

const BTN_STYLE = { display: 'inline-flex', alignItems: 'center', gap: 4 }

/** 弹窗是收着的、在为列表里某一条开着、还是在为一条还没存在的新方案开着 */
export type AsrProfilePane = 'closed' | 'edit' | 'new'

/** 域名那一格：接口地址是用户手填的，不能指望它能被 URL 解析（填了 `api.x.com` 也算合法） */
function hostOf(profile: ProfileView): string {
  const raw = (profile.values.asrApiBase ?? '').trim()
  if (!raw) return '接口地址未填'
  return raw.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
}

/** 行标题：模型名优先，没有模型才退回方案名（第一条建出来时模型可能还空着） */
function titleOf(profile: ProfileView): string {
  return (profile.values.asrModel ?? '').trim() || profile.name
}

interface AsrProfileListProps {
  /** null＝主进程连列表都没给出来：那不等于「用户一条都没建」，两句话必须分开说 */
  profiles: ProfilesView | null
  editingId: string
  /** 弹窗此刻开着是给哪一条的（行上那颗按钮要改口说「编辑中」，同一时刻只该有一个） */
  pane: AsrProfilePane
  busy: boolean
  /** 为列表里某一条打开弹窗 */
  onEdit: (profileId: string) => void
  /** 打开新建弹窗——这一步一个字节都不写磁盘，写盘在弹窗那颗「保存」上 */
  onCreate: () => void
  onDelete: (profileId: string) => Promise<boolean>
}

export function AsrProfileList({
  profiles,
  editingId,
  pane,
  busy,
  onEdit,
  onCreate,
  onDelete,
}: AsrProfileListProps) {
  const [confirmingId, setConfirmingId] = useState('')
  const popRef = useRef<HTMLDivElement | null>(null)

  const list = profiles?.profiles.asr ?? []
  const defaultId = profiles?.defaultProfileId.asr ?? ''
  const atLimit = !!profiles && list.length >= profiles.maxProfiles

  /**
   * 「编辑中」跟着弹窗开没开走，不只看 `editingId`。
   *
   * 列表一读回来，SettingsModal 就把「当前使用」那条推进表单（弹窗关掉后指针也留着它），
   * 那时 `pane` 还是 'closed'。照 id 判的话这一栏会出现一处假象：屏幕上根本没有弹窗，行上却写着
   * 「编辑中」并把按钮按死——而用户最想改的正是这条正在用的，点了没反应。
   */
  const isRowEditing = (profileId: string) => pane === 'edit' && profileId === editingId

  // 气泡是挂在行上的：点外面和 Esc 收掉它，不顺手把设置窗口也关掉（那一步用户没说要走）
  useEffect(() => {
    if (!confirmingId) return
    popRef.current?.scrollIntoView({ block: 'nearest' })
    const onPointerDown = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) setConfirmingId('')
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmingId('')
    }
    document.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [confirmingId])

  if (!profiles) {
    return (
      <div className="settings-form-group">
        <label className="settings-form-label">云端转写方案</label>
        <span className="settings-form-hint">
          方案列表这次没读出来——磁盘上已有的方案不会因此消失。新建、编辑、删除也先别用：
          关掉设置窗口重开一次。
        </span>
      </div>
    )
  }

  return (
    <div className="settings-form-group">
      <label className="settings-form-label">云端转写方案</label>

      {list.length === 0 ? (
        <span className="settings-form-hint">
          一条都还没有：点下面「新建API接入」，填好三格点弹窗里的「保存」。
          第一条落盘就是当前使用的那一套。
        </span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((profile) => {
            const isEditing = isRowEditing(profile.id)
            const isCurrent = profile.id === defaultId
            const isConfirming = confirmingId === profile.id
            // 删的是「当前使用」那一条时，转写这一档不会落回剩下的第一条（主进程那侧是刻意的），
            // 所以这一句必须提前说清「删完点开始转写会被拦下」——事后那句提示救不回已经按下去的那一次
            const isLast = list.length === 1
            const currentTail = isCurrent
              ? isLast
                ? '它是最后一条，也是「当前使用」那条——删掉后这一档一条方案都没有，云端转写会被拦下'
                : '它是「当前使用」那条——删掉后这几套里没有正在使用的方案，云端转写会被拦下'
              : isLast
                ? '这是最后一条，删掉后这一档一条方案都没有'
                : ''
            return (
              <div
                key={profile.id}
                className={`asr-profile-row${isCurrent ? ' asr-profile-row--current' : ''}`}
              >
                <span
                  className="asr-profile-row__label"
                  title={`${titleOf(profile)} · ${hostOf(profile)}`}
                >
                  <span className="asr-profile-row__name">{titleOf(profile)}</span>
                  <span className="asr-profile-row__host">· {hostOf(profile)}</span>
                </span>
                <span className="asr-profile-row__actions">
                  {isCurrent && <span className="asr-profile-row__chip">当前使用</span>}
                  <button
                    type="button"
                    className="settings-modal__dict-update-btn"
                    style={BTN_STYLE}
                    disabled={busy || isEditing}
                    onClick={() => onEdit(profile.id)}
                  >
                    <Pencil size={12} />
                    {isEditing ? '编辑中' : '编辑'}
                  </button>
                  <button
                    type="button"
                    className="settings-modal__dict-update-btn"
                    style={BTN_STYLE}
                    disabled={busy}
                    onClick={() => setConfirmingId(profile.id)}
                  >
                    <Trash2 size={12} />
                    删除
                  </button>
                </span>
                {isConfirming && (
                  <div className="asr-confirm-pop" ref={popRef} role="dialog" aria-modal="false">
                    <span className="asr-confirm-pop__text">
                      删掉「{titleOf(profile)}」？这一套的地址、模型
                      {profile.keyStatus === 'none' ? '' : '、API Key'}
                      一起没掉，撤不回来。{currentTail}
                    </span>
                    <span className="asr-confirm-pop__actions">
                      <button
                        type="button"
                        className="settings-modal__dict-update-btn"
                        disabled={busy}
                        onClick={() => setConfirmingId('')}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="asr-confirm-pop__danger"
                        style={BTN_STYLE}
                        disabled={busy}
                        onClick={async () => {
                          if (await onDelete(profile.id)) setConfirmingId('')
                        }}
                      >
                        <Trash2 size={12} />
                        删除
                      </button>
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        {/* 满 3 条时这颗按钮直接不出现，而不是摆一个按不动的：那一格位置留给「先删一条」那句话 */}
        {!atLimit && (
          <button
            type="button"
            className="settings-modal__dict-update-btn"
            style={BTN_STYLE}
            disabled={busy}
            onClick={onCreate}
          >
            <Plus size={12} />
            新建API接入
          </button>
        )}
      </div>

      {atLimit && (
        <span className="settings-form-hint">
          最多 {profiles.maxProfiles} 套，要再建一套先删掉一条
        </span>
      )}

      {list.length > 0 && (
        // 一个窗口里出现了两颗「保存」——不说清谁管哪一份，用户就会以为弹窗里存完还得再点一次外面那颗
        <span className="settings-form-hint">
          弹窗里的「保存」当场写盘，「删除」也是当场、撤不回来；右下角那颗「保存设置」只管上面的模式与语言。
        </span>
      )}

      {list.length > 0 && !defaultId && (
        // 有方案、却没有「当前使用」那一条（删掉的就是那条，或建的时候没勾上）：
        // 这时云端转写开不了工，得让人知道是「没选」而不是「没配」
        <span className="settings-form-hint">
          这几套里没有「当前使用」的那一条，云端转写会被拦下：进那一行的「编辑」勾上再保存。
        </span>
      )}
    </div>
  )
}
