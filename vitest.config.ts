import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 单独一份配置，不复用 vite.config.ts：那份挂着 vite-plugin-electron，它的 onstart 会把应用拉起来。
export default defineConfig({
  // src 里的模块用 `@/xxx` 互相引用（那份配置里也有这条），要测到渲染层的纯函数就得在这里
  // 重新声明一遍。少这一条时 vitest 报的是「Failed to resolve import '@/hooks/...'」，
  // 看着像是源码坏了，其实只是这份配置没接线。
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
