/**
 * 文件处理 IPC 处理器
 * 提供文件选择对话框、文件元数据读取、音频提取（FFmpeg）、临时文件清理等功能
 *
 * 注册统一走 guard.ts 的 ipcHandle（#280）。这一档里多数通道本来就有自己的 try/catch，
 * 那些 catch 留着不动——它们要落 logger.serviceError（带 service 与 action 两个字段，比 guard 那行更利于排障）；
 * guard 补的是它们没覆盖的部分：整个函数体之外的注册、catch 自己再抛、以及原先一个 try 都没有的那几条。
 * 失败形状跟着各条通道原有的契约走，不统一改成 `{ error }`：这里 15 个调用点已经按
 * success/canceled/null 三种判法写好，改一种口径就得连着动界面。
 */
import { dialog, shell, BrowserWindow } from 'electron'
import { stat, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { extractAudio, cleanupTemp, probeFile } from '../services/audioProcessor'
import {
  cancelMediaDownload,
  downloadMedia,
  releaseMediaSession,
  resolveMediaUrl,
  saveMediaFileAs,
} from '../services/urlDownloader'
import { extractTextFromFile } from '../services/referenceParser'
import { logger } from '../services/logger'
import { logsDir, userDataRoot } from '../services/userDataStore'
import { failOkError, failSuccessError, ipcHandle } from './guard'

/**
 * 白名单按「FFmpeg 能解 + 媒体行业日常会递过来的文件」两条线取，不是随便列的：
 * AIFF/MP2/AC3 是广电播出与老磁带采集的常见容器，M4V/WMV/TS/M2TS 是网络与摄像机产物，
 * MXF 是摄录卡的标准封装。真正能不能解由 ffprobe 说了算，这里只决定「要不要让用户选到它」。
 */
const AUDIO_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.wma',
  '.aac', '.ac3', '.mp2', '.aif', '.aiff', '.amr',
]
const VIDEO_EXTENSIONS = [
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv',
  '.mpg', '.mpeg', '.3gp', '.ts', '.m2ts', '.mts', '.mxf', '.vob', '.ogv',
]
const ALLOWED_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]

/**
 * 在系统文件管理器里打开一个目录。
 * `shell.openPath()` 不 reject——打不开（目录还没建、权限、找不到 Helper）时它把 resolve 成
 * 一句错误文本，所以只 catch 异常的那版永远返回 success: true，界面也就永远报「已打开」。
 * 这里按它真正的契约判一次，界面才敢拿这个返回值当结论。
 */
async function openInFinder(dir: string, channel: string): Promise<{ success: boolean; error?: string }> {
  try {
    const failure = await shell.openPath(dir)
    if (failure) {
      // openPath 的错误是一句话文本，不是 Error；serviceError 只取 .message，所以包一层再交
      logger.serviceError('FileHandlers', channel, { message: failure })
      return { success: false, error: failure }
    }
    return { success: true }
  } catch (err) {
    logger.serviceError('FileHandlers', channel, err as Error)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerFileHandlers() {
  ipcHandle(
    'dialog:selectFile',
    async () => {
      logger.userAction('Select file dialog opened')
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          {
            name: '音视频文件',
            extensions: ALLOWED_EXTENSIONS.map((ext) => ext.slice(1)),
          },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) {
        logger.userAction('File selection cancelled')
        return null
      }
      logger.userAction('File selected', { name: basename(result.filePaths[0]) })
      return result.filePaths[0]
    },
    // 回 null 与「用户按了取消」是同一个值，界面也就退回「没选文件」那一态。
    // 这里不硬造第三种：弹面板本身失败时，用户看到的只是面板没出来——
    // 原因落在日志的 IPC 那一行，而不是界面上多一句没人能行动的话
    () => null
  )

  ipcHandle(
    'file:getMetadata',
    async (_event, filePath: string) => {
      logger.serviceCall('FileHandlers', 'getMetadata', { name: basename(filePath) })
      try {
        const stats = await stat(filePath)
        const ext = extname(filePath).toLowerCase()
        const metadata = {
          path: filePath,
          name: filePath.split('/').pop() ?? filePath,
          size: stats.size,
          extension: ext,
          type: AUDIO_EXTENSIONS.includes(ext) ? ('audio' as const) : ('video' as const),
          // 拖拽进来的文件绕过了选择框的 filters，白名单由主进程说了算：
          // 渲染层再抄一份扩展名清单，早晚和这里对不上
          supported: ALLOWED_EXTENSIONS.includes(ext),
          lastModified: stats.mtimeMs,
        }
        logger.info('FileHandlers', 'Metadata retrieved', {
          name: metadata.name,
          size: metadata.size,
          type: metadata.type,
          supported: metadata.supported,
        })
        return metadata
      } catch (err) {
        logger.serviceError('FileHandlers', 'getMetadata', err)
        return null
      }
    },
    () => null
  )

  ipcHandle(
    'file:extractAudio',
    async (_event, filePath: string) => {
      logger.userAction('Extract audio started', { name: basename(filePath) })
      try {
        const result = await extractAudio(filePath)
        logger.userAction('Extract audio completed', {
          name: basename(filePath),
          duration: result.metadata.duration,
        })
        return {
          success: true,
          wavPath: result.wavPath,
          tempDir: result.tempDir,
          duration: result.metadata.duration,
        }
      } catch (err) {
        logger.serviceError('FileHandlers', 'extractAudio', err)
        return {
          success: false,
          error: err instanceof Error ? err.message : '音频提取失败',
        }
      }
    },
    failSuccessError
  )

  // 清临时目录这一步原先整个没有兜底：ffmpeg 的中间文件删不掉时会 reject，
  // 而渲染层那边是 `void api.cleanupTemp(...)`，那句错就这样没人接
  // 成功也要回一个值：形状和 failOkError 对齐，界面才敢拿 ok 当结论
  ipcHandle(
    'file:cleanupTemp',
    async (_event, tempDir: string) => {
      logger.debug('FileHandlers', 'Cleanup temp', { tempDir })
      await cleanupTemp(tempDir)
      return { ok: true, error: null }
    },
    failOkError
  )

  ipcHandle(
    'file:probeAudio',
    async (_event, filePath: string) => {
      logger.serviceCall('FileHandlers', 'probeAudio', { name: basename(filePath) })
      try {
        const metadata = await probeFile(filePath)
        logger.info('FileHandlers', 'Probe audio success', metadata)
        return { success: true, metadata }
      } catch (err) {
        logger.serviceError('FileHandlers', 'probeAudio', err)
        return {
          success: false,
          error: err instanceof Error ? err.message : '无法读取音频信息',
        }
      }
    },
    failSuccessError
  )

  /**
   * 链接媒体分两段：先解析出标题/时长/清晰度，再由用户选「转写音频」还是「下载视频」。
   * 拆成两段是因为下载前给不出体积与清晰度就得让用户点「开始转写」，下错了只能重下。
   */
  ipcHandle(
    'file:resolveMedia',
    async (_event, url: string) => {
      logger.userAction('Media resolve started', { url })
      try {
        const result = await resolveMediaUrl(url)
        if (!result.success) logger.serviceError('FileHandlers', 'resolveMedia', new Error(result.error))
        return result
      } catch (err) {
        logger.serviceError('FileHandlers', 'resolveMedia', err)
        return { success: false, error: err instanceof Error ? err.message : '链接解析失败' }
      }
    },
    failSuccessError
  )

  ipcHandle(
    'file:downloadMedia',
    async (
      event,
      payload: { sessionId: string; kind: 'audio' | 'video'; height?: number | null }
    ) => {
      logger.userAction('Media download started', { kind: payload.kind, height: payload.height ?? null })
      const win = BrowserWindow.fromWebContents(event.sender)
      try {
        const result = await downloadMedia(
          payload.sessionId,
          payload.kind === 'audio' ? { kind: 'audio' } : { kind: 'video', height: payload.height ?? null },
          (progress) => {
            if (win && !win.isDestroyed()) win.webContents.send('file:mediaProgress', progress)
          }
        )
        if (result.success) {
          logger.userAction('Media download completed', {
            name: basename(result.filePath ?? ''),
            sizeBytes: result.fileSizeBytes ?? 0,
          })
        } else if (!result.canceled) {
          logger.serviceError('FileHandlers', 'downloadMedia', new Error(result.error))
        }
        return result
      } catch (err) {
        logger.serviceError('FileHandlers', 'downloadMedia', err)
        return { success: false, error: err instanceof Error ? err.message : '下载失败' }
      }
    },
    // canceled 不给：下载是在这里失败的，不是用户停的——界面会把「已取消」那一态收起来
    failSuccessError
  )

  ipcHandle(
    'file:cancelMediaDownload',
    (_event, sessionId: string) => {
      cancelMediaDownload(sessionId)
      return { success: true }
    },
    failSuccessError
  )

  /** 用完必须还：会话目录里是 cookies 和产物，泄漏一次就是几十 MB 到几 GB */
  ipcHandle(
    'file:releaseMediaSession',
    async (_event, sessionId: string) => {
      await releaseMediaSession(sessionId)
      return { success: true }
    },
    failSuccessError
  )

  ipcHandle(
    'file:saveMediaAs',
    async (_event, sessionId: string) => {
      try {
        return await saveMediaFileAs(sessionId)
      } catch (err) {
        logger.serviceError('FileHandlers', 'saveMediaAs', err)
        return { success: false, error: err instanceof Error ? err.message : '保存失败' }
      }
    },
    failSuccessError
  )

  ipcHandle(
    'dialog:selectTextFile',
    async () => {
      logger.userAction('Select text file dialog opened')
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: '参考文稿', extensions: ['txt', 'md', 'srt', 'docx', 'pdf'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) {
        logger.userAction('Text file selection cancelled')
        return null
      }
      logger.userAction('Text file selected', { name: basename(result.filePaths[0]) })
      return result.filePaths[0]
    },
    () => null
  )

  /**
   * 导出文本：走系统「另存为」面板后由主进程写盘。
   * 渲染进程的 blob + <a download> 拿不到取消/失败信号，URL.revokeObjectURL 还可能抢在写盘前把内容释放掉。
   */
  ipcHandle(
    'file:saveText',
    async (_event, payload: { suggestedName: string; content: string }) => {
      const safeName = basename(payload.suggestedName || 'transcript')
      const ext = extname(safeName).slice(1).toLowerCase()
      const result = await dialog.showSaveDialog({
        defaultPath: safeName,
        filters: [{ name: '转写文本', extensions: [ext || 'txt'] }],
      })
      if (result.canceled || !result.filePath) {
        logger.userAction('Export cancelled', { name: safeName })
        return { success: false, canceled: true }
      }

      try {
        await writeFile(result.filePath, payload.content, 'utf-8')
        logger.info('FileHandlers', 'Export completed', {
          name: basename(result.filePath),
          size: payload.content.length,
        })
        return { success: true, name: basename(result.filePath) }
      } catch (err) {
        logger.serviceError('FileHandlers', 'saveText', err)
        return {
          success: false,
          error: err instanceof Error ? err.message : '写入文件失败',
        }
      }
    },
    // 这里不记 payload：那里面是用户的整份文稿。canceled 不给 true——
    // 导出没做成不是用户按了取消，界面会把「已取消」和「写不进去」说成两句话
    (message) => ({ success: false, canceled: false, error: message })
  )

  ipcHandle(
    'file:readTextFile',
    async (_event, filePath: string) => {
      logger.serviceCall('FileHandlers', 'readTextFile', { name: basename(filePath) })
      try {
        const content = await extractTextFromFile(filePath)
        logger.info('FileHandlers', 'Text file read', { name: basename(filePath), size: content?.length ?? 0 })
        return content
      } catch (err) {
        logger.serviceError('FileHandlers', 'readTextFile', err)
        return null
      }
    },
    () => null
  )

  ipcHandle(
    'app:openLogDirectory',
    () => {
      const logDir = logsDir()
      logger.userAction('Opening log directory', { path: logDir })
      return openInFinder(logDir, 'openLogDirectory')
    },
    failSuccessError
  )

  // 设置读不出来时，界面唯一的「自己看一眼原件」入口：corrupt 留档那份、.bak 那份都住在这里
  ipcHandle(
    'app:openUserDataDirectory',
    () => {
      logger.userAction('Opening user data directory')
      return openInFinder(userDataRoot(), 'openUserDataDirectory')
    },
    failSuccessError
  )
}
