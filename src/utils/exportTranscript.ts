/**
 * 转写结果导出工具
 * 支持六种格式：SRT / VTT 字幕、台词表 TSV、纯文本 TXT、JSON 数据、Markdown 文档
 *
 * 为什么是这几个：字幕交付与剪辑回填认 SRT，网页与 YouTube 认 VTT，配音读稿要的是
 * 「一行一句、前面带落点」的台词表。三者都是纯文本、任何软件都能开，比造一个只有
 * 本应用认的私有格式有用。
 */
import type { TranscriptionSegment, ExportFormat } from '@/types/transcription'

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`
}

/** WebVTT 的时间戳分隔符是点，不是 SRT 的逗号——写成逗号会被当坏文件 */
function formatVTTTime(seconds: number): string {
  return formatSRTTime(seconds).replace(',', '.')
}

/** Markdown 里的短时码：满一小时才补上小时位，否则一小时的节目会写出 62:05 这种没人认的读数 */
function formatDisplayTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mmss = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return h > 0 ? `${h.toString().padStart(2, '0')}:${mmss}` : mmss
}

export function exportTranscript(
  segments: TranscriptionSegment[],
  format: ExportFormat,
): string {
  switch (format) {
    case 'srt':
      return segments
        .map(
          (seg, idx) =>
            `${idx + 1}\n${formatSRTTime(seg.startTime)} --> ${formatSRTTime(seg.endTime)}\n${seg.text}\n`,
        )
        .join('\n')

    case 'vtt':
      return [
        'WEBVTT',
        '',
        ...segments.map(
          (seg) => `${formatVTTTime(seg.startTime)} --> ${formatVTTTime(seg.endTime)}\n${seg.text}\n`,
        ),
      ].join('\n')

    /**
     * 台词表：一行一句，时间码和正文用制表符分开，粘进表格或读稿软件都能直接分列。
     * 只给起始落点不给结束点——配音看的是「这句什么时候开口」，槽位长度已经在 SRT 里了。
     */
    case 'tsv':
      return segments
        .map((seg) => `${formatVTTTime(seg.startTime)}\t${seg.text}`)
        .join('\n')

    case 'txt':
      return segments.map((seg) => seg.text).join('\n\n')

    case 'json':
      return JSON.stringify(
        segments.map((seg) => ({
          startTime: seg.startTime,
          endTime: seg.endTime,
          text: seg.text,
          isEdited: seg.isEdited,
          isCorrected: seg.isCorrected,
        })),
        null,
        2,
      )

    case 'md':
      return segments
        .map(
          (seg) =>
            `**[${formatDisplayTime(seg.startTime)} - ${formatDisplayTime(seg.endTime)}]**\n\n${seg.text}`,
        )
        .join('\n\n---\n\n')

    default:
      return ''
  }
}

export function getExportExtension(format: ExportFormat): string {
  const extMap: Record<ExportFormat, string> = {
    srt: 'srt',
    vtt: 'vtt',
    tsv: 'tsv',
    txt: 'txt',
    json: 'json',
    md: 'md',
  }
  return extMap[format]
}
