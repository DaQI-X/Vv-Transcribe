/**
 * 引擎的 stdout 能不能实时进到 app.log（#285，#284 留下的那条）。
 *
 * 宿主用管道接管两个 sidecar 的 stdout，Python 在这种管道上是块缓冲：`print` 不带 `flush`
 * 就不往下发。改前本机 app.log 的现场是——一次 36.40 秒的转写，`Loading Whisper model`、
 * `Model loaded successfully`、`Transcription completed in 36.40s` 三句打印时刻隔着几十秒，
 * 落盘时间戳却是同一个 13:22:31.572，而那句请求的发出时刻是 13:09:07.850（引擎期间没重启：
 * 上一条 `Starting Vv Transcribe ASR service` 在 13:08:54.195）。也就是隔了 13 分 24 秒，
 * 而且是攒成一批发回来。日志里落的时刻是「送达」不是「发生」，报障时按它排时序就是错的。
 *
 * 所以判据按文件查（注释里提 flush 不该把测试弄红）：每个 sidecar 目录顶层的 .py 里，
 * 直接写 stdout 的那一扇只许是 `log()`，别处不许再有裸 `print`；顺带钉住「引擎话都带
 * `[ASR] `/`[TTS] ` 前缀」——宿主按前缀分级别，没前缀的行会落 WARN（见下面那两条接线断言）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SIDECARS = [
  { dir: 'python-asr', prefix: '[ASR]', manager: 'electron/main/services/asrServiceManager.ts', infoPattern: '^\\[ASR\\] ' },
  { dir: 'python-tts', prefix: '[TTS]', manager: 'electron/main/services/localTtsEngine.ts', infoPattern: '^\\[TTS\\] ' },
]

/**
 * 只取每个目录顶层的 .py。venv/、build-arm64/、dist-arm64/ 里第三方代码的 print 不归我们管，
 * 递归扫会把测试变成对 site-packages 的投票；顶层新增一个 .py 会自动纳进来。
 */
async function entryScripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isFile() && e.name.endsWith('.py')).map((e) => join(dir, e.name))
}

/** 去掉注释行：注释里写「别用不带 flush 的 print」不是违规 */
function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*#/.test(line))
}

describe('引擎 stdout：一行一回话', () => {
  it('每个 sidecar 目录顶层都有 .py 可查（防止判据空转）', async () => {
    for (const { dir } of SIDECARS) {
      expect(await entryScripts(dir)).not.toHaveLength(0)
    }
  })

  /**
   * 唯一那扇门是 `log()`：print 只出现一次，且带 `flush=True`。
   * 出现第二处 print 就等于第二处可以悄悄块缓冲——块缓冲的毛病不在某一句，在「没 flush」。
   */
  it('print 只许出现在 log() 那一行，且必须 flush', async () => {
    for (const { dir } of SIDECARS) {
      for (const file of await entryScripts(dir)) {
        const prints = codeLines(await readFile(file, 'utf-8')).filter((line) => /print\(/.test(line))
        expect(prints, `${file} 里的 print 调用点`).toHaveLength(1)
        expect(prints[0]).toContain('flush=True')
      }
    }
  })

  /** 调用点都得走 log()；留着 print 的写法上面那条已经拦了，这条拦的是「换个名字自己写 stdout」 */
  it('引擎话都经 log() 发出，且带宿主认得的前缀', async () => {
    for (const { dir, prefix } of SIDECARS) {
      for (const file of await entryScripts(dir)) {
        const calls = codeLines(await readFile(file, 'utf-8'))
          .filter((line) => /\blog\(/.test(line) && !/^\s*def log\(/.test(line))
        expect(calls, `${file} 里的 log 调用点`).not.toHaveLength(0)
        for (const call of calls) {
          expect(call, `缺少 ${prefix} 前缀：${call.trim()}`).toContain(`"${prefix} `)
        }
      }
    }
  })

  /**
   * 前缀不是装饰：宿主那两处分类把 `[ASR] ` / `[TTS] ` 认成 INFO，认不出前缀的一律 WARN。
   * 这条接线断言在的时候，上一条测试才不是自说自话。
   */
  it('宿主侧仍按前缀给引擎横幅定 INFO 级别', async () => {
    for (const { prefix, manager, infoPattern } of SIDECARS) {
      const source = await readFile(manager, 'utf-8')
      expect(source, `${manager} 应保留对 ${prefix} 前缀的 INFO 分流`).toContain(infoPattern)
    }
  })
})
