# Vv Transcribe

一款基于 Electron 的桌面端音视频转写应用，支持本地/云端 ASR 语音识别、参考稿逐字比对、本地校对与 AI 校对、段落级播放同步、字幕配音和多格式导出。

## 功能特性

- **文件导入**：拖拽或点选本地文件，音频+视频白名单共 31 项（14 种音频 + 17 种视频：MP3/WAV/M4A/FLAC/AIFF/AC3、MP4/MKV/MOV/AVI/WebM/FLV/WMV/TS/M2TS/MXF 等，含广电常见的 MXF 与磁带采集容器）；能否真正解出音轨由 ffprobe 判定
- **链接取内容**：粘贴公开视频链接后**先只解析元信息**（标题 / 时长 / 体积估算 / 清晰度档位），界面在中间态让用户二选一——「转写音频」只取音频轨转 MP3 后汇入同一条转写流，「下载视频」按选中的档位取画面与音频合并 MP4、下满后走系统「另存为」写到用户选的位置。取内容过程中界面给的是实测进度（第 n/2 路 / 合并音视频轨 / 转码中 + 速度与剩余时间），并留「取消下载」入口。合规口径写在界面上：只能取公开视频，需要登录或会员的（抖音、B 站会员片、部分 YouTube）拿不到音频，请先在本地下载好再走「本地文件」上传。内置的这版解析组件还能在「设置 → 关于与更新」里直接更新，站点改规则不必重装应用
- **ASR 语音转写**：引擎由设置里的「转写模式」决定——默认「本地转写」（Python faster-whisper，音频不出本机），显式切到「云端优先」且填了 API Key 才走云端转写接口——1.1.1 起这一趟发成哪一家的形状由方案里那格「厂商」决定（默认仍是 OpenAI 兼容的 Whisper 接口，1.1.1 加 MiniMax、1.1.2 加讯飞共三家；讯飞「录音文件转写大模型版」是三家里唯一「上传音频换订单号、再轮询取结果」的异步接口，收 5 小时以内的长音频，界面上进度会停在「已提交，等对方出结果」那一段，出字仍是一次性——**这一家本机没有凭据、一次真请求都没发过**，形状全部照原厂文档实现，所以文档与界面都不说它验证过），云端失败时回落本地（两条原因一起报，不拿「引擎未运行」盖住真实错误）。上屏方式跟着引擎走：本地逐句流式、编辑器里一段段长出来；云端是一次请求拿整份结果，段落随返回值一次性填进列表（界面已有段落时不覆盖），进度只有几个节点。两条路径都可随时取消
- **转写语言**：12 种语言可选（zh/en/ja/ko/th/vi/id/fr/de/es/ru/ar），本地与云端共用这一设置；刻意不提供「自动检测」
- **参考稿比对**：上传播出稿（TXT/Markdown/SRT/DOCX/PDF）后与转写结果逐字 diff，差异高亮，还可用 AI 逐处解释
- **双方式校对**：本地校对用常见同音误听表 + 内置中文词库给修正与词义提示，不需要任何 API Key；AI 校对调用您配置的模型结合上下文分析。两者都只提建议，逐条「采纳」才生效。非中文素材没有可用的中文规则，此时只走 AI 校对
- **音视频播放器**：播放/暂停、进度拖拽 seek、段落高亮同步，视频文件内嵌播放
- **段落编辑器**：行内编辑转写文本，点击段落跳转到对应播放时间
- **多格式导出**：SRT 字幕 / VTT 字幕 / 台词表 TSV（时间码 + 台词）/ 纯文本 TXT / JSON 数据 / Markdown 文档，走系统「另存为」面板
- **字幕配音**：首页第三个 tab「字幕配音」是一整页工作台，输入来源两种——**纯文本**（自己贴稿，按句切成每块 ≤800 字的朗读单元，一段挨一段念成连续朗读）或**从转写带入**（拿当前转写段落，按字幕时间轴铺）。配音方案（云端档那一格选的是「当前使用」那一条整套凭据，界面上不再手输模型名）、音色、倍速在工作台上选（本地档那一格选的是 VITS / Kokoro 哪一档；云端那档的倍速只透传请求体的 `speed`，服务商不认这个字段就是不认，界面不替它承诺），先「试听第一句」再「开始配音」，逐段串行——云端档一段一次请求，打哪一家的接口由方案里那格「厂商」决定（1.1.1 起认 OpenAI 兼容／MiniMax／阿里云百炼，1.1.2 再加豆包（火山引擎）共四家，没填过这一项的老方案还是 OpenAI 兼容），本地档一段一次交给本机引擎。产物是一条**独立的 MP3 配音轨**（44.1kHz 单声道）：字幕源上某段配音比它的字幕槽位长就顺延到后面、整条往后推，结果卡写明几段被顺延、这条轨比原时间轴长多少——**字幕与时间轴一个字都不改**。跑完点「保存配音轨」走系统「另存为」；不保存的话，清空或重开一批就把这一版产物删掉。空段落直接跳过、不占一次合成；连续 3 段失败自动熔断停下整批；「取消」只停后面的段，已经合成的照样拼成一条轨——等到只剩本地拼轨这一步，界面上就没有取消按钮了（那一步停不下来，拦下来等于把已经合成好的段白扔）。切走再回来进度与产物都还在（状态在 store 里，不跟组件走）；工作台抬头是「返回首页」+「清空文稿」两颗——清空只清输入框里那份稿和它派生的试听片段，已经配好的那条轨不动（删产物另有结果卡那颗「清空」）；**贴进来的那份稿子本身不落盘**，退出应用就没了——1.0.9 的历史记录给这一批记的是那条配音轨的元信息，勾上「留住」留下的是音轨，不是稿子（只有转写那一条留得住正文，因为正文只活在那次会话的界面里）。首页那个 tab 上挂着「实验」标：本地档随 1.0.6 发但按实验功能对待，而两条档共用的铺轴在 Intel / Windows 的打包版上还没跑过端到端冒烟。1.0.8 起 CI 会在三个平台 job 里当场把引擎产物拉起、校一遍身份握手与原生库（#235 路径 A），可那证的是引擎层，铺轴与界面不在这条绿里——#263 摘标等的仍是这两台机器上的手测（路径 B）
- **本地配音（离线，1.0.6 新增）**：「配音配置 → 配音引擎」切成「本地配音（需下载引擎和模型）」后，配音不再调任何远程接口——主进程 spawn 一个 `vv-tts-server` sidecar（sherpa-onnx，Python 冻结出来的单个可执行文件），只绑 `127.0.0.1:8010`，一段一段在本机念完，**不花钱、不上传文稿**。引擎和模型都不塞进安装包：缺哪个下哪个，入口在「设置 → 关于与更新 → 按需组件」（引擎取自家清单 + 本仓库 Release 资产，模型按下钉死的上游 commit 与逐文件 sha256 从 hf-mirror 自取）。本地档是**懒启动**的：打开设置只查状态不会把引擎拉起来，第一次试听或配音才真正启动
- **历史记录**：转写、下载、配音每跑完一次自动记一行——记的是元信息（哪一次、几段、多长、多大、当时用的哪套方案），**正文与产物默认不进账**。入口是标题栏「设置」齿轮旁边那颗图标：点开是一块浮在页面右侧的抽屉，它不参加任何一栏的布局，播放器与编辑器在开与关两种状态下量出来是同一个矩形（代价是它会盖住编辑器右边那一条，收起后一个字都不剩）；收起时整块缩回那颗图标。抽屉里按「全部 / 转写 / 下载 / 配音」四个标签分组，标签上的数字直接取主进程那份列表；每行只有一颗「留住」，勾上才把产物（配音轨、下载到的媒体）或这一刻从界面上交来的稿子正文复制进 `userData/records/keep/<id>/`，从此不受 24 小时临时清扫管。另有「显示」在文件夹里选中留住的那一份，删除只删单条、连它留住的副本一起没（这句在按下去之前写明）。账本最多留 200 条，超了先剪最老的「什么都没留住」那一条；**留住的行不参与修剪**——自动删掉用户点名要留的文件比账本长一点严重得多，代价是那一侧没有上界，所以抽屉底部另说一句「留住了几份、一共占多大」，攒过 2GB 再点名占最多的那一条；越过那条线应用一个字也不会自动删，腾地方是用户自己在那一行点「删除」。这本账读不出来时界面说的是「现在读不出来」，不会说成「还没有记录」
- **设置持久化**：转写、校对、配音三套配置写入 `userData/settings.json`，点「保存设置」才生效；保存后窗口不关，可以直接接着点检测。转写页在云端模式下是「测试连接」、本地模式下是「检查引擎状态」，校对页是「测试连接」，配音页云端档是「测试连接」、本地档还多一个「重启本地配音引擎」——都不保存也能先试一次。1.0.9 起每类配置可以再存**最多 3 套方案**（转写 / 校对 / 配音各一条独立列表，互不影响），一条方案里只装凭据：「当前使用的那套」和「正在编辑的那套」是分开的两件事，编辑没在用的方案不影响正在跑的活，详见「配置说明 → 多套配置」。三个 Tab 从第⑧步起是**同一套界面**：一列「云端XX方案」+ 一个小弹窗。行上显示的是模型名和接口域名（整行不换行，名字再长也只是两边各截断，「当前使用」那一行是一圈发光边框加一枚小徽标），动作只剩新建 / 编辑 / 删除，删除的二次确认是挂在被点那一行下面的气泡，而「当前使用」是弹窗里那颗勾选；点某一行的「编辑」或点**「新建API接入」**都弹出一个**小弹窗**（`ProfileDialog.tsx`），里面只有这一档那几格凭据（转写四格含厂商、校对四格含服务商、配音四格含厂商——「厂商」这一格是 1.1.1 加的，配音和转写同一轮各加一格；转写选到讯飞时是**五格**：多 AppID 与 APISecret、少「模型」）、那颗勾选和底部两颗按钮：「保存」**当场写进磁盘**（新建就是建出这一条，编辑就是改这一条），「取消」把草稿丢掉、磁盘一个字不动。因此右下角那颗「保存设置」从此管不到任何一档的凭据：转写那一页它只剩「转写模式」「本地模型档位」「转写语言」，配音那一页只剩「配音引擎」「本地模型」（1.1.0 起连「本地音色」那一格也撤了——音色是配音页那一次任务的事），而**校对那一页一个全局字段都没有，那颗按钮也就整颗不出现**（点它只会报一句「设置已保存」，而盘上什么都没变）。那一列也只在真走云端时出现：转写看「转写模式＝云端优先」、配音看「配音引擎＝云端接口」，校对本来只有云端。校对方式弹窗和配音页顶部还各挂着一条「XX方案」下拉——只有一套时不出现，做的还是「设为当前使用」这一件事，不是「这一次用哪套」；转写首页原来那条下拉已随这轮重写撤掉，选哪一套只在设置里定
- **密钥加密落盘**：三把 API Key 走系统密钥库（macOS 钥匙串 / Windows DPAPI）加密后写进同一份 `settings.json`，磁盘上的值形如 `v1:<base64>`。输入框不回显已保存的值：留空＝不改，「清除已保存的 Key」要点**弹窗里那颗「保存」**才生效（三档的 Key 从第⑧步起都只住在弹窗里，右下角那颗「保存设置」碰不到它）。历史明文在首次读到时就地换成密文；这台机器用不了密钥库时退回明文落盘并在设置里如实标注，读不出密文（换过电脑）时提示重新填写——任何一步都不会静默丢掉用户填的 Key。这份文件本身也按同样的标准处置：解不开时先把原件改名留档再当面说明，连内容都读不出来时直接禁止落盘（保存会给出原因而不是假报成功），设置里的「本机数据」一栏随时能打开那个目录
- **故障自救**：本地转写引擎没能起来时在「设置 → 转写配置」点「重启本地引擎」，本地配音起不来（端口被上一代占住、启动后秒退）时在「设置 → 配音配置」点「重启本地配音引擎」，都不必退出应用；「关于与更新 → 打开日志文件夹」直接取日志
- **帮助文档**：「设置 → 关于与更新 → 打开使用文档」用系统浏览器打开官网那一页（`vvscribe.com/docs`），转写 / 校对 / 字幕配音的操作步骤和常见问题都写在那里。应用里不抄一份内容——抄了就会有第二份需要跟着线上改的文档，而线上那份改起来没人记得改这里
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
| ASR 转写 | Python faster-whisper（本地，FastAPI + NDJSON 流式）/ 云端三家（1.1.2 起，走哪一条由方案里那格「厂商」决定）：OpenAI 兼容 `POST {apiBase}/v1/audio/transcriptions`（multipart）／MiniMax `POST {apiBase}/v1/speech_to_text`（multipart，语言走请求头）／讯飞「录音文件转写大模型版」`POST {apiBase}/v2/upload`（音频以 `application/octet-stream` 的裸字节上传）换订单号、再 `POST {apiBase}/v2/getResult` 轮询取结果，每趟现算一次 HMAC-SHA1 签名放 `signature` 请求头，凭据三样（AppID / APIKey / APISecret） |
| 校对 | 本地规则校对（误听表 + chinese-xinhua 词库 + 参考稿 diff）/ OpenAI 兼容大模型接口 |
| 配音（TTS） | 一次一句，请求形状跟着方案里那格「厂商」走（1.1.1 起，1.1.2 加到四家）：OpenAI 兼容 `POST {apiBase}/v1/audio/speech`（body `{model, input, voice, response_format:'mp3'}`）／MiniMax `POST {apiBase}/v1/t2a_v2`（`{model, text, stream:false, output_format:'hex', voice_setting:{voice_id, speed}}`，音频回的是十六进制字符串）／阿里云百炼 `POST {apiBase}/api/v1/services/audio/tts/SpeechSynthesizer`（`{model, input:{text, voice, format, rate}}`，非流式回的是一个 24 小时有效的签名地址，音频要再取一次）／豆包（火山引擎）`POST {apiBase}/api/v3/tts/unidirectional`（`{req_params:{audio_params:{format,sample_rate,speech_rate}, text, speaker}}`，鉴权是 `X-Api-Key` + `X-Api-Resource-Id`，回包是一行一帧的 NDJSON、音频按 base64 分帧）；四家都只在这一层不同，倍速只在 ≠1 时才带（豆包那一家的单位是百分比增量而不是倍数），拿到的一律是 mp3 字节，之后 FFmpeg 铺轴拼接（每段先解成 44.1k 单声道 PCM 量准长度，再按时轴垫静音 `concat` 串成一条，`libmp3lame` 192k 输出） |
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
│   │   │   ├── guard.ts               #   唯一的 ipcMain.handle 调用点：每条通道必须声明自己失败回什么形状
│   │   │   ├── fileHandlers.ts        #   文件选择/元数据/音频提取/参考稿读取/另存为/打开日志目录
│   │   │   ├── asrHandlers.ts         #   转写任务：开始、取消、应用内重启引擎、进度推送
│   │   │   ├── aiHandlers.ts          #   AI 校对、差异解释、参考稿分析
│   │   │   ├── proofreadHandlers.ts   #   本地校对与规则解释（完全不读 API Key）
│   │   │   ├── ttsHandlers.ts         #   配音：试听、整批合成、进度推送、取消、另存为、释放这批、本地引擎状态/重启/停止
│   │   │   ├── componentHandlers.ts   #   按需组件（本地配音引擎与模型）：列出、对清单、下载、取消、删除、占用查询
│   │   │   ├── historyHandlers.ts     #   历史记录那五条：读账、留住、取消留住、删单条、在文件夹里显示
│   │   │   ├── settingsHandlers.ts    #   设置读写 + 「测试连接」
│   │   │   ├── dictionaryHandlers.ts  #   词典查询、版本检查、更新下载
│   │   │   ├── updateHandlers.ts      #   版本号、检查更新、外链与系统设置入口
│   │   │   └── windowHandlers.ts      #   自绘标题栏：最大化 / 最小化 / 关闭
│   │   └── services/
│   │       ├── audioProcessor.ts      #   FFmpeg 提取 16kHz WAV、探测、临时目录清理
│   │       ├── asrServiceManager.ts   #   引擎子进程生命周期：bootId 握手 / 残尸回收 / 进程树关闭 / 应用内重启
│   │       ├── asr/                   #   转写 provider：types、asrManager（按「转写模式」分流）、
│   │       │                          #     cloudASR、localASR（读 NDJSON 逐句流）、
│   │       │                          #     asrVendor（1.1.1 转写侧厂商适配层：按厂商拼 URL 与 multipart 字段，
│   │       │                          #     真转写与「测试连接」共用这一个函数；OpenAI 兼容与 MiniMax 响应同形，
│   │       │                          #     所以解析不分叉）、iflytekAsr（1.1.2 讯飞「录音文件转写大模型版」：
│   │       │                          #     上传换订单号 → 轮询取结果，签名每趟现算，所以单独一个文件；
│   │       │                          #     出口仍是同一份 AsrReadResult，「这一家是谁」的判据只在 asrVendor 一处）
│   │       ├── ruleProofread.ts       #   误听表 + 词库的规则校对
│   │       ├── localProofread.ts      #   本地校对编排（误听表 + 词库 + 参考稿 diff）
│   │       ├── asrErrorMap.ts         #   常见同音误听表与易混词辨析数据
│   │       ├── dictionaryService.ts   #   中文词典加载 / 查询 / GitHub 更新
│   │       ├── ai/                    #   AI 校对：types（Provider 接口）+ openaiCompatible
│   │       │                          #     中文走误听表 + 词典 prompt，其他语言走通用 prompt
│   │       ├── ttsService.ts          #   配音：逐段合成落盘 + 解码量准时长 + 铺轴（溢出顺延）+ 静音垫 concat 拼成整轨（命令行超预算时分块）；云端/本地两档分流与这批账目（含取消落在哪一步）
│   │       ├── ttsVendor.ts           #   云端配音的厂商适配层（1.1.1）：按厂商拼请求（URL/头/body）+ 把这一家的响应换成音频字节；
│   │       │                          #     真合成与「测试连接」共用这两个函数，音色必填性也由这一张表说清
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
│   │       ├── settingsService.ts     #   userData/settings.json 读写 + 内存缓存；Key 密文落盘，对外只给脱敏视图；
│   │       │                          #     解不开先留档再报，读不出内容就拦住落盘；磁盘上按能力各存一份方案列表
│   │       │                          #     （方案里只有凭据：地址 / Key / 模型），非凭据那几个开关存在文档根上的全局段，
│   │       │                          #     界面上那 18 个扁平键由 flattenFor 按「全局段 + 这次用哪条」投出来
│   │       ├── userDataStore.ts       #   用户数据目录的唯一规范层：路径（全仓库只有这里读 app.getPath('userData')）、
│   │       │                          #     读（ok/missing/corrupt/unreadable 四种结局）、原子写（.tmp→rename、.bak 备份）
│   │       ├── settingsSchema.ts      #   配置文档的 schemaVersion 与迁移链注册表；升版本只改这里
│   │       ├── historyService.ts      #   历史账本：`records/history.json` 读写（走 userDataStore 的原子写）+ 200 条修剪
│   │       │                          #     + 「留住」把产物/正文复制进 `records/keep/<id>/`（原件位置只认账上那份）
│   │       │                          #     + 记一笔账从不抛错：转写已经成功了，记账失败不能把它变成一次失败
│   │       ├── logger.ts              #   主进程日志的唯一写入口（落 userData/logs/app.log，单文件 5MB、留 3 份轮转）；
│   │       │                          #     崩溃路径另有一条同步落盘的 errorSync，两条口都绕不开下面那道闸门
│   │       ├── logRedact.ts           #   落盘前的统一脱敏（#281）：按键名隐凭据与原文、按形状收凭据与绝对路径、按尺寸截断
│   │       └── crashWatch.ts          #   崩溃兜底：主进程 uncaughtException/未处理拒绝 + 界面进程与子进程消失 + 主框架加载失败；
│   │                                  #     现场先同步落盘再谈界面，重载/退出都由人点头（见「注意事项」那条）
│   ├── preload/                       # contextBridge 暴露 window.electronAPI（index.d.ts 是类型声明）
│   └── resources/dictionary/          # 内置词库：ci.json / idiom.json / version.json
│
├── src/                               # React 渲染进程
│   ├── main.tsx / index.css           # 入口与全局样式（Tailwind + 明暗主题变量）
│   ├── router/index.tsx               # HashRouter，业务页只有一个 `/`（配音工作台是页面内的 tab 状态，不另开路由）
│   ├── pages/Transcription.tsx        # 上传 / 转写中 / 结果 三态切换，外加「字幕配音」整页工作台的分流
│   ├── components/
│   │   ├── SplashScreen.tsx           #   开屏：只有冷启动播，显示引擎就绪到哪一步
│   │   ├── ErrorPage.tsx              #   前置服务（词典/ASR）没起来时的整页提示，让人重启应用
│   │   ├── ErrorBoundary.tsx          #   渲染期抛错的兜底卡片：说原因 + 复制详情 / 打开日志文件夹 / 重新加载
│   │   ├── ui/                        #   自研 Toast / Dropdown / Popover
│   │   ├── transcription/             #   StudioTabs（顶部 tab：本地文件 / 音视频链接 / 字幕配音；进了配音页只剩一个返回入口，
│   │   │                              #     按钮样式与转写结果页那颗一致）、
│   │   │                              #     FileUploader（本地 / 链接；这轮重写后首页不再挂「转写方案」下拉）、UploadStatus、
│   │   │                              #     AudioPlayer、TranscriptEditor、SegmentRow、DiffPanel、
│   │   │                              #     ProofreadModeDialog（两张方式卡 + 「校对方案」那一格，多于一条时才出现）、
│   │   │                              #     VoiceStudio（配音工作台：输入来源 + 第一格按档位分叉（本地＝配音模型下拉、
│   │   │                              #     云端＝配音方案下拉且多于一条才出现）+ 音色（本地是编号下拉、云端手输，1.1.0 起
│   │   │                              #     这一页唯一的音色入口）+ 倍速 + 试听 + 合成中 + 结果卡；
│   │   │                              #     「云端还是本地」不在这一页给选择，只在设置里定）、
│   │   │                              #     HistoryPanel（历史记录抽屉：浮在三种视图之上、不参加任何一栏的 flex，
│   │   │                              #     入口是标题栏那颗图标，收起时整块缩向它；四个标签按作业种类分组，
│   │   │                              #     一行只有「留住 / 显示 / 删除」三件事，删除走挂在行下的气泡二次确认）
│   │   └── settings/                  #   SettingsModal.tsx（转写配置 / 校对配置 / 配音配置 / 主题 / 关于与更新）
│   │       ├── ProfileList.tsx        #   三个 Tab 共用的「云端XX方案」列表（#222 重写第⑧步收成一份）：一行一套（模型名 · 域名）
│   │       │                          #     + 新建API接入 / 编辑 / 删除（两颗入口都只开弹窗，列表自己一个字节都不写盘）
│   │       │                          #     删除的二次确认是挂在被点那一行下面的气泡；「当前使用」那一行是一圈发光边框 + 一枚徽标
│   │       │                          #     这一档有哪几格、每格下面那句说明，全从 utils/profileSpec 那张表读，组件不写死任何一档
│   │       ├── ProfileDialog.tsx      #   三档共用的「新建API接入／编辑API接入」小弹窗：按那张表画格子
│   │       │                          #     + 那颗「当前使用」勾选 + 底部「取消 / 保存」；「保存」当场写磁盘，
│   │       │                          #     遮罩挡住外层点击，收场只有「取消」、右上角 X、Esc 三条路
│   │       ├── ApiKeyField.tsx        #   API Key 那一格（三档共用，只在弹窗里出现）：不回显已保存的值，给的是状态
│   │       │                          #     有字＝替换 / 「清除」＝清空 / 都没＝不发这个键；「保存」那颗按钮的叫法是参数
│   │       ├── ProfileSwitchSelect.tsx#   两处共用的「XX方案」下拉（校对弹窗 / 配音页），
│   │       │                          #     只有一套或列表没读出来时整块不出现；落盘与话术都在 useProfileStore 一处
│   │       └── ComponentsSection.tsx  #   「按需组件」一栏：本地配音引擎与两份模型的下载、进度、删除、停引擎
│   ├── stores/                        #   useTranscriptionStore、usePlayerStore、useReferenceStore、
│   │                                  #     useSettingsModalStore、useThemeStore、useVoiceStudioStore（均 Zustand；
│   │                                  #     顶部 tab 也在最后一个里——配音是分钟级后台任务，状态跟组件走会丢）、
│   │                                  #     useProfileStore（三个页面那条「方案」下拉共用的状态：一次 listProfiles 给全三档，
│   │                                  #     切方案的动作、话术与在途标记都收在这一个 setProfile 里）、
│   │                                  #     useHistoryStore（抽屉自己：开合、停在哪个标签、刚从盘上读回来的那一份列表。
│   │                                  #     入口那颗图标在标题栏、抽屉浮在 main 之外，两处一收一开，状态跟组件走会丢；
│   │                                  #     `items: null` 与 `[]` 是两句话，这里不许折成一个）
│   ├── hooks/useElectronAPI.ts        #   非 Electron 环境的安全降级
│   ├── hooks/useProfiles.ts           #   页面挂载时读一次方案列表（下拉自己决定长不长出来，读不能交给它）
│   ├── types/                         #   transcription.ts、reference.ts、voice.ts、settingsProfile.ts（方案列表的跨 IPC 形状）、
│   │                                  #     history.ts（账本那一行的界面形状：元信息 + 三档 id + keptProduct/keptDraft +
│   │                                  #     productAvailable，原件此刻还在不在盘上由主进程判）
│   └── utils/                         #   asrLanguage（12 语种 + 本地校对适用性）、segmentDiff、textAlignment、
│                                      #     correctedTextAlignment、referenceComparator、exportTranscript、
│                                      #     splitPlainText（纯文本稿按句切成 ≤800 字的朗读块）、
│                                      #     localTtsEngines（本地引擎白名单选项、音色编号枚举、缺件该说哪句话）、
│                                      #     profileSpec（三档方案共用的一张表：有哪几格、每格叫什么、列表/弹窗/删除确认
│                                      #     里那句怎么说、行上显示哪两样；与主进程 CAPABILITY_FIELDS 一一对应）、
│                                      #     readiness（阻塞项统一提示）、userData（打开 userData 目录，三处共用一个入口，
│                                      #     失败一定要弹出来而不是默默没反应）、logger、
│                                      #     rendererErrorWatch（事件回调 / Promise 里那两类 ErrorBoundary 接不到的抛错：
│                                      #     落日志 + toast，8 秒内同一句话只说一次；也是 app:errorNotice 的收件方）
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
│                                      #   触发只剩 Actions 面板手点：2026-10-29 把 components/v* 那条 tag 触发摘了
│                                      #   （build.yml 接管资产后，它跑到底只会得到一枚 422 的红 X，
│                                      #   代价是这条路现在需要有 gh/PAT 或直接在网页上点，推 tag 不再作数）。
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
│       logger · crashWatch                                     │
└───────┬───────────────────────┬──────────────────────┬────────┘
        │ HTTP :8000 与 :8010   │ spawn                │ HTTPS（云端转写/校对要显式配置才走，配音云端档是默认；
        │                      │                      │ 链接转写、词库检查更新按用户操作发起）
┌───────┴───────────┐  ┌────────┴─────────┐  ┌─────────┴────────────┐
│ 本机 Python 引擎  │  │ yt-dlp（随包）   │  │ 云端 ASR / OpenAI 兼容│
│ 两个 sidecar，同一│  │ + 临时浏览器配置 │  │ 大模型 / 配音接口     │
│ 套生命周期口径：  │  │ 取站点 cookies   │  │                      │
│  8000 ASR：       │  └──────────────────┘  │ 另：按需组件从本仓库  │
│  faster-whisper   │                        │ Release 取引擎二进制、│
│  8010 本地配音：  │                        │ 从 hf-mirror 逐文件取 │
│  sherpa-onnx      │                        │ 模型（sha256 校验）   │
└───────────────────┘                        └──────────────────────┘
```

只有主进程直连 8000 / 8010 与外部接口，渲染层不发任何 `fetch`。两个本机端口都是「一进程一服务、启动时钉死身份」：ASR 用 `bootId` 握手确认应答者是自己这次拉起的那个，配音引擎除此之外还用 `VV_TTS_ENGINE` 把引擎 id 钉在进程上（换档＝重起，端口上留着的还是那一个）。配音这一路只绑 `127.0.0.1:8010`（ASR 那个 8000 绑了 0.0.0.0 是历史遗留，新服务不重复）。密钥也不进渲染层：`settings:get` 返回的是脱敏视图——三把 Key 字段被剔除，只留 `asrKeyStatus` / `aiKeyStatus` / `ttsKeyStatus`（无 / 密文 / 明文 / 解不开）、`keyEncryptionAvailable`（本机密钥库能不能用）与 `storageProblem`（这份配置是不是正常从磁盘读出来的，见「注意事项」）；这份视图投的是**各档当前默认那条方案**的字段——磁盘上从 v2 起按能力各存一份方案列表（`profiles` + `defaultProfileId`，#222 方案 A），一条方案里只装凭据（接口地址 / Key / 模型，校对与配音各再带一个「这套是哪家」的服务商／厂商书签）；「转写模式、本地档位、转写语言」这三个开关不住在方案里，它们存在文档根上的一段全局值，切方案不会把它们一起切走（本地转写模式挂着一套云端 Key 是同一台机器上的常态，不是两套配置）。界面上那 18 个扁平键是这两段合起来的对外形状。解密结果只在主进程里用于转写、校对、配音和「测试连接」。引擎由主进程按需拉起（本地配音是懒启动：只有真开始配音/试听才 `ensure`，打开设置页不会把它拉起来），退出时按进程树优雅关闭。

### 数据流

```
本地文件转写：
  FileUploader（拖拽经 preload 的 webUtils 取路径 / dialog:selectFile 点选）
    → IPC file:getMetadata → 名称、大小、类型，并按主进程白名单判 supported
    → IPC asr:start（带上设置里的「转写语言」）
      → audioProcessor.extractAudio() → ffprobe 确认有音轨 → FFmpeg 转 16kHz WAV（临时目录）
      → asrManager.runTranscription()
          「云端优先」且填了 Key → cloudASR → 按方案里那格「厂商」拼请求（`asrVendor`，1.1.1）：
                                   openai＝POST {apiBase}/v1/audio/transcriptions；minimax＝POST {apiBase}/v1/speech_to_text
                                   两家返回同形（segments[].start/end/text，单位秒），所以解析不分叉
                                   iflytek（1.1.2，#343）＝POST {apiBase}/v2/upload（音频裸字节）换订单号
                                     → 每 3 秒 POST {apiBase}/v2/getResult 轮询到 status 4／-1（真转写上界 1 小时、
                                       自检上界 3 分钟）→ 解 orderResult（双层字符串化的 lattice，bg/ed 是毫秒字符串）
                                     每趟现算 HMAC-SHA1 签名放 signature 头，所以这一家不走 buildAsrRequest
                                     （形状收在 `asr/iflytekAsr.ts`，出口仍是同一份「秒 + 段」）
                                   失败则记录原因并回落本地
                                   一次请求拿整份结果：进度只有 2 / 10 / 80 / 100 几个点，
                                   不逐段推流，段落全在 asr:start 的返回值里（讯飞那一家中间多几趟轮询，
                                   进度条钉在「已提交，等对方出结果」那一段，出字仍是一次性）
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
  音色、倍速、本地模型是「这一次任务」的参数（本地档那一格「配音模型」选的是 VITS / Kokoro 哪一档，走 `localEngine`；
    云端那一格是「配音方案」下拉，它改的是磁盘上的「当前使用」指针，不进这一份参数——模型名从 1.1.0 起跟着方案整套走，
    界面上没有手输模型的地方）：
    作为 `tts:preview` / `tts:synthesize` 的第二个参数交给主进程收口，**不写回 `settings.json`**——
    工作台上的试错不该变成用户的长期默认值——但 1.1.0 起「长期那一份」只剩两样还在设置页有格子（配音引擎、本地模型）：
    两档的音色在设置页都没有格子了，倍速本来就没有，所以这一页的音色就是它唯一的入口，不是「先在这儿试、再去设置里定」
    空串＝不覆盖、按设置里那个走；`localEngine` 过白名单（它会被拼进模型目录名和 sidecar 的 engine 字段）。
    「云端还是本地」这一档本身不在可覆盖之列——它决定的是这次要不要花钱、要不要拉起本机进程，属于已保存的长期选择
    倍速只在 ≠1 时才进云端请求体的 `speed`；接口字段是 0.25–4.0，但某家是不是照单实现由接口说了算，界面不替它承诺
    云端音色这一格空着时走 `withOverrides` 的 `voice || base.voice`，而 `base.voice` 从 1.1.1 起按厂商给：OpenAI 兼容
    那一档取设置里那一份 `ttsVoice`，所以「空着＝不发」只在**那一份也是空**的时候才成立，它有值时发出去的就是它；
    MiniMax／百炼／豆包那一档 `getTTSConfig` 直接投空串（`alloy` 是别家的名字，发过去只换来一句「没有这个音色」，
    而那句读起来像网关配错了），于是「空着」在这三家就是真的空着，由 `ttsConfigProblem` 在发出去之前拦下。
    界面那句提示按这几种情况分叉（1.1.0 真渲染抓到：根上存着 alloy，页面却写着「留空＝请求里干脆不发这一项」）。
    有些配音模型本来不收 voice，发一个空串过去会被当成
    「要一个叫空字符串的音色」，报回来的 400 会被读成「这家不支持配音」
  前置校验：配音在「设置 → 配音配置」里有自己的一整组值——接口地址与 Key 留空时按 getTTSConfig 的口径沿用
    校对那一套，但配音模型**不回落**：音频接口吃的是配音模型 id，拿 chat 模型去调必然被拒。
    「试听第一句」与「开始配音」过的是**同一道** checkVoiceReady（`src/utils/readiness.ts`），
    传的是 callOptions 那一份覆盖参数（界面当前选的音色/倍速/本地模型），与真跑起来交给主进程的值一个字不差——
    以前只有整批走这道、试听另问一遍「缓存里模型在不在」，两边口径对不上，引擎没下载时点试听会一路掉到
    主进程的兜底文案。Key（配音或校对两把里任一可用）与配音模型缺任何一项都不发起调用：
    toast 说清缺的是哪一项，并当场打开对应的那个设置 tab。音色不在这道门里（1.1.0 拍板，1.1.1 仍然不改）：各家字段与取值都不一样，
    拦下等于替用户猜一份「这个模型该有音色」的清单——填错了由服务商回原话，界面把那句原话送到结果卡上。
    MiniMax／百炼／豆包那种「这家一定要有一个音色」的空值由主进程 `ttsConfigProblem` 在发请求之前拦（1.1.1，
    试听与整批都过它），判据是 `ttsVendorNeedsVoice`；渲染层 `checkVoiceReady` 仍然不碰音色，界面那两句提示读的是
    `profileSpec.ts` 里那张按厂商的表（两处不一致的症状见「配音」小节）。
    本地档走另一问：不看地址和 Key，只拦「组件不在场」，且**现问一次主进程**（不拿页面进页面时缓存的那份
    当闸门——用户在别处下载完、或手工挪走模型目录之后，缓存不会自己变）。两样缺件各自按自己的位分叉：
    引擎看本版清单里有没有那一条（`binaryInManifest`，随状态一起回，来自会话缓存、不联网），
    模型看这一档钉没钉上游指纹表（`hasInAppModelDownload`）——有包的说去哪一行下、开的就是「关于与更新」，
    没包的说换回 VITS 或改用云端档、开的是「配音配置」。**清单一律不许写成「去下载就行」**：那一行在
    没有包时是收着按钮的，把人领过去只能让他自己发现点不动。缺哪样说哪样，另一样已在磁盘上时明说不用重下，
    行名点的是那一栏真显示的标题（与主进程 `COMPONENT_ROW_TITLES` 同一份常量）。
    音色填的不是编号再单独拦一次；`ready:false` **不算**阻塞条件（懒启动的引擎只是还没起过，
    要求用户先去手动点一次「启动引擎」是凭空加一步）
    这一层是唯一的：配音是一整页，不再是弹窗底下又叠一个设置弹窗（那种两层互相盖住的坑见 #220）
  试听：云端档 IPC tts:preview(text, opts) → 按方案里那格「厂商」拼出这一家的地址与 body（OpenAI 兼容是 `POST {apiBase}/v1/audio/speech` + `response_format=mp3`，
    MiniMax 是 `/v1/t2a_v2`、百炼是 `/api/v1/services/audio/tts/SpeechSynthesizer`、豆包是 `/api/v3/tts/unidirectional`，
    三家的音频都不在响应体裸字节里，见 `ttsVendor.ts`）→ 换成 mp3 字节落盘
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
      +「去配音配置测连接」，不假装成功；云端档那句是「厂商、地址、Key、模型这四样里任何一样不对都长这样」，
      音色那半句按厂商分叉（OpenAI 兼容＝「音色是可选的，填了而这个模型不认，也是这一句」；MiniMax／百炼／豆包＝「『这一家的名字』还不收空音色——没填音色当场就拦下、不调接口，填了但这家不认这个音色也长这样」，名字是当场按厂商插进去的）；
      本地档那句换成「本地这一档不看地址和 Key；引擎二进制、模型、音色编号三样里任何一样不对，都长这样」
    → 页内 `<audio controls>` 直接播这条轨（file:// 绝对路径，和回放转写源音频同一套加载口径）
    → 「保存配音轨」IPC tts:saveTrack：系统「另存为」+ copyFile（另存出去的副本不跟着临时目录删）
    → 「清空」/ 重开一批 / 回首页时 IPC tts:releaseBatch 当场删掉这批临时目录；正在跑的那批不删，
      切走 tab 也不删——产物得留着，回到配音页还能听（没另存出去的产物就到此为止）
      （进程被强杀走不到这步，由下次启动的 sweepStaleMediaTempDirs 回收——同一套 `transcribe-*` 前缀）

历史记录（#247：跑完一次自动记一笔，产物「勾了才留」）：
  记账点在三个完成点，都在主进程，界面一个字都不参与（渲染层报上来的路径一律不信）：
    IPC asr:start 成功返回后 → kind='transcribe'，id 就是 jobId，profiles 只填 asr 那一格
      提取出来的 wav 在那一步的 cleanupTemp 就没了，所以这一类 `source: null`——没有产物可留，
      界面上那一勾写的是「留住稿子」，留的是这一刻从渲染层交来的正文（不是重播那次转写）
    IPC tts:synthesize 拼完整条轨后 → kind='voice'，id 是这批的 jobId，profiles 只填 tts
      `source` 记的是批次目录里那条 `voice-track.mp3`：批次还在时那一勾点得动，
      界面清空结果或返回首页会 releaseBatch，那时原件没了，留住得赶在之前勾
    urlDownloader 下载落盘后 → kind='download'，id 是 sessionId，三格 profiles 全空
      （下载不读任何一档凭据，记不出「用的哪套」，硬填是撒谎）
  账本 `userData/records/history.json`（`{ schemaVersion, records[] }`，走 userDataStore 的原子写）：
    最多 200 条，超了先修剪「什么都没留住」里最老的那一条；认不得的行不显示，但原样写回，不替用户改写他读不到的东西
    留住的行**不参与修剪**（自动删掉用户点名要留的文件比账本长一点严重得多），所以那一侧没有上界，只能靠界面把占了多大说出来
    每条只记元信息 + 三档方案 id（改名不影响引用：`settings:renameProfile` 不动 id）
    **正文一个字都不进账**——日志与账本同样受 logRedact 那道闸门管，稿子只在用户当面勾「留住稿子」时跨一次 IPC
  那一勾（IPC history:keep）：产物按账上 `source` 的原件位置复制进 `records/keep/<id>/`，正文写 `keep/<id>/draft.txt`，
    两份引用在同一个排他块里一次写盘——要么一起进账，要么都不进，不许亮成「留住了」而盘上只有一半
  `history:list` 每行另回一个 `keptBytes`（留住那一到两份在盘上的真实字节数；没勾的恒为 0，
    连还留在临时目录里的原件也不算进去——它 24 小时后就不在了，算进去的数第二天就对不上）：
    抽屉底部那句「留住了几份，一共多大」就是把它累起来，攒过 2GB 再点名占最多的那一条，
    那句话只说数、不删东西，出口是那一行本来就有的一颗「删除」
  界面是标题栏那颗图标开的一块浮层（`HistoryPanel.tsx`，`position: fixed`）：它不参加任何一栏的 flex，
    所以播放器与编辑器在开与关两种状态下量出来是同一个矩形（本机实测 480×735 / 301×735 一个像素不差）；
    代价是它会盖住编辑器右边那一条——这是「不许挤压」换来的，收起后一个字都不剩
```

### IPC 通道一览

preload 用 contextBridge 把这些通道包成 `window.electronAPI`，渲染层拿不到 `ipcRenderer` 本身。下表是主进程注册的全部 76 条（70 条渲染 → 主的调用 + 6 条主 → 渲染推送；`component:cancel` 与 `component:remove` 合写成一行，所以表里 75 行）。

注册只有一处入口：`ipcHandle(channel, handler, fail)`（`electron/main/ipc/guard.ts`），`ipcMain.handle` 在整个 `electron/` 下只出现在那个文件里——这条由 `tests/ipcGuard.test.ts` 守着。「不跨 IPC 抛错」原先只是两个 handler 文件头上的注释，而收口前 59 条注册里有 40 条函数体连一个 `try` 都搜不到；现在每条通道必须当场声明自己失败回什么形状（没有默认值），任何同步抛出、Promise reject、连失败值都造不出来的情况都收成一趟 `logger.error` 加一个值。统一给一个通用形状是不行的：有的通道回 `[]` 会被界面念成「一个组件都没装」，回 `null` 会让某一栏永远停在「读取中...」——那是谎，不是兜底。日志只记通道名和原因，不记入参（`file:saveText` 的入参是用户的整份文稿）。

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
| `app:openUserDataDirectory` | 渲染 → 主 | 打开 `userData` 本身：设置读不出来时界面唯一的「自己看一眼原件」入口（`settings.json.corrupt-*` 留档和 `.bak` 都住在这层）。失败回 `{ success:false, error }`，不在这里跨 IPC 抛错 |
| `app:errorNotice` | 主 → 渲染 | 崩溃兜底推给用户的一句话（后台子进程没了、某步异步失败没接住）。只有渲染进程还活着才走这条，界面本身没了就只能弹系统对话框；收件方是 `src/utils/rendererErrorWatch.ts`，转成 toast |
| `asr:start` | 渲染 → 主 | 启动转写任务，返回 jobId + 段落，或 `canceled` / 失败原因。options 里的 `profileId` 是 #222 第②步留下的接缝：空或指不到人时按**转写档当前默认那条**跑（不打断手上的活），日志记的是 `resolveProfileId` 问出来的实际那一条，不是界面报回来的那一个。这一档用不上这个参数：首页那条「转写方案」下拉已在 #222 重写第③步撤掉，改用哪一套是在「设置 → 转写配置」的列表里点那一行的「编辑」、勾上「当前使用」再点**弹窗底部的「保存」**定的（见「多套配置（方案）」），所以这条通道收到的仍是空。本地档的档位**不跟着方案走**——它是全局段的 `asrLocalModel`：`asrManager` 在发请求前先跑 `ensureLocalTier(那个全局档位)`，引擎驻留档位不对就把引擎按那一档重起一次（`HF_HUB_OFFLINE` 是 spawn 时按当时的档位钉死的，换档位等于换联网许可），起不来则报错而不是硬发一次注定「模型没下载完」的请求；这里兜的是「点保存时那次自动重启被跳过或失败」的场合（有转写在跑时保存刻意不重启，见下面「换档位就是换引擎」那条） |
| `asr:cancel` | 渲染 → 主 | AbortController 中断当前任务并清理临时目录 |
| `asr:progress` | 主 → 渲染 | 推送 `{ jobId, progress, segment, stage }`，逐句上屏 |
| `asr:restartEngine` | 渲染 → 主 | 应用内重启本地引擎；有任务在跑时直接拒绝 |
| `ai:correct` | 渲染 → 主 | AI 校对（含误听表 + 词典 prompt）；失败回 `error`，不静默返回原文。options 里的 `profileId` 是 #222 第②步留下的接缝：空或指不到人时按**校对档当前默认那条**走；「选择校对方式」弹窗里那条「校对方案」下拉同样只做「设为当前使用」，不填这一格，所以这里现在收到的仍是空——但主进程记日志前先把 id 过一遍 `resolveProfileId`，落盘的是实际用的那条而不是传进来的那条 |
| `ai:explainDifferences` | 渲染 → 主 | 参考稿差异逐处解释，每 50 条一批。第二个参数是同一把 `profileId` 查找键（同上，空＝校对档默认那条），失败时按差异条数补齐等长的解释，不缺席 |
| `ai:analyzeReference` | 渲染 → 主 | 让模型通读参考稿找自身问题。第二个参数同样是 `profileId`（空＝校对档默认那条） |
| `proofread:local` | 渲染 → 主 | 本地校对：误听表 + 词库 + 参考稿 diff，全程不读 API Key |
| `proofread:explain` | 渲染 → 主 | 差异的规则解释（同上，不需要 Key） |
| `tts:preview` | 渲染 → 主 | 配音试听一句。云端档按方案里那格「厂商」发一次合成请求（1.1.1；老方案磁盘上没这一项＝OpenAI 兼容），拿到的 mp3 字节落进临时目录；本地档不打远程接口，同一次调用交给 sidecar 的 `/synthesize`、落的是 `.wav`。两档回同一个形状 `{ clip: { filePath, bytes, duration }, error }`。第二个参数是这一次调用的可覆盖项（`{ voice?, localEngine?, speed?, profileId? }`，空串＝不覆盖、按设置里那个走；`localEngine` 过白名单；`profileId` 是「读哪一套配音方案」这把查找键，不是路径，所以不过白名单——空＝配音档当前默认那条，#222 第②步留下的接缝（配音页那条下拉改的是这个默认本身，不是这一格的值——单次覆盖刻意不做，理由见「多套配置（方案）」）；云端/本地这一档本身不被覆盖），倍速夹进 0.25–4.0（非有限数/≤0 退回 1），主进程收口、不写回设置。`duration`：云端是 ffprobe 读出来的（mp3 的容器估算，只够给这一句显示用，铺轴不认它），本地是引擎自己在响应头 `X-Vv-Duration` 里报的采样换算值；两档读不到都不谎报。整批之前先花这一次代价（云端档是真花钱，本地档不花钱但要等引擎起来），两档验的东西不一样：云端把厂商/地址/Key/模型这几样过一遍（模型这一问 1.1.2 起也按厂商——四家里只有豆包那一档空着才是对的；音色对 OpenAI 兼容那一档是可选的，填了而这个模型不认由服务商回原话；MiniMax／百炼／豆包不收空音色，主进程在发请求之前就拦下），本地把「引擎与模型在不在、这个音色编号能不能念」过一遍 |
| `tts:release` | 渲染 → 主 | 删掉刚才那句试听的产物（主进程本来只留一份，下一次试听会自己回收上一份；配音页点「清空」时当场还掉） |
| `tts:synthesize` | 渲染 → 主 | 整条稿子配音：段落（含时间轴）由渲染层一次传来，第二个参数同样是这一批的可覆盖项（`{ voice?, localEngine?, speed?, profileId? }`，见 `tts:preview` 那行——空串＝按设置里那个走，`profileId` 空＝配音档当前默认那条，对整批生效、不写回设置；开跑前那句 `Batch config` 日志记的是 `resolveProfileId` 落回后的实际那条）。主进程不存第二份时间轴、也不用界面报回来的路径。逐段**串行**（云端档并发只会换来 429；本地档一次推理吃满几个线程，并发只会互相抢核），空段落直接跳过不发起调用，单段 60 秒超时，连续 3 段失败熔断停下整批；跑完按时间轴铺成整轨（每段先解成 PCM 量准长度，再垫静音 `concat`，命令行超字符预算时分块）。回 `{ jobId, track, clipCount, failures, skipped, canceled, abortedReason, error }`——`abortedReason` 只写熔断原因，与「用户自己点了取消」分开报；拼接失败时前面的账目照样带回去，不会抹成「一段都没成」 |
| `tts:progress` | 主 → 渲染 | 推 `{ jobId, stage, index, total, segmentId, note }`，`stage` 五态：`synthesizing` / `skipped` / `failed` / `assembling` / `done`。界面写的是真实段号（「已合成 7 / 12 段」），不做假百分比 |
| `tts:cancel` | 渲染 → 主 | 置取消标志：只停**后面**的段，正在飞的那段等它回来；已经合成的照样拼成一条轨，不白跑。回 `{ success, reason }`，`reason` 三态如实说：`stopped`＝落在逐段循环里、真被停下了；`late`＝循环已经出界、现在在本地拼轨，那一步**没有取消位**（拼接读的是已经落盘/已经花过钱的片段，拦下来等于白扔），所以这里绝不回 `success: true`；`gone`＝这批已经不在了。界面只在 `stopped` 时写「正在取消…」，`late` 给的是「这一步停不下来、等它跑完轨照常给你」 |
| `tts:saveTrack` | 渲染 → 主 | 弹系统「另存为」（默认名 `voice-track.mp3`、MP3 过滤），`copyFile` 到用户选的位置，回 `{ success, canceled, name, error }`。取消不算失败也不释放这批——界面还留着结果态让人再点一次 |
| `tts:releaseBatch` | 渲染 → 主 | 删掉这批的临时目录：配音页「清空」、重开一批、回首页（且这批已跑完）三条路都会触发；**切走 tab 不触发**——产物要留着，回到配音页还能听。另存出去的那份是副本，跟着目录一起删不掉 |
| `tts:voiceList` | 渲染 → 主 | 取这一家能用的音色名单（#340，配音页那一格的候选）。参数是可选的方案 id（同 `tts:localStatus` 那一套：传了就用那条、不传用「当前使用」那条），**只读已保存的配置**，不接受界面传值。回 `{ ok, voices: [{ id, name, source }], error }`，三种状态分得清：`ok:true`＝取到了；`ok:false` 且 `error:null`＝**这家没有可问的地方**（四家里只有 MiniMax 给这条接口，另三家是刻意不接的，理由在 `ttsVendor.VENDOR_VOICE_LIST_PATH` 那张表头上）；`ok:false` 且带 `error`＝问了但没问到（Key 空着、超时、对方回了业务错误码），界面把这句原话摆在那格灰字里并留一条文档链接的出路，输入框本身退回纯手输。`source` 分 `system`／`clone`，后者是这个账号自己复刻的音色 |
| `tts:localStatus` | 渲染 → 主 | 本地配音引擎的只读快照，**不会因此拉起引擎**（懒启动：只是打开设置页就吃 8 秒解包和几百 MB 内存是更坏的答案）。回 `{ binaryPresent, modelPresent, engine, engineLoaded, speakers, sampleRate, port, ready, error, mode, configuredEngine, requestedEngine, binaryInManifest }`。`requestedEngine` 允许界面传还没保存的那个选择，但必须先过白名单——这个值会拼进模型目录名，不能把渲染层传来的字符串直接当路径用。第二个参数是 #222 第②步加的方案 id：多套配音配置之后「这一套要用的引擎装没装好」得能按套问，传空＝问配音档当前默认那一条（`mode`/`configuredEngine` 就是这一条的已保存值）。`speakers` 只有模型真进了内存才有值（`/health` 在此之前不报 `num_speakers`；实测引擎刚重启时仍是 0，跑过第一次真合成才回 5） |
| `tts:localRestart` | 渲染 → 主 | 「重启本地配音引擎」：先回收躺在 8010 上的上一代再重开，换引擎失败、端口被占、启动失败后的重试都走这条。只认**已保存**的配置，不接受界面传值（设置页「点保存才生效」的口径不能在这儿破例），而且不传方案 id——它取的是配音档当前默认那一条的已保存配置（`getTTSConfig()` 空参），所以第④步的「按套重启」要真做得另开口子。已保存档位不是本地时直接回 `{ ok: false, error }` 说明「本地配音引擎没在使用中，无需启动」。同一时刻只允许一次启动/重启，连点会被合并 |
| `tts:localStop` | 渲染 → 主 | 停掉本地引擎且不重开（下一次配音由 `ensure` 懒启动，界面不用管）。存在的理由很具体：「按需组件」那栏要删/换那几个文件，而引擎配音完不会自己退，没这个入口同会话里永远动不了组件。有一批正在逐段合成时**拒绝**停（那会让剩下的段落全失败），回 `{ ok, stopped, error }` |
| `component:list` | 渲染 → 主 | 「设置 → 关于与更新 → 按需组件」打开就读的磁盘快照：每个组件的在场情况、已装版本、占用体积、要不要下载、下载多大，**不联网** |
| `component:check` | 渲染 → 主 | 取自家组件清单对版本（`components-manifest.json`，两条读法：raw.githubusercontent 直连 → api.github.com contents）。国内直连可能要十几秒，界面得有「检查中...」；取不到清单不等于「已是最新」，会如实报错。两类失败分开说：连不上（网络/超时）只报「读不到、可开加速重试」，下载按钮留着；两个入口都答 404 就顺手记下「这一版没发布清单」，靠清单找包的那个组件（引擎）下一行改说「这个版本没有发布对应的下载包」并收起按钮，钉了上游指纹的两份模型不受牵连 |
| `component:install` | 渲染 → 主 | 下载并装上一个组件（id 之外的东西全在主进程决定：从哪读、落到哪、要不要解压），进度经 `component:progress` 推回界面。同一组件重复发起会复用前一份任务并接上同一条进度流，连点不会产生两条下载。落点 `userData/components/` |
| `component:cancel` / `component:remove` | 渲染 → 主 | 取消正在跑的下载 / 删掉已装组件。这个组件没在下载时 `cancel` 直接回错误，不谎报「已取消」 |
| `component:progress` | 主 → 渲染 | 推 `{ id, phase, done, total }`，`phase` 三态：`download` / `extract` / `verify`。129MB 的模型在慢网里要跑几分钟，`total` 未知时是 0，界面按「不显示百分比」处理，不给假百分比 |
| `component:busy` | 渲染 → 主 | 回 `{ engineRunning, synthesizing }`：这两种占用分开报——引擎进程还活着有「停止本地配音引擎」可点，一批正在逐段合成则只能等它跑完或去配音页取消，因为在这里停引擎会让剩下的段落全失败 |
| `dictionary:lookup` | 渲染 → 主 | 查单个词释义。词库现在由主进程在校对/prompt 组装时内部使用，界面暂无调用点 |
| `dictionary:lookupMultiple` | 渲染 → 主 | 批量查词，同上 |
| `dictionary:getVersion` | 渲染 → 主 | 当前词库 commit hash |
| `dictionary:checkUpdate` | 渲染 → 主 | 只对比远端 commit，判断有没有新版 |
| `dictionary:downloadUpdate` | 渲染 → 主 | 下载远端词库更新 |
| `settings:get` | 渲染 → 主 | 读设置的**脱敏视图**：非密钥字段原样，三把 Key 只给状态（`none`/`encrypted`/`plaintext`/`unreadable`）+ 本机密钥库可用性 + `storageProblem`（磁盘那份没读出来、或来自更新版本的应用时给人看的一句话，null＝正常）。读盘失败不会让这个 channel 报错——按默认值返回并带上原因，界面才有的可显示 |
| `settings:save` | 渲染 → 主 | 写设置。渲染层有两个调用方：右下角那颗「保存设置」**只带全局段那几个键**，弹窗里那颗「保存」在编辑已有那一条时也走这条通道，但补丁只带这一档的凭据 + 它的 id（新建那条走 `settings:createProfile`）。落盘走 `userDataStore` 的原子写：tmp+rename，替换前先留一份 `settings.json.bak`，并把 `schemaVersion` 一起盖上）。补丁写进哪几条方案由 `profileIds` 决定：某个字段整个缺席＝那一档当前默认那条（现在只有弹窗会带它，且只带 `{ [该档]: 那一条 id }`；右下角那次一个 id 都不带，各档就落回当前默认那条——而它送的键又只可能是全局段，指针与凭据自然不动）；传了 id 却指不到人**报错**而不是落回默认——静默写到默认那条会吃掉用户另一套他没碰过的配置，且这一步在 `writeRaw` 之前，磁盘上不会留下半个字。**三档的凭据都不再从「保存设置」发出**（第⑧步：`asrApiBase`/`aiApiBase`/`ttsApiBase`… 连同三把 Key 都住在弹窗自己的草稿里，面板上根本没有读它们的地方）。这半句以前只说过转写，而它挡的是一类真出过的事故：草稿不落进表单、表单却跟着每次保存发出去，主进程把它当成「你要存凭据却没先建方案」，整次保存被拦下——本机 CDP 实测过的是「删掉最后一条方案后只改『转写语言』点保存，盘上 `asrLanguage` 停在原值，界面只剩一句『请先点「新建一套」』」。补丁里属于某一档的键按 `CAPABILITY_FIELDS` 写进那条方案的字段，属于全局段的键按 `GLOBAL_FLAT_KEYS` 写进 `store.globals`（这一份表不是手抄的：它是 `DEFAULT_SETTINGS` 里**没被任何一档认领**的那几个键，此刻就是 `asrProvider`/`asrLocalModel`/`asrLanguage`/`ttsEngine`/`ttsLocalEngine`/`ttsVoice`/`ttsLocalVoice` 七个——手抄的表一旦和 `CAPABILITY_FIELDS` 分叉，用户填的值就会被写进一个没人读的位置，那是「读得到、写进去、东西没了」）；两边都不认的键（脱敏视图的状态位、`profileIds` 这类）不会被当成配置落盘。这一档一条方案都没有（还没建过第一条，或刚把最后一条删掉）而补丁里带着凭据时也只**报错**、不代建（`PROFILE_CREATE_FIRST_MESSAGE`）：建方案是「新建API接入」那颗按钮的活，保存里偷偷建一条会让「删掉最后一条」看起来像没生效；只改全局段的保存不受这条拦。界面正常操作从第⑧步起走不到这条闸门——它是主进程侧的不变量，防的是绕过弹窗往 save 塞凭据的调用；`tests/settingsProfiles.test.ts` 直连 IPC 钉住它。Key 字段三态：非空＝替换、`null`＝清除、留空＝整个键不发送、磁盘上那把不动；两张表里的值都只收字符串（手改出来的怪值不该被写回磁盘）。回来的视图按「刚写进去的那几条」投，否则编辑非默认方案时看到的是默认那条，像保存没生效。`defaultProfileIds` 是重写这版加的第二把：那颗「当前使用」勾选三档都住在弹窗里，由弹窗那颗「保存」跟着这一次 `settings:save` 落盘——某一档给了值就改那个指针（给空串＝明确「这一档现在没有正在使用的方案」，靠它把「谁在干活」和「谁在编辑」收成一次点击），整个键缺席则指针不动；给一个指不到人的 id **报错**，和 `profileIds` 同一口径。**界面只在用户真翻过那颗勾选时才发这一把**（拿弹窗草稿的 `isCurrent` 和磁盘上那条指针比出「翻过没有」，没翻过就整个键不带）：没翻过时草稿读到的是基准值，而编辑**非默认**那条时基准值本就是 `false`，照它发等于发一个空串把磁盘上的指针清掉——用户只是进来改个接口地址，出去之后云端转写被拦下说「没有当前使用的方案」，那颗勾他碰都没碰（第⑤步那轮 CDP 抓出来的）。草稿那一次不在这里发：`createProfile` 的 `setDefault` 已经定过一遍了。`tierRestart`（本地引擎要不要按新档位重启）比的是**全局段那一份** `asrLocalModel` 换前换后：档位已经不在方案里，所以「这次编辑的是哪一条方案」与它无关，改凭据的保存一次引擎都不碰（旧写法拿被编辑那条的档位来比，编辑第二套转写方案会平白重启一次引擎、还附一句「新档位才会生效」）。没写进磁盘时不跨 IPC 抛错，回 `saveError` 一句可直接弹的话，界面必须留在原状；这一句有两种来源（原件读不出来 / 那份文件来自更新版本的应用），靠 `SettingsWriteBlockedError` 这个类型分开，不是比字符串——比字符串哪天多一道闸门就会把原因说错。**第三种是方案的规矩**（`SettingsProfileRuleError`，比如那句「这一类现在还没有任何配置方案，这几项没地方可存。请点这一类的「新建API接入」，在弹窗里填好那几格再点弹窗里的「保存」」），`saveErrorMessage` 把它和闸门那一类同样原样透出去，与 `profilesErrorMessage` 一个口径（第⑤步之前漏了一层：规矩那句被包进「设置没能写入（…）。…清出磁盘空间或修好目录权限后再存一次」，让用户去查一个没坏的磁盘）；`tests/settingsProfiles.test.ts` 两头各钉一条——真 EACCES 那句仍留着「不用重填」，证明没把整类一起吞掉。顺带一句：界面在 `saveError` 旁挂的那颗「打开数据目录」是按「没写进磁盘」这个大类给的，规矩那类的真正出路是那一栏自己那颗「新建API接入」，那颗按钮对它没用（不骗人，只是多余） |
| `settings:testConnection` | 渲染 → 主 | 按面板上此刻那一档 + 磁盘上「当前使用」那一条的凭据试一次：`kind='asr'` 探云端接口或本机引擎，`kind='ai'` 探校对接口，`kind='tts'` 探音频接口（真合成一句，约 10 个字）；第三个入参是**一个字符串** `profileId`，只带被测那一档**「当前使用」那条**的 id（第⑧步起三档的凭据都住在弹窗里，面板上不再有「正在编辑的那条」这种东西；弹窗里没点「保存」的那几个字不参与这次自检，hint 里就是这么写的）。表单 Key 留空时它回落到**已保存的那把**，取的是这一条而不是该档当前默认那条（改接口地址不用重贴）——不带 id、或带了却指不到人，都落回该档默认那条，与真干活同一口径。配音这一腿还额外跟 `getTTSConfig` 同口径回落：地址与 Key 留空时用的是**校对档默认那条**的 Key 与地址，而不是界面此刻在编辑的校对方案，否则会出「自检按 B 家网关绿了、点开始配音却走 A 家」这种最难解释的分歧；所以这里刻意**不把三档 id 一起发过去**，一个 id 同时指到两档会让「配音借哪家」由校对那边的选择决定。本地配音档不参与回落（它不读地址与 Key，留空照样开测）。密文解不开则直接报错、不发请求，那句是「这台机器读不出已保存的 API Key」而不是「还没填」。配音的超时跟真实合成一样是 60 秒，不是校对的 30 秒 |
| `settings:listProfiles` | 渲染 → 主 | 三档各自的方案列表（#222 方案档），一次给全：`{ profiles: { asr, ai, tts }, defaultProfileId, maxProfiles, storageProblem }`。每条是脱敏的 `{ id, name, values, keyStatus }`——`values` 的键名是**界面上那 17 个扁平名里属于这一档凭据的那几项**（`asr` 2 个：`asrApiBase`/`asrModel`；`ai` 3 个：`aiProvider`/`aiApiBase`/`aiModel`；`tts` 2 个：`ttsApiBase`/`ttsModel`——配音音色从 1.1.0 起不在方案里），不是磁盘上的字段名（`provider`/`model`）；那 17 个里剩下十个——三把 `*ApiKey` 加 `asrProvider`/`asrLocalModel`/`asrLanguage`/`ttsEngine`/`ttsLocalEngine`/`ttsVoice`/`ttsLocalVoice` 这七个全局段——都不在任何一档的 `values` 里：密钥只给状态位，七个全局值是文档根上那一段，走 `settings:get` 和保存补丁、跟着表单存但不跟方案走。表单状态、`settings:get` 的脱敏视图、保存补丁说的都是扁平名这一套，这里换成磁盘名就等于让渲染层再抄一份字段对照表——那张表一旦和 `CAPABILITY_FIELDS` 分叉，「界面显示 A、实际跑的是 B」就又回来了。API Key 一律不跨 IPC，只带状态位（表里那一行 `*ApiKey` 在投视图时被跳过）。**某一档 `profiles[cap]` 是空数组、`defaultProfileId[cap]` 是空串**是合法状态（还没建过第一条，或刚把最后一条删掉），界面要按「0 配置」显示、给的是那句「一条都还没有：点下面『新建API接入』」；这与「列表没读出来」是两件事——后者整个返回 `null`。设置窗口打开时读一次就够，切 Tab 不再重读——重读会把用户刚填还没存的字段静默冲掉；弹窗里那颗「保存」写完一条已有方案后会再读一次，为的是把「当前使用」指针、那一行的模型名和那格 Key 的状态对齐到**刚写进去的那一条**（新建和删除两条通道自己就把新列表带回界面，不用再问一次）。读盘失败回 `null`，与 `settings:get` 同一个规矩：回一份「每条都空」的列表会让界面说「你还没填 Key」，而磁盘上明明有 |
| `settings:createProfile` | 渲染 → 主 | 新建一套方案，入参 `(capability, input)`——`input` 是**一个对象** `{ name?, fromProfileId?, values?, setDefault? }`（早前那是三个位置参数，字符串会被当成整个 input，所以跨 IPC 的边界先把它收口成对象，不是对象就按「没填」处理），回 `{ profiles, error }`（成功也带列表，界面不用为「改完长什么样」再问一次）。`fromProfileId` 三种意思：省略＝照该档当前默认那条复制、给 id＝照那条复制（指不到人**报错**，不悄悄换一条）、给空串＝要一条全空白的（连 Key 都不带）。界面上三档那颗「新建API接入」从第⑧步起**都只把弹窗打开、一个字节都不写**（点错了关掉窗口，磁盘上还是原来那几套）；弹窗里那颗「保存」才调这条通道，`fromProfileId` 传的是**空串**（一条全空白）——密钥绝不从上一条搬过来，密钥属于那一家，悄悄复制到另一套里，下一次干活按谁计价就没人说得清了。地址与其余字段由 `values` 当场盖上（弹窗起手时从「当前使用」那一条抄——这一档没有当前使用的就抄列表第一条——抄进那几格，所以「同一家换个模型」仍然不用重打地址）；弹窗里那颗「建好就设为当前使用」就是这里的 `setDefault`。右下角「保存设置」从此不再带任何一档的凭据（见上一条）。旧口径里那颗「新建一套」是当场建一条、并传**正在编辑那一条**的 id 作复制来源（省略则复制默认那条，用户编辑非默认方案时点新建拿到的就是别套的内容），第⑧步之后界面走不到这条路了，但 `fromProfileId` 给 id 那一档语义仍留着：给一个指不到人的 id 照样**报错**，不悄悄换一条。`values` 是「建出来就带上界面现值」，按**界面上那 17 个扁平名**给、只认属于这一档的几项，给了就盖过复制来源（`apiKey: ''` 真的表示空）——弹窗发的就是它自己那几格草稿（用户点的就是「把我刚填的这几格存成一条」），主进程按 `CAPABILITY_FIELDS` 只挑这一档的键，多带的（那七个全局段、别档的字段）一律忽略；Key 那一格只有真填了、或真点了「清除已保存的 Key」才带上，空着是「没填新 Key」而不是「把抄来的那把抹掉」。复制时密钥**原样搬运**密文而不是重新封一次——重封会把「能不能解密」变成「换过机器」。名字留空先取那条的模型名，再没有就自动给「方案 1/2/3」，上限 `maxProfiles`＝3 只在写入侧拦新建：手改文件里多出来的几条照样能读、能选、能删。**这一档原来一条都没有时，新建出来的第一条同时就是「当前使用」那条**（建完就能转写，不用再去找开关）；已经有几条时新建**不改**指针，`setDefault: true` 才改，所以按钮旁边那句话在非首条的场合不能说「已生效」 |
| `settings:renameProfile` | 渲染 → 主 | 改名，入参 `(capability, profileId, name)`。只动 `name`：`id` 不变，所以历史记录（#247 按 id 记）的引用不会断；密钥与其余字段原样。空名字（含纯空白）报「方案名不能为空」而不是「没改」，长度收在 40 字。**这条通道在界面上已经没有任何调用点**：三档列表那一行显示的都是模型名（没模型才退方案名），改名不参与分辨，所以转写在重写第③步、校对与配音在第⑧步先后撤掉了那颗内联的改名输入框。通道与校验留着，是因为 `name` 仍是这一条的**兜底标签**（新建还没填模型、或手改的文件里没写模型名时，界面总得有个能指人的词），而 `tests/settingsProfiles.test.ts` 仍直连 IPC 钉着它的校验与「指不到人就报错」。 |
| `settings:deleteProfile` | 渲染 → 主 | 删掉一套方案，入参 `(capability, profileId)`。**删到一条不剩是合法状态**（转写这一档按 #222 的新口径来：用户删掉最后一条之后这一档就是「0 配置」，界面给的是「新建API接入」而不是「你的 Key 丢了」；保存里绝不代建，所以「删掉最后一条」不会被下一次保存偷偷撤销）。删的正是当前默认那条时，剩下的列表里落回谁由 `fixDefaultId` 一处决定：**三档一律落空串**（`getSettingsView`/`pickDefault` 都只认「要么指得到人、要么是空串」——没人指路就是真的没人指路，让应用悄悄换成列表里排第一那条等于替用户选了家网关，而下一次干活花的钱按那条计价）。上一版这里给校对／配音留的是「落回剩下第一条」，理由是 `getAIConfig` 拿到空 id 会回一份空凭据、正在用的校对当场失败；第②③⑧步把那两档也改成同一口径后那个分支已经删掉，「没有当前使用」由前置校验（`checkTranscriptionReady` / `checkCorrectionReady` / `checkVoiceReady`）说清并直达设置页。列表空了指针一律落空串，不凭空指一条。弹窗是模态的（`ProfileDialog` 自带一层挡住外层遮罩的 overlay），所以那颗「删除」在弹窗开着时点不到——不会出现「草稿正指着一条刚被删掉的方案」；列表被别处改掉、`openEditDialog` 认不出那一行时先报错不开窗，带着一个已经不存在的 id 提交则由主进程按 id **报错**而不是落回默认（静默写到默认那条会吃掉用户另一套他没碰过的配置）。删除本身也不重拍全局段快照：面板上「转写模式／语言」里刚改还没存的那几处不该被这一次点击算成已保存。删除前那句二次确认是**挂在被点那一行下面的气泡**（三档共用同一份 `ProfileList`，第⑦步做在转写上、第⑧步跟着共用）：「删掉「X」？这一套的{这一档的凭据清单}、API Key 一起没掉，撤不回来。」，其中凭据清单和「这一档的活」都取自 `PROFILE_CAP_SPEC`（转写说「地址、模型／云端转写」，校对说「服务商、地址、模型／AI 校对」，配音说「厂商、地址、配音模型／云端配音」），而「、API Key」按那条自己的 `keyStatus` 决定——**一套没存过密钥的方案被删掉时不许说它有 Key**；再按「是不是当前使用那条 / 是不是最后一条」补一句指针的结局（「它是最后一条，也是「当前使用」那条——删掉后这一档一条方案都没有，{这一档的活}会被拦下」／「它是「当前使用」那条——删掉后这几套里没有正在使用的方案，{这一档的活}会被拦下」／「这是最后一条，删掉后这一档一条方案都没有」）。这一句必须**提前**替用户说，因为删掉「当前使用」那条之后没人接班，而这一次点击是唯一还能看见它的地方（删完那句 toast 只落在列表上，救不回已经按下去的那一次）。气泡点外面和 Esc 都收得掉，收掉的只有气泡（CDP 实测：设置窗口此刻照旧开着）。旧文案里那句「表单里那几处还没保存的修改也一起丢」跟着面板上的表单没了——凭据在弹窗草稿里，删别的那条丢不了它。 |
| `settings:setDefaultProfile` | 渲染 → 主 | 换这一档当前用的方案，入参 `(capability, profileId)`，下一次校对/配音取值就走这条。**界面上现在只有校对方式弹窗和配音页顶部那两条下拉走它**（`ProfileSwitchSelect` → `useProfileStore.setProfile`）；设置窗口里三档都不用它了——那颗「当前使用」勾选住在弹窗里，跟着弹窗底部那次 `settings:save` 的 `defaultProfileIds` 落盘（第③步撤掉转写首页那条下拉、第⑧步把校对／配音的方案条也换成列表 + 弹窗之后，asr 与 tts 这一档在这条通道上只剩「弹窗勾选」之外的调用者）。本地引擎不在这里重启，但两档的理由不一样：转写的本地档位是**全局段**那一份 `asrLocalModel`、不在任何一条方案里，换「当前使用」那条动不了引擎（`asr:start` 前的 `ensureLocalTier` 比的也是那一份全局档位，它兜的是「保存时那次自动重启被跳过或失败」，不是跟着方案切换走的）；配音的本地引擎 id 从第⑧步起也是**全局段**那一份 `ttsLocalEngine`（连同「配音引擎」这一档和「本地音色」编号一起退回根上），所以换方案同样动不了它——`ensureLocalTtsEngine` 只在 `boundEngine` 与目标引擎不同时才收掉上一代重起，而那只由「保存设置」改档位引起。总之这里只改指针不碰进程，界面上那句也只能说「下一次配音/校对就按这套干活」，说「立刻生效」是假的（正在跑的那一批用的还是原来那套）。四条改动共用同一条落盘出口 `writeRaw`，所以读盘失败时的写盘闸门、`schemaVersion` 版本戳、原子写与 `.bak` 对增删改同样生效——少一件，方案列表就成了绕过闸门的旁路 |
| `history:list` | 渲染 → 主 | 读那本账（`userData/records/history.json`）给那块浮在页面右侧的「历史记录」抽屉，按 `at` 倒序回 `{ items, error }`：每条是元信息 + 三档 `profiles` + `keptProduct`/`keptDraft` + `productAvailable`（原件此刻还在不在盘上——24 小时清扫跑过就是 false，那一勾据此摆成点不动并在 `title` 上说清为什么）+ `keptBytes`（留住那一到两份在盘上实际占的字节，没勾的恒为 0；原件不算进来，因为它 24 小时后就不在了，界面那句「一共占多大」要的必须是现在还在的）。**失败值里 `items` 必须是 `null` 而不是 `[]`**：`[]` 在界面上写的是「还没有过记录」，而真实情况可能是这本账读不动（`settings:listProfiles` 回空列表那个坑换个门面）；看不懂的行不显示，但也不会被改写掉 |
| `history:keep` | 渲染 → 主 | 界面上那一颗「留住」，入参 `(id, draftText?)`：一次调用把这条能留的两样一起留——产物由主进程按账上 `source` 那份**原件位置**复制进 `records/keep/<id>/`（渲染层报上来的路径一律不信），稿子正文用这一刻从渲染层交来的那一份写进 `keep/<id>/draft.txt`。两份引用在同一个排他块里一次写盘，要么一起进账要么都不进，免得那一勾亮成「留住了」而盘上只有一半。原件已被清扫收走时回的是「原件已经被清掉了（临时目录只保 24 小时），只能重跑一次」而不是「没勾上」；**留住一半也照实回 `ok:false` + 那句原因**，不给一句「已留住」 |
| `history:dropCopies` | 渲染 → 主 | 反悔：只删 `records/keep/<id>/` 那几份副本（连目录一起收，不留空壳），记录本身留着——用户是不想再留了，不是要抹掉这笔账。账本里 `kept` 两格清回 `null`，这一行从此重新参与修剪 |
| `history:delete` | 渲染 → 主 | 删一条记录，连它留住的副本一起没。这是用户能把「自己跑过什么」这条痕迹抹干净的唯一入口，所以文件必须跟着没：只从账本摘一行会在 `records/keep/` 底下留一个没人认领的音轨，比记着更糟。界面上按下去之前那句「它留住的那一份跟着一起没，撤不回来」说的就是这条 |
| `history:reveal` | 渲染 → 主 | 「在文件夹里显示」：路径在主进程里解出来（`kept.product ?? kept.draft` 那一份），**一个字都不回给界面**，回的是 `{ success, error }`（形状跟 `app:openLogDirectory` 那几条一致，不是 `ok`）。三种显示不了的情况各给各的一句话（这条记录没了／这一条还没有留住的副本／副本已经不在盘上）——它们在界面上长得一样，用户能做的事却完全不同。`success` 只代表「这一条确实有留住的副本、它此刻还在盘上」：`shell.showItemInFolder` 不给回执，不能顺着说「已打开」 |
| `app:getServiceReady` | 渲染 → 主 | 开屏阶段状态：`asrDone` / `asrError` / `dictionaryDone` |
| `app:log` | 渲染 → 主 | 渲染层日志经 `src/utils/logger.ts` 汇入 `app.log`，两边写在同一份日志里。渲染层的全局抛错另走 `rendererErrorWatch`（module `RendererError`，带 stack）、界面崩掉那一次走 `ErrorBoundary`（module `RendererCrash`，带 componentStack），都不依赖任何组件记得打日志 |
| `app:getVersion` | 渲染 → 主 | 应用版本号 |
| `app:checkUpdate` | 渲染 → 主 | 查 GitHub Release 最新版并与当前版本逐段比较；应用本体不自动装，只给「前往发布页」的链接 |
| `app:contactDeveloper` | 渲染 → 主 | 拼死收件人与正文（应用版本 / 系统 / 取日志说明）后 `shell.openExternal` 打开 `mailto:`；渲染层传不进任何参数 |
| `app:openExternal` | 渲染 → 主 | 用系统浏览器打开外链；只放行 https 且主机在 `ALLOWED_HOSTS` 内（`github.com` / `vvscribe.com` / `platform.minimax.cn` / `help.aliyun.com` / `volcengine.com`，带 `www` 的写法各列一条）——渲染层要挂厂商文档链接，白名单就得跟着那张表长，所以 `tests/ttsVendor.test.ts` 里有一条把 `TTS_VENDOR_UI[*].voiceListUrl` 的 hostname 逐个对到这张表上 |
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

### 测试

```bash
pnpm test          # 跑一遍，CI 用的就是这条
pnpm test:watch    # 边改边跑
```

跑的是 vitest（`vitest.config.ts` 单独一份，不复用 `vite.config.ts`：那份挂着 `vite-plugin-electron`，它的 `onstart` 会在每次跑测试时把应用拉起来）。`electron` 模块由 `tests/setup.ts` 逐个成员给出显式替身——不是 Proxy 兜万能，漏了哪个成员就响亮地失败，免得把真缺陷测成通过。

当前覆盖十六块。一是主进程里「收口的纯函数」：配置归一化（接口地址 / 本地档位 / 配音档位 / 音色 / 引擎白名单）与配音单次调用参数（`withOverrides`、`toSegments`）——这些地方的失败方式不是报错，而是「界面显示 A、实际跑的是 B」，正适合用断言钉住，`tests/ttsCallOptions.test.ts` 里那条「引擎空串必须保住设置里那档」就是 2026-10-29 本机试听踩实的 bug 的回归锚。接口地址那一格（`tests/settingsNormalize.test.ts`，14 条）在 1.1.1 收尾多了三条，都对着 #327 那句 404：整条端点粘进来要认（`https://api.minimax.cn/v1/speech_to_text` 剥回 `https://api.minimax.cn`，百炼那条带大写的 `.../SpeechSynthesizer` 也算）；认尾巴忽略大小写、但**只剥一层**，路径里真带这些词的自建网关（`.../proxy/v1/chat/completions`）剥完还得是个能用的地址；最后一条是**对账**——它不比对那张尾巴表的内容，比对的是适配层真拼出来的那条 URL：把「真发出去的那条完整端点」当成用户粘贴的输入走一遍归一化、再拼一次，必须回到同一条地址（还断言归一化确实改变了它，否则等于没测）。1.1.2 起这一条对账把讯飞那两条（`/v2/upload` 与 `/v2/getResult`）也各走一遍——它们是表里唯一大小写混排的一条，而认尾巴那一步**两边都得转小写**：只转用户粘的那一份，`getResult` 这条永远匹配不上，洗不回根地址，症状又是那句 404（这条正是对账测试当场抓出来的）。这张表是手抄的，抄漏一条不会编译报错，只会在用户那一格里变成 404，所以「新增一条端点忘了登记」这件事只能这样钉。二是 `userData` 这一层本身：`tests/userDataStore.test.ts` 钉路径收口（各处目录都在 userData 下且互不重合、`settings.json` 平铺在根层）与读写机制（四种读盘结局分得清、原子写留下的文件、`.bak` 存的是上一份、备份失败不影响写成功、历史副本按前缀只留最新 keep 份），`tests/settingsSchema.test.ts` 钉迁移链（走链的三种结局、多步顺序、断链判 gap、比本版新的一份字节不动）；这几份都落在真临时目录里（每用例一份 `mkdtemp` + 替身 `app.getPath`），写盘逻辑用 mock 的 `fs` 测等于测了自己骗自己，`safeStorage` 则由一对可逆的假加解密（`fake:` 前缀）替掉，不碰系统密钥库。三是 `settings.json` 的读写端到端（`tests/settingsPersistence.test.ts`）：钉「解不开会留档并说出去」「读不出内容会拦住落盘」「密钥留空＝不改、`null`＝清除」「首次运行不凭空造文件」「旧字段与明文 Key 一次读盘都办完」「v2 的文件读得懂界面但不许写」。迁移链的多步顺序与断链没法靠只有一步的生产注册表证明，所以 `migrateSettingsDocument` 的 target / steps 做成入参。四是崩溃兜底（`tests/crashWatch.test.ts`）：钉每一种 Electron 原因码都落在一句人话上（oom、memory-eviction、integrity-failure 三件事说成一句，人就照着错的那句做）、该静默的那几种真的静默（`clean-exit`、`killed`、开发模式热重载那次 `ERR_ABORTED`），以及「按钮写着重新加载就不能替用户按回车」——点「知道了」不许重载、连拒两次不占用后面那两次机会、60 秒内真重载满两次就改口让人重启应用。重载计数是模块级数组，所以每用例都要 `vi.resetModules()` 加换一份临时目录重灌模块（logger 的路径在构造时算死，换目录必须赶在 import 之前），不然限流那条永远测不准。另有两条钉的是同一件事的两个时刻：崩溃现场必须先落盘再谈界面——常规日志走 `fs/promises`，而 `dialog.showMessageBoxSync` 会把事件循环按住到用户点掉为止，实测那条 ERROR 就是这么丢的；断言因此写在对话框的 mock 里（弹窗还挂着的那一刻读 `app.log` 就该有那一行）。五是 IPC 收口这一层本身（`tests/ipcGuard.test.ts`，12 条）：这一层存在的理由只有一条——「不跨 IPC 抛错」以前只是注释，所以钉的是三种抛出（同步就炸、handler reject、连失败值构造器自己也抛）最后都必须以 resolve 收场，且回的是这条通道自己声明的形状；构造器抛的那条还要求落**两句**日志（一句「通道没跑成」、一句「它的失败形状也没造出来」），只留后者就查不到源头。另外三条钉细节：非 Error 的抛出物转字符串、空 message 的 Error 退回 `name`、两者都拿不到时回一句通用文案；失败值收得到原因**和原始入参**（`proofread:explain` 要按 `differences` 的条数回等长清单，只给原因造不出那个形状）；落盘的载荷键集合恰好等于 `channel` + `message`——判据是键集合而不是「不含某个字符串」，机制自己不往日志里加入参。最后一条是结构判据：递归扫 `electron/` 下的 `.ts`，`ipcMain.handle(` 只许出现在 `guard.ts` 一处，防止下一个通道绕过收口自己注册。六是日志落盘这一层（`tests/logRedact.test.ts` 27 条 + `tests/loggerRotation.test.ts` 12 条），它问的是同一个问题的两面——**该隐的隐没隐、该留的有没有被一起隐掉**（这份日志的唯一用途是用户发回来后能定位问题，隐过头等于白记）。脱敏那头钉三条规则：按键名（凭据用包含匹配加词尾 `key`，好让 `api_key`、`accessToken`、`Ocp-Apim-Subscription-Key` 落进同一条；装文稿的用全等，好让 `contentLength`、`durationMs` 这些派生数字留着，段落数组只收里面每个 `text` 而留下 `id/start/end`）、按形状（`Bearer` 与 `sk-` 打码、签名 URL 只收查询串、`data:…;base64,` 整段换掉、绝对路径收成 basename——段内字符类要是写成 `[A-Za-z0-9]`，`/Users/daqi/Movies/采访第3期.mp3` 就只匹配到 `Movies` 为止，替换后盘上留下的是 `Movies/采访第3期.mp3`（用户名没了，父目录名跟文件名粘着，看着像条相对路径），那是最难发现的一种漏，所以中文与 Windows 路径各有一条独立用例）、按尺寸（单串截到 400 且头尾各留一半，因为 ffprobe 那句决定性的 `No such file` 在尾巴上；数组 20 条但要报总条数；深度砍在 6 层；循环引用打标记）。轮转这头像本机那份 3MB 的 `app.log` 那样顶到 5MB 是不必真写 5MB 的：`ftruncate` 造稀疏文件，`stat` 看到的是真体积。用例钉六件事——到上限先把旧档挪成 `app.1.log` 且新份开头补一句轮转说明（不补，读日志的人只看到时间戳跳了一段）、只留 3 份且第四档挤掉最老的（`app.4.log` 不许存在）、没到上限就一个字都不动、挪不动时（把目录 `chmod` 成只读，rename 必失败而写文件仍可行）这一行照样落盘但那句说明不写（没挪成却说「旧的移到 app.1.log」是句谎）、崩溃路径的 `errorSync` 与常规 `write` 共用同一套闸门、控制台与文件说同一句话（`redactEntry` 只跑一遍，用户截图控制台又发回 `app.log` 时差的正是最难查的那种问题）。另有三条结构判据：`appendFileSync?(`、`'app.log'` 这个文件名、以及 `console.*` 的调用，都只许出现在 `logger.ts`，防止下一个模块另开一个口把闸门绕过去——前两条守「写盘」，第三条守 #284 刚收进来的那 40 处（console 这个口在 `redactEntry` 之外，调用点写什么就是什么）。七是 #282 收的两把尺（`tests/formatBytes.test.ts` 7 条 + `tests/styleTokens.test.ts` 5 条）。体积这头先钉算法本身：四档进位、且跨档时不写出 `1000KB` / `1000.0MB`（999,499→`999KB`、999,500→`1.0MB`、999,949,999→`999.9MB`、999,950,000→`1.00GB`），再钉 README 与清单里那几个数确实从这一个函数里出来（引擎 24.4MB、VITS 135.5MB、Kokoro 426.6MB），最后跑一次主进程的 `modelSizeHint` 断言它和界面回的是同一个字符串——导的是同一份代码，不是抄了同一份数字。另有两条结构判据守「别再长出第二把尺」：`src/` 与 `electron/` 下 `/ 1024` 只许出现在 `logger.ts`（它算的是自己那份按 1024 定义的 `MAX_LOG_BYTES`），写出 KB/MB/GB/TB 字面量的文件只能是 7 个，每一处例外都在 `formatBytes.ts` 的注释里说清为什么留着。样式这头钉的不是像素而是**引用关系**：用掉的每一个 `var(--x)`（连 `src/**` 里 JSX 内联 style 那几处一起算，注释行不算）都必须在 `index.css` 有声明——`--text-tertiary` 从来没声明过，浏览器把整条 `color` 声明丢掉，那 6 行标签一直是继承来的颜色而谁也没发现；只 grep 那个名字防不住下个人换一个同样不存在的令牌照样漏。剩下三条连着接线一起钉：`.harder_top` 的 `padding-left` 必须走 `var(--header-pad-left)`、`:root[data-platform="darwin"]` 里得是 108px 而 `:root` 得是一个不等于 108px 的默认值、preload 要把 `process.platform` 交出来且 `src/main.tsx` 要在首帧前把它写成 `<html data-platform>`——「非 mac 那条分支永远命不中」是这次改动独有的失效方式，只有 Windows 用户看得到，在 mac 上开发的人看不出来。这些判据都注入旁路验过会红：把 `--text-tertiary` 用回一处、把 `main.tsx` 那行接线删掉，各自让对应那条红。八是 #287 收的时钟尺（`tests/formatTime.test.ts` 9 条）。形态那头钉一小时内外两种写法（`3725.7→01:02:05`，且明确 `not.toBe('61:01')`——那正是被合掉的三处界面尺会写出来的东西）、floor 不进位（`59.7→00:59`、`3599.99→59:59`）。实测那头钉的是 `app.log` 里 `Voice track assembled` 那两个数：轨 58.31、原时间轴 58.42，套这把尺同读 `00:58` 而差是 0.11 秒——这把尺给不出「差多少」，所以结果卡那句必须走调用点自己的亚秒口径，这条接线由源码判据钉住（那句「差不到 1 秒」和 `formatDrift(track.duration - track.originalEnd)` 都还活着）。跨文件那头跑一次真的 `exportTranscript(..., 'md')`，断言台词稿里的时间码等于界面读出来的那个字符串，另加一条反向的：SRT 仍是 `00:01:02,500`、VTT 仍是点号分隔，防止有人把交付文件一起「统一」成界面口径。判据两条：`padStart(2` 与 `Math.floor(... / 60)` 的持有者都只能是 `utils/formatTime.ts` 和 `utils/exportTranscript.ts`（后者是字幕格式，不是界面读数）。旁路注入同样验过会红：往任一组件里塞一份旧的三行实现，两条判据一起红；把那把尺改回不算小时的形状，形态与 md 那两条红。九是 #285 收的引擎 stdout（`tests/sidecarStdout.test.ts` 4 条）。这一份守的不是换算而是「话能不能当天到盘」：Python 的 stdout 接到管道上是块缓冲，`print` 不带 `flush` 就会攒着——判据与接线：两个 sidecar 目录（`python-asr` / `python-tts`）顶层的 `.py` 里 `print(` 只许出现一次且必须带 `flush=True`，每条 `log()` 都带宿主 `logSidecarOutput` 认得的前缀，另有一条反向钉住那两处「按前缀分 INFO」的接线还在——扫描只取目录顶层，`venv/` 与 `dist-*/` 里第三方代码的 print 不算我们的口径。旁路注入同样验过会红：塞一处裸 `print`、再拿掉一条 `log` 的前缀，两条判据各红一条。十是 #235 路径 A 收的引擎冻结产物冒烟（`tests/engineSmoke.test.ts` 10 条：4 条常开、6 条要 `VV_ENGINE_SMOKE=1` 才跑）。它守的是「那台机器上的产物到底拉不拉得起来」——`onnxruntime.dll` 漏收、x64 架构错配这类坏法只有在那台机器上把进程拉起来才看得出来，纯函数测不到，而「在开发者 mac 上跑一遍」又恰好是最不像在验 Windows 的验法。常开那 4 条一个字都不碰进程：**头一条守的是这一档自己不许报假绿**——开关开了却找不到那两份冻结产物就直接红（写成「打印一句然后跳过」的话，产物目录名或 exe 后缀一变，这一档会静默退化成只剩判据在跑，而 CI 三个 job 照样全绿；旁路注入验过会红：把 `VV_ENGINE_SMOKE_ARCH` 指到一个不存在的架构，那条当场失败并点名缺哪份、该跑哪个 `pnpm build:*`。唯一合法的跳过是「出声档」，CI 不下模型）；另三条是两份 sidecar 源码里的协议号（TTS `= 1` / ASR `= 2`）必须等于测试写死的数（改了 Python 忘了改冒烟就红）、冒烟端口必须避开应用正在用的 8010/8000、ASR 的端口确实由 `VV_ASR_PORT` 决定（默认仍 8000，应用那条链路一字未变）。拉起那 6 条按档分，每档证的事与代价都不同，别把它们读成一句「冒烟过了」：启动档只断「`/health` 回的是本次下发的 boot_id、protocol 对、绑定引擎是启动时钉死那档、且 `engine_loaded` 是空——启动不等于顺手把模型读进内存」；**原生库齐不齐用「空模型目录要出 503 并点名缺 `model.onnx` 与 `dict`，而不是 500」来证**，因为 `load_engine()` 先 `import sherpa_onnx` 再查文件，所以 503 就等于 `_sherpa_onnx.pyd` / `libonnxruntime` 已经加载成功，这一分钱下载都不花；再断「请求没绑定的那档引擎必 409、被拒后 `engine_loaded` 仍为空」（一个进程只服务一个引擎那条契约在产物里还活着）和「超 2000 字要 413」（宿主分块的兜底还在，且它排在加载引擎之前，所以没模型也能证）。ASR 档只到握手：`from faster_whisper import WhisperModel` 是懒加载，不跑一次真转写就证不到 torch，而真转写要 138MB 起步的权重——**这条绿不等于「转写过了一遍」**。真出声那一档只在本机已经有模型目录时跑（再给一个 `VV_ENGINE_SMOKE_MODEL_DIR`），CI 不下模型所以恒为跳过；它把响应体自己拆开对账（`RIFF`/`WAVE`、单声道、16bit、`data` 块长度＝采样数×2、总字节＝44＋采样数×2），不用 ffprobe 估时长（随包那份 2018 构建估 mp3 容器会偏，本地有精确采样数，凭什么用估的）。RTF 只打印不断言：它是本机性能画像，拿它当闸门只会让冒烟随机红。2026-10-30 本机 arm64 两轮实跑都是 10 条全绿——Kokoro `sid=0` 出 2.26 秒音频，两轮分别用 571ms（RTF 0.253）与 612ms（RTF 0.271），与 #223 那轮 0.249 同量级，**所以 RTF 别当定值报，本机这个量级是 0.25–0.27**；ASR 那份 69MB 的 onefile 产物 17.6–19.1 秒才回出 boot_id（首次解包；宿主 `HEALTH_TIMEOUT_MS` 是 60 秒，顶得住）；收尾按端口找 pid、按二进制名核验后再杀，跑完 18000/18010/18011 三个端口都空着，而开发者机器上那个开着的实例（8000）既没被杀也没被抢——第一轮 ASR 档用的还是改动前那份旧产物，它照样去绑 8000，报回 `address already in use` 就自己退了：这既是「冒烟没碰坏东西」的证据，也是「旧产物不认 `VV_ASR_PORT`」的现场，所以那条失败信息专门带了一句「重新 pnpm build:asr」的提示。十一是 #222 收的方案档（`tests/settingsProfiles.test.ts`，76 条）。它钉的第一件事是那条**不对称**：干活那条路（`getASRConfig` / `getAIConfig` / `getTTSConfig`）遇到空 id 或指不到的 id 一律落回该档当前默认那条——转写跑到一半不许因为界面报了一个没听过的 id 就失败；改配置那条路（`saveSettings` 带 `profileIds`、`renameProfile` / `deleteProfile` / `setDefaultProfile` / `createProfile` 的 `fromProfileId`）遇到同样的 id 必须**报错**，因为静默写到默认那条吃掉的是用户另一套他没碰过的配置。这两件事如果写成一套「都回落」或「都抛」，前者会让改配置点错方案时看着像成功，后者会让正在跑的活被一个字符串杀掉，所以各有一组用例。其余钉的：上限 3 只在写入侧拦新建（手写着 5 条照样读得懂、能选、能删，剪掉就是「读成功、写成功、东西没了」）；`listProfiles` 回的形状里 `values` 的键名是 `CAPABILITY_FIELDS` 那一张表里的**扁平名**（`asrApiBase` 这一套，不是磁盘上的 `apiBase`——断言按名字逐个比，投视图时搬错键就会红；转写的 `values` 只剩凭据那几项，`asrProvider` / `asrLocalModel` / `asrLanguage` 是全局段，各有一条正证与一条反证钉着「按哪条方案取都不会改它们、改它们也不是改到某一条身上」）、JSON 里既没有 `sk-` 也没有 `v1:`（密钥不跨 IPC 这条由字符串断言守着，不是靠约定）；复制方案时密钥**原样搬运**——用例把密文串本身比对过去，重封一次在这套替身下是过不去的；任何一档都可以删到一条不剩（第⑧步之后这是**三档共同的**合法结局：列表回空数组 + 空默认指针，凭据投成空值而全局段照旧，本地转写与本地配音不受影响；「这一档 0 条方案」那一段用例钉的还有首次运行——磁盘上根本没文件时三档都 0 条；这时带凭据的保存被拦下、只改全局段的保存照样落盘），删掉的正是当前使用那条时三档的指针一律落空串（`fixDefaultId` 一处决定，第⑧步删掉了原先给校对／配音留的「落回剩下第一条」那个分支——悄悄换成列表里排第一那条等于替用户选了家网关），删空再新建的第一条自动成为当前使用，改名只动 `name`（`id` 不变，#247 按 id 记的历史引用因此不会断）；四条增删改共用 `writeRaw` 这一出口，所以读盘闸门对它们同样生效——两条「没落盘」的断言看的都是那一层里除 `settings.json` 本身没多出任何东西（`.tmp`、`.bak` 都不该出现），而不是比一句错误文案。另有 7 条钉的是 `settings:save` 那句「档位变了要不要重启本地引擎」：档位回到全局段之后，比的是**全局段那一份** `asrLocalModel` 换前换后，跟「这次编辑的是哪一条方案」无关——改档位必回 `done` 并重启一次；改方案凭据时无论编辑的是当前使用那条还是没在用的那条，`restartLocalEngine` 一次都不许被调用、改动照样落到那一条上（这两条各钉一头）；再加 `busy`（有转写在跑就不许动引擎，但那句话必须送到界面——`saveError` 为 null 配 `error` 非 null，界面才读得出「存下了、只是还没生效」）与 `failed`（重启没成，「存下了」不等于「生效了」）两种说法，和「档位没动的保存一次引擎都不碰」「磁盘上的档位是表外的值（`tiny`）时按 `base` 收口、收口后前后一样就不重启」两条。引擎那两条腿（`restartLocalEngine` / `hasActiveTranscription`）在这份测试里是替身，真调用会 spawn Python 去抢 8000。这 7 条里那两条「改方案不许动引擎」的来历是本机 CDP 冒烟读出来的一个真缺陷：档位还挂在方案上的那版拿**被编辑那条**的档位来比，编辑第二套转写方案会平白重启一次引擎、还附一句「新档位才会生效」；当时把比较改回读这次写进去的那条做旁路注入，只有「改的不是当前默认那条时不重启」这一条红、其余 52 条照常绿。重写之后 `CAPABILITY_FIELDS.asr` 只剩 `apiKey` / `apiBase` / `model`，方案里已经没有档位这个字段（1.1.1 又补进一项 `vendor`——它是「这套地址和 Key 是哪家」的书签，见下面十五那一块，仍然不是档位），那个形状写不出来了——要把档位收回方案，会先撞上上面说的全局段正证与反证，而这两条继续钉的是「编辑任何一条方案都不许碰本地引擎」。另有 6 条钉的是「测试连接」的回落**读哪一条方案**，这一组的判据只有一条：测出来的那句结论必须与真干活用的是同一套配置。所以钉了：Key 留空时取这次发来的那一条而不是该档默认那条；不带 id、或带了却指不到人，都落回该档默认那条（与 getter 同一口径）；配音地址与 Key 留空时借的「校对那套」**固定是校对档当前默认那条**，不跟界面正在编辑的校对方案走——跟着界面走会出「自检按 B 家网关绿了、点开始配音却走 A 家」，而这是界面亲口撒的谎；第三条只收一个字符串，把三档 id 一起塞进去不会被吃进去（将来谁想放宽这个契约，这条会先红而不是静默通过）；本地配音档不参与回落，Key 留空照样开测；那条方案的 Key 在这台机器上解不开时报的是「读不出」而不是「还没填」。这一份里还有一条是当场抓出来的契约 bug：`createProfile` 的文档写着「不给 `fromProfileId`＝照着当前那条复制」，代码却在省略时给了一条全空白的——界面上「新建一套」那颗按钮就盖在这个上面（它传的是正在编辑那条的 id，没在编辑任何一条时才省略，省略就必须落回当前使用那条），要是没先改对，用户点一次就丢一次配置；测试先红在文档那一边、然后把代码改对。十二是 #222 重写第③步收的那句「点开始转写时拦下的话」（`tests/readinessTranscription.test.ts`，11 条）。它只能由单测钉住：判据全在 `checkTranscriptionReady` 一个函数里，而它只有用户真点下去才跑得到，那一步的第一环是原生选文件对话框（`dialog.showOpenDialog` 自动化点不动），所以 CDP 那轮能验到设置页里每条提示，验不到这里。前 7 条钉的是三句出路不能互换：一条方案都没建过说「点『新建API接入』，在弹窗里把接口地址、API Key 和模型（讯飞那一家是 AppID、API Key 与 APISecret）填好，点弹窗底部的『保存』」——零条方案时还不知道用户会选哪家，所以两种口径都得说到，只说前一种的话选了讯飞的人会去弹窗里找一个不存在的「模型」格；建了 N 套但没选当前使用说「点要用的那一行的『编辑』，在弹窗里勾上『当前使用』并点『保存』」，且把 N 写出口；`settings:listProfiles` 整个没读回来时不许编原因——落回那句既有的「API Base 或 API Key 还没填」，把读盘失败说成用户漏做一步是界面在撒谎。另加「Key 解不开」排在问方案之前（所以那一次读列表根本不该发生）、「方案正常且凭据齐全」回 null、本地模式不读方案列表（删空转写方案不影响本机转写）、本地引擎 fail 时把引擎那句话原样送出。1.1.2 多的 4 条钉讯飞那一档：三样凭据加一个非空地址，缺哪一格就**点名哪一格**（缺着发出去只会被回一句 100009「签名校验不通过」，那句不说是哪一格错了，用户只能三格挨个试）；这一档的地址**留空不算「按 OpenAI 官方地址发」**——主进程不会拿别家的地址替它发，所以照那句省事口径放行等于送用户一次必然失败；四样齐全时回 null 且一次 `testConnection` 都不发（云端这一支从来不靠自检放行）；「Key 解不开」仍排在方案与凭据判据之前。7 条都按旁路注入验过会红：把三元判据钉成常量各让对应那一条红，把「列表没读回来」当成 0 条会让第一与第三条红，把 provider 判断放宽到本地会让最后两条红。第⑧步把三档的界面换成同一套「列表 + 弹窗」之后，**另起一份 `tests/readinessProfiles.test.ts`（12 条）**钉剩下两档同一处判据（`checkCorrectionReady` / `checkVoiceReady` 也走 `noCurrentProfileMessage`），要守的是同一件事：面板上不再有凭据输入框，所以**出路只能指到弹窗那颗「保存」**——说错一颗按钮，用户就会在面板上找一个已经不存在的输入框，或者在弹窗里存完又去点外面那颗、等一个永远不出现的「已保存」。这一份里除了那三种结局不能互换（一条都没建过／建了 N 套没选定且把 N 说出口／列表没读回来时不许编原因），还钉了三条这两档独有的：Key 解不开排在方案判据之前（那一次读列表根本不该发生）、校对那把能用时配音不因配音档拦人（与 `getTTSConfig` 的 `ttsApiKey || aiApiKey` 同一口径），以及「配音引擎＝本地」时整段方案判据都不出现——本地档不看方案，拿云端那套去问它就是拦人。这两份测试都归 `tsconfig.test.renderer.json`：`src/utils/readiness.ts` 那条 import 链要 DOM 与 jsx（它读 `window.electronAPI`、还引了 `Toast.tsx`），而 `tsconfig.test.json` 的 `lib` 只有 ES2023（那边同时编主进程源码，加上 DOM 会把 `fetch` 的类型从 undici 版换成 lib.dom 版，`connectionTestService` 里 `{ body: buffer }` 当场报假错）。**新增一份拉渲染层代码的测试就要在两处各登记一次**：只写进 `tests/` 而没从 `tsconfig.test.json` 的 exclude 摘出去，报的是「Cannot find name 'Window'」这种看着像源码坏了的错。顺带一条接线：`vitest.config.ts` 现在也得声明 `@` 别名——src 里的模块互相用 `@/xxx` 引用，而这份配置刻意不复用 `vite.config.ts`（那份挂着 vite-plugin-electron，`onstart` 会把应用拉起来），漏了这一条时报的是「Failed to resolve import」，看着像源码坏了，其实只是接线没接。第④步那轮 CDP 真渲染（隔离 `--user-data-dir`，每一步都回头核盘上那份 `settings.json`）跑的是：0 条→1→2→3 且满 3 条收起「新建一套」、翻「当前使用」后 `defaultProfileId.asr` 仍然唯一、删掉的正是当前使用那条时指针落空串且不偷偷改指、删到 0 条面板只剩「新建一套」、从 0 条建出来的第一条自动成为当前使用。它当场抓出一个文案缺陷：删的正是「当前使用」那一条时，二次确认只说了「含 Key、撤不回来」，没说这一档不像校对/配音那样落回剩下第一条，于是用户点完才知道下一次「开始转写」会被拦下——`AsrProfileList` 因此按「还剩别的 / 只剩这条且它在用 / 只剩这条但没在用」三种情况各补一句，那句必须排在点击之前。第⑤步（那三格按意图才摊开）这轮 CDP 真渲染问的是**点一颗按钮到底写没写盘**：`pnpm build` 后用隔离 `--user-data-dir` 起应用，每一步都回头读那份 `settings.json` 的 mtime 与条数。0 条时列表只剩「新建一套」，点它之后 mtime 与条数一字未动，表单末尾连那颗勾选都不出现，那三格的提示是「这几格是还没落盘的新方案…」和「这一套还没建出来，所以现在没有 Key…」；填好点右下角「保存设置」才建出第一条，toast 说的是「已把那三格存成新的一套「whisper-large-v3」，设置已保存」，`defaultProfileId.asr` 跟着指过去、Key 以 `v1:` 密文落盘。已有 1 条时再点「新建一套」，那颗勾以「建好就设为当前使用」出现且默认不勾，勾上之后提示换成「这套建出来就接管云端转写，上面原来那条被顶掉——下一次转写按这一套的模型和地址计价」；两种结局都真跑了一遍：勾上保存 → 指针换到新那条、老那条的密文一个字节没动；不勾保存 → 条数 +1 而指针原地不动、新那条的 Key 是空串（密钥绝不从上一条搬过来）。「取消这份新建」按用户那句「太丑、还偏大、不协调」改成列表那套小胶囊的规格，实测 92×27 / 11px / `4px 12px` / 圆角 8px，和它下面那颗「测试连接」同形状（页脚「保存设置」是 70×40 / 14px，摆在这格末尾会显得比整页都重）。第⑥步把这颗按钮连同那三格一起搬进弹窗，收场那颗改叫「取消」，上面那几个数只是当时那版的实测记录。这一步也抓出两个只有真点才看得见的缺陷。一是**看不见的字段替用户按了保存**：删掉最后一条方案后那三格收起，而 `values` 里还挂着上一次读来的接口地址与模型，于是「只改转写语言」那一次保存照样带着凭据发出去，主进程按「补丁里有凭据而这一档一条方案都没有＝你要存却没先建」整次拦下——盘上 `asrLanguage` 停在 `zh` 而界面显示 `en`，用户从头到尾没碰过那三格；修法是渲染层不发没有归宿的字段；第⑥步把这层做绝了——那三格整个搬进小弹窗，右下角「保存设置」从此**无条件**删掉 `asrApiBase` / `asrModel` / `asrApiKey`，面板表单里那份残留读数再也不会跟着每次保存发出去。二是**同一个错误在两条通道上说成两句话**：那句「请先点『新建一套』」送到 `settings:save` 时被 `saveErrorMessage` 披上了「清出磁盘空间或修好目录权限后再存一次」（改之前 `app.log` 里就留着那样一句原话），而 `settingsService.ts` 给 `SettingsProfileRuleError` 写的注释明确要求原样透出、`profilesErrorMessage` 也正是这么做的。这一句在转写这一档经界面已经走不到了（第⑥步之后右下角保存把那三格整个删掉不发，弹窗新建又是先建后写），但校对/配音那两档的凭据格还一直挂着、`deleteProfile` 对三档都允许删空，所以照旧能撞见——因此由单测钉住而不是靠界面点验：`settings:save` 的失败按来源分两种形状各一条，规矩没守住时 `saveError` 恰好等于那句出路且不含「磁盘」，把目录 `chmod` 成只读（真 EACCES）时「设置没能写入」和「不用重填」两句都得留着。旁路注入验过会红：拿掉 `SettingsProfileRuleError` 那行 passthrough，只有前者红、后者照常绿——两条分开钉才有意义，合成一条等于没钉。那条 `chmod` 用例会带出 `[Logger] Failed to write log` 的 ENOENT 噪音，那不是缺陷，它恰好证明连日志都写不进去时 `saveError` 照样送到了界面。第⑥步（那三格搬进小弹窗）这轮 CDP 真渲染问的还是**点一颗按钮到底写没写盘**，外加一件第⑤步问不到的事：**弹窗旁边那些没存的改动有没有被顺手算成已保存**。`pnpm build` 后用隔离 `--user-data-dir` 起应用，跑完再回头读盘上那份 `settings.json`。点「新建API接入」再按 Esc，列表还是那两条、磁盘上没有多出第三条——写盘的只有弹窗底部那颗「保存」，那两条（`model-a` / `model-b`）建出来都带 `v1:` 密文的 Key，而 `sk-step…` 那几串明文在 `settings.json` 与 `app.log` 里各 grep 一次都是零。进「编辑」时那三格读的是磁盘上这一条（行上是 `model-a`，弹窗里就是 `model-a`），点遮罩既不关弹窗也不关设置窗口，Esc 只收弹窗、外面那个设置窗口照旧开着。满 3 条收起入口、三种二次确认各说清指针的结局、删到一条不剩后右下角那颗「保存设置」照样成功（那句「请先点『新建一套』」在转写这一档经界面彻底走不到了）。这一轮抓出**两处同一类静默丢改动**：列表上点「编辑」和删掉「正在编辑那一条」都还走着 `switchProfile`，而它把整份 snapshot 重拍了一遍——「转写模式／语言」里刚改还没存的那两处会被算成已保存，关窗一句都不问。两处都改成只挪指针（弹窗那次连那三格也只对齐键值，不碰 snapshot 其余部分），改完补的断言是：改「转写语言」不保存 → 进某一行的「编辑」→ 取消 → 删掉的正是那一条 → 关设置窗口仍问「有未保存的修改」，跑出来 `closeAsked=true`；toast 那句名字跟着行上显示的模型名走（`已删掉「model-a」（含它保存的 API Key）`），删完列表与 toast 都说明白「这一档现在没有「当前使用」的那一条」以及出路是进某一行的「编辑」勾上再点弹窗里的「保存」。第⑦步（行不换行 + 发光边框 + 气泡确认 + 提示精简）这轮 CDP 真渲染读的是**屏幕上的几何**和那几句字：三条都在 41px 高（上一版长模型名会把「编辑 / 删除」顶到第二行，三行列表看着像六行），名称区里模型名和域名各让一半、一起截断，完整那串挂在 hover 的 `title` 上；「当前使用」那一行的 `box-shadow` 是 `0 0 0 1px` 加 `0 0 14px` 两圈，徽标挪到动作前面而不是夹在文字中间。删除的确认气泡挂在被点那一行下面 7px、右边缘不越出滚动区、`inViewport=true`（上一版它长在整栏末尾，点完「删除」还得往下滑），点外面／Esc／气泡里那颗「取消」三种收场都只收气泡，设置窗口照旧开着。删掉的正是「当前使用」那条时 toast 与列表那句一起说清「没有正在使用的方案」。文案这轮把转写 Tab 那几句逐条读回来核过（模式 / 本地档位 / 语言 / 自检 / 列表那四句 / 弹窗那四句），本文上面被引号引用的那几句已按新字改过。十三是 #247 收的历史账本（`tests/historyService.test.ts` 34 条 + `tests/historyIpc.test.ts` 8 条）。这一份钉的第一件事是**记的是账，不是稿子**：记一条转写之后 `records/` 底下除了一本账什么都没有——正文不进盘、产物路径也不出主进程；下载那一类不读任何设置，三个方案 id 全空也算记成，而「这一档当时没有方案在用」落账只有 `null` 一种形状（空串与 `null` 混着用，事后就分不清「没在用」和「这文件是手改的」）。同一个 jobId 再记一次算更新而不是补一行，且上一行留住的副本要照搬过来——不然用户勾过一次的东西会被他自己下一次转写悄悄抹掉。「勾了才留」那半边钉的是四种结局各自的说法：产物复制进 `records/keep/<id>/`、文件名跟原件走；原件已被 24 小时清扫收走时报「只能重跑一次」并且一个文件都不留；转写那一类没有产物、但只要这一刻交来正文就留得住稿子，而空稿子连空文件都不造（留一个空文件比不留更让人误解）；原件没了但稿子留得住时那一半照样落盘、那句原因也照样说（`ok:false` 不等于盘上什么都没变）。反悔只删副本、记录本身还在；单条删除连留住的文件一起没——只从账上摘一行会把音轨晾在盘上没人认领。两条路径判据守的是安全：Windows 那套非法字符洗得掉（同一本账在两台机器上拼得出同一个路径），而 id 被手改成路径穿越的形状也不许写出 `records/keep` 以外。「在文件夹里显示」那三种「显示不了」各配各的一句话（没留过／被人删了／账里没这条），因为它们在界面上长得一样、用户能做的事却完全不同。修剪钉「留住过东西的行不参与修剪」和「看不懂的行既不显示也不剪」。留住那一侧因此没有上界，这是刻意的取舍，代价由一个数补上：`listHistory` 每行回 `keptBytes`，三条用例钉的是「没勾留住的恒为 0——一份 4KB 的原件摆在 `source` 里也不许算进来，算进去第二天就对不上」「勾了产物加稿子就是那两份**落盘后**的真实字节之和（断言从盘上 `stat` 回来比，不跟用例里手写的数字比）」「留住的一份被人自己删了只算还在的那份、整本账照样列得出来而不是一句错误」。坏盘那一组钉的是**读不出来不等于可以盖**：半截 JSON 改名留档再从空账本继续、它是个目录时直接拦住落盘、比本版新的账本一个字不动、解得开但 `records` 不是列表时也别当成空账本写回去，而第一次用时那本账不存在不算故障——不弹错、也不留一份改名副本。IPC 那 8 条守的是通道形状：五条都真注册在 `ipcMain` 上、`items` 为 `null` 与 `[]` 在界面上是两句话（前者不许演成「没跑过作业」）、id 不是字符串时不去账本里找也不动盘、`keep` 的第二参数不是字符串就当「只留产物」（界面少给一份正文不该炸），最后一条是**正文不过日志**——整份稿子只过一次桥，日志里只留字符数。#247 第④步（抽屉换成浮的）这轮 CDP 真渲染读的还是几何：结果页上播放器 480×735、编辑器 301×735，抽屉开与关两次量的数一个像素不差（这就是「不许挤压」那条的验收数），代价是它展开时盖住编辑器右边那一条；收起后那块量出来是 20×46、中心 (758,45)，入口那颗图标是 32×32、中心 (765,20)——缩的是图标那个位置；四个标签读回「全部 5 / 转写 2 / 下载 2 / 配音 1」，点进去各是 5/2/2/1 行，非「全部」时行上不再盖同一枚章；顶部那颗设置菜单的命中测试仍压在抽屉之上（抽屉 `z-index` 150、菜单 200，它 portal 到 `body`）；Esc 先收挂在行下的删除气泡、再收整块抽屉；明暗两套主题各截一张回看（暗色下那颗入口点亮的那一版要单独补一条规则，暗色的普通选择器比它的 `.is-on` 更具体）。十四是 #224 收的厂商适配层（`tests/ttsVendor.test.ts`，59 条，其中最后 9 条是 #340 那条音色候选名单）。这一份钉的是**四家之间那几处不同不许长回一条**，因为每一处不同都对应一种「界面看着成功、盘上是坏文件」的坏法：`normalizeTtsVendor` 那头钉认识的名字原样收下（大小写与首尾空白不算）、空串／缺失／认不出的值一律落回 OpenAI 兼容（1.1.0 及更早建出来的方案磁盘上根本没有这一项），以及除 OpenAI 兼容以外三家（MiniMax／百炼／豆包）都把音色列为必填；1.1.2 进来的豆包另带两处只属于它自己的形状——**模型必填性上它是例外**（原厂写 `req_params.model`「仅当 speaker 为声音复刻 2.0 的音色时需指定」，系统音色填了反被回 `45000001 InvalidModel`，所以 `ttsVendorNeedsModel('volc')` 是 false，另三家都是 true），以及**只有它收「资源编号」那一格**（请求头 `X-Api-Resource-Id`；另三家在表里是 `null` 而不是空串——null＝弹窗里这一格根本不出现，空串＝出现但留空照样发出去，写成空串就会在 OpenAI 那一档下面挂一格没人读的地方）；`buildSpeechRequest` 那头钉四家的路径与字段名各是自己的那一套（文本在 `input` 还是 `text`、倍速在顶层还是嵌进 `voice_setting`／`input`、百炼没有 `parameters` 这一层、豆包鉴权换成 `X-Api-Key` 而没有 `Bearer`、音频格式与采样率写在 `audio_params` 里），倍速是 1 时四家都不带这一项（兼容网关对未知字段的行为不一致），音色空着时不发空值——拦下它是前置校验的事，这一层只管「真发出去那份不带空值」；地址接路径那头 1.1.1 起自己有一份（`tests/apiPath.test.ts`，6 条，#332）：钉的是 `apiPath.appendApiPath` 那一个判据——根地址与「只剩一段」（`.../api`、`.../proxy`）一律接上路径，够两段以上且第一段撞上要接的那一条（`/v1/...`、`/api/v1/...`、豆包那条 `/api/v3/...`）就按用户填的原话打，比较忽略大小写，以及只有「地址末尾正好是 `/api`、路径又以 `/api/` 起头」才折叠这一次重复（照阿里云文档粘进来的 Base URL 会被 `normalizeApiBase` 剥成 `/api`，不折叠就是 404）；`tests/ttsVendor.test.ts` 那头接着钉报错必须把最终打出去的 `POST <地址>` 念出来，以及首段撞不上的多段路径照旧接上去（那类串档是尾巴表的活，段数判据救不了）。豆包的 `/api/v3/tts/unidirectional` 撞的是同一个判据，所以那边另有一条：粘到 `/api` 那层折叠一次、粘整条端点则照原话打不再接第二层。`readSpeechAudio` 占最多条，因为四家的响应形状是四件事：OpenAI 是裸字节流但兼容网关确实会 200 回一份 JSON，不验内容类型就往 `.mp3` 里落，用户在播放器里只看到「加载失败」（404 的解释也按厂商分叉：OpenAI 是「这家可能没有标准音频接口」，另三家是「路径由应用接上、地址填到域名根就行」——同一个 404 在这两种情况下要用户动的是不同的格子）；MiniMax 的音频是十六进制字符串（按 base64 解会得到一坨长度对得上的垃圾），而且错误可以带着 HTTP 200 回来，所以 `base_resp.status_code` 非 0 必须算失败；百炼非流式回的是一个 24 小时有效的签名地址，要再发一次 GET 才拿到音频——那一次必须带上调用方的取消信号（否则「取消配音」在最后一跳上失效），被取消时原样抛 `AbortError` 而不许改写成「网关故障」，内联 base64 优先于地址，计费字数翻成一句 `note`；豆包回的是一行一帧的 NDJSON、音频在每帧的 base64 里（按裸字节流落盘得到的是一坨文本），所以 `code` 为 0 是「这一段音频」而不是「整体失败」——既不能把非零一概当错误、也不能只看最后一帧，看到结束帧就停，`usage.text_words` 同样翻成一句 `note`；它那一组错误码必须**按格**说话，因为对方原话同时点到两样东西时光念原话用户不知道动哪一格：`45000001 InvalidModel` 要说清「配音模型那一格只对复刻音色有用」，`45000003 resource ID is mismatched` 要翻成「这个资源编号下没有这个音色」并点名音色在配音页、资源编号在设置弹窗（`seed-icl-2.0` 那一版），认不出的码把原话递出去不替用户猜，而「回了成功但一个音频字节都没给」也要接上这条最可能的路。最后那一段钉的是四家的共同坏情况：一份 JSON 接口回了 HTML 时说的是「地址填错了层级」而不是「没读出音频」；适配层的失败一律带 `TtsVendorError` 类型（调用方靠类型而不是消息前缀决定「原样贴给用户」还是「再包一层」）；错误正文压成一行并截断（网关的 HTML 报错页整段甩给用户毫无意义）。往后那几条是 1.1.1 收尾补、1.1.2 又改过口径的 `ttsVendorProbeVoice`：必填那三家的「测试连接」在界面没带音色时补的那一个**只收有出处的值**——MiniMax 钉 `male-qn-qingse`（本机真 Key 出声过），豆包钉官方 2.0 音色表的第一行 `zh_female_vv_uranus_bigtts`（本机没 Key，走的是 #224 那句拍板「先照规范设计、之后有 Key 再验」；和留空比它的代价小得多——留空＝那颗按钮对这一家永远不可用，而万一这个音色不在用户账号的权限里，对方回的仍是「音色与资源编号不匹配」，还是一句真诊断），同一条还断言 `TTS_VENDOR_RESOURCE_ID.volc` 是 `seed-tts-2.0`，因为音色与资源编号必须成对（1.0 的音色配 2.0 的资源号换回的就是那句 mismatched）；OpenAI 兼容与百炼那两条钉的是**空串**——空串不是「还没填」，它是「这颗按钮不硬测这一家」的信号，写成具体 id 就是替用户发明一个没验证过的值；漂移守卫逐家比对渲染层 `TTS_VENDOR_UI` 那份镜像表与主进程这张表（`probeVoice`、`voiceRequired` 与 `modelRequired` 三个键一起比），因为两边不一致的症状是「界面说这次用应用补的音色、主进程却回『这一页测不了』」；资源编号那一格也各有一条对账（厂商表里出现的每一家界面那张表都得认得，少一家的症状是「弹窗里那一格不出现、请求照发一个用户没填过的值」——比报错更难发现），最后一条把界面挂出去的每个 `voiceListUrl` 的 hostname 对到主进程 `ALLOWED_HOSTS` 上（白名单漏一个的症状是点了链接只回一句「不允许打开该链接」）。十五是同一件事在转写那一侧（`tests/asrVendor.test.ts`，35 条）。这一份比配音那一份短得多，因为它原本只有一处不同要钉：MiniMax 的音频接口**不在它自己的 OpenAI 兼容层里**（那层只覆盖文本），所以路径是 `/v1/speech_to_text`、分段那一项叫 `timestamp_level=sentence` 而不是 `timestamp_granularities[0]=segment`、模型留空时落的是 `asr-1.0` 而不是 `whisper-1`——沿用 openai 那一支的话，对方既不报错也不返回时间，症状是「转写成功但字幕整条压在 0 上」。**1.1.2 这一轮先钉的是「这一档只有两家」**：豆包与阿里百炼的转写都被摘掉了（豆包的**配音**照旧收），两家卡在同一个地方——它们不收本机音频，要先有一个公网可访问的音频 URL，再走「提交任务 → 轮询任务 → 下载结果 JSON」那条异步链路，而官方给「本机文件换临时 URL」的那条通道自己写着「请勿用于生产环境」（48 小时过期、上传凭证 100 QPS 不可扩容）；与其在下拉里挂一个「选了大概率失败」的选项，不如先不列它——这一格不许说做不到的小事。所以 `normalizeAsrVendor('dashscope')` 与 `normalizeAsrVendor('volc')` 各是一条**反向断言**：必须落回 openai。这两个名字在配音那一侧是真厂商，认错了等于把一份 OpenAI 形状的 multipart 请求发到一个既不认 `Bearer` 也不认 `/v1/audio/transcriptions` 的网关；下拉里在配音那一档看得到豆包、在这一档看不到，不是漏了。**1.1.2 真接进来的第三家是讯飞**（#343，`iflytek`，界面上「讯飞（录音文件转写大模型版）」），它在这一份里钉四件事：`normalizeAsrVendor` 认得它且界面那个 label 与主进程这张表同一个字；`ASR_VENDOR_DEFAULT_MODEL.iflytek` 是**空串**——不是「还没兜底」，而是这一家的参数表里根本没有模型这一项，界面上那一格因此不出现（`asrVendorWantsModel`）；`asrVendorUsesOrderFlow` **只对它为真**——这个判据不许在三个调用点各写一遍 `vendor === 'iflytek'`（真转写、设置里那颗「测试连接」、以及界面上那句「这一家要等」都按它分叉，各写一遍就是下次加一家时漏掉一处的形状）；以及 `buildAsrRequest('iflytek')` **抛错**而不是静默落回 openai 那一支——落回去的结果正是「自检过了、真转写 404」那个形状（它的签名每趟现算，一次调用产不出一份固定形状，所以那份整个收在 `iflytekAsr.ts`，见下面第十六块）。上限那两条也各是一家：讯飞 ≤500MB / ≤5 小时（都是原厂文档写死的硬上限，超时长的表现是订单直接判 `failType 4`，用户上传完还得等一轮轮询才知道，所以也拦在发出去之前），且它超限那句的尾巴**不许**沿用前两家那句「没有长音频异步接口可用」——它自己就是那条异步接口，5 小时是硬上限，所以改成「超过只能先把音频切开分几次转」；MiniMax 那一句原样留着，两边各有一条钉着。最后 4 条是**对账**：渲染层 `ASR_VENDOR_UI` 那份镜像表逐家比主进程这张表的四个键（label／要不要模型那一格／是不是异步／要不要 AppID 那两格），两边不一致的症状是「弹窗里多一格没人读的地方」或「界面上没说这一家要等」，都是不报错的坏法。**1.1.1 那一轮长出过两处不同**：其一是 `language` 这一项两家放的位置不一样——OpenAI 兼容在 multipart 字段里、MiniMax 在请求头里，所以两家各钉一条，而且互相断言对方那一处**不许**出现（当成字段发给 MiniMax 不会报错，只会静静被忽略：界面选了中文、对方按自动检测跑，那是最难发现的「配了但没生效」；这个位置是真 Key 打出来的——发一个不存在的语言标对方回 400，说明它真读了这一项）。其二是发出去之前的大小闸门 `asrFileProblem`，四条：超时长就拦、并把这一份到底是多长说出口（**向上取整**——8 分 21 秒念成 9 分钟，四舍五入会得到「只收 8 分钟以内，这一份是 8 分钟」那句读起来像被误拦的话，而它真的超了；上限那一头方向相反、必须**向下**取整——MiniMax 写的是 500 秒（＝8 分 20 秒），`ceil` 会念成「只收 9 分钟」，于是一个 8 分 40 秒的用户读到「只收 9 分钟以内，这一份是 9 分钟」，像是我们拦错了，而说 8 分钟顶多保守 20 秒。两个方向相反是刻意的。这一处是 1.1.2 把上限从「秒」改念「分钟／小时」时一起定下来的：讯飞那条正好是 5 小时，300 分钟没人读得下去，而直接拿 `500 / 60` 去念会得到 `8.333333333333334 分钟`）；超体积也拦，且这一条排在时长前面判（体积那两个数出自 `formatBytes` 那一把尺，不另算一份；文档那句「50MB」没写进制，按十进制取＝按小的那一头拦）；时长探不到时只按体积判，不拿猜出来的秒数拦人（ffprobe 挂了不等于这份音频有问题）；OpenAI 兼容那一档一条都不拦（各家兼容网关放多少并不一样，替它们拦人会把能用的人挡在门外——这一条的循环里现在带着 `dashscope`，它按上面那条反向断言已经落回 openai）。另外几条是共用的口径：`normalizeAsrVendor` 认不出的一律落回 OpenAI 兼容（1.1.1 之前建出来的方案磁盘上没这一项，`settings.json` 又允许手改），而 `'cloud'` / `'local'` 这两个值**不许**被当成厂商读——那是全局段 `asrProvider`（转写模式）的取值，认错了等于把请求发到一家用户没选的网关；语言留空时干脆不发 `language` 这一项（两家的默认行为不一样，发空串等于替用户猜）；`shapeOf(undefined)` 与 `shapeOf('openai')` 必须完全相等，这是「加这一项不改变任何已有配置的行为」那句承诺的可执行版本。响应解析这一轮从 `cloudASR` 里搬进了适配层（`readAsrResponse`，5 条），搬的理由还是那句「自检与真链路必须同一口径」：两家的 `verbose_json` 形状一致（`segments[].{start,end}` 本来就是秒，直接搬），所以这一层**不看厂商**——真长出第二套形状时该在这里加分叉，而不是让「测试连接」和真转写各自解一遍。5 条钉的是：秒直接搬、逐段 `text` 去首尾空白；`avg_logprob` 换算成 0..1 的置信度；**没给 `text` 字段是 `null`、给空串是空串**（自检那两处按这两件事分别说话：「这个地址不是转写接口」／「这段样本是静音」）；`segments` 这一项**在不在**与数组空不空是两件事（MiniMax 对没听出字的样本干脆不给这一项，读成空数组就分不清「不支持分段」与「这段是静音」）；响应体不是 JSON 时原样抛 `SyntaxError`，这一层不吞错也不改写（自检里「200 但返回的不是 JSON」那一条靠的就是这里漏出来）。十六是 1.1.2 新接的讯飞（`tests/iflytekAsr.test.ts`，28 条）。**这一家本机没有凭据、一次真请求都没发过**，所以这一份钉的不是「跑通过」，而是「形状与原厂文档逐字对得上」——这也是 #224 那句拍板（先照规范设计好、之后有 Key 再验）能成立的前提：等真有 Key 时，红一条就意味着凭据或网络，而不是签名推错了一个字符。签名那几条按文档那段 Java 示例逐步推：待签串是排掉 `signature` 自己、按参数名排序、空值不参与、`编码后的键=编码后的值` 用 `&` 连起来，再 `base64(HMAC-SHA1(串, APISecret))`；而那份编码是 Java `URLEncoder` 的口径（空格编成 `+`，`!'()~` 也要编），与 `encodeURIComponent` 差一个字符对方就回 100009，偏偏唯一带得上这些字符的是 `fileName`——就是用户自己那份音频的名字。期望值由测试自己用 `node:crypto` **独立算一遍**、时区偏移另走 `Intl` 推（`getTimezoneOffset` 的符号与文档要的相反，照它写期望等于把实现的坑抄进测试）。上传与查询两趟各钉一份完整待签串，并断言两者签名不同、查询那趟**没有 `appId`**、`dateTime` 重新生成而 `signatureRandom` 沿用上传那一个（这一对最容易记反，记反了签名照样算得出来、只是对方不认，回的是一条看不出原因的错）。结果解析按文档那份完成态响应示例逐段对（`tests/fixtures/iflytekOrderResult.json` 就是从它取出来的）：`orderResult` 是**双层字符串化**的（`lattice[].json_1best` 还要再解一次，少解一层的症状是「转写完成、字幕全空」）、`bg`/`ed` 是毫秒**字符串**（别家给的是秒、而且是数字，所以这一层不能与 `readAsrResponse` 共用）、`wp` 只留 n 与 p（留着 s 会多出一个孤零零的「喂」，g 的 `w` 本来就是空串）、置信度只对 n 那一类取平均（标点那一类的 `wc` 恒为 `0.0000`，算进去每段都无端压低一截）。整条链路那几条用替身 `fetch` 跑：错误可以带着 HTTP 200 回来（`code` 是数字也认，成功示例里它是字符串、失败示例里是数字）、200 但响应体不是 JSON 要说「地址填错了层级」而不是当成一次空响应、收下却没回订单号不许静默当成功、`status 4` 才解析、到上界还没完成就把**订单号交出去**（用户还能自己拿它去查，比一句「超时」有用）、`status -1` 带 `failType` 说话（`failType 6`「静音文件」对自检**不是**错误——自检发的正是一份静音样本，判成失败等于让配置正确的用户永远看到红的自检）、以及取消只让下一趟 `fetch` 抛 `AbortError`（轮询之间那段等待被取消时只是提前醒过来，不自己抛——取消在全应用只该有一种形状，多一种就多一处「点了取消却被报成失败」）。另有两条守的是**凭据不外泄**：APISecret 一个字节都不出现在 URL 与查询串里；而报错里带出去的那一段地址只留协议 + 域名 + 路径、**整个查询串丢掉**——查询串里的 `accessKeyId` 就是用户控制台里那把 APIKey，`logRedact` 拦不住它（那张表认的是**键名**，这里泄漏的是值），而那两句一处进 `app.log`、一处直接显示在设置弹窗里。丢掉查询串不损失诊断力：#327 那次 404 的教训是「看不出应用在后头又接了一层路径」，说的是路径，而签名那几个参数全是我们自己算出来的，用户照着它也改不了什么。

闸门位置：`build.yml` 的 `test` job（ubuntu，装依赖 + `tsc -b --force` + `pnpm test`）用 `needs` 卡在三平台矩阵之前，红在这里就不用再花三份构建时间。第十块里那 6 条拉起档不在这个 job 里——ubuntu 上没有冻结产物，跑也只能全跳过；它挂在三个平台 job 各自的 `Smoke engine binaries (${{ matrix.arch }})` 一步，紧跟在「Upload TTS binary」之后、「Build renderer + main」之前，带 `VV_ENGINE_SMOKE=1` 与 `VV_ENGINE_SMOKE_ARCH=${{ matrix.arch }}`（macOS x64 job 的 Node 自己仍是 arm64，只有构建步骤被 `arch -x86_64` 按在 x64 里；不指这个开关就会去找一份不存在的 `dist-arm64`，那里的 x64 产物由 Rosetta 拉起）。UI 与安装包链路仍由人工冒烟覆盖（见上面的「开发模式」与下面的「构建打包」），单测不碰。

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

本地配音的 sidecar 不走这条：`build:mac:arm64` / `build:electron*` 里没有 `build:tts`，electron-builder 的 `extraResources` 也只列了 `python-asr/dist-<arch>`——安装包**不含**配音引擎（见「按需组件」的理由）。CI 每个平台各编一份 `python-tts/dist-<arch>/vv-tts-server[.exe]` 并传成 `vv-tts-server-<platform>-<arch>` 这份 artifact；这三份由 **`build.yml` 的 release job 在创建 Release 的那一刻**打成资产、连同生成的 `components-manifest.json` 一起挂上（2026-10-29 改的：仓库开了 Release immutability，「事后往已发布的 Release 加资产」这条路必然 HTTP 422，只有创建那一刻传得进去；顺带把「人工指名 run-id」也省了——三份二进制与三个安装包出自同一次 run，指纹天然对得上眼前这次产物）。原来的 `publish-components.yml` 就此成为回收路径（只在临时关掉 immutability 补历史版本时才有用）。清单仍然要**人工看过 diff 再提交进 main**——CI 不把自己刚生成的信任锚直接推上 main，全文会抄进 job summary，Release 上也有一份公开可读的资产副本。这份流程里没有模型：第三方权重的再分发许可尚未核实（2026-10-28 实测该 HuggingFace 仓库 `license` 字段为空、也没有 LICENSE 文件），而模型这一路本来就不走 Release（应用从 hf-mirror 自取）。`build.yml` 里那步 `Verify components manifest` 只在仓库根有这份清单时才对账（不存在只提示并退 0，存在即硬失败；对的是清单声明的 sha256 与 GitHub 上传时自己算的 digest）；release job 发布之后还会再对一遍同一笔账（资产的 `state` 与 `digest` 是 GitHub 传完之后异步填的，所以那一步最多看 6 轮、每轮间隔 20 秒；6 轮后仍未落定就判红——旧写法对 digest 缺席只 warn 一句，等于「什么都没核对的绿色」）。`win32-arm64` 在 `ENGINE_KEYS` 里但 CI 不产这一档，清单里缺它是设计内的状态（那个平台的引擎行显示「本版没有下载包」）。本地要手工出这份二进制就是 `pnpm setup:tts` + `pnpm build:tts`；`pnpm check:components-manifest` 是发布后的独立复核（比对 GitHub 给每个资产自己算的 digest），清单还没进仓库时它只打一行「本地配音组件尚未发布」再退 0，联网不通或只改文案时用 `--offline` 做本地结构校验。

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

### 多套配置（方案）

转写、校对、配音三档各自可以并存最多 3 套方案（`MAX_PROFILES_PER_CAPABILITY`，`settingsSchema.ts`），互不影响：转写用第一套、校对用第二套、配音用第三套，是这套结构支持的正常用法（一家网关转写、另一家校对、第三家配音）。**第⑧步起三个 Tab 是同一套界面**（`ProfileList` + `ProfileDialog`，两个组件都不认档位，字段表在 `utils/profileSpec`）：一栏「云端转写／校对／配音方案」+ 一个小弹窗。栏里一行一套，行上写的是模型名 · 接口域名（整行不换行：两边都长就各让一半、各自截断，完整那串挂在 hover 的 `title` 上；「当前使用」那一行靠一圈发光边框加动作前一枚小徽标认，不再是夹在文字中间加粗那四个字），动作只有「新建API接入 / 编辑 / 删除」三颗；删除的二次确认是**挂在被点那一行下面的气泡**（`.profile-confirm-pop`，点外面和 Esc 收掉它，但收不掉外面那个设置窗口）。改名去掉了：建那条时主进程就按模型名落名字，行上显示的又是模型名，再让用户维护一份只有他自己看得懂的别名没有意义。这一档的凭据那几格（三档各四格，第一格是服务商／厂商——转写与配音的「厂商」都是 1.1.1 加的；**转写那一档选到讯飞时是五格**：多出 AppID 与 APISecret、少掉「模型」，因为它那条链路的参数表里没有模型这一项，1.1.2 #343）连同那颗**「当前使用」**勾选都住进**小弹窗**——点「新建API接入」或某一行的「编辑」才出现，底部两颗按钮「取消 / 保存」，**「保存」当场写磁盘**，右下角那颗「保存设置」从此碰不到任何一档的凭据。新建时没起名就先取那条的模型名，再没有就自动给「方案 1 / 方案 2 / 方案 3」（不与已有名字重样）。这一栏只在**这一档真走云端**时出现：转写看「转写模式＝云端优先」，配音看「配音引擎＝云端接口」（本地档不看厂商、地址、Key、模型这四样，填了也不生效），校对本来只有云端。

**一条方案里只装「换一家网关要换的那几项」**：接口地址、API Key、模型，转写与配音各多一项厂商、校对多一项服务商（都不是凭据，但它们是「这套地址和 Key 是哪家」的书签：校那一档按它预填地址与默认模型，配音这一档 1.1.1 拍板**改成清空而不是预填**——换厂商时接口地址、API Key、配音模型三格一起清空，灰字只留举例，因为替用户填进去的地址一旦过时，它长得就像用户自己填的、点保存就落盘，而猜错的地址要等请求失败才说话，空格子当场就拦得住；厂商还决定「音色这一格能不能空着」）。1.1.0 起配音这一档把**音色摘出了方案**——大多数用户并不清楚哪个模型支持哪些音色，把它绑进方案等于替每家网关猜一份清单，而各家的字段名与取值本来就不一样；它改成了配音页上那一次任务的选项。1.1.1 又在这一档的第一格加回一个「厂商」，于是配音方案与校对方案同样是四格。1.1.2 起**转写这一档的格数还会跟着「厂商」那一格变**：选讯飞时多出 AppID 与 APISecret、少掉「模型」，是三档里唯一格数不固定的一档（AppID 按明文存——签名与请求参数都要带上它，它不是密钥；APISecret 与 API Key 一样加密存，且一个字节都不发出去，只用来算这一趟的 HMAC-SHA1 签名）。而**这七项不在任何方案里**，它们是磁盘上 `settings.json` 根上的一段全局值：转写模式（云端 / 本地）、本地转写档位、转写语言、配音引擎（云端 / 本地）、本地配音模型、本地音色编号、配音音色名。最后那项（`ttsVoice`）和它前面那项「本地音色编号」（`ttsLocalVoice`）从 1.1.0 起在设置页**都没有对应的格子**：配音页那一格是单次覆盖、不写盘，根上这两份只是「没在页面上动过时用的默认值」。`ttsVoice` 没人填过在 OpenAI 兼容那一档就等于「不指定音色」——请求体里干脆不发 `voice`；1.1.1 起换成 MiniMax／百炼、1.1.2 起换成豆包时这一格空着会被主进程当场拦下，请求根本发不出去；`ttsLocalVoice` 在设置里唯一的写入点是换本地配音模型时归回第一个编号（`SettingsModal` 里那处 onChange），磁盘上是空串也没关系，`normalizeLocalVoice` 把它落成推荐档 0。换方案不会把全局段这几项一起换走，改它们也不属于任何一套方案；这份归属只有一处说了算——`settingsSchema.CAPABILITY_FIELDS` 认领的进方案，没被认领的自动落进全局段（`GLOBAL_FLAT_KEYS` 是从这两张表推出来的，不是手抄的）。这是第一轮方案档被推翻的地方——本机跑本地引擎、同时存着一套云端 Key 是同一台机器上的常态，把「用不用云端」做成方案自带的字段，等于逼用户为这一件事建两套配置。「0 配置」也是一等状态：任何一档都可以一条方案都没有（还没建过第一条，或把最后一条删了），这时那一栏给的是「一条都还没有：点下面『新建API接入』…」那句和那颗按钮，而不是「你的 Key 丢了」。

界面上有两对概念必须分开读，这是这一层最容易踩的地方：

- **「当前使用」≠「正在编辑」**。标着「当前使用」的那条是应用真按它干活的（磁盘上的 `defaultProfileId`）；弹窗此刻开给的那一条只是「在改谁的字」。编辑一套没在用的配置不该影响正在跑的活，所以这两件事在数据结构、按钮禁用和提示语上都是分开的。**设置里三档的换法是同一颗勾选**：它就长在弹窗里，跟着弹窗自己那颗「保存」落盘——新建走 `createProfile` 的 `setDefault`、编辑走 `settings:save` 的 `defaultProfileIds`，右下角「保存设置」完全不参与，所以成功那句说的是这一条自己（「已建好「X」…」／「已存好「X」的凭据…」），不再是那句通用的「设置已保存」。**界面上另外两处「设为当前使用」**（校对方式弹窗里那条「校对方案」下拉、配音页顶部那条「配音方案」下拉）走 `settings:setDefaultProfile`，只改指针、当场落盘，成功那句是「已把「X」设为当前使用的{校对/配音}配置，下一次{校对/配音}就按这套干活」，不是「立刻生效」。两处都不动正在跑的那一批，仍用开跑时读好的那套；也都不动本地引擎——「云端还是本地」「本地档位」「本地音色编号」「配音音色名」是全局段、不在任何一条方案里，引擎的重起只由「保存」真改掉档位那一次引起（`ensureLocalTier` / `ensureLocalTtsEngine` 在下一次调用时比的都是那一份全局档位）。
- **弹窗那颗「保存」当场写磁盘，面板上那几格要点右下角「保存设置」才落盘**。三档的「新建API接入」和「编辑」都只开弹窗：点入口一个字节都不写磁盘（填完不点保存、直接「取消」／Esc，磁盘上还是原样），点弹窗里那颗「保存」则当场落盘——新建走 `settings:createProfile`、编辑走 `settings:save` 只带这一档那几格和这一条的 id，那颗「当前使用」勾选跟着同一次点击走。以前「新建」这颗按钮当场建一条，用户点完才第一次看见输入框，想改得改一条已经存在的方案，点错了磁盘上还多出一条没人要的；第⑤步那版又把草稿摊在列表下面、让它跟着「保存设置」建出来，于是同一个面板上出现两种落盘时机（删除当场、新建要等右下角），用户分不清「刚填的那几格到底算不算存了」。现在弹窗两颗按钮把这件事说死了：「取消」＝丢掉草稿，「保存」＝写磁盘，右下角那颗与这些格子无关。**右下角那次保存只可能写全局段**（`handleSave` 发的就是表单那几项，一条凭据都不带）：`profileIds` 也不再带——三档的凭据都不从这条路进。第⑤步那轮 CDP 实测过的坑留在这里当反面教材：删掉最后一条方案后只改「转写语言」点保存，主进程把那次当成「你要存凭据却没先建」拦下，盘上 `asrLanguage` 停在原值，而界面只剩一句「请先点『新建一套』」——没有归宿的字段就不发，这才是修法。**这一档一条方案都没有时再点保存也不会被偷偷建成一条**——`PROFILE_CREATE_FIRST_MESSAGE` 那句「要先点『新建API接入』」现在是主进程侧的不变量（直接打 IPC 才走得到，`tests/settingsProfiles.test.ts` 钉着），界面上三档都碰不到它，因为凭据只能从弹窗进来，而弹窗那颗「保存」是先建再存。这一句送到界面时**原样就是那一句**，不披「清出磁盘空间或修好目录权限」那件外衣（`saveErrorMessage` 与 `profilesErrorMessage` 同一口径：规矩那句不许被包成磁盘坏了，真 EACCES 那句也不许被吞成没原因）。**校对那一页连右下角那颗按钮都不出现**（`hasPanelFields`）——那一档屏幕上从「服务商」到「模型」全住在弹窗里，摆一颗按下去只会说「设置已保存」、盘上什么都没变的按钮就是撒谎。

其余口径：

- **「未保存」的只有面板上那几格，弹窗里那份是草稿、不参与比对**。右下角「保存设置」那几格走「点保存才生效」：改完不点它，关窗会问「有未保存的修改」（比的是 `snapshot` 那一份）。弹窗里那几格和那颗勾选**从不进表单状态**（`SettingsValues` 只装全局段那几项：6 个键、屏幕上有格子的是 5 个——转写的模式／本地档位／语言 + 配音的引擎／本地模型；`ttsLocalVoice` 跟着表单走却在 1.1.0 起没有对应的格子，只在换本地模型时被归回第一个，`ttsVoice` 连表单都不进、只剩迁移和主进程读数在动它），所以既不会被右下角那颗存到别处，也不会因为它们的改动让关窗多问一句——收场只有「取消」、右上角 X 和 Esc 三条，每一条都是用户自己点的（CDP 实测：Esc 只收弹窗，外面那个设置窗口照旧开着）。列表上点「编辑」**不重拍 snapshot**：它只决定「弹窗是为哪一条开的」，字段由弹窗直接从磁盘那一份起手。以前这里踩过的坑是走了一条会重拍整份 snapshot 的切换通道——用户在「转写模式／语言」里刚改还没存的那两处会跟着被算成已保存，关窗不问一句（静默丢改动），那条路现在从代码里删掉了。CDP 实测：改了「转写语言」不保存 → 点某一行的「编辑」→ 取消 → 关窗仍然问「有未保存的修改」。**弹窗是模态的**，开着它点不到列表上另一行的「编辑」，也点不到「删除」，所以翻了一半的勾选不会被别处洗掉。切「转写模式」离云端、切「配音引擎」离云时会把那一档的弹窗一起收掉（`closeDraftOf`）——那一栏本身也在这时收起，留着一份看不见的新草稿，切回云端时当着用户的面重新弹出来，那已经不是他要填的东西了。还有一层跟着方案走：Key 那一格每开一次弹窗都从空开始——输入框里的字是「还没保存的新 Key」，跟着盖到另一套上就等于把 A 套的 Key 存进 B 套；那一格的「已保存／未填写」标记挂在草稿自己身上（开弹窗时从那条的 `profile.keyStatus` 抄一份，面板不再持有密钥状态，共用就会把 A 套的密钥状态说到 B 套头上），同时那一档的自检结果被收掉（`invalidateTest`），因为「按 A 套测过」不再说明 B 套能不能通。
- **三档那颗「新建API接入」都是只开弹窗、一个字节都不写磁盘**。写盘的是弹窗底部那颗「保存」：新建调 `settings:createProfile`（`values` 就是弹窗那几格、`setDefault` 就是那颗勾选），成功那句是「已建好「X」，API Key 也一起存好了」再补一句指针的结局（没接管就说「当前使用的还是原来那一条——要换过来，进这一行的「编辑」勾上「当前使用」再保存」）；「取消」把草稿整个丢掉，磁盘上不会多出一条没人要的方案。弹窗起手抄的是**列表上「当前使用」那一条**的那几格（这一档没有「当前使用」那条时抄列表第一条——行上就写着它，抄得不算突然），为的是「同一家网关换个模型」这个最常见的第二次配置不用重打地址；`fromProfileId` 传的却是**空串**（一条全空白），密钥绝不从上一条搬过来——密钥属于那一家，悄悄复制到另一套里，下一次干活按谁计价就没人说得清。Key 那格永远从空开始、也不挂「已保存」那个标记（这条还没拿到任何密钥，那标记说的是别的那一套）；空着是「没填新 Key」，不是「把抄来的那把抹掉」——只有真填了、或真点了「清除已保存的 Key」才带上它。手上还没有任何一条时没有可抄的对象，而**这第一条落盘就同时是「当前使用」那条**（建完就能干活，不用再去找开关；所以列表为空时连那颗勾选都不出现，摆一颗能取消的勾等于给用户一个点了也没用的开关）；已经有别的条时新建不会自己上位，这时弹窗里才多出一颗**「建好就设为当前使用」**，默认不勾（不勾就还是原来那条在跑），勾了才顶掉。
- **上限与最后一条**：满 3 套时那一栏直接把「新建API接入」收掉，只留「最多 3 套，要再建一套先删掉一条」那句话（不是摆一颗按不动的按钮——那个位置留给出路）；只剩 1 套时「删除」**不再禁用**——删空这一档是合法状态，界面随之换成那一档自己那句「一条都还没有：点下面『新建API接入』，填好那几格点弹窗里的『保存』。第一条落盘就是当前使用的那一套」。**二次确认三档都是挂在被点那一行下面的气泡**（`.profile-confirm-pop`，第⑦步做在转写上、第⑧步跟着组件一起共用；上一版它长在整栏末尾，点完「删除」要往下滑才看到那颗确认，而它说的正是这一行要没了）。气泡那句是「删掉「X」？这一套的{这几样}一起没掉，撤不回来」，其中「这几样」按档给（转写＝地址、模型；校对＝服务商、地址、模型；配音＝地址、配音模型——1.1.0 起音色不在方案里，所以删掉一条方案不该说它带走音色，全在 `PROFILE_CAP_SPEC[*].credSummary` 那张表上），「、API Key」按那条自己的 `keyStatus` 决定——**一套没存过密钥的方案被删掉时不许说它有 Key**；再按「是不是当前使用那条 / 是不是最后一条」补一句指针的结局（「它是最后一条，也是「当前使用」那条——删掉后这一档一条方案都没有，{云端转写／AI 校对／云端配音}会被拦下」／「它是「当前使用」那条——删掉后这几套里没有正在使用的方案，…会被拦下」／「这是最后一条，删掉后这一档一条方案都没有」）。这一句不用再说「表单里那几处还没保存的修改也一起丢」：面板上没有表单了，草稿在弹窗里，而开着弹窗点不到「删除」。气泡点外面和 Esc 都收得掉，而收掉的只有气泡（CDP 实测：设置窗口此刻照旧开着）。**主进程那侧指针一律落空串**，剩下几条都不接班（`fixDefaultId`）：让应用悄悄换成列表里排第一那条等于替用户选了家网关，而下一次干活花的钱按那条计价；界面因此多一句「这几套里没有「当前使用」的那一条，{活动}会被拦下：进那一行的「编辑」勾上再保存」，那句拦下的话只等在列表上，救不回已经按下去的那一次——所以二次确认要提前替用户说出这个结局。删完那句 toast 也不能再说「列表照旧」（删到一条不剩时列表恰好空了）。**toast、二次确认、页面上那条下拉里报的那个名，跟列表那一行显示的是同一个**——模型名优先、没模型才退方案名（`profileRowTitle` 一处算）：用户点的是写着「whisper-1-touched」那一行，toast 却说「已删掉「whisper-large-v3」」（那条自己存着的旧名字）等于报了另一条方案，这是第⑥步那轮 CDP 真抓出来的；方案名建那条时按当时的模型落定、弹窗里没有改名格，所以它只会过期，不会跟着变。
- **列表读不出来时不许演成「一条都没有」**：那时那一栏只剩标题加一句「方案列表这次没读出来——磁盘上已有的方案不会因此消失。新建、编辑、删除也先别用：关掉设置窗口重开一次。」，三档同一句（组件不认档位）；打开设置那一次还额外 toast 一句同样的话，因为这一栏此刻没有别的上下文。全局段那几格照旧显示磁盘上的真值——`settings:get` 和 `settings:listProfiles` 是两次独立的读，一次列表抖动不该把已经读到的字段打回默认值（那才是真丢数据），两边套在同一个 `try` 里就是这个错。「测试连接」在这时按不动（测的是磁盘上「当前使用」那一条，而列表读不出时根本不知道是哪条），旁边那句也会分三种：列表没读出来＝「关掉设置窗口重开一次再看」，一条都没建＝「还没有方案可测：点上面『新建API接入』」，建了但没选谁在干活＝「没有『当前使用』的那一条，这颗按不动」。这是 `settings:listProfiles` 回 `null` 而不是回一份「每条都空」的列表的原因——回空列表会当着用户的面说「你还没填 Key」，而磁盘上明明有。
- **手改文件塞进第 4 条照样读得懂**：上限只在写入侧拦新建，读侧不剪列表（剪掉是「读成功、写成功、东西没了」）。
- **配音页顶部也有一条「配音方案」下拉，它做的就是「把配音档的当前使用换过去」**（#222 第④步的配音这半）。只在配音档确实有多于一套时出现：只有一条时这一格不摆，方案名改在「当前用的是哪一套」那行里报出来（报的名字和设置那一行同一个），读不出列表时整块收起（`profiles` 是 `null`，界面照样不许说「只有默认那套」）。正在配音或正在试听时禁用，连点由 store 那个按档的 `switching` 标记合并成一次，走的仍是 `settings:setDefaultProfile` 这同一条 IPC——所以成功那句也是「已把「X」设为当前使用的配音配置，下一次配音就按这套干活」，界面上不留第二种「切方案」的口径。**这一格 1.1.0 起按档位分叉**：本地档它换成「配音模型」下拉（白名单里那两档，是这一次调用的参数、不写回设置），因为方案那三项凭据（地址 / Key / 模型）本地档一个字都不读，在本地档摆一条「配音方案」下拉就是「你以为在用的那套其实没参与」；下面那句横幅也照档分叉——本地档念的是选中的那一档引擎，云端档念的是「当前使用那一条」里的模型（页面上没有手输的覆盖了，所以念的就是待会儿真发出去的那个）。换完方案会把单次参数收回（`set({ voice: '', engine: '', speakers: 0 })`）再重读一遍设置：音色不在方案里（1.1.0 起它是全局那一份 `ttsVoice`），清空只是把手输的这一次覆盖收回、让它退回重读到的那一份，挂着 A 套挑的音色、实际按 B 套跑是这一格最坏的骗人方式；倍速既不在方案字段里也不在全局段（`CAPABILITY_FIELDS.tts` 那 3 个键没有它），是这一页自己的参数，留着。**它不是「这一次用哪套」的单次覆盖**：「云端还是本地」在第⑧步之后是全局段那一份 `ttsEngine`，而这一档本页刻意不给选（它决定花不花钱、要不要拉起本机进程），做成单次覆盖等于把那扇关着的门从侧面推开。因此 `tts:preview` / `tts:synthesize` 收到的 `profileId` 至今是空＝配音档当前默认那条，切完之后的下一次取值才走新那套，正在跑的那一批仍用原来那套。
- **三条链路都在主进程记一句「这次按哪一套跑的」**（#222 第④步的日志那半）：`asr:start` 那条 `Transcription config`、校对的 `Correction config` / `Explain differences config` / `Analyze reference config`、配音的 `Preview config` 与开跑前的 `Batch config`。记的都是 `resolveProfileId` 落回之后的**实际那一条**，不是界面报回来的那一个——落回默认时后者会说谎（本机实测：传一条不存在的 id，盘上写的是这条档的默认方案）。载荷只有方案 id、云端/本地那一档、段数与一个「有没有 Key」的布尔；Key 本身、接口地址、文稿正文都不进这一条。**那个布尔的键名是 `keyStatus`，不能写成 `hasApiKey`**：脱敏闸门按键名包含 `apikey` 就整值隐去（`logRedact.ts`），`hasApiKey` 落盘只剩 `[已隐去:boolean]`——用户本机 app.log 里 2026-10-30 那几条 `Transcription config` 就是这个样子，隐掉它一个字节的安全也没多，只是把「到底有没有配 Key」这句诊断读没了。
- **校对那一步挂了一条「校对方案」下拉**（`ProofreadModeDialog.tsx`，#222 第④步的另一半），口径与配音那条完全一样，也只做「设为当前使用」——同一条 `settings:setDefaultProfile`、同一句「已把「X」设为当前使用的校对配置，下一次校对就按这套干活」。**转写首页原来也挂着一条，重写第③步已经撤了**：那一档的凭据只剩三项，「用哪一套」收进「设置 → 转写配置」的「当前使用」勾选，首页不留第二个入口（两个入口做同一件事，早晚说出两种话）。因此 `ai:correct` 收到的 `profileId` 至今是空＝该档当前那条，切完之后的下一次才走新那套。下拉只在对应那档确实有多于一套时出现，只有一条或列表没读出来时整块收起——校对那一格连分隔线和旁边那句提示一起收，否则弹窗里会多空一道没人问的横线。校对为什么不摆在结果页表头那一行：1400 宽的窗口里表头可用 806px，标题组 299 + 四颗按钮 374 已用掉 673，再加一格 176px 的横排下拉（标签 48 + 间距 8 + 控件 120）就把表头挤成两行（本机实测 77 → 115px）。列表由页面挂载时的 `useProfiles` 读一次，设置窗口每读回一份列表都把它同时推给 `useProfileStore`（`applyProfiles` → `applyView`），所以在设置里新建/删掉一套之后，回到那一页看到的就是磁盘此刻的清单，不必重开应用。至于「每批任务记下当时用的是哪三条」，那是 #247 历史记录的活——已经落了：账上每条带 `profiles{asr,ai,tts}` 三格，但填法按「这一行是哪一类活」分：转写只填 `asr`、配音只填 `tts`、下载三格全空（它不读任何凭据）。校对不产出新素材、也就没有它自己那一行账，所以 `ai` 那格至今没有任何调用点填过——留着是因为「一次转写当时配的是哪套校对」这件事将来要说得清，而不是现在假装它有用。

### 转写配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 转写模式 | `local`（「本地转写（默认）」）/ `cloud`（「云端优先（需配置 API Key）」） | `local` |
| 本地模型档位 | `asrLocalModel`，本地引擎用哪一档 Whisper：`base`（「快速」，权重约 138MB）/ `small`（「精准」，约 461MB，本机实测耗时约为快速档的 2.8 倍）。只在转写模式不是 `cloud` 时显示；这个值和下面的「模型」无关，后者是云端服务商的型号名 | `base` |
| 转写语言 | `asrLanguage`，传给 Whisper 的语言码，共 12 种（zh/en/ja/ko/th/vi/id/fr/de/es/ru/ar）；刻意不提供「自动检测」 | `zh` |
| 厂商 | `asrVendor`，**属于方案**（1.1.1，#224 转写侧）。云端转写这一趟发成哪一家的形状：`openai`（「OpenAI 兼容接口」，也是留空／认不出来时的落点）/ `minimax`（「MiniMax」）/ `iflytek`（「讯飞（录音文件转写大模型版）」，1.1.2 #343）。**豆包与阿里云百炼这两家的转写都没接**（豆包的**配音**照旧收，见下面「配音配置」那节——它那条链路一次 POST 就把音频给回来，与转写不是一个形状）。豆包在架那一版的转写只收**公网可访问的音频地址**（`audio.url` 必填，文档里已经没有把音频塞进请求体的写法），而本机文件换不到一个能递给对方的地址：官方给的那条「上传换临时 URL」自己写着「请勿用于生产环境」（48 小时过期、凭证 100 QPS 不可扩容）。与其在下拉里挂一个「选了大概率失败」的选项，不如先不列它。百炼**不是**这个理由（1.1.1 收尾时把它家 ASR 的文档逐条过了一遍，之前记的「只收公网可访问的音频地址」这句不准，按下面这几条改）：`qwen3-asr-flash` 确实有一次调用就出结果的口子，但它那份「OpenAI 兼容」挂在 `/compatible-mode/v1/chat/completions` 上（消息体里放 `input_audio`，收 URL 或 Base64 Data URI，单次 ≤10MB、≤5 分钟），**不是** `/v1/audio/transcriptions` 那个 multipart 上传——应用这一路发出去的形状它收不到；而同步那条（multimodal-generation）和兼容那条**都不返回时间戳**。要时间戳就得换 `qwen3-asr-flash-filetrans`，那一族才是提交任务→轮询→再下载结果，且只收公网可访问的音频地址（本地文件要先走官方临时上传，那条文档自己写着「请勿用于生产环境」）。字幕这一整条链路靠的就是 start/end，所以这一家在「一次 POST 上传本地文件、拿回秒级 segments」这个形状上没有可用路径——它不进下拉，免得用户在界面里选了一条半能用的路。讯飞这一家与前两家不是一个形状：它是三家里唯一「上传音频换订单号、再轮询取结果」的异步接口（`POST {apiBase}/v2/upload` → 每 3 秒 `POST {apiBase}/v2/getResult`，真转写最长等 1 小时、自检最长等 3 分钟），收 5 小时以内的长音频，也是**目前唯一真能收长音频的一家**。它要**三样凭据**（AppID / APIKey / APISecret——少一样对方回的都是同一句 100009「签名校验不通过」，那句不说是哪一格错了，所以开工前置校验会点名缺的那一格），而**没有「模型」那一格**（它那份参数表里压根没有这个字段，选的是 `language` 与领域参数，所以那一格按厂商不出现，列表那一行的标题也换成 AppID）。连带一句必须说清的：**「转写语言」这一格对它无效**——它只收 `autodialect` / `autominor`（后者要单独提交工单申请权限，所以适配层钉死 `autodialect`：中英 + 202 种方言免切识别），把 Whisper 那套短码发过去是一条 100020「语言验证失败」，用户只会以为是自己选的中文没生效。它的接口地址那一格也**不能留空**：留空时应用不会拿别家的地址替它发（那等于把用户的音频 POST 到一个他没选过的服务商去），而是直接判云端不可用、落回本地引擎。**这一家本机没有凭据、一次真请求都没发过**：形状全部照原厂文档（《录音文件转写大模型》，2026-11-07 读的那一份）实现，单测钉的是文档自己给出的签名示例与完成态响应示例（见上面第十六块），所以界面与文档都不说它验证过。换这一格会把下面几格（接口地址 / API Key / 模型，讯飞那两格 AppID / APISecret 也在内）一起清空——这一家的地址和模型名只有对方文档说了算，替你猜一份等于诱导保存一个错值。清空的是弹窗里那几个输入框，不是磁盘上那条记录：两把密钥那两格本来就留空＝不改，所以换过一次厂商再点「保存」，已存的密文原样不动（实测 `v1:` 那一串长度不变），地址、模型和 AppID 则按你重新填的写 | `openai` |
| API Base URL | 云端 ASR 接口地址。**属于方案**，只在「云端优先」下、且点了某一行的「编辑」或「新建API接入」之后才出现——那几格住在小弹窗里，点弹窗底部的「保存」当场写进这一条。OpenAI 兼容那一档留空时按 OpenAI 的官方地址发（只有这一档能这么省）；**讯飞那一档不能留空**，留空不会拿别家的地址替它发，而是直接判云端不可用 | 空 |
| AppID | `asrAppId`，**属于方案**，1.1.2 起只在「厂商＝讯飞」时出现（另两家的请求里没有这一层，摆一格等于让人往没人读的地方填值）。讯飞开放平台那个应用的 APPID（形如 `12345678`）；它**不是密钥**——签名与请求参数里都要带上它，所以按明文存（这一档没有模型名，列表那一行的标题显示的就是它）。要和另外两把是**同一个应用**的，串着用得到的是一句 100009「签名校验不通过」 | 空 |
| API Key | 云端 ASR 密钥。**属于方案**，同上。输入框不回显已保存的值：留空＝不改，「清除已保存的 Key」要点**弹窗里的「保存」**才生效（右下角那颗「保存设置」管不到它）；保存时经系统密钥库加密后写入，磁盘上形如 `v1:<base64>`。讯飞那一档这一格填的是控制台里那把 **APIKey**——它在请求参数里叫 `accessKeyId`；它不是 AppID、也不是下面那把 APISecret，三样填串了得到的都是同一句签名不通过 | 空 |
| APISecret | `asrApiSecret`，**属于方案**，同上只在「厂商＝讯飞」时出现。只用来算这一趟请求的 HMAC-SHA1 签名，**一个字节都不会发出去**；和 API Key 一样经系统密钥库加密后写入（磁盘上形如 `v1:<base64>`），留空＝不改。1.1.2 起这一档的密文因此有两把（`SECRET_PROFILE_FIELDS` 里 `apiKey` 与 `apiSecret` 两项），读不出来时那句「这台机器读不出已保存的 API Key」两把共用——成因与出路完全一样，不为它另编一种措辞。少了它对方回的是 100009「签名校验不通过」 | 空 |
| 模型 | ASR 模型名称。**属于方案**，同上；列表上那一行的标题显示的就是它。留空时按这一家的默认档发（OpenAI 兼容 `whisper-1`／MiniMax `asr-1.0`），灰字举例跟着「厂商」那一格变。**讯飞那一档这一格根本不出现**：它那条链路没有模型这一项，主进程那张默认档表里这一家写的是空串（空串在这里不是「还没兜底」，而是「没有这一格」），列表那一行的标题换成 AppID | 空 |

这九项里只有最后六项（厂商 / 接口地址 / AppID / API Key / APISecret / 模型——AppID 与 APISecret 只在讯飞那一档出现，「模型」恰恰相反，只在另两家出现）属于「配置方案」，换一套方案换的就是它们；前面三项「转写模式 / 本地模型档位 / 转写语言」是本机的全局值，存在 `settings.json` 的根上，换方案不会把它们一起换走（原因见上面「多套配置（方案）」那节——本机跑本地引擎、同时存着一套云端 Key 是常态）。「转写语言」是全局值这件事在讯飞那一档还多一层意思：它连**参与请求都不参与**（那一格只收 `autodialect` / `autominor`），所以界面上那一格按厂商明说「对这一家无效」，不留成一处「配了但没生效」的静默分歧。

「云端优先」下这四格上面有一栏**「云端转写方案」**：一行一套，行上写「模型名 · 接口域名」，真在用的那条标「当前使用」，动作只有「新建API接入 / 编辑 / 删除」三颗（改名去掉了——行上显示的是模型名，名字已经不参与分辨）。**那四格凭据平时不出现**：两颗入口都只弹出一个**小弹窗**（`ProfileDialog`，三档共用这一只），里面就是那四格 + 那颗「当前使用」勾选 + 底部「取消 / 保存」两颗按钮。点「保存」**当场写磁盘**，点「取消」／右上角 X／Esc 把草稿整个丢掉，右下角那颗「保存设置」从此碰不到这四格。要改「云端转写按哪一套走」，就在弹窗里勾那颗**「当前使用」**再点弹窗里的「保存」：勾选的初始值读的是磁盘上那个指针，所以没碰过它不等于「要把它改成不勾」——**没翻过它这一次保存根本不发 `defaultProfileIds`**（编辑非默认那条时基准值本就是 `false`，照它发等于发一个空串把磁盘上的指针清掉：用户只是进来改个接口地址，出去之后云端转写被拦下说「没有当前使用的方案」，而那颗勾他碰都没碰——这条是第⑤步那轮 CDP 抓出来的，第⑥步把整段搬进弹窗、规矩原样保留）；翻过了才发——勾＝把指针挪到这一条，不勾＝明确说这一档暂时不要当前使用的方案。取消勾选并保存＝点开始转写会被前置校验拦下。新建那一次这颗勾选写作**「建好就设为当前使用」**且默认不勾（已经有在用的那条时不顶掉它，成功那句因此要补一句「当前使用的还是原来那一条——要换过来，进这一行的「编辑」勾上「当前使用」再保存」）；列表本来就空时这颗勾选**根本不出现**，第一条落盘自动就是当前使用的那一套，摆一颗能取消的勾等于给用户一个点了也没用的开关。弹窗是模态的：点遮罩不关窗（里面装的是用户刚敲的地址和密钥，一关就再也回显不出来），Esc 也只关弹窗、外面那个设置窗口照旧开着——收场只有「取消」、右上角 X、Esc 三条路。这一栏还有一个连带效果：**「测试连接」测的是磁盘上「当前使用」那一条**已保存的厂商、地址、模型和 Key（厂商那一格 1.1.1 起也带进这一次自检，理由与配音同一句：不带就是那条方案是 MiniMax、自检却按 OpenAI 兼容的端点发，绿了也不作数；渲染层没选过就一直传空串，主进程按 OpenAI 兼容读，与取值那一边同一个落点），弹窗里没点「保存」的那些字不算。**讯飞那一档这一句要改口**：测的是 AppID / APIKey / APISecret 三样加一个非空的地址（它没有「模型」那一格），测法也不是「一次 POST 通不通」——它把真转写那一个入口 `runIflytekOrderFlow` 原样跑一遍（两处各拼一遍签名，就是 #220/#227 那种「自检说可用、一转写就失败」的分歧），代价是这一档点下去不是秒回（轮询上界 3 分钟），好处是绿灯意味着上传、换订单号、轮询、结果解析整条链都通了。这一档没有「当前使用」那条时这颗按不动，旁边那句按原因分三种说（`testBlockedHint`，三档共用这一个函数）：列表此刻没读出来 → 说「重开设置窗口再看一次」；一条都没有 → 说去点「新建API接入」；有方案但没有当前那条 → 才说「进要用的那一行的『编辑』，勾上『当前使用』再保存」。**前两种情况下那句「进某一行的编辑」是假路**——列表根本不在屏幕上，没有哪一行能点。本地模式这一档整栏不出现（四格凭据用不上，配置自检那格换成「检查引擎状态 / 重启本地引擎」）。

接口地址那格**允许直接粘对方文档里那条完整端点**：主进程按三步归一——先 `trim` 去尾斜杠，再认下「应用自己会往根地址后面接的那几条尾巴」（`settingsService.APPENDED_ENDPOINT_PATHS`，忽略大小写），最后才去掉尾巴上的一层 `/v1`；然后按「厂商」那一格拼上这一家的路径——OpenAI 兼容是 `${apiBase}/v1/audio/transcriptions`，MiniMax 是 `${apiBase}/v1/speech_to_text`，讯飞是两条（`${apiBase}/v2/upload` 换订单号、`${apiBase}/v2/getResult` 轮询取结果，两条都在尾巴表里，所以粘哪一条都能洗回根地址）（接路径这一处收在 `apiPath.appendApiPath`，转写／配音／校对三条链路与「测试连接」共用，见上面第十五块）。所以填 `https://example.com`、`https://example.com/v1` 或 `https://example.com/v1/` 都指向同一个端点；`https://api.minimax.cn/v1` 那种从对方文档粘来的地址也不会变成 `/v1/v1/...`。1.1.1 起再加一条兜底（#332）：**那张尾巴表没登记过的路径不再硬接**——归一化之后剩下的段数够两段、且第一段就是要接的那一条的第一段（`/v1/...`、`/api/v1/...`），就照你填的那一条打；只剩一段（`.../api`、`.../proxy` 这种挂在路径前缀底下的自建网关）仍按「根」接上去。加它是因为厂商会改路径：规则只写在我们这边时，对方改一天就得等我们发一版，而那句 404 里看不出应用做了什么。真撞 404 时，配音与自检的报错会把**最终打出去的那条地址**念出来（`POST https://...`），对着对方文档一眼就分得清是自己填深了还是应用接错了。

- **第二步是 1.1.1 才补上的，它补的是一条报成 404 的真链路（#327）**：用户照着 MiniMax 文档整段复制，粘进来的就是 `https://api.minimax.cn/v1/speech_to_text`（配音那格是 `.../v1/t2a_v2`），而应用在这串后面再接一次自己的路径，拼出 `.../v1/speech_to_text/v1/speech_to_text`，对方回一句「404 page not found」。症状长得像「没有这个 api 方案」，而用户填的明明是对方的原话——这种错最难往配置上想，只会让人怀疑那家根本没有这个接口。
- **那张表只登记真的会发出去的那几条**（十一条：转写五条、配音五条、校对一条），刻意不收 `/v1/responses`、`/v1/messages` 这种「以后也许接」的：认下一条自己根本不会发的尾巴，等于把一份本来就不兼容的配置洗成「看着像能用」——应用照旧发 `/v1/chat/completions` 加 Bearer，撞过去的还是那句错，只是这一次连用户填的原话都看不到了。**这十一条里有一条是例外**：`/api/v3/auc/bigmodel/recognize/flash`（豆包的录音文件转写）1.1.2 起应用一次都不发了——那一家的转写整条摘掉、只留配音（理由见上面「转写配置」那张表的「厂商」一行）。留着它不是「以后也许接」，而是为了**把同一家的旧端点洗回根地址**：认下这条尾巴，地址归一回豆包那个根，配音再按自己的 `/api/v3/tts/unidirectional` 接上去，是能用的；不认，`appendApiPath` 那道「两段以上且首段撞上」的判据会把整串当成用户指的端点原样打出去（`ours[0]` 与 `past[0]` 都是 `api`），于是配音请求 POST 到那条转写端点上，撞回来的是一句看不出所以然的错，而报错里念的还正是用户自己粘的那条地址。
- **这张表只用来认尾巴，不用来拼请求**，拼法仍以那五处为准（`ttsVendor.VENDOR_SHAPES` 与同文件那张 `VENDOR_VOICE_LIST_PATH`、`asrVendor.buildAsrRequest`、`asr/iflytekAsr` 那两条、`ai/openaiCompatible`），接路径这一步全应用只有 `apiPath.appendApiPath` 一处。表里的值是逐条从那五处抄来的，新增一条端点而忘了登记，代价从「粘贴完整端点必变成 404」降成「那条地址按原话打」——能不能连通取决于对方认不认这一条，而不再是应用悄悄叠上去的一层；对账测试（`tests/settingsNormalize.test.ts`）仍把这五处和表钉在一起，改拼法必须同时改表。表兜不住的是**串档**那类（在 MiniMax 的地址上粘了百炼的端点：首段撞不上，段数判据救不了，洗回根地址反而能用），所以两张网都要留着，归一化先跑。

- **只有「转写模式 = 云端优先」且填了云端 API Key，音频才会发出本机。** 默认的本地模式不发起任何网络转写请求；AI 校对的 Key 只处理文本，不会上传音视频。配音同理——发出去的是逐段的字幕文本（外加试听那一句），回来的才是音频，所以**文本会离开本机**，目的地就是「配音配置」里填的那个接口地址（留空时沿用「校对配置」那个）。已保存但在这台机器解不开的 Key 不算「填了」：开工前置校验会当场拦住并说明原因，不会带着空 `Authorization` 去打接口。
- 本地转写依赖内置的 Python ASR 引擎：打包后自动拉起，开发模式同样由主进程 spawn `python-asr/dist-<arch>/` 里的二进制（所以要先 `pnpm build:asr`，见「快速开始」）。引擎没能应答时，转写会直接给出原因而不是 `fetch failed`，并引导到「设置 → 转写配置」的「重启本地引擎」——它先 stop 再 start，`bootId` 每次 spawn 重新生成，所以不会把上一代残尸认成自己的引擎；重启进行中按钮显示「重启中…」，连点会被合并成一次，避免两个引擎抢 8000。有转写任务在跑时该操作被拒绝，避免打断正在出的字幕。
- 换档位就是换引擎内存里的那个模型，而 `HF_HUB_OFFLINE` 只能在 spawn 之前决定，所以点「保存」时档位变了会自动重启一次本地引擎，提示「设置已保存，本地引擎已按新档位重启」。比的换前换后那一份**全局段**的 `asrLocalModel`：重写第①步起档位不再待在任何一个方案里，于是「这次保存写进了哪条方案」和「引擎跑哪个档位」是两件独立的事——方案里那三项凭据跟档位无关，编辑一套没在用的方案也不会顺手动到档位；只有表单上「本地档位」那一格真被改过，换前换后才不同、才重启一次，否则一律 `not-needed`，不该惊动引擎，更不该附一句「新档位才会生效」（改凭据的保存一次引擎都不碰）。兜底在转写那一头：`asrManager` 发请求前用 `ensureLocalTier` 把引擎对齐到这一次真的会用到的那一份全局档位，对不上就报错而不是硬发。两种情况保存时不重启、也给人话提示：有转写正在跑（重启会截断正在推的 NDJSON 流，半截结果比报错更糟，提示让你等这次转写结束后手动点「重启本地引擎」）、自动重启失败。首次下载的体积提示不再写死数字：引擎在 `status` 事件里把档位和权重体积（`base` 138MB / `small` 461MB）一起下发，进度页直接用它，避免 JS 和 Python 两处数字各说各话。
- 「设置 → 转写配置 → 引擎状态」里的当前档位报的是引擎自己回显的那个（`/health` 的 `model` 字段），不是表单里还没保存的值——不然会让人以为切换已经生效了。
- 转写语言是中文时，本地和云端的结果都做一次繁→简归一（`opencc-js` 的 `tw→cn`，只在真的转出中文时才建字典，实测首次 4ms、之后每次不到 2ms）：`small` 档实测会漂繁体，而下游的误听表、词库和参考稿 diff 全按简体比对，不归一就会漏匹配。
- **「转写语言」这一项两家放的位置不一样**：OpenAI 兼容是 multipart 里的 `language` 字段，MiniMax 原厂口径是 `language` **请求头**（值是同一套短码，没有区域后缀）。当成字段发给 MiniMax 不会报错，只会静静被忽略——界面选了中文、对方按自动检测跑，这是最难被发现的那类「配了但没生效」。1.1.1 收尾时对着真 Key 打过一次：发一个不存在的语言标（`qq-zzz`）对方回 400 「invalid language」，说明这一项真被读了；`buildAsrRequest` 因此把 `headers` 做成形状的一部分，两个调用点（真转写与「测试连接」）都原样展开，不许其中一处漏带。**讯飞是第三副面孔：它根本没有这一项**——它只收 `autodialect`（中英 + 202 种方言免切识别）与 `autominor`（后者要单独提交工单申请权限，所以适配层钉死 `autodialect`），把 Whisper 那套短码发过去是一条 100020「语言验证失败」。所以「转写语言」那一格在选到讯飞时按厂商明说对这一家无效（`ASR_VENDOR_UI.iflytek.languageApplies = false`），不留成一处「选了中文却没生效」的静默分歧：这一家的中文与方言是对方自己判的，用户插不上手。
- **「厂商」各自的上限拦在音频发出去之前**（`asrFileProblem`）：MiniMax 单次 ≤500 秒、≤50MB；讯飞 ≤5 小时、≤500MB（原厂文档写死的硬上限，而超时长的表现是订单直接判 `failType 4`——用户得等一轮轮询才知道，所以更要在发出去之前就说）。超了直接给一句人话、不调接口。拦它不是因为怕花冤枉钱，而是因为一段超过 8 分钟的媒体是这一行最常见的输入，而「一次 POST 整段音频」这条链路对它根本不成立——不拦的话用户在进度条跑完之前什么都看不到，只在日志里撞到一句对方原话。**超限那句的尾巴按厂商分叉**：对前两家说的是「这一家没有长音频异步接口可用，或改用支持分段上传的服务」，对讯飞不能说这句——它**已经是**「上传换订单号再轮询」的异步接口了，5 小时就是它的天花板，所以那句换成「超过只能先把音频切开分几次转」；它同时也是目前唯一真能收长音频的一家。`openai` 那一档刻意不设上限：25MB 是 OpenAI 自己那家的数，而兼容网关各自放多少并不一样（本机起的、内网的常常不收这一项），替它们拦人会把能用的人挡在门外。体积按 `50_000_000` 而不是 `50 * 1024 * 1024`——对方文档没说是十进制还是 1024 进制，取小的那个是宁可多拦一句也不让对方回 413；念出来的数走 `formatBytes` 那一把尺（#282）。时长探不到（探测失败）时只按体积判，不猜。
- **「测试连接」对静音样本不再误报「不支持分段」**：这一档用的是约 1 秒的静音样本，本来就走不出字，所以判据是「响应里有没有 `segments` 这个键」而不是「数组是不是空的」。MiniMax 在这件事上是原厂行为的例外——没听出字时它干脆不给 `segments` 这一项（实测返回的键只有 `text` / `duration` / `n_speakers` / `trace_id`），而真给音频时它给的是秒级 `start`/`end`（本机实测过）。照 OpenAI 那一支的判据读，这一家会得到一句「这个服务忽略了分段粒度，建议换成支持分段的服务（如 whisper-1）」——判断本身对了、建议是错的，用户照提示换服务，而问题本来不存在。所以 MiniMax 在这种情况下回 pass 并明说「分段时间戳这次没验到：这一家对没听出字的样本直接不返回 segments，真实转写里再看」。**讯飞那一档连这个判据都用不上**：静音样本走完一整条链（上传 → 换订单号 → 轮询）之后对方回的是 `status 4` + `failType 6 静音文件`，那里没有 `segments` 这个键可看。自检把这一条判成**通过**——它证明地址、三样凭据、签名、上传、轮询与结果解析整条链都通了，「这份音频里没有人声」只是样本自己的性质；判成 fail 的话配置全对的用户就永远看着一颗红的「测试连接」，与上面 MiniMax 音色那次死锁同一类坑。真转写那边这一条仍是失败（编辑器会白屏），两处口径**故意差这一处**。另外这一档的自检收场分三种措辞：三样凭据缺哪一样就点名哪一格（对方回的 100009「签名校验不通过」不说是哪一格错了）；轮询到上界还没出结果时把**订单号**交出去（「凭据与地址大概率是对的——它已经发得出订单号了」），所以整个 `fetch` 的信号比轮询上界多留 30 秒，为的是让这一趟走优雅那个出口而不是先被信号打断成一句笼统的超时；真的 `failType` 非 0 非 6 时才说「地址与凭据是通的，卡住的是音频本身」。

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

这四格从第⑧步起也住在**方案**里：这一 Tab 是「云端校对方案」那一栏 + 「配置自检」 + 「本地词典」，面板上没有输入框，所以**这一页连右下角那颗「保存设置」都不出现**（`hasPanelFields` 把 `ai` 排除在外，底部换成「关闭」）——没有面板字段可存，摆一颗按下去只说「设置已保存」、盘上什么都没改的按钮就是撒谎。

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 服务商 | `aiProvider`，OpenAI / DeepSeek / 通义千问 / 自定义兼容接口。**属于方案**。选中一家会连带把弹窗里另外两格填成那家的地址与默认模型（`PROFILE_CAP_SPEC.ai.fields[].fills`，改完还能自己改回去）——换网关就是换一家，地址留着上一家等于换个名字骗自己。**主进程取配置时不看这一项**，它只是「这套地址和 Key 是哪家」的书签；预设也只动这一条草稿，配音那套有自己的地址和 Key，不被它改写 | `openai` |
| API Base URL | `aiApiBase`，AI 接口地址（**属于方案**，弹窗里那格）。主进程在其后拼 `/v1/chat/completions`；整条端点直接粘进来也算对（这一条在 `APPENDED_ENDPOINT_PATHS` 那张表里，见「转写配置」那节的地址归一化） | 空（等价 `https://api.openai.com`） |
| API Key | `aiApiKey`，AI 密钥（**属于方案**，弹窗里那格）。同样不回显、留空＝不改。没配 Key 时点「校对」不弹选择框，直接走本地通道；有 Key 才弹「本地校对 / AI 校对」——密文在这台机器解不开也算「有」，好在弹窗里撞上明确原因并跳去重填，而不是被「未配置校对模型」误导 | 空 |
| 模型 | `aiModel`，AI 模型名称（**属于方案**，弹窗里那格；列表那一行的标题就是它） | 空（默认 `gpt-4o-mini`；预设 DeepSeek=`deepseek-chat`、通义千问=`qwen-plus`） |

这一档**没有任何全局字段**：`GLOBAL_FLAT_KEYS` 里那七项（转写的模式／本地档位／语言，配音的引擎／本地模型／本地音色编号／云端音色名）一项都不属于校对，所以右下角那次保存对这一档能写的只有全局段与另两档，与校对无关。要改「AI 校对按哪一套走」，只在弹窗里那颗「当前使用」勾选上——它与弹窗自己那颗「保存」同一次落盘。

### 配音配置

配音是「设置」里的第三个 Tab，字段按**两条链路各归一处**分：走不走云端、本地跑哪一档引擎，这两项是**全局段**里这一页还有格子的（分别常驻和只在本地档出现，点右下角「保存设置」落盘）；另两个全局段（本地默认音色编号 `ttsLocalVoice`、云端音色名 `ttsVoice`）从 1.1.0 起**没有格子了**——音色是「这一批听哪一个」，入口只剩配音页那一格，磁盘上这两份退回「没在页面上手输时的默认值」；厂商 / 接口地址 / Key / 配音模型 / 资源编号这**五**项是**方案**（第⑧步起是「云端配音方案」那一栏 + 小弹窗，和转写、校对同一套 UI，弹窗里那颗「保存」当场写盘；1.1.0 把音色从方案里摘了出去，1.1.1 把「厂商」加进来当作这一档的第一格，1.1.2 把「资源编号」加在最后——只有豆包收它，另三家那一格整个不出现）。哪一组显示由「配音引擎」决定——本地档根本不读厂商、地址、Key、模型、资源编号这五样，所以那一栏在本地档里整个不出现，而不是摆在那儿让人往不生效的框里填 Key。

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 配音引擎 | `ttsEngine`，**全局段**。`cloud`（「云端接口（默认）」）或 `local`（「本地配音（需下载引擎和模型）」）。这一档决定后面走哪条链路，也是 `getTTSConfig().engine` 里那个 `engine`；非法值会被 `normalizeTtsEngine` 收成默认档。**换方案碰不到它**——它不在任何一档方案里，配音页那条下拉也不改它（所以「切了方案结果悄悄花钱／悄悄拉起本机进程」这件事不存在） | `cloud` |
| 厂商 | `ttsProvider`，**属于方案**，1.1.1 起弹窗里的第一格。`openai`（「OpenAI 兼容接口」，默认）／`minimax`／`dashscope`（「阿里云百炼（CosyVoice）」）／`volc`（「豆包（火山引擎）」，1.1.2 起）。它决定这一次配音的请求长什么样——走哪条路径、用哪一套头部鉴权、文本放在请求体哪个键、音频从响应的哪一层取（都在 `ttsVendor.ts` 那张 `VENDOR_SHAPES` 表里），也决定「空音色」是不是一个能出声的答案、以及「配音模型」那一格能不能留空（四家里只有豆包能）。取值时先过 `normalizeTtsVendor`：空串、手改出来的怪值、以及 1.1.0 及更早建出来的方案（磁盘上根本没这一项）一律读成 OpenAI 兼容，**所以这一格不需要迁移**。**换一家会把下面几格一起清空**（`clears: ['ttsApiBase','ttsApiKey','ttsModel','ttsResourceId']`，1.1.1 的 #325 拍板；换回 OpenAI 兼容同样清）——理由不是审美：应用替用户填进去的地址和模型名一旦过时，界面上它就长得像用户自己填的，点「保存」照样落盘，而错误的地址要等请求失败才说话，空格子当场就拦得住。那几格的**灰字举例**按厂商换（`TTS_VENDOR_UI[*].apiBaseExample` / `modelExample`：`https://api.openai.com`+`tts-1`／`https://api.minimax.cn`+`speech-2.8-hd`／`https://dashscope.aliyuncs.com`+`cosyvoice-v3-flash`／`https://openspeech.bytedance.com`+`seed-tts-2.0-standard`），灰字只是举例、不是值，豆包那一格的灰字写的还是「复刻音色才填」那一条而不是替系统音色猜一个 model 名。Key 也在 clears 里，但它只清「手上还没存的那串字」：磁盘上已存的那把仍按「留空＝不改」走，换厂商不该替用户做「抹掉已保存的 Key」那个明确动作 | `openai` |
| API Base URL | `ttsApiBase`，音频接口地址（**属于方案**，弹窗里那格；本地档看不见）。留空＝沿用**校对档「当前使用」那一条**的地址（`getTTSConfig` 里 `normalizeApiBase(ttsApiBase) \|\| normalizeApiBase(aiApiBase)`）；两边都空时退到 `https://api.openai.com`。**这条回落只对 OpenAI 兼容那一档说得通**，MiniMax／百炼／豆包在校对那边一般没有对应的网关，界面那句提示按厂商分叉（回落留着：同一家用两档的人确实能省一次粘贴）。同样走上面那一条三步归一（去尾斜杠 → 认下应用自己会接的那几条尾巴 → 再去一层 `/v1`），再接这一家要走的路径（OpenAI 兼容 `/v1/audio/speech`、MiniMax `/v1/t2a_v2`、百炼 `/api/v1/services/audio/tts/SpeechSynthesizer`、豆包 `/api/v3/tts/unidirectional`）——所以照着 MiniMax 文档把 `https://api.minimax.cn/v1/t2a_v2` 整段粘进这一格也算对（#327 那句 404 是转写和配音两格各自踩出来的，两处都改了）；只填到域名根为止也行——接路径这一处收在 `apiPath.appendApiPath`（四家与「测试连接」共用），它认得「地址末尾已经是 `/api`、路径又以 `/api/` 开头」这一种重复，照阿里云文档粘 `.../api/v1` 不会再拼出 `/api/api/v1/...`，豆包那条 `/api/v3/...` 走的是同一个判断。1.1.1 起还认「已经是端点」这一种：尾巴表没登记过、但归一化后剩两段以上且第一段就是要接的那一条的第一段（`.../v1/别的`），就不再叠一层，打出去的就是你填的那一条；配音报错（真链路与自检共用适配层那一句）会把最终的 `POST <地址>` 念出来，撞 404 时不用猜应用加了什么 | 空 |
| API Key | `ttsApiKey`，可以和校对是**另一家网关的另把 Key**（**属于方案**，弹窗里那格）。留空＝沿用校对那一条的 Key（`ttsApiKey \|\| aiApiKey`）；输入框同样不回显、留空＝不改、点「清除已保存的 Key」再点弹窗里的「保存」才删 | 空 |
| 配音模型 | `ttsModel`，配音用的模型 id（**属于方案**，弹窗里那格；列表那一行的标题优先用它，空着时退回方案名），与校对的「模型」**不是同一个值**：音频接口要的是配音模型，填 chat 模型会被直接拒。**不回落**——留空就是没配，前置校验和「测试连接」都当场说「还没填」，不会拿校对模型去顶上。**1.1.2 起这一项的必填性也看厂商**（`ttsVendorNeedsModel`，与主进程 `VENDOR_SHAPES.modelRequired` 同一份，`tests/ttsVendor.test.ts` 逐家对账）：豆包是四家里唯一能留空的一家，原厂写 `req_params.model`「仅当 speaker 为声音复刻 2.0 的音色时需指定」，用系统音色时留空才对，填了反倒可能被回一个 45000001 InvalidModel；那一格的提示语因此按厂商换成「只有『声音复刻』的音色才需要模型名，用系统音色时留空即可」，而列表那一行显示的常常是方案名。渲染层那道 `checkVoiceReady` 读的是同一张表，所以「界面拦下、主进程放行」这种两头都说不清的失败在这儿不成立 | 空 |
| 资源编号 | `ttsResourceId`，1.1.2 起**属于方案**，弹窗里最后一格，**只有选了豆包才出现**（`visibleWhen: ttsVendorWantsResourceId`，判据与主进程 `TTS_VENDOR_RESOURCE_ID` 那张表同源；另三家请求里没有这一层，摆一格等于让人往没人读的地方填值）。它是豆包 `X-Api-Resource-Id` 那条头，说的是「用哪一版配音服务」，**必须和配音页那个音色同一版**才对得上：系统音色配 `seed-tts-2.0`，声音复刻的音色配 `seed-icl-2.0`。留空按 `seed-tts-2.0` 发（`TTS_VENDOR_RESOURCE_ID.volc`），所以用系统音色的人根本不用碰这一格；配错了对方回的是一句同时提到音色和资源号的 mismatched，看不出是哪一格错，所以那一格的提示语把两种配法都写出来。它不是密钥（`SECRET_FIELDS` 只列三个 `*ApiKey`），按明文留在方案里 | 空（豆包那一档取值时落回 `seed-tts-2.0`） |
| 配音音色 | `ttsVoice`，**全局段**，1.1.0 起这一页没有它的格子（也是从这一刻起它不再属于方案）。各家格式不同（OpenAI 是 `alloy` / `onyx` 这类短名，有的网关要求带模型前缀），能不能填、填什么由服务商决定——所以应用不在设置里摆这一格，也不替你猜一份清单，但把**对方那份清单的网址**挂在配音页那段提示里（`TTS_VENDOR_UI[*].voiceListUrl`：MiniMax、百炼与豆包各一条官网文档地址，OpenAI 兼容没有公开的音色表，那一家就不挂链接；链接只在配音页那一段里出现，设置里没有音色格也就没有可挂的地方），**1.1.2 起配音页那一格自己会长出候选**（#340）：厂商给「列音色」这条接口时（四家里只有 MiniMax 给，判据收在 `ttsVendor.VENDOR_VOICE_LIST_PATH` + `ttsVendorListsVoices`），进配音页／切方案就用这一套方案里那把 Key 现取一份（`POST ${apiBase}/v1/get_voice`，`voice_type=all` 一次问全，15 秒超时），挂成原生 `<datalist>`——边打边筛、键盘上下选，填进格子的仍是音色 id；这个账号自己复刻过的音色也在同一份名单里（那几行右边标着「自己复刻」）。**另三家是刻意不接，不是漏了**，理由逐条写在 `ttsVendor.ts` 那张表头上：百炼那条接口只列你自己复刻的音色（半张表比空表更容易让人以为「系统音色没了」）、豆包的真名单要控制台侧的 AK/SK 而不是这把配音 Key、OpenAI 兼容的规范里没有这一条。取不到名单不是致命错：那一格退回纯手输（本来也只有手输），灰字里把原因原话摆出来并留一条文档链接的出路；这家根本没这条接口时连「没取到」都不说，只挂链接。唯一的入口仍是配音页那一格，它是「这一批听哪一个」，不写回设置。磁盘上这一份的用途是**没在页面上手输时的默认**：`getTTSConfig` 云端档从它取值，「测试连接」在页面没填时也跟着它，于是「自检绿的音色」和「真发出去的音色」还是同一份——**这一句 1.1.1 起只对 OpenAI 兼容成立**，必填那三家改走另一条口径，见下面「自检（云端档）」那一条。旧版填过的值不会因为升级被抹掉；OpenAI 兼容那一档没填过就干脆不发 `voice` 这一项（有的模型不收这一项，填了反被拒）。**1.1.1 起这一项的必填性看厂商**：MiniMax、百炼与豆包把音色列成必填，真配音空着时前置校验当场拦下、不调接口（拦它不是因为应用猜得出音色清单，而是因为这家一定要一个；填什么仍以对方文档为准，填错由接口回原话）；设置里那颗「测试连接」不跟着拦，它按厂商补一个**有出处**的系统音色去敲这一家（见下面「自检（云端档）」那条），补不出来才说「这一页测不了这一家」；整条配音用同一个音色，暂不支持逐段换；**不回落**到校对那套。这一格空着时也不再拿磁盘上那一份 `ttsVoice` 去顶上：`getTTSConfig` 对必填那三家直接投空串——根上那份默认值在本机是 OpenAI 系的 `alloy`，把它发给 MiniMax 只会换回一句「没有这个音色」，而那句读起来像用户把网关配错了。 | 空 |
| 本地模型 | `ttsLocalEngine`，**全局段**，本地档才出现：本地档用哪个引擎，下拉只有白名单里那两档：`VITS（体积小，音色支持少）` / `Kokoro（体积大，音色支持多）`（括号里写的是能核实的差别：模型 135,454,939 B / 5 个音色 vs 426,573,262 B / 103 个音色，不写「推荐中文/推荐英文」那种替引擎定边界的说法）。这个值会被拼进模型目录名，所以渲染层传来的字符串必须先过 `LOCAL_TTS_ENGINES` 白名单，不在名单里就退回默认档——不拿界面传来的字符串当路径用。换这一档会把本地音色复位成默认那一个（两档的音色不通用，VITS 的 3 号不是 Kokoro 的 3 号）——1.1.0 起这一页没有「本地音色」那格了，这一次复位是那个字段在设置里唯一的写入点 | 空（未选过，取值时落回 `sherpa-onnx-vits-zh-ll`） |
| 本地音色 | `ttsLocalVoice`，**全局段**，1.1.0 起这一页也没有它的格子了（音色是配音页那一次任务的事，那一栏在页面上摆一颗「本地音色」下拉等于给用户第二个入口做同一件事）。存的还是 **0-based 的 sid** 字符串，现在的身份是「进配音页时那一格的下发起点」：`getTTSConfig` 本地档经 `normalizeLocalVoice` 读它（空 → `'0'`，而 `alloy` 这种云端残留原样带过去，让校验当场报「音色得是编号」，不悄悄换成 0 让用户以为自己的选择生效了）。这一页它仅剩的写入点是换本地模型时归回 `'0'`（见上一行）。条数取 `LOCAL_TTS_MODEL_SPEAKERS` 那份实测表（VITS 5 个，2026-10-28 本机 `/health` 报的数；Kokoro 103 个，2026-10-29 本机把钉死 sha256 的那份模型直接喂给 sherpa-onnx 2.0.1 实测的），引擎真把模型读进内存后就改认 `/health` 实报的 `num_speakers`——静态表只兜「还没加载」那一段，所以懒启动状态下打开配音页也能一次列全。万一某一档回 0（那是「还不知道」而不是「只有一个」），界面只列得出「音色 1」一行，提示也只说「总数还没报上来」——不给出路、更不凭空造一串编号。界面按「音色 1 … 音色 N」显示（`voiceSidLabel` 做那一格偏移，`'0'` 就是界面上的「音色 1」） | `''`（取值时落回 `'0'`，即界面上的「音色 1」） |

- **为什么地址和 Key 可以共用、模型不行**：前者是「去哪家网关、拿什么身份去」，一家网关通常同时挂着对话和音频两个端点，共用一把 Key 是省事；后者是「要哪个产品」，`gpt-4o-mini` 拿去调 `/v1/audio/speech` 只会得到一个 400。所以回落只回落到会真正干活的那一层。**「厂商」这一项不回落**：它不是「哪家网关」的身份，而是「这次发的请求长什么样」，校对那条的服务商（`aiProvider`）跟配音这一格各说各话，拿它顶上等于让一句没填的配音配置悄悄换一种请求形状。**音色从 1.1.0 起不在方案里，必填性从 1.1.1 起看厂商**：它不是这家网关的参数，而是「这一批听哪一个」——大多数用户并不清楚某个模型支持哪些音色名，把它钉在一条方案上等于要求每个人先读懂各家的文档；各家字段名与取值还互不相同，硬校验就是替用户猜一份清单。所以它只剩配音页那一格，而这一格空着时走的是 `withOverrides` 的 `voice || base.voice`——`base.voice` 按厂商给：OpenAI 兼容那档取磁盘根上那份 `ttsVoice`，有值就发它，那份也空着才干脆不带这一项（页面那句提示按这两情况分叉，1.1.0 真渲染抓到过一处说反的：根上存着 `alloy`，界面却写「留空＝干脆不发」）；必填那三家从 1.1.1 收尾起 `getTTSConfig` 直接投空串，根上那份不再跟着发出去——那是别家的名字。OpenAI 兼容那一档到这一步就结束了：填了又被模型拒了就由接口回的原话送到结果卡上。MiniMax／百炼／豆包把音色列成必填，空着不发这一项只会换来一句「没有这个音色」，所以这三档在**发出去之前**就说清「这一格要填一个」（`ttsVendorNeedsVoice` 一处判断，配音页那两句提示和主进程 `ttsConfigProblem` 都读它；渲染层那道 `checkVoiceReady` 仍然不拦音色，空音色是主进程那一步明确拒绝的，界面拿到的是有名有姓的一句话）——这是给一个有名有姓的原因，不是替用户猜一份音色清单：填什么仍以对方文档为准。
- **旧值迁移**：1.0.5 的字段名是 `aiTtsModel` / `aiTtsVoice`（配音藏在校对 Tab 里）。1.0.6 起读磁盘时把这两个旧值搬进 `ttsModel` / `ttsVoice` 并当场写回，**只在目标值为空时搬**——新值已经填过就保留新值。任何情况都不会把用户填过的配音配置清空，也不会带着旧字段名继续读写。**1.1.0（schema v2→v3）那一步搬的就是音色**：它此前住在每一条配音方案的 `voice` 里，现在整段回到文档根上的全局段。三条规矩——搬「当前使用」那一条（指不到人就用列表第一条，多条方案各带不同音色时按正在用的那条走是唯一不猜的理由）；根上已经有一个字符串就不接管（那是新形状写出来的，比方案里那份新）；只搬字符串，类型不对的不搬也不替它编一个值。**其余方案里的 `voice` 一律删掉**，所以这是本项目里唯一一处会少数据的迁移：非当前那几条各自带的音色值不再留痕，因为新表不认它、没有任何地方读它，留着只是磁盘上一份没人读的残留（不给它兜底，那等于替用户发明一份他没见过、界面也读不出的新结构）。
- **自检（云端档）**：「配音配置 → 测试连接」测的是**磁盘上「当前使用」那一条**已保存的厂商、地址、模型和 Key，外加音色那一份（OpenAI 兼容档取磁盘根上那个 `ttsVoice`，必填那三家按厂商补一个**有出处**的系统音色，下面说），合成一句约 10 个字的文本；弹窗里那些还没点「保存」的字不算，这一档没有「当前使用」那条时这颗按不动（旁边那句按 `testBlockedHint` 分三种原因说）。**厂商也带进这一次自检**（1.1.1）：同一家地址可以长得不一样、请求体更不一样，不带过去就是「当前使用」那条是 MiniMax、自检却按 OpenAI 兼容的端点发——绿了也不作数；渲染层没选过就一直传空串，主进程按 OpenAI 兼容读，与取值那一边同一个落点。地址与 Key 留空时按上面同一口径回落到**校对档当前默认那一条**，所以「自检绿的这一套」和「点开始配音真正用的那一套」是同一套——按别的套绿了等于给用户一张救不了命的合格证。**这一条回落只对 OpenAI 兼容那一档说得通**：MiniMax／百炼／豆包在校对那边通常没有对应的网关，这两格空着多半就是 404/401，所以旁边那句提示按厂商分叉、不再一概而论（回落本身留着——同一家用两档的人确实能省一次粘贴）。音色这一项 1.1.0 起不在弹窗里了。**OpenAI 兼容那一档**的探测按磁盘上那一份走：它是空就干脆不发 `voice`（有的模型不收这一项，硬塞反而得到一个 400），所以那句成功的报告在没音色时写的是「用「tts-1（未指定音色）」合成出 …」，而不是留下一串 `tts-1 · ` 看着像音色被吃了。**必填那三家（MiniMax／百炼／豆包）1.1.1 收尾起不再跟着磁盘那一份，也不再当场拦下**：这一档的音色在设置里根本没有格子（1.1.0 摘掉的），配音页那一格既不写盘、也进不到 `settings:testConnection` 的参数里，于是「拿根上那份 `alloy` 去测 → 拦下 → 提示你去配音页填一个 → 回来再点还是拦下」是一条永远走不通的路，而这条死结正是本轮把 `alloy` 从必填那几家摘掉之后自己造出来的（CDP 真点出来的：那颗按钮对 MiniMax 恒红）。现在补的是**这一家自己那一个有出处**的系统音色——`VENDOR_SHAPES[*].probeVoice` 那一格只收「说得出它是从哪来的」的值：MiniMax 钉 `male-qn-qingse`（2026-11-06 本机真 Key 实测 37428 字节 / 2.232 秒，同一轮里那颗自检按钮 930 毫秒回 41KB）；豆包钉官方 2.0 音色表的第一行 `zh_female_vv_uranus_bigtts`（本机没 Key，按 #224 那句拍板「先照规范设计、之后有 Key 再验」——和留空比它的代价小得多，留空＝那颗按钮对这一家永远不可用，而万一这个音色不在用户账号的权限里，对方回的仍是「音色与资源编号不匹配」，还是一句真诊断）；一个出处都没有的家（百炼）留空，猜一个 id 等于替用户发明一个值，绿了也不作数、红了还让人去改一个应用自己编出来的东西。补来的音色只证明「这一家认这个 id、这条端点能出声」，不证明用户自己填的那个听得到，所以结论里必须点名「这次用的是『这一家的名字』的系统音色「X」（实测能用那一个），设置这一页没有音色格」——那句「实测能用」只在通过那一刻说，而那一次请求刚用这个 id 出过声，所以对豆包也不算替它承诺；成功那一句只算验到地址、Key 和模型；失败那两句也各带一句应用补音色的说明（没出声是「本次的音色「X」是应用补的，不是你填的那一个」，0 字节是「音色「X」是应用补的，这一格在设置里没有入口，不用去配音页找它改」）——不点名就会让人去配音页改一个本来就没错的音色。**资源编号那一格同样会被补**（1.1.2，四家里只有豆包画得出这一格）：留空时发出去的是 `TTS_VENDOR_RESOURCE_ID.volc` 那条 `seed-tts-2.0`，而通过、没出声、0 字节三种结论都附一句「（资源编号「seed-tts-2.0」是这一家的文档默认值，那一格留空时应用发的是它）」——不点名用户就会以为「空着＝不发」，而标准音色配错资源编号（拿 1.0 的音色配 2.0 的编号）恰恰是这一家最常见的失败形状。**百炼是唯一一个 probeVoice 留空的必填家**，它那一格留空时这颗按钮不硬测，回的是「这一页测不了这一家」＋出路：去字幕配音页的「音色」那一格填一个（以对方文档为准）再点「试听」——那一次用的就是这套方案，而试听确实拿得到那一格的值（自检拿不到、试听拿得到，所以这句出路不是假路）。旁边那句提示按这三档分叉（`SettingsModal` 里那三段）：补得到音色的说「自检用应用补的那一个系统音色「X」——验的是地址、Key 和模型这三样」，补不到的说「应用也不替你猜一个没有出处的音色 id，所以这颗按钮测不了这一套，去配音页试听」，OpenAI 兼容那档照旧说「跟磁盘上那一份走」。渲染层 `TTS_VENDOR_UI` 里镜像了同一张 `probeVoice`，`tests/ttsVendor.test.ts` 有一条漂移守卫逐家比对两份表——两边不一致的症状是「界面说这次用应用补的音色，主进程却回『这一页测不了』」。返回 200 却是 JSON、或音频是 0 字节，都算失败并写出原因。**「走云端还是本地」这一格例外地读表单当前值**（不读已保存的 `ttsEngine`）：主进程那边要测的就是你刚选中的那个组合，读已保存设置会测到另一档上去。
- **自检（本地档）**：同一栏里换成两个按钮，问的不是同一件事。「测试连接」不起远程请求，而是**真起本机引擎**并合成一句约 10 字（倍速固定 1，只为验链路），成功报耗时与「几秒、多大」，失败标题是「本地配音跑不通」；缺件那句与「第一次配音时启动失败」弹的是**同一份**（`localTtsEngine.missingComponentsMessage`，自检把会话缓存里的 `binaryInManifest` 传进去，启动那条拿不到就按「还没读过清单」说话）：缺哪样说哪样，只缺模型就不附「另需下载引擎二进制」（那是已经下好的包），另一样已在磁盘上时明说不用重下，并点名「按需组件」里那一行的标题（引擎=「本地配音引擎」，模型=档位那一行，两处名字与 SPECS 标题同一份常量）。引擎那条按本版清单里有没有它分叉：明确没有包时不说「去下载」，给的是换回云端档。音色这一格 1.1.0 起不在设置里了，所以传来的编号为空串时按真配音同一口径落回推荐档 0（**不拦人**——把默认值当「填错」报出去，等于给每个没动过音色的用户一条永远按不动的自检）；非空的怪值（云端残留的 `alloy`）照旧拦，那句是「本地配音的音色要选配音页「音色」里的一项，当前是「X」。设置页从 1.1.0 起没有这一格了，请到配音页那一格重选一个编号」。「重启本地配音引擎」处理端口被上一代占住、启动后秒退这类情况，不用退出应用重开；它**只认磁盘上已保存的那一档**，表单里换了没保存不算（「点保存才生效」的口径在这儿不破例），连点会被合并成一次（两个引擎抢 8010 是更坏的结果）。重启后会再问一次状态，音色列表不靠这一次才齐：`/health` 只在模型真进了内存后才报 `num_speakers`（实测刚重启时仍是 0），而列表那条数来自按 sha256 钉死的那份模型表，引擎实报之后才由实报值覆盖。
- **本地档不许打断正在跑的批次**：一批配音正在逐段合成时点「测试连接」，回的是「现在不能测 / 有一批配音正在逐段合成…」。理由是测试要把引擎换掉，而换掉之后剩下的几十段会全报「没能连上本地配音服务」——花过钱的（云端档）或已经念完的段就白扔了。同一口径也压在「停止本地配音引擎」上（`tts:localStop`）。
- **本地配音的组件不进安装包**：引擎二进制 + 两份模型合计 500MB 以上，而大部分用户根本不用本地配音，所以缺哪个下哪个，入口在「设置 → 关于与更新 → 按需组件」。两条来源分开：引擎二进制认自家 `components-manifest.json`（schema、tag、资产名、sha256 全部收死字符集，清单里 `component` 必须是 `vv-components`，防把别家同类文件指过来），资产从本仓库的 Release 直链取；模型不读清单，由代码钉死上游 commit 与**逐文件**的 bytes + sha256，从 hf-mirror 按文件自取（VITS 钉的是 `sherpa-onnx-vits-zh-ll` 那个 commit 的 17 个文件，合计 135,454,939 字节，界面显示「未安装，下载约 135.5MB」）。落点都在 `userData/components/`，版本记录写 `installed.json`（手工放进目录的那份没有版本记录，`localVersion` 就是 null）。
- **Kokoro 这一档 1.0.7 落地**：指纹表钉上了 `ttsModelUpstream.ts`（`csukuangfj/kokoro-multi-lang-v1_1` @ commit `423bfb9ccd6a66115a76602a9630ffea265ae176`，**375 个文件、426,573,262 字节**——十进制 426.6MB，界面那句「下载约 X MB」读的是这个数；MiB 口径 406.8，本机 `du` 报 408M 是按块取整，第三把尺，别拿它对账），与 VITS 同一条路：应用从 hf-mirror 逐文件自取，不走我们的 Release，也不读清单。表里剔掉了 3 个仓库元文件（`.gitattributes`、`LICENSE`、`README.md`），`espeak-ng-data/` 那 355 个文件整目录都点进表（少一个 lang 文件会不会静默降级没人验过，而「静默念错」比「下得慢」难发现得多），大头是 `model.onnx` 325,561,476 与 `voices.bin` 53,790,720。指纹是 2026-10-29 本机一轮实测生成的，两条独立路子逐个比对：368 个普通 blob 用 `git clone` 拿到内容、自算 git blob sha1（**注意是 `blob <len>\0` + 内容的 SHA-1，不是纯内容的 SHA-1**，写错就直接报「与上游 oid 不一致」）与 tree API 的 `oid` 比，全等；7 个 LFS 文件（model.onnx、voices.bin、三份 lexicon、`espeak-ng-data/cmn_dict`、`espeak-ng-data/ru_dict`）既比了 LFS 指针里的 `oid sha256` 与 `size`，又经 resolve→302→CDN 真下过一遍、校 sha256 与字节数，全等（**这一条要 `-L`**：hf-mirror 302 到 `cas-bridge.xethub.hf.co`，不加 `-L` 只会拿到 1KB 的跳转正文）。装完的落盘目录再走一遍磁盘求和：375 个文件 / 426,573,262 字节，与表逐个相等。
  界面口径随之翻回：`localTtsEngines.ts` 的 `inAppDownload` 两档都是 `true`（下拉里缺件时那句是「（模型还没下载）」，不再是「（本版没有下载包）」，`missingModelHint` 指的路是「设置 → 关于与更新 → 按需组件」），`componentService.ts` 的 Kokoro 那一行补上了 `upstream`，于是那一行有真按钮。sidecar 不用重打（2026-10-28 就验过它认得这个引擎 id）。本机实测：加载后 `num_speakers=103`、`sample_rate=24000`、模型进内存 0.75 秒，所以 `LOCAL_TTS_MODEL_SPEAKERS` 从「还不知道的 0」改成 103，音色下拉在引擎还没起来时就能列全 103 行。两档采样率不同（VITS 16k / Kokoro 24k）不影响拼轨：铺轴前每段都 `aformat` 成 44.1k 单声道 s16（`PCM_CHAIN`），进的是同一条 concat。
  **一处实测到的固有行为**：Kokoro 的英文按词表逐词查，查不到的词**静默跳过**——只往 stderr 写一行 `OOV word skipped`，不报错也不返回失败。实测一段 90 词的真实英文旁白出 27.15 秒声、跳掉 3 个词（`subtitles`、`SRT`、`VTT`）；只给 `lexicon-zh.txt` 时同一句 14 词的英文只剩 0.9 秒（词全跳）；三份 lexicon 一份都不给则引擎直接拒绝（`No lexicon available`，`espeak-ng-data` 顶不上这一层）。这不是回归，`lang` 那一位（c-api.h 叫 "Optional language hint"）实测 `""/zh/en/en-us/cmn` 五种取值行为全同，改它修不掉跳过。所以界面在选了 Kokoro 后多出一行提示（`localTtsEngineCaveat`，配音页与设置页共用这一处口径），说的就是「先试听一句再整段」。手工放的那份照样认：放进 `userData/components/tts-models/kokoro-multi-lang-v1_1/`（目录名就是引擎 id，sidecar 与组件落点用的是同一个函数），那一行会显示「已在组件目录里（无版本记录）」，按钮是「重新下载」。

### 配音（TTS）

- **两档引擎，同一条铺轴链路**：「配音配置 → 配音引擎」= `cloud` 时逐段打远程音频接口；= `local` 时主进程 spawn 一个 `vv-tts-server` sidecar（sherpa-onnx，只绑 `127.0.0.1:8010`，一进程一引擎，引擎 id 在启动时用 `VV_TTS_ENGINE` 钉死），逐段 `POST /synthesize`，body 是 `{ engine, text, sid, speed }`。**除音频那一步之外，两档共用同一套代码**：段落切分、记账、熔断、铺轴、拼轨、另存为、临时目录回收都不分叉——本地档只是把「一次请求」换成「本机念一段」。产物也一样：MP3，同样的结果卡与账目。
- **本地档不花钱，也不上传文稿**：整条链路没有任何远程音频请求（模型下载是另一回事，那是按需组件从 hf-mirror / GitHub 取文件）。界面在点下去之前写的就是这一档的账：「本机合成 N 段（逐段串行，不调接口、不花钱）」，云端那档才写「将调用 N 次接口，按服务商计费」。
- **懒启动与首次成本**：`tts:localStatus` 只读快照，不会因为打开设置页就把引擎拉起来；真开始配音/试听时才 `ensure`。代码里记的实测：冻结包从 spawn 到 `/health` 回显本次身份要 8.07 秒（PyInstaller 解包是大头），模型读进内存再 VITS 0.22 秒、Kokoro 0.86 秒，这两笔都落在第一次 `/synthesize` 里——所以界面明说「第一次配音要多花几秒，之后就快了」，而「就绪」只保证能收请求，不保证已经念得动。应用内重启实测约 16 秒（本机 arm64 打包版，「设置 → 配音配置 → 重启本地配音引擎」）。
- **时长信引擎，不信 ffprobe**：本地档的段时长取 sidecar 自己数的采样数（响应头 `X-Vv-Duration`）。ffprobe 读 mp3 拿到的是容器估算，铺轴不认它——这也是为什么本地档的铺轴比云端档准。真读不出来（sidecar 版本对不上）就按 0 报，调用方按「不知道」处理，与云端同一口径，不做「读不出来就猜一个」。
- **鉴权这一层现在有两套**：OpenAI 兼容／MiniMax／百炼都只要 `Authorization: Bearer <Key>`；豆包（火山引擎）1.1.2 起换成 `X-Api-Key`，外加一条「这一版服务」的资源编号 `X-Api-Resource-Id`（界面留空按 `seed-tts-2.0` 发，那一格填了就用填的）和一条原厂标「必选、推荐随机 UUID」的请求号。整份头部由 `buildSpeechRequest` 一处给，调用方不许在外面补一条——那正是 #220/#227 那种「自检少发一条头」的形状。**要现场算签名的那一类（讯飞）在配音这一侧仍不接**：签名里带 `dateTime`，每趟都得重算，而 `buildSpeechRequest` 一次调用只能产出一份固定形状；1.1.2 只接它转写那一侧（#343）。厂商清单要加长只改三处：`VENDOR_SHAPES`、界面上那个下拉（`TTS_VENDOR_UI`，在 `utils/profileSpec.ts`；换厂商走 `clears` 清空那四格、灰字举例读同一张表，见上面「厂商」那一行）、`normalizeTtsVendor` 的白名单——**渲染层那份表是主进程那张的镜像，不是第二把尺**，两边不一致的症状是「下拉里能选的一家，发出去按 OpenAI 兼容走」。
- **能用什么接口**（云端档）：1.1.2 起是**四家**（1.1.1 是三家），走哪一条由方案里那格「厂商」决定，形状全收在 `ttsVendor.ts`（真合成与「测试连接」共用这两个函数）。**①OpenAI 兼容**（默认，也是磁盘上没有「厂商」那一项时的读法）`POST {apiBase}/v1/audio/speech`，body `{ model, input, response_format: 'mp3' }`（`voice` 只在填了时才带上——空串发过去在一些网关上是「要一个叫空字符串的音色」，报回来的 400 会被当成「这家不支持配音」，而真因只是我们多发了一个字段），返回体直接是音频字节。**②MiniMax** `POST {apiBase}/v1/t2a_v2`，body `{ model, text, stream: false, output_format: 'hex', voice_setting: { voice_id, speed } }`，音频在 `data.audio` 里以**十六进制字符串**回来（按 base64 解会得到一坨长度对得上的垃圾），而且**错误可能带着 HTTP 200 回来**——`base_resp.status_code` 非 0 就是失败，只看状态码等于把失败读成成功。**③阿里云百炼（CosyVoice）** `POST {apiBase}/api/v1/services/audio/tts/SpeechSynthesizer`，body `{ model, input: { text, voice, format, rate } }`——这一家的 HTTP 接口没有 `parameters` 那一层，按 SDK 那套老形状发到 `parameters`，对方不报错、只按默认值回一份 pcm，我们把它落成 `.mp3`，播放器里就只剩「加载失败」；非流式回的是一条**24 小时有效的签名地址**，音频要再发一次 GET 去取，那一次也吃同一个取消信号（否则「取消配音」在最后一跳上失效）。**④豆包（火山引擎）** `POST {apiBase}/api/v3/tts/unidirectional`，body 只有一层 `{ req_params: { audio_params: { format: 'mp3', sample_rate: 24000, speech_rate? }, text?, speaker?, model? } }`——这一家三处都跟别家不一样：**倍速不是倍数而是百分比增量**（原厂三个锚点 0＝原速／100＝2 倍／-50＝0.5 倍，所以界面选 1.5 倍发的是 `speech_rate: 50`，直接把 1.5 发过去等于提速 1.5%）；**`model` 那一格留空时干脆不发**（原厂写它「仅当 speaker 为声音复刻 2.0 的音色时需指定」，枚举只有 standard／expressive 两个，给系统音色带上它回的是 45000001 InvalidModel），这也是四家里唯一「配音模型非必填」的一家；**回包是一行一帧的 NDJSON**（原厂自己的 Python 示例用 `iter_lines` 逐行 parse），音频按 base64 分帧回来，而结论可能写在任何一帧的 `code` 上，所以要把所有帧拼起来再逐帧查错，只看最后一帧会把中途的失败读成一段短音频。四家只在这一层不同：落成 mp3、量时长、铺轴、拼轨、记账都是同一套。**这四家的实测程度不一样**：OpenAI 兼容从 1.0.6 就在真用；**MiniMax 到 1.1.1 收尾这一轮才拿到真 Key 出声**——配音一次合成 37428 字节 / 2.232 秒（`speech-2.8-hd` + `male-qn-qingse`，本机 2026-11-06），转写一次回的是秒级 `segments`（同一条链路、同一把 Key），所以这一家两条腿都验过；在这之前它只发过一次假 Key 的请求，拿到 200 + `base_resp.status_code=1004`，界面弹的是那句原话加一句「模型名与音色 id 都以对方文档为准」——那条只证到「走得到对方、错误读得出来」；**百炼与豆包这两档至今一次真请求都没发过**（手上都没有 Key），只有请求体与响应解析的单测；百炼界面上那句「这一页测不了这一家」因此不是客气话，而是这一档的真状态——它连一个实测过的音色都没有，自检补不出值（豆包按 #224 拍板那条「先照原厂规范设计好、之后有 Key 再验」的口径，自检值取的是官方 2.0 音色清单第一行，所以那一页测得动，只是这一家同样没验过）。所以这四家的对外口径不一样：OpenAI 兼容按「一直在用」说话，MiniMax 按「通了、你自己也能配上」说话，百炼与豆包按「接好了、待你用」说话，界面都不替服务商承诺。状态码那句话也按厂商分叉：404 对 OpenAI 兼容是「这家可能没有这个端点，或 API Base 少/多层路径」，对另外三家是「这一家的接口路径由应用接上——地址填到域名根为止就行；照对方文档粘完整端点也认，那种情况下打的就是上面这一条」（1.1.1 的 #332 起两种填法都认，那句提示不再反过来说「只该填到根」）；401 一律是「Key 不对、已过期，或没有调用该模型的权限」；200 而正文读不出一个 JSON 对象（多半是网关回了一份 HTML 报错页）说的是「API Base URL 那格填错了层级」。返回 JSON 会被当成失败并把 body 前 200 字带进报错（先压成一行：各家的 JSON 常带换行与缩进，原样贴进 toast 会把最有用那半句挤到看不见，「测试连接」那条链路也是这个口径），而不是当成一段空音频。**只做对话的模型服务通常没有音频端点**，能不能配音以服务商文档为准——界面不承诺通用。**配音之外还有一条只给配音页那一格用的接口**（#340）：MiniMax 的 `POST {apiBase}/v1/get_voice`（body `{voice_type:'all'}`，同一把 Bearer），取回来的是这个账号能用的全部音色，挂成音色那格的候选；另三家没有可问的地方（见上面「配音音色」那一行），那一格就退回纯手输。
- **前置校验跟主进程同一口径**：`checkVoiceReady()` 先按「配音引擎」这一档分叉，再查该档真正会坏的那件事。**云端档**先看「配音那把 Key 或校对那把 Key，有没有一把在这台机器上解得开」——两把都指望不上才算没配（解不开的那把会直接说「读不出已保存的 Key」并跳到对应的 Tab），然后**只查配音模型这一样，而这一问 1.1.2 起也看厂商**：模型 1.1.0 起住在方案里，页面上没有那一格可填，所以不存在「界面填全了、设置还空着」的分歧；但四家里只有豆包那一档空着才是对的（`ttsVendorNeedsModel('volc')` 是 false，原厂写 `req_params.model`「仅当 speaker 为声音复刻 2.0 的音色时需指定」，系统音色填了反被回 `45000001 InvalidModel`），在这儿一刀切就是把一个配对了的人拦在门外、而主进程那边根本不拦——判严判松都栽过（#220/#227），所以两边读的是同一张表（`tests/readinessProfiles.test.ts` 里那条回归钉的就是「豆包模型留空不拦人」）。同一张表也决定那句「把哪几格填好」念几样：收模型的三家说「接口地址、API Key 和配音模型」，豆包那一档少一样、只说「接口地址和 API Key」。**音色不在这里查**，空着对 OpenAI 兼容那一档是合法调用（各家字段名与取值都不一样，拦下来等于替用户猜一份清单）；1.1.1 起 MiniMax／百炼、1.1.2 起豆包都不收空音色，但这一问也不写进这道门——它由主进程 `ttsConfigProblem` 在发请求之前拦，界面拿到的是那句指名道姓的原因（「这一家的音色必填」＋一个可照抄的例子），而不是一个 400。**本地档**查引擎二进制与模型在不在场，以及音色是不是一串编号——覆盖值为空时回落设置里那份 `ttsLocalVoice`，而空串经 `normalizeLocalVoice` 就是推荐档 0，所以「没动过音色」不算问题；一串从旧版本带上来的 `alloy` 才算，那句拦下的话不给 `settingsTab`（出路就在配音页那一格，把设置弹到用户脸上反而让他找不到）。界面填的那一份和设置里的那一份按同一条回落链问（与主进程 `withOverrides` 同一写法：空串＝没覆盖），两边口径不一致就会出现「按设置拦下、按界面跑通」这种两头都说不清的失败。缺哪一样都当场拦住、打开对应设置页，不会带着空值去点「开始配音」烧用户额度。**「这一档开不了工」有两种，出路不一样**：一条方案都没建过 → 说去点「新建API接入」并在弹窗里填全；建了几套却没选定 → 说进那一行的「编辑」勾上「当前使用」再点「保存」（`noCurrentProfileMessage`，三档共用，第⑧步之后句子只提弹窗那颗「保存」，不再提右下角）；列表这次没读出来就不编原因，落回那句本来说得通的话。判得比主进程松或严都不行：松了是拿空 `Authorization` 去打接口，紧了会把本来能干活的人拦在门外。
  配音页那条配置行末尾的「（模型还没下载）（现在开跑会被拦下）」从 1.1.0 起**只在本地档说**（`local && !selectedPresent`）：
  它讲的是本机那一档模型的权重不在盘上，而云端档一个字都不读它——1.1.0 CDP 回放时这句话正挂在「配音引擎：云端接口」后面，
  而那次云端调用根本不会因为本地模型缺失被拦，摆在横幅里就是让界面说一句假话。
- **两种输入来源，走的同一条合成链路**：「纯文本」由 `splitPlainText` 按行 → 句末 → 停顿切、贪心合并到每块 ≤800 字，每块一段、时间轴全 0，铺轴因此天然退化成「首尾相接」，主进程不需要为朗读另开一条路；「从转写带入」把当前非空段落原样带走，起点/终点就是字幕时间轴，页面上给的是只读摘要——要改文字得回转写页编辑，配音页不动字幕一个字。
- **计费与耗时**：逐段串行——云端档一段一次请求、按服务商计费方式扣费，本地档一段一次交给本机引擎、不花钱；整条耗时云端档取决于接口响应速度，本地档取决于本机推理（第一次还多了引擎起来 + 模型读进内存那两笔）。左列在点下去之前就把账写清楚：纯文本给「N 字 · 会切成 M 次调用」，从转写带入给「共 K 段可配音，约 X 字」和「另外 n 段是空的，会被跳过、不占用一次合成」，最下面那行按档分叉：云端档「将调用 M 次接口（逐段串行，按服务商计费）」，本地档「本机合成 M 段（逐段串行，不调接口、不花钱）。第一次配音要多花几秒…」，旁边摆「试听第一句」。
- **音色、倍速、本地模型只作用于这一次任务**：工作台上的这三个字段（本地档那一格「配音模型」选的其实是 VITS / Kokoro 哪一档，走 `localEngine`）作为 `tts:preview` / `tts:synthesize` 的第二个参数交给主进程收口（`withOverrides`），**不写回 `settings.json`**——在这一页试错的音色不该变成用户的长期默认值。**云端配音模型 1.1.0 起不在这一格里**：它跟着「配音方案」整套走，界面要换的是整套、不给换单项，所以那一格手输的模型框也删了（下拉里那一行念的就是模型名，旁边再摆一个输入框说的是同一件事，用户只会以为是两件事）。留空＝不覆盖：音色退回磁盘上那一份（云端档＝全局段 `ttsVoice`，本地档＝`ttsLocalVoice` 先过 `normalizeLocalVoice`，`withOverrides` 用 `voice || base.voice`，空串一路当「没覆盖」），本地引擎同理退回 `ttsLocalEngine` 那一份。要长期改这一份默认值，1.1.0 起界面上**没有那个地方**了——两档的音色都只有配音页这一个入口，这是「配置方案是方案、界面里的选项是选项」这条拍板的直接结果。倍速只给固定档位 `0.5 / 0.75 / 1 / 1.25 / 1.5 / 2`（接口字段本是 0.25–4.0 的连续值，让人手打 8 只会得到一条废音轨），并且只在 ≠1 时才进云端请求体的 `speed`。**这一批也没带方案 id**：`callOptions()` 只发 `voice / speed / localEngine` 三个键，因此 `tts:preview` / `tts:synthesize` 收到的 `profileId` 至今是空＝配音档当前默认那条。「云端还是本地」这一档不在可覆盖之列——它决定的是这次要不要花钱、要不要拉起本机进程，而且第⑧步之后它是**全局段**、根本不住在方案里，那条「配音方案」下拉换不动它。某家是不是照单实现由接口说了算，界面把这句话写在按钮旁边，不替服务商承诺。
- **产物是一条独立音轨**：MP3（44.1kHz 单声道、192k）。按字幕时间轴铺开时，某段配音比它的字幕槽位长就顺延到后面，整条往后推——不截断、不做重叠混音，所以**这条轨可能比原时间轴长**。结果卡按来源说人话：从转写带入给「配音轨 00:42 · 体积 / 原时间轴到 00:27，这条比它长（差 00:14）/ n 段配音比字幕槽位长，已顺延到后面——这条轨和画面越到后面差得越多」；**差不足 1 秒时那一格改说「（差不到 1 秒）」**，不写「差 00:00」——整秒那把尺会把实测的 0.11 秒吞成 0，而 00:00 读起来像严丝合缝，这一行的用途恰恰是决定要不要拿这条轨去重铺字幕（详见「注意事项」里「给人看的时钟只有一把尺」那条）；纯文本那一路没有时间轴，就写「纯文本连续朗读，按顺序首尾相接」，不把「相对字幕槽位」的警告套到一个根本不存在的槽位上。两条都照实写明「字幕与时间轴没有改动，这是一条独立的音轨」。越到后面偏差越大，对画面时要以这条轨为准重铺字幕，而不是直接盖在原时间轴上。
- **失败与取消**：连续 3 段失败即熔断停下整批（熔断原因与「用户自己点了取消」分开报），失败清单在结果卡上列出前 3 段的原话（「第 n 段：`failure.error`」，标题是「n 段失败：」），剩下的并成一句「还有 n 段，原因同上一类」；「取消」只停后面的段——正在飞的那一次请求、正在念的那一段都要等它回来，已经合成的照样拼成一条轨。只剩本地拼轨这一步时**界面上没有取消按钮**（主进程那一步也没有取消位，`tts:cancel` 此时回 `late`，绝不回 `success: true`），同一张卡的提示行改说「不再调接口、不再花钱，但也停不下来…等它跑完轨照常给你」，并且**不置「正在取消…」**——置了就等于跟着骗人。一段都没成时不会谎报成功，同一张卡换成失败态：整批停下的原因 + 原话（云端档标题是「接口回的原话：」，本地档是「本机引擎回的原话：」）+「去配音配置测连接」，最后一行按档分开：云端档写「厂商、地址、Key、模型这四样里任何一样不对都长这样；」，后半句按厂商分叉（OpenAI 兼容＝「音色是可选的，填了而这个模型不认，也是这一句」；MiniMax／百炼／豆包＝「『这一家的名字』还不收空音色——没填音色当场就拦下、不调接口，填了但这家不认这个音色也长这样」，名字当场按厂商插进去），本地档写「本地这一档不看地址和 Key；引擎二进制、模型、音色编号三样里任何一样不对，都长这样」。
- **产物只有一份留在用户手上**：中间片段与整轨都写在 `$TMPDIR/transcribe-tts-<uuid>/`，配音页「清空」、重开一批、回首页（且这批已跑完）三条路会当场把整目录删掉；切走 tab 不删——这一版产物在清空或重开之前一直能听，回来还能播。要把它留在自己机器上，必须点「保存配音轨」走系统「另存为」，另存出去的副本跟着目录删不掉。进程被强杀没走到那一步时，由下次启动的临时清扫回收（`transcribe-*` 前缀、mtime 超 24 小时）。
- **本地档应用内实测（2026-10-30，`pnpm dev` 起真应用 + CDP 点界面，不是独立跑的 sidecar）**：补的是两个缺口。一是**整批从未在真字幕时间轴上跑过**——翻盘前账，本地档此前最多到 2 段，而且 `Voice track assembled` 里的 `originalEnd` 一直是 0（那是纯文本那一路，时间轴全 0、铺轴退化成首尾相接），按槽位落点那条分支在段落上没走过；二是 Kokoro 虽然 10-29 就在应用内合成过，但那时那几条 `TTS preview synthesized` **不带档位**，事后只能拿引擎自己那句 `[TTS] Loaded kokoro…` 的时间戳倒推它念的是哪一档（见下面最后一条，这个洞现在堵上了）。下面这些时刻都是 `app.log` 里的 UTC 时间戳，本机墙钟加 8 小时。
  - **Kokoro 试听**：引擎取「按需组件」那份（`userData/components/vv-tts-server/darwin-arm64/vv-tts-server`，盘上 24,438,304 字节，与 v1.0.7 发布资产同一个数）。`Starting engine` 12:52:26.677 → `Engine ready` 12:52:34.193 = **7.52 秒**起来，`/health` 之后那句 `[TTS] Loaded kokoro-multi-lang-v1_1 in 1.10s speakers=103 rate=24000` 落在 12:52:36.309——**ready 之后又过了 2.11 秒模型才进内存**，这正是上面「就绪只保证能收请求」那句的现场版。点「试听第一句」到出声 **11.0 秒**，回 114,788 字节 / 2.39 秒，toast「试听已生成，2.4 秒」。
  - **本地档多段铺轴（从转写带入 12 段真段落）**：`Batch started` 12:52:37.777 → `Voice track assembled` 12:52:45.679 = **7.9 秒念完 12 段**，账目是 `{segments:12, chunks:1, pushedCount:0, estimatedCount:0, trackDuration:58.31, originalEnd:58.42, bytes:1399998}`，失败 0、跳过 0，结果卡「配音轨 00:58 · 1.4MB」。盘上那 12 份 `voice-pcm-NNNN.wav` 逐段 ffprobe 求和 = **27.07 秒配音净时长**，而独立一把尺（本机 Homebrew ffprobe，不是应用内那份）读整轨 = **58.262086 秒** / 1,399,998 字节 / mp3 44.1kHz 单声道 192k——即这条轨里 **31.19 秒是按时轴垫进去的静音**（58.26 − 27.07，占 53.5%）；应用自己报的 58.31 与它差 0.05 秒，是容器估算那把尺的老毛病，与上面「时长信引擎不信 ffprobe」一致。`pushedCount=0` 说 12 段都没溢出各自的字幕槽位，`estimatedCount=0` 说没有一段是空音频。跑完点「清空」，那一批（jobId `1647b730…`）的临时目录当场不在盘上。
  - **端口上有残尸时下一次启动自己收**：另一次把应用 SIGTERM 掉（信号抢在 `before-quit` 那串 await 跑完之前，`stopLocalTtsEngine` 没来得及走完），留下一个仍占着 8010 的 `vv-tts-server`。下一次点试听时 `ensure` 报 `Port answered before spawn, trying to reap it` → `Reaping leftover engine processes {"pids":"48643, 48642"}` → 12:58:13.386 `Starting engine` → 12:58:20.904 `Engine ready`，随后试听正常出声（3.4 秒，首包 11.0 秒）。所以「起不来不必退出应用重开」那句在有残尸的情形也成立，不需要人手去点「重启本地配音引擎」。
- **日志里「这一趟是谁在念」按档分叉**（#283 收尾改的）：`TTS preview synthesized` 与 `Batch started` 这两条此前不分档、一律带 `model: config.model`，于是本地档落盘就是一串 `"model":""`——VITS 和 Kokoro 念出来的东西不一样，这恰是报障时要先排掉的一条，而日志里查无此人。现在本地档回 `"engine":"local","localEngine":"kokoro-multi-lang-v1_1"`（上面那两条实测记录就是这么取到的），云端档照旧报 `model`；云端请求体里那个 `model` 是接口要的字段，跟日志无关，没动。

### 本地词典

- 数据来源：[pwxcoo/chinese-xinhua](https://github.com/pwxcoo/chinese-xinhua)
- 包含词语（ci.json）和成语（idiom.json）释义；「校对配置 → 本地词典」显示当前版本号（内置是 `1.0.0`，更新过后换成源仓库 commit 短哈希）
- 加载优先级：`userData/dictionary/`（更新后的副本）> `resources/dictionary/`（内置）
- **启动那一次读盘只跑一遍**：`initDictionary()` 有两个调用点同时打在启动那几秒里——`main/index.ts` 那串服务初始化，和 `ipc/dictionaryHandlers.ts` 注册通道时自己那一次。判空只看 `dictionaryCache`，而它要等两份 JSON 全解完才赋值，于是后一家进来时什么都是空的、于是 26 万条 ci + 3 万条成语被读进内存两遍。本机 `app.log` 上这是每次启动两行 `Loaded builtin dictionary`、隔 85–96 毫秒（改前一次启动实测两行 12:56:42.350 / .446，改后一次启动只剩一行 13:06:05.636）。现在跟在飞的那次 promise 被另一个调用点共用（与本地配音引擎 `singleFlight` 同一套路），失败后 `initTask` 清空、下一次调用可以重试。
- 更新机制：按 `data/ci.json` 的最近 commit hash 判断有没有新版，有就直接拉 `ci.json` / `idiom.json` 写入 `userData/dictionary/`、清缓存重载，当场生效。连不上 GitHub 会如实报错，不会当成「已是最新」

## 注意事项

- 本地转写跑的是 Python 引擎二进制：打包后由应用自动拉起，开发模式要先生成 `python-asr/dist-<arch>/`（`pnpm setup:asr` + `pnpm build:asr`），详见「快速开始」
- 引擎第一次转写会向 hf-mirror.com 下载所选档位的 Whisper 权重（本机 HF 缓存实测：`base` 的 `model.bin` 138MB、`small` 461MB），弱网时这一步可能超时——那时不是模型坏了，报错会这么说；只有失败事件里带的 `stage` 是 `loading_model` 时才这么报，ffmpeg 抽音频失败会原样带出原因（改之前 JS 只看最后一次 `status` 的阶段，抽音频失败也会被误报成「模型没下完」，把人往错的网络上引）。模型已在本地缓存时改走 `HF_HUB_OFFLINE=1`，不再向镜像站确认版本
- 视频文件播放依赖 `webSecurity: false` 配置，通过 `file://` 协议加载本地文件
- 「校对」不要求 API Key：没配置校对模型时不弹选择框，直接跑本地校对（误听表 + 词库 + 参考稿 diff）；配置了模型才弹「本地校对 / AI 校对」选择框。AI 校对调用失败会给出可见提示，不会静默返回原文
- 本地校对依据的误听表和中文词库只对中文成立：「转写语言」选成其他语言后，没配模型时点「校对」会提示去「校对配置」选模型，配了模型则在选择框里把「本地校对」置灰
- 配音整批是**逐段串行**的：云端档一段一次请求、扣的是用户自己 Key 上的额度，所以点「开始配音」之前先看左列那两行账（字数、「将调用 n 次接口」），并先听「试听第一句」那一句——音色不对时第 2 段和第 20 段一样烧钱。本地档不烧钱，但一段一次本机推理，整批下来照样是分钟级的事，而且第一次配音多了「引擎起来 + 模型读进内存」两笔；组件不在场时「试听第一句」与「开始配音」都会被当场拦住（同一道 checkVoiceReady，按界面当前选的那一档问），toast 点名「按需组件」里该下哪一行、并把设置页开到那一栏——本版清单里没有引擎那条时不给「去下载」，给的是改用云端档
- 本地配音的引擎和模型**都不在安装包里**：全新装机上「配音配置」选本地档，测连接会直接说「本地配音组件还没下载」并指路「设置 → 关于与更新 → 按需组件」，而不是转圈等到超时。所以对外别说「装上就能离线配音」，得先跑那一次下载（引擎二进制从本仓库 Release 取、模型从 hf-mirror 取，弱网这一步可能失败，报错按下载链路原样给）
- 端口 8010 是本地配音引擎的约定端口，只绑 `127.0.0.1`，且**一进程一引擎**（引擎 id 启动时由 `VV_TTS_ENGINE` 钉死）：换档不并起第二个进程，而是 `ensure` 里把上一代收掉再开新的（所以换档=重启，端口上留着的还是那一个）。应用被强杀、上一代还占着 8010 时由「重启本地配音引擎」回收，不必退出重开。这批正在逐段合成时不许测连接也不许停引擎，理由见「配音配置」那条
- 配音轨可能比原时间轴长（有段落被顺延），这是刻意不截断、不重叠的结果。拿这条轨对画面时**以配音轨为准重铺字幕**，别直接盖在原时间轴上；配音页结果卡上那句「n 段配音比字幕槽位长」和「差 00:xx」就是给人判断这件事用的——它们只在「从转写带入」时出现，纯文本连续朗读没有字幕槽位可比
- 编译 Python ASR 二进制需要 PyInstaller，它已列在 `python-asr/requirements.txt` 里（`pnpm setup:asr` 一并装上）；`scripts/build-asr.mjs` 用的是 venv 里的解释器，所以必须先建好虚拟环境
- API Key 的加密时机与退化路径：`settings.json` 里的历史明文在**首次读到设置**时就地换成密文（读到才迁，不是启动就迁——没打开设置页、也没跑过任何读配置的链路时，磁盘上那条仍是明文）；本机密钥库不可用时退回明文并在设置里标注，加密抛错也存明文，而不是把用户填的 Key 丢掉。换过电脑导致密文解不开时，设置里的状态、「测试连接」和开工前置校验给的是同一句「这台机器读不出已保存的 API Key…」，重新填一次并保存即恢复
- **多套配置里只有全局段那几格守「点『保存设置』才生效」**：第⑧步之后**三档是同一套交互**，方案那几格（转写 3 项 / 校对 4 项 / 配音 4 项）全部住在弹窗里，**落盘的是弹窗自己那颗「保存」**（新建走 `settings:createProfile`、编辑走 `settings:save` 只带这一条那几格，那颗「当前使用」勾选跟着同一次点击走），「删除」也当场、撤不回来；右下角那颗「保存设置」写的只剩全局段——转写的「转写模式／本地模型档位／转写语言」和配音的「配音引擎／本地模型」两格，校对一档本来没有全局字段，所以那一页连这颗按钮都不出现。全局段那 7 个键里配音就占 4 个，而 1.1.0 起这一页只剩两格：`ttsLocalVoice` 只在「本地模型」那格的 onChange 里被归回第一个（`SettingsModal` 中该字段唯一的写入点），`ttsVoice` 连表单都不进、界面上没有写它的口子——它是根上那一份**默认音色**，配音页那一格（本地是下拉、云端是手输）只把它当初始值，用户改的那一份作为单次参数发下去（`callOptions().voice`），不写回设置。「保存设置」不再经手任何一档的凭据，也不会被弹窗里那份草稿牵连（草稿不进 `values`）。所以「删掉一套」撤不回来、弹窗里点了「保存」也撤不回来，而面板上那几格输入框里的字仍要等右下角那一次点击。这几层区别各自都写在按钮／字段下面那句提示里（`panelNote` 挂在**列表非空**的每一栏下面，空列表那句换成 `emptyHint`），用户不必自己试才知道
- **`settings.json` 读不出来分两种处置，共同点是「解不开」绝不当成「没填」**（1.0.8 修掉的就是这个：以前半截 JSON 会被静默换成默认值，用户看到的是 Key 全空，下一次保存就把密文盖掉了）：
  - 文件在但**解不开**（半截写入、手改坏）：先把原件改名留成 `settings.json.corrupt-<时间戳>`（改名成功才这么算，最多留最新 5 份，见 `ARCHIVE_KEEP`），再按默认配置继续跑，启动时弹一句说明，「设置 → 本机数据」里另有一个「打开数据目录」按钮——toast 会消失，原件就在那一层，随时可以从那份文件里找回。这时候写盘是安全的，所以不拦。
  - 连**内容都没拿到**（权限、只读介质、`settings.json` 是个目录）：内存里的默认值来自猜测，写下去就是盖掉用户的东西，所以本次禁止落盘（`SETTINGS_WRITE_BLOCKED`），「保存设置」弹的是这句原因而不是成功。闸门只由一次**成功读取**打开：POSIX 上 rename 只需要目录可写，所以「写成功了」并不证明原件变得可读了。
  - 内容非 null 的 JSON 但不是一对象（数组、字符串）走 corrupt 那条；空文件、`null` 也走。首次运行（文件本来就不存在，ENOENT）不算故障，`storageProblem` 为 null，也不会凭空造出一个 `settings.json`
- **`settings.json` 自己声明格式版本**：文件里多了一个 `schemaVersion`（本版写 3），只由写盘那一步盖上，读的时候缺字段就按 v0 走迁移。往下兼容靠 `settingsSchema.ts` 的迁移注册表一条一步搬上来（v0→v1 就是把 1.0.5 之前寄存在校对名下的 `aiTtsModel` / `aiTtsVoice` 搬到 `ttsModel` / `ttsVoice`，搬完无条件删旧键；v1→v2 是 #222 那一步，把**那张表当时认领的那些扁平键**（本版 `CAPABILITY_FIELDS` 是转写 3 项 / 校对 4 项 / 配音 4 项——配音那四项里第一格是 1.1.1 加的「厂商」，共 11 个；1.0.x 的文件里根本没有 `ttsProvider` 这个扁平键，所以这一步搬不出它，那条「默认」方案读出来就是 OpenAI 兼容）按能力拆成 `profiles` + `defaultProfileId` 两段，每档搬出一条名为「默认」、id 钉成 `asr-default` / `ai-default` / `tts-default` 的方案——没被任何一档认领的那 7 个（`asrProvider` / `asrLocalModel` / `asrLanguage` 加配音的 `ttsEngine` / `ttsLocalEngine` / `ttsLocalVoice` / `ttsVoice`）**留在文档根上，一个字节都不动**：它们是全局段，搬进方案就等于把「用不用云端、跑哪个档位」变成某一套凭据的属性，而转写那三项第一轮正是被一起搬进去的，这轮重写推翻的就是它（用例分别钉「全局键照原样留在根上」与「一条方案里不许多出它们」）——密钥**原样搬**（重新封一次会把「能不能解密」变成「换过机器」，界面上就成了「Key 没配」这句不可恢复的谎话）、被认领的扁平键无论搬没搬都删掉（留着是永远没人读的残留）、类型不对的值不搬进方案（那份收口在 settingsService 按默认值补，迁移只管形状）；**v2→v3 是 1.1.0 这一步**，按同一条线把音色从配音方案里摘回根上的 `ttsVoice`（`CAPABILITY_FIELDS.tts` 从此只剩地址 / Key / 模型三项）。**1.1.1 在这三项前面又加了 `provider`，但没有为它升 `schemaVersion`**：那一格只是一个「这一套是哪家」的书签，1.1.0 及更早的文件里它本来就不存在，读出来是空串、按 OpenAI 兼容走，下一次写盘才多出一个键——没有任何值需要搬，也就没有任何一步迁移可走（`settingsSchema.ts` 里 `PROFILE_FIELDS_MOVED_TO_GLOBALS` 那张表收的是 v2 开发中途的几种形状，跟这一格无关）。`liftTtsVoiceToRoot` 守的还是那三条：donor 取「当前使用」那条、指不到人才取列表第一条（多条方案各带不同音色时按正在用的那条走是唯一不猜的理由），根上已经有个字符串就不接管（那是新形状写出来的，比方案里那份新），只搬字符串。其余方案里的 `voice` 一律删掉，所以这一步是全项目**唯一一处会少数据**的迁移——非当前那几条各自的音色值不再留痕；不给它兜底（挂到方案名上、或塞进某条新键）是因为那等于替用户发明一份他没见过、界面也读不出的结构。v2 是 1.0.9 发出去的那份形状，所以这条迁移是真用户升级时一定会走到的一步）；链中间缺一步会被判成「断链」并拦住写盘，而不是跳过那步——跳过等于把一份看不懂的文件当成看懂了。往上不兼容时反过来：**版本比本版高的文件，本版不搬、不改名、不写回，连保存都停用**（`SETTINGS_WRITE_BLOCKED_NEWER_VERSION`），防的是「装了 1.0.9 再回退到 1.0.8」把用户新版里的配置整段抹掉。写坏的版本号（`'1'`、1.5、负数）按 v0 处理：这个方向搬得回来，装成未来版本反而把人卡在写不进去
- **用户数据目录的落点只有一处定义**：`userDataStore.ts` 是全主进程唯一向 Electron 要 userData 根的地方，日志、按需组件、更新下来的 yt-dlp、词库副本、`settings.json` 都从它拼出来，所以「打开数据目录」按钮打开的那一层，确实就是这些文件住的那一层。同一层还给出唯一的原子写（`.tmp`→rename）与读盘结局分类；`installed.json`（按需组件的版本账）也走这个写。仍按自己方式 `writeFile` 的只剩两类：tempDir 里一次性的中间产物（配音逐段的音频、铺轴用的 ffmpeg graph、用完即删的 cookies），以及可重下的词库副本与它的 `version.json`——后者解不开时读的那一头直接回「没有版本」，下次更新覆盖，坏了我不会盖掉用户填的任何东西
- **日志只有一个写入口，脱敏与轮转都长在入口上**（1.0.8 的 #281，`electron/main/services/logger.ts` + `logRedact.ts`）：`'app.log'` 这个字面量在 `electron/` 下只出现在 logger 里（`src/` 里那几处分别是一句给用户看的话和两条注释，都不开写的口，测试因此只扫主进程），落盘的两个口——异步 `write` 与崩溃路径的同步 `errorSync`——都要先过 `compose()`，所以脱敏只有一道闸门且**控制台与文件必然说同一句话**：跑两遍就会不一致，而用户一边截图控制台、一边发回 app.log 时，差的正是最难查的那种问题。三条规则按**字段名**（凭据是含式匹配 `apikey`/`token`/`cookie`/`...key` 收尾等；用户原文是精确匹配 `transcript`/`content`/`text` 这类，所以 `contentLength`、`durationMs` 这些数字照常留着）、**形状**（data URI、`sk-`、`Bearer`、`api_key=` 内联值、签名 URL 的整段 query，以及 POSIX 与 Windows 绝对路径→只留文件名）和**尺寸**（单条字符串 400 字符且**头尾各留一半**——ffprobe 那句报错的关键在尾巴上，只留头等于没记；数组 20 条并带总数、深度 6 层、Buffer 落成字节数）各砍一遍。路径的字符类用的是 `\p{L}\p{N}` 而不是 `[A-Za-z0-9]`：素材是中文文件名，`/Users/daqi/Movies/采访第3期.mp3` 在 ASCII 类下只匹配到 `/Users/daqi/Movies`，替换后盘上写的是 `Movies/采访第3期.mp3`——用户名收掉了，父目录名却跟文件名粘在一起，看着像条相对路径，比整条绝对路径更难认。这是本机 CDP 打进真应用回放才看出来的。轮转是**单文件 5MB、`app.log` 之外留 3 份**（`MAX_LOG_BYTES` / `KEEP_ROTATIONS` 从 logger 导出，测试和这句话都读同一对常量，不会各说一套），最坏占 20MB：按本机实测均值（3,113,607 字节 ÷ 15,946 行 ≈ 195 字节/行）折算，一个 5MB 文件约装得下 2.7 万条，又还发得动。挪不动时（目录只读、旧档被别的进程占着）这一行照写、计数继续累加、**且不补那句「已轮转」的说明**——当成已清空就得再攒满 5MB 才想起来挪，而说那句是撒谎。
  - #284 补的是这一层的**覆盖面**：此前 logger 之外 `electron/` 下还有 40 处裸 `console.*`（`asrServiceManager.ts` 21 处、`dictionaryService.ts` 5、`ipc/asrHandlers.ts` 5、`asr/asrManager.ts` 5、`asr/localASR.ts` 4），既不过脱敏也不落盘，打包后只进终端——用户发回的 app.log 里本地引擎那一段是空白的，另有 4 处把绝对路径直接拼进话里。现在这 40 处全部走 logger，`electron/` 下 `console.*` 的调用只剩 logger 自己的控制台口（`consoleLine` 与 `errorSync` 里那几处打的是 compose 之后的值，init 与写盘失败那几句打的是日志目录自身的路径），由 `tests/logRedact.test.ts` 的第三条结构判据钉住。引擎的 stdout/stderr 还按行分了级（`asrServiceManager.ts` 的 `logSidecarOutput`）：uvicorn 写在自己 stderr 上的 `INFO:` 起停行落 INFO，`ERROR:`、traceback 与 `[ASR] Error:` 落 ERROR，认不出前缀的一律 WARN（宁可吵，不吞）——这是 #236 给本地配音定的同一套规矩。
  - **引擎那几句 `print` 现在按行 flush**（#285，2026-10-30 收尾，接在上一条后面）：#284 把话收进 logger 之后还剩一个限度——引擎自己写 stdout 的那几句到不了盘，或到得很晚。根因在 Python：stdout 接的是管道时按块缓冲，`print` 不带 `flush` 就不往下发，所以 app.log 里落的时刻是「送达」而不是「发生」。改前本机现场：一次 36.40 秒的转写里，`Loading Whisper model`、`Model loaded successfully`、`Transcription completed in 36.40s` 三句的打印时刻隔着几十秒，落盘时间戳却全是同一个 `13:22:31.572`，而发出那句请求的时刻是 `13:09:07.850`（期间引擎没重启，上一条 `Starting Vv Transcribe ASR service` 在 `13:08:54.195`）——隔了 13 分 24 秒、攒成一批发回来。现在 `python-asr/main.py` 与 `python-tts/main.py` 一个口径：只留一扇 stdout 门（模块级 `log()` 里那一句 `print(..., file=sys.stdout, flush=True)`），六处调用点全部改走它。改后同一条链路重测（重启应用、真点界面、`small` 档、同一份 12 段素材）：`Loading Whisper model` 13:40:46.150 → `Model loaded successfully` 13:41:16.379（那 30.2 秒的加载第一次在日志里看得见）→ `Transcription completed in 36.07s` 13:41:22.217，比宿主自己那句 `LocalASR / Transcription completed` 早 1 毫秒；引擎报的 36.07 秒与日志两头相减（46.150→22.217＝36.067 秒）对得上，两把尺说的是同一件事。**这条要重出 ASR 二进制才到用户手上**：本机 `dist-arm64` 已重出并复测，另外两个平台随下一次三平台构建带上，所以这一条不单独触发 CI。判据在 `tests/sidecarStdout.test.ts`：两个 sidecar 目录顶层的 `.py` 里 `print(` 只许出现一次且必须带 `flush=True`；每条 `log()` 都带宿主认得的前缀（`[ASR] ` / `[TTS] `，没前缀会被 `logSidecarOutput` 落成 WARN）；另有一条反向钉住宿主那两处「按前缀分 INFO」的接线还在。旁路注入验过会红：塞一处裸 `print`、再拿掉一条 `log` 的前缀，两条判据各红一条。
- **引擎冻结产物现在在三个平台 job 里各自当场冒烟**（1.0.8 的 #235 路径 A，`tests/engineSmoke.test.ts` + `build.yml` 的 `Smoke engine binaries (${{ matrix.arch }})` 一步）：#223 那轮的数全是 M 系列 arm64 取的，Intel Mac 与 Windows 一直是假设，而这两个平台最容易坏的偏偏是「PyInstaller 把原生库收齐了没有」——这种坏法只在把那台机器上的产物真拉起来的那一刻现形，纯函数测不到，在开发机上跑一遍也证不了。现在每个平台 job 出完 ASR/TTS 二进制就当场跑：拉起 → 断 `/health` 回的是本次下发的 boot_id 与协议号 → **喂一份空模型目录，要的是 503 而不是 500**（`load_engine()` 先 `import sherpa_onnx` 再查文件，所以 503 就是 `onnxruntime` 那层已经加载成功、500 才是漏收，这一分钱下载都不花）→ 断请求未绑定那档引擎回 409、超 2000 字回 413。为此给 ASR 加了 `VV_ASR_PORT`（默认仍 8000，应用那条链路一字未变）：不加就没有一个既不抢用户正在用的引擎、又能当场验的端口。**证不到的两条得说明白**：ASR 的 `faster_whisper` 是懒加载，不跑一次真转写就证不到 torch（那要 138MB 起步的权重，不在 CI 里下）；真出声那一档只在本机已有模型目录时跑（2026-10-30 本机 arm64 实测：Kokoro 出 2.26 秒声用 571ms，RTF 0.253，与 #223 那轮 0.249 同量级；ASR 那份 69MB 的 onefile 产物 17.6 秒才回出 boot_id），CI 里恒为跳过。**2026-10-30 三平台首跑（run `41077577083`，dev `c9071d0`）三个 job 全绿**：Windows x64 / macOS x64(Rosetta) / macOS arm64 都回了 **503 而不是 500**，也就是 `onnxruntime.dll`、`_sherpa_onnx.pyd`、`libonnxruntime` 在这些平台上都被 PyInstaller 收齐了——#235 必测点 1 至此有了正面答案。要说清那轮绿是怎么核实的：`Smoke engine binaries` 这一步本身只会报 success，「六档到底跑没跑」当时是靠 workflow 自己的两道硬闸反证的（`Upload TTS binary` 的 `if-no-files-found: error`，路径式与用例里的 `TTS_BIN` 同一个；以及 `Package Electron app` 里 afterPack 缺 ASR 二进制就直接 throw，`electron-builder.cjs:60-68`）。这条反证现在不再需要靠人推：常开那 4 条里的头一条就是「开关开了必须有产物，否则红」。界面、铺轴与安装包链路照旧靠 Intel Mac / Windows 两台机器上的手工冒烟（路径 B，#235 那 6 条必测），这条绿不等于那 6 条过了。
- **面向用户的体积只有一个算法，且按 1000 进位**（1.0.8 的 #282，`src/utils/formatBytes.ts`）：改之前渲染层有 6 份各自实现——VoiceStudio / UploadStatus / FileUploader / AudioPlayer 按 1024，SettingsModal / ComponentsSection 按 1000，标签却都写 KB/MB。同一个 v1.0.7 引擎（24,438,304 字节）在「设置 → 关于与更新 → 按需组件」里是 24.4MB、在配音页会是 23.3MB，而这一栏的唯一用途就是决定「这次下载要不要下」，用户拿不到任何线索去怀疑这两个数说的是同一件东西。尺选 1000 的理由按能不能核对排序：主进程已经钉死的那几处用户可见体积全按 1000 算（模型体积提示、组件下载与对账文案），`components-manifest.json` 里那份是发布出去的字节数、动不得，macOS 访达从 Big Sur 起也按 1000 显示；代价是 Windows 资源管理器仍按 1024（它把 1024 也叫「MB」），同一个素材两边差 7%——两边不可能同时对上，选跟应用自己那套账一致的一边。现在 `electron/main/services/` 里也有两处 import 它：「测试连接」那句「…KB 音频」和本地配音的模型体积提示，走的是相对路径而不是 `@/`——`vite.config.ts` 里 electron 那几份子构建不继承根 `tsconfig` 的 alias，`tsc` 会过、打包会炸。留在原地的三处不是遗漏：5 条下载失败的文案按 `1e6` 直接算且 `toFixed(0)`（要的是一眼看得出的粗粒度），`logger.ts` 算的是自己那份按 1024 定义的日志上限，`urlDownloader.ts` 里那个同名的 `formatBytes(f: YtdlpFormat)` 排的是码率不是体积。
- **给人看的时钟只有一把尺，且满一小时补小时位**（1.0.8 的 #287 收尾，`src/utils/formatTime.ts`）：改之前渲染层有 3 份**逐字节相同**的实现（AudioPlayer / VoiceStudio / SegmentRow），都只算到分钟、没有小时位——一档 61 分钟的节目在播放器、字幕行、配音结果卡上写成 `62:05`。这个坑本仓其实认过一次：Markdown 导出那条短时码自己补了小时位，注释里就写着「否则一小时的节目会写出 62:05 这种没人认的读数」，只是那一次没回头收这三处界面。现在界面与导出的 Markdown 用同一个函数（用户拿台词稿对字幕行的落点，两边必须是一个数），链接解析回来那张卡的时长也并了进来——它原来是第四套规则（四舍五入到整秒、分钟不补零），于是同一个文件在卡上是 `1:00`、进了播放器是 `00:59`；现在只剩「时长未知」那一句是它自己的话术。没并进来的是字幕文件的 timecode：SRT 的 `00:01:02,500` 与 VTT 的点号分隔由规范说了算，收进界面尺等于「改一次显示口径」就把交付文件写坏，`tests/formatTime.test.ts` 专门钉了它仍是规范格式。尺的取整是 floor 不是四舍五入，代价是不足一秒的余量被抹掉，所以**亚秒差不能套这把尺**：配音结果卡那句「比原时间轴长多少」由调用点自己处理，1 秒以内说「差不到 1 秒」——2026-10-30 那批 12 段实测就是 58.31 对 58.42（`app.log` 的 `Voice track assembled`），两个读数都落进 `00:58`、差却是 0.11 秒，套旧口径会写成「差 00:00」，而这一行的用途恰恰是告诉用户要不要拿这条轨去重铺字幕，`00:00` 读起来像严丝合缝。
- **header 左留白按平台取值**（#282）：`titleBarStyle: 'hiddenInset'` 只在 macOS 上有意义（红绿灯要占头里那一条），可 `padding-left: 108px` 原先是无条件写的——Windows/Linux 上窗口按钮在右边，左边凭空 108px 空隙。现在 `:root` 给 24px（与 `padding-right` 对齐），`:root[data-platform="darwin"]` 给 108px；值由 `src/main.tsx` 写在模块作用域、`createRoot` 之前，来源是 preload 交出的 `process.platform`，跟主进程决定 `hiddenInset` 用的是同一个值（拿不到 preload 时兜底成 `'other'`，走 24px 那条）。本机 CDP 打进真应用实测：mac 上 `.harder_top` 的计算值仍是 108px，把 `<html data-platform>` 临时改成 `win32` 立刻变 24px、改回来又变回 108px。非 mac 那一支在真机上的实际渲染（`hiddenInset` 在无红绿灯的窗口上到底让出多少）仍随 #235 三平台冒烟确认。
- 链接取内容的临时媒体**不是**下完就删：播放器整场都要拿它做逐句回放，删早了链路末尾只会剩一条「文件已被移动」的 toast（这是 1.0.5 修掉的回归）。站点 cookies 在提取出音频后立刻删，媒体留到「下一段素材开工」或「退出应用」；应用被强杀时这两处都走不到，下次启动由 24 小时清扫兜底。所以 /tmp 里短时间内看到上一份素材是正常的，不是泄漏
- 端口 8000 是本机引擎的约定端口。应用不会复用一个「应答者身份不明」的服务，因此手动起的 `python main.py` 不会被采信；反过来，构建或清理时不要用 `pkill -f vv-asr-server` 之类的通配杀进程，容易连别的工作一起打掉
- **出事的时候一定有话**（1.0.8 的崩溃兜底层，`electron/main/services/crashWatch.ts` + `src/components/ErrorBoundary.tsx` + `src/utils/rendererErrorWatch.ts`）：改之前主进程一个 `uncaughtException` / `unhandledRejection` 处理器都没有，而 Node 15+ 对未处理拒绝的默认处置就是结束进程——一处 `.catch` 漏了，整个应用直接消失，连一行日志都不留。现在这两条都装了，`render-process-gone`、`child-process-gone`、主框架 `did-fail-load` 也各自接上（`installCrashWatch` 排在其余初始化之前，因为 `app.whenReady()` 里那几条链路恰恰最容易出一句没接住的异步失败）。三条规矩：日志先落盘再谈界面，且崩溃路径走 `logger.errorSync`——常规日志是异步写的，紧接着弹出的阻塞式对话框会把事件循环按住到用户点掉为止，实测现场就是这么丢的；谁还活着用谁的通道，渲染进程在就推 toast（`app:errorNotice`），没了才弹系统对话框；丢不丢数据由人点头——界面崩了给「重新加载 / 知道了」，主进程异常给「知道了 / 退出应用」，只有点退出才走 `app.quit()`（那才会跑 before-quit 收尾，不给 8000/8010 留残尸），60 秒内真重载满两次就不再给重载按钮、改口让人重启。渲染层那道 `ErrorBoundary` 只接得住渲染期抛错，事件回调和 Promise 里的那部分靠 `rendererErrorWatch`；`ToastContainer` 现在和 `ErrorBoundary` 平级挂在根层（`src/main.tsx`）——它原先在转写页里，也就是 boundary 的子孙，而 boundary 接住抛错是拿 fallback 换掉整个 children，崩的那一刻 toast 容器自己也跟着没了（这是本机 CDP 打进崩溃态查 DOM 才看出来的，不是推的；`rendererErrorWatch` 同理装在模块作用域，不进组件的 effect）
