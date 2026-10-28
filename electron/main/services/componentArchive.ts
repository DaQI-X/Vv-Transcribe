/**
 * tar.gz 归档的流式解包（#230 组件按需下载器的一部分）
 *
 * 为什么自己写而不用系统 tar / 第三方库：
 * - 调系统 tar 在 Windows 上要赌「System32\tar.exe（bsdtar）存在且行为一致」，
 *   这类没实测过的假设我们已经吃过一次教训（随包 ffmpeg 的 libmp3lame）；
 * - 加一个 zip/tar 依赖 = 公开仓库多一条运行时供应链输入，而它只为解压我们自己打的包。
 * 这里只用 node:zlib 与 node:fs，逻辑是纯粹的格式解析，可以离线拿真归档逐字节对账。
 *
 * 支持范围（也只支持这些，遇到别的直接失败，不做「跳过继续」）：
 * - ustar / GNU 头部，GNU 长名（typeflag 'L'）与 pax 扩展头里的 name= 记录；
 * - 普通文件（'0'、'\0'、'7'）与目录（'5'）；'x'/'g'/'K' 是元数据，读完丢掉。
 * - 符号链接、硬链接、设备节点一律拒绝：模型目录里没有这些东西，它们出现的唯一合理解释是
 *   归档被人换过，而链接正是「把写操作指到目录外面」那条路。
 *
 * 每条头部的校验和都比；不匹配就当归档坏了，不猜哪个字段是对的。
 */
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'

const BLOCK = 512

/** 进度节流：4MB 报一次。解 129MB 归档会回来上百次，每块都推等于给 IPC 刷屏 */
const REPORT_EVERY = 4 << 20

/** 一条归档里的文件数上限。VITS 17 个、Kokoro 连 espeak-ng-data 也就一百多个，5000 是十倍余量 */
const DEFAULT_MAX_FILES = 5000

export interface ExtractedEntry {
  /** 相对 destDir 的路径，用 / 分隔 */
  path: string
  bytes: number
}

export interface ExtractOptions {
  /** 解出来的总字节数上限。归档指纹只能证明「和清单那条一致」，证明不了「不会撑爆磁盘」 */
  maxBytes?: number
  maxFiles?: number
  /** 进度分母。归档里没有这个数，由调用方按清单声明的解压后体积给 */
  expectedBytes?: number
  /** 关键文件的期望指纹（相对路径 → 小写十六进制 sha256）。边写边算，不用第二遍读那 121MB 的 onnx */
  expectedHashes?: Record<string, string>
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export interface ExtractResult {
  entries: ExtractedEntry[]
  bytes: number
  /** 真的比过指纹的文件数：界面与日志要说清「查了几个」，而不是含糊一句「校验通过」 */
  verified: number
}

export class ArchiveError extends Error {}

/** 定长字段取字符串：未用的字节可能是 \0 也可能是空格，GNU 还会把末尾填 NUL */
function field(header: Buffer, start: number, len: number): string {
  const slice = header.subarray(start, start + len)
  let end = 0
  while (end < slice.length && slice[end] !== 0) end++
  return slice.subarray(0, end).toString('utf8').trim()
}

/** 八进制数值字段：GNU 允许末尾空格、pax 允许 0x 十六进制，两种都得收，否则同一个 tar 打出来的包解不开 */
function numeric(header: Buffer, start: number, len: number, what: string): number {
  const raw = field(header, start, len)
  if (raw === '') return 0
  const hex = raw.startsWith('0x') || raw.startsWith('-0x')
  const value = hex ? Number.parseInt(raw, 16) : Number.parseInt(raw, 8)
  if (!Number.isFinite(value) || value < 0) throw new ArchiveError(`${what} 字段读不出数值（"${raw}"）`)
  return value
}

/** 校验和字段本身的写法是「6 位八进制 + NUL + 空格」，求和时这一段整体按空格算 */
function checkHeaderChecksum(header: Buffer): void {
  const stated = field(header, 148, 8)
  const statedValue = Number.parseInt(stated || '0', 8)
  if (!Number.isFinite(statedValue)) throw new ArchiveError(`头部校验和字段不合法（"${stated}"）`)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  if (sum !== statedValue) {
    throw new ArchiveError(
      `头部校验和不匹配（算得 ${sum}，头部写着 ${statedValue}）——归档损坏或被人改过`
    )
  }
}

/**
 * 名字规范化 + 安全检查：清单与归档都按外部输入对待，这一步是唯一不让写操作跑到目录外面的口子。
 * 返回 null 表示这条不能用；返回 '' 表示「就是归档根目录那一条」（bsdtar 打 '.' 时会写出来）。
 *
 * 挡掉的形式：绝对路径（/ 或 C: 开头）、任何一段 ..、以及反斜杠——\ 在 Windows 是分隔符、
 * 在 POSIX 只是文件名里的一个字符，两边都留这种歧义迟早变成「解出来一个跑出去的文件」。
 * ./ 与空段是 tar 的常规写法（./dict/ 这种目录项），剥掉不算越权，因为绝对路径已经在前面挡住了。
 */
function normalizeName(name: string): string | null {
  if (name === '') return null
  if (name.includes('\\')) return null
  if (name.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(name)) return null
  const kept: string[] = []
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    kept.push(segment)
  }
  return kept.join('/')
}

/** 从流里按块取数据的游标。归档是几百 MB，全读进内存不可接受 */
class BlockReader {
  private buffer: Buffer = Buffer.alloc(0)
  /** 不用构造参数属性：那会让这个文件在 node --experimental-strip-types 下跑不起来，而离线验证靠它 */
  private readonly next: () => Promise<IteratorResult<Buffer, undefined>>

  constructor(next: () => Promise<IteratorResult<Buffer, undefined>>) {
    this.next = next
  }

  /** 保证缓冲区里至少 n 字节；到 EOF 还不够就 false */
  async ensure(n: number): Promise<boolean> {
    while (this.buffer.length < n) {
      let step: IteratorResult<Buffer, undefined>
      try {
        step = await this.next()
      } catch (err) {
        // gzip 流半路断（下载被截断、归档本身坏了）时 zlib 抛的是 "unexpected end of file" 这类原话，
        // 直接冒到界面上像程序自己坏了，得换成「这份包不完整，重新下载」
        const message = err instanceof Error ? err.message : String(err)
        throw new ArchiveError(
          `归档读不下去了（${message}）。多半是没下完或包本身坏了，重新下载一次`
        )
      }
      if (step.done) return false
      const chunk = step.value as Buffer
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    }
    return true
  }

  /** 取走前 n 字节，调用前必须 ensure 够 */
  take(n: number): Buffer {
    const out = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    return out
  }

  /** 丢掉 n 字节（读填充与元数据体用），不够就 false */
  async skip(n: number): Promise<boolean> {
    if (!(await this.ensure(n))) return false
    this.buffer = this.buffer.subarray(n)
    return true
  }
}

/** pax 扩展头是「<len> <key>=<value>\n」的串联，我们只关心能改名字的 name= */
function paxName(data: Buffer): string | null {
  let text = data.toString('utf8')
  while (text.length > 0) {
    const space = text.indexOf(' ')
    if (space < 0) return null
    const len = Number.parseInt(text.slice(0, space), 10)
    if (!Number.isFinite(len) || len <= space + 1) return null
    const record = text.slice(space + 1, len - 1)
    text = text.slice(len)
    const eq = record.indexOf('=')
    if (eq >= 0 && record.slice(0, eq) === 'name') return record.slice(eq + 1)
  }
  return null
}

/**
 * 解一个 .tar.gz 到 destDir。
 *
 * 失败语义：任何一步抛错就停，已写的半截留给调用方按 .partial 整体删除，这里不逐条回滚。
 * 只往 destDir 里写，destDir 之外一个字节都不碰。
 */
export async function extractTarGz(
  archivePath: string,
  destDir: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const expected = options.expectedHashes ?? {}
  const total = options.expectedBytes ?? 0
  const root = resolve(destDir)
  await mkdir(root, { recursive: true })

  const stream = createReadStream(archivePath).pipe(createGunzip())
  const iterator = stream[Symbol.asyncIterator]()
  const src = new BlockReader(() => iterator.next())
  const entries: ExtractedEntry[] = []
  const hashes = new Map<string, string>()
  let totalBytes = 0
  let sinceReport = 0
  /** GNU 长名：下一条头部的名字由这一段数据给出 */
  let pendingName: string | null = null

  for (;;) {
    if (options.signal?.aborted) throw new ArchiveError('解包已取消')
    if (!(await src.ensure(BLOCK))) break
    const header = src.take(BLOCK)
    // 全零块是归档结束标记；尾部还可能补到 10240 的倍数，所以见到第一个零块就停
    if (header.every((byte) => byte === 0)) break
    checkHeaderChecksum(header)

    const typeflag = String.fromCharCode(header[156] || 0x30)
    const size = numeric(header, 124, 12, 'size')
    const padded = Math.ceil(size / BLOCK) * BLOCK
    const rawName = pendingName ?? field(header, 0, 100)
    // ustar 的长路径靠 prefix 字段拆出来，只有没被 'L'/pax 覆盖时才拼
    const prefix = pendingName ? '' : field(header, 345, 155)
    pendingName = null

    if (typeflag === 'L' || typeflag === 'K' || typeflag === 'x' || typeflag === 'g') {
      if (!(await src.ensure(padded))) throw new ArchiveError('归档在扩展头处被截断')
      const data = src.take(size)
      await src.skip(padded - size)
      if (typeflag === 'L') pendingName = data.toString('utf8').replace(/\0+$/g, '')
      else if (typeflag === 'x') {
        const name = paxName(data)
        if (name) pendingName = name
      }
      continue
    }

    if (typeflag === '5') {
      await src.skip(padded)
      const rel = normalizeName(rawName)
      if (rel === null) throw new ArchiveError(`归档里的目录名不合法：${JSON.stringify(rawName)}`)
      // rel 为空就是 bsdtar 打「./」时那条根目录项，指向目标目录本身，不必建也不能建
      if (rel !== '') await mkdir(join(root, rel), { recursive: true })
      continue
    }

    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7') {
      throw new ArchiveError(
        `归档里有不支持的条目类型「${typeflag}」（${JSON.stringify(rawName)}）。只接受普通文件与目录，链接和设备文件一律拒绝`
      )
    }

    const rel = normalizeName(prefix ? `${prefix}/${rawName}` : rawName)
    if (rel === null || rel === '') {
      throw new ArchiveError(`归档里的文件名不合法：${JSON.stringify(rawName)}`)
    }
    if (entries.length + 1 > maxFiles) {
      throw new ArchiveError(`归档里的文件数超过 ${maxFiles} 个上限`)
    }
    if (totalBytes + size > maxBytes) {
      throw new ArchiveError(
        `归档解出来的体积超过 ${(maxBytes / 1e6).toFixed(0)}MB 上限，拒绝继续写盘`
      )
    }
    const abs = resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new ArchiveError(`归档里的路径跑出了目标目录：${JSON.stringify(rel)}`)
    }

    entries.push({ path: rel, bytes: size })
    totalBytes += size

    const sha = expected[rel] === undefined ? null : createHash('sha256')
    // 先建父目录再开文件：'wx' 在父目录不存在时直接 ENOENT，而归档里的 ./dict/ 这类目录项
    // 不保证排在文件前面（GNU 与 bsdtar 的顺序不一样）
    await mkdir(dirname(abs), { recursive: true })
    const handle = await open(abs, 'wx')
    try {
      let written = 0
      while (written < size) {
        const want = Math.min(size - written, 1 << 20)
        if (!(await src.ensure(want))) throw new ArchiveError(`归档在 ${rel} 处被截断`)
        const chunk = src.take(want)
        await handle.write(chunk)
        sha?.update(chunk)
        written += chunk.length
        // 进度判在块循环里，不判在文件循环外：模型那 121MB 是一整个文件，
        // 等它写完才报一次的话，界面会在 12% 停住十几秒，跟坏了没区别
        sinceReport += chunk.length
        if (options.onProgress && sinceReport >= REPORT_EVERY) {
          sinceReport = 0
          options.onProgress(totalBytes - size + written, total || totalBytes)
        }
      }
      const padding = padded - size
      if (padding > 0 && !(await src.skip(padding))) {
        throw new ArchiveError(`归档在 ${rel} 的填充处被截断`)
      }
    } finally {
      await handle.close()
    }
    if (sha) hashes.set(rel, sha.digest('hex'))
    if (options.onProgress && sinceReport >= REPORT_EVERY) {
      sinceReport = 0
      options.onProgress(totalBytes, total || totalBytes)
    }
  }

  const mismatches: string[] = []
  for (const [rel, want] of Object.entries(expected)) {
    const got = hashes.get(rel)
    if (got === undefined) mismatches.push(`${rel}（归档里没有这个文件）`)
    else if (got !== want)
      mismatches.push(`${rel}（${got.slice(0, 12)}… ≠ ${want.slice(0, 12)}…）`)
  }
  if (mismatches.length > 0) throw new ArchiveError(`关键文件校验不通过：${mismatches.join('；')}`)

  // 收尾必报一次：129MB 里最后一段可能不足 4MB，不补这一下界面就停在 96% 上
  options.onProgress?.(totalBytes, total || totalBytes)
  return { entries, bytes: totalBytes, verified: hashes.size }
}
