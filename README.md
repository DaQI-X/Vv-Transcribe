# Vv Transcribe

一款基于 Electron 的桌面端音视频转写应用，支持本地/云端 ASR 语音识别、参考稿逐字比对、本地校对与 AI 校对、段落级播放同步、字幕配音和多格式导出。

## 功能特性

- **文件导入**：拖拽或点选本地文件，音频+视频白名单共 31 项（14 种音频 + 17 种视频：MP3/WAV/M4A/FLAC/AIFF/AC3、MP4/MKV/MOV/AVI/WebM/FLV/WMV/TS/M2TS/MXF 等，含广电常见的 MXF 与磁带采集容器）；能否真正解出音轨由 ffprobe 判定
- **链接取内容**：粘贴公开视频链接后**先只解析元信息**（标题 / 时长 / 体积估算 / 清晰度档位），界面在中间态让用户二选一——「转写音频」只取音频轨转 MP3 后汇入同一条转写流，「下载视频」按选中的档位取画面与音频合并 MP4、下满后走系统「另存为」写到用户选的位置。取内容过程中界面给的是实测进度（第 n/2 路 / 合并音视频轨 / 转码中 + 速度与剩余时间），并留「取消下载」入口。合规口径写在界面上：只能取公开视频，需要登录或会员的（抖音、B 站会员片、部分 YouTube）拿不到音频，请先在本地下载好再走「本地文件」上传。内置的这版解析组件还能在「设置 → 关于与更新」里直接更新，站点改规则不必重装应用
- **ASR 语音转写**：引擎由设置里的「转写模式」决定——默认「本地转写」（Python faster-whisper，音频不出本机），显式切到「云端优先」且填了 API Key 才走 OpenAI 兼容的 Whisper 接口，云端失败时回落本地（两条原因一起报，不拿「引擎未运行」盖住真实错误）。上屏方式跟着引擎走：本地逐句流式、编辑器里一段段长出来；云端是一次请求拿整份结果，段落随返回值一次性填进列表（界面已有段落时不覆盖），进度只有几个节点。两条路径都可随时取消
- **转写语言**：12 种语言可选（zh/en/ja/ko/th/vi/id/fr/de/es/ru/ar），本地与云端共用这一设置；刻意不提供「自动检测」
- **参考稿比对**：上传播出稿（TXT/Markdown/SRT/DOCX/PDF）后与转写结果逐字 diff，差异高亮，还可用 AI 逐处解释
- **双方式校对**：本地校对用常见同音误听表 + 内置中文词库给修正与词义提示，不需要任何 API Key；AI 校对调用您配置的模型结合上下文分析。两者都只提建议，逐条「采纳」才生效。非中文素材没有可用的中文规则，此时只走 AI 校对
- **音视频播放器**：播放/暂停、进度拖拽 seek、段落高亮同步，视频文件内嵌播放
- **段落编辑器**：行内编辑转写文本，点击段落跳转到对应播放时间
- **多格式导出**：SRT 字幕 / VTT 字幕 / 台词表 TSV（时间码 + 台词）/ 纯文本 TXT / JSON 数据 / Markdown 文档，走系统「另存为」面板
- **字幕配音**：首页第三个 tab「字幕配音」是一整页工作台，输入来源两种——**纯文本**（自己贴稿，按句切成每块 ≤800 字的朗读单元，一段挨一段念成连续朗读）或**从转写带入**（拿当前转写段落，按字幕时间轴铺）。音色与倍速在工作台上选（倍速只透传接口的 `speed`，服务商不认这个字段就是不认，界面不替它承诺），先「试听第一句」再「开始配音」，逐段串行——云端档一段一次请求打 OpenAI 兼容的音频接口，本地档一段一次交给本机引擎。产物是一条**独立的 MP3 配音轨**（44.1kHz 单声道）：字幕源上某段配音比它的字幕槽位长就顺延到后面、整条往后推，结果卡写明几段被顺延、这条轨比原时间轴长多少——**字幕与时间轴一个字都不改**。跑完点「保存配音轨」走系统「另存为」；不保存的话，清空或重开一批就把这一版产物删掉。空段落不调接口；连续 3 段失败自动熔断停下整批；「取消」只停后面的段，已经合成的照样拼成一条轨——等到只剩本地拼轨这一步，界面上就没有取消按钮了（那一步停不下来，拦下来等于把已经合成好的段白扔）。切走再回来进度与产物都还在（状态在 store 里，不跟组件走）；工作台抬头是「返回首页」+「清空文稿」两颗——清空只清输入框里那份稿和它派生的试听片段，已经配好的那条轨不动（删产物另有结果卡那颗「清空」）；**文稿目前不落盘**，退出应用就没了，「历史记录」排在 1.0.9。首页那个 tab 上挂着「实验」标：本地档随 1.0.6 发但按实验功能对待，而两条档共用的铺轴在 Intel / Windows 的打包版上还没跑过端到端冒烟
- **本地配音（离线，1.0.6 新增）**：「配音配置 → 配音引擎」切成「本地配音（需下载引擎和模型）」后，配音不再调任何远程接口——主进程 spawn 一个 `vv-tts-server` sidecar（sherpa-onnx，Python 冻结出来的单个可执行文件），只绑 `127.0.0.1:8010`，一段一段在本机念完，**不花钱、不上传文稿**。引擎和模型都不塞进安装包：缺哪个下哪个，入口在「设置 → 关于与更新 → 按需组件」（引擎取自家清单 + 本仓库 Release 资产，模型按下钉死的上游 commit 与逐文件 sha256 从 hf-mirror 自取）。本地档是**懒启动**的：打开设置只查状态不会把引擎拉起来，第一次试听或配音才真正启动
- **设置持久化**：转写、校对、配音三套配置写入 `userData/settings.json`，点「保存设置」才生效；保存后窗口不关，可以直接接着点检测。转写页在云端模式下是「测试连接」、本地模式下是「检查引擎状态」，校对页是「测试连接」，配音页云端档是「测试连接」、本地档还多一个「重启本地配音引擎」——都不保存也能先试一次
- **密钥加密落盘**：三把 API Key 走系统密钥库（macOS 钥匙串 / Windows DPAPI）加密后写进同一份 `settings.json`，磁盘上的值形如 `v1:<base64>`。输入框不回显已保存的值：留空＝不改，「清除已保存的 Key」要点「保存设置」才生效。历史明文在首次读到时就地换成密文；这台机器用不了密钥库时退回明文落盘并在设置里如实标注，读不出密文（换过电脑）时提示重新填写——任何一步都不会静默丢掉用户填的 Key
- **故障自救**：本地转写引擎没能起来时在「设置 → 转写配置」点「重启本地引擎」，本地配音起不来（端口被上一代占住、启动后秒退）时在「设置 → 配音配置」点「重启本地配音引擎」，都不必退出应用；「关于与更新 → 打开日志文件夹」直接取日志
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
| 配音（TTS） | OpenAI 兼容音频接口 `POST {apiBase}/v1/audio/speech`（一次一句，body `{model, input, voice, response_format:'mp3'}`，倍速只在 ≠1 时才带 `speed`）+ FFmpeg 铺轴拼接（每段先解成 44.1k 单声道 PCM 量准长度，再按时轴垫静音 `concat` 串成一条，`libmp3lame` 192k 输出） |
| 本地配音（离线，1.0.6） | sherpa-onnx 2.0.1（VITS 中文 / Kokoro 多语，onnxruntime 由 `sherpa-onnx-core` 自带）+ 自写 FastAPI sidecar `vv-tts-server`（PyInstaller 冻结，只绑 `127.0.0.1:8010`，一进程一引擎）；引擎二进制与模型都按需下载、不进安装包 |
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
│   │   │   ├── ttsHandlers.ts         #   配音：试听、整批合成、进度推送、取消、另存为、释放这批、本地引擎状态/重启/停止
│   │   │   ├── componentHandlers.ts   #   按需组件（本地配音引擎与模型）：列出、对清单、下载、取消、删除、占用查询
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
│   │       ├── ttsService.ts          #   配音：逐段合成落盘 + 解码量准时长 + 铺轴（溢出顺延）+ 静音垫 concat 拼成整轨（命令行超预算时分块）；云端/本地两档分流与这批账目（含取消落在哪一步）
│   │       ├── localTtsEngine.ts      #   本地配音 sidecar：spawn + bootId 握手 + /health 轮询 + 进程树回收，只绑 127.0.0.1:8010，一进程一引擎（引擎 id 走白名单）
│   │       ├── ttsModelUpstream.ts    #   模型上游指纹表：钉死 commit + 逐文件 bytes/sha256，从 hf-mirror 按文件自取
│   │       ├── componentService.ts    #   按需组件下载器：读自家清单→校验→解压/逐文件落盘→installed.json 记账→占用判断与删除
│   │       ├── componentArchive.ts    #   自写的 tar.gz 流式解包（只用 node:zlib + node:fs）：符号/硬链接与设备节点直接拒绝，
│   │       │                          #     每条头部校验和都比——不调系统 tar、不引第三方解压库
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
│   ├── router/index.tsx               # HashRouter，业务页只有一个 `/`（配音工作台是页面内的 tab 状态，不另开路由）
│   ├── pages/Transcription.tsx        # 上传 / 转写中 / 结果 三态切换，外加「字幕配音」整页工作台的分流
│   ├── components/
│   │   ├── SplashScreen.tsx           #   开屏：只有冷启动播，显示引擎就绪到哪一步
│   │   ├── ErrorPage.tsx              #   路由兜底
│   │   ├── ui/                        #   自研 Toast / Dropdown / Popover
│   │   ├── transcription/             #   StudioTabs（顶部 tab：本地文件 / 音视频链接 / 字幕配音；进了配音页只剩一个返回入口，
│   │   │                              #     按钮样式与转写结果页那颗一致）、
│   │   │                              #     FileUploader（本地 / 链接）、UploadStatus、AudioPlayer、
│   │   │                              #     TranscriptEditor、SegmentRow、DiffPanel、ProofreadModeDialog、
│   │   │                              #     VoiceStudio（配音工作台：输入来源 + 本地档的模型/音色下拉 + 试听 + 合成中 + 结果卡；
│   │   │                              #     「云端还是本地」不在这一页给选择，只在设置里定）
│   │   └── settings/                  #   SettingsModal.tsx（转写配置 / 校对配置 / 配音配置 / 主题 / 关于与更新）
│   │       └── ComponentsSection.tsx  #   「按需组件」一栏：本地配音引擎与两份模型的下载、进度、删除、停引擎
│   ├── stores/                        #   useTranscriptionStore、usePlayerStore、useReferenceStore、
│   │                                  #     useSettingsModalStore、useThemeStore、useVoiceStudioStore（均 Zustand；
│   │                                  #     顶部 tab 也在最后一个里——配音是分钟级后台任务，状态跟组件走会丢）
│   ├── hooks/useElectronAPI.ts        #   非 Electron 环境的安全降级
│   ├── types/                         #   transcription.ts、reference.ts、voice.ts
│   └── utils/                         #   asrLanguage（12 语种 + 本地校对适用性）、segmentDiff、textAlignment、
│                                      #     correctedTextAlignment、referenceComparator、exportTranscript、
│                                      #     splitPlainText（纯文本稿按句切成 ≤800 字的朗读块）、
│                                      #     localTtsEngines（本地引擎白名单选项、音色编号枚举、缺件该说哪句话）、
│                                      #     readiness（阻塞项统一提示）、logger
│
├── python-asr/                        # 本地转写服务：main.py（FastAPI，协议 2 = NDJSON 逐句回传）
│   ├── vv-asr-server.spec             #   PyInstaller 配置（非 Python 资源必须在 datas 里显式列出）
│   ├── requirements.txt               #   faster-whisper / fastapi / uvicorn / python-multipart / pyinstaller
│   └── dist-<arch>/                   #   按架构产出的 vv-asr-server[.exe]，开发模式也用它
│
├── python-tts/                        # 本地配音服务（sidecar）：main.py（sherpa-onnx，一进程一引擎，
│   │                                  #     /synthesize 用 X-Vv-Duration 回它自己数的采样时长）
│   ├── vv-tts-server.spec             #   PyInstaller 配置；**不进安装包**，CI 按平台构建后发成 Release 资产供按需下载
│   ├── requirements.txt               #   sherpa-onnx 2.0.1 + sherpa-onnx-core 同号（onnxruntime 在 core 的 wheel 里）+
│   │                                  #     fastapi / uvicorn / pyinstaller 钉的版本号与 ASR 那份对齐；刻意不含 numpy
│   └── dist-<arch>/                   #   按架构产出的 vv-tts-server[.exe]，开发模式回落用它
│
├── yt-dlp-manifest.json               # yt-dlp 组件的版本+指纹清单（构建期与运行期读同一份；改它=改往包里塞什么）
├── scripts/                           # build-asr.mjs / build-tts.mjs（按 --arch 选 venv 与产物目录）、fetch-yt-dlp.mjs（校验 SHA2-256）、
│                                      #   yt-dlp-manifest.mjs + components-manifest.mjs + lib/（pnpm check:* 与上游/远端资产逐条对账）
├── vendor/yt-dlp/                     # 拉下来的官方独立二进制（已 gitignore，构建时进包）
├── release/                           # 最终安装包（Vv-Transcribe-arm64.dmg 等）
├── .github/workflows/build.yml        # CI：build（Win x64 + macOS arm64/x64 三个目标）+ release（tag 触发，
│                                      #   先校验 tag 在 main 上、package.json 版本 == tag，再发 .dmg/.exe）。
│                                      #   三个目标各自构建 vv-tts-server 并 upload artifact；build job 早期有一步
│                                      #   「Verify components manifest」——清单文件不存在时只提示并退 0（现在就是这条路），
│                                      #   一旦存在就对不上账硬失败。
│                                      #   release job 在创建 Release 前把三份引擎打成资产、生成 components-manifest.json，
│                                      #   与三个安装包一起挂上（immutability 只允许这一刻传），发布后再拿 GitHub 算的
│                                      #   digest 对一遍账
├── .github/workflows/publish-components.yml # ⚠ 已被上面那条取代（2026-10-29）：它只能「事后往已发布的
│                                      #   Release 加资产」，而仓库开了 Release immutability，Upload 那步必然 422。
│                                      #   留着只作为「临时关掉 immutability 后补历史版本资产」的回收路径。
│                                      #   ⚠ 这份清单目前还不在 main 上（仓库里没有 components-manifest.json）：
│                                      #     点「检查清单」会报「这一版还没有发布组件清单（404），本版没有对应的下载包」，
│                                      #     引擎那一行收起下载按钮、同说这句（2026-10-28 #251：404 是服务器答清楚了
│                                      #     「这份文件不在」，留一颗点了只会 404 的按钮比没有按钮更坏）；
│                                      #     模型那一档不读清单（指纹钉在代码里），照常能下
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
│  字幕配音页：VoiceStudio（两档引擎 → 进度卡 → 结果卡 + 另存为）│
│  SettingsModal：转写 / 校对 / 配音 / 主题 / 关于（含按需组件） │
│  Zustand：transcription · player · reference · settingsModal ·│
│            theme · voiceStudio                                │
└──────────────────────┬───────────────────────────────────────┘
                       │ window.electronAPI（preload contextBridge，无 nodeIntegration）
┌──────────────────────┴───────────────────────────────────────┐
│ Electron 主进程                                               │
│  IPC：file · asr · ai · proofread · tts · component ·         │
│       settings · dictionary · update · window                 │
│  服务：audioProcessor（FFmpeg）· asrServiceManager（引擎生命  │
│       周期）· asr/localASR · asr/cloudASR · ruleProofread ·   │
│       localProofread · ai/openaiCompatible · dictionaryService│
│       · referenceParser · urlDownloader · browserCookieFetcher│
│       · ttsService（逐段合成/铺轴/拼轨，两档共用）·           │
│       localTtsEngine（配音 sidecar 生命周期）·                │
│       componentService + componentArchive + ttsModelUpstream ·│
│       ytDlpUpdate · connectionTestService · settingsService · │
│       logger                                                  │
└───────┬───────────────────────┬──────────────────────┬────────┘
        │ HTTP :8000 与 :8010   │ spawn                │ HTTPS（云端转写/校对要显式配置才走；
        │                      │                      │ 链接转写、词库检查更新按用户操作发起）
┌───────┴───────────┐  ┌────────┴─────────┐  ┌─────────┴────────────┐
│ 本机 Python 引擎  │  │ yt-dlp（随包）   │  │ 云端 ASR / OpenAI 兼容│
│ 两个 sidecar，同一│  │ + 临时浏览器配置 │  │ 大模型接口            │
│ 套生命周期口径：  │  │ 取站点 cookies   │  │                      │
│  8000 ASR：       │  └──────────────────┘  │ 另：按需组件从本仓库  │
│  faster-whisper   │                        │ Release 取引擎二进制、│
│  8010 本地配音：  │                        │ 从 hf-mirror 逐文件取 │
│  sherpa-onnx      │                        │ 模型（sha256 校验）   │
└───────────────────┘                        └──────────────────────┘
```

只有主进程直连 8000 / 8010 与外部接口，渲染层不发任何 `fetch`。两个本机端口都是「一进程一服务、启动时钉死身份」：ASR 用 `bootId` 握手确认应答者是自己这次拉起的那个，配音引擎除此之外还用 `VV_TTS_ENGINE` 把引擎 id 钉在进程上（换档＝重起，端口上留着的还是那一个）。配音这一路只绑 `127.0.0.1:8010`（ASR 那个 8000 绑了 0.0.0.0 是历史遗留，新服务不重复）。密钥也不进渲染层：`settings:get` 返回的是脱敏视图——两把 Key 字段被剔除，只留 `asrKeyStatus` / `aiKeyStatus`（无 / 密文 / 明文 / 解不开）和 `keyEncryptionAvailable` 三个状态位；解密结果只在主进程里用于转写、校对和「测试连接」。引擎由主进程按需拉起（本地配音是懒启动：只有真开始配音/试听才 `ensure`，打开设置页不会把它拉起来），退出时按进程树优雅关闭。

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
                                   一次请求拿整份结果：进度只有 2 / 10 / 80 / 100 几个点，
                                   不逐段推流，段落全在 asr:start 的返回值里
          其余（默认）           → localASR → POST localhost:8000/transcribe
                                   逐行读 NDJSON，每出一句回调一次
      → IPC asr:progress（percent + segment + stage）→ 本地逐句上屏、进度按真实音频位置
      → 云端不推段落，界面在 asr:start 返回后整份写入（已有段落时不覆盖用户正在改的那份）
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

字幕配音（一整页工作台；一次调用只合成一句，整条稿子串行跑完再拼成一条轨；字幕与时间轴一个字都不改）：
  入口两条：首页顶部第三个 tab「字幕配音」（tab 上带一枚「实验」标，`StudioTabs` 与首页共用同一组件，
    所以标在两处同一位置），或转写结果页头部的「字幕配音」按钮——后者只是把 tab 切过去，
    不叠弹窗（配音跑起来是分钟级的事，藏在一层浮层里没法中途去看别处）
  抬头两颗：「返回首页」（有转写结果时写作「返回转写」）与「清空文稿」。后者走 `clearDraft`，
    只清 `text` 与它派生的试听片段，`queue` / `result` 一律不动；正在跑整批、或来源是「从转写带入」时按不动
    （那两份都不是这一页的输入框里的东西），禁用原因写在按钮的 title 上
  两档引擎（「配音配置 → 配音引擎」）：cloud＝逐段打远程音频接口；local＝主进程 spawn 的 `vv-tts-server`
    sidecar，逐段 `POST /synthesize`（`{ engine, text, sid, speed }`）。下面这套链路——切分、前置校验、进度、
    熔断、铺轴、拼轨、另存为、临时目录回收——两档共用，只有「念一段」这一步分叉
  左列选输入来源：
    纯文本：整篇稿子 → `splitPlainText` 先按行、再按句末、再按停顿切，贪心合并到每块 ≤800 字 → 每块一段、时间轴全 0
      （时间轴全 0 时下面那套铺轴天然退化成「首尾相接」，所以纯文本朗读不用主进程另开一条路）
    从转写带入：当前非空段落原样带走（起点/终点就是字幕时间轴），界面给的是只读摘要，文字要改回转写页编辑
  音色与倍速是「这一次任务」的参数：作为 `tts:preview` / `tts:synthesize` 的第二个参数交给主进程收口，
    不写回 `settings.json`——工作台上的试错不该变成用户的长期默认值（那要去「配音配置」点「保存设置」）
    倍速只在 ≠1 时才进请求体的 `speed`；接口字段是 0.25–4.0，但某家是不是照单实现由接口说了算，界面不替它承诺
  前置校验：配音在「设置 → 配音配置」里有自己的一整组值——接口地址与 Key 留空时按 getTTSConfig 的口径沿用
    校对那一套，但模型与音色**不回落**：音频接口吃的是配音模型 id，拿 chat 模型去调必然被拒。
    所以点「开始配音」先过 checkVoiceReady：Key（配音或校对两把里任一可用）、配音模型、配音音色，
    缺任何一项都不发起整批调用——toast 说清缺的是哪一项，并当场打开「设置 → 配音配置」那一层。
    本地档走另一问：不看地址和 Key，只拦「组件不在场」——引擎二进制缺就指路「设置 → 关于与更新 → 按需组件」，
    模型缺就按「这一版有没有对应的下载包」分叉（有包的说去哪下、开的就是那个 tab；没包的说换回 VITS 或改用云端档），
    音色填的不是编号再单独拦一次；`ready:false` **不算**阻塞条件（懒启动的引擎只是还没起过，
    要求用户先去手动点一次「启动引擎」是凭空加一步）。配音页上还会再问一遍，问的是「界面当前选的这一档
    在不在磁盘上」而不是「设置里保存的那一档」，还没查到结果时按不拦处理
    这一层是唯一的：配音是一整页，不再是弹窗底下又叠一个设置弹窗（那种两层互相盖住的坑见 #220）
  试听：云端档 IPC tts:preview(text, opts) → POST {apiBase}/v1/audio/speech（response_format=mp3）→ 落盘
    → ffprobe 读时长（这个时长只给试听那一句显示用，铺轴不认它）；本地档同样走 tts:preview，
    只是那一次交给 sidecar 的 `/synthesize`，倍速与音色编号原样带过去
  进行中：IPC tts:synthesize(queue, opts) 一次带走全部段落（时间轴只有渲染层这一份，主进程按 jobId 记账）
    → 逐段**串行**（云端档并发只会换来 429；本地档一次推理吃满 4 个线程，并发只会互相抢核、还把界面拖卡），
      每段落进 `transcribe-tts-<uuid>/`
    → 段号经 IPC tts:progress 推回界面，写的是「已合成 7 / 12 段」这种真实段号
    → 空段落跳过不调接口；单段 60 秒超时（两档都是 60 秒）；连续 3 段失败熔断停下整批（原因与「用户点了取消」分开报）
    → 「取消」只停后面的段，正在飞的那段/正在念的那段等它回来，已经合成的照样拼成一条轨；
      只剩本地拼轨这一步时没有取消位（`tts:cancel` 回 `late`），界面上那个按钮这时直接收起
    → 合成中那张卡直接复用转写的 processing 视觉（徽章 + 波形 + 进度条 + 取消按钮），只做分钟级活儿的界面不需要两套动画
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
    → 一条都没成功时同一张卡换成失败态：整批停下的原因 + 原话（云端档标题「接口回的原话：」、本地档「本机引擎回的原话：」）
      +「去配音配置测连接」，不假装成功；云端档补「地址 / Key / 模型 / 音色任何一样不对都长这样」，
      本地档那句换成「本地这一档不看地址和 Key；引擎二进制、模型、音色编号三样里任何一样不对，都长这样」
    → 页内 `<audio controls>` 直接播这条轨（file:// 绝对路径，和回放转写源音频同一套加载口径）
    → 「保存配音轨」IPC tts:saveTrack：系统「另存为」+ copyFile（另存出去的副本不跟着临时目录删）
    → 「清空」/ 重开一批 / 回首页时 IPC tts:releaseBatch 当场删掉这批临时目录；正在跑的那批不删，
      切走 tab 也不删——产物得留着，回到配音页还能听（没另存出去的产物就到此为止）
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
| `file:saveText` | 渲染 → 主 | 系统「另存为」面板写出 SRT / VTT / TSV / TXT / JSON / MD（过滤项按传进来的扩展名给，不在主进程维护格式白名单） |
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
| `tts:preview` | 渲染 → 主 | 配音试听一句：`POST {apiBase}/v1/audio/speech` 拿 mp3 落进临时目录，回 `{ clip: { filePath, bytes, duration }, error }`。第二个参数是这一次调用的可覆盖项（`{ voice?, speed? }`）：音色空串＝不覆盖、按设置里那个走，倍速夹进 0.25–4.0（非有限数/≤0 退回 1），主进程收口、不写回设置。`duration` 是 ffprobe 读出来的时长（mp3 的容器估算，只够给这一句显示用，铺轴不认它），读不到也不谎报。整批之前先花这一次钱，端点/模型/音色任何一样不对都在这一步暴露 |
| `tts:release` | 渲染 → 主 | 删掉刚才那句试听的产物（主进程本来只留一份，下一次试听会自己回收上一份；配音页点「清空」时当场还掉） |
| `tts:synthesize` | 渲染 → 主 | 整条稿子配音：段落（含时间轴）由渲染层一次传来，第二个参数同样是这一批的可覆盖项（音色/倍速对整批生效，不写回设置）。主进程不存第二份时间轴、也不用界面报回来的路径。逐段**串行**（并发只会换来 429），空段落直接跳过不调接口，单段 60 秒超时，连续 3 段失败熔断停下整批；跑完按时间轴铺成整轨（每段先解成 PCM 量准长度，再垫静音 `concat`，命令行超字符预算时分块）。回 `{ jobId, track, clipCount, failures, skipped, canceled, abortedReason, error }`——`abortedReason` 只写熔断原因，与「用户自己点了取消」分开报；拼接失败时前面的账目照样带回去，不会抹成「一段都没成」 |
| `tts:progress` | 主 → 渲染 | 推 `{ jobId, stage, index, total, segmentId, note }`，`stage` 五态：`synthesizing` / `skipped` / `failed` / `assembling` / `done`。界面写的是真实段号（「已合成 7 / 12 段」），不做假百分比 |
| `tts:cancel` | 渲染 → 主 | 置取消标志：只停**后面**的段，正在飞的那段等它回来；已经合成的照样拼成一条轨，不白跑。回 `{ success, reason }`，`reason` 三态如实说：`stopped`＝落在逐段循环里、真被停下了；`late`＝循环已经出界、现在在本地拼轨，那一步**没有取消位**（拼接读的是已经落盘/已经花过钱的片段，拦下来等于白扔），所以这里绝不回 `success: true`；`gone`＝这批已经不在了。界面只在 `stopped` 时写「正在取消…」，`late` 给的是「这一步停不下来、等它跑完轨照常给你」 |
| `tts:saveTrack` | 渲染 → 主 | 弹系统「另存为」（默认名 `voice-track.mp3`、MP3 过滤），`copyFile` 到用户选的位置，回 `{ success, canceled, name, error }`。取消不算失败也不释放这批——界面还留着结果态让人再点一次 |
| `tts:releaseBatch` | 渲染 → 主 | 删掉这批的临时目录：配音页「清空」、重开一批、回首页（且这批已跑完）三条路都会触发；**切走 tab 不触发**——产物要留着，回到配音页还能听。另存出去的那份是副本，跟着目录一起删不掉 |
| `tts:localStatus` | 渲染 → 主 | 本地配音引擎的只读快照，**不会因此拉起引擎**（懒启动：只是打开设置页就吃 8 秒解包和几百 MB 内存是更坏的答案）。回 `{ binaryPresent, modelPresent, engine, engineLoaded, speakers, sampleRate, port, ready, error, mode, configuredEngine, requestedEngine }`。`requestedEngine` 允许界面传还没保存的那个选择，但必须先过白名单——这个值会拼进模型目录名，不能把渲染层传来的字符串直接当路径用。`speakers` 只有模型真进了内存才有值（`/health` 在此之前不报 `num_speakers`；实测引擎刚重启时仍是 0，跑过第一次真合成才回 5） |
| `tts:localRestart` | 渲染 → 主 | 「重启本地配音引擎」：先回收躺在 8010 上的上一代再重开，换引擎失败、端口被占、启动失败后的重试都走这条。只认**已保存**的配置，不接受界面传值（设置页「点保存才生效」的口径不能在这儿破例），已保存档位不是本地时直接回 `{ ok: false, error }` 说明「本地配音引擎没在使用中，无需启动」。同一时刻只允许一次启动/重启，连点会被合并 |
| `tts:localStop` | 渲染 → 主 | 停掉本地引擎且不重开（下一次配音由 `ensure` 懒启动，界面不用管）。存在的理由很具体：「按需组件」那栏要删/换那几个文件，而引擎配音完不会自己退，没这个入口同会话里永远动不了组件。有一批正在逐段合成时**拒绝**停（那会让剩下的段落全失败），回 `{ ok, stopped, error }` |
| `component:list` | 渲染 → 主 | 「设置 → 关于与更新 → 按需组件」打开就读的磁盘快照：每个组件的在场情况、已装版本、占用体积、要不要下载、下载多大，**不联网** |
| `component:check` | 渲染 → 主 | 取自家组件清单对版本（`components-manifest.json`，两条读法：raw.githubusercontent 直连 → api.github.com contents）。国内直连可能要十几秒，界面得有「检查中...」；取不到清单不等于「已是最新」，会如实报错。两类失败分开说：连不上（网络/超时）只报「读不到、可开加速重试」，下载按钮留着；两个入口都答 404 就顺手记下「这一版没发布清单」，靠清单找包的那个组件（引擎）下一行改说「这个版本没有发布对应的下载包」并收起按钮，钉了上游指纹的两份模型不受牵连 |
| `component:install` | 渲染 → 主 | 下载并装上一个组件（id 之外的东西全在主进程决定：从哪读、落到哪、要不要解压），进度经 `component:progress` 推回界面。同一组件重复发起会复用前一份任务并接上同一条进度流，连点不会产生两条下载。落点 `userData/components/` |
| `component:cancel` / `component:remove` | 渲染 → 主 | 取消正在跑的下载 / 删掉已装组件。这个组件没在下载时 `cancel` 直接回错误，不谎报「已取消」 |
| `component:busy` | 渲染 → 主 | 回 `{ engineRunning, synthesizing }`：这两种占用分开报——引擎进程还活着有「停止本地配音引擎」可点，一批正在逐段合成则只能等它跑完或去配音页取消，因为在这里停引擎会让剩下的段落全失败 |
| `dictionary:lookup` | 渲染 → 主 | 查单个词释义。词库现在由主进程在校对/prompt 组装时内部使用，界面暂无调用点 |
| `dictionary:lookupMultiple` | 渲染 → 主 | 批量查词，同上 |
| `dictionary:getVersion` | 渲染 → 主 | 当前词库 commit hash |
| `dictionary:checkUpdate` | 渲染 → 主 | 只对比远端 commit，判断有没有新版 |
| `dictionary:downloadUpdate` | 渲染 → 主 | 下载远端词库更新 |
| `settings:get` | 渲染 → 主 | 读设置的**脱敏视图**：非密钥字段原样，三把 Key 只给状态（`none`/`encrypted`/`plaintext`/`unreadable`）+ 本机密钥库可用性 |
| `settings:save` | 渲染 → 主 | 写设置（渲染层只在点「保存设置」时调用）。Key 字段三态：非空＝替换、`null`＝清除、留空＝整个键不发送、磁盘上那把不动；只收 `DEFAULT_SETTINGS` 列得出的字符串字段 |
| `settings:testConnection` | 渲染 → 主 | 按表单当前值试一次：`kind='asr'` 探云端接口或本机引擎，`kind='ai'` 探校对接口，`kind='tts'` 探音频接口（真合成一句，约 10 个字）；表单 Key 留空时回落到已保存的那把（改接口地址不用重贴），配音这一腿还额外跟 `getTTSConfig` 同口径回落——留空时用的是校对那把 Key、校对那个地址，否则会出现「自检说没填、点开始配音却跑得通」的分歧；密文解不开则直接报错、不发请求。配音的超时跟真实合成一样是 60 秒，不是校对的 30 秒 |
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
- Python 3.10+（本地 ASR 引擎需要；CI 用 3.12，x64 包还要一份 x64 解释器）。本地配音的 sidecar 只在要动那条链路时才需要装：`python-tts/requirements.txt` 里 fastapi / uvicorn / pyinstaller 钉的就是 ASR 那份已在三平台 CI 上验证过的版本号，两边共用一个 venv 不会打架
- pnpm（推荐）

### 安装依赖

```bash
# 安装前端依赖
pnpm install

# 建立本地 ASR 的 Python 虚拟环境并装依赖（含 PyInstaller）
pnpm setup:asr          # 等价于 python-asr/venv + pip install -r python-asr/requirements.txt

# 编译本机架构的引擎二进制：开发模式也由主进程拉起它，不是跑 main.py
pnpm build:asr

# 可选：本地配音的 sidecar（只在要动这条链路时才需要装与编译）
pnpm setup:tts          # python-tts/venv + pip install -r python-tts/requirements.txt
pnpm build:tts          # 产物 python-tts/dist-<arch>/vv-tts-server
```

### 开发模式

```bash
pnpm dev
```

`pnpm dev` 启动 Electron 时，主进程照样会 spawn `python-asr/dist-<arch>/vv-asr-server[.exe]`（`getBinaryPath()` 在开发模式取的就是这个架构目录），所以先跑过 `pnpm build:asr` 才有本地转写；缺文件时应用会明确报「本地转写引擎文件缺失」。

本地配音的 sidecar 找法略有次序：`getBinaryPath()`（`electron/main/services/localTtsEngine.ts:97-105`）先看「按需组件」那份 `userData/components/vv-tts-server/<platform>-<arch>/vv-tts-server`，在就用它；没有才在开发模式退回 `python-tts/dist-<arch>/`。所以在开发模式测本地配音，两条路都算「装上了」——走过一次应用内下载就不用再编译，反之先 `pnpm build:tts` 也能跑；两边都没有时测连接会直接说「本地配音组件还没下载」。打包版没有这个退回分支：sidecar **不进安装包**（`electron-builder.cjs` 只 `extraResources` 了 `python-asr/dist-<arch>`），磁盘上没有下载好的那份就是没有。

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

本地配音的 sidecar 不走这条：`build:mac:arm64` / `build:electron*` 里没有 `build:tts`，electron-builder 的 `extraResources` 也只列了 `python-asr/dist-<arch>`——安装包**不含**配音引擎（见「按需组件」的理由）。CI 每个平台各编一份 `python-tts/dist-<arch>/vv-tts-server[.exe]` 并传成 `vv-tts-server-<platform>-<arch>` 这份 artifact；这三份由 **`build.yml` 的 release job 在创建 Release 的那一刻**打成资产、连同生成的 `components-manifest.json` 一起挂上（2026-10-29 改的：仓库开了 Release immutability，「事后往已发布的 Release 加资产」这条路必然 HTTP 422，只有创建那一刻传得进去；顺带把「人工指名 run-id」也省了——三份二进制与三个安装包出自同一次 run，指纹天然对得上眼前这次产物）。原来的 `publish-components.yml` 就此成为回收路径（只在临时关掉 immutability 补历史版本时才有用）。清单仍然要**人工看过 diff 再提交进 main**——CI 不把自己刚生成的信任锚直接推上 main，全文会抄进 job summary，Release 上也有一份公开可读的资产副本。这份流程里没有模型：第三方权重的再分发许可尚未核实（2026-10-28 实测该 HuggingFace 仓库 `license` 字段为空、也没有 LICENSE 文件），而模型这一路本来就不走 Release（应用从 hf-mirror 自取）。`build.yml` 里那步 `Verify components manifest` 只在仓库根有这份清单时才对账（不存在只提示并退 0，存在即硬失败；对的是清单声明的 sha256 与 GitHub 上传时自己算的 digest）；release job 发布之后还会再对一遍同一笔账。`win32-arm64` 在 `ENGINE_KEYS` 里但 CI 不产这一档，清单里缺它是设计内的状态（那个平台的引擎行显示「本版没有下载包」）。本地要手工出这份二进制就是 `pnpm setup:tts` + `pnpm build:tts`；`pnpm check:components-manifest` 是发布后的独立复核（比对 GitHub 给每个资产自己算的 digest），清单还没进仓库时它只打一行「本地配音组件尚未发布」再退 0，联网不通或只改文案时用 `--offline` 做本地结构校验。

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

- **只有「转写模式 = 云端优先」且填了云端 API Key，音频才会发出本机。** 默认的本地模式不发起任何网络转写请求；AI 校对的 Key 只处理文本，不会上传音视频。配音同理——发出去的是逐段的字幕文本（外加试听那一句），回来的才是音频，所以**文本会离开本机**，目的地就是「配音配置」里填的那个接口地址（留空时沿用「校对配置」那个）。已保存但在这台机器解不开的 Key 不算「填了」：开工前置校验会当场拦住并说明原因，不会带着空 `Authorization` 去打接口。
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
| 服务商 | OpenAI / DeepSeek / 通义千问 / 自定义兼容接口；切换时自动填入下面的接口地址与默认模型（**只动本 Tab 这两项**，配音那套有自己的地址和 Key，不被这里的预设改写） | `openai` |
| API Base URL | AI 接口地址，主进程在其后拼 `/v1/chat/completions` | 空（等价 `https://api.openai.com`） |
| API Key | AI 密钥，同样不回显、留空＝不改。没配 Key 时点「校对」不弹选择框，直接走本地通道；有 Key 才弹「本地校对 / AI 校对」——密文在这台机器解不开也算「有」，好在弹窗里撞上明确原因并跳去重填，而不是被「未配置校对模型」误导 | 空 |
| 模型 | AI 模型名称 | 空（默认 `gpt-4o-mini`；预设 DeepSeek=`deepseek-chat`、通义千问=`qwen-plus`） |

### 配音配置

配音是「设置」里的第三个 Tab。字段分两组：**云端档**四个（地址 / Key / 模型 / 音色），**本地档**三个（引擎档位 / 本地模型 / 本地音色）。哪一组显示由「配音引擎」决定——本地档根本不读地址、Key、模型，所以那三个框在本地档里直接不出现，而不是摆在那儿让人填了不管用。

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 配音引擎 | `ttsEngine`，`cloud`（「云端接口（默认）」）或 `local`（「本地配音（需下载引擎和模型）」）。这一档决定后面走哪条链路，也是 `getTTSConfig().engine` 里那个 `engine`；非法值会被 `normalizeTtsEngine` 收成默认档 | `cloud` |
| API Base URL | `ttsApiBase`，音频接口地址（**只有云端档看得着**）。留空＝沿用「校对配置」那个；两者都空时 `getTTSConfig()` 退到 `https://api.openai.com`。同样先 `trim` 去尾斜杠、再去掉尾巴上的 `/v1`，然后拼 `${apiBase}/v1/audio/speech` | 空 |
| API Key | `ttsApiKey`，可以和校对是**另一家网关的另把 Key**。留空＝沿用校对那把（`ttsApiKey \|\| aiApiKey`）；输入框同样不回显、留空＝不改、点「清除已保存的 Key」才删 | 空 |
| 配音模型 | `ttsModel`，配音用的模型 id，与校对的「模型」**不是同一个值**：音频接口要的是配音模型，填 chat 模型会被直接拒。**不回落**——留空就是没配，前置校验和「测试连接」都当场说「还没填」，不会拿校对模型去顶上 | 空 |
| 配音音色 | `ttsVoice`，各家格式不同（OpenAI 是 `alloy` / `onyx` 这类短名，有的网关要求带模型前缀），照服务商文档原样填。整条配音用同一个音色，暂不支持逐段换。**同样不回落** | 空 |
| 本地模型 | `ttsLocalEngine`，本地档用哪个引擎，下拉只有白名单里那两档：`VITS（推荐中文）` / `Kokoro（推荐英文）`。这个值会被拼进模型目录名，所以渲染层传来的字符串必须先过 `LOCAL_TTS_ENGINES` 白名单，不在名单里就退回默认档——不拿界面传来的字符串当路径用。换这一档会把本地音色复位成默认那一个（两档的音色不通用，VITS 的 3 号不是 Kokoro 的 3 号） | `sherpa-onnx-vits-zh-ll` |
| 本地音色 | `ttsLocalVoice`，存的是 **0-based 的 sid** 字符串，界面按「音色 1 … 音色 N」显示（`voiceSidLabel` 做那一格偏移，配置里的 `'0'` 就是界面上的「音色 1」）。条数取 `LOCAL_TTS_MODEL_SPEAKERS` 那份实测表（VITS 5 个，2026-10-28 本机 `/health` 报的数），引擎真把模型读进内存后就改认 `/health` 实报的 `num_speakers`——静态表只兜「还没加载」那一段，所以懒启动状态下打开配音页也能一次列全。没核实过的档位（Kokoro）回 0，那时界面只列得出「音色 1」一行，并在提示里说清「这一档的音色总数还没核实，本版也没有它的应用内下载包」，不凭空造一串编号 | `'0'` |

- **为什么地址和 Key 可以共用、模型和音色不行**：前者是「去哪家网关、拿什么身份去」，一家网关通常同时挂着对话和音频两个端点，共用一把 Key 是省事；后者是「要哪个产品」，`gpt-4o-mini` 拿去调 `/v1/audio/speech` 只会得到一个 400。所以回落只回落到会真正干活的那一层。
- **旧值迁移**：1.0.5 的字段名是 `aiTtsModel` / `aiTtsVoice`（配音藏在校对 Tab 里）。1.0.6 起读磁盘时把这两个旧值搬进 `ttsModel` / `ttsVoice` 并当场写回，**只在目标值为空时搬**——新值已经填过就保留新值。任何情况都不会把用户填过的配音配置清空，也不会带着旧字段名继续读写。
- **自检（云端档）**：「配音配置 → 测试连接」用表单当前值真打一次音频接口，合成一句约 10 个字的文本；地址与 Key 留空时按上面同一口径回落，所以「没保存也能测」和「点开始配音」走的是同一条路径。返回 200 却是 JSON、或音频是 0 字节，都算失败并写出原因。
- **自检（本地档）**：同一栏里换成两个按钮，问的不是同一件事。「测试连接」不起远程请求，而是**真起本机引擎**并合成一句约 10 字（倍速固定 1，只为验链路），成功报耗时与「几秒、多大」，失败标题是「本地配音跑不通」；缺件时缺哪样说哪样——只缺模型就不附「另需下载引擎二进制」（那是已经下好的包），音色不在列表里则说「本地配音的音色要选「本地音色」列表里的一项，当前是「X」」。「重启本地配音引擎」处理端口被上一代占住、启动后秒退这类情况，不用退出应用重开；它**只认磁盘上已保存的那一档**，表单里换了没保存不算（「点保存才生效」的口径在这儿不破例），连点会被合并成一次（两个引擎抢 8010 是更坏的结果）。重启后会再问一次状态，音色列表不靠这一次才齐：`/health` 只在模型真进了内存后才报 `num_speakers`（实测刚重启时仍是 0），而列表那条数来自按 sha256 钉死的那份模型表，引擎实报之后才由实报值覆盖。
- **本地档不许打断正在跑的批次**：一批配音正在逐段合成时点「测试连接」，回的是「现在不能测 / 有一批配音正在逐段合成…」。理由是测试要把引擎换掉，而换掉之后剩下的几十段会全报「没能连上本地配音服务」——花过钱的（云端档）或已经念完的段就白扔了。同一口径也压在「停止本地配音引擎」上（`tts:localStop`）。
- **本地配音的组件不进安装包**：引擎二进制 + 两份模型合计 500MB 以上，而大部分用户根本不用本地配音，所以缺哪个下哪个，入口在「设置 → 关于与更新 → 按需组件」。两条来源分开：引擎二进制认自家 `components-manifest.json`（schema、tag、资产名、sha256 全部收死字符集，清单里 `component` 必须是 `vv-components`，防把别家同类文件指过来），资产从本仓库的 Release 直链取；模型不读清单，由代码钉死上游 commit 与**逐文件**的 bytes + sha256，从 hf-mirror 按文件自取（VITS 钉的是 `sherpa-onnx-vits-zh-ll` 那个 commit 的 17 个文件，合计 135,454,939 字节，界面显示「未安装，下载约 135.5MB」）。落点都在 `userData/components/`，版本记录写 `installed.json`（手工放进目录的那份没有版本记录，`localVersion` 就是 null）。
- **Kokoro 这一档本版没有应用内下载包，已拍板排到 1.0.7**，这是范围决定，不是漏了：1.0.6 只发中文 VITS，而 Kokoro 的 `espeak-ng-data/` 有几百个文件，指纹表要另做一轮实测，不能凭记忆填。2026-10-28 量的数（hf-mirror API，commit `423bfb9ccd6a66115a76602a9630ffea265ae176`）：**378 个文件、426,586,433 字节**（按界面那句「下载约 X MB」的十进制口径就是 426.6MB，MiB 是 406.8），其中 `espeak-ng-data/` 占 355 个文件却只有 17.2 MiB，大头是 `model.onnx` 325,561,476 与 `voices.bin` 53,790,720；5 个大文件走 LFS、sha256 能从 API 直取，剩下 373 个是普通 blob，只能整包下完自己算哈希——所以出表之前要先跑一次 426.6MB 的下载。本版这一档既不指清单也不钉上游指纹，界面按「这个版本没有发布对应的下载包」处理：模型下拉里跟在档位名后面那句是「（本版没有下载包）」（`modelPresenceTag`，与「（模型还没下载）」分叉），缺件提示原话是「Kokoro（推荐英文）这一版没有应用内下载包——把本地模型换回 VITS，或改用云端档」（`missingModelHint` 按 `hasInAppDownload` 分叉的那一条）——把一个按下去必然失败的按钮摆出来，比一开始就说清楚更糟。**sidecar 那一层其实已经认得这一档**（2026-10-28 本机实测：拿已发布的那个冻结包 `VV_TTS_ENGINE=kokoro-multi-lang-v1_1` 起在 8019，`/health` 回 `engines:["kokoro-multi-lang-v1_1","sherpa-onnx-vits-zh-ll"]`，`engine` 认下了这个 id），缺的只有模型包与它的指纹表，1.0.7 补表时不用重打 sidecar。两档采样率不同（VITS 16k / Kokoro 24k）也不影响拼轨：铺轴前每段都 `aformat` 成 44.1k 单声道 s16（`PCM_CHAIN`），进的是同一条 concat。真要手工用这份模型：自己放进 `userData/components/tts-models/kokoro-multi-lang-v1_1/`（目录名就是引擎 id，sidecar 与组件落点用的是同一个函数），引擎与模型都齐了就能跑。

### 配音（TTS）

- **两档引擎，同一条铺轴链路**：「配音配置 → 配音引擎」= `cloud` 时逐段打远程音频接口；= `local` 时主进程 spawn 一个 `vv-tts-server` sidecar（sherpa-onnx，只绑 `127.0.0.1:8010`，一进程一引擎，引擎 id 在启动时用 `VV_TTS_ENGINE` 钉死），逐段 `POST /synthesize`，body 是 `{ engine, text, sid, speed }`。**除音频那一步之外，两档共用同一套代码**：段落切分、记账、熔断、铺轴、拼轨、另存为、临时目录回收都不分叉——本地档只是把「一次请求」换成「本机念一段」。产物也一样：MP3，同样的结果卡与账目。
- **本地档不花钱，也不上传文稿**：整条链路没有任何远程音频请求（模型下载是另一回事，那是按需组件从 hf-mirror / GitHub 取文件）。界面在点下去之前写的就是这一档的账：「本机合成 N 段（逐段串行，不调接口、不花钱）」，云端那档才写「将调用 N 次接口，按服务商计费」。
- **懒启动与首次成本**：`tts:localStatus` 只读快照，不会因为打开设置页就把引擎拉起来；真开始配音/试听时才 `ensure`。代码里记的实测：冻结包从 spawn 到 `/health` 回显本次身份要 8.07 秒（PyInstaller 解包是大头），模型读进内存再 VITS 0.22 秒、Kokoro 0.86 秒，这两笔都落在第一次 `/synthesize` 里——所以界面明说「第一次配音要多花几秒，之后就快了」，而「就绪」只保证能收请求，不保证已经念得动。应用内重启实测约 16 秒（本机 arm64 打包版，「设置 → 配音配置 → 重启本地配音引擎」）。
- **时长信引擎，不信 ffprobe**：本地档的段时长取 sidecar 自己数的采样数（响应头 `X-Vv-Duration`）。ffprobe 读 mp3 拿到的是容器估算，铺轴不认它——这也是为什么本地档的铺轴比云端档准。真读不出来（sidecar 版本对不上）就按 0 报，调用方按「不知道」处理，与云端同一口径，不做「读不出来就猜一个」。
- **能用什么接口**（云端档）：只实测了 OpenAI 标准的音频端点 `POST {apiBase}/v1/audio/speech`（body 为 `{ model, input, voice, response_format: 'mp3' }`，返回体直接是音频字节）。返回 JSON 会被当成失败并把 body 前 200 字带进报错，而不是当成一段空音频；404 会额外说明「这家可能没有这个端点，或 API Base 少/多层路径」，401 说明「Key 不对或没有该模型权限」。**只做对话的模型服务通常没有这个端点**，能不能配音以服务商文档为准——界面不承诺通用。
- **前置校验跟主进程同一口径**：`checkVoiceReady()` 先看「配音那把 Key 或校对那把 Key，有没有一把在这台机器上解得开」——两把都指望不上才算没配（解不开的那把会直接说「读不出已保存的 Key」并跳到对应的 Tab），然后单独查 `ttsModel`、`ttsVoice` 这两项。缺任何一样都当场拦住、打开「配音配置」，不会带着空值去点「开始配音」烧用户额度。判得比主进程松或严都不行：松了是拿空 `Authorization` 去打接口，紧了会把本来能干活的人拦在门外。
- **两种输入来源，走的同一条合成链路**：「纯文本」由 `splitPlainText` 按行 → 句末 → 停顿切、贪心合并到每块 ≤800 字，每块一段、时间轴全 0，铺轴因此天然退化成「首尾相接」，主进程不需要为朗读另开一条路；「从转写带入」把当前非空段落原样带走，起点/终点就是字幕时间轴，页面上给的是只读摘要——要改文字得回转写页编辑，配音页不动字幕一个字。
- **计费与耗时**：逐段串行——云端档一段一次请求、按服务商计费方式扣费，本地档一段一次交给本机引擎、不花钱；整条耗时云端档取决于接口响应速度，本地档取决于本机推理（第一次还多了引擎起来 + 模型读进内存那两笔）。左列在点下去之前就把账写清楚：纯文本给「N 字 · 会切成 M 次调用」，从转写带入给「共 K 段可配音，约 X 字」和「另外 n 段是空的，会被跳过、不占用一次合成」，最下面那行按档分叉：云端档「将调用 M 次接口（逐段串行，按服务商计费）」，本地档「本机合成 M 段（逐段串行，不调接口、不花钱）。第一次配音要多花几秒…」，旁边摆「试听第一句」。
- **音色与倍速只作用于这一次任务**：工作台上的这两个字段作为 `tts:preview` / `tts:synthesize` 的第二个参数交给主进程收口，**不写回 `settings.json`**——在这一页试错的音色不该变成用户的长期默认值（那要去「配音配置」点「保存设置」）。音色留空＝不覆盖，按设置里那个走；倍速只给固定档位 `0.5 / 0.75 / 1 / 1.25 / 1.5 / 2`（接口字段本是 0.25–4.0 的连续值，让人手打 8 只会得到一条废音轨），并且只在 ≠1 时才进请求体的 `speed`。某家是不是照单实现由接口说了算，界面把这句话写在按钮旁边，不替服务商承诺。
- **产物是一条独立音轨**：MP3（44.1kHz 单声道、192k）。按字幕时间轴铺开时，某段配音比它的字幕槽位长就顺延到后面，整条往后推——不截断、不做重叠混音，所以**这条轨可能比原时间轴长**。结果卡按来源说人话：从转写带入给「配音轨 00:42 · 体积 / 原时间轴到 00:27，这条比它长（差 00:14）/ n 段配音比字幕槽位长，已顺延到后面——这条轨和画面越到后面差得越多」；纯文本那一路没有时间轴，就写「纯文本连续朗读，按顺序首尾相接」，不把「相对字幕槽位」的警告套到一个根本不存在的槽位上。两条都照实写明「字幕与时间轴没有改动，这是一条独立的音轨」。越到后面偏差越大，对画面时要以这条轨为准重铺字幕，而不是直接盖在原时间轴上。
- **失败与取消**：连续 3 段失败即熔断停下整批（熔断原因与「用户自己点了取消」分开报），失败清单在结果卡上列出前 3 段的原话（「第 n 段：`failure.error`」，标题是「n 段失败：」），剩下的并成一句「还有 n 段，原因同上一类」；「取消」只停后面的段——正在飞的那一次请求、正在念的那一段都要等它回来，已经合成的照样拼成一条轨。只剩本地拼轨这一步时**界面上没有取消按钮**（主进程那一步也没有取消位，`tts:cancel` 此时回 `late`，绝不回 `success: true`），同一张卡的提示行改说「不再调接口、不再花钱，但也停不下来…等它跑完轨照常给你」，并且**不置「正在取消…」**——置了就等于跟着骗人。一段都没成时不会谎报成功，同一张卡换成失败态：整批停下的原因 + 原话（云端档标题是「接口回的原话：」，本地档是「本机引擎回的原话：」）+「去配音配置测连接」，最后一行按档分开：云端档写「地址、Key、模型、音色四样里任何一样不对，都长这样」，本地档写「本地这一档不看地址和 Key；引擎二进制、模型、音色编号三样里任何一样不对，都长这样」。
- **产物只有一份留在用户手上**：中间片段与整轨都写在 `$TMPDIR/transcribe-tts-<uuid>/`，配音页「清空」、重开一批、回首页（且这批已跑完）三条路会当场把整目录删掉；切走 tab 不删——这一版产物在清空或重开之前一直能听，回来还能播。要把它留在自己机器上，必须点「保存配音轨」走系统「另存为」，另存出去的副本跟着目录删不掉。进程被强杀没走到那一步时，由下次启动的临时清扫回收（`transcribe-*` 前缀、mtime 超 24 小时）。

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
- 配音整批是**逐段串行**的：云端档一段一次请求、扣的是用户自己 Key 上的额度，所以点「开始配音」之前先看左列那两行账（字数、「将调用 n 次接口」），并先听「试听第一句」那一句——音色不对时第 2 段和第 20 段一样烧钱。本地档不烧钱，但一段一次本机推理，整批下来照样是分钟级的事，而且第一次配音多了「引擎起来 + 模型读进内存」两笔；选的这一档模型不在磁盘上时点下去会被当场拦住（不发起整批），提示去哪下按需组件
- 本地配音的引擎和模型**都不在安装包里**：全新装机上「配音配置」选本地档，测连接会直接说「本地配音组件还没下载」并指路「设置 → 关于与更新 → 按需组件」，而不是转圈等到超时。所以对外别说「装上就能离线配音」，得先跑那一次下载（引擎二进制从本仓库 Release 取、模型从 hf-mirror 取，弱网这一步可能失败，报错按下载链路原样给）
- 端口 8010 是本地配音引擎的约定端口，只绑 `127.0.0.1`，且**一进程一引擎**（引擎 id 启动时由 `VV_TTS_ENGINE` 钉死）：换档不并起第二个进程，而是 `ensure` 里把上一代收掉再开新的（所以换档=重启，端口上留着的还是那一个）。应用被强杀、上一代还占着 8010 时由「重启本地配音引擎」回收，不必退出重开。这批正在逐段合成时不许测连接也不许停引擎，理由见「配音配置」那条
- 配音轨可能比原时间轴长（有段落被顺延），这是刻意不截断、不重叠的结果。拿这条轨对画面时**以配音轨为准重铺字幕**，别直接盖在原时间轴上；配音页结果卡上那句「n 段配音比字幕槽位长」和「差 00:xx」就是给人判断这件事用的——它们只在「从转写带入」时出现，纯文本连续朗读没有字幕槽位可比
- 编译 Python ASR 二进制需要 PyInstaller，它已列在 `python-asr/requirements.txt` 里（`pnpm setup:asr` 一并装上）；`scripts/build-asr.mjs` 用的是 venv 里的解释器，所以必须先建好虚拟环境
- API Key 的加密时机与退化路径：`settings.json` 里的历史明文在**首次读到设置**时就地换成密文（读到才迁，不是启动就迁——没打开设置页、也没跑过任何读配置的链路时，磁盘上那条仍是明文）；本机密钥库不可用时退回明文并在设置里标注，加密抛错也存明文，而不是把用户填的 Key 丢掉。换过电脑导致密文解不开时，设置里的状态、「测试连接」和开工前置校验给的是同一句「这台机器读不出已保存的 API Key…」，重新填一次并保存即恢复
- 链接取内容的临时媒体**不是**下完就删：播放器整场都要拿它做逐句回放，删早了链路末尾只会剩一条「文件已被移动」的 toast（这是 1.0.5 修掉的回归）。站点 cookies 在提取出音频后立刻删，媒体留到「下一段素材开工」或「退出应用」；应用被强杀时这两处都走不到，下次启动由 24 小时清扫兜底。所以 /tmp 里短时间内看到上一份素材是正常的，不是泄漏
- 端口 8000 是本机引擎的约定端口。应用不会复用一个「应答者身份不明」的服务，因此手动起的 `python main.py` 不会被采信；反过来，构建或清理时不要用 `pkill -f vv-asr-server` 之类的通配杀进程，容易连别的工作一起打掉
