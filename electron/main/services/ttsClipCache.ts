/**
 * 配音片段缓存（#362）
 *
 * 一句文本 + 一套「怎么念」的参数 = 一个文件。下一次同一套参数再念同一句，直接复用这条音频，
 * 不再调接口、不再花钱。理由在界面上看不见：一条 300 段的稿子改了 3 个字再点「开始配音」，
 * 今天会烧掉 300 次调用，而用户真实的工作顺序恰恰是「出一版 → 逐段改字 → 再出音」。
 *
 * 三件设计上的事，每件都对着一个坑：
 *
 * ① 键里装的是**整条作废判据**那几维（档 / 厂商或本地引擎 / 模型 / 音色 / 倍速），
 *    外加云端那一路的接口地址与豆包那格的资源编号。少一维就会出现「换了音色，只有没重跑的那几段
 *    是新音色」——一条串音色的音轨比整条重烧贵得多。apiKey 故意**不在**键里：换 Key 不改听感，
 *    算进去等于让用户换个账号就白扔一整份缓存；而且也不该让密钥串参与任何文件名派生。
 * ② 落点是 userData，不是 `transcribe-` 临时目录（见 userDataStore 里 ttsClipCacheDir 那段）。
 *    落在临时前缀下面等于每次启动清扫把缓存清空，代码写完一次复用都不会发生。
 * ③ 音频与那份 `.json` 是元数据是两个文件，**先落音频、后写元数据**。元数据只是「不用再 ffprobe
 *    一遍」的便利，读不出来就当不知道、重新探一次再补上——绝不因为元数据坏了就重花一次接口的钱。
 *
 * 缓存是不可丢弃的派生物，不是交付物：所以它也不进 records 那层（那层归「用户勾了才留」）。
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ttsClipCacheDir } from './userDataStore'
import type { TTSConfig } from './ttsService'

/**
 * 键的形状版本。改动上面那几维的任何含义时升它，让老文件自然失配——
 * 宁可让用户重跑一次，也不要拿旧形状解释出来的键去认新参数下的音频。
 */
const KEY_VERSION = 'v1'

/** 元数据里记的那点东西：字节数只是给统计用，时长是给铺轴与结果卡用 */
export interface ClipMeta {
  duration: number
  bytes: number
}

/** 这一档的产物是什么容器：云端那一路固定 mp3，本地 sidecar 固定 wav（与两处写盘的名字同源） */
export function clipFormat(config: TTSConfig): 'mp3' | 'wav' {
  return config.engine === 'local' ? 'wav' : 'mp3'
}

/**
 * 一段文本在一套参数下的身份。
 *
 * 逐维取值按档分叉：本地档不看厂商、模型、接口地址与资源编号（它连 Key 都没有），
 * 那几格一律留空串，于是「本地档换云端档」必然换键，而「本地档改云端模型」这种不相干的改动
 * 不会把本地缓存整体判死。文本走 trim——合成用的本来就是 trim 过的那一份，
 * 键和产物必须是同一句文本，否则「键里有空格、请求里没空格」会把同一段判成两段。
 */
export function clipFingerprint(config: TTSConfig, text: string): string {
  const local = config.engine === 'local'
  const parts = [
    KEY_VERSION,
    local ? 'local' : 'cloud',
    local ? String(config.localEngine || '') : String(config.vendor || ''),
    local ? '' : String(config.apiBase || '').trim().toLowerCase(),
    local ? '' : String(config.model || '').trim(),
    local ? '' : String(config.resourceId || '').trim(),
    String(config.voice || '').trim(),
    String(config.speed ?? 1),
    text.trim(),
  ]
  // 分隔符用一个不可能出现在这些格子里的字符：地址、模型名、音色 id 都可能出现 '-' 或 '/'
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function audioPathFor(fingerprint: string, ext: string): string {
  return join(ttsClipCacheDir(), `${fingerprint}.${ext}`)
}

function metaPathFor(fingerprint: string): string {
  return join(ttsClipCacheDir(), `${fingerprint}.json`)
}

/** 命中结果：元数据可能没读出来（老条目、写一半被强杀），那时 duration 交回调用方去探 */
export interface CachedClip {
  filePath: string
  bytes: number
  meta: ClipMeta | null
}

/**
 * 查一条现成的片段。任何「读不到」都回 null——文件不在、目录还没建过、 stat 出怪错，
 * 在缓存这一层的语义都是「当它没有」，调用方照原路合成一次即可。
 * 缓存这一层永远不该让一次配音失败。
 */
export async function lookupCachedClip(fingerprint: string, ext: string): Promise<CachedClip | null> {
  const filePath = audioPathFor(fingerprint, ext)
  let size = 0
  try {
    const info = await stat(filePath)
    // 0 字节不是「一条很短的音频」，是上一次写到这里就没写完；当作没有，重花一次钱比放一条坏音频进轨便宜
    if (!info.isFile() || info.size === 0) return null
    size = info.size
  } catch {
    return null
  }
  let meta: ClipMeta | null = null
  try {
    const parsed = JSON.parse(await readFile(metaPathFor(fingerprint), 'utf8')) as Partial<ClipMeta>
    if (typeof parsed?.duration === 'number' && typeof parsed?.bytes === 'number') {
      meta = { duration: parsed.duration, bytes: parsed.bytes }
    }
  } catch {
    meta = null
  }
  return { filePath, bytes: size, meta }
}

/** 补写元数据（探出来的时长回填用）。失败不报出去：它只是省下一次 ffprobe，不影响这条音频能用 */
export async function writeClipMeta(fingerprint: string, meta: ClipMeta): Promise<void> {
  try {
    await writeFile(metaPathFor(fingerprint), JSON.stringify(meta), 'utf8')
  } catch {
    /* 元数据没落成，下次复用多探一次时长，仅此而已 */
  }
}

/**
 * 把刚合成好的那条收进缓存：先落音频、后写元数据。
 *
 * 移动而不是复制：这批的临时目录随后要被 releaseBatch 删掉，留着副本就等于同一份音频占两处。
 * 跨设备时 rename 会抛 EXDEV（userData 与 tmpdir 在某些机器上不在同一卷），那时退回复制加删源。
 */
export async function storeClip(
  srcPath: string,
  fingerprint: string,
  ext: string,
  meta: ClipMeta
): Promise<CachedClip> {
  const filePath = audioPathFor(fingerprint, ext)
  try {
    await mkdir(ttsClipCacheDir(), { recursive: true })
    try {
      await rename(srcPath, filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await copyFile(srcPath, filePath)
      await unlink(srcPath).catch(() => {})
    }
  } catch {
    // 收不进缓存不影响这一批：产物还在临时目录里，照常能铺轴，只是下一轮没得复用
    const info = await stat(srcPath).catch(() => null)
    return { filePath: srcPath, bytes: info?.size ?? meta.bytes, meta }
  }
  await writeClipMeta(fingerprint, meta)
  return { filePath, bytes: meta.bytes, meta }
}

export interface ClipCacheStats {
  bytes: number
  clips: number
}

/**
 * 缓存占多少。元数据不计——那几十字节的一堆 json 报上去只会让那个数字读起来像猜的。
 * 目录不存在（从没配过音）就是 0，不报错。
 */
export async function clipCacheStats(): Promise<ClipCacheStats> {
  let names: string[]
  try {
    names = await readdir(ttsClipCacheDir())
  } catch {
    return { bytes: 0, clips: 0 }
  }
  let bytes = 0
  let clips = 0
  for (const name of names) {
    if (name.endsWith('.json')) continue
    const info = await stat(join(ttsClipCacheDir(), name)).catch(() => null)
    if (!info?.isFile()) continue
    bytes += info.size
    clips += 1
  }
  return { bytes, clips }
}

/**
 * 整层清掉。跑着的那一批由调用方先拦住（正在配音时删缓存，会让后面段落的复用与统计糊在一起），
 * 这里只管删目录、回 freed 字节数给界面说人话。
 */
export async function clearClipCache(): Promise<number> {
  const { bytes } = await clipCacheStats()
  await rm(ttsClipCacheDir(), { recursive: true, force: true }).catch(() => {})
  return bytes
}
