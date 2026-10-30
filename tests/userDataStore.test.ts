/**
 * userDataStore 的契约：路径都在同一根目录下、读盘失败分成四类、写盘只有原子写这一条路。
 * 1.0.9 的多配置与历史记录会往这一层加文件，所以这里测的是「层」本身，
 * 不是 settings 那一处调用——层上写错一次的代价是新文件各错一遍。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CORRUPT_SETTINGS_PREFIX,
  atomicWriteJson,
  componentsDir,
  corruptSettingsName,
  dictionaryDir,
  errnoDetail,
  fileStamp,
  logsDir,
  pruneOlderCopies,
  readJsonFile,
  settingsFile,
  userDataPath,
  userDataRoot,
} from '../electron/main/services/userDataStore'

let dir = ''

async function freshDir(): Promise<string> {
  await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(tmpdir(), 'vv-store-'))
  return dir
}

/** 把 userData 指到临时目录：这一层的每个函数都只在被调用时问一次路径，换目录不用重灌模块 */
function pointAt(fresh: string): void {
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? fresh : join(fresh, name))) as typeof app.getPath
  )
}

const names = () => readdir(dir)
const readText = (path: string) => readFile(path, 'utf-8')

beforeEach(async () => {
  pointAt(await freshDir())
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('路径收口', () => {
  it('每一个目录名都直接落在 userData 下面，且互不相同', () => {
    expect(userDataRoot()).toBe(dir)
    expect(logsDir()).toBe(join(dir, 'logs'))
    expect(componentsDir()).toBe(join(dir, 'components'))
    expect(dictionaryDir()).toBe(join(dir, 'dictionary'))
    expect(new Set([logsDir(), componentsDir(), dictionaryDir()]).size).toBe(3)
    // 应用内更新下来的 yt-dlp 由 urlDownloader 自己拼 userDataPath('bin', <带不带 .exe 的名字>)：
    // 叶子名是它的领域知识，但根仍是这一层，所以这里钉的是 bin 这层不会和上面任何目录撞名
    expect(userDataPath('bin')).toBe(join(dir, 'bin'))
  })

  it('settings.json 平铺在根目录，不挪进子目录', () => {
    // 界面文案教用户去「打开数据目录」找 settings.json.corrupt-*，改名与清扫也按同一层过滤：
    // 这条不是随手断言，挪走它同时会弄坏提示与清扫两处正确性
    expect(settingsFile()).toBe(join(dir, 'settings.json'))
    expect(userDataPath('x', 'y')).toBe(join(dir, 'x', 'y'))
  })

  it('留档文件名 = 前缀 + 时间戳，前缀与清扫用的是同一个常量', () => {
    expect(corruptSettingsName('20261030-123456')).toBe(`${CORRUPT_SETTINGS_PREFIX}20261030-123456`)
    expect(fileStamp(new Date('2026-10-30T12:34:56.789Z'))).toBe('20261030-123456')
  })
})

describe('readJsonFile：四种结局分得清', () => {
  it('正常文件给 ok，内容原样是解析后的对象', async () => {
    const file = join(dir, 'a.json')
    await writeFile(file, '{"aiModel":"gpt-4o"}')
    expect(await readJsonFile(file)).toEqual({ status: 'ok', value: { aiModel: 'gpt-4o' } })
  })

  it('文件不存在是 missing，不是故障（首次运行就是这样）', async () => {
    expect(await readJsonFile(join(dir, 'nope.json'))).toEqual({ status: 'missing' })
  })

  it('半截 JSON 是 corrupt，detail 带解析器的话', async () => {
    const file = join(dir, 'b.json')
    await writeFile(file, '{"aiModel":"gp')
    const result = await readJsonFile(file)
    expect(result.status).toBe('corrupt')
    expect(result.status === 'corrupt' && result.detail).toBeTruthy()
  })

  it('解得开但不是对象也算 corrupt，不会被当成一份合法配置读进去', async () => {
    for (const [name, content] of [
      ['null', 'null'],
      ['数组', '[1,2]'],
      ['字符串', '"asr"'],
      ['数字', '42']
    ]) {
      const file = join(dir, `shape-${name}.json`)
      await writeFile(file, content)
      expect(await readJsonFile(file)).toEqual({
        status: 'corrupt',
        detail: '文件内容不是一个 JSON 对象'
      })
    }
  })

  it('空文件也算 corrupt，但 detail 是解析器那句话', async () => {
    // 这一条和上一条走的是两个分支：前者 JSON.parse 就抛了，后者解得开、是形状不对
    const file = join(dir, 'shape-empty.json')
    await writeFile(file, '')
    const result = await readJsonFile(file)
    expect(result.status).toBe('corrupt')
    expect(result.status === 'corrupt' && result.detail).not.toBe('文件内容不是一个 JSON 对象')
  })

  /**
   * 「目录」用来代表读不出内容：readFile 稳定抛 EISDIR（本机实测），
   * 而且不像 chmod——CI 里以 root 跑时权限位根本不拦人，会测出一个假通过。
   */
  it('读不出内容是 unreadable，detail 里带 errno 的 code', async () => {
    await mkdir(join(dir, 'c.json'))
    const result = await readJsonFile(join(dir, 'c.json'))
    expect(result.status).toBe('unreadable')
    expect(result.status === 'unreadable' && result.detail).toContain('EISDIR')
  })

  it('errnoDetail 把 code 排在最前，非 Error 也能变成一句话', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    expect(errnoDetail(err)).toBe('EACCES: permission denied')
    expect(errnoDetail(new Error('no code'))).toBe('no code')
    expect(errnoDetail('只是一串字')).toBe('只是一串字')
  })
})

describe('atomicWriteJson：先 .tmp 再 rename', () => {
  const file = () => join(dir, 'd.json')

  it('写出来的是能解析的 JSON，且磁盘上不留 .tmp', async () => {
    await atomicWriteJson(file(), { aiModel: 'gpt-4o', n: 1 })
    expect(JSON.parse(await readText(file()))).toEqual({ aiModel: 'gpt-4o', n: 1 })
    expect(await names()).toEqual(['d.json'])
  })

  it('父目录不存在时自己建出来', async () => {
    const nested = join(dir, 'logs', 'deep', 'e.json')
    await atomicWriteJson(nested, { ok: true })
    expect(JSON.parse(await readText(nested))).toEqual({ ok: true })
  })

  it('backup 打开时，第二次写入把上一份复制成 .bak，第一次写入不假装失败', async () => {
    await atomicWriteJson(file(), { v: 1 }, { backup: true })
    // 首次根本没有上一份，ENOENT 不是故障：不该要调用方去日志里查一条不存在的事故
    expect(await names()).toEqual(['d.json'])

    let notified = 0
    await atomicWriteJson(file(), { v: 2 }, { backup: true, onBackupFailure: () => notified++ })
    expect(notified).toBe(0)
    expect(JSON.parse(await readText(`${file()}.bak`))).toEqual({ v: 1 })
    expect(JSON.parse(await readText(file()))).toEqual({ v: 2 })
  })

  it('备份没成不阻断这次保存，但原因要交回调用方', async () => {
    // 把 .bak 的目标做成一个目录：copyFile 打不开它，但 rename 与主文件都不受影响
    await atomicWriteJson(file(), { v: 1 })
    await mkdir(`${file()}.bak`)
    const seen: string[] = []
    await atomicWriteJson(file(), { v: 2 }, { backup: true, onBackupFailure: (d) => seen.push(d) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('EISDIR')
    expect(JSON.parse(await readText(file()))).toEqual({ v: 2 })
  })

  it('写入半途失败时把 .tmp 清掉：磁盘上不该留一个没人认领的临时文件', async () => {
    // 目标位置是个非空目录 → rename 必然失败（不用 chmod，CI 以 root 跑时权限拦不住人）
    const blocked = join(dir, 'f.json')
    await mkdir(blocked)
    await writeFile(join(blocked, 'inside.txt'), 'x')
    await expect(atomicWriteJson(blocked, { v: 1 })).rejects.toThrow()
    expect(await names()).toEqual(['f.json'])
  })

  it('连序列化都过不去时直接抛错，既不写盘也不留痕', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(atomicWriteJson(file(), circular)).rejects.toThrow()
    expect(await names()).toEqual([])
  })

  it('不传 backup 就不产生 .bak：读一个 JSON 的文件不必都背上历史副本', async () => {
    await atomicWriteJson(file(), { v: 1 })
    await atomicWriteJson(file(), { v: 2 })
    expect(await names()).toEqual(['d.json'])
  })
})

describe('pruneOlderCopies：同前缀只留最新几份', () => {
  it('按名字排序删最旧的，只碰这个前缀', async () => {
    for (const stamp of ['01', '02', '03', '04', '05', '06']) {
      await writeFile(join(dir, corruptSettingsName(`202601${stamp}-000000`)), 'x')
    }
    await writeFile(settingsFile(), 'keep me')
    await writeFile(`${settingsFile()}.bak`, 'keep me too')

    await pruneOlderCopies(CORRUPT_SETTINGS_PREFIX, 3)

    const kept = (await names())
      .filter((n) => n.startsWith(CORRUPT_SETTINGS_PREFIX))
      .sort()
    expect(kept).toEqual([
      'settings.json.corrupt-20260104-000000',
      'settings.json.corrupt-20260105-000000',
      'settings.json.corrupt-20260106-000000'
    ])
    // 别的文件一个都不该被牵连：这一层同时住着 settings.json 与它的 .bak
    expect(await readText(settingsFile())).toBe('keep me')
    expect(await readText(`${settingsFile()}.bak`)).toBe('keep me too')
  })

  it('份数没到上限时什么都不删；清扫失败也不该把主流程搭进去', async () => {
    await writeFile(join(dir, corruptSettingsName('20260101-000000')), 'x')
    await pruneOlderCopies(CORRUPT_SETTINGS_PREFIX, 5)
    expect(await names()).toEqual(['settings.json.corrupt-20260101-000000'])

    // userData 换成一个不存在的目录：readdir 抛错，这一层选择咽下来交给下次
    pointAt(join(dir, 'not-created-yet'))
    await expect(pruneOlderCopies(CORRUPT_SETTINGS_PREFIX, 0)).resolves.toBeUndefined()
  })
})
