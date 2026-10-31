/**
 * 一挡能力的「配置方案」条（#222 第③步）
 *
 * 它只管两件事：选哪一套来编辑，以及新建 / 改名 / 删除 / 设为当前使用这四个动作的
 * 界面状态（输入框开合、两个二次确认）。磁盘上的读写全在 SettingsModal 那边，
 * 因为「切方案要丢掉未保存的修改」这件事只有它知道。
 *
 * 三个口径要说清，界面上的每句话都按它们写：
 * - 「当前使用」＝应用真的按这套干活的那条；「正在编辑」只是表单此刻显示的那条。
 *   两者分开是刻意的：编辑一套没在用的配置不该影响正在跑的活。
 * - 新建 / 改名 / 删除 / 设为当前使用**当场落盘**，不等「保存设置」——它们是结构上的改动，
 *   攒到一起反而解释不清「删了的那套为什么还在」。表单里那些字段的改动照旧
 *   只有点保存才写进去，所以按钮旁边那句话得把这层区别说明白。
 * - 列表读不出来时不许演成「一条都没有」：那是读失败，不是用户没建过方案。
 */
import { useState } from 'react'
import { Check, Pencil, Plus, Star, Trash2, X } from 'lucide-react'
import type { ProfileCapability, ProfilesView } from '@/types/settingsProfile'

/** 三档能力对用户的叫法；SettingsModal 的成功提示要说清切的是哪一档，所以从这里导出 */
export const CAPABILITY_NOUN: Record<ProfileCapability, string> = {
  asr: '转写',
  ai: '校对',
  tts: '配音',
}

const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }

/** 未保存修改时挡住「换一套来编辑」，等用户确认 */
type PendingAction = { kind: 'switch'; profileId: string } | { kind: 'create' } | null

export interface ProfileBarProps {
  capability: ProfileCapability
  /** null＝主进程连列表都没给出来：只说「读不出来」，四个动作全部不出现 */
  profiles: ProfilesView | null
  /** 表单此刻在编辑的那条方案 id */
  editingId: string
  hasUnsavedEdits: boolean
  /** 一次增删改正在路上：连点会把两次操作叠到同一份配置上 */
  busy: boolean
  onSelect: (profileId: string) => void
  onCreate: () => Promise<void>
  onRename: (profileId: string, name: string) => Promise<boolean>
  onDelete: (profileId: string) => Promise<boolean>
  onSetDefault: (profileId: string) => void
}

export function ProfileBar({
  capability,
  profiles,
  editingId,
  hasUnsavedEdits,
  busy,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSetDefault,
}: ProfileBarProps) {
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [pending, setPending] = useState<PendingAction>(null)

  const noun = CAPABILITY_NOUN[capability]
  const list = profiles?.profiles[capability] ?? []
  const defaultId = profiles?.defaultProfileId[capability] ?? ''
  const editing = list.find((profile) => profile.id === editingId) ?? null
  const editingIsCurrent = !!editing && editing.id === defaultId
  const atLimit = !!profiles && list.length >= profiles.maxProfiles
  const pendingTargetName =
    pending?.kind === 'switch' ? list.find((p) => p.id === pending.profileId)?.name ?? '' : ''

  /** 会改掉「正在编辑哪一套」的动作都得先过未保存这道关 */
  const requestSwitch = (profileId: string) => {
    if (profileId === editingId) return
    if (hasUnsavedEdits) {
      setPending({ kind: 'switch', profileId })
      return
    }
    onSelect(profileId)
  }

  const requestCreate = async () => {
    if (hasUnsavedEdits) {
      setPending({ kind: 'create' })
      return
    }
    await onCreate()
  }

  const runPending = async () => {
    const action = pending
    setPending(null)
    if (!action) return
    if (action.kind === 'switch') onSelect(action.profileId)
    else await onCreate()
  }

  /** 改名没成功时输入框得留着，用户改两个字就能再点一次；所以这里要等回话 */
  async function submitRename(): Promise<void> {
    if (!editing) return
    const done = await onRename(editing.id, nameDraft.trim())
    if (done) setRenaming(false)
  }

  if (!profiles) {
    return (
      <div className="settings-form-group">
        <label className="settings-form-label">配置方案</label>
        <span className="settings-form-hint">
          方案列表这次没读出来，下面显示的是当前使用的那一套。新建、改名、删除先不要用，
          关掉设置窗口重开一次再看（磁盘上已有的方案不会因为读不到而消失）
        </span>
      </div>
    )
  }

  return (
    <div className="settings-form-group">
      <label className="settings-form-label">配置方案</label>
      <div style={ROW_STYLE}>
        <select
          className="settings-form-select"
          style={{ flex: '0 1 220px', minWidth: 180, width: 'auto' }}
          value={editingId}
          disabled={busy}
          onChange={(e) => requestSwitch(e.target.value)}
        >
          {list.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
              {profile.id === defaultId ? '（当前使用）' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="settings-modal__dict-update-btn"
          style={ROW_STYLE}
          disabled={busy || editingIsCurrent || !editing}
          onClick={() => editing && onSetDefault(editing.id)}
        >
          <Star size={12} />
          设为当前使用
        </button>
        <button
          type="button"
          className="settings-modal__dict-update-btn"
          style={ROW_STYLE}
          disabled={busy || atLimit}
          onClick={() => void requestCreate()}
        >
          <Plus size={12} />
          新建一套
        </button>
        <button
          type="button"
          className="settings-modal__dict-update-btn"
          style={ROW_STYLE}
          disabled={busy || !editing}
          onClick={() => {
            setNameDraft(editing?.name ?? '')
            setRenaming(true)
            setConfirmingDelete(false)
          }}
        >
          <Pencil size={12} />
          改名
        </button>
        <button
          type="button"
          className="settings-modal__dict-update-btn"
          style={ROW_STYLE}
          disabled={busy || !editing || list.length <= 1}
          onClick={() => {
            setConfirmingDelete(true)
            setRenaming(false)
            setPending(null)
          }}
        >
          <Trash2 size={12} />
          删除
        </button>
      </div>

      {editingIsCurrent ? (
        <span className="settings-form-hint">
          这套正在被应用使用。新建或编辑别的{noun}方案都不影响它，点「设为当前使用」才切过去。
          这里的四个按钮当场就写进磁盘，只有下面那些字段是点「保存设置」才生效。
        </span>
      ) : (
        <span className="settings-form-hint">
          正在编辑的是没在用的{noun}方案，改完点「保存设置」只会写进这一套，
          正在用的那套一个字都不动；要让应用开始用它，点「设为当前使用」。
          这里的四个按钮当场就写进磁盘。
        </span>
      )}

      {atLimit && (
        <span className="settings-form-hint">
          每类配置最多 {profiles.maxProfiles} 套，{noun}已经满了——要再建一套，先删掉一套
        </span>
      )}
      {list.length <= 1 && (
        <span className="settings-form-hint">
          至少得留一套{noun}配置，所以现在不能删。新建一套之后再删旧的就行
        </span>
      )}

      {renaming && editing && (
        <div style={{ ...ROW_STYLE, marginTop: 6 }}>
          <input
            className="settings-form-input"
            style={{ flex: '1 1 160px' }}
            value={nameDraft}
            maxLength={40}
            autoFocus
            disabled={busy}
            placeholder={`这套${noun}配置的名字`}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitRename()
              }
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
          <button
            type="button"
            className="settings-modal__dict-update-btn"
            style={ROW_STYLE}
            disabled={busy || nameDraft.trim() === ''}
            onClick={() => void submitRename()}
          >
            <Check size={12} />
            改名字
          </button>
          <button
            type="button"
            className="settings-modal__cancel-btn"
            style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
            onClick={() => setRenaming(false)}
          >
            <X size={12} />
            取消
          </button>
        </div>
      )}

      {confirmingDelete && editing && (
        <div style={{ ...ROW_STYLE, marginTop: 6 }}>
          <span className="settings-form-hint">
            删掉「{editing.name}」？磁盘上这一套（含它的 API Key）会一起没掉，撤不回来
            {hasUnsavedEdits ? '；表单里那几处还没保存的修改也一起丢' : ''}。
          </span>
          <button
            type="button"
            className="settings-modal__dict-update-btn"
            style={ROW_STYLE}
            disabled={busy}
            onClick={async () => {
              if (!editing) return
              const done = await onDelete(editing.id)
              if (done) setConfirmingDelete(false)
            }}
          >
            <Trash2 size={12} />
            确定删除
          </button>
          <button
            type="button"
            className="settings-modal__cancel-btn"
            style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
            onClick={() => setConfirmingDelete(false)}
          >
            取消
          </button>
        </div>
      )}

      {pending && (
        <div style={{ ...ROW_STYLE, marginTop: 6 }}>
          <span className="settings-form-hint">
            {pending.kind === 'switch'
              ? `切到「${pendingTargetName}」会丢掉这套里还没保存的修改。`
              : '新建一套会切到新那套上去，这套里还没保存的修改会丢掉。'}
          </span>
          <button
            type="button"
            className="settings-modal__save-btn"
            style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
            onClick={() => void runPending()}
          >
            {pending.kind === 'switch' ? '丢掉并切换' : '丢掉并新建'}
          </button>
          <button
            type="button"
            className="settings-modal__cancel-btn"
            style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
            onClick={() => setPending(null)}
          >
            先去保存
          </button>
        </div>
      )}
    </div>
  )
}
