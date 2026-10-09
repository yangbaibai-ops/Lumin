// ─── KaTeX 样式表：**按需加载**（不进渲染阻塞的入口 CSS）─────────────────────────
//
// 背景（启动量化，第十二轮）：入口 CSS 是渲染阻塞的 —— 浏览器必须把它解析完才画第一帧。
// 而 `katex/dist/katex.min.css` 自带 59 条 `@font-face` 与整套排版规则，静态 `@import` 进
// 入口后把入口 CSS 从 ~60KB 抬到 **143KB**，可"打开应用"这一屏（空文档/纯文本文档）里
// 一个公式都没有 —— 这份成本 100% 用不上。
//
// 为什么改**动态 import** 而不是干脆不引：KaTeX 的排版依赖这份 CSS（字体度量、`.katex`
// 系列规则）。少了它，公式会以未样式化的形态短暂出现（分数字形不堆叠、积分号不伸缩）。
// 动态 import 由 Vite 打成一个**按需 CSS chunk**，首次 import 时注入 `<link>`，行为等价。
//
// 什么时候加载（两处，都不阻塞首屏）：
//   1. `EditorView.vue` 的 setup 里 `preloadKatexCss()` —— 与编辑器创建并行，纯预热；
//   2. 真的要在页面上渲染公式之前（`lib/editor/mathPreview.ts` 建装饰前）`await` 一次，
//      保证"有公式的文档"不会闪未样式化的公式。
//
// ⚠️ 如实边界：文件里的公式若在 CSS chunk 落地**之前**就完成了首帧渲染，会看到极短
// （~10–30ms，本机实测）的未样式化公式。预热把窗口压到最小，但不能证明为零。
let pending: Promise<unknown> | null = null

/** 预热（不 await）：编辑器挂载时调一次即可 */
export function preloadKatexCss(): void {
  void ensureKatexCss()
}

/** 确保 KaTeX 样式已注入；幂等（同一个 Promise 复用） */
export function ensureKatexCss(): Promise<unknown> {
  if (!pending) {
    pending = import('katex/dist/katex.min.css').catch(() => {
      // 加载失败不该让编辑器建不起来：公式退化为未样式化（但应用照常可用）
      pending = null
      return null
    })
  }
  return pending
}
