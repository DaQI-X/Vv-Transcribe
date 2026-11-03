/**
 * 「云端转写方案」列表（#222 重写第③步 + 第⑤步，只管转写这一档）。
 *
 * 它替掉转写这一档原来那条通用 ProfileBar。重写之后一条转写方案只剩凭据三项
 * （接口地址 / API Key / 模型），「走不走云端」是全局段那几个开关里的事，所以这一栏只在
 * 「转写模式＝云端优先」时出现；行上给的是模型名与域名——用户分辨两套云端配置靠的就是这两样，
 * 不是「方案 2」这种名字。
 *
 * 第⑤步把「什么时候把凭据那三格亮出来」改了：这一栏只有列表，那三格在用户点了某一行的「编辑」
 * 或点了「新建一套」之后才出现。原来它们一直挂在列表下面，于是「我要新建一套」变成了
 * 「先把眼前这条正在用的配置改掉」——那是同一家网关换第二个模型时最别扭的一步。
 * 「新建一套」现在也只摊表单、不写盘，落盘跟着「保存设置」一起走。
 *
 * 「设为当前使用」在这里不再是当场落盘的那颗按钮，而是编辑表单里的一颗开关，
 * 跟着「保存设置」一起写（主进程 saveSettings 的 `defaultProfileIds`，新建那一次走 createProfile 的
 * `setDefault`）：改哪一套、用哪一套，一次点完。
 * 改名也去掉了：建那条时主进程就按模型名落名字，行上显示的又是模型名，
 * 让用户再维护一份只有他自己看得懂的别名没有意义（模型之后改了，名字不会跟着变，但名字已经不参与分辨了）。
 *
 * 读写全在 SettingsModal，这里只有列表的样子、那颗「新建一套」的开关，和两处二次确认。
 */
import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { ProfileView, ProfilesView } from '@/types/settingsProfile'

const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }

/** 表单此刻是收着、正在改某一条、还是摊着一份还没落盘的新建（显示在 SettingsModal 那边） */
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
  /** 凭据那三格此刻是收着还是摊开的（这一栏的话要说「下一步点哪儿」，得知道表单在哪） */
  pane: AsrProfilePane
  hasUnsavedEdits: boolean
  busy: boolean
  onEdit: (profileId: string) => void
  /** 摊开一份还没落盘的新建草稿——这个名字现在不再意味着「当场建一条」 */
  onCreate: () => void
  onDelete: (profileId: string) => Promise<boolean>
}

export function AsrProfileList({
  profiles,
  editingId,
  pane,
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

  /**
   * 「编辑中」跟着表单摊没摊开走，不只看 `editingId`。
   *
   * 列表一读回来，SettingsModal 就把「当前使用」那条推进表单（保存时那几格写进谁由它决定），
   * 那时 pane 还是 'closed'。照 id 判的话这一栏会出现一处假象：屏幕上根本没有表单，行上却写着
   * 「编辑中」并把按钮按死——而用户最想改的正是这条正在用的，点了没反应。
   */
  const isRowEditing = (profileId: string) => pane === 'edit' && profileId === editingId

  /** 换一套来编辑会盖掉表单上还没保存的那几格（或丢掉那份还没落盘的新建），所以先问一句 */
  const requestEdit = (profileId: string) => {
    if (isRowEditing(profileId)) return
    if (hasUnsavedEdits || pane === 'new') {
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
          接口地址 / API Key / 模型那三格也跟着不出现，新建、编辑、删除同样没有：那三格写回的是
          「正在编辑的那一条」，看不见列表就说不清是哪一条。关掉设置窗口重开一次，等这里列出方案再改
        </span>
      </div>
    )
  }

  return (
    <div className="settings-form-group">
      <label className="settings-form-label">云端转写方案</label>

      {list.length === 0 ? (
        <span className="settings-form-hint">
          一条云端转写方案都还没有：点下面「新建一套」把接口地址、API Key、模型摊出来填好，
          再点窗口右下角的「保存设置」就存成第一条。第一条落盘就是当前使用的那一套，不用再去勾什么。
        </span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((profile) => {
            const isEditing = isRowEditing(profile.id)
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
        {/* 满 3 条时这颗按钮直接不出现，而不是摆一个按不动的：那一格位置留给「先删一条」那句话。
            草稿已经摊开时同样不出现——再点一次只是把同一份新建再摊一遍，位置留给「正在新建」那句 */}
        {!atLimit && pane !== 'new' && (
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
        {pane === 'new' && (
          <span className="settings-form-hint">
            <strong>正在新建一套</strong>
            ：下面那三格现在还没落盘，填好后点窗口右下角的「保存设置」才真的建出来一条（点错了就点「取消这份新建」，
            磁盘上不会多出一条没人要的方案）
          </span>
        )}
      </div>

      {atLimit && (
        <span className="settings-form-hint">
          每类配置最多 {profiles.maxProfiles} 套，转写已经满了——要再建一套，先删掉一套
        </span>
      )}

      {list.length > 0 && pane !== 'new' && (
        // 这一栏两种落盘时机混在一起（删除当场写盘，字段和那颗勾选等保存），
        // 不说清就等着用户猜——他刚点的「删除」和他刚填的那格是两件事。
        // 草稿摊开时不发这句：那时候「保存设置」建的是新的一套，不是「上面正在编辑的这一套」
        // 表格收着时也不能说「正在编辑的这一套」——那三格根本没摊开，用户手上没有正在编辑的东西
        <span className="settings-form-hint">
          点某一行的「编辑」才把凭据那三格摊开。「删除」当场就写进磁盘；那三格和那颗「当前使用」
          勾选，都要点「保存设置」才生效
          {pane === 'edit'
            ? '，写的就是上面正在编辑的这一套。'
            : '；三格收着的时候，那颗「保存设置」落的是「转写模式」「转写语言」那两格，方案的内容一个字都不动。'}
        </span>
      )}

      {list.length > 0 && !defaultId && (
        // 有方案、却没有「当前使用」那一条（删掉的就是那条，或用户把开关关了又保存）：
        // 这时云端转写开不了工，得让人知道是「没选」而不是「没配」
        <span className="settings-form-hint">
          这几套里现在没有「当前使用」的那一套，云端转写点开始会被拦下：点要用的那一行的「编辑」，
          勾上「当前使用」再点「保存设置」。
        </span>
      )}

      {pendingTarget && (
        <div style={{ ...ROW_STYLE, marginTop: 6 }}>
          <span className="settings-form-hint">
            {pane === 'new'
              ? `切到「${titleOf(pendingTarget)}」会丢掉正在新建的那一套（它还没落盘，磁盘上不会多出一条）。`
              : `切到「${titleOf(pendingTarget)}」会丢掉这里还没保存的修改（那些改动不会进任何一套方案）。`}
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
            {/* 草稿还没建出来时「先去保存」存的是「新建这一套」，不是「先把手上的改动落盘再切」——
                那颗按钮在这条分支上说的是另一件事，别让它骗人 */}
            {pane === 'new' ? '先不切' : '先去保存'}
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
          // 「还没保存的修改会一起丢」这句要说得有条件：删掉这一条之后界面会把表单切到接班那一条，
          // 那几格是真的被盖掉；删到一条不剩时没得切，那几格留着不清（删完照着建回来是最常见的下一步）；
          // 草稿摊开时 editingId 是空串，删谁都盖不到表单。三种情况都说成「会丢」就是骗人
          const formOverwritten = hasUnsavedEdits && target.id === editingId && list.length > 1
          return (
            <div style={{ ...ROW_STYLE, marginTop: 6 }}>
              <span className="settings-form-hint">
                删掉「{titleOf(target)}」？磁盘上这一套
                {target.keyStatus === 'none' ? '' : '（含它的 API Key）'}会一起没掉，撤不回来
                {formOverwritten ? '；表单里那几处还没保存的修改也跟着丢——删完界面会切到剩下的那一条' : ''}
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
