/**
 * 云端配音厂商适配层的测试（1.1.1，#224 → #342 加豆包）。
 *
 * 这一层是「同一份配置在真实配音里能用、在自检里也必须能用」的唯一保证，所以两边都测：
 * - 请求体：四家要的字段名和嵌套位置各不相同，改错一个键名不会有任何编译错误，
 *   只会在用户点「开始配音」之后换回一句对方网关的 400。这里把形状按文档钉住。
 * - 响应：MiniMax 的音频是十六进制、可能带着 HTTP 200 报错；百炼给的是一个要再取一次的地址；
 *   豆包发的是一行一帧的 NDJSON，音频在每帧的 base64 里，而结论可能写在任何一帧的 code 上。
 *   这三条都不是「裸字节流」，按 OpenAI 那一档的写法直接落盘就是一个装着 JSON 的 .mp3。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSpeechRequest,
  buildVoiceCloneRequest,
  buildVoiceCloneUploadRequest,
  buildVoiceListRequest,
  normalizeTtsVendor,
  readSpeechAudio,
  readVoiceCloneResult,
  readVoiceCloneUpload,
  readVoiceList,
  suggestCloneName,
  ttsVendorCloneSpec,
  ttsVendorClonesVoices,
  ttsVendorListsVoices,
  ttsVendorNeedsModel,
  ttsVendorNeedsVoice,
  ttsVendorProbeVoice,
  ttsVendorWantsResourceId,
  TTS_VENDOR_RESOURCE_ID,
  TtsVendorError,
  voiceCloneEndpoints,
  voiceCloneProblem,
  type TtsSpeechInput,
  type TtsVendorId,
  type TtsVendorRequest,
  type TtsVendorUploadRequest,
} from '../electron/main/services/ttsVendor'
// 渲染层那张厂商表（界面文案读它）：与上面这张对账，见下面那个 describe
import {
  ttsCloneSpec as uiCloneSpec,
  ttsVendorClonesVoices as uiClonesVoices,
  ttsVendorNeedsModel as uiNeedsModel,
  ttsVendorNeedsVoice as uiNeedsVoice,
  ttsVendorProbeVoice as uiProbeVoice,
  ttsVendorWantsResourceId as uiWantsResourceId,
  ttsVoiceListUrl as uiVoiceListUrl,
} from '../src/utils/profileSpec'
import { ALLOWED_HOSTS } from '../electron/main/ipc/updateHandlers'

const input: TtsSpeechInput = {
  apiBase: 'https://gateway.example.com',
  apiKey: 'sk-test',
  model: 'the-model',
  voice: 'the-voice',
  resourceId: '',
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
  it('四个认识的名字原样收下，大小写与首尾空白不影响', () => {
    expect(normalizeTtsVendor('openai')).toBe('openai')
    expect(normalizeTtsVendor(' MiniMax ')).toBe('minimax')
    expect(normalizeTtsVendor('DASHSCOPE')).toBe('dashscope')
    expect(normalizeTtsVendor('volc')).toBe('volc')
  })

  it('空串、缺失、认不出的值一律落回 OpenAI 兼容：1.1.0 及更早建出来的方案磁盘上没有这一项', () => {
    // 42 不是假想：settings.json 是用户能手改的文件，这一格坏了也不能让配音整条链路抛错
    // 'volcengine' 也在其中：豆包在界面上的 id 是 volc，而对方公司叫 Volcengine——
    // 用户手改时写出全名的概率不低，认成"不认识"落回默认档比猜一家网关安全
    for (const raw of ['', '   ', undefined, null, 'volcengine', '讯飞', 42, {}, []]) {
      expect(normalizeTtsVendor(raw)).toBe('openai')
    }
  })

  it('除 OpenAI 兼容以外三家都把音色列为必填', () => {
    expect(ttsVendorNeedsVoice('openai')).toBe(false)
    expect(ttsVendorNeedsVoice('minimax')).toBe(true)
    expect(ttsVendorNeedsVoice('dashscope')).toBe(true)
    expect(ttsVendorNeedsVoice('volc')).toBe(true)
  })

  it('模型必填性上豆包是例外：它的 req_params.model 只给复刻音色用，系统音色填了反被回 InvalidModel', () => {
    expect(ttsVendorNeedsModel('openai')).toBe(true)
    expect(ttsVendorNeedsModel('minimax')).toBe(true)
    expect(ttsVendorNeedsModel('dashscope')).toBe(true)
    expect(ttsVendorNeedsModel('volc')).toBe(false)
  })
})

describe('资源编号那一格画不画', () => {
  it('只有豆包收它（X-Api-Resource-Id），另三家是 null 而不是空串', () => {
    // null 与空串的差别是界面上的：null＝这一格不出现，空串＝出现但留空发这个值。
    // 写成空串就会在 OpenAI 那一档下面挂一格没人读的地方
    expect(TTS_VENDOR_RESOURCE_ID.openai).toBeNull()
    expect(TTS_VENDOR_RESOURCE_ID.minimax).toBeNull()
    expect(TTS_VENDOR_RESOURCE_ID.dashscope).toBeNull()
    expect(TTS_VENDOR_RESOURCE_ID.volc).toBe('seed-tts-2.0')
    expect(ttsVendorWantsResourceId('openai')).toBe(false)
    expect(ttsVendorWantsResourceId('volc')).toBe(true)
    // 1.1.0 及更早建出来的方案磁盘上没有厂商那一项，读出来是空串——那一格也不该出现
    expect(ttsVendorWantsResourceId(normalizeTtsVendor(''))).toBe(false)
  })

  it('对账：厂商表里出现的每一家，界面那张表也得认得', () => {
    // 少一家的症状是「弹窗里那一格不出现，但请求照发一个用户没填过的值」——比报错更难发现
    for (const vendor of Object.keys(TTS_VENDOR_RESOURCE_ID) as TtsVendorId[]) {
      expect(normalizeTtsVendor(vendor)).toBe(vendor)
      expect(uiWantsResourceId(vendor)).toBe(ttsVendorWantsResourceId(vendor))
    }
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

  it('豆包给的是官方 2.0 音色表的第一行：本机没 Key，这是「先照规范设计、之后有 Key 再验」的那一类', () => {
    // 和留空比，它的代价小得多：留空＝那颗按钮对这一家永远不可用；
    // 万一这个音色不在用户账号的权限里，对方回的仍是「音色与资源编号不匹配」——还是一句真诊断
    // 它必须和 seed-tts-2.0 那个资源编号成对（1.0 的音色配 2.0 的资源号就是那句 mismatched）
    expect(ttsVendorProbeVoice('volc')).toBe('zh_female_vv_uranus_bigtts')
    expect(TTS_VENDOR_RESOURCE_ID.volc).toBe('seed-tts-2.0')
  })

  it('对账：界面那张表（提示文案与灰字举例读它）和主进程这张表得说同一个值', () => {
    // 两处分开写的代价是「设置页写着自检会用 A 音色，实际发的是 B」——那颗按钮的结论没法解释
    for (const vendor of ['openai', 'minimax', 'dashscope', 'volc'] as const) {
      expect(uiProbeVoice(vendor)).toBe(ttsVendorProbeVoice(vendor))
      expect(uiNeedsVoice(vendor)).toBe(ttsVendorNeedsVoice(vendor))
      expect(uiNeedsModel(vendor)).toBe(ttsVendorNeedsModel(vendor))
    }
  })
})

describe('buildSpeechRequest：四家的请求形状', () => {
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

  it('倍速是 1 时四家都不带这一项：兼容网关对未知字段的行为不一致', () => {
    expect(bodyOf('openai').body).not.toHaveProperty('speed')
    expect(bodyOf('minimax').body.voice_setting).not.toHaveProperty('speed')
    expect(bodyOf('dashscope').body.input).not.toHaveProperty('rate')
    // 这一家的 audio_params 恒在（format/sample_rate 是它自己的默认值，写出来是为了让
    // 「落成 .mp3」这件事看得见），条件性的只有 speech_rate 这一项
    expect(bodyOf('volc').body.req_params).toMatchObject({
      audio_params: { format: 'mp3', sample_rate: 24000 },
    })
    expect(bodyOf('volc').body.req_params).not.toHaveProperty('audio_params.speech_rate')
    // 0 是「没设过」而不是「静音播放」，与 speed=1 同一个处理
    expect(bodyOf('openai', { speed: 0 }).body).not.toHaveProperty('speed')
  })

  it('音色空着时不发空值，但这一项该由前置校验拦下（另三家必填）', () => {
    expect(bodyOf('openai', { voice: '' }).body).not.toHaveProperty('voice')
    expect(bodyOf('minimax', { voice: '' }).body.voice_setting).toEqual({})
    expect(bodyOf('dashscope', { voice: '' }).body.input).not.toHaveProperty('voice')
    expect(bodyOf('volc', { voice: '' }).body.req_params).not.toHaveProperty('speaker')
  })

  it('豆包：鉴权换成 X-Api-Key，没有 Bearer，音频格式与采样率写在 audio_params 里', () => {
    const { request, body } = bodyOf('volc')
    expect(request.url).toBe('https://gateway.example.com/api/v3/tts/unidirectional')
    expect(request.headers['X-Api-Key']).toBe('sk-test')
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.headers['X-Api-Resource-Id']).toBe('seed-tts-2.0')
    // 原厂表格标「必选，推荐随机 UUID」，而它自己的 cURL 示例里没带这一条——照着协议补上
    expect(request.headers['X-Api-Request-Id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    // 配音这一腿没有分帧发送，X-Api-Sequence 是转写那一侧才有的东西
    expect(request.headers['X-Api-Sequence']).toBeUndefined()
    expect(body).toEqual({
      req_params: {
        text: '念这一句',
        speaker: 'the-voice',
        model: 'the-model',
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    })
    // 这一家的 model 挂在 req_params 里而不是顶层；顶层挂一个 model 是另外三家的写法
    expect(body.model).toBeUndefined()
  })

  it('豆包的倍速不是倍数而是一个百分比增量：界面选 1.5 倍发的是 50，不是 1.5', () => {
    // 原厂给的三个锚点是 0＝原速、100＝2 倍、-50＝0.5 倍。直接把倍数发过去是 1.5% 的提速，
    // 而用户听出来的差别只在「好像没变」，最难归因到这一格
    expect(bodyOf('volc', { speed: 1.5 }).body.req_params).toMatchObject({
      audio_params: { speech_rate: 50 },
    })
    expect(bodyOf('volc', { speed: 2 }).body.req_params).toMatchObject({
      audio_params: { speech_rate: 100 },
    })
    expect(bodyOf('volc', { speed: 0.5 }).body.req_params).toMatchObject({
      audio_params: { speech_rate: -50 },
    })
    // 1.1 这种非整换算成整数（10），对方收的是整数，小数会被截断成看不见的误差
    expect(bodyOf('volc', { speed: 1.1 }).body.req_params).toMatchObject({
      audio_params: { speech_rate: 10 },
    })
  })

  it('豆包：模型那格填了才带（复刻音色才需要），资源编号填了覆盖默认档', () => {
    expect(bodyOf('volc', { model: '' }).body.req_params).not.toHaveProperty('model')
    expect(bodyOf('volc', { model: '  ' }).body.req_params).not.toHaveProperty('model')
    expect(bodyOf('volc', { model: 'seed-tts-2.0-expressive' }).body.req_params).toMatchObject({
      model: 'seed-tts-2.0-expressive',
    })
    expect(buildSpeechRequest('volc', { ...input, resourceId: 'seed-icl-2.0' }).headers[
      'X-Api-Resource-Id'
    ]).toBe('seed-icl-2.0')
    expect(buildSpeechRequest('volc', { ...input, resourceId: '  seed-icl-2.0  ' }).headers[
      'X-Api-Resource-Id'
    ]).toBe('seed-icl-2.0')
  })

  it('不收资源编号那三家：那一格填了什么也不发（请求头里没有这一项）', () => {
    for (const vendor of ['openai', 'minimax', 'dashscope'] as const) {
      expect(
        buildSpeechRequest(vendor, { ...input, resourceId: 'seed-tts-2.0' }).headers[
          'X-Api-Resource-Id'
        ]
      ).toBeUndefined()
    }
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

  it('豆包：粘到 /api 那层折叠一次，粘整条端点则照原话打（不再接第二层）', () => {
    // 原厂文档给的是 wss/https 两条完整端点，粘贴过来的人多半连 /api/v3/tts/unidirectional 一起复制
    expect(bodyOf('volc', { apiBase: 'https://h.example.com/api' }).request.url).toBe(
      'https://h.example.com/api/v3/tts/unidirectional'
    )
    expect(
      bodyOf('volc', { apiBase: 'https://h.example.com/api/v3/tts/unidirectional' }).request.url
    ).toBe('https://h.example.com/api/v3/tts/unidirectional')
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

/**
 * 豆包的回包是一行一帧的 JSON（原厂自己的 Python 示例用 iter_lines 逐行 parse），
 * 所以这里造的是「多行文本」而不是一份 JSON——按整体 parse 会得到一句「回的不是 JSON」。
 */
function volcLines(frames: unknown[]): Response {
  return new Response(frames.map((frame) => JSON.stringify(frame)).join('\n'), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一帧音频：data 是 base64，结束帧的 code 是 20000000 */
function b64(bytes: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: 0, message: 'success', data: Buffer.alloc(bytes, 9).toString('base64'), ...extra }
}

const VOLC_END = { code: 20000000, message: 'SUCCESS', data: null }

describe('readSpeechAudio：豆包', () => {
  it('逐帧的 base64 拼成整段音频；按裸字节流落盘会得到一坨 NDJSON 文本', async () => {
    const got = await readSpeechAudio(
      'volc',
      reqOf('volc'),
      volcLines([b64(4), b64(6), VOLC_END])
    )
    expect([...got.bytes]).toEqual(new Array(10).fill(9))
  })

  it('计费字数从 usage.text_words 翻成一句 note（界面不显示，日志要）', async () => {
    const got = await readSpeechAudio(
      'volc',
      reqOf('volc'),
      volcLines([b64(3, { usage: { text_words: 12 } }), VOLC_END])
    )
    expect(got.note).toBe('回执 text_words=12')
  })

  it('看到结束帧就停：它后面的东西不再当音频读', async () => {
    const got = await readSpeechAudio(
      'volc',
      reqOf('volc'),
      volcLines([b64(2), VOLC_END, b64(100)])
    )
    expect(got.bytes).toHaveLength(2)
  })

  it('code 为 0 是「这一段音频」而不是「整体失败」——不能把非零一概当错误，也不能只看最后一帧', async () => {
    // 结束帧的 code 是 20000000，比 0 大得多；按「code != 0 就失败」写，每一段配音都会红
    await expect(readSpeechAudio('volc', reqOf('volc'), volcLines([b64(1), VOLC_END]))).resolves
      .toBeTruthy()
  })

  it('错误帧：45000001 要说清「配音模型那一格只对复刻音色有用」，光念对方原话用户不知道动哪一格', async () => {
    await expect(
      readSpeechAudio(
        'volc',
        reqOf('volc'),
        volcLines([{ code: 45000001, message: 'InvalidModel', data: null }])
      )
    ).rejects.toThrow(/错误码 45000001：InvalidModel[\s\S]*复刻音色/)
  })

  it('「音色与资源编号不匹配」那一条必须点名两格分别在哪：对方原话同时提到两样东西', async () => {
    // 界面上资源编号在设置弹窗、音色在配音页，不点出来人只会来回改这两格
    const message = await readSpeechAudio(
      'volc',
      reqOf('volc'),
      volcLines([
        {
          code: 45000003,
          message: 'resource ID is mismatched with speaker related resource',
          data: null,
        },
      ])
    ).catch((e: unknown) => (e as Error).message)
    expect(message).toContain('这一句说的是「这个资源编号下没有这个音色」')
    expect(message).toContain('seed-icl-2.0')
  })

  it('认不出的错误码把对方原话递出去，不替用户猜原因', async () => {
    await expect(
      readSpeechAudio('volc', reqOf('volc'), volcLines([{ code: 45999999, message: 'weird' }]))
    ).rejects.toThrow(/错误码 45999999：weird/)
  })

  it('全是结束帧而一个音频字节都没有：说的是「音色与资源编号」那条最可能的路，不是「没读到」', async () => {
    await expect(
      readSpeechAudio('volc', reqOf('volc'), volcLines([{ code: 0, data: '' }, VOLC_END]))
    ).rejects.toThrow(/回了成功但一个音频字节都没给/)
  })

  it('回包整体拆不出 JSON 时点名打了哪一条地址：这一家的正常回包是一行一帧，出现这句多半是地址指错了层', async () => {
    const response = new Response('<html>502</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
    await expect(readSpeechAudio('volc', reqOf('volc'), response)).rejects.toThrow(/拆不出 JSON/)
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
    for (const vendor of ['openai', 'minimax', 'dashscope', 'volc'] as const) {
      const url = uiVoiceListUrl(vendor)
      if (!url) continue
      const host = new URL(url).hostname
      expect(ALLOWED_HOSTS).toContain(host)
    }
  })
})

describe('音色候选名单（#340）：只有厂商自己给这条接口时才有', () => {
  /** 与 `reqOf` 同一口径：断言响应那一半时要拿「真发出去的那条 URL」，报错才点得准地址 */
  const listReq = (apiBase = 'https://api.minimax.cn') =>
    buildVoiceListRequest('minimax', { apiBase, apiKey: 'sk-test' })

  /**
   * 失败那几趟取错误对象。写成 `.catch((e) => e as Error)` 时 TS 会把成功类型并进联合
   * （`VendorVoice[] | Error`），后面每一句 `.message` 都报假错——这一层本来就要断言「必抛」。
   */
  const rejected = async (promise: Promise<unknown>): Promise<Error> => {
    try {
      await promise
    } catch (err) {
      return err as Error
    }
    throw new Error('这一趟本该失败，却正常返回了')
  }

  it('四家里只有 MiniMax 给「列音色」，另三家不是漏了而是刻意不接', () => {
    expect(ttsVendorListsVoices('minimax')).toBe(true)
    for (const vendor of ['openai', 'dashscope', 'volc'] as const) {
      expect(ttsVendorListsVoices(vendor)).toBe(false)
    }
  })

  it('没有这条接口的三家：拼请求就当场说清「只能手输」，不是回一个空表', () => {
    // 空表在界面上读起来是「这家一个音色都没有」——那是句谎，而且会让用户以为自己 Key 填错了
    for (const vendor of ['openai', 'dashscope', 'volc'] as const) {
      const build = () => buildVoiceListRequest(vendor, { apiBase: 'https://h.example.com', apiKey: 'k' })
      expect(build).toThrow(TtsVendorError)
      expect(build).toThrow(/没有「列出音色」这一条接口/)
    }
  })

  it('请求形状：一次问全（voice_type=all），认证与配音同一把 Bearer', () => {
    const request = listReq()
    expect(request.url).toBe('https://api.minimax.cn/v1/get_voice')
    expect(request.headers.Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(request.body)).toEqual({ voice_type: 'all' })
  })

  it('用户照文档粘完整端点也认：地址仍走 appendApiPath，不接第二层', () => {
    expect(listReq('https://api.minimax.cn/v1/get_voice').url).toBe(
      'https://api.minimax.cn/v1/get_voice'
    )
  })

  it('系统音色归 system，复刻与生成的都归 clone；没有 voice_id 的行丢掉', async () => {
    const voices = await readVoiceList(
      'minimax',
      listReq(),
      json(200, {
        system_voice: [
          { voice_id: 'male-qn-qingse', voice_name: '青涩青年' },
          { voice_name: '这一行没有 id' },
        ],
        voice_cloning: [{ voice_id: 'clone-1', voice_name: '我自己' }],
        voice_generation: [{ voice_id: 'gen-1' }],
        base_resp: { status_code: 0, status_msg: 'success' },
      })
    )
    expect(voices).toEqual([
      { id: 'male-qn-qingse', name: '青涩青年', source: 'system' },
      { id: 'clone-1', name: '我自己', source: 'clone' },
      // 对方没给名字就是空串，界面上那列说明会空着——编一个名字比空着更糟
      { id: 'gen-1', name: '', source: 'clone' },
    ])
  })

  it('一个音色都没有时回空表（这是真话，不是失败）', async () => {
    await expect(readVoiceList('minimax', listReq(), json(200, { base_resp: { status_code: 0 } }))).resolves.toEqual(
      []
    )
  })

  it('HTTP 200 但 base_resp 报了错：这是失败，不是「这家没音色」', async () => {
    // MiniMax 的老口径：业务错误照样 200 回来，只看状态码就是把 1008「余额不足」读成空名单
    const err = await rejected(
      readVoiceList(
        'minimax',
        listReq(),
        json(200, { system_voice: [], base_resp: { status_code: 1008, status_msg: 'insufficient balance' } })
      )
    )
    expect(err).toBeInstanceOf(TtsVendorError)
    expect(err.message).toContain('错误码 1008')
    expect(err.message).toContain('insufficient balance')
  })

  it('非 2xx：状态码与打出去的那条地址都在这一句里', async () => {
    const err = await rejected(
      readVoiceList(
        'minimax',
        listReq(),
        new Response('{"base_resp":{"status_msg":"invalid api key"}}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
    expect(err.message).toContain('HTTP 401')
    expect(err.message).toContain('POST https://api.minimax.cn/v1/get_voice')
    expect(err.message).toContain('invalid api key')
  })

  it('回了一份 HTML：说的是地址层级填错，而不是「没读出音色名单」这么一句干巴巴的话', async () => {
    const err = await rejected(
      readVoiceList(
        'minimax',
        listReq(),
        new Response('<html>404 Not Found</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      )
    )
    expect(err.message).toContain('回的不是 JSON')
    expect(err.message).toContain('没读出音色名单')
    expect(err.message).not.toContain('没读出音频')
  })
})

/**
 * 声音复刻（#330）。这一块的口径与前面几块不同：**MiniMax 那条 2026-11-07 用真 Key 在本机跑通过一次**
 * （上传换 file_id → 复刻 → 回执 id 填回「音色」那一格），百炼那条至今没有 Key，只有单测形状与
 * 本机照着文档回包的假厂商服务，所以这里钉的不是「实测行为」，
 * 而是「照原厂当前文档拼出来的形状」——形状写错一个键名不会有任何编译错误，
 * 只会在用户点下去之后换回一句对方网关的 400，而那句 400 看不出是哪一格错了。
 */
describe('声音复刻：哪家支持、按什么形状发', () => {
  const ALL: readonly TtsVendorId[] = ['openai', 'minimax', 'dashscope', 'volc']
  const rejected = async (promise: Promise<unknown>): Promise<Error> => {
    try {
      await promise
    } catch (err) {
      return err as Error
    }
    throw new Error('这一趟本该失败，却正常返回了')
  }
  const uploadReq = (apiBase = 'https://api.minimax.cn'): TtsVendorUploadRequest =>
    buildVoiceCloneUploadRequest('minimax', {
      apiBase,
      apiKey: 'sk-test',
      fileName: 'me.mp3',
      bytes: Buffer.from([1, 2, 3]),
    })
  const cloneReq = (vendor: TtsVendorId, apiBase = 'https://api.minimax.cn'): TtsVendorRequest =>
    vendor === 'minimax'
      ? buildVoiceCloneRequest(vendor, { apiBase, apiKey: 'sk-test', name: 'MiniMax001', model: '', fileId: '123' })
      : buildVoiceCloneRequest(vendor, {
          apiBase: 'https://dashscope.aliyuncs.com',
          apiKey: 'sk-test',
          name: 'myvoice',
          model: 'cosyvoice-v3-flash',
          fileName: 'me.wav',
          bytes: Buffer.from([9, 8, 7]),
        })

  it('四家里只有 MiniMax 与百炼支持：另两家不是漏了，是复刻本身要别的条件', () => {
    expect(ttsVendorClonesVoices('minimax')).toBe(true)
    expect(ttsVendorClonesVoices('dashscope')).toBe(true)
    for (const vendor of ['openai', 'volc'] as const) {
      expect(ttsVendorClonesVoices(vendor)).toBe(false)
      // 拿不到 spec 时说的必须是「这家不支持」，而不是回一份空规格让上层拼出一个假请求
      expect(() => ttsVendorCloneSpec(vendor)).toThrow(/不支持在应用里复刻音色/)
      expect(() => voiceCloneProblem(vendor, { name: 'x', fileName: 'a.mp3', bytes: 1 })).toThrow(
        /不支持在应用里复刻音色/
      )
    }
  })

  it('对账：界面那张复刻表（起名格与规则文案读它）和主进程这张得说同一件事', () => {
    for (const vendor of ALL) {
      expect(uiClonesVoices(vendor)).toBe(ttsVendorClonesVoices(vendor))
      const ui = uiCloneSpec(vendor)
      const spec = ttsVendorClonesVoices(vendor) ? ttsVendorCloneSpec(vendor) : null
      if (!spec) {
        expect(ui).toBeNull()
        continue
      }
      expect(ui).not.toBeNull()
      // 「两步还是一步」在界面上决定那颗按钮念什么，判据只能是「有没有上传这一步」
      expect(ui?.twoStep).toBe(!!spec.uploadPath)
      expect(ui?.nameLabel).toBe(spec.nameLabel)
      expect(ui?.nameRule).toBe(spec.nameRule)
      expect(ui?.audioRule).toBe(spec.audioRule)
      // 报错时念的那个上限数必须也出现在界面那句原厂规矩里，否则同一件事在两个地方各说一个数
      expect(spec.audioRule).toContain(spec.sizeLimit)
      // 灰字举例本身要能过这一家的名字规矩，否则界面上教的第一个值就是会被拦下的那个
      expect(voiceCloneProblem(vendor, { name: ui!.nameExample, fileName: `a.${spec.formats[0]}`, bytes: 10 })).toBeNull()
    }
  })

  it('本机预检只拦测得准的三样：名字形状、后缀、字节数（时长刻意不拦）', () => {
    const ok = { name: 'MiniMax001', fileName: 'me.mp3', bytes: 1024 }
    expect(voiceCloneProblem('minimax', ok)).toBeNull()
    expect(voiceCloneProblem('minimax', { ...ok, name: 'ab' })).toMatch(/不合这一家的规矩/)
    expect(voiceCloneProblem('minimax', { ...ok, name: '1abc' })).toMatch(/不合这一家的规矩/)
    expect(voiceCloneProblem('minimax', { ...ok, fileName: 'me.ogg' })).toMatch(/只收 mp3 \/ m4a \/ wav/)
    expect(voiceCloneProblem('minimax', { ...ok, fileName: '没有后缀' })).toMatch(/认不出后缀/)
    expect(voiceCloneProblem('minimax', { ...ok, bytes: 0 })).toMatch(/是空的/)
    // 量出来的那一半走全仓那把尺（SI，与访达同一个数），上限那一半念厂商文档的原话
    expect(voiceCloneProblem('minimax', { ...ok, bytes: 21 * 1024 * 1024 })).toMatch(
      /这段音频 22\.0MB，超过这一家复刻收的 20MB/
    )
    // 空名字这一条是主进程自己的兜底：界面上那一格正常是选完录音自动填好的，空着只可能是用户自己清掉的
    expect(voiceCloneProblem('minimax', { ...ok, name: '  ' })).toMatch(/先把「新音色 ID」那一格填上/)
  })

  it('选完录音自动填的那个建议名，两家都得当场过预检（#349：这一格不再要用户自己想名字）', () => {
    for (const vendor of ['minimax', 'dashscope'] as const) {
      const name = suggestCloneName(vendor)
      // 后缀取时间戳的 36 进制末 8 位：同一账号里重名会被对方直接拒，而 8 位刚好卡在百炼那 10 个字符的上限内
      expect(name).toMatch(/^[a-z0-9-]+$/)
      expect(name.length).toBeLessThanOrEqual(10 + 7)
      expect(voiceCloneProblem(vendor, { name, fileName: 'me.mp3', bytes: 1024 })).toBeNull()
    }
  })

  it('百炼那一格是前缀：只收字母数字、最长 10 个，7.5 MB 按原文件拦', () => {
    const ok = { name: 'myvoice', fileName: 'me.wav', bytes: 1024 }
    expect(voiceCloneProblem('dashscope', ok)).toBeNull()
    expect(voiceCloneProblem('dashscope', { ...ok, name: '我的音色' })).toMatch(/不合这一家的规矩/)
    expect(voiceCloneProblem('dashscope', { ...ok, name: 'prefixtoolong' })).toMatch(/不合这一家的规矩/)
    // 原厂那句「≤10 MB」说的是 Base64 编码之后，照它拦原文件就是放一批注定被拒的请求出去
    expect(voiceCloneProblem('dashscope', { ...ok, bytes: 8 * 1024 * 1024 })).toMatch(
      /这段音频 8\.4MB，超过这一家复刻收的 7\.5MB/
    )
  })

  it('上传那一步（只有 MiniMax 有）：purpose=voice_clone，头部刻意不给 Content-Type', () => {
    const request = uploadReq()
    expect(request.url).toBe('https://api.minimax.cn/v1/files/upload')
    expect(Object.keys(request.headers)).toEqual(['Authorization'])
    expect(request.headers.Authorization).toBe('Bearer sk-test')
    expect(request.form.get('purpose')).toBe('voice_clone')
    const file = request.form.get('file')
    expect(file).toBeInstanceOf(Blob)
    expect((file as File).name).toBe('me.mp3')
    // 百炼那一家没有上传这一步，真被调到就得当场说清，而不是拼一条不存在的路径
    expect(() =>
      buildVoiceCloneUploadRequest('dashscope', {
        apiBase: 'https://dashscope.aliyuncs.com',
        apiKey: 'k',
        fileName: 'a.wav',
        bytes: Buffer.from([1]),
      })
    ).toThrow(/不用先上传音频/)
  })

  it('MiniMax 复刻请求：file_id 是纯数字就按数字发，voice_id 用用户自己起的那个', () => {
    const request = cloneReq('minimax')
    expect(request.url).toBe('https://api.minimax.cn/v1/voice_clone')
    expect(request.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(request.body)).toEqual({ file_id: 123, voice_id: 'MiniMax001' })
    // 18 位那种真 id：过一遍 Number() 尾数就被 IEEE754 收掉（…890 变 …900），
    // 发出去是一个不存在的文件号，对方只会回「文件找不到」，所以数字串必须一字不差
    const big = buildVoiceCloneRequest('minimax', {
      apiBase: 'https://api.minimax.cn',
      apiKey: 'sk-test',
      name: 'MiniMax003',
      model: '',
      fileId: '202611071234567890',
    })
    expect(JSON.parse(big.body)).toEqual({ file_id: 202611071234567890, voice_id: 'MiniMax003' })
    expect(big.body).toContain('"file_id":202611071234567890')
    // 回执给的不是纯数字时原样发：转成 NaN 比发一个字符串更糟
    const other = buildVoiceCloneRequest('minimax', {
      apiBase: 'https://api.minimax.cn',
      apiKey: 'sk-test',
      name: ' MiniMax002 ',
      model: '',
      fileId: 'file-abc',
    })
    expect(JSON.parse(other.body)).toEqual({ file_id: 'file-abc', voice_id: 'MiniMax002' })
    expect(() =>
      buildVoiceCloneRequest('minimax', { apiBase: 'https://api.minimax.cn', apiKey: 'k', name: 'a', model: '' })
    ).toThrow(/要先上传音频换 file_id/)
  })

  it('百炼复刻请求：音频编成 Data URI，target_model 必须与之后合成用的是同一个', () => {
    const request = cloneReq('dashscope')
    expect(request.url).toBe('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization')
    const body = JSON.parse(request.body) as { model: string; input: Record<string, string> }
    expect(body.model).toBe('voice-enrollment')
    expect(body.input.action).toBe('create_voice')
    expect(body.input.target_model).toBe('cosyvoice-v3-flash')
    expect(body.input.prefix).toBe('myvoice')
    // mime 按后缀定：写错一个 mime 对方解不出音频，回的那句「参数错误」看不出问题在这一格
    expect(body.input.audio).toBe(`data:audio/wav;base64,${Buffer.from([9, 8, 7]).toString('base64')}`)
    expect(body.input.language_hints).toBeUndefined()

    expect(() =>
      buildVoiceCloneRequest('dashscope', {
        apiBase: 'https://dashscope.aliyuncs.com',
        apiKey: 'k',
        name: 'myvoice',
        model: '  ',
        fileName: 'a.wav',
        bytes: Buffer.from([1]),
      })
    ).toThrow(/模型那格是空的/)
    expect(() =>
      buildVoiceCloneRequest('dashscope', {
        apiBase: 'https://dashscope.aliyuncs.com',
        apiKey: 'k',
        name: 'myvoice',
        model: 'cosyvoice-v3-flash',
      })
    ).toThrow(/要把音频本身递过去/)
  })

  it('用户照文档粘完整端点也认：两条复刻路径都走 appendApiPath，不接第二层', () => {
    expect(uploadReq('https://api.minimax.cn/v1/files/upload').url).toBe(
      'https://api.minimax.cn/v1/files/upload'
    )
    expect(cloneReq('minimax', 'https://api.minimax.cn/v1/voice_clone').url).toBe(
      'https://api.minimax.cn/v1/voice_clone'
    )
  })

  it('界面那一行「这一趟打到」与真发出去的是同一份推导（#346）', () => {
    // 复刻走的从来不是配音那一条端点，所以这一行的全部价值在「与请求同源」上：
    // 渲染层再拼一遍就是第二个出处，症状正是界面念一句、请求打另一句（#327 那一类）
    expect(voiceCloneEndpoints('minimax', 'https://api.minimax.cn')).toEqual([uploadReq().url, cloneReq('minimax').url])
    // 顺序按发出去的先后：先上传换 file_id，再拿它复刻；百炼没有第二步
    expect(voiceCloneEndpoints('dashscope', 'https://dashscope.aliyuncs.com')).toEqual([cloneReq('dashscope').url])
    // 不支持的两家要说清「这家不支持」，而不是回一份空名单让界面摆一条空地址
    for (const vendor of ['openai', 'volc'] as const) {
      expect(() => voiceCloneEndpoints(vendor, 'https://api.openai.com')).toThrow(/不支持在应用里复刻音色/)
    }
  })

  it('那一格填什么就打什么：路径前缀底下的网关照样接两条，应用不替你改道（#346）', () => {
    // 挂在自己路径前缀底下的网关（归一化后不到两段）仍当它是根
    expect(voiceCloneEndpoints('minimax', 'https://gw.example.com/proxy')).toEqual([
      'https://gw.example.com/proxy/v1/files/upload',
      'https://gw.example.com/proxy/v1/voice_clone',
    ])
    // 只转发了配音那一条的中转网关，接上复刻路径就是一条不存在的路由。应用不改道、也不猜，
    // 把它原样摆出来——用户看得见真打的那一条，界面上那句「地址不对？改一个」才有落点
    expect(voiceCloneEndpoints('dashscope', 'https://gw.example.com/proxy')).toEqual([
      'https://gw.example.com/proxy/api/v1/services/audio/tts/customization',
    ])
  })

  it('读上传回执：file_id 是纯数字也按字符串回给上层（下一步会自己判要不要转数字）', async () => {
    await expect(
      readVoiceCloneUpload('minimax', uploadReq(), json(200, { file: { file_id: 123 }, base_resp: { status_code: 0 } }))
    ).resolves.toBe('123')
  })

  it('上传失败：HTTP 200 但 base_resp 报错，是失败不是「没给 file_id」', async () => {
    const err = await rejected(
      readVoiceCloneUpload(
        'minimax',
        uploadReq(),
        json(200, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } })
      )
    )
    expect(err).toBeInstanceOf(TtsVendorError)
    expect(err.message).toContain('上传复刻音频回了错误码 1008')
    expect(err.message).toContain('insufficient balance')
  })

  it('上传回了 401：状态码与打出去的那条地址都在这一句里', async () => {
    const err = await rejected(
      readVoiceCloneUpload(
        'minimax',
        uploadReq(),
        new Response('{"base_resp":{"status_msg":"invalid api key"}}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
    expect(err.message).toContain('HTTP 401')
    expect(err.message).toContain('POST https://api.minimax.cn/v1/files/upload')
    expect(err.message).toContain('invalid api key')
  })

  it('上传回了一份 HTML：说的是没读出回执，不是「没读出音频」', async () => {
    const err = await rejected(
      readVoiceCloneUpload(
        'minimax',
        uploadReq(),
        new Response('<html>404</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      )
    )
    expect(err.message).toContain('没读出上传回执')
    expect(err.message).not.toContain('没读出音频')
  })

  it('上传成功了却没给 file_id：下一步复刻拿不到这段音频，就地停下', async () => {
    const err = await rejected(
      readVoiceCloneUpload('minimax', uploadReq(), json(200, { file: {}, base_resp: { status_code: 0 } }))
    )
    expect(err.message).toContain('没给 file_id')
  })

  it('MiniMax 复刻成功：回执里不重复 voice_id，答案就是用户自己填的那一个', async () => {
    await expect(
      readVoiceCloneResult('minimax', cloneReq('minimax'), json(200, { base_resp: { status_code: 0 } }), 'MiniMax001')
    ).resolves.toBe('MiniMax001')
  })

  it('MiniMax 复刻回了错误码：对方原话在前，我们只补一句「多半是哪一格」', async () => {
    const err = await rejected(
      readVoiceCloneResult(
        'minimax',
        cloneReq('minimax'),
        json(200, { base_resp: { status_code: 1002, status_msg: 'voice_id already exists' } }),
        'MiniMax001'
      )
    )
    expect(err.message).toContain('voice_id already exists')
    expect(err.message).toContain('音色 id 与已有的重复')
  })

  it('百炼复刻成功：音色名是对方拼的，只能从回执里读', async () => {
    await expect(
      readVoiceCloneResult(
        'dashscope',
        cloneReq('dashscope'),
        json(200, { output: { voice_id: 'cosyvoice-v3-flash-myvoice-abc123' } }),
        'myvoice'
      )
    ).resolves.toBe('cosyvoice-v3-flash-myvoice-abc123')
  })

  it('百炼复刻回了 code：这是失败，不能把前缀当音色 id 交上去', async () => {
    const err = await rejected(
      readVoiceCloneResult('dashscope', cloneReq('dashscope'), json(200, { code: 'InvalidParameter', message: 'audio too short' }), 'myvoice')
    )
    expect(err.message).toContain('InvalidParameter')
    expect(err.message).toContain('audio too short')
  })

  it('百炼回了成功却没给 voice_id：读不到就等于没复刻成', async () => {
    const err = await rejected(
      readVoiceCloneResult('dashscope', cloneReq('dashscope'), json(200, { output: {} }), 'myvoice')
    )
    expect(err.message).toContain('别拿前缀当音色用')
  })

  it('复刻回了一份 HTML：说的是没读出回执', async () => {
    const err = await rejected(
      readVoiceCloneResult(
        'minimax',
        cloneReq('minimax'),
        new Response('<html>502</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        'MiniMax001'
      )
    )
    expect(err.message).toContain('没读出复刻回执')
    expect(err.message).not.toContain('没读出音频')
  })
})
