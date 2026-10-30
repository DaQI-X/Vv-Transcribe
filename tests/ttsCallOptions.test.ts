/**
 * 配音「单次调用参数」的收口测试。
 * 这条口子是界面唯一能指定「这次跑哪档模型」的地方，而它一旦收错，症状是
 * 「界面显示 A、实际出声是 B」——用户听见的不一定是他选的那个。
 * 2026-10-29 本机试听就踩实过一次（空串引擎落回 VITS 而界面写着 Kokoro），
 * 下面那条 case 就是当时的回归锚。
 */
import { describe, expect, it } from 'vitest'
import { toSegments, withOverrides } from '../electron/main/ipc/ttsHandlers'
import type { TTSConfig } from '../electron/main/services/ttsService'

const KOKORO = 'kokoro-multi-lang-v1_1'
const VITS = 'sherpa-onnx-vits-zh-ll'

/** 一份「云端档、已保存过模型与音色」的配置，作为 base 参与覆盖计算 */
const base: TTSConfig = {
  engine: 'cloud',
  apiKey: 'sk-test',
  apiBase: 'https://gateway.example.com',
  model: 'tts-1',
  voice: 'alloy',
  localEngine: KOKORO,
}

describe('withOverrides', () => {
  it('没传任何东西时按 base 取值，倍速落成 1', () => {
    const got = withOverrides(base, undefined)
    expect(got.model).toBe('tts-1')
    expect(got.voice).toBe('alloy')
    expect(got.localEngine).toBe(KOKORO)
    expect(got.speed).toBe(1)
  })

  it('null、数字、字符串这些非对象入参都不该抛错，一律当「没覆盖」', () => {
    for (const raw of [null, undefined, 42, 'local', true, []]) {
      expect(() => withOverrides(base, raw)).not.toThrow()
      expect(withOverrides(base, raw).model).toBe('tts-1')
    }
  })

  it('空串与纯空白＝没覆盖，回落到设置里那值（不是把配置清空）', () => {
    const got = withOverrides(base, { model: '', voice: '   ' })
    expect(got.model).toBe('tts-1')
    expect(got.voice).toBe('alloy')
  })

  it('非空值才生效，且先 trim', () => {
    const got = withOverrides(base, { model: '  cosyvoice-v2  ', voice: ' longxiaochun ' })
    expect(got.model).toBe('cosyvoice-v2')
    expect(got.voice).toBe('longxiaochun')
  })

  it('回归锚：引擎传空串必须保住设置里那档 Kokoro，不能落回 VITS 默认值', () => {
    expect(withOverrides(base, { localEngine: '' }).localEngine).toBe(KOKORO)
    expect(withOverrides(base, { localEngine: undefined }).localEngine).toBe(KOKORO)
    expect(withOverrides(base, {}).localEngine).toBe(KOKORO)
  })

  it('引擎传非空时按单次选择切换，两档都能被指名', () => {
    expect(withOverrides(base, { localEngine: VITS }).localEngine).toBe(VITS)
    expect(withOverrides(base, { localEngine: ` ${KOKORO} ` }).localEngine).toBe(KOKORO)
  })

  it('引擎白名单外的值进不来：它会被拼成模型目录名', () => {
    expect(withOverrides(base, { localEngine: '../../tmp' }).localEngine).toBe(VITS)
    expect(withOverrides(base, { localEngine: 123 }).localEngine).toBe(KOKORO)
  })

  it('倍速夹进 0.25–4.0，非个数一律退回 1', () => {
    expect(withOverrides(base, { speed: 0.1 }).speed).toBe(0.25)
    expect(withOverrides(base, { speed: 9 }).speed).toBe(4)
    expect(withOverrides(base, { speed: 1.2 }).speed).toBe(1.2)
    expect(withOverrides(base, { speed: 0 }).speed).toBe(1)
    expect(withOverrides(base, { speed: -3 }).speed).toBe(1)
    expect(withOverrides(base, { speed: Number.NaN }).speed).toBe(1)
    expect(withOverrides(base, { speed: Infinity }).speed).toBe(1)
    expect(withOverrides(base, { speed: '2.5' }).speed).toBe(2.5)
    expect(withOverrides(base, { speed: 'fast' }).speed).toBe(1)
    expect(withOverrides(base, { speed: null }).speed).toBe(1)
  })

  it('云端/本地这一档不允许被单次调用改写：它决定花不花钱、要不要拉起本机进程', () => {
    const got = withOverrides(base, { engine: 'local' })
    expect(got.engine).toBe('cloud')
  })

  it('覆盖只动该动的四个字段，Key 与接口地址原样带过去', () => {
    const got = withOverrides(base, { model: 'tts-1-hd' })
    expect(got.apiKey).toBe('sk-test')
    expect(got.apiBase).toBe('https://gateway.example.com')
  })
})

describe('toSegments', () => {
  it('非数组一律当空段落，不抛错', () => {
    for (const input of [undefined, null, 'x', 42, {}]) {
      expect(toSegments(input)).toEqual([])
    }
  })

  it('正常段落原样收：时间轴只有渲染层有这一份', () => {
    const got = toSegments([
      { id: 'a', startTime: 0, endTime: 2.5, text: '第一句' },
      { id: 'b', startTime: 2.5, endTime: 5, text: '第二句' },
    ])
    expect(got).toEqual([
      { id: 'a', startTime: 0, endTime: 2.5, text: '第一句' },
      { id: 'b', startTime: 2.5, endTime: 5, text: '第二句' },
    ])
  })

  it('没有 id 的段落直接丢掉：整批合成按 id 记账，缺了就没法回报哪段失败', () => {
    expect(toSegments([{ startTime: 0, endTime: 1, text: '无 id' }])).toEqual([])
    expect(toSegments([{ id: '', startTime: 0, endTime: 1, text: '空 id' }])).toEqual([])
    expect(toSegments([{ id: null, startTime: 0, endTime: 1, text: 'x' }])).toEqual([])
  })

  it('数字型 id 收成字符串，跟渲染层的类型对齐', () => {
    expect(toSegments([{ id: 7, startTime: 0, endTime: 1, text: 'x' }])[0].id).toBe('7')
  })

  it('时间不是个数就落 0，而不是 NaN——NaN 进 ffmpeg 的铺轴参数会让整条轨拼不出来', () => {
    const got = toSegments([{ id: 'a', startTime: 'abc', endTime: undefined, text: 'x' }])
    expect(got[0].startTime).toBe(0)
    expect(got[0].endTime).toBe(0)
    expect(Number.isNaN(got[0].startTime)).toBe(false)
  })

  it('文本缺失按空串收（空段会在合成阶段跳过并说明原因，不能在这里变成 undefined）', () => {
    expect(toSegments([{ id: 'a', startTime: 0, endTime: 1 }])[0].text).toBe('')
    expect(toSegments([{ id: 'a', startTime: 0, endTime: 1, text: null }])[0].text).toBe('')
  })

  it('界面多带的字段不会跟着进主进程', () => {
    const got = toSegments([{ id: 'a', startTime: 0, endTime: 1, text: 'x', speaker: '旁白' }])
    expect(Object.keys(got[0]).sort()).toEqual(['endTime', 'id', 'startTime', 'text'])
  })
})
