# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置：本地配音（TTS）sidecar
产物路径：python-tts/dist-<arch>/vv-tts-server (macOS/Linux) 或 vv-tts-server.exe (Windows)

注意：PyInstaller 无法交叉编译，产物架构 = 运行它的 Python 解释器架构。
arm64 venv → arm64 二进制；x64 venv（Rosetta）→ x64 二进制。
site-packages 通过 sysconfig 动态解析，适配任意 venv / Python 版本 / 架构。

模型不在这个包里：sherpa-onnx 的引擎 wheel 只有 9–16MB，模型 129–409MB，
所以模型目录由宿主按需下载后用 VV_TTS_MODEL_DIR 指进来，这里只打代码和原生库。
"""
import glob
import os
import sysconfig

block_cipher = None

# 动态解析当前解释器的 site-packages，避免硬编码 python 版本号与 venv 路径
_SITE_PACKAGES = sysconfig.get_paths()['purelib']
_SHERPA_LIB = os.path.join(_SITE_PACKAGES, 'sherpa_onnx', 'lib')

# 原生库的 glob 模式必须在构建机上求值成「真存在的那些」再交给 PyInstaller：
# 直接往 binaries 里写模式串会硬失败（2026-10-28 本机实测 ERROR: Unable to find
# '.../sherpa_onnx/lib/_sherpa_onnx*.pyd'），而 .pyd/.dll 只在 Windows 构建机上有。
_SHERPA_NATIVE_PATTERNS = (
    '_sherpa_onnx*.so',        # macOS / Linux 的 Python 扩展
    '_sherpa_onnx*.pyd',       # Windows 的 Python 扩展
    'libonnxruntime*.dylib',   # macOS：扩展用 @rpath/libonnxruntime.dylib 链它
    'libonnxruntime*.so',      # Linux
    'onnxruntime*.dll',        # Windows
)
_SHERPA_BINARIES = [
    (path, 'sherpa_onnx/lib')
    for pattern in _SHERPA_NATIVE_PATTERNS
    for path in glob.glob(os.path.join(_SHERPA_LIB, pattern))
]

a = Analysis(
    ['main.py'],
    pathex=[],
    # 显式收 sherpa_onnx/lib 下的原生库。2026-10-28 本机实测：即使不列这条，PyInstaller 的默认
    # 依赖分析也能从 `from sherpa_onnx.lib._sherpa_onnx import ...` 推出扩展并把 29MB 的
    # libonnxruntime.dylib 收进包、把 @rpath 落成解包目录里的软链（pyi-archive_viewer 看过清单，
    # 冻结二进制合成结果与源码运行一致）。列明白是为了不赌分析器，不是因为默认那条不通。
    # 注意 c-api / cxx-api 那两个 dylib 是 sherpa-onnx-cli 用的，Python 扩展不链它们，收了只是白占体积。
    binaries=_SHERPA_BINARIES,
    datas=[],
    hiddenimports=[
        # main.py 里 import sherpa_onnx 写在 load_engine() 函数体内（惰性加载，为了空载时
        # 不把 37MB 原生库拉进内存），列进 hiddenimports 保证这条惰性路径一定被打进包。
        'sherpa_onnx',
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
        'fastapi',
        'pydantic',
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
    name='vv-tts-server',
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
