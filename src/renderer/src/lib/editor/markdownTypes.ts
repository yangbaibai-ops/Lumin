/**
 * tiptap-markdown / prosemirror-markdown 的**最小结构化类型声明**。
 *
 * 两个包都没导出序列化状态与节点的类型（`markdown.serialize` 的签名是 any），
 * 而我们又要写自定义序列化器（图片、代码围栏、列表标记），所以按用到的成员声明一份：
 * 比 `any` 安全，也不会被上游的类型细节变动打断编译。
 */

/** 序列化状态（prosemirror-markdown 的 MarkdownSerializerState 子集） */
export interface MarkdownSerializerStateLike {
  /** 输出缓冲（表格序列化靠它「先渲染一格、再把竖线转义」） */
  out: string
  /** 是否正在写表格：表格里的硬换行要写成 HTML `<br>`（否则表格被换行拆散） */
  inTable: boolean
  /** 追加文本（不转义） */
  write(text: string): void
  /** 按 Markdown 规则转义 */
  esc(text: string): string
  /** 追加文本（escape=false 时原样输出） */
  text(text: string, escape?: boolean): void
  /** 渲染一个节点的**行内**内容（不产生块级换行） */
  renderInline(node: unknown): void
  /** 保证当前行结束 */
  ensureNewLine(): void
  /** 结束一个块（写空行/换行，取决于是否在紧列表里） */
  closeBlock(node: unknown): void
  /** 渲染一个列表（delim 为续行缩进，firstDelim 给每个 item 的起始标记） */
  renderList(node: unknown, delim: string, firstDelim: (index: number) => string): void
  /** 结束上一个块：size=1 只断行，size≥2 补空行 */
  flushClose(size?: number): void
  /** 最近关闭的块：列表序列化靠它判断「同类型相邻」要不要空行分隔 */
  closed: { type: { name: string }; attrs?: Record<string, unknown> } | null
}

/** 序列化时的节点（只用到 attrs / textContent / type） */
export interface PMNodeLike {
  attrs: Record<string, unknown>
  textContent?: string
  type: { name: string }
}

/** markdown-it 渲染器规则（setup 钩子里改渲染器用） */
export type MarkdownItRendererRule = (
  tokens: MarkdownItToken[],
  idx: number,
  options: unknown,
  env: unknown,
  self: { renderToken(tokens: MarkdownItToken[], idx: number, options: unknown): string }
) => string

export interface MarkdownItToken {
  markup: string
  attrSet(name: string, value: string): void
}

/** markdown-it 实例（只用到 renderer.rules 与 inline.ruler） */
export interface MarkdownItLike {
  renderer: { rules: Record<string, MarkdownItRendererRule | undefined> }
}

/** 打补丁标记：markdown-it 的渲染器规则每次 parse 前都会被 setup 钩子拿到，别重复包装 */
export interface PatchedRule {
  __luminPatched?: boolean
}
