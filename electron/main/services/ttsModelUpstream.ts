/**
 * 本地配音模型的上游出处表（#237「模型自取上游」）
 *
 * 为什么模型不走 components-manifest.json、而引擎走：
 * 引擎二进制是我们自己用 PyInstaller 打出来的，发布在自己仓库的 Release 上，指纹由 CI 现算——
 * 那份资产我们能对内容负责。模型是第三方训练出来的权重，HuggingFace 上那份的 license 字段实测是空的
 * （#234 查过），把它下载再上传到我们的 Release 等于替第三方权重做一次再分发，这层责任不该揽。
 * 于是分家：引擎继续走清单，模型由应用直接从上游客仓取，「钉」这件事写死在这份代码里。
 *
 * 钉的是三样，缺一不可：
 * - commit：完整 40 位。上游客仓可以被 force push，`main` 会飘，commit 不会——URL 里带 commit 之后
 *   「今天下到的和昨天下到的」是同一份字节。
 * - 每个文件的 bytes：拦住被截断的响应（302 到 CDN 之后被网关吃掉一半是真实发生过的）。
 * - 每个文件的 sha256：拦住「长度对但内容不对」。
 *
 * 这些指纹的来路（2026-10-28 本机）：
 * - 全部 17 个文件取自本机那份**引擎实际加载过、并且用户试听后选定音色**的模型目录
 *   （`userData/components/tts-models/sherpa-onnx-vits-zh-ll`），逐个 `shasum -a 256` 算出来的；
 * - 其中 10 个（model.onnx 与 dict/ 下的 9 个）是 Git LFS 文件，上游 tree API 的 `lfs.oid` 就是内容
 *   sha256，自算值与它逐个相等——两条独立路子给出同一个数；
 * - 另外 7 个（*.fst、tokens.txt、lexicon.txt、dict/README.md）是普通 git blob，tree API 只给 40 位的
 *   git sha1，拿不到内容 sha256，只能自钉。为确认自钉的不是「本机被改过的脏值」，抽了 tokens.txt 与
 *   date.fst 用下面这个 commit 的 resolve 地址实下一遍，字节数与 sha256 双双对上；
 *   model.onnx 的 302→CDN 链路也验过，最终 Content-Length = 121,100,803，与表里一致。
 * - 同一个 commit 的同一个文件，直连 hf-mirror 和走代理（会被 308 转去 huggingface.co 正站）取回的内容
 *   指纹相同——所以开不开网络加速都不影响正确性，只影响速度。
 *
 * 为什么按文件下、而不是整仓打包下一份 zip：hf-mirror 上 `/archive/<commit>.zip`、
 * `/archive/refs/heads/main.zip` 这几种 git-archive 路径实测全部 404（2026-10-28），
 * 而模型仓库里有 3 个文件（README.md、.gitattributes、G_multisperaker_latest.json）引擎根本不需要，
 * 按清单逐文件取反而更准、也更能说清「下的是哪些东西」。
 *
 * 17 个文件、合计 135,454,939 字节。界面上那个数由这份表算出（135.5MB，按 1000 进位），
 * 和 du 的 MiB 口径（129）不是同一把尺——所以「要下多少」只说表算的那个，别再报第二个数。
 * 这份表改了就必须连同 commit 一起改，只改指纹不改 commit 是自欺欺人：
 * commit 才是「上游那批字节没变」的凭据。
 */
import { createHash } from 'node:crypto'
import type { LocalTtsEngineId } from './localTtsEngine'

export interface UpstreamModelFile {
  /** 相对模型目录的路径，会原样拼进 resolve 地址与本地落盘路径 */
  path: string
  bytes: number
  /** 文件内容的 SHA2-256，64 位小写十六进制 */
  sha256: string
}

export interface UpstreamModelSource {
  /** HuggingFace 上的 `<namespace>/<repo>` */
  repo: string
  /** 完整 40 位提交号 */
  commit: string
  files: UpstreamModelFile[]
}

/**
 * 国内直连 huggingface.co 基本取不动，正站留作「关掉加速也照样能取」的兜底由界面文案说明，
 * 代码里只认这一个源。换源自检（同 VV_COMPONENTS_MANIFEST_URL 的思路）用 VV_TTS_MODEL_BASE：
 * 指纹钉在代码里，把前缀指到本机静态服务也只能喂出内容相同的东西，撑不开「换成别人的文件」。
 */
const UPSTREAM_BASE = 'https://hf-mirror.com'

export function upstreamBase(): string {
  return process.env.VV_TTS_MODEL_BASE || UPSTREAM_BASE
}

/** 一个文件的下载地址。commit 是钉死的，不是分支名 */
export function upstreamFileUrl(source: UpstreamModelSource, file: UpstreamModelFile): string {
  return `${upstreamBase()}/${source.repo}/resolve/${source.commit}/${file.path}`
}

/** 提交号的前 7 位，界面当版本号用（和 git 里认一个提交的习惯一致） */
export function upstreamVersion(source: UpstreamModelSource): string {
  return source.commit.slice(0, 7)
}

/**
 * 引擎 id → 上游出处。 kokoro 这一档故意不在这里：1.0.6 只发中文 VITS（拍板过的范围），
 * 而 Kokoro 的 espeak-ng-data/ 有几百个文件，指纹表要另做一轮实测，不能凭记忆填。
 * 于是这一档在界面上是「本版没有可下载的包」，而不是「下载会失败」——由调用方按缺席处理。
 */
export const UPSTREAM_MODEL_SOURCES: Partial<Record<LocalTtsEngineId, UpstreamModelSource>> =
  {
    'sherpa-onnx-vits-zh-ll': {
      repo: 'csukuangfj/sherpa-onnx-vits-zh-ll',
      commit: '7ddf37bcacf05ed56afee360d96835be633a5265',
      files: [
        { path: 'date.fst', bytes: 59_154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
        { path: 'dict/README.md', bytes: 683, sha256: '8bcc7c2ed7dff082d9a99c09de0bfd72249bf3b5c4298a3af328da40cbd8cfd1' },
        {
          path: 'dict/hmm_model.utf8',
          bytes: 519_739,
          sha256: 'f17790586ac86dd048c8adffed052c4bd2b28ed0682972c1275e59040c0589a7',
        },
        {
          path: 'dict/idf.utf8',
          bytes: 5_998_717,
          sha256: 'dbd1e03d72b2263cc8d84a4304ed77677eed9e7deaf43a1a5133bbba9733b535',
        },
        {
          path: 'dict/jieba.dict.utf8',
          bytes: 5_071_204,
          sha256: '3043b77068e09c9904f27cad82f12b6ebe9dbdb5aeff3b25e45ab7f9c1122b55',
        },
        {
          path: 'dict/pos_dict/char_state_tab.utf8',
          bytes: 327_139,
          sha256: '28b7be1dd7369766a51445af4d42e9a2ba4bf374c13be5bc1ca7721e27271dbb',
        },
        {
          path: 'dict/pos_dict/prob_emit.utf8',
          bytes: 1_687_686,
          sha256: 'c33c4cb7edf3b3a5947df7209b6e9f267eae1f21335d9e2bd2521ea07105457a',
        },
        {
          path: 'dict/pos_dict/prob_start.utf8',
          bytes: 4_347,
          sha256: '13623ea0e9300bdb597cb2da28770b7b385d6c0098d66e516083fb01b6bd5d96',
        },
        {
          path: 'dict/pos_dict/prob_trans.utf8',
          bytes: 124_159,
          sha256: 'f22363e2307408293d180c6f9f6b5cb75879d52f722f7764fa2d3d0ae2400236',
        },
        {
          path: 'dict/stop_words.utf8',
          bytes: 8_974,
          sha256: 'b788b8a939d2e2fe079abd579ea98f12f9fb84370bfd0dddd81bb9381f7ab42c',
        },
        { path: 'dict/user.dict.utf8', bytes: 49, sha256: '495bbf49270408a1234690e1e6a97328f30a482a7a72aa769e8a12e8714b0c62' },
        { path: 'lexicon.txt', bytes: 376_868, sha256: 'b3a82f16b286c424953dea3686039e7ab465fa8e15d87ef8abd0ec69175beb21' },
        {
          path: 'model.onnx',
          bytes: 121_100_803,
          sha256: '6c349bdd73dc928234dd7bc86929748bba32cd5264d32d915bf7b7aa0595965b',
        },
        {
          path: 'new_heteronym.fst',
          bytes: 21_974,
          sha256: 'ca14b2127e27baa571664e4bb791e143e7425f56a6bc29db08d74f97e6aa4e29',
        },
        { path: 'number.fst', bytes: 64_482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
        { path: 'phone.fst', bytes: 88_630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
        { path: 'tokens.txt', bytes: 331, sha256: '34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402' },
      ],
    },
  }

/**
 * 这一档的模型本版有没有应用内下载包。界面上「去按需组件下载它」这句话能不能说，全看这一位：
 * componentService 的 SPECS 按同一个位决定那一行的按钮，缺包时把用户领到一行灰按钮前面是更坏的答案。
 */
export function hasInAppModelDownload(engine: LocalTtsEngineId): boolean {
  return Boolean(UPSTREAM_MODEL_SOURCES[engine])
}

/** 这批文件的总字节，就是「要下多少」的那本账 */
export function upstreamTotalBytes(source: UpstreamModelSource): number {
  return source.files.reduce((sum, file) => sum + file.bytes, 0)
}

/**
 * 整份表的指纹：把「路径:内容指纹」按路径排序后串起来再取一次 sha256。
 * installed.json 记的就是它——它变了而磁盘上的文件没变，说明钉的那份表被改过，界面该提示重新取一次。
 * 用排序是因为表里的书写顺序不该影响指纹。
 */
export function upstreamTableDigest(source: UpstreamModelSource): string {
  const lines = source.files
    .map((file) => `${file.path}:${file.sha256}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(`${source.repo}\n${source.commit}\n${lines}\n`).digest('hex')
}
