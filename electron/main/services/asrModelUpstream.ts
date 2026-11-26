/**
 * 本地 Whisper 档位权重的上游出处表（#430）
 *
 * 这一档的权重以前只有一条路：转写请求打到引擎，引擎里的 huggingface_hub 自己去 hf-mirror 拉
 * 138MB/461MB，拉多久、拉到哪、拉回来的字节对不对，宿主一概不知道。三个毛病同一个根——
 * 取件这件事发生在罐子外面，而罐子外面那套机器件（候选源、逐字节进度、断点续传、SHA256）
 * 早就为配音模型建好了（#237 + #407 + #1.2.2 那轮）。所以这张表照抄 ttsModelUpstream 的形状，
 * 让两档权重变成两个普通组件：进度、换源、校验全部复用同一条下载链。
 *
 * 钉的是三样，缺一不可（口径与配音那两张表一致）：
 * - commit：完整 40 位。上游客仓可以被 force push，`main` 会飘，commit 不会。
 * - 每个文件的 bytes：拦住被网关吃掉一半的响应。
 * - 每个文件的 sha256：拦住「长度对但内容不对」。
 *
 * 指纹的来路（2026-11-26 本机，逐个文件算，两档各四个）：
 * - 取值来自本机 HF 缓存里**引擎实际加载过**的那两个快照目录
 *   （`~/.cache/huggingface/hub/models--Systran--faster-whisper-<档位>/snapshots/<commit>`），
 *   软链先 realpath 到真身再统计，与 #421 那套量法同一把尺。
 * - 其中两档的 `config.json` 与 `vocabulary.txt`（共 4 个）另走网络复核过：按上面那两个 commit 的
 *   resolve 地址从 hf-mirror 现下，字节数与表里逐个相等（2309 / 459861 / 2370 / 459861）。
 * - `model.bin` 与 `tokenizer.json` 没有重下验证（145MB/483MB 各一枚 + 两枚 2.2MB），
 *   它们的上游字节数由缓存落盘时的 `.incomplete`→真身链路保证，不在这里假装实测过。
 * - 第二枚候选（huggingface.co 正站）**本机今天验不到**：直连返回 000（2026-11-26 两次，与
 *   ttsModelUpstream 那句「国内直连基本取不动」同一条经验）。留着它的理由是它对外部用户有效，
 *   对本机无效——这句写在这里，是为了下一个改这段的人别把它当成「两个源都验过」。
 *
 * 为什么表里只有 4 个文件、不裁也不加：faster-whisper 加载一个目录时点名的就是这 4 个
 * （ctranslate2 要 model.bin + config.json，WhisperTokenizer 要 tokenizer.json + vocabulary.txt），
 * 本机那两个快照目录里也只有这 4 个。上游仓库若还有 README 之类，引擎不读，也就不必占下载。
 *
 * 两档共用 tokenizer.json 与 vocabulary.txt（指纹完全相同），但**不做跨档硬链接**：
 * 落点在 userData 下、按档位各一份目录，删一档就是删那棵目录——共享文件会让「删除」变成引用计数，
 * 那是 #416 那件「应用内清空本机数据」的活儿，不该塞进取件层。代价是两档都装时多占约 2.5MB。
 */
import { join } from 'node:path'
import { componentsDir } from './userDataStore'
import type { LocalModelTier } from './settingsService'
import type { UpstreamModelFile, UpstreamModelSource } from './ttsModelUpstream'

export type { UpstreamModelFile, UpstreamModelSource }

/** 主取件源：国内直连 huggingface.co 取不动，镜像是第一腿 */
const MIRROR_BASE = 'https://hf-mirror.com'
/** 兜底源：正站。镜像整体挂了（它是公益反代，不是自家 CDN）时这一腿还有用 */
const ORIGIN_BASE = 'https://huggingface.co'

/**
 * 档位 → 上游出处。表改了必须连同 commit 一起改，只改指纹不改 commit 是自欺欺人。
 * 每个档位的 `bytes` 合计：base 147,882,941，small 486,212,372（按 1000 进位即 147.9MB / 486.2MB）。
 * 注意这与引擎 `MODEL_WEIGHTS_MB` 里那两个「约 138MB／461MB」不是一把尺——那两位只数 model.bin，
 * 且按 1024 进位。这一版起「要下多少」以本表的 bytes 合计为准（组件面板那一行就是它）。
 * 版本号（提交号前 7 位）、总字节、整表指纹这三个量不再各写一份：它们只认 `UpstreamModelSource`
 * 这个结构，配音那侧的 `upstreamVersion` / `upstreamTotalBytes` / `upstreamTableDigest` 就是通用实现，
 * componentService 的 `upstreamEntry` 拿这张表喂进去算，两档 ASR 因此天然在 installed.json 里记了指纹。
 */
export const ASR_MODEL_SOURCES: Record<LocalModelTier, UpstreamModelSource> = {
  base: {
    repo: 'Systran/faster-whisper-base',
    commit: 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66',
    files: [
      {
        path: 'config.json',
        bytes: 2309,
        sha256: '56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a',
      },
      {
        path: 'model.bin',
        bytes: 145217532,
        sha256: 'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9',
      },
      {
        path: 'tokenizer.json',
        bytes: 2203239,
        sha256: 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
      },
      {
        path: 'vocabulary.txt',
        bytes: 459861,
        sha256: '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
      },
    ],
  },
  small: {
    repo: 'Systran/faster-whisper-small',
    commit: '536b0662742c02347bc0e980a01041f333bce120',
    files: [
      {
        path: 'config.json',
        bytes: 2370,
        sha256: 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828',
      },
      {
        path: 'model.bin',
        bytes: 483546902,
        sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',
      },
      {
        path: 'tokenizer.json',
        bytes: 2203239,
        sha256: 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
      },
      {
        path: 'vocabulary.txt',
        bytes: 459861,
        sha256: '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
      },
    ],
  },
}

export function hasAsrModelDownload(tier: string): tier is LocalModelTier {
  return Boolean(ASR_MODEL_SOURCES[tier as LocalModelTier])
}

/**
 * 组件面板那两行的名字与说明。和配音那边一样，行标题只在这一处写，界面与提示语共用一份，
 * 免得「快速档语音模型」和「base 权重」在同屏并存。
 * hint 里不重复体积：那一格由表算（主进程按 files 的 bytes 合计报），写死了就会出现两个不同的数并排。
 */
export const ASR_MODEL_ROW_TITLES: Record<LocalModelTier, { title: string; hint: string }> = {
  base: {
    title: '快速档语音模型（base）',
    hint: '本地转写用的 Whisper 权重，取自 HuggingFace 上游仓库里钉死的那个提交',
  },
  small: {
    title: '精准档语音模型（small）',
    hint: '本地转写用的 Whisper 权重，比快速档准，取自 HuggingFace 上游仓库里钉死的那个提交',
  },
}

/** 整档在组件目录下的落点根（#434）：`userData/components/asr-models` */
export function asrModelRootDir(): string {
  return join(componentsDir(), 'asr-models')
}

/**
 * 某一档的权重目录——下载器的落点，也是交给引擎的 `VV_ASR_MODEL_DIR`。
 * 路径归 asrModelUpstream 说（那边是「这一档要哪些文件」，这里是「那些文件放哪」），
 * 引擎侧必须吃同一个函数：写死第二份拼法迟早分叉。
 */
export function asrModelDir(tier: LocalModelTier): string {
  return join(asrModelRootDir(), tier)
}

/**
 * 一个文件的全部候选地址，顺序即取件顺序。
 * 与清单那条（assetUrls）同一条规矩：第一腿是快的，最后一腿是「前面全挂也要有个出路」，
 * 判死按字节/时间（componentService 的 budget），不按出口 IP 的国家码。
 * `VV_ASR_MODEL_BASE` 只在自检里用（指到本机静态服务），它把两腿一起换掉——指纹钉在代码里，
 * 换前缀只能喂出内容相同的东西，撑不开「换成别人的文件」。
 */
export function asrModelFileUrls(source: UpstreamModelSource, file: UpstreamModelFile): string[] {
  const override = process.env.VV_ASR_MODEL_BASE
  const bases = override ? [override] : [MIRROR_BASE, ORIGIN_BASE]
  return bases.map((base) => `${base}/${source.repo}/resolve/${source.commit}/${file.path}`)
}
