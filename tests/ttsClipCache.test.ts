/**
 * 配音片段缓存（#362）的契约。
 *
 * 这一层的输出是「钱」：命中就少调一次接口，判错就白扔一整份缓存，而两种错都不会有任何报错——
 * 用户只会发现「改了 3 个字重出一版，300 段又全跑了一遍」，或者更糟：一条音轨里前半是旧音色、
 * 后半是新音色。所以这里钉死三件事：
 * ① 键的作废判据一维都不能少，apiKey 一维都不能多；
 * ② 缓存读不出来的每一种姿势（没目录、0 字节、半截 json）都只回「当它没有」，绝不把配音带失败；
 * ③ 落点在 userData 而不是临时目录，否则启动清扫会把它每次清空，代码等于白写。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearClipCache,
  clipCacheStats,
  clipFormat,
  clipFingerprint,
  lookupCachedClip,
  storeClip,
  writeClipMeta,
} from '../electron/main/services/ttsClipCache'
import { ttsClipCacheDir } from '../electron/main/services/userDataStore'
import type { TTSConfig } from '../electron/main/services/ttsService'

const KOKORO = 'kokoro-multi-lang-v1_1'
const VITS = 'sherpa-onnx-vits-zh-ll'

/** rename 抛 EXDEV 的开关：userData 与 tmpdir 不在同一卷时真会这样，那一档退回复制＋删源 */
const fsState = vi.hoisted(() => ({ exdevForRename: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (fsState.exdevForRename) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      }
      return actual.rename(from, to)
    },
  }
})

/** 一份「云端档、四项凭据齐」的配置：改哪一维就只改那一维，其余保持默认，才测得出「少了哪一维」 */
const cloud: TTSConfig = {
  engine: 'cloud',
  vendor: 'minimax',
  apiKey: 'sk-minimax-one',
  apiBase: 'https://api.minimaxi.com',
  model: 'speech-02-hd',
  resourceId: 'speech_02',
  voice: 'male-qn-qingse',
  localEngine: KOKORO,
}

/** 本地档：云端那四维留着上一次的脏值，正好用来验「本地档根本不看它们」 */
const local: TTSConfig = { ...cloud, engine: 'local', localEngine: VITS }

let root = ''
const text = '这是一句要念的话'
/** 纯函数，不碰磁盘：作为「什么都没改」那一头的基准键，模块级算一次就够 */
const CLOUD_KEY = clipFingerprint(cloud, text)

async function freshDir(): Promise<string> {
  await rm(root, { recursive: true, force: true })
  root = await mkdtemp(join(tmpdir(), 'vv-clip-'))
  return root
}

/** 把 userData 指到临时目录：ttsClipCacheDir 每次被调用时才问一次路径，换目录不用重灌模块 */
function pointAt(fresh: string): void {
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? fresh : join(fresh, name))) as typeof app.getPath
  )
}

/** 造一条真音频那么大的文件（内容无所谓，这一层只认字节数与在不在） */
async function makeAudio(path: string, bytes: number): Promise<void> {
  await writeFile(path, Buffer.alloc(bytes, 7))
}

beforeEach(async () => {
  fsState.exdevForRename = false
  pointAt(await freshDir())
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('clipFormat：容器跟着档走', () => {
  it('云端是 mp3、本地是 wav，与两处写盘的文件名同源', () => {
    expect(clipFormat(cloud)).toBe('mp3')
    expect(clipFormat(local)).toBe('wav')
  })

  it('换厂商不换容器：容器只由「哪一档」决定', () => {
    expect(clipFormat({ ...cloud, vendor: 'dashscope' })).toBe(clipFormat(cloud))
  })
})

describe('clipFingerprint：同输入必须同键', () => {
  it('同一套参数、同一句文本两次算出来一模一样（复用的全部依据就是这一条）', () => {
    expect(clipFingerprint(cloud, text)).toBe(clipFingerprint(cloud, text))
    expect(clipFingerprint(local, text)).toBe(clipFingerprint(local, text))
  })

  it('文本前后空白不算另一句：接口吃的本来就是 trim 过的那一份', () => {
    expect(clipFingerprint(cloud, `  ${text}\n`)).toBe(clipFingerprint(cloud, text))
  })

  it('改一个字就是另一句', () => {
    expect(clipFingerprint(cloud, '这是一句要念的话。')).not.toBe(clipFingerprint(cloud, text))
  })

  it('倍速不填和填 1 是同一件事（发请求时本来就不发这一项）', () => {
    expect(clipFingerprint(cloud, text)).toBe(clipFingerprint({ ...cloud, speed: 1 }, text))
  })

  it('键是一串 sha256，文件名里既没有原文也没有密钥', async () => {
    const fp = clipFingerprint(cloud, text)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    await storeClip(await tempSrc(128), fp, 'mp3', { duration: 2.5, bytes: 128 })
    const names = await readdir(ttsClipCacheDir())
    expect(names.filter((n) => !n.endsWith('.json'))).toEqual([`${fp}.mp3`])
  })
})

describe('clipFingerprint：作废判据一维都不能少', () => {
  /**
   * 少一维的症状是「换了音色，只有没重跑的那几段是新音色」——一条串音色的音轨比整条重烧贵得多。
   * 所以逐维换一次、逐维要求换键，缺哪一维这条就当场红。
   */
  it('厂商 / 接口地址 / 模型 / 资源编号 / 音色 / 倍速 / 档 / 本地引擎，换哪一维都换键', () => {
    const base = clipFingerprint(cloud, text)
    const changed: Array<[string, TTSConfig]> = [
      ['厂商', { ...cloud, vendor: 'openai' }],
      ['接口地址', { ...cloud, apiBase: 'https://gateway.example.com' }],
      ['模型', { ...cloud, model: 'speech-02-turbo' }],
      ['资源编号', { ...cloud, resourceId: 'speech_01' }],
      ['音色', { ...cloud, voice: 'female-shaonv' }],
      ['倍速', { ...cloud, speed: 1.2 }],
      ['档（云端↔本地）', { ...cloud, engine: 'local' as const }],
    ]
    for (const [name, config] of changed) {
      expect(clipFingerprint(config, text), name).not.toBe(base)
    }
    // 本地档换引擎同样换键：VITS 和 Kokoro 出来的音色不是一回事
    expect(clipFingerprint({ ...local, localEngine: KOKORO }, text)).not.toBe(
      clipFingerprint(local, text)
    )
  })

  it('接口地址只差大小写与首尾空白，算同一个头', () => {
    expect(clipFingerprint({ ...cloud, apiBase: '  HTTPS://API.minimaxi.com  ' }, text)).toBe(CLOUD_KEY)
  })

  it('换 API Key 不换键：换 Key 不改听感，算进去等于让用户换个账号白扔一整份缓存', () => {
    expect(clipFingerprint({ ...cloud, apiKey: 'sk-another-account' }, text)).toBe(CLOUD_KEY)
    expect(clipFingerprint({ ...cloud, apiKey: '' }, text)).toBe(CLOUD_KEY)
  })

  it('本地档不看云端那四维：往本地配置里塞脏的厂商/地址/模型/编号不该把本地缓存判死', () => {
    const dirty: TTSConfig = {
      ...local,
      vendor: 'openai',
      apiBase: 'https://whatever.example.com',
      model: 'tts-1',
      resourceId: 'x',
    }
    expect(clipFingerprint(dirty, text)).toBe(clipFingerprint(local, text))
  })

  it('档不同就一定不同键，哪怕其余字段一个字都没改', () => {
    expect(clipFingerprint({ ...cloud, engine: 'local' }, text)).not.toBe(
      clipFingerprint({ ...cloud, engine: 'cloud' }, text)
    )
  })

  it('文本是最后一维：以上都相同、只有句子不同，必须不同键', () => {
    expect(clipFingerprint(cloud, '甲')).not.toBe(clipFingerprint(cloud, '乙'))
  })
})

describe('lookupCachedClip：读不出来一律只回「当它没有」', () => {
  it('缓存目录还没建过（从没配过音）不算故障', async () => {
    expect(await lookupCachedClip('f'.repeat(64), 'mp3')).toBeNull()
  })

  it('文件不在是 null；容器对不上也是 null（云端 mp3 不能认本地 wav 那份）', async () => {
    const fp = clipFingerprint(cloud, text)
    await storeClip(await tempSrc(100), fp, 'mp3', { duration: 1, bytes: 100 })
    expect(await lookupCachedClip(fp, 'mp3')).not.toBeNull()
    expect(await lookupCachedClip(fp, 'wav')).toBeNull()
  })

  it('0 字节不算「一条很短的音频」，是上次没写完：宁可重花一次钱，也不放一条坏音频进轨', async () => {
    const fp = clipFingerprint(cloud, text)
    await mkdir(ttsClipCacheDir(), { recursive: true })
    await writeFile(join(ttsClipCacheDir(), `${fp}.mp3`), '')
    expect(await lookupCachedClip(fp, 'mp3')).toBeNull()
  })

  it('那个位置是个目录时也当没有（不用 chmod 造读不了，CI 以 root 跑时权限拦不住人）', async () => {
    const fp = clipFingerprint(cloud, text)
    await mkdir(join(ttsClipCacheDir(), `${fp}.mp3`), { recursive: true })
    expect(await lookupCachedClip(fp, 'mp3')).toBeNull()
  })

  it('命中就回真实字节数，元数据齐全时一起带回', async () => {
    const fp = clipFingerprint(cloud, text)
    const src = await tempSrc(1234)
    const kept = await storeClip(src, fp, 'mp3', { duration: 3.25, bytes: 1234 })
    const hit = await lookupCachedClip(fp, 'mp3')
    expect(hit).toEqual({ filePath: kept.filePath, bytes: 1234, meta: { duration: 3.25, bytes: 1234 } })
    expect(hit?.meta?.duration).toBe(3.25)
  })

  it('元数据没落成（写一半被强杀）照样算命中，只是把时长交回调用方去探', async () => {
    const fp = clipFingerprint(cloud, text)
    await mkdir(ttsClipCacheDir(), { recursive: true })
    await makeAudio(join(ttsClipCacheDir(), `${fp}.mp3`), 300)
    const hit = await lookupCachedClip(fp, 'mp3')
    expect(hit?.bytes).toBe(300)
    expect(hit?.meta).toBeNull()
  })

  it('元数据是半截 JSON 或形状不对时算「不知道」，不算坏条目', async () => {
    const fp = clipFingerprint(cloud, text)
    await mkdir(ttsClipCacheDir(), { recursive: true })
    await makeAudio(join(ttsClipCacheDir(), `${fp}.mp3`), 300)
    for (const body of ['{"duratio', 'null', '[1,2]', '{"duration":"3"}', '{}']) {
      await writeFile(join(ttsClipCacheDir(), `${fp}.json`), body)
      expect((await lookupCachedClip(fp, 'mp3'))?.meta, body).toBeNull()
    }
  })

  it('字节数取磁盘上那一份，不信元数据里写过的数', async () => {
    const fp = clipFingerprint(cloud, text)
    await storeClip(await tempSrc(100), fp, 'mp3', { duration: 1, bytes: 100 })
    const real = join(ttsClipCacheDir(), `${fp}.mp3`)
    await makeAudio(real, 900)
    expect((await lookupCachedClip(fp, 'mp3'))?.bytes).toBe(900)
  })
})

describe('writeClipMeta：补写时长只是省一次 ffprobe', () => {
  it('写得进去，且写的是能读回来的那两个数', async () => {
    const fp = clipFingerprint(cloud, text)
    // 这一层不建目录：两个调用点（storeClip 之后、命中后补探时长）都已经先有了一条音频在盘上
    await mkdir(ttsClipCacheDir(), { recursive: true })
    await writeClipMeta(fp, { duration: 2, bytes: 64 })
    expect(JSON.parse(await readFile(join(ttsClipCacheDir(), `${fp}.json`), 'utf8'))).toEqual({
      duration: 2,
      bytes: 64,
    })
  })

  it('写不进去也不抛：缓存这一层不该让一次配音失败', async () => {
    const fp = clipFingerprint(cloud, text)
    // 目标位置站着一个目录 → writeFile 必抛 EISDIR
    await mkdir(join(ttsClipCacheDir(), `${fp}.json`), { recursive: true })
    await expect(writeClipMeta(fp, { duration: 2, bytes: 64 })).resolves.toBeUndefined()
  })
})

describe('storeClip：把刚合成的那条收进缓存', () => {
  it('搬走源文件、落下音频与元数据', async () => {
    const fp = clipFingerprint(cloud, text)
    const src = await tempSrc(2048)
    const kept = await storeClip(src, fp, 'mp3', { duration: 4.5, bytes: 2048 })
    expect(kept.filePath).toBe(join(ttsClipCacheDir(), `${fp}.mp3`))
    expect(kept.bytes).toBe(2048)
    expect(await stat(src).catch(() => null)).toBeNull()
    expect((await stat(kept.filePath)).size).toBe(2048)
    expect(JSON.parse(await readFile(join(ttsClipCacheDir(), `${fp}.json`), 'utf8')).duration).toBe(4.5)
  })

  it('同键重复存不报错，后一份顶掉前一份（重试那一段时源路径会变、键不变）', async () => {
    const fp = clipFingerprint(cloud, text)
    await storeClip(await tempSrc(100), fp, 'mp3', { duration: 1, bytes: 100 })
    const second = await storeClip(await tempSrc(220), fp, 'mp3', { duration: 2, bytes: 220 })
    expect((await stat(second.filePath)).size).toBe(220)
    expect((await lookupCachedClip(fp, 'mp3'))?.meta).toEqual({ duration: 2, bytes: 220 })
  })

  it('userData 与临时目录不在同一卷时退回复制＋删源，产物照样在缓存里', async () => {
    const fp = clipFingerprint(cloud, text)
    const src = await tempSrc(512)
    fsState.exdevForRename = true
    const kept = await storeClip(src, fp, 'mp3', { duration: 1.5, bytes: 512 })
    expect((await stat(kept.filePath)).size).toBe(512)
    expect(await stat(src).catch(() => null)).toBeNull()
    expect((await lookupCachedClip(fp, 'mp3'))?.meta).toEqual({ duration: 1.5, bytes: 512 })
  })

  it('收不进缓存时把临时路径原样交回去：这批照旧成，只是下一轮没得复用', async () => {
    const fp = clipFingerprint(cloud, text)
    const src = await tempSrc(700)
    // 缓存目录那个位置站着一个文件 → mkdir 抛 ENOTDIR，rename 根本没机会跑
    await writeFile(ttsClipCacheDir(), 'not a dir')
    const kept = await storeClip(src, fp, 'mp3', { duration: 9, bytes: 700 })
    expect(kept.filePath).toBe(src)
    expect((await stat(src)).size).toBe(700)
  })

  it('连源文件都没了时回传进来的字节数，不编一个 0 出去', async () => {
    const fp = clipFingerprint(cloud, text)
    await writeFile(ttsClipCacheDir(), 'not a dir')
    const kept = await storeClip(join(root, 'gone.mp3'), fp, 'mp3', { duration: 1, bytes: 333 })
    expect(kept.bytes).toBe(333)
  })
})

describe('clipCacheStats / clearClipCache：界面上那个数', () => {
  it('从没配过音是 0 段 0 字节，不报错', async () => {
    expect(await clipCacheStats()).toEqual({ bytes: 0, clips: 0 })
  })

  it('只数音频、元数据不计：那几十字节的 json 报上去会让数字读起来像猜的', async () => {
    for (const [i, cfg] of [
      [0, cloud],
      [1, local],
    ] as const) {
      const fp = clipFingerprint(cfg, `第 ${i} 句`)
      await storeClip(await tempSrc(1000 + i), fp, clipFormat(cfg), { duration: 1, bytes: 1000 + i })
    }
    const got = await clipCacheStats()
    expect(got.clips).toBe(2)
    expect(got.bytes).toBe(2001)
  })

  it('清掉之后回到 0，并报出释放了多少', async () => {
    const fp = clipFingerprint(cloud, text)
    await storeClip(await tempSrc(4096), fp, 'mp3', { duration: 1, bytes: 4096 })
    expect(await clearClipCache()).toBe(4096)
    expect(await clipCacheStats()).toEqual({ bytes: 0, clips: 0 })
    expect(await lookupCachedClip(fp, 'mp3')).toBeNull()
  })

  it('空的时候再清一次不报错，释放 0 字节', async () => {
    expect(await clearClipCache()).toBe(0)
    expect(await clearClipCache()).toBe(0)
  })
})

describe('落点这条硬约束', () => {
  /**
   * 两处删除都按 `transcribe-` 前缀干活：启动清扫扫 tmpdir 顶层（urlDownloader），
   * 每批跑完的 releaseBatch 删自己那个 `transcribe-tts-<jobId>`。缓存只要沾上这个前缀，
   * 配一次音就把上一批的成品删掉了——「下一次还在」这条根本意义当场归零。
   */
  it('缓存目录不落在任何 transcribe- 前缀的目录下面', () => {
    expect(ttsClipCacheDir().split('/').some((seg) => seg.startsWith('transcribe-'))).toBe(false)
  })

  it('也不和 records / 组件 / 日志任何一层同名：那是「用户勾了才留」的交付物，缓存是可丢弃的派生物', () => {
    const dir = ttsClipCacheDir()
    for (const other of ['records', 'components', 'logs', 'dictionary', 'settings.json']) {
      expect(dir).not.toBe(join(root, other))
    }
  })
})

/** 在临时目录里造一条「刚合成出来」的音频，模拟批次那次调用的产物 */
async function tempSrc(bytes: number): Promise<string> {
  const dir = await mkdtemp(join(root, 'batch-'))
  const path = join(dir, 'clip.mp3')
  await makeAudio(path, bytes)
  return path
}
