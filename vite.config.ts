import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
                'puppeteer-extra',
                'puppeteer-extra-plugin-stealth',
                'mammoth',
                'pdf-parse',
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
      {
        /**
         * CLI 是第三个构建产物，不是主进程那份的一部分：`vv` 靠 ELECTRON_RUN_AS_NODE 直接吃这个文件，
         * 主进程那个 bundle 一 import 就抛（它要 `electron` 模块）。名字定死成 vv.mjs（不是默认的 vv.js）
         * 是因为 #374 实测跑通的就是 `.mjs`——省掉「靠根 package.json 的 type 字段才被当 ESM」这一层间接。
         * onstart 留空：这个入口改了不该再拉起一个 Electron 实例。
         */
        entry: 'electron/cli/vv.ts',
        onstart() {},
        vite: {
          build: {
            outDir: 'dist-electron/cli',
            rollupOptions: {
              output: {
                entryFileNames: 'vv.mjs',
              },
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
