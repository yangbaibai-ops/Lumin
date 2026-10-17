// ─── 代码块语言：预设清单、别名解析、过滤与启发式识别（纯函数）──────────────────
//
// 为什么单独成模块：`CodeBlockView.vue` 是 NodeView（Vue + CodeMirror + mermaid），
// 而「用户输入的语言名解析成哪个高亮包」「一段没有语言的代码该识别成什么」是**纯逻辑**。
// 抽出来之后 `tests/codeBlockLanguage.test.mjs` 能直接钉住行为（不需要 DOM），
// NodeView 只管渲染与交互。
//
// 语言名的口径（改之前先读）：
//   * `code` 节点的 `language` 属性里**原样保存用户/文档写的名字**（`ts` / `typescript` /
//     `zig` 都行），序列化时逐字写回围栏（见 codeBlock.ts 的 serializer）；
//   * 别名表只用于**解析**（决定用哪个 CodeMirror 语言包），绝不据此重写文档 ——
//     否则「用户输入 zig」会被改写成别的名字，往返就不忠实了；
//   * 解析不出高亮包的语言 = 纯文本（不报错），UI 只在选择器里标注「未内置高亮」。

/** 无语言 / 纯文本在界面上的显示名（不写进文档时用空串表示"无语言"） */
export const PLAIN_TEXT_LANGUAGE = 'text'

/**
 * 选择器里的常用语言预设（顺序即展示顺序）。
 *
 * 清单来自本轮需求：text, js, ts, vue, python, bash, json, css, html, markdown,
 * sql, go, rust, java, c, cpp, yaml, mermaid。其余语言不占用列表位置，
 * 但**可以手动输入**（例如 php / ruby / javascript 这些有内置高亮包的写法）。
 */
export const LANGUAGE_PRESETS = [
  'text',
  'js',
  'ts',
  'vue',
  'python',
  'bash',
  'json',
  'css',
  'html',
  'markdown',
  'sql',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'yaml',
  'mermaid'
] as const

/**
 * 有内置高亮包的语言键（与 CodeBlockView.vue 的 `LANGUAGE_LOADERS` 一一对应）。
 * 这里只列**键**，不 import 任何语言包 —— 模块要能在 Node 单测里直接跑。
 *
 * ⚠️ 特意没有 `markdown`：本仓的 `@codemirror/legacy-modes` 6.5.3 没有 markdown 模式，
 * 也不能为了它引新依赖。所以 `markdown` 预设是**合法但未内置高亮**的（纯文本 + 选择器里
 * 标注「未内置高亮」），而不是假装上色。
 */
const HIGHLIGHT_KEYS = new Set([
  'javascript',
  'typescript',
  'python',
  'html',
  'css',
  'json',
  'sql',
  'java',
  'go',
  'rust',
  'cpp',
  'php',
  'ruby',
  'yaml',
  'bash'
])

/**
 * 文档里常见的别名 → 高亮键（沿用原 `language-data` 认得的那些，外加 markdown 生态里
 * 常见的几个：`jsx/tsx/mjs/cjs`、`htm`、`yml`、`rb`、`golang`、`cxx/hpp`、`shell`）。
 *
 * 注意两个刻意的近似：
 *   * `vue` → `html`：单文件组件的主体是模板标记，用 HTML 高亮比纯文本有用；
 *   * `c` → `cpp`：CodeMirror 只有 C++ 包，它对 C 的关键字/注释/字符串覆盖得足够好。
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  htm: 'html',
  xhtml: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  'c++': 'cpp',
  c: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  golang: 'go',
  rb: 'ruby',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  sqlite: 'sql',
  md: 'markdown',
  plaintext: 'text',
  plain: 'text',
  txt: 'text',
  none: 'text'
}

/** 纯文本的别名（这些语言名合法，只是"不需要高亮"，不该提示"未内置"） */
const PLAIN_ALIASES = new Set(['text', 'plaintext', 'plain', 'txt', 'none'])

/** 文档属性里的语言名归一化：去掉首尾空白；非字符串（null/undefined）当"无语言" */
export function normalizeLanguageName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 这个语言名是不是"纯文本/无语言"（空串、text 及其别名） */
export function isPlainTextLanguage(raw: string): boolean {
  const key = raw.trim().toLowerCase()
  if (!key) return true
  if (PLAIN_ALIASES.has(key)) return true
  return LANGUAGE_ALIASES[key] === 'text'
}

/**
 * 语言名 → CodeMirror 高亮键（大小写不敏感）。
 * 返回 `null` 表示"没有内置高亮"（空串、text 系列、自定义语言如 `zig`）。
 */
export function resolveLanguageKey(raw: string): string | null {
  const key = raw.trim().toLowerCase()
  if (!key) return null
  if (isPlainTextLanguage(key)) return null
  if (HIGHLIGHT_KEYS.has(key)) return key
  const alias = LANGUAGE_ALIASES[key]
  if (!alias) return null
  if (alias === 'text') return null
  return HIGHLIGHT_KEYS.has(alias) ? alias : null
}

/**
 * 选择器里要不要给这个语言标「未内置高亮」。
 *
 * 三种情况**不**提示：空/纯文本（本来就不需要高亮）、mermaid（它渲染成图表，
 * 图表就是它的呈现方式）、有高亮包的别名（`typescript` / `c` 都能上色）。
 */
export function needsNoHighlightNotice(raw: string): boolean {
  const key = raw.trim().toLowerCase()
  if (!key) return false
  if (isPlainTextLanguage(key)) return false
  if (key === 'mermaid') return false
  return resolveLanguageKey(key) === null
}

/** 一个预设参与过滤时可以被匹配到的所有写法（自身 / 高亮键 / 指向它的别名） */
function searchTermsOf(preset: string): string[] {
  const terms = new Set<string>([preset.toLowerCase()])
  const key = resolveLanguageKey(preset)
  const canonical = key ?? preset.toLowerCase()
  terms.add(canonical)
  for (const [alias, target] of Object.entries(LANGUAGE_ALIASES)) {
    if (target === canonical) terms.add(alias)
  }
  return [...terms]
}

/**
 * 按输入过滤预设（大小写不敏感）。
 *
 * 排序：完全相等 → 前缀命中 → 包含命中；同档内保持预设顺序（稳定的肌肉记忆）。
 * 空输入返回整份预设。**没匹配到的自定义语言由调用方另行追加**（见 CodeBlockView
 * 的 candidateItems），这里只负责"常用语言"这一半。
 */
export function filterLanguagePresets(query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...LANGUAGE_PRESETS]
  const scored: { preset: string; score: number; order: number }[] = []
  for (let i = 0; i < LANGUAGE_PRESETS.length; i++) {
    const preset = LANGUAGE_PRESETS[i]
    let score = Number.POSITIVE_INFINITY
    for (const term of searchTermsOf(preset)) {
      if (term === q) score = Math.min(score, 0)
      else if (term.startsWith(q)) score = Math.min(score, 1)
      else if (term.includes(q)) score = Math.min(score, 2)
    }
    if (Number.isFinite(score)) scored.push({ preset, score, order: i })
  }
  scored.sort((a, b) => a.score - b.score || a.order - b.order)
  return scored.map((s) => s.preset)
}

/**
 * 启发式识别时最多看前多少个字符。
 *
 * 为什么不扫全文：识别是"内容变化且无显式语言"时**防抖**跑的，而正文块可能有几十万字符；
 * 语言特征（首个 import / #include / SELECT / flowchart…）几乎都在开头。取 4000 字符
 * 既够覆盖一个正常代码块，又把单次识别成本钉成常数（1500 个块同时变内容也不会卡）。
 */
export const DETECT_SAMPLE_CHARS = 4000

/**
 * 内容 → 语言名（识别不出来返回 `null` = 保持纯文本）。
 *
 * ⚠️ 顺序就是优先级，改顺序会改变识别结果。几条容易踩的：
 *   * mermaid 先判：`graph TD` 里的 `graph` 不该被当成别的语言；
 *   * python 的 `# -*- coding` 要排在 markdown 的 `^#{1,6}\s` 前面；
 *   * json 的 `^{ "` 要排在 ts 的 `: string` 前面（`{"a": "x"}` 不是 TS 类型标注）；
 *   * css 的 `^\s*\.[\w-]+\s*{` 与 markdown 的 `[..](..)` 互不干扰，按需求给的顺序。
 *
 * 识别结果只用于**显示与高亮**，从不写回 `language` 属性 —— 所以「显式设置过的语言
 * 不会被自动识别覆盖」是结构性成立的：有显式语言时这段函数根本不会被调用。
 */
export function detectLanguage(source: string): string | null {
  const text = (source || '').slice(0, DETECT_SAMPLE_CHARS)
  if (!text.trim()) return null

  // 1) mermaid 家族（识别到就照旧走图表渲染）
  if (
    /(^|\n)\s*(flowchart|graph|sequenceDiagram|gantt|classDiagram|erDiagram|stateDiagram)\b/i.test(
      text
    )
  ) {
    return 'mermaid'
  }
  // 2) HTML / XML 类标记
  if (/<html\b|<div\b|<!DOCTYPE/i.test(text)) return 'html'
  // 3) Rust / Go：特征足够独特，必须排在 JS 前面 —— Rust 的 `let mut x` 会被
  //    「const/let/var」这条通用规则误判成 JS（需求的规则清单里两条都点了名，
  //    这里是"更specific的规则优先"，不是偏离需求）。
  if (/\bfn\s+main\b|\blet\s+mut\b/.test(text)) return 'rust'
  if (/\bfunc\s+\w+\s*\(|\bpackage\s+main\b/.test(text)) return 'go'
  // 4) TypeScript：import from / 类型标注 / interface（`const` 无类型则归 JS）
  if (
    /^\s*import\s+.*\s+from\s+/m.test(text) ||
    /:\s*(string|number|boolean)\b/.test(text) ||
    /\binterface\s+\w+\s*\{/.test(text)
  ) {
    return 'ts'
  }
  // 5) JavaScript：只有变量声明、没有类型标注
  if (/\b(const|let|var)\b/.test(text)) return 'js'
  // 6) Python：def / class ...: / coding 声明
  if (/\bdef\s+\w+\s*\(|^\s*class\s+\w+.*:/m.test(text) || /^\s*#.*coding/m.test(text)) {
    return 'python'
  }
  // 7) C / C++：先认出来，再按 C++ 专属特征细分
  if (/#include\b|\bprintf\s*\(|\bstd::/.test(text)) {
    return /std::|#include\s*<(iostream|vector|string|map|memory)>|using\s+namespace|template\s*</.test(
      text
    )
      ? 'cpp'
      : 'c'
  }
  // 8) JSON：对象/数组开头
  if (/^\s*\{\s*"|\[\s*\{/m.test(text)) return 'json'
  // 9) SQL（大小写不敏感）
  if (/\b(SELECT|INSERT\s+INTO|CREATE\s+TABLE)\b/i.test(text)) return 'sql'
  // 10) Shell：shebang 或常见命令开头
  if (/^#!\/bin\/(ba)?sh/m.test(text) || /^\s*(echo|export|sudo|apt-get)\b/m.test(text)) {
    return 'bash'
  }
  // 11) CSS：<style> / 类选择器 / @media / :root
  if (/<style\b|^\s*\.[\w-]+\s*\{|@media\b|:root\s*\{/m.test(text)) return 'css'
  // 12) Markdown：标题行或链接
  if (/^#{1,6}\s|\[.*\]\(.*\)/m.test(text)) return 'markdown'
  return null
}
