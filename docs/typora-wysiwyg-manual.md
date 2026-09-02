# Lumin 技术实现手册

## Typora 式所见即所得 Markdown 编辑器：原理、落地与演进路线

> 适用对象：接手或扩展本项目的工程师。本文档同时是一份「从零实现 Typora 式编辑器」的完整施工指南：
> 先讲透原理（第 1~3 章），再给出本项目踩过的坑与解法（第 4 章），然后是可以照做的分步实施计划（第 5 章），
> 最后是工程化与演进路线（第 6~7 章）。文中所有文件路径均指向本仓库实际代码。

---

## 目录

1. [总体设计与技术选型](#1-总体设计与技术选型)
2. [核心原理：如何在渲染结果里直接编辑](#2-核心原理如何在渲染结果里直接编辑)
3. [关键交互的实现细节](#3-关键交互的实现细节)
4. [实践坑位与解法（本项目实录）](#4-实践坑位与解法本项目实录)
5. [分步实施计划（从零到一）](#5-分步实施计划从零到一)
6. [工程化与质量保障](#6-工程化与质量保障)
7. [可扩展性路线图](#7-可扩展性路线图)
8. [附录](#8-附录)

---

## 1. 总体设计与技术选型

### 1.1 产品目标

Typora 的核心体验是三个关键词：

1. **实时渲染（Live Preview）**——输入 `# 标题` 后立刻看到大号标题，源码标记（`#`、`**`、`-`）消失，渲染样式即时呈现；
2. **所见即所得编辑（WYSIWYG）**——光标直接落在渲染结果里：在「标题」里改字、在「表格」里填单元格、在「代码块」里写代码，不需要跳回源码视图；
3. **无缝往返（Round-trip）**——文件始终是标准 Markdown 文本。渲染视图只是「视图」，真正的数据是 `.md` 源码，任何改动都能无损序列化回源码。

Lumin 在这三点之上增加了自己的产品形态：Electron 桌面应用、SQLite 文档库、全局搜索、大纲、导出。

### 1.2 为什么不能用 `contenteditable + 正则替换`

第一代 Markdown 编辑器（以及很多玩具实现）的做法是：一个 `contenteditable` 的 `div`，每次 `input` 事件后把纯文本重新跑一遍 Markdown 渲染，再整体替换 `innerHTML`。这条路有几个致命问题：

- **光标丢失/跳动**：整体替换 DOM 后浏览器无法把光标恢复到用户正在编辑的位置，中文输入法（IME）的组词状态也会被打断；
- **结构漂移**：`contenteditable` 的 DOM 是浏览器自由发挥的产物（`<div><br></div>` 满天飞），同一份 HTML 在不同浏览器里编辑行为不同；
- **无法表示复杂结构**：表格的单元格选区、列表的嵌套折叠、任务列表的勾选框，都需要超出「一段文字」的结构化操作；
- **渲染与数据脱节**：所见与文件内容之间隔着不可控的转换，做不到无损往返。

**结论：WYSIWYG Markdown 编辑器必须维护一棵「文档树」作为唯一数据源，DOM 只是这棵树的投影。** 这正是 ProseMirror 的设计。

### 1.3 业界主流方案对比

| 方案 | 内核 | 定位 | 代表产品 | 评价 |
|---|---|---|---|---|
| **ProseMirror + Tiptap** | 自研文档模型 + 事务系统 | 富文本/结构化编辑 | NYT、卫报、Atlassian Confluence、GitLab、Notion 的编辑底座 | 学术界出身（Marijn Haverbeke，CodeMirror 作者），模型最严谨，schema 可完全自定义，生态成熟 |
| Slate | React 组件树即文档树 | 高度自定义的 React 富文本 | Dropbox Paper 一脉 | 灵活但需要自己补大量基建（选区模型、协作、撤销），踩坑成本高 |
| Lexical | 自研节点系统 | Meta 出品的现代富文本 | Facebook/WhatsApp Web | 新、性能好，但 Markdown 序列化生态弱于 ProseMirror 系 |
| Milkdown | 包装 ProseMirror | 插件式 Markdown 编辑器 | 少数项目 | 理念好，社区规模与文档深度不及 Tiptap |
| CodeMirror 6 | 行级编辑器 | 代码编辑 | Chrome DevTools、JSFiddle | 不适合整篇 WYSIWYG 渲染，适合嵌入做代码块/源码视图 |
| Monaco | 行级编辑器 | 代码编辑 | VS Code | 体积大，同样不适合做文档 WYSIWYG |

**选型结论：Tiptap v3（ProseMirror 内核）**，理由：

1. **工业验证最充分**——ProseMirror 是富文本编辑器的事实标准内核，Notion、Confluence、GitLab 都在用；Tiptap 是它之上最成熟的开源封装（MIT 协议、Vue3 官方绑定）；
2. **schema 即能力**——文档结构由 schema 声明，所有行为（渲染、选区、键盘语义、序列化）都由 schema 推导，这正是「渲染结果可编辑」的结构性保证；
3. **生态组件齐全**——表格（`@tiptap/extension-table`）、任务列表、图片、占位符、`tiptap-markdown` 双向转换都是官方/半官方包，本项目几乎不用造轮子；
4. **可扩展路径清晰**——NodeView 机制可以把任意 React/Vue 组件（甚至整个 CodeMirror）嵌进文档流。

配套选型：`tiptap-markdown@0.9`（remark 系解析/序列化，支持表格、任务列表、tight list）、CodeMirror 6（代码块 NodeView）、KaTeX + Mermaid（公式/图表渲染）。

### 1.4 总体架构

```
┌─────────────────────────── Electron ───────────────────────────┐
│  Main 进程 (Node + Electron)                                    │
│  ├─ 文件系统 (fileOps) ─ 读写 .md 文件                           │
│  ├─ SQLite (node:sqlite DatabaseSync, WAL + FTS5 + kv 状态表)    │
│  │   ├─ documents 表：文档元数据 + 全文索引（增删改查）             │
│  │   └─ kv 表：设置(主题/语言/字体) + 工作区状态（JSON 持久化）    │
│  ├─ 自定义协议 lumin-file://（图片等本地资源，CSP 白名单）          │
│  └─ 导出管线 (mermaid 渲染 → HTML/PDF/Word/EPUB)                 │
│        ▲ contextBridge / window.luminAPI（preload 白名单桥）      │
│  Renderer 进程 (Vue3 + Pinia + Tailwind v4 + vue-i18n)           │
│  ├─ files store ─ 文件树/当前文档/自动保存（500ms 防抖写盘）        │
│  ├─ settings store ─ 主题/语言/字体（立即生效，250ms 防抖落 SQLite）│
│  ├─ editor store ─ Tiptap 实例/大纲/跳转                          │
│  ├─ TyporaEditor.vue ─ useEditor + EditorContent                │
│  │    ├─ extensions.ts ─ schema 扩展集装配                       │
│  │    ├─ inputRules.ts ─ #、-、- [ ]、表格 实时转换               │
│  │    ├─ keymap.ts ─ 分割线回车确认 / 标题行首退格降级             │
│  │    ├─ markers.ts ─ 光标感知标记符 (Decoration + PluginView)    │
│  │    ├─ codeBlock.ts + CodeBlockView.vue ─ CodeMirror NodeView  │
│  │    └─ 自绘选区气泡菜单（坐标钳制）                              │
│  └─ 序列化桥 markdownStorage.ts ─ getMarkdown(editor)            │
└──────────────────────────────────────────────────────────────────┘
```

数据流向（单向、防竞态；所有状态持久化落 SQLite，无 session 态）：

```
用户输入 → Tiptap 事务 → ProseMirror Doc（唯一数据源）
  → onUpdate 防抖 250ms → getMarkdown 序列化为 .md 文本
  → emit update:modelValue → files store 防抖 500ms → IPC → SQLite documents + 磁盘文件

主题/语言切换 → settings store 即时应用 DOM → 防抖 250ms → IPC → SQLite kv 表
```

---

## 2. 核心原理：如何在渲染结果里直接编辑

### 2.1 文档树：一切的基础

ProseMirror 把文档建模为一棵 **Node 树**（schema 声明合法结构）：

```
doc
├─ heading (level=1) ─ text "验收标题"
├─ paragraph ─ text "正文段落 " + text "加粗"（带 bold mark）+ text "。"
└─ bulletList (tight=true)
   └─ listItem
      └─ paragraph ─ text "第一项"
```

要点：

- **节点（Node）**是块级结构（doc/heading/paragraph/bulletList/listItem/table/codeBlock…），有 `type`、`attrs`（如 heading 的 level）、`content`；
- **标记（Mark）**是行内样式（bold/italic/link/code），附着在 text 节点上，不产生层级；
- **文本只能是叶子**——text 节点内不能有节点，这是与 DOM 最大的区别，也是结构稳定的根源；
- **位置（Position）**是「字符间隙」的编号：文档有 N 个字符就有 N+1 个合法位置。`doc.textBetween(a, b)` 取 a、b 之间的文本。

### 2.2 从 Markdown 到文档树（parse）

`tiptap-markdown` 内部用 remark 把 Markdown 解析成 mdast，再按 schema 映射成 ProseMirror Doc：

- `# 标题` → `heading(level=1)`；
- `**加粗**` → text 节点 + `bold` mark（`**` 字符被消费掉，**不进文档**）；
- `- 项` → `bulletList > listItem > paragraph`；
- 代码围栏 ` ```js ` → `codeBlock(attrs.language='js')`；
- 表格 → `table > tableRow > tableHeader/tableCell`。

**这是「源码标记消失」的第一层原因**：标记字符在解析阶段就被结构化了，渲染视图里根本没有 `#`、`**` 这些字符，只有带着 attrs/marks 的节点。

### 2.3 从文档树到 DOM（渲染视图）

每个 node/mark 类型的 spec 里声明 `toDOM()`（Tiptap 的 `renderHTML`），ProseMirror 据此构建 `contenteditable="true"` 的 DOM：

| 文档节点 | DOM | 样式来源 |
|---|---|---|
| `heading(level=1)` | `<h1>` | `style.css` `.md-preview h1`（1.95em、下边框） |
| `paragraph` | `<p>` | `.md-preview p` |
| `bulletList > listItem` | `<ul><li>` | `list-style: disc`——**圆点由浏览器原生渲染，不是字符** |
| `text + bold` | `<strong>` | `.md-preview strong` |
| `table > tableRow > tableCell` | `<table><tr><td>` | 边框、内边距、斑马纹 |
| `codeBlock` | NodeView 挂载的 `<div>.code-block-wrapper > CodeMirror` | 见 §3.4 |

这就是「所见即所得」的渲染层：**Markdown 语义 → 语义化 HTML → CSS 排版**。和浏览器渲染普通网页没有区别。

### 2.4 在渲染结果里编辑：事务（Transaction）管线

用户在这个 DOM 里输入、删除、回车，浏览器产生原生编辑行为。ProseMirror 通过 **DOM observer** 把这些变更翻译成 Step，组装成 Transaction，应用出新状态，再**增量**更新 DOM：

```
DOM 变更（浏览器）→ mutation observer → Step（replace/join/split/addMark…）
→ Transaction（steps + selection + meta）→ apply → 新 Doc + 新 Selection
→ diff 映射 → 最小 DOM patch
```

三个关键性质：

1. **schema 保证结构合法**——任何 Step 应用后都会校验 schema，非法结构被拒绝或规范化，所以 DOM 里永远出现不了「半截列表」「表格里冒出自由文本」这种脏结构；
2. **撤销/重做免费获得**——历史就是反转的 Step 序列；
3. **光标位置是文档位置**——选区不是 DOM Range，而是 `Selection(from, to)`，绑定文档树上的字符间隙。DOM 怎么重排，光标都锚定在文档内容上。

### 2.5 从文档树回到 Markdown（serialize）

反向过程：遍历 Doc，按 schema 把节点/标记还原成 Markdown 文本（`tiptap-markdown` 的 serializer）：

- `heading(level=2)` → `## ` + 文本；
- `bulletList` → `- ` 行（本项目配置 `bulletListMarker: '-'`）；
- tight list 不产生空行、loose list 项间空行（配置 `tightLists: true`）；
- `taskItem` → `- [ ] / - [x]`；
- `codeBlock` → ` ```js\n…\n``` `。

**无损往返是产品底线**：parse → 渲染 → 编辑 → serialize 必须稳定。这要求 schema 与 serializer 对同一结构有一致认识（§4.5 记录了几处不一致的坑）。

### 2.6 为什么这套架构「编辑不会出错」

- 内容只存在于一处（Doc），DOM 可以随时被整体重建而不丢数据、不丢光标（位置在文档上）；
- 所有修改走事务，schema 校验兜底，坏状态无法产生；
- 序列化器是纯函数：Doc → 文本，与 DOM 状态无关，因此「渲染错了」不会污染文件内容。

---

## 3. 关键交互的实现细节

### 3.1 Input Rules：源码标记的即时转换

Input Rule 是 ProseMirror 的正则触发机制：每次文本插入后，用正则匹配光标前的文本，命中就执行一个替换事务。

本项目在 `src/renderer/src/lib/editor/inputRules.ts`（`TyporaInputRules` 扩展）中注册：

| 输入 | 规则 | 结果 |
|---|---|---|
| `# ` | StarterKit 自带 `textblockTypeInputRule` | 段落 → `heading(level=1)` |
| `- ` | `wrappingInputRule` | 段落 → `bulletList > listItem` |
| `- [ ] ` | 自定义规则（`/^\[([ xX]?)\] $/`） | `bulletList` → `taskList` + 勾选框 |
| `1. ` | `wrappingInputRule` | 段落 → `orderedList` |
| `> ` | `wrappingInputRule` | 段落 → `blockquote` |
| ` ```js ` | StarterKit | `codeBlock(language='js')` |
| `| a | b |` | 表格扩展规则 | 创建 2 列表格 |
| `---` + 回车 | `TyporaKeymap`（Enter 键绑定） | `horizontalRule`（**回车确认式**，见下） |
| `**加粗**`、`` `代码` `` | 成对标点规则 | 自动应用 mark |

**分割线为什么是「回车确认式」**：Typora 里输入 `---` 并不会立刻变成横线——否则 `---你好` 这类文本根本无法输入。正确语义是：整段内容恰好为 `---`/`***`（可带尾随空格）且光标在段尾时，**按 Enter 才转换**。实现要点：

1. 通过 `StarterKit.configure({ horizontalRule: false })` 关闭 StarterKit 自带的即时输入规则，再独立注册 `HorizontalRule.extend({ addInputRules: () => [] })`——只保留节点与渲染，去掉即时转换（`src/renderer/src/lib/editor/extensions.ts`）；
2. 在 `TyporaKeymap` 扩展里绑定 Enter：条件为「空选区 + 父块是 paragraph + 光标在段尾 + 文本匹配 `/^(-{3,}|\*{3,})\s*$/`」，满足则用事务把整段替换为 `[horizontalRule, 新空段落]`，光标落在新段落（`src/renderer/src/lib/editor/keymap.ts`）；
3. 顺带获得的正确性：`---你好` 按 Enter 只是普通换行，且序列化器会自动把它转义为 `\---你好` 写回文件，下次解析不会误判成分割线（CommonMark 转义规则，无损往返）。

实现要点（任务列表规则的教训）：

- 匹配正则在**光标前文本**上运行，`$` 前要留真实空格而不是 `\s`——否则回车产生的 `\n` 会误触发规则；
- 规则命中后不能依赖 core 回调给的 `range`（DOM 光标比状态选区领先 1 位），要自己用 `doc.descendants` 定位文本；
- **列表类型互转**（bulletList ↔ taskList）不能走 `deleteRange/replaceWith`（§4.2），本项目采用「重建顶层内容 + 整体 replace」的稳妥做法。

### 3.2 回车 / 退格 / 删除的列表与标题语义

Typora 的键盘手感由这套规则组成，StarterKit 的 listItem 扩展默认提供列表部分：

- **回车**：列表项内回车 → 分裂出新的同类列表项；连续两次空项回车 → 退出列表回到段落（`splitListItem` + `liftListItem` 的 keymap 组合）；
- **退格（列表行首）**：列表项第一段开头退格 → 把该项提为普通段落（`liftListItem`）；空项再退格 → 变为文本/段落；
- **删除（行尾）**：光标在项尾且下一项紧跟 → 合并两个列表项；
- **Tab / Shift+Tab**：嵌套/提升列表层级（`sinkListItem`/`liftListItem`）。

**标题行首退格（本项目自研语义，`TyporaKeymap`）**：光标位于标题第一个字前（含空标题）按 Backspace → 整行**取消标题格式**（降级为段落，内容保留），而不是默认的 `joinBackward` 并入上一行——后者正是「按退格跑到上一行、还改变上一行层级」bug 的根源。实现：

```ts
Backspace: ({ editor }) => {
  const { $from, empty } = editor.state.selection
  if (!empty) return false
  if ($from.parent.type.name !== 'heading') return false
  if ($from.parentOffset !== 0) return false
  return editor.chain().focus().setParagraph().run()
}
```

**键盘优先级（关键坑）**：Tiptap v3 把每个扩展的 `addKeyboardShortcuts` 变成独立 keymap 插件，按扩展 `priority`（默认 100）降序执行，先返回 true 的绑定胜出。core 的 Enter/Backspace（`splitBlock`/`joinBackward` 链）默认优先于一般用户扩展，因此自定义键盘语义的扩展必须显式设置 `priority: 200`（`TyporaKeymap` 即是），否则拦截永远不会生效；条件不匹配时返回 false 交还后续绑定，不影响其他按键行为。

本项目验收矩阵（`tools/verify-tiptap.js`）覆盖：`task-enter-semantics`（任务列表回车语义）、`heading-backspace-unheading`（标题行首退格降级且不影响上一行）、`hr-enter-rule`（分割线回车确认）。

### 3.3 光标感知标记符（源码的「浮现」）

Typora 的招牌细节：光标进入一个块或行内样式时，该处的 Markdown 源码标记以淡色浮现（标题前的 `#`、引用前的 `>`、加粗两端的 `**`），光标离开即消失。实现分两层（`src/renderer/src/lib/editor/markers.ts` + `style.css`）：

**块级**（heading/blockquote/listItem）：

1. `typoraMarkersPlugin` 用 `Decoration.node` 在选区所在块的 DOM 上挂 `md-reveal` 类（注意：本 PM 版本装饰的 `pos` 必须用 `descendants` 回调给的 0-based `contentPos`，且要传 `parent` 以判断容器）；
2. CSS 生成内容画出标记：`h1.md-reveal::before { content: '# ' }`、`blockquote.md-reveal > p::before { content: '> ' }`。字符只存在于 `::before`，文档内容里没有，序列化零影响。

**行内级**（bold/italic/strike/code）：

1. `PluginView.update` 在每次选区变化时扫描 `posAtDOM` 范围，选区与样式相交则给 `strong/em/s/code` 元素挂/摘 `md-reveal-inline` 类；
2. CSS：`strong.md-reveal-inline::before/::after { content: '**' }`。

> **列表圆点的教训**：曾让 `li.md-reveal { list-style: none } + ::before{content:'- '}` 把圆点替换成 `-`，导致输入 `- ` 后用户看到的是减号而不是圆点。**Typora 的正确行为是圆点始终显示**（圆点是浏览器渲染的 `list-style: disc`，不是字符），列表项不做标记替换。详见 §4.7 与本次修复记录。

### 3.4 代码块：NodeView 内嵌 CodeMirror 6

`pre > code` 这种内容可编辑但有特殊语义的节点，ProseMirror 提供 **NodeView** 机制：把节点 DOM 的渲染和事件完全交给自定义对象/组件。

本项目 `src/renderer/src/lib/editor/codeBlock.ts`：

```ts
export const CodeBlockCM = CodeBlock.extend({
  addNodeView: () => VueNodeViewRenderer(CodeBlockView)
})
```

`CodeBlockView.vue` 在挂载时创建一个 CodeMirror 6 实例（带语言包高亮），并把 PM 文档与 CM 状态同步：

- PM → CM：`update` 时若外部内容变化，用 `cm.dispatch` 整体替换（保持光标）；
- CM → PM：CM `updateListener` 把新文本写回 `node.textContent`，触发 PM 事务。

**焦点管理的两个坑**（均已修复）：

1. CodeMirror 的 contentDOM 默认没有 `tabindex`，点击/聚焦不进 CM——挂载后必须 `cmView.contentDOM.tabIndex = 0`；
2. PM 的 `updateSelection → view.focus()` 会在每次选区变化时抢焦点，导致在 CM 里点一下光标立刻弹回 PM——在 CM 容器上挂 `@mousedown.stop @pointerdown.stop` 阻断事件冒泡。

**Mermaid**：`codeBlock(attrs.language='mermaid')` 走同一 NodeView 的另一分支——动态 `import('mermaid')` 渲染 SVG（`.mermaid-render`），双击切换回源码 `<textarea>` 编辑。

### 3.5 表格

`@tiptap/extension-table` 提供 `table/tableRow/tableHeader/tableCell` 节点与 CellSelection（单元格矩形选区）。配置 `resizable: false`（拖拽改列宽体验差且与 Typora 观感不符）。表格内 Tab 移动单元格、回车换行由扩展 keymap 提供。

### 3.6 任务列表

`TaskList + TaskItem(configure({ nested: true }))`。`taskItem` 渲染 `li[data-checked] > label > input[type=checkbox] + div`；checkbox 点击经扩展内部处理为 `toggleTaskItemChecked` 事务（改 `checked` attr），CSS 用 `:has()`/伪元素画自定义勾选框（`style.css` 594~624 行）。序列化为 `- [x]` / `- [ ]`。

### 3.7 图片与链接

- 图片：`Image` 扩展 `inline: false`，`renderHTML` 统一把相对路径转 `lumin-file://` 协议（Electron 自定义协议，CSP 白名单内）；
- 链接：`link: { openOnClick: false }`——点击不跳转（编辑态），配合自绘菜单的「链接」按钮设置/清除链接；`autolink: true` 自动识别 URL。

### 3.8 选区浮动菜单（气泡菜单）

Tiptap v3 官方已无 Vue 版 BubbleMenu 组件，本项目自绘（`TyporaEditor.vue`）。要点：

1. **触发**：`onSelectionUpdate` 中 `selection.empty` 为假时定位显示；
2. **坐标**：`view.coordsAtPos(from/to)` 返回**视口坐标**，减去气泡的**定位上下文**（`.typora-container`，`position:relative`）的 `getBoundingClientRect()`，得到容器相对坐标；气泡 `absolute + transform: translateX(-50%)` 居中于选区、位于其上方 44px；
3. **坐标系教训**：最初用 `ed.view.dom`（`.ProseMirror`）的 rect 做参考系——它和定位上下文之间隔着 `px-6/pt-10` 内边距，气泡整体偏左 24px；滚动后还漂移。**必须用定位上下文自己的 rect**；
4. **视口钳制**：`coordsAtPos` 在选区滚出可视区时返回视口外坐标。若选区完全离开容器可视范围则隐藏气泡；部分可见时把 top/left 钳制在容器内（`top >= 8`、`left ∈ [8, width-8]`），气泡绝不渲染到窗口外；
5. **滚动跟随**：`onScroll` 里补一次重新定位；
6. **焦点保持**：容器挂 `@mousedown.prevent`，点按钮不抢编辑器焦点、选区不塌缩。

### 3.9 多语言与多主题架构

**多语言（vue-i18n）**：

- 词条按语言分文件（`src/renderer/src/i18n/locales/zh-CN.json` / `en-US.json`），`createI18n({ legacy: false, fallbackLocale: 'en-US' })`——composition API 模式（模板里 `$t()` / 脚本里 `useI18n()`）；
- `setLanguage(lang)` 同时切换 i18n locale 与 `<html lang>`；
- UI 文案全部走词条，**编辑器文档内容绝不经过 i18n**（文档是用户数据，不是 UI 文案）——这条边界是解耦的关键。

**多主题（CSS 变量 + Tailwind dark 变体）**：

- 主题是四个值之一：`light | dark | sepia | auto`（`auto` 跟随系统 `prefers-color-scheme`，由 settings store 的 `effectiveTheme` getter 解析）；
- 主题落地为 `<html>` 上的 `theme-{name}` 类 + Tailwind 的 `dark` 类（dark 变体工具类可用）；所有颜色经 CSS 变量间接引用（`--accent/--edge/--ink/--elevate/--panel-2…`），每个主题只换变量定义——组件样式零感知；
- 主进程同步 `nativeTheme.themeSource`，窗口 `backgroundColor` 按主题预置，避免启动闪白；
- 主题/语言切换即 `settings.set()`：立即 `applyAll()` 生效，250ms 防抖后经 IPC 落 **SQLite kv 表**（重启后保持，非 session 态）。

### 3.10 Tailwind v4 样式分层与动效

本项目已集成 Tailwind v4（`@tailwindcss/vite` 插件 + `@import "tailwindcss"`），样式体系分三层，职责清晰：

| 层 | 载体 | 职责 |
|---|---|---|
| 原子层 | Tailwind 工具类 | 应用壳层布局（侧栏/工具栏/弹窗）的间距、尺寸、布局、dark 变体 |
| 语义层 | CSS 变量 | 主题色板（`--accent/--edge/--elevate…`），四个主题在此切换 |
| 内容层 | `.md-preview` 手写规则 | 编辑器文档排版（标题/列表/表格/代码/分割线…），与 Typora 观感对齐 |

**动效策略**（简约、合理、可访问）：

- 高频交互用 120~180ms 的 CSS transition（按钮 hover、侧栏折叠、主题切换、气泡弹入）——不做花哨动画，避免打断写作流；
- 进出场用 Vue `<Transition>`（气泡菜单 `pop`、模态 `fade/zoom`）；
- 动效全部收敛在 `transition-*` 与 `@media (prefers-reduced-motion: reduce)` 降级之内，减少动效敏感用户的干扰；
- 编辑器内容本身零动画（渲染稳定优先，防抖序列化与布局抖动风险最低）。

### 3.11 公式与图表

- **KaTeX**：在 `tiptap-markdown@0.9` 未开放自定义 parser/serializer 前，公式渲染走「渲染视图内识别 `$…$` 文本 → 挂 KaTeX 组件」的渐进路径（本项目暂缓，列入路线图 §7.1）；
- **Mermaid**：已落地，见 §3.4。

---

## 4. 实践坑位与解法（本项目实录）

这一章是本手册最有价值的部分：以下每个坑都在本项目开发中真实发生过，并留有对应代码与验收断言。

### 4.1 位置语义：packed position 与 contentPos

- **本 PM 版本的位置是「紧凑」的**：`doc.content.size === Σ child.nodeSize`，顶层子节点之间**没有** `+1` 的间隙。实测 `[h1(5), p(4), taskList(6), p(2)]` 的 `content.size = 17`。
- `descendants` 回调的 `pos` 是 0-based `contentPos`，**转绝对位置要 `+1`**（`outline`、`inputRules` 里都是这么用的）；
- **光标落点算术必须用 packed 偏移**：任务列表转换后的插入点 = `1 + Σ 前置兄弟.nodeSize + 1 + Σ 前置转换项.nodeSize + 1`（`inputRules.ts` 的实现），任何一个 `+1` 间隙假设都会让光标落到错误块。

### 4.2 替换原语对列表类型转换的敌意

把 `bulletList` 原地改成 `taskList` 时，逐个试过并**全部失败**的路径：

| 原语 | 失败方式 |
|---|---|
| `tr.deleteRange(from, to)` | `deleteRange(4,7)` 实际删掉 `[5,7)`——replaceStep 的 Fitter 会挪动 textblock 边界 |
| `tr.replace / replaceWith / delete` | 同样经 replaceStep，深度不匹配时抛 "Inconsistent open depths" |
| 原始 `ReplaceStep` / `Fragment.replace` | 抛 "Inconsistent open depths" |
| `ReplaceAroundStep` | "Content does not fit in gap"——旧 listItem 塞不进 taskList 的 gap |
| `tr.replaceRange` | 不报错但把 taskList 整个丢掉 |

**最终解法（已落地在 `inputRules.ts`）**：不原地改结构，而是**重建整层内容再整体替换**：

```ts
// 1. 遍历 doc 顶层 children，把目标 bulletList 替换为等价 taskList（递归转换 listItem）
// 2. 用 PACKED 偏移构造新 Fragment
tr.replace(0, doc.content.size, new Slice(Fragment.fromArray(children), 0, 0))
```

`Slice(0,0)` 满足 `fitsTrivially`，`replace` 走精确 ReplaceStep，schema 校验一次性通过，光标位置随后用 packed 偏移重算，`TextSelection.create` 显式放置。

> 通用经验：**PM 的替换原语面向「同构结构内的编辑」**；跨类型的结构性转换（bullet↔task、段落↔标题组）优先「重建 + 整体 replace」，而不是指望切片原语自动适配。

### 4.3 resolve 与选区的边界行为

- `resolve(n)` 落在节点开头时会**一路下降到最深叶子**：`[h1(5), p(4), taskList(6), p(2)]` 里 `resolve(12)` 给 paragraph（depth 3）、`resolve(13)` 给 taskItem、`resolve(14)` 给 taskList、`resolve(15)` 给 doc；
- 空 textblock 的内部位置解析到外层节点——判断「光标在哪个块」要同时看 `$from.parent` 和 `$from.depth`；
- `TextSelection.near` 会把光标从空段落「弹」出去（4→7 之类）——需要精确落点时用 `TextSelection.create(doc, pos)`（本项目任务列表转换后的光标就是这么放的）。

### 4.4 焦点管理

- PM 与 CodeMirror 的焦点争夺（§3.4）：`contentDOM.tabIndex = 0` + `@mousedown.stop @pointerdown.stop`；
- 气泡菜单 `@mousedown.prevent` 防止点按钮时编辑器失焦、选区塌缩（§3.8）；
- CDP 自动化测试时，`visibilityState === 'hidden'` 的窗口会丢弃可信输入事件——测试前必须把窗口真正置前（`tools/run-verify.ps1` 的 user32 调用）。

### 4.5 序列化一致性

- **tight/loose list**：`tightLists: true` 时 serializer 决定项间空行，与解析器必须对称，否则「打开→保存」会漂移；
- **taskItem**：v3 的 `taskItem` 没有 `data-type` 属性（早期版本有），CSS 选择器与测试断言都不要依赖它；勾选状态在 `li[data-checked]` 上；
- **代码围栏语言**：`codeBlock(attrs.language)` 必须进 serializer 的 fence info，否则 `js` 语言丢失；
- **HTML 与换行**：`html: true, breaks: true` 意味着源码里的行内 HTML 会进渲染视图——这是有意的（Typora 同样支持），但导出 HTML 前要统一处理。

### 4.6 数据竞态：文件切换时的回写覆盖

场景：切文件时旧编辑器实例销毁，`blur/flushSync` 把旧文档内容写回当前文件槽——新打开的文档被旧内容覆盖。

解法（`TyporaEditor.vue`）：

1. `unmounting` 标志位：`onBeforeUnmount` 置位，`flushSync` 开头检查，卸载中的旧实例禁止回写；
2. 窗口级关闭走 `beforeunload` 监听单独 flush（不参与文件切换）；
3. 外部同步守卫：`watch(modelValue)` 里先比较 `getMarkdown(editor)` 与传入值，**不一致才 `setContent(nv, { emitUpdate: false })`**，避免 `setContent` 触发 onUpdate 造成回环与光标重置。

### 4.7 装饰/类名残留与列表圆点（本次修复）

- 本 PM 视图移除行内 `Decoration` 时会留下孤儿 `<span class="md-reveal-inline">`（`patchOuterDeco/patchAttributes` 对 text 节点失效）→ 行内标记改为 PluginView 直接管理类名（§3.3）；
- `Decoration.node` 校验用 0-based `content.findIndex`，装饰 pos 传绝对位置会挂；
- **列表圆点**：`li.md-reveal { list-style: none } + ::before{content:'- '}` 会把圆点换成减号。Typora 语义是：圆点由 `ul` 的 `list-style: disc` 始终渲染，`- ` 只存在于源码与序列化里。已移除替换规则（`li.md-reveal { list-style: inherit }`），验收断言 `bullet-input-rule` 持续守护。

### 4.8 气泡菜单的坐标系与视口钳制（本次修复）

见 §3.8 第 3、4 条：参考系必须用定位上下文 rect；`coordsAtPos` 可能返回视口外坐标，必须钳制/隐藏，否则气泡出现在选区左侧 24px、甚至窗口外（表现为「点击按钮无效」）。

### 4.9 键盘语义优先级与「回车确认式」转换（本次修复）

- **core keymap 抢占**：Tiptap v3 每个扩展的 keymap 是独立插件，按扩展 `priority` 降序执行、先返回 true 者胜。core 的 Enter（`splitBlock`）与 Backspace（`joinBackward`）链默认优先于一般用户扩展——自定义键盘语义（标题退格降级、分割线回车确认）必须 `priority: 200`，否则拦截静默失效（详见 §3.2）；
- **即时转换的误伤**：分割线输入规则 `---` 即时生效会让 `---你好` 无法输入。有歧义的语法（`---` 既是分割线又是普通文本）应采用**回车确认式**转换：关闭即时输入规则（`horizontalRule: false` + 独立注册空输入规则的 HR 节点），改由 Enter 键绑定判断「整段恰为标记」后转换；
- **转义回写**：`---你好` 这样的段首横线文本在序列化时会被转义为 `\---你好`，保证下次解析不误判——这是 CommonMark 往返正确性的一部分，验收断言 `hr-text-kept` 直接守护。

---

## 5. 分步实施计划（从零到一）

> 每一节对应本项目的一个真实完成阶段，含目标、关键实现、验收标准。标注 ✅ 的均已在本仓库落地并通过验收矩阵。

### 步骤 0：脚手架（✅）

- **目标**：electron-vite + Vue3 + TS + Tailwind v4 的工程骨架，主/preload/渲染三进程分离。
- **实现**：`electron-vite` 模板；`src/main`、`src/preload`、`src/renderer` 三层；`contextBridge` 暴露 `window.luminAPI`；`lumin-file://` 自定义协议；CSP meta。
- **验收**：`npm run typecheck`、`npm run build` 零错误；`npm run dev` 出窗口。

### 步骤 1：SQLite 文档库与应用状态库（✅）

- **目标**：文档元数据 + 全文搜索 + 防抖持久化 + **应用状态持久化（设置/工作区）**。
- **实现**：`src/main/services/database.ts`——`node:sqlite` 的 `DatabaseSync`（Electron 内置，零原生依赖）；`PRAGMA journal_mode = WAL` + `synchronous = NORMAL`；FTS5 trigram 分词器（中日韩子串匹配）+ LIKE 兜底；`documents` 表完整增删改查（upsert/get/delete/rename/touchOpened/setPinned/setTags）；**`kv` 键值表**（`kvGet/kvSet/kvHas/kvDelete`，JSON 序列化）承载设置与工作区状态；`files` store 500ms 防抖写盘。
- **迁移**：`migrateLegacyStores()` 在 `app.whenReady` 时把历史 electron-store 数据一次性种入 kv（kv 已有数据则跳过），electron-store 此后仅作为迁移源保留。
- **验收**：`sqlite-search` / `sqlite-content-match`（phase C）、`settings-sqlite-persist`（phase E，IPC 写入后回读一致）。

### 步骤 2：编辑器内核装配（✅）

- **目标**：能渲染 Markdown 的 Tiptap 实例。
- **实现**：`extensions.ts` 按 §1.3 装配：StarterKit（`codeBlock:false`、link 不点击跳转）+ Image + Table 全家 + TaskList/TaskItem + Placeholder + CodeBlockCM + TyporaInputRules + Markdown 双向转换 + TyporaMarkers。
- **验收**：打开 `.md` 文件后 `h1/strong/em/blockquote/ul/ol/table/checkbox/codemirror/mermaid` 全部渲染，`no-raw-markdown`（verify phase A 的 15 项断言）。

### 步骤 3：Markdown 双向桥（✅）

- **目标**：文件内容 ↔ 文档树无损往返。
- **实现**：`markdownStorage.ts` 的 `getMarkdown(ed)` 封装 `editor.storage.markdown.getMarkdown()`；`watch(modelValue)` 不一致才 `setContent(…, { emitUpdate: false })`。
- **验收**：`roundtrip-markdown`、`cm-sync-to-md`、`file-save`（verify phase B/C）。

### 步骤 4：WYSIWYG 渲染样式（✅）

- **目标**：Typora 式排版（最小块样式、无活跃块背景/色条）。
- **实现**：`style.css` 三层样式体系（§3.10）——Tailwind 原子层负责应用壳层、CSS 变量语义层负责四主题色板、`.md-preview` 内容层负责文档排版（标题/引用/列表/表格/代码/链接/hr/图片/任务列表自定义勾选框）；分割线为 1px 通栏实线（`background: var(--edge)`，随主题自动换色），点击可选中（`ProseMirror-selectednode` 描边）。
- **验收**：视觉检查 + phase A 渲染断言。

### 步骤 5：Input Rules 与键盘语义（✅）

- **目标**：`# `、`- `、`- [ ] `、`> `、` ``` `、表格即时转换；`---`/`***` + 回车确认式分割线；回车/退格/删除的 Typora 手感（列表 + 标题降级）。
- **实现**：`inputRules.ts`（任务规则用「重建 + 整体 replace」）+ `keymap.ts`（`TyporaKeymap`，priority 200：Enter→分割线、Backspace→标题降级）+ StarterKit 内建 keymap。
- **验收**：`heading-input-rule`、`bullet-input-rule`、`task-input-rule`、`task-enter-semantics`（phase B）、`hr-not-immediate`、`hr-enter-rule`、`hr-text-kept`、`heading-backspace-unheading`（phase E）。

### 步骤 6：光标感知标记符（✅）

- **目标**：光标进入块/样式时源码标记淡色浮现，离开即消失。
- **实现**：`markers.ts`（块级 Decoration.node + 行内 PluginView 类管理）+ `style.css` 的 `md-reveal*` 规则。
- **验收**：`heading-marker-hide-on-exit`、`bold-marker-reveal/hide-on-exit`（verify phase B）。

### 步骤 7：代码块 NodeView（✅）

- **目标**：代码块内嵌 CodeMirror 6（高亮/编辑/围栏保持），mermaid 代码块渲染 SVG。
- **实现**：`codeBlock.ts` + `CodeBlockView.vue`；焦点管理两件套（§3.4）。
- **验收**：`codemirror-mounted`、`codemirror-edit`、`cm-fence-kept`、`mermaid-svg`（verify phase A/C）。

### 步骤 8：选区气泡菜单与工具栏（✅）

- **目标**：选中文字弹出格式菜单（加粗/斜体/下划线/删除线/行内代码/链接/清除格式）。
- **实现**：`TyporaEditor.vue` 自绘气泡；定位上下文 rect + 视口钳制 + 滚动跟随（§3.8）。
- **验收**：`bubble-menu-visible`、`bubble-bold-applied`、`bubble-stays-open`（verify phase D）。

### 步骤 9：数据持久化管道（✅）

- **目标**：输入 → 250ms 防抖序列化 → 500ms 防抖写盘 → SQLite 落库；blur/beforeunload 立即 flush。
- **实现**：`TyporaEditor.vue` 的 `onUpdate` 防抖 + `files` store 写盘 + `unmounting` 守卫（§4.6）。
- **验收**：`file-save`、`reopen-persists-render`（verify phase C）。

### 步骤 10：设置持久化与多语言多主题（✅）

- **目标**：主题/语言/字体等设置即时生效、重启保持；多语言词条体系、四主题切换。
- **实现**：`settings store`（`set()` 立即 `applyAll()`，250ms 防抖 `persist()`）；IPC `settings:getAll/update`（深度合并）落 SQLite kv 表；`vue-i18n` 词条分文件 + `setLanguage`；主题经 `theme-*`/`dark` 类与 CSS 变量切换（§3.9）。
- **验收**：`theme-switch`（phase D）、`settings-sqlite-persist`（phase E）。

### 步骤 11：大纲与侧栏（✅）

- **目标**：文档标题树、滚动联动、点击跳转。
- **实现**：`stores/editor.ts` 用 `doc.descendants` 扫描 heading（`contentPos+1` 转绝对位置）；`Outline.vue` 渲染；`onScroll` 联动 activeHeading。
- **验收**：`outline-populated`、`outline-pos-valid`（verify phase A）。

### 步骤 12：导出 HTML/PDF/Word/EPUB（✅）

- **目标**：导出带样式、含渲染后 mermaid 图表的单文件 HTML。
- **实现**：`lib/export.ts`（`exportCss` + `renderMermaidInHtml`）+ `composables/useExport.ts`。
- **验收**：`export-html-ready`（verify phase D）。

### 步骤 13：自动化验收矩阵（✅）

- **目标**：核心体验可回归。
- **实现**：`tools/verify-tiptap.js`（CDP 连接 `LUMIN_DEBUG_PORT=9222` 的窗口，`Runtime.evaluate` + `Input.dispatchKeyEvent/insertText` 驱动，45 项断言）+ `tools/run-verify.ps1`（user32 置前窗口）。
- **验收**：`45/45 PASS` 且 `console-errors: 0`。

---

## 6. 工程化与质量保障

### 6.1 类型与静态检查

- 双 tsconfig：`tsconfig.node.json`（main/preload）+ `tsconfig.web.json`（renderer，vue-tsc）；
- `npm run typecheck` 进 CI；`prettier` + `eslint` 统一风格；
- 扩展装配处的类型注意点：`@tiptap/extension-table` 无默认导出（具名导入）；v3 的 InputRule 是配置对象 API（从 `@tiptap/core` 导入 `InputRule`/`textblockTypeInputRule`）。

### 6.2 测试分层

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | vitest（预留） | 序列化器往返、字数统计、input rule 正则 |
| 集成 | 验证脚本直连页面 | 事务/选区/标记行为 |
| E2E | CDP（`verify-tiptap.js`） | 完整用户路径 + 持久化 + 搜索 + 导出 + 主题 |

CDP 测试的三个工程约束：窗口必须真实置前（否则可信输入被丢弃）；vite 启动期全量刷新会清掉页面桥接对象（每阶段 `ensureBridge`）；断言位置用 `textBetween` 逐位扫描而不是手算偏移。

### 6.3 性能策略

- 序列化只在防抖窗口末尾执行一次（250ms），不随每次击键跑全文档；
- SQLite 写盘 500ms 防抖 + WAL（读不阻塞写）；
- 大纲/字数统计用 `descendants` 单次遍历；
- CodeMirror 实例按代码块惰性创建，mermaid 动态 `import`。

### 6.4 安全基线

- 渲染进程无 Node 权限：`contextIsolation: true`、`nodeIntegration: false`、preload 白名单桥接；
- CSP 白名单 + `lumin-file://` 协议隔离本地资源；
- 打开文件只读自己的工作区根目录。

---

## 7. 可扩展性路线图

### 7.1 自定义块的统一范式（下一步最值得做）

本项目已验证：任何新块类型 = **四件事**：

1. **schema**：`Node.create` 声明节点与 attrs；
2. **解析**：tiptap-markdown 升级（0.10+ 开放自定义 parser/serializer）或自定义 Input Rule 从文本构建节点；
3. **渲染**：`renderHTML`（简单块）或 `addNodeView`（复杂块，如公式、图表、白板）；
4. **序列化**：serializer 把节点还原为 Markdown/扩展语法。

候选：KaTeX 数学块、警告块（`:::warning`）、脚注、内嵌 PDF、双链 `[[wiki]]`。

### 7.2 协同编辑

ProseMirror 的 Step 天然可序列化——接入 `y-prosemirror`（Yjs CRDT）即可获得实时协同 + 离线合并。架构上只需把 `dispatchTransaction` 的 Step 推给 Yjs 文档，其余（schema、序列化、渲染）零改动。这是选 ProseMirror 的长线红利。

### 7.3 产品能力清单（对标 Typora/Obsidian）

- 源码模式（CodeMirror 整文档视图，`Ctrl+/` 切换）——NodeView 已趟平 CodeMirror 嵌入路径；
- 焦点模式 / 打字机滚动；
- 图片拖拽粘贴 + 自动入库；
- 主题市场（CSS 变量体系已具备，`--accent/--edge/…`）；
- 移动端/平板触摸选择（PM 对 touch 有基础支持，需补触摸选区菜单）；
- 导出 PDF（HTML → Electron `webContents.printToPDF`）。

### 7.4 版本升级策略

- Tiptap v3 的 PM 依赖被重新打包（位置紧凑化、装饰校验等行为差异都来自这里）——**升级 Tiptap 版本时必须重跑全部验收矩阵**；
- `tiptap-markdown` 关注 0.10+ 的自定义 parser/serializer API，是 §7.1 的前置。

---

## 8. 附录

### 附录 A：目录结构（编辑器相关）

```
src/
├─ main/                        # Electron 主进程
│  ├─ index.ts                  # 窗口/协议/生命周期
│  ├─ ipc.ts / fileOps.ts / drafts.ts / export.ts / menu.ts
│  └─ services/database.ts      # SQLite (WAL + FTS5)
├─ preload/index.ts             # contextBridge → window.luminAPI
├─ shared/                      # 三进程共享类型
└─ renderer/src/
   ├─ components/editor/
   │  ├─ TyporaEditor.vue       # useEditor + 防抖序列化 + 气泡菜单
   │  └─ CodeBlockView.vue      # CodeMirror/Mermaid NodeView
   ├─ lib/editor/
   │  ├─ extensions.ts          # 扩展集装配
   │  ├─ inputRules.ts          # #、-、- [ ] 即时转换
   │  ├─ keymap.ts              # 分割线回车确认 / 标题行首退格降级
   │  ├─ markers.ts             # 光标感知标记符
   │  ├─ codeBlock.ts           # CodeBlock.extend(addNodeView)
   │  └─ markdownStorage.ts     # getMarkdown 桥
   ├─ stores/editor.ts          # 实例/大纲/activeHeading
   └─ assets/style.css          # .md-preview 渲染样式 + md-reveal 标记样式
tools/
├─ verify-tiptap.js             # 45 项 CDP 验收矩阵
└─ run-verify.ps1               # 置前窗口 + 执行验收
docs/typora-wysiwyg-manual.md   # 本文档
```

### 附录 B：关键依赖（package.json 实况）

- `@tiptap/vue-3`、`@tiptap/starter-kit`、`@tiptap/extension-table`、`@tiptap/extension-task-list`、`@tiptap/extension-task-item`、`@tiptap/extension-image`、`@tiptap/extension-placeholder`、`@tiptap/extension-underline`、`@tiptap/extension-horizontal-rule`、`@tiptap/pm` —— 均 `^3.31.0`
- `tiptap-markdown` `^0.9.0`（remark 系双向转换）
- `@codemirror/*` 六件套 `^6`
- `katex` `^0.18.5`、`mermaid` `^11.17.2`
- `electron` `^39.2.6`、`electron-vite` `^5.0.0`、`vite` `^7.2.6`、`vue` `^3.5.25`、`pinia` `^4.0.3`、`tailwindcss` `^4.3.3`、`typescript` `^5.9.3`

### 附录 C：验收矩阵速查

| 阶段 | 覆盖 |
|---|---|
| setup | 窗口可见、pinia 桥接、控制台零错误 |
| A | 15 项：打开文件 → 全格式渲染（标题/粗斜体/行内码/引用/列表/任务/表格/代码块/mermaid/无源码标记残留/大纲） |
| B | 10 项：Input Rules + 标记符浮现/隐藏 + 任务列表回车语义 + 往返一致 |
| C | 8 项：CodeMirror 编辑同步、围栏保持、文件保存、SQLite 落库搜索、重开渲染 |
| D | 10 项：表格单元格编辑、气泡菜单可见/加粗/保持、导出、主题切换、全局搜索 |
| E | 5 项：分割线回车确认（不即时转换/回车生效/`---你好` 保留与转义）、标题行首退格降级、设置 SQLite 持久化往返 |

运行方式：`$env:LUMIN_DEBUG_PORT='9222'; npm run dev` 后执行 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-verify.ps1`。

---

*本手册随代码演进持续更新；任何涉及编辑器内核的改动（扩展装配、标记、输入规则、序列化桥）都必须先跑通附录 C 的验收矩阵。*
