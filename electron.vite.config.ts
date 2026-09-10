import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue(), tailwindcss()],
    server: {
      watch: {
        // 忽略编辑器原子保存产生的临时目录：Windows 上该目录常被短暂锁定，
        // watcher 一旦 watch 到就会 EBUSY 崩溃并终止整个 dev 进程。
        ignored: ['**/.*.tmpdir/**']
      }
    }
  }
})
