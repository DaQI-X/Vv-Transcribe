/**
 * 一挡能力的「云端方案」列表（#222 重写第③⑤⑥⑦步做在转写上，第⑧步收成三档共用）。
 *
 * 一条方案只剩「换一家网关要换的那几项」（见 `PROFILE_CAP_SPEC`），所以这一栏只在
 * 真走云端时出现：转看「转写模式＝云端优先」，配音看「配音引擎＝云端接口」，校对本来只有云端。
 * 行上给的是模型名与域名——用户分辨两套云端配置靠的就是这两样，不是「方案 2」这种名字。
 *
 * 这一栏只有列表、那颗「新建API接入」和删除的二次确认。凭据那几格和「当前使用」那颗勾选
 * 都在 `ProfileDialog` 那个小窗里，填完点它自己的「保存」当场写盘。
 *
 * 三处手感（第⑦步）：行不许换行（模型名和域名各让一半、各自截断，完整那串挂在 hover 的
 * title 上，动作那颗再也不能被顶到第二行）、「当前使用」是行的一圈发光边框加右侧一枚小徽标、
 * 删除的二次确认挂在被点那一行下面的气泡里。
 *
 * 「设为当前使用」是弹窗里那颗勾选，跟着那一次「保存」一起写；改名去掉了：建那条时主进程就按
 * 模型名落名字，行上显示的又是模型名，让用户再维护一份只有他自己看得懂的别名没有意义。
 *
 * 读写全在 SettingsModal，这里只有列表的样子、那颗入口按钮，和删除那一次二次确认。
 */
import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  PROFILE_CAP_SPEC,
  profileRowHost,
  profileRowTitle,
} from '@/utils/profileSpec'
import type { ProfileCapability, ProfilesView } from '@/types/settingsProfile'

const BTN_STYLE = { display: 'inline-flex', alignItems: 'center', gap: 4 }

/** 弹窗是收着的、在为列表里某一条开着、还是在为一条还没存在的新方案开着 */
export type ProfilePane = 'closed' | 'edit' | 'new'

interface ProfileListProps {
  capability: ProfileCapability
  /** null＝主进程连列表都没给出来：那不等于「用户一条都没建」，两句话必须分开说 */
  profiles: ProfilesView | null
  /** 弹窗此刻开给的是哪一条（行上那颗按钮要改口说「编辑中」，同一时刻只该有一个） */
  editingId: string
  pane: ProfilePane
  busy: boolean
  /** 为列表里某一条打开弹窗 */
  onEdit: (profileId: string) => void
  /** 打开新建弹窗——这一步一个字节都不写磁盘，写盘在弹窗那颗「保存」上 */
  onCreate: () => void
  onDelete: (profileId: string) => Promise<boolean>
}

export function ProfileList({
  capability,
  profiles,
  editingId,
  pane,
  busy,
  onEdit,
  onCreate,
  onDelete,
}: ProfileListProps) {
  const spec = PROFILE_CAP_SPEC[capability]
  const [confirmingId, setConfirmingId] = useState('')
  const popRef = useRef<HTMLDivElement | null>(null)

  const list = profiles?.profiles[capability] ?? []
  const defaultId = profiles?.defaultProfileId[capability] ?? ''
  const atLimit = !!profiles && list.length >= profiles.maxProfiles

  /**
   * 「编辑中」跟着弹窗开没开走，不只看 `editingId`。
   *
   * 列表一读回来，SettingsModal 就把「当前使用」那条当成指针指着的对象，那时 `pane` 还是 'closed'。
   * 照 id 判的话会出现一处假象：屏幕上根本没有弹窗，行上却写着「编辑中」并把按钮按死——
   * 而用户最想改的正是这条正在用的，点了没反应。
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
        <label className="settings-form-label">{spec.listLabel}</label>
        <span className="settings-form-hint">
          方案列表这次没读出来——磁盘上已有的方案不会因此消失。新建、编辑、删除也先别用：
          关掉设置窗口重开一次。
        </span>
      </div>
    )
  }

  return (
    <div className="settings-form-group">
      <label className="settings-form-label">{spec.listLabel}</label>

      {list.length === 0 ? (
        <span className="settings-form-hint">{spec.emptyHint}</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((profile) => {
            const isEditing = isRowEditing(profile.id)
            const isCurrent = profile.id === defaultId
            const isConfirming = confirmingId === profile.id
            // 删的是「当前使用」那一条时，这一档不会落回剩下的第一条（主进程那侧是刻意的），
            // 所以这一句必须提前说清「删完点开始会被拦下」——事后那句提示救不回已经按下去的那一次
            const isLast = list.length === 1
            const currentTail = isCurrent
              ? isLast
                ? `它是最后一条，也是「当前使用」那条——删掉后这一档一条方案都没有，${spec.activity}会被拦下`
                : `它是「当前使用」那条——删掉后这几套里没有正在使用的方案，${spec.activity}会被拦下`
              : isLast
                ? '这是最后一条，删掉后这一档一条方案都没有'
                : ''
            return (
              <div
                key={profile.id}
                className={`profile-row${isCurrent ? ' profile-row--current' : ''}`}
              >
                <span
                  className="profile-row__label"
                  title={`${profileRowTitle(capability, profile)} · ${profileRowHost(capability, profile)}`}
                >
                  <span className="profile-row__name">{profileRowTitle(capability, profile)}</span>
                  <span className="profile-row__host">
                    · {profileRowHost(capability, profile)}
                  </span>
                </span>
                <span className="profile-row__actions">
                  {isCurrent && <span className="profile-row__chip">当前使用</span>}
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
                  <div className="profile-confirm-pop" ref={popRef} role="dialog" aria-modal="false">
                    <span className="profile-confirm-pop__text">
                      删掉「{profileRowTitle(capability, profile)}」？这一套的
                      {spec.credSummary}
                      {profile.keyStatus === 'none' ? '' : '、API Key'}
                      一起没掉，撤不回来。{currentTail}
                    </span>
                    <span className="profile-confirm-pop__actions">
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
                        className="profile-confirm-pop__danger"
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

      {list.length > 0 && spec.panelNote && (
        // 一个窗口里出现了两颗「保存」——不说清谁管哪一份，用户就会以为弹窗里存完还得再点一次外面那颗
        <span className="settings-form-hint">{spec.panelNote}</span>
      )}

      {list.length > 0 && !defaultId && (
        // 有方案、却没有「当前使用」那一条（删掉的就是那条，或建的时候没勾上）：
        // 这时这一档开不了工，得让人知道是「没选」而不是「没配」
        <span className="settings-form-hint">
          这几套里没有「当前使用」的那一条，{spec.activity}会被拦下：进那一行的「编辑」勾上再保存。
        </span>
      )}
    </div>
  )
}
