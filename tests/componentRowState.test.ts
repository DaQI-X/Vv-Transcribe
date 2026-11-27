/**
 * 按需组件面板那五行「装没装」的出处（#439）。
 *
 * 触发这条的是 v1.2.5 的实测缺陷：本机转写成功、「本地转写模型占用」那行报 486.2MB，
 * 而同一屏的组件行写着「未安装，下载约 486.2MB」。根因是那一行沿用下载器默认的
 * `existsSync(target)`，只看应用自取的 `userData/components/asr-models/<档>`，
 * 而 1.2.4 之前的权重是引擎自己拉进 `~/.cache/huggingface/hub` 的——两棵树的判式分叉。
 * 用户照着那行点「下载」就白取一份、还多占一份盘，这正是缺陷报告里那句「看着有模型却还让下载」。
 *
 * 所以这里钉四台机器，全都走 `listComponents()` 这一条真实出口（不测 asrWeightState 本身，
 * 那一位的字节与软链形状在 asrModelUsage.test.ts 里已经钉过）：
 * - 只有 HF 那棵（老用户）：已安装、版本号是表内那枚、按钮收起，**不许**再给「下载」。
 * - 只有表外 revision：已安装但落在「更新」——这一档确实不是本版钉的那枚，别演成一致。
 * - 自家目录只有半份权重：未安装。反向那条洞（`existsSync` 不看字节 → 报「已安装，占用 0 B」）。
 * - 两棵都空：未安装，且「下载约多少」这个分母仍答得出（它来自指纹表，不依赖磁盘）。
 */
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listComponents } from '../electron/main/services/componentService'
import { ASR_MODEL_SOURCES, asrModelDir, asrModelRootDir } from '../electron/main/services/asrModelUpstream'

let hub = ''

/** HF 缓存里那一档的快照目录（宿主按文件名判齐，所以真身还是软链形状，这里用实体文件即可） */
async function hfSnapshot(tier: 'base' | 'small', commit: string, weightBytes: number): Promise<string> {
  const dir = join(hub, `models--Systran--faster-whisper-${tier}`, 'snapshots', commit)
  await mkdir(dir, { recursive: true })
  const source = ASR_MODEL_SOURCES[tier]
  for (const file of source.files) {
    await writeFile(join(dir, file.path), '')
    // 权重给个非零量，附属文件给表里的真数：断言只认「报不报已安装」，不抢字节那条测试的活
    await truncate(join(dir, file.path), file.path === 'model.bin' ? weightBytes : file.bytes)
  }
  return dir
}

/** 应用自取那棵树：按表补齐，`shortOf` 那枚少留 1 字节（半份文件的形状） */
async function appTree(tier: 'base' | 'small', shortOf: string | null): Promise<void> {
  const dir = asrModelDir(tier)
  await mkdir(dir, { recursive: true })
  for (const file of ASR_MODEL_SOURCES[tier].files) {
    const abs = join(dir, file.path)
    await writeFile(abs, '')
    await truncate(abs, file.path === shortOf ? file.bytes - 1 : file.bytes)
  }
}

const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`组件状态里没有 ${id} 这一行`)
  return found
}
let rows: Awaited<ReturnType<typeof listComponents>> = []

beforeEach(async () => {
  hub = await mkdtemp(join(tmpdir(), 'vv-hub-'))
  process.env.HF_HUB_CACHE = hub
  delete process.env.HUGGINGFACE_HUB_CACHE
  delete process.env.HF_HOME
  // 这一棵住在测试的 userData 里，不跟着 hub 那颗临时目录走，不清会把上一条用例的货演成「已安装」
  await rm(asrModelRootDir(), { recursive: true, force: true })
  rows = await listComponents()
})

afterEach(async () => {
  delete process.env.HF_HUB_CACHE
  await rm(asrModelRootDir(), { recursive: true, force: true })
  await rm(hub, { recursive: true, force: true })
})

describe('ASR 权重两行必须认两棵树（#439）', () => {
  it('两棵都空：未安装，但下载体积仍答得出（它来自指纹表，不是磁盘）', async () => {
    for (const tier of ['base', 'small'] as const) {
      const r = row(`asr-model-${tier}`)
      expect([r.installed, r.action, r.localVersion, r.bytes]).toEqual([false, 'install', null, 0])
      expect(r.remoteBytes).toBe(ASR_MODEL_SOURCES[tier].files.reduce((s, f) => s + f.bytes, 0))
    }
  })

  it('只有引擎那棵 HF 缓存：算已安装，且按钮收起——这就是本机报的那台机器', async () => {
    const source = ASR_MODEL_SOURCES.small
    await hfSnapshot('small', source.commit, 1_000)
    rows = await listComponents()
    const r = row('asr-model-small')
    expect(r.installed).toBe(true)
    expect(r.action).toBe('none')
    expect(r.localVersion).toBe(source.commit.slice(0, 7))
    // 版本号与 remote 同源才落 'none'：写成第三套拼法（比如整枚 commit）就会变成「更新」
    expect(r.remoteVersion).toBe(r.localVersion)
    expect(r.bytes).toBeGreaterThan(0)
    // 另一档没跟着沾光
    expect(row('asr-model-base').installed).toBe(false)
  })

  it('HF 里是表外那一版：说清「本版认的是另一枚」，不许演成已一致', async () => {
    await hfSnapshot('base', '0123456789abcdef0123456789abcdef01234567', 1_000)
    rows = await listComponents()
    const r = row('asr-model-base')
    expect([r.installed, r.action]).toEqual([true, 'update'])
    expect(r.localVersion).toBe('0123456')
  })

  it('自家目录只有半份权重：算未安装，不许报「已安装，占用 0 B」', async () => {
    await appTree('base', 'model.bin')
    rows = await listComponents()
    const r = row('asr-model-base')
    expect([r.installed, r.action, r.bytes]).toEqual([false, 'install', 0])
  })
})
