/**
 * `ASRStage` 那一串阶段名在几个界面上各自有没有落地（#435 加的 `downloading_model` 是起因）。
 *
 * 这类断言测不出功能对不对，它拦的是**接线漏一半**：`ASRStage` 加一个成员，`tsc` 一声不响——
 * 界面那一处是三元链的 `else`，新阶段会一路掉进「ASR 识别转写处理中」，用户看到「正在分析音频」
 * 而机器其实在下 486MB。跨 IPC 那四位手抄的形状同理（preload 两份 + .d.ts + store + CLI）：
 * 少抄一格，取件那一段就永远读不到字节数，界面只能退回那句没有分母的文案。
 *
 * 判式按源码文本查而不是 import 模块：这些都是编译期就定死的字面量，跑起来反而要拖一整条
 * electron 依赖链进来（同一份对账在 tests/formatBytes.test.ts、tests/historyIpc.test.ts 里也是这个写法）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function read(...parts: string[]): Promise<string> {
  return readFile(join(process.cwd(), ...parts), 'utf-8')
}

/** 从 `export type ASRStage = 'a' | 'b' | 'c'` 里取出成员名 */
async function stageMembers(): Promise<string[]> {
  const types = await read('electron/main/services/asr/types.ts')
  const line = types.split('\n').find((l) => l.startsWith('export type ASRStage'))
  if (!line) throw new Error('ASRStage 那一行找不到了，判式要先改')
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('阶段名在每一处界面都有话说', () => {
  it('转写页那一栏的三元链覆盖了每个阶段', async () => {
    const ui = await read('src/components/transcription/UploadStatus.tsx')
    for (const stage of await stageMembers()) {
      expect(ui, `UploadStatus 没有 stage === '${stage}' 的分支`).toContain(`'${stage}'`)
    }
  })

  it('vv 终端那一行的 STAGE_LABEL 覆盖了每个阶段', async () => {
    const cli = await read('electron/cli/vv.ts')
    const table = cli.slice(cli.indexOf('const STAGE_LABEL'), cli.indexOf('export async function run'))
    for (const stage of await stageMembers()) {
      expect(table, `vv 里 ${stage} 会退化成把内部键名甩给用户读`).toContain(`${stage}:`)
    }
  })
})

describe('跨 IPC 的模型形状四处手抄一致', () => {
  /**
   * `download` 是 #435 的实测字节；漏抄一处，界面就只会念档位而念不出「已取多少」。
   * 判式取「同一个对象字面量里 weightsMb 之后跟着 download」而不是数某一行——store 那份是
   * 一行一格的 interface，压成一行反而会把真正的形状读没。
   */
  const carriers = [
    ['electron/preload/index.ts', 2],
    ['electron/preload/index.d.ts', 1],
    ['src/stores/useTranscriptionStore.ts', 1],
    ['electron/cli/vv.ts', 1],
  ] as const
  const shape = /weightsMb[^}]*?download/g

  for (const [file, times] of carriers) {
    it(`${file} 带 download 那一对字节`, async () => {
      const found = (await read(file)).match(shape) ?? []
      expect(found.length, `${file} 里 model 形状应当有 ${times} 处带上取件字节`).toBe(times)
    })
  }
})
