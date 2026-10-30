/**
 * 样式令牌与窗口几何（#282②③）。
 *
 * 这两条都不是「测一个像素」，测的是**引用关系**：
 * - ②：`.diff-panel__*` 那 6 处原先写 `var(--text-tertiary)`，而这个令牌在 `index.css` 里
 *   从来没声明过——浏览器把整条 `color` 声明丢掉，那几行标签其实是继承来的颜色，谁也没发现。
 *   所以判据不能只 grep 那个名字（下个人换成另一个不存在的令牌照样漏），要问「用掉的每个
 *   `--x` 有没有哪一处声明」。
 * - ③：header 左留白是给 macOS 红绿灯让位的，`titleBarStyle: 'hiddenInset'` 只在 mac 上有意义，
 *   可 `padding-left: 108px` 是无条件写的。改成按平台取值之后，新的失效方式是「CSS 分支永远
 *   命不中」——那得看 `<html data-platform>` 有没有人写。所以这一条连着接线一起钉。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssPath = join(process.cwd(), 'src/index.css')

/** 剥掉块注释：文档里提一句某个令牌名，不该被当成一次引用 */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 渲染层的 var() 也可能写在 JSX 内联 style 里，逐行注释同样不算引用 */
async function collectCode(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collectCode(path)))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

describe('判据：CSS 自定义属性不许悬空', () => {
  it('用过的每一个 var(--x) 都在 index.css 里有声明', async () => {
    const css = stripBlockComments(await readFile(cssPath, 'utf-8'))
    // 声明认「行首或 { ; , 空格后面紧跟 --x:」，这样 `.btn--primary:hover` 这类修饰符不会被误认
    const declared = new Set(
      [...css.matchAll(/(?:^|[;{,\s])(--[\w-]+)\s*:/gm)].map((m) => m[1] as string),
    )
    const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] as string))
    for (const file of await collectCode(join(process.cwd(), 'src'))) {
      const source = stripBlockComments(await readFile(file, 'utf-8'))
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n')
      for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(match[1] as string)
    }
    const missing = [...used].filter((name) => !declared.has(name))
    expect(missing).toEqual([])
  })

  /** 单独立一条：②修的就是这个名字，它回来（哪怕只出现在声明侧的对面）就说明那次收口被推翻了 */
  it('--text-tertiary 已经不存在，既不声明也不引用', async () => {
    const css = stripBlockComments(await readFile(cssPath, 'utf-8'))
    expect(css).not.toContain('--text-tertiary')
    const sources = await Promise.all(
      (await collectCode(join(process.cwd(), 'src'))).map((file) => readFile(file, 'utf-8')),
    )
    expect(sources.join('\n')).not.toContain('text-tertiary')
  })
})

describe('header 左留白按平台取值', () => {
  it('.harder_top 的 padding-left 走变量，不写死 108px', async () => {
    const css = stripBlockComments(await readFile(cssPath, 'utf-8'))
    expect(css).toMatch(/\.harder_top\s*\{[^}]*padding-left:\s*var\(--header-pad-left\)/)
  })

  it('mac 分支给 108px，默认分支明确给另一个值', async () => {
    const css = stripBlockComments(await readFile(cssPath, 'utf-8'))
    expect(css).toMatch(/:root\[data-platform="darwin"\]\s*\{[^}]*--header-pad-left:\s*108px/)
    expect(css).toMatch(/:root\s*\{[^}]*--header-pad-left:\s*(?!108px)[\d.]+px/)
  })

  /**
   * CSS 那一半只是半条链路：`[data-platform]` 没人写就永远不命中，界面会一直按默认值画——
   * 在 mac 上表现为 logo 挤到红绿灯底下，而这种错法没有任何报错。值的来源必须是 preload 的
   * `process.platform`（和创建窗口时那句 `titleBarStyle` 同一个来源），不是渲染层猜 UA。
   */
  it('preload 带出 platform，main.tsx 在首帧前写到 <html> 上', async () => {
    const preload = await readFile(join(process.cwd(), 'electron/preload/index.ts'), 'utf-8')
    const entry = await readFile(join(process.cwd(), 'src/main.tsx'), 'utf-8')
    const types = await readFile(join(process.cwd(), 'electron/preload/index.d.ts'), 'utf-8')
    expect(preload).toMatch(/platform:\s*process\.platform/)
    expect(types).toMatch(/platform:\s*string/)
    expect(entry).toMatch(/document\.documentElement\.dataset\.platform\s*=\s*window\.electronAPI\?\.platform/)
  })
})
