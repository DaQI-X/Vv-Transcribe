/**
 * 体积单位这一把尺（#282①）。
 *
 * 改之前渲染层有 6 份「字节数 → 给人看的体积」实现，标签都写 KB/MB，一半按 1024、一半按 1000：
 * 同一个引擎包（24,438,304 字节）在「按需组件」里念 24.4MB、在配音页会是 23.3MB。这一条链路上
 * 那串数字的唯一用途是决定「这次下载要不要下」，两个数并排出现时用户没有任何线索怀疑它们同源。
 *
 * 所以用例分两层：换算本身钉住四档与进位边界；判据钉住「不再出现第二把尺」——按文件与代码行查，
 * 注释里提一句「以前这里按 1024 除」不该把测试弄红。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { modelSizeHint } from '../electron/main/services/localTtsEngine'
import { formatBytes } from '../src/utils/formatBytes'

/**
 * 只收 .ts/.tsx：`src/assets` 里那份 lottie JSON 和 `electron/resources` 下的词库都有「1024」，
 * 扫进去纯属噪音，而且它们不是代码，改不改都不构成第二把尺。
 */
async function collectCode(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collectCode(path)))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

/** 仓库相对路径，测试红了时读起来比绝对路径省事 */
function repoPath(file: string): string {
  return file.replace(`${process.cwd()}/`, '')
}

/** 去掉行注释与 JSDoc 正文，只留可能真的在跑的那几行 */
function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
}

describe('formatBytes：换算', () => {
  it('四档各按其位：B 与 KB 取整、MB 一位小数、GB 两位小数', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(999)).toBe('999B')
    expect(formatBytes(1000)).toBe('1KB')
    expect(formatBytes(1536)).toBe('2KB')
    expect(formatBytes(24_438_304)).toBe('24.4MB')
    expect(formatBytes(3_500_000_000)).toBe('3.50GB')
  })

  /**
   * 档位分界按「将要显示的那一位」四舍五入之后判，不按整档大小：
   * 999,999 字节按 `bytes < 1e6` 会留在 KB 档、四舍五入成 1000KB，界面看着就像单位换算坏了。
   */
  it('进位边界不会留下 1000KB / 1000.0MB 这种半格', () => {
    expect(formatBytes(999_499)).toBe('999KB')
    expect(formatBytes(999_500)).toBe('1.0MB')
    expect(formatBytes(999_949_999)).toBe('999.9MB')
    expect(formatBytes(999_950_000)).toBe('1.00GB')
    expect(formatBytes(999_999_999)).toBe('1.00GB')
  })

  it('README、清单与界面引用的那三个体积仍是原数', () => {
    // VITS / Kokoro 的指纹表字节数（localTtsEngine.ts 钉的那两个数）
    expect(formatBytes(135_454_939)).toBe('135.5MB')
    expect(formatBytes(426_573_262)).toBe('426.6MB')
    // 1.0.7 引擎包：按需组件列表里「下载约 …」就是它
    expect(formatBytes(24_438_304)).toBe('24.4MB')
  })

  /** 钉住「选了 1000」这个决定本身：换成 1024 这把测试就会红，改的人得先回答为什么 */
  it('按 1024 算会差出 7%，这里明确不采纳', () => {
    expect(formatBytes(24_438_304)).not.toBe(`${(24_438_304 / 1024 / 1024).toFixed(1)}MB`)
    expect(formatBytes(135_454_939)).not.toBe(`${(135_454_939 / 1024 / 1024).toFixed(1)}MB`)
  })
})

describe('跨进程共用同一把尺', () => {
  /**
   * 缺件提示由主进程拼，界面上那行「未安装，下载约 …」由渲染层拼，两处必须报同一个数——
   * README 与网站的配音文案引用的就是这 135.5MB / 426.6MB，任何一侧换尺都会让文档对不上。
   * 这条也顺带证明 `electron/main/services/` import `src/utils/formatBytes` 是真跑得通的
   * （另一处是自检里的「…KB 音频」）。
   */
  it('主进程拼出来的模型体积和界面同一个数', () => {
    expect(modelSizeHint('sherpa-onnx-vits-zh-ll')).toBe('VITS 的模型（约 135.5MB）')
    expect(modelSizeHint('kokoro-multi-lang-v1_1')).toBe('Kokoro 的模型（约 426.6MB）')
  })
})

describe('判据：体积换算只剩一把尺', () => {
  /**
   * logger.ts 是唯一被允许的持有者，那句 `(MAX_LOG_BYTES / 1024 / 1024)` 量的是它自己按 1024
   * 定义的常量（5MB 日志上限），不是给用户看的产物体积；拿 1000 去除一个 1024 的常量反而更绕。
   */
  it('除以 1024 的字节换算只存在于 logger.ts', async () => {
    const holders: string[] = []
    for (const dir of ['src', 'electron']) {
      for (const file of await collectCode(join(process.cwd(), dir))) {
        if (codeLines(await readFile(file, 'utf-8')).some((line) => /\/\s*1024\b/.test(line))) {
          holders.push(repoPath(file))
        }
      }
    }
    expect(holders).toEqual(['electron/main/services/logger.ts'])
  })

  /**
   * 「界面上那些 KB/MB/GB 字样只可能出自换算器」是这一条真正想守的东西，但今天还不到不了：
   * 下面这些持有者是 #282 有意没收的，各有各的理由，列死在这里是为了让「再加一处自己拼体积」
   * 变成一次显式的决定——测试红了，要么改用 formatBytes，要么来加一行并说清为什么不能改。
   * - `componentArchive` / `componentService` / `ytDlpUpdate`：下载超时、断流、解压对账那几句
   *   走的是 `toFixed(0)` 的粗口径（`约 24MB`），报错时用户要判断的是「还要不要重试」，不是精确
   *   体积。收进换算器会把每一句改成一位小数，属于另一次改动，本次没动。
   * - `logger`：见上一条用例，它量的是自己那个按 1024 定义的日志上限。
   * - `localASR` / `UploadStatus`：`${weightsMb}MB`，数字本来就出自档位表里按 MB 钉好的那一列，
   *   手上没有字节数，套不进这个函数。
   */
  it('体积单位字样的持有者是这份清单', async () => {
    const unit = /(?:^|[^A-Za-z0-9_])(?:KB|MB|GB|TB)(?![A-Za-z0-9_-])/
    const holders: string[] = []
    for (const dir of ['src', 'electron']) {
      for (const file of await collectCode(join(process.cwd(), dir))) {
        if (codeLines(await readFile(file, 'utf-8')).some((line) => unit.test(line))) {
          holders.push(repoPath(file))
        }
      }
    }
    expect(holders.sort()).toEqual(
      [
        'electron/main/services/asr/localASR.ts',
        'electron/main/services/componentArchive.ts',
        'electron/main/services/componentService.ts',
        'electron/main/services/logger.ts',
        'electron/main/services/ytDlpUpdate.ts',
        'src/components/transcription/UploadStatus.tsx',
        'src/utils/formatBytes.ts',
      ].sort(),
    )
  })
})
