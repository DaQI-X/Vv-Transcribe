/**
 * 日志脱敏这一道闸门（#281）。
 *
 * 「日志不带原文」原先写在调用点上——十几处各自记得 `basename(filePath)`，剩下的照抄原样进盘：
 * 本机 app.log 实测有 ffprobe 的整段版本横幅、`/nonexistent/x.mp3` 全路径、
 * `file:///Users/<用户名>/…/index.js:204` 这种带目录的栈帧。这一层把规矩从措辞变成机制，
 * 所以每条用例都在问两件事：**该隐的隐没隐、该留的有没有被一起隐掉**
 * （日志的唯一用途是用户发回来后能定位问题，隐过头等于白记）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_ARRAY_ITEMS,
  MAX_STRING,
  clampText,
  redactEntry,
  redactText,
  redactValue,
} from '../electron/main/services/logRedact'

describe('按键名隐去：凭据与用户原文', () => {
  it('三把 Key 无论叫什么名字都只留尺寸，模型名照留', () => {
    const out = redactValue({ asrApiKey: 'sk-abcdef123456', model: 'gpt-4o-mini' }) as Record<string, string>
    expect(out.model).toBe('gpt-4o-mini')
    expect(out.asrApiKey).toContain('已隐去')
    expect(out.asrApiKey).toContain('15 字符')
    expect(JSON.stringify(out)).not.toContain('sk-abcdef')
  })

  it('api_key / X-API-Key / Ocp-Apim-Subscription-Key 归一到同一条规则', () => {
    for (const key of [
      'api_key',
      'X-API-Key',
      'Ocp-Apim-Subscription-Key',
      'ocpApSubscriptionKey',
      'access_key_secret',
      'accessToken',
      'password',
      'cookie',
    ]) {
      const out = redactValue({ [key]: 'SUPERSECRETVALUE' }) as Record<string, string>
      expect(out[key], key).toContain('已隐去')
    }
    // 调试要用的数字不能被这条规则顺手带走
    const keep = redactValue({ keyEncryptionAvailable: false, asrKeyStatus: 'plain' }) as Record<string, unknown>
    expect(keep.keyEncryptionAvailable).toBe(false)
    expect(keep.asrKeyStatus).toBe('plain')
  })

  it('装原文的字段隐掉，派生出来的长度留着——不然查不出「接口返回了 0 字节」', () => {
    const out = redactValue({
      text: '嘉宾甲：今天我们来聊聊这个选题',
      content: '整份文稿',
      contentLength: 2145,
      textLength: 12,
      diffCount: 3,
    }) as Record<string, unknown>
    expect(out.text).toContain('已隐去')
    expect(out.content).toContain('已隐去')
    expect(out.contentLength).toBe(2145)
    expect(out.textLength).toBe(12)
    expect(out.diffCount).toBe(3)
  })

  it('段落数组只收掉里面的 text，时间轴照留', () => {
    const out = redactValue([
      { id: 'seg-3', start: 12.4, end: 15.8, text: '这句是用户的原话' },
    ]) as Array<Record<string, unknown>>
    expect(out[0].id).toBe('seg-3')
    expect(out[0].start).toBe(12.4)
    expect(out[0].end).toBe(15.8)
    expect(out[0].text).toContain('已隐去')
  })

  it('校对差异的 original / corrected / context 都是文稿片段，一起收', () => {
    const out = redactValue({ differences: [{ original: '其她', corrected: '其他', context: '前面一句' }] }) as {
      differences: Array<Record<string, unknown>>
    }
    const one = out.differences[0]
    expect(one.original).toContain('已隐去')
    expect(one.corrected).toContain('已隐去')
    expect(one.context).toContain('已隐去')
  })
})

describe('按形状改写：裸在文本里的凭据、内嵌音频、绝对路径', () => {
  it('sk- 开头与 Bearer 后面那一串都打码', () => {
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(
      'Authorization: Bearer ****'
    )
    expect(redactText('请求头 bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 已带上')).toBe(
      '请求头 bearer **** 已带上'
    )
    expect(redactText('接口拒绝了 sk-proj-ABCDEFG123456789abcdefghij')).not.toContain('ABCDEFG')
    expect(redactText('请求参数 api_key=ABCDEFGHIJ1234567890 有误')).toBe('请求参数 api_key=**** 有误')
  })

  it('带签名参数的 URL 只收查询串，主机与路径留着', () => {
    const out = redactText('https://cdn.example.com/media/a.mp3?X-Amz-Signature=deadbeef12&Expires=1790000000')
    expect(out).toContain('https://cdn.example.com/media/a.mp3')
    expect(out).toContain('查询参数已隐去')
    expect(out).not.toContain('deadbeef12')
  })

  it('公开接口路径不误伤：/v1/chat/completions 与本机端口都原样', () => {
    expect(redactText('POST http://localhost:5173/#/transcribe')).toBe('POST http://localhost:5173/#/transcribe')
    expect(redactText('调用 https://api.openai.com/v1/chat/completions 失败')).toContain('/v1/chat/completions')
    expect(redactText('127.0.0.1:8010/v1/models 没应答')).toContain('/v1/models')
  })

  it('data URI 内嵌音频整段换掉（配音失败时最容易顺手进日志的就是它）', () => {
    const uri = `data:audio/mpeg;base64,${'SUQzBAAAAAAAU1VD'.repeat(30)}`
    const out = redactText(`响应体：${uri}`)
    expect(out).toContain('data 内嵌内容已隐去')
    expect(out).not.toContain('SUQzBAAAAAAAU1VD')
  })

  it('macOS / Linux 绝对路径收成 basename，行号留着', () => {
    expect(
      redactText('stat \'/Users/daqi/Dq_files/Project/front_project/basic_one/test.mp3\' 失败')
    ).toBe('stat \'test.mp3\' 失败')
    expect(redactText('at file:///Users/daqi/x/dist-electron/main/index.js:204:73')).toBe('at index.js:204:73')
    expect(redactText('/nonexistent/x.mp3: No such file or directory')).toContain('x.mp3')
    expect(redactText('/nonexistent/x.mp3: No such file or directory')).not.toContain('/nonexistent')
  })

  it('Windows 路径同样收成 basename', () => {
    expect(redactText('保存到 C:\\Users\\daqi\\Movies\\采访第3期.mp4 完成')).toContain('采访第3期.mp4')
    expect(redactText('保存到 C:\\Users\\daqi\\Movies\\采访第3期.mp4 完成')).not.toContain('C:\\Users')
  })

  /**
   * 中文文件名是这个应用的常态而不是边角：段内字符类当时写成 `[A-Za-z0-9]`，
   * `/Users/daqi/Movies/采访第3期.mp3` 只匹配到 Movies 为止，盘上写的是 `Movies/采访第3期.mp3`——
   * 用户名收了，父目录名跟文件名粘着，看着像条相对路径，是最难发现的一种漏。
   * 所以这几条都钉成「整行等于 basename」，留一个字节的目录名都算没修。
   */
  it('中文与全角文件名的绝对路径也收成 basename', () => {
    expect(redactText('/Users/daqi/Movies/采访第3期.mp3: No such file')).toBe(
      '采访第3期.mp3: No such file'
    )
    expect(redactText('/Users/daqi/文稿/第2期-嘉宾甲.txt')).toBe('第2期-嘉宾甲.txt')
    expect(redactText('D:\\素材\\2026选题\\嘉宾甲.mp3')).toBe('嘉宾甲.mp3')
  })

  it('ffprobe 那种多行横幅：路径收掉、尾部那句决定性的话不能因为截断而丢', () => {
    const banner = [
      '无法读取文件信息: ffprobe exited with code 1',
      'ffprobe version n4.4.1 Copyright (c) 2007-2021 the FFmpeg developers',
      '  built with Apple clang version 13.0.0 (clang-1300.0.29.30)',
      '  configuration: --prefix=/Applications/Vv.app/Contents/Resources/ffmpeg --enable-gpl',
      '  libavutil      56. 70.100 / 56. 70.100',
      '  libavcodec     58.134.100 / 58.134.100',
      '  libavformat    58. 76.100 / 58. 76.100',
      '  libavdevice    58. 13.100 / 58. 13.100',
      '  libavfilter    7.110.100 /  7.110.100',
      '  libswscale      5.  9.100 /  5.  9.100',
      '  libswresample   3.  9.100 /  3.  9.100',
      '  libpostproc    55.  9.100 / 55.  9.100',
      '/Users/daqi/Movies/x.mp3: No such file or directory',
    ].join('\n')
    const out = clampText(redactText(banner))
    expect(out).toContain('No such file or directory')
    expect(out).not.toContain('/Users/daqi')
    expect(out).not.toContain('/Applications/Vv.app')
    expect(out).toContain('中间省略')
    expect(out.length).toBeLessThanOrEqual(MAX_STRING + 40)
  })
})

describe('按尺寸收口：一条记录不许把整份日志顶爆', () => {
  it('超长文本两头各留一半，中间标出省略了多少', () => {
    const long = `头${'中'.repeat(1000)}尾`
    const out = clampText(long)
    expect(out.startsWith('头')).toBe(true)
    expect(out.endsWith('尾')).toBe(true)
    expect(out).toContain(`共 ${long.length}`)
    expect(out.length).toBeLessThan(long.length)
  })

  it('不超过上限的原文一个字都不动（截断不是默认行为）', () => {
    const s = '一段刚刚好的失败原因'
    expect(clampText(s)).toBe(s)
  })

  it('数组只留前 20 条，但报出总条数——少一条解释就是界面按下标取不到', () => {
    const out = redactValue(Array.from({ length: MAX_ARRAY_ITEMS + 5 }, (_, i) => i)) as unknown[]
    expect(out).toHaveLength(MAX_ARRAY_ITEMS + 1)
    expect(String(out[MAX_ARRAY_ITEMS])).toContain('共 25 条')
  })

  it('深层嵌套砍在第六层，不是一路递归到栈溢出', () => {
    let node: Record<string, unknown> = { level: 0 }
    for (let i = 1; i < 12; i++) node = { child: node, level: i }
    const json = JSON.stringify(redactValue(node))
    expect(json).toContain('已截断')
    expect(json.length).toBeLessThan(2000)
  })

  it('循环引用回一个标记，不把进程搭进去', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(JSON.stringify(redactValue(a))).toContain('循环引用')
  })

  it('Buffer 与 TypedArray 报字节数，不报内容', () => {
    const out = redactValue({ clip: Buffer.alloc(4096), view: new Uint8Array(128) }) as Record<string, string>
    expect(out.clip).toBe('[二进制 4096 字节]')
    expect(out.view).toBe('[二进制 128 字节]')
  })

  it('Error 对象收成 message 与 stack 两个字段（直接 stringify 会得到一个空对象）', () => {
    const err = new Error('读不出这个文件')
    err.stack = `Error: 读不出这个文件\n    at /Users/daqi/proj/main/index.js:1:1`
    const out = redactValue(err) as Record<string, string>
    expect(out.message).toBe('读不出这个文件')
    expect(out.stack).toContain('index.js:1:1')
    expect(out.stack).not.toContain('/Users/daqi')
  })

  it('Date 走 ISO，数字与布尔原样，函数与符号留个名字', () => {
    const stamp = new Date('2026-10-30T09:41:35.148Z')
    const out = redactValue({
      when: stamp,
      size: 12,
      ok: true,
      missing: null,
      cb: function handler() {},
      tag: Symbol('sym'),
    }) as Record<string, unknown>
    expect(out.when).toBe('2026-10-30T09:41:35.148Z')
    expect(out.size).toBe(12)
    expect(out.ok).toBe(true)
    expect(out.missing).toBeNull()
    expect(out.cb).toBe('[函数 handler]')
    expect(out.tag).toBe('[符号 sym]')
  })
})

describe('redactEntry：一条记录进闸门前后', () => {
  it('message 与 data 都过，返回值仍是能被 JSON.stringify 的结构', () => {
    const entry = redactEntry('打开 /Users/daqi/Movies/x.mp4 失败', { apiKey: 'AKIAIOSFODNN7EXAMPLE', code: 5 })
    const json = JSON.stringify(entry)
    expect(json).not.toContain('/Users/daqi')
    expect(json).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(entry.data).toEqual({ apiKey: expect.any(String), code: 5 })
    expect(entry.message).toContain('x.mp4')
  })

  it('data 是裸字符串时也收得住（sidecar 每行输出就是这么进来的）', () => {
    const entry = redactEntry('LocalTTS', '/opt/homebrew/bin/yt-dlp 起不来')
    expect(entry.data).toBe('yt-dlp 起不来')
  })
})

describe('判据：写日志文件只有 logger 这一处', () => {
  async function collectTs(dir: string): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await collectTs(path)))
      else if (entry.name.endsWith('.ts')) out.push(path)
    }
    return out
  }

  it('appendFile / appendFileSync 只存在于 logger.ts', async () => {
    const files = await collectTs(join(process.cwd(), 'electron'))
    const holders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf-8')
      if (/appendFileSync?\(/.test(source)) holders.push(file.replace(`${process.cwd()}/`, ''))
    }
    expect(holders).toEqual(['electron/main/services/logger.ts'])
  })

  /**
   * 这一条不是「证明有 bug」，是把规矩钉在文件里：#281 之前「日志不带全路径」靠十几处各自记得，
   * 谁都能在别处再开一个写日志的口，那这道闸门就成了摆设。所以判据按「文件名 + 写入 API」两头查。
   */
  it('日志文件名 app.log 只出现在 logger.ts 的路径拼装里', async () => {
    const files = await collectTs(join(process.cwd(), 'electron'))
    const holders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf-8')
      // 只认「被引号包住的那个文件名」；注释和给用户的提示语里提到 app.log 不算
      if (/['"`]app\.log['"`]/.test(source)) holders.push(file.replace(`${process.cwd()}/`, ''))
    }
    expect(holders).toEqual(['electron/main/services/logger.ts'])
  })
})
