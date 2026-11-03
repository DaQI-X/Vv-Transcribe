/**
 * 一挡能力的「配置方案」条（#222 第③步）
 *
 * 现在只有校对与配音用它：转写那一档在 #222 重写第③步换成了 AsrProfileList——
 * 一条转写方案只剩凭据三项，「当前使用」改由编辑表单里那颗勾选随保存落盘，
 * 这一条上的四颗按钮也就没有一颗是给转写用的。
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
type PendingAction = { kind: 'switch'; profileId: string } | null

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

  /**
   * 新建不再问「未保存的修改要不要丢」：它带的正是表单此刻这几格（SettingsModal 把输入
   * 整份交给主进程，主进程只挑这一档的键），点下去是「把我现在填的存成另一套」，没有东西要丢。
   */
  const runPending = async () => {
    const action = pending
    setPending(null)
    if (!action) return
    onSelect(action.profileId)
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
          value={editing ? editingId : ''}
          disabled={busy || list.length === 0}
          onChange={(e) => requestSwitch(e.target.value)}
        >
          {!editing && (
            // 没在编辑任何一条时（一条都没有，或磁盘上「当前使用」那个 id 指不到人），
            // 下拉不能是个空白的框：那看着像界面坏了，而它要说的是「还没有选到哪一套」
            <option value="" disabled hidden>
              （没有正在编辑的方案）
            </option>
          )}
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
          onClick={() => void onCreate()}
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
          disabled={busy || !editing}
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

      {editing ? (
        editingIsCurrent ? (
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
        )
      ) : list.length === 0 ? (
        <span className="settings-form-hint">
          {noun}现在一条配置方案都没有，所以下面那些字段还没有归宿：点「新建一套」先落一条，
          填完再点「保存设置」才存进去。第一条落盘后自动就是当前使用的那套
        </span>
      ) : (
        // 列表有方案、表单却没在编辑任何一条：磁盘上「当前使用」那个 id 指不到人，
        // 主进程把它收口成空串（转写这一档不擅自抓第一条）。这时既不能说「一条都没有」，
        // 也不能说正在编辑某一套——只能让用户自己从下拉里点一条。
        <span className="settings-form-hint">
          {noun}这几格现在不属于任何一套方案（列表里那几条都没被选中来编辑）：从上面选一条，
          填完点「保存设置」就写进那一条。
        </span>
      )}

      {atLimit && (
        <span className="settings-form-hint">
          每类配置最多 {profiles.maxProfiles} 套，{noun}已经满了——要再建一套，先删掉一套
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
            {hasUnsavedEdits ? '；表单里那几处还没保存的修改也一起丢' : ''}
            {list.length === 1
              ? `；这是最后一条，删掉之后${noun}就没有正在使用的方案，云端${noun}要用它得重新建一条`
              : ''}。
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
            切到「{pendingTargetName}」会丢掉这套里还没保存的修改。
          </span>
          <button
            type="button"
            className="settings-modal__save-btn"
            style={{ ...ROW_STYLE, padding: '4px 12px', fontSize: 11 }}
            onClick={() => void runPending()}
          >
            丢掉并切换
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
