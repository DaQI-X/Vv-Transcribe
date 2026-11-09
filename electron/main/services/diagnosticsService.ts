/**
 * 诊断包（#358）
 *
 * 一句话背景：应用零遥测、官网写着「素材不出本机」，所以出问题只能靠用户把现场发回来；
 * 而 `mailto` 带不了附件——今天用户要自己「打开日志文件夹 → 找到 .log → 拖进邮件」，多数人这一步就放弃了。
 * 这一层把那一步换成一次点击：拼一份文本、交给用户当场选位置、随后调起同一封反馈邮件。
 * 它**不新增任何网络出口**（只有 saveDialog + 本地写盘 + mailto），所以上面那句隐私承诺一个字都不用改。
 *
 * 为什么是**一个 .txt**而不是任务范围里写的「文件夹/zip」：
 * - 判据是「能不能一次附件发出去」。文件夹要用户自己压；zip 要引一个压缩依赖，
 *   而仓库在 `componentArchive.ts` 头上写明不装压缩库、也不赌 Windows 系统里有 tar——
 *   为一份文本开那个口子不值当。真正要发的是日志尾部那一两千行，不是 4 × 5MB 的全量。
 * - 一个文件也少一处漏：目录树里每一项都得单独想一遍脱敏，单文件只有「写进去的这一段」。
 *
 * 三条硬约束分别长在哪：
 * 1. **绝不自动上传**：拼 URL 与写盘全在主进程，渲染层传不进任何参数（同 `app:contactDeveloper`）。
 * 2. **不写凭据、文稿原文、绝对路径**：不另立规则，用 #281 那道闸门的同一张表
 *    （`logRedact.isSensitiveKey` + `redactText`）。配置取的是 `getSettingsView()` 那份脱敏视图——
 *    Key 在这条路上压根没解密过，所以「这里忘了跳过某一格」不是靠这份代码记得，而是拿不到。
 *    `asrAppId` 是唯一一把不属于凭据字段、却能指认「账号是哪一位」的值，所以它只报有没有填。
 * 3. **不落进 `transcribe-` 前缀**：那是 `sweepStaleMediaTempDirs` 的清扫靶子，选到那里的话
 *    一份诊断包会在 24 小时后被自己的清理机制删掉，而用户只会以为邮件出问题了。
 *    写盘前查一次，不写在注释里。
 *
 * 日志那一段照抄盘上的行，但每行再过一遍 `redactText` + `clampText`：#281 之前轮转出去的旧档
 * 是闸门之前写的（本机那份 15,946 行的 app.log 里数得出 1,837 处绝对路径），
 * 那些历史残留不能因为「这次没改写」就原样发给任何人。
 */
import { app } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getASRServiceStatus } from './asrServiceManager'
import { engineBinaryInManifest, listComponents, type ComponentState } from './componentService'
import { clampText, isSensitiveKey, redactText } from './logRedact'
import { getSettingsView, listProfiles, type ProfilesView, type SettingsView } from './settingsService'
import { logsDir, userDataRoot } from './userDataStore'
// 体积只有一把尺（#282①）：包里的 KB 要跟「按需组件」那一行念出同一个数
import { formatBytes } from '../../../src/utils/formatBytes'

/**
 * 日志尾取多少行。按 `logger.ts` 那句「均值约 195 字节/行」折算约 230KB——
 * 一封邮件发得动，也够盖住最近几十次操作。省略了多少行要说出来，不能装作这就是全部。
 */
export const LOG_TAIL_LINES = 1200

export interface DiagnosticsSnapshot {
  exportedAt: string
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osVersion: string
  locale: string
  packaged: boolean
  /** userData 的**目录名**，不是路径：「是哪个应用的数据目录」有用，「它装在哪一层」是要隐掉的那部分 */
  dataDirName: string
  settings: SettingsView
  profiles: ProfilesView
  components: ComponentState[]
  engineInManifest: boolean | null
  asrService: { ready: boolean; error: string | null }
  logs: { name: string; bytes: number }[]
  /** 日志尾取自哪一份（app.log 被清空过时会是 app.1.log）；null＝一份都没读到 */
  tailName: string | null
  tail: string[] | null
  tailSkipped: number
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return '（空）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return String(value)
  const text = String(value).trim()
  if (!text) return '（空）'
  // 每段自由文本都要贴一个可指认的标签，否则读的人分不清「没填」和「读不出」
  return clampText(redactText(text))
}

/** 一个 `名字：值` 字段。值为空也要写出来——「没填」本身就是诊断信息 */
function field(label: string, value: unknown): string {
  return `${label}：${showValue(value)}`
}

/**
 * 名字撞上 #281 那张表、值却只是「这把凭据存没存」的状态位。
 * `asrSecretStatus` 归一化后含 `secret`，那道闸门会把它整值隐掉——logRedact 头上
 * 「布尔状态位 hasApiKey」那段说的是同一个坑。而对诊断包来说，「讯飞那把 APISecret 到底存没存」
 * 恰是要回答的问题：隐掉它，包就答不出自己最该答的那一句。
 * 判式只认**字段名尾巴**（Status / Available），不看值——真凭据的字段名都不带这两个尾巴（见 SECRET_FIELDS）。
 */
function isStatusFlag(key: string): boolean {
  return /(status|available)$/i.test(key)
}

/**
 * 配置摘要 = 脱敏视图的**全部**字段。
 * 逐字段点名写死在这里是要分叉的（加一格配置，摘要就少一格，而没人会想起来补），
 * 所以改成「遍历所有键 + 撞上 #281 那张敏感表的键名就整格跳过」：
 * 新加一格凭据或文稿字段时，它自动出现在「跳过」那行里，而不是自动出现在正文里。
 */
function renderSettings(settings: SettingsView): string[] {
  const lines: string[] = ['== 配置摘要（磁盘上已保存的，不含任何凭据）==']
  const skipped: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    if (isSensitiveKey(key) && !isStatusFlag(key)) {
      skipped.push(key)
      continue
    }
    // AppID 指认的是「账号是哪一位」，不是「这一格能不能解密」，所以脱敏视图里留着它、这里只报有没有
    if (key === 'asrAppId') {
      lines.push(field('转写 AppID', typeof value === 'string' && value.trim() ? '已填' : '未填'))
      continue
    }
    lines.push(field(key, value))
  }
  lines.push(
    skipped.length
      ? `（已跳过 ${skipped.length} 格：${skipped.join('、')}——按 #281 那张表，这些键名一律不进包）`
      : '（这次脱敏视图里没有撞上凭据/原文键名的字段）'
  )
  return lines
}

function renderProfiles(profiles: ProfilesView): string[] {
  const lines: string[] = ['== 方案（几套 API 接入）==']
  lines.push(field('每档上限', profiles.maxProfiles))
  for (const [cap, list] of Object.entries(profiles.profiles)) {
    const used = profiles.defaultProfileId[cap as keyof ProfilesView['defaultProfileId']]
    lines.push(`${cap}：${list.length} 套，当前使用 ${showValue(used)}`)
    for (const profile of list) {
      const values: string[] = []
      for (const [key, value] of Object.entries(profile.values)) {
        if (isSensitiveKey(key)) continue
        values.push(`${key}=${showValue(value)}`)
      }
      const secrets = Object.entries(profile.secretStatus)
        .filter(([, status]) => status !== 'none')
        .map(([key, status]) => `${key}:${status}`)
        .join('、')
      lines.push(
        `  - ${profile.id}｜${showValue(profile.name)}｜${values.join('｜')}` +
          `｜Key=${profile.keyStatus}${secrets ? `｜另有的凭据=${secrets}` : ''}`
      )
    }
  }
  // 一套都没有是真状态（1.0.9 之后 0 条合法），界面得能区分「没配」和「读不出」，摘要也要
  return lines
}

function renderComponents(components: ComponentState[], engineInManifest: boolean | null): string[] {
  const lines: string[] = ['== 本机组件 ==']
  if (components.length === 0) {
    lines.push('（一份组件状态都没读到）')
    return lines
  }
  for (const item of components) {
    lines.push(
      `${item.id}｜${showValue(item.title)}｜${item.installed ? '已装' : '未装'}` +
        `｜本机 ${formatBytes(item.bytes)}｜本机版本=${showValue(item.localVersion)}` +
        `｜清单版本=${showValue(item.remoteVersion)}｜建议动作=${item.action}` +
        `｜清单有这条=${showValue(item.inManifest)}`
    )
  }
  lines.push(field('配音引擎在清单里', engineInManifest))
  return lines
}

/**
 * 日志这一段。
 * 正文在这里过闸门，而不是在 `readLogInventory` 里：渲染是包内容的唯一出口，
 * 收在这儿等于「只要进了包就过了一遍」；收在读取处则多一条绕过路径（换一份快照直接渲染就漏了）。
 * #281 之前写下的轮转档正是走这条路进来的，那时还没有这道闸门。
 */
function renderLogs(
  logs: { name: string; bytes: number }[],
  tailName: string | null,
  tail: string[] | null,
  tailSkipped: number
): string[] {
  const lines: string[] = ['== 日志文件（userData/logs 里的那几份）==']
  if (logs.length === 0) {
    lines.push('（这一层没读到任何 app*.log）')
  } else {
    for (const item of logs) {
      lines.push(`${item.name}｜${formatBytes(item.bytes)}`)
    }
  }
  if (tail) {
    const head =
      tailSkipped > 0
        ? `（以下取自 ${tailName} 的尾部 ${tail.length} 行，前面 ${tailSkipped} 行没带）`
        : `（以下取自 ${tailName} 的全部 ${tail.length} 行）`
    lines.push(head)
    lines.push(...tail.map((line) => clampText(redactText(line))))
  } else {
    lines.push('（这次没读到日志正文：目录没有、文件为空，或者正好被轮转挪走）')
  }
  return lines
}

/**
 * 拼出诊断包全文。
 * 单独收成接一份快照的纯函数，是因为判据要能自动化：「包里没有 `sk-` 形态的串、没有绝对路径」
 * 写在注释里等于没写（#281/#280 那两个坑都是这么来的），而 `tests/diagnostics.test.ts` 拿一份
 * 塞了 Key 与路径的假快照就能真的把这句话跑一遍。
 */
export function renderDiagnostics(snap: DiagnosticsSnapshot): string {
  return [
    'Vv Transcribe 诊断包',
    '（本机生成，应用不会自己上传。凭据、文稿原文与绝对路径按 #281 那道闸门的规则隐去；' +
      '日志正文落盘时已过同一道闸门，这里再对每行过一遍，为的是闸门之前写下的旧轮转档。）',
    '',
    field('导出时间', snap.exportedAt),
    '',
    '== 运行环境 ==',
    field('应用版本', snap.appVersion),
    field('运行方式', snap.packaged ? '打包安装版' : '开发版（未打包）'),
    field('Electron', snap.electron),
    field('Chrome', snap.chrome),
    field('Node', snap.node),
    field('平台', `${snap.platform} ${snap.arch}`),
    field('系统版本', snap.osVersion),
    field('界面语言', snap.locale),
    field('数据目录名', snap.dataDirName),
    '',
    ...renderSettings(snap.settings),
    '',
    ...renderProfiles(snap.profiles),
    '',
    ...renderComponents(snap.components, snap.engineInManifest),
    '',
    '== 本机转写引擎 ==',
    field('服务状态', snap.asrService.ready ? '已就绪' : '未就绪'),
    field('失败原因', snap.asrService.error ?? '（无）'),
    '',
    ...renderLogs(snap.logs, snap.tailName, snap.tail, snap.tailSkipped),
  ].join('\n')
}

/**
 * 落盘的默认名，也是界面 toast 里那一句「××」。
 * 这里自己补零：它是文件名不是界面读数，`tests/formatTime.test.ts` 那条判据留的正是这种位置
 * （理由写在那儿，跟讯飞签名里那个 `yyyyMMddHHmmss` 同一条）。
 */
export function diagnosticsFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `vv-diagnostic-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(
    at.getHours()
  )}${pad(at.getMinutes())}.txt`
}

/**
 * 这个路径是不是落在会被启动清扫删掉的那一层。
 * 判式抄清扫那一头的形状（`urlDownloader.ts` 认 `tmpdir()` 下 `startsWith('transcribe-')` 的目录）：
 * 逐段比开头，不看整段相等——`/tmp/transcribe-abc/diagnostic.txt` 也在靶子里。
 * 这比「只认 tmpdir 那一条前缀」更宽：用户自建、名字恰好带连字符的文件夹（`transcribe-notes`）也拦。
 * 宁可拦错一边：误拦的代价是「换个文件夹再点一次」，误放的代价是这份包过一天自己没了，
 * 而后者一句提示都不会有。
 */
export function landsInSweepTarget(path: string): boolean {
  return path.split(/[/\\]/).some((seg) => seg.startsWith('transcribe-'))
}

/**
 * 盘上真实有哪几份日志。
 * 用 readdir 过滤而不是照 `logger.ts` 的轮转号凑四个名字：轮转会把 app.3.log 删掉、把 app.2.log
 * 改名，凑出来的名字会报出「0KB」这种看着像「这个用户没日志」的假值。读不到的那一份干脆不列。
 */
const LOG_FILE_NAME = /^app(\.\d+)?\.log$/

async function readLogInventory(): Promise<
  Pick<DiagnosticsSnapshot, 'logs' | 'tailName' | 'tail' | 'tailSkipped'>
> {
  const empty = { logs: [], tailName: null, tail: null, tailSkipped: 0 }
  const dir = logsDir()
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => LOG_FILE_NAME.test(name))
  } catch {
    return empty
  }

  const listed: { name: string; rotation: number; bytes: number }[] = []
  for (const name of names) {
    try {
      const info = await stat(join(dir, name))
      // app.log 是最新的一份（轮转号 0），app.1 / app.2 / app.3 依次更旧
      listed.push({ name, rotation: Number(/\.(\d+)\.log$/.exec(name)?.[1] ?? 0), bytes: info.size })
    } catch {
      // 正好被轮转挪走或删掉了：这一份列不出来，其余照列
    }
  }
  listed.sort((a, b) => a.rotation - b.rotation)

  for (const entry of listed) {
    if (entry.bytes === 0) continue
    let raw: string
    try {
      raw = await readFile(join(dir, entry.name), 'utf-8')
    } catch {
      continue
    }
    const lines = raw.split('\n').filter((line) => line.trim())
    if (lines.length === 0) continue
    return {
      logs: listed.map(({ name, bytes }) => ({ name, bytes })),
      tailName: entry.name,
      tail: lines.slice(-LOG_TAIL_LINES),
      tailSkipped: Math.max(0, lines.length - LOG_TAIL_LINES),
    }
  }
  return { logs: listed.map(({ name, bytes }) => ({ name, bytes })), tailName: null, tail: null, tailSkipped: 0 }
}

/**
 * 取齐一份快照。
 * 配置走 `getSettingsView()` 而不是 `loadSettings()`：后者会解密 Key，拿到它的调用点
 * 一旦把这值 `JSON.stringify` 出去，Key 就进了包——这条路上压根不给那个机会。
 * 这几头都没有联网：组件那份读的是会话缓存（`listComponents` 是「不联网的那一份」），
 * 所以「导出诊断包」这个动作本身不产生任何一次请求。
 */
export async function collectDiagnostics(): Promise<DiagnosticsSnapshot> {
  const settings = await getSettingsView()
  const profiles = await listProfiles()
  const components = await listComponents()
  const logs = await readLogInventory()
  return {
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '未知',
    chrome: process.versions.chrome ?? '未知',
    node: process.versions.node ?? '未知',
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    locale: app.getLocale(),
    packaged: app.isPackaged,
    dataDirName: basename(userDataRoot()),
    settings,
    profiles,
    components,
    engineInManifest: engineBinaryInManifest(),
    asrService: getASRServiceStatus(),
    ...logs,
  }
}

/** 拼好一整包文本：IPC 那一条只负责把它写到用户选的位置 */
export async function buildDiagnosticsText(): Promise<string> {
  return renderDiagnostics(await collectDiagnostics())
}
