/**
 * 校对／配音这两档的开工前置校验（src/utils/readiness.ts 的 checkCorrectionReady / checkVoiceReady）。
 *
 * 第⑧步把三档的设置界面换成同一套「列表 + 弹窗」之后，这两句拦人的话也跟着换了口径：
 * 面板上不再有凭据输入框，右下角那颗「保存设置」一个字都写不到凭据上。所以这里钉的是
 * 「出路只能指到弹窗」——说错一颗按钮，用户就会在面板上找一个已经不存在的输入框，
 * 或者在弹窗里存完又去点外面那颗、等一个永远不出现的「已保存」。
 *
 * 判据和转写那一档共用一个函数（`noCurrentProfileMessage`），三种结局不能互换：
 * ① 一条方案都没建过 → 去点「新建API接入」；
 * ② 建了几套但没选定哪套 → 进那一行的「编辑」勾上「当前使用」，并把条数说出口；
 * ③ 列表没读回来 → 不编原因，落回那句本来就说得出结果的话。
 * 另钉两条这一档特有的：配音的 Key 可以沿用校对那把（两把都没有才算缺），
 * 以及「配音引擎＝本地」时整段方案判据都不该出现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkCorrectionReady, checkVoiceReady } from '../src/utils/readiness'

const api = {
  getSettings: vi.fn(),
  listProfiles: vi.fn(),
  getLocalVoiceStatus: vi.fn(),
}

/** `settings:listProfiles` 的脱敏视图：只把被测那一档填满，另外两档留空不影响判据。
 *  tts 那一行从 v3 起只有地址与模型两格（音色不在方案里），别再往 values 里塞 ttsVoice */
function profilesView(cap: 'ai' | 'tts', ids: string[], defaultId: string) {
  const rows = ids.map((id) => ({
    id,
    name: id,
    values:
      cap === 'ai'
        ? { aiProvider: 'openai', aiApiBase: 'https://gw.example.com', aiModel: 'gpt-4o-mini' }
        : { ttsApiBase: 'https://gw.example.com', ttsModel: 'tts-1' },
    keyStatus: 'encrypted' as const,
  }))
  return {
    profiles: { asr: [], ai: cap === 'ai' ? rows : [], tts: cap === 'tts' ? rows : [] },
    defaultProfileId: { asr: '', ai: cap === 'ai' ? defaultId : '', tts: cap === 'tts' ? defaultId : '' },
    maxProfiles: 3,
    storageProblem: null,
  }
}

/** 校对：一把已保存的 Key 都没有（第⑧步之后这也是「这一档没有当前使用的方案」的一种表现） */
function noAiKey(over: Record<string, unknown> = {}) {
  return { aiKeyStatus: 'none', ...over }
}

/** 配音走云端、两把 Key 都指望不上 */
function noVoiceKey(over: Record<string, unknown> = {}) {
  return { ttsEngine: 'cloud', ttsKeyStatus: 'none', aiKeyStatus: 'none', ...over }
}

beforeEach(() => {
  api.getSettings.mockReset()
  api.listProfiles.mockReset()
  api.getLocalVoiceStatus.mockReset()
  vi.stubGlobal('window', { electronAPI: api })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkCorrectionReady 的云端方案分支', () => {
  it('一条校对方案都没建过：出路是「新建API接入」，落点是弹窗那颗保存', async () => {
    api.getSettings.mockResolvedValue(noAiKey())
    api.listProfiles.mockResolvedValue(profilesView('ai', [], ''))

    const blocked = await checkCorrectionReady()

    expect(blocked?.settingsTab).toBe('ai')
    expect(blocked?.message).toContain('一条AI 校对方案都还没有')
    expect(blocked?.message).toContain('在「校对配置」里点「新建API接入」')
    expect(blocked?.message).toContain('在弹窗里把服务商、接口地址、API Key 和模型填好')
    expect(blocked?.message).toContain('点弹窗底部的「保存」')
    expect(blocked?.message).not.toContain('保存设置')
    // 这一档没有第二个模式可退，出路只有本地校对那条不依赖 Key 的路
    expect(blocked?.message).toContain('本地校对')
  })

  it('建了两套但没选定哪套：说清条数，并把动作停在「勾上当前使用」', async () => {
    api.getSettings.mockResolvedValue(noAiKey())
    api.listProfiles.mockResolvedValue(profilesView('ai', ['a', 'b'], ''))

    const blocked = await checkCorrectionReady()

    expect(blocked?.message).toContain('那 2 套方案里现在没有「当前使用」的那一套')
    expect(blocked?.message).toContain('点要用的那一行的「编辑」')
    expect(blocked?.message).toContain('在弹窗里勾上「当前使用」再点「保存」')
    expect(blocked?.message).not.toContain('都还没有')
  })

  it('列表没读回来时不编原因：只说缺 Key，并把补法指到那一行的弹窗', async () => {
    api.getSettings.mockResolvedValue(noAiKey())
    api.listProfiles.mockResolvedValue(null)

    const blocked = await checkCorrectionReady()

    expect(blocked?.message).toContain('AI 校对需要先配置 API Key')
    expect(blocked?.message).toContain('点那一行的「编辑」，在弹窗里填一把 Key 并点「保存」')
    expect(blocked?.message).not.toMatch(/都还没有|没有「当前使用」/)
  })

  it('已保存的 Key 解不开时排在方案判据之前，那一次读列表根本不该发生', async () => {
    api.getSettings.mockResolvedValue(noAiKey({ aiKeyStatus: 'unreadable' }))

    const blocked = await checkCorrectionReady()

    expect(blocked?.message).toContain('这台机器读不出已保存的 API Key')
    expect(api.listProfiles).not.toHaveBeenCalled()
  })

  it('有 Key 就放行：方案指针不参与这一问，别把能干活的人拦在门外', async () => {
    api.getSettings.mockResolvedValue(noAiKey({ aiKeyStatus: 'encrypted' }))

    expect(await checkCorrectionReady()).toBeNull()
    expect(api.listProfiles).not.toHaveBeenCalled()
  })
})

describe('checkVoiceReady 的云端方案分支', () => {
  it('一条配音方案都没建过：说的是「云端配音」这一档，出路给两条', async () => {
    api.getSettings.mockResolvedValue(noVoiceKey())
    api.listProfiles.mockResolvedValue(profilesView('tts', [], ''))

    const blocked = await checkVoiceReady({ voice: 'alloy' })

    expect(blocked?.settingsTab).toBe('tts')
    expect(blocked?.message).toContain('一条云端配音方案都还没有')
    expect(blocked?.message).toContain('在「配音配置」里点「新建API接入」')
    // 本地档是这一档真有的第二条退路（配音引擎是个全局字段），说了得能兑现
    expect(blocked?.message).toContain('或把「配音引擎」换成「本地配音」')
    expect(blocked?.message).not.toContain('保存设置')
  })

  it('建了一套却没勾上「当前使用」：把条数和那一次勾选说出口', async () => {
    api.getSettings.mockResolvedValue(noVoiceKey())
    api.listProfiles.mockResolvedValue(profilesView('tts', ['a'], ''))

    const blocked = await checkVoiceReady({})

    expect(blocked?.message).toContain('那 1 套方案里现在没有「当前使用」的那一套')
    expect(blocked?.message).toContain('在弹窗里勾上「当前使用」再点「保存」')
  })

  it('校对那把能用时不因配音档拦人：回落口径与 getTTSConfig 一致', async () => {
    // 模型跟着「当前使用那一条」走，界面上不再有单次覆盖（1.1.0 起摘掉云端模型输入），
    // 所以这一条要给 settings 填上 ttsModel，否则先被「还缺配音模型」拦下、测不到 Key 回落
    api.getSettings.mockResolvedValue(noVoiceKey({ aiKeyStatus: 'encrypted', ttsModel: 'tts-1' }))

    expect(await checkVoiceReady({ voice: 'alloy' })).toBeNull()
    expect(api.listProfiles).not.toHaveBeenCalled()
  })

  it('有当前使用的方案但缺配音模型：补法指向弹窗，不再说「在配音配置里填好并保存」', async () => {
    // ttsModel 是「当前使用那一条」的读数（视图里的扁平名），空＝这一条没填过。
    // 音色留空不再拦人：有的服务商模型不收这一项，界面只提供选项，填错由接口回原话。
    api.getSettings.mockResolvedValue(noVoiceKey({ ttsKeyStatus: 'encrypted', ttsModel: '', ttsVoice: '' }))

    const blocked = await checkVoiceReady({})

    expect(blocked?.message).toContain('字幕配音还缺「配音模型」')
    expect(blocked?.message).toContain('点当前那一行的「编辑」，在弹窗里填模型 id 并点「保存」')
    expect(blocked?.message).not.toContain('保存设置')
  })

  it('音色空着不拦人：有的模型不收这一项，这一格只给选项、不做强校验', async () => {
    api.getSettings.mockResolvedValue(noVoiceKey({ ttsKeyStatus: 'encrypted', ttsModel: 'tts-1', ttsVoice: '' }))

    expect(await checkVoiceReady({ voice: '' })).toBeNull()
  })

  it('配音引擎切到本地时整段方案判据都不出现', async () => {
    api.getSettings.mockResolvedValue({
      ttsEngine: 'local',
      ttsLocalEngine: 'vits',
      ttsLocalVoice: '0',
      ttsKeyStatus: 'none',
      aiKeyStatus: 'none',
    })
    api.getLocalVoiceStatus.mockResolvedValue({
      engine: 'vits',
      requestedEngine: 'vits',
      binaryPresent: true,
      modelPresent: true,
      speakers: 2,
    })

    expect(await checkVoiceReady({})).toBeNull()
    expect(api.listProfiles).not.toHaveBeenCalled()
  })
})
