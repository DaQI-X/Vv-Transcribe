/**
 * 设置侧归一化函数的单测。
 * 这几个函数都是「配置值进入下一步之前必须过的一道收口」，而且它们的落点不是同一个：
 * 档位名会被拼成 HuggingFace repo 名、引擎 id 会被拼成模型目录名。测它们不是在测格式好看，
 * 是在测「用户手改过的 settings.json 或旧版本残留值，不会把下载目标带偏」。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeApiBase,
  normalizeLocalModel,
  normalizeLocalVoice,
  normalizeTtsEngine,
} from '../electron/main/services/settingsService'
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
