/**
 * 云端转写厂商适配层的测试（#224 转写侧）。
 *
 * 这一层是「真实转写走得通、设置里那颗自检也必须走同一条路」的唯一保证：两个调用点
 * （cloudASR 与 connectionTestService）都只问这一个函数要 URL、头和字段名，所以这里钉住的
 * 就是那两处共同的请求形状。改错一个键名不会有编译错误，只会在用户点了「开始转写」之后
 * 换回一句对方网关的 400/404——而那时烧的是他自己 Key 上的额度。
 *
 * 值写死按原厂文档：MiniMax 的音频接口不是它自己那个 OpenAI 兼容层（那层只覆盖文本），
 * 所以路径、字段名、语言放哪一层（字段还是头部）和默认模型名都必须逐条钉住，
 * 不能靠「兼容」两个字推定。
 *
 * 这一版只有两家（openai / minimax）。豆包与阿里云百炼的转写都没收——两家只吃「公网可访问的
 * 音频地址」，本机文件换不到一个能递给对方的地址；完整理由在 `asrVendor.ts` 抬头与
 * `src/utils/profileSpec.ts` 的 ASR_VENDOR_UI 抬头里。所以这两个名字在这里是**反向**断言：
 * 它们必须落回 openai（见 normalizeAsrVendor），不能凭空长出一条只属于它们的分支。
 */
import { describe, expect, it } from 'vitest'
import {
  ASR_VENDOR_DEFAULT_MODEL,
  ASR_VENDOR_NAMES,
  asrFileProblem,
  buildAsrRequest,
  normalizeAsrVendor,
  readAsrResponse,
  type AsrRequestInput,
} from '../electron/main/services/asr/asrVendor'

const input: AsrRequestInput = {
  apiBase: 'https://gateway.example.com',
  apiKey: 'sk-test-key',
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

  it('配音那一侧的厂商名不会被当成转写厂商', () => {
    // dashscope 与 volc 在 TTS 侧是真厂商，在转写侧都不接：两家的转写只吃公网音频地址
    // （理由见 src/utils/profileSpec.ts 里 ASR_VENDOR_UI 的抬头）。认错了等于把一份
    // OpenAI 形状的 multipart 请求发到一个既不认 Bearer 也不认 /v1/audio/transcriptions 的网关
    expect(normalizeAsrVendor('dashscope')).toBe('openai')
    expect(normalizeAsrVendor('volc')).toBe('openai')
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
    // 鉴权头收进这一层之后，调用方就不该再自己补一次 Bearer（补两次正是 1.1.1 的分歧来源之一）
    expect(shape.headers).toEqual({ Authorization: 'Bearer sk-test-key' })
  })

  it('模型留空时用这一家的默认档', () => {
    expect(shapeOf('openai', { model: '' }).fields.model).toBe(ASR_VENDOR_DEFAULT_MODEL.openai)
    expect(shapeOf('openai', { model: '   ' }).fields.model).toBe('whisper-1')
  })

  it('语言走 multipart 字段，不放头部', () => {
    // OpenAI 这条只认字段；这一档错了会直接 400，比 MiniMax 那一档容易被发现
    const shape = shapeOf('openai', { language: 'zh' })
    expect(shape.fields.language).toBe('zh')
    expect(shape.headers).toEqual({ Authorization: 'Bearer sk-test-key' })
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

  it('语言走 language 请求头，不进 multipart 字段', () => {
    // 原厂 OpenAPI 里 speech_to_text 的 language 是 header，form 里没有这一项。
    // 当成字段发过去对方不报错、只是不理——界面选了中文、实际按自动检测跑，
    // 这种「配了但没生效」不会有任何一句提示，只能靠这一条钉住
    const shape = shapeOf('minimax', { language: 'zh' })
    expect(shape.headers).toEqual({ Authorization: 'Bearer sk-test-key', language: 'zh' })
    expect(shape.fields).not.toHaveProperty('language')
  })

  it('语言留空时头部也不发这一项', () => {
    // 空串发给对方等于替用户猜一份默认行为，两家各自怎么处理并不一样
    expect(shapeOf('minimax', { language: '' }).headers).toEqual({ Authorization: 'Bearer sk-test-key' })
    expect(shapeOf('minimax', { language: '   ' }).headers).toEqual({ Authorization: 'Bearer sk-test-key' })
  })

  it('鉴权仍是 Bearer：它没有换成另一套头', () => {
    expect(shapeOf('minimax').headers['X-Api-Key']).toBeUndefined()
  })
})

describe('buildAsrRequest：两家共有的口径', () => {
  it('语言留空时两家都不发这一项', () => {
    // 把一个空 language 递过去，两家的默认行为并不一样，等于替用户猜一份。
    // 放的位置两家不同（字段／头部），所以两处都得钉住，不能只查一处
    for (const vendor of ['openai', 'minimax']) {
      expect(shapeOf(vendor, { language: '' }).fields).not.toHaveProperty('language')
      expect(shapeOf(vendor, { language: '' }).headers).not.toHaveProperty('language')
    }
  })

  it('没填厂商的老方案发出来的形状与 openai 完全一致', () => {
    // 「加这一项不改变任何已有配置的行为」这句承诺的可执行版本
    expect(shapeOf(undefined)).toEqual(shapeOf('openai'))
    expect(shapeOf('dashscope')).toEqual(shapeOf('openai'))
  })

  it('两家都用用户填的那把 Key，头的名字也相同', () => {
    for (const vendor of ['openai', 'minimax']) {
      const headers = shapeOf(vendor).headers
      expect(headers.Authorization).toBe('Bearer sk-test-key')
      // 换厂商时不该出现「两套都带」：那等于把凭据发给了不该收它的网关
      expect(headers['X-Api-Key']).toBeUndefined()
    }
  })

  it('地址原样拼上去：尾部斜杠的收口不归这一层', () => {
    // 两个调用点传进来的都是 normalizeApiBase 之后的值，所以这里不该再修一遍——
    // 修了就会出现「适配层容错、真链路照样炸」的分歧；这一条只用来钉住「这里不修」
    expect(shapeOf('minimax', { apiBase: 'https://a.example/v1/' }).url).toBe(
      'https://a.example/v1//v1/speech_to_text'
    )
  })

  it('界面上的名字都认得，两张表的键一致', () => {
    expect(ASR_VENDOR_NAMES.openai).toBe('OpenAI 兼容接口')
    expect(ASR_VENDOR_NAMES.minimax).toBe('MiniMax')
    // 漏配一家时默认模型那格会凭空读不到，而两边都是「读得到就跑」，只有这里能挡住
    expect(Object.keys(ASR_VENDOR_NAMES).sort()).toEqual(Object.keys(ASR_VENDOR_DEFAULT_MODEL).sort())
  })
})

describe('asrFileProblem：发出去之前先问这一家收不收', () => {
  // 按十进制 MB 取值：文档那句「50MB」没写进制，应用按小的那一头拦（见 VENDOR_FILE_LIMITS）
  const MB = 1000 * 1000

  it('MiniMax 超时长就拦，并且把这份到底是多长说出来', () => {
    // 500 秒是硬上限，而一段超过 8 分钟的媒体对这一行是常态：不拦的话整批跑完才撞到对方原话
    const problem = asrFileProblem('minimax', { bytes: 5 * MB, seconds: 501 }) as string
    expect(problem).toContain('只收 8 分钟以内')
    // 向上取整：8 分 21 秒念成 9 分钟。四舍五入会得到「只收 8 分钟，这一份是 8 分钟」，
    // 那句读起来像被误拦，而它真的超了
    expect(problem).toContain('这一份是 9 分钟')
    expect(asrFileProblem('minimax', { bytes: 5 * MB, seconds: 500 })).toBeNull()
  })

  it('MiniMax 超体积也拦，这一条比时长先判', () => {
    // 数字出自 formatBytes 那一把尺（#282），这里不另算一份
    const problem = asrFileProblem('minimax', { bytes: 51 * MB, seconds: 10 })
    expect(problem).toContain('50.0MB')
    expect(problem).toContain('51.0MB')
    expect(asrFileProblem('minimax', { bytes: 50 * MB, seconds: 10 })).toBeNull()
  })

  it('时长探不到时只按体积判，不拿猜出来的秒数拦人', () => {
    // ffprobe 挂了不等于这份音频有问题；把它当「没这条信息」，本来能成的转写不该被拦下来
    expect(asrFileProblem('minimax', { bytes: 5 * MB })).toBeNull()
    expect(asrFileProblem('minimax', { bytes: 5 * MB, seconds: undefined })).toBeNull()
  })

  it('OpenAI 兼容档不拦：各家网关放多少并不一样', () => {
    // 本机起的和内网的兼容网关常常不收这两条上限，替它们拦人会把能用的人挡在门外
    for (const vendor of ['openai', undefined, 'dashscope']) {
      expect(asrFileProblem(vendor, { bytes: 500 * MB, seconds: 999999 })).toBeNull()
    }
  })
})

describe('readAsrResponse：读回来那一段', () => {
  // 这一层不看厂商：两家在架的接口回的都是同一套 verbose_json（segments + start/end 秒），
  // 所以没有「按厂商分支读」这件事——真长出第二套形状时该在这里加，而不是在调用方各自解一遍
  it('start／end 本来就是秒，直接搬', async () => {
    const read = await readAsrResponse(
      new Response(
        JSON.stringify({ text: '整篇', duration: 12.5, segments: [{ start: 0.4, end: 1.6, text: ' 有字 ' }] })
      )
    )
    expect(read.segments).toEqual([{ start: 0.4, end: 1.6, text: '有字', confidence: undefined }])
    expect(read.duration).toBe(12.5)
    expect(read.text).toBe('整篇')
    expect(read.hasSegments).toBe(true)
  })

  it('avg_logprob 换算成 0..1 的置信度', async () => {
    const read = await readAsrResponse(
      new Response(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'x', avg_logprob: -1 }] }))
    )
    expect(read.segments[0].confidence).toBeCloseTo(0.9)
  })

  it('没给 text 字段是 null，给空串是空串', async () => {
    // 自检那两处按这两件事分别说话：「这个地址不是转写接口」／「这段样本是静音」
    const missing = await readAsrResponse(new Response(JSON.stringify({ segments: [] })))
    expect(missing.text).toBeNull()
    expect(missing.hasSegments).toBe(true)
    const empty = await readAsrResponse(new Response(JSON.stringify({ text: '', segments: [] })))
    expect(empty.text).toBe('')
  })

  it('MiniMax 对没听出字的样本干脆不给 segments 这一项', async () => {
    // 数组空不空与字段在不在是两件事；读成「空数组」自检就没法区分「不支持分段」与「这段是静音」
    const read = await readAsrResponse(new Response(JSON.stringify({ text: '', duration: 1 })))
    expect(read.hasSegments).toBe(false)
    expect(read.segments).toEqual([])
  })

  it('响应体不是 JSON 时原样抛出，由调用方说那一句', async () => {
    // 这一层不吞错也不改写：自检里「200 但返回的不是 JSON」那一条靠的就是这里漏出来
    await expect(readAsrResponse(new Response('<html>gate</html>'))).rejects.toBeInstanceOf(SyntaxError)
  })
})
