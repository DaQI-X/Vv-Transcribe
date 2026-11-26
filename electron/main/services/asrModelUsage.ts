/**
 * 本地 Whisper 档位权重的落盘情况（#421）
 *
 * 这一层归本模块自己管，因为「缓存目录在哪」和「里面有多少字节」必须是同一个答案：
 * `asrServiceManager` 按同一套公式决定要不要给引擎下发 `HF_HUB_OFFLINE`，界面那一行报的占用
 * 也来自同一套公式，两处各写一份路径拼法迟早会分叉（分叉的那天，界面说「已占 486MB」而引擎
 * 说「我没找到模型」）。
 *
 * 为什么不照目录大小念（本机实测 2026-11-26）：huggingface_hub 开着共享存储时（缓存根目录里那枚
 * `.huggingface-shared-blobs` 就是它），权重真身落在 `hub/blobs/<两位>/<sha>`，仓库目录里只留软链，
 * 而快照层又是一层软链——
 * - base：`model.bin` 指向仓库自己 `blobs/` 里的真身 145,217,532 字节，`du -sh` 那层仓库目录报 141M，对得上；
 * - small：`snapshots/<rev>/model.bin` → 仓库 `blobs/3e3059…`（它**本身也是软链**）→ `hub/blobs/42/429ffc84…`
 *   = 483,546,902 字节，加上快照里那三个附属文件（config/tokenizer/vocabulary）整档 486,212,372 字节，
 *   而 `du -sk` 报那层仓库目录只有 2,678,784 字节——少报约 180 倍。
 * 所以这里逐个条目 `realpath` 到真身再 `stat`，并且**按解析后的路径去重**：两档共用一枚权重时
 * 合计只算一份，各档那一行仍报自己读得到的量。`du` 不跟软链、`--apparent-size` 也不跟，
 * 这条链路只能自己走。
 *
 * 只数 `Systran/faster-whisper-<档位>` 这两个 repo：`hub/` 这一层是 HuggingFace 的通用缓存，
 * 别家程序与别的模型也在里面（本机就有三份 sherpa 的配音模型），把整层报成本应用的占用是虚账。
 * 从快照解析不到的东西一律不计——`.lock`/`.refs`/`*.incomplete` 住在 `blobs/` 那一层而不是快照里，
 * 它们是「还没下完」的证据，不是这一档的占用；解析不过去的悬空软链同理。
 *
 * #434 之后这一档可能有**两棵树**：旧那棵是引擎自己去 hf-mirror 拉的 HF 缓存，新那棵是应用按
 * `asrModelUpstream` 的指纹表自取的 `userData/components/asr-models/<档位>`。两棵都量、都计入占用，
 * 「在不在本地」任一棵齐了即算（见 isModelCached）——界面与 spawn 必须给同一个答案。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_MODEL_TIERS, type LocalModelTier } from './settingsService'
import { ASR_MODEL_SOURCES, asrModelDir, hasAsrModelDownload } from './asrModelUpstream'
// 「这一档一共多少字节」由同一份通用实现说（componentService 报 remoteBytes 用的也是它），
// 这里再 reduce 一遍 files.bytes 就是第二把尺（#438）
import { upstreamTotalBytes } from './ttsModelUpstream'

/**
 * 权重文件名，也是指纹表缺位时（认不出的档位）唯一的判据。
 * 注意它**不是**「这一档算不算已缓存」的完整答案——那要看下面 requiredFiles 的四枚。
 */
const WEIGHT_FILE = 'model.bin'

/**
 * 判定某一档「已缓存」时要看的那几枚文件名，全部取自 `ASR_MODEL_SOURCES`（#422）。
 *
 * 不在这儿再抄一份四枚的清单：引擎侧 `python-asr/main.py` 的 `MODEL_FILES` 与指纹表本来就要
 * 对得上（见 localEngineAuth.test 那条守卫），宿主写第三份只会让「宿主说齐了、引擎说少了」
 * 这种分叉重新长出来。
 */
function requiredFiles(tier: string): string[] {
  return hasAsrModelDownload(tier) ? ASR_MODEL_SOURCES[tier].files.map((file) => file.path) : [WEIGHT_FILE]
}
/** 档位名会被拼成 HuggingFace 的 repo 目录名，与引擎侧 `Systran/faster-whisper-<档位>` 同一个拼法 */
const REPO_DIR_PREFIX = 'models--Systran--faster-whisper-'

/**
 * HuggingFace 缓存根目录，判式与 huggingface_hub 自己一致：显式指定的缓存目录优先，
 * 其次 `HF_HOME` 下面那层 `hub`，最后才是默认的 `~/.cache/huggingface/hub`。
 * 空串按没设处理（`||` 而不是 `??`）：用户导出了一个空值时跟着它走等于把缓存找到 `/` 底下去。
 */
export function hubCacheDir(): string {
  return (
    process.env.HF_HUB_CACHE ||
    process.env.HUGGINGFACE_HUB_CACHE ||
    (process.env.HF_HOME ? join(process.env.HF_HOME, 'hub') : undefined) ||
    join(homedir(), '.cache', 'huggingface', 'hub')
  )
}

function repoDir(tier: string): string {
  return join(hubCacheDir(), `${REPO_DIR_PREFIX}${tier}`)
}

/**
 * 应用自己取件那一棵树（#434：下载器落在 `userData/components/asr-models/<档位>`）里，
 * 这一档的四个文件是否都在、字节是否与指纹表一致。
 *
 * 只对数量与尺寸，不对内容：内容在装的那一刻已由 SHA256 验过（`downloadToPart`），事后逐枚重算是
 * 145MB/483MB 两趟全盘读，为一次启动付这个代价不值。尺寸对不上就当它不在——手工塞进来的半份文件
 * 比没塞更坏（引擎加载时会在 CTranslate2 内部炸成一句看不懂的话）。
 */
export function localWeightsComplete(tier: string): boolean {
  if (!hasAsrModelDownload(tier)) return false
  const dir = asrModelDir(tier)
  if (!existsSync(dir)) return false
  try {
    return ASR_MODEL_SOURCES[tier].files.every((file) => {
      const abs = join(dir, file.path)
      return existsSync(abs) && statSync(abs).size === file.bytes
    })
  } catch {
    return false
  }
}

/**
 * 这一档的权重是否已在本地。**四枚文件都在**才算，只数 `model.bin` 会把死结留给用户。
 *
 * 为什么收紧到四枚（2026-11-26 实测，#422）：宿主拿这个结论决定给不给引擎下发
 * `HF_HUB_OFFLINE=1`，而 huggingface_hub 认快照的判式本来就是「那一版里点名的文件全在」——
 * 本机造一棵「model.bin 在、tokenizer.json 缺」的树、照旧下发离线标志，引擎回的是
 * `Cannot find an appropriate cached snapshot folder for the specified revision on the local disk
 * and outgoing traffic has been disabled`。旧判式（只看 model.bin）在这种机器上会判「已缓存」，
 * 于是界面那行写「已缓存」、加载必然失败、而它唯一能自愈的那条路（联网补齐那 2.2MB）被自己掐死了。
 * 更糟的是宿主那句失败文案会把它念成「去确认能不能访问 hf-mirror.com」（引擎自报
 * `modelSource: repo`、`missingFiles: []`，它确实不知道少了什么）——把用户支去查网络。
 *
 * 代价说清楚：这么一改，那极少数「手工删过附属文件」的用户会重新取**整档**（147.9MB/486.2MB，
 * 有进度、可取消），而不是只补那一枚。取整档是因为下载器按组件整批工作（#430 的清单形状），
 * 逐文件补齐属于 #416；拿一次可见的整档下载换掉一个不可自愈的死结，是这笔账的答案。
 *
 * 只按文件名对，不按字节对：按字节要么读 145MB/483MB 全盘（每次启动付这个代价不值），要么信表里
 * 钉的那个 commit——而 HF 缓存里可能是别的 revision，一比尺寸正常缓存就集体误判成「没缓存」，
 * 把这轮省下的下载全赔回去。半份文件本来就不可能有软链：huggingface_hub 只为下载完整的文件建链，
 * 没下完的证据是 blob 那层的 `.incomplete`（所以下面 `collectSnapshot` 跟不到真身就当它不在）。
 *
 * 反过来为什么仍然要这个离线标志：huggingface_hub 平时每次加载都会向 hf-mirror 发一次「有没有
 * 新版本」的在线请求，弱网/挂代理时这一步能卡十几秒——模型明明已在本地，却被它拖成「首次加载慢了
 * 很多」。没命中缓存必须保持在线，否则用户第一次下载会直接失败。
 *
 * 调用方还有 `asrManager.fetchLocalWeights`：它拿同一个结论决定要不要自己下（#435），
 * 所以「界面说已缓存」「spawn 下发离线标志」「首转不重下」这三件事天然是同一个答案。
 *
 * 必须按档位判断：缓存里有 base 不代表有 small。用户在设置里切到 small 后如果照 base 的
 * 命中结果下发离线标志，首次转写会连不上 hf-mirror，报一个「模型没下载完」却又下载不了的死结。
 *
 * 两棵树任一到齐都算「在本地」（#434）：旧那棵是引擎自己去 hf-mirror 拉的 HF 缓存，新那棵是应用
 * 按指纹表自取的组件目录（那棵由 `localWeightsComplete` 按字节把关）。
 */
export function isModelCached(tier: string): boolean {
  if (localWeightsComplete(tier)) return true
  const snapshots = join(repoDir(tier), 'snapshots')
  if (!existsSync(snapshots)) return false
  const required = requiredFiles(tier)
  try {
    return readdirSync(snapshots).some((rev) => {
      const dir = join(snapshots, rev)
      return required.every((name) => existsSync(join(dir, name)))
    })
  } catch {
    return false
  }
}

export interface LocalModelTierUsage {
  tier: LocalModelTier
  /** true＝这一档的权重已在本地，加载它不用再联网 */
  cached: boolean
  /** 这一档快照可达的文件合计（同一枚真身在本档内只算一次） */
  bytes: number
  /**
   * 这一档按指纹表要下多少字节（#438）——表里没有这一档时为 null，界面宁可不报数。
   * 它是「还没下载」那一侧唯一的出处：档位提示再说一句「约 138MB」，同屏就会出现
   * 「147.9MB（组件行，表算）」与「138MB（手抄）」两个数（`ASR_MODEL_ROW_TITLES` 那条注释立的就是这条规矩）。
   */
  downloadBytes: number | null
}

export interface LocalModelUsage {
  /** 顺序与 `LOCAL_MODEL_TIERS` 一致；`error` 非空时这里是空数组——没读到不等于没占地方 */
  tiers: LocalModelTierUsage[]
  /** 跨档位按真身去重后的合计，可能小于各档 bytes 相加 */
  totalBytes: number
  error: string | null
}

/** 目录列不出来时抛；`ENOENT` 回 null，那是「这一层还不存在」而不是读失败 */
async function readDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * 把一个快照版本目录里的文件按真身收进 sizes，并回一句「这一版里能解析到哪几枚文件名」。
 * 返回值只看名字，不看字节：齐不齐这一档由调用方拿 `requiredFiles` 去对，字节尺在 `localWeightsComplete`。
 */
async function collectSnapshot(revDir: string, sizes: Map<string, number>): Promise<Set<string>> {
  const names = new Set<string>()
  for (const entry of (await readDir(revDir)) ?? []) {
    // 快照层是平铺的（本机两档都只有文件）；目录条目当没看见，不当占用也不当权重
    if (entry.isDirectory()) continue
    let real: string
    let info
    try {
      // 两跳软链一次到底；悬空的（目标没落盘）在这里就抛，那份既不计进字节、也不算解析得到
      real = await realpath(join(revDir, entry.name))
      info = await stat(real)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    names.add(entry.name)
    if (!sizes.has(real)) sizes.set(real, info.size)
  }
  return names
}

/** 一档的落盘情况：真身→字节数收进 sizes，另回一句「这一档的权重齐了没」 */
async function measureTier(tier: LocalModelTier, sizes: Map<string, number>): Promise<boolean> {
  const snapshotsPath = join(repoDir(tier), 'snapshots')
  const snapshots = await readDir(snapshotsPath)
  const required = requiredFiles(tier)
  let cached = false
  for (const rev of snapshots ?? []) {
    if (!rev.isDirectory()) continue
    // 同一档位可能被 checkout 过两个 revision：每一版的文件都真的占着盘，逐版收完再合计
    const names = await collectSnapshot(join(snapshotsPath, rev.name), sizes)
    // 每一版各自算齐不齐：只在一版里凑齐四枚也算（另一版的残件不能把整档判成没下载）
    if (required.every((name) => names.has(name))) cached = true
  }
  // 应用自取那棵树（#434）也占盘，同样逐文件 realpath 后收进来。两棵都装过时这一档报的是两份之和，
  // 那是真话不是重复计数——磁盘上确实有两份东西；把它们并成一份属于 #416 的活儿。
  // 它的名字不计进上面的判式：那棵树的权威结论是下面 `localWeightsComplete` 的字节尺
  await collectSnapshot(asrModelDir(tier), sizes)
  // 「算不算已缓存」必须与 isModelCached 同一把尺（尺寸齐了才算），不然界面会说「已缓存」、
  // spawn 却按没缓存下发在线许可——那正是本模块开头要避免的分叉
  return cached || localWeightsComplete(tier)
}

function sumBytes(sizes: Map<string, number>): number {
  let bytes = 0
  for (const size of sizes.values()) bytes += size
  return bytes
}

/**
 * 量一遍两个档位的落盘情况。整颗缓存目录不在（新用户从没本地转写过）是一种正常答案：
 * 两档 `cached:false`、合计 0、`error:null`。权限、卷没挂这类读不出来才回 `error`，
 * 因为「没读到」长成「没占地方」就是一句谎。
 */
export async function measureLocalModelUsage(): Promise<LocalModelUsage> {
  try {
    const union = new Map<string, number>()
    const tiers: LocalModelTierUsage[] = []
    for (const tier of LOCAL_MODEL_TIERS) {
      const sizes = new Map<string, number>()
      const cached = await measureTier(tier, sizes)
      // 两档共用同一枚真身时合计只算一份，各档那一行仍然报自己读到的量
      for (const [real, size] of sizes) {
        if (!union.has(real)) union.set(real, size)
      }
      tiers.push({
        tier,
        cached,
        bytes: sumBytes(sizes),
        // 表里没有这一档（认不出的档位）就报 null：界面宁可少说半句，也不报一个抄来的数
        downloadBytes: hasAsrModelDownload(tier) ? upstreamTotalBytes(ASR_MODEL_SOURCES[tier]) : null,
      })
    }
    return { tiers, totalBytes: sumBytes(union), error: null }
  } catch (err) {
    return {
      tiers: [],
      totalBytes: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
