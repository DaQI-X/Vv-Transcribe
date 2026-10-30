/**
 * settings.json 的读盘/写盘契约。
 * 这里测的不是某个函数返回什么，而是「磁盘出问题时，用户填过的 Key 还在不在」：
 * 旧写法把一个 catch 等同于「给默认值」，于是半截 JSON、只读介质都会让界面以为「用户还没填」，
 * 用户点一次保存就把原来那份盖掉了——1.0.8 把这条排进 P0 就是因为它丢的是不可恢复的数据。
 * 后半段的「配置格式版本」是同一个问题的另一面：旧文件搬上来要盖戳，本版本读不懂的新文件
 * 既不搬、不改名、不写回——读不懂不等于坏了，把它当坏的就会抹掉更新版本正在用的配置。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_WRITE_BLOCKED,
  SETTINGS_WRITE_BLOCKED_NEWER_VERSION
} from '../electron/main/services/settingsService'

type Service = typeof import('../electron/main/services/settingsService')

let dir = ''
let service: Service

const file = () => join(dir, 'settings.json')

/** 换一份干净的 userData：用例里中途换目录时必须先删掉旧的，不然临时目录会越堆越多 */
async function resetDir(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(tmpdir(), 'vv-settings-'))
}

/**
 * 每个用例都要一份全新的模块：cache / loadProblem / writeBlocked 是模块级状态，
 * 不重灌就会把上一个用例的结论带进来。setup.ts 里的 electron 替身在 resetModules 之后
 * 仍是同一个对象（实测过），所以这里 spyOn 就够用，不必为了测试给生产代码开后门。
 */
async function loadInto(freshDir: string): Promise<void> {
  vi.resetModules()
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? freshDir : join(freshDir, name))) as typeof app.getPath
  )
  service = await import('../electron/main/services/settingsService')
}

async function namesWith(prefix: string): Promise<string[]> {
  return (await readdir(dir))
    .filter((name) => name.startsWith(prefix))
    .sort()
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
}

beforeEach(resetDir)

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('首次运行', () => {
  it('没有 settings.json 时按默认值起来，storageProblem 是 null（没文件不是故障）', async () => {
    await loadInto(dir)
    const settings = await service.loadSettings()
    expect(settings.asrProvider).toBe('local')
    expect(settings.aiApiBase).toBe('')
    expect((await service.getSettingsView()).storageProblem).toBeNull()
    // 只读不该在磁盘上留下任何文件：首次启动的用户此刻还没有一份需要他负责的配置
    expect(await readdir(dir)).toEqual([])
  })
})

describe('正常读写', () => {
  it('Key 以 v1: 密文落盘，重新载入后还能解出来（模拟一次重启）', async () => {
    await loadInto(dir)
    await service.saveSettings({ asrApiKey: 'sk-first-abcdef', aiModel: 'gpt-4o' })
    expect((await readJson(file())).asrApiKey as string).toMatch(/^v1:/)
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-first-abcdef')

    await loadInto(dir)
    const reloaded = await service.loadSettings()
    expect(reloaded.asrApiKey).toBe('sk-first-abcdef')
    expect(reloaded.aiModel).toBe('gpt-4o')
    expect((await service.getSettingsView()).asrKeyStatus).toBe('encrypted')
  })

  it('第二次保存前把上一份复制成 .bak，里面是被替换掉的那一版', async () => {
    await loadInto(dir)
    await service.saveSettings({ asrApiKey: 'sk-first-abcdef' })
    const first = await readJson(file())
    expect(await namesWith('settings.json.bak')).toEqual([])

    await service.saveSettings({ asrApiKey: 'sk-second-uvwxyz' })
    const backup = await readJson(`${file()}.bak`)
    expect(backup.asrApiKey).toBe(first.asrApiKey)
    expect((await readJson(file())).asrApiKey).not.toBe(first.asrApiKey)
  })

  it('留空＝不改、null＝清除：只改模型名不会把磁盘上那把 Key 弄丢', async () => {
    await loadInto(dir)
    await service.saveSettings({ aiApiKey: 'sk-keep-me' })
    await service.saveSettings({ aiModel: 'gpt-4o-mini' })
    expect((await service.loadSettings()).aiApiKey).toBe('sk-keep-me')

    await service.saveSettings({ aiApiKey: null })
    expect((await service.loadSettings()).aiApiKey).toBe('')
  })
})

describe('settings.json 解不开（corrupt）', () => {
  const broken = '{"asrProvider":"local","aiApiKey":"v1:'

  it('原件改名留档、内容一字不差，界面拿到那句提示', async () => {
    await writeFile(file(), broken)
    await loadInto(dir)

    const problem = (await service.getSettingsView()).storageProblem
    expect(problem).toContain('没能解析')
    const archived = await namesWith('settings.json.corrupt-')
    expect(archived).toHaveLength(1)
    expect(problem).toContain(archived[0])
    expect(await readFile(join(dir, archived[0]), 'utf-8')).toBe(broken)
    // 坏的那份不再占着原位，下一次写盘是全新的一份，不会跟半截内容混在一起
    await expect(readFile(file(), 'utf-8')).rejects.toThrow('ENOENT')
  })

  it('留档之后允许写回新配置，但「原件被留档过」不会因为写盘成功而消失', async () => {
    await writeFile(file(), broken)
    await loadInto(dir)
    await service.getSettingsView()
    const archived = (await namesWith('settings.json.corrupt-'))[0]

    await service.saveSettings({ aiModel: 'gpt-4o' })
    expect((await readJson(file())).aiModel).toBe('gpt-4o')
    // 这条是设计决定，不是实现巧合：留档发生过，界面就得一直说得出原件在哪个文件里
    expect((await service.getSettingsView()).storageProblem).toContain(archived)
  })

  it('空文件与「解得开但不是对象」都按解析失败留档，不会当成一份合法配置', async () => {
    for (const content of ['', 'null', '[1,2]', '"asr"']) {
      await resetDir()
      await writeFile(file(), content)
      await loadInto(dir)
      expect((await service.getSettingsView()).storageProblem).toContain('没能解析')
      expect(await namesWith('settings.json.corrupt-')).toHaveLength(1)
    }
  })

  it('留档最多只留最新 5 份：每次启动都坏一次的话，不能把数据目录变成垃圾场', async () => {
    for (let i = 0; i < 7; i++) {
      await writeFile(join(dir, `settings.json.corrupt-2026010${i}-000000`), 'x')
    }
    await writeFile(file(), broken)
    await loadInto(dir)
    await service.getSettingsView()

    const kept = await namesWith('settings.json.corrupt-')
    expect(kept).toHaveLength(5)
    expect(kept).not.toContain('settings.json.corrupt-20260100-000000')
    expect(kept).toContain('settings.json.corrupt-20260106-000000')
  })
})

describe('settings.json 读不出内容（unreadable）', () => {
  /**
   * 用「settings.json 是个目录」造这个状态：readFile 稳定抛 EISDIR（本机实测），
   * 而且不像 chmod 那样——CI 里以 root 跑时权限位根本不拦人，会测出一个假通过。
   */
  beforeEach(async () => {
    await mkdir(file())
  })

  it('提示里带上 errno 和「保存已停用」，且这份配置不会被就地覆盖', async () => {
    await loadInto(dir)
    const problem = (await service.getSettingsView()).storageProblem
    expect(problem).toContain('EISDIR')
    expect(problem).toContain('保存已暂时停用')
    expect((await readdir(dir)).includes('settings.json')).toBe(true)
  })

  it('本次禁止写盘：连内容都没读到，写下去就是把猜测盖到用户的东西上', async () => {
    await loadInto(dir)
    await expect(service.saveSettings({ aiModel: 'gpt-4o' })).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    // 闸门在碰磁盘之前就落下：既不写 .tmp，也不复制 .bak（那份读不出来的东西不该被任何人读过一遍就改名）
    expect((await readdir(dir)).includes('settings.json.tmp')).toBe(false)
    expect((await readdir(dir)).includes('settings.json.bak')).toBe(false)
  })
})

describe('配置格式版本（schemaVersion 与迁移链）', () => {
  it('没有版本字段的旧文件：搬完把版本盖回去，而且这事不打扰用户', async () => {
    // 1.0.5 及之前的文件确实不写版本号，这一条既是迁移也是「别再靠猜」的收口：
    // 只有写盘那一处产生版本字段，下一个读的人不用再猜第二遍
    await writeFile(file(), JSON.stringify({ aiTtsModel: 'cosyvoice-v1', aiModel: 'gpt-4o' }))
    await loadInto(dir)

    const settings = await service.loadSettings()
    expect(settings.ttsModel).toBe('cosyvoice-v1')
    expect(settings.aiModel).toBe('gpt-4o')
    expect((await service.getSettingsView()).storageProblem).toBeNull()

    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(1)
    expect('aiTtsModel' in onDisk).toBe(false)
  })

  it('版本已经是当前值：读完一个字节都不动', async () => {
    // 迁移不是「顺手整理一下」。文件说自己已经是 v1 了还去重写，用户看到的保存成功
    // 其实是我们替他改过一次配置，而这次改动没有任何人要求过
    const content = '{\n  "schemaVersion": 1,\n  "aiModel": "gpt-4o"\n}'
    await writeFile(file(), content)
    await loadInto(dir)
    await service.loadSettings()
    await service.getSettingsView()
    expect(await readFile(file(), 'utf-8')).toBe(content)
    expect(await namesWith('settings.json')).toEqual(['settings.json'])
  })

  it('文件来自更新版本：界面说得出是哪个版本，写盘被拦，那份文件一字未动', async () => {
    // 这条防的是「装了 1.0.9 又回退到 1.0.8」：那一版的多配置与历史记录本版本读不懂，
    // 但读不懂不等于坏了——改名留档会挪走人家正在用的配置，写回会抹掉 profiles
    const content = JSON.stringify(
      { schemaVersion: 2, profiles: [{ name: '工作' }], aiModel: 'gpt-4o' },
      null,
      2
    )
    await writeFile(file(), content)
    await loadInto(dir)

    const view = await service.getSettingsView()
    expect(view.storageProblem).toContain('更新版本')
    expect(view.storageProblem).toContain('v2')
    expect(view.aiModel).toBe('')

    await expect(service.saveSettings({ aiModel: 'gpt-4o-mini' })).rejects.toThrow(
      SETTINGS_WRITE_BLOCKED_NEWER_VERSION
    )
    expect(await readFile(file(), 'utf-8')).toBe(content)
    // 不改名（那是「它坏了」的说法，可它没坏）、不备份、不留临时文件。按前缀筛而不是比整个目录：
    // 这一条会写 ERROR 日志，userData 下多一个 logs/ 是正常的
    expect(await namesWith('settings.json')).toEqual(['settings.json'])
  })

  it('版本写坏成字符串/小数时不按「未来版本」处理：先搬回当前再盖新戳', async () => {
    // 与上一条的分别是「哪个方向更可恢复」：这种写法更像是有人手改坏了文件，
    // 按 v0 走一步就把它整理回本版本认得的样子；装成未来版本会让人一直卡在写不进去
    await writeFile(file(), JSON.stringify({ schemaVersion: '1', aiTtsModel: 'old-voice' }))
    await loadInto(dir)
    expect((await service.getSettingsView()).storageProblem).toBeNull()
    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.ttsModel).toBe('old-voice')
    expect('aiTtsModel' in onDisk).toBe(false)
  })

  it('旧字段与历史明文 Key 同时存在时，一次读盘就把两件事都办完', async () => {
    // 迁移写盘与密钥就地加密各写一次，中间那次留下的 .bak 是「搬完但还没加密」的那份——
    // 这条测的是两次写不打架：最终的磁盘上版本、字段、密文三样都对
    await writeFile(
      file(),
      JSON.stringify({ aiTtsModel: 'cosyvoice-v1', aiApiKey: 'sk-legacy-plaintext' })
    )
    await loadInto(dir)
    expect((await service.loadSettings()).aiApiKey).toBe('sk-legacy-plaintext')

    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(1)
    expect('aiTtsModel' in onDisk).toBe(false)
    expect(onDisk.aiApiKey as string).toMatch(/^v1:/)
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-legacy-plaintext')

    // 内存里那份照常能用：迁移写盘失败也不该让用户觉得自己的配置没了（见 readCache 的 WARN 分支）
    const inMemory = await service.loadSettings()
    expect(inMemory.aiApiKey).toBe('sk-legacy-plaintext')
    expect(inMemory.ttsModel).toBe('cosyvoice-v1')

    // 再重灌一次模块当「重启应用」：磁盘上那份必须自己站得住——版本对、旧键没了、密文解得开
    await loadInto(dir)
    const rebooted = await service.loadSettings()
    expect(rebooted.aiApiKey).toBe('sk-legacy-plaintext')
    expect(rebooted.ttsModel).toBe('cosyvoice-v1')
  })
})
