/**
 * 「用户填的地址 → 这一次真的打出去的 URL」这一层的单测（1.1.1 #332）。
 *
 * 这一层只有一个决定：那一段路径接不接。接错了不会编译报错、也不会在我们这边报错——
 * 症状是服务商那侧的一句 404，而 404 里看不出应用做过什么。所以规则本身必须钉在这里，
 * 不能等用户去猜。这里比的是**这一层单独**的行为：归一化（`settingsNormalize.test.ts`）
 * 先跑，认尾巴；剩下的才轮到这里判段数。
 */
import { describe, expect, it } from 'vitest'
import { appendApiPath } from '../electron/main/services/apiPath'

const SPEECH = '/v1/audio/speech'
const MINIMAX_TTS = '/v1/t2a_v2'
const BAILIAN_TTS = '/api/v1/services/audio/tts/SpeechSynthesizer'

describe('appendApiPath：根地址一律接上路径', () => {
  it('纯域名、带端口、挂在路径前缀底下的自建网关，都按根处理', () => {
    expect(appendApiPath('https://api.openai.com', SPEECH)).toBe('https://api.openai.com/v1/audio/speech')
    expect(appendApiPath('http://127.0.0.1:11434', SPEECH)).toBe('http://127.0.0.1:11434/v1/audio/speech')
    // 反代挂在 /proxy 底下（归一化把尾上的 /v1 剥剩这一段），路径还得由应用接上
    expect(appendApiPath('https://gw.example.com/proxy', SPEECH)).toBe(
      'https://gw.example.com/proxy/v1/audio/speech'
    )
  })

  it('只剩一段时不算端点：我们自己每一条接的路径都在两段以上', () => {
    expect(appendApiPath('https://gw.example.com/api', SPEECH)).toBe('https://gw.example.com/api/v1/audio/speech')
    expect(appendApiPath('https://gw.example.com/apiv1', MINIMAX_TTS)).toBe('https://gw.example.com/apiv1/v1/t2a_v2')
    // 尾上的 /v1 是归一化那一步负责剥的，这一层只数段数：真链路传进来的永远是归一化之后的值
    expect(appendApiPath('https://gw.example.com/v1', SPEECH)).toBe('https://gw.example.com/v1/v1/audio/speech')
  })

  it('百炼文档里的 Base 带 /api/v1，归一化剥剩 /api——这一次重复要认，不能拼成 /api/api', () => {
    expect(appendApiPath('https://dashscope.aliyuncs.com/api', BAILIAN_TTS)).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    )
  })
})

describe('appendApiPath：已经指到端点那层的，照用户说的打', () => {
  it('两段以上、且第一层撞上要接的那一层，就不再重复接一层', () => {
    // 这一条正是「厂商改了路径而我们的规则还是老的」那个口子：用户粘的是对方文档的原话，
    // 应用再叠一层就得到一个他从来没写过的地址
    expect(appendApiPath('https://gw.example.com/v1/speech-synth', SPEECH)).toBe(
      'https://gw.example.com/v1/speech-synth'
    )
    expect(appendApiPath('https://api.minimax.cn/v1/t2a_v2', MINIMAX_TTS)).toBe('https://api.minimax.cn/v1/t2a_v2')
    expect(appendApiPath(`https://dashscope.aliyuncs.com${BAILIAN_TTS}`, BAILIAN_TTS)).toBe(
      `https://dashscope.aliyuncs.com${BAILIAN_TTS}`
    )
  })

  it('大小写不影响判定：真实文档里 `V1/Speech_To_Text` 这种写法就有', () => {
    expect(appendApiPath('https://api.minimax.cn/V1/T2A_V2', MINIMAX_TTS)).toBe('https://api.minimax.cn/V1/T2A_V2')
  })

  it('首段撞不上的多段路径照旧接：在 MiniMax 的地址上粘了百炼的端点，按原话打必然不通', () => {
    // 这一类是尾巴表（APPENDED_ENDPOINT_PATHS）的活：归一化先把它洗回根，走不到这里。
    // 这里留着这条断言是为了记下分工——段数判据不负责救串档
    expect(appendApiPath('https://api.minimax.cn/api/v1/services/audio/tts/SpeechSynthesizer', MINIMAX_TTS)).toBe(
      'https://api.minimax.cn/api/v1/services/audio/tts/SpeechSynthesizer/v1/t2a_v2'
    )
  })
})
