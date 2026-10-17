// ─── 导出服务（渲染层）：getHTML 输出 + 独立排版 CSS + Mermaid 后处理 ──────
import type { EffectiveTheme } from '../../../shared/types'

/**
 * ─── Mermaid SVG 尺寸口径（编辑器与导出**共用这一处**）────────────────────────
 *
 * mermaid 默认输出 `width="100%"` + 内联 `style="max-width: <自然宽>px"`。历史上为了
 * 「长流程图被压成小图」把 width 改成 100%、删掉 height —— 于是**竖图被放大**：一个
 * 自然宽 346 的纵向流程图会被拉到 584（1000px 窗口下实测），块高从 590 涨到 996，
 * 屏幕上只剩一个方框（用户报障）。
 *
 * 现在**只缩不放**：
 *   * 把 `viewBox` 的 `w`/`h` 写成 `<svg>` 的 `width`/`height` 属性（`viewBox` 保留），
 *     SVG 于是有确定的**内在尺寸与宽高比**；
 *   * 缩放完全交给 CSS 的 `max-width: 100%`：容器更窄 ⇒ 等比缩小（宽图照旧铺满），
 *     容器更宽 ⇒ 保持自然尺寸（竖图不再被拉满一屏）；
 *   * 内联 `style` 仍摘掉（里面只有 max-width，会把图锁在自然宽以内；而且缩放口径
 *     只能有一处，写在 CSS 里）。
 *
 * 导出侧 `renderMermaidInHtml` 与编辑器 `CodeBlockView.renderMermaid` 都走这个函数，
 * 保证「编辑器里看到的尺寸 = 导出件里的尺寸」。
 */
export function normalizeMermaidSvg(svg: string): string {
  const open = /<svg\b[^>]*>/i.exec(svg)
  if (!open) return svg
  // ⚠️ 只改开头这个 <svg …> 标签；内容里的 <style>/<svg> 子元素必须原样保留
  let tag = open[0].replace(/\sstyle="[^"]*"/i, '')
  const natural = parseViewBoxSize(/\sviewBox="([^"]*)"/i.exec(tag)?.[1])
  if (natural) {
    tag = setSvgAttr(tag, 'width', String(natural.width))
    tag = setSvgAttr(tag, 'height', String(natural.height))
  } else {
    // 没有 viewBox（mermaid 正常都会给）：保守兜底 —— 百分比宽度必须去掉，
    // 它就是「把图拉满容器」的那个源头；固定 height 也去掉，交给内在比例。
    tag = tag.replace(/\swidth="[^"]*%"/i, '').replace(/\sheight="[^"]*"/i, '')
  }
  return svg.replace(open[0], tag)
}

/** `viewBox="minX minY w h"` 的后两项（自然宽高）；解析不出来返回 null */
function parseViewBoxSize(viewBox: string | undefined): { width: number; height: number } | null {
  if (!viewBox) return null
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [, , width, height] = parts
  return width > 0 && height > 0 ? { width, height } : null
}

/** 覆盖（没有就补上）`<svg>` 开标签上的一个属性 */
function setSvgAttr(tag: string, name: 'width' | 'height', value: string): string {
  const re = new RegExp(`\\s${name}="[^"]*"`, 'i')
  if (re.test(tag)) return tag.replace(re, ` ${name}="${value}"`)
  return tag.replace(/<svg\b/i, `<svg ${name}="${value}"`)
}

/**
 * 编辑态实时预览的状态迁移：**渲染失败时保留上一张成功的图**（只多一行错误提示），
 * 绝不把整块换成错误文本。
 *
 * `rendered === null` = 本次渲染抛错；此时 svg 原样返回、error 置真。成功则整体替换。
 * 抽成纯函数是为了单测能直接钉住「失败保留旧图」这条语义（组件里只负责调用）。
 */
export interface MermaidPreviewState {
  svg: string
  error: boolean
}

export function nextMermaidPreviewState(
  prev: MermaidPreviewState,
  rendered: string | null
): MermaidPreviewState {
  if (rendered === null) return { svg: prev.svg, error: true }
  return { svg: rendered, error: false }
}

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
/* Same geometry contract as the editor (overlays.css .mermaid-block): **shrink only, never grow**.
   normalizeMermaidSvg() writes the viewBox's natural w/h onto the svg, so:
     * narrower container -> max-width:100% scales it down proportionally (wide flowcharts still fit);
     * wider container   -> it keeps its natural size (tall diagrams are no longer blown up).
   The host stays shrink-to-fit: it is the flex item, and an explicit width:100% here would make
   every svg grow to the full column again (the bug this contract fixes). */
.md-mermaid .mermaid-svg-host { min-width: 0; max-width: 100%; }
.md-mermaid svg { display: block; max-width: 100%; height: auto; }
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
         * 与编辑器侧同一口径（`normalizeMermaidSvg`，本文件顶部）：把 viewBox 的自然宽高写回
         * `width`/`height` 属性并摘掉内联 style，缩放交给上面 CSS 的 `max-width:100%` ——
         * 窄容器等比缩小、宽容器保持自然尺寸（竖图不再被拉满整页）。
         * 外面再包一层 `.mermaid-svg-host`，与编辑器（模板里的宿主 div）**结构一致**。
         */
        wrap.innerHTML = `<div class="mermaid-svg-host">${normalizeMermaidSvg(svg)}</div>`
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
