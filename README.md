# Vv Transcribe

一款基于 Electron 的桌面端音视频转写应用，支持本地/云端 ASR 语音识别、AI 智能纠错（集成中文词典）、段落级播放同步和多格式导出。

## 功能特性

- **音视频文件上传**：支持拖拽/点击上传，兼容 MP3/WAV/M4A/FLAC/MP4/MKV/AVI/MOV/WebM/FLV 等格式
- **ASR 语音转写**：云端优先（OpenAI Whisper API）、本地兜底（Python faster-whisper），自动降级
- **AI 智能纠错**：集成开源中文词库（chinese-xinhua），在 AI 纠错前注入词典释义，提升用词准确性
- **音视频播放器**：播放/暂停、进度拖拽 seek、段落高亮同步，视频文件内嵌播放
- **段落编辑器**：行内编辑转写文本，点击段落跳转到对应播放时间
- **多格式导出**：SRT 字幕 / 纯文本 TXT / JSON 数据 / Markdown 文档
- **设置持久化**：ASR 和 AI 配置项持久化到本地，支持本地/云端转写模式切换
- **词典更新**：内置开源词库，支持从 GitHub 远程检查更新并下载

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 44 |
| 前端框架 | React 19 + TypeScript 6 |
| 构建工具 | Vite 8 + vite-plugin-electron |
| UI 组件库 | Ant Design 6 + @ant-design/icons |
| 状态管理 | Zustand 5 |
| 路由 | React Router 7（HashRouter） |
| 音频处理 | FFmpeg（fluent-ffmpeg + @ffmpeg-installer） |
| ASR 转写 | Python faster-whisper（本地）/ OpenAI Whisper API（云端） |
| AI 纠错 | OpenAI 兼容接口（OpenAI / DeepSeek / 通义千问） |
| 中文词典 | pwxcoo/chinese-xinhua 开源词库 |

## 项目结构

```
basic_one/
├── electron/                          # Electron 主进程
│   ├── main/
│   │   ├── index.ts                   # 主进程入口：创建窗口、注册 IPC
│   │   ├── ipc/                       # IPC 处理器层
│   │   │   ├── index.ts               #   注册中心，统一注册所有处理器
│   │   │   ├── fileHandlers.ts        #   文件操作：选择、元数据、音频提取、清理
│   │   │   ├── asrHandlers.ts         #   ASR 转写：任务管理、进度推送、取消
│   │   │   ├── aiHandlers.ts          #   AI 纠错：读取配置、调用纠错接口
│   │   │   ├── settingsHandlers.ts    #   设置：读取/保存配置
│   │   │   └── dictionaryHandlers.ts  #   词典：查询、版本检查、更新下载
│   │   └── services/                  # 业务服务层
│   │       ├── audioProcessor.ts      #   FFmpeg 音频处理（提取/探测/清理）
│   │       ├── asrServiceManager.ts   #   Python ASR 子进程管理（启动/健康检查/关闭）
│   │       ├── settingsService.ts     #   设置持久化（JSON 文件 + 内存缓存）
│   │       ├── dictionaryService.ts   #   中文词典服务（加载/查询/更新）
│   │       ├── asr/                   #   ASR 转写模块
│   │       │   ├── types.ts           #     类型定义（Segment/Progress/Provider）
│   │       │   ├── asrManager.ts      #     转写管理器（云端优先→本地兜底）
│   │       │   ├── cloudASR.ts        #     云端 ASR（OpenAI Whisper API）
│   │       │   └── localASR.ts        #     本地 ASR（调用 Python 服务）
│   │       └── ai/                    #   AI 纠错模块
│   │           ├── types.ts           #     AI Provider 接口定义
│   │           └── openaiCompatible.ts #    OpenAI 兼容纠错实现（含词典注入）
│   ├── preload/
│   │   ├── index.ts                   # Preload 脚本：contextBridge 暴露 IPC 接口
│   │   └── index.d.ts                 # ElectronAPI 类型声明
│   └── resources/
│       └── dictionary/                # 内置词典资源（打包时复制到 resources/）
│           ├── ci.json                #   词语数据
│           ├── idiom.json             #   成语数据
│           └── version.json           #   版本信息（commit hash）
│
├── src/                               # React 渲染进程
│   ├── main.tsx                       # 渲染进程入口
│   ├── index.css                      # 全局样式
│   ├── router/
│   │   └── index.tsx                  # HashRouter 路由配置
│   ├── pages/
│   │   └── Transcription.tsx          # 转写主页面（上传/状态/结果三态切换）
│   ├── components/
│   │   ├── transcription/
│   │   │   ├── FileUploader.tsx       #   文件上传（拖拽 + 点击）
│   │   │   ├── UploadStatus.tsx       #   处理状态展示（上传中/转写中/失败）
│   │   │   ├── AudioPlayer.tsx        #   音视频播放器（波形可视化 + 段落同步）
│   │   │   ├── TranscriptEditor.tsx   #   转写编辑器（编辑/AI纠错/导出）
│   │   │   └── SegmentRow.tsx         #   段落行（时间戳 + 可编辑文本）
│   │   └── settings/
│   │       └── SettingsModal.tsx      #   设置弹窗（转写配置 / 纠错配置）
│   ├── stores/
│   │   ├── useTranscriptionStore.ts   # 转写状态（文件/进度/段落/错误）
│   │   └── usePlayerStore.ts          # 播放器状态（播放/时间/倍速/高亮）
│   ├── hooks/
│   │   └── useElectronAPI.ts          # Electron API 安全获取
│   ├── types/
│   │   └── transcription.ts           # 前端类型定义
│   └── utils/
│       └── exportTranscript.ts        # 导出工具（SRT/TXT/JSON/MD）
│
├── python-asr/                        # Python ASR 本地转写服务
│   ├── main.py                        # FastAPI 服务入口（faster-whisper）
│   ├── vv-asr-server.spec             # PyInstaller 打包配置
│   ├── requirements.txt               # Python 依赖清单
│   └── venv/                          # Python 虚拟环境
│
├── vite.config.ts                     # Vite + Electron 构建配置
├── tsconfig.json                      # TypeScript 配置
├── package.json                       # 依赖与脚本
└── README.md
```

## 架构设计

### 进程模型

```
┌─────────────────────────────────────────────────────────┐
│                    Electron 主进程                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ 文件处理  │  │ ASR 管理  │  │ AI 纠错  │  │ 词典服务 │ │
│  │ IPC      │  │ IPC      │  │ IPC      │  │ IPC     │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │              │              │      │
│  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐  ┌────┴────┐ │
│  │ FFmpeg   │  │ 云端/本地 │  │ OpenAI   │  │ 词库    │ │
│  │ 音频处理  │  │ ASR 引擎  │  │ 兼容接口 │  │ 查询    │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                                                         │
│  Preload (contextBridge) ← IPC 安全桥接                  │
└────────────────────────┬────────────────────────────────┘
                         │ window.electronAPI
┌────────────────────────┴────────────────────────────────┐
│                    React 渲染进程                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ 文件上传  │  │ 播放器   │  │ 编辑器   │  │ 设置    │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│  ┌──────────────────────┐  ┌──────────────────────┐     │
│  │ TranscriptionStore   │  │ PlayerStore          │     │
│  │ (Zustand)            │  │ (Zustand)            │     │
│  └──────────────────────┘  └──────────────────────┘     │
└─────────────────────────────────────────────────────────┘
                         │ HTTP (localhost:8000)
┌────────────────────────┴────────────────────────────────┐
│              Python ASR 服务（独立进程）                   │
│  FastAPI + faster-whisper (Whisper base, int8, CPU)      │
└─────────────────────────────────────────────────────────┘
```

### 数据流

```
用户拖拽/选择文件
  → FileUploader → IPC file:getMetadata → 获取文件元数据
  → IPC asr:start → 创建转写任务
    → audioProcessor.extractAudio() → FFmpeg 转 16kHz WAV
    → asrManager.runTranscription()
      → [云端] CloudASRProvider → OpenAI Whisper API
      → [本地] LocalASRProvider → Python ASR 服务
    → IPC asr:progress → 实时推送进度和段落
  → TranscriptionStore 更新状态
  → 转写完成 → 展示播放器 + 编辑器

AI 纠错流程：
  TranscriptEditor → IPC ai:correct
    → 提取中文词汇 → 查询本地词典
    → 注入词典释义到 prompt → 调用 AI 接口
    → 返回纠错结果 + Diff 对比
```

### IPC 通道一览

| 通道 | 方向 | 说明 |
|------|------|------|
| `dialog:selectFile` | 渲染 → 主 | 打开文件选择对话框 |
| `file:getMetadata` | 渲染 → 主 | 获取文件元数据 |
| `file:extractAudio` | 渲染 → 主 | 提取音频为 WAV |
| `file:cleanupTemp` | 渲染 → 主 | 清理临时文件 |
| `file:probeAudio` | 渲染 → 主 | 探测音频信息 |
| `file:saveText` | 渲染 → 主 | 系统「另存为」面板导出转写文本 |
| `asr:start` | 渲染 → 主 | 启动转写任务 |
| `asr:cancel` | 渲染 → 主 | 取消转写任务 |
| `asr:progress` | 主 → 渲染 | 推送转写进度和段落 |
| `ai:correct` | 渲染 → 主 | AI 文本纠错 |
| `settings:get` | 渲染 → 主 | 读取设置 |
| `settings:save` | 渲染 → 主 | 保存设置 |
| `dictionary:lookup` | 渲染 → 主 | 查询单个词 |
| `dictionary:lookupMultiple` | 渲染 → 主 | 批量查询词汇 |
| `dictionary:checkUpdate` | 渲染 → 主 | 检查词典更新 |
| `dictionary:downloadUpdate` | 渲染 → 主 | 下载词典更新 |
| `dictionary:getVersion` | 渲染 → 主 | 获取词典版本 |

## 快速开始

### 环境要求

- Node.js >= 18
- Python 3.10+（本地 ASR 转写需要）
- pnpm（推荐）

### 安装依赖

```bash
# 安装前端依赖
pnpm install

# 安装 Python ASR 依赖
cd python-asr
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install faster-whisper fastapi uvicorn pydantic numpy
```

### 开发模式

```bash
# 终端 1：启动 Python ASR 服务（本地转写需要）
cd python-asr && source venv/bin/activate && python main.py

# 终端 2：启动 Electron 开发服务
pnpm dev
```

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

`build:electron*` 第一步会执行 `scripts/fetch-yt-dlp.mjs`：按平台拉官方独立二进制并校验 SHA2-256，落在 `vendor/yt-dlp/`（已 gitignore，同版本重复构建会跳过下载）。GitHub 慢就换前缀：`YTDLP_MIRROR=https://<加速域名> pnpm build:mac:arm64`。`afterPack` 同样校验它是否进了包，缺了就红。

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
- 如果端口 8000 已被占用（用户手动启动了服务），则跳过自动启动
- 应用退出时自动发送 SIGTERM 优雅关闭 ASR 子进程

## 配置说明

### 转写配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 转写模式 | `local`（本地）/ `cloud`（云端） | `local` |
| API Base URL | 云端 ASR 接口地址 | 空 |
| API Key | 云端 ASR 密钥 | 空 |
| 模型 | ASR 模型名称 | 空（默认 whisper-1） |

- **只有「转写模式 = 云端优先」且填了云端 API Key，音频才会发出本机。** 默认的本地模式不发起任何网络转写请求；AI 纠错的 Key 只处理文本，不会上传音视频。
- 本地转写依赖内置的 Python ASR 服务（打包后自动拉起，开发模式需手动启动，见「快速开始」）。引擎未能启动时，转写会直接给出原因而不是 `fetch failed`。

### 链接转写

链接解析用的 **yt-dlp** 已随安装包内置（构建时由 `scripts/fetch-yt-dlp.mjs` 拉官方独立二进制并校验 SHA2-256），使用者不需要再自行安装。应用按下面的顺序取第一个存在的路径：

1. `<userData>/bin/yt-dlp[.exe]` —— 应用内更新写下的副本
2. 安装包内置：`Contents/Resources/yt-dlp/yt-dlp`（Windows 为 `resources/yt-dlp/yt-dlp.exe`）；开发模式取仓库里的 `vendor/yt-dlp/<平台目录>/`
3. 本机安装的 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`（仅 macOS）
4. PATH 上的 `yt-dlp`；全都找不到时，链接转写会提示上面的安装命令

内置包是官方 standalone 构建，自带 `curl_cffi`，所以 `--impersonate chrome`（TLS 指纹模拟）默认可用；第 3/4 档命中的 Homebrew 版本通常没有它，应用会探测后自动降级为不带浏览器模拟的请求。
部分带风控的站点还需要浏览器 cookies 才能解析，应用会先用无头浏览器取 cookies 再重试。

### AI 纠错配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 服务商 | OpenAI / DeepSeek / 通义千问 / 自定义 | `openai` |
| API Base URL | AI 接口地址 | 空 |
| API Key | AI 密钥 | 空 |
| 模型 | AI 模型名称 | 空（默认 gpt-4o-mini） |

### 本地词典

- 数据来源：[pwxcoo/chinese-xinhua](https://github.com/pwxcoo/chinese-xinhua)
- 包含词语（ci.json）和成语（idiom.json）释义
- 内置于应用资源目录，支持从 GitHub 远程更新
- 更新机制：通过 GitHub API 对比 commit hash 判断是否有新版本

## 注意事项

- 开发模式下需手动启动 Python ASR 服务（`python-asr/main.py`），打包后的应用会自动启动内置的 ASR 二进制文件
- 首次运行 Python ASR 服务时会自动下载 Whisper 模型（约 150MB），使用 hf-mirror.com 镜像
- 视频文件播放依赖 `webSecurity: false` 配置，通过 `file://` 协议加载本地文件
- AI 纠错需要配置有效的 API Key；未配置时点击纠错会直接弹出提示，不会静默返回原文
- 编译 Python ASR 二进制需要先安装 PyInstaller（`pip install pyinstaller`），并在激活的虚拟环境中执行
# Vv-Transcribe
