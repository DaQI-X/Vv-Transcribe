# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置
将 Python ASR 服务编译为独立可执行文件，供 Electron 打包应用调用
产物路径：python-asr/dist-<arch>/vv-asr-server (macOS/Linux) 或 vv-asr-server.exe (Windows)

注意：PyInstaller 无法交叉编译，产物架构 = 运行它的 Python 解释器架构。
arm64 venv → arm64 二进制；x64 venv（Rosetta）→ x64 二进制。
site-packages 通过 sysconfig 动态解析，适配任意 venv / Python 版本 / 架构。
"""
import os
import sysconfig

block_cipher = None

# 动态解析当前解释器的 site-packages，避免硬编码 python 版本号与 venv 路径
_SITE_PACKAGES = sysconfig.get_paths()['purelib']
_FASTER_WHISPER_ASSETS = os.path.join(_SITE_PACKAGES, 'faster_whisper', 'assets')

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        (_FASTER_WHISPER_ASSETS, 'faster_whisper/assets'),
    ],
    hiddenimports=[
        'faster_whisper',
        'ctranslate2',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'h11',
        'httptools',
        'websockets',
        'fastapi',
        'pydantic',
        'numpy',
        'tokenizers',
        'onnxruntime',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='vv-asr-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
