# Vv Transcribe

一款基于 Electron 的桌面端音视频转写应用，支持本地/云端 ASR 语音识别、参考稿逐字比对、本地校对与 AI 校对、段落级播放同步、字幕配音和多格式导出。

## 功能特性

- **文件导入**：拖拽或点选本地文件，音频+视频白名单共 31 项（14 种音频 + 17 种视频：MP3/WAV/M4A/FLAC/AIFF/AC3、MP4/MKV/MOV/AVI/WebM/FLV/WMV/TS/M2TS/MXF 等，含广电常见的 MXF 与磁带采集容器）；能否真正解出音轨由 ffprobe 判定
- **链接取内容**：粘贴公开视频链接后**先只解析元信息**（标题 / 时长 / 体积估算 / 清晰度档位），界面在中间态让用户二选一——「转写音频」只取音频轨转 MP3 后汇入同一条转写流，「下载视频」按选中的档位取画面与音频合并 MP4、下满后走系统「另存为」写到用户选的位置。取内容过程中界面给的是实测进度（第 n/2 路 / 合并音视频轨 / 转码中 + 速度与剩余时间），并留「取消下载」入口。合规口径写在界面上：只能取公开视频，需要登录或会员的（抖音、B 站会员片、部分 YouTube）拿不到音频，请先在本地下载好再走「本地文件」上传。内置的这版解析组件还能在「设置 → 关于与更新」里直接更新，站点改规则不必重装应用
- **ASR 语音转写**：引擎由设置里的「转写模式」决定——默认「本地转写」（Python faster-whisper，音频不出本机），显式切到「云端优先」且填了 API Key 才走 OpenAI 兼容的 Whisper 接口，云端失败时回落本地。进度按 NDJSON 逐句流式上屏，可随时取消
- **转写语言**：12 种语言可选（zh/en/ja/ko/th/vi/id/fr/de/es/ru/ar），本地与云端共用这一设置；刻意不提供「自动检测」
- **参考稿比对**：上传播出稿（TXT/Markdown/SRT/DOCX/PDF）后与转写结果逐字 diff，差异高亮，还可用 AI 逐处解释
- **双方式校对**：本地校对用常见同音误听表 + 内置中文词库给修正与词义提示，不需要任何 API Key；AI 校对调用您配置的模型结合上下文分析。两者都只提建议，逐条「采纳」才生效。非中文素材没有可用的中文规则，此时只走 AI 校对
- **音视频播放器**：播放/暂停、进度拖拽 seek、段落高亮同步，视频文件内嵌播放
- **段落编辑器**：行内编辑转写文本，点击段落跳转到对应播放时间
- **多格式导出**：SRT 字幕 / 纯文本 TXT / JSON 数据 / Markdown 文档，走系统「另存为」面板
- **字幕配音**：转写结果页点「配音」，先试听一句确认音色，再逐段串行调用 OpenAI 兼容的音频接口（一段一次请求），产物由 FFmpeg 按字幕时间轴铺成**一条独立的 MP3 配音轨**（44.1kHz 单声道）。段与段之间不重叠也不截断：某段配音比它的字幕槽位长就顺延到后面、整条往后推，结果页会写明几段被顺延、这条轨比原时间轴长多少——**字幕与时间轴一个字都不改**。跑完走系统「另存为」存成 MP3，不保存就关窗删掉这批产物。空段落不调接口；连续 3 段失败自动熔断停下整批；「取消」只停后面的段，已合成的照样拼成一条轨
- **设置持久化**：转写与校对配置写入 `userData/settings.json`，点「保存设置」才生效；保存后窗口不关，可以直接接着点检测。转写页在云端模式下是「测试连接」、本地模式下是「检查引擎状态」，校对页是「测试连接」——都不保存也能先试一次
- **密钥加密落盘**：两把 API Key 走系统密钥库（macOS 钥匙串 / Windows DPAPI）加密后写进同一份 `settings.json`，磁盘上的值形如 `v1:<base64>`。输入框不回显已保存的值：留空＝不改，「清除已保存的 Key」要点「保存设置」才生效。历史明文在首次读到时就地换成密文；这台机器用不了密钥库时退回明文落盘并在设置里如实标注，读不出密文（换过电脑）时提示重新填写——任何一步都不会静默丢掉用户填的 Key
- **故障自救**：本地引擎没能起来时在「设置 → 转写配置」点「重启本地引擎」，不必退出应用；「关于与更新 → 打开日志文件夹」直接取日志
- **词典更新**：内置开源中文词库；「校对配置 → 检查更新」发现新版会直接下载并装上，当场生效，不需要重装应用

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 44 |
| 前端框架 | React 19 + TypeScript 6 |
| 构建工具 | Vite 8 + vite-plugin-electron（主进程一并打包成 `dist-electron/`） |
| 样式 | Tailwind CSS 4 + 自写全局样式，明/暗双主题 |
| UI 组件 | lucide-react 图标 + 自研轻量组件（Toast / Dropdown / Popover），不依赖重型组件库 |
| 状态管理 | Zustand 5 |
| 路由 | React Router 7（HashRouter） |
| 音频处理 | FFmpeg（fluent-ffmpeg + @ffmpeg-installer / @ffprobe-installer） |
| ASR 转写 | Python faster-whisper（本地，FastAPI + NDJSON 流式）/ OpenAI 兼容 Whisper 接口（云端） |
| 校对 | 本地规则校对（误听表 + chinese-xinhua 词库 + 参考稿 diff）/ OpenAI 兼容大模型接口 |
| 配音（TTS） | OpenAI 兼容音频接口 `POST {apiBase}/v1/audio/speech`（一次一句）+ FFmpeg 铺轴拼接（每段先解成 44.1k 单声道 PCM 量准长度，再按时轴垫静音 `concat` 串成一条，`libmp3lame` 192k 输出） |
| 文本比对 | diff 库 + 自写段落对齐（`segmentDiff` / `textAlignment`） |
| 参考稿解析 | mammoth（.docx）、pdf-parse（.pdf）、自写 SRT/Markdown 解析 |
| 链接转写 | yt-dlp（随包内置，可在应用内更新）+ puppeteer-core 取站点 cookies |
| 中文词典 | pwxcoo/chinese-xinhua 开源词库 |
| 打包分发 | electron-builder 26（macOS DMG / Windows NSIS）+ GitHub Actions 三目标构建（Win x64、macOS arm64、macOS x64） |
| 代码质量 | ESLint 10 + typescript-eslint + Prettier 3 |

## 项目结构

```
basic_one/
├── electron/                          # Electron 主进程（vite-plugin-electron 打包进 dist-electron/）
│   ├── main/
│   │   ├── index.ts                   # 入口：建窗、开屏阶段状态、随应用启动/关闭本地引擎
│   │   ├── types/ffmpeg.d.ts          #   @ffmpeg-installer / @ffprobe-installer 的类型声明
│   │   ├── ipc/                       # IPC 处理器层（ipc/index.ts 统一注册）
│   │   │   ├── fileHandlers.ts        #   文件选择/元数据/音频提取/参考稿读取/另存为/打开日志目录
│   │   │   ├── asrHandlers.ts         #   转写任务：开始、取消、应用内重启引擎、进度推送
│   │   │   ├── aiHandlers.ts          #   AI 校对、差异解释、参考稿分析
│   │   │   ├── proofreadHandlers.ts   #   本地校对与规则解释（完全不读 API Key）
│   │   │   ├── ttsHandlers.ts         #   配音：试听、整批合成、进度推送、取消、另存为、释放这批
│   │   │   ├── settingsHandlers.ts    #   设置读写 + 「测试连接」
│   │   │   ├── dictionaryHandlers.ts  #   词典查询、版本检查、更新下载
│   │   │   ├── updateHandlers.ts      #   版本号、检查更新、外链与系统设置入口
│   │   │   └── windowHandlers.ts      #   自绘标题栏：最大化 / 最小化 / 关闭
│   │   └── services/
│   │       ├── audioProcessor.ts      #   FFmpeg 提取 16kHz WAV、探测、临时目录清理
│   │       ├── asrServiceManager.ts   #   引擎子进程生命周期：bootId 握手 / 残尸回收 / 进程树关闭 / 应用内重启
│   │       ├── asr/                   #   转写 provider：types、asrManager（按「转写模式」分流）、
│   │       │                          #     cloudASR（OpenAI 兼容）、localASR（读 NDJSON 逐句流）
│   │       ├── ruleProofread.ts       #   误听表 + 词库的规则校对
│   │       ├── localProofread.ts      #   本地校对编排（误听表 + 词库 + 参考稿 diff）
│   │       ├── asrErrorMap.ts         #   常见同音误听表与易混词辨析数据
│   │       ├── dictionaryService.ts   #   中文词典加载 / 查询 / GitHub 更新
│   │       ├── ai/                    #   AI 校对：types（Provider 接口）+ openaiCompatible
│   │       │                          #     中文走误听表 + 词典 prompt，其他语言走通用 prompt
│   │       ├── ttsService.ts          #   配音：逐段合成落盘 + 解码量准时长 + 铺轴（溢出顺延）+ 静音垫 concat 拼成整轨（命令行超预算时分块）
│   │       ├── referenceParser.ts     #   参考稿解析：txt / md / srt / docx / pdf
│   │       ├── urlDownloader.ts       #   链接取内容：`-J` 解析元信息 + 会话表 + 音/视频两路 args + 进度与看门狗 + 另存为 + 临时目录回收
│   │       ├── ytDlpUpdate.ts         #   链接解析组件的应用内更新：读清单→校验指纹→落盘→重探版本→失败退回
│   │       ├── browserCookieFetcher.ts#   用 puppeteer-core 起一份空白临时配置取站点 cookies
│   │       ├── connectionTestService.ts # 「测试连接」：分别探云端接口与本机引擎
│   │       ├── settingsService.ts     #   userData/settings.json 读写 + 内存缓存；Key 密文落盘，对外只给脱敏视图
│   │       └── logger.ts              #   主进程日志（落 userData/logs/app.log）
│   ├── preload/                       # contextBridge 暴露 window.electronAPI（index.d.ts 是类型声明）
│   └── resources/dictionary/          # 内置词库：ci.json / idiom.json / version.json
│
├── src/                               # React 渲染进程
│   ├── main.tsx / index.css           # 入口与全局样式（Tailwind + 明暗主题变量）
│   ├── router/index.tsx               # HashRouter，业务页只有一个
│   ├── pages/Transcription.tsx        # 上传 / 转写中 / 结果 三态切换
│   ├── components/
│   │   ├── SplashScreen.tsx           #   开屏：只有冷启动播，显示引擎就绪到哪一步
│   │   ├── ErrorPage.tsx              #   路由兜底
│   │   ├── ui/                        #   自研 Toast / Dropdown / Popover
│   │   ├── transcription/             #   FileUploader（本地 / 链接两个 Tab）、UploadStatus、AudioPlayer、
│   │   │                              #     TranscriptEditor、SegmentRow、DiffPanel、ProofreadModeDialog、TtsDialog
│   │   └── settings/SettingsModal.tsx #   转写配置 / 校对配置 / 主题 / 关于与更新
│   ├── stores/                        #   useTranscriptionStore、usePlayerStore、useReferenceStore、
│   │                                  #     useSettingsModalStore、useThemeStore（均 Zustand）
│   ├── hooks/useElectronAPI.ts        #   非 Electron 环境的安全降级
│   ├── types/                         #   transcription.ts、reference.ts
│   └── utils/                         #   asrLanguage（12 语种 + 本地校对适用性）、segmentDiff、textAlignment、
│                                      #     correctedTextAlignment、referenceComparator、exportTranscript、
│                                      #     readiness（阻塞项统一提示）、logger
│
├── python-asr/                        # 本地转写服务：main.py（FastAPI，协议 2 = NDJSON 逐句回传）
│   ├── vv-asr-server.spec             #   PyInstaller 配置（非 Python 资源必须在 datas 里显式列出）
│   ├── requirements.txt               #   faster-whisper / fastapi / uvicorn / python-multipart / pyinstaller
│   └── dist-<arch>/                   #   按架构产出的 vv-asr-server[.exe]，开发模式也用它
│
├── yt-dlp-manifest.json               # yt-dlp 组件的版本+指纹清单（构建期与运行期读同一份；改它=改往包里塞什么）
├── scripts/                           # build-asr.mjs（按 --arch 选 venv 与产物目录）、fetch-yt-dlp.mjs（校验 SHA2-256）、
│                                      #   yt-dlp-manifest.mjs + lib/（pnpm check:yt-dlp-manifest：与上游 sums 逐条对账）
├── vendor/yt-dlp/                     # 拉下来的官方独立二进制（已 gitignore，构建时进包）
├── release/                           # 最终安装包（Vv-Transcribe-arm64.dmg 等）
├── .github/workflows/build.yml        # CI：build（Win x64 + macOS arm64/x64 三个目标）+ release（tag 触发，
│                                      #   先校验 tag 在 main 上、package.json 版本 == tag，再发 .dmg/.exe）
├── electron-builder.cjs               # 打包配置 + afterPack（ASR 架构、yt-dlp 是否进包）
├── vite.config.ts                     # React + Tailwind + vite-plugin-electron
└── package.json                       # version 与全部脚本
```

## 架构设计

### 进程模型

```
┌──────────────────────────────────────────────────────────────┐
│ React 渲染进程                                                │
│  Transcription 页：FileUploader（本地/链接）→ UploadStatus →  │
│    AudioPlayer + TranscriptEditor（DiffPanel、校对弹窗、导出）│
│  SettingsModal：转写配置 / 校对配置 / 主题 / 关于与更新      │
│  Zustand：transcription · player · reference · settingsModal ·│
│            theme                                              │
└──────────────────────┬───────────────────────────────────────┘
                       │ window.electronAPI（preload contextBridge，无 nodeIntegration）
┌──────────────────────┴───────────────────────────────────────┐
│ Electron 主进程                                               │
│  IPC：file · asr · ai · proofread · settings · dictionary ·   │
│       update · window                                         │
│  服务：audioProcessor（FFmpeg）· asrServiceManager（引擎生命  │
│       周期）· asr/localASR · asr/cloudASR · ruleProofread ·   │
│       localProofread · ai/openaiCompatible · dictionaryService│
│       · referenceParser · urlDownloader · browserCookieFetcher│
│       · connectionTestService · settingsService · logger      │
└───────┬───────────────────────┬──────────────────────┬────────┘
        │ HTTP localhost:8000   │ spawn                │ HTTPS（云端转写/校对要显式配置才走；
        │                      │                      │ 链接转写、词库检查更新按用户操作发起）
┌───────┴───────────┐  ┌────────┴─────────┐  ┌─────────┴────────────┐
│ Python ASR 引擎   │  │ yt-dlp（随包）   │  │ 云端 ASR / OpenAI 兼容│
│ faster-whisper    │  │ + 临时浏览器配置 │  │ 大模型接口            │
│ base·int8·CPU     │  │ 取站点 cookies   │  │                      │
│ NDJSON 逐句回传   │  └──────────────────┘  └──────────────────────┘
└───────────────────┘
```

只有主进程直连 8000 与外部接口，渲染层不发任何 `fetch`。密钥也不进渲染层：`settings:get` 返回的是脱敏视图——两把 Key 字段被剔除，只留 `asrKeyStatus` / `aiKeyStatus`（无 / 密文 / 明文 / 解不开）和 `keyEncryptionAvailable` 三个状态位；解密结果只在主进程里用于转写、校对和「测试连接」。引擎由主进程随应用拉起（`bootId` 握手确认应答者是自己这次启动的那个），退出时按进程树优雅关闭。

### 数据流

```
本地文件转写：
  FileUploader（拖拽经 preload 的 webUtils 取路径 / dialog:selectFile 点选）
    → IPC file:getMetadata → 名称、大小、类型，并按主进程白名单判 supported
    → IPC asr:start（带上设置里的「转写语言」）
      → audioProcessor.extractAudio() → ffprobe 确认有音轨 → FFmpeg 转 16kHz WAV（临时目录）
      → asrManager.runTranscription()
          「云端优先」且填了 Key → cloudASR → OpenAI 兼容 /audio/transcriptions
                                   失败则记录原因并回落本地
          其余（默认）           → localASR → POST localhost:8000/transcribe
                                   逐行读 NDJSON，每出一句回调一次
      → IPC asr:progress（percent + segment + stage）→ 逐句上屏、进度按真实音频位置
      → 清理临时目录；asr:cancel 用 AbortController 中断，回 canceled 让界面退回初始态
    → TranscriptionStore → 播放器 + 编辑器

链接取内容（解析与取内容是两步，界面在中间态让用户选「转写」还是「下载视频」）：
  FileUploader（链接 Tab）→ IPC file:resolveMedia
    → browserCookieFetcher：puppeteer-core 起一份系统临时目录里的空白配置取站点 cookies
      （读不到就退回不带 cookies 的请求）
    → urlDownloader：先用内置 yt-dlp 跑一次 `-J` 只取元信息，不下载内容；默认 --impersonate chrome，
      探测到该二进制不支持 curl_cffi 时自动去掉这个 flag。这一步 45 秒没返回就中断并报「站点 45 秒没有响应」
    → buildMediaInfo 把 formats 拆成「只有画面 / 只有声音 / 画面声音打包在一起」三路，据此给出
      「转写音频」的体积估算与可选清晰度档位（档位体积 = 该路画面 + 那一路音频；没有纯音频轨时按整片估）
    → 直播场次在这里就被拒掉（取到的是无限流，既不能下载也不能转写）
    → 会话（sessionId + 临时目录 + cookies + 公共参数）存进主进程 sessions 表，渲染层只拿到 id
  用户选一条 → IPC file:downloadMedia（kind='audio' | 'video' + height）
    → 音频：`-f bestaudio[ext=m4a]/bestaudio/best -x --audio-format mp3 --audio-quality 0`
      视频：`-f bestvideo[height<=H]+bestaudio/best[height<=H]/best --merge-output-format mp4`
      （不落盘字幕/封面，产物路径优先认 yt-dlp 自己打印的 Destination/Merger 行，扫目录只兜底）
    → 主进程逐行读 yt-dlp 输出，经 IPC file:mediaProgress 推 `{ stage, streamIndex/streamCount, percent, speed, eta }`
      到界面（下载中 / 第 n/2 路 / 合并音视频轨 / 转码中），百分比来自实测字节，不做假进度
    → 兜底两条：45 秒拿不到元信息、180 秒 yt-dlp 完全没输出（站点限速或代理不稳）各自给人话报错；
      180 秒这个数字改了文案也跟着改（报错里的秒数是从常量算出来的）
    → 中途可 IPC file:cancelMediaDownload（SIGTERM），回 canceled，界面退回二选一、会话留着可以再点一次
    → 音频直接汇入上面同一条转写流；视频下载完成后 IPC file:saveMediaAs 弹系统「另存为」，
      复制目标位置后释放会话——**取消保存同样释放会话**（渲染层此刻已经丢了句柄，不还会话就是纯泄漏）
    → 临时目录（媒体 + cookies）的四种还法，按「谁还会用这份文件」区分：
        不再用这条链接（换链接 / 切回「本地文件」Tab / 组件卸载）→ IPC file:releaseMediaSession 立刻整目录删掉
        「转写音频」→ 只删 cookies（asr:start 提取出 wav 之后 dropMediaSessionCookies），媒体留着给播放器
                     逐句回放；下一段素材开工时 releaseMediaSessionsExcept 回收上一份，本次这份留到退出应用
        退出应用 → before-quit 里 releaseAllMediaSessions 收尾（进程被强杀走不到这步，由下面这条兜底）
        下次启动 → sweepStaleMediaTempDirs 回收 mtime 超过 24 小时且不在 sessions 里的 `transcribe-*`
      取 cookies 那份无头浏览器临时配置目录由 browserCookieFetcher 自己删，不留在这张表里
    → 失败时把英文报错翻成「下一步该做什么」（站点风控 / 私有视频 / 无音轨 / 未授权执行），
      并提供「改传本地文件」一键切回本地 Tab

校对（两条独立通道，都只给建议，改动要逐条采纳）：
  TranscriptEditor 的「校对」按钮
    → 没有校对模型：不弹选择框，直接 IPC proofread:local
        ruleProofread/localProofread：误听表逐段修正 + 中文词库释义提示 + 参考稿 diff
        完成提示会说明「为什么只有本地结果」以及去哪配模型
    → 已配模型：弹 ProofreadModeDialog 选「本地校对」或「AI 校对」
        本地 → proofread:local，差异解释走 proofread:explain（全程不读 Key）
        AI   → ai:correct，差异解释走 ai:explainDifferences（每 50 条一批）
              prompt 里先套一遍误听表 + 词库释义（buildDictionaryContext），
              非中文走通用 prompt
    → 非中文素材：hasLocalProofreadRules(language) 为假，本地这条路不成立——
        没配模型时提示去「校对配置」，配了模型则在选择框里把「本地校对」置灰并写明原因

参考稿比对：
  上传参考稿 → IPC file:readTextFile → referenceParser（txt / md / srt / docx / pdf）
    → textAlignment 段落对齐 + segmentDiff 逐字比对 → DiffPanel 标出差异
    → 可选 ai:analyzeReference 让模型通读参考稿找自身问题

配音（一次调用只合成一句，整条稿子串行跑完再拼成一条轨；字幕与时间轴一个字都不改）：
  TranscriptEditor 的「配音」按钮 → TtsDialog 三段走
    确认：段数 / 字数 + 在用的模型与音色 + 「试听一句」（默认取第一段，可改文本）
      → IPC tts:preview → POST {apiBase}/v1/audio/speech（response_format=mp3）→ 落盘 → ffprobe 读时长（只给这一句的显示用）
      接口地址与 Key 沿用校对那一套，模型与音色是另两个独立值：音频接口吃的是配音模型 id，
        拿 chat 模型去调必然被拒，所以开工前置校验单独查这两项，缺任何一项都不发起整批调用
    进行中：IPC tts:synthesize 一次带走全部段落（时间轴只有渲染层这一份，主进程按 jobId 记账）
      → 逐段**串行**调接口（并发只会换来 429），每段落进 `transcribe-tts-<uuid>/`
      → 段号经 IPC tts:progress 推回界面，写的是「已合成 7 / 12 段」这种真实段号
      → 空段落跳过不调接口；单段 60 秒超时；连续 3 段失败熔断停下整批（原因与「用户点了取消」分开报）
      → 「取消」只停后面的段，正在飞的那段等它回来，已经合成的照样拼成一条轨
    铺轴与拼接：每段落点 = max(该段字幕起点, 上一段配音终点)，配音比字幕槽位长就顺延、整条往后推
      （不截断也不重叠混音；某段解出来一个采样都没有才退回按字幕槽位估长，并在结果里标明有几段是估的）
      → 每段先单独解成 44.1k 单声道 PCM：时长用自己的样本数量，不用 ffprobe 报的 mp3 容器长度
        （那是按码率估的、含 LAME 前后填充——实测 0.5 秒的片段报成 0.549 秒，串联拼接会一段一段把它累起来）
      → 再按时轴拼：段前垫 `anullsrc` 静音、一路一路 `concat` 串起来。不用 `adelay`+`amix`：
        包进安装包的 win32-x64 / darwin-x64 那两个 ffmpeg 是 2018-12 的构建，`adelay` 没有 all 选项、
        `amix` 没有 normalize，那张图在这两个平台上直接退码 1（mac arm64 的 4.4 能跑，所以只在 Mac 上试过就等于没试）
      → 一次 ffmpeg 只背「每段一个 `-i 路径`」，按 24000 字符切块（Windows CreateProcess 上限 32767）；
        多块时先各落一个无损 WAV、最后一轮只把块串起来编码。graph 写进文件用 `-filter_complex_script` 传
      → `libmp3lame -b:a 192k` 出一条 `voice-track.mp3`（整条只在最后重编码一次，不 mp3→mp3 来回掉质量）
    结果：配音轨时长与体积、原时间轴到几点、这条比它长多少、几段被顺延、成功/失败/跳过清单
      → 「保存配音轨」IPC tts:saveTrack：系统「另存为」+ copyFile（另存出去的副本不跟着临时目录删）
      → 关弹窗 IPC tts:releaseBatch 当场删掉这批临时目录；没另存出去的产物就到此为止
        （进程被强杀走不到这步，由下次启动的 sweepStaleMediaTempDirs 回收——同一套 `transcribe-*` 前缀）
```

### IPC 通道一览

preload 用 contextBridge 把这些通道包成 `window.electronAPI`，渲染层拿不到 `ipcRenderer` 本身。下表是主进程注册的全部 53 条（49 条 `ipcMain.handle` + 4 条主 → 渲染推送）。

| 通道 | 方向 | 说明 |
|------|------|------|
| `dialog:selectFile` | 渲染 → 主 | 打开音视频文件选择框（按白名单过滤扩展名） |
| `dialog:selectTextFile` | 渲染 → 主 | 参考稿选择框：txt / md / srt / docx / pdf |
| `file:getMetadata` | 渲染 → 主 | 名称/大小/类型，并给出 `supported`——拖拽进来的文件绕过了选择框过滤，白名单以这里为准 |
| `file:probeAudio` | 渲染 → 主 | ffprobe 探测时长与音轨。转写链路由主进程内部直接调用，渲染层目前没有单独调它 |
| `file:extractAudio` | 渲染 → 主 | FFmpeg 提取 16kHz WAV 到临时目录。同上，`asr:start` 内部自己调 |
| `file:cleanupTemp` | 渲染 → 主 | 删除临时目录，任务结束/取消时主进程已自行清理 |
| `file:resolveMedia` | 渲染 → 主 | 链接取内容第一步：跑一次 yt-dlp `-J` 只取元信息（需要时先起无头浏览器取 cookies），回标题/时长/清晰度档位/体积估算，并把会话存进主进程 `sessions` 表，渲染层只拿到 `sessionId` |
| `file:downloadMedia` | 渲染 → 主 | 按会话取内容：`kind='audio'` 取音频轨转 mp3、`kind='video'` + `height` 取画面与音频合并 mp4；进度经 `file:mediaProgress` 推送 |
| `file:mediaProgress` | 主 → 渲染 | 推 `{ sessionId, kind, stage, streamIndex, streamCount, percent, speed, eta }`，界面写「第 1/2 路 · 47% · 4.67MiB/s · 剩余 00:02」；`speed`/`eta` 用 yt-dlp 原样吐的字符串，不自己换算单位 |
| `file:cancelMediaDownload` | 渲染 → 主 | SIGTERM 中断当前那次 yt-dlp，回 `canceled`；会话留着，界面退回二选一还能再点别的档位 |
| `file:saveMediaAs` | 渲染 → 主 | 视频下满后弹系统「另存为」，`copyFile` 到用户选的位置（临时目录在 /tmp、目标盘可能是另一块卷，rename 会 EXDEV，所以是复制不是移动）。**存成功和取消都释放会话**——此时渲染层已经丢了句柄，不还会话就是纯泄漏；只有 `copyFile` 报错那条留着，由渲染层还 |
| `file:releaseMediaSession` | 渲染 → 主 | 删这条链接的临时目录（媒体 + cookies）：换链接、切回「本地文件」Tab、组件卸载三条路都会触发 |
| `file:readTextFile` | 渲染 → 主 | 读取参考稿并按格式解析成纯文本 |
| `file:saveText` | 渲染 → 主 | 系统「另存为」面板写出 SRT / TXT / JSON / MD |
| `ytDlp:getLocal` | 渲染 → 主 | 本机生效的链接解析组件：版本号 + 来源档位 + 实际字节数（要 spawn 一次 `--version`，只在打开「关于与更新」时做） |
| `ytDlp:check` | 渲染 → 主 | 读更新清单比对本机版本；清单/网络读不到时回拼好的中文原因 |
| `ytDlp:apply` | 渲染 → 主 | 下载并装上新版组件（校验指纹、失败自动退回原副本）；有链接在解析时先拒绝 |
| `ytDlp:progress` | 主 → 渲染 | 推送 `{ received, total }` 实测字节数，界面据此写「下载中 a/b」 |
| `app:openLogDirectory` | 渲染 → 主 | 打开 `userData/logs` 取日志 |
| `asr:start` | 渲染 → 主 | 启动转写任务，返回 jobId + 段落，或 `canceled` / 失败原因 |
| `asr:cancel` | 渲染 → 主 | AbortController 中断当前任务并清理临时目录 |
| `asr:progress` | 主 → 渲染 | 推送 `{ jobId, progress, segment, stage }`，逐句上屏 |
| `asr:restartEngine` | 渲染 → 主 | 应用内重启本地引擎；有任务在跑时直接拒绝 |
| `ai:correct` | 渲染 → 主 | AI 校对（含误听表 + 词典 prompt）；失败回 `error`，不静默返回原文 |
| `ai:explainDifferences` | 渲染 → 主 | 参考稿差异逐处解释，每 50 条一批 |
| `ai:analyzeReference` | 渲染 → 主 | 让模型通读参考稿找自身问题 |
| `proofread:local` | 渲染 → 主 | 本地校对：误听表 + 词库 + 参考稿 diff，全程不读 API Key |
| `proofread:explain` | 渲染 → 主 | 差异的规则解释（同上，不需要 Key） |
| `tts:preview` | 渲染 → 主 | 配音试听一句：`POST {apiBase}/v1/audio/speech` 拿 mp3 落进临时目录，回 `{ clip: { filePath, bytes, duration }, error }`；`duration` 是 ffprobe 读出来的时长（mp3 的容器估算，只够给这一句显示用，铺轴不认它），读不到也不谎报。整批之前先花这一次钱，端点/模型/音色任何一样不对都在这一步暴露 |
| `tts:release` | 渲染 → 主 | 删掉刚才那句试听的产物（试听框换内容、关弹窗时调用） |
| `tts:synthesize` | 渲染 → 主 | 整条稿子配音：段落（含时间轴）由渲染层一次传来，主进程不存第二份时间轴、也不用界面报回来的路径。逐段**串行**（并发只会换来 429），空段落直接跳过不调接口，单段 60 秒超时，连续 3 段失败熔断停下整批；跑完按时间轴铺成整轨（每段先解成 PCM 量准长度，再垫静音 `concat`，命令行超字符预算时分块）。回 `{ jobId, track, clipCount, failures, skipped, canceled, abortedReason, error }`——`abortedReason` 只写熔断原因，与「用户自己点了取消」分开报；拼接失败时前面的账目照样带回去，不会抹成「一段都没成」 |
| `tts:progress` | 主 → 渲染 | 推 `{ jobId, stage, index, total, segmentId, note }`，`stage` 五态：`synthesizing` / `skipped` / `failed` / `assembling` / `done`。界面写的是真实段号（「已合成 7 / 12 段」），不做假百分比 |
| `tts:cancel` | 渲染 → 主 | 置取消标志：只停**后面**的段，正在飞的那段等它回来；已经合成的照样拼成一条轨，不白跑 |
| `tts:saveTrack` | 渲染 → 主 | 弹系统「另存为」（默认名 `voice-track.mp3`、MP3 过滤），`copyFile` 到用户选的位置，回 `{ success, canceled, name, error }`。取消不算失败也不释放这批——界面还留着结果态让人再点一次 |
| `tts:releaseBatch` | 渲染 → 主 | 删掉这批的临时目录：关弹窗、组件卸载两条路都会触发；另存出去的那份是副本，跟着目录一起删不掉 |
| `dictionary:lookup` | 渲染 → 主 | 查单个词释义。词库现在由主进程在校对/prompt 组装时内部使用，界面暂无调用点 |
| `dictionary:lookupMultiple` | 渲染 → 主 | 批量查词，同上 |
| `dictionary:getVersion` | 渲染 → 主 | 当前词库 commit hash |
| `dictionary:checkUpdate` | 渲染 → 主 | 只对比远端 commit，判断有没有新版 |
| `dictionary:downloadUpdate` | 渲染 → 主 | 下载远端词库更新 |
| `settings:get` | 渲染 → 主 | 读设置的**脱敏视图**：非密钥字段原样，两把 Key 只给状态（`none`/`encrypted`/`plaintext`/`unreadable`）+ 本机密钥库可用性 |
| `settings:save` | 渲染 → 主 | 写设置（渲染层只在点「保存设置」时调用）。Key 字段三态：非空＝替换、`null`＝清除、留空＝整个键不发送、磁盘上那把不动；只收 `DEFAULT_SETTINGS` 列得出的字符串字段 |
| `settings:testConnection` | 渲染 → 主 | 按表单当前值试一次：`kind='asr'` 探云端接口或本机引擎，`kind='ai'` 探校对接口；表单 Key 留空时回落到已保存的那把（改接口地址不用重贴），密文解不开则直接报错、不发请求 |
| `app:getServiceReady` | 渲染 → 主 | 开屏阶段状态：`asrDone` / `asrError` / `dictionaryDone` |
| `app:log` | 渲染 → 主 | 渲染层日志经 `src/utils/logger.ts` 汇入 `app.log`，两边写在同一份日志里 |
| `app:getVersion` | 渲染 → 主 | 应用版本号 |
| `app:checkUpdate` | 渲染 → 主 | 查 GitHub Release 最新版并与当前版本逐段比较；应用本体不自动装，只给「前往发布页」的链接 |
| `app:contactDeveloper` | 渲染 → 主 | 拼死收件人与正文（应用版本 / 系统 / 取日志说明）后 `shell.openExternal` 打开 `mailto:`；渲染层传不进任何参数 |
| `app:openExternal` | 渲染 → 主 | 用系统浏览器打开外链；只放行 https 且主机在 `github.com` / `vvscribe.com` 白名单内 |
| `app:openSystemSettings` | 渲染 → 主 | 直达 macOS「隐私与安全性」面板（包内二进制被 Gatekeeper 拦下时一键跳转）；非 macOS 返回手动指引文案 |
| `window:toggleMaximize` | 渲染 → 主 | 标题栏双击最大化 / 还原 |
| `window:minimize` | 渲染 → 主 | 自绘标题栏：最小化。macOS 现在用系统红绿灯，界面暂无调用点 |
| `window:close` | 渲染 → 主 | 自绘标题栏：关闭，同上 |

## 快速开始

### 环境要求

- Node.js 22.12+（Vite 8 要 `^20.19.0 || >=22.12.0`，Electron 44 要 `>=22.12.0`；CI 用 22）
- Python 3.10+（本地 ASR 引擎需要；CI 用 3.12，x64 包还要一份 x64 解释器）
- pnpm（推荐）

### 安装依赖

```bash
# 安装前端依赖
pnpm install

# 建立本地 ASR 的 Python 虚拟环境并装依赖（含 PyInstaller）
pnpm setup:asr          # 等价于 python-asr/venv + pip install -r python-asr/requirements.txt

# 编译本机架构的引擎二进制：开发模式也由主进程拉起它，不是跑 main.py
pnpm build:asr
```

### 开发模式

```bash
pnpm dev
```

`pnpm dev` 启动 Electron 时，主进程照样会 spawn `python-asr/dist-<arch>/vv-asr-server[.exe]`（`getBinaryPath()` 在开发模式取的就是这个架构目录），所以先跑过 `pnpm build:asr` 才有本地转写；缺文件时应用会明确报「本地转写引擎文件缺失」。

只有要改 Python 侧代码时才需要另外手动起服务：

```bash
cd python-asr && source venv/bin/activate && ASR_BOOT_ID=$(uuidgen) python main.py
```

不带本次 `ASR_BOOT_ID` 的手动服务虽然照样应答 `/health`，但主进程不会采信它（否则拿到的就是上一代残尸那份「模块找不到」的报错），引擎状态会显示「8000 端口上的转写服务不属于本次启动」。所以调 Python 侧之前要先把应用完全退出——8000 已经被应用自己的引擎占着，手动服务根本 bind 不上。

### 构建打包

ASR 二进制按架构分目录产出（`dist-arm64` / `dist-x64`），electron-builder 根据 `BUILD_ARCH` 选择对应架构的二进制打入安装包。**PyInstaller 无法交叉编译**：产物架构 = 构建它的 Python 解释器架构，因此 x64 包必须用 x64 的 Python 环境构建。`afterPack` 会校验二进制架构，不匹配则中断构建（避免目标机出现 `error -86` / EBADARCH）。

```bash
# 0. 首次：创建本机 Python 虚拟环境并安装依赖（含 PyInstaller）
pnpm setup:asr

# 1. 编译本机架构的 ASR 二进制（arm64 Mac → python-asr/dist-arm64/）
pnpm build:asr

# 2. 构建 Electron 安装包
pnpm build:electron:arm64     # 产出 release/Vv-Transcribe-arm64.dmg

# 或一步完成（ASR + 安装包）
pnpm build:mac:arm64
```

`build:electron*` 第一步会执行 `scripts/fetch-yt-dlp.mjs`：按 `yt-dlp-manifest.json` 里钉死的版本与 SHA2-256 拉官方独立二进制，落在 `vendor/yt-dlp/`（已 gitignore，同版本重复构建会跳过下载）。GitHub 慢就换前缀：`YTDLP_MIRROR=https://<加速域名> pnpm build:mac:arm64`。`afterPack` 同样校验它是否进了包，缺了就红。

清单本身用 `pnpm check:yt-dlp-manifest` 与上游 `SHA2-256SUMS` + Release API 逐条对账（版本号、资产名、指纹、体积），CI 把它放在装依赖之前（`Setup Python` 之后、`pnpm install` 之前）——清单写错了，没必要再花三平台的构建时间去发现；网络拉不到上游时用 `--offline` 只验结构。2026-10-25 本机实测：五个资产全部与上游一致（macOS 37.2 MB / win32-x64 17.9 MB / win32-arm64 21.7 MB / linux-x64 40.6 MB / linux-arm64 40.3 MB）。

#### 构建 x64（Intel）DMG —— 在 arm64 Mac 上经 Rosetta

```bash
# 首次：在 Rosetta 下创建 x64 venv（需本机有 x64 Python，可用 PYTHON_X64 指定解释器路径）
pnpm setup:asr:x64

# 构建 x64 ASR 二进制（dist-x64）+ x64 DMG
pnpm build:mac:x64            # 产出 release/Vv-Transcribe-x64.dmg
```

#### 构建 Windows 安装包

Windows 无法在 macOS 上交叉构建（PyInstaller 与 electron-builder 均需在 Windows 原生执行）。项目提供 GitHub Actions 工作流 [`.github/workflows/build.yml`](.github/workflows/build.yml)，在 `windows-latest` 上免费构建，产物见 Actions 运行结果的 Artifacts。也可在 Windows 本机执行：

```bash
python -m venv python-asr/venv
python-asr/venv/Scripts/pip install -r python-asr/requirements.txt
node scripts/build-asr.mjs --arch=x64   # 产出 dist-x64/vv-asr-server.exe
pnpm install && pnpm build && pnpm build:electron:win
```

#### Python ASR 打包流程

```
python-asr/main.py + dependencies
  → scripts/build-asr.mjs（按 --arch 选择 venv 与 dist 目录，macOS 跨架构经 Rosetta）
    → PyInstaller (vv-asr-server.spec，site-packages 经 sysconfig 动态解析)
      → python-asr/dist-<arch>/vv-asr-server[.exe]
        → electron-builder extraResources（按 BUILD_ARCH 选择对应架构目录）
          → Vv Transcribe.app/Contents/Resources/python-asr/vv-asr-server
```

- 开发模式：读取 `python-asr/dist-<arch>/vv-asr-server[.exe]`（arch = `process.arch`）
- 打包模式：从 `process.resourcesPath/python-asr/vv-asr-server[.exe]` 启动
- `afterPack` 校验二进制架构（Mach-O / PE），与 `BUILD_ARCH` 不符则构建失败
- 端口 8000 上已有应答时，主进程绝不复用：只有应答里的 `boot_id` 是本次 spawn 下发的那个、且 `protocol` 对得上才算就绪。应答者若是上一代强杀留下的残尸，会先按进程名认领、确认后收掉（连同 PyInstaller 引导进程），收不掉才把原因推给用户；别人的服务占着 8000 则直接提示端口被占用
- 引擎 spawn 时 `detached` 自成一个进程组，退出时对整个进程组发 SIGTERM，超时升级 SIGKILL；Windows 走 `taskkill /T /F`。是否「模型已缓存」按设置里选的那个档位判定（看 HF 缓存里的 `models--Systran--faster-whisper-<档位>/snapshots`）：命中才给引擎下发 `HF_HUB_OFFLINE=1`，免得弱网时卡在「有没有新版本」的在线请求上；切到没下过的档位时不下发，否则那次首下会被自己掐死

## 配置说明

### 转写配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 转写模式 | `local`（「本地转写（默认）」）/ `cloud`（「云端优先（需配置 API Key）」） | `local` |
| 本地模型档位 | `asrLocalModel`，本地引擎用哪一档 Whisper：`base`（「快速」，权重约 138MB）/ `small`（「精准」，约 461MB，本机实测耗时约为快速档的 2.8 倍）。只在转写模式不是 `cloud` 时显示；这个值和下面的「模型」无关，后者是云端服务商的型号名 | `base` |
| 转写语言 | `asrLanguage`，传给 Whisper 的语言码，共 12 种（zh/en/ja/ko/th/vi/id/fr/de/es/ru/ar）；刻意不提供「自动检测」 | `zh` |
| API Base URL | 云端 ASR 接口地址 | 空 |
| API Key | 云端 ASR 密钥。输入框不回显已保存的值：留空＝不改，「清除已保存的 Key」要点「保存设置」才生效；保存时经系统密钥库加密后写入，磁盘上形如 `v1:<base64>` | 空 |
| 模型 | ASR 模型名称 | 空（默认 whisper-1） |

接口地址不用自己补版本段：主进程会先 `trim` 去尾斜杠、再去掉尾巴上的 `/v1`，然后拼 `${apiBase}/v1/audio/transcriptions`。所以填 `https://example.com`、`https://example.com/v1` 或 `https://example.com/v1/` 都指向同一个端点。

- **只有「转写模式 = 云端优先」且填了云端 API Key，音频才会发出本机。** 默认的本地模式不发起任何网络转写请求；AI 校对的 Key 只处理文本，不会上传音视频。配音同理——发出去的是逐段的字幕文本（外加试听那一句），回来的才是音频，所以**文本会离开本机**，目的地就是「校对配置」里填的那个接口地址。已保存但在这台机器解不开的 Key 不算「填了」：开工前置校验会当场拦住并说明原因，不会带着空 `Authorization` 去打接口。
- 本地转写依赖内置的 Python ASR 引擎：打包后自动拉起，开发模式同样由主进程 spawn `python-asr/dist-<arch>/` 里的二进制（所以要先 `pnpm build:asr`，见「快速开始」）。引擎没能应答时，转写会直接给出原因而不是 `fetch failed`，并引导到「设置 → 转写配置」的「重启本地引擎」——它先 stop 再 start，`bootId` 每次 spawn 重新生成，所以不会把上一代残尸认成自己的引擎；重启进行中按钮显示「重启中…」，连点会被合并成一次，避免两个引擎抢 8000。有转写任务在跑时该操作被拒绝，避免打断正在出的字幕。
- 换档位就是换引擎内存里的那个模型，而 `HF_HUB_OFFLINE` 只能在 spawn 之前决定，所以点「保存」时档位变了会自动重启一次本地引擎，提示「设置已保存，本地引擎已按新档位重启」。两种情况不重启、也给人话提示：有转写正在跑（重启会截断正在推的 NDJSON 流，半截结果比报错更糟，提示让你等这次转写结束后手动点「重启本地引擎」）、自动重启失败。首次下载的体积提示不再写死数字：引擎在 `status` 事件里把档位和权重体积（`base` 138MB / `small` 461MB）一起下发，进度页直接用它，避免 JS 和 Python 两处数字各说各话。
- 「设置 → 转写配置 → 引擎状态」里的当前档位报的是引擎自己回显的那个（`/health` 的 `model` 字段），不是表单里还没保存的值——不然会让人以为切换已经生效了。
- 转写语言是中文时，本地和云端的结果都做一次繁→简归一（`opencc-js` 的 `tw→cn`，只在真的转出中文时才建字典，实测首次 4ms、之后每次不到 2ms）：`small` 档实测会漂繁体，而下游的误听表、词库和参考稿 diff 全按简体比对，不归一就会漏匹配。

### 链接转写

链接解析用的 **yt-dlp** 已随安装包内置（构建时由 `scripts/fetch-yt-dlp.mjs` 拉官方独立二进制并校验 SHA2-256），使用者不需要再自行安装。应用按下面的顺序取第一个存在的路径：

1. `<userData>/bin/yt-dlp[.exe]` —— 应用内更新写下的副本
2. 安装包内置：`Contents/Resources/yt-dlp/yt-dlp`（Windows 为 `resources/yt-dlp/yt-dlp.exe`）；开发模式取仓库里的 `vendor/yt-dlp/<平台目录>/`
3. 本机安装的 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`（仅 macOS）
4. PATH 上的 `yt-dlp`；全都找不到时，链接转写会提示上面的安装命令

内置包是官方 standalone 构建，自带 `curl_cffi`，所以 `--impersonate chrome`（TLS 指纹模拟）默认可用；第 3/4 档命中的 Homebrew 版本通常没有它，应用会探测后自动降级为不带浏览器模拟的请求。
部分带风控的站点还需要浏览器 cookies 才能解析，应用会先用无头浏览器取 cookies 再重试。

#### 组件在应用内更新

yt-dlp 每隔几周就要跟着站点改解析规则，而安装包里的这一版是发布那天钉死的。所以「设置 → 关于与更新 → 链接解析组件」把这版组件做成可以不重装就换掉：

- **显示的是实测值**：本机生效那份的版本号、来自哪一档（应用内更新过 / 安装包内置 / 本机安装 / PATH）、以及磁盘上的实际字节数。版本号是 spawn 一次 `--version` 探出来的，探不到就写「版本未知」并照样允许试更新，不谎报「已是最新」。
- **清单在仓库里**：`yt-dlp-manifest.json`（`main` 分支根目录）记 `version` / 每平台的 `upstream` 资产名 / `sha256` / `bytes`，是人工核对后提交的常量。读取顺序是先 `raw.githubusercontent.com`、失败再退 `api.github.com` 的 contents 接口。构建期的 `scripts/fetch-yt-dlp.mjs` 和 `pnpm check:yt-dlp-manifest` 读同一份，安装包与应用内更新不会各说一套版本。**清单还没合进 `main` 时这条链路会如实报「更新清单读取失败（两个入口分别：更新服务器返回 404 …）」**——本机实测过。
- **下载 URL 由主进程拼死**：`https://github.com/yt-dlp/yt-dlp/releases/download/<version>/<asset>`，清单里没有 URL 字段，版本号与资产名各自过正则，所以换掉清单也指不到第三方服务器。剩下的边界是「能改这个仓库的人可以同时换掉清单和官方产物」（同源自证，记在 #182）；构建期那道与上游 `SHA2-256SUMS` 对账的关只覆盖安装包，覆盖不到用户机器上的这次下载。
- **装法是事务式的**：下到 `.part`、边下边算 SHA2-256，字节数与指纹都对上才 `chmod 755` → 旧副本挪去 `.prev` → `.part` 改名转正 → 重探一次 `--version`。版本不符或根本跑不起来就换回 `.prev`，并把「安装包内置的那份仍然可用」说清楚；任何一种失败都不会留下半个二进制。
- **进度与原因都说人话**：下载按实测字节推「下载中 a/b」，不做假百分比；20 分钟没下完报的是「约 37MB 在 20 分钟内没下完（收到 X MB）」而不是 `The operation was aborted`。失败分三类措辞——网络类才配「可开启网络加速后重试」并带上原始 `net::ERR_*`；清单结构类直接说哪一条不合规矩；完整性类给出收到/应有字节数或两处指纹前 12 位。
- **走 Electron 的 `net.fetch`，不是 Node 全局 `fetch`**：全局那个只认 `HTTP_PROXY` 环境变量，看不见系统代理。本机实测同一个 37MB 资产：直连约 19KB/s（必然撞超时），开着系统代理约 0.5MB/s（一分钟内完成）。这一栏能不能更新完，取决于这里用哪个。
- 有链接正在解析时拒绝更新（Windows 上运行中的 `yt-dlp.exe` 占着文件，改名会失败），提示等它结束。

### AI 校对配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 服务商 | OpenAI / DeepSeek / 通义千问 / 自定义兼容接口；切换时自动填入下面的接口地址与默认模型 | `openai` |
| API Base URL | AI 接口地址，主进程在其后拼 `/v1/chat/completions` | 空（等价 `https://api.openai.com`） |
| API Key | AI 密钥，同样不回显、留空＝不改。没配 Key 时点「校对」不弹选择框，直接走本地通道；有 Key 才弹「本地校对 / AI 校对」——密文在这台机器解不开也算「有」，好在弹窗里撞上明确原因并跳去重填，而不是被「未配置校对模型」误导 | 空 |
| 模型 | AI 模型名称 | 空（默认 `gpt-4o-mini`；预设 DeepSeek=`deepseek-chat`、通义千问=`qwen-plus`） |
| 配音模型 | `aiTtsModel`，配音用的模型 id，与上面的「模型」**不是同一个值**：音频接口要的是配音模型，填 chat 模型会被直接拒。服务商预设里只有 OpenAI 预填（`tts-1` + `alloy`），其余留空——留空＝切换服务商时**不动**用户已填的配音配置（走聚合网关的人，音色 id 是自定义的，被下拉框一键清掉比不清更容易丢配置） | 空（不自动回落默认值，缺就报「还没填」） |
| 配音音色 | `aiTtsVoice`，各家格式不同（OpenAI 是 `alloy` / `onyx` 这类短名，有的网关要求带模型前缀），照服务商文档原样填。整条配音用同一个音色，暂不支持逐段换 | 空 |

配音与校对**共用同一套接口地址与 API Key**（`getTTSConfig()` 读的就是 `aiApiBase` / `aiApiKey`），只有模型和音色分开存；接口地址同样先 `trim` 去尾斜杠、再去掉尾巴上的 `/v1`，然后拼 `${apiBase}/v1/audio/speech`。

### 配音（TTS）

- **能用什么接口**：只实测了 OpenAI 标准的音频端点 `POST {apiBase}/v1/audio/speech`（body 为 `{ model, input, voice, response_format: 'mp3' }`，返回体直接是音频字节）。返回 JSON 会被当成失败并把 body 前 200 字带进报错，而不是当成一段空音频；404 会额外说明「这家可能没有这个端点，或 API Base 少/多层路径」，401 说明「Key 不对或没有该模型权限」。**只做对话的模型服务通常没有这个端点**，能不能配音以服务商文档为准——界面不承诺通用。
- **前置校验单独查配音这两项**：`checkVoiceReady()` 缺 Key、缺配音模型、缺音色任何一样都当场拦住，不会带着空值去点「开始配音」烧用户额度。
- **计费与耗时**：逐段串行，一段一次请求，按服务商计费方式扣费；整条耗时取决于接口响应速度。弹窗确认页把段数、字数和「另外 n 段是空的，不会调用接口」写在点下去之前，并提供「试听一句」。
- **产物是一条独立音轨**：MP3（44.1kHz 单声道、192k），按字幕时间轴铺开。某段配音比它的字幕槽位长就顺延到后面，整条往后推——不截断、不做重叠混音。所以**这条轨可能比原时间轴长**，结果页会给出「配音轨 00:42 / 原时间轴到 00:27，这条比它长（差 00:14）/ n 段配音比字幕槽位长，已顺延到后面」，并写明「字幕与时间轴没有改动，这是一条独立的音轨」。越到后面偏差越大，对画面时要以这条轨为准重铺字幕，而不是直接盖在原时间轴上。
- **失败与取消**：连续 3 段失败即熔断停下整批（熔断原因与「用户自己点了取消」分开报），失败清单在结果页逐段可看；「取消」只停后面的段，已经合成的照样拼成一条轨。一段都没成时不会谎报成功，报的是前面那批的真实账目。
- **产物只有一份留在用户手上**：中间片段与整轨都写在 `$TMPDIR/transcribe-tts-<uuid>/`，关弹窗当场整目录删掉；要留下必须点「保存配音轨」走系统「另存为」。进程被强杀没走到那一步时，由下次启动的临时清扫回收（`transcribe-*` 前缀、mtime 超 24 小时）。

### 本地词典

- 数据来源：[pwxcoo/chinese-xinhua](https://github.com/pwxcoo/chinese-xinhua)
- 包含词语（ci.json）和成语（idiom.json）释义；「校对配置 → 本地词典」显示当前版本号（内置是 `1.0.0`，更新过后换成源仓库 commit 短哈希）
- 加载优先级：`userData/dictionary/`（更新后的副本）> `resources/dictionary/`（内置）
- 更新机制：按 `data/ci.json` 的最近 commit hash 判断有没有新版，有就直接拉 `ci.json` / `idiom.json` 写入 `userData/dictionary/`、清缓存重载，当场生效。连不上 GitHub 会如实报错，不会当成「已是最新」

## 注意事项

- 本地转写跑的是 Python 引擎二进制：打包后由应用自动拉起，开发模式要先生成 `python-asr/dist-<arch>/`（`pnpm setup:asr` + `pnpm build:asr`），详见「快速开始」
- 引擎第一次转写会向 hf-mirror.com 下载所选档位的 Whisper 权重（本机 HF 缓存实测：`base` 的 `model.bin` 138MB、`small` 461MB），弱网时这一步可能超时——那时不是模型坏了，报错会这么说；只有失败事件里带的 `stage` 是 `loading_model` 时才这么报，ffmpeg 抽音频失败会原样带出原因（改之前 JS 只看最后一次 `status` 的阶段，抽音频失败也会被误报成「模型没下完」，把人往错的网络上引）。模型已在本地缓存时改走 `HF_HUB_OFFLINE=1`，不再向镜像站确认版本
- 视频文件播放依赖 `webSecurity: false` 配置，通过 `file://` 协议加载本地文件
- 「校对」不要求 API Key：没配置校对模型时不弹选择框，直接跑本地校对（误听表 + 词库 + 参考稿 diff）；配置了模型才弹「本地校对 / AI 校对」选择框。AI 校对调用失败会给出可见提示，不会静默返回原文
- 本地校对依据的误听表和中文词库只对中文成立：「转写语言」选成其他语言后，没配模型时点「校对」会提示去「校对配置」选模型，配了模型则在选择框里把「本地校对」置灰
- 配音整批是**逐段串行的一次段一次请求**，扣的是用户自己 Key 上的额度，所以点「开始配音」之前先看确认页的段数与字数，并先听那一句——音色不对时第 2 段和第 20 段一样烧钱
- 配音轨可能比原时间轴长（有段落被顺延），这是刻意不截断、不重叠的结果。拿这条轨对画面时**以配音轨为准重铺字幕**，别直接盖在原时间轴上；结果页那句「n 段配音比字幕槽位长」和「差 00:xx」就是给人判断这件事用的
- 编译 Python ASR 二进制需要 PyInstaller，它已列在 `python-asr/requirements.txt` 里（`pnpm setup:asr` 一并装上）；`scripts/build-asr.mjs` 用的是 venv 里的解释器，所以必须先建好虚拟环境
- API Key 的加密时机与退化路径：`settings.json` 里的历史明文在**首次读到设置**时就地换成密文（读到才迁，不是启动就迁——没打开设置页、也没跑过任何读配置的链路时，磁盘上那条仍是明文）；本机密钥库不可用时退回明文并在设置里标注，加密抛错也存明文，而不是把用户填的 Key 丢掉。换过电脑导致密文解不开时，设置里的状态、「测试连接」和开工前置校验给的是同一句「这台机器读不出已保存的 API Key…」，重新填一次并保存即恢复
- 链接取内容的临时媒体**不是**下完就删：播放器整场都要拿它做逐句回放，删早了链路末尾只会剩一条「文件已被移动」的 toast（这是 1.0.5 修掉的回归）。站点 cookies 在提取出音频后立刻删，媒体留到「下一段素材开工」或「退出应用」；应用被强杀时这两处都走不到，下次启动由 24 小时清扫兜底。所以 /tmp 里短时间内看到上一份素材是正常的，不是泄漏
- 端口 8000 是本机引擎的约定端口。应用不会复用一个「应答者身份不明」的服务，因此手动起的 `python main.py` 不会被采信；反过来，构建或清理时不要用 `pkill -f vv-asr-server` 之类的通配杀进程，容易连别的工作一起打掉
