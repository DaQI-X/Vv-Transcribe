/**
 * ASR 模块类型定义
 * 定义转写片段、进度、配置项和 Provider 接口规范
 */
export interface ASRSegment {
  startTime: number
  endTime: number
  text: string
  confidence?: number
}

/** 本地引擎的阶段性状态：目前只有首次加载/下载模型 */
export type ASRStage = 'loading_model'

export interface ASRProgress {
  percent: number
  segment?: ASRSegment
  stage?: ASRStage
}

export interface ASROptions {
  language?: string
  model?: string
}

export interface ASRProvider {
  readonly name: string
  readonly type: 'local' | 'cloud'

  isAvailable(): Promise<boolean>

  transcribe(
    audioFilePath: string,
    options: {
      language?: string
      onProgress?: (progress: ASRProgress) => void
      signal?: AbortSignal
    },
  ): Promise<ASRSegment[]>

  cancel(): void
}
