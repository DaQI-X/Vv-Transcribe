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
 * `loading_model` 与 `waiting_order` **故意不带百分比**：
 * - `loading_model` 本地引擎首次加载/下载权重，落点由引擎自己报，我们这边不知道它到哪了；
 * - `waiting_order` 讯飞那类「上传换订单号再轮询」的异步接口（#343），对方只给
 *   `taskEstimateTime` 这种没有实测数的估值。按估值换算一个百分比就是编一个数给用户看，
 *   而这条链路上「进度条走到 90% 卡住十分钟」比「一直显示在等对方」更难解释。
 *   固定百分比 + 一句阶段文案，是 `loading_model` 那一档已经认下来的形状。
 *
 * `downloading_model` 是这三段里唯一**真有分母**的一段（#435）：权重由宿主自己的下载器逐文件取，
 * 每个文件的字节数钉在指纹表里，所以这一条给的是实测比例，不是估的。它的存在本身就是这一档的意义——
 * 在此之前首转要拉 148/486MB，进度条却只能钉在 10% 装死，用户没有任何办法区分「在下」和「卡了」。
 */
export type ASRStage = 'downloading_model' | 'loading_model' | 'waiting_order'

/**
 * 引擎在 loading_model 阶段自报的身份：档位名 + 需要下载的权重体积。
 * 后两位是 #436 补的「这一档真从哪儿读」：`source` 为 `directory` 时整条加载不碰网络，
 * 那句「请确认能访问 hf-mirror.com」就必须收起——报错了还劝人查网络，是把唯一一件与网络无关的
 * 失败推给用户去排查网络。`missingFiles` 非空则是宿主下发的目录少文件（装完之后被删/被改），
 * 出路在「按需组件」那一行，不在网络上。旧引擎不发这两位，界面按没有这两位处理（走原来那句）。
 */
export interface ASRModelInfo {
  tier: string
  weightsMb: number | null
  source?: 'directory' | 'repo'
  missingFiles?: string[]
  /**
   * 宿主自己取件那一段的实测字节（#435），只在 `stage === 'downloading_model'` 时出现。
   * 这里给的是**字节数**而不是「多少 MB」：单位由渲染层那唯一的 `formatBytes` 说（#282），
   * 主进程这边一旦先拼成字符串，界面就没法按自己的宽度改口径了。
   */
  download?: { done: number; total: number }
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
