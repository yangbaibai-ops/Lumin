// ─── 导出服务（渲染层）：getHTML 输出 + 独立排版 CSS + Mermaid 后处理 ──────
import type { EffectiveTheme } from '../../../shared/types'

// 导出件的色值必须与**浅色主题令牌逐条一致**（审计 §8 P2「token 未覆盖的硬编码色」）：
// 这里是一份独立 HTML 的排版 CSS，拿不到运行时的 CSS 变量，只能写死字面量 —— 但"写死"不等于
// "自己另立一套"：`--code-bg` 曾漂成 #f4f5f8（令牌 #f1f2f5）、`--panel-2` 漂成 #f0f1f4（令牌 #e9ebf0），
// 于是导出的 PDF/HTML 与编辑器里的观感悄悄不同。改动这些值请同步 theme.css 的浅色块，
// `tests/designTokens.test.mjs` 会逐条对账。
const proseCss = `
:root {
  --edge: #e4e6ea; --edge-strong: #d2d5db; --ink: #20242b; --ink-2: #4e5766; --ink-3: #7d8595;
  --accent: #6b7280; --accent-2: #4b5563; --accent-soft: rgba(17, 24, 39, 0.07);
  --link: #1f57dd;
  --ok: #16a34a; --warning: #d97706; --danger: #dc2626;
  --code-key: #3f6592; --code-key-2: #2b6f8f;
  --code-bg: #f1f2f5; --panel-2: #e9ebf0;
}
html, body { margin: 0; padding: 0; }
body.export-body {
  background: #fff; color: var(--ink); line-height: 1.85; font-size: 15.5px;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.md-preview { max-width: 800px; margin: 0 auto; padding: 48px 56px; }
.md-preview > *:first-child { margin-top: 0; }
.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6 {
  font-weight: 700; line-height: 1.35; margin: 1.3em 0 .55em; letter-spacing: -.01em;
}
.md-preview h1 { font-size: 1.95em; padding-bottom: .28em; border-bottom: 1px solid var(--edge); }
.md-preview h2 { font-size: 1.5em; padding-bottom: .22em; border-bottom: 1px solid var(--edge); }
.md-preview h3 { font-size: 1.22em; }
.md-preview p { margin: .55em 0; }
.md-preview a { color: var(--link); text-decoration: none; border-bottom: 1px solid rgba(37,99,235,.35); }
.md-preview blockquote {
  margin: .8em 0; padding: .4em 1.1em; border-left: 3px solid var(--edge-strong);
  background: none; color: var(--ink-2);
}
.md-preview ul,.md-preview ol { margin: .55em 0; padding-left: 1.7em; }
.md-preview li { margin: .22em 0; }
.md-preview code {
  font-family: ui-monospace, 'Cascadia Code', Consolas, Menlo, monospace;
  font-size: .88em; background: var(--code-bg); border-radius: 5px; padding: .15em .4em;
}
.md-preview pre {
  margin: .8em 0; padding: 14px 16px; border-radius: 12px; background: var(--code-bg);
  border: 1px solid var(--edge); overflow-x: auto; line-height: 1.6; position: relative;
}
.md-preview pre code { background: none; padding: 0; font-size: .86em; }
.md-preview table { border-collapse: collapse; margin: .9em 0; width: 100%; font-size: .95em; }
.md-preview thead { background: var(--panel-2); }
.md-preview th,.md-preview td { border: 1px solid var(--edge); padding: 7px 13px; text-align: left; }
.md-preview th { font-weight: 600; }
.md-preview hr { border: none; height: 1px; margin: 1.6em auto; width: 70%;
  background: linear-gradient(90deg, transparent, #d2d5db, transparent); }
.md-preview img { max-width: 100%; border-radius: 10px; margin: .4em auto; display: block; }
.md-preview ul[data-type="taskList"] { list-style: none; padding-left: .4em; }
.md-preview ul[data-type="taskList"] li { display: flex; gap: 8px; align-items: flex-start; }
.md-preview ul[data-type="taskList"] li > label { flex: none; margin-top: 4px; }
.md-preview ul[data-type="taskList"] input[type="checkbox"] { accent-color: var(--accent); }
.md-preview .katex { font-size: 1.06em; }
.md-mermaid { display: flex; justify-content: center; margin: .8em 0; }
.md-mermaid svg { display: block; flex: 1 1 auto; width: 100%; min-width: 0; max-width: 100%; height: auto; }
@media print {
  .md-preview { padding: 0; max-width: none; }
  .md-preview pre { white-space: pre-wrap; }
  /* Pagination (audit §7-18: previously this block only tweaked padding):
     keep headings with their body, never split code/table/img/quote across pages,
     and avoid single-line orphans/widows. */
  .md-preview h1, .md-preview h2, .md-preview h3 {
    break-after: avoid-page; page-break-after: avoid;
  }
  .md-preview pre, .md-preview table, .md-preview img, .md-preview blockquote,
  .md-preview ul[data-type="taskList"] li {
    break-inside: avoid; page-break-inside: avoid;
  }
  .md-preview p, .md-preview li { orphans: 3; widows: 3; }
  .md-preview { overflow-wrap: break-word; }
}
`

/**
 * 导出用的完整 CSS（排版规则 + KaTeX 样式），**按需加载**。
 *
 * 为什么是函数而不是模块级常量：KaTeX 的样式表（含 59 条 `@font-face`）经 `?inline`
 * 变成字符串后是 **~231KB**，而本模块挂在 `App.vue → useAppActions → useExport`
 * 这条**静态**依赖链上 —— 常量写法会在模块求值期把它钉进首屏 entry chunk，
 * 而真正需要它的只有「用户点了导出」这一刻（第二十五轮轻量化）。
 * 首次调用后缓存字符串，第二次导出不再付解析成本。
 */
let exportCssCache: string | null = null
export async function getExportCss(): Promise<string> {
  if (exportCssCache === null) {
    const { default: katexCss } = await import('katex/dist/katex.min.css?inline')
    exportCssCache = proseCss + '\n' + katexCss
  }
  return exportCssCache
}

/** 把 getHTML 输出中的 mermaid 代码块替换为渲染好的 SVG */
export async function renderMermaidInHtml(html: string, theme: EffectiveTheme): Promise<string> {
  if (!html.includes('language-mermaid')) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocks = Array.from(doc.querySelectorAll('pre > code.language-mermaid'))
  if (!blocks.length) return html
  try {
    const mod = await import('mermaid')
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    })
    let seq = 0
    for (const code of blocks) {
      const pre = code.parentElement
      if (!pre) continue
      try {
        const { svg } = await mod.default.render(
          `mmd-export-${Date.now()}-${seq++}`,
          code.textContent || ''
        )
        const wrap = doc.createElement('div')
        wrap.className = 'md-mermaid'
        /**
         * 与编辑器侧同一口径（见 CodeBlockView 的 renderMermaid）：摘掉 mermaid 写在
         * `<svg>` 上的内联 `style`（里面只有 `max-width`），宽度强制 100%、删掉固定
         * `height` 交给 viewBox 自适应 —— 否则导出的图会被锁在自然宽度内、被压小。
         */
        wrap.innerHTML = svg
          .replace(/(<svg[^>]*?)\sstyle="[^"]*"/i, '$1')
          .replace(/(<svg[^>]*?)\swidth="[^"]*"/i, '$1 width="100%"')
          .replace(/(<svg[^>]*?)\sheight="[^"]*"/i, '$1')
        pre.replaceWith(wrap)
      } catch {
        /* 渲染失败保留源码 */
      }
    }
    return doc.body.innerHTML
  } catch {
    return html
  }
}
