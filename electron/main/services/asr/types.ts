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

/** 引擎在 loading_model 阶段自报的身份：档位名 + 需要下载的权重体积 */
export interface ASRModelInfo {
  tier: string
  weightsMb: number | null
}

export interface ASRProgress {
  percent: number
  segment?: ASRSegment
  stage?: ASRStage
  model?: ASRModelInfo
}

export interface ASROptions {
  language?: string
  /** 本地引擎的 Whisper 档位（base / small），只对本机推理生效；云端用的还是 config.model */
  localModel?: string
}

export interface ASRProvider {
  readonly name: string
  readonly type: 'local' | 'cloud'

  isAvailable(): Promise<boolean>

  transcribe(
    audioFilePath: string,
    options: {
      language?: string
      localModel?: string
      onProgress?: (progress: ASRProgress) => void
      signal?: AbortSignal
    },
  ): Promise<ASRSegment[]>

  cancel(): void
}
