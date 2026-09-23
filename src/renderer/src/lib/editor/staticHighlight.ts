// ─── 静态态语法高亮（F 项 / O2 虚拟化的 P2「视觉不掉档」）───────────────────────
//
// 背景：虚拟化之后，没轮到挂 CodeMirror 的代码块渲染 `.cb-static`（等宽纯文本 + CSS 行号）。
// 于是「刚被滚出边距、CM 卸掉」的那一刻颜色会掉一下 —— 用户在快速滚动 / 程序化跳转
// （`scrollIntoView`、跳转到行）时可能正好看见。
//
// P2 的做法（施工图给的方向）：**用 Lezer 的 `highlightTree` 给静态态上色，不建 CM 实例**。
// 两个刻意的设计：
//   1. **不依赖 CM 的 StyleModule**。CM 的 `syntaxHighlighting(HighlightStyle)` 把生成的 class
//      挂在 StyleModule 上，而 StyleModule 随**最后一个**用到它的 CM 实例销毁而卸载 ——
//      拿 CM 的 class 名做静态态，就会出现「块都卸完 → 颜色集体消失」。所以这里自带一套
//      `lm-tok-*` class，颜色写进应用自己的 CSS（见 assets/overlays.css，用同一组 CSS 变量）。
//   2. **只给「语言已经加载过」的块上色**。解析器在块挂载时（`loadLanguage`）登记进来，
//      静态态只做「登记表里有就解析、没有就纯文本」——绝不为了给屏幕外的块上色去
//      `import()` 语言包（1500 个块的文档里那会变成几十次额外 chunk 加载）。
//
// 本模块是纯函数 + 一张登记表，有单测：`tests/staticHighlight.test.mjs`。
import { highlightTree, tagHighlighter, tags as t, type Highlighter } from '@lezer/highlight'
import type { Parser, Tree } from '@lezer/common'
// ⚠️ 相对导入要带 `.ts` 后缀：本模块被 `tests/staticHighlight.test.mjs` 直接 import
// （Node 原生类型剥离，不做裸路径解析）。仓里同样被单测直接 import 的模块都这么写。
import { escapeHtml } from '../utils/html.ts'

/**
 * 静态态的 token class（**与 CM 主题一一对应**，颜色在 assets/overlays.css 里）。
 *
 * 对应关系见 `CodeBlockView.vue` 的 `mdHighlight`（`HighlightStyle.define`）——
 * 改一边记得改另一边，否则「挂载态 → 静态态」切换会看到颜色变化。
 */
export const TOKEN_CLASS = {
  keyword: 'lm-tok-keyword',
  name: 'lm-tok-name',
  function: 'lm-tok-function',
  value: 'lm-tok-value',
  type: 'lm-tok-type',
  operator: 'lm-tok-operator',
  comment: 'lm-tok-comment',
  string: 'lm-tok-string',
  invalid: 'lm-tok-invalid'
} as const

/** tag → class 的规则表（顺序即优先级；与 `CodeBlockView.vue` 的 `mdHighlight` 一一对应） */
export const staticHighlighter: Highlighter = tagHighlighter([
  { tag: t.keyword, class: TOKEN_CLASS.keyword },
  {
    tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName],
    class: TOKEN_CLASS.name
  },
  { tag: [t.function(t.variableName), t.labelName], class: TOKEN_CLASS.function },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], class: TOKEN_CLASS.value },
  {
    tag: [
      t.typeName,
      t.className,
      t.number,
      t.changed,
      t.annotation,
      t.modifier,
      t.self,
      t.namespace
    ],
    class: TOKEN_CLASS.type
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    class: TOKEN_CLASS.operator
  },
  { tag: [t.meta, t.comment], class: TOKEN_CLASS.comment },
  { tag: [t.atom, t.bool, t.special(t.variableName)], class: TOKEN_CLASS.value },
  { tag: [t.processingInstruction, t.string, t.inserted], class: TOKEN_CLASS.string },
  { tag: t.invalid, class: TOKEN_CLASS.invalid }
])

/**
 * 把一段文本按语法树渲染成「带 token class 的 HTML」。
 *
 * **安全性**：文本自己走 `escapeHtml`，class 只可能来自上面的常量表（不含用户输入），
 * 所以结果是「转义过的文本 + 我们自己的 span 壳」，可以直接 `v-html`（组件里也有说明）。
 * 没有语法树（语言没加载过 / 认不出来的语言）时退化成纯转义文本 —— 与虚拟化之前的渲染一致。
 */
export function highlightToHtml(
  text: string,
  tree: Tree | null,
  highlighter: Highlighter = staticHighlighter
): string {
  if (!tree) return escapeHtml(text)
  let html = ''
  let pos = 0
  highlightTree(tree, highlighter, (from, to, classes) => {
    if (from > pos) html += escapeHtml(text.slice(pos, from))
    const cls = classes.trim()
    const chunk = escapeHtml(text.slice(from, to))
    html += cls ? `<span class="${cls}">${chunk}</span>` : chunk
    pos = to
  })
  if (pos < text.length) html += escapeHtml(text.slice(pos))
  return html
}

// ─── 解析器登记表 ────────────────────────────────────────────────────────────
// 只有「本会话真的加载过的语言」在表里。渲染静态块时查表：没有 ⇒ 纯文本（绝不 import）。
const parsers = new Map<string, Parser>()

/**
 * 登记一个语言的解析器（组件在 `loadLanguage` 里调用）。
 *
 * ⚠️ 这里**刻意不做成响应式**（不做「登记表一变就让所有静态块重算」）。试过那版：
 * 语言是懒加载的，解析器到位时全文档 1500 个静态块会**同时**重算 + 重渲染 ——
 * 实测 1500 围栏的文档「可用耗时」2695 → **3451ms**、RSS 924 → 1079MB，为了给
 * **屏幕外、用户根本看不到**的块上色，把打开文档这件事拖慢了一秒多、多吃一百多 MB。
 *
 * 现在的口径（组件的 `staticHtml` 配合 `wasMounted`）：**块挂载过才在静态态上色**。
 *   * 用户能看到的块永远处于挂载态（观察器有 600px 提前量）⇒ 看到的一直有颜色；
 *   * 滚过去的块保留颜色（卸下来时就已经登记了解析器）⇒ 「滚回去」不会掉色；
 *   * 从没露过面的块保持纯文本 —— 它本来就在屏幕外，而且省下一次全文档重渲染。
 */
export function registerStaticParser(key: string, parser: Parser): void {
  if (parsers.get(key) === parser) return
  parsers.set(key, parser)
}

export function hasStaticParser(key: string | null): boolean {
  return !!key && parsers.has(key)
}

/** 仅供探针/单测：当前登记了多少种语言 */
export function staticParserCount(): number {
  return parsers.size
}

/**
 * 文本 → 静态态 HTML。`key` 是 `resolveLanguageKey()` 的结果（null = 认不出来的语言）。
 * 语言没加载过时返回**纯转义文本**（不是为了省事：见文件头第 2 点，避免为屏幕外的块拉语言包）。
 */
export function staticHighlightHtml(text: string, key: string | null): string {
  const parser = key ? parsers.get(key) : null
  if (!parser) return escapeHtml(text)
  try {
    return highlightToHtml(text, parser.parse(text))
  } catch {
    return escapeHtml(text)
  }
}
