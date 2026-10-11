const { rmSync, existsSync } = require('fs')
const { join } = require('path')

const targetArch = process.env.BUILD_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64')
const excludedArch = targetArch === 'arm64' ? 'x64' : 'arm64'

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
    '**/node_modules/@ffprobe-installer/darwin-arm64/**',
    '**/node_modules/@ffprobe-installer/darwin-x64/**',
  ],
  extraResources: [
    {
      from: 'electron/resources',
      to: 'resources',
    },
    {
      from: 'python-asr/dist',
      to: 'python-asr',
      filter: ['vv-asr-server*'],
    },
  ],
  afterPack(context) {
    const appDir = context.appOutDir
    const unpackedBase = join(appDir, 'Vv Transcribe.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')

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
