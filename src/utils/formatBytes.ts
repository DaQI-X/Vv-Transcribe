/**
 * 全仓唯一的「字节数 → 给人看的体积」
 *
 * 为什么要有这一个：改之前渲染层有 6 份各自实现（VoiceStudio / UploadStatus / FileUploader /
 * AudioPlayer 按 1024，SettingsModal / ComponentsSection 按 1000），标签却都写 KB/MB。同一个
 * v1.0.7 引擎（24,438,304 字节）在「按需组件」里是 24.4MB、在配音页会是 23.3MB——用户拿不到
 * 任何线索去怀疑这两个数说的是同一件东西，而这一栏的唯一用途就是决定「这次下载要不要下」。
 *
 * 尺选 1000（SI），不是 1024，理由按能不能核对排序：
 * - 主进程面向用户的体积本来就按 1000 算（`componentService.ts` / `ytDlpUpdate.ts` 的下载与对账
 *   文案）。按 1024 统一会把这些连 README 一起改口，而 `components-manifest.json` 里那份是发布
 *   出去的字节数，动不得。
 * - macOS 访达从 Big Sur 起按 1000 显示，用户在选文件时看到的那个数就是这个。
 * - 代价是 Windows 资源管理器仍按 1024 显示（它把 1024 也叫「MB」），同一个素材两边差 7%。
 *   两边不可能同时对上，选跟应用自己那套账一致的一边。
 *
 * `electron/main/services/` 里两处给用户看的体积（自检的「…KB 音频」、下载引导的模型档位提示）
 * 也 import 这里，所以这一把尺是跨主进程与渲染层的；它们走相对路径而非 `@/`，因为主进程那条
 * build 链没装配名。
 *
 * 单位之间不留空格（`24.4MB` 而不是 `24.4 MB`）：`占用 135.5MB`、`下载约 135.5MB` 这些话已经
 * 同时出现在设置页、主进程的 toast 和 README 里，加空格就等于再制造一次「看着像两个来源」。
 */
const KB = 1e3
const MB = 1e6
const GB = 1e9

/**
 * 到 GB 为止：这条链路上最大的是用户自己的视频，TB 级文件不存在。真出现时按 GB 念，
 * 宁可念成一个奇怪的巨数，也不要一个静默的 `Infinity` 或 `NaN`。
 *
 * 档与档的分界看「将要显示的那一位」四舍五入之后够不够本档，不看整档大小：
 * 999,999 字节按 `bytes < MB` 会落在 KB 档、四舍五入成 1000KB——界面出现「1000KB」
 * 那一刻看起来就像单位换算坏了，而它离 1.0MB 只差一个字节。
 */
export function formatBytes(bytes: number): string {
  const whole = Math.round(bytes)
  if (whole < KB) return `${whole}B`
  const kb = Math.round(whole / KB)
  if (kb < 1000) return `${kb}KB`
  const mb = (whole / MB).toFixed(1)
  if (Number(mb) < 1000) return `${mb}MB`
  return `${(whole / GB).toFixed(2)}GB`
}
