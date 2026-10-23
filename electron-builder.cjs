const { rmSync, existsSync, openSync, readSync, closeSync, readdirSync, statSync } = require('fs')
const { join } = require('path')

const targetArch = process.env.BUILD_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64')
const asrExeName = process.platform === 'win32' ? 'vv-asr-server.exe' : 'vv-asr-server'
// 上游的 macOS 包是 Universal（arm64+x86_64），所以 macOS 只有一份，目录不按架构分
const ytdlpDir = process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${targetArch}`
const ytdlpExeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'

/** 读取 Mach-O 64 位二进制架构（darwin）；非 Mach-O 返回 null */
function readMachOArch(binPath) {
  const fd = openSync(binPath, 'r')
  const buf = Buffer.alloc(8)
  try {
    readSync(fd, buf, 0, 8, 0)
  } finally {
    closeSync(fd)
  }
  if (buf.readUInt32LE(0) !== 0xfeedfacf) return null
  const cputype = buf.readInt32LE(4)
  if (cputype === 0x0100000c) return 'arm64'
  if (cputype === 0x01000007) return 'x64'
  return null
}

/** 读取 PE 二进制架构（win32）；非 PE 返回 null */
function readPEArch(binPath) {
  const fd = openSync(binPath, 'r')
  try {
    const dos = Buffer.alloc(2)
    readSync(fd, dos, 0, 2, 0)
    if (dos.toString('ascii') !== 'MZ') return null
    const lfanewBuf = Buffer.alloc(4)
    readSync(fd, lfanewBuf, 0, 4, 0x3c)
    const peOffset = lfanewBuf.readInt32LE(0)
    const machineBuf = Buffer.alloc(6)
    readSync(fd, machineBuf, 0, 6, peOffset)
    if (machineBuf.toString('ascii', 0, 4) !== 'PE\u0000\u0000') return null
    const machine = machineBuf.readUInt16LE(4)
    if (machine === 0x8664) return 'x64'
    if (machine === 0xaa64) return 'arm64'
    return null
  } finally {
    closeSync(fd)
  }
}

/** 打包产物里 Resources 目录的位置 */
function resourcesBaseOf(appOutDir, platformName) {
  // darwin：appOutDir 是 .app 的父目录（如 dist/mac-arm64），需再进入 .app/Contents/Resources
  // win32/linux：appOutDir 本身就是 win-unpacked / linux-unpacked，resources 直接在其下
  return platformName === 'darwin'
    ? join(appOutDir, 'Vv Transcribe.app', 'Contents', 'Resources')
    : join(appOutDir, 'resources')
}

/** 校验打包后的 ASR 二进制存在且架构匹配，否则中断构建 */
function verifyASRBinary(appOutDir, platformName) {
  const resourcesBase = resourcesBaseOf(appOutDir, platformName)
  const asrBin = join(resourcesBase, 'python-asr', asrExeName)

  if (!existsSync(asrBin)) {
    throw new Error(
      `[afterPack] 缺少 ${targetArch} 的 ASR 二进制: ${asrBin}\n` +
        `请先构建对应架构的 ASR 产物（python-asr/dist-${targetArch}/）：\n` +
        `  macOS arm64:  pnpm build:asr\n` +
        `  macOS x64:    pnpm build:asr:x64   （需先 pnpm setup:asr:x64）\n` +
        `  Windows x64:  在 Windows 上运行 PyInstaller 输出到 dist-x64`
    )
  }

  const actual = platformName === 'win32' ? readPEArch(asrBin) : readMachOArch(asrBin)
  if (actual && actual !== targetArch) {
    throw new Error(
      `[afterPack] ASR 二进制架构不匹配！期望 ${targetArch}，实际 ${actual}。\n` +
        `产物: ${asrBin}\n` +
        `这会导致目标机器上 "spawn Unknown system error -86"（EBADARCH）。\n` +
        `请重新构建匹配架构的 ASR 产物后重试。`
    )
  }
  console.log(`[afterPack] ASR 二进制校验通过: ${targetArch}${actual ? ` (${actual})` : ''}`)
}

/**
 * 校验内置 yt-dlp 已进包。
 * 缺了不会让应用崩，但「链接转写」会退化成「请先自行安装 yt-dlp」——
 * 那正是这次要消灭的用户门槛，所以宁可构建失败也别悄悄发出去。
 */
function verifyYtDlpBinary(appOutDir, platformName) {
  const ytdlpBin = join(resourcesBaseOf(appOutDir, platformName), 'yt-dlp', ytdlpExeName)
  if (!existsSync(ytdlpBin)) {
    throw new Error(
      `[afterPack] 包内缺少 yt-dlp: ${ytdlpBin}\n` +
        `请先下载对应平台的独立二进制：node scripts/fetch-yt-dlp.mjs --arch=${targetArch}\n` +
        `（GitHub 慢时加 YTDLP_MIRROR=<加速前缀>，产物落在 vendor/yt-dlp/${ytdlpDir}/）`
    )
  }
  console.log(`[afterPack] yt-dlp 已内置: vendor/yt-dlp/${ytdlpDir} → ${ytdlpExeName}`)
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.vv.transcribe',
  productName: 'Vv Transcribe',
  // 不含版本号/空格：保证文件名跨版本稳定，网站可用 /releases/latest/download/<固定名> 永久直链
  artifactName: 'Vv-Transcribe-${os}-${arch}.${ext}',
  mac: {
    target: ['dmg'],
    icon: 'src/assets/mac/logo_1024.png',
    category: 'public.app-category.productivity',
  },
  dmg: {
    writeUpdateInfo: false,
  },
  win: {
    target: ['nsis', 'zip'],
    icon: 'src/assets/win/logo_256.ico',
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'src/assets/linux/logo_512.png',
  },
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    'electron/resources/**/*',
    '!dist/mac/**',
    '!dist/mac-arm64/**',
    '!dist/mac-x64/**',
    '!dist/*.dmg',
    '!dist/*.blockmap',
    '!dist/builder-debug.yml',
    '!dist/latest-mac.yml',
    '!dist/latest.yml',
    '!dist/.DS_Store',
    '!dist/.icon-icns/**',
  ],
  asarUnpack: [
    '**/node_modules/@ffmpeg-installer/darwin-arm64/**',
    '**/node_modules/@ffmpeg-installer/darwin-x64/**',
    '**/node_modules/@ffmpeg-installer/win32-x64/**',
    '**/node_modules/@ffmpeg-installer/linux-x64/**',
    '**/node_modules/@ffprobe-installer/darwin-arm64/**',
    '**/node_modules/@ffprobe-installer/darwin-x64/**',
    '**/node_modules/@ffprobe-installer/win32-x64/**',
    '**/node_modules/@ffprobe-installer/linux-x64/**',
  ],
  extraResources: [
    {
      from: 'electron/resources',
      to: 'resources',
    },
    {
      from: `python-asr/dist-${targetArch}`,
      to: 'python-asr',
      filter: ['vv-asr-server*'],
    },
    {
      // scripts/fetch-yt-dlp.mjs 的产物；不进 files，避免同一份 37MB 在 asar 里再躺一份
      from: `vendor/yt-dlp/${ytdlpDir}`,
      to: 'yt-dlp',
      filter: [ytdlpExeName],
    },
  ],
  afterPack(context) {
    const platformName = context.electronPlatformName // 'darwin' | 'win32' | 'linux'
    const appDir = context.appOutDir

    // 校验 ASR 二进制架构匹配（防止 error -86 / EBADARCH）
    verifyASRBinary(appDir, platformName)
    verifyYtDlpBinary(appDir, platformName)

    const resourcesBase = resourcesBaseOf(appDir, platformName)
    const unpackedModules = join(resourcesBase, 'app.asar.unpacked', 'node_modules')

    // 目标平台需保留的 ffmpeg/ffprobe 子目录，其余平台目录全部删除。
    // darwin-arm64/darwin-x64 是显式依赖，会被装进所有平台的包（Win/Linux 各多约 140MB 无用二进制）。
    const keepDir = platformName === 'darwin' ? `darwin-${targetArch}` : `${platformName}-${targetArch}`
    const platformDirRe = /^(darwin|win32|linux|freebsd)-/

    for (const pkg of ['@ffmpeg-installer', '@ffprobe-installer']) {
      const pkgDir = join(unpackedModules, pkg)
      if (!existsSync(pkgDir)) continue
      for (const entry of readdirSync(pkgDir)) {
        if (entry === keepDir || !platformDirRe.test(entry)) continue
        const removePath = join(pkgDir, entry)
        if (statSync(removePath).isDirectory()) {
          rmSync(removePath, { recursive: true, force: true })
          console.log(`[afterPack] Removed: ${pkg}/${entry}`)
        }
      }
      // 兜底：目标平台二进制必须还在，否则宁可让构建失败也不产出坏包
      if (!existsSync(join(pkgDir, keepDir))) {
        throw new Error(`[afterPack] 剪枝后缺少目标平台二进制: ${pkg}/${keepDir}`)
      }
    }
  },
}

module.exports = config
