/**
 * 设置侧归一化函数的单测。
 * 这几个函数都是「配置值进入下一步之前必须过的一道收口」，而且它们的落点不是同一个：
 * 档位名会被拼成 HuggingFace repo 名、引擎 id 会被拼成模型目录名。测它们不是在测格式好看，
 * 是在测「用户手改过的 settings.json 或旧版本残留值，不会把下载目标带偏」。
 * `normalizeApiBase` 还多担一件事：接口地址那格粘的常常是服务商文档里那条**完整端点**，
 * 认不下这个尾巴就是 1.1.1 那句「填了就能连上」的兑现失败（MiniMax 404 的根因，#327）。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeApiBase,
  normalizeLocalModel,
  normalizeLocalVoice,
  normalizeTtsEngine,
} from '../electron/main/services/settingsService'
import { buildAsrRequest } from '../electron/main/services/asr/asrVendor'
import { buildIflytekResult, buildIflytekUpload } from '../electron/main/services/asr/iflytekAsr'
import { buildSpeechRequest, buildVoiceListRequest } from '../electron/main/services/ttsVendor'
import {
  DEFAULT_LOCAL_TTS_ENGINE,
  LOCAL_TTS_ENGINES,
  normalizeLocalTtsEngine,
} from '../electron/main/services/localTtsEngine'

describe('normalizeApiBase', () => {
  it('容忍各家文档里的 /v1 后缀与末尾斜杠', () => {
    expect(normalizeApiBase('https://api.openai.com/v1')).toBe('https://api.openai.com')
    expect(normalizeApiBase('https://api.openai.com/v1/')).toBe('https://api.openai.com')
    expect(normalizeApiBase('  https://gateway.example.com/v1  ')).toBe('https://gateway.example.com')
  })

  it('只剥一层 /v1：路径里真叫 v1 的自有网关不该被剥成半个地址', () => {
    expect(normalizeApiBase('https://example.com/v1/v1')).toBe('https://example.com/v1')
    expect(normalizeApiBase('https://example.com/api/v1/proxy')).toBe('https://example.com/api/v1/proxy')
  })

  it('空值进去是空串，不是 undefined——调用方靠「空＝没填」判断', () => {
    expect(normalizeApiBase('')).toBe('')
    expect(normalizeApiBase('   ')).toBe('')
  })

  it('不动没有斜杠后缀的正常地址', () => {
    expect(normalizeApiBase('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
  })

  it('认下「照着对方文档粘进来的整条端点」', () => {
    // 用户在接口地址那格粘的是服务商文档里那条完整 URL，而应用自己还要再接一次路径。
    // 不认这条尾巴，MiniMax 就得到 `.../v1/speech_to_text/v1/speech_to_text`，症状是一句 404，
    // 而他填的明明是对方的原话——这一条就是 1.1.1 那句「输入框里填了就能连上」的直接兑现
    expect(normalizeApiBase('https://api.minimax.cn/v1/speech_to_text')).toBe('https://api.minimax.cn')
    expect(normalizeApiBase('https://api.minimax.cn/v1/t2a_v2')).toBe('https://api.minimax.cn')
    expect(normalizeApiBase('https://api.openai.com/v1/audio/transcriptions')).toBe('https://api.openai.com')
    expect(normalizeApiBase('https://api.openai.com/v1/audio/speech')).toBe('https://api.openai.com')
    expect(normalizeApiBase('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')).toBe(
      'https://dashscope.aliyuncs.com'
    )
  })

  it('粘错的尾巴认得大小写，也不误伤路径里带这些词的自有网关', () => {
    expect(normalizeApiBase('https://api.minimax.cn/V1/Speech_To_Text')).toBe('https://api.minimax.cn')
    expect(normalizeApiBase('https://gw.example.com/v1/speech_to_text/v1/speech_to_text')).toBe(
      'https://gw.example.com/v1/speech_to_text'
    )
    // 只剥一层：真把端点放在某个更长路径底下的自建网关，剥完还得是个能用的地址
    expect(normalizeApiBase('https://gw.example.com/proxy/v1/chat/completions')).toBe('https://gw.example.com/proxy')
  })

  it('对账：三条拼请求的链路，把用户粘的完整端点喂回去还能拼回同一条', () => {
    // 这张尾巴表是手抄的，抄漏一条不会编译报错，只会在用户那格变成 404。
    // 所以这里不比对表内容，比对的是**真拼出来的那条 URL**：把适配层产出的完整端点当成
    // 用户粘贴的输入走一遍归一化，再拼一次必须回到同一条地址——加了新端点却忘了登记时，
    // 这一步必然拼出双重路径
    const apiBase = 'https://gateway.example.com'

    for (const vendor of ['openai', 'minimax'] as const) {
      const input = {
        apiBase,
        apiKey: 'k',
        model: 'm',
        language: '',
      }
      const pasted = buildAsrRequest(vendor, input).url
      expect(normalizeApiBase(pasted)).not.toBe(pasted)
      expect(buildAsrRequest(vendor, { ...input, apiBase: normalizeApiBase(pasted) }).url).toBe(pasted)
    }

    for (const vendor of ['openai', 'minimax', 'dashscope', 'volc'] as const) {
      const pasted = buildSpeechRequest(vendor, {
        apiBase,
        apiKey: 'k',
        model: 'm',
        text: 't',
        voice: '',
        speed: 1,
        resourceId: '',
      }).url
      expect(normalizeApiBase(pasted)).not.toBe(pasted)
      expect(
        buildSpeechRequest(vendor, {
          apiBase: normalizeApiBase(pasted),
          apiKey: 'k',
          model: 'm',
          text: 't',
          voice: '',
          speed: 1,
          resourceId: '',
        }).url
      ).toBe(pasted)
    }

    // 配音页取音色候选那条（#340）：也是真发出去的一趟，用户照 MiniMax 文档粘
    // `https://api.minimax.cn/v1/get_voice` 时必须同样认下
    const voiceListPasted = buildVoiceListRequest('minimax', { apiBase, apiKey: 'k' }).url
    expect(voiceListPasted).toBe(`${apiBase}/v1/get_voice`)
    expect(normalizeApiBase(voiceListPasted)).toBe(apiBase)
    expect(
      buildVoiceListRequest('minimax', { apiBase: normalizeApiBase(voiceListPasted), apiKey: 'k' }).url
    ).toBe(voiceListPasted)

    // 讯飞那两趟的路径不在适配层的固定形状里（每趟现算签名），但尾巴表照样要认下它们：
    // 用户照文档粘的正是 `.../v2/upload` 与 `.../v2/getResult` 这两条。
    // 查询串不参与归一化，所以比的是路径那一段
    const iflytekCredentials = { appId: 'a', apiKey: 'k', apiSecret: 's' }
    const iflytekUpload = (base: string) =>
      buildIflytekUpload({
        apiBase: base,
        credentials: iflytekCredentials,
        fileName: 'f.wav',
        fileSize: 1,
        signatureRandom: 'r',
        dateTime: '2026-11-07T01:02:03+0800',
      }).url.split('?')[0]
    const iflytekResult = (base: string) =>
      buildIflytekResult({
        apiBase: base,
        credentials: iflytekCredentials,
        orderId: 'o',
        signatureRandom: 'r',
        dateTime: '2026-11-07T01:02:03+0800',
      }).url.split('?')[0]

    for (const build of [iflytekUpload, iflytekResult]) {
      const pasted = build(apiBase)
      const rooted = normalizeApiBase(pasted)
      expect(rooted).toBe(apiBase)
      expect(build(rooted)).toBe(pasted)
    }

    // 校对这一腿没有适配层，路径就写死在 openaiCompatible 与连接自检里；这里钉住表抄对了
    expect(normalizeApiBase(`${apiBase}/v1/chat/completions`)).toBe(apiBase)
  })
})

describe('normalizeLocalModel', () => {
  it('白名单内的档位原样通过', () => {
    expect(normalizeLocalModel('base')).toBe('base')
    expect(normalizeLocalModel('small')).toBe('small')
  })

  it('白名单外一律落回 base：这个值会被拼成 HF repo 名，不能放野值过去', () => {
    expect(normalizeLocalModel('large-v3')).toBe('base')
    expect(normalizeLocalModel('BASE')).toBe('base')
    expect(normalizeLocalModel('')).toBe('base')
    expect(normalizeLocalModel(undefined)).toBe('base')
    expect(normalizeLocalModel(null)).toBe('base')
    expect(normalizeLocalModel(2)).toBe('base')
  })
})

describe('normalizeTtsEngine', () => {
  it('只有 local 是本地档，其余（含旧配置没这个键）都落回云端', () => {
    expect(normalizeTtsEngine('local')).toBe('local')
    expect(normalizeTtsEngine('cloud')).toBe('cloud')
    expect(normalizeTtsEngine('')).toBe('cloud')
    expect(normalizeTtsEngine(undefined)).toBe('cloud')
    expect(normalizeTtsEngine('LOCAL')).toBe('cloud')
  })
})

describe('normalizeLocalVoice', () => {
  it('空值落回推荐音色 0', () => {
    expect(normalizeLocalVoice('')).toBe('0')
    expect(normalizeLocalVoice('   ')).toBe('0')
  })

  it('已经是编号字符串就原样', () => {
    expect(normalizeLocalVoice('40')).toBe('40')
    expect(normalizeLocalVoice(' 7 ')).toBe('7')
  })

  it('云端残留的音色名不许被悄悄换成 0——得让下游报错，用户才知道自己那一下没生效', () => {
    expect(normalizeLocalVoice('alloy')).toBe('alloy')
  })
})

describe('normalizeLocalTtsEngine', () => {
  it('白名单内原样，白名单外落回中文默认档', () => {
    for (const id of LOCAL_TTS_ENGINES) {
      expect(normalizeLocalTtsEngine(id)).toBe(id)
    }
    expect(normalizeLocalTtsEngine('')).toBe(DEFAULT_LOCAL_TTS_ENGINE)
    expect(normalizeLocalTtsEngine(undefined)).toBe(DEFAULT_LOCAL_TTS_ENGINE)
    expect(normalizeLocalTtsEngine('../../etc/passwd')).toBe(DEFAULT_LOCAL_TTS_ENGINE)
  })
})
