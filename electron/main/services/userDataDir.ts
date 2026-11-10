/**
 * 「用户数据目录在哪」的不依赖 electron 那一份（#376）
 *
 * 为什么要有第二份：README 的规矩是「用户数据落点只有一处定义」，那一处是
 * `userDataStore.userDataRoot()` = `app.getPath('userData')`。而 #374 实测过，打包版
 * `vv` 跑在 ELECTRON_RUN_AS_NODE 模式里，`require('electron')` 抛 MODULE_NOT_FOUND——
 * CLI 拿不到那个函数，只能自己算。
 * 于是这句话变成两处定义，风险很具体：**门面把 token 写进一个目录，CLI 去另一个目录找**，
 * 症状是「设置里明明打开了却连不上」，而日志两边各自都写着自己在干活。
 * 这份文件的作用就是把那两处钉回同一个算法：
 * - 主进程仍然用 `app.getPath`（那是权威，Electron 升级改了规则也跟着改）；
 * - 门面启动时拿本函数与它比一次，不一致就在日志里 WARN（`agentFacade.ts`），
 *   所以真分叉是被发现的，不是被猜的；
 * - 纯函数、不收 electron 依赖，所以 CLI 能直接 import——这也是它单独成文件的原因，
 *   放进 `userDataStore.ts` 就等于把 electron 依赖传染给 CLI。
 *
 * 三个平台各自的规则抄自 Chromium 的 userData 路径口径（macOS `~/Library/Application Support`、
 * Windows `%APPDATA%`、Linux `$XDG_CONFIG_HOME` 或 `~/.config`），目录名用 `APP_DATA_DIR_NAME`。
 * Windows 与 Linux 那两支在本机测不到（这台是 macOS），所以打包后第一次跑 `vv` 时那条 WARN
 * 是这两支唯一的实证机会——#378 的遗留清单要照着这个口径写。
 */
import { join } from 'node:path'

/**
 * 数据目录那一层的名字。打包后 Electron 用的 `app.name` 就是它：
 * `electron-builder.cjs` 的 `productName` 与 `main/index.ts` 的 `APP_NAME` 三处必须是同一个串，
 * `tests/agentFacade.test.ts` 拿仓库文件把这三处对账（改产品名是三个地方一起改，漏一个的后果
 * 是 CLI 再也找不到 token，而那看起来像「门面没开」）。
 */
export const APP_DATA_DIR_NAME = 'Vv Transcribe'

/**
 * @param platform `process.platform`
 * @param home `os.homedir()`
 * @param env 默认 `process.env`；单测传一份假环境来验 XDG / APPDATA 那两支
 */
export function userDataDirFor(
  platform: NodeJS.Platform | string,
  home: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DATA_DIR_NAME)
  }
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DATA_DIR_NAME)
  }
  // Linux 之外的一律走 XDG 那支：Electron 对未知平台也是这个口径，而这里的目标是「别比 Electron 少算一层」
  const xdg = env.XDG_CONFIG_HOME
  // 相对路径的 XDG_CONFIG_HOME 在 Chromium 里直接不认（否则 userData 会跟着进程 cwd 跑）
  const base = xdg && xdg.startsWith('/') ? xdg : join(home, '.config')
  return join(base, APP_DATA_DIR_NAME)
}
