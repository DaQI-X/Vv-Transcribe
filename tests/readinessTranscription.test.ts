/**
 * 「云端优先 + 转写方案」这段开工前置校验（src/utils/readiness.ts 的 checkTranscriptionReady）。
 *
 * 为什么要单测它：这句提示只有用户点了「开始转写」才跑得到，而那条路的第一步是原生选文件对话框
 * （`dialog.showOpenDialog`，自动化点不动），所以真渲染只能验到设置页里那些提示，验不到这里。
 * 判据全收在这一个纯函数里——读 `settings:get` 的状态位 + `settings:listProfiles` 那份视图，
 * 给它一份假 electronAPI 就能把三种结局分开钉住。
 *
 * 钉的是「三件事不能互换」：
 * ① 一条方案都没建过 → 说「点新建API接入，在弹窗里把那三格填好，点弹窗底部的保存」；
 * ② 建了几套但没有「当前使用」那一条 → 说「点那一行的编辑、在弹窗里勾上当前使用再点保存」，并把条数说出口；
 * ③ 列表都没读回来 → 不编原因，落回那句已有的「API Base 或 Key 还没填」。
 * ②和③最容易写反：读不到证据时照样报「没选方案」，等于界面替用户编一个他没做过的操作。
 * 三句都还要钉住「动作顺序和第⑥步的界面一致」：那三格从第⑥步起只活在小弹窗里，落盘的是弹窗
 * 自己那颗「保存」而不是右下角的「保存设置」——说错一颗，用户就会在面板上找一个不存在的输入框，
 * 或者填完弹窗又去点外面那颗、等一个永远不出现的「已保存」。
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
  it('一条方案都没建过：说「新建API接入」，并把落点指到转写配置', async () => {
    api.getSettings.mockResolvedValue(cloudSettings())
    api.listProfiles.mockResolvedValue(profilesView([], ''))

    const blocked = await checkTranscriptionReady()

    expect(blocked?.settingsTab).toBe('asr')
    expect(blocked?.message).toContain('一条云端转写方案都还没有')
    expect(blocked?.message).toContain('新建API接入')
    // 第⑥步起那三格只活在小弹窗里，所以出路必须先把「点新建API接入、在弹窗里填」说出口，
    // 而不是让用户去填一个他在面板上根本看不到的输入框
    expect(blocked?.message).toContain('在弹窗里把接口地址、API Key 和模型')
    // 零条方案时还不知道用户会选哪家，所以两种口径都得说到：讯飞那一档没有「模型」这一格，
    // 换成三样凭据。只说前一种，选了讯飞的人会去弹窗里找一个不存在的格子
    expect(blocked?.message).toContain('（讯飞那一家是 AppID、API Key 与 APISecret）填好')
    // 落盘的是弹窗自己那颗「保存」：指到右下角「保存设置」就等于让用户白点一颗碰不到凭据的按钮
    expect(blocked?.message).toContain('点弹窗底部的「保存」')
    expect(blocked?.message).not.toContain('保存设置')
    // 这句不许顺手把②那句带出来：用户没建过方案，谈不上「勾上当前使用」
    expect(blocked?.message).not.toContain('没有「当前使用」的那一套')
  })

  it('建了三套但没有「当前使用」那一条：改成「在弹窗里勾上当前使用再保存」，并把条数说出口', async () => {
    api.getSettings.mockResolvedValue(cloudSettings())
    api.listProfiles.mockResolvedValue(profilesView(['a', 'b', 'c'], ''))

    const blocked = await checkTranscriptionReady()

    expect(blocked?.message).toContain('那 3 套方案里现在没有「当前使用」的那一套')
    expect(blocked?.message).toContain('点要用的那一行的「编辑」')
    expect(blocked?.message).toContain('在弹窗里勾上「当前使用」再点「保存」')
    expect(blocked?.message).not.toContain('一条云端转写方案都还没有')
  })

  it('列表没读回来时不编原因：落回那句「API Base 或 Key 还没填」', async () => {
    // 界面拿不到证据就说「你没选方案」，是把读盘失败说成用户漏做了一步
    api.getSettings.mockResolvedValue(cloudSettings({ asrKeyStatus: 'none', asrApiBase: '' }))
    api.listProfiles.mockResolvedValue(null)

    const blocked = await checkTranscriptionReady()

    expect(api.listProfiles).toHaveBeenCalledTimes(1)
    expect(blocked?.message).toContain('API Base 或 API Key 还没填')
    expect(blocked?.message).toContain('点它的「编辑」，在弹窗里把那几格补全并点「保存」')
    expect(blocked?.message).not.toMatch(/方案都还没有|没有「当前使用」/)
  })

  it('有「当前使用」那一条且凭据齐全：不拦下', async () => {
    api.getSettings.mockResolvedValue(cloudSettings())
    api.listProfiles.mockResolvedValue(profilesView(['a'], 'a'))

    expect(await checkTranscriptionReady()).toBeNull()
  })

  /**
   * 讯飞那一档要三把凭据（#343）。这一组钉的是「缺哪一把就点名哪一把」：
   * 缺着发出去只会撞一条 100009「鉴权失败」，那句不说哪格错了，用户只能三格挨个试。
   * 同样要紧的是**不许**落回那句泛泛的「API Base 或 API Key 还没填」——它对这一档是错的口径。
   */
  describe('讯飞那一档：三把凭据缺一把就点名那一把', () => {
    const iflytek = (over: Record<string, unknown> = {}) =>
      cloudSettings({
        asrVendor: 'iflytek',
        asrAppId: 'app-1',
        asrSecretStatus: 'encrypted',
        asrApiBase: 'https://office-api-ist-dx.iflyaisol.com',
        ...over,
      })

    it('三把都在：放行，且不问本地引擎', async () => {
      api.getSettings.mockResolvedValue(iflytek())
      api.listProfiles.mockResolvedValue(profilesView(['a'], 'a'))

      expect(await checkTranscriptionReady()).toBeNull()
      expect(api.testConnection).not.toHaveBeenCalled()
    })

    it('只缺 APISecret：只说 APISecret，不把已经填好的 AppID 也报上去', async () => {
      api.getSettings.mockResolvedValue(iflytek({ asrSecretStatus: 'none' }))
      api.listProfiles.mockResolvedValue(profilesView(['a'], 'a'))

      const blocked = await checkTranscriptionReady()

      expect(blocked?.message).toContain('还缺 APISecret')
      expect(blocked?.message).not.toContain('AppID、')
      expect(blocked?.message).toContain('讯飞')
      expect(blocked?.settingsTab).toBe('asr')
      // 落回那句泛泛的话就等于没说：这一档不是「API Base 或 API Key」两格的事
      expect(blocked?.message).not.toContain('API Base 或 API Key 还没填')
    })

    it('AppID、API Key、接口地址一起缺：三样按顺序点名', async () => {
      api.getSettings.mockResolvedValue(
        iflytek({ asrAppId: '', asrKeyStatus: 'none', asrApiBase: '' })
      )
      api.listProfiles.mockResolvedValue(profilesView(['a'], 'a'))

      const blocked = await checkTranscriptionReady()

      expect(blocked?.message).toContain('还缺 AppID、API Key、接口地址')
      // APISecret 这一把是好的，不该被捎带进去
      expect(blocked?.message).not.toContain('APISecret')
    })

    it('APISecret 解不开：与 Key 解不开同一句话，不去点名单格', async () => {
      api.getSettings.mockResolvedValue(iflytek({ asrSecretStatus: 'unreadable' }))
      api.listProfiles.mockResolvedValue(profilesView(['a'], 'a'))

      const blocked = await checkTranscriptionReady()

      expect(blocked?.message).toBe(UNREADABLE_KEY_MESSAGE)
      expect(api.listProfiles).not.toHaveBeenCalled()
    })
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
