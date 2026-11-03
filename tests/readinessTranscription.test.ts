/**
 * 「云端优先 + 转写方案」这段开工前置校验（src/utils/readiness.ts 的 checkTranscriptionReady）。
 *
 * 为什么要单测它：这句提示只有用户点了「开始转写」才跑得到，而那条路的第一步是原生选文件对话框
 * （`dialog.showOpenDialog`，自动化点不动），所以真渲染只能验到设置页里那些提示，验不到这里。
 * 判据全收在这一个纯函数里——读 `settings:get` 的状态位 + `settings:listProfiles` 那份视图，
 * 给它一份假 electronAPI 就能把三种结局分开钉住。
 *
 * 钉的是「三件事不能互换」：
 * ① 一条方案都没建过 → 说「新建一套」；
 * ② 建了几套但没有「当前使用」那一条 → 说「勾上当前使用再保存」，并把条数说出口；
 * ③ 列表都没读回来 → 不编原因，落回那句已有的「API Base 或 Key 还没填」。
 * ②和③最容易写反：读不到证据时照样报「没选方案」，等于界面替用户编一个他没做过的操作。
 * 后三条钉的是这段判据只管云端——本地转写不读方案列表，删空方案不影响它。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNREADABLE_KEY_MESSAGE, checkTranscriptionReady } from '../src/utils/readiness'

const api = {
  getSettings: vi.fn(),
  listProfiles: vi.fn(),
  testConnection: vi.fn(),
}

/** `settings:listProfiles` 的脱敏视图，只填 transcribe 这一档用得上的两处 */
function profilesView(asrIds: string[], defaultId: string) {
  return {
    profiles: {
      asr: asrIds.map((id) => ({
        id,
        name: id,
        values: { asrApiBase: 'https://gw.example.com', asrModel: 'm', asrApiKey: '' },
        keyStatus: 'encrypted' as const,
      })),
      ai: [],
      tts: [],
    },
    defaultProfileId: { asr: defaultId, ai: '', tts: '' },
    maxProfiles: 3,
    storageProblem: null,
  }
}

/** 全局段按「云端优先」，凭据给一份已填好的形状，好让方案指针成为唯一的变量 */
function cloudSettings(over: Record<string, unknown> = {}) {
  return {
    asrProvider: 'cloud',
    asrKeyStatus: 'encrypted',
    asrApiBase: 'https://gw.example.com',
    ...over,
  }
}

beforeEach(() => {
  api.getSettings.mockReset()
  api.listProfiles.mockReset()
  api.testConnection.mockReset()
  // readiness 只认 window.electronAPI，非 Electron 环境直接放行；所以替身挂在这里而不是 mock 整个模块
  vi.stubGlobal('window', { electronAPI: api })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkTranscriptionReady 的云端方案分支', () => {
  it('一条方案都没建过：说「新建一套」，并把落点指到转写配置', async () => {
    api.getSettings.mockResolvedValue(cloudSettings())
    api.listProfiles.mockResolvedValue(profilesView([], ''))

    const blocked = await checkTranscriptionReady()

    expect(blocked?.settingsTab).toBe('asr')
    expect(blocked?.message).toContain('一条云端转写方案都还没有')
    expect(blocked?.message).toContain('新建一套')
    // 这句不许顺手把②那句带出来：用户没建过方案，谈不上「勾上当前使用」
    expect(blocked?.message).not.toContain('没有「当前使用」的那一套')
  })

  it('建了三套但没有「当前使用」那一条：改成「勾上当前使用」，并把条数说出口', async () => {
    api.getSettings.mockResolvedValue(cloudSettings())
    api.listProfiles.mockResolvedValue(profilesView(['a', 'b', 'c'], ''))

    const blocked = await checkTranscriptionReady()

    expect(blocked?.message).toContain('那 3 套方案里现在没有「当前使用」的那一套')
    expect(blocked?.message).toContain('勾上「当前使用」')
    expect(blocked?.message).not.toContain('一条云端转写方案都还没有')
  })

  it('列表没读回来时不编原因：落回那句「API Base 或 Key 还没填」', async () => {
    // 界面拿不到证据就说「你没选方案」，是把读盘失败说成用户漏做了一步
    api.getSettings.mockResolvedValue(cloudSettings({ asrKeyStatus: 'none', asrApiBase: '' }))
    api.listProfiles.mockResolvedValue(null)

    const blocked = await checkTranscriptionReady()

    expect(api.listProfiles).toHaveBeenCalledTimes(1)
    expect(blocked?.message).toContain('API Base 或 API Key 还没填')
    expect(blocked?.message).not.toMatch(/方案都还没有|没有「当前使用」/)
  })

  it('有「当前使用」那一条且凭据齐全：不拦下', async () => {
    api.getSettings.mockResolvedValue(cloudSettings())
    api.listProfiles.mockResolvedValue(profilesView(['a'], 'a'))

    expect(await checkTranscriptionReady()).toBeNull()
  })

  it('Key 解不开排在方案判据之前：哪怕方案是好的，也只说「读不出」', async () => {
    api.getSettings.mockResolvedValue(cloudSettings({ asrKeyStatus: 'unreadable' }))
    api.listProfiles.mockResolvedValue(profilesView(['a'], 'a'))

    const blocked = await checkTranscriptionReady()

    expect(blocked?.message).toBe(UNREADABLE_KEY_MESSAGE)
    // 这一条排在问方案之前，所以那一次读列表根本不该发生
    expect(api.listProfiles).not.toHaveBeenCalled()
  })

  it('本地转写不看方案列表：一条方案都没有也照样放行', async () => {
    // 转写模式与档位都是全局段，跟方案指针无关——这条钉的是「删空方案不影响本地转写」
    api.getSettings.mockResolvedValue({ asrProvider: 'local', asrKeyStatus: 'none', asrApiBase: '' })
    api.testConnection.mockResolvedValue({ level: 'ok', message: '本机引擎在线' })

    expect(await checkTranscriptionReady()).toBeNull()
    expect(api.listProfiles).not.toHaveBeenCalled()
    expect(api.testConnection).toHaveBeenCalledWith('asr', expect.objectContaining({ provider: 'local' }))
  })

  it('本地引擎不在线时照样拦下，并把引擎那句话原样送出', async () => {
    api.getSettings.mockResolvedValue({ asrProvider: 'local', asrKeyStatus: 'none', asrApiBase: '' })
    api.testConnection.mockResolvedValue({ level: 'fail', message: '本机引擎没起来' })

    const blocked = await checkTranscriptionReady()

    expect(blocked?.message).toBe('本机引擎没起来')
    expect(blocked?.settingsTab).toBe('asr')
  })
})
