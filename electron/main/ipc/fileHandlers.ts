/**
 * 文件处理 IPC 处理器
 * 提供文件选择对话框、文件元数据读取、音频提取（FFmpeg）、临时文件清理等功能
 * 支持格式：MP3/WAV/M4A/FLAC/OGG/WMA/MP4/MKV/AVI/MOV/WebM/FLV
 */
import { ipcMain, dialog } from 'electron'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { extractAudio, cleanupTemp, probeFile } from '../services/audioProcessor'

const ALLOWED_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.wma',
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv',
]

export function registerFileHandlers() {
  ipcMain.handle('dialog:selectFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: '音视频文件',
          extensions: ALLOWED_EXTENSIONS.map((ext) => ext.slice(1)),
        },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('file:getMetadata', async (_event, filePath: string) => {
    try {
      console.log('[fileHandlers] getMetadata for:', filePath)
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
      console.log('[fileHandlers] metadata:', metadata)
      return metadata
    } catch (err) {
      console.error('[fileHandlers] getMetadata failed:', filePath, err)
      return null
    }
  })

  ipcMain.handle('file:extractAudio', async (_event, filePath: string) => {
    try {
      const result = await extractAudio(filePath)
      return {
        success: true,
        wavPath: result.wavPath,
        tempDir: result.tempDir,
        duration: result.metadata.duration,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : '音频提取失败',
      }
    }
  })

  ipcMain.handle('file:cleanupTemp', async (_event, tempDir: string) => {
    await cleanupTemp(tempDir)
  })

  ipcMain.handle('file:probeAudio', async (_event, filePath: string) => {
    try {
      const metadata = await probeFile(filePath)
      return { success: true, metadata }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : '无法读取音频信息',
      }
    }
  })
}
