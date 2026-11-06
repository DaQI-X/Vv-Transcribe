/**
 * 讯飞「录音文件转写大模型版」适配层（#343）。
 *
 * 这一家手上没有凭据，一次真请求都没发过（沿用 #224 那条拍板：先照原厂规范设计好）。
 * 所以这里钉的全是**文档自己给出的形状**，钉它的意义在于「等有 Key 那天，失败一定是凭据或
 * 网络的问题，而不是我们把签名算歪了」：
 * - 签名的待签串：参数排序、Java 那套编码、空值剔除，逐条写死在这里，
 *   HMAC 本身用 node:crypto 在测试里独立算一遍（不拿实现的输出当实现的期望）。
 * - 上传与查询两趟参数的差异：`appId` 只有上传有、`dateTime` 每趟重生、`signatureRandom` 沿用。
 * - 结果解析对着 `tests/fixtures/iflytekOrderResult.json`——那是文档里那份完成态响应的原样，
 *   五段的文字、起止秒（毫秒转秒）、以及「顺滑词 s 与分段标记 g 要剔掉」都由它钉住。
 * - 报错里不许带出查询串：`accessKeyId` 就是用户那把 APIKey，而 `logRedact` 认的是键名不是值。
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IFLYTEK_API_BASE_EXAMPLE,
  IFLYTEK_FAIL_SILENT,
  IFLYTEK_ORDER_DONE,
  IFLYTEK_ORDER_FAILED,
  IFLYTEK_PROBE_DEADLINE_MS,
  buildIflytekResult,
  buildIflytekUpload,
  iflytekDateTime,
  iflytekErrorMessage,
  iflytekFailTypeMessage,
  iflytekSignature,
  iflytekSignatureRandom,
  parseIflytekOrderResult,
  runIflytekOrderFlow,
} from '../electron/main/services/asr/iflytekAsr'
import type { IflytekCredentials } from '../electron/main/services/asr/iflytekAsr'

const BASE = IFLYTEK_API_BASE_EXAMPLE

/** 假凭据。三把都填成一眼认得出的假值，好让「哪一把泄漏到了消息里」这种断言说得清 */
const credentials: IflytekCredentials = {
  appId: 'app-fake-001',
  apiKey: 'key-fake-002',
  apiSecret: 'secret-fake-003',
}

const FIXED_TIME = '2026-11-07T01:02:03+0800'
const FIXED_RANDOM = 'aB3dEfGhIjKlMn0p'

function upload(over: Partial<Parameters<typeof buildIflytekUpload>[0]> = {}) {
  return buildIflytekUpload({
    apiBase: BASE,
    credentials,
    fileName: 'sample.wav',
    fileSize: 123456,
    signatureRandom: FIXED_RANDOM,
    dateTime: FIXED_TIME,
    ...over,
  })
}

function result(over: Partial<Parameters<typeof buildIflytekResult>[0]> = {}) {
  return buildIflytekResult({
    apiBase: BASE,
    credentials,
    orderId: 'order-9',
    signatureRandom: FIXED_RANDOM,
    dateTime: FIXED_TIME,
    ...over,
  })
}

function queryOf(url: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of url.split('?')[1].split('&')) {
    const [key, value] = pair.split('=')
    out[key] = decodeURIComponent(value)
  }
  return out
}

/** 与实现无关地独立算一遍 base64(HMAC-SHA1)：期望值不能从实现里取 */
function hmacSha1Base64(baseString: string, secret: string): string {
  return createHmac('sha1', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(baseString, 'utf8'))
    .digest('base64')
}

/**
 * 独立推一遍本机时区偏移（`GMT+08:00` → `+0800`）。
 * 不从 `getTimezoneOffset` 取：那个符号与文档要的相反，照它写期望就是把实现的坑抄进测试。
 */
function intlOffset(date: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((item) => item.type === 'timeZoneName')?.value
  const body = (part ?? 'GMT').replace('GMT', '')
  // 零偏移在部分 ICU 上就写作 `GMT`，没有 `+00:00` 那一段
  return body ? body.replace(':', '') : '+0000'
}

/**
 * 断言「这一趟必须抛错」，并把那个 Error 交出来。
 *
 * 不用 `.catch((cause) => cause)`：那样类型是 `Error | IflytekFlowResult`，后面读 `.message` 就是红的；
 * 更要紧的是那次拒绝发生在没人接手的那一刻，Node 记一条 unhandled rejection，
 * vitest 会把它报成整份文件的错（用例本身却还是绿的，最容易漏看）。
 * `then` 的两手写法同步挂上接手，返回类型也只剩 Error。
 */
function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('这一趟本该抛错，却正常返回了')
    },
    (cause: unknown) => {
      expect(cause).toBeInstanceOf(Error)
      return cause as Error
    }
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('签名的待签串', () => {
  it('上传那一趟：按参数名排序、空值剔除、Java 那套编码，串本身写死在这里', () => {
    const request = upload()
    // 顺序是 ASCII 自然排序（accessKeyId 在 appId 前，fileName 在 fileSize 前）。
    // 待签的是**编码后**的键值：`dateTime` 里的 `:` 与 `+` 在这一份编码下是 %3A 与 %2B
    // （Java URLEncoder 的口径，与最终 URL 上那份一致），照原样写进待签串就是一条 100009
    const baseString = [
      'accessKeyId=key-fake-002',
      'appId=app-fake-001',
      'dateTime=2026-11-07T01%3A02%3A03%2B0800',
      'durationCheckDisable=true',
      'fileName=sample.wav',
      'fileSize=123456',
      'language=autodialect',
      `signatureRandom=${FIXED_RANDOM}`,
    ].join('&')

    expect(request.headers.signature).toBe(hmacSha1Base64(baseString, credentials.apiSecret))
  })

  it('查询那一趟：没有 appId，多了 orderId 与 resultType', () => {
    const request = result()
    const baseString = [
      'accessKeyId=key-fake-002',
      'dateTime=2026-11-07T01%3A02%3A03%2B0800',
      'orderId=order-9',
      'resultType=transfer',
      `signatureRandom=${FIXED_RANDOM}`,
    ].join('&')

    expect(request.headers.signature).toBe(hmacSha1Base64(baseString, credentials.apiSecret))
    // 两趟参数不同，签名必然不同：相同就说明有一趟没把参数算进去
    expect(request.headers.signature).not.toBe(upload().headers.signature)
  })

  it('文件名里的空格与 ! 走 Java 那套（空格是 +，! 要转义），不是 encodeURIComponent', () => {
    // 这一档唯一带得上这些字符的就是用户自己那份音频的名字。拿错编码不会当场出事，
    // 直到某天文件名里有个空格，才变成一条查不出原因的 100009「签名校验不通过」
    const withSpace = iflytekSignature({ fileName: 'a b!c.wav' }, credentials.apiSecret)
    expect(withSpace).toBe(hmacSha1Base64('fileName=a+b%21c.wav', credentials.apiSecret))
    expect(withSpace).not.toBe(hmacSha1Base64('fileName=a%20b!c.wav', credentials.apiSecret))
  })

  it('空值不参与签名，signature 自己也不参与', () => {
    expect(iflytekSignature({ b: '', a: '1' }, credentials.apiSecret)).toBe(
      hmacSha1Base64('a=1', credentials.apiSecret)
    )
    // 排掉 signature 是文档明写的一步：把它算进去就成了「签名要签自己」，永远对不上
    expect(iflytekSignature({ a: '1', signature: 'whatever' }, credentials.apiSecret)).toBe(
      hmacSha1Base64('a=1', credentials.apiSecret)
    )
  })

  it('APISecret 只用来算 HMAC，从不作为参数发出去', () => {
    for (const url of [upload().url, result().url]) {
      expect(url).not.toContain(credentials.apiSecret)
      expect(queryOf(url).apiSecret).toBeUndefined()
    }
  })
})

describe('两趟请求的形状', () => {
  it('上传：裸字节那条口径（octet-stream），音频不进查询串', () => {
    const request = upload()
    expect(request.url.startsWith(`${BASE}/v2/upload?`)).toBe(true)
    expect(request.headers['Content-Type']).toBe('application/octet-stream')
    const query = queryOf(request.url)
    expect(query).toMatchObject({
      appId: credentials.appId,
      // accessKeyId 就是控制台里那把 APIKey，不是 AppID——名字对不上是这一家最容易填错的一处
      accessKeyId: credentials.apiKey,
      dateTime: FIXED_TIME,
      signatureRandom: FIXED_RANDOM,
      fileSize: '123456',
      fileName: 'sample.wav',
      language: 'autodialect',
      durationCheckDisable: 'true',
    })
    // 我们的时长来自 ffprobe 读容器（估算值），拿它去碰对方那道精确校验，输的是用户一次上传
    expect(query.duration).toBeUndefined()
  })

  it('地址已经写到 /v2/upload 时不再拼第二遍（#332 那条口径对这一家同样成立）', () => {
    const request = upload({ apiBase: `${BASE}/v2/upload` })
    expect(request.url.startsWith(`${BASE}/v2/upload?`)).toBe(true)
    expect(request.url).not.toContain('/v2/upload/v2/upload')
  })

  it('查询：请求头是 JSON，参数表里没有 appId', () => {
    const request = result()
    expect(request.url.startsWith(`${BASE}/v2/getResult?`)).toBe(true)
    expect(request.headers['Content-Type']).toBe('application/json')
    const query = queryOf(request.url)
    expect(query.appId).toBeUndefined()
    expect(query).toMatchObject({
      accessKeyId: credentials.apiKey,
      orderId: 'order-9',
      resultType: 'transfer',
      signatureRandom: FIXED_RANDOM,
    })
  })

  it('dateTime 带本机时区偏移，格式是 yyyy-MM-ddTHH:mm:ss±HHmm', () => {
    const date = new Date(2026, 10, 7, 1, 2, 3)
    expect(iflytekDateTime(date)).toBe(`2026-11-07T01:02:03${intlOffset(date)}`)
    expect(iflytekDateTime(date)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/)
  })

  it('随机串是 16 位字母数字，且每次不一样', () => {
    const seen = new Set(Array.from({ length: 20 }, () => iflytekSignatureRandom()))
    expect(seen.size).toBe(20)
    for (const value of seen) expect(value).toMatch(/^[A-Za-z0-9]{16}$/)
  })

  it('自检的轮询上界远短于真转写：不让人对着弹窗等一小时', () => {
    expect(IFLYTEK_PROBE_DEADLINE_MS).toBe(3 * 60 * 1000)
  })
})

describe('orderResult 解析（对着文档那份完成态示例）', () => {
  const fixture = readFileSync(join(__dirname, 'fixtures/iflytekOrderResult.json'), 'utf-8')

  it('五段的文字与起止秒逐段对上，毫秒转成秒', () => {
    const { segments, hasLattice } = parseIflytekOrderResult(fixture)

    expect(hasLattice).toBe(true)
    expect(segments.map((segment) => segment.text)).toEqual([
      '为',
      '你好｡',
      '舒高生先生是吧?',
      '为｡',
      '听得到吗?一｡',
    ])
    expect(segments.map((segment) => [segment.start, segment.end])).toEqual([
      [0.88, 1.68],
      [2.39, 3.64],
      [5.13, 7.2],
      [7.2, 8.65],
      [9.33, 11.24],
    ])
  })

  it('顺滑词（s）与分段标记（g）剔掉：留着就会多出一个孤零零的「喂」', () => {
    const text = parseIflytekOrderResult(fixture).segments.map((segment) => segment.text).join('')
    // 示例里 s 出现三次（都是「喂」），g 出现一次（w 是空串）
    expect(text).not.toContain('喂')
    expect(text).toBe('为你好｡舒高生先生是吧?为｡听得到吗?一｡')
  })

  it('置信度只取 n 那一类的平均：标点那类恒为 0，算进去会把每段无端压低', () => {
    const { segments } = parseIflytekOrderResult(fixture)
    expect(segments[0].confidence).toBeCloseTo(0.7511, 4)
    // 第二段有 你好(1.0) 与 ｡(0.0)：只取 n 才是 1.0，取了标点就是 0.5
    expect(segments[1].confidence).toBeCloseTo(1, 4)
    expect(segments[2].confidence).toBeCloseTo(
      (0.863 + 1 + 0.2461 + 0.9709 + 1 + 1) / 6,
      4
    )
  })

  it('没有 lattice / 空串：给出「没有分段这一层」，不抛错', () => {
    expect(parseIflytekOrderResult('')).toEqual({ segments: [], hasLattice: false })
    expect(parseIflytekOrderResult('   ')).toEqual({ segments: [], hasLattice: false })
    expect(parseIflytekOrderResult(JSON.stringify({ orderId: 'x' }))).toEqual({
      segments: [],
      hasLattice: false,
    })
  })

  it('少解一层就是空字幕：json_1best 是字符串，不是对象', () => {
    // 这条钉的是「双层字符串化」这件事本身——文档示例里它就是个字符串，
    // 谁把它改成对象读法，症状会是「转写完成、字幕全空」，界面上看不出原因
    const outer = JSON.parse(fixture) as { lattice: Array<{ json_1best: string }> }
    expect(typeof outer.lattice[0].json_1best).toBe('string')
  })
})

describe('错误码与异常状态', () => {
  it('原厂原话照带上，我们只补「改哪一格」', () => {
    const message = iflytekErrorMessage('100009', 'signature check failed')
    expect(message).toContain('100009')
    expect(message).toContain('signature check failed')
    expect(message).toContain('APISecret')
  })

  it('descInfo 是 success 或空时不硬凑一句「对方原话」', () => {
    expect(iflytekErrorMessage('100013', 'success')).not.toContain('对方原话')
    expect(iflytekErrorMessage('100013', '')).not.toContain('对方原话')
    // 表外的码也要能说话，只是没有那句「改哪一格」
    expect(iflytekErrorMessage('999999', '')).toContain('999999')
  })

  it('静音文件是那唯一一个「对我们不是错误」的异常状态', () => {
    expect(IFLYTEK_FAIL_SILENT).toBe(6)
    expect(iflytekFailTypeMessage(6)).toBe('静音文件')
    expect(iflytekFailTypeMessage(4)).toContain('5 小时')
    expect(iflytekFailTypeMessage(123)).toBe('未知的异常状态 123')
  })

  it('订单状态的两个终态', () => {
    expect(IFLYTEK_ORDER_DONE).toBe(4)
    expect(IFLYTEK_ORDER_FAILED).toBe(-1)
  })
})

describe('整条链路（fetch 打桩）', () => {
  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('上传失败：错误码是数字也认，且消息里不带查询串（那里面有用户的 APIKey）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ code: 100003, descInfo: 'dateTime error' }))
    )

    const error = await rejectionOf(runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1, 2, 3]),
    }))

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('100003')
    expect(error.message).toContain('dateTime')
    // 这一支不带地址（对方已经把错误码说清了，地址帮不上忙）。真带地址的那两支
    // （HTTP 非 200、200 但不是 JSON）走 safeUrl 丢掉整个查询串——`accessKeyId` 就在里面，
    // 而 logRedact 拦不住这一处：那张表认的是**键名**，这里泄漏的是值
    expect(error.message).not.toContain(credentials.apiKey)
    expect(error.message).not.toContain('accessKeyId')
  })

  it('HTTP 非 200 时消息里带地址，但查询串整个丢掉（accessKeyId 就在里面）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('gateway said no', { status: 502 }))
    )

    const error = await rejectionOf(runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1]),
    }))

    expect(error.message).toContain('502')
    expect(error.message).toContain(`${BASE}/v2/upload`)
    expect(error.message).toContain('gateway said no')
    expect(error.message).not.toContain(credentials.apiKey)
    expect(error.message).not.toContain(credentials.appId)
    expect(error.message).not.toContain('accessKeyId')
    expect(error.message).not.toContain('?')
  })

  it('HTTP 200 但响应体不是 JSON：说清是地址填错了层级，而不是当成一次空响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>404</html>', { status: 200 })))

    const error = await rejectionOf(runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1]),
    }))

    expect(error.message).toContain('不是 JSON')
    expect(error.message).toContain('填错了层级')
    expect(error.message).not.toContain(credentials.apiKey)
  })

  it('收下了却没回订单号：不静默当成功，把对方那段 content 念出来', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: '000000', content: {} })))

    const error = await rejectionOf(runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1]),
    }))

    expect(error.message).toContain('没有回订单号')
  })

  it('上传换订单号，轮询到 status 4 才解析结果；查询沿用同一个随机串', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('/v2/upload')) return json({ code: '000000', content: { orderId: 'order-9' } })
      return json({
        code: '000000',
        content: {
          orderInfo: { orderId: 'order-9', status: IFLYTEK_ORDER_DONE, originalDuration: 11240 },
          orderResult: readFileSync(join(__dirname, 'fixtures/iflytekOrderResult.json'), 'utf-8'),
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const orders: Array<{ orderId: string; polls: number; status: number }> = []

    const flow = runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1, 2, 3, 4]),
      onOrder: (info) => orders.push(info),
    })
    // 轮询之间那一段等待：第一次也等（刚上传完立刻去查必然还是「已创建」，那一趟白花）
    await vi.advanceTimersByTimeAsync(3000)
    const done = await flow

    expect(calls).toHaveLength(2)
    expect(calls[0].startsWith(`${BASE}/v2/upload?`)).toBe(true)
    expect(calls[1].startsWith(`${BASE}/v2/getResult?`)).toBe(true)
    expect(queryOf(calls[1]).signatureRandom).toBe(queryOf(calls[0]).signatureRandom)
    // 上传那趟带 appId，查询那趟不带（文档两张参数表的差异）
    expect(queryOf(calls[0]).appId).toBe(credentials.appId)
    expect(queryOf(calls[1]).appId).toBeUndefined()

    expect(done.orderId).toBe('order-9')
    expect(done.completed).toBe(true)
    expect(done.polls).toBe(1)
    expect(done.failType).toBe(0)
    expect(done.duration).toBeCloseTo(11.24, 2)
    expect(done.hasSegments).toBe(true)
    expect(done.segments).toHaveLength(5)
    expect(done.text).toBe('为你好｡舒高生先生是吧?为｡听得到吗?一｡')
    // 界面那句「已提交，等对方出结果」靠这一串回调：拿到订单号一次、每轮询一次各一声
    expect(orders.map((item) => item.polls)).toEqual([0, 1])
  })

  it('到上界仍在处理中：不抛错，把订单号交出去（用户还能自己拿它去查）', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v2/upload')) return json({ code: '000000', content: { orderId: 'order-9' } })
      return json({ code: '000000', content: { orderInfo: { status: 2 } } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const flow = runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1]),
      deadlineMs: 1,
    })
    await vi.advanceTimersByTimeAsync(3000)
    const done = await flow

    expect(done.completed).toBe(false)
    expect(done.orderId).toBe('order-9')
    expect(done.segments).toEqual([])
    expect(done.polls).toBe(1)
  })

  it('status -1（失败）也算终态：停下来交给调用方按 failType 说话', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v2/upload')) return json({ code: '000000', content: { orderId: 'order-9' } })
      return json({
        code: '000000',
        content: { orderInfo: { status: IFLYTEK_ORDER_FAILED, failType: 4 } },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const flow = runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1]),
    })
    await vi.advanceTimersByTimeAsync(3000)
    const done = await flow

    expect(done.completed).toBe(false)
    expect(done.failType).toBe(4)
    expect(iflytekFailTypeMessage(done.failType)).toContain('5 小时')
  })

  it('取消时提前醒过来，但不自己抛错：让下一趟 fetch 抛出与其余网络调用相同的 AbortError', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v2/upload')) return json({ code: '000000', content: { orderId: 'order-9' } })
      if (controller.signal.aborted) throw abort
      return json({ code: '000000', content: { orderInfo: { status: 2 } } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const flow = runIflytekOrderFlow({
      apiBase: BASE,
      credentials,
      fileName: 'sample.wav',
      audio: new Uint8Array([1]),
      signal: controller.signal,
      deadlineMs: 60_000,
    })
    // 先挂上接手的那一手，再点取消（rejectionOf 同步挂，见它那段）
    const settled = rejectionOf(flow)
    // 在那 3 秒等待里点取消：等待立刻结束，不用熬满
    controller.abort()
    await vi.advanceTimersByTimeAsync(10)
    const error = await settled

    expect(error).toBe(abort)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
