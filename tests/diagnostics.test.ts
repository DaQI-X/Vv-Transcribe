/**
 * 诊断包这一份文本（#358）。
 *
 * 判据写的是「导出的包在本机 grep 不到任何 `sk-` 形态的串与完整绝对路径」，而一句写在验收单上的
 * 规矩跟写在注释里的规矩是同一件东西——#281 与 #280 那两个坑都是这么长出来的。所以这里不测
 * 「函数返回什么」，测的是四条以后最容易被顺手改掉、一改就漏隐私的口径：
 * 1. 撞上 #281 那张表的键名**整格跳过**，并在包里点名跳了谁（新加一格 Key 时不用改这份代码，
 *    它自动出现在「跳过」那行——这才是把「别写凭据」变成机制，而不是变成一份要人记得维护的清单）；
 * 2. 状态位不能被一起跳掉（`asrSecretStatus` 归一化后含 `secret`，一刀切会让包答不出
 *    「讯飞那把第二凭据到底存没存」，而那正是它最该答的一句）；
 * 3. 「没填」「没读到」「一份都没有」三种空态要分开说，混一种就是句谎；
 * 4. 日志正文与闸门之前写下的旧轮转档一起再收一遍——盘上那份历史残留不能因为「这次没改写」就发出去。
 */
import { describe, expect, it } from 'vitest'
import {
  diagnosticsFileName,
  landsInSweepTarget,
  LOG_TAIL_LINES,
  renderDiagnostics,
  type DiagnosticsSnapshot,
} from '../electron/main/services/diagnosticsService'

/** 一把真形状的 Key 与一处真形状的目录：用例要 grep 的是这两样，不是「有没有调过 redact」 */
const KEY = 'sk-abcdef123456UVWXYZ'
const HOME_PATH = '/Users/daqi/Movies/采访第3期/成片.mp3'

/** 一份「什么都没配、什么都没读到」的最小快照，用例各自往上要盖哪一格再改 */
function baseSnapshot(over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    exportedAt: '2026-11-10T02:03:04.000Z',
    appVersion: '1.1.4',
    electron: '37.0.0',
    chrome: '138.0.0.0',
    node: '22.0.0',
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '27.2.0',
    locale: 'zh-CN',
    packaged: true,
    dataDirName: 'Vv Transcribe',
    settings: {
      asrProvider: 'local',
      asrVendor: 'openai',
      asrApiBase: 'https://api.openai.com/v1',
      asrModel: 'whisper-1',
      asrAppId: '',
      asrLocalModel: 'base',
      asrLanguage: 'zh',
      asrEngineAuth: 'require',
      aiProvider: 'openai',
      aiApiBase: '',
      aiModel: '',
      ttsProvider: 'minimax',
      ttsApiBase: '',
      ttsModel: 'speech-02-hd',
      ttsResourceId: '',
      ttsVoice: '',
      ttsEngine: 'cloud',
      ttsLocalEngine: '',
      ttsLocalVoice: '',
      asrKeyStatus: 'none',
      aiKeyStatus: 'none',
      ttsKeyStatus: 'encrypted',
      asrSecretStatus: 'none',
      keyEncryptionAvailable: true,
      storageProblem: null,
    } as DiagnosticsSnapshot['settings'],
    profiles: {
      profiles: { asr: [], ai: [], tts: [] },
      defaultProfileId: { asr: '', ai: '', tts: '' },
      maxProfiles: 5,
      storageProblem: null,
    },
    components: [],
    engineInManifest: null,
    asrService: { ready: true, error: null },
    logs: [],
    tailName: null,
    tail: null,
    tailSkipped: 0,
    ...over,
  }
}

describe('包里没有凭据、没有绝对路径', () => {
  it('值里混着 Key 与整段路径时，两者都留不下', () => {
    const snap = baseSnapshot()
    // 直接往字段里灌：测的是「不管它长在哪个字段上都会被收掉」，不是「这份快照本来干净」
    snap.settings.asrApiBase = `https://api.openai.com/v1?api_key=${KEY}`
    snap.settings.aiModel = KEY
    snap.settings.storageProblem = `读不出来：${HOME_PATH}`
    const out = renderDiagnostics(snap)

    expect(out).not.toContain(KEY)
    expect(out).not.toContain('sk-abcdef')
    expect(out).not.toContain('/Users/daqi')
    expect(out).not.toContain('api_key=')
    // 但「出过事」这件事要说得出来——隐掉整句就等于把故障一起隐了
    expect(out).toContain('storageProblem')
    expect(out).toContain('读不出来')
  })

  it('撞上敏感键名的字段整格跳过，并在包里点名跳了谁', () => {
    const snap = baseSnapshot()
    // SettingsView 现在没有这两格；模拟「以后加了一格凭据/文稿字段」——这条用例测的就是
    // 那时不用改这份代码，新字段自动落进跳过那行，而不是自动落进正文。
    // 文稿那格用表里真有的名字（CONTENT_KEY 按归一化**全等**匹配，`transcriptText` 那种派生名故意不在表里）
    Object.assign(snap.settings, { asrApiSecret: KEY, transcript: '一整段用户文稿' })
    const out = renderDiagnostics(snap)

    expect(out).not.toContain(KEY)
    expect(out).not.toContain('一整段用户文稿')
    expect(out).toMatch(/已跳过 2 格：asrApiSecret、transcript/)
  })

  it('AppID 只报有没有填：它能指认账号是哪一位，界面上却没有「状态」这一说', () => {
    const filled = baseSnapshot()
    filled.settings.asrAppId = '1234567890abcdef'
    expect(renderDiagnostics(filled)).toContain('转写 AppID：已填')
    expect(renderDiagnostics(filled)).not.toContain('1234567890abcdef')

    expect(renderDiagnostics(baseSnapshot())).toContain('转写 AppID：未填')
  })

  it('状态位不算凭据，必须留着——尤其 asrSecretStatus 名字里就带着 secret', () => {
    const snap = baseSnapshot()
    snap.settings.asrSecretStatus = 'encrypted'
    const out = renderDiagnostics(snap)
    expect(out).toContain('asrSecretStatus：encrypted')
    expect(out).toContain('keyEncryptionAvailable：是')
  })
})

describe('空态三种说法要分开', () => {
  it('没填的格子照列出来，写成（空）而不是从包里消失', () => {
    const out = renderDiagnostics(baseSnapshot())
    expect(out).toContain('aiApiBase：（空）')
    expect(out).toContain('ttsVoice：（空）')
  })

  it('一份日志都没读到时说「没读到」，不能演成「这个用户没有日志」', () => {
    const out = renderDiagnostics(baseSnapshot())
    expect(out).toContain('（这一层没读到任何 app*.log）')
    expect(out).toContain('（这次没读到日志正文')
  })

  it('组件一套都没读到时同样点名，而不是给一个空的段落', () => {
    expect(renderDiagnostics(baseSnapshot())).toContain('（一份组件状态都没读到）')
  })

  it('某一档 0 套方案是真状态，那行要说 0 套', () => {
    expect(renderDiagnostics(baseSnapshot())).toContain('tts：0 套')
  })
})

describe('方案与组件', () => {
  it('方案自己的凭据格不进包，厂商与模型进', () => {
    const snap = baseSnapshot()
    snap.profiles.profiles.tts = [
      {
        id: 'tts-1a2b3c4d',
        name: '公司网关',
        values: { ttsProvider: 'minimax', ttsApiBase: 'https://api.minimax.cn', apiKey: KEY },
        keyStatus: 'encrypted',
        secretStatus: {},
      },
    ]
    snap.profiles.defaultProfileId.tts = 'tts-1a2b3c4d'
    const out = renderDiagnostics(snap)

    expect(out).not.toContain(KEY)
    expect(out).not.toContain('apiKey')
    expect(out).toContain('tts-1a2b3c4d')
    expect(out).toContain('ttsProvider=minimax')
    expect(out).toContain('Key=encrypted')
    expect(out).toContain('tts：1 套，当前使用 tts-1a2b3c4d')
  })

  it('装没装、占多少、清单有没有这一条都要在同一行里', () => {
    const snap = baseSnapshot()
    snap.components = [
      {
        id: 'vv-tts-server',
        title: '本地配音引擎',
        kind: 'binary',
        hint: '',
        installed: true,
        bytes: 15 * 1024 * 1024,
        localVersion: '1.0.8',
        remoteVersion: null,
        remoteBytes: null,
        action: 'repair',
        inManifest: null,
      },
    ]
    const out = renderDiagnostics(snap)
    expect(out).toContain('vv-tts-server')
    expect(out).toContain('已装')
    // 体积走 #282 那一把尺（formatBytes），与「按需组件」那行念同一个数：15MiB → 15.7MB 而不是 15360KB
    expect(out).toContain('本机 15.7MB')
    expect(out).toContain('建议动作=repair')
    // null 是「还没查清单」，不能显示成（空）让人以为清单是空的
    expect(out).toContain('清单有这条=（空）')
  })
})

describe('日志尾部', () => {
  it('闸门之前写下的旧轮转档在这一层再收一遍', () => {
    const snap = baseSnapshot()
    snap.logs = [{ name: 'app.2.log', bytes: 5120 }]
    // 这一行长得就像 #281 之前落盘的样子：整段路径 + 一把裸 Key
    snap.tail = [`{"level":"ERROR","message":"ffprobe ${HOME_PATH}","key":"${KEY}"}`]
    snap.tailName = 'app.2.log'
    const out = renderDiagnostics(snap)

    expect(out).not.toContain('/Users/daqi')
    expect(out).not.toContain(KEY)
    // 是哪个文件仍然要说：收成 basename 就够定位了
    expect(out).toContain('成片.mp3')
    expect(out).toContain('以下取自 app.2.log')
    expect(out).toContain('app.2.log｜5KB')
  })

  it('截了尾要说前面省略多少行，不能装作这就是全部', () => {
    const snap = baseSnapshot()
    snap.tail = ['{"message":"a"}', '{"message":"b"}']
    snap.tailName = 'app.log'
    snap.tailSkipped = 9000
    const out = renderDiagnostics(snap)
    expect(out).toContain('前面 9000 行没带')
    expect(out).not.toContain('全部 2 行')

    snap.tailSkipped = 0
    expect(renderDiagnostics(snap)).toContain('全部 2 行')
  })

  it('取的行数就是那份文本承诺的行数', () => {
    expect(LOG_TAIL_LINES).toBe(1200)
  })
})

describe('落点与文件名', () => {
  it('选在会被启动清扫删掉的那一层时要拦下来', () => {
    // 清扫按「目录名前缀 transcribe-」删整个目录，所以包只要在那一层里就算中了
    expect(landsInSweepTarget('/var/folders/xq/xxx/T/transcribe-1a2b3c/diag.txt')).toBe(true)
    expect(landsInSweepTarget('/tmp/transcribe-abc/diag.txt')).toBe(true)
    expect(landsInSweepTarget('C:\\Users\\daqi\\AppData\\Local\\Temp\\transcribe-1a2b3c\\d.txt')).toBe(
      true
    )
  })

  it('名字里带 transcribe- 的用户自建文件夹也拦：宁可拦错，不能放错', () => {
    expect(landsInSweepTarget('/Users/daqi/Desktop/vv-diagnostic.txt')).toBe(false)
    expect(landsInSweepTarget('/Users/daqi/Downloads/vv-diagnostic.txt')).toBe(false)
    expect(landsInSweepTarget('/Users/daqi/Documents/vv-export/transcribe-notes/diag.txt')).toBe(true)
    /**
     * `transcribe-notes` 这种一眼不是清扫靶子的位置确实被误拦了，这是这里故意的取舍：
     * 判式抄的是清扫那一头的形状（`urlDownloader.ts` 认 `startsWith('transcribe-')` 的目录名），
     * 而两种错的代价不对等——误拦只是「换个文件夹再点一次」，误放是这份包过一天自己没了，
     * 且一个字节的提示都不会有。
     *
     * 没有改成「跟 os.tmpdir() 比前缀」：macOS 上系统对话框回的是 `/private/var/folders/…`，
     * 而 `os.tmpdir()` 回 `/var/folders/…`，比前缀会在最该拦的那条路径上判 false。
     */
    expect(landsInSweepTarget('/Users/daqi/Documents/transcribe-notes/diag.txt')).toBe(true)
  })

  it('默认名是可当附件名的 ASCII，带日期与分钟', () => {
    expect(diagnosticsFileName(new Date(2026, 10, 10, 2, 3))).toBe('vv-diagnostic-20261110-0203.txt')
  })
})

describe('摘要的形状', () => {
  it('每段都有标题，读的人不用猜哪一段是什么', () => {
    const out = renderDiagnostics(baseSnapshot())
    for (const section of [
      '== 运行环境 ==',
      '== 配置摘要（磁盘上已保存的，不含任何凭据）==',
      '== 方案（几套 API 接入）==',
      '== 本机组件 ==',
      '== 本机转写引擎 ==',
      '== 日志文件（userData/logs 里的那几份）==',
    ]) {
      expect(out).toContain(section)
    }
    expect(out).toContain('应用版本：1.1.4')
    expect(out).toContain('运行方式：打包安装版')
    expect(out).toContain('平台：darwin arm64')
    // 数据目录只报名字：「是哪个应用的数据目录」有用，「它装在哪一层」正是要隐的那部分
    expect(out).toContain('数据目录名：Vv Transcribe')
  })

  it('引擎没起来时那句原因原样带上，只把里面的路径与 Key 收掉', () => {
    const snap = baseSnapshot()
    snap.asrService = { ready: false, error: `启动失败：spawn ${HOME_PATH} EACCES（key ${KEY}）` }
    const out = renderDiagnostics(snap)
    expect(out).toContain('服务状态：未就绪')
    expect(out).toContain('启动失败：spawn 成片.mp3 EACCES')
    expect(out).not.toContain(KEY)
  })
})
