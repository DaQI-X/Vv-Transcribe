/**
 * 本地 Whisper 档位的「到底占了多少盘」（#421）。
 *
 * 这一层的唯一产出是设置界面上那一行数字，而它最容易犯的错不是崩，是**少报**：本机实测 small 档的
 * 权重真身 483,546,902 字节落在 `hub/blobs/42/` 那层共享存储里，仓库目录只留两跳软链，
 * `du -sh` 报 2.6M。少报的症状是「应用说只占 2.6M，磁盘却凭空少了 480M」——用户只会认为应用在撒谎。
 * 所以这里逐条钉：软链跟到真身、两跳也要跟、悬空的不许算成占用、blobs 那层的下载残骸不许算数、
 * 别家模型的缓存不许混进来、两档共用一枚真身时合计只算一份。
 *
 * 造「读不出来」用的是「snapshots 那个位置站着一个文件」（ENOTDIR），不用 chmod：
 * CI 以 root 跑时权限拦不住人，那条测试在 CI 上会假绿。
 *
 * #422 之后这个文件还钉住**判「已缓存」的那把尺**：宿主拿它决定要不要给引擎下发 `HF_HUB_OFFLINE`，
 * 所以「快照里有 model.bin」不再等于命中——本机实测那种「权重在、附属文件缺」的树，离线标志会让
 * 引擎回一句 `Cannot find an appropriate cached snapshot folder`，界面却写着「已缓存」，而唯一能自愈
 * 的那条路（联网补那 2.2MB）被自己掐死。收紧的是判定，占用那一路的字节照报，两件事分开钉。
 */
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hubCacheDir,
  isModelCached,
  localWeightsComplete,
  measureLocalModelUsage,
} from '../electron/main/services/asrModelUsage'
import { ASR_MODEL_SOURCES, asrModelDir, asrModelRootDir } from '../electron/main/services/asrModelUpstream'

let root = ''
const repo = (tier: string) => join(root, `models--Systran--faster-whisper-${tier}`)

/**
 * 判定「已缓存」要看的那四枚文件名，**取自指纹表本身**（#422）：这里再抄一份四枚的清单，
 * 表一改就测不出「宿主说齐了、引擎说少了」那种分叉了。
 */
const REQUIRED = ASR_MODEL_SOURCES.base.files.map((file) => file.path)
/** 除权重外的三枚附属文件：写 0 字节，只为让「齐不齐」这一维可控，不搅动按字节的断言 */
const AUX = REQUIRED.filter((name) => name !== 'model.bin')

/** 造一枚权重真身（内容无所谓，这一层只认字节数） */
async function makeBlob(path: string, bytes: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 7))
}

/** 造一层快照目录 */
async function snapshot(tier: string, rev: string): Promise<string> {
  const dir = join(repo(tier), 'snapshots', rev)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 快照里的附属文件（config/tokenizer/vocabulary）：0 字节。
 *
 * 有了它们，「已下载」那些用例测的才是**完整快照**；缺附属文件正是 #422 修掉的那条尾巴，
 * 所以下面另有用例专门把它拆掉，而不是让所有 fixture 都停留在旧判式里。
 */
async function withAux(dir: string): Promise<string> {
  for (const name of AUX) await writeFile(join(dir, name), '')
  return dir
}

/**
 * 快照里的 model.bin 是指向 blobs 的软链（huggingface_hub 的落法）。
 * target 相对 `snapshots/<rev>/` 那一层——仓库自己的 blobs 要写 `../../blobs/<sha>`（往上两跳），
 * 少写一跳就是一个悬空链，测出来的是「没下载」而不是「量到了」，而且它不会报错、只会静默少报。
 */
async function linkWeight(tier: string, rev: string, target: string): Promise<void> {
  const dir = await snapshot(tier, rev)
  await symlink(target, join(dir, 'model.bin'))
  await withAux(dir)
}

/** 快照里的 model.bin 是实体文件（没开共享存储时长这样），也用来单独占一层字节数 */
async function solidWeight(tier: string, rev: string, bytes: number): Promise<void> {
  const dir = await snapshot(tier, rev)
  await writeFile(join(dir, 'model.bin'), Buffer.alloc(bytes, 3))
  await withAux(dir)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vv-hfcache-'))
  // 每条用例换一颗干净的缓存树：hubCacheDir() 是调用时才读环境变量，换目录不用重灌模块
  process.env.HF_HUB_CACHE = root
  delete process.env.HUGGINGFACE_HUB_CACHE
  delete process.env.HF_HOME
})

afterEach(async () => {
  delete process.env.HF_HUB_CACHE
  await rm(root, { recursive: true, force: true })
})

describe('hubCacheDir：判式与 huggingface_hub 自己一致', () => {
  it('显式指定的缓存目录最大', () => {
    process.env.HF_HOME = join(root, 'home')
    expect(hubCacheDir()).toBe(root)
  })

  it('没有 HF_HUB_CACHE 时认 HUGGINGFACE_HUB_CACHE', () => {
    delete process.env.HF_HUB_CACHE
    process.env.HUGGINGFACE_HUB_CACHE = join(root, 'legacy')
    expect(hubCacheDir()).toBe(join(root, 'legacy'))
  })

  it('两者都没有时落 HF_HOME 下面那层 hub', () => {
    delete process.env.HF_HUB_CACHE
    process.env.HF_HOME = join(root, 'home')
    expect(hubCacheDir()).toBe(join(root, 'home', 'hub'))
  })

  it('导出成空串按没设处理：跟着空值走等于把缓存找到 `/` 底下去', () => {
    process.env.HF_HUB_CACHE = ''
    process.env.HF_HOME = ''
    expect(hubCacheDir()).toBe(join(process.env.HOME ?? '', '.cache', 'huggingface', 'hub'))
  })
})

describe('measureLocalModelUsage：软链必须跟到真身', () => {
  it('整颗缓存还不存在（从没本地转写过）是正常答案，不是错误', async () => {
    const got = await measureLocalModelUsage()
    expect(got.error).toBeNull()
    expect(got.totalBytes).toBe(0)
    expect(got.tiers.map((row) => [row.tier, row.cached, row.bytes])).toEqual([
      ['base', false, 0],
      ['small', false, 0],
    ])
    expect(isModelCached('base')).toBe(false)
  })

  it('一跳软链（真身就在本仓库 blobs 里）量的是真身字节数', async () => {
    await makeBlob(join(repo('base'), 'blobs', 'a1b2c3'), 4096)
    await linkWeight('base', 'rev1', '../../blobs/a1b2c3')
    const got = await measureLocalModelUsage()
    expect(got.error).toBeNull()
    expect(got.tiers[0]).toEqual({ tier: 'base', cached: true, bytes: 4096 })
  })

  it('两跳软链（真身在 hub/blobs/<两位>/ 那层共享存储）也量到真身，而不是链本身那几个字节', async () => {
    // 本机 small 档就是这个形状：snapshots/<rev>/model.bin → 仓库 blobs/<sha> → hub/blobs/42/<sha2>
    await makeBlob(join(root, 'blobs', '42', 'sha2'), 120000)
    await mkdir(join(repo('small'), 'blobs'), { recursive: true })
    await symlink('../../blobs/42/sha2', join(repo('small'), 'blobs', '3e3059'))
    await linkWeight('small', 'rev9', '../../blobs/3e3059')
    const got = await measureLocalModelUsage()
    expect(got.tiers.find((row) => row.tier === 'small')).toEqual({
      tier: 'small',
      cached: true,
      bytes: 120000,
    })
    expect(got.tiers.find((row) => row.tier === 'base')?.cached).toBe(false)
    expect(got.totalBytes).toBe(120000)
    expect(isModelCached('small')).toBe(true)
  })

  it('快照里的普通文件（config.json 这些）算这一档的占用', async () => {
    await solidWeight('base', 'rev1', 4096)
    await writeFile(join(await snapshot('base', 'rev1'), 'config.json'), '{}')
    const got = await measureLocalModelUsage()
    expect(got.tiers[0]).toEqual({ tier: 'base', cached: true, bytes: 4098 })
  })

  it('同一档位 checkout 过两个 revision：两版都真占着盘，逐版合计', async () => {
    await makeBlob(join(repo('base'), 'blobs', 'one'), 1000)
    await makeBlob(join(repo('base'), 'blobs', 'two'), 2000)
    await linkWeight('base', 'revA', '../../blobs/one')
    await linkWeight('base', 'revB', '../../blobs/two')
    const got = await measureLocalModelUsage()
    expect(got.tiers[0]).toEqual({ tier: 'base', cached: true, bytes: 3000 })
  })

  it('两档共用同一枚真身时各档照报自己读到的量，合计只算一份', async () => {
    await makeBlob(join(root, 'blobs', '42', 'same'), 5000)
    for (const tier of ['base', 'small']) {
      await mkdir(join(repo(tier), 'blobs'), { recursive: true })
      await symlink('../../blobs/42/same', join(repo(tier), 'blobs', `${tier}-sha`))
      await linkWeight(tier, 'rev1', `../../blobs/${tier}-sha`)
    }
    const got = await measureLocalModelUsage()
    expect(got.tiers.map((row) => row.bytes)).toEqual([5000, 5000])
    expect(got.totalBytes).toBe(5000)
  })
})

describe('measureLocalModelUsage：不许把读不出来演成没占地方', () => {
  it('权重是悬空软链（目标没落盘）时这一档算未下载，那份也不计进字节', async () => {
    await mkdir(join(repo('base'), 'blobs'), { recursive: true })
    await linkWeight('base', 'rev1', '../../blobs/never-downloaded')
    const got = await measureLocalModelUsage()
    expect(got.tiers[0]).toEqual({ tier: 'base', cached: false, bytes: 0 })
    expect(got.totalBytes).toBe(0)
    expect(got.error).toBeNull()
    expect(isModelCached('base')).toBe(false)
  })

  it('blobs 那层的 .incomplete / .lock / .refs 是「还没下完」的证据，不算这一档的占用', async () => {
    await solidWeight('base', 'rev1', 900)
    const blobs = join(repo('base'), 'blobs')
    await mkdir(join(blobs, 'deadbeef.lock'), { recursive: true })
    await mkdir(join(root, 'refs'), { recursive: true })
    await writeFile(join(blobs, 'deadbeef.incomplete'), Buffer.alloc(70000, 1))
    await writeFile(join(root, 'refs', 'main'), 'rev1')
    const got = await measureLocalModelUsage()
    expect(got.tiers[0].bytes).toBe(900)
    expect(got.totalBytes).toBe(900)
  })

  it('快照层里站着目录时既不计进字节，也不当它是权重', async () => {
    await solidWeight('base', 'rev1', 900)
    await mkdir(join(repo('base'), 'snapshots', 'rev1', 'nested'), { recursive: true })
    await writeFile(join(repo('base'), 'snapshots', 'rev1', 'nested', 'model.bin'), 'x')
    const got = await measureLocalModelUsage()
    expect(got.tiers[0].bytes).toBe(900)
  })

  it('别家模型的缓存不算进来：只数 Systran/faster-whisper-<档位> 这两个 repo', async () => {
    await solidWeight('base', 'rev1', 900)
    // 本机真有其他家：hub 这一层是 HuggingFace 的通用缓存
    await makeBlob(join(root, 'models--Systran--faster-whisper-medium', 'blobs', 'm'), 88000)
    await makeBlob(join(root, 'models--some-org--some-model', 'snapshots', 'rev1', 'model.bin'), 88000)
    const got = await measureLocalModelUsage()
    expect(got.totalBytes).toBe(900)
  })

  it('那一层站着一个文件（真读不出来）时报错，而不是回一份「两档都没占地方」', async () => {
    await mkdir(repo('base'), { recursive: true })
    await writeFile(join(repo('base'), 'snapshots'), 'not a dir')
    const got = await measureLocalModelUsage()
    expect(got.error).toBeTruthy()
    expect(got.tiers).toEqual([])
    expect(got.totalBytes).toBe(0)
  })
})

describe('isModelCached：与那一行报的数同一条判据（#422 收紧到四枚）', () => {
  it('四枚文件都能解析到才算命中：spawn 时下发 HF_HUB_OFFLINE 用的就是这个结论', async () => {
    expect(isModelCached('base')).toBe(false)
    await solidWeight('base', 'rev1', 1200)
    expect(isModelCached('base')).toBe(true)
    const got = await measureLocalModelUsage()
    expect(got.tiers.find((row) => row.tier === 'base')?.cached).toBe(true)
  })

  /**
   * 本机实测过的那条死结（2026-11-26）：快照里只有 model.bin 时，旧判式回「已缓存」，宿主照此下发
   * `HF_HUB_OFFLINE=1`，而 huggingface_hub 认快照要文件全在，于是引擎回
   * `Cannot find an appropriate cached snapshot folder ... outgoing traffic has been disabled`，
   * 宿主再把它念成「去确认能不能访问 hf-mirror.com」——把用户支去查一个没坏的东西。
   */
  it('缺附属文件（只有 model.bin）时不许判「已缓存」，否则离线标志把唯一的出路掐死', async () => {
    const dir = await snapshot('base', 'rev1')
    await writeFile(join(dir, 'model.bin'), Buffer.alloc(1200, 3))
    expect(isModelCached('base')).toBe(false)
    const got = await measureLocalModelUsage()
    expect(got.tiers[0]?.cached).toBe(false)
  })

  it('附属文件是悬空软链时同样不算齐：链在、货不在', async () => {
    const dir = await snapshot('base', 'rev1')
    await writeFile(join(dir, 'model.bin'), Buffer.alloc(1200, 3))
    await writeFile(join(dir, 'config.json'), '{}')
    await writeFile(join(dir, 'vocabulary.txt'), 'x')
    await symlink('../../blobs/never-downloaded', join(dir, 'tokenizer.json'))
    expect(isModelCached('base')).toBe(false)
    // 字节仍然照报：那 1,203 枚字节真的占着盘（权重 1200 + config 2 + vocabulary 1），
    // 判据收紧不许顺手把占用也少报；那个悬空链解析不到，本来就不计进字节
    const got = await measureLocalModelUsage()
    expect(got.tiers[0]?.bytes).toBe(1203)
  })

  it('两版快照里有一版齐就算齐：另一版的残件不该把整档判成没下载', async () => {
    const broken = await snapshot('base', 'revA')
    await writeFile(join(broken, 'model.bin'), Buffer.alloc(500, 1))
    await solidWeight('base', 'revB', 1200)
    expect(isModelCached('base')).toBe(true)
    const got = await measureLocalModelUsage()
    expect(got.tiers[0]?.cached).toBe(true)
    expect(got.tiers[0]?.bytes).toBe(1700)
  })

  it('缓存里有 base 不代表有 small：切档后照 base 的结论下发离线标志，第一次转写会死结', async () => {
    await solidWeight('base', 'rev1', 1200)
    expect(isModelCached('base')).toBe(true)
    expect(isModelCached('small')).toBe(false)
    const got = await measureLocalModelUsage()
    expect(got.tiers.map((row) => row.cached)).toEqual([true, false])
  })
})

/**
 * 应用自取那棵树（#434/#435）的判据是**字节逐个对得上**，比 HF 树那一把尺更严。
 * 这一组钉的是「半份文件绝不能被判成已装好」：那正是引擎会在 CTranslate2 里炸成一句
 * 看不懂的话的形状，而 #435 的取件段闸门（`isModelCached`）也吃这个结论。
 */
describe('localWeightsComplete：组件目录那一棵按字节把关', () => {
  /**
   * 落点必须走 `asrModelRootDir()`：那是下载器、判式与占用测量共用的同一个函数，写死第二份拼法
   * 测的就不是真路径。每条用例先删整层——这一棵住在 worker 的 userData 里，不跟着 `root` 那颗
   * 缓存树走，上一用例留下的 147MB 会把下一条「这棵没货」的断言演成假绿。
   */
  beforeEach(async () => {
    await rm(asrModelRootDir(), { recursive: true, force: true })
  })

  async function appDir(tier: 'base' | 'small'): Promise<string> {
    const dir = asrModelDir(tier)
    await mkdir(dir, { recursive: true })
    return dir
  }

  it('整档目录还不存在时两把尺都回未装好', async () => {
    expect(localWeightsComplete('base')).toBe(false)
    expect(isModelCached('base')).toBe(false)
  })

  it('文件都在但少 1 字节就当作没装好：半份 model.bin 比没下更坏', async () => {
    const dir = await appDir('base')
    for (const file of ASR_MODEL_SOURCES.base.files) {
      const abs = join(dir, file.path)
      await writeFile(abs, '')
      // 稀疏文件（truncate 撑出来的尺寸）也要被字节尺拦住：stat 看的是表里的数，不是磁盘块数
      await truncate(abs, file.path === 'model.bin' ? file.bytes - 1 : file.bytes)
    }
    expect(localWeightsComplete('base')).toBe(false)
    expect(isModelCached('base')).toBe(false)
  })

  it('按表补齐四枚才算装好，占用那一行同时报出这一档的量', async () => {
    const dir = await appDir('base')
    for (const file of ASR_MODEL_SOURCES.base.files) {
      const abs = join(dir, file.path)
      // truncate 只改已有文件的长度，不会把缺的文件造出来（实测 ENOENT），所以先写空再撑开
      await writeFile(abs, '')
      await truncate(abs, file.bytes)
    }
    expect(localWeightsComplete('base')).toBe(true)
    expect(isModelCached('base')).toBe(true)
    const got = await measureLocalModelUsage()
    expect(got.tiers[0]?.cached).toBe(true)
    expect(got.tiers[0]?.bytes).toBe(147882941)
  })
})
