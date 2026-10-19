const { rmSync, existsSync, openSync, readSync, closeSync } = require('fs')
const { join } = require('path')

const targetArch = process.env.BUILD_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64')
const excludedArch = targetArch === 'arm64' ? 'x64' : 'arm64'
const asrExeName = process.platform === 'win32' ? 'vv-asr-server.exe' : 'vv-asr-server'

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

/** 校验打包后的 ASR 二进制存在且架构匹配，否则中断构建 */
function verifyASRBinary(appOutDir, platformName) {
  // darwin：appOutDir 是 .app 的父目录（如 dist/mac-arm64），需再进入 .app/Contents/Resources
  // win32/linux：appOutDir 本身就是 win-unpacked / linux-unpacked，resources 直接在其下
  const resourcesBase =
    platformName === 'darwin'
      ? join(appOutDir, 'Vv Transcribe.app', 'Contents', 'Resources')
      : join(appOutDir, 'resources')
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

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.vv.transcribe',
  productName: 'Vv Transcribe',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
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
    '!**/node_modules/onnxruntime-node/bin/napi-v3/linux/**',
    '!**/node_modules/onnxruntime-node/bin/napi-v3/win32/**',
  ],
  asarUnpack: [
    '**/node_modules/onnxruntime-node/bin/napi-v3/darwin/**',
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
  ],
  afterPack(context) {
    const appDir = context.appOutDir
    const unpackedBase = join(appDir, 'Vv Transcribe.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')

    // 校验 ASR 二进制架构匹配（防止 error -86 / EBADARCH）
    verifyASRBinary(appDir, context.electronPlatformName)

    const targets = [
      { dir: '@ffmpeg-installer', keep: `darwin-${targetArch}`, remove: `darwin-${excludedArch}` },
      { dir: '@ffprobe-installer', keep: `darwin-${targetArch}`, remove: `darwin-${excludedArch}` },
      { dir: 'onnxruntime-node/bin/napi-v3/darwin', keep: targetArch, remove: excludedArch },
    ]

    for (const t of targets) {
      const removePath = join(unpackedBase, t.dir, t.remove)
      if (existsSync(removePath)) {
        rmSync(removePath, { recursive: true, force: true })
        console.log(`[afterPack] Removed: ${removePath}`)
      }
    }
  },
}

module.exports = config
