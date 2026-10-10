/**
 * 转写结果导出工具
 * 支持四种格式：SRT 字幕、纯文本 TXT、JSON 数据、Markdown 文档
 */
import type { TranscriptionSegment, ExportFormat } from '@/types/transcription'

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`
}

function formatDisplayTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
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
    txt: 'txt',
    json: 'json',
    md: 'md',
  }
  return extMap[format]
}
