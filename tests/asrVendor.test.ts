/**
 * 云端转写厂商适配层的测试（1.1.1，#224 转写侧）。
 *
 * 这一层是「真实转写走得通、设置里那颗自检也必须走同一条路」的唯一保证：两个调用点
 * （cloudASR 与 connectionTestService）都只问这一个函数要 URL 和字段名，所以这里钉住的
 * 就是那两处共同的请求形状。改错一个键名不会有编译错误，只会在用户点了「开始转写」之后
 * 换回一句对方网关的 400/404——而那时烧的是他自己 Key 上的额度。
 *
 * 值写死按原厂文档：MiniMax 的音频接口不是它自己那个 OpenAI 兼容层（那层只覆盖文本），
 * 所以路径、字段名和默认模型名都必须逐条钉住，不能靠「兼容」两个字推定。
 */
import { describe, expect, it } from 'vitest'
import {
  ASR_VENDOR_DEFAULT_MODEL,
  ASR_VENDOR_NAMES,
  buildAsrRequest,
  normalizeAsrVendor,
  type AsrRequestInput,
} from '../electron/main/services/asr/asrVendor'

const input: AsrRequestInput = {
  apiBase: 'https://gateway.example.com',
  model: 'the-model',
  language: '',
}

function shapeOf(vendor: unknown, over: Partial<AsrRequestInput> = {}) {
  return buildAsrRequest(vendor, { ...input, ...over })
}

describe('normalizeAsrVendor：不认识的一律按 OpenAI 兼容', () => {
  it('两家原样读回，大小写与空格不影响', () => {
    expect(normalizeAsrVendor('openai')).toBe('openai')
    expect(normalizeAsrVendor('minimax')).toBe('minimax')
    expect(normalizeAsrVendor(' MiniMax ')).toBe('minimax')
  })

  it('空串、缺字段、非字符串都落回 openai', () => {
    // 磁盘上 1.1.1 之前建出来的方案根本没有这一项；settings.json 又允许用户手改
    for (const raw of ['', '  ', undefined, null, 'cloud', 'dashscope', 0, {}, [], true]) {
      expect(normalizeAsrVendor(raw)).toBe('openai')
    }
  })

  it('转写模式那个值不会被误当成厂商', () => {
    // 'cloud' / 'local' 是全局段 asrProvider 的取值，长得像书签但不是：
    // 认错了等于把用户的请求发到一家他压根没选的网关
    expect(normalizeAsrVendor('cloud')).toBe('openai')
    expect(normalizeAsrVendor('local')).toBe('openai')
  })
})

describe('buildAsrRequest：OpenAI 兼容档', () => {
  it('路径与字段名按 OpenAI 的转写接口', () => {
    const shape = shapeOf('openai')
    expect(shape.url).toBe('https://gateway.example.com/v1/audio/transcriptions')
    expect(shape.fields).toEqual({
      model: 'the-model',
      response_format: 'verbose_json',
      'timestamp_granularities[0]': 'segment',
    })
  })

  it('模型留空时用这一家的默认档', () => {
    expect(shapeOf('openai', { model: '' }).fields.model).toBe(ASR_VENDOR_DEFAULT_MODEL.openai)
    expect(shapeOf('openai', { model: '   ' }).fields.model).toBe('whisper-1')
  })
})

describe('buildAsrRequest：MiniMax 档', () => {
  it('走的是 /v1/speech_to_text，不是 OpenAI 兼容那条路径', () => {
    expect(shapeOf('minimax').url).toBe('https://gateway.example.com/v1/speech_to_text')
  })

  it('分段那一项叫 timestamp_level，没有 timestamp_granularities', () => {
    // 这一条是本档存在的理由：字段名沿用 openai 那一支的话，MiniMax 收不收都不报错，
    // 只是返回里没有时间——字幕整条压在 0 上，界面看着像「转写成功但字幕坏了」
    expect(shapeOf('minimax').fields).toEqual({
      model: 'the-model',
      response_format: 'verbose_json',
      timestamp_level: 'sentence',
    })
  })

  it('模型留空时用的是 asr 那一条，不是 whisper-1', () => {
    expect(shapeOf('minimax', { model: '' }).fields.model).toBe('asr-1.0')
    expect(ASR_VENDOR_DEFAULT_MODEL.minimax).toBe('asr-1.0')
  })
})

describe('buildAsrRequest：两家共有的口径', () => {
  it('语言留空时干脆不发这一项', () => {
    // 把一个空 language 递过去，两家的默认行为并不一样，等于替用户猜一份
    for (const vendor of ['openai', 'minimax']) {
      expect(shapeOf(vendor, { language: '' }).fields).not.toHaveProperty('language')
      expect(shapeOf(vendor, { language: 'zh' }).fields.language).toBe('zh')
    }
  })

  it('没填厂商的老方案发出来的形状与 openai 完全一致', () => {
    // 「加这一项不改变任何已有配置的行为」这句承诺的可执行版本
    expect(shapeOf(undefined)).toEqual(shapeOf('openai'))
    expect(shapeOf('dashscope')).toEqual(shapeOf('openai'))
  })

  it('地址原样拼上去：尾部斜杠的收口不归这一层', () => {
    // 两个调用点传进来的都是 normalizeApiBase 之后的值，所以这里不该再修一遍——
    // 修了就会出现「适配层容错、真链路照样炸」的分歧；这一条只用来钉住「这里不修」
    expect(shapeOf('minimax', { apiBase: 'https://a.example/v1/' }).url).toBe(
      'https://a.example/v1//v1/speech_to_text'
    )
  })

  it('界面上的名字都认得', () => {
    expect(ASR_VENDOR_NAMES.openai).toBe('OpenAI 兼容接口')
    expect(ASR_VENDOR_NAMES.minimax).toBe('MiniMax')
    expect(Object.keys(ASR_VENDOR_NAMES).sort()).toEqual(Object.keys(ASR_VENDOR_DEFAULT_MODEL).sort())
  })
})
