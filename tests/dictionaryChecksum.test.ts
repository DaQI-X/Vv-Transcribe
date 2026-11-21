/**
 * D（1.2.2）：词库是应用里唯一「下载回来的大文件不做任何完整性校验」的取件面——
 * 上游仓库八年没动过（data/ 最后一次提交 2018-12-16），所以「跟着上游走」不值钱，
 * 「服务器给什么就原样落盘」才值钱。这里钉的是闸门本身，以及它必须同样管住读取那一头。
 *
 * 三段各管一件会静默出错的事：
 * 1. 指纹必须与**随包那份**一致——不一致等于我们把 pin 改了却没换数据，
 *    上线后每次「更新词库」都判篡改，用户那边永远更新不成功，而这条不会崩，只会一直报错；
 * 2. 改一个字节必须被拒（长度没变，所以只有指纹那道闸门拦得住）；
 * 3. 少一截必须被拒（长度不符比指纹先响，这条给用户的话要说清差多少）。
 *
 * 第二块测的是读取那一头：旧版落盘是「下载一份写一份、写完不验」，所以用户盘上可能已经躺着
 * 一份混合态，而当年判失败的条件是「两头都空」——一头残、一头好会被当成一次成功的更新加载进来，
 * 加上 version.json 与远端 commit 一致，检查更新永远回「已是最新」，坏状态自己不会好。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { verifyDictionaryBytes } from '../electron/main/services/dictionaryService'

type DictService = typeof import('../electron/main/services/dictionaryService')

const PINNED = {
  'ci.json': {
    bytes: 26_129_191,
    sha256: '739e086d61dc9b95cd1df92095720e6391f952a41c476d3281ef95ebed869a09',
  },
  'idiom.json': {
    bytes: 10_319_857,
    sha256: '1d4b4f454ce1c416d6a1ab2369d6e66c0ff99e04390172eef70790499e21ce19',
  },
} as const

/** 随包那份数据：闸门与它必须逐字节认同，否则更新路径上线即死 */
const builtinDir = join(process.cwd(), 'electron/resources/dictionary')

const real: Record<string, Buffer> = {}

beforeAll(async () => {
  for (const name of Object.keys(PINNED)) {
    real[name] = await readFile(join(builtinDir, name))
  }
}, 120_000)

describe('verifyDictionaryBytes 词库指纹闸门', () => {
  it('两份钉死的指纹都与随包那份一致（pin 改了却没换数据会被这条抓住）', () => {
    for (const name of Object.keys(PINNED)) {
      expect(real[name].length, `${name} 的体积`).toBe(PINNED[name as keyof typeof PINNED].bytes)
      expect(verifyDictionaryBytes(name, real[name])).toBeNull()
    }
  })

  it('只改一个字节也要被拒（长度没变，拦它的是指纹那道闸门）', () => {
    const tampered = Buffer.from(real['idiom.json'])
    // 改在开头，确保动的是正文而不是任何尾部填充
    tampered[0] = tampered[0] === 0x7b ? 0x7a : 0x7b
    expect(tampered.length).toBe(real['idiom.json'].length)
    expect(verifyDictionaryBytes('idiom.json', tampered)).toMatch(/指纹和钉死/)
  })

  it('下载断在半路（长度不符）算失败，不拿残包当新版本', () => {
    const truncated = real['ci.json'].subarray(0, real['ci.json'].length - 1_000)
    // 两边都得是精确字节数：约成 26.1MB 之后这句话会变成「与钉死的 26.1MB 不符」，看不出问题在哪
    expect(verifyDictionaryBytes('ci.json', truncated)).toMatch(/收到 26,128,191 字节，与钉死的 26,129,191 字节/)
  })

  it('清单里没有的文件名直接拒：不给「钉死表外的那份数据」落盘的机会', () => {
    expect(verifyDictionaryBytes('words.json', real['ci.json'])).toMatch(/词库里没有/)
  })

  it('空文件与整份被换成别的内容，都过不了', () => {
    expect(verifyDictionaryBytes('ci.json', Buffer.alloc(0))).toMatch(/收到 0 字节/)
    // 长度凑一样、内容完全不同的另一份数据（比如上游被人替换成别的仓库）
    const swapped = Buffer.alloc(real['idiom.json'].length, 0x61)
    expect(verifyDictionaryBytes('idiom.json', swapped)).toMatch(/指纹和钉死/)
  })
})

/**
 * 现场是造出来的：往一份临时 userData 的 dictionary/ 里放 version.json + 两份数据，
 * 其中一份按需截断。每家用一份新目录并重灌模块——`dictionaryCache` 与 `currentVersion`
 * 都是模块级状态，不 reset 的话第二家读到的是第一家剩下的那份词库，断言就成了摆设。
 */
describe('盘上那份更新副本走同一把闸门', () => {
  /**
   * 退回内置那条腿要能真读到 electron/resources/dictionary。补的是 vitest 的洞、不是被测代码的洞：
   * dev 分支用 import.meta.dirname 拼路径（vitest 里是空串，拼出来落到仓库外面），打包分支用
   * process.resourcesPath（只有 Electron 会设，纯 Node 下没有）——所以走打包分支并把它指回仓库根。
   * vitest 每个测试文件一个隔离 worker，这两个改动跑完就随 worker 一起没了，不需要还原。
   */
  beforeAll(() => {
    delete process.env.VITE_DEV_SERVER_URL
    Object.defineProperty(process, 'resourcesPath', {
      value: join(process.cwd(), 'electron'),
      configurable: true,
    })
  })

  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  /** 第一词的词头，用来证明「这一头有内容」——不断条数，断的是查得到一个真实释义 */
  const firstTerm = (buf: Buffer): string => {
    const data = JSON.parse(buf.toString('utf-8')) as Array<{ ci?: string; word?: string }>
    const entry = data[0]
    return entry.ci || entry.word || ''
  }

  async function loadFrom(updateFiles: Record<string, Buffer>): Promise<DictService> {
    const userData = await mkdtemp(join(tmpdir(), 'vv-dict-fixture-'))
    dirs.push(userData)
    const dictDir = join(userData, 'dictionary')
    await mkdir(dictDir, { recursive: true })
    await writeFile(
      join(dictDir, 'version.json'),
      JSON.stringify({ version: 'abcdef1', commitHash: 'abcdef1234567890abcdef1234567890abcdef12', updatedAt: new Date().toISOString() }),
      'utf-8'
    )
    for (const [name, buf] of Object.entries(updateFiles)) {
      await writeFile(join(dictDir, name), buf)
    }
    vi.resetModules()
    vi.spyOn(app, 'getPath').mockImplementation(
      ((name: string) => (name === 'userData' ? userData : join(userData, name))) as typeof app.getPath
    )
    return await import('../electron/main/services/dictionaryService')
  }

  it('一份是残包 → 整份退回内置，两头都还在', async () => {
    const svc = await loadFrom({
      'ci.json': real['ci.json'],
      'idiom.json': real['idiom.json'].subarray(0, real['idiom.json'].length - 1_000),
    })
    await svc.initDictionary()

    // 退回内置的直接证据：版本号回到内置那一份，不是 version.json 里的那枚 commit
    expect(svc.getCurrentVersion()).toBe('1.0.0')
    // 这条才是实质：旧代码在这里会交出「有词语、零条成语」的半套词库，并且再也不更新
    expect(await svc.lookupWord(firstTerm(real['idiom.json']))).toMatchObject({ found: true })
    expect(await svc.lookupWord(firstTerm(real['ci.json']))).toMatchObject({ found: true })
  }, 120_000)

  it('两份都对 → 用盘上那份更新副本，不退回内置', async () => {
    const svc = await loadFrom({ 'ci.json': real['ci.json'], 'idiom.json': real['idiom.json'] })
    await svc.initDictionary()

    expect(svc.getCurrentVersion()).toBe('abcdef1')
    expect(await svc.lookupWord(firstTerm(real['idiom.json']))).toMatchObject({ found: true })
  }, 120_000)
})
