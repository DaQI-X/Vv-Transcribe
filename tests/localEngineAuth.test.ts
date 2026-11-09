/**
 * 本机 ASR 引擎的访问边界（1.1.3 #353）。
 *
 * 为什么要这一层：`/transcribe` 收的是**盘上路径**（`{"audio_path": "/Users/…/x.wav"}`），
 * 也就是它肯替调用方读本机上任意一个音频文件再转成文字。改前它绑 0.0.0.0，还挂着一段
 * `allow_origins=["*"]` 的 CORS 中间件——于是任何装了本应用的电脑，网页里的脚本都能把这份
 * 能力借走（局域网直连、DNS 重绑定都够得到 8000）。#353 把它收回收环并加一道 Bearer 校验。
 *
 * 这个文件钉的是「修完别再退回去」，因为这三条形状都很容易被一次看似无关的改动抹掉：
 * 加回 CORS 是为了「网页调不通」，把 host 改回 0.0.0.0 是为了「手机连不上」，
 * 给 /health 也补一道校验看着像「一视同仁」——而那一条会直接把宿主的启动握手锁死
 * （probeHealth 不带凭证，锁死的症状是 60 秒超时后一句「引擎没能应答」，查不到根因）。
 *
 * 判式为什么写在源码上：纯函数单测跑在 Node 里，碰不到那个冻结二进制；二进制里的行为只有
 * CI 各平台 `VV_ENGINE_SMOKE=1` 那一档验得到（tests/engineSmoke.test.ts 的转写用例钉的是
 * 「不带凭证→401、带错→401、带对才放进 handler」）。源码形状 + 真进程行为两边合起来才是完整证据，
 * 缺一半就有一半是假设。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocalEngineAuthHeader } from '../electron/main/services/asrServiceManager'
import { LocalASRProvider } from '../electron/main/services/asr/localASR'

/**
 * 注释行不算数：main.py 里刻意把当年那段 CORS 与 0.0.0.0 写进注释说明「为什么没有它」，
 * 判式只认代码，否则解释自己会把测试弄红（同 tests/sidecarStdout.test.ts 里那句口径）。
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

describe('引擎那一侧的边界形状', () => {
  const engine = async () => codeOnly(await readFile('python-asr/main.py', 'utf-8'))

  it('只绑 127.0.0.1，代码里没有 0.0.0.0，也没有那段任意来源的 CORS', async () => {
    const src = await engine()
    expect(src).toContain('uvicorn.run(app, host="127.0.0.1", port=port)')
    expect(src).not.toContain('0.0.0.0')
    expect(src).not.toContain('allow_origins')
    expect(src).not.toContain('CORSMiddleware')
  })

  it('凭证读 VV_ASR_TOKEN，比对用 hmac.compare_digest，绝不拿 /health 回显的 BOOT_ID 顶替', async () => {
    const src = await engine()
    expect(src).toContain('ASR_TOKEN = os.environ.get("VV_ASR_TOKEN", "")')
    expect(src).toContain('hmac.compare_digest(credential.strip(), ASR_TOKEN)')
    // BOOT_ID 是 /health 原样回显的：用它当凭证，任何连得上端口的人问一次就拿到了
    expect(src).not.toMatch(/ASR_TOKEN\s*=\s*.*BOOT_ID/)
  })

  it('/transcribe 挂了校验，/health 不挂（宿主启动握手要靠它裸奔）', async () => {
    const src = await engine()
    expect(src).toContain('@app.post("/transcribe", dependencies=[Depends(require_token)])')
    const healthDecorators = src.split('\n').filter((line) => line.includes('@app.get("/health")'))
    expect(healthDecorators, '/health 那条路由不见了').toHaveLength(1)
    expect(healthDecorators[0]).not.toContain('Depends')
  })
})

describe('宿主这一侧真的带上凭证', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 引擎回一句 done，够让 transcribe 走完整条流 */
  const okStream = () =>
    new Response('{"type":"done"}\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } })

  it('打的是 127.0.0.1:8000，请求头带的就是主进程那份本次凭证', async () => {
    const calls: { url: string; auth: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        calls.push({ url: String(input), auth: headers.get('authorization') ?? '' })
        return okStream()
      }),
    )
    const segments = await new LocalASRProvider().transcribe('/tmp/不存在.wav', { language: 'zh' })
    expect(segments).toEqual([])
    expect(calls).toHaveLength(1)
    // 写死 127.0.0.1：引擎只绑 IPv4 回环，而某些机器上 localhost 先解析到 ::1
    expect(calls[0].url).toBe('http://127.0.0.1:8000/transcribe')
    expect(calls[0].auth).toBe(getLocalEngineAuthHeader().Authorization)
    expect(calls[0].auth).toMatch(/^Bearer [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('401 要说那句有出路的中文，而不是把引擎的英文原文甩给用户', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: 'Missing or invalid bearer token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const err = await new LocalASRProvider().transcribe('/tmp/不存在.wav', {}).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('重启本地引擎')
    expect((err as Error).message).not.toContain('Missing or invalid')
  })
})

describe('凭证不过 IPC、不落盘', () => {
  let dir = ''

  afterEach(async () => {
    vi.resetModules()
    vi.restoreAllMocks()
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  /**
   * 磁盘上那一项存的是「校不校验」，不是凭证本身。这一条是给下一个动这里的人看的：
   * 想把那串东西显示到界面上（哪怕只是「复制」按钮），就得先让脱敏视图带着它过一次 IPC，
   * 而它一旦落盘就是明文躺在 settings.json 里——两条都是 API Key 那套规矩明确拒绝的
   * （见 settingsService 的 getSettingsView 与 SECRET_FIELDS）。
   */
  it('脱敏视图与磁盘上那份配置里都没有这串凭证', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vv-engine-auth-'))
    vi.resetModules()
    vi.spyOn(app, 'getPath').mockImplementation(
      ((name: string) => (name === 'userData' ? dir : join(dir, name))) as typeof app.getPath,
    )
    const service = await import('../electron/main/services/settingsService')
    const token = getLocalEngineAuthHeader().Authorization.slice('Bearer '.length)
    const flat = await service.loadSettings()
    const view = await service.getSettingsView()
    await service.saveSettings({ asrEngineAuth: 'off' })
    const onDisk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf-8'))

    expect(flat.asrEngineAuth).toBe('require')
    expect(view.asrEngineAuth).toBe('require')
    expect(JSON.stringify(view)).not.toContain(token)
    expect(onDisk.asrEngineAuth).toBe('off')
    expect(JSON.stringify(onDisk)).not.toContain(token)
    // 全局段只收字符串：布尔/对象形状发过来会被 normalizeGlobals 直接扔掉，看着像改了、盘上没动
    expect(typeof flat.asrEngineAuth).toBe('string')
  })
})

describe('界面上没有那一格，但保存不许把它抹掉', () => {
  /**
   * #353 收尾时拍板：这一项不给用户看（它不改转写结果、不多发包，没有可决定的东西），
   * 出路改成手改 `settings.json`。于是这里的风险换了一头——`SettingsModal` 的保存发的是**整份**
   * `values`，那个键一旦从 GLOBAL_VALUE_KEYS 里掉出去（看着像「没有对应格子的死代码」，最容易被顺手清理），
   * 表单就带着 DEFAULT_VALUES 那个 `require` 发出去，排查时手改的 `off` 被每一次界面保存悄悄盖回。
   * 判式写在源码形状上：这一层是渲染层的组件，纯函数单测跑不到它，而它错了没有任何一条链路会红。
   */
  it('没有控件绑它，但它在全局回填名单里', async () => {
    const src = await readFile('src/components/settings/SettingsModal.tsx', 'utf-8')
    expect(src).not.toContain('引擎访问校验')
    expect(src).not.toContain("updateField('asrEngineAuth'")
    const backfill = src.match(/const GLOBAL_VALUE_KEYS[^\n]*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
    expect(backfill, 'GLOBAL_VALUE_KEYS 那张名单不见了').toContain("'asrEngineAuth'")
  })
})
