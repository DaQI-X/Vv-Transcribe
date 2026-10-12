/**
 * 参考稿文件解析服务
 * 支持 .txt / .md / .srt / .docx / .pdf 格式的文本提取
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { logger } from './logger'

/** 从 SRT 字幕文件中提取纯文本 */
function extractSrtText(content: string): string {
  const lines = content.split(/\r?\n/)
  const textLines: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^\d+$/.test(trimmed)) continue
    if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(trimmed)) continue
    const cleaned = trimmed.replace(/<[^>]+>/g, '')
    textLines.push(cleaned)
  }
  const seen = new Set<string>()
  const unique: string[] = []
  for (const line of textLines) {
    if (!seen.has(line)) {
      seen.add(line)
      unique.push(line)
    }
  }
  return unique.join('\n')
}

/** 去除 Markdown 格式标记 */
function stripMarkdown(content: string): string {
  return content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.+?)\]\(.*?\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^---+$/gm, '')
    .trim()
}

/** 根据文件扩展名提取纯文本 */
export async function extractTextFromFile(filePath: string): Promise<string | null> {
  const ext = extname(filePath).toLowerCase()
  logger.serviceCall('ReferenceParser', 'extractTextFromFile', { filePath, ext })

  try {
    switch (ext) {
      case '.txt':
      case '.md': {
        let content = await readFile(filePath, 'utf-8')
        if (ext === '.md') content = stripMarkdown(content)
        return content
      }

      case '.srt': {
        const content = await readFile(filePath, 'utf-8')
        return extractSrtText(content)
      }

      case '.docx': {
        const mammoth = await import('mammoth')
        const buffer = await readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        return result.value
      }

      case '.pdf': {
        const pdfParseModule = await import('pdf-parse')
        const pdfParse = (pdfParseModule as any).default || pdfParseModule
        const buffer = await readFile(filePath)
        const result = await pdfParse(buffer)
        return result.text
      }

      default:
        logger.warn('ReferenceParser', 'Unsupported file format', { ext })
        return null
    }
  } catch (err) {
    logger.serviceError('ReferenceParser', 'extractTextFromFile', err)
    return null
  }
}
