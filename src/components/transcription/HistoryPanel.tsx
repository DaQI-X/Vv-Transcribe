/**
 * 「历史记录」抽屉（#247④）——浮在页面右侧，不占布局
 *
 * 为什么是浮的：这一栏读的是「跑过什么」，属于随时看一眼、看完要收回去的东西。摆在结果页那一列里
 * 就得从字幕编辑器头上切走 280px，用户为了查一条记录把主要工作面挤窄，这是本末倒置。
 * 所以它 `position: fixed` 盖在上面，入口是标题栏那颗图标，关的时候整块缩回那颗图标（见
 * `.history-drawer` 的 transform-origin）。
 *
 * 这一栏回答的只有两件事：这次跑过什么，和哪些东西现在不勾就没了。所以：
 * - 顶部按作业种类分组（全部 / 转写 / 下载 / 配音），行上那枚徽标与标签同一个取值；
 *   选中某一类时不再重复给每行盖同一枚章。账本读不出来时**不摆标签**——那三个数字会是三个 0，
 *   等于当着用户的面说他没跑过作业。
 * - 一行只有一颗「留住」的勾。勾上＝主进程把那份产物（或这次会话的稿子正文）复制进应用数据目录，
 *   从此不受 24 小时清扫管；不勾＝原件还在临时目录里，清扫跑过就找不回来了。
 * - 那一勾点不点得动由 `productAvailable` 和「正文只在这次会话里」决定，点不动就在 title 上说清为什么——
 *   摆一颗按下去必失败的按钮，比一开始不给它更糟。
 * - 「在文件夹里显示」是这一栏碰得到文件的唯一方式：产物的路径从头到尾没跨过 IPC，界面连它在哪儿都不知道。
 * - 删除只删单条，连它留住的副本一起没（这一条必须在按下之前说清，撤不回来）。
 *
 * 列表按「最新在上」——排序由主进程做（`listHistory` 里按 at 字典序），界面不再自己排一次，
 * 免得两处规则漂移。
 */
import { useEffect, useRef, useState } from 'react'
import { BookmarkCheck, FolderOpen, RotateCw, Trash2, X } from 'lucide-react'
import { useHistoryStore, type HistoryTab } from '@/stores/useHistoryStore'
import { useProfileStore } from '@/stores/useProfileStore'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { profileRowTitle } from '@/utils/profileSpec'
import { localTtsEngineLabel, voiceSidLabel } from '@/utils/localTtsEngines'
import { languageLabel } from '@/utils/asrLanguage'
import { formatTime } from '@/utils/formatTime'
import { formatBytes } from '@/utils/formatBytes'
import type { HistoryItem, HistoryKind } from '@/types/history'
import type { ProfileCapability, ProfileView } from '@/types/settingsProfile'

const KIND_LABEL: Record<HistoryKind, string> = {
  transcribe: '转写',
  download: '下载',
  voice: '配音',
}

/** 标签顺序就是这三种作业，「全部」在最前——数字直接取主进程那份列表，界面不自己数一遍口径 */
const TABS: { key: HistoryTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'transcribe', label: KIND_LABEL.transcribe },
  { key: 'download', label: KIND_LABEL.download },
  { key: 'voice', label: KIND_LABEL.voice },
]

const CAP_LABEL: Record<ProfileCapability, string> = { asr: '转写', ai: '校对', tts: '配音' }

/**
 * 「留住了多少」要开始点名那一条的线。2GB 是拍的：一条留住的是稿子（几十 KB）或一条音轨（几 MB
 * 到几百 MB），普通一期节目攒不到这个数，攒到了就说明这一栏正在被当成仓库用，该给用户看一眼。
 *
 * 它**不是**一条自动清理线：留住的行不参与修剪是刻意的决定（`historyService` 的 `pruneRows`
 * 只剪「什么都没留住」的行，自动删掉用户点名要留的东西比账本长一点严重得多），所以这一句只负责
 * 说数、并指着那一行的「删除」——越过这条线应用一个字都不会删。
 */
const KEPT_WARN_BYTES = 2e9

/**
 * 记录里的时间是 ISO；界面只念到分钟——一行之差看不出是哪一次，但年份能看出是不是去年那批。
 * 补零交给 Intl，不自己拼：`formatTime.ts` 那把尺量的是「一段音频有几时几分几秒」，量不出日历日期，
 * 而 `tests/formatTime.test.ts` 把 `padStart(2` 当成「自己造第三把时钟」的指纹——这里要的是日期，
 * 既不占用那把尺，就不该在文件里留下它的写法。
 */
function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间没记上'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 秒数念成 mm:ss / hh:mm:ss；null 是「当时没读到」，不拿 00:00 冒充「时长是零」 */
function secondsText(seconds: number | null): string {
  return seconds === null ? '时长未知' : formatTime(seconds)
}

/** 界面上的勾：这一条此刻点不点得动、点下去留的是哪一样 */
function keepState(item: HistoryItem, currentTranscribeId: string | null, hasSegments: boolean) {
  const kept = item.keptProduct || item.keptDraft
  if (kept) return { kept: true, canKeep: true, label: '留住', why: '' }
  if (item.kind === 'transcribe') {
    // 转写的提取音频在完成点就被删了（TranscribeDetail 上面那句），能留的只有稿子正文，
    // 而正文只活在渲染层——不是刚转完这一单的话，界面上已经没有一个地方还留着它
    const available = item.id === currentTranscribeId && hasSegments
    return {
      kept: false,
      canKeep: available,
      label: '留住稿子',
      why: available
        ? ''
        : '转写不留音频，只留稿子正文；而正文只在那次会话的界面上，这一条已经取不到了',
    }
  }
  return {
    kept: false,
    canKeep: item.productAvailable,
    label: '留住',
    why: item.productAvailable ? '' : '原件所在的临时目录已经被清掉（超过 24 小时），这一条留不了了',
  }
}

/** 行上那一行念不完的正文，和挂在 title 上的完整一句 */
function summaryOf(item: HistoryItem, profiles: Record<ProfileCapability, ProfileView[] | null>) {
  const d = item.detail
  const at = clockOf(item.at)
  let row = ''
  let more = ''
  if (d.kind === 'transcribe') {
    row = `${at} · ${d.provider === 'cloud' ? '云端' : `本地 ${d.model}`} · ${d.segments} 段 · ${secondsText(d.durationSec)}`
    more = `语言 ${languageLabel(d.language)} · 用了 ${d.elapsedMs === null ? '未知' : formatTime(d.elapsedMs / 1000)}`
  } else if (d.kind === 'download') {
    const media = d.mediaKind === 'video' ? '视频' : d.mediaKind === 'audio' ? '音频' : d.mediaKind
    row = `${at} · ${media}${d.height ? ` ${d.height}p` : ''} · ${formatBytes(d.sizeBytes)} · ${secondsText(d.durationSec)}`
  } else {
    const who = d.engine === 'local' ? `本地 ${localTtsEngineLabel(d.model)}` : `云端 ${d.model}`
    row = `${at} · ${who} · ${d.clips}/${d.queueTotal} 段 · ${formatTime(d.trackDuration)}`
    const voice = d.engine === 'local' ? voiceSidLabel(d.voice) : `音色 ${d.voice}`
    more = `${voice} · ${d.speed}× · ${formatBytes(d.trackBytes)}${d.pushedCount > 0 ? ` · 有 ${d.pushedCount} 段被顺延` : ''}`
  }
  // 方案 id 记在账上是为了事后对「这次跟那次不一样」，但一串 uuid 写在行上没人读得下去；
  // 列表没读回来时这一段整个不出现——宁可少一句，也不拿 id 前几位冒充名字
  const used = (['asr', 'ai', 'tts'] as ProfileCapability[])
    .map((cap) => {
      const id = item.profiles[cap]
      const list = profiles[cap]
      if (!id || !list) return ''
      const match = list.find((profile) => profile.id === id)
      if (!match) return ''
      return `${CAP_LABEL[cap]}用「${profileRowTitle(cap, match)}」`
    })
    .filter(Boolean)
    .join(' · ')
  return { row, title: [row, more, used].filter(Boolean).join(' ｜ ') }
}

export function HistoryPanel() {
  const items = useHistoryStore((s) => s.items)
  const error = useHistoryStore((s) => s.error)
  const loading = useHistoryStore((s) => s.loading)
  const busyId = useHistoryStore((s) => s.busyId)
  const open = useHistoryStore((s) => s.open)
  const tab = useHistoryStore((s) => s.tab)
  const refresh = useHistoryStore((s) => s.refresh)
  const setOpen = useHistoryStore((s) => s.setOpen)
  const setTab = useHistoryStore((s) => s.setTab)
  const keep = useHistoryStore((s) => s.keep)
  const unkeep = useHistoryStore((s) => s.unkeep)
  const remove = useHistoryStore((s) => s.remove)
  const reveal = useHistoryStore((s) => s.reveal)

  const jobId = useTranscriptionStore((s) => s.jobId)
  const hasSegments = useTranscriptionStore((s) => s.segments.length > 0)
  const slice = useProfileStore((s) => s.slice)

  const [confirmingId, setConfirmingId] = useState('')
  const popRef = useRef<HTMLDivElement | null>(null)

  // 挂载先读一次：这一栏平时不显示，但 `items === null` 得先变成「读过」的形状，
  // 否则还没试过盘就会被那句「读不出来」顶替
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 之后每次打开再重读一次：抽屉关着的那段时间里可能又跑完了一单，
  // 靠挂载那一次会说不出「刚刚那次去哪了」
  useEffect(() => {
    if (!open) return
    void refresh()
    // 行上的「用的哪套方案」要名字，id 换名字得先有三档的列表
    void useProfileStore.getState().load()
  }, [open, refresh])

  // 二次确认是长在行里的：点外面收回它；Esc 先看它，没有它可收才收整个抽屉
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) setConfirmingId('')
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (confirmingId) {
        setConfirmingId('')
        return
      }
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, confirmingId, setOpen])

  useEffect(() => {
    if (!confirmingId) return
    popRef.current?.scrollIntoView({ block: 'nearest' })
  }, [confirmingId])

  const countOf = (key: HistoryTab): number => {
    if (!items) return 0
    return key === 'all' ? items.length : items.filter((item) => item.kind === key).length
  }
  const profiles = { asr: slice.asr.profiles, ai: slice.ai.profiles, tts: slice.tts.profiles }
  const shown: HistoryItem[] = !items
    ? []
    : tab === 'all'
      ? items
      : items.filter((item) => item.kind === tab)

  // 占多少地方这件事跟当前选中的标签无关：数的是整本账，不是这一屏。
  // 留住的那侧不自动修剪，所以「一共占多大」必须由这一栏自己说出口。
  const keptRows = (items ?? []).filter((item) => item.keptProduct || item.keptDraft)
  const keptTotalBytes = keptRows.reduce((sum, item) => sum + item.keptBytes, 0)
  const biggestKept = keptRows.reduce<HistoryItem | null>(
    (max, item) => (max === null || item.keptBytes > max.keptBytes ? item : max),
    null,
  )

  return (
    <div
      className={`history-drawer${open ? '' : ' history-drawer--hidden'}`}
      inert={!open}
      role="complementary"
      aria-label="历史记录"
    >
      <div className="history-panel">
        <div className="history-panel__header">
          <span className="history-panel__title">历史记录</span>
          <button
            type="button"
            className="history-panel__ghost"
            onClick={() => void refresh()}
            disabled={loading}
            title={loading ? '正在读盘' : '重新读一遍磁盘上那本账'}
          >
            <RotateCw size={12} className={loading ? 'animate-spin' : undefined} />
            {loading ? '读取中' : '刷新'}
          </button>
          <button
            type="button"
            className="history-panel__ghost"
            onClick={() => setOpen(false)}
            title="收起这一栏（缩回标题栏那颗图标）"
          >
            <X size={12} />
            关闭
          </button>
        </div>

        {/* 读不出来时不摆标签：三个 0 会替用户认定「他没跑过作业」，而真相是这本账此刻读不动 */}
        {items && (
          <div className="history-tabs">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`history-tabs__item${tab === entry.key ? ' history-tabs__item--active' : ''}`}
                onClick={() => {
                  // 切走这一类，挂在某一行下面的二次确认气泡也就没了落脚点——跟着收掉，
                  // 否则换回原类时那颗「删除」还张着，而用户已经看过别的了
                  setConfirmingId('')
                  setTab(entry.key)
                }}
              >
                {entry.label}
                <span className="history-tabs__count">{countOf(entry.key)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="history-panel__list">
          {items === null ? (
            <p className="history-panel__state">
              {/* 读不出来 ≠ 没跑过作业。把这两句折成一句，等于替用户忘掉他跑过什么 */}
              {loading ? '正在读这一本账…' : error || '历史记录现在读不出来，先别改它（详情看应用日志）'}
            </p>
          ) : shown.length === 0 ? (
            <p className="history-panel__state">
              {tab === 'all'
                ? '还没有记录。转写、下载或字幕配音跑完一次，就会在这里出现一行。'
                : `这一类还没有记录，切回「全部」或跑一次${KIND_LABEL[tab]}。`}
            </p>
          ) : (
            shown.map((item) => {
              const state = keepState(item, jobId, hasSegments)
              const { row, title } = summaryOf(item, profiles)
              const busy = busyId === item.id
              const isConfirming = confirmingId === item.id
              return (
                <div key={item.id} className={`history-row${item.id === jobId ? ' history-row--current' : ''}`}>
                  <div className="history-row__title" title={item.name}>
                    {/* 选中某一类时，每一行盖同一枚章是噪音；只有「全部」需要它来分辨种类 */}
                    {tab === 'all' && <span className="history-row__chip">{KIND_LABEL[item.kind]}</span>}
                    <span className="history-row__name">{item.name}</span>
                  </div>
                  <div className="history-row__meta" title={title}>
                    {row}
                  </div>
                  <div className="history-row__actions">
                    <label
                      className={`history-row__keep${state.canKeep ? '' : ' history-row__keep--disabled'}`}
                      title={
                        state.why ||
                        (state.kept
                          ? '这份已经复制进应用数据目录，取消勾选就删掉它（记录本身留着）'
                          : '复制一份到应用数据目录，不会被自动清理')
                      }
                    >
                      <input
                        type="checkbox"
                        checked={state.kept}
                        disabled={!state.canKeep || busy}
                        onChange={(event) => {
                          if (event.target.checked) void keep(item.id)
                          else void unkeep(item.id)
                        }}
                      />
                      <BookmarkCheck size={12} />
                      {state.label}
                    </label>
                    {(item.keptProduct || item.keptDraft) && (
                      <button
                        type="button"
                        className="history-row__btn"
                        disabled={busy}
                        onClick={() => void reveal(item.id)}
                        title="在访达／资源管理器里选中留住的这一份"
                      >
                        <FolderOpen size={12} />
                        显示
                      </button>
                    )}
                    <button
                      type="button"
                      className="history-row__btn"
                      disabled={busy}
                      onClick={() => setConfirmingId(item.id)}
                    >
                      <Trash2 size={12} />
                      删除
                    </button>
                  </div>
                  {isConfirming && (
                    <div className="history-row__pop" ref={popRef} role="dialog" aria-modal="false">
                      <span className="history-row__pop-text">
                        删掉这一条？
                        {item.keptProduct || item.keptDraft
                          ? '它留住的那一份跟着一起没，撤不回来。'
                          : '这条只有一行元信息，删了就找不回当时那套参数。'}
                      </span>
                      <span className="history-row__pop-actions">
                        <button type="button" className="history-row__btn" onClick={() => setConfirmingId('')}>
                          <X size={12} />
                          取消
                        </button>
                        <button
                          type="button"
                          className="history-row__danger"
                          disabled={busy}
                          onClick={async () => {
                            await remove(item.id)
                            setConfirmingId('')
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
            })
          )}
        </div>

        <div className="history-panel__footer">
          <p className="history-panel__hint">
            没勾「留住」的产物放在临时目录，超过 24 小时会被清掉；记录本身最多留 200
            条，超了先删最老的「什么都没留住」那一条。
          </p>
          {keptRows.length > 0 && (
            <p className="history-panel__hint">
              留住了 {keptRows.length} 份，一共 {formatBytes(keptTotalBytes)}
              {keptTotalBytes >= KEPT_WARN_BYTES && biggestKept && biggestKept.keptBytes > 0
                ? `，占最多的是「${biggestKept.name}」（${formatBytes(biggestKept.keptBytes)}）`
                : ''}
              。勾了「留住」的东西这一版不会自动清理，要腾地方就在对应那一行点「删除」。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
