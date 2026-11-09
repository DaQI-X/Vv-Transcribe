/**
 * 配音（TTS）服务
 *
 * 只做一件事：把一段文本换成一条音频落盘，并带回它的时长。换的方式有两档，
 * 对上层（ttsHandlers、配音页）是同一个契约 `{ filePath, bytes, duration }`：
 * - 云端档（默认）：打用户在「配音方案」里配好的那家网关。请求长什么样、音频在响应里怎么编码，
 *   由方案上那个厂商书签决定（1.1.1，见 ttsVendor）；不选就是 OpenAI 兼容的 `/v1/audio/speech`。
 * - 本地档：本机 sidecar（见 localTtsEngine），不花钱、不联网，回 WAV 并自带精确采样数。
 *
 * 这个时长只给「试听完那句有多长」用；铺轴不认它。云端接口不返回时间信息，而 ffprobe 对 mp3 报的是
 * 按码率估的容器长度（含 LAME 前后填充），实测 0.5 秒的片段会报成 0.549 秒——拼整轨时改用自己的
 * PCM 解码样本数，见 toMeasuredPcm。本地档的 X-Vv-Duration 就是 sidecar 数的采样数，可以直接用，
 * 但「段与段之间怎么顺延」仍然每次都重新解一遍：VITS 同文本同音色连跑时长会抖 ±6%（2026-10-28 本机实测），
 * 没有 seed 可钉，缓存上一次的结论就是把误差累进时间轴。
 *
 * 五条踩过坑的口径写在这里：
 * - 配音的凭据（厂商、接口地址、Key、模型）整套住在「配音方案」里；地址与 Key 留空时沿用校对那套，
 *   但模型**绝不共用**（chat 模型调音频接口会被直接拒）。音色不在方案里（1.1.0 起）：
 *   它是「这一批怎么念」的问题，界面上每次调用可以覆盖，空着就干脆不发这一项。
 * - 这个文件不认得任何一家的响应形状。200 里装 JSON、十六进制音频、签名地址要二次 GET 这些差别
 *   全收在 ttsVendor 里——真实合成和「测试连接」走同一份，分叉过一次就是自检绿了配音挂了。
 * - 花费落在用户自己的 Key 上，所以任何一次调用前都得让他看清要调多少次。
 *   1.1.4 起这条多一个具体形态：逐段循环每段先查片段缓存（ttsClipCache），同一句文本 + 同一套
 *   「怎么念」的参数已经念过一次就直接复用旧音频，改几个字重出一版只花改过那几段的钱。缓存只在
 *   逐段这一条路上生效——试听和「测试连接」照旧真打一次，那两处的用途就是把端点与音色当场验一遍，
 *   缓存下来就等于把自检变成不看对面回什么。命中与否一路传到界面（`TTSClip.reused` → 结果卡那行
 *   「复用 N 段、新合成 M 段」），因为「这一批花没花钱」是用户唯一真正关心的账。
 * - 配置校验必须跟着引擎档分叉：本地档根本没有 Key 和模型，拿云端那三条去问就是把用户拦在门外；
 *   反过来本地档真正会失败的是「音色不是编号」和「组件没下载」。判松判严都栽过（见 #220/#227）。
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { probeFile, resolveFfmpegBinary } from './audioProcessor'
import {
  clipFingerprint,
  clipFormat,
  lookupCachedClip,
  storeClip,
  writeClipMeta,
} from './ttsClipCache'
import { parseLocalTtsSid, synthesizeLocally, type LocalTtsEngineId } from './localTtsEngine'
import {
  buildSpeechRequest,
  buildVoiceCloneRequest,
  buildVoiceCloneUploadRequest,
  buildVoiceListRequest,
  readSpeechAudio,
  readVoiceCloneResult,
  readVoiceCloneUpload,
  readVoiceList,
  ttsVendorCloneSpec,
  ttsVendorClonesVoices,
  ttsVendorListsVoices,
  ttsVendorNeedsModel,
  ttsVendorNeedsVoice,
  voiceCloneProblem,
  TtsVendorError,
  TTS_VENDOR_NAMES,
  type TtsAudioResult,
  type TtsVendorId,
  type VendorVoice,
} from './ttsVendor'

/** 主进程内部用的配音配置：明文 Key，只有主进程拿得到（见 settingsService 的脱敏视图） */
export interface TTSConfig {
  /**
   * 用哪一档。云端档要 Key 和模型两样（音色看不选的那一家），本地档一样都不要——
   * 所以后面那几项的含义是按这一档变的，任何「不分档就取值」的写法都会把另一档的配置要求强加过来。
   */
  engine: 'cloud' | 'local'
  /**
   * 云端档走哪一家的接口形状（1.1.1，见 ttsVendor）。它属于「配音方案」那组凭据，
   * 本地档不看这一项。磁盘上没有这一项的旧方案读出来是 `openai`，与 1.1.0 的行为一字不差。
   */
  vendor: TtsVendorId
  apiKey: string
  apiBase: string
  model: string
  /**
   * 配音方案的资源编号（1.1.2，#342 豆包）：豆包拿请求头 `X-Api-Resource-Id` 说「这一版配音服务」，
   * 标准音色与复刻音色是两条不同的编号。其余几家在请求里不看这一项，空串就是不发。
   * 它和 model 都不算密钥，所以走的是与 `ttsModel` 同一套明文配置通道。
   */
  resourceId: string
  /**
   * 云端档是服务商的音色名；本地档是 sid 编号的字符串写法（'0'、'40'）。
   * 云端档里它能不能空由厂商决定：OpenAI 兼容可以（有些模型根本不收这一项），
   * MiniMax、阿里云百炼与豆包必填（拦下的地方是 ttsConfigProblem）。
   */
  voice: string
  /** 本地档用哪个引擎（白名单见 localTtsEngine）；云端档忽略这一项 */
  localEngine: LocalTtsEngineId
  /**
   * 倍速。OpenAI 兼容那一档标准写的是 0.25–4.0，MiniMax 与阿里云百炼各自是 0.5–2.0 的浮点，
   * 界面因此只给 0.5–2 这几档（见 VOICE_SPEED_OPTIONS），落在三家都合法的区间里。
   * 不填按 1 处理；1 时干脆不发这一项（各家对未知字段的行为不一致）。
   * 两档都收这个值：本地 sidecar 自己夹到 0.25–4.0，界面与云端语义因此是一套。
   */
  speed?: number
}

/** 单次合成产物：路径给播放器，字节数与时长给时间轴 */
export interface SynthesizedClip {
  filePath: string
  bytes: number
  /**
   * 秒。云端档是 ffprobe 读 mp3 容器，本地档是 sidecar 数的采样数；
   * 读不出来时为 0，调用方必须当成「不知道」而不是「零长度」。
   */
  duration: number
}

/** 一段文本给接口吃一次的上限：接口正常时中文长句也就几秒，60 秒不回就是端点或网络出问题了 */
const SPEECH_TIMEOUT_MS = 60_000

/**
 * 缺哪项说哪项。让请求带着空 model 发出去，用户收到的是一条看不懂的 400，
 * 而真实原因只是「配音模型还没填」。
 *
 * 本地档只问本地档会坏的那件事：它没有 Key、没有模型名、也没有接口地址，
 * 唯一能从云端那档带坏的字段是音色——界面切了引擎，配置里留着的还可能是 `alloy`。
 */
export function ttsConfigProblem(config: TTSConfig): string | null {
  if (config.engine === 'local') {
    if (parseLocalTtsSid(config.voice) === null) {
      return `本地配音的音色要选配音页「音色」里的那一项，当前是「${config.voice || '空'}」。在这一格重选一个编号即可`
    }
    return null
  }
  if (!config.apiKey) return '未配置 API Key，请在「设置 → 配音配置」中填写（留空则沿用校对配置那把）'
  if (ttsVendorNeedsModel(config.vendor) && !config.model) {
    return '未配置配音模型，请在「设置 → 配音配置」里点那一行的「编辑」，在弹窗里填「配音模型」并保存'
  }
  if (ttsVendorNeedsVoice(config.vendor) && !config.voice) {
    // 1.1.0 的口径是「音色不做强校验」，那句只对不收音色的模型成立。MiniMax、阿里云百炼和豆包
    // 把音色列成必填，空着发过去只会得到一句对面的原话（而且多半不说是哪一格），
    // 所以在花钱之前先点名这一格；OpenAI 兼容那档继续留空可跑。
    return `${TTS_VENDOR_NAMES[config.vendor]} 必须有音色才能配音。在配音页的「音色」那一格填一个音色 id（这一家的音色表以对方文档为准）`
  }
  return null
}

/**
 * 日志里「这一趟是谁在念」要按档分叉：本地档没有云端模型名，照抄 `config.model` 只会留下一串
 * `model:""`，而 VITS 和 Kokoro 念出来的东西差别是用户报障时最需要先排掉的一条。引擎只在冷启动
 * 那一条里报档位，热着跑完的一批若不写 localEngine，app.log 里就查无此人。
 *
 * 云端档再带上厂商：模型名是各家自己的那套，日志里 `model:"cosyvoice-v2"` 只有配上 dashscope
 * 才对得上号；而「路径拼错」和「Key 不对」这类失败，先要分清是哪一家的形状才能复盘。
 */
function tierForLog(
  config: TTSConfig
): { engine: 'cloud' | 'local'; vendor?: string; model?: string; localEngine?: string } {
  return config.engine === 'local'
    ? { engine: 'local', localEngine: config.localEngine }
    : { engine: 'cloud', vendor: config.vendor, model: config.model }
}

/** 临时目录名沿用 transcribe- 前缀：1.0.5 起的启动清扫按这个前缀删，崩溃与强杀遗留能被兜住 */
function newTempDir(): string {
  return join(tmpdir(), `transcribe-tts-${randomUUID()}`)
}

/**
 * 上一次试听的目录。只留一个：试听是「听完就换下一个音色」的动作，
 * 攒着一堆历史片段既没人听也占临时盘。新一段开始前先回收上一段。
 */
let lastPreviewDir: string | null = null

async function releasePreviewDir(): Promise<void> {
  if (!lastPreviewDir) return
  const dir = lastPreviewDir
  lastPreviewDir = null
  await rm(dir, { recursive: true, force: true }).catch(() => {
    /* 已经没了或被别的实例占用，交给启动清扫 */
  })
}

/**
 * 把一段文本换成一条音频落盘：云端打用户在设置里配好的接口，本地打本机 sidecar。
 * 两档回同一个形状，所以逐段合成、试听、熔断、取消那套语义不需要知道对面是谁。
 * 抛错即失败，调用方负责把它变成 `{ error }` 回给界面——主进程不跨 IPC 抛（全应用统一口径）。
 */
export async function synthesizeSpeech(
  text: string,
  config: TTSConfig,
  tempDir: string
): Promise<SynthesizedClip> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('这段文本是空的，没什么可以合成的')

  const problem = ttsConfigProblem(config)
  if (problem) throw new Error(problem)

  if (config.engine === 'local') {
    // ttsConfigProblem 已经保证这是个纯数字编号，这里直接交给 sidecar 就行
    return synthesizeLocally(trimmed, config.localEngine, Number(config.voice), config.speed ?? 1, tempDir)
  }

  // 请求长什么样、音频从响应的哪一层里取，全在 ttsVendor 里按厂商分叉；这里只管超时、取消和落盘。
  const request = buildSpeechRequest(config.vendor, {
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    model: config.model,
    voice: config.voice,
    resourceId: config.resourceId,
    speed: config.speed ?? 1,
    text: trimmed,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS)
  let audio: TtsAudioResult
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    // 同一个 signal 递进去：阿里云百炼拿地址要再发一次 GET，取消按钮在最后一跳上也不能失效
    audio = await readSpeechAudio(config.vendor, request, response, controller.signal)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`配音请求 ${SPEECH_TIMEOUT_MS / 1000} 秒没响应，已中断`)
    }
    // 适配层的原话已经是「发生了什么 + 能改哪一格」，再套一层「请求没能发出去」就把它埋了
    if (err instanceof TtsVendorError) throw err
    // fetch 本身抛的是 TypeError（DNS/断网/TLS），原样吐出来用户至少能认出是网络问题
    throw new Error(`配音请求没能发出去：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }

  const bytes = audio.bytes
  if (bytes.length === 0) throw new Error('配音接口返回了 0 字节音频')
  // 服务商报回来的计费口径（百炼按字数）只进日志：界面上那笔账按段数算，两者对不上号
  if (audio.note) logger.debug('TTS', 'vendor returned a billing note', { note: audio.note, ...tierForLog(config) })

  await mkdir(tempDir, { recursive: true })
  const filePath = join(tempDir, `${randomUUID()}.mp3`)
  await writeFile(filePath, bytes)

  let duration = 0
  try {
    duration = (await probeFile(filePath)).duration
  } catch (err) {
    // 时长读不出来不等于合成失败：产物是好的，只是「会不会压到下一段」暂时判断不了
    logger.warn('TTS', 'ffprobe failed on synthesized clip', {
      name: basename(filePath),
      message: err instanceof Error ? err.message : String(err),
    })
  }

  const info = await stat(filePath)
  return { filePath, bytes: info.size, duration }
}

/**
 * 试听一条。批量合成前先听一句，是最便宜的「端点+模型+音色三样都对」的验证——
 * 整条稿子跑到第 20 段才发现音色不对，烧的是用户的钱。
 */
export async function previewSpeech(text: string, config: TTSConfig): Promise<SynthesizedClip> {
  await releasePreviewDir()
  const tempDir = newTempDir()
  lastPreviewDir = tempDir
  const clip = await synthesizeSpeech(text, config, tempDir)
  logger.userAction('TTS preview synthesized', {
    bytes: clip.bytes,
    duration: Number(clip.duration.toFixed(2)),
    ...tierForLog(config),
    voice: config.voice,
  })
  return clip
}

/** 显式释放（配音页点「清空」时）；没留目录时什么都不做 */
export async function releasePreview(): Promise<void> {
  await releasePreviewDir()
}

/**
 * 取音色名单那一次的超时。它只是给输入框补候选，所以比一次合成（60 秒）短得多：
 * 名单取不到就落回手输，让用户为一个可选的便利等一分钟是本末倒置。
 */
const VOICE_LIST_TIMEOUT_MS = 15_000

/**
 * 取「这一把 Key 现在能用哪些音色」（1.1.2 #340）。
 *
 * 只有 MiniMax 一家有这条接口（见 `ttsVendorListsVoices` 那段说明），其余三家在这里就返回空、
 * **不发一个字节**——不是「试了一下没成」，是这一家压根没有可问的地方，界面据此照旧手输。
 * 所以这一条不是配音链路的一部分：它失败时配音照样能跑，调用方也别把它当可用性判据。
 */
export async function listVendorVoices(config: TTSConfig): Promise<VendorVoice[]> {
  if (!ttsVendorListsVoices(config.vendor)) return []
  if (!config.apiKey.trim()) {
    throw new Error(`${TTS_VENDOR_NAMES[config.vendor]} 的音色名单要用配置里那把 Key 才取得到，现在这一格是空的`)
  }
  const request = buildVoiceListRequest(config.vendor, { apiBase: config.apiBase, apiKey: config.apiKey })
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(VOICE_LIST_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`取音色名单 ${VOICE_LIST_TIMEOUT_MS / 1000} 秒没响应，已中断`)
    }
    throw new Error(`取音色名单的请求没能发出去：${err instanceof Error ? err.message : String(err)}`)
  }
  const voices = await readVoiceList(config.vendor, request, response)
  // 名单里是音色 id 与名字，不带 Key；地址只记到域名那层，与其余 TTS 日志同一口径
  logger.info('TTS', 'vendor voice list fetched', { vendor: config.vendor, count: voices.length })
  return voices
}

/**
 * 复刻那两步的超时。比取名单（15 秒）和一次合成（60 秒）都长得多，理由是两个真实代价：
 * 上传那一段音频最大可到 20 MB，而复刻本身是对方在服务端建一把音色，不是当场念一句。
 * 超时短了的症状是「明明能成的复刻被我们掐断」，用户重试一次又要重传一遍音频。
 */
const VOICE_CLONE_TIMEOUT_MS = 120_000

/**
 * 复刻那两步各发一次请求；错误措辞要按「哪一步」分叉，所以这一步的名字由调用方给。
 *
 * 发出去之前先落一行 `clone request sent`：这一条是「到底有没有打到厂商服务器」的唯一判据。
 * 原先这条链路只在成功时留一句 `TTS voice cloned`，失败靠 guard 那条 IPC WARN——两头都不沾的中间态
 * （请求压根没发出去、或者发出后卡在那 120 秒里）在 app.log 上和「没发生」长得一模一样，
 * 2026-11-07 用户报「选完录音没反应」时就只能靠反证推。
 *
 * 地址记成 `host + pathname` 连起来的一个字段，不是 `path: '/v1/files/upload'`：日志出口那道
 * redact 会把斜杠开头的多段字符串当成本机路径收成 basename（logRedact 的 POSIX_PATH），实测落成
 * `path: "upload"`——判据被自家闸门改写了，所以喂给它一个端口/域名挨着斜杠的形状，那条规则刻意放过。
 */
async function cloneFetch(step: string, url: string, init: RequestInit): Promise<Response> {
  const { host, pathname } = new URL(url)
  const endpoint = `${host}${pathname}`
  logger.info('TTS', 'clone request sent', { step, endpoint })
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(VOICE_CLONE_TIMEOUT_MS) })
    logger.info('TTS', 'clone response', { step, endpoint, status: response.status })
    return response
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`${step} ${VOICE_CLONE_TIMEOUT_MS / 1000} 秒没响应，已中断`)
    }
    throw new Error(`${step}的请求没能发出去：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 复刻一次的产物。MiniMax 那一家的 id 是用户自己起的，百炼是对方拼的，两边都从这里拿 */
export interface VoiceCloneResult {
  voiceId: string
}

/**
 * 用一段本机音频在这一家复刻一把音色（1.1.2 #330）。
 *
 * 只有 MiniMax 与百炼收这一件事，另两家在 `ttsVendorClonesVoices` 那段里写清了为什么刻意不接；
 * 这一条因此先拦「这一家能不能」，再拦「这段音频合不合规矩」，两样都在花钱/上传之前。
 *
 * 复刻出来的音色**不落盘**：它是用户账号里的资产，MiniMax 那边能靠 #340 那条列音色接口取回来
 * （标着「自己复刻」），百炼那边照旧手输一次。所以我们不存第二份、也就不存在「存的和账号里的
 * 对不上」这种陈旧态——这也是 #330 当年卡住的那个「音色不落盘」问题在这条链路上不成立的原因。
 *
 * **MiniMax 那条 2026-11-07 用真 Key 在本机跑通过一次复刻**（换 file_id → 建音色 → 回执 id 填回「音色」格），
 * 百炼那条至今没有 Key，形状全部抄自原厂文档，按 #224 的口径先设计上、后验。
 */
export async function cloneVoice(
  config: TTSConfig,
  input: { filePath: string; name: string }
): Promise<VoiceCloneResult> {
  if (config.engine === 'local') {
    throw new Error('本地配音没有「复刻音色」这一说：本机能念的是模型自带的那些编号，换嗓子要换模型档')
  }
  if (!ttsVendorClonesVoices(config.vendor)) {
    throw new Error(`${TTS_VENDOR_NAMES[config.vendor]} 不支持在应用里复刻音色`)
  }
  if (!config.apiKey.trim()) {
    throw new Error(`${TTS_VENDOR_NAMES[config.vendor]} 的复刻要用配音方案里那把 Key，现在这一格是空的`)
  }
  const spec = ttsVendorCloneSpec(config.vendor)
  const fileName = basename(input.filePath)
  let bytes: Buffer
  try {
    bytes = await readFile(input.filePath)
  } catch (err) {
    throw new Error(`这段音频没能读出来（${fileName}）：${err instanceof Error ? err.message : String(err)}`)
  }
  const problem = voiceCloneProblem(config.vendor, { name: input.name, fileName, bytes: bytes.length })
  if (problem) throw new Error(problem)

  const base = { apiBase: config.apiBase, apiKey: config.apiKey }
  let voiceId: string
  if (spec.uploadPath) {
    // 两步的那一家（MiniMax）：先拿 file_id，再把它与自己起的 voice_id 绑起来。
    // 第一步失败就别走第二步——带着一个不存在的 file_id 去复刻，对方回的那句和「音频不合格」长得一样
    const upload = buildVoiceCloneUploadRequest(config.vendor, { ...base, fileName, bytes })
    const uploadResponse = await cloneFetch('上传复刻音频', upload.url, {
      method: 'POST',
      headers: upload.headers,
      body: upload.form,
    })
    const fileId = await readVoiceCloneUpload(config.vendor, upload, uploadResponse)
    const request = buildVoiceCloneRequest(config.vendor, { ...base, name: input.name, model: config.model, fileId })
    const response = await cloneFetch('复刻音色', request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })
    voiceId = await readVoiceCloneResult(config.vendor, request, response, input.name)
  } else {
    // 一步的那一家（百炼）：音频编成 Base64 Data URI 直接进请求体，不需要先传到哪儿
    const request = buildVoiceCloneRequest(config.vendor, {
      ...base,
      name: input.name,
      model: config.model,
      fileName,
      bytes,
    })
    const response = await cloneFetch('复刻音色', request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })
    voiceId = await readVoiceCloneResult(config.vendor, request, response, input.name)
  }
  // 日志只记体积与新音色的 id：那段音频是用户自己的嗓子，一个字节都不该落进 app.log
  logger.userAction('TTS voice cloned', { vendor: config.vendor, bytes: bytes.length, voiceId })
  return { voiceId }
}

/** 渲染层传下来的段落形状：时间轴只有渲染层有，主进程不存第二份（与 proofread:local 同一口径） */
export interface TTSSegmentInput {
  id: string
  /** 秒，浮点（转写段落的时间单位一直是秒） */
  startTime: number
  endTime: number
  text: string
}

export type TTSStage = 'synthesizing' | 'reused' | 'skipped' | 'failed' | 'assembling' | 'done'

/** 进度回传：index/total 是真实段号，不做假百分比 */
export interface TTSProgress {
  jobId: string
  stage: TTSStage
  /** 1 起算的真实段号；0 是「已经发起、第一段还在接口那边」，让渲染层早点拿到 jobId 好放取消 */
  index: number
  total: number
  segmentId?: string
  /** 失败原因，或「这段是空的，没花钱」 */
  note?: string
}

/** 一条成品片段：时间戳留着，铺轴那一步按它决定落在哪 */
export interface TTSClip {
  segmentId: string
  index: number
  startTime: number
  endTime: number
  filePath: string
  bytes: number
  duration: number
  /**
   * 这条是复用缓存里的旧音频（#362），还是这一趟真的调了接口。
   * 它必须一路传到界面：用户判断「这一批有没有再花钱」只看这个数，
   * 而报「配音完成，300 段」掩盖的是其中 297 段其实一分钱没花。
   */
  reused: boolean
}

export interface TTSFailure {
  segmentId: string
  index: number
  error: string
}

export interface TTSBatchResult {
  jobId: string
  tempDir: string
  clips: TTSClip[]
  failures: TTSFailure[]
  /** 空段落：不调接口、不花钱，直接进跳过名单 */
  skipped: string[]
  canceled: boolean
  /** 中途整体停下来的原因（连续失败熔断这类），null 表示没熔断 */
  abortedReason: string | null
}

interface BatchJob {
  id: string
  canceled: boolean
  /**
   * 逐段循环还在跑。批次记录本身要活到用户释放整轨为止（合成完到点「另存」之间
   * 它一直都在表里），所以「有没有在配音」不能拿 map 的大小判，得看这一段。
   * #230 的组件下载/删除与「停止引擎」都按它拒绝：把正在配音的引擎杀掉，剩下的段落全失败。
   */
  running: boolean
  tempDir: string
}

const batchJobs = new Map<string, BatchJob>()

/** 有没有一批配音正在逐段跑。侧栏组件管理与「停止引擎」的前置闸门 */
export function hasActiveTTSSynthesis(): boolean {
  for (const job of batchJobs.values()) {
    if (job.running) return true
  }
  return false
}

/**
 * 连续失败到这个数就整批停。
 * 单段失败继续往下跑是对的（网络抖一下不该作废前面几十段的钱）；但 Key 没权限、
 * 音色名写错这类系统性错误会连着失败几百次，一路跑完等于把用户的额度拿去试错。
 */
const MAX_CONSECUTIVE_FAILURES = 3

/** 一批一个目录：目录名带批次 id，日志与磁盘能一眼对上 */
function newBatchDir(jobId: string): string {
  return join(tmpdir(), `transcribe-tts-${jobId}`)
}

/**
 * 取消请求落在哪一步。
 * 'late' 是「逐段循环已经出界，现在在拼轨」：拼接读的是已经落盘（云端档是已经花过钱）的片段，
 * 停下来等于把那些段白扔了，所以这一步根本没有取消位——以前这里返回 success:true 却什么都不停，
 * 界面写着「正在取消…」而音轨照旧拼完，是谎报。
 */
export type TTSCancelReason = 'stopped' | 'late' | 'gone'

/** 取消：置标志位，循环在每段之间检查（正在飞出去的那一次请求不打断，钱已经花了） */
export function cancelTTSSynthesis(jobId: string): TTSCancelReason {
  const job = batchJobs.get(jobId)
  if (!job) return 'gone'
  if (!job.running) return 'late'
  job.canceled = true
  logger.userAction('TTS batch canceled', { jobId })
  return 'stopped'
}

/**
 * 逐段合成。串行，不并发：
 * 并发对配音没有意义（总调用数一样），但各家网关的 QPS 限制会让并发版本先撞 429，
 * 而且失败重试的归属会糊在一起。慢一点是这条链路本来就有的性质，界面上如实给段号。
 * 本地档串行还有另一个理由：一次推理吃满 4 个线程，并发只会互相抢核，还会把界面拖卡。
 */
export async function synthesizeSegments(
  segments: TTSSegmentInput[],
  config: TTSConfig,
  onProgress: (p: TTSProgress) => void
): Promise<{ job: BatchJob; result: TTSBatchResult }> {
  const problem = ttsConfigProblem(config)
  if (problem) throw new Error(problem)

  const jobId = randomUUID()
  const tempDir = newBatchDir(jobId)
  await mkdir(tempDir, { recursive: true })
  const job: BatchJob = { id: jobId, canceled: false, running: true, tempDir }
  batchJobs.set(jobId, job)

  const total = segments.length
  const clips: TTSClip[] = []
  const failures: TTSFailure[] = []
  const skipped: string[] = []
  let abortedReason: string | null = null
  let consecutiveFailures = 0

  logger.info('TTS', 'Batch started', {
    jobId,
    total,
    ...tierForLog(config),
    voice: config.voice,
  })

  // 先把 jobId 推下去：第一段在慢网里能飞几十秒，界面那时候就已经想给用户一个能按的「取消」了
  onProgress({ jobId, stage: 'synthesizing', index: 0, total })

  for (let i = 0; i < total; i++) {
    const segment = segments[i]
    const index = i + 1

    // 取消只写 canceled 标志：abortedReason 是「熔断原因」，两者混用界面就分不清
    // 是用户自己按了取消，还是连续失败把整批停下来了
    if (job.canceled) break

    if (!segment.text.trim()) {
      skipped.push(segment.id)
      onProgress({ jobId, stage: 'skipped', index, total, segmentId: segment.id, note: '空段落，未调用接口' })
      continue
    }

    // #362：这一句、这一套「怎么念」的参数已经念过一次，就直接用那条旧音频——不再调接口、不再花钱。
    // 作废判据全在 clipFingerprint 里（换厂商/模型/音色/倍速/引擎都换键），这里只管命中与回收。
    const ext = clipFormat(config)
    const fingerprint = clipFingerprint(config, segment.text)
    const cached = await lookupCachedClip(fingerprint, ext)
    if (cached) {
      let duration = cached.meta?.duration ?? 0
      if (!duration) {
        // 时长是 0 有两种：元数据压根没落成，或当年 ffprobe 就没读出来。两种都重探一次——
        // 音频已经在盘上了，探一下比重新花一次接口的钱便宜，而 0 会让界面上那句「有多长」显示成空
        const probed = await probeFile(cached.filePath).catch(() => null)
        duration = probed?.duration ?? 0
        if (duration) await writeClipMeta(fingerprint, { duration, bytes: cached.bytes })
      }
      clips.push({
        segmentId: segment.id,
        index,
        startTime: segment.startTime,
        endTime: segment.endTime,
        filePath: cached.filePath,
        bytes: cached.bytes,
        duration,
        reused: true,
      })
      // 命中**不**重置 consecutiveFailures：重置就会走成「失败一段、命中一段」交替跑完整批，
      // 而每次失败都是真金白银——那正是这个计数器存在的理由。命中也不算失败，所以两个数都不动。
      onProgress({ jobId, stage: 'reused', index, total, segmentId: segment.id })
      continue
    }

    try {
      const clip = await synthesizeSpeech(segment.text, config, tempDir)
      // 收进缓存是把这条音频搬出临时目录，往后拼接读的就是缓存里这一份；
      // 搬不动时 storeClip 原样回临时路径——这一批照旧成，只是下一轮没得复用（缓存永远不该让配音失败）。
      const kept = await storeClip(clip.filePath, fingerprint, ext, {
        duration: clip.duration,
        bytes: clip.bytes,
      })
      clips.push({
        segmentId: segment.id,
        index,
        startTime: segment.startTime,
        endTime: segment.endTime,
        ...clip,
        filePath: kept.filePath,
        bytes: kept.bytes,
        reused: false,
      })
      consecutiveFailures = 0
      onProgress({ jobId, stage: 'synthesizing', index, total, segmentId: segment.id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ segmentId: segment.id, index, error: message })
      consecutiveFailures++
      onProgress({ jobId, stage: 'failed', index, total, segmentId: segment.id, note: message })
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // 这句原来写的是「连续 N 段」——#362 之后缓存命中既不重置也不累加这个计数器，
        // 「连续」就不一定成立了（失败一段、命中一段交替出现也会攒到 3），说「累计」才是真话。
        abortedReason = `累计 ${consecutiveFailures} 段合成失败，已停止整批（最后一条原因：${message}）`
        logger.error('TTS', 'Batch aborted on consecutive failures', { jobId, index, message })
        break
      }
    }
  }

  // 花没花钱是这一批最重要的一件事，日志里必须能直接答出来：只记 clipCount 的话，
  // 下一轮用户报「我明明重新配了一遍怎么还扣钱」就没证据可对。
  const reusedCount = clips.filter((clip) => clip.reused).length
  logger.info('TTS', 'Batch segments finished', {
    jobId,
    total,
    synthesized: clips.length - reusedCount,
    reused: reusedCount,
    failed: failures.length,
    skipped: skipped.length,
  })

  // 逐段循环出界（跑完、被取消、被熔断）就不再占用引擎了。后面的拼接读的是已经落盘的
  // wav，不需要引擎，所以组件下载与「停止引擎」在这一步之后就可以放行。
  job.running = false

  return {
    job,
    result: { jobId, tempDir, clips, failures, skipped, canceled: job.canceled, abortedReason },
  }
}

/** 批次目录的显式回收；启动清扫（transcribe- 前缀 + 24 小时）是兜底，不是主要手段 */
async function releaseBatch(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {
    /* 已经没了，或被用户自己在文件管理器里开着 */
  })
}

/** 拼好的整轨按 jobId 存着，另存与释放都按 id 找主进程自己的记录——渲染层报上来的路径一律不信 */
const voiceTracks = new Map<string, VoiceTrack>()

/** 拼出来的整条配音轨 */
export interface VoiceTrack {
  filePath: string
  bytes: number
  /** 配音轨总时长（ffprobe 实测，秒） */
  duration: number
  /** 因为「配音比字幕槽位长」而被往后推的段数 */
  pushedCount: number
  /** 接口时长没读出来、只能按字幕槽位估算的段数 */
  estimatedCount: number
  /** 原时间轴最后一段的结束点，用来跟 duration 对照（界面要说「比原片长了多少」） */
  originalEnd: number
}

/**
 * 拼一次 ffmpeg 允许挂多少路输入，按命令行的字符数算，不按段数。
 * 真正的上限是操作系统的命令行长度（Windows CreateProcess 数的是 32767 个 UTF-16 字符，
 * macOS 是 1MB 的 ARG_MAX），段数估不准它——路径长短都算在里面。24000 相对 32767 留了约四分之一，
 * 给固定参数、输出路径和转义（300 段实测最长一条命令行 24398 字符）。
 */
const FFMPEG_ARG_BUDGET_CHARS = 24_000

/** 间隙小于这么多样本（约 0.2 ms）就不垫静音了：为几微秒生成一路静音不值得 */
const MIN_SILENCE_SAMPLES = 10

interface Placement {
  clip: TTSClip
  placedAt: number
  /** 这一段在时间轴上占多长（解码出来是 0 个采样时按字幕槽位估） */
  length: number
  pushed: boolean
  estimated: boolean
}

/**
 * 顺延排布：每段落点 = max(自己的 startTime, 上一段的结束点)。
 * 于是永不重叠、顺序不变，代价是整条可能比原视频长——这是拍板选的策略，
 * 推后了多少段必须原样报给界面，不能让用户以为「时长肯定对得上画面」。
 */
function planPlacements(clips: TTSClip[]): { placements: Placement[]; totalDuration: number } {
  let cursor = 0
  const placements: Placement[] = []
  for (const clip of clips) {
    const estimated = !(clip.duration > 0)
    const length = estimated ? Math.max(0, clip.endTime - clip.startTime) : clip.duration
    const placedAt = Math.max(clip.startTime, cursor)
    placements.push({ clip, placedAt, length, pushed: placedAt - clip.startTime > 0.01, estimated })
    cursor = placedAt + length
  }
  return { placements, totalDuration: cursor }
}

/** 铺轴的最小单位：一路配音 + 它前面该有的静音垫（垫按样本数记，秒只是换算出来的显示值） */
interface TimelineUnit {
  filePath: string
  /** 这一路 `-i 路径` 在命令行上占的字符数 */
  argChars: number
  silenceSamples: number
}

/**
 * 把排布结果摊成「静音、配音、静音、配音……」的串联序列。
 * 排布本身保证不重叠，所以串联就是精确语义——不能用 amix：包进安装包的
 * win32-x64 / darwin-x64 那两个 ffmpeg 是 2018-12 的构建，`adelay` 还没有 all 选项、
 * `amix` 还没有 normalize（关掉之前是硬按 1/N 衰减），那张图在两个平台上直接退码 1。
 */
function buildTimelineUnits(placements: Placement[]): TimelineUnit[] {
  const units: TimelineUnit[] = []
  let consumed = 0
  for (const placement of placements) {
    units.push({
      filePath: placement.clip.filePath,
      argChars: placement.clip.filePath.length + 4,
      silenceSamples: Math.max(0, Math.round((placement.placedAt - consumed) * PCM_SAMPLE_RATE)),
    })
    consumed = placement.placedAt + placement.length
  }
  return units
}

/** 按命令行字符预算切块；静音垫跟着它后面那一路走，不会被切到上一块末尾 */
function packChunks(units: TimelineUnit[]): TimelineUnit[][] {
  const chunks: TimelineUnit[][] = []
  let current: TimelineUnit[] = []
  let chars = 0
  for (const unit of units) {
    if (current.length > 0 && chars + unit.argChars > FFMPEG_ARG_BUDGET_CHARS) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(unit)
    chars += unit.argChars
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** 直接 spawn：几百路输入 + 复杂图，fluent-ffmpeg 的链式写法接不住这个形状 */
function runFfmpeg(args: string[]): Promise<void> {
  const bin = resolveFfmpegBinary()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('error', (err) => reject(new Error(`没能启动 ffmpeg：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`配音轨拼接失败（ffmpeg 退出码 ${code}）：${stderr.trim().slice(-300) || '没有任何输出'}`))
    })
  })
}

/** 拼轨统一的音频参数：44.1k 单声道 s16，concat 只认同一种参数 */
const PCM_SAMPLE_RATE = 44100
const PCM_CHAIN = `aformat=sample_rates=${PCM_SAMPLE_RATE}:channel_layouts=mono:sample_fmts=s16`

/**
 * 渲染一块的 filtergraph。静音走图内的 anullsrc（不占命令行输入，命令行里就只剩每段一个 `-i 路径`），
 * 配音直接取 `[i:a]`（进来了就已经是统一参数的 PCM）。只有一路时不用 concat，anull 直送到 [out]。
 */
function renderChunkGraph(units: TimelineUnit[], outLabel: string): string {
  const lines: string[] = []
  const labels: string[] = []
  units.forEach((unit, i) => {
    if (unit.silenceSamples >= MIN_SILENCE_SAMPLES) {
      const label = `[s${labels.length}]`
      // 按样本数换算成秒（6 位小数），误差 ≤1 个样本；直接写秒会把毫秒级的抖动累到整条上
      lines.push(
        `anullsrc=r=${PCM_SAMPLE_RATE}:cl=mono,atrim=end=${(unit.silenceSamples / PCM_SAMPLE_RATE).toFixed(6)},${PCM_CHAIN}${label}`
      )
      labels.push(label)
    }
    const label = `[c${i}]`
    lines.push(`[${i}:a]${PCM_CHAIN}${label}`)
    labels.push(label)
  })
  const joined = labels.join('')
  lines.push(
    labels.length === 1 ? `${joined}anull${outLabel}` : `${joined}concat=n=${labels.length}:v=0:a=1${outLabel}`
  )
  return lines.join(';\n')
}

/** 跑一块：几百路的图写进文件用 -filter_complex_script 交给它，命令行只背输入清单 */
async function runFfmpegChunk(
  units: TimelineUnit[],
  tempDir: string,
  graphName: string,
  outputPath: string,
  encodeArgs: string[]
): Promise<void> {
  const args: string[] = []
  for (const unit of units) args.push('-i', unit.filePath)
  const graphPath = join(tempDir, graphName)
  await writeFile(graphPath, renderChunkGraph(units, '[out]'))
  await runFfmpeg([...args, '-filter_complex_script', graphPath, '-map', '[out]', ...encodeArgs, outputPath])
}

/** 从 WAV 里读 data 块的字节数，换算成精确秒数——不经过 ffprobe 的容器估算 */
function pcmSeconds(wav: Buffer): number {
  let offset = 12 // 跳过 RIFF/WAVE 与第一个 fmt 块头
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return Math.floor(size / 2) / PCM_SAMPLE_RATE
    offset += 8 + size + (size % 2)
  }
  return 0
}

/**
 * 一段配音解成统一参数的 PCM，并用解出来的样本数当它的时长。
 * 为什么不能用 ffprobe 报的 mp3 时长：那是按码率估的容器长度，含 LAME 的前后填充，解码时会被丢掉
 * ——实测 0.5 秒的片段报成 0.549 秒。每段的落点都是从上一段的长度推出来的，这几十毫秒会一段一段
 * 累起来（300 段就是十几秒），所以铺轴用的时长必须自己数解码出来的采样。
 */
async function toMeasuredPcm(clip: TTSClip, index: number, tempDir: string): Promise<TTSClip> {
  const wavPath = join(tempDir, `voice-pcm-${String(index).padStart(4, '0')}.wav`)
  await runFfmpeg([
    '-i',
    clip.filePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(PCM_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    wavPath,
  ])
  return { ...clip, filePath: wavPath, duration: pcmSeconds(await readFile(wavPath)) }
}

/**
 * 把逐段成品拼成一条对齐时间轴的配音轨。
 * 每段先归一到 44.1k 单声道 PCM，再按时轴垫静音串起来，整条只在最后重编码一次 mp3
 * （剪辑软件都吃，也不会 mp3 → mp3 来回掉质量）。
 * 超出命令行字符预算时先分块落无损 WAV、最后只把块串起来——多一道无损封装，不多一次有损转码。
 */
async function assembleVoiceTrack(clips: TTSClip[], tempDir: string): Promise<VoiceTrack> {
  if (clips.length === 0) throw new Error('一段都没合成成功，没有可以拼起来的音频')

  const measured: TTSClip[] = []
  for (let index = 0; index < clips.length; index++) {
    measured.push(await toMeasuredPcm(clips[index], index, tempDir))
  }

  const { placements, totalDuration } = planPlacements(measured)
  const chunks = packChunks(buildTimelineUnits(placements))
  const filePath = join(tempDir, 'voice-track.mp3')
  const mp3Args = ['-c:a', 'libmp3lame', '-b:a', '192k']

  if (chunks.length === 1) {
    await runFfmpegChunk(chunks[0], tempDir, 'filtergraph.txt', filePath, mp3Args)
  } else {
    const chunkWavs: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const wavPath = join(tempDir, `voice-chunk-${String(i).padStart(3, '0')}.wav`)
      await runFfmpegChunk(chunks[i], tempDir, `filtergraph-${i}.txt`, wavPath, ['-c:a', 'pcm_s16le'])
      chunkWavs.push(wavPath)
    }
    await runFfmpegChunk(
      chunkWavs.map((wav) => ({ filePath: wav, argChars: wav.length + 4, silenceSamples: 0 })),
      tempDir,
      'filtergraph-final.txt',
      filePath,
      mp3Args
    )
  }

  const { duration } = await probeFile(filePath)
  const info = await stat(filePath)
  const originalEnd = placements.reduce((max, p) => Math.max(max, p.clip.endTime), 0)
  const pushedCount = placements.filter((p) => p.pushed).length
  const estimatedCount = placements.filter((p) => p.estimated).length

  logger.info('TTS', 'Voice track assembled', {
    segments: placements.length,
    chunks: chunks.length,
    pushedCount,
    estimatedCount,
    trackDuration: Number(duration.toFixed(2)),
    originalEnd: Number(originalEnd.toFixed(2)),
    bytes: info.size,
  })

  // totalDuration 是排布算出来的期望值，只用于日志对照；对用户报的是 ffprobe 实测
  logger.debug('TTS', 'Planned vs probed duration', {
    planned: Number(totalDuration.toFixed(2)),
    probed: Number(duration.toFixed(2)),
  })

  return {
    filePath,
    bytes: info.size,
    duration,
    pushedCount,
    estimatedCount,
    originalEnd,
  }
}

/**
 * 拼轨并登记。跟 synthesizeSegments 分成两个调用点是因为进度要能单独报「开始拼接」——
 * 几百段的图要跑一阵，界面那时候不能还写着「第 137/137 段」。
 */
export async function composeVoiceTrack(jobId: string, clips: TTSClip[]): Promise<VoiceTrack> {
  const job = batchJobs.get(jobId)
  if (!job) throw new Error('这批配音任务已经不在了，请重新发起')
  const track = await assembleVoiceTrack(clips, job.tempDir)
  voiceTracks.set(jobId, track)
  return track
}

/** 取回某一批的成品轨（回放与另存都走这里） */
export function getVoiceTrack(jobId: string): VoiceTrack | null {
  return voiceTracks.get(jobId) ?? null
}

/**
 * 回收一整批：中间片段是几十到几百个 mp3，加一条成品轨，占的是用户的临时盘。
 * 另存成功、以及用户关掉弹窗都该调它；漏了有 24 小时清扫兜着。
 */
export async function releaseBatchById(jobId: string): Promise<void> {
  voiceTracks.delete(jobId)
  const job = batchJobs.get(jobId)
  if (!job) return
  batchJobs.delete(jobId)
  await releaseBatch(job.tempDir)
}
