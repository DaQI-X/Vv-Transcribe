/**
 * 文件处理 IPC 处理器
 * 提供文件选择对话框、文件元数据读取、音频提取（FFmpeg）、临时文件清理等功能
 * 支持格式：MP3/WAV/M4A/FLAC/OGG/WMA/MP4/MKV/AVI/MOV/WebM/FLV
 */
import { ipcMain, dialog } from 'electron'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { extractAudio, cleanupTemp, probeFile } from '../services/audioProcessor'
import { downloadFromUrl } from '../services/urlDownloader'
import { extractTextFromFile } from '../services/referenceParser'
import { logger } from '../services/logger'

const ALLOWED_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.wma',
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv',
]

export function registerFileHandlers() {
  ipcMain.handle('dialog:selectFile', async () => {
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
    logger.userAction('File selected', { path: result.filePaths[0] })
    return result.filePaths[0]
  })

  ipcMain.handle('file:getMetadata', async (_event, filePath: string) => {
    logger.serviceCall('FileHandlers', 'getMetadata', { filePath })
    try {
      const stats = await stat(filePath)
      const ext = extname(filePath).toLowerCase()
      const isAudio = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.wma'].includes(ext)
      const metadata = {
        path: filePath,
        name: filePath.split('/').pop() ?? filePath,
        size: stats.size,
        extension: ext,
        type: isAudio ? 'audio' as const : 'video' as const,
        lastModified: stats.mtimeMs,
      }
      logger.info('FileHandlers', 'Metadata retrieved', metadata)
      return metadata
    } catch (err) {
      logger.serviceError('FileHandlers', 'getMetadata', err)
      return null
    }
  })

  ipcMain.handle('file:extractAudio', async (_event, filePath: string) => {
    logger.userAction('Extract audio started', { filePath })
    try {
      const result = await extractAudio(filePath)
      logger.userAction('Extract audio completed', {
        filePath,
        duration: result.metadata.duration,
        wavPath: result.wavPath,
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
  })

  ipcMain.handle('file:cleanupTemp', async (_event, tempDir: string) => {
    logger.debug('FileHandlers', 'Cleanup temp', { tempDir })
    await cleanupTemp(tempDir)
  })

  ipcMain.handle('file:probeAudio', async (_event, filePath: string) => {
    logger.serviceCall('FileHandlers', 'probeAudio', { filePath })
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
  })

  ipcMain.handle('file:downloadFromUrl', async (_event, url: string) => {
    logger.userAction('Download from URL started', { url })
    try {
      const result = await downloadFromUrl(url)
      if (result.success) {
        logger.userAction('Download from URL completed', { filePath: result.filePath, title: result.title })
      } else {
        logger.serviceError('FileHandlers', 'downloadFromUrl', new Error(result.error))
      }
      return result
    } catch (err) {
      logger.serviceError('FileHandlers', 'downloadFromUrl', err)
      return {
        success: false,
        error: err instanceof Error ? err.message : '下载失败',
      }
    }
  })

  ipcMain.handle('dialog:selectTextFile', async () => {
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
    logger.userAction('Text file selected', { path: result.filePaths[0] })
    return result.filePaths[0]
  })

  ipcMain.handle('file:readTextFile', async (_event, filePath: string) => {
    logger.serviceCall('FileHandlers', 'readTextFile', { filePath })
    try {
      const content = await extractTextFromFile(filePath)
      logger.info('FileHandlers', 'Text file read', { filePath, size: content?.length ?? 0 })
      return content
    } catch (err) {
      logger.serviceError('FileHandlers', 'readTextFile', err)
      return null
    }
  })

  ipcMain.handle('app:openLogDirectory', async () => {
    const { app, shell } = require('electron')
    const { join } = require('path')
    const logDir = join(app.getPath('userData'), 'logs')
    logger.userAction('Opening log directory', { path: logDir })
    try {
      await shell.openPath(logDir)
      return { success: true }
    } catch (err) {
      logger.serviceError('FileHandlers', 'openLogDirectory', err as Error)
      return { success: false, error: (err as Error).message }
    }
  })
}
