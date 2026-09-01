// ─── Markdown 渲染管线：marked + KaTeX + highlight.js + Mermaid + DOMPurify ──
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import katex from 'katex'
import type { EffectiveTheme } from '../../../shared/types'

// ─────────────────────────── 基础工具 ───────────────────────────
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escapeAttr(s: string): string {
  return escapeHtml(s)
}

export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
  return slug || 'section'
}

// ─────────────────────────── 文档块模型 ───────────────────────────
export interface Block {
  index: number
  start: number // 起始行（含，0-based）
  end: number // 结束行（不含，0-based）
  text: string
}

export interface HeadingInfo {
  level: number
  text: string
  id: string
  line: number
  blockIndex: number
}

export interface DocAnalysis {
  blocks: Block[]
  headings: HeadingInfo[]
  slugCursor: Map<string, number>
}

/** 将文档切分为块（以空行分隔），同时提取标题大纲 */
export function analyzeDoc(content: string): DocAnalysis {
  const lines = content.split('\n')
  const blocks: Block[] = []
  const headings: HeadingInfo[] = []
  const slugCursor = new Map<string, number>()
  let start = 0
  let inFence = false

  const pushBlock = (from: number, to: number): void => {
    if (to > from || blocks.length === 0) {
      blocks.push({ index: blocks.length, start: from, end: to, text: lines.slice(from, to).join('\n') })
    }
  }

  lines.forEach((line, i) => {
    const fenceMatch = line.match(/^\s*(```|~~~)/)
    if (fenceMatch) inFence = !inFence
    const isBlank = line.trim() === '' && !inFence

    if (!inFence) {
      const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (h && !line.startsWith('>')) {
        const text = h[2].replace(/[*_`~]/g, '').trim()
        const idx = slugCursor.get(text) ?? 0
        slugCursor.set(text, idx + 1)
        const slug = slugify(text)
        headings.push({
          level: h[1].length,
          text,
          id: idx === 0 ? slug : `${slug}-${idx}`,
          line: i,
          blockIndex: blocks.length
        })
      }
    }

    if (isBlank) {
      pushBlock(start, i)
      // 连续空行之间的空行 = 空段落块（Typora：段落行末回车产生空段落）
      const prevBlank = i > 0 && lines[i - 1].trim() === ''
      const nextNotBlank = i + 1 < lines.length && lines[i + 1].trim() !== ''
      if (i === start && blocks.length > 0 && prevBlank && nextNotBlank) {
        blocks.push({ index: blocks.length, start: i, end: i, text: '' })
      }
      start = i + 1
    }
  })
  pushBlock(start, lines.length)

  // 修正标题所在块索引
  for (const h of headings) {
    h.blockIndex = blocks.findIndex((b) => h.line >= b.start && h.line < b.end)
    if (h.blockIndex < 0) h.blockIndex = 0
  }
  // 重置游标（渲染时从头递增）
  slugCursor.forEach((_, k) => slugCursor.set(k, 0))
  return { blocks, headings, slugCursor }
}

/** 用新文本替换某块，返回新文档 */
export function replaceBlock(content: string, block: Block, newText: string): string {
  const lines = content.split('\n')
  const replacement = newText.split('\n')
  lines.splice(block.start, block.end - block.start, ...replacement)
  return lines.join('\n')
}

// ─────────────────────────── 渲染上下文 ───────────────────────────
export interface RenderCtx {
  slugCursor: Map<string, number>
  headings: HeadingInfo[]
  baseDir: string | null
}

let activeCtx: RenderCtx = { slugCursor: new Map(), headings: [], baseDir: null }

/** 相对路径图片 → lumin-file:// 本地协议 */
function resolveImageSrc(src: string): string {
  if (/^(https?|data|file|lumin-file):/i.test(src)) return src
  if (!activeCtx.baseDir) return src
  const parts = (activeCtx.baseDir.replace(/\\/g, '/').split('/').filter(Boolean) as string[]).concat(
    src.replace(/\\/g, '/').split('/')
  )
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  const abs = (activeCtx.baseDir.startsWith('/') ? '/' : '') + stack.join('/')
  return `lumin-file://local/${encodeURIComponent(abs)}`
}

// ─────────────────────────── Marked 扩展 ───────────────────────────
const inlineMath = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string): number {
    let i = src.indexOf('$')
    while (i !== -1) {
      if (i === 0 || src[i - 1] !== '\\') {
        const next = src[i + 1]
        if (next && next !== '$' && next !== ' ' && next !== '\n' && !/\d/.test(next)) return i
      }
      i = src.indexOf('$', i + 1)
    }
    return -1
  },
  tokenizer(src: string): { type: string; raw: string; text: string } | undefined {
    const m = /^\$([^$\n]+?)\$(?!\d)/.exec(src)
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1] }
    return undefined
  },
  renderer(token: { raw: string; text: string }): string {
    try {
      const html = katex.renderToString(token.text, { throwOnError: false, output: 'html' })
      return `<span class="md-math md-math-inline" data-tex="${escapeAttr(token.text)}" contenteditable="false">${html}</span>`
    } catch {
      return token.raw
    }
  }
}

const blockMath = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string): number {
    const i = src.search(/^\$\$|^[^\S\n]*\$\$/m)
    return i
  },
  tokenizer(src: string): { type: string; raw: string; text: string } | undefined {
    const m = /^\$\$[^\S\n]*\n?([\s\S]+?)\n?[^\S\n]*\$\$/.exec(src)
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() }
    return undefined
  },
  renderer(token: { raw: string; text: string }): string {
    try {
      const html = katex.renderToString(token.text, {
        throwOnError: false,
        displayMode: true,
        output: 'html'
      })
      return `<div class="md-math md-math-block" data-tex="${escapeAttr(token.text)}" contenteditable="false">${html}</div>`
    } catch {
      return `<pre><code>${escapeHtml(token.raw)}</code></pre>`
    }
  }
}

interface RendererThis {
  parser: { parseInline: (t: unknown[]) => string }
}

// 渲染器级扩展（heading id / 行内标记符 / 代码高亮 / 链接 / 图片解析）
// strong/em/del/codespan 输出带 .md-meta 标记符（视觉层，光标进入时才显示，不可编辑）
const meta = (marker: string): string =>
  `<span class="md-meta" contenteditable="false">${marker}</span>`

const customRenderer = {
  heading(
    this: RendererThis,
    token: { depth: number; text: string; tokens: unknown[] }
  ): string {
    const plain = (token.text || '').replace(/[*_`~]/g, '').trim()
    const idx = activeCtx.slugCursor.get(plain) ?? 0
    activeCtx.slugCursor.set(plain, idx + 1)
    const slug = slugify(plain)
    const id = idx === 0 ? slug : `${slug}-${idx}`
    const inner = this.parser.parseInline(token.tokens)
    // Typora 式：光标进入标题时显示 # 标记符（视觉层，序列化时忽略）
    const marker = `<span class="md-meta md-heading-marker" contenteditable="false">${'#'.repeat(token.depth)} </span>`
    return `<h${token.depth} id="${id}">${marker}${inner}</h${token.depth}>`
  },
  strong(this: RendererThis, token: { tokens: unknown[] }): string {
    return `<strong>${meta('**')}${this.parser.parseInline(token.tokens)}${meta('**')}</strong>`
  },
  em(this: RendererThis, token: { tokens: unknown[] }): string {
    return `<em>${meta('*')}${this.parser.parseInline(token.tokens)}${meta('*')}</em>`
  },
  del(this: RendererThis, token: { tokens: unknown[] }): string {
    return `<del>${meta('~~')}${this.parser.parseInline(token.tokens)}${meta('~~')}</del>`
  },
  codespan(this: RendererThis, token: { text: string }): string {
    return `<code>${meta('`')}${escapeHtml(token.text)}${meta('`')}</code>`
  },
  code({ text, lang }: { text: string; lang?: string }): string {
    if (lang === 'mermaid') {
      return `<div class="md-mermaid" data-mermaid="${encodeURIComponent(text)}" contenteditable="false"></div>`
    }
    let html: string
    if (lang && hljs.getLanguage(lang)) {
      try {
        html = hljs.highlight(text, { language: lang }).value
      } catch {
        html = escapeHtml(text)
      }
    } else {
      html = escapeHtml(text)
    }
    // Typora 式：代码块保持高亮样式，点击后进入原位编辑（高亮层 + 透明输入层）。
    // 不渲染语言角标——contenteditable=false 节点会干扰光标与输入位置
    return `<pre class="code-wrap" data-lang="${escapeAttr(lang || '')}" data-code="${encodeURIComponent(text)}"><code class="hljs language-${escapeAttr(lang || '')}">${html}</code></pre>`
  },
  hr(): string {
    return '<hr contenteditable="false" />'
  },
  // Typora 式表格：单元格内容两侧的 | 标记符（视觉层，序列化时忽略）
  table(
    this: RendererThis,
    token: {
      header: { tokens: unknown[] }[]
      align: (string | null)[]
      rows: { tokens: unknown[] }[][]
    }
  ): string {
    const cellHtml = (tokens: unknown[], tag: 'th' | 'td', align: string | null): string => {
      const inner = this.parser.parseInline(tokens)
      const alignAttr = align ? ` align="${align}"` : ''
      const pipe = `<span class="md-meta md-cell-pipe" contenteditable="false">|</span>`
      return `<${tag}${alignAttr}>${pipe}${inner}${pipe}</${tag}>`
    }
    const thead = `<thead><tr>${token.header
      .map((c, i) => cellHtml(c.tokens, 'th', token.align[i] ?? null))
      .join('')}</tr></thead>`
    const tbody = `<tbody>${token.rows
      .map((row) => `<tr>${row.map((c, i) => cellHtml(c.tokens, 'td', token.align[i] ?? null)).join('')}</tr>`)
      .join('')}</tbody>`
    return `<table>${thead}${tbody}</table>`
  },
  link(
    this: RendererThis,
    { href, title, tokens }: { href: string; title?: string | null; tokens: unknown[] }
  ): string {
    const inner = this.parser.parseInline(tokens)
    const isExternal = /^https?:\/\//i.test(href)
    const target = isExternal ? ' target="_blank" rel="noopener"' : ''
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
    return `<a href="${escapeAttr(href)}"${target}${titleAttr}>${inner}</a>`
  },
  image({ href, title, text }: { href: string; title?: string | null; text: string }): string {
    const src = resolveImageSrc(href)
    const alt = escapeAttr(text)
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
    return `<img class="md-image" src="${escapeAttr(src)}" alt="${alt}" data-src="${escapeAttr(href)}"${titleAttr} loading="lazy" contenteditable="false" />`
  }
}

marked.use({ gfm: true, breaks: true })
marked.use({ extensions: [inlineMath, blockMath] })
marked.use({ renderer: customRenderer as unknown as import('marked').RendererObject })

// ─────────────────────────── TOC ───────────────────────────
function renderToc(headings: HeadingInfo[]): string {
  const items = headings
    .filter((h) => h.level <= 3)
    .map(
      (h) => `<a class="toc-l${h.level}" href="#${h.id}" data-heading-id="${h.id}">${escapeHtml(h.text)}</a>`
    )
    .join('')
  const empty = headings.length === 0 ? '<p class="toc-empty">—</p>' : ''
  return `<div class="md-toc" contenteditable="false"><span class="md-toc-title">TOC</span>${empty}${items}</div>`
}

// ─────────────────────────── 渲染入口 ───────────────────────────
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'contenteditable'],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick']
  })
}

/** 渲染单个块（含 [TOC] 处理） */
export function renderBlock(blockText: string, ctx: RenderCtx): string {
  activeCtx = ctx
  try {
    if (/^\s*\[TOC\]\s*$/i.test(blockText.trim())) {
      return renderToc(ctx.headings)
    }
    const html = marked.parse(blockText, { async: false }) as string
    return sanitize(html)
  } catch {
    return `<p>${escapeHtml(blockText)}</p>`
  }
}

/** 渲染完整文档（导出用） */
export function renderFull(content: string, ctx: RenderCtx): string {
  activeCtx = ctx
  try {
    const html = marked.parse(content, { async: false }) as string
    return sanitize(html)
  } catch {
    return `<p>${escapeHtml(content)}</p>`
  }
}

// ─────────────────────────── Mermaid ───────────────────────────
let mermaidPromise: Promise<typeof import('mermaid')> | null = null

function loadMermaid(): Promise<typeof import('mermaid')> {
  if (!mermaidPromise) mermaidPromise = import('mermaid')
  return mermaidPromise
}

async function initMermaid(theme: EffectiveTheme): Promise<typeof import('mermaid')> {
  const mod = await loadMermaid()
  mod.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
  })
  return mod
}

let mermaidSeq = 1

/** 将容器内的 data-mermaid 占位符异步渲染为 SVG */
export async function renderMermaidInContainer(container: HTMLElement, theme: EffectiveTheme): Promise<void> {
  const placeholders = Array.from(container.querySelectorAll<HTMLElement>('[data-mermaid]'))
  if (!placeholders.length) return
  let mod: Awaited<ReturnType<typeof initMermaid>>
  try {
    mod = await initMermaid(theme)
  } catch (err) {
    for (const ph of placeholders) {
      ph.innerHTML = `<pre><code>${escapeHtml('Mermaid 加载失败：' + String(err))}</code></pre>`
      ph.classList.add('mermaid-error')
    }
    return
  }
  for (const ph of placeholders) {
    const code = decodeURIComponent(ph.dataset.mermaid || '')
    try {
      const { svg } = await mod.default.render(`mmd-${mermaidSeq++}`, code)
      // 插入 SVG 但保留占位容器与 data-mermaid（序列化器需要还原源码）
      ph.innerHTML = sanitize(svg)
      ph.classList.add('rendered')
    } catch {
      ph.innerHTML = `<pre><code>${escapeHtml(code)}</code></pre>`
      ph.classList.add('mermaid-error')
    }
  }
}

/** 导出前：把 html 字符串里的 mermaid 占位符替换为 SVG */
export async function renderMermaidInHtml(html: string, theme: EffectiveTheme): Promise<string> {
  if (!html.includes('data-mermaid')) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const container = doc.body
  await renderMermaidInContainer(container as unknown as HTMLElement, theme)
  return container.innerHTML
}
