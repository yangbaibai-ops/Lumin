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
  /**
   * ⚠️ **必须显式开压缩**（第十二轮启动量化实测）：`electron-vite` 给 main / preload / renderer
   * 的默认 `build.minify` 都是 **false**（它的理由大概是"Electron 从本地加载、可读性更重要"），
   * 于是我们一直在用**未压缩产物**：入口 chunk 991KB、编辑器 chunk 2.5MB、主进程 334KB ——
   * 这些字节每次启动都要读、解析、求值。实测（同一台机器、同一方法、交替 A/B）：
   * 入口 991 → **423KB**、编辑器 chunk 2547 → **1259KB**、主进程 334 → **220KB**、
   * 入口 CSS 111 → **87KB**；`lumin:entry-exec` 149→145、`doc-visible`(编辑器可交互)
   * 272→**256ms**、窗口首次可见（主进程 `first-window-painted`）485→**457ms**（−28ms）。
   *
   * 用 `'esbuild'`（Vite 的默认压缩器）：只重命名标识符、不做语义变换，字符串/类名字面量
   * 都保留 —— 对"靠 name 找扩展/插件"的代码（Tiptap extension name、插件 key、`data-*`
   * 锚点）无影响；仓库里所有 `.name` 用法都是数据名（ProseMirror 节点/标记名、路由名、
   * 文件/列名），**产品代码里没有一处依赖被压缩的标识符**（清查过 `constructor.name` /
   * `getPrototypeOf` / `prototype.constructor` / `Function.toString` / `KeepAlive include`
   * 这些写法，`src/` 里一处都没有）。
   *
   * ⚠️ **但压缩必须配 `keepNames: true`**（第十二轮收尾被真实回归打出来的）：esbuild 默认连
   * **类名**一起改，于是 `editor.state.selection.constructor.name` 从 `TextSelection` 变成
   * `Tt` —— `tools/_verify-math-edit.js` 的 S2/TB2（以及 `_verify-table-quickbar.js` 读选区
   * 类型的那批）当场红，而**行为数据完全正确**，红的只是名字。`keepNames` 让测试、日志、
   * 崩溃栈在任何环境下都读得懂；代价是入口 +7.6%（423→455KB）、编辑器 chunk +4.6%
   * （1259→1317KB）—— 相对未压缩基线仍是 **−54% / −48%**（`tests/bootBudget.test.mjs` 守着）。
   */
  main: { build: { minify: 'esbuild' }, esbuild: { keepNames: true } },
  preload: {
    build: {
      minify: 'esbuild',
      rollupOptions: {
        /**
         * 两个 preload 入口：
         *   * `index`        —— 应用窗口的全套 API（`window.luminAPI`）；
         *   * `printPreview` —— 打印预览窗口**专用**，只暴露「打印 / 关闭」两个动作
         *     （那个窗口只显示一份 PDF，没有理由拿到草稿/备份/剪贴板那套，见
         *     src/preload/printPreview.ts 与 main/printPreview.ts）。
         */
        input: {
          index: resolve('src/preload/index.ts'),
          printPreview: resolve('src/preload/printPreview.ts')
        }
      }
    }
  },
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
    esbuild: { keepNames: true },
    build: {
      minify: 'esbuild',
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
