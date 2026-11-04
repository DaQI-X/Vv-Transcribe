/**
 * 历史记录（#247）：一次作业跑完了，给用户留一笔账
 *
 * 这一层只做「记账」和「按用户的意思留住副本」两件事，界面怎么摆、什么时候刷新都不在这。
 * 三条口径是本条的边界，都在代码里而不是只在计划里：
 *
 * 1. **自动落的只有元信息**。稿本正文不进磁盘，除非用户在那一条上勾了「留住这份」——
 *    「日志与崩溃上报绝不带原文」（#281）好不容易变成机制，别从历史记录这道门再把原文漏出去。
 *    代价要说在前面：正文只活在渲染层那份 store 里（全仓只有主题落 localStorage），
 *    所以「留住全文」这件事只有在这次会话还开着的时候做得了，隔重启再翻那条记录已经没稿子了。
 * 2. **三个 profileId，不是一个**。#222 定的是「每能力各一条列表」，一次作业三家各自用自己
 *    列表里的那一条，记 1 个 id 答不出「那期节目用哪套配置跑的」。视频下载那条链路
 *    一个设置 getter 都不读（urlDownloader 里 grep 不到 getASRConfig/getAIConfig/getTTSConfig），
 *    所以这一列**必须可空**，别当必填。
 * 3. **留住的份数不设自动上限**。产物什么时候占盘、占多少，由用户那一勾决定；
 *    超限就自动删最老的整份，等于替用户丢掉他点名要留的文件——这一条不写进代码。
 *    元信息那侧有上限（见 MAX_RECORDS），但修剪只动「什么都没留住」的行，见 pruneRows()。
 *
 * 与临时目录清扫的衔接是一条硬约束：`sweepStaleMediaTempDirs` 按 `transcribe-` 前缀
 * 加 24 小时删目录，而配音轨就在那个前缀下面（ttsService 的批次目录）。所以「留住」的副本
 * 只能落 recordsDir()，落在别处就是把自己刚保住的东西交给清扫。
 */
import { randomUUID } from 'node:crypto'
import { rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { logger } from './logger'
import {
  atomicCopy,
  atomicWriteBytes,
  atomicWriteJson,
  CORRUPT_HISTORY_PREFIX,
  errnoDetail,
  fileStamp,
  pruneOlderCopies,
  readJsonFile,
  recordsDir,
} from './userDataStore'

const TAG = 'History'

/** 账本文件名与「留住」副本的子目录，都钉在 recordsDir() 这一层下面 */
const DOC_FILE = 'history.json'
const KEEP_DIR = 'keep'

/** 留住的稿子正文都叫这个名字：产物跟原件走，正文没有「原件名」可跟 */
const DRAFT_NAME = 'draft.txt'

/**
 * 元信息一条约 200 字节，200 条不到 40 KB，占地方的从来不是这一列。
 * 这个数字暂时是常量而不是设置项：它只管「什么都没留住」的纯元信息行，为用户要留的文件
 * 兜底的机制是单条删除，不是淘汰；而为它开一个设置字段要动 settings 的 schema——
 * 那套形状 1.0.9 刚定完，不该为这种收益很低的可选项再改一遍。
 */
export const MAX_RECORDS = 200

/** 解不开的账本改名留档，同一种坏最多留 3 份（坏盘的话每次启动都会留一份） */
const KEEP_CORRUPT_COPIES = 3

/** 这份账本的格式版本。比它高的文件既不改写、也不改名——本版本读不懂它，不代表它坏了 */
export const HISTORY_SCHEMA_VERSION = 1

export type HistoryKind = 'transcribe' | 'download' | 'voice'

/** 一次作业各自用了哪条方案；三个都可空（空＝这一档当时没有「当前使用」，下载链路整列都是空） */
export interface HistoryProfiles {
  asr: string | null
  ai: string | null
  tts: string | null
}

/** 转写：素材的提取音频在完成点就被 cleanupTemp 删了，所以这一档没有产物可留，只能留稿子 */
export interface TranscribeDetail {
  kind: 'transcribe'
  provider: string
  model: string
  language: string
  segments: number
  /** 素材时长（秒）；ffprobe 没报出来就是 null，不猜 */
  durationSec: number | null
  /** 整条链路耗时（毫秒）；没计时就是 null */
  elapsedMs: number | null
}

/** 视频下载：这条链路唯一读不出方案 id 的一类，profileIds 三个都记 null */
export interface DownloadDetail {
  kind: 'download'
  /** yt-dlp 给的媒体种类（video/audio），与记录自己的 kind 分开命名，别混成一个 */
  mediaKind: string
  durationSec: number | null
  height: number | null
  sizeBytes: number
}

/** 配音：engine/model/voice 记的是这次实际用的那一份，不是设置里现在的 */
export interface VoiceDetail {
  kind: 'voice'
  engine: string
  model: string
  voice: string
  speed: number
  /** 这一段数成了的；界面把它跟 queueTotal 一起摆，「跑了 12/300 段」一眼就能看出来是没配完 */
  clips: number
  /** 这批提交了多少段（含失败与被跳过的），取消和熔断都发生在它中间 */
  queueTotal: number
  trackBytes: number
  trackDuration: number
  /** 因为比字幕槽位长而被往后推的段数，界面上那句「比原片长了多少」要用 */
  pushedCount: number
}

export type HistoryDetail = TranscribeDetail | DownloadDetail | VoiceDetail

export interface HistoryRecord {
  /** 作业 id（转写/配音是 jobId，下载是会话 id）；没有就自己生成一个 */
  id: string
  /** 完成那一刻的 ISO 时间，字典序＝时间序 */
  at: string
  /**
   * 这一行给用户看的名：转写与下载是那个产物的文件名（与「留住」落盘的名字同一个），
   * 配音是界面报上来的稿子来源名（主进程只收到正文，它自己起不出这个名）。
   * 只存名字：整条路径会被 #281 那道闸门收成文件名，存了也没用。
   */
  name: string
  profiles: HistoryProfiles
  detail: HistoryDetail
  /**
   * 这次作业的产物在主进程这边的原始位置。**只在主进程用**：界面向记录要 id，
   * 「留住」时由这里去 stat 原件——渲染层报上来的路径一律不信（与 voiceTracks 那张表同源）。
   */
  source: string | null
  /**
   * 勾了才有的两份副本。存的是 `keep/<id>/` **下面的文件名**，不是路径：
   * 分隔符一进账本，mac 上写进去的 `keep/x/y.mp3` 到 Windows 上就拼不出东西来了。
   */
  kept: { product: string | null; draft: string | null }
}

/** 给界面的那一面：路径不出主进程，界面只需要「有没有」和「还在不在」 */
export interface HistoryItem {
  id: string
  at: string
  name: string
  kind: HistoryKind
  profiles: HistoryProfiles
  detail: HistoryDetail
  keptProduct: boolean
  keptDraft: boolean
  /** 原件此刻还在不在盘上——24 小时清扫跑过之后就是 false，界面据此说「只能重跑」 */
  productAvailable: boolean
}

export interface NewHistoryRecord {
  id?: string
  at?: string
  name: string
  profiles: HistoryProfiles
  detail: HistoryDetail
  source?: string | null
}

export interface HistoryResult {
  ok: boolean
  /** 给用户看的那句话由调用方（handler/界面）措辞，这里只说成没成、为什么没成 */
  error?: string
}

export interface HistoryListResult {
  /**
   * null＝这本账此刻拿不到（读不动、或它比这一版新）；[] 是「读过了，确实一条都没有」。
   * 把前者写成后者就是 #277 那个坑：界面显示「还没有过记录」，用户以为自己没跑过作业。
   */
  items: HistoryItem[] | null
  error: string | null
}

/**
 * 内存里那本账。null＝还没读过盘；[]＝读过，确实一条都没有。
 * 后面所有写盘都从这份改，所以每个入口都得先进 runExclusive。
 */
let cache: unknown[] | null = null

/**
 * 读盘读不动（不是「没有」，是「拿不到」）时置起来，写盘一律拦住。
 * 这就是 #277 那个坑的机制版：把「读不出来」当「用户还没记过」，下一次写入就把整本账盖掉了。
 */
let writeBlocked = false

/** 写盘串行：转写和下载可能同一秒完成，两条各自读-改-写就会丢一条 */
let writeChain: Promise<unknown> = Promise.resolve()

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => undefined)
  return next
}

function docFile(): string {
  return join(recordsDir(), DOC_FILE)
}

/** 一条记录留住的那些文件都在这层下面，删的时候连目录一起收 */
function keepDir(id: string): string {
  return join(recordsDir(), KEEP_DIR, safeId(id))
}

function keepFile(id: string, name: string): string {
  return join(keepDir(id), name)
}

/** id 是我们自己发的 UUID，路径段仍要过一遍：手改坏的账本里塞一个 `../../x` 不能就顺着写出目录 */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

/**
 * 留住的产物按原件的名字摆，用户在文件夹里才认得出是哪一条。
 * 名字来自 yt-dlp 的标题或配音的文件名，Windows 那套非法字符（`: ? * " < > |` 和反斜杠）
 * 在 macOS 上全都能存在，所以清洗不是洁癖——同一份账本在两台机器上要落得出同一个路径。
 */
function safeName(name: string): string {
  const cleaned = basename(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[.\s]+$/, '')
    .slice(0, 120)
  return cleaned === '' ? 'product' : cleaned
}

/**
 * 方案 id 落账只有两种形状：一条真 id，或 null。
 * `resolveProfileId` 报「这一档当前没有方案在用」用的是空串（日志里就照 `profileId: ''` 落，那是它自己的口径），
 * 但那一种状态进了账本得写成 null——同一件事在一本账里既可能记成 `""` 又可能记成 `null`，
 * 日后照 `!== null` 读这一列的人会读错。
 */
function profileIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 读那本账，并把四种读盘结局分开处理（与 settings 同一套）。
 * 返回 null 表示「读不动」，调用方必须停下这次写。
 */
async function loadRows(): Promise<unknown[] | null> {
  if (cache && !writeBlocked) return cache
  const result = await readJsonFile<Record<string, unknown>>(docFile())
  if (result.status === 'ok') {
    const doc = result.value
    const version = Number(doc.schemaVersion)
    // 比这一版新的账本：读不懂不等于坏了，把它当坏的就会抹掉更新版本正在用的东西。
    // 这里只停写，不动文件，也不改名。
    if (Number.isFinite(version) && version > HISTORY_SCHEMA_VERSION) {
      writeBlocked = true
      logger.warn(TAG, 'Ledger newer than this build', { version })
      return null
    }
    const rows = Array.isArray(doc.records) ? doc.records : null
    if (!rows) {
      await setAside('records 那一列不是一个列表')
      cache = []
      return cache
    }
    writeBlocked = false
    cache = rows
    return rows
  }
  if (result.status === 'missing') {
    // 首次运行就是这样，这不是故障，报给界面只会吓到人
    writeBlocked = false
    cache = []
    return cache
  }
  if (result.status === 'corrupt') {
    await setAside(result.detail)
    cache = []
    return cache
  }
  writeBlocked = true
  logger.error(TAG, 'Ledger unreadable', { detail: result.detail })
  return null
}

/** 解不开的原件改名留档，再从空账本继续——它还在同一个目录里，只是换了个名字 */
async function setAside(detail: string): Promise<void> {
  const file = docFile()
  const name = `${CORRUPT_HISTORY_PREFIX}${fileStamp(new Date())}`
  try {
    await rename(file, join(recordsDir(), name))
    await pruneOlderCopies(CORRUPT_HISTORY_PREFIX, KEEP_CORRUPT_COPIES, recordsDir())
    logger.warn(TAG, 'Ledger unreadable, kept aside', { name, detail })
  } catch (err) {
    // 改名都没成：那连内容都拿不到，拦住写盘，别把猜出来的空账本盖到用户的东西上
    writeBlocked = true
    logger.error(TAG, 'Ledger could not be kept aside', { detail: errnoDetail(err) })
  }
}

async function writeRows(rows: unknown[]): Promise<void> {
  await atomicWriteJson(docFile(), { schemaVersion: HISTORY_SCHEMA_VERSION, records: rows })
  cache = rows
}

/**
 * 修剪：条数超上限时从**记账顺序的尾部**开始剪（新记录永远插在头上，所以尾部就是最早记的那笔），
 * 而且只剪什么都没留住的行。留住了产物或稿子的行不参与修剪——自动删掉用户点名要留的文件，
 * 比账本长一点严重得多。全都留住了就允许它超出上限：那条上限是「纯元信息」的卫生线，不是硬闸。
 * 看不懂的行也一律不剪：那一行我们不知道它有没有带着什么，剪它就是替用户做决定。
 */
function pruneRows(rows: unknown[]): unknown[] {
  if (rows.length <= MAX_RECORDS) return rows
  const out = [...rows]
  // 头上那一行是这次刚记的（新记录一律插在头上），它不参与修剪：
  // 记一笔又当场把它自己抹掉，等于用户跑完一次作业什么都没留下
  for (let i = out.length - 1; i >= 1 && out.length > MAX_RECORDS; i -= 1) {
    const row = toRecord(out[i])
    if (row && row.kept.product === null && row.kept.draft === null) {
      out.splice(i, 1)
    }
  }
  return out
}

/** 一行是不是我们这一版认得的记录；认不得的照常原样写回，只是不显示 */
function toRecord(row: unknown): HistoryRecord | null {
  const raw = row as Record<string, unknown>
  if (!raw || typeof raw !== 'object') return null
  const detail = raw.detail as Record<string, unknown> | undefined
  if (typeof raw.id !== 'string' || typeof raw.at !== 'string') return null
  if (!detail || (detail.kind !== 'transcribe' && detail.kind !== 'download' && detail.kind !== 'voice')) {
    return null
  }
  const profiles = raw.profiles as Record<string, unknown> | undefined
  const kept = raw.kept as Record<string, unknown> | undefined
  return {
    id: raw.id,
    at: raw.at,
    name: typeof raw.name === 'string' ? raw.name : '',
    profiles: {
      asr: profileIdOf(profiles?.asr),
      ai: profileIdOf(profiles?.ai),
      tts: profileIdOf(profiles?.tts),
    },
    detail: raw.detail as HistoryDetail,
    source: typeof raw.source === 'string' ? raw.source : null,
    kept: {
      product: typeof kept?.product === 'string' ? kept.product : null,
      draft: typeof kept?.draft === 'string' ? kept.draft : null,
    },
  }
}

/** 时间倒序：界面第一行就是刚跑完的那条 */
function byNewest(a: HistoryRecord, b: HistoryRecord): number {
  return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * 记一笔账。**从不抛错**：转写已经成功了，记账失败不能把它变成一次失败。
 * 返回 false 只用于日志，界面上不弹——用户不该因为「历史没记上」而以为稿子丢了。
 */
export async function addHistoryRecord(input: NewHistoryRecord): Promise<boolean> {
  try {
    return await runExclusive(async () => {
      const rows = await loadRows()
      if (!rows) return false
      const id = input.id && input.id.trim() !== '' ? input.id : randomUUID()
      // 同一个 id 再记一次算更新（重跑同一个 jobId 不该在账本里留下两行），但上一行留住的那几份
      // 要照搬过来：那一勾是用户点名的文件，引用一掉 keep/<id>/ 下面就只剩一份没人认领的东西，
      // 界面上还会显示成「没留住」——用户以为是自己取消的。
      const previous = rows.map(toRecord).find((row) => row?.id === id)
      const record: HistoryRecord = {
        id,
        at: input.at ?? new Date().toISOString(),
        name: input.name,
        profiles: {
          asr: profileIdOf(input.profiles.asr),
          ai: profileIdOf(input.profiles.ai),
          tts: profileIdOf(input.profiles.tts),
        },
        detail: input.detail,
        source: input.source ?? null,
        kept: previous?.kept ?? { product: null, draft: null },
      }
      const next = [record, ...rows.filter((row) => toRecord(row)?.id !== id)]
      await writeRows(pruneRows(next))
      logger.info(TAG, 'Record added', { id: record.id, kind: record.detail.kind })
      return true
    })
  } catch (err) {
    logger.warn(TAG, 'Record failed', { detail: errnoDetail(err) })
    return false
  }
}

/**
 * 「拿不到这本账」要说得出的一句话。三种原因（读不动、内容解不开又改不动名、它比这一版新）
 * 在界面上是同一件事：别改它。具体是哪一种在 app.log 里那三条各有的话里说得更准，
 * 这一句只负责不再把「读不出来」演成「你还没跑过作业」。
 */
const UNREADABLE = '历史记录现在读不出来，先别改它（详情看应用日志）'

/** 列出来给界面。看不懂的行不显示，但也不会被改写掉 */
export async function listHistory(): Promise<HistoryListResult> {
  try {
    const rows = await loadRows()
    // null 是「拿不到」，不是「没有」——这一格一旦被折成 []，界面就开始替用户记不起他跑过什么
    if (!rows) return { items: null, error: UNREADABLE }
    const records = rows.map(toRecord).filter((row): row is HistoryRecord => row !== null)
    records.sort(byNewest)
    const items: HistoryItem[] = []
    for (const record of records) {
      const productPath = record.kept.product ? keepFile(record.id, record.kept.product) : record.source
      items.push({
        id: record.id,
        at: record.at,
        name: record.name,
        kind: record.detail.kind,
        profiles: record.profiles,
        detail: record.detail,
        keptProduct: record.kept.product !== null,
        keptDraft: record.kept.draft !== null,
        // 已经留住的当然「有」；没留住的看原件还在不在——在，那一勾才点得动
        productAvailable: productPath === null ? false : await exists(productPath),
      })
    }
    return { items, error: null }
  } catch (err) {
    logger.warn(TAG, 'List failed', { detail: errnoDetail(err) })
    return { items: null, error: UNREADABLE }
  }
}

/**
 * 界面上那一颗「留住」：这一条能留的两样一起留——产物按主进程记着的那个原件搬进
 * records/keep/，稿子正文用这一刻调用方交进来的那一份。整段在一个排他块里、一次写盘：
 * 两份引用要么一起进账，要么都别进，免得界面那一勾亮成「留住了」而盘上只有一半。
 *
 * 已经另存过也照样搬产物——另存到哪是用户自己挑的，我们既不掌握它会不会被删，
 * 也不该把自己的账本押在那个路径上。代价是一份副本，界面上要说清「这是又存了一份」。
 */
export async function keepHistory(id: string, draftText?: string): Promise<HistoryResult> {
  const body = typeof draftText === 'string' ? draftText : ''
  try {
    return await runExclusive(async () => {
      const rows = await loadRows()
      if (!rows) return { ok: false, error: '历史记录读不出来，先别改它' }
      const index = rows.findIndex((row) => toRecord(row)?.id === id)
      if (index < 0) return { ok: false, error: '这条记录已经不在了' }
      const record = toRecord(rows[index]) as HistoryRecord
      const kept = { ...record.kept }
      let wrote = false
      /** 没能留住的那件事要说得出：原件被清扫收走时用户需要知道的是「只能重跑」，不是「没勾上」 */
      let missed: string | null = null

      // 已经留过的产物不再搬第二次：那份副本已经在 keep/ 下面了，再读原件只会撞上「原件早被清了」
      if (record.source !== null && record.kept.product === null) {
        if (await exists(record.source)) {
          const name = safeName(record.source)
          await atomicCopy(record.source, keepFile(record.id, name))
          kept.product = name
          wrote = true
        } else {
          missed = '原件已经被清掉了（临时目录只保 24 小时），只能重跑一次'
        }
      }
      // 正文只在这一刻从渲染层手里过桥：记账的时候它从没在盘上待过——那是「全文按需」这句的全部含义。
      // 已经留过稿子也照写一遍：用户可能是改过稿子之后再点这一勾的，留的该是他手上这一份。
      if (body.trim() !== '') {
        await atomicWriteBytes(keepFile(record.id, DRAFT_NAME), body)
        kept.draft = DRAFT_NAME
        wrote = true
      }

      if (!wrote) return { ok: false, error: missed ?? '这一条没有可以留住的东西' }
      const next = [...rows]
      next[index] = { ...record, kept }
      await writeRows(next)
      logger.info(TAG, 'Copies kept', { id, product: kept.product !== null, chars: body.length })
      // 留住了一半也照实说：稿子进了盘、产物没跟上，那句原因比一句「已留住」有用
      return missed ? { ok: false, error: missed } : { ok: true }
    })
  } catch (err) {
    logger.warn(TAG, 'Keep failed', { detail: errnoDetail(err) })
    return { ok: false, error: '这份东西没能留住' }
  }
}

/** 不留了：只删副本，记录本身留着（用户只是反悔，不是要抹掉这笔账） */
export async function dropHistoryCopies(id: string): Promise<HistoryResult> {
  try {
    return await runExclusive(async () => {
      const rows = await loadRows()
      if (!rows) return { ok: false, error: '历史记录读不出来，先别改它' }
      const index = rows.findIndex((row) => toRecord(row)?.id === id)
      if (index < 0) return { ok: false, error: '这条记录已经不在了' }
      const record = toRecord(rows[index]) as HistoryRecord
      // 副本只有产物与稿子两份，都在 keep/<id>/ 这一层下面，连目录一起收掉才不留空壳
      await rm(keepDir(record.id), { recursive: true, force: true }).catch(() => {})
      const next = [...rows]
      next[index] = { ...record, kept: { product: null, draft: null } }
      await writeRows(next)
      logger.info(TAG, 'Copies dropped', { id })
      return { ok: true }
    })
  } catch (err) {
    logger.warn(TAG, 'Drop copies failed', { detail: errnoDetail(err) })
    return { ok: false, error: '没能清掉这份副本' }
  }
}

/**
 * 删掉一条记录，连同它留住的东西一起。
 * 这是用户手上唯一能把「自己跑过什么」这条痕迹抹干净的入口，所以文件也必须跟着没——
 * 只从账本里摘掉一行，records/keep 下面会留下一个没人认领的音轨，比记着更糟。
 */
export async function deleteHistoryRecord(id: string): Promise<HistoryResult> {
  try {
    return await runExclusive(async () => {
      const rows = await loadRows()
      if (!rows) return { ok: false, error: '历史记录读不出来，先别改它' }
      const record = toRecord(rows.find((row) => toRecord(row)?.id === id))
      if (!record) return { ok: false, error: '这条记录已经不在了' }
      await rm(keepDir(record.id), { recursive: true, force: true }).catch(() => {})
      const next = rows.filter((row) => toRecord(row)?.id !== record.id)
      await writeRows(next)
      logger.userAction('History record deleted', { id, kind: record.detail.kind })
      return { ok: true }
    })
  } catch (err) {
    logger.warn(TAG, 'Delete failed', { detail: errnoDetail(err) })
    return { ok: false, error: '这条记录没删掉' }
  }
}

/**
 * 「在文件夹里显示」要用的那一份：返回这一条留住的第一个副本在主进程这边的绝对位置。
 * 三种显示不了的情况各给各的一句话——它们在界面上长得一样（那颗按钮点了没反应），
 * 用户能做的事却完全不同：记录没了只能重跑，没勾过那一勾是还没留，
 * 副本不在盘上说明有人在我们之外动过 records/keep/。
 * **路径只交给 handler**，绝不跨 IPC 回给渲染层（与 HistoryRecord.source 同一条边界）。
 */
export async function resolveHistoryKeptFile(
  id: string
): Promise<{ path: string | null; error: string | null }> {
  const rows = await loadRows()
  if (!rows) return { path: null, error: UNREADABLE }
  const record = toRecord(rows.find((row) => toRecord(row)?.id === id))
  if (!record) return { path: null, error: '这条记录已经不在了' }
  const name = record.kept.product ?? record.kept.draft
  if (!name) return { path: null, error: '这一条还没有留住的副本' }
  const path = keepFile(record.id, name)
  if (!(await exists(path))) return { path: null, error: '留住的副本已经不在盘上了' }
  return { path, error: null }
}

/** 模块级状态清干净，只给测试用（与 settingsService 那个测试的换目录需求同源） */
export function _resetHistoryForTests(): void {
  cache = null
  writeBlocked = false
  writeChain = Promise.resolve()
}
