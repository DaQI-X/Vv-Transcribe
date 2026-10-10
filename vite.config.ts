import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main/index.ts',
        onstart(args) {
          args.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: [
                'fluent-ffmpeg',
                '@ffmpeg-installer/ffmpeg',
                '@ffmpeg-installer/darwin-arm64',
                '@ffmpeg-installer/darwin-x64',
                '@ffprobe-installer/ffprobe',
                '@ffprobe-installer/darwin-arm64',
                '@ffprobe-installer/darwin-x64',
                '@xenova/transformers',
                'onnxruntime-node',
                'sharp',
              ],
            },
          },
        },
      },
      {
        entry: 'electron/preload/index.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': '/src',
      'sharp': '/electron/main/services/sharp-mock.js',
    },
  },
})
