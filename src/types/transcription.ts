/**
 * 前端核心类型定义
 * 定义转写段落、转写状态流转、导出格式等数据结构
 */
export interface TranscriptionSegment {
  id: string
  startTime: number
  endTime: number
  text: string
  originalText?: string
  isEdited: boolean
  isCorrected: boolean
  confidence?: number
}

export type TranscriptionStatus =
  | 'idle'
  | 'extracting_audio'
  | 'transcribing'
  | 'correcting'
  | 'completed'
  | 'error'
  | 'cancelled'

export type ExportFormat = 'srt' | 'vtt' | 'tsv' | 'txt' | 'json' | 'md'
