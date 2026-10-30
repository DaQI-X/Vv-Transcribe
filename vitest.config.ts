import { defineConfig } from 'vitest/config'

// 单独一份配置，不复用 vite.config.ts：那份挂着 vite-plugin-electron，它的 onstart 会把应用拉起来。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
