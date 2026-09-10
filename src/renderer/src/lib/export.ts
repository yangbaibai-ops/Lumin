// ─── 导出服务（渲染层）：getHTML 输出 + 独立排版 CSS + Mermaid 后处理 ──────
import katexCss from 'katex/dist/katex.min.css?inline'
import type { EffectiveTheme } from '../../../shared/types'

const proseCss = `
:root {
  --edge: #e4e6ea; --ink: #20242b; --ink-2: #4e5766; --ink-3: #8a919e;
  --accent: #6366f1; --accent-2: #8b5cf6; --accent-soft: rgba(99,102,241,.08);
  --ok: #16a34a; --warning: #d97706; --danger: #dc2626;
  --code-bg: #f4f5f8; --panel-2: #f0f1f4;
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
.md-preview a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(99,102,241,.35); }
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
.md-mermaid svg { max-width: 100%; height: auto; }
@media print {
  .md-preview { padding: 0; max-width: none; }
  .md-preview pre { white-space: pre-wrap; }
}
`

export const exportCss = proseCss + '\n' + katexCss

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
        const { svg } = await mod.default.render(`mmd-export-${Date.now()}-${seq++}`, code.textContent || '')
        const wrap = doc.createElement('div')
        wrap.className = 'md-mermaid'
        wrap.innerHTML = svg
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
