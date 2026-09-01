// ─── 导出文档用的独立样式表（含 KaTeX / 代码高亮配色）────────────────────
import katexCss from 'katex/dist/katex.min.css?inline'

const proseCss = `
:root {
  --edge: #e4e6ea;
  --ink: #20242b;
  --ink-2: #4e5766;
  --ink-3: #8a919e;
  --accent: #6366f1;
  --accent-2: #8b5cf6;
  --accent-soft: rgba(99,102,241,.08);
  --ok: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  --code-bg: #f4f5f8;
  --panel-2: #f0f1f4;
}
html, body { margin: 0; padding: 0; }
body.export-body {
  background: #fff;
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  line-height: 1.85;
  font-size: 15.5px;
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
  margin: .8em 0; padding: .4em 1.1em; border-left: 3px solid var(--accent);
  border-radius: 0 10px 10px 0; background: var(--accent-soft); color: var(--ink-2);
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
.md-preview .katex { font-size: 1.06em; }
.md-preview .katex-display { margin: .8em 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.md-preview svg { max-width: 100%; }
.md-toc { margin: .6em 0; padding: 10px 16px 10px 18px; border: 1px solid var(--edge);
  border-left: 3px solid var(--accent); border-radius: 10px; background: #fafbfd;
  display: inline-block; min-width: 240px; }
.md-toc-title { font-size: .85em; font-weight: 700; color: var(--ink-2); letter-spacing: .06em; margin-bottom: 4px; }
.md-toc a { display: block; padding: 1px 0; font-size: .94em; border-bottom: none; color: var(--ink); text-decoration: none; }
.md-toc .toc-l2 { padding-left: 1.1em; }
.md-toc .toc-l3 { padding-left: 2.2em; }
.md-mermaid { display: flex; justify-content: center; margin: .8em 0; }
.md-mermaid svg { max-width: 100%; height: auto; }
.code-lang {
  position: absolute; top: 8px; right: 10px; font-size: 10.5px; letter-spacing: .05em;
  text-transform: uppercase; color: var(--ink-3); background: rgba(255,255,255,.6);
  border-radius: 6px; padding: 1px 7px; font-family: ui-sans-serif, sans-serif;
}
.hljs { color: var(--ink); }
.hljs-comment,.hljs-quote { color: var(--ink-3); font-style: italic; }
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag { color: var(--accent); }
.hljs-string,.hljs-regexp,.hljs-addition { color: var(--ok); }
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-meta { color: var(--warning); }
.hljs-title,.hljs-section,.hljs-name { color: var(--accent-2); }
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-type { color: #4338ca; }
.hljs-built_in,.hljs-builtin-name,.hljs-function { color: var(--warning); }
.hljs-tag { color: var(--accent); }
.hljs-deletion { color: var(--danger); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
@media print {
  .md-preview { padding: 0; max-width: none; }
  .md-preview pre { white-space: pre-wrap; }
}
`

export const exportCss = proseCss + '\n' + katexCss
