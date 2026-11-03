/**
 * 「云端转写方案」列表（#222 重写第③步，只管转写这一档）。
 *
 * 它替掉转写这一档原来那条通用 ProfileBar。重写之后一条转写方案只剩凭据三项
 * （接口地址 / API Key / 模型），「走不走云端」是全局段那几个开关里的事，所以这一栏只在
 * 「转写模式＝云端优先」时出现；行上给的是模型名与域名——用户分辨两套云端配置靠的就是这两样，
 * 不是「方案 2」这种名字。
 *
 * 「设为当前使用」在这里不再是当场落盘的那颗按钮，而是编辑表单里的一颗开关，
 * 跟着「保存设置」一起写（主进程 saveSettings 的 `defaultProfileIds`）：改哪一套、用哪一套，一次点完。
 * 改名也去掉了：建那条时主进程就按模型名落名字，行上显示的又是模型名，
 * 让用户再维护一份只有他自己看得懂的别名没有意义（模型之后改了，名字不会跟着变，但名字已经不参与分辨了）。
 *
 * 读写全在 SettingsModal，这里只有列表的样子和两处二次确认。
 */
import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { ProfileView, ProfilesView } from '@/types/settingsProfile'

const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }

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
  hasUnsavedEdits: boolean
  busy: boolean
  onEdit: (profileId: string) => void
  onCreate: () => void
  onDelete: (profileId: string) => Promise<boolean>
}

export function AsrProfileList({
  profiles,
  editingId,
  hasUnsavedEdits,
  busy,
  onEdit,
  onCreate,
  onDelete,
}: AsrProfileListProps) {
  const [confirmingId, setConfirmingId] = useState('')
  const [pendingSwitchId, setPendingSwitchId] = useState('')

  const list = profiles?.profiles.asr ?? []
  const defaultId = profiles?.defaultProfileId.asr ?? ''
  const atLimit = !!profiles && list.length >= profiles.maxProfiles
  const pendingTarget = pendingSwitchId
    ? list.find((profile) => profile.id === pendingSwitchId)
    : undefined

  /** 换一套来编辑会盖掉表单上还没保存的那几格，所以先问一句 */
  const requestEdit = (profileId: string) => {
    if (profileId === editingId) return
    if (hasUnsavedEdits) {
      setPendingSwitchId(profileId)
      return
    }
    onEdit(profileId)
  }

  if (!profiles) {
    return (
      <div className="settings-form-group">
        <label className="settings-form-label">云端转写方案</label>
        <span className="settings-form-hint">
          方案列表这次没读出来，所以这一栏先空着——磁盘上已有的方案不会因为读不到而消失。
          下面那三格显示的是「当前使用」那一条，改了点保存也是写回它；看不见列表就分不清
          那到底是哪一套，所以新建、编辑、删除和那三格都先不要用，关掉设置窗口重开一次再看
        </span>
      </div>
    )
  }

  return (
    <div className="settings-form-group">
      <label className="settings-form-label">云端转写方案</label>

      {list.length === 0 ? (
        <span className="settings-form-hint">
          一条云端转写方案都还没有：把下面接口地址、API Key、模型填好，点「新建一套」就把这几格存成第一条，
          第一条落盘就是当前使用的那一套。
        </span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((profile) => {
            const isEditing = profile.id === editingId
            const isCurrent = profile.id === defaultId
            return (
              <div
                key={profile.id}
                style={{
                  ...ROW_STYLE,
                  justifyContent: 'space-between',
                  border: `1px solid ${isEditing ? 'var(--brand-blue)' : 'var(--border-color)'}`,
                  borderRadius: 10,
                  padding: '6px 10px',
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  {titleOf(profile)}
                  <span style={{ color: 'var(--text-muted)' }}> · {hostOf(profile)}</span>
                  {isCurrent ? <strong style={{ marginLeft: 6 }}>当前使用</strong> : null}
                </span>
                <span style={ROW_STYLE}>
                  <button
                    type="button"
                    className="settings-modal__dict-update-btn"
                    style={ROW_STYLE}
                    disabled={busy || isEditing}
                    onClick={() => requestEdit(profile.id)}
                  >
                    <Pencil size={12} />
                    {isEditing ? '编辑中' : '编辑'}
                  </button>
                  <button
                    type="button"
                    className="settings-modal__dict-update-btn"
                    style={ROW_STYLE}
                    disabled={busy}
                    onClick={() => {
                      setConfirmingId(profile.id)
                      setPendingSwitchId('')
                    }}
                  >
                    <Trash2 size={12} />
                    删除
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ ...ROW_STYLE, marginTop: 8 }}>
        {/* 满 3 条时这颗按钮直接不出现，而不是摆一个按不动的：那一格位置留给「先删一条」那句话 */}
        {!atLimit && (
          <button
            type="button"
            className="settings-modal__dict-update-btn"
            style={ROW_STYLE}
            disabled={busy}
            onClick={onCreate}
          >
            <Plus size={12} />
            新建一套
          </button>
        )}
      </div>

      {atLimit && (
        <span className="settings-form-hint">
          每类配置最多 {profiles.maxProfiles} 套，转写已经满了——要再建一套，先删掉一套
        </span>
      )}

      {list.length > 0 && (
        // 这一栏两种落盘时机混在一起（新建/删除当场写盘，字段和那颗勾选等保存），
        // 不说清就等着用户猜——他刚点的「删除」和他刚填的那格是两件事
        <span className="settings-form-hint">
          「新建一套」和「删除」当场就写进磁盘；下面那三格和那颗「当前使用」勾选，
          都要点「保存设置」才生效，写的就是上面正在编辑的这一套。
        </span>
      )}

      {list.length > 0 && !defaultId && (
        // 有方案、却没有「当前使用」那一条（删掉的就是那条，或用户把开关关了又保存）：
        // 这时云端转写开不了工，得让人知道是「没选」而不是「没配」
        <span className="settings-form-hint">
          这几套里现在没有「当前使用」的那一套，云端转写点开始会被拦下：编辑要用的那一套，
          勾上「当前使用」再点「保存设置」。
        </span>
      )}

      {pendingTarget && (
        <div style={{ ...ROW_STYLE, marginTop: 6 }}>
          <span className="settings-form-hint">
            切到「{titleOf(pendingTarget)}」会丢掉这里还没保存的修改（那些改动不会进任何一套方案）。
          </span>
          <button
            type="button"
            className="settings-modal__save-btn"
            style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
            onClick={() => {
              const target = pendingTarget.id
              setPendingSwitchId('')
              onEdit(target)
            }}
          >
            丢掉并切换
          </button>
          <button
            type="button"
            className="settings-modal__cancel-btn"
            style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
            onClick={() => setPendingSwitchId('')}
          >
            先去保存
          </button>
        </div>
      )}

      {confirmingId &&
        (() => {
          const target = list.find((profile) => profile.id === confirmingId)
          if (!target) return null
          // 删的是「当前使用」那一条时，转写这一档不会落回剩下的第一条（主进程那侧是刻意的），
          // 所以这一句必须提前说清「删完点开始转写会被拦下」——事后那条提示救不回已经按下去的那一次
          const isLast = list.length === 1
          const isCurrentTarget = target.id === defaultId
          const currentTail = isCurrentTarget
            ? isLast
              ? '；它是「当前使用」那一条，也是最后一条——删掉之后转写一条方案都没有，要用云端转写得先新建一条'
              : '；它是「当前使用」那一条，删掉之后这几套里就没有正在使用的方案了，云端转写点开始会被拦下，得勾一条再点「保存设置」'
            : isLast
              ? '；这是最后一条，删掉之后转写就没有正在使用的方案，云端转写要用它得重新建一条'
              : ''
          return (
            <div style={{ ...ROW_STYLE, marginTop: 6 }}>
              <span className="settings-form-hint">
                删掉「{titleOf(target)}」？磁盘上这一套（含它的 API Key）会一起没掉，撤不回来
                {hasUnsavedEdits ? '；表单里那几处还没保存的修改也一起丢' : ''}
                {currentTail}
                。
              </span>
              <button
                type="button"
                className="settings-modal__dict-update-btn"
                style={ROW_STYLE}
                disabled={busy}
                onClick={async () => {
                  if (await onDelete(target.id)) setConfirmingId('')
                }}
              >
                <Trash2 size={12} />
                确定删除
              </button>
              <button
                type="button"
                className="settings-modal__cancel-btn"
                style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
                onClick={() => setConfirmingId('')}
              >
                取消
              </button>
            </div>
          )
        })()}
    </div>
  )
}
