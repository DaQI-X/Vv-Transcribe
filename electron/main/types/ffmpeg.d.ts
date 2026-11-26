declare module 'fluent-ffmpeg' {
  interface FfmpegCommand {
    audioFrequency(freq: number): FfmpegCommand
    audioChannels(channels: number): FfmpegCommand
    audioCodec(codec: string): FfmpegCommand
    format(format: string): FfmpegCommand
    on(event: 'end', callback: () => void): FfmpegCommand
    on(event: 'error', callback: (err: Error) => void): FfmpegCommand
    on(event: string, callback: (...args: unknown[]) => void): FfmpegCommand
    /** 库自己只发这一个信号，不留 SIGTERM 到点再升级的余地（那层在 childKill.ts） */
    kill(signal?: string): FfmpegCommand
    save(outputPath: string): void
  }

  interface FfprobeData {
    streams: Array<{
      codec_type?: string
      codec_name?: string
      channels?: number
      sample_rate?: number
    }>
    format: {
      duration?: number
    }
  }

  interface FluentFfmpeg {
    (inputPath: string): FfmpegCommand
    setFfmpegPath(path: string): void
    ffprobe(
      filePath: string,
      callback: (err: Error | null, metadata: FfprobeData) => void,
    ): void
  }

  const ffmpeg: FluentFfmpeg
  export default ffmpeg
}

declare module '@ffmpeg-installer/ffmpeg' {
  const ffmpegPath: { path: string }
  export default ffmpegPath
}
