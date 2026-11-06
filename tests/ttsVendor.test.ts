/**
 * 云端配音厂商适配层的测试（1.1.1，#224）。
 *
 * 这一层是「同一份配置在真实配音里能用、在自检里也必须能用」的唯一保证，所以两边都测：
 * - 请求体：三家要的字段名和嵌套位置各不相同，改错一个键名不会有任何编译错误，
 *   只会在用户点「开始配音」之后换回一句对方网关的 400。这里把形状按文档钉住。
 * - 响应：MiniMax 的音频是十六进制、可能带着 HTTP 200 报错；百炼给的是一个要再取一次的地址。
 *   这两条都不是「裸字节流」，按 OpenAI 那一档的写法直接落盘就是一个装着 JSON 的 .mp3。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSpeechRequest,
  normalizeTtsVendor,
  readSpeechAudio,
  ttsVendorNeedsVoice,
  ttsVendorProbeVoice,
  TtsVendorError,
  type TtsSpeechInput,
  type TtsVendorRequest,
} from '../electron/main/services/ttsVendor'
// 渲染层那张厂商表（界面文案读它）：与上面这张对账，见下面那个 describe
import {
  ttsVendorNeedsVoice as uiNeedsVoice,
  ttsVendorProbeVoice as uiProbeVoice,
  ttsVoiceListUrl as uiVoiceListUrl,
} from '../src/utils/profileSpec'
import { ALLOWED_HOSTS } from '../electron/main/ipc/updateHandlers'

const input: TtsSpeechInput = {
  apiBase: 'https://gateway.example.com',
  apiKey: 'sk-test',
  model: 'the-model',
  voice: 'the-voice',
  speed: 1,
  text: '念这一句',
}

/** 请求体反解析：断言形状时比对整个对象，比一个个 `toBe` 更能看出多写了什么、少写了什么 */
function bodyOf(vendor: Parameters<typeof buildSpeechRequest>[0], over: Partial<TtsSpeechInput> = {}) {
  const request = buildSpeechRequest(vendor, { ...input, ...over })
  return { request, body: JSON.parse(request.body) as Record<string, unknown> }
}

/**
 * 响应那半边要的第二个参数：`readSpeechAudio` 现在得知道「刚发出去的是哪一条 URL」才能在报错里点名。
 * 用真请求构造而不是造一个假地址——地址怎么接的本身就是这一层要钉住的东西。
 */
function reqOf(vendor: Parameters<typeof buildSpeechRequest>[0]): TtsVendorRequest {
  return buildSpeechRequest(vendor, input)
}

function json(status: number, payload: unknown, contentType = 'application/json'): Response {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status,
    headers: { 'content-type': contentType },
  })
}

function audio(bytes: number): Response {
  return new Response(new Uint8Array(bytes).fill(7), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeTtsVendor', () => {
  it('三个认识的名字原样收下，大小写与首尾空白不影响', () => {
    expect(normalizeTtsVendor('openai')).toBe('openai')
    expect(normalizeTtsVendor(' MiniMax ')).toBe('minimax')
    expect(normalizeTtsVendor('DASHSCOPE')).toBe('dashscope')
  })

  it('空串、缺失、认不出的值一律落回 OpenAI 兼容：1.1.0 及更早建出来的方案磁盘上没有这一项', () => {
    // 42 不是假想：settings.json 是用户能手改的文件，这一格坏了也不能让配音整条链路抛错
    for (const raw of ['', '   ', undefined, null, 'volcengine', '讯飞', 42, {}, []]) {
      expect(normalizeTtsVendor(raw)).toBe('openai')
    }
  })

  it('只有 MiniMax 与百炼把音色列为必填', () => {
    expect(ttsVendorNeedsVoice('openai')).toBe(false)
    expect(ttsVendorNeedsVoice('minimax')).toBe(true)
    expect(ttsVendorNeedsVoice('dashscope')).toBe(true)
  })
})

describe('ttsVendorProbeVoice：「测试连接」在界面没带音色时补的那一个', () => {
  it('MiniMax 有实测过的值（speech-2.8-hd + 这一个音色真出过音频）', () => {
    expect(ttsVendorProbeVoice('minimax')).toBe('male-qn-qingse')
  })

  it('OpenAI 兼容本来就不收音色、百炼那份音色表我们只抄过灰字举例没发过真请求 → 都留空', () => {
    // 留空不是「忘了填」，是让 connectionTestService 走「这一页测不了这一家」那句真话；
    // 补一个没实测过的 id，症状是把「地址和 Key 通不通」这条诊断埋进一句 voice id not exist
    expect(ttsVendorProbeVoice('openai')).toBe('')
    expect(ttsVendorProbeVoice('dashscope')).toBe('')
  })

  it('对账：界面那张表（提示文案与灰字举例读它）和主进程这张表得说同一个值', () => {
    // 两处分开写的代价是「设置页写着自检会用 A 音色，实际发的是 B」——那颗按钮的结论没法解释
    for (const vendor of ['openai', 'minimax', 'dashscope'] as const) {
      expect(uiProbeVoice(vendor)).toBe(ttsVendorProbeVoice(vendor))
      expect(uiNeedsVoice(vendor)).toBe(ttsVendorNeedsVoice(vendor))
    }
  })
})

describe('buildSpeechRequest：三家的请求形状', () => {
  it('OpenAI 兼容：/v1/audio/speech，文本在 input，格式在 response_format', () => {
    const { request, body } = bodyOf('openai')
    expect(request.url).toBe('https://gateway.example.com/v1/audio/speech')
    expect(request.headers.Authorization).toBe('Bearer sk-test')
    expect(request.headers['Content-Type']).toBe('application/json')
    expect(body).toEqual({ model: 'the-model', input: '念这一句', response_format: 'mp3', voice: 'the-voice' })
  })

  it('MiniMax：/v1/t2a_v2，文本叫 text、倍速嵌在 voice_setting 里、非流式且要十六进制', () => {
    const { request, body } = bodyOf('minimax', { speed: 1.25 })
    expect(request.url).toBe('https://gateway.example.com/v1/t2a_v2')
    expect(body).toEqual({
      model: 'the-model',
      text: '念这一句',
      stream: false,
      output_format: 'hex',
      voice_setting: { voice_id: 'the-voice', speed: 1.25 },
    })
  })

  it('阿里云百炼：/api/v1/services/... 整段路径，格式与倍速都在 input 里，没有 parameters 这一层', () => {
    const { request, body } = bodyOf('dashscope', { speed: 0.75 })
    expect(request.url).toBe('https://gateway.example.com/api/v1/services/audio/tts/SpeechSynthesizer')
    // 按 DashScope SDK 的老形状把 format/rate 发进 parameters，对方不报错，只按默认值回一份 pcm；
    // 我们把它落成 .mp3，用户在播放器里只会看到「加载失败」
    expect(body).toEqual({
      model: 'the-model',
      input: { text: '念这一句', format: 'mp3', voice: 'the-voice', rate: 0.75 },
    })
    expect(body.parameters).toBeUndefined()
  })

  it('倍速是 1 时三家都不带这一项：兼容网关对未知字段的行为不一致', () => {
    expect(bodyOf('openai').body).not.toHaveProperty('speed')
    expect(bodyOf('minimax').body.voice_setting).not.toHaveProperty('speed')
    expect(bodyOf('dashscope').body.input).not.toHaveProperty('rate')
    // 0 是「没设过」而不是「静音播放」，与 speed=1 同一个处理
    expect(bodyOf('openai', { speed: 0 }).body).not.toHaveProperty('speed')
  })

  it('音色空着时不发空值，但这一项该由前置校验拦下（另两家必填）', () => {
    expect(bodyOf('openai', { voice: '' }).body).not.toHaveProperty('voice')
    expect(bodyOf('minimax', { voice: '' }).body.voice_setting).toEqual({})
    expect(bodyOf('dashscope', { voice: '' }).body.input).not.toHaveProperty('voice')
  })
})

describe('buildSpeechRequest：地址接路径', () => {
  it('百炼文档里的 Base URL 带 /api/v1，而归一化会把末尾那段剥掉——这里认这一次重复', () => {
    // 少了这条容忍，照对方文档原样粘贴的人得到的是 /api/api/v1/... 和一句 404
    const { request } = bodyOf('dashscope', { apiBase: 'https://dashscope.aliyuncs.com/api' })
    expect(request.url).toBe('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')
  })

  it('域名根正常接上，且只有正好以 /api 结尾时才折叠', () => {
    expect(bodyOf('openai', { apiBase: 'https://h.example.com' }).request.url).toBe(
      'https://h.example.com/v1/audio/speech'
    )
    // 网关自己就挂在 /api 这一层之下，OpenAI 的路径里没有 /api，不该被折叠
    expect(bodyOf('openai', { apiBase: 'https://h.example.com/api' }).request.url).toBe(
      'https://h.example.com/api/v1/audio/speech'
    )
    expect(bodyOf('minimax', { apiBase: 'https://h.example.com/apiv1' }).request.url).toBe(
      'https://h.example.com/apiv1/v1/t2a_v2'
    )
  })
})

describe('readSpeechAudio：OpenAI 兼容档', () => {
  it('裸字节流原样收下', async () => {
    const got = await readSpeechAudio('openai', reqOf('openai'), audio(16))
    expect(got.bytes).toHaveLength(16)
    expect(got.note).toBeUndefined()
  })

  it('200 但 body 是 JSON 的网关要拦，否则落盘一个装着错误正文的 .mp3', async () => {
    await expect(
      readSpeechAudio('openai', reqOf('openai'), json(200, { error: { message: 'nope' } }))
    ).rejects.toThrow(/没返回音频，返回的是 JSON/)
  })

  it('非 2xx：状态码、打出去的那条地址、401 的解释和对方原话都要在这一句里', async () => {
    const response = new Response('{"error":"bad key"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
    const message = await readSpeechAudio('openai', reqOf('openai'), response).catch(
      (e: unknown) => (e as Error).message
    )
    expect(message).toContain('配音接口返回 401（POST https://gateway.example.com/v1/audio/speech）')
    expect(message).toContain('OpenAI 兼容接口 的 Key 不对')
    expect(message).toContain('{"error":"bad key"}')
  })

  it('404 的解释按厂商分叉：OpenAI 是「这家没这个端点」，另两家是「地址层级的事」', async () => {
    const notFound = (vendor: 'openai' | 'minimax') =>
      readSpeechAudio(vendor, reqOf(vendor), new Response('', { status: 404 }))
    await expect(notFound('openai')).rejects.toThrow(/OpenAI 标准的音频接口/)
    await expect(notFound('minimax')).rejects.toThrow(/接口路径由应用接上/)
  })
})

describe('readSpeechAudio：MiniMax', () => {
  it('音频是十六进制字符串——按 base64 解会得到一坨长度对得上的垃圾', async () => {
    const got = await readSpeechAudio('minimax', reqOf('minimax'), json(200, { data: { audio: '49443300' } }))
    expect([...got.bytes]).toEqual([0x49, 0x44, 0x33, 0x00])
  })

  it('错误可以带着 HTTP 200 回来：不看 base_resp 就是把失败读成成功', async () => {
    await expect(
      readSpeechAudio(
        'minimax',
        reqOf('minimax'),
        json(200, { base_resp: { status_code: 1004, status_msg: 'invalid key' } })
      )
    ).rejects.toThrow(/MiniMax 回了错误码 1004：invalid key/)
  })

  it('base_resp 是 0 时不影响成功路径', async () => {
    const got = await readSpeechAudio(
      'minimax',
      reqOf('minimax'),
      json(200, { base_resp: { status_code: 0 }, data: { audio: 'ff' } })
    )
    expect(got.bytes.length).toBe(1)
  })

  it('回成功但音频为空、或者不是十六进制，都要单独说一句', async () => {
    await expect(
      readSpeechAudio('minimax', reqOf('minimax'), json(200, { data: { audio: '' } }))
    ).rejects.toThrow(/回了成功但音频是空的/)
    // Buffer.from(..., 'hex') 对非法字符是「遇到第一个非十六进制字符就停」，能解出零字节
    await expect(
      readSpeechAudio('minimax', reqOf('minimax'), json(200, { data: { audio: 'zz' } }))
    ).rejects.toThrow(/解不出一个字节/)
  })
})

describe('readSpeechAudio：阿里云百炼', () => {
  it('非流式回的是签名地址，要再发一次 GET 才拿到音频；计费字数翻成一句 note', async () => {
    const second = vi.fn(async () => audio(8))
    vi.stubGlobal('fetch', second)
    const got = await readSpeechAudio(
      'dashscope',
      reqOf('dashscope'),
      json(200, {
        output: { audio: { data: '', url: 'https://oss.example.com/a.mp3?sig=1' } },
        usage: { characters: 15 },
      })
    )
    expect(got.bytes).toHaveLength(8)
    expect(got.note).toBe('按 15 字计费')
    expect(second).toHaveBeenCalledWith('https://oss.example.com/a.mp3?sig=1', expect.anything())
  })

  it('第二次取音频要带上调用方的取消信号，否则「取消配音」在最后一跳上失效', async () => {
    const second = vi.fn(async () => audio(2))
    vi.stubGlobal('fetch', second)
    const controller = new AbortController()
    await readSpeechAudio(
      'dashscope',
      reqOf('dashscope'),
      json(200, { output: { audio: { url: 'https://oss.example.com/a.mp3' } } }),
      controller.signal
    )
    expect(second).toHaveBeenCalledWith('https://oss.example.com/a.mp3', { signal: controller.signal })
  })

  it('内联 data（base64）优先于地址，这种回法不用再发一次请求', async () => {
    const second = vi.fn(async () => audio(1))
    vi.stubGlobal('fetch', second)
    const got = await readSpeechAudio(
      'dashscope',
      reqOf('dashscope'),
      json(200, { output: { audio: { data: Buffer.from('abc').toString('base64'), url: 'https://x/y' } } })
    )
    expect(got.bytes.toString()).toBe('abc')
    expect(second).not.toHaveBeenCalled()
  })

  it('200 但既没地址也没内联数据：把 code/message 带出来，别只说「没给音频」', async () => {
    await expect(
      readSpeechAudio(
        'dashscope',
        reqOf('dashscope'),
        json(200, { code: 'Throttling', message: '额度不够', output: {} })
      )
    ).rejects.toThrow(/没给音频地址（Throttling）：额度不够/)
  })

  it('地址取回来不是 2xx，要说明那个地址只有 24 小时有效', async () => {
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 403 }))
    await expect(
      readSpeechAudio(
        'dashscope',
        reqOf('dashscope'),
        json(200, { output: { audio: { url: 'https://oss.example.com/a.mp3' } } })
      )
    ).rejects.toThrow(/取回来是 403（这个地址只在 24 小时内有效/)
  })

  it('取音频那一步被取消时按取消抛，不改写成「网关故障」', async () => {
    vi.stubGlobal('fetch', async () => {
      const err = new Error('This operation was aborted')
      err.name = 'AbortError'
      throw err
    })
    await expect(
      readSpeechAudio(
        'dashscope',
        reqOf('dashscope'),
        json(200, { output: { audio: { url: 'https://oss.example.com/a.mp3' } } })
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('readSpeechAudio：共同的坏情况', () => {
  it('一家 JSON 接口回了一份 HTML，说的是「地址填错了层级」而不是「没读出音频」', async () => {
    const response = new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
    await expect(readSpeechAudio('minimax', reqOf('minimax'), response)).rejects.toThrow(
      /回的不是 JSON.*502 Bad Gateway/
    )
  })

  it('报错点名最终打出去的那条地址：用户照文档填的原话就是念出来的那一条，不是应用接完路径之后的', async () => {
    // 这条尾巴我们还不认识（表里没登记、也接不上要接的那一条），按原话打；
    // 报错若不点名地址，用户看到的就只是「404」，无从判断是自己填深了还是应用接错了
    const typed = 'https://gw.example.com/v1/speech-synth'
    const message = await readSpeechAudio(
      'minimax',
      buildSpeechRequest('minimax', { ...input, apiBase: typed }),
      new Response('', { status: 404 })
    ).catch((e: unknown) => (e as Error).message)
    expect(message).toContain(`POST ${typed}）`)
  })

  it('适配层的失败一律带 TtsVendorError 类型：调用方靠它决定「原样贴给用户」还是「再包一层」', async () => {
    const err = await readSpeechAudio('openai', reqOf('openai'), new Response('', { status: 500 })).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(TtsVendorError)
  })

  it('错误正文压成一行并截断：网关的 HTML 报错页整段甩给用户毫无意义', async () => {
    const long = `<pre>${'x'.repeat(400)}</pre>`
    const err = await readSpeechAudio(
      'openai',
      reqOf('openai'),
      new Response(long, { status: 400, headers: { 'content-type': 'text/html' } })
    ).catch((e: unknown) => e)
    const message = (err as Error).message
    expect(message).not.toContain('\n')
    expect(message.length).toBeLessThan(300)
  })
})

describe('音色列表链接：界面挂出去的 URL 必须在主进程白名单里', () => {
  it('所有厂商的 voiceListUrl hostname 都出现在 ALLOWED_HOSTS 中（空串跳过）', () => {
    for (const vendor of ['openai', 'minimax', 'dashscope'] as const) {
      const url = uiVoiceListUrl(vendor)
      if (!url) continue
      const host = new URL(url).hostname
      expect(ALLOWED_HOSTS).toContain(host)
    }
  })
})
