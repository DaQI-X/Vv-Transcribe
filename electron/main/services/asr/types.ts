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

/**
 * 阶段性状态：这一段在等什么，而不是「进度到了百分之几」。
 *
 * 两个阶段都**故意不带百分比**：
 * - `loading_model` 本地引擎首次加载/下载权重，落点由引擎自己报，我们这边不知道它到哪了；
 * - `waiting_order` 讯飞那类「上传换订单号再轮询」的异步接口（#343），对方只给
 *   `taskEstimateTime` 这种没有实测数的估值。按估值换算一个百分比就是编一个数给用户看，
 *   而这条链路上「进度条走到 90% 卡住十分钟」比「一直显示在等对方」更难解释。
 *   固定百分比 + 一句阶段文案，是 `loading_model` 那一档已经认下来的形状。
 */
export type ASRStage = 'loading_model' | 'waiting_order'

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
