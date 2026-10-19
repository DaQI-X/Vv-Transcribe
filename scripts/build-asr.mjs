#!/usr/bin/env node
/**
 * 跨平台 ASR 二进制构建脚本
 *
 * PyInstaller 无法交叉编译：产物架构 = 运行它的 Python 解释器架构。
 * 本脚本根据目标架构选择正确的 venv 与 dist 目录，并在 macOS arm64 主机上
 * 通过 Rosetta（arch -x86_64）构建 x64 产物，最后校验产物架构是否匹配。
 *
 * 用法：
 *   node scripts/build-asr.mjs --arch=arm64   # 本机架构（默认）
 *   node scripts/build-asr.mjs --arch=x64      # arm64 主机经 Rosetta 构建 x64
 *
 * 约定：
 *   - 目标架构 == 主机架构 → 使用 python-asr/venv
 *   - 目标架构 != 主机架构（仅支持 arm64 主机构建 x64）→ 使用 python-asr/venv-x64
 *   - 产物输出到 python-asr/dist-<arch>/，中间文件 build-<arch>/
 */
import { spawnSync } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch as hostArch } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ASR_DIR = join(ROOT, 'python-asr')

function parseArgs() {
  const args = { arch: hostArch }
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--arch=(.+)$/)
    if (m) args.arch = m[1]
  }
  return args
}

function fail(msg) {
  console.error(`\n[build-asr] ERROR: ${msg}\n`)
  process.exit(1)
}

/** 读取 Mach-O 64 位二进制的架构；非 Mach-O 返回 null */
function readMachOArch(binPath) {
  const fd = openSync(binPath, 'r')
  const buf = Buffer.alloc(8)
  try {
    readSync(fd, buf, 0, 8, 0)
  } finally {
    closeSync(fd)
  }
  const magic = buf.readUInt32LE(0)
  if (magic !== 0xfeedfacf) return null // 非 64 位小端 Mach-O
  const cputype = buf.readInt32LE(4)
  if (cputype === 0x0100000c) return 'arm64'
  if (cputype === 0x01000007) return 'x64'
  return `unknown(0x${cputype.toString(16)})`
}

const { arch: targetArch } = parseArgs()

if (targetArch !== 'arm64' && targetArch !== 'x64') {
  fail(`不支持的目标架构: ${targetArch}（仅 arm64 / x64）`)
}

const isCross = targetArch !== hostArch
if (isCross && !(platform === 'darwin' && hostArch === 'arm64' && targetArch === 'x64')) {
  fail(
    `无法在 ${platform}/${hostArch} 主机上交叉构建 ${targetArch}。\n` +
      `PyInstaller 不支持交叉编译，请在目标架构的原生环境（或 CI）中构建。`
  )
}

// venv 选择：本机架构用 venv，跨架构（Rosetta x64）用 venv-x64
const venvName = isCross ? 'venv-x64' : 'venv'
const venvDir = join(ASR_DIR, venvName)
const pythonExe =
  platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')

if (!existsSync(pythonExe)) {
  fail(
    `未找到 ${targetArch} 的 Python 环境: ${pythonExe}\n` +
      (isCross
        ? `请先运行: pnpm setup:asr:x64   （在 Rosetta 下创建 x64 venv 并安装依赖）`
        : `请先运行: pnpm setup:asr       （创建本机 venv 并安装依赖）`)
  )
}

const distDir = join(ASR_DIR, `dist-${targetArch}`)
const workDir = join(ASR_DIR, `build-${targetArch}`)
const exeName = platform === 'win32' ? 'vv-asr-server.exe' : 'vv-asr-server'
const outBin = join(distDir, exeName)

// 清理旧产物，避免残留错误架构的二进制
if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true })

const pyinstallerArgs = [
  '-m',
  'PyInstaller',
  'vv-asr-server.spec',
  '--clean',
  '--noconfirm',
  '--distpath',
  distDir,
  '--workpath',
  workDir,
]

// macOS arm64 主机构建 x64 时，用 Rosetta 强制 x64
const useRosetta = isCross && platform === 'darwin'
const cmd = useRosetta ? 'arch' : pythonExe
const cmdArgs = useRosetta ? ['-x86_64', pythonExe, ...pyinstallerArgs] : pyinstallerArgs

console.log(
  `[build-asr] 目标架构=${targetArch} 主机=${platform}/${hostArch} ` +
    `venv=${venvName} rosetta=${useRosetta}\n` +
    `[build-asr] 输出=${distDir}\n` +
    `[build-asr] 执行: ${cmd} ${cmdArgs.join(' ')}`
)

const result = spawnSync(cmd, cmdArgs, {
  cwd: ASR_DIR,
  stdio: 'inherit',
  env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' },
})

if (result.status !== 0) {
  fail(`PyInstaller 构建失败（退出码 ${result.status}）`)
}

if (!existsSync(outBin)) {
  fail(`构建结束但未找到产物: ${outBin}`)
}

// 校验产物架构（仅 macOS Mach-O 可校验）
if (platform === 'darwin') {
  const actual = readMachOArch(outBin)
  if (actual && actual !== targetArch) {
    fail(
      `产物架构不匹配！期望 ${targetArch}，实际 ${actual}。\n` +
        `${outBin}\n` +
        `请确认 ${venvName} 是用 ${targetArch} 的 Python 创建的。`
    )
  }
  console.log(`[build-asr] 架构校验通过: ${actual}`)
}

console.log(`[build-asr] 完成: ${outBin}`)
