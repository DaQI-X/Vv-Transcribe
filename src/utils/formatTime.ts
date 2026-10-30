/**
 * 全仓唯一的「秒 → 给人看的时钟」
 *
 * 为什么要有这一个：改之前渲染层有 3 份逐字节相同的实现（AudioPlayer / VoiceStudio / SegmentRow），
 * 都只算到 `Math.floor(seconds / 60)` 再补零，没有小时位。一档 61 分钟的节目在播放器、字幕行、
 * 配音结果卡上会写成 `61:23`。这个说法本来就是错的，而且本仓已经认过一次：
 * `exportTranscript.ts` 里那句「满一小时才补上小时位，否则一小时的节目会写出 62:05 这种没人认的读数」
 * 说的就是同一个坑——只是那一次只修了 Markdown 导出，没回头收这三处界面。现在界面与导出的
 * Markdown 走同一把尺：用户在字幕行看到的落点，和他导出来对的那行 `[01:02:05]` 必须是一个数。
 *
 * 不含 SRT/VTT 时间戳：`00:01:02,500`（SRT 用逗号、VTT 用点）是交付文件的规范格式，
 * 由 `exportTranscript.ts` 按规范自己拼。混进来只会诱导出「顺手改个显示格式」这种把交付文件改坏的动作。
 *
 * 一律 floor 到整秒，不四舍五入：进度条读数与总时长并排出现时，`00:59` 与 `01:00` 差一秒会被读成
 * 「这两个数说的不是同一个东西」；一条轨在两个格子里只能有一个读数。代价是不足一秒的余量被抹掉，
 * 需要把亚秒差说清楚的场合（配音结果卡那条「比原时间轴长多少」）由调用点自己处理，别让这把尺去装看不见。
 */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mmss = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return h > 0 ? `${h.toString().padStart(2, '0')}:${mmss}` : mmss
}
