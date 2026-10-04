import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { CSP_PLACEHOLDER, cspMetaTag, devCsp, PROD_CSP } from './src/shared/csp'

/**
 * 把 `index.html` 里的 `<!--LUMIN_CSP-->` 占位替换成真的 CSP meta 标签。
 *
 * 为什么用构建期注入而不是手写两份：CSP 只能有一份真相源（`src/shared/csp.ts`），
 * 主进程的响应头读的是同一个常量。dev 与 prod 的差别只有"要不要放行 HMR 的 ws"。
 */
function cspPlugin(isDev: boolean): Plugin {
  return {
    name: 'lumin-csp',
    transformIndexHtml(html) {
      if (!html.includes(CSP_PLACEHOLDER)) return html
      return html.replace(CSP_PLACEHOLDER, cspMetaTag(isDev ? devCsp() : PROD_CSP))
    }
  }
}

/**
 * 开发/生产都以「启动」为约束来配：
 *  - optimizeDeps.include：把启动路径上必用的 ESM 依赖**预打包**，避免首次进入编辑器时
 *    现发现依赖 → 触发 "new dependencies optimized, reloading" 的二次加载；
 *  - server.warmup.clientFiles：dev 启动时预热首屏链路（编辑器、store），把 on-demand
 *    transform 的等待提前到启动阶段；
 *  - build：不手工拆 chunk（原因见下方注释），保持 Vite 默认的「按动态 import 边界拆包」。
 */
export default defineConfig(({ command }) => ({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue(), tailwindcss(), cspPlugin(command === 'serve')],
    optimizeDeps: {
      // 按「代码里真实出现的 specifier」列：子路径包（@tiptap/pm/state 等）必须单独列，
      // 只写根包名不会覆盖子路径，仍会在首次进入编辑器时触发重新预打包。
      include: [
        'vue',
        'vue-router',
        'pinia',
        'vue-i18n',
        '@tiptap/core',
        '@tiptap/vue-3',
        '@tiptap/starter-kit',
        '@tiptap/extension-bold',
        '@tiptap/extension-code',
        '@tiptap/extension-code-block',
        '@tiptap/extension-horizontal-rule',
        '@tiptap/extension-image',
        '@tiptap/extension-italic',
        '@tiptap/extension-placeholder',
        '@tiptap/extension-strike',
        '@tiptap/extension-table',
        '@tiptap/extension-task-item',
        '@tiptap/extension-task-list',
        '@tiptap/extension-underline',
        '@tiptap/pm/model',
        '@tiptap/pm/state',
        '@tiptap/pm/transform',
        '@tiptap/pm/view',
        'tiptap-markdown',
        '@codemirror/autocomplete',
        '@codemirror/commands',
        '@codemirror/language',
        /**
         * ⚠️ 这里曾经列着 `@codemirror/language-data`（报告 §3.2 P1-3 的死配置）：
         * `src/**` 里**零引用** —— 它带 116 个 `import()` 的语言包，代码块正是为了避开它
         * 才自己维护显式语言表（见 `components/editor/CodeBlockView.vue`）。列在预构建里
         * 只会让 dev 首次启动多扫一遍这个包。删掉它，让配置与真实引用一致。
         */
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/highlight'
      ]
    },
    server: {
      warmup: {
        clientFiles: [
          './src/main.ts',
          './src/App.vue',
          './src/router/index.ts',
          './src/views/EditorView.vue',
          './src/components/editor/*.vue',
          './src/stores/*.ts',
          './src/components/NotificationCenter.vue'
        ]
      },
      watch: {
        // 忽略编辑器原子保存产生的临时目录：Windows 上该目录常被短暂锁定，
        // watcher 一旦 watch 到就会 EBUSY 崩溃并终止整个 dev 进程。
        ignored: ['**/.*.tmpdir/**']
      }
    },
    build: {
      // 不做 manualChunks 手工拆包：实测把 @tiptap/@codemirror/mermaid 强制分组会形成
      // 「循环 chunk」，Rollup 会把只被动态 import 的 mermaid（4.9MB）提到 modulepreload
      // 里**首屏就加载**，反而拖慢启动。Vite/Rollup 默认按动态 import 边界拆包已经足够：
      // 编辑器是懒加载 chunk，mermaid/katex 保持按需加载。
      //
      // ⚠️ 但**默认的 modulePreload 仍然会把 mermaid 家族预加载**（自查报告 O1 / 清单 §2.G 实测）：
      // 路由 chunk（EditorView）加载时，Vite 会为它「动态 import 的依赖」插 `<link rel=modulepreload>`，
      // 于是 `mermaid.core`（1.23MB）在**首屏就被取**——哪怕文档里一个 mermaid 块都没有。
      // 这跟「mermaid 按需」的初衷相反，所以这里把这一族从预加载依赖里剔掉：
      // 真正需要时（mermaid 块进入视口附近 / 导出）由 `import('mermaid')` 现取。
      // 验证：`tools/_verify-mermaid-gate.js` 断言启动后 `link[rel=modulepreload]` 里
      // 不含 mermaid/cynefin/cytoscape，且块滚入视口后仍能正常渲染。
      modulePreload: {
        polyfill: true,
        resolveDependencies: (_filename, deps) =>
          deps.filter((d) => !/mermaid|cynefin|cytoscape/i.test(d))
      },
      rollupOptions: {
        output: {}
      }
    }
  }
}))
