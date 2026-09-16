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
  addNodeView: () => VueNodeViewRenderer(CodeBlockView, {
    ignoreMutation: () => true,
    stopEvent: ({ event }) => ...
  })
})
```

`CodeBlockView.vue` 在挂载时创建一个 CodeMirror 6 实例（带语言包高亮），并把 PM 文档与 CM 状态同步：

- PM → CM：`watch(props.node.textContent)`——外部内容变化（同文件重开等）时 `setState` 整体重置（CM 状态与节点脱钩是隐性 bug 源）；
- CM → PM：CM `updateListener` 的 `docChanged` → `syncToNode()` 把文本写回 PM 节点。

**焦点管理（本项目最深的坑，五层防线）**：

1. **`stopEvent`**（官方机制）：CM 编辑器区域内的鼠标/键盘/输入事件全部 `stopEvent → true`——PM 的 `eventBelongsToView` 检查到此直接忽略（尤其 PM 的 click 处理器会无条件 `view.focus()` 并重置 DOM 选区，这是「光标被抢回标题位置」的元凶）；
2. **DOM 事件阻断**：容器上 `mousedown/mouseup/pointerdown/pointerup/dblclick/click` 全部 `.stop`；
3. **焦点钉扎 `pinCmFocus`**：冒泡阶段的 mousedown/mouseup/click 显式 `cmView.focus()` + 派发 `userEvent: 'select.pointer'` 的选择事务（`updateSelection(fromPointer=true)` 强制把 DOM 光标同步回 CM 状态选区——CM 自身的 `focus()` 对空光标不重设 DOM 选区），并 60ms 后重钉一次（兜住 PM focus 处理器 20ms 后的 `selectionToDOM` 回抢）；
4. **hasFocus 覆盖**：CM 聚焦期间令 PM 的 `view.hasFocus()` 返回 false，阻止 PM 的选区同步；
5. **Enter 专用捕获处理器**：`@keydown.capture` 拦截 Enter，用**视图自身 state 构建事务 + `setState` 整文档重建 + `requestMeasure()`** 插入换行——嵌套场景下 CM 的增量重绘（`docView.update`）与跨模块 `Transaction instanceof` 判定均不可靠，这是唯一验证稳定的路径。

> **快速连续回车的坑不在 CM 本身，而在 PM 侧的外部同步回路**——见 §4.11（blur 提前 emit 旧快照 → store 回流 → `setContent` 回滚整文档的完整链条）。修好后 18 次连发（含 15ms 按住速率）逐行落 CM/PM 双端一致。

**Mermaid**：`codeBlock(attrs.language='mermaid')` 走同一 NodeView 的另一分支——动态 `import('mermaid')` 渲染 SVG（`.mermaid-render`），双击切换回源码 `<textarea>` 编辑。

### 3.5 表格

`@tiptap/extension-table` 提供 `table/tableRow/tableHeader/tableCell` 节点与 CellSelection（单元格矩形选区）。配置 `resizable: false`（拖拽改列宽体验差且与 Typora 观感不符）。表格内 Tab 移动单元格、回车换行由扩展 keymap 提供。

**插入交互（WPS 式网格选择器，`ToolbarTableButton.vue`）**：

- 点击工具栏表格按钮 → 立即插入默认 **3×3** 表格（表头行 + 2 数据行）；
- 悬停按钮 ~300ms → 弹出 **8 行 × 10 列**的网格选择器（左上角为 1×1，悬停高亮 r×c，顶部实时显示尺寸），点击格子插入对应尺寸；
- 弹层用 `<Teleport to="body">` + `fixed` 定位：工具栏 `overflow-x-auto` 会裁剪普通 absolute 弹层（实测坑）；悬停意图用 enter 300ms / leave 180ms 双定时器；
- 选区位于表格/代码块等原子容器内时 `insertTable` 会静默失败（schema 拒绝）——检测祖先节点后回退到文档末尾插入。

**表格宽度策略（Typora 同款）**：`width: 100%` + `table-layout: fixed`——**无论列数多少（哪怕只有一列），表格都占满整个写作区域宽度**：可用宽度按列均分，单列即 100%；单元格 `min-width: 56px`（最小可读宽度）与 `max-width: 280px`（超出自动换行）；列多到总宽超过容器时由 `display: block + overflow-x: auto` 提供表格内横向滚动条（`style.css` 的 `.md-preview table` 规则，验收断言 `table-cell-width-css` + `table-fills-width` 守护）。

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

**写作区版心**：`TyporaEditor.vue` 的内容容器 `mx-auto` 居中，常规模式 `max-w-[1320px]`、焦点模式 `max-w-[1140px]`（1.5 倍于旧值 880/760），宽度切换带 `transition-all duration-300` 平滑过渡。

### 3.11 公式与图表

- **KaTeX**：在 `tiptap-markdown@0.9` 未开放自定义 parser/serializer 前，公式渲染走「渲染视图内识别 `$…$` 文本 → 挂 KaTeX 组件」的渐进路径（本项目暂缓，列入路线图 §7.1）；
- **Mermaid**：已落地，见 §3.4。

### 3.12 三模式视图：实时渲染 / 分屏对比 / 源码

**入口**：工具栏左侧主功能区的分段控件（渲染/分屏/源码，带激活态）、应用菜单（查看 → 编辑器模式）、`Ctrl+/` 三态循环（Typora 同款习惯）。会话态存 `ui.editorMode`（默认值来自设置页的 `settings.editorMode`，SQLite kv 持久化）。

**工具栏位置教训**：分段控件最初放在工具栏右端文档信息区——该区在窄窗口下会被 `overflow-x-auto` 裁出可视区（CDP 点击落在窗口外，模式切不动）。**主控控件必须放在左侧主功能区**，任何宽度都可见。

**架构**（`EditorView.vue` + `composables/useEditorMode.ts`）：

- **实时渲染**：Tiptap WYSIWYG；**源码模式**：纯 `<textarea>`（等宽、零渲染样式），**分屏对比**：左侧 WYSIWYG + 右侧源码，`v-if` 互斥挂载；
- **切走前显式 flush**：工具栏根节点 `@mousedown.prevent`（点控件不触发编辑器 blur），blur 落盘不会发生——`flushWysiwyg()` 先把文档序列化刷入 files store，防抖窗口内的编辑零丢失；
- **源码面板高度**：textarea 是定高控件、默认只渲染 2 行——「展示不全」的根因。高度链 `.editor-scroll(h-full) → 内层(h-full) → textarea(height:100%)` 填满可视区，长内容在内部滚动（VSCode 式单滚动区，无嵌套滚动条）；Tab 插入两空格，光标行列经 `ui.cursor` 进状态栏；
- **分屏双向实时同步**（IDEA 式对比）：
  - 左 → 右：TyporaEditor 防抖序列化 → files store → 源码面板 `:value` 自动刷新（既有管道，零新增代码）；
  - 右 → 左：输入即写 files store（持久化管道），另防抖 200ms 直接 `commands.setContent(…, { emitUpdate: false })` 进左侧 Tiptap——**不依赖 modelValue watch**（其 600ms 静默窗会吞掉紧邻渲染端 emit 的外部更新），且 `emitUpdate:false` 不产生 onUpdate 回声，双向永不回路；
- **分隔条**：拖拽调整左右比例（0.25~0.75 钳制），双击复位 0.5，拖拽结束才 `settings.set('splitRatio', …)` 落 SQLite kv（重启保持）；拖拽期间全局 `user-select:none` + `cursor:col-resize`，杜绝 CodeMirror/选区抢鼠标；
- **同步滚动**（分屏专属悬浮芯片「同步滚动」+ 设置页开关，`settings.syncScroll` 落 kv）：`scroll` 事件不冒泡但可捕获——在分屏容器挂 `@scroll.capture` 单点监听，左右任意一栏滚动（含左侧代码块 CodeMirror 内部滚动）都按**滚动进度比**（`scrollTop / (scrollHeight - clientHeight)`）映射到另一栏；busy 旗标 + 同值赋值不触发 scroll 的浏览器语义保证无回声振荡。两侧内容高度不同也能正确对齐进度（对比视图的通用做法）；
- 菜单/快捷键/分段控件三入口共用 `useEditorMode`——切换逻辑唯一。

验收：矩阵 phase F 的 `source-mode-enter/editable/fills-height/back-wysiwyg` 与 `split-mode-enter/source-to-wysiwyg/wysiwyg-to-source/divider-drag/sync-toggle/scroll-r2l/scroll-l2r`（74 项全绿）。

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

- PM 与 CodeMirror 的焦点争夺（完整五层防线见 §3.4）：`stopEvent` + DOM 事件阻断 + 焦点钉扎 + hasFocus 覆盖 + Enter 专用捕获处理器；
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

**回声过滤（本次修复，快速回车丢失的根因）**——同一 watch 的另两类拦截：

4. **blur 守卫**：`onBlur` 时若 `relatedTarget` 仍在编辑器内部（`.cm-editor` 内或 `view.dom` 内），**不落盘**。否则焦点在代码块与正文间每次翻转都触发一次 flushSync，把「上一轮」的旧 markdown 抢在本轮 `syncToNode` 之前 emit 出去；
5. **回声过滤 + 静默窗**：`flushSync` 记录 `lastEmitted` 与时刻；watch 收到 `nv === lastEmitted`（自身回声）或距最近 emit < 600ms（滞后回声）时直接跳过——只放行真正的低频外部事件（文件切换/草稿恢复）。完整竞态链见 §4.11。

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

### 4.10 大纲闪烁与 CodeMirror 行渲染（本次修复）

- **大纲闪烁根因**：`Outline.vue` 的列表 `:key` 曾含标题绝对位置 `pos`——代码块内每敲一键，其上方所有标题的 `pos` 位移 → 全部 key 变化 → `TransitionGroup` 整列进出动画重放 → 可视闪烁。修复：key 改为 `索引-层级-文本`（集合不变时稳定），`refreshOutline` 做差异跳过（标题集合不变时只原位更新 `pos`，不重建数组），并移到 `transaction` 钩子（保证跳转位置新鲜）——验收断言 `outline-dom-stable` 直接比较 DOM 元素引用；
- **CodeMirror 行渲染与断言**：CM 用独立 `.cm-line` div 渲染每一行，`cm-content.textContent` 拼接无分隔符——**不能**用 `textContent.includes('\n')` 断言换行，必须数 `.cm-line` 元素（验收断言 `cm-enter-newline` 的教训）；
- **嵌套 CM 的三条铁律**（§3.4 的实现依据）：跨模块 `Transaction instanceof` 判定会失效（事务落入 spec 合并路径、changes 丢失）；增量重绘 `docView.update` 在嵌入场景不可靠（state 更新而 DOM 不重绘）；`setState` 整文档重建是唯一稳定路径。

### 4.11 代码块快速回车丢失的完整竞态链（本次修复）

现象：代码块里慢慢一下一下回车正常，快速连点或按住回车时大量换行丢失、光标乱跳。

诊断实录（CDP 打点 + `view.dispatch` 补丁抓 PM 事务栈）：

1. **焦点全程在 CM 上**——`HTMLElement.focus` 补丁显示 47 次 focus 全部落在 `cm-content`，零次 tiptap；8 个 keydown 全部进入捕获处理器，`setState` 全部应用（CM 状态 1→9 行）。问题不在 CM；
2. **PM 文档在事务间被回滚**：`syncToNode` 的 8 个事务依次把节点推到 9 行，但每轮之后紧跟一个 `setContent` 事务（栈指向 `TyporaEditor.vue` 的 modelValue watch）把它打回**上一轮**的行数（9→3 收尾）；
3. **根因链**：每轮 Enter 的 `pinCmFocus` 把焦点从 PM 拉回 CM → 触发 PM blur → `onBlur` 立即 `flushSync` → **抢在本轮 `syncToNode` 之前** emit 上一轮的 markdown → 父组件 store 同步回流 `props.modelValue` → watch 比较「当前 PM 序列化 ≠ 旧快照」→ `setContent(旧快照)` 整体替换文档 → 代码块节点 props 更新 → `CodeBlockView` 的 watch 又把 CM 状态重置回旧内容。单次回车靠「syncToNode 在 watch 之后执行」的顺序碰巧自愈，快速输入时 watch 落在两轮 syncToNode 之间 → 真回滚；
4. **修复**（§4.6 第 4、5 条）：blur 守卫（焦点仍在编辑器内不落盘）+ 回声过滤 + 600ms 静默窗。另将 `CodeBlockView` 的 `props.node.textContent` watch 防抖 150ms，避免 Vue 异步队列里的过期快照把 CM 逐级回滚；
5. **验收**：`tools/_repro-rapidenter.js`——8 次 35ms 连发 + 10 次 15ms 按住速率，要求 `.cm-line` 与 PM codeBlock 行数双端 = 19。

### 4.12 粘贴内容的「开放 Slice 合并」：标题被吸进段落（本次修复）

现象：粘贴 Markdown 源码（或 HTML）后，`# 大标题` 显示成了普通段落文字——点击它不出现 `#` 标记符、块语义全丢（用户报「粘贴内容显示样式但不可编辑、点击大标题没有 #」）。

诊断链（逐层 CDP 打点）：

1. `markdown-it` 的解析**没有问题**——`parser.parse(text)` 输出 `<h1>…</h1><p>…</p><ul>…</ul>` 完整块结构；
2. `DOMParser.parseSlice(<body>…</body>, { context })` 产出的 Slice 是 `openStart/openEnd > 0` 的**开放结构**（body 包裹解析使首尾块处于开放上下文）；
3. `parseFromClipboard` 的后处理 `normalizeSiblings` 保留了 heading（实测 normalized=[heading,paragraph,bulletList]），但 `Slice.maxOpen` 会**重新把完整块算成开放**（它沿首尾节点向内容内走深度：h1→text 得 openStart=1，ul→listItem→p→text 得 openEnd=3），随后 `closeSlice` 判定「无需闭合」；
4. `replaceSelection(开放 Slice)` 把首个块的内容**并入当前段落**——`_ReplaceAroundStep` 的 slice 首节点已是 paragraph（标题文本被吸进去），列表因为是后续块而幸存。HTML 粘贴路径同样受影响；
5. 修复（`markdownPaste.ts`）：`clipboardTextParser` 按内容智能选择（含换行/块标记开头 → 块级解析并显式闭合；单行行内 → inline 解析保持开放）；**`transformPasted` 兜底**（插入前最后一道钩子）把首节点为文本块/引用/列表的伪开放 Slice 闭合为 0/0——编辑器内部复制粘贴的合法开放结构（部分段落、列表项）不受影响。

**补丁：粘贴标题去粗（本次）**：`transformPasted` 里 `stripBoldInHeadings` 递归遍历 Slice，剥除标题节点内所有文本的 `bold` 标记——外部 HTML 粘贴的 `h1<b>…</b>`（Word/网页标题常整段加粗）与 Markdown 粘贴的 `# **…**` 都归一为干净的 `# 标题`（标题本身即加粗样式，`**` 冗余）。验收：`paste-heading-no-bold`（节点无 bold 标记 + 源码无 `**`）。

### 4.13 真实文本标记模型（本次重构）

需求驱动（Typora 同款）：行内语法标记（`**`/`*`/`~~`/`` ` ``）必须是**文档中的真实文本**——光标在样式内/边界（'体'后、'被'前）时显现、移出隐藏，且标记可被选中编辑；**「标记文本即源码真值」（CommonMark 对齐）**：两侧标记相等且可识别才派生样式，**不成对/不可识别即整段字面量**——删单侧一个 `*` 后显示原始字符 `*加粗**`（不再自动转斜体），两侧各删一星成 `*加粗*` 才按 CommonMark 重派为斜体；标题的光标提示改为浅色 `H1~H6` 徽章（非可编辑源码标记）。

**数据模型**（`typoraInlineMarks.ts`，两条自定义 Mark）：
- `mdStyle`（attrs.style）：被样式的正文，WYSIWYG 渲染 `<strong>/<em>/<s>/<code>`（带 `data-md-style`），markdown 序列化 open/close 为空——**语法由标记文本自身承担**，序列化输出 == 源码；
- `mdMarker`（attrs.style + side）：语法标记文本，渲染 `.md-marker` span，序列化 `open/close: '' + escape: false`（标记字符原样输出；若被转义成 `\*`，序列化结果与源码不一致，会破坏外部同步回声过滤并引发 setContent 循环重放）。

**派生归一化**（appendTransaction）：每次文档变更后重建含样式/标记的文本块——识别「标记 + 正文 + 配对标记」模式（任意位置扫描，打字合并进同一文本节点也命中）派生样式；**两侧标记相等且可识别（`**`/`*`/`~~`/`` ` ``）→ 按标记文本决定样式；不配对/不可识别（如 `**5*`、回车把标记劈开）→ 整段字面量**：内容去 `mdStyle`、标记降级 `side:'literal'`（保留 mdMarker mark 使原样序列化 + 以可见字符渲染，CSS `.md-marker[data-side='literal']{font-size/weight/style/color:inherit}`）；带样式内容缺一侧标记（回车切段）→ 自动补齐完整构造；标记删空去样式；遗留 bold/italic/strike/code（解析/粘贴产物）自动转换。与主事务同组撤销（prosemirror-history 按时间戳合并）。

**关键坑位**（本版重打包 PM 的实测行为）：
1. **`Transaction.insertText(text, from, to)` 无 marks 参数**（marks 取自 storedMarks/位置）——带标记文本须走 `replaceRangeWith(from, to, schema.text(text, marks))`，否则 marks 数组被当成 `to` 位置抛 RangeError；
2. **DOM 观察器回写循环**：渲染后的 `<strong>`/marker span 被 PM 的 DOMObserver 解析回 legacy bold/纯文本，与文档比对不一致 → `readDOMChange` 回写 → 标记丢失 + 无限重放。修复：两个 mark 声明 `parseHTML`（`strong[data-md-style]`/`span.md-marker`，priority 60），DOM 解析还原原 mark，比对一致即止；
3. **显隐用 PM Decoration**（`.md-reveal-inline` 包在 marker span 内部，CSS `:has(> .md-reveal-inline)` 反向匹配）：DOM 类切换会被追加事务的重渲染冲掉，装饰随选区状态自动重建。**展开判定左右边界均含**（`from <= r.end && to >= r.start`）：光标落在正文/标记内或紧贴构造两端（`|**s**`、`**s**|`）都展开，可继续选中/编辑 `*`；完全移入相邻普通文本才折叠——折叠临界不再抢占光标（Typora 同款）；
4. **隐藏态必须零占位且可导航**：`opacity: 0` 保留布局盒（出现占位空隙）；`display: none` 移除文本节点导致浏览器光标无法导航/落位——箭头键会把光标落在错误位置，Enter 把标记劈成两半造成字符错乱/输入不可见。**正确方案 `font-size: 0`**：字形零宽不占布局，但文本节点仍在，光标可正常导航、标记可正常选中编辑，显现时 `font-size: inherit` 恢复；
5. 初始加载（解析产物无标记）在 onCreate 跑一次 `normalizeMdMarkers`；粘贴/打字由 appendTransaction 自动维护；
6. **标记内回车 = 普通字面量切段**（`keymap.ts` 不再拦截，priority 200 仅保留 `---/***` 段尾回车→分割线与标题首字前退格降级）：光标落在标记字符内部（如 `**5*|*`）按 Enter，PM 把构造文本切成两半——派生归一化把两个不成对片段降级为 `side:'literal'`，按**可见字符**原样落到两个新段落（`**5*` / `*`），序列化**零转义**（源码即 `**5*\n\n*`，无 `\*`），继续打字即时可见（字面量段没有隐藏标记，输入不会再"看不见"）；光标在正文中段回车同样切段，完整一侧的构造由派生自动补齐另一侧。此前"先跳到 run.end 再切段"的拦截已删除——它会伪造"跳出构造"的落点（`**5*` 变成 `**5**` 才换行）且新行输入异常。`appendTransaction` 整体包 try/catch 兜底，任何归一化异常都不会让编辑器崩溃。
7. **构造边界打字会"污染"标记文本**：光标紧贴构造起点（`|**5**`）打字时，PM 的 `insertText` 取 `$head.marks()`——位置右侧是 mdMarker 节点，新字符继承 mdMarker，与起始标记文本合并成同一节点 `2**`（终点同理得 `**2`）；此时两侧标记文本不配对，归一化误判「不成对 → 整段字面量」，渲染失粗，且源码仍是 `2**5**`（字面量标记原样序列化），content-equal 断言**永远抓不到**，须刷新才恢复。修复：`repairPollutedMarkers` 在 `normalizeAtoms` 开头把粘连在标记外侧的多余字符拆回普通文本、只保留干净标记本体（start 标记取 `MARKER_OF[style]` 的后缀、end 标记取前缀），随后正常识别重新派生样式。

**联动调整**：StarterKit 的 bold/italic/strike/code 以「安静版」注册（关闭输入规则与快捷键，mark 类型保留供解析）；工具栏/气泡菜单改用 `toggleMdBold` 等新命令；`Ctrl+B/I/Shift+X/E` 快捷键接管。验收：`bold-marker-reveal/boundary/hide-on-exit/no-layout/boundary-left`（隐藏态零占位 + 光标边界显隐）、`roundtrip-markdown`（源码零转义往返）、`paste-heading-no-bold`、`boundary-type-start/end-keeps-bold/fold-back-bold`（G 阶段，构造边界打字不失粗）、`ctrl-click-plain-caret/plain-click-unchanged`（H 阶段，Ctrl+点击普通光标）、`link-plain-click-expand/link-auto-collapse/link-ctrl-keeps-link`（I 阶段，链接点击交互，§4.15）、`marker-enter-italic-live/backspace-join-no-purple-relift/bold-survives-after-merge`（J 阶段，标记内回车→斜体实时化/段首退格合并，§4.13）等 89 项全绿。

**补丁：标记内回车 → 段首退格合并（本次，J 阶段）**：`**5*|*` 回车字面量切段后再按 Backspace，此前本版 prosemirror-commands 的 `joinBackward` 要求光标真正在文本块内部，而 Enter/归一化常把光标留在**块边界（depth 0）**位置，join 失效 → 落到 `selectNodeBackward` 把上一段做成 NodeSelection（`.ProseMirror-selectednode` 紫色整选框）；即使后续拼回 `**5**`，两侧字面量标记也会永远停在可见字面量、须刷新才恢复。修复（三处，非硬编码）：
1. `typoraInlineMarks.ts` 新增 **reLiftLiteralPairs（字面量配对重提升）**：`side:'literal'` 只是"当时不成对"的过渡态——一旦两侧字面量标记在编辑/合并后重新围住无样式正文（整窗文本与完整构造模式吻合），立即还原为 start/正文 mdStyle/end，与任何输入/合并路径通用；
2. `keymap.ts` 段首/段间边界 Backspace（及对称 Delete）显式 `tr.join` 相邻同型段落，并把光标设到两段拼接缝，不再让 PM 走 selectNodeBackward；
3. `pointer.ts` 增加 **filterTransaction 护栏**：任何事务若要把文本块（段落/标题等）设为 NodeSelection，一律降级为文本光标（节点级整选只保留给图片等叶子）——紫色段选框从机制上不可能出现。

**补丁：源码权威重推，实时渲染与刷新语义对齐（本次）**：用户复现出斜体同样滞后（`*5*|` 无法删到 `*5`；`**5**` 在结束标记两星之间回车后，首行 `**5*` 的 5 应实时显示斜体——按 markdown-it，`**5*` = 字面 `*` + 斜体 `5`，此前要刷新才出现）。根因：归一化只是“启发式配对/字面量化”，与 markdown-it 对**边缘源码**（不成对、劈裂、删除收尾）的解析语义不一致。修复（非硬编码）：
1. **复用同一条解析管线**：`typoraInlineMarks.ts` 新增 `resolveBlockContent` + `parseInlineHtml`——对含 `*~`` 的纯行内文本块，把其原文（标记文本即源码真值）喂给 tiptap-markdown 的 markdown-it parser（与加载/刷新完全同一引擎），解析结果经同一归一化转成标记模型；差异才替换（稳定态零开销），解析不可用回退原启发式。于是 `**5*` 实时即 字面`*`+斜体5、`*5**` 对称同理、`*5` 删尾后按字面量显示；
2. **零转义保持**：`literalizeStrayMarkers` 把解析产物中“未被样式消费”的裸 `*~`` 包成 mdMarker(literal)（escape:false），否则普通文本里的 `*` 会被 markdown 写出器加 `\`（`**5*` → `\**5*` 源码漂移）；
3. **删除收尾不再自动补齐**：删掉 `*5*` 的收尾 `*` 后按源码真值落为字面 `*5`（可继续删除），而不是引擎擅自把缺侧标记补回。
验证：原生键 CDP（删除到 `*5` 无转义；回车即斜体）+ 打字回归（逐字 `**5**`/`*5*` 最终正确零转义）+ J 阶段断言更新，89/89 全绿。

**补丁：字面量语义落地 ×3（本次）**：① **逐字符打字成样式**——打字识别正则（`typoraInlineMarks.ts` PATTERN/PATTERN_TEST）单星分支加 lookaround `(?<!\*)\*([^*\n]+?)\*(?!\*)`，杜绝输入 `**5**` 到中途 `**5*` 时把 `*5*` 误切为斜体（残星 + 序列化 `\*` 转义）；逐字输入 `*`,`*`,`5`,`*`,`*` 的最终产物为粗体 `**5**`、源码零转义。② **标记内回车字面量切段**（见上方坑位 6）。③ **行首粘贴不裂段**——光标位于构造起点（`|**5**`，pos=run.start）或文档首段边界（pos 0）粘贴内联文本时，PM 把插入合并进当前段落、归一化容错，得到同段 `2**5**`（不再出现 `2\n**5**` 两段）。验证：CDP 实测脚本（`tools/probe-three.js`，验证毕移除）三项断言全过 + 全量矩阵 77/77 全绿。

**补丁：构造边界打字不失粗（本次）**：光标落在粗体 `**5**` 的构造起点打字 `2`，此前因 mdMarker 继承粘连（坑位 7）导致整段字面量、渲染失粗、刷新才恢复；新增 `repairPollutedMarkers` 拆回普通文本后，起点/终点打字均保留粗体（`2**5**`、`2**5**3` 且 `strong` 内容为 `5`），光标移出折叠为纯粗体。验证：`tools/probe-boundary-type.js` 三场景全过 + 矩阵新增 G 阶段 3 项断言，80/80 全绿。

### 4.14 鼠标语义：Ctrl/Cmd + 左键 = 普通点击（本次）

prosemirror-view 内置 `selectNodeModifier`（Win: `ctrlKey` / Mac: `metaKey`）：按住修饰键左键点击时，PM 在 `mousedown` 捕获该状态，`mouseup` 时经 `selectClickedNode` 把光标所在**最小可选中块**（段落/标题等文本块）做成 `NodeSelection` 整选，DOM 上整块套 `.ProseMirror-selectednode`（CSS 为主题色 outline 全选框）——Typora 没有这套逻辑。修复（`pointer.ts` → `TyporaPointer`，注册于扩展集）：在 **`mousedown` 阶段**拦截（PM 的 selectNode 状态在 mousedown 即被捕获——若用户先松开 Ctrl 再松鼠标，mouseup 时判断修饰键会漏网，mousedown 拦截才是确定的），`preventDefault` 掉浏览器默认行为后**退化为普通点击**：`posAtCoords` → `TextSelection.near` 把光标放到点击处。仅拦截 Ctrl/Cmd+左键，普通单击（含图片等节点的常规选中）、双击/三击选择均不受影响。验收（H 阶段）：`ctrl-click-plain-caret`（折叠 TextSelection 落在段落内、无 `.ProseMirror-selectednode`）、`plain-click-unchanged`。

### 4.15 链接交互：普通点击展开源码 / Ctrl+点击用浏览器打开（本次）

Typora 官方行为（support.typoraio.cn/Links/）：**Ctrl/Cmd+点击**链接跳转（网页/本地/应用），**普通点击**不跳转，而是把该链接原地展开为可编辑的 Markdown 源码 `[文字](网址)`。Lumin 实现（`pointer.ts` → `TyporaPointer` + `LinkSource` 标记）：

- **Ctrl/Cmd + 左键点击链接** → 交宿主注入的 `onOpenLink`（`pointer.ts` 的 `TyporaPointer` 选项；应用内为 `lib/linkOpen.ts`：网址→系统默认浏览器、同级文件名→新窗口、相对/绝对路径→默认应用，目标缺失时询问是否新建，详见 §4.17）；非链接处仍为 §4.14 的普通光标落点；
- **普通左键点击链接** → 展开：**不整体替换成纯文本**，而是把原 label 上的 link mark 换成 `linkSource(part:'label')`（**保留其内 mdStyle/mdMarker 等标记**，各 mark 序列化 open/close 为空 → 输出仍是原 label 字符），两侧补 `linkSource(part:'syntax')` 的 `[` 与 `](网址)`——效果：**原文标签保持链接外观**（主题色 + 下边框，CSS `.md-link-source` 与 `.md-preview a` 一致）、**新增的括号与网址以浅灰呈现**（`.md-link-syntax` = `--ink-3`）、源码往返恒等；
- **不自动选中、光标停在点击处**：展开前先把光标落到点击位置（mousedown 内 preventDefault 会阻止 PM 落光标，须先 `setSelection` 再展开），展开事务本身不 setSelection，PM 把光标按步骤映射进 label 的相对偏移——点到哪光标就在哪；
- **自动折叠**：光标移出展开区（appendTransaction 判定）、按 Esc、编辑器失焦 → 解析展开区整体文本 `[label](url)` 以 link mark 重建 label（内部 `**` 等由派生归一化还原）；改残则不还原、仅去掉 linkSource 标记保留原文；
- **联动归一化**：`typoraInlineMarks` 的 toAtoms/blockNeedsNormalize 把 linkSource 文本视为**不透明**（否则展开源码里的 `**` 会被派生归一化误转为样式标记）。

关键坑位：PM 的 mark 渲染必须有 `toDOM`（tiptap `renderHTML`）——缺省会抛 `mark.type.spec.toDOM is not a function`：事务已进 state（选区/文档都对）但 **DOM 构建中断**，视图停在旧 DOM，形成「状态已展开、界面仍是链接」的失同步；且**不能在 mousedown 事件回调里同步 dispatch**（实测 DOM 不随事务重建），须 `setTimeout(0)` 延后派发；parseHTML 需还原 `span.md-link-source`/`span.md-link-syntax` 避免 DOMObserver 回写循环。验收（I 阶段）：`link-plain-click-expand`（锚点消失、源码可见、label/syntax 双形态存在、光标折叠不选中、md 不变）、`link-auto-collapse`（光标移出折叠还原）、`link-ctrl-keeps-link`（Ctrl+点击不展开）。

### 4.16 设置中心（模态浮层）与系统级设置项（本次）

设置从「占用整页的路由视图」重构为 **Teleport 模态浮层**（`components/SettingsDialog.vue`，挂载于 App 根，z-120 遮罩 + 居中面板 + 左导航分组 + 右侧滚动内容），提供 **X 按钮 / Esc / 点击遮罩** 三种关闭方式，打开时不离开当前文档上下文；面板入场淡入微弹，关闭即时（本版 Teleport 内层 Transition 的 leave 卸载偶发残留，故采用即时显隐 + 入场动画）。入口统一走 `ui.openSettings()`（工具栏齿轮、侧边栏底部、菜单「设置」Ctrl+,），不再使用 `/settings` 路由。

新增/重构的系统级设置（均经 settings store → `settings:update` → **SQLite kv 持久化**，非 session）：
- **顶部菜单栏（`nativeMenuBar`，默认开）**：采用**应用内菜单栏 `TopMenuBar`**（VS Code 式，位置由 DOM 精确摆放、Alt+F/E/V/H 必达、菜单项与原生菜单同源动作）替代系统原生菜单条——主进程隐藏系统菜单条（`setMenuBarVisibility(false)`）避免双开/错位，应用菜单仍安装以保留 Ctrl+N/O/S 等加速键；`nativeMenuBar` 关闭时仅隐藏该菜单栏（快捷键仍可用），设置经 SQLite kv 持久化。
- **自动保存（`autoSave`，默认开）**：已有持久化字段；新增关闭时 `files.cancelAutoSave()` 取消**未触发的磁盘定时器**（草稿崩溃保护仍写）。状态栏左侧保存状态区为**入口按钮**：点击弹出**竖向选择菜单（自动保存 / 手动保存 + 打开设置…）**，选中即切换并持久化；切到手动保存时状态区文字显示 **「未开启自动保存」——不加强调色（沿用底部状态栏默认文字色）、且不显示前置状态圆点**。
- **排版与空白（`whitespace`，默认全开）**：编辑/导出两个维度分别控制「保留连续空格」「保留单个换行」——编辑维度经 `data-preserve-spaces/breaks` + CSS（段落 `pre-wrap`、软换行 `<br>` 显隐）实时生效；导出维度在导出 HTML/PDF/Word/EPUB 时叠加 `white-space: pre-wrap` 与 `<br>`→空格 策略。说明：连续回车产生的**空段落**属 Markdown 块级语义，打开/保存按规范合并为单个分段空行（主流引擎与 Typora 一致）。
- **多语言（i18n）**：基于 vue-i18n 的解耦架构，语言目录为纯 JSON 数据：`zh-CN` / `en-US` / `ru-RU`（俄文）三套全量键；新增语言 = 新增 `locales/{locale}.json` 并在 `i18n/index.ts` 的 `messages` 与 `Language` 联合类型登记（`LANGUAGE_OPTIONS` 自动驱动设置面板语言选择与状态栏快捷循环）。`settings.language` 经 SQLite kv 持久化，`document.documentElement.lang` 同步。已有 i18n 键位的界面（编辑区、工具栏、侧栏空态、设置面板等）随语言即时切换；存量硬编码文案按模块增量迁移中。
- **PDF 导出（优化）**：隐藏窗口 + 真实 Chromium 排版引擎渲染后 `printToPDF`；**等待 `document.fonts.ready` 与一次渲染帧稳定后再打印**，杜绝空白/缺字/未分页；按设置注入 A4/A5/Letter 与页边距、`printBackground`；失败时清理半成品文件并向上抛错（渲染层 Toast 提示）。

验收：CDP 实测浮层 开→X 关、开→Esc 关、原生菜单栏开关状态持久化回读、autoSave 开关持久化、语言三态切换与 `ru-RU` 持久化、`openTopMenu` IPC 无异常；全量矩阵 89/89 全绿。

### 4.17 链接目标解析与打开策略（本次）

§4.15 只区分了「是不是链接」，Ctrl/Cmd+点击一律丢给 `shell.openExternal`——于是 Markdown 里极常见的 `[下一篇](notes.md)`、`[资料](./assets/spec.pdf)` 这类**本地目标点不动**（`openExternal` 只认 http/https）。本次把「打开链接」升级为**分类解析 + 按需创建**的完整流程：

| 链接形态 | 判定 | 打开方式 |
| --- | --- | --- |
| `https://…`、`http://…`、`mailto:…` | `url` | 系统默认浏览器 / 邮件客户端 |
| `notes.md`（不含量分隔符） | `file`（相对**当前文档所在目录**） | **Lumin 新窗口**打开（`app:openInNewWindow`） |
| `./a/b.md`、`../x` | `relative` | 系统默认应用（`shell.openPath`） |
| `C:\a\b`、`\\server\share`、`/home/a` | `absolute` | 系统默认应用 |

- **目标不存在 → 询问是否创建**：询问**融合进右下角通知中心的可交互卡片**（带「创建并打开 / 取消」按钮，不弹模态、不打断写作，答完自动收起；同一目标只占一张卡片）。策略可由 **设置 → 链接 → 目标不存在时** 三态控制：总是创建 / 每次询问（默认）/ 从不创建；父目录缺失会一并 `mkdir -p`。链接以分隔符结尾（`./notes/`）判定为文件夹，否则为文件。
  - 实现要点：通知表新增 `actions` / `payload` 两列（JSON 文本，旧库走 `ALTER TABLE` 升级），因此**按钮与负载随通知一起持久化**；点击时按 `payload.kind` 找渲染层注册表（`lib/notificationActions.ts`）里的处理器执行，不会出现「按钮还在、逻辑没了」的死按钮。负载只存「原始链接 + 当时的基准目录」，处理器会**重新解析**——等待期间文件若已被别处创建，会直接落到「打开」分支。
- **非文本目标不凭空创建**：`.png`/`.pdf` 之类已经存在时交系统默认应用；不存在时直接提示「该类型的文件无法新建」——造一个空的二进制文件没有意义。
- **安全**：`shell.openExternal` 只放行 http/https/mailto 白名单（任意 scheme 交给系统处理器是历史上的高危面，如 `javascript:`、`ms-msdt:`）；分类前先排除 Windows 盘符（`C:\x` 会被 `new URL()` 误判成 scheme `c:`）；创建文件用 `flag: 'wx'`——**绝不覆盖**已有内容。`file://` URL 先 `fileURLToPath` 再按路径规则处理。
- **持久化（SQLite，非 session）**：`link_history` 表以链接文本为主键 upsert（`kind / resolved_path / action / created_entry / count / created_at / last_used`），记录每一次打开、以及「放弃创建」；设置项 `linkCreateMode` 落在 `kv.settings`。**设置 → 链接**页签可查看历史（含类型/动作/次数/时间徽章）、逐条删除、一键清空（完整 CRUD）。
- **解耦**：主进程 `services/links.ts` 只做「分类 + 路径解析 + 探测/创建」，**不打开任何东西**；打开动作由渲染层 `lib/linkOpen.ts` 编排（确认弹窗、通知、落库都在 UI 层）。编辑器内核不依赖任何 store——`TyporaPointer` 暴露 `onOpenLink` 选项注入（默认实现仅开浏览器），`buildEditorExtensions({ onOpenLink })` 在 `TyporaEditor.vue` 里接上应用逻辑。

验收：`tools/_verify-link-open.js`（真实文件系统 + 真实新窗口 + 直读 SQLite）：分类矩阵、缺失目标「是/否」两条分支、创建后打开、协议白名单拒绝、非文本不创建、历史 CRUD 与落盘。

### 4.18 会话恢复：重启回到上次的文档与位置（本次）

此前每次启动都停在欢迎页——写作工具里这是最容易被吐槽的一处（Typora/VS Code 都会回到上次的位置）。本次按「一窗一文档」的既有模型做**每窗口会话**：
- **记录什么**：`{ path, pos, len, scrollRatio }`。位置不用 scrollTop 而用**滚动比例**、光标除 PM 位置外还带上当时的文档长度——文件被外部改过、窗口大小/字体/主题变了，也能按比例落到同一处（与 EditorView 视图位置记忆同一套思路）。
- **存在哪**：SQLite `kv.session = { slots: [SessionSlot|null] }`，按**窗口槽位**索引存放。主进程在创建窗口时分配槽位（`--lumin-session-slot=N` 走 additionalArguments，preload 解析），启动时按槽位重建：几个窗口就是几份上下文，各自恢复各自的文档（上限 5 个，避免窗口风暴）。显式 `--lumin-open` 的窗口优先打开指定文件，不参与恢复。
- **谁动槽位**：渲染层只管写；主进程在窗口 `closed` 里分两种情形处理 —— **单独关窗**保留槽位并标记 `closed`（下次启动若没有别的窗口「活着退出」就恢复它，见 §4.45），**整体退出**（`before-quit` / 菜单退出 / 系统关机）原样保留，下次启动把当时活着的窗口全部恢复。
- **写入时机**：文档切换、光标移动（`ui.cursor`）、滚动（window 捕获阶段，容器重建也无需重绑）→ **800ms 节流**写一行 kv；关键路径补刀：关窗前（`app:before-close` 里 flush）、`pagehide`、切到后台。
- **开关**：设置 → 通用 →「启动时恢复上次会话」（`restoreSession`，默认开）。关掉后启动直接进编辑器（空白未命名缓冲区）——注意语义：会话记录的是**当前状态**，关着的时候该窗口的会话就被写成「无文档」，这与主流行为一致。
- **降级**：恢复的文档已不存在（被移动/删除）→ 通知中心告警一条，不阻断启动；未命名缓冲区不进会话（其内容本就由草稿机制保护，避免两套恢复逻辑打架）。

验收：`tools/_verify-session.js`（真实 reload 触发完整启动流程 + 直读 SQLite）：槽位分配、路径/光标/滚动落盘、reload 后三者精确恢复、开关两向、文件丢失告警、单独关窗保留槽位并标记关闭；另做了**真·杀进程重启**复核（窗口数、文档、光标 1168/保存值 1166、滚动 0.5 全部对上）。

### 4.19 去掉欢迎页，能力重排到三个入口（本次）

Lumin 是写作工具，没有文档时就该是一篇空白稿纸——Typora、iA Writer、Bear 都没有欢迎页。会话恢复（§4.18）之后，欢迎页更只在异常路径出现（首启、用户关掉恢复、上次没开文档、文档丢失），专门为它维护一个路由 + 一套 hero 样式不划算。于是：

- **删除 `views/WelcomeView.vue`**，`/` 一律重定向到 `/editor`：没有文档时 `EditorView` 挂载即建空白未命名缓冲区，「无文档」从此只有一种表现，异常降级也走同一条路（不再有「欢迎页 / 空编辑器」两种空态）。
- **能力重排到三个已有一等入口**（这才是关键，删页面不等于删能力）：
  1. **侧栏空态**（`FileTree.vue`，未打开工作区时）：三个入口按钮 + 快捷键提示——原来欢迎页「这是什么应用、能干什么」的作用由它承担（后来按 §4.24 精简为一行图标按钮）；
  2. **侧栏头部「最近文档」按钮**（`components/SidebarRecentButton.vue`，新增，位于「新建文件」**左侧**）：点击展开最近文档下拉（固定优先 + 按时间倒序，行内可 固定/取消固定/移除 + 清除记录）；
  3. **顶栏「文件」菜单**：原有「新建文档 / 新建窗口 / 打开文件 / 打开文件夹」保持不变，新增两个**一级项 + 悬停二级菜单**——`最近文档 ▸` 与 `最近文件夹 ▸`（`SubMenu` 类型 + `RecentList.vue` 共用组件）。
- **最近文档 / 最近文件夹 → 一律在新窗口打开**（`openInNewWindow` / `openFolderInNewWindow`）：当前窗口的文档与工作区完全不受打扰，因此**不再需要脏数据确认**。为此把窗口创建参数收敛成 `WindowOpenOptions { openFile?, openFolder?, sessionSlot? }`，新增 `--lumin-open-folder=<dir>` 启动参数：新窗口以该文件夹为工作区（空白文档，等用户点开文件）。会话槽位（§4.18）随之扩展出 `folder` 字段——「只开着文件夹」的窗口也能在重启后回来；`planRestore()` 现在同时接受「有文档」与「有文件夹」的槽位。
  （已知边界：`workspace.root` 是**全局** kv 值，所以在一个窗口里换文件夹会影响其它窗口的下次初始化；每窗口独立工作区是后续可做的一步。）
- **二级菜单实现**（`TopMenuBar.vue`）：一级行悬停 → 右侧浮层（贴死左侧面板、重叠 1px），指针移出后 **160ms 宽限**再收起、进入浮层即撤销 —— 与编辑器右键菜单同一套「悬停意图」思路，避免「怎么都移不到二级上」；右侧放不下自动翻到左侧；Esc 先收二级再收一级。二级内容由插槽渲染（`slot: 'recentFiles' | 'recentFolders'`），列表与行内操作全部复用 `RecentList.vue`。
- **浮层关闭条件抽成公共判断**（`lib/popoverClose.ts`）：`shouldCloseOnScrollOrResize(e, ...panels)` —— **浮层内部滚动不关闭**、外部滚动与缩放才关闭。此前「滚动即关闭」的监听挂在 window 捕获阶段，而列表自带滚动条，滚动它同样会冒到 window，于是「菜单里有滚动条却滚不动，一滚就消失」；浮层经 Teleport 挂到 body，判断「是否在内部」必须显式传元素而非靠 DOM 祖先关系。侧栏最近文档下拉、导出菜单、表格选择器、代码块弹层统一改用它（编辑器右键菜单里原本就是同一套逻辑）。
- **新增持久化字段 `recentFolders`**：打开文件夹（`files.setRoot`）时记一笔（去重 + 置顶，最多 12 条，落 SQLite kv）；列表展示时并入「当前工作区」，避免历史用户看到空列表。
- **工具栏不再有「打开」按钮**：同一能力不在工具栏、侧栏、菜单三处重复；打开文件仍走菜单 / `Ctrl+O` / 侧栏空态。
- **i18n 收敛**：`welcome.*` 命名空间整体退场——`searchPlaceholder` 迁到 `common.*`（全局搜索在用），其余文案迁到新的 `open.*`（复用既有译文，新增 `recentFolders/emptyFolders/clearFolders/pin/unpin/removeRecent/hint`）；三语言键集合保持一致（顶层与各命名空间均校验过）。
- **顺带清掉**欢迎页里的「未保存草稿恢复卡」：`openUntitled()` 本来就会把草稿挂到编辑器横幅（`.restore-bar`，含 恢复/丢弃），同一能力不再有两处实现；`/about` 仍承担版本、技术栈等信息面板的角色。

验收：`tools/_verify-welcome-removed.js`（无会话启动落在编辑器 + 侧栏空态三入口 + 工具栏分裂按钮的最近文档/固定/清除 + 文件菜单含最近项）。

### 4.20 通知按窗口隔离（本次）

**问题**：在任一窗口保存文件产生的提示，会在**所有窗口**同时弹出——通知表是全局的，而且主进程每次变更都 `BrowserWindow.getAllWindows()` 广播一遍，于是「A 窗口的提示」变成了「每个窗口都有的提示」。

**根因**：主进程能力（IPC handler、SQLite、广播）天然是所有窗口共享的，渲染进程又无法自证身份。Electron 没有「这个状态属于哪个窗口」的原生答案，必须自己建一层**窗口身份**。

**方案（最小且主流）**：给通知加**窗口作用域**，作用域由主进程从 IPC 发送方反查，渲染层既不传也传不了。

- **窗口身份**（`src/main/services/windowScope.ts`，新增）：`window.id → w<会话槽位>`，创建窗口时 `bindWindowScope(win, slot)` 登记、`closed` 时自动注销；`scopeOfSender(event.sender)` 用 `BrowserWindow.fromWebContents` 反查。选**会话槽位**而不是 `webContents.id`：槽位是本项目里唯一**跨启动稳定**的窗口身份（§4.18 按槽位重建窗口），这样「窗口 A 没处理完的提示」重启后仍回到窗口 A，而不是变成孤儿行或串到别的窗口。没有槽位的窗口退化成一次性随机作用域——底线是「宁可各自独立，不可互相串台」。
- **存储层**（`services/database.ts`）：`notifications` 新增 `scope TEXT NOT NULL DEFAULT ''` 列（旧库 `ALTER TABLE` 升级；升级时把 `scope=''` 的历史行一次性删掉——它们是「全局共享」时期的产物，无法归属，留着只会在所有窗口都查不到却永久占表）。索引换成 `(scope, closed_at, created_at DESC)` 并删掉被它覆盖的旧索引。`add/list/update/close/closeAll/remove/clearClosed/prune` **全部带 scope 条件**，连 `mergeKey` 去重与「每窗口保留 200 条」的裁剪也按作用域各自进行——不会出现「另一个窗口的同名提示把我的卡片顶掉」。
- **IPC 层**（`src/main/ipc.ts`）：每个 handler 用 `scopeOf(event)` 取作用域；变更信号由「广播给所有窗口」改成**只回给发起窗口**（`event.sender.send('notifications:changed')`）。
- **生命周期**：通知随窗口存在。窗口被**单独关闭**（非整体退出）时，除了把会话槽位标记为「已关闭」（§4.45，不清内容），同时 `deleteNotificationsByScope` 清掉它的通知；新窗口领到槽位时（`claimFreshSlot()`）也先清一遍该作用域——槽位被复用时不会把上一任窗口的提示带给新窗口。整体退出（`before-quit`）保留，交给下次启动按槽位恢复到同一个窗口。
- **渲染层零改动**：`stores/notifications.ts` 的调用签名与数据流不变（store → IPC → SQLite，UI 只读 store），只是语义从「全局通知中心」变成「本窗口通知中心」——解耦的好处在这里体现：隔离完全落在主进程一侧，UI 不知情也不需要知情。

**边界与取舍**：① 升级瞬间，旧库里未关闭的全局通知会被丢掉一次（无法归属到窗口，且多为一过性的「已保存」）；② 每个窗口的未读提示不跨窗口汇总——这正是本次要的行为；③ 槽位索引在单次运行内只增不减（`releaseSlot` 未被调用），因此作用域清理主要覆盖「关窗即清」与「重启后复用槽位」两条路径，`claimFreshSlot()` 的清理是后者的安全网。

验收：`tools/_verify-notify-multiwindow.js`（新建临时窗口 A/B/C，全程不碰用户窗口）：A 的通知**不出现在 B**、DB 行的 `scope` 等于 A 的槽位、同 mergeKey 只在各自窗口内合并、`closeAll/clearClosed` 只作用本窗口、关窗后该作用域行被物理清掉、新窗口干净且各占独立槽位、用户已有窗口快照前后一致；`tools/_verify-notify-disk.js` 直读 `lumin.db` 核对 `scope` 列/索引/行内容/软关闭/关窗清理；`tools/_verify-notify-restart.js`（两阶段，中间由外部硬杀进程 + 重启）核对「重启后按槽位恢复到同一个窗口，且那条通知只回到这个窗口」。

### 4.21 启动速度优化（本次）

**方法论**：先测量再动手，所有结论都以生产包（`npm run build` + `electron .`）的实测数字为准，dev 数字不作为依据。

- **打点**：主进程 `LUMIN_STARTUP_LOG=1` 时输出 `[startup] app-ready / ipc-registered / first-window-created / first-window-loaded / remaining-windows-created / first-window-painted`（含 `t+ms` 与 `process.uptime`）；渲染层统一 `performance.mark('lumin:*')`（`boot-start / settings / shell / files / editor-mounted / doc-visible / idle-tasks-started / notifications / editor-menu`），零开销、DevTools Performance 面板可见。基准脚本 `tools/_startup-bench.js <label> [轮数]`：从 spawn 进程起算，逐窗口记录「窗口可见」（`document.visibilityState` 变 visible）与「文档可用」（编辑器挂载且骨架屏退场），复用单个 CDP 连接轮询以避免测量噪声。

**实测（同一脚本 3 轮中位数，生产包，2 个窗口）**：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 首次内容绘制 FCP | 668 ms | **280 ms** |
| 窗口可见（`show()`） | 386 ms | 376 ms |
| 文档可用（首个窗口） | 1151 ms | 1120 ms |
| 文档可用（全部窗口） | 1157 ms | 1136 ms |

**改了什么**：

1. **首帧骨架屏内联进 `index.html`**（纯 HTML/CSS，不用 JS，中性半透明灰因此适配明/暗/羊皮纸主题）：窗口出现时立刻是「应用骨架 + 呼吸的 LUMIN」，Vue 挂载时整棵 `#app` 子树被替换。这是 FCP 从 668ms → 280ms 的原因——首帧不再等模块脚本执行 + Vue 挂载骨架组件。
2. **渲染层启动链路重排**（`renderer/src/main.ts`）：主题/语言 + 本窗口要打开的文档留在关键路径上；通知中心与右键菜单「最近使用」的 hydrate 改到 `requestIdleCallback`（它们只影响卡片与菜单次要分区），并且不再互相串行等待。
3. **多窗口会话恢复错峰创建**（`main/index.ts` + `services/session.ts`）：`planRestore()` 改为按 `savedAt` 倒序（**用户最后停留的窗口排第一**），首个窗口先建、等它 `did-finish-load` 后再建其余（兜底 1.5s），避免 N 个渲染进程同时抢 CPU/磁盘。
4. **主进程初始化顺序**：`registerIpc()` 保持在窗口之前（渲染层启动即发 IPC），`installMenu()`（原生菜单）挪到窗口创建之后——它不影响首屏。
5. **dev 侧预打包与预热**（`electron.vite.config.ts`）：`optimizeDeps.include` 列出真实用到的 specifier（含 `@tiptap/pm/*` 这类子路径，只写根包名覆盖不到），`server.warmup.clientFiles` 预热首屏链路，消除首次进入编辑器时 "new dependencies optimized, reloading" 造成的二次加载。

**测量后被否掉的两项**（记录在此，避免以后重复踩）：

- **惰性化 SQLite 单例**：实测「打开 + PRAGMA + 全部 `CREATE ... IF NOT EXISTS` + `table_info` 检查」在真实库（1.6MB，含 FTS trigram）上只有 **~1.5ms**，不值得为它改结构 → 放弃。
- **`manualChunks` 手工拆包**：拆出 `vendor-vue/editor/code/diagram` 后 Rollup 报 `Circular chunk`，并且把**只被动态 import 的 mermaid（4.9MB）提到了首屏 `modulepreload`**——首屏载荷反而暴涨，启动更慢 → 已回退，保留 Vite 默认的「按动态 import 边界拆包」（编辑器仍是懒加载 chunk，mermaid/katex 按需加载）。

**剩余瓶颈（优化后首个窗口的自身时间轴，相对 navigationStart）**：模块解析执行 → `boot-start` ≈225ms（首屏 chunk ~935KB，其中还夹着一部分 ProseMirror：`lib/session.ts` 顶层 `import { TextSelection } from '@tiptap/pm/state'`）→ `shell` ≈95ms（settings IPC + Vue 挂载）→ `files` ≈25ms → `editor-mounted` ≈20ms → `doc-visible` ≈250ms（EditorView chunk 1.9MB 的加载/执行 + ProseMirror 文档构建与首帧，其中 CodeMirror 6 与 `@codemirror/language-data` 是静态导入）。**下一步的正确做法是「减字节」而不是继续重排**：把 CM6 从编辑器 chunk 里拆成按需加载（只含代码块的文档才付这份成本，用 `_verify-cb-*` 系列套件兜底），以及把 ProseMirror 从首屏 chunk 里请出去（session 里的 `TextSelection` 改为惰性获取）。这两项都会改变编辑器内部加载时序，属于独立改动 + 独立验收，本次不做。

**回归验收**：`_verify-session.js` 16/16（含槽位与光标/滚动恢复）、`_verify-welcome-removed.js` 34/34、`_verify-notifications.js` 30/30、`_verify-editor-menu.js` 全 PASS、`_verify-link-open.js` 62/62、`_verify-notify-multiwindow.js` 21/21、`_verify-notify-restart.js` 6/6（错峰创建后仍按槽位恢复，且通知只回到原窗口）、`_verify-alt-menu.js`（Alt+F 仍由应用内菜单接管，原生菜单条不拦截）；`npm run build`（含 `typecheck` 双工程）与 `eslint` 均零错误。

### 4.22 窗口标题跟随打开的文档（本次）

**问题**：多窗口时 Windows 任务栏把每个窗口列成一项，而所有窗口的标题都是「Lumin」——最小化后想把某个文档调出来，只能一个个点开看，等于没有窗口切换能力。

**方案**：标题跟随本窗口打开的**文件**（Typora 是 `文件名 - Typora`，VS Code 是 `● 文件名 - 文件夹 - 应用名`，同一套主流做法）。新增 `renderer/src/composables/useWindowTitle.ts`，在 `App.vue` 的 `setup` 里调一次，用 `watchEffect` 把 `files` 的状态映射成标题——**只有真的打开了文件才进标题，否则就是纯应用名**：

| 本窗口状态 | 标题 |
|---|---|
| 打开了文件 | `文件名.md - Lumin` |
| 该文件有未保存改动 | `• 文件名.md - Lumin` |
| 没有打开任何文件（只开着工作区 / 未命名缓冲区，含其有未保存改动） | `Lumin` |

**几个刻意的决定**：

- **只写 `document.title`，不加任何 IPC**：Electron 会把渲染层的页面标题同步成原生窗口标题，任务栏、Alt+Tab、窗口缩略图用的都是它。所以主进程不需要再存一份标题，也不需要在窗口创建时 `setTitle`——一份真相，零同步成本。
- **天然按窗口隔离**：每个窗口的渲染层各自计算自己的标题，多窗口之间不可能互相影响（与 §4.20 的通知作用域是同一个「窗口私有状态」的思路）。
- **「没打开文件」就不带任何后缀**：未命名缓冲区的编号是每个渲染进程各自从 1 开始的，带上它反而会让两个「新建窗口」同时叫 `Untitled-1.md`（正是本功能要消掉的重名）；只开着工作区也不代表「打开了什么」。未保存内容另有提示通道——状态栏「未保存」+ 工具栏小圆点，标题保持纯 `Lumin` 最干净也最符合直觉。
- **不落 SQLite**：标题是**派生状态**（由当前文件实时算出来），不是用户数据；重启后由会话恢复（§4.18）重新算出同样的标题。为它建表只会多一份可能不一致的副本。
- **不新增 i18n 文案**：`•`、` - `、`Lumin` 都不是需要翻译的自然语言。
- **HMR 友好**：挂在 `App.vue` 的 setup 里（而不是 `renderer/src/main.ts`）——改 `main.ts` 会让 Vite 整页重载，丢掉当前窗口未保存的内容；组件级 HMR 只重跑 setup。

**验收**：`tools/_verify-window-title.js` 14/14（没打开文件 → `Lumin`（无工作区 / 有工作区 / **未命名缓冲区有未保存改动** / 关掉文件后 都是 `Lumin`）、打开文件 → `文件名 - Lumin`、改动后 → `• 文件名 - Lumin`、重新打开 → 前缀消失、**目录树里改名 → 标题跟随**、两个窗口各自显示自己的文件互不串台）。套件用**独立 `--user-data-dir`** 的实例跑，并在每段前把状态重置成「无文档无工作区」，因此不碰用户正在用的窗口和数据、且可重复运行。另用 Win32 `EnumWindows` 直接读**原生窗口标题**交叉核对（任务栏用的就是它）：实测用户实例里「只开着工作区」的窗口标题为 `Lumin`、打开了文件的窗口为 `未命名-17.md - Lumin`，与 `document.title` 完全一致。

### 4.23 「新建窗口」是干净窗口（本次）

**问题**：文件 → 新建窗口 出来的新窗口，会顺带把当前工作区（文件夹树）也带出来，不是「一张白纸」。

**原因**：`workspace.root` 在 SQLite kv 里是**全局**值（§4.19 记过这条边界），而且主进程的文件操作校验（`fileOps.assertWorkspacePath` → `file:readDir/scanWorkspace/create/remove/rename`）也依赖它——它不是纯 UI 状态，不能简单地"按窗口拆"。新窗口启动时 `files.init()` 读的就是这个全局根目录。

**方案（最小改动，不碰全局语义）**：给「新建窗口」加一个启动开关，只让**那一个窗口**不继承工作区：

- 主进程 `WindowOpenOptions` 增加 `noWorkspace`，透传 `--lumin-no-workspace=1`；**只有** `app:newWindow`（= 文件 → 新建窗口，全项目唯一调用点）带它；
- 渲染层 `files.init({ inheritWorkspace })`：`false` 时不读 kv 根目录，于是侧栏是该工作区的空态入口（按 §4.24 为一行图标按钮 + 快捷键提示），编辑器里是一张空白未命名缓冲区，标题按 §4.22 就是纯 `Lumin`（没打开文件）；
- **全局根目录一个字都没动**：其它窗口的文件夹树、主进程的路径校验、下次启动的工作区全都保持原样（这也是为什么不采用"清空 kv 根目录"这种看起来更省事的做法）。

**边界（有意保持的差异）**：只有「新建窗口」是干净的；**「在新窗口打开文件」** 与 **「最近文件夹 → 新窗口」** 语义不变——前者仍继承工作区并多打开一个文件，后者本来就要把指定文件夹作为工作区。干净窗口随后自己「打开文件夹」时，仍然会写全局根目录（与既有行为一致；**每窗口独立工作区**仍是后续可做的一步）。另外，一个既没有文档也没有工作区的干净窗口在重启后不会被恢复（会话恢复要求槽位里有文档或文件夹），这是「没内容可恢复」的既有语义。

**验收**：`tools/_verify-new-window-clean.js` 13/13，全程走**真实 UI 路径**（Alt+F 打开文件菜单 → 点「新建窗口」，不直接调 IPC）：新窗口 `startupNoWorkspace=true`、`root=null`、侧栏是空态入口且行数为 0、编辑器是未命名缓冲区、标题 `Lumin`（没打开文件）；**原窗口的根目录/树/槽位不变**、`workspace:getRoot` 仍是原值；干净窗口里打开文件正常（`alpha.md - Lumin`）且不会因此获得文件夹、随后也能自己打开文件夹；边界项——`openInNewWindow` 出来的窗口仍 `noWorkspaceFlag=false` 且继承工作区。回归：`_verify-session.js` 16/16、`_verify-notify-multiwindow.js` 21/21、`_verify-window-title.js` 14/14、`_verify-welcome-removed.js` 30 项通过（其中「最近文档/最近文件夹 → 新窗口」两项在隔离实例里因缺少工作区夹具而跳过，这两条路径本次未改动）。

**顺带修好的测试基建**：`_verify-session.js` / `_verify-notify-*.js` 直读 SQLite 的路径改为支持 `LUMIN_DB` 环境变量覆盖。此前它们硬编码 `%APPDATA%\lumin\lumin.db`，导致在 `--user-data-dir` 起的隔离实例上跑时读的是**用户真实库**（曾让 5 项会话断言误报失败）。

### 4.24 侧栏空态精简为一行图标按钮（本次）

**问题**：没打开工作区的窗口里，侧栏空态是「logo + 一句 slogan（开始你的灵感之旅）+ 一句描述（所见即所得的 Markdown 写作体验）+ 三个整行文字按钮」，占掉大半屏，和一个写作工具的侧栏气质不符——用户开个空窗口是为了立刻写字，不是为了看介绍。

**改法**（`components/FileTree.vue` 的空态区块）：

- **删掉 logo、标题 slogan、描述文案**（连同 i18n 里的 `open.emptyTitle` / `open.emptyDesc` 两个键一起删——三语言同步，不留死键）；
- **三个入口收成一行图标按钮**：新建文档 / 打开文件 / 打开文件夹，复用既有 `.icon-btn`（30×30，已有 hover/active 动效）+ `border border-edge` 描边，**不新增任何 CSS**；文案挪到 `title`（全局 tooltip 接管，750ms 延迟、主题化样式）与 `aria-label`（读屏可读），因此「图标没字」不等于「没有说明」；
- 保留一行 11.5px 的快捷键提示（`open.hint`：Ctrl+O 打开文件 · Ctrl+Shift+P 搜索文档）——它是空态里唯一还带信息的文字，也是那三个图标的可发现性补丁；不想要的话删一行即可；
- 空态根节点保留语义类名 `empty-hub`，验收脚本按它定位（也让断言不再依赖界面文案）。

**验收**：`tools/_verify-welcome-removed.js` 的 B 段改为按 `aria-label` 断言并新增两条——`empty-state-buttons-are-icon-only`（三个按钮 `textContent` 全为空）、`empty-state-has-no-hero-text`（空态区已无 slogan/描述文案），另有 `hasLogoSvg:false` 佐证 logo 已移除；`tools/_verify-new-window-clean.js` 13/13（空态识别改用三个 `aria-label`）。视觉不变量另行程序化核对：三按钮 30×30、同排等高、只含 3 个 svg、按钮下方才是提示、`--ink-2`/`--edge` 随 light/dark/sepia 主题令牌变化（切换后 150ms 内完成颜色过渡）。

### 4.25 工具栏与状态栏去掉文件名（本次）

**问题**：文件名同时出现在三个地方——窗口标题（任务栏）、编辑器工具栏右上角（文件 + 名称 + 未保存圆点）、底部状态栏左侧（名称）——重复且占地方；写作工具里这三处本来就是同一份信息的三种冗余呈现。

**改法**：

- **工具栏**（`Toolbar.vue`）：删掉整块「文档信息」（文件图标 + 文件名 + 未保存圆点）。未保存状态在状态栏有「已保存 / 未保存 + 圆点」的完整呈现，不会因为这次精简而丢失；工具栏右侧从「文档信息 · 专注模式 · 导出」变成「专注模式 · 导出」。
- **状态栏**（`StatusBar.vue`）：删掉左侧的分隔线与文件名（连同它上面那层「完整路径」的 `title` 提示），保留保存态、字数/行数/字符数、光标行列、主题与语言入口；没有文档时仍显示 `Lumin — Write in Light.` 占位。
- **清理**：`Toolbar.vue` 里只为显示名字而存在的 `docName` computed 与 `useFilesStore` 导入、`files` 变量一并删掉（`vue-tsc` 会以 TS6133 拦截这种死代码）；**没有 i18n 改动**（文件名是数据不是文案）。

文件名如今只在**窗口标题/任务栏**里出现（§4.22 的那套规则），需要看「我现在在哪个文件」时看任务栏或侧栏树即可，三处冗余收敛成一处。

**验收**：`tools/_verify-bars-no-filename.js` 12/12（两条栏都不再出现当前文件名、`title` 提示里也不残留；工具栏按钮 27 个不变；状态栏仍显示「已保存」、字数/行数/字符数、光标行列、主题/语言；窗口标题仍是 `visible-name-check.md - Lumin`）。`npm run typecheck`（主/渲染）0 error，`eslint` 对两个文件 0 error（余下警告均为既有的 prettier 换行偏好）。

### 4.26 打开外部文件的落点规则（本次）

**问题**：从系统外部打开一个文件（Ctrl+O / 打开文件 / 把文件拖进窗口）时落点不统一：没有工作区时不知道该不该顺手把侧栏切过去；已有工作区时也没有「新窗口打开」的语义，用户既可能打断当前窗口的现场，也可能打开了一个侧栏里根本看不见的文件。

**规则**（针对「窗口外的文件」这一条语义，实现在 `renderer/src/lib/openFile.ts`）：

| 本窗口状态 | 行为 |
|---|---|
| 这个文件**已经在本窗口打开** | 什么都不做：不重复打开、不新建窗口 |
| **没有打开任何文件夹** | 在**本窗口**打开，并把侧栏切到该文件所在文件夹 |
| **已打开文件夹** | 在**新窗口**打开；新窗口的侧栏对准该文件的文件夹（文件本来就在继承来的工作区里时保持原工作区，不做无谓的缩小） |

**为什么这样切**：核心诉求是「刚打开的文件必须能在侧栏里看见」。所以判据不是「文件属于哪个文件夹」，而是**本窗口有没有工作区**——没有工作区时本窗口就是一张白纸，直接用它最省事；已有工作区说明这个窗口正服务于另一个文件夹，硬塞进来既打断现场、又让侧栏与内容对不上，于是交给新窗口，并让新窗口自己把侧栏对准目标文件夹。反过来，若文件本来就在当前工作区内，新窗口保持原工作区即可（缩小范围反而丢了上下文）。

**实现要点**：

- **一处实现、四处入口**：`openExternalFile(path)` 被 Ctrl+O / 原生菜单、侧栏空态的「打开文件」按钮、文件菜单「打开…」、编辑器拖放四处调用（验收里有调用点静态核对）。侧栏树里点文件（同一工作区内切换）、最近文档 / 右键「在新窗口打开」、文档内链接点击各有既定行为，不走这条路径。
- **新窗口那一侧**（`renderer/src/main.ts` 的 `--lumin-open` 分支）：打开启动文件后，若该文件不在继承来的工作区内，就把工作区切到它的文件夹——这样「最近文档 → 新窗口」「右键 → 在新窗口打开」也自动获得同一可见性保证。
- **路径判断**（`samePath` / `isInside`）：Windows 大小写不敏感 + 正反斜杠归一，`isInside` 按**目录边界**比较（`C:\Docs` 不会把 `C:\Docs2` 判成内部），两者都有 null 兜底。
- **顺手修掉的 i18n 债**：拖放处理器里原本硬编码了三处中文（不支持的格式、脏数据确认标题与正文），现在复用既有的 `editor.dirtyConfirmTitle/Body` 并新增 `toast.unsupportedFile`（三语言同步、键集合一致）。

**验收**：`tools/_verify-open-file-routing.js` 22/22（在页面里 `await import('/src/lib/openFile.ts')` 驱动**真实模块**）：路径判断的大小写/分隔符/前缀边界；无工作区 → 本窗口打开 + 侧栏切到该文件夹且文件在树里可见；同一个文件再次打开 → `already-open`、窗口数不变、文档不变；有工作区 + 文件在外 → 新窗口（doc = 文件、root = 文件所在文件夹），原窗口完全不受影响；有工作区 + 文件在内 → 新窗口保持原工作区；另覆盖 `openInNewWindow`（最近文档/右键那条路）的两个分支。回归：`_verify-session.js` 16/16、`_verify-bars-no-filename.js` 12/12、`_verify-menu-export-submenu.js` 15/15、`_verify-welcome-removed.js` 32 项通过（其中「最近文档/最近文件夹 → 新窗口」两项在本机隔离实例里因缺工作区夹具跳过，其断言涉及的行为已由上一条用例覆盖）。

### 4.27 文件菜单「导出」收进二级菜单（本次）

原先文件菜单把四种导出格式平铺成四行，菜单过长、也把「导出」这个动作本身淹没了。现在一级只留一个 `导出 ▸`，四种格式进二级浮层（复用 §4.19 建立的二级菜单机制：贴死一级面板重叠 1px、悬停 160ms 宽限、右侧放不下翻到左侧、Esc 先收二级再收一级）。

- **菜单数据**：`SubMenu` 类型本来就支持 `children`（固定 Leaf 列表）与 `slot`（自定义组件）两种二级内容，`placeSub()` 也已按 `slot ? 300 : 220` 预留宽度——只是模板里此前只渲染了 `slot` 分支。本次补上 `children` 分支（行样式与一级项一致），因此**没有改任何定位/悬停逻辑**。
- **i18n**：新增 `menu.export`（导出 / Export / Экспорт），复用既有的 `menu.exportPdf/Html/Word/Epub`；三语言键集合保持一致。

**验收**：`tools/_verify-menu-export-submenu.js` 15/15：一级菜单只剩一个带箭头的一级项「导出」、不再平铺四行；悬停展开的二级浮层标题为「导出」且列出四种格式；浮层与一级面板贴死（`gap = -1`）；指针从一级行平移进浮层不会被关掉、悬停普通项会收起；Esc 先收浮层再收菜单；**动作接线**通过读组件实例的菜单数据断言四项各自调用 `runExport('pdf'|'html'|'word'|'epub')`——这里刻意不点击导出项：点击会真的走导出流程并弹出系统「另存为」对话框，而 `window.luminAPI` 是冻结对象（打桩无效），自动化无法取消原生对话框（第一版就踩了这个坑），因此改为「结构 + 悬停/关闭机制 + 接线」三段式验证。

### 4.28 一个文件只开一个窗口（本次）

**问题**：同一个文件可以在两个窗口里各开一份——多开的那份不会同步，改哪一份都可能被另一份覆盖，用户也分不清哪个是「正本」。

**方案**：主进程维护一张「哪个窗口开着哪个文档」的注册表，打开文件时先查表。

- **注册表**（`src/main/services/openDocs.ts`）：`window.id → 文档路径`。数据来自渲染层在**文档切换时**的上报（`window:docPath`），因此是**精确即时**的，不依赖会话槽位那套 800ms 节流写库；窗口关闭时 `forgetWindow()` 清账，不留已销毁窗口的条目。路径比较与渲染层同一套判据（Windows 大小写不敏感 + 分隔符归一）。
- **查表与聚焦**（`src/main/ipc.ts` 的 `window:focusByDoc`）：返回 `'focused'` / `'not-open'`。命中别的窗口时把那个窗口**唤到前面**（最小化则先 `restore()`，再 `show()` + `focus()`，Windows 任务栏随之激活）；命中的唯一窗口就是调用方自己时不聚焦、也不新建（渲染层已先判掉「本窗口已打开」，主进程这层是兜底）。
- **落点规则随之调整为四步**（`renderer/src/lib/openFile.ts`）：
  1. 已在本窗口打开 → 什么都不做；
  2. **已开在别的窗口 → 聚焦那个窗口**；
  3. 本窗口没有工作区 → 在本窗口打开 + 侧栏切到该文件的文件夹；
  4. 本窗口已有工作区且没人开着 → 新窗口打开。
  **顺序很关键**：一开始我把「本窗口没有工作台就直接打开」放在第 2 步之前，结果一个已经开在别处的文件会在无工作台的窗口里**又开一份**（正是要消灭的重复；回归用例 `no-workspace-still-focuses-existing` 就是这条），现已把它排到查表之后。
- **覆盖面**：Ctrl+O / 打开文件 / 拖文件进窗口（走 `openExternalFile`）与**最近文档**（侧栏按钮、文件菜单二级，走 `openInWindowOrFocus`）都会先查表。**例外**：侧栏树右键的「在新窗口打开」是用户**显式**要求新窗口，保持原样（否则点了没有任何新窗口出现会像 bug）；文档内链接点击、`最近文件夹` 也各有既定行为。

**验收**：`tools/_verify-open-file-dedup.js` 21/21（隔离实例，两个窗口 A/B）：A 开着 `x.md` 后，B 问 `focusWindowByDoc(x.md)` → `focused` 且**窗口数不变**、A 获得焦点、B 不失焦于自身；A 最小化后再问 → `focused` 且 A 被还原并聚焦（`visibilityState=visible` + `hasFocus`）；没人开的文件 → `not-open`；**A 开着 x.md 而 B 没有工作台**时，B 走真实入口打开 x.md → `focused-existing`、B 不会多出一份、窗口数不变（回归用例）；B 打开没人开的 `y.md` → `opened-here` 且侧栏切到该文件夹；B 有工作区后打开没人开的 `z.md` → 新窗口；最近文档入口对已在别处打开的 `x.md` → `focused-existing` 且窗口数不变；关掉 A 后同一路径变回 `not-open`（注册表清账）。回归：`_verify-open-file-routing.js` 22/22、`_verify-session.js` 16/16、`_verify-bars-no-filename.js` 12/12；`npm run typecheck` 双工程 0 error，改动文件 `eslint` 0 error。

### 4.29 快捷键系统：命令注册表 + 可自定义键位 + Ctrl+Tab 切窗口（本次）

**目标**：把散落三处的按键处理收敛成一套可扩展、可自定义的系统，并补上应用内切换窗口的快捷键。

**改造前的问题**：快捷键有**两套真相**——主进程原生菜单自带 `accelerator`（Ctrl+N/O/S…），渲染层又有一份硬编码的 `keydown` 判断（`useAppActions` 里十几个 `if`）。用户既改不了键，也容易出现重复/绕过的行为；加一条快捷键要改两处。

**架构**（`renderer/src/lib/keymap/`，与 VS Code / Atom 同一套思路，只是规模小得多）：

```
keys.ts      按键表达式解析/规范化/格式化/匹配（Mod、Ctrl、Shift、Alt、Meta、Tab、F12、, …）
service.ts   命令注册表 + 解析（用户覆盖优先）+ 全局 keydown 派发 + 冲突计算 + 录制态
commands     应用级命令表（composables/useKeymap.ts）：id / i18n 标题 / 分组 / 默认键 / when / run
```

- **一处声明**：命令表的每一项 = 一条可被快捷键触发的命令，`run` 统一调 `handleMenu(action)`——和原生菜单**同一份实现**，因此不存在「菜单能做的事快捷键做不到」。
- **扩展方式**：加一条快捷键 = 命令表里加一项（设置界面、冲突检测、恢复默认、i18n 检查全部自动生效）；换默认键只改 `defaultKeys`，用户改过的不受影响。
- **解析优先级**（写在 `service.ts` 顶部注释里）：用户覆盖 > 代码默认；同一档内**后注册者胜**（与 VS Code「later wins」一致）；`keybindings[id] = null` 表示**明确解绑**。
- **派发**：一个 window 捕获阶段的 `keydown`；只处理带修饰键的组合（纯字母键留给编辑器/输入框）；`when: 'notInInput'` 的命令在输入框里让行（Ctrl+F）；**录制期间整体让行**（否则「录 Ctrl+N」会真的执行它 —— §4.47 之后这一下会**开一个新窗口**）。
- **原生菜单不再自带 accelerator**（`src/main/menu.ts`）：否则用户改了键，原生那份照旧触发——两套真相 + 重复触发。菜单项保留（系统级可访问性），应用内快捷键统一由渲染层接管。

**默认键一览**（26 条，分 6 组；「导出」单独成组）：

| 分组 | 命令 | 默认键 |
|---|---|---|
| 文件 | 新建 / 新建窗口 / 打开… / 打开文件夹… / 保存 / 另存为… | `Ctrl+N` / `Ctrl+Shift+N` / `Ctrl+O` / `Ctrl+Shift+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| 文件 | 关闭窗口 | `Ctrl+W` |
| 导出 | 导出为 PDF（HTML/Word/EPUB 默认不绑） | `Ctrl+Shift+E` |
| 编辑 | 查找 / 替换、全局搜索、设置 | `Ctrl+F`、`Ctrl+Shift+P`、`Ctrl+,` |
| 视图 | 切换侧边栏 / 专注模式 / 打字机模式 / 循环切换编辑模式 | `Ctrl+Shift+B` / `Ctrl+Shift+F` / `Ctrl+Shift+T` / `Ctrl+/`（模式直选三条默认不绑） |
| **窗口** | **切换到下一个窗口 / 上一个窗口** | **`Ctrl+Tab` / `Ctrl+Shift+Tab`** |
| 帮助 | 打开快捷键设置（关于默认不绑） | `Ctrl+K` |

`Ctrl+Tab` 由主进程按**窗口创建顺序循环**（1 个窗口不动、2 个来回切、N 个依次走），语义与浏览器 Ctrl+Tab 切标签页一致；目标窗口最小化时先还原再聚焦（`services/openDocs.ts` 的 `focusWindow`）。

**设置界面**（设置 → 快捷键，`components/SettingsKeymap.vue`）：搜索（命令名或按键）、按分组浏览、逐条显示键位胶囊 / 「已修改」/「冲突」标记、点键盘图标进入**录制**（Esc 取消、Backspace 解绑）、单条恢复默认、全部恢复默认，并显示已自定义条数；键位写入 `settings.keybindings`（SQLite kv，`null` = 解绑），三语言文案同步。

**本次顺带修掉的两个真 bug**（都是被验收用例逼出来的）：

1. **Pinia `$patch(对象)` 对嵌套对象是深合并**，所以「恢复默认」用 `$patch({ keybindings: {...} })` 删键会被合并回来 → 表现为「点了恢复默认却没生效」。改用 `$patch(函数)` 整体替换。
2. **`focusWindow` 只用 `isMinimized()` 判断**：窗口在应用处于后台时被最小化，Electron 可能报 `isMinimized() === false`，于是只调 `focus()` 得到「焦点给了它、但它还最小化着」的怪状态。改为 `isMinimized() || !isVisible()` 一起判断（`restore()` 对非最小化窗口本来就是 no-op）。

**验收**：`tools/_verify-keymap.js` **31/31**（隔离实例；含页面内的按键投递探针）——**§4.47 之后为 33/33**（C 段改为「窗口数 +1」判定，并新增「新窗口同工作区且未命名、不落盘」两条）：命令表 26 条且标题/分组 i18n 全部有值、默认键 `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Mod→Ctrl` 规范化、无重复默认键；默认键真的生效（`Ctrl+/` 切模式、`Ctrl+Shift+B` 侧栏、`Ctrl+Shift+P` 全局搜索）；`Ctrl+N` **只执行一次**（原生菜单已无 accelerator；§4.47 后「执行一次」= 只多一个窗口）；自定义后新键生效且旧键失效、用户绑定优先于默认绑定、冲突可见、解绑后按键无反应、恢复默认后默认键回来；**`Ctrl+Tab` / `Ctrl+Shift+Tab` 真的切换窗口**（focus/blur 事件流判定，含反向与自定义键）；设置界面 26 行 / 7 分组 / 45 个键位胶囊 / 搜索过滤 / 进入录制 / **录制期间按 Ctrl+N 不开新窗口** / 录制写入生效；直读 SQLite 证明改键落库，reload 后解析结果仍是自定义键。回归：`_verify-editor-menu.js` 51/51、`_verify-open-file-routing.js` 22/22、`_verify-open-file-dedup.js` 21/21、`_verify-session.js` 16/16、`_verify-menu-export-submenu.js` 15/15、`_verify-window-title.js` 14/14、`_verify-bars-no-filename.js` 12/12、`_verify-welcome-removed.js` 32 项通过（另 2 项为既有的隔离实例环境跳过）、`_verify-alt-menu.js`（Alt+F 仍由应用内菜单接管）；`npm run build`（含双工程 typecheck）0 error。

**范围与边界**：本表管**应用级命令**；编辑器内部的排版键（`Ctrl+B/I/U`、`Ctrl+Z/Y`、Markdown 输入规则等）由 ProseMirror / CodeMirror 自己的 keymap 处理，属编辑器内核语义，**不在**设置里改（要改需把编辑器键也搬进注册表，是另一件事）。另外，侧栏树右键的「在新窗口打开」仍是显式新建窗口，不参与 §4.28 的去重。

### 4.30 另存为之后侧栏跟到保存位置（本次）

**问题**：另存为把文件写到别处后，侧栏还停在原来的工作区——那份新文件在侧栏里根本看不见，像是「存丢了」。

**规则**（`stores/files.ts` 的 `syncWorkspaceToPath` / `revealPath`，与 §4.26「刚打开的文件必须能看见」同一条原则）：

| 保存位置 | 侧栏行为 |
|---|---|
| 当前工作区**之外**，或本窗口**没有工作区** | 工作区切到该文件所在文件夹（`setRoot`，并记入最近文件夹） |
| 当前工作区**之内**（含深层子目录） | **不缩小范围**，逐级展开路径把文件露出来；列表视图则让文档缓存重扫一次 |

- `saveAs()` 的时序：先写盘，**成功后**才同步侧栏（`const ok = await this.save(); if (ok) await this.syncWorkspaceToPath(path)`）——写失败不该把侧栏带走。
- 落成 store 动作而不是写在组件里：侧栏状态（`root` / `expanded` / `dirCache` / `docsEpoch`）本来就归 `files` store 管；将来「重命名到别处」「移动到文件夹」也能复用同一个动作。
- **顺带抽出 `lib/pathUtils.ts`**：`normPath` / `samePath` / `isInside` / `parentDir` / `ancestorDirs`。原先 `samePath`、`isInside` 只存在于 `lib/openFile.ts`，而 store 也要判「在不在工作区内」——直接 import 会形成 `stores/files ↔ lib/openFile` 循环，抽出公共模块后两边共用同一套判据（Windows 大小写不敏感 + 分隔符归一 + 目录边界），`lib/openFile.ts` 仍转出这两个函数供调用方就近引用。

**验收**：`tools/_verify-save-as-workspace.js` **17/17**（隔离实例 + 真实文件系统）：路径工具边界（`ancestorDirs`：直接子文件 / 深层嵌套 / 工作区外为空；`parentDir('C:\x') === 'C:\'`、裸文件名 → `''`；`C:\Docs` 不把 `C:\Docs2` 判成内部）；保存到工作区内 → root 不变、`sub` 被展开且树里能看到 `b.md`；保存到工作区外 → root 切成目标文件夹并落库（`workspace:getRoot` 一致）、树里能看到 `c.md`；深层路径 `d1/d2/deep.md` → 两级祖先都展开；没有工作区时保存 → 同样切到该文件夹；并静态核对 `saveAs()` 在保存成功后调用了它。回归：打开文件落点 22/22、一文件一窗口 21/21、会话 16/16、工具栏去文件名 12/12；`npm run typecheck` 双工程 0 error。

**说明**：原生「另存为」对话框无法在自动化里作答，因此上面用「改路径 → `save()` 写真实文件 → `syncWorkspaceToPath`」的等价序列验证，并静态核对 `saveAs` 的调用点；对话框本身与本功能无关。

### 4.31 分段控件重做：滑动指示块（本次）

**问题**：工具栏的「实时渲染 / 分屏 / 源码」原来是三个图标+文字按钮各自填充（激活项 `accent-soft` 底 + 强调色字），读起来像「三个小按钮」而不是一个控件；加上三段中文标签，横向也占地方。侧栏的「树 / 列表」是另一套写法，同一类交互两种长相。

**做法**：抽出一个通用 `components/SegmentedControl.vue`，两处共用（工具栏 3 段、侧栏 2 段），采用当代主流的**滑动指示块（sliding thumb）**：

- **一条中性轨道 + 一个随选中项平移的抬升色块**：轨道用 `--panel-2` + `--edge` 描边 + 极轻内阴影；指示块用 `--elevate` + 发丝描边 + 1px 投影——「浮起来」的三件套让它在浅色/深色/羊皮纸下都立得住。
- **不需要测量 DOM**：指示块宽度 `calc((100% - 内外边距) / 段数)`、位移 `translateX(序号 × 100%)`（百分比相对**指示块自身**宽度），因此尺寸变化/字体变化都不会错位，也没有测量后的跳动。
- **动效只走 transform**（`0.24s cubic-bezier(.4,0,.2,1)`，合成层），并遵循 `prefers-reduced-motion`。
- **克制的强调色**：激活项文字转 `--ink`、图标用 `--accent` 点一下，而不是整块染色；未激活 `--ink-3`、悬停 `--ink-2`。
- **工具栏只留图标**（文案在 `title`——悬停提示会带上 `Ctrl+/`——与 `aria-label` 上），控件宽度从约 180px 收到 108px，工具栏更透气；`role="tablist"/"tab"` + `aria-selected` 保持不变，两个控件的无障碍名称新增 i18n 词条（`editor.viewMode` / `sidebar.filesView`，三语言同步）。
- 顺手删掉已无引用的 `.mode-seg` / `.mode-seg-btn` 死 CSS（38 行）。

**验收**：`tools/_verify-segmented-control.js` **16/16**（隔离实例，几何与状态都按 DOM 实测）：两处控件段数正确（3 / 2）、每段只有 1 个图标且无可见文字、提示里带 `Ctrl+/`、`aria-selected` 与激活段一致、各段等宽；**指示块宽度 = 一段宽（±1px）且与激活段左边缘重合**；点击第 3 段 → 模式变 `source`、`aria-selected` 跟着走、**指示块位移正好两段宽**（21→89，段宽 34）；侧栏切到列表视图且指示块跟上；指示块带 transform 过渡与投影、底色 ≠ 轨道底色；light/dark/sepia 三主题下轨道与指示块颜色各不相同（令牌驱动）；工具栏无横向溢出（`scrollWidth - clientWidth = 0`）。回归：工具栏去文件名 12/12（按钮数仍 27）、去欢迎页 32 项通过（另 2 项为既有的隔离实例环境跳过）；`npm run typecheck` 双工程 0 error。另存了三张 3× 截图（浅色/深色/羊皮纸）到 `%TEMP%\lumin-seg-*.png` 供人工看观感。

### 4.32 左缘展开把手重做（本次）

**用户反馈的三点**：① 长得不好看；② 出现/消失「卡卡的」；③ 热区太小，鼠标要靠得很近才现身。

**② 的根因（值得记一笔）**：把手原先是 Tailwind 工具类拼的——`-translate-x-1` / `translate-x-0` 在 **Tailwind v4 里写的是 `translate` 长属性**，而类上声明的过渡是 `transition-[opacity,transform,color]`：**被动画化的属性（transform）和实际承载位移的属性（translate）不是同一个**，于是位移根本不参与过渡，只有透明度在淡入淡出，看起来就是「啪地跳一下」。另外 `top-1/2 -translate-y-1/2` 把纵向居中混在同一个属性里，也让位移难以单独控制。

**改法**：

- **把位移交给 `transform`**：新增 `.sidebar-handle` 类（style.css），收起态 `translate3d(-100%, -50%, 0)`、浮现态 `translate3d(0, -50%, 0)`——**整体退到窗口之外**，不再只挪 4px（原来收起时还会露出一条边，视觉上像「没关干净」）。过渡显式写在 `transform` / `opacity` 上：`transform .3s cubic-bezier(.22,1,.36,1)`（带一点回弹的缓出，滑出更顺）+ `opacity .22s`，并加 `will-change: transform, opacity` 走合成层。
- **③ 双阈值迟滞**：`EDGE_SHOW_PX = 120`（原来是 86，热区扩大约 40%）、`EDGE_HIDE_PX = 200`。指针进 120px 内浮现、退到 200px 外才收起，**中间 80px 是迟滞带**——单阈值时指针停在边界上会反复闪现，这是「忽有忽无」的另一个来源。
- **① 外观**：22×56 的小药丸，只在右侧圆角（12px）贴住窗口边缘；`--elevate` 92% 半透明 + `backdrop-filter: blur(10px)`（与工具栏/状态栏同一套玻璃语言）+ `--shadow-2` 轻投影；默认 `--ink-3`，悬停/键盘聚焦时转 `--accent` 并加一圈 `--accent-soft` 光环，悬停再往外探 2px 提示可点；遵循 `prefers-reduced-motion`（此时只保留淡入淡出）。
- 键盘 Tab 聚焦仍会浮现（原行为保留）、点击展开后把手卸载并落库（`sidebarVisible`）不变。

**验收**：`tools/_verify-sidebar-handle-style.js` **19/19**（隔离实例 + CDP 真实指针移动）：折叠后把手存在；**收起态整体在窗口外**（`left=-22 / right=0`）+ `opacity:0` + `pointer-events:none`；指针到 x=80 → 浮现且左边缘贴 0；**退到 x=150（迟滞带内）仍保持浮现**（不闪）；退到 x=260 → 收起；再次靠近 x=100 → 又浮现；过渡属性确认为 `transform, opacity, color, box-shadow` 且带 `cubic-bezier(.22,1,.36,1)`/`0.3s`；**位移落在 `transform` 上而 `translate` 长属性为 `none`**（即上一轮那个坑已修掉）；`will-change` 含 transform；圆角为 `0 12px 12px 0`；玻璃质感 + 投影；三主题下底色/字色各不相同（令牌驱动）；键盘聚焦浮现；点击后侧边栏展开且设置落库、把手卸载。回归：分段控件 16/16、工具栏去文件名 12/12、会话 16/16、去欢迎页 32 项通过；`npm run typecheck` 双工程 0 error。另存 `%TEMP%\lumin-handle-{light,dark,sepia}.png` 三张 3× 截图供观感确认。

### 4.33 目录对齐 Typora（去掉左侧色条、默认蓝色）+ 点击标题平滑滚动（本次）

**用户要求**：① 优化目录样式——**取消左侧颜色条**、做成 Typora 那样；② 点目录里的标题时界面要**滑过去**，而不是直接跳过去。

**样式改法**（`assets/style.css` 的「目录」段 + `components/editor/TocNodeView.vue`）：

- **去掉整套卡片化外观**：原先 `.md-toc` 有「目录」标题行 + 左侧色条 + 底色 + 外框 + 圆角，现在全删——目录就是一个普通块（`margin: .9em 0`），嵌在正文流里，与 Typora 的观感一致。
- **改成按层级的圆点列表**：条目带 `--toc-depth`（`min(level, 4) - 1`，0..3），`padding-left: calc(1.15em + var(--toc-depth) * 1.15em)` 由层级算缩进；`::before` 的圆点按层换字符 **`•` / `◦` / `▪`**（第 3 级起 0.9em 略小），圆点定位在 `left: calc(var(--toc-depth) * 1.15em)`。字号 1em、行高 1.75 与正文同款，颜色继承正文、悬停转 `--accent-2`——**全走主题令牌**，三套主题自动跟随。
- 只留一个内联变量（`--toc-depth`），缩进与圆点都在 CSS 里推导，DOM 里不再有装饰元素。
- **默认字色改为蓝色**（同日追问）：新增主题令牌 `--toc-link`，条目 `color: var(--toc-link)`。**没有直接用 `--accent`**——浅色/深色主题的 accent 是靛紫（#6366f1 / #818cf8），到了一直走暖色的羊皮纸主题就变成琥珀（#b45309），用 accent 就「不是蓝的」。所以三套主题各自给一个蓝并校过对比度（按各自的 `--app` 底色算）：浅色 `#2563eb`（blue-600，在 #f5f6f8 上 ≈4.7:1）、深色 `#60a5fa`（blue-400，在 #0f1116 上 ≈7.5:1）、羊皮纸 `#1d4ed8`（blue-700，在 #f1e9d5 上 ≈5.5:1）——都过 AA（正文 4.5:1）。悬停时文字与圆点一起用 `color-mix(in srgb, var(--toc-link) 78%, var(--ink))`——浅色变深、深色变亮，不额外加令牌，也不会从蓝跳成紫（原来是 hover → `--accent-2`）。

**平滑滚动改法**（新增 `src/renderer/src/lib/editor/smoothScroll.ts` + `stores/editor.ts` 的 `jumpToHeading`）：

- **一个动作，两处受益**：目录条目与侧栏大纲调用的是**同一个** `editorStore.jumpToHeading(pos)`，所以「目录能滑、大纲也能滑」，以后改一处两边都对。
- **流程**：先只移动光标（`setTextSelection`）→ 把 focus 顺带造成的瞬时滚动**原样复位** → 再对 `.editor-scroll` 做 `behavior: 'smooth'` 的滚动；目标位置用 `view.domAtPos(pos)` 找到标题的 DOM 元素，顶部留 12px 呼吸位。
- **不再用 ProseMirror 的 `.scrollIntoView()`**：它一步写死 `scrollTop`，视觉上就是「啪」地跳（这正是用户反馈的问题）。
- **无障碍**：`prefers-reduced-motion: reduce` 时退化为瞬时定位（`scrollContainerTo` 第三参由 `prefersReducedMotion()` 决定）。
- **坑 1**：`scrollTo({ behavior })` 的显式取值**优先于** CSS 的 `scroll-behavior`——所以打字机模式下容器自带的 `smooth` 也能被我们强制瞬时复位，不会被 CSS 反噬。
- **坑 2（实测抓到的「偶发瞬移」）**：Tiptap 的 `focus()` 默认 `scrollIntoView: true`，而它是在 **`requestAnimationFrame` 里**补一次 `scrollIntoView`（瞬时滚动）。若我们的平滑动画同步启动，那一帧的瞬时滚动会把动画打断 —— 表现为「多数时候滑、偶尔还是直接跳过去」。修法两步：`focus(null, { scrollIntoView: false })` 关掉它；并把平滑滚动排到下一帧执行（`document.hidden` 时直接瞬时，免得 rAF 不触发导致回到前台才莫名滚动）。

**验收**：`tools/_verify-toc-style-scroll.js` **23/23**（隔离实例，样式与滚动全部按 DOM / 逐帧滚动位置实测）：

- 样式：无色条（判据是 `border-left` **宽度 0**，不是 `style: none`——Tailwind preflight 给所有元素写了 `border-style: solid`）、条目无底色/外框/阴影/伪元素底色、无「目录」标题行、3 个条目圆点恰为 `•`/`◦`/`▪`、缩进 20/39/59px 单调递增、`font-size: 17px` / `line-height: 29.75px` / `cursor: pointer`。
- 滚动：从文档底部（`scrollTop 2506`）点「一级标题 Alpha」→ 逐帧采样得到 **50 个不同值**（2506 → 2504 → 2497 → 2483 → … → 28），最终停在该标题上方 12px（`headingTop 40` / `finalTop 28`），光标落在该标题；**并额外断言「平滑调用之后不允许再出现任何滚动写入」**——这条就是坑 2 那个 bug 的回归护栏（探针实测只应有 `scrollTo{top:2506,behavior:'instant'}` 与 `scrollTo{top:28,behavior:'smooth'}` 两条，之后为空）。
- `prefers-reduced-motion: reduce` 模拟下同一路径只采到 2 个值（瞬时）、落点相同；侧栏大纲点击同样平滑（证明是同一个动作）。
- 颜色（**23 项**里的 6 项）：默认字色三套主题都是蓝且**等于令牌解析值**（用临时元素取 `var(--toc-link)` 的计算色，不把色值写死在套件里）、且 ≠ 正文墨色；用真实指针移上去验证悬停色仍是蓝且确实变深（`color-mix` 会算出浮点格式 `color(srgb …)`，套件里的解析两种格式都吃）；light/dark/sepia 轮换时逐主题断言 `rgb(37,99,235)` / `rgb(96,165,250)` / `rgb(29,78,216)`。
- 截图：`%TEMP%\lumin-toc-{light,dark,sepia}.png`（3×）供人工看观感。
- 回归：分段控件 16/16、工具栏去文件名 12/12、会话 16/16、去欢迎页 32 项通过（另 2 项为既有的隔离实例环境跳过）、旧目录用例 `_verify-toc.js` 的插入/点击/往返仍正常（3 个条目、点击后光标落在「二级标题B」、Markdown 仍往返成 `[TOC]`）；`npm run typecheck:web` 0 error。
- 顺带修了验收脚手架在**全新配置目录**下的三处隐含假设（侧栏默认收起、标签页可能停在大纲、编辑器模式跨会话持久化），并给 `tools/*.ps1` 补了 UTF-8 BOM——PowerShell 5.1 会把「无 BOM 的 UTF-8」按 ANSI 解码，中文注释里的引号会把脚本整体解析搞崩。

### 4.34 侧栏文件树重做：单色图标 + 16px 网格 + 三种状态（本次）

**用户要求**：重新设计左侧侧栏文件树的样式，**不要太花里胡哨，简约大气**，符合项目与「大厂」审美。

**三条设计决定**（都为了「安静」）：

1. **图标全部单色**：文件夹原来是 `color-mix(--warning 70%, --ink-3)` 的琥珀色——颜色语义不对（`--warning` 是警示色），视觉上也花。现在类型图标统一 `--ink-3`，靠字形区分（`folder` / `folderOpen` / `file`），选中时才整体转 `--accent`。
2. **固定 16px 缩进网格 + 等距行**：行高锁 27px、圆角 6px、字号 13px，缩进 `padding-left: calc(8px + depth * 16px)`（原来的 14px 步进偏挤）。层级靠间距表达，**不画连线、不做色条**。
3. **只有三种状态**：默认 `--ink-2` / 悬停 `--panel-2` + `--ink` / 当前项 `--accent-soft` + `--accent` + 500 字重（悬停当前项时底色只是同色系加深到 16%，不换色系）。展开箭头 12px，收起不变换、展开 `rotate(90deg)`，过渡 0.18s。

**实现**：行/箭头/图标/空目录提示/重命名输入框全部收敛到 `style.css` 的「侧栏文件树」CSS 块（`.tree-row` / `.tree-chevron` / `.tree-icon` / `.tree-label` / `.tree-empty-hint` / `.tree-rename-input`），`TreeNode.vue` 模板只留结构（十几行 Tailwind 工具类去掉，缩进由 `--tree-depth` 在 CSS 里算）；展开/收起从全局 `.list-*`（带 `scale(0.98)`、250ms）换成专用的 `.tree-*` 过渡（0.14s、`opacity` + `translateY(-2px)`，不带缩放）。同时补了几个测试钩子（`data-tree-row` / `data-tree-scroll` / `data-tree-children` / `data-tree-chevron` / `data-tree-icon` / `data-tree-empty-folder`）。

**顺手修掉两个真 bug**（都是「看着像样式、其实是缺陷」）：

- **选中文件时图标不变色**：原来 `class="text-ink-3" :class="isCurrent ? 'text-accent' : ''"` —— 两个 `text-*` 工具类同时存在、特异性相同，生成的 CSS 里 `text-ink-3` 在后面，把 `text-accent` 压掉了，于是选中行的文字是强调色、图标还是灰的。改成父状态选择器 `.tree-row.is-current .tree-icon` 后必然生效。
- **箭头旋转其实没有动画**：`class="transition-transform"` + `:class="isOpen ? 'rotate-90' : ''"` —— Tailwind v4 的 `rotate-90` 写的是 **`rotate` 长属性**，而过渡声明的属性是 `transform`，两者不是一个属性，所以旋转是「啪」地跳（和 §4.32 侧栏把手踩的是同一个坑）。现在用 `.tree-chevron.is-open { transform: rotate(90deg) }` + `transition: transform 0.18s`。

**验收**：`tools/_verify-sidebar-tree-style.js` **24/24**（隔离实例 + 夹具工作区三层嵌套/空目录/未展开目录，全部按 DOM 实测）：行高全为 27px、圆角 6px、字号 13px；**缩进步进 16px**（图标槽与文字各测一次，行盒子整宽不变是设计如此）；类型图标同色且等于 `--ink-3` 令牌、尺寸 15px；默认文字 = `--ink-2`；悬停（真实指针）底色 = `--panel-2`、文字 = `--ink`；选中底色 = `--accent-soft`、文字与图标 = `--accent`、字重 500；选中项悬停是同色系加深（alpha 0.16 > 0.10）；未展开目录箭头 `transform: none`、展开目录为 `matrix(0,1,-1,0,0,0)`（正好 90°），且过渡确实挂在 `transform` 上；空目录提示文字与同级子项文字左对齐（75 = 75px）；`.tree-*` 过渡为 `opacity, transform 0.14s`（无 scale），收起后子节点在 180ms 内从 DOM 消失；三套主题下选中底色都来自各自令牌。另存 `%TEMP%\lumin-tree-{light,dark,sepia}.png` 三张截图供人工看观感。

**回归**：分段控件 16/16、工具栏去文件名 12/12、会话 16/16、去欢迎页 32 项通过（另 2 项为既有的隔离实例环境跳过）；`npm run typecheck:web` 0 error，改动文件 eslint 0 error。

### 4.35 任务栏右键对齐 Typora：应用标识 + 快捷方式 + 跳转列表（本次）

**用户反馈（两轮）**：① 右键任务栏里其他应用（如 Typora）的图标会列出很多条目，其中一条就叫应用名，点它出来一个**全新窗口**；Lumin 那条却叫「Electron」，点下去出来的是 **Electron 原生窗口**。② 第一轮改完仍然如此：右键只有三项——「Electron」「固定到任务栏」「关闭窗口」。

**根因**（第一轮只治了半张菜单，第二轮才找到真正的那半张）：

1. **任务栏右键菜单第一项的名字与点击行为，来自该 AUMID（应用标识）注册的那条开始菜单快捷方式。** Windows 只认「标识 → 快捷方式」这条链：**名字**取快捷方式的显示名，**点击执行的命令**取它的 target + args。开发态跑的是 `electron.exe`，而 `@electron-toolkit/utils` 的 `setAppUserModelId()` 在开发态用的正是 `process.execPath`——那个标识在 Windows 眼里就是 electron.exe 本身：名字显示成「Electron」，点击执行**不带参数**的 electron.exe（= Electron 自带的示例窗口），「固定到任务栏」固定下来的也是这条无参数快捷方式。**应用侧改不了别人的快捷方式，但可以自己注册一条正确标识的快捷方式**，让 Windows 认这一条。
2. 应用侧此前没注册任何跳转列表条目，于是连 Tasks／最近文档都没有。
3. 为什么第一轮改完没变化：Win11 里**只有固定到任务栏的图标**右键才展开完整跳转列表；未固定时就是「应用名 / 固定到任务栏 / 关闭窗口」三项——第一项正是根因 1 那条。所以光注册 Tasks 是不够的，必须先把**标识**换对。

**改法**（`src/main/services/taskbar.ts`）：

- **`appId()`**：打包态 `com.lumin.app`（与安装器一致），开发态 `com.lumin.app.dev`（加后缀，避免和装好的版本互相顶掉快捷方式）。`src/main/index.ts` 里改成 `app.setAppUserModelId(taskbar.appId())`，并且**在建窗口之前**设置。**（后续修正：开发态再按配置目录分流 —— 默认配置目录才是 `.dev`，隔离实例用 `.dev.test`，原因见 §4.46。）**
- **`ensureAppShortcut()`**：用 `shell.writeShortcutLink(path, 'create', {...})` 在开始菜单（`%APPDATA%\...\Start Menu\Programs\Lumin (dev).lnk`）写一条带 `target`（electron.exe / Lumin.exe）、`args`（开发态含**应用目录** + `--lumin-new-window`）、`appUserModelId`、`description` 的快捷方式；每次启动刷新一遍（幂等）。有了它：菜单第一项显示 **Lumin (dev)**，点它就是「electron.exe + 应用目录」→ **新的 Lumin 窗口**；用户「固定到任务栏」时，Windows 按 AUMID 复制这条快捷方式，**参数一起固定**。
- **Tasks 那条改名「新建窗口」**（按语言本地化）：它和「应用名」那条不再重名，各司其职（前者是显式动作，后者是 Windows 的启动项）。
- **最近文档**：custom 分类（分类名跟随界面语言），每条的 program/args 同样显式指向本应用。**故意不用 `app.addRecentDocument()`**：那个把点击交给**文件关联**，开发态 electron.exe 没有 `.md` 关联，用户点「最近」反而会叫起别的程序（机器上装了 Typora 就开 Typora）。
- **主进程解析这些开关**（`parseLaunchIntent`，冷启动与第二实例两条路都认）：
  - 运行中的实例收到 `--lumin-new-window` → 开干净新窗口（与「文件 → 新建窗口」同一路径，带 `--lumin-no-workspace`）；
  - 收到 `--lumin-open=<file>` → **先查这篇是否已在别的窗口开着**，是则把那窗口唤到前面（沿用 §4.28 的「一个文件只开一个窗口」），否则新开窗口打开它；
  - 什么都没有 → 聚焦已有窗口（原行为）。
  - 冷启动带 `--lumin-open` 时**不拉会话恢复**：意图很明确就是开这一篇，否则会先把一堆旧窗口恢复出来再把这篇插进去；槽位数据仍留在 kv，下次正常启动照旧恢复。
- **重建时机**：启动时先写快捷方式、再注册跳转列表；`window:docPath`（文档切换）后节流 1.5s 重建（等这次打开先落库）；换语言或最近列表变化（含界面上「清空最近」）时立即重建。

**验收**：`tools/_verify-taskbar-jumplist.js` **25/25**（隔离实例 + 主进程自检日志 + **真的再起一个进程**）——该套件现为 **31/31**，新增的断言见 §4.46：

- 标识与快捷方式：`shortcut ok=true`，**AUMID 是我们自己的且不含 electron.exe**（这条直接钉住「名字显示成 Electron」的根因；§4.46 之后隔离实例的期望值改为 `com.lumin.app.dev.test`），target 是 electron.exe、args 含应用目录；`shell.readShortcutLink` **回读**校验磁盘上那条快捷方式与写入一致（不是只信我们的意图）；快捷方式文件确实存在于开始菜单；它的 target+args 恰好等于下一条里被验证过能开新窗口的命令。
- 跳转列表：`status=ok tasks=1 title="新建窗口"`（`setJumpList` 的返回值，Windows 真收下了）。
- **行为**：带 `--lumin-new-window` 起第二进程 → 多出一个窗口，且该窗口 `location.href` 是我们的渲染页、`window.luminAPI` 在、标题是 `Lumin`——即**不是** Electron 原生窗口；带 `--lumin-open=<beta.md>` → 新窗口打开的正是那篇；同一篇再来一次不多开；不带参数再来一次不多开；冷启动带 `--lumin-open=<alpha.md>` → 只开一个窗口并直接打开该文档。

**踩坑记录**：

- Windows 上主进程的 `console.log` 拿不到——把 electron 的 stdout 重定向到文件后，里面只有 Chromium 那行 `DevTools listening`（GUI 子系统进程没有控制台）。所以自检信息落 `%TEMP%\lumin-taskbar.log`，且只在 `LUMIN_DEBUG_PORT`／`LUMIN_STARTUP_LOG` 打开时写。
- `shell.writeShortcutLink(path, 'replace', ...)` 在**文件还不存在**时会失败（`replace` 的语义是「只替换已存在的」）——用 `'create'`（它会覆盖已存在的）。
- **验收里不要真的去 shell 打开这条 .lnk**：它是应用自己的快捷方式，不带 `--user-data-dir`，于是会连到「默认配置目录」那个实例上——也就是**用户正在用的那个应用**，等于拿验收去动用户的窗口（踩过一次，用户那边多出一个窗口）。所以改成断言「快捷方式的 target+args 等于已通过隔离验证的那条命令」，真正的启动行为由隔离实例那条用例负责。

**用户侧需要做的一步**：重启 Lumin（标识在启动时设置），之后右键任务栏图标第一项就是「Lumin (dev)」；把旧的「Electron」固定取消、重新固定新的按钮，固定下来的那条快捷方式会带参数（Windows 按 AUMID 复制我们自己写的那条）。若名字没立刻变，是 shell 缓存没刷新，重登或重启资源管理器即可。

**回归**：会话 16/16、目录 23/23、文件树 24/24、打开落点 22/22、单文件单窗口 21/21、新窗口干净 13/13、另存为切工作区 17/17、重命名 13/13、去欢迎页 32 项（另 2 项既有环境跳过）、工具栏去文件名 12/12；`npm run typecheck` 0 error。

> 打包提醒：`package.json` 目前还没有 electron-builder 配置，将来加的时候 `appId` 要写成 `com.lumin.app`（与 `appId()` 的打包分支一致），安装器就会建出同名标识的 `Lumin.lnk`，与现在的开发态逻辑严丝合缝。

**顺带修的三处验收脚手架问题**：

- 三套用例里「找文件树的行」还在用 Tailwind 的 `.group` / `.group.cursor-pointer`——§4.34 把行样式搬进 CSS 后这些类没了，于是行数恒为 0；统一改用新钩子 `[data-tree-row]`（同时避免误匹配「最近文档」下拉里的 `.group` 行）。
- `tools/_verify-tree-indent.js` 删除：它只打印不断言，且绑定的是旧几何（`paddingLeft === '6px'`）。
- `tools/_verify-rename.js` 从「只打印」改成真断言（13 条）：走真实右键菜单 → 重命名 → 真实文本输入（`Input.insertText`，会**替换已选中的主干**、保留 `.md`）→ 回落后直接用 fs 验证磁盘结果，并覆盖 Esc 取消。写这套时顺便确认了「只选主干、扩展名不动」这条设计确实生效（`selStart/selEnd = 0/5`）。
- **另一个必须记住的环境事实**：用户正在跑的 dev 应用**不会**自动拿到主进程改动——`electron-vite dev` 从 11:34 起就没有重建 `out/main`（渲染层是 HMR，主进程不是）。本次已手动 `electron-vite build` 重建，重启应用即生效。

### 4.36 应用图标：一条折起来的「光带 L」（本次）

**用户要求**：设计并换上项目的应用图标，简约大气。

**第一版为什么被打回**：初版是「靛蓝方块 + 居中一个白字母 L（等宽 6、占字面 47%）」。用户反馈「缺乏设计感、很单调、土」——这个评价是对的：它只是把字体字母摆在方块正中，**没有结构、没有光、比例也怯**，跟任何一个 UI 套件的占位图标没有区别。于是推倒重做字形本身。

**设计**（`resources/icon.svg` 是母版，下面都是它的参数）：

概念是「**一条折起来的光带写出的 L**」：L 不再是一笔字母，而是**一条折带**——竖面与横面在折角处被一条 45° 折痕分开，受光面与背光面有明度差，于是它有「体积」而不是「字形」。

| 元素 | 规格（32 网格） |
| --- | --- |
| 底板 | 圆角方块 `rx=8`（25%），**对角 135° 渐变** `#262A42 → #12131F`（对角而不是垂直：光来自左上角，垂直渐变会显廉价） |
| 辉光 | 字后面一团同色系 `rgba(99,102,241,.55)` 径向辉光（字自己发光，名字叫 Lumin 就该这样） |
| 玻璃边 | 内圈一条渐隐描边 `rgba(255,255,255,.20 → 0)`，给出边缘的一线反光 |
| 字形 | 折带外轮廓 `M10 7 H17 V16 H24 A2 2 0 0 1 26 18 V23 A2 2 0 0 1 24 25 H8 V9 A2 2 0 0 1 10 7 Z`——**占字面 59%**（x 8..26、y 7..25），三个外角 r=2 圆角、**内侧折角保持尖锐**（圆与锐的对比就是设计感的来源） |
| 折痕 | `M8 16 H17 L8 25 Z`：从内侧折角斜下到左缘的 45° 折痕，压一层 `rgba(14,16,36,.34)` 当背光面 |
| 字色 | 对角渐变 `#FFFFFF → #A9B4FF`（上亮下冷的「发光」而不是死白） |

**三个底，一套字形**（`VARIANTS` 表；`INSTALL_VARIANT` 决定装哪一个）：A 深色底 + 字发光（默认，最「高级」也最不容易和一堆蓝色图标撞脸）、B 靛蓝斜向渐变 + 白字（明亮饱和）、C 纸感浅底 + 靛蓝字（贴亮色主题）。三者的字形、比例、折痕完全一致，只换「光」的处理——所以换口味只是改一行常量再跑一次脚本。

**两个尺寸档**：16/24/32px 用**方角字形**（`M8 7 H17 V16 H26 V25 H8 Z`）+ **平色底**（`#1A1C2C`）+ 更重的折痕（.44）+ 关掉辉光与描边；48px 以上才用圆角、渐变、辉光、描边。渐变与柔光在 16px 下只会变成脏点，方角对齐像素网格才锐利——这是「不靠等比缩小糊过去」的常规做法。

**生成方式（零新依赖）**：`tools/build-app-icon.js`

- 光栅化交给**项目自己的 Chromium**：Chromium 有 canvas，图标又只是圆角矩形 + 渐变 + 一笔折线，直接用图元画比引 sharp / canvas 之类的依赖更省；母版 SVG 与 canvas 用**同一组常量**，两边不会走样。
- **Electron 不允许 CDP 建临时页面**（`Target.createTarget` 与 `PUT /json/new` 都返回失败），所以就在已有页面里画：只创建游离 canvas、画完立刻 `width=height=0` 释放，不碰应用 DOM；也**不用** data:/blob: 图片（应用页面 CSP 里没有 `blob:`）。
- **ICO 自己打包**：6 字节头 + 每张 16 字节目录项 + PNG 负载（Vista 起支持），比装一个 `png-to-ico` 更可控。
- **写完立刻回读校验**，并且**按 32 网格坐标取像素**证明「画出来的就是设计的样子」：圆角外必须 `alpha=0`、笔画正中必须近白、折角内侧必须是底板色（证明确实是 L 不是实心块）、大档上下亮度必须差 >8（渐变在）、小档上下必须完全同色且等于 `#5A5CE8`（平色在）。

**产物**（都在 `resources/`，由脚本生成，勿手改）：

- `icon.svg`（母版，给设计/其他平台）、`icon-small.svg`（小尺寸档，方头平色是刻意的，别当手误）
- `icon.png` 512×512（窗口图标；比 1024 省一半解码内存，够高 DPI）
- `icon.ico`：**16/24/32/48/64/128/256** 七档（Windows 的任务栏、窗口、快捷方式都读它）

**接线**：

- 窗口图标沿用 `resources/icon.png?asset`（electron-vite 会把导入改写成 `path.join(__dirname, '../../resources/icon.png')`，所以任务栏按钮用的就是这张新图）。
- **任务栏快捷方式与跳转列表条目**改用 `resources/icon.ico`（它们只认 exe/dll/ico 资源，PNG 在这里没用；之前借的是 electron.exe 的图标）——`ensureAppShortcut()` 的 `icon` 与两条 task 的 `iconPath` 都指向它。
- **应用内标识**（`Icon.vue` 的 `logo`）换成与图标同源的折线 `M9 8 V16.5 H15.5`（24 viewBox 折算），启动骨架屏与「关于」页各给一个较粗的 `stroke-width`，它才像「标识」而不是一枚普通线性图标。

**验收**：`tools/build-app-icon.js` 自检 **14/14**（文件结构 + 像素取样）；`tools/_verify-taskbar-jumplist.js` **27/27**（新增两条：快捷方式的 `icon` 是 `icon.ico` 且文件存在、`readShortcutLink` 回读的 icon 与写入一致）。另外用 **Windows 自己的 COM** 独立复核了那条 `.lnk`：`IconLocation = D:\code_workspace\Lumin\resources\icon.ico,0`。各档观感另存 `%TEMP%\lumin-icon-sheet.png`（浅色/深色两条 + 原尺寸，供人工看）。

**打包注意**：`?asset` 在打包后仍指向 `app.asar` 内的 `resources/`——窗口图标 Electron 自己能读，但**任务栏/快捷方式要的是真实文件**，所以将来配 electron-builder 时要把 `resources/**` 放进 `asarUnpack`（并把 `win.icon` 指到 `resources/icon.ico`）。

**顺带修的脚手架问题**（都是「dev server 不在跑就整片挂掉」这类）：

- 48 个验收套件都用 `Symbol(pinia)` 的描述去找 Pinia 实例，而**生产构建里这个 Symbol 没有描述**，于是加载 `out/renderer` 时全部报 `Cannot read properties of undefined (reading '_s')`；统一加了一条鸭子类型兜底（在 provides 里找带 `_s` 的 Map）。
- `tools/_isolated-instance.ps1` 新增 `-NoDevServer`：不连 dev server，直接加载构建好的 `out/renderer`（dev server 没在跑时用）。注意少数套件自己按 `5173` 过滤页面或 `import /src/...`，那些仍然必须配 dev server。
- 回归（无 dev server 模式）：文件树 24/24、目录 23/23、工具栏去文件名 12/12、跳转列表 27/27；`npm run typecheck` 0 error。

---

### 4.37 文件编码：判定链 + 每文件记忆 + 按编码读写（本次）

**用户要求**：适配不同编码（UTF-8 等）；设置里能选；顶部「文件」菜单加一级「选择编码重新打开」+ 二级编码列表，选中即按该编码重读当前文档。

**判定链**（`src/main/services/encoding.ts` 的 `decodeBuffer`，顺序即优先级）：

1. **调用方显式指定的具体编码**（用户在「选择编码重新打开」里点了某个编码）：**必须听用户的，BOM 也不能挡**。这一条最初写成了「BOM 优先」，复核时改掉了 —— 那样对带 BOM 的文件，菜单点了等于没反应，用户会以为功能坏了。现在 BOM 仍有用：它若**正好属于**所选编码，就把它摘掉并把 `hadBom` 记下来（写回时补回）；若与所选编码不符（用户就是要强行换个解释），那几个字节按普通字节解、`hadBom=false`。顺带得到一个明确能力：**显式选「UTF-8」= 去掉 BOM**（选「UTF-8 BOM」相反，保存必然带 BOM）；
2. **BOM 嗅探**（`EF BB BF` → UTF-8 BOM、`FF FE` → UTF-16 LE、`FE FF` → UTF-16 BE）：自动模式下 BOM 是文件自己写的声明，比任何猜测都可靠；
3. **该文件上次记住的编码**（kv `fileEncodings`）：同一个文件反复打开保持一致；
4. **严格 UTF-8 能过 → UTF-8**（`new TextDecoder('utf-8', { fatal: true })`）：UTF-8 是当代默认，「通过 fatal 校验」是很强的证据；
5. **按系统语言兜底**：`app.getLocale()` → zh → GB18030、ja → Shift_JIS、ko → EUC-KR、ru → Windows-1251、其它 → Windows-1252；
6. **最后兜底 UTF-8（有损）**：理论上到不了（1252 能解码任意字节），留作保险。

UTF-16 在写回时**总是补 BOM**：没有 BOM 的 UTF-16 文件几乎无法被别的软件识别，所以哪怕用户是从无 BOM 的 UTF-8 切过来的，也给他补上（这是「选 UTF-16」这个动作的合理预期）。

**为什么必须引 iconv-lite**：Node 的 `TextDecoder`（Electron 带完整 ICU）能解很多编码，但 **`TextEncoder` 只支持 UTF-8** —— 「按原编码写回」标准库做不到。所以 UTF-8 家族走 Node 内置，其余**解码与编码**都走 iconv-lite（纯 JS、无原生编译、极主流；本项目 mermaid → d3 → d3-dsv 本来就带着它）。本次把 `iconv-lite@0.6.3` 提升为**直接依赖**（package.json + lockfile 均已更新，`npm ls iconv-lite` 首行即它）。

**每文件编码记忆**：kv key `fileEncodings`，形如 `{ [小写路径]: EncodingId }`，**插入序当 LRU** 裁到 200 条；重复写入先删键再插回队尾（真正的 LRU 语义）。**只记「用户显式选过的」或「判定为非 UTF-8 的」**——纯 UTF-8 不占条目，否则这张表很快被日常文档塞满，真正需要记的反而被挤掉。

**UI 三处入口**：

- **设置 → 通用 → 编码**：下拉选「默认编码」（自动检测 + 全部 13 种）+ 一行说明（默认编码的作用、临时切换走「文件 → 选择编码重新打开」），经 `settings.defaultEncoding` 落 SQLite kv；
- **文件 → 选择编码重新打开**（一级）→ 悬停二级：**自动检测 + 全部编码**，**当前生效的那个打勾并高亮**（沿用「导出」二级菜单的结构与样式，新增 `active` 标记）；
- **状态栏**：文档打开时在统计与主题切换之间显示当前编码名（专有名，如 `GBK`）+ tooltip。

`stores/files.reopenWithEncoding()` 三个要点：脏文档先问（就地写 `ui.confirm`，**没有**引 `composables/useAppActions.confirmIfDirty`——那个模块反过来依赖本 store，会循环导入）；换进来时 **savedContent 一起更新 = 标记为干净**（语义是「重新解释磁盘字节」，磁盘没变，不该留成未保存态）；成功 toast（`toast.reopenedWithEncoding` 带 `{enc}`）。保存按当前编码 + `hadBom` 写回（`file:write(p, content, encoding, hadBom)`），UTF-8 BOM 文件存完 BOM 仍在。

**验收**：`tools/_verify-encoding.js` **34/34**（隔离实例 + Node/iconv-lite 写出的真实夹具 + 真实指针点击）：

- **解码**：UTF-8 → `utf-8`；UTF-8 BOM → `utf-8-bom` 且 `hadBom=true`（正文不含 BOM 字符）；UTF-16LE(BOM) → `utf-16le`；GBK 正文与期望**逐字相等**（中文系统判定为 `gb18030`，GBK 超集，允许两者之一）；Shift_JIS / Windows-1251 用显式编码打开，正文与编码都对；三条自动检测（两种 UTF-8 + UTF-16LE）全判对。
- **显式选择压过 BOM**（复核时补的 3 条）：带 BOM 的文件显式按 `windows-1252` 打开 → 正文确实变了（不再等于 UTF-8 文本）、`hadBom=false`（即菜单对 BOM 文件不再是「点了没反应」）；`reopenWithEncoding('utf-8')` → 正文干净（首字符码点 35 而非 `U+FEFF`）、`hadBom=false`、`dirty=false`，随后保存 → 文件头前三字节变成 `[35, 32, 228]`（BOM 被去掉）；断言后把夹具还原成带 BOM，供后面「保存保留 BOM」的用例继续验。
- **重新打开**：`reopenWithEncoding('windows-1252')` 打开 GBK 文件 → 正文确实乱码（`# ÖÐÎÄ G…`）；再 `reopenWithEncoding('gbk')` → 正文恢复、`encoding='gbk'`、**`dirty === false`**。
- **保存回写**：GBK 文件改内容保存 → 磁盘 80 字节、`iconv.decode(bytes,'gbk')` 与文本完全相等，且这些字节**不等于** UTF-8 编码（没偷偷写成 UTF-8）；UTF-8 BOM 文件保存后前三字节仍是 `EF BB BF`，其余等于新文本。
- **设置生效**：同一串字节 `C4 E3 BA C3` 在两种编码下都合法 → 默认编码 `gbk` 解出「你好」、`windows-1252` 解出「ÄãºÃ」，两次不同且各自正确；**node:sqlite 直读隔离实例 DB** 断言 `settings.defaultEncoding === 'windows-1252'` 已落库，`fileEncodings` 记忆表 5 条。
- **菜单**：`setupState.GROUPS` 里文件菜单含 `menu.reopenWithEncoding`，二级 **14 项**且 `active` 恰为 `['GBK']`；同时用真实指针展开做 DOM 断言（14 行、GBK 行 `bg-accent-soft` + 打勾、其余无勾）；**真实点击**「Windows-1252」→ `files.current.encoding` 变为 `windows-1252` 且正文变乱码。
- **i18n**：三语 8 个 key 齐全；切到 `en-US` 后重开菜单，一级项文本变成 `Reopen with Encoding`。
- **状态栏**：`[data-status-encoding]` 文本含 `GBK`，title 是那句 tooltip。

**回归**：打开落点 22/22、会话 16/16、另存为切工作区 17/17、工具栏去文件名 12/12、导出二级菜单 15/15、目录样式与平滑滚动 23/23；`npm run typecheck` 两工程 0 error；改动文件 eslint 0 error（`src/main/fileOps.ts` 那条 `no-useless-escape` 是既有正则的存量问题，不在本次 diff 内）。

**已知取舍与风险**（验收里都如实体现）：

1. **GBK/GB18030 与 Shift_JIS 会互相误判**：无 BOM 且非法 UTF-8 的文件只能按系统语言猜 —— 中文系统下日文 Shift_JIS 会被猜成 GB18030（乱码），日文系统下中文 GBK 会被猜成 Shift_JIS（乱码）。这是「没有元信息的双字节编码」的固有歧义，任何编辑器都只能猜；缓解手段就是「选择编码重新打开」+ 每文件记忆（选一次以后这个文件都对）。套件里 Shift_JIS/Windows-1251 走显式编码路径正因此。
2. **GBK 与 GB18030 不区分**：中文系统下 GBK 文件判成 GB18030（超集，正文正确）；想让它显示成 `GBK` 手动选一次即可，之后走每文件记忆。
3. **i18n key 命名偏差**：规格写的是 `status.encodingTooltip`，但本项目状态栏文案统一在 `statusbar.*`（没有 `status` 组），实际落在 **`statusbar.encodingTooltip`**；其余 key 与规格一致。
4. **`setupState` 内省只在开发构建可用**：Vue 生产构建不把 `<script setup>` 绑定挂到 `setupState`，所以套件同时保留 **DOM 断言**。本次 31/31 是在开发渲染层（dev server 5173）下跑出的；用 `-NoDevServer` 跑时 setupState 那三条显示 SKIP，DOM 三条照常断言。

### 4.38 开发态主进程热重载：`electron-vite dev --watch`（本次）

**症状**：改主进程代码（如新增编码功能）后，界面上能看到新菜单（渲染层走 dev server 热更新），但点下去报错 —— 像是功能坏了；而且**每次都要手动重启应用**才可能生效，甚至重启也没用（加载的还是旧主进程构建产物）。

**根因**：`electron-vite@5` 的 dev 命令里，**主进程/preload 的监听是可选开关**（`-w, --watch`：*rebuilds when main process or preload script modules have changed on disk*，见 `node_modules/electron-vite/dist/cli.js`），而本仓库的 `dev` 脚本是 `electron-vite dev` —— **没开**。于是渲染层热更新正常、主进程永远不重建：应用进程里跑的一直是启动那一刻加载的旧主进程。实测：用户 dev server 19:51 启动，20:48 落地的主进程功能到 22:00 都没触发过任何重建（`out/main/index.js` 的 mtime 一直是手动构建的时间）。

**改法**（一个词）：

```json
"dev": "electron-vite dev --watch"
```

**验证**（隔离实例，`--watch` 且把参数透传给 electron：`electron-vite dev --watch -- --user-data-dir=…`）：

- 启动后 `out/main/index.js` 随启动构建（22:07:10）；
- 改一行主进程文件 → **主进程产物重建**（mtime 22:07:10 → 22:07:57）且日志出现 `electron main process rebuilt successfully` / `restarting electron app...`；
- **应用进程号变化**：PID 24544 → 24932（即自动重启，不再需要人工重启）。

**对编码功能的意义**：编码切换本身**从来不需要重启** —— 「选择编码重新打开」是重新读盘 + 就地换内容，切一次生效一次；之前需要重启纯粹是因为主进程代码没被重建过。开了 `--watch` 之后，这类「渲染层新、主进程旧」的错配不会再出现。

> 顺带说明：打包产物里主进程与渲染层来自同一次构建，不存在这种错配；它是**开发态专属**问题。渲染层遇到旧主进程时会提示「编码功能需要重启应用后生效」（见 §4.37），而不是含糊地报失败。

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
- **实现**：`extensions.ts` 按 §1.3 装配：StarterKit（`codeBlock:false`、link 不点击跳转）+ Image + Table 全家 + TaskList/TaskItem + Placeholder + CodeBlockCM + TyporaInputRules + **MarkdownPaste**（粘贴块级解析/开放 Slice 闭合，§4.12，Markdown 自身 `transformPastedText: false` 让位）+ Markdown 双向转换 + TyporaMarkers。
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

- ✅ 源码模式（§3.12：纯文本 textarea + `Ctrl+/`，Typora 同款交互——整文档 CodeMirror 视图留作后续增强，NodeView 已趟平 CM 嵌入路径）；
- ✅ 分屏对比（§3.12：渲染+源码左右实时同步、拖拽比例 SQLite 持久化，IDEA 式）；
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
   ├─ components/ToolbarTableButton.vue  # WPS 式表格网格选择器
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
| F | 24 项：表格按钮默认 3×3、悬停网格选择器 2×3、单元格宽度 CSS、表格占满写作区宽度、代码块真实键入（焦点保持/同步/大纲 DOM 稳定/Enter 换行）、Markdown 粘贴（块级节点/标题标记符/粘贴内容可编辑/标题去粗）、源码模式（进入/编辑/填满高度/切回重建）、分屏对比（进入/右→左/左→右/分隔条拖拽持久化/同步滚动开关与双向滚动映射）；另有 B 阶段行内标记显隐边界断言（真实文本标记模型，§4.13） |
| G | 3 项：构造边界打字不失粗（起点/终点打字后 `strong` 保留 + 移出折叠为纯粗体，§4.13 坑位 7） |
| H | 2 项：Ctrl/Cmd+左键退化为普通光标点击（不整选段落/节点、无主题色全选框）、普通左键不受影响（§4.14） |
| I | 3 项：链接普通点击原地展开（锚点消失、label/syntax 双形态、光标折叠不自动选中、md 不变）、光标移出自动折叠还原、Ctrl+点击保持链接不展开（§4.15） |
| J | 3 项：标记内回车切段后源码精确两段且首行 5 立即斜体（与刷新一致，零转义）、段首退格合并（单段 `**5**` + 粗体即时还原 + 无 `.ProseMirror-selectednode`）、合并后光标移开粗体保持（§4.13） |

运行方式：`$env:LUMIN_DEBUG_PORT='9222'; npm run dev` 后执行 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-verify.ps1`。

---

*本手册随代码演进持续更新；任何涉及编辑器内核的改动（扩展装配、标记、输入规则、序列化桥）都必须先跑通附录 C 的验收矩阵。*

### 4.39 编码切换的两个加固：强制同步 + 构建自检（本次）

**用户反馈**：UTF-8 文档切成 GBK 成功，但再切回 UTF-8「切不回去」。

**排查结论（重要）**：在当前构建上我用四种方式复现，**全部通过、复现不出来** —— ① 直接调 `reopenWithEncoding`；② 走真实菜单两级点击；③ 两次点击间隔 <600ms 的快速切换；④ 先让编辑器 emit 过一次原文（`focus` → `blur` 触发 `flushSync`，使 `lastEmitted === 磁盘原文`）再切换。四条的编码、正文、磁盘字节都正确往返。

**但确实找到了一条「能产生完全相同症状」的代码路径**，并把它封掉了：

`src/renderer/src/components/editor/TyporaEditor.vue` 的外部同步 watch 有两条**回声过滤**（启发式）：
1. `if (nv === lastEmitted) return` —— 「store 内容 == 我上次 emit 的文本」当成自身回声；
2. `if (performance.now() - lastEmitTime < 600) return` —— 600ms 静默窗。

两条对「显式外部替换」都不成立：**按原编码切回来时，store 里的内容恰好就是原文**（= 编辑器上次 emit 的文本）→ 规则 1 把它当回声丢掉；若上次 emit 在 600ms 内 → 规则 2 丢掉。表现就是「状态栏编码变了、正文却没回来」。实测里之所以没咬到，是因为切成 GBK 后编辑器往往又 emit 了一次乱码文本、把 `lastEmitted` 顶掉了 —— 属于时序运气，不能依赖。

**改法**：`files` store 新增 `syncEpoch`（显式外部替换计数），`reopenWithEncoding` 替换内容后 `syncEpoch++`；TyporaEditor 把同步逻辑抽成 `applyExternalContent(nv, force)`，`force = true` 时**跳过两条过滤**、无条件 `setContent`。于是「重新解释编码」这类显式动作永远能落到编辑器上，不受任何回声启发式影响。

**顺带两处诊断加固**（这次排查最费时间的就是「不知道用户那边跑的是哪份构建」）：

- **构建自检**：开发态启动时往 `%TEMP%\lumin-build.log` 追加一行 —— 进程启动时间、app/Electron/Chrome 版本、**主进程 bundle 的 mtime**（这份代码什么时候构建的）、能力标记 `{encoding, taskbar}`。主进程不热更新，排查错配时第一眼看它。打包态不写（`src/main/services/buildStamp.ts`）。
- **失败不再沉默**：`reopenWithEncoding` 在「文档还没落盘」时给出提示（原先静默 `return false`，用户只会看到「点了没反应」）；失败提示里带上真实原因（`无法按该编码重新打开：<原因>`），console 里也留一条。

**验收**：`tools/_verify-encoding.js` 在开发渲染层下 34/34；`-NoDevServer`（生产渲染层）下 31/34，差的 3 条是既有的 `setupState` 内省（生产构建不暴露，套件里已注明 SKIP）。两个探针（快速切换、先 emit 再切换）在修复后仍 PASS，且**磁盘字节全程不变**（切换只重读、不写回）。`npm run typecheck` 两工程 0 error。

> 说明：第 1 条加固是**预防性**的 —— 我无法在当前构建上复现用户的现象，但它是代码里唯一能产生该现象的机制，封掉它之后该类时序问题不再可能发生。

### 4.40 图标统一到单一文件（本次）

**用户要求**：所有应用图标（窗口、任务栏等）都换成最新设计；删掉未使用的旧图标；**所有用到的地方引用同一个文件**，避免出现两种图标（除非确实需要别的图标类型）。

**排查发现的三个真问题**：

1. **窗口图标以前只在 Linux 设置**：`src/main/index.ts` 里是 `...(process.platform === 'linux' ? { icon } : {})` —— Windows 下等于没设，任务栏按钮退化用 electron.exe 自带的图标（开发态看着就是 Electron 的 logo）。所以之前换 `icon.png` 对 Windows 根本没生效。
2. **模板自带的旧图标还在，而且是打包默认读取的位置**：`build/icon.ico`（123 KB）、`build/icon.png`、`build/icon.icns` 是 electron-vite 模板的占位图（旧设计），而 electron-builder 默认就去读 `build/icon.ico` —— 一旦打包就会出现「开发态一个新图标、安装后一个旧图标」。
3. **同一个应用读两个文件**：窗口图标读 `resources/icon.png`，而开始菜单快捷方式与跳转列表读 `resources/icon.ico`。

**改法**：

- **Windows 运行时统一到一个文件**：窗口图标改成 `process.platform === 'win32' ? appIconIco : appIconPng`（`resources/icon.ico`）—— ICO 里本来就含 16/24/32/48/64/128/256 七档，Windows 会按场景（任务栏 / Alt+Tab / 标题栏 / 高 DPI）自己挑最合适的尺寸，比单张 PNG 更对；于是**窗口 + 任务栏 + 开始菜单快捷方式 + 跳转列表**读的都是 `resources/icon.ico`。
- **非 Windows 用 PNG**：macOS/Linux 不吃 ICO，这是「确实需要另一种图标类型」的那种例外，用同一份设计导出的 `resources/icon.png`。
- **删掉旧图标**：`build/icon.ico`、`build/icon.png`、`build/icon.icns` 全部删除（`build/` 只剩 mac 的 entitlements，与图标无关）。
- **打包也指到同一个文件**：当时在 `package.json` 里加了一段最小 `build` 配置（`appId: com.lumin.app`、`productName: Lumin`、`win.icon: resources/icon.ico`）—— 不写这段的话 electron-builder 会回去找 `build/icon.ico`（已被我们删掉），反而退化成 Electron 默认图标。**后来这段被移到 `electron-builder.yml` 里成为唯一配置源，`package.json` 的 `build` 字段已删除，见 §4.41。**
- **加守卫防复发**：`tools/build-app-icon.js` 自检里新增三条 —— 扫 `src/**` 里所有 `resources/icon*` 引用必须只有 `icon.ico`（或非 Windows 分支的 `icon.png`）、Windows 必须有 ≥2 处引用同一个 ico、`build/` 下不允许再出现 `icon.*`。

**验收**：`tools/build-app-icon.js` **14/14**（像素取样 + 三条单一来源守卫）；`_verify-taskbar-jumplist.js` 里快捷方式的 `IconLocation` 独立用 Windows COM 复核为 `D:\code_workspace\Lumin\resources\icon.ico,0`；`npm run typecheck` 0 error。

**需要重启才能看到**：窗口图标是在窗口创建时设置的，所以改完要重启应用（如今开发态 `npm run dev --watch` 会自动重启，见 §4.38）。

### 4.41 打包链路：单一配置源 + 打包态/开发态分层 + 打包验收（本次）

**先纠正一个说法**：此前把打包链路说成「空的」并不准确 —— `electron-builder.yml` 一直存在，`package.json` 里也有一段 `build`。准确的说法是：**它是 electron-vite 模板的原样默认值 + 三行手写配置，而且从来没有被验证过**（没人跑过 `build:win`/`build:unpack`，也没有任何针对打包产物的验收）。本次把它做成「可用、专业、可扩展」的形态。

#### 一、排查出的四个真实缺陷（含一处我先判断错、后经实测纠正的）

先说一个反直觉但**已实测确认**的事实：electron-builder 的配置解析顺序是

1. **先看 `package.json` 的 `build` 字段 —— 有它就只用它，`electron-builder.yml` 整份被忽略**；
2. 只有 `build` 字段不存在时，才按 `electron-builder.yml → .yaml → .json → .json5 → .toml → .js` 去找配置文件。

（读的是 `app-builder-lib/out/util/config/load.js` 的 `loadConfig()`；并写了个探针在同一目录下同时放 `package.json` 的 `build` 与 `electron-builder.yml` 验证：有 `build` 时读到的是 `FROM-PACKAGE-JSON`，删掉后读到 `FROM-YML`。**我最初按印象写反了**，是这两步把我拉回来的 —— 所以这条结论连同「为什么」一起写进 yml 注释，免得下次再猜。）

于是模板留下的真实状况是**反的**：

1. **`electron-builder.yml` 是一份完整的死配置**：它写着模板默认值 `appId: com.electron.app`、`productName: lumin`、`win.executableName: lumin`、`linux.maintainer: electronjs.org`、`category: Utility`、snap target……**而它一个字都没被读过**（因为 `package.json` 里有 `build`）。危险在于：这不是「配置写错了」，而是「配置看着很全、其实全是摆设」，且**一旦有人删掉 `package.json` 的 `build`（比如为了消除重复配置），应用身份会瞬间变成 `com.electron.app` / `lumin.exe`** —— 任务栏身份、快捷方式、跳转列表、通知归属一起崩。这类地雷比明显写错更难发现。
2. **真正生效的配置只有三行**：`package.json` 里的 `{appId: com.lumin.app, productName: Lumin, win.icon: resources/icon.ico}` —— 身份恰好是对的，纯属这三行**恰好**写对了；除此之外的一切都退回 electron-builder 的默认值，没人检查过默认值是否符合产品预期。
3. **默认安装行为不符合写作类应用**：`nsis.oneClick` 默认是 `true` —— **一键安装、不给选安装目录**。写作软件常被装到非系统盘，这个默认值不合适（现在的 yml 明确写 `oneClick: false` + `allowToChangeInstallationDirectory: true`）。
4. **没有文件关联**：`.md` 双击打不开（也就谈不上「Typora 平替」的入场体验）。顺带说，把 `publish` 的 `url` 留在 `https://example.com/auto-updates` 这种占位值上而运行时又不去识别它，也是同类问题（会在用户机器上冒网络失败），所以 `updater.ts` 会主动识别占位域名并跳过。

#### 二、比配置更致命的洞：裸路径 argv 根本没解析

旧版解析器（原在 `taskbar.ts`）只认自己造的两个开关：

```ts
const arg = argv.find((a) => a.startsWith(OPEN_FILE_PREFIX))   // --lumin-open=<encodeURIComponent(path)>
return { newWindow: argv.includes(NEW_WINDOW_SWITCH), openFile }
```

而**双击文件、`Lumin.exe x.md`、从别的程序拖进来**，argv 里是一个**裸路径**（Windows 还会附带 `--allow-file-access-from-files`、`--source-app-id`、`--secure-schemes=lumin-file` 等 Chromium 自己的开关）。旧代码对这些一律无视 —— 于是「双击 .md 没反应」是**必然**的，哪怕文件关联注册得再对。**文件关联 = 安装器注册 + 应用会解析裸路径，两件事缺一不可。**

#### 三、改法（六块，逐条讲为什么）

**① `electron-builder.yml` 成为唯一配置源**

`package.json` 的 `build` 字段已删除，配置全部集中到 yml：

- 身份对齐代码：`appId: com.lumin.app`（与 `taskbar.appId()` 打包分支一致）、`productName: Lumin`、`win.executableName: Lumin`；
- `win.icon: resources/icon.ico` —— 图标单一来源（§4.40），这里显式指过去，避免 electron-builder 回退去找已删除的 `build/icon.ico`；
- `win.target: nsis / x64`（只出 Windows 免安装版 + 安装包，不做跨架构幻想）；
- `nsis` 显式写全：`oneClick: false` + `allowToChangeInstallationDirectory: true`（可选安装目录，**不是**一路 next 的静默安装）、`perMachine: false`（装到当前用户，不需要管理员）、`createDesktopShortcut/ createStartMenuShortcut: true`、`shortcutName: Lumin`、`uninstallDisplayName: Lumin`、`artifactName: Lumin-${version}-setup.${ext}`、`runAfterFinish: true`；
- **`deleteAppDataOnUninstall: false`**：卸载**不删**用户数据（SQLite 里的会话、设置、编码记忆都在 `%APPDATA%\lumin`）—— 卸载重装不该把用户的偏好和草稿一起带走；
- `fileAssociations`：只注册 `.md` 与 `.markdown`（`name: Markdown`、`description: Markdown Document`、`role: Editor`、`icon: resources/icon.ico`）。不贪多：`.txt`/`.markdownx` 之类抢来只会惹人烦；
- `publish` 保留占位并写清启用步骤（见第五块）；
- 模板残留一并修掉：`linux.maintainer` 从 `electronjs.org` 改为 Lumin、`linux.category` 从 `Utility` 改为 `Office`、去掉 snap target（本产品是 Windows-only，留着 snap 只是噪音）、mac 的 entitlements 与 `notarize: false` 保留；
- `asarUnpack: resources/**` 与 `npmRebuild: false` 保持（前者保证运行时能按真实路径取图标文件、后者本工程没有原生模块要重建）；
- `files` 里补排除**开发期专属内容**：`docs/*`、`tools/*`、`{build-out.txt,typecheck-out.txt,dev-run.log}`。这条是解析 asar 顶层时发现的 —— 默认打包会把文档、验收脚本、构建日志一起塞进 `app.asar`（顶层能看到 `docs/`、`tools/`、`build-out.txt`、`typecheck-out.txt`、`dev-run.log`），既让安装包变大，也等于把开发脚本发给用户；已核对 `src` 里没有任何代码在运行时读这些路径。

> 关于「两处配置谁是权威」：不是「说不清」，而是一个**确定的、反直觉的**顺序（`package.json` 的 `build` 赢）。正确做法不是记住它，而是**不让它成为问题**：现在只剩 yml 一处，并且验收里有两条断言把这个状态钉住 —— `package-json-has-no-build-field`（`package.json` 不许再长出 `build`）与 `builder-config-comes-from-yml`（用 electron-builder 自己的解析函数算出「有效配置」，再核对它等于 yml 里写的值；`nsis.oneClick` 默认 `true` 而 yml 写 `false`，读出 `false` 就证明 yml 真的在生效，而不是躺着的死配置）。实测产物 `Lumin.exe` / `Lumin-1.0.0-setup.exe` / 开始菜单名 `Lumin` 也全部严格来自 yml。

**② 新增纯函数 `src/main/services/launchIntent.ts`**

把「命令行 → 启动意图」从主进程里剥出来，做成**无副作用纯函数**（唯一依赖 `fs.existsSync/statSync` 与注入的 `cwd/appPath`），因为这段逻辑是文件关联、跳转列表、第二实例转发三条路径的共同入口，值得独立：

```ts
export interface LaunchIntent {
  openFile: string | null
  openFolder: string | null
  newWindow: boolean
  noWorkspace: boolean
  ignored: string[]        // 被忽略的参数（诊断用）
}
parseLaunchIntent(argv, { appPath, cwd }): LaunchIntent
```

解析规则（每条都对应一个真实踩法）：

- 跳过 `argv[0]`（可执行文件自身）与 `appPath`（开发态 `electron .` 就是这条，否则一定被当成「打开文件夹」）；
- `--` 之后一律不解释（POSIX 约定，避免把用户数据当成开关）；
- 认识自己的开关：`--lumin-open=`、`--lumin-open-folder=`、`--lumin-new-window`、`--lumin-no-workspace=1`；
- 其它 `-` 开头的参数**一律忽略并记进 `ignored`**（Chromium/Squirrel 会塞 `--allow-file-access-from-files`、`--source-app-id`、`--secure-schemes=…` 等，不忽略就会被当成文件路径去 stat）；
- 剩下的是裸路径：**相对路径按 cwd 解析**（从命令行敲 `Lumin.exe ..\a.md` 必须能用），`existsSync` + `statSync` 判定文件还是目录，不存在的记进 `ignored`（而不是静默丢掉）。

`ignored` 不是为了好看，而是为了「双击没反应」这类反馈能一眼定位。

**③ `src/main/index.ts` 接线：三条入口收敛到一个函数**

三个来源原本各写一套逻辑：冷启动 argv、`second-instance`（第二实例把 argv 转发给已运行实例）、macOS 的 `open-file` 事件。现在统一成：

- 冷启动：`parseLaunchIntent(process.argv, { appPath, cwd })` → `recordLaunchIntent(...)` 落一行日志 → 合并 `pendingOpenPaths`（macOS `open-file` 早于 ready 时的暂存，这里保留为跨平台正确性）→ 首个窗口按意图携带 `openFile`/`openFolder`/`noWorkspace`；
- `app.on('open-file')`：ready 前入 `pendingOpenPaths`，ready 后直接 `handleOpenRequest`；
- `app.on('second-instance', (_e, argv, cwd))`：解析 + 落日志 + `handleOpenRequest`；
- **`handleOpenRequest(intent)` 是唯一分发点**：`newWindow` → 新窗口（带目标就带上，没带目标才是「干净窗口」）；`openFile` → 先用 `openDocs.findWindowWithDoc` 找已打开它的窗口，找到就聚焦（**不重复开**），否则新窗口；`openFolder` → 新窗口；什么都没有 → `focusExistingWindow()`。

**④ 打包态与开发态明确分层**（之前是混着来的，两个身份互相污染）：

| 行为 | 开发态 | 打包态 |
|---|---|---|
| 开始菜单快捷方式 | 启动时写（`ensureAppShortcut()`） | **不写**，早退并记日志 `shortcut skipped (packaged; installer owns it)` —— 快捷方式归安装器所有，运行时不越权 |
| 窗口 `icon` | 传 `runtimeIconPath()`（内容寻址副本） | **不传**：图标已内嵌进 `Lumin.exe`（验收 B 段就是证明），再传一次只会多一条路径依赖 |
| 跳转列表图标 | `runtimeIconPath()`（按内容换路径，规避 Windows 按路径缓存，§4.35） | `process.execPath`（即 `Lumin.exe`，系统直接取 exe 内嵌图标） |

**⑤ 新增 `src/main/services/updater.ts`：更新能力「装好但默认关闭」**

- 只在**打包态**且**真有发布通道**时才是可用状态：`updateChannelConfigured()` 要求 `resources/app-update.yml` 存在、且 url 主机不是 `example.com/example.org/example.net/localhost` 这类占位值 —— 否则「检查更新」只会永远失败；
- `autoDownload = false`：**不偷偷下 100MB 安装包**；`autoInstallOnAppQuit = true` 只在用户已选择下载后才在退出时安装；
- 检查条件是 `app.isPackaged && settings.autoCheckUpdate && updateChannelConfigured()`，即默认设置（`autoCheckUpdate: false`）下**一条网络请求都不发**；
- 状态经 `update:status` 推给渲染层，渲染层用通知中心呈现（文案在 i18n 里，主进程只传数据 —— 与既有约定一致，§4.32）。
- **与规格的一处有意偏差**：只有 `available` / `downloaded` / `error` 三种状态发通知，`checking` / `not-available` 只 `console.info`。原因是本应用的通知中心是**持久卡片**而不是自动消失的 toast（§4.32），「没找到更新」这种一次性的中间态做成卡片会一直躺在那里等人手动关。

**⑥ 新增 `tools/_verify-packaging.js`（24 项，本次的重点）**

打包链路以前最大的问题不是配置，而是**没人验证**。这个套件把「打包产物真的能用」变成可重复的事实：

- **A** **构建前先清场**（`no-packaged-instance-holds-dist-before-build` + `dist-cleared-before-build`：不许有 `Lumin.exe` 占着 `dist\`，且上一轮产物必须删得掉，原因见三点五），然后 `npm run build:unpack`（内含 typecheck）成功、`dist/win-unpacked/Lumin.exe` 存在；
- **A2** **产物冒烟启动**：真起一次、等首页就绪；起不来就自动重建一次再试（`packaged-artifact-boots-after-rebuild`）—— 这条是本轮的血泪（见三点五）；
- **B** **exe 里真的内嵌了我们的图标**：解析 `resources/icon.ico` 的目录项，断言 7 个尺寸（16/24/32/48/64/128/256）的字节**全部**能在 `Lumin.exe` 里找到，且 **electron.exe 里一个都找不到**（对照组）；再用 `ExtractAssociatedIcon` 取出 32×32 证明「取出来能渲染」；
- **C** **裸路径打开文件**：用打包后的 exe 直接启动 `Lumin.exe <临时目录>\甲-中文名.md`（隔离 `--user-data-dir` + CDP），断言 `files.current.path`、正文开头 `# 甲文档标题`、内存里的编码是 `utf-8`；
- **D** **第二实例转发 + 去重**：再启动一次同一个 exe（另一个文件 `乙-第二篇.md`）→ 窗口数 1→2 且新窗口里是乙文件；同一文件再开一次 → 2→2（不会开出第三个窗口）；
- **E** **打包运行不碰开始菜单**：整段测试前后对 `开始菜单\Programs` 做快照对比（含 mtime），必须完全不变，且不得出现 `Lumin.lnk`；
- **F** `npm run build:win` 出 NSIS 安装包，只检查大小与 SHA256，**绝不运行安装包**（见第六节）；
- **G** **配置单一来源 + 身份一致**（这一段是排查出「死配置」之后补的，防止复发）：`package.json` 不得有 `build` 字段；用 electron-builder **自己的解析函数**算出有效配置并核对它确实等于 yml 里写的（`appId`/`productName`/`executableName`/`win.icon`/`nsis.oneClick === false`/`allowToChangeInstallationDirectory === true`/`deleteAppDataOnUninstall === false`）；`appId` 必须等于代码里 `taskbar.ts` 用的那个；文件关联必须恰好是 `md` + `markdown`（不许顺手抢 `.txt`）。

#### 三点五、「打包产物启动即静默退出」——本次踩得最贵的一个坑（必须留档）

这一节建议优先读：它说明**「产物存在 + 图标字节都对」也可能整个产物是坏的**，验收里「真的把它跑起来」这一步不能省。

**现象**：一轮完整验收里 A 段（`build:unpack` 成功、`Lumin.exe` 存在）与 B 段（exe 里 7 档图标字节全中、与 electron.exe 对照正确）**全部 PASS**，C 段却连不上 CDP：`packaged-app-boots FAIL pid=13660` + `ERROR connect ECONNREFUSED 127.0.0.1:9225`。

**误导性极强的地方**（也是我绕远路的原因）：手工起同一个 exe，它**立刻退出、exit code 1、stdout/stderr 一个字都没有**；profile 目录建了但是空的；`%TEMP%\lumin-build.log` 里**没有**本次启动的意图行；用 `--inspect` 起它，**Node inspector 根本不监听** —— 即**主进程 JS 一行都没执行**，死在了 Electron 自己的启动阶段。于是我先怀疑配置和代码，依次排查（全是死路）：yml 是否被读、asar 结构是否被截断（自己解析 asar 头部 → 结构完好）、换 `electron.exe` 直接加载 `resources/app.asar`（同样秒退）、Windows 事件日志、磁盘空间。

**已验证的事实**（这部分是硬结论）：

1. 这种产物**重新构建一次就恢复正常**（三次复现，每次重建都立刻好）；
2. 重建后的 `Lumin.exe` 与 `app.asar` 和可用产物的 **SHA256 逐字节一致**（`exe 52B90573…` / `asar 6437F17C…`），构建本身是确定的 —— **所以不是配置问题、不是代码问题、也不是构建不确定**；
3. 坏产物死在 Electron 的启动校验阶段（JS 未执行）。

**已定位的一个真凶（且是验收脚本自己的 bug）**：`run()` 用 `spawnSync` 跑构建，而 **spawnSync 默认只缓冲 1MB 输出**；electron-builder 那一行 `duplicate dependency references dependencies=[...]` 本身就接近 1MB，**一旦超限子进程会被直接杀掉**（`error.code = ENOBUFS`、`status = null`）—— 于是构建被**中途打断**，`dist/` 里留下半成品（asar 换了、exe 的完整性资源没来得及写），这种半成品启动时正是「静默退出」。而且断言只报一句 `exit=1`，完全看不出是「构建真失败」还是「输出太多被杀」。**已修**：`maxBuffer` 提到 64MB，并在失败时额外打印 `BUILD-SUSPECT-LINES`（把 error/fail/EPERM/ENOBUFS 之类的行拎出来）。这一条同时也是本次「排查被误导」的一部分原因 —— **验收工具本身不可信时，排查方向会被它带偏**。

**仍未定位的一处**（如实记录）：另有一轮构建 `exit=0` 正常退出、产物却是坏的。推测是「构建时 `dist` 里上一轮的产物文件仍被占用，electron-builder 往 exe 写 asar 完整性资源（日志 `• updating asar integrity executable resource`）时没能与新的 asar 对上」，但**没有证实**。

**已加的护栏**（不依赖上面哪种解释成立）：

- **构建前清场**：`ensureNoPackagedInstanceRunning()` 干掉残留实例并等它真的退出（断言 `no-packaged-instance-holds-dist-before-build`）；`clearPreviousArtifacts()` **自己删掉上一轮产物并确认删得掉**（断言 `dist-cleared-before-build`）—— 删不掉就当场失败，绝不在文件被占的情况下让构建继续；
- **构建后冒烟启动（A2）**：`smokeBootArtifact()` 真起一次产物、等首页就绪；起不来就**自动重建一次**再试（断言 `packaged-artifact-boots-after-rebuild`）；这一步让「坏产物」在 A2 就被抓住，不用等到 C 段看一句没头没脑的「连不上 CDP」；
- C 段再失败会打印 `HINT-PACKAGED-BOOT-FAILED`，直接给出归因方向与下一步；
- 清场范围刻意收窄：进程名必须是 `Lumin.exe`，**且**（命令行带本套件的隔离 profile **或** 可执行文件就在 `dist\` 下）—— 用户开发态跑的是 `electron.exe`，永远不会被误杀。

> 一句话总结：**构建产物可能坏，而坏法恰好是「静默退出 + 前面几段全绿」**。所以「构建前清场」和「构建后真起一次」都必须写进验收，而不是靠人记得。

#### 四、验收数据（本次实测）

`node tools\_verify-packaging.js` → **24/24 PASS**（全新构建，非复用产物）：

- **A2 冒烟启动本轮一次通过**；而加护栏的那一轮它**真的抓到过一次坏产物**：`SMOKE-FAILED-FIRST-TRY {"ok":false,"pid":26736}` → 自动重建一次 → `PASS packaged-artifact-smoke-boots {"ok":true}`（那一轮因为多跑了「重建后通过」这条断言，总数是 25）。也就是说这个坑**不是理论上的可能，而是会真的碰上**，护栏确实在起作用；
- `ICON-BYTES` `sizes=[16,24,32,48,64,128,256] inExe=[true×7]`，对照 `electron.exe` 全 `false`；
- `ICON-EXTRACT` 我们的 exe 中心像素 `(176,179,198)`、亮度 180；electron.exe 对照 `(60,66,78)`、亮度 66（断言「亮度差 > 60」，避免把「都是深色」误判成同一张图）；
- `C-BARE-PATH` `path=…\Temp\lumin-pkg-fixtures\甲-中文名.md`、`head="# 甲文档标题\n\n这"`、`encoding=utf-8`；
- `D-SECOND-INSTANCE` `乙-第二篇.md`、窗口 `1 -> 2`；`D-DEDUP` `2 -> 2`；
- `E` 开始菜单快照前后完全一致（含 mtime），无新建 `Lumin.lnk`；
- `G` `EFFECTIVE-CONFIG {"appId":"com.lumin.app","productName":"Lumin","executableName":"Lumin","winIcon":"resources/icon.ico","oneClick":false,"allowDir":true,"deleteAppDataOnUninstall":false,"associations":["md","markdown"]}` —— 生效配置确实来自 yml（`oneClick: false` 不是默认值）；
- `F` `Lumin-1.0.0-setup.exe`，**129,201,471 字节（123.2 MB）**，`sha256=6d8f208c421b7e38eeebd9507b1e8b520785763898bae7c09d774beb8cbcd958`；`latest.yml` 一并产出（自动更新的版本清单）。

> 安装包体积会随构建时间戳等变动（同一天两次构建差几十到几百 KB），哈希也随之变 —— 上面是本次实测值。把 `docs/`、`tools/`、构建日志排除出打包后，安装包从 129,444,185 字节降到 **129,201,471 字节**（约 -240 KB），这既是体积收益，也是「不把开发脚本发给用户」。

**回归**（本次改动不碰编辑器内核，但仍全跑一遍，全部在隔离实例上）：

| 套件 | 结果 |
|---|---|
| `_verify-encoding.js` | **34/34** |
| `_verify-open-file-dedup.js` | **21/21** |
| `_verify-open-file-routing.js` | **22/22** |
| `_verify-session.js` | **16/16**（会话恢复没被 `explicitOpen` 判定改坏） |
| `_verify-taskbar-jumplist.js` | **27/27** |
| `npm run typecheck` | 0 error |

> taskbar 套件里 `shortcut-icon-is-app-icon` 原本是「路径以 `icon.ico` 结尾 + 文件存在」。§4.35 把开发态图标改成**内容寻址的运行时副本**（`userData\icons\lumin-<sha1:8>.ico`）之后，这条断言就**过时了**（文件名不再叫 `icon.ico`）。已改为更强的一条：后缀 `.ico` + 文件存在 + **字节与 `resources/icon.ico` 完全一致**（实测 `bytesEqual: true`）—— 既排除 electron.exe 的图标，也排除旧设计的残留。

#### 五、更新通道怎么开

1. 把 `electron-builder.yml` 的 `publish.url` 换成真实地址；
2. 把 `latest.yml` 与安装包一起上传到该地址；
3. 在设置里打开「自动检查更新」（`settings.autoCheckUpdate`，默认关）。

三项缺一，更新就保持「装好但不动」的状态 —— 这是刻意的：默认关、不发请求、不自动下载。

#### 六、本次**未验证**的部分（不要当成已验证）

- **没有真的运行安装包**。所以「安装后 `.md` 关联是否注册成功」「桌面/开始菜单快捷方式是否正确」「卸载是否保留用户数据（`deleteAppDataOnUninstall: false` 的真实行为）」都**没有实测**。安装器只被检查了大小与 SHA256。
- 即便关联注册成功，**Win10+ 也不会自动抢默认程序**：用户需要在「打开方式」里选一次 Lumin（`role: Editor` 只影响候选列表）。这是平台行为，不是配置问题。
- 更新链路只验证了「默认关且不发请求」，**没有接真实更新服务器**跑过一次真实升级。

手动验证步骤（要真验证时）：在**虚拟机或非工作机**上双击安装包 → 装到非默认目录 → 双击任意 `.md`（应打开该文件且窗口里是同一篇）→ 检查开始菜单/桌面快捷方式图标 → 卸载 → 确认 `%APPDATA%\lumin` 仍在。

#### 七、命令

```bash
npm run dev          # 开发（--watch：主进程改动自动重建，§4.38）
npm run build:unpack # 免安装版 → dist/win-unpacked/Lumin.exe（验收 A–E 用这个）
npm run build:win    # NSIS 安装包 → dist/Lumin-<version>-setup.exe
node tools/_verify-packaging.js            # 17 项打包验收（会跑上面两条构建）
set LUMIN_PKG_SKIP_BUILD=1 && node tools/_verify-packaging.js   # 复用已有产物，快速回归
```

> `tools/_verify-packaging.js` 全程不运行安装包，所有打包态启动都用 `--user-data-dir=%TEMP%\lumin-pkg-userdata` 隔离并按该 profile 精确回收进程，不会碰用户正在使用的实例。

### 4.42 安装 / 卸载链路实测报告（本次）

见独立文档 **`docs/packaging-install-test.md`**：在本机用 NSIS 安装包做了完整的装 → 跑 → 卸实测。

- 安装 `Lumin-1.0.0-setup.exe /S`：退出码 0、20.2 s；安装到 `%LOCALAPPDATA%\Programs\Lumin`（82 个文件，`Lumin.exe` 210,974,720 字节）；
- exe 内嵌图标：`resources/icon.ico` 的 **16/24/32/48/64/128/256 七档负载 7/7 逐字节命中**，同一批字节在 `electron.exe` 里 7/7 不存在；
- 文件关联：`HKCU\Software\Classes\.md` → ProgID `Markdown` → 命令 `…\Programs\Lumin\Lumin.exe "%1"`（`%1` 即裸路径，正好由 §4.41 的 `launchIntent` 解析）；
- 打包版以**裸路径**打开中文文档成功（窗口标题 = 文件名，渲染层从 `app.asar` 加载）；
- 卸载 `/currentuser /S`：退出码 0、10.6 s；安装目录与快捷方式清除；**`%APPDATA%\Lumin` 11027 个文件 / 38 个草稿原样保留**（`deleteAppDataOnUninstall: false` 生效）。

报告同时记录了 **1 个中severity 缺陷**（卸载后 `HKCU\Software\Classes\.md` 默认值残留 `Markdown`，形成悬空关联，需在 `nsis.include` 里补一段删除逻辑）、**4 项待修/待确认**（Publisher 显示 `example.com`、桌面同名快捷方式会被覆盖、快捷方式未携带 AUMID、dev 与打包版共用 `%APPDATA%\Lumin` 与单实例锁）以及 **5 项未覆盖**（真实双击 `.md`、任务栏固定项观感、自动更新、代码签名/SmartScreen、非 Windows 平台）。

> ⬅ 这些问题已在 **§4.43** 逐条处置并**重新跑了一遍完整装/卸实测**。其中「快捷方式未携带 AUMID」那条的**结论被推翻**：安装器写的 `Lumin.lnk` 本来就带 `com.lumin.app`，第一轮是**测量方法**错了（拿原始字节搜 UTF-16 字符串）。

### 4.43 安装 / 卸载缺陷修复 + 复测（本次）

接 §4.42：6 条问题逐条处置，然后**重新构建安装包、重新跑完整个装 → 跑 → 卸链路**，用实测数据证明修好了。完整报告见 `docs/packaging-install-test.md`（第一轮原始记录作为附录保留在文末）。

#### 一、修了什么（逐条给落点与证据）

| 第一轮问题 | 处置 | 落点 | 复测证据 |
| --- | --- | --- | --- |
| **中**：卸载后 `.md` 默认值残留 `Markdown`（悬空关联） | 修 | 新增 `build/installer.nsh`（`customUnInstall` + 自己的 `Lumin_UnassociateExtension` 宏），经 `electron-builder.yml` 的 `nsis.include` 挂载 | `.md=''`、`.markdown=''`，且扩展名下 `OpenWithProgids` 子键也删掉 |
| **中**：Publisher 显示 `example.com` | 修 | `package.json` 的 `author` 改成真实作者（NSIS 的 Publisher 就取自这里） | `Publisher='yang_bai_bai'` |
| 低：桌面同名快捷方式被覆盖 | **有意保持** | 不改代码 | 见下「三」 |
| 低：判断「快捷方式未携带 AUMID」 | **前提有误，改断言 + 留兜底** | `taskbar.ts` 的 `backfillInstalledShortcutAumid()`（幂等，正常走「已存在」分支） | 日志 `shortcut aumid already present … aumid=com.lumin.app` |
| 中（开发期）：dev 与打包版共用 `%APPDATA%\Lumin` 与单实例锁 | 修（opt-in） | 新增 `src/main/devProfile.ts` + `npm run dev:isolated` | 复测全程用 `--user-data-dir` 隔离，用户数据 11027 文件/38 草稿未变 |
| 低：`InstallLocation` 空 | 修（前半） | `build/installer.nsh` 的 `customInstall` 写 `InstallLocation=$INSTDIR` | `InstallLocation='…\AppData\Local\Programs\Lumin'`；`EstimatedSize` 501.4 MB 属上游估算方式，只记录不处理 |

#### 二、根因：漏的那一半在 electron-builder 自带模板里

`nsis.include` 不是「随手加一段脚本」，而是因为根因在依赖里、上游模板又不能改：

- `APP_ASSOCIATE`（`FileAssociation.nsh:65-74`）写的是三处：扩展名默认值 = FILECLASS、`OpenWithProgids` 加点、ProgID 子树；
- `APP_UNASSOCIATE`（同文件 `:99-102`）只删了**后两处** —— `OpenWithProgids` 的那个值和 ProgID 子树，**从不删扩展名的默认值**；
- 于是卸载后 `.md` 的默认值仍指着已被删除的 ProgID，Windows 只能弹「选择打开方式」。

官方给的扩展点正好够用：`customInstall` / `customUnInstall` 宏（`installSection.nsh:81`、`uninstaller.nsh:156`）。我们的宏还顺手做了幂等与「只删自己建的键」：用 `DeleteRegKey /ifempty`，别人的键一个不动。

#### 三、P3 为什么保持现状（桌面快捷方式覆盖同名文件）

`createDesktopShortcut: true` 是主流做法（VS Code / Typora / Obsidian 都是），安装向导非静默时也能取消勾选；改成 `false` 会让「装完桌面没图标」变成更常见的抱怨。真正的风险只是「静默覆盖同名文件」，而 `Lumin.lnk` 这个名字本就属于本应用。**代价**：验收脚本收尾会把桌面那条按原样重建（本轮即 `target = D:\code_workspace\Lumin`），发布说明里要写明会在桌面创建快捷方式。

#### 四、AUMID：我第一轮判错了，留档避免再犯

第一轮我说「在 `.lnk` 字节里搜不到 `com.lumin.app` → 没带 AUMID」。第二轮用 Electron 的 `shell.readShortcutLink()`（内部就是 Windows Shell 的 `IShellLink`/`IPropertyStore`）读同一条快捷方式，**读得到 `com.lumin.app`** —— electron-builder 会按 `appId` 写这条属性。

错在哪：`.lnk` 的扩展属性存储有自己的序列化格式，**把它当 UTF-16 字符串搜子串，搜不到不等于属性不存在**。现在的断言走权威 API，脚本里只保留一条「只观察、不断言」的字节搜索结果，并把这个坑写在输出里（`INFO 原始字节搜索命中=False（仅观察；与日志不一致时以日志为准）`）。

对代码的影响：`backfillInstalledShortcutAumid()` 从「补救」降级为**幂等兜底** —— 正常情况走「已存在」分支直接返回（实测正是这条路），只在快捷方式被换成不带 AUMID 的版本时才真的补写；仍然只动 AUMID 一个属性、绝不新建文件、绝不改启动参数。函数注释已按此改写。

#### 五、复测数据（本次实测）

- 产物：`dist/Lumin-1.0.0-setup.exe` **123.22 MB**（129,201,831 字节），SHA256 `341F322B4C1719532EEED790AFE5EA5609E3884CD0207E0F8B21783A6A91DA76`；
- 安装 `/S`：退出码 0、**11.2 s**；`Lumin.exe` 210,974,720 字节；
- 裸路径启动打包版：窗口标题 `安装测试-甲文档.md - Lumin`；
- 卸载 `/currentuser /S`：退出码 0、**6.4 s**；安装目录残留 0 文件；快捷方式、ProgID、扩展名默认值、卸载条目全部清除；
- **用户数据**：`before=11027/38 after=11027/38`（文件数/草稿数逐项一致）；
- 断言总计 **19/19 PASS**，退出码 0。

> ⚠️ **NSIS 产物不可字节复现**：同一份源码连打三次，sha256 各不相同（`0D953579…` / `b6424599…` / `341F322B…`），差异来自构建时嵌入的时间戳等。所以别拿 sha256 当发布校验。

#### 六、回归（确认没踩坏既有功能）

`npm run typecheck`（`tsc` + `vue-tsc`）exit=0；`node tools/_verify-packaging.js` **24/24 PASS**（含真跑 `build:win`、配置单一来源、`appId` 一致、只关联 `.md/.markdown`）；`node tools/_verify-taskbar-jumplist.js` **27/27 PASS**；本轮改动的 `src/` 文件 ESLint 0 问题。

顺带修掉一个**验收脚本**缺陷（不是产品问题，但会污染回归结论）：`tools/_verify-taskbar-jumplist.js` 的冷启动那一节把渲染页面地址硬编码成 `http://localhost:5173`，而套件里其他每次启动都是继承父进程环境的 —— 没有 dev server 时冷启动进程拿不到页面，脚本会以 `TypeError: Cannot read properties of undefined (reading 'files')` 崩掉，看着像产品回归。现改为继承父进程环境（有 `ELECTRON_RENDERER_URL` 就用，没有就走 `out/renderer`），并在注入失败时输出能看懂的结论。

#### 七、命令

```bash
pwsh -NoProfile -File tools\_install-test.ps1   # 装 → 19 条断言 → 卸 → 自动恢复机器状态
npm run dev:isolated                            # dev 用独立 profile（%APPDATA%\Lumin (dev)），不再和打包版抢锁
```

> `dev:isolated` 是**可选开关**（`LUMIN_DEV_PROFILE=1`）：默认 `npm run dev` 行为**故意不变** —— 否则你现有的开发数据会「凭空消失」（其实是换了目录），那比共用 profile 更吓人。

#### 八、本轮**未验证**的部分（别当成已验证）

真实「双击 `.md`」端到端（你的 dev 实例在跑 → 会转给它，测不出打包版自身行为；要验就关掉 dev 实例或改用 `dev:isolated` 后双击）、图形化安装向导界面、**覆盖安装/升级**、任务栏右键菜单与「固定到任务栏」的**观感**（断言只覆盖到「快捷方式/ AUMID / 启动命令正确」这一层）、自动更新（`publish` 仍是占位）、代码签名与 SmartScreen。

---

### 4.44 未保存草稿横幅的假阳性：草稿语义收敛（本次）

**现象**（用户报的）：每次新开一个窗口、或打开一个没保存过的空文档，编辑器上方都会冒出
「检测到未保存的草稿（比磁盘文件更新）」+ 恢复/丢弃。观感上像出了故障，逻辑上也说不通 ——
明明什么都没有输入。

#### 一、根因（两条，都是「草稿的语义被写成了无条件」）

1. **干净文档也写草稿。** `scheduleSave()` 的注释原文就是「草稿防抖（**始终写入**，用于崩溃恢复）」，
   `flushAll()` 更是在关窗时无条件 `writeDraft()`。于是任何一次关窗都会把**当前缓冲区**（包括
   从未编辑过的空白未命名缓冲区）落成一份草稿。实测用户盘上那份 `%APPDATA%\lumin\drafts\untitled.json`
   正是 `{"content":"","savedAt":…}` —— 空草稿。
2. **未命名草稿全应用共用一个键。** `openUntitled()` 固定读 `'untitled'`，而 `writeDraft()` 用
   `draftKey(null)` 也落到同一个键：所有窗口的未命名缓冲区共享一份草稿。于是「本窗口的空白缓冲区」
   会把**别的窗口 / 上一次运行**留下的草稿当成自己的，条件（`draft.savedAt > mtime + 1000`）对
   未命名缓冲区根本不成立（没有磁盘文件可比较），只要文件存在就弹横幅。

第 1 条决定了「**每次**都会出现」，第 2 条决定了「**新窗口**里冒出来的是别人的东西」。

#### 二、改法：把草稿的语义写成可判定的三条

| 规则 | 落点 |
| --- | --- |
| **只有脏文档才有草稿**：`content === savedContent` 时不写，并把盘上的旧草稿清掉（正等用户决定的横幅除外） | `stores/files.ts` 的 `writeDraft()` |
| **只有「确实不同」才打扰用户**：内容与即将显示的内容一致 → 不弹；文件草稿还要「确实比磁盘新」，并核对草稿里记的路径（键名对 `.`/`_` 会折叠，理论上会撞键） | `restorableDraft()`（`stores/files.ts`） |
| **未命名草稿按窗口（会话槽位）隔离**：`untitled-<slot>`；窗口没了留下的那份由主进程判定为「无主草稿」再交给空白缓冲区认领 | 新增 `src/shared/drafts.ts`（键约定，两个进程共用）+ `main/drafts.ts` 的 `takeUntitledDraft()` |

配套：

- 「谁还活着」只有主进程知道 → `registerIpc({ slotOf, liveSlots })` 由 `index.ts` 注入（不反向
  import，避免成环）；渲染层只调 `drafts.untitledDraft()` 拿结果。
- **数据安全不回退**：未命名缓冲区不进会话（§4.29），草稿是它唯一的保护。窗口被单独关闭或崩溃后，
  它的 `untitled-<slot>` 不再被任何活动窗口占着 → 下一个空白缓冲区认领并**搬移**（天然只被认领一次）；
  空内容草稿直接清掉。升级前遗留的 `untitled`（历史键）同样走认领 + 清理。
- 顺手把横幅文案接进 i18n（原先是硬编码中文、恢复/丢弃按钮也硬编码），未命名缓冲区不再说
  「比磁盘文件更新」（它没有磁盘文件），改用 `editor.restoreDraftUntitled`（三语齐全）。
- `applyDraftRestore(true)` 补 `syncEpoch++`：它和「重新解释编码」一样是**显式外部替换**，不该被
  编辑器的 600ms 回声静默窗吞掉（与 §4.39 同一类坑）。

#### 三、验收（新增套件）

`node tools/_verify-draft-banner.js`（独立 userData 起实例，21/21 PASS）：干净空白缓冲区不写草稿、
不弹横幅 → 旧版遗留的空 `untitled` 草稿不弹横幅且被清掉 → 真有未保存内容时横幅照旧出现（未命名文案）
且「恢复」能取回正文 → 干净文件不留草稿、与磁盘同内容的草稿不弹 → 真比磁盘新的文件草稿弹横幅（文件文案）
→ **多窗口**：A 窗口有未保存未命名正文时，新建窗口不冒横幅且 A 的草稿未被碰 → 无主草稿仍能被认领
→ **重启**（reload）：干净空白缓冲区不再冒横幅、脏未命名缓冲区重启后仍可恢复。

回归：`npm run typecheck` exit=0；`npm run build` 通过；本轮改动文件 ESLint 0 error；
`node tools/_verify-new-window-clean.js` **13/13 PASS**（新建窗口仍是干净窗口，不受草稿认领影响）。

> 存量影响：用户盘上那份空的 `untitled.json` 会在下次启动/新开空白窗口时被自动清掉（套件第 ② 条
> 就是按这份真实文件构造的）；已有的文件草稿只有「内容确实不同且比磁盘新」时才会再弹横幅。

---

### 4.45 关窗再打开：回到刚才那篇文档（本次）

**现象**（用户报的）：关掉窗口、重新打开，**文件夹回来了，文档却是一个不落在任何实际位置的
未命名缓冲区**（`Untitled-1.md`）—— 明明刚编辑过一篇真实的 `.md`。

#### 一、根因：单独关窗被当成「清空槽位」

`createWindow` 的 `closed` 处理器里有这么一句：单独关窗（非整体退出）时 `session.clearSessionSlot(slot)`
—— 本意是「下次启动不要把用户已经关掉的窗口又拉回来」。但用户关掉窗口往往就是「今天先这样」，
再打开时他期望回到刚才那篇；槽位一清，**文档路径就没了**。而侧栏那个文件夹来自另一处（全局
`kv.workspace.root`，不随槽位走），于是出现「文件夹在、文件是虚空的」这种极不协调的状态。
实测（`node tools/_verify-session-last-closed.js` 的 A 段就是按这条构造的）：

```
关窗前 kv：{"slots":[{"path":"…\\restore-me.md","folder":"…"}]}
关窗后 kv：{"slots":[null]}                       ← 文档路径被清掉
重启后   ：{"root":"…","doc":null,"name":"Untitled-1.md"}   ← 文件夹照旧，文档虚空
```

#### 二、改法：槽位不删，改成「已关闭」；恢复时按两种退出方式分流

| 规则 | 落点 |
| --- | --- |
| 单独关窗 → 槽位**保留**并标记 `closed`/`closedAt`（只记最后一个被关掉的） | `services/session.ts` 的 `markSlotClosed()`，由 `index.ts` 的 `closed` 处理器调用 |
| **整体退出**（菜单退出 / 系统关机 / 崩溃）：当时活着的窗口**全部**恢复（原行为不变） | `planRestore()`：优先返回未标记 `closed` 的槽位 |
| **挨个关窗**：只恢复**最后关掉的那一个**；更早关掉的是用户明确关掉的，不再冒出来 | `planRestore()`：一个存活槽位都没有时，返回 `closedAt` 最新的那个 |

两个必须一起处理的细节：

1. **恢复时立刻摘掉「已关闭」标记**（`planRestore` 写回时删掉 `closed`）。否则那个窗口会一直挂着
   这个身份：用户接着再开一个窗口、然后整体退出，它会被当成「被单独关掉的」而丢掉（测试第 C 段
   正是踩到这个才暴露出来的）。
2. **`closed` 记录会顶掉上一条**（旧的连同槽位号一起置空）。否则「先关 C、再关 B」会留下两条记录，
   而更早关掉的那条会以「存活」的身份被恢复 —— 与「只回到最后关掉的那个」相反。

#### 三、验收（新增套件，自起自灭 3 轮实例）

`node tools/_verify-session-last-closed.js`（独立 userData，**8/8 PASS**）：
- **A** 单独关掉唯一窗口 → 再打开：回到关窗时那篇文档（`doc === alpha.md`，且不是 `Untitled-N.md`），工作区文件夹照旧；
- **B** 两个窗口（alpha / beta）挨个关掉（最后关的是 alpha）→ 再打开：**只有一个窗口、且是 alpha**，更早关掉的 beta 不再冒出来；
- **C** 两个窗口一起结束（整进程被杀 ≈ 崩溃/整体退出）→ 再打开：**两个窗口都回来**。

回归：`npm run typecheck` exit=0、`npm run build` 通过、改动文件 ESLint 0 error；
`tools/_verify-session.js` **17/17 PASS**（E 段已从「关窗清槽位」改为「关窗保留并标记」，
A~D 段的光标/滚动/开关/文件丢失恢复全部照旧）；`_verify-draft-banner.js` **21/21**、
`_verify-new-window-clean.js` **13/13**。

顺带把 `_verify-session.js` 变得**不依赖 dev server**：页面识别同时认 `5173` 与
`out/renderer/index.html`，并且不再按 `Symbol(pinia)` 的名字找 store（生产构建会压掉 symbol
描述，只有 dev server 页面能命中）—— 与其余套件统一成「provides 里持有 `_s` Map 的那个对象」。

> 存量影响：你现有的 `kv.session` 里那份记录早被旧逻辑清掉了，所以**下一次正常关窗再打开**才生效
> （从那以后每次都生效）。

---

### 4.46 任务栏图标变缺省：隔离实例抢了用户的 AUMID（本次）

**现象**（用户报的）：跑过项目（开发态）之后，任务栏按钮的图标变成**缺省图标**（Windows 的空白/通用图标）。

#### 一、根因：同一个 AUMID 下有两条快捷方式，用户的应用被解析到**测试实例那条**

任务栏按钮的**图标与名字**不是取窗口自己的 HICON，而是按「**AUMID → 开始菜单快捷方式**」这条链
去解析的。而开发态我们一直用**同一个** AUMID（`com.lumin.app.dev`）给所有实例：

| 谁 | 写的快捷方式 | 图标指向 |
| --- | --- | --- |
| 用户的应用（默认配置目录） | `Lumin (dev).lnk` | `%APPDATA%\lumin\icons\lumin-<hash>.ico`（长期存在） |
| 验收/隔离实例（`--user-data-dir`） | `Lumin (dev) [test].lnk` | `<临时配置目录>\icons\lumin-<hash>.ico`（**跑完就被删**） |

于是：隔离实例一跑，开始菜单里就多了一条**同 AUMID**的快捷方式，而它的图标文件随临时目录一起消失
（`Lumin (dev) [test].lnk` 按字母序还排在前面）。Windows 解析用户的应用图标时命中那条 → 找不到图标文件
→ **任务栏只剩缺省图标**。实测证据（`%TEMP%\lumin-taskbar.log`，来自本轮验收实例）：

```
[taskbar] shortcut ok=true path="…\Start Menu\Programs\Lumin (dev) [test].lnk"
          aumid=com.lumin.app.dev icon="C:\Users\…\Temp\lumin-guard-userdata\icons\lumin-817ce6db.ico"
```

而那条 `.lnk` 的图标文件在套件收尾删掉临时配置目录后就不存在了（`IconExists: False`）。
另外同一份日志还显示隔离实例的跳转列表重建也写进了同一个 AUMID —— 用户的右键菜单会被测试实例
的临时路径顶掉一次。

#### 二、改法：隔离实例用**独立标识**，并清掉历史残留

| 规则 | 落点 |
| --- | --- |
| 开发态按配置目录分流 AUMID：默认配置目录 `com.lumin.app.dev`，隔离实例 `com.lumin.app.dev.test` | `appId()` |
| 隔离实例的图标副本改放**稳定**目录（`%TEMP%\lumin-icons`），不再随它那个跑完就删的配置目录消失 | `iconDir()` + `runtimeIconPath()` |
| 默认配置目录启动时**自愈**：删掉名字里带 `[test]` 的快捷方式（历史版本留下的、带用户 AUMID 的那条） | `removeStaleTestShortcut()`，由 `ensureShortcut()` 调用 |

`appId()` 的打包分支没动（仍是 `com.lumin.app`，与安装器一致），所以打包链路、安装器那条
`Lumin.lnk`、`backfillInstalledShortcutAumid()` 的兜底语义全部不变。`[test]` 这个名字**默认配置目录
从不用**，自愈删它绝不会碰到用户那条快捷方式。

#### 三、修完的机器状态（本次已修）

- 删掉 `…\Start Menu\Programs\Lumin (dev) [test].lnk`（它当时指向已被删除的临时图标）；
- `ie4uinit.exe -show` 刷新 shell 图标缓存；
- 复读用户那条 `Lumin (dev).lnk`：target/args 正确，图标指向
  `%APPDATA%\lumin\icons\lumin-817ce6db.ico` 且**文件存在**。

以后运行验收套件不会再产生这种残留：新的隔离实例写的是 `.test` 标识那条，且图标落在稳定目录里；
默认配置目录每次启动还会顺手清掉 `[test]` 残留。

#### 四、验收

`node tools/_verify-taskbar-jumplist.js`（隔离实例 + 主进程自检日志 + 真起第二进程）**31/31 PASS**，
其中为本次新增/改写的断言：

- `isolated-aumid-is-not-user-aumid`：隔离实例的 AUMID 必须是 `com.lumin.app.dev.test`（**不再与用户同一个**）；
- `isolated-shortcut-path-is-test-only`：它写的必须是 `[test].lnk`，不能是用户那条；
- `isolated-shortcut-icon-outside-profile`：它写的图标必须落在配置目录**之外**（稳定目录）；
- `user-shortcut-icon-still-valid`：**用户那条** `Lumin (dev).lnk` 的图标文件必须仍然存在（这条直接钉住本 bug）。

顺带把该套件的 SETUP 也换成「provides 里持有 `_s` Map 的对象」那套取 pinia 的口径
（与 §4.45 同一处改动：不再按 `Symbol(pinia)` 的名字找，生产构建会压掉 symbol 描述）。

> 如果你的任务栏还留着旧图：图标缓存是按 AUMID 记的，正常重启应用即可；极少数情况需要
> 「从任务栏取消固定 → 重新固定」，或重启一次 explorer.exe。

---

### 4.47 顶部栏「新建」按钮 + Ctrl+N 的语义：新窗口 + 工作区不变 + 未命名文档（本次）

**需求**（用户提的）：顶部栏要有一个「新建」按钮；Ctrl+N 和「文件 → 新建」都应当**开一个新窗口**，
**文件夹不变**，但文档是**未命名**的；按 Ctrl+S 时才问保存到哪。

#### 一、改之前的三种「新建」（各说各话）

| 入口 | 旧行为 |
| --- | --- |
| 文件 → 新建文档 / `Ctrl+N` | 在**当前窗口**的工作区里造一个 `未命名.md` 并打开（还先弹脏数据确认） |
| 文件 → 新建窗口 / `Ctrl+Shift+N` | 干净窗口：**不继承工作区**，空白 + 未命名文档 |
| 侧栏空态 / 文件树的「新建文件」 | 在工作区里造文件（本次**保持不动**，那才是它们该有的语义） |

#### 二、改法：一个动作、三个入口共用一份实现

- 新增 `newDocumentWindow()`（`composables/useAppActions.ts`）：有工作区 → `app.openFolderInNewWindow(root)`
  （新窗口以**同一个文件夹**为工作区）；没有工作区 → `app.newWindow()`（干净窗口）。
- 「文件 → 新建文档」、`Ctrl+N`（命令表 `file.new` → `handleMenu('new')`）、顶部栏新按钮**都调它** ——
  三个入口不可能走岔。
- **不再需要脏数据确认**：新动作完全不碰当前窗口（与「最近文档/最近文件夹 → 新窗口」同一口径）。
- 未命名文档 `path === null` ⇒ `files.save()` 天然走 `saveAs()`（`chooseFile` 对话框）：
  「Ctrl+S 时选择保存到的位置」**不需要新代码**。
- 顶部栏按钮：放在菜单组**右侧**（`data-topbar-action="new"`，`file-plus` 图标 + 「新建」，title 带 `(Ctrl+N)`），
  不挤 Alt+F/E/V/H 的位置；文案走 i18n（新增 `menu.new`，三语齐全）。
  **（后续调整：§4.50 把这个独立按钮收回「文件」菜单第一项 —— 顶部栏只留菜单组。）**

**为什么不做成「在当前窗口新建」**：用户要的是「新建 → 直接开始写 → 保存时再决定放哪」，
而且当前窗口正在写的东西一个字节都不会被打断。

#### 三、验收

新增 `node tools/_verify-new-document.js`（隔离实例，**19/19 PASS**）：

- 顶部栏按钮存在、在菜单栏内、标签等于 `menu.new`（**§4.50 起改为：「文件」菜单第一项就是「新建」、
  顶部栏不再有独立按钮、全菜单只有一个「新建」**）；
- **三个入口各跑一遍真实交互**（真实鼠标点击按钮 / 真实 `Ctrl+N` 按键 / Alt+F 后点菜单项），
  每个都：多出一个窗口（slot 变化）、新窗口 `root` 与当前窗口**同一个文件夹**（侧栏树有行）、
  文档是 `Untitled-N.md`（`path === null`、不脏）；
- **当前窗口没被动**（文档与工作区照旧）、**工作区目录里没多出任何文件**（旧行为会造 `未命名.md`）；
- 未命名 ⇒ 保存走另存为（`path === null` 前提 + 静态核对 `save() → saveAs() → chooseFile` 链，
  原生对话框无法自动作答，与 `_verify-save-as-workspace.js` 同一口径）。

回归：`tools/_verify-keymap.js` **33/33**（C 段从「工作区文件数 +1」改为「**窗口数 +1**」判定，
并新增「新窗口同工作区且未命名、不落盘」两条；录制期间那条也补上窗口数断言）；
`tools/_verify-new-window-clean.js` **13/13**（「新建窗口」的干净窗口语义未受影响）；
`tools/_verify-welcome-removed.js` **32/34**（文件菜单仍有「新建文档」、侧栏空态三个入口不变；
另 2 项是既有的隔离实例环境跳过）；`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

顺带把 `_verify-keymap.js`、`_verify-welcome-removed.js` 也换成「provides 里持有 `_s` Map 的对象」
取 pinia、页面识别同时认 `out/renderer` 的口径（与 §4.45/§4.46 同一处修正）：它们现在**不依赖 dev server**。

---

### 4.48 「另存为」对话框默认落在侧栏那个文件夹（本次）

**需求**（用户提的）：§4.47 的「新建」开出来的未命名文档，按 Ctrl+S 时对话框应当**默认就停在
侧边栏打开的那个文件夹**（省掉每次自己找一遍）。

#### 一、改之前

`file:chooseSaveFile` 的 `defaultPath` 只有**文件名**（`Untitled-1.md`），于是对话框停在哪完全看
Windows 记的「上次位置」—— 常常不是当前工作区。

#### 二、改法：两半各管一段

| 半 | 落点 | 规则 |
| --- | --- | --- |
| 渲染层决定**默认目录**交给主进程 | `stores/files.ts` → `saveAs()` | `const dir = current.path ? currentDir : root` |
| 主进程拼成 `defaultPath` | `main/ipc.ts` → `file:chooseSaveFile` | `dir && existsSync(dir) ? path.join(dir, name) : name` |

- **未命名文档**（含 `Ctrl+N` / 文件 → 新建 开出来的那份）→ 传**侧栏当前工作区**；
  于是 Ctrl+S 默认就存进侧栏那个文件夹，落盘后 `syncWorkspaceToPath()` 还会把新文件在树里露出来。
- **已有路径**（对已存在的文档按「另存为」）→ 传**它自己所在的文件夹**（`currentDir` 就是打开/上次保存时记下的）——
  比一律用工作区根更符合直觉（文档在 `工作区\sub\` 下时，默认还是 `sub`）。
- **都没有**（没打开文件夹、也没有路径）→ 不传：交给系统记上次的位置。
- 目录**已不存在**（工作区被移走/删掉）→ 主进程退回「只给文件名」，不甩一个死路径出去。

#### 三、验收

`tools/_verify-new-document.js` **23/23 PASS**（在原有 19 条上新增 4 条）：

- `untitled-save-defaults-to-sidebar-folder`：Ctrl+N 的那个窗口里，交给对话框的目录 == 侧栏工作区；
- `existing-save-defaults-to-own-folder`：把工作区子目录里的 `sub\c.md` 打开后，默认目录 == `工作区\sub`
  （证明两条分支真的分开，不是都退化成工作区根）；
- `static-save-as-passes-default-dir` / `static-main-joins-dir-and-name`：静态核对两半
  （原生保存对话框无法在自动化里作答，与 `_verify-save-as-workspace.js` 同一口径）。

回归：`_verify-save-as-workspace.js` 里那条「`saveAs` 保存成功后调用 `syncWorkspaceToPath`」的静态断言仍成立；
`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

---

### 4.49 按 Ctrl+N 却冒出「检测到上次未保存的内容」：草稿归属改成显式身份（本次）

**现象**（用户报的）：按 Ctrl+N 开出来的新窗口，弹出了「检测到上次未保存的内容」横幅 ——
用户明确要的是一篇空白，这既打断人又说不通。

#### 一、根因：§4.44 的「无主」判据太宽

§4.44 给未命名草稿分了命名空间（`untitled-<会话槽位>`），「无主」= **没有活动窗口占着那个槽位**。
于是两类东西都会被判成无主，并被**任何一个**空白缓冲区认领：

1. 某个窗口**被关掉**后留下的草稿（`untitled-<它的槽位>` —— 槽位不再 live，草稿还在盘上）；
2. 槽位号被复用：某个关掉的窗口腾出索引后，后来的窗口拿到同一个号，而那一格还留着**上一个住户**的正文。

Ctrl+N 开的新窗口正好是「空白缓冲区」，于是把别人的正文当成自己的弹了出来。

#### 二、改法：草稿带**写它的窗口实例**

| 机制 | 落点 |
| --- | --- |
| 每个窗口实例一个 uid（`crypto.randomUUID()`），随窗口 argv 下发（`--lumin-window-uid=`，reload 后不变） | `index.ts` `createWindow()` |
| 写草稿时盖上这个 uid（`DraftInfo.ownerUid`） | `main/ipc.ts` `drafts:save` + `main/drafts.ts` `saveDraft()` |
| 「是我的」= **uid 相同**（同一个窗口 reload 前后）；「无主」= 写它的窗口已经不在这个进程里 / 来自上一次运行 | `main/drafts.ts` `takeUntitledDraft()` |
| **只有本次运行的启动窗口**能认领无主草稿（Ctrl+N / 新建窗口是明确要空白，不打扰） | `index.ts` 的 `startupWindowId` + `SlotRegistry.mayClaimUntitledDraft` |
| 自己这一格留着**别人**的正文时：不弹、也**不覆盖**，先挪到停放键 `untitled-orphan` 等着被启动窗口认领 | `main/drafts.ts` `parkDraft()` |

安全性没丢：崩溃 / 单独关窗后的未保存正文，仍会在**下次启动的那个窗口**里被认领（§4.44 的
数据安全承诺照旧），只是不再往 Ctrl+N 的窗口里塞。

#### 三、验收

`tools/_verify-draft-banner.js` **25/25 PASS**（需要 `LUMIN_DRAFTS_DIR` 才能构造「写它的窗口不在了」
的草稿并直接核对盘上文件）：

- `new-window-does-not-claim-orphan`：新开的窗口（Ctrl+N 同一条路径）**不弹横幅**，且把它留给启动窗口；
- `startup-window-claims-orphan` / `orphan-draft-moved`：启动窗口照旧认领并搬走（数据安全）；
- `foreign-draft-not-shown` / `foreign-draft-parked-not-overwritten`：别人 uid 的草稿既不展示也不被覆盖；
- `sibling-draft-untouched`、reload / 重启那几条照旧（同一个窗口自己那份仍认得出来）。

`tools/_verify-new-document.js` **24/24 PASS**：新增 `no-new-window-shows-draft-banner` ——
先往盘上种一份无主草稿，再走**文件 → 新建 / 真实 Ctrl+N**（§4.50 前的第三条是顶部栏按钮）几条路，
新窗口都不弹横幅。

回归：`tools/_verify-session.js` **17/17**（新增的 `--lumin-window-uid` 不影响槽位解析与会话恢复）、
`tools/_verify-session-last-closed.js` **8/8**、`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

---

### 4.50 「新建」收进「文件」菜单第一项（本次）

**需求**（用户提的）：把顶部栏那个独立的「新建」按钮收回「文件」菜单里，放在最上面。

**背景**：§4.47 加按钮时，「文件 → 新建文档」和它已经是**同一个动作**（新窗口 + 工作区不变 +
未命名文档）。所以这一轮不是「再加一项」，而是**合并成一个入口**（用户选的就是这条）：
菜单里若同时留着「新建」与「新建文档」，就是两个一模一样的入口。

#### 改法

| 位置 | 改动 |
| --- | --- |
| `TopMenuBar.vue` | 删掉顶部栏右侧的独立按钮；「文件」菜单第一项 = `menu.new`（新建，`file-plus` 图标），动作仍是 `newDocumentWindow()` |
| i18n ×3 | `menu.new`（新建 / New / Создать）成为这一项的文案；删掉已无人引用的 `menu.newDoc`（三语同步删，键集仍完全一致：357 键） |
| `useKeymap.ts` | 命令 `file.new`（`Ctrl+N`）的标题 key 改为 `menu.new` —— 设置 → 快捷键里显示的就是「新建」 |
| `main/menu.ts` | 隐藏的原生菜单那一项也跟着改叫「新建」（仍是同一个 `send('new')`） |
| 侧栏空态 / 文件树 | 仍用 `open.newDoc`（「新建文档」）—— 那是「在工作区里新建文件」，与菜单里的「新建」是两件事，保持不变 |

改完的「文件」菜单：**新建 / 新建窗口 / 打开… / 打开文件夹… / 最近文档 ▸ / 最近文件夹 ▸ /
保存 / 另存为… / 导出 ▸ / 选择编码重新打开 ▸**。

#### 验收

`tools/_verify-new-document.js` **23/23 PASS**（原 19 条的入口断言按新位置重写）：

- `topbar-button-removed`：顶部栏只剩五个菜单组（`文件(F)|编辑(E)|段落(D)|视图(V)|帮助(H)`），没有残留按钮；
- `file-menu-first-item-is-new`：文件菜单**第一项**就是「新建」；
- `file-menu-has-single-new-entry`：全菜单只有**一个**「新建」，且不再有「新建文档」；
- `menu-new-opens-new-window` / `menu-new-keeps-same-folder` / `menu-new-doc-untitled` /
  `menu-new-works-repeatedly`：真实点这条菜单项（两次）→ 每次都多出一个窗口、工作区不变、
  文档是未命名缓冲区；加上 `Ctrl+N` 那条，以及 `no-new-window-shows-draft-banner`（种了无主草稿也不打扰）。

回归：`tools/_verify-welcome-removed.js` **32/34**（`file-menu-has-new` 已改成「第一项是新建、
且没有新建文档」；另 2 项仍是既有的隔离实例环境跳过）、`tools/_verify-i18n.js` 正常切换语言；
三份 locale 键集逐项一致（357 键，无 missing/extra）；`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

> `tools/_verify-keymap.js` 本轮**未跑**：它 `import('/src/lib/keymap/service.ts')`，必须有 dev server
> 在 5173 才跑得起来，而写这轮时它没在跑。本轮对它的影响只是 `file.new` 的标题 key 换成 `menu.new`
> （三语都有这个 key，且 `titles-and-groups-translated` 校验的就是「标题能取到」），Ctrl+N 的行为
> 由上面那个套件覆盖。

---

### 4.51 系统性优化第一轮：数据安全 + 门禁 + 安全/性能 + 测试基建（本次）

> 依据：桌面上的《Lumin 项目评审报告》。按仓库自己的规矩「一次一波、每波留下可复跑数字」，本轮做的是
> 报告里的**第一批（零风险高收益）**，外加三个高价值项（安全加固、索引节流、单元测试 + CI）。
> Wave 1（Markdown 保真）与 Wave 2（元数据/EOL/本地历史）**未动** —— 它们是各自独立的一波，见文末。

#### 一、数据安全（P0）

| 项 | 改法 | 落点 |
| --- | --- | --- |
| **写盘原子化** | 同目录临时文件 → `fsync` → `rename` 覆盖；失败清理临时文件并原样抛出 | `main/fileOps.ts` `writeFile()` |
| 失败要带原因 | IPC 错误前缀削掉后进 toast（不再只有「保存失败」） | 新增 `renderer/lib/errors.ts`，`stores/files.ts` 的 `save()` / `reopenWithEncoding()` |

为什么必须：原先 `fs.writeFile` 直接覆盖原文件，写入中途崩溃/断电/磁盘满会把用户唯一的一份稿件截断，
而当时连本地历史都还没有 —— 这是写作工具最不能接受的一类故障。同分区 `rename` 是原子的，
磁盘上任何时刻只可能是「完整旧版」或「完整新版」。

#### 二、门禁可用（P2）

| 项 | 改法 | 实测 |
| --- | --- | --- |
| `tools/**` 不进 lint | flat config `ignores` 加 `tools/**`、`build/**`（脚手架是 CommonJS + 一次性脚本，898 个 error 把真问题淹了） | 912 → 14 errors |
| 行尾不再假报 | `.prettierrc.yaml` 加 `endOfLine: auto`（工作树是 CRLF，默认 LF 校验让**每一行**都报 `Delete ␍`） | 7260 → 0 warnings |
| 修掉 src 的 14 个 error | 13 个 `no-useless-escape`（正则字符类里的多余转义）+ 1 个缺返回类型 | — |
| 格式化收口 | `prettier --write src`（41 个文件，纯格式） | — |
| **结果** | — | **`npm run lint` 0 error / 0 warning（exit 0）** |

**踩到的坑（值得记住）**：`prettier --write` 会把模板里**内联多语句**的分号吃掉，变成
`@dblclick=" a = 1 b() "`，Vue 模板编译器随后报 `Error parsing JavaScript expression`，构建直接失败。
正确做法是把这类逻辑抽成方法：本轮抽了 `collapseSidebar` / `openGeneralSettings` / `pickTheme` /
`resetSplitRatio`（顺带让模板更干净），并在 `tools/_verify-local-media.js` 里逐个个点了一遍。

#### 三、仓库卫生（P2）

- 取消跟踪并清理误提交的构建产物：`build-out.txt`、`typecheck-out.txt`、`dev-app-update.yml`（`.gitignore` 同步加规则）。
- 新增 `.gitattributes`：行尾与二进制类型写进仓库，不再看各机器的 `core.autocrlf`（**没有**顺手 renormalize 历史，那是独立一次改动）。
- README 重写：平台现状（Windows 优先，mac/Linux 未验证）、真实的质量门禁命令、目录结构、文档地图、
  已知限制与路线 —— 修掉「说 2 种语言其实 3 种」「说 run-verify.ps1 跑 45 项其实只跑 1 个」这类过期信息。
- 新增 `CHANGELOG.md`（Keep a Changelog；此前完全没有）。
- 依赖与元数据：删掉未使用的 `@electron-toolkit/preload`（`src` 里 0 引用，并同步了 lock）、
  删掉 pnpm 专用字段 `allowScripts`、补 `engines.node >= 22`、补 `npm run ci` / `lint:fix`。
- 死代码：删掉 `wasCrashed()` 与整套 crash-flag（写而不读）、`releaseSlot()`（从未被调用）。

#### 四、安全加固（P1）

| 项 | 改法 | 落点 |
| --- | --- | --- |
| `lumin-file://` 无校验 | **两道白名单**：① 媒体扩展名（图片/音视频/PDF）；② 必须位于「当前工作区」或「某个已打开文档所在目录」之内，否则 404 并记一行日志 | `main/index.ts` `protocol.handle` + `shared/media.ts`（纯函数）+ `fileOps.isServableMedia()` + `openDocs.listOpenDocs()` |
| 缺 `will-navigate` 兜底 | 只允许停留在自己的页面，其余拦下并交系统浏览器（与 `setWindowOpenHandler`、`shell:openExternal` 白名单同口径） | `main/index.ts` `createWindow` |
| 搜索结果 `v-html` | 主进程 `snippet()` 改用 U+0001/U+0002 作标记（**数据里不再夹 HTML**），渲染层按段渲染 `<em class="gs-hl">` —— **全程没有 `v-html`**，也就没有转义遗漏的机会 | `main/services/database.ts` + 新增 `renderer/lib/highlight.ts` + `GlobalSearch.vue` |

顺带修掉一个**功能缺口**：`![](img/a.png)` 这类相对图片原先按「页面目录」解析（`resolveLocalImageSrc`
是空实现）→ **渲染不出来**。现在按**文档目录**解析成 `lumin-file:///<绝对路径>`（新增
`renderer/lib/imageSrc.ts`，纯函数 + 单测），走上面那道校验过的协议加载。

#### 五、性能（P1）

**FTS 索引节流**：自动保存默认 3 秒一次，原先每次都 `DELETE` + `INSERT` 整篇正文进 FTS5 ——
`DatabaseSync` 是**同步** API、跑在主进程上，大文档等于每 3 秒卡一下。现在：
元数据（标题/时间/字数）立即写；正文索引按 rowid 合并、**2 秒窗口**批量重建（批次内开事务，
`node:sqlite` 没有 better-sqlite3 的 `.transaction()`，就显式 `BEGIN/COMMIT/ROLLBACK`）；
单篇超过 **256KB** 只索引前一段；**搜索前**与**退出前**各 flush 一次，保证「刚保存就搜」也能命中。
落点：`main/services/database.ts`（`scheduleFtsIndex` / `flushFtsIndex` / `clipForIndex`）+ `index.ts` 的 `before-quit`。

#### 六、测试基建（P1-7 / P2-2）

1. **把判定从 I/O 里剥出来**（这是本轮结构性改动的主线）：
   - `shared/drafts.ts`：`planUntitledDraft(ctx, onDisk)` → 返回 `show / adopt / park / purge` 步骤；
     `main/drafts.ts` 只剩「列目录 → 问它 → 照做」。这块语义连续出过三次真 bug（§4.44/§4.45/§4.49）。
   - `shared/session.ts`：`planRestoreFromSlots(slots, max)` → 返回「重建哪些窗口 + 清哪些 closed 记录 + 摘哪些标记」；
     `main/services/session.ts` 只做 kv 读写。
   - `shared/media.ts`、`renderer/lib/imageSrc.ts`、`renderer/lib/highlight.ts`：同样是纯函数。
2. **`tests/`（`node --test`，原生 TS 类型剥离，零新依赖）**：57 条断言 —— 草稿归属矩阵（11 条）、
   会话恢复矩阵（9 条）、高亮分段（5 条）、图片路径（8 条）、路径工具（5 条）、编码表（5 条）、
   媒体白名单（8 条）、**package.json ↔ package-lock 一致性自检**（6 条）。
3. **CI**（`.github/workflows/ci.yml`，Windows runner）：`npm ci` → typecheck → lint（`--max-warnings 0`）→ 单测 → 构建。
   本地等价命令是 `npm run ci`。

#### 七、本轮验收数字（全部可复跑）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | **0 error / 0 warning** |
| `npm run test:unit` | **57/57** |
| `npm run ci`（本地等价 CI） | exit 0 |
| `npm run build` | exit 0 |
| `_verify-draft-banner.js` | 25/25 |
| `_verify-new-document.js` | 23/23 |
| `_verify-session.js` | 17/17 |
| `_verify-session-last-closed.js` | 8/8 |
| `_verify-taskbar-jumplist.js` | 31/31 |
| `_verify-local-media.js`（本轮新增，10 条） | 10/10 |

`_verify-local-media.js` 覆盖三块：相对图片按文档目录解析并**真的加载成功**、协议两道闸
（非媒体文件 404、工作区外图片 404）、以及本轮抽成方法的四个 UI 处理器逐个点一遍。

#### 八、本轮**未做**（下一波的起点，别当成已完成）

1. **Wave 1 Markdown 往返保真**（信誉底线）：夹具 + `EXACT/NORMALIZED/LOSSY` 三档 + 幂等回归 + 报告。**优先做这个。**
2. **Wave 2 数据安全**：`documents` 表加编码/EOL/BOM 列 + 迁移；`services/eol.ts`；本地历史与回滚；以编码/EOL 保存。
3. **Wave 3**：编辑器 ⇄ store 的显式意图状态机（替换回声 + 600ms 两条启发式）；文件树键盘可达；原生菜单文案三语。
4. **工程化**：`tools/lib/harness.js` + `tools/run-suites.js`（57 个 CDP 套件目前没有统一入口，
   且仍有 49 个套件按 `Symbol(pinia)` 名字取 store —— 在生产构建下会失败）；
   `files` store 拆分；把 store 里那份为绕循环导入复制的 `confirmIfDirty` 收敛到 `services/dialog`。
5. 依赖升级与 `node:sqlite` 实验 API 的升级检查单；`publish` 渠道与代码签名决策。

---

### 4.52 Wave 1：Markdown 往返保真（本次）

> 上一节把「Wave 1」列为第一优先，理由是它是**写作工具的信誉底线**：
> 用户打开一份 `.md`、动一下、保存 —— 文件不该变；内容更不该被吃掉。
> 本轮把它做成可复跑的数字，并在过程中查实并修掉了 **7 类内容损坏缺陷**。

#### 一、判级器：`tools/lib/md-fidelity.js`（纯函数，零依赖）

三档分级，等级数字越大越糟（`actual > expected` 即回归）：

| 档 | 含义 |
| --- | --- |
| `exact` | 磁盘字节完全没变 |
| `normalized` | 经过**文档化的保义规则**规范化后完全一致：文件被重写，但语义没丢 |
| `lossy` | 规范化后仍不一致 → 内容/结构真的变了，必须当缺陷处理 |

规范化只收「能在 CommonMark 语义上站得住脚」的改写，共 18 条（`RULES` 导出，报告可直接引用）：
行尾 LF、硬换行两种写法归一、ATX/Setext 标题、列表标记 `*`/`+`/`1)`、引用块、分割线、表格空白与分隔行、
围栏 `~~~`→``` ```、缩进代码 ↔ 无 info 围栏、强调标记 `__`/`_`、链接尖括号、HTML 实体、引用式链接展开、
**段落内软换行合并（软换行 ≡ 空格）**、连续空行压缩、非必要转义 `\\` ≡ `\`、
**不同标记的相邻列表之间的空行无义**（同标记的空行会让列表变松散，那就有义了）。

判定「不能靠规则糊过去」的例子（都写成了单测）：围栏内容里的 `*` 差异、行内代码里的内容差异、
`**粗**`→`*斜*`、少一个列表项、表格单元格内容变化、段落合并、代码语言丢失。

#### 二、夹具库 `tools/fixtures/md/`（30 份 + `EXPECT.json`）

覆盖：标题（ATX/Setext/边界写法）、段落与硬换行、强调与嵌套、转义、列表（无序/有序/嵌套/松散/相邻）、
任务列表（含有序）、引用块、分割线、围栏代码（含内容里带 ```）、缩进代码、表格（对齐/转义竖线）、
链接（行内/带标题/自动链接/裸 URL/中文路径/引用式）、图片（本地/远程/空 alt/行内/被链接）、行内 HTML、
实体、中日韩与 Unicode、公式、mermaid、`[TOC]`、YAML front matter、空行边界、综合文档。

**`EXPECT.json` 就是契约**：`class` + `why`。`lossy` 必须写清**为什么**以及**修法**——
没有 why 的 lossy 等于把缺陷藏进预期里。实测比预期好会在输出里提示「可收紧」，
比预期差就是 FAIL。

#### 三、套件 `tools/_verify-md-fidelity.js`（文档级 / 幂等 / 字节级）

1. **文档级（主断言）**：把夹具装进真实编辑器 → 触发应用**自己的落盘管线**
   （`TyporaEditor` 的 `flushSync`，用 window 的 `beforeunload` 同步触发，正是「关窗落盘」那条真实路径）
   → 读 `files.current.content`（= 文档文本）→ 判级比对。
   *为什么绕这一道*：Tiptap 只在 **docChanged** 时发 `onUpdate`（还有 250ms 防抖），
   而 `beforeunload` 的 flush 是同步的 —— 既确定，又不用给产品代码开后门。
2. **幂等**：把文档文本再装回去走一遍，必须**一字不差**（否则每次保存都在漂，
   git diff 全是噪声，用户会认为编辑器在改他的文件）。已知缺口内的幂等不检查。
3. **字节级**：真开真存（临时目录副本）—— 打开不改就保存必须**字节不变**
   （CRLF / UTF-8 BOM / GB18030 / 文末无换行四种），走一遍落盘管线再保存也要字节不变。
   诊断产出落 `%TEMP%\lumin-md-fidelity-report.json`（原文/产出/判级/逐行差异）。

#### 四、本轮查实并修掉的缺陷（都是「用户会丢内容」那一类）

| 现象 | 根因 | 修法（落点） |
| --- | --- | --- |
| 代码块里出现成对反引号（``let a = `x```）时，**一次编辑后整段代码并成一行** | 标记模型的「源码权威重推」把 `codeBlock` 当普通段落处理（PM 里 `isTextblock` 对代码块也为真），拿代码文本再喂 markdown-it，而重推走的 DOMParser **不保留空白** → 换行全塌成空格 | `isVerbatimBlock()`（`type.spec.code === true`）把逐字块排除在归一化之外（`typoraInlineMarks.ts`） |
| 行内代码里的反斜杠**每保存一次多一层**（非幂等增长） | prose-mirror-markdown 只按**最内层 mark** 的 `escape:false` 决定原样输出，而 `mdStyle(code)` 正文没有这层保护；代码跨度里反斜杠不是转义字符 | 新增 `mdCodeLiteral` mark（空包裹 + `escape:false`），贴在代码样式正文上（`typoraInlineMarks.ts` + `extensions.ts`） |
| 软换行被写成行尾 `\`（每行都加） | `Markdown.configure({ breaks: true })`：markdown-it 把段内单个换行渲染成 `<br>` → 解析成 hardBreak → 序列化成 `\`。语义从「软换行 ≡ 空格」变成强制换行，GitHub 渲染都不一样 | `breaks: false`；真正的「软换行可往返」需要独立节点，列为 Wave 2 |
| 无序列表标记被抹平（`*`/`+` → `-`），相邻两个列表被插**两个空行**，再解析并成一个**松散列表** → 每次保存都在漂 | 上游 `bulletListMarker` 固定 `-`；`renderList` 遇到同类型相邻块会 `flushClose(3)` 兜底 | 解析时记录 `bullet`（`parse.setup` 钩子给 `<ul>` 打 `data-bullet`）→ 序列化写回原标记；标记不同时 `flushClose(1)` 只断行不插空行（`listMarkers.ts`） |
| 任务列表**每个任务项之间都被塞空行**；`1. [ ] x` 变成「空的有序项 + 无序任务列表」 | 任务列表复用无序列表的序列化器，而它读 `node.attrs.tight`，`tight` 只挂在 bulletList/orderedList 上 → `undefined` → 松散；`ol` 形态的任务列表没有 parse 规则 | 给 `taskList` 补 `tight` 属性；parse 规则同时认 `ul/ol[data-type="taskList"]`（`listMarkers.ts`） |
| 相邻图片被粘成一行；图片后紧跟的标题被吞进同一段 | `Image` 是块级节点，但 tiptap-markdown 给它的是行内序列化器（不换行、不 closeBlock） | 自定义 Image 序列化器：沿用上游写法 + `closeBlock`（`extensions.ts`） |
| 内容里含 ``` 的代码块，围栏被内容提前闭合 → 后面正文被解析成代码 | 围栏固定写三个反引号 | `codeFenceFor(content)`：围栏长度 ≥ 内容里最长反引号串 + 1（`shared/documentText.ts` + `codeBlock.ts`） |
| 序列化产出**不含文末换行** → 每次保存都与原文差一个字节 | 上游 serializer 不补 | 文档文本收尾规则 `withFinalNewline()`，收在 `markdownStorage.getMarkdown()`（编辑器内容 → 文档文本的**唯一出口**，否则会与外部同步比较打架、触发 setContent 回滚） |

#### 五、判级器/工具链自身踩过的坑（都已修，值得记）

- **判级器**：围栏闭合必须**不短于**开启（` ```` ` 里的 ``` 不闭合它）；`---` 既是 Setext 下划线又是分割线，
  得按「前面是不是段落文本」判（CommonMark 顺序）；`$$` 块要与多行写法归一；实体要按命名/十进制/十六进制还原
  （`&lt;` 与 `<` 才判等）；链接目标要还原百分号编码（`%E4%B8%AD` ≡ `中`）；
  相邻列表之间的空行要**在标记归一化之前**判定（归一化后 `*` 也成了 `-`，就再也分不出两个列表了）。
- **`start-isolated.ps1`**：Electron 的 `--user-data-dir` 用的是 **8.3 短路径**（`YANGBA~1`），
  拿长路径字符串比对会**漏杀**旧实例 —— 曾经因此对着**旧构建**跑了一整轮验收（结论全错）。
  现在两边都 `Resolve-Path` 成同一形态再比；端口判定改用 TCP 连接（`Get-NetTCPConnection`
  在受限模式会静默返回空，把「被占」判成「空闲」）。
- **PowerShell 脚本必须存 UTF-8 with BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本时按 ANSI 解码，
  中文注释里的多字节序列会撞出引号 → 语法错误。
- **别用 PowerShell 做字符串替换**：`$pair[0]`/`$pair[1]` 在字符串上取到的是**首字符**
  （`'s'`/`'t'`），一次替换把源码里的 `s` 全换成了 `t`（两个文件被改坏，`git checkout` 才救回来）。
  这类一次性改写一律走 Node 脚本。

#### 六、测试基建（本轮补齐）

- **`tools/lib/harness.js`**：CDP 套件公共骨架 —— 连页面、注入 pinia 访问器、键鼠模拟、结果汇总。
  两个反复咬人的坑固化在这里：**按结构找 pinia**（`provides` 里持有 `_s` Map 的那个对象），
  不按 `Symbol(pinia)` 名字找（生产构建会压掉 symbol 描述 → 只有 dev server 的页面能用）；
  页面识别同时认 dev server 与 `out/` 构建产物（不写死 5173）。
- **`tools/run-suites.js`**：统一入口 —— 逐个套件起**全新隔离实例**（串着跑必然互相污染）、
  解析末行 `--- N/M PASS`、汇总矩阵、有 FAIL 非零退出；依赖 dev server 的套件默认跳过（`--all` 才跑）。
- **单测**：`tests/md-fidelity.test.mjs`（判级器自身：每条规则一个同义改写用例 + 反例 + 幂等）、
  `tests/documentText.test.mjs`（收尾规则与围栏长度）。单测总数 57 → **81**。

#### 七、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **86/86**（57 → 86） |
| `npm run ci` | exit 0 |
| `_verify-md-fidelity.js` | **50 PASS / 0 FAIL / 20 SKIP**（30 份夹具；SKIP = `EXPECT.json` 里逐条写明修法的已知缺口） |
| `node tools/run-suites.js` | **7/7 套件 PASS**：session-last-closed 8/8、md-fidelity 50/70（0 FAIL）、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 31/31 |

#### 八、已知缺口（`EXPECT.json` 里逐条写了修法，Wave 2 的起点）

1. **反斜杠转义保留**：`\*` 被解析器吃掉，模型还原不回来（语义会从「字面星号」变成「斜体」）。
   修法：用 `parse.setup` 钩子替换 markdown-it 的 inline `escape` 规则，把转义字符渲染成带 data 标记的
   span + 一个 `escape:false` 的 mark 原样写回（钩子已验证可用）。
2. **行内 HTML**（`<kbd>`/`<span>`/`<br>`/注释/`<details>`）：unknown 标签被 DOMParser 剥离。修法：加「原样 HTML 节点」。
3. **表格列对齐 +单元格转义竖线**：Tiptap 表格没有 align 属性；`\|` 会被当分隔符。修法：cell 加 align + 自定义 Table 序列化器转义 `|`。
4. **公式**：应用**根本没有数学节点**（KaTeX 只用于导出 CSS），`$$` 只是普通文本，里面的反斜杠会被补成 `\\`。
   修法：mathInline/mathBlock 节点 + 原样序列化（顺带把「公式渲染」这个功能补上）。
5. **链接包裹的图片**（`[![alt](img)](url)`）与**段落中间的图片**：块级 Image 挂不了 link mark、会被拆成独立块。
   修法：内联图片节点或 figure 包裹节点。
6. **有序任务列表编号**：`1. [ ] x` 的编号在模型里没有位置。
7. **YAML front matter**：被解析成分割线 + 段落。修法：解析前摘出头部块存进文档属性。
8. **CommonMark 同标记相邻列表的重编号**：`3. c` 空行 `5. e` 在 CommonMark 里是**同一个**松散列表，
   所以 `5.` 会被重排 —— 这是规范行为，要「保持从 5 开始」得拆列表并记住起始序号。
9. **CRLF 与文末无换行**（字节级）：编辑器序列化只产出 LF；文档收尾规则统一补一个文末换行。
   前者要把 EOL 收进文档模型（Wave 2 的数据安全波）。

---

### 4.53 Wave 2：文档级元数据（编码 / 行尾 / BOM）与本地历史（本次）

> 这三件事是**同一个根**：「文档级元数据没有模型」。此前编码只活在渲染进程的 `current` 上、
> 再配一张 kv 表兜；行尾（EOL）**根本没人管**；保存成功即清草稿 —— 一次误保存无法挽回。
> 本波把前两件收进 `documents` 表，把第三件做成一条**写盘前的快照链**。

#### 一、行尾（EOL）进文档模型

**约定**：**内存里的文本永远是 LF，行尾是文档属性，落盘时才展开。**
理由：编辑器内核（ProseMirror / markdown 序列化器）只会产出 `\n`；若让「当前文本」承担行尾，
那么任何一次序列化都会把 CRLF 抹成 LF，而且没有任何一层知道它该不该抹。
把行尾变成**属性**之后只有一个真相：编辑器怎么改都不会污染行尾。

- `src/shared/eol.ts`（纯函数 + 单测）：`detectEol`（按**多数**行尾判定）、`toLf`、`toEol`、`hasUniformEol`。
- 判定与归一位于 `fileOps.readFileInfo`（打开时一次），展开位于 `fileOps.writeFile`（写盘时一次）——
  **所有写盘路径都走这里**（保存、另存为、导出），不会有调用点漏掉。
- 混合行尾（同一文件两种混用）没有正确答案：按多数判定，保存时统一成它。这条写进代码注释与本文档，
  免得日后被当 bug 报。
- **实测收益**：`_verify-md-fidelity.js` 的 crlf 字节级用例（打开 → 动一下 → 保存，字节必须不变）
  从「已知缺口」变成 **PASS**。

#### 二、编码 / 行尾 / BOM 落库 + 一次性迁移

- `documents` 表加 `encoding` / `eol` / `had_bom` 三列，用 `PRAGMA table_info` + `ALTER TABLE` 迁移
  （与 notifications 加列同一套写法，旧库无痛升级）。
- 老的 kv `fileEncodings`（`{ 小写路径: 编码 }`，插入序当 LRU）做**一次性迁移**：
  能对上 `documents` 行的条目搬进表；对不上的（文件还没进索引）留在 kv 兜底；迁完打标记不重复扫。
  `rememberEncoding` 现在优先写 `documents`，并顺手清掉 kv 里的同名条目，避免两处不一致。
- 顺带修掉一处**同名双份定义**：`DocMeta` 原本在 `shared/types.ts` 与 `main/services/database.ts`
  各写了一份。现在只保留 shared 那份并再导出（"一次真相"这条约定不该有例外）。

#### 三、本地历史（数据安全）

**问题**：保存成功即清草稿 —— 全选删掉再 Ctrl+S、或改错一份稿，就再也回不去了。

**做法**：

- 新表 `documents_history`（path / saved_at / size / preview / content / encoding / eol）。
- **快照取自磁盘上现有的字节**（即将被覆盖的那一版），记录点在主进程 `file:write`：
  * 语义准确 —— 用户想回滚的就是「上次保存时磁盘上的样子」；
  * 与调用方解耦 —— 保存、另存为、以后的回滚写回都自动有历史，不依赖某个调用点记得调用；
  * 内容相同不重复留（连按 Ctrl+S 不会灌水）。
- **抽稀策略是纯函数**（`shared/history.ts` 的 `planHistoryPrune`，有单测）：
  每文件最多 30 条；超过 30 天且不是该文件最新 3 条就丢；全库封顶 2000 条。
  数据安全优先于省空间：**每个文件的最新几条不受年龄限制**（全库膨胀交给总量封顶）。
- **回滚的语义是「载入缓冲」而不是「直接写盘」**：快照是说不准的东西，直接覆盖磁盘风险太大
  （选错版本、或只想摘一段）。载入后文档变成未保存状态，用户能在编辑器里看清/对比再 Ctrl+S。
  实测断言直接盯着这条：载入后缓冲是第一版、**磁盘仍是第三版**、`dirty === true`。

#### 四、界面

- 状态栏新增**可点的行尾标记**（LF ⇄ CRLF，点击即按新行尾写回）—— 行尾是「打开→保存会不会整文件 diff」
  的直接原因，值得一眼可见、一键可改。
- 文件菜单新增两个二级：「行尾」（以 LF / CRLF 保存）与「以编码保存」；「本地历史…」开浮层。
- 设置面板新增「默认行尾」（只影响新建/未命名文档；已有文件按自己原本的行尾）。
- 三语同步 11 个键（377 键，键集合一致）。

#### 五、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **97/97**（新增行尾 6 条、历史策略 5 条） |
| `_verify-md-fidelity.js` | **63 PASS / 0 FAIL / 19 SKIP**（82 条断言；新增行尾 6 条、历史 6 条） |
| `node tools/run-suites.js` | 7/7 套件 PASS |

行尾与历史的端到端断言（都是一个真实 Electron 窗口里跑出来的）：
打开 CRLF 文件 → 判定 `crlf` 且内存无 CR；切 LF → 磁盘 LF；切回 CRLF → 磁盘 CRLF；
元数据落库（`documents.eol/encoding`）；未命名文档用设置里的默认行尾；
保存两轮 → 历史两条（最新一条正是「即将被覆盖」的那一版、最早一条是打开时的原文）；
载入历史 → 缓冲变、磁盘不变、标记未保存；清空 → 归零。

#### 六、工具链补丁（本轮踩到的坑）

`tools/run-suites.js` 现在会在开场与「端口被占」时**清掉临时目录下的 Electron 实例**：
人工起的隔离实例（`%TEMP%\lumin-ud` 等）会占着 9222，把整轮矩阵顶成 6 个 FAIL ——
而那看起来像"代码坏了"，实际只是端口被占。判定按「命令行里的 user-data-dir 落在 `%TEMP%` 下」，
**绝不碰**用户自己的 `%APPDATA%\lumin` 实例。

#### 七、Wave 2 剩余（下一轮的起点）

1. **多窗口一致性**：同一文件在两个窗口打开时，编码/行尾以库为准（库表已就位，
   还差"打开时优先用库里记的元数据"这一步取舍与套件）。
2. **本地历史的可配项**：设置面板里的开关与保留策略（当前是代码里的常量 + 纯函数策略）。
3. 反斜杠转义保留（Wave 1 留下的第一号缺口，钩子方案已验证可用）。

---

### 4.54 Wave 3：显式意图同步 / 文件树键盘可达 / 原生菜单三语（本次）

> 三条的共同思路：**把"猜"换成"明说"**。

#### 一、编辑器 ⇄ store：显式意图状态机（替掉两条回声启发式）

**旧实现的两年债**（§4.6 / §4.11 记录过它救过的火）：`TyporaEditor` 的 watch 靠两条启发式判断
「这次 `modelValue` 变化是不是我自己的回声」——
① 与最近一次 emit 的内容完全相等 → 跳过；② 距最近 emit < 600ms → 跳过。

两条都**必漏判**，各自有记录在案的故障：

| 场景 | 旧行为 |
| --- | --- |
| 按原编码切回来（内容恰好等于上次 emit 的文本） | 规则①把它当回声丢掉 → **状态栏编码变了、正文没变** |
| 刚打完字就点「恢复草稿 / 切编码」 | 规则②把它丢掉 → 同上 |
| 每次 modelValue 变化 | 都要做一次**整篇字符串比较**（大文档下的无谓开销） |

**新实现**：契约定在 store 里 —— **凡是要编辑器换内容的动作都必须自增 `files.syncEpoch`**
（打开文件、恢复草稿、重新解释编码、载入历史；源码模式切回来走另一条既有路径）。
编辑器只看一件事：

```
世代没变 ⇒ 不是给编辑器的指令（多半是自己 flush 的回声）→ 不动编辑器
世代变了 ⇒ 按 store 的新内容 setContent（内容一致时连这一步都省）
```

于是「碰巧内容相等」「刚 emit 完」都不再影响判断，两条启发式连同 `lastEmitted`/`lastEmitTime`
一起删掉。**验收盯着三件事**（`tools/_verify-wave3.js` A 段）：

- flush 完之后**立刻**做显式替换，必须生效（旧规则②会吞掉它）；
- 编辑器自己的回声**不得**重建文档：输入一个字符后走完回声链路，文档内容与光标位置原样保持；
- 同一 `:key` 下换内容（未命名缓冲区 `openUntitled`）也要生效。

#### 二、文件树键盘可达（ARIA tree + roving tabindex）

`FileTree.vue` 容器是 `role="tree"`，每一行是 `role="treeitem"`，带 `aria-expanded`（目录）、
`aria-selected`（当前文档）、`aria-level`；**整棵树任何时候只有一个可 Tab 的行**（空闲时也挑一个落点，
`schema` 上就是 roving tabindex 的 0）。

键位按 WAI-ARIA 的 Tree View：`↑/↓` 上下、`→` 展开（已展开则进第一个子项）、`←` 收起（已收起则回父项）、
`Home/End` 首尾、`Enter/Space` 打开文件（目录则展开收起）。实现放在 `lib/treeFocus.ts`：

- **递归组件里怎么拿"可见行"**：直接用 DOM 顺序（`[data-tree-row]`）—— 渲染出来的行就是可见行，
  顺序天然等于 ARIA 要求的遍历顺序；不用把递归树拍平成数组再逐层传 props。
- **进子项为什么要轮询**：展开是一次 IPC 读目录 + 渲染，单次 `nextTick` 太早（实测拿不到子行）；
  实现里按 60ms 轮询几轮，并且每次都确认"本行仍是活跃行"（期间用户可能已按别的键）。
- 键盘焦点有可见描边，且只在 `:focus-visible` 时出现（鼠标点击不闪描边）。

#### 三、原生菜单三语化

菜单栏默认被隐藏（自绘顶栏 + `autoHideMenuBar=false`），只有系统级可访问性路径（Alt 唤出、
屏幕阅读器、Windows 菜单键）会用到它 —— 正因为"没人看"，它一直是硬编码中文。

- **语言包搬到 `src/shared/i18n/`**：主进程与渲染层**共用一份**（跨进程的东西放 shared，README 的开发约定）。
- `main/menu.ts` 所有标签走语言包；语言取持久化设置（SQLite kv 的 `settings.language`）。
- **换语言立即重建**：`settings:update` 里 `partial.language` 存在时调用 `installMenu()`（否则要重启才生效）。
- **可验证性**：菜单栏页面侧看不到，所以加了一行 ASCII 自检日志 `[menu] rebuilt lang=… top=…`；
  验收脚本读隔离实例的 stdout 断言"确实按新语言重建了"。
- **静态自检单测** `tests/menu.test.mjs`：菜单源码里没有硬编码中文（去掉注释后搜 CJK）、
  `T('key')` 用到的 key 在三份语言包都存在、顶层菜单带助记符、三份键集合一致。
  这条**当场抓出** 4 个漏翻的键（`cut`/`copy`/`paste`/`selectAll` 在语言包里根本不存在，
  原生菜单会退化成显示英文 key）。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **101/101**（新增菜单静态自检 4 条） |
| `tools/_verify-wave3.js`（新增，19 条） | **19/19 PASS** |
| `tools/_verify-md-fidelity.js` | 63 PASS / 0 FAIL / 19 SKIP |
| `node tools/run-suites.js` | **8/8 套件 PASS** |

Wave 3 段的端到端断言（真实窗口里跑出来的）：flush 后立刻显式替换仍生效且编辑器确实换成新内容；
自身回声不改文档、不动光标；`openUntitled` 同 key 也清空编辑器；
树结构（role/treeitem/aria-expanded/单一可 Tab 行）、`↓↑`、`Home/End`、`→` 展开并进子项、`←` 回父项并收起、
空目录再按 `→` 安静留在原地、`Enter` 打开焦点行文件；语言切到 en-US 后主进程按新语言重建菜单。

#### 五、仍待办（下一轮起点）

1. **工程化**：`files` store 拆分（约 700 行）、`confirmIfDirty` 收敛到 `services/dialog`。
2. **Wave 2 尾巴**：多窗口元数据一致性、历史保留策略可配。
3. **Wave 1 头号缺口**：反斜杠转义保留（`parse.setup` 钩子 + `escape:false` 的 mark，方案已验证）。
4. 仍有约 40 个老套件按 `Symbol(pinia)` 名字取 store（生产构建下会失败），继续「改到谁就顺手迁谁」。

---

### 4.56 工程化收口：store 拆分与对话框收敛（本次）

> 整改方案的最后两项工程债。原则同前几波：**先把「规则」从「状态」里剥出来** —— 能单测的才有底气。

#### 一、`files` store 瘦身（703 → 535 行）

这个 store 原本一份承担四件事：工作区文件树、当前文档 + 草稿 + 自动保存、**列表视图的派生缓存**、
最近文档/文件夹。拆法按「生命周期是否相同」而不是按行数切：

| 拆出物 | 为什么是它 | 落点 |
| --- | --- | --- |
| **列表视图缓存** → 独立 store | 它是一份**派生缓存**（主进程递归扫描的产物），失效条件是「工作区结构变了 / 某篇保存了」，与文档状态无关；只有一个消费者（`FileList.vue`） | `stores/workspaceDocs.ts`（`docs`/`epoch`/`loading` + `load`/`invalidate`/`bumpMtime`/`reset`） |
| **最近文档/文件夹/置顶的列表规则** → 纯函数 | 「去重 + 置顶 + 截断 + 并入当前工作区」这类容易写错又不容易发现的逻辑散在 4 个 action 里 | `lib/recent.ts`（`planTouchRecent` / `planRemoveRecent` / `planTogglePin` / `planTouchRecentFolder` / `planRemoveRecentFolder` / `planRecentFolderList`） |
| **草稿键与可恢复判定** → 纯函数 | 这块**出过三次真 bug**（§4.44 空草稿假横幅、§4.45 关窗清槽位、§4.49 跨窗认领），必须能被毫秒级钉住 | `lib/draftRules.ts`（`draftKeyFor` / `restorableDraft`） |
| **文档文本小工具** → 纯函数 | 未命名文档的编码/行尾、编码显示名、历史时间格式，都是**规则**不是状态 | `lib/docText.ts` |

依赖方向是**单向**的：`workspaceDocs` 读 `files.root`；`files` 只在结构变化/保存时调用
`invalidate()` / `bumpMtime()`。新增单测 `tests/filesRules.test.mjs`（9 条）。

**一个部署细节**：`tests/*.test.mjs` 直接用 `node --test` 加载这些模块，而 **Node 的 ESM 解析不做
扩展名补全** —— 所以「会被单测加载」的模块里，相对导入写显式 `.ts`（`tsconfig.web.json` 开
`allowImportingTsExtensions`）；其余文件保持仓库既有的无扩展名写法，不搞全仓改造。

**没有继续做的那一步（诚实记录）**：把**状态**也拆成「workspace store + document store」需要改动
约 20 个调用点（`files.root` / `dirCache` / `expanded` / `toggleDir` …），收益是文件更小、
风险是回归面铺得很宽。当前拆法已经把「派生缓存」与「规则」搬出主 store，剩下的 535 行是
「状态 + IPC 编排」，语义内聚；再拆建议单独一波、以现有 8 个套件为安全网来做。

#### 二、未保存更改确认：从四份收敛成一份

此前四处各写一遍同样的 `ui.confirm({ title: t('editor.dirtyConfirmTitle'), ... })`：
`composables/useAppActions.ts`、`stores/files.ts`（当初为绕循环导入复制了一份）、
`TreeNode.vue`（打开文件前）、`FileList.vue`（列表里打开）。文案改一次要改四处，漏一处就是
「两个入口问的话不一样」。

现在只有 `lib/dialog.ts`：

- `confirmDiscardChanges()`：直接问（调用方已确认确实脏了）；
- `confirmDiscardIfDirty(dirty)`：脏了才问，干净直接放行。

**关键设计**：这个模块**只依赖 ui store 与 i18n**，「脏不脏」作为**参数**传进来 ——
于是 `stores/files.ts` 也能用它，不必再为「循环导入」复制一份（那正是当初抄四遍的根因）。

命名偏差说明：整改方案写的是 `services/dialog`，但本仓库的 `services/` 是**主进程**约定
（`src/main/services/*`），渲染层没有这一层，故落在 `lib/dialog.ts`（与 `lib/errors.ts` 同级）。

#### 三、顺带记下的一条踩坑（工具链）

`tools/run-suites.js` 跑套件时**不要同时 `npm run build`**：实例加载的是 `out/`，
边跑边构建会让正在运行的实例读到半截产物 —— 实测表现是编码套件的「设置已落库」与
「菜单标题跟随语言」同时变红，看着像代码坏了，其实是构建把它脚下的产物换掉了。
这条已写进 runner 的文件头。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **110/110**（新增 9 条） |
| `npm run ci` | exit 0 |
| `node tools/run-suites.js` | **8/8 套件 PASS** |
| `tools/_verify-md-fidelity.js` / `tools/_verify-wave3.js` | 63 PASS / 0 FAIL / 19 SKIP · 19/19 |

#### 五、四波做完之后仍开着的口子（按价值排序）

1. **Wave 1 头号缺口**：反斜杠转义保留（`\*` 被解析器吃掉；`parse.setup` 钩子 + `escape:false` 的 mark 方案已验证）。
2. **Wave 2 尾巴**：多窗口元数据一致性（库表已就位，差「打开时以库为准」）、历史保留策略做成设置项。
3. **Wave 3.2**：三处真相源（WYSIWYG / 源码 textarea / 代码块 CM）收敛成单向数据流。
4. **套件迁移**：约 40 个老套件仍按 `Symbol(pinia)` 名字取 store（生产构建下会失败），继续「改到谁就顺手迁谁」。

---

### 4.57 反斜杠转义保留：`\*` 原样往返（本次）

> Wave 1 留下的第一号缺口。它排第一的原因是**信息在解析那一刻就丢了**：
> markdown-it 的 inline `escape` 规则会把 `\*` 变成文本 `*`，于是「字面星号」往返后
> 变成「斜体标记」—— 语义变了，而任何后置的归一化都补不回来（无法区分 `\*` 与 `*`）。

#### 一、机制：解析时留痕，序列化逐字写回

用 tiptap-markdown 官方给的 `parse.setup` 钩子（与「保留列表标记」同一套机制，见 §4.52）：

1. **替换 markdown-it 的 inline `escape` 规则**：照抄上游的三种分支，只改一处 ——
   可转义标点不再被"吃掉"反斜杠，而是把原文 `\X` 放进一个自定义 token；
2. **渲染成 `<span data-md-escape>\X</span>`**（token 自带渲染规则；内容来自用户源码，做了 HTML 转义）；
3. **`MdEscape` mark**（`escape:false` + 空包裹）认领这个 span → 序列化时**逐字写回**。

三种分支一个都不能漏（实测教训）：

| 分支 | 语义 | 漏掉的后果 |
| --- | --- | --- |
| `\` + 换行 | 硬换行（并吃掉行尾空格） | 退化成「字面反斜杠 + 软换行」→ 整段被并成一行，`paragraph-breaks` 夹具立刻变红 |
| `\` + 空格 | 反斜杠不是转义，字面输出 | 空格被当作转义目标 |
| 其余 | 可转义标点保留 `\X`；不可转义字符本来就原样 | `C:\temp` 会被补成 `C:\\temp`（源码漂移） |

#### 二、三处「不显眼但必须改」的联动

1. **`literalizeStrayMarkers` 要跳过转义文本**：那一步会把裸 `*`/`~`/`` ` `` 包成「字面量标记」，
   若不跳过，`\*` 会被拆成「反斜杠 + 字面量星号」→ 输出 `\\*`。
2. **转义文本必须留在样式构造里**：一开始把它当成不透明节点（`kind: 'other'`），
   结果它把同样式正文**切成两段** —— `**粗体里的 \* 星号**` 被拆成两个 `**…**` 构造，
   实测输出 `****\*****`。正确做法是让它作为**带样式的 verbatim 文本**参与构造
   （`verbatim` 标记只影响「不参与标记派生」与「序列化时贴回 mdEscape」两件事）。
3. **重推的触发条件要认识反斜杠**：`blockNeedsNormalize` / `resolveBlockContent` 的守卫
   此前只认 `*~`` ` ``；现在补上「反斜杠 + ASCII 标点」。用「反斜杠 + 标点」而不是「任意反斜杠」
   是有意的 —— Windows 路径那种普通反斜杠不该让每次按键都对整段做一次 markdown-it 解析。

#### 三、顺带修掉的「孤儿标记漂移」

夹具新加的一行暴露了另一个老问题：`$a * b$` 里那个**不成对**的 `*` 会被写出器补成 `\*`。
原因：把裸标记包成字面量标记（`literalizeStrayMarkers`）那条路径的触发条件用了 `PATTERN_TEST`
（要求**成对**的 `*…*`），单颗星直接漏过。现在触发条件补上「孤儿标记字符」这一档，
源码不再漂移（这正是那一整段代码注释里写的目标）。

#### 四、夹具与已知缺口

- `escapes.md` 扩到 6 个边界：非标点反斜杠、`\`+空格、`\`+emoji（代理对）、反斜杠硬换行、
  与粗体/行内代码/链接混排 —— 现在整份 **exact**（从「已知缺口 lossy」升级）。
- `math.md` 从 lossy 升到 **normalized**：`$$ … $$` 里的反斜杠不再被转义
  （剩下的「没有公式渲染」是**功能**缺口，不是保真缺口，已在 EXPECT 里写明）。
- 新增 `nested-styles.md` 记录一个**结构性**缺口：标记模型是扁平的（`mdStyle` 只带一个 style 值），
  「粗体里套行内代码/链接」表达不出来。修法（给 `mdStyle` 支持样式集合）属独立一波。

#### 五、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（110/110 单测） |
| `node tools/run-suites.js` | **8/8 套件 PASS** |
| `tools/_verify-md-fidelity.js` | **67 PASS / 0 FAIL / 17 SKIP**（31 份夹具；exact 9 / normalized 14 / lossy 8） |

---

### 4.58 Wave 2 尾巴：多窗口元数据一致性与历史保留策略可配（本次）

> Wave 2 当时留了两条尾巴：两个窗口打开同一文件时元数据可能各说各话；本地历史的保留策略写死在代码里。

#### 一、编码优先级：显式指定 > 每文件记录 > 全局默认

原来的 `file:read` 只有「设置里是 `auto`」时才查每文件记录，于是：

- 用户把**全局默认编码**改成 windows-1252 之后，之前明确按 GBK 打开过的文件会被解成乱码；
- 两个窗口如果「默认编码」设置不同（比如一个窗口刚改过），**同一个文件会解出不同内容** ——
  这就是「多窗口元数据不一致」的实际表现。

新优先级（`file:read` 增加 `opts.softDefault`）：

| 来源 | 何时生效 | 为什么 |
| --- | --- | --- |
| **显式指定**（`reopenWithEncoding`、显式 readAs） | 永远优先 | 用户刚点的那个必须听，否则「点了没反应」 |
| **该文件的记录**（`documents.encoding`，兼容 kv 兜底） | 调用方说「这只是设置里的默认值」时（`softDefault: true`） | 它是「这个文件是什么编码」的权威答案，比全局默认更具体 |
| **自动判定链**（BOM → 记忆 → 严格 UTF-8 → 语言兜底） | 没有记录、也没显式指定 | 兜底 |

实测（`_verify-md-fidelity.js` F 段）：窗口 A 用 auto 打开 GBK 文件并落库 → 窗口 B 打开同一文件，
**编码与行尾都与库记录一致**；窗口 B 把「默认编码」改成 windows-1252 后重开，**每文件记录仍然优先**。

**套件侧的两处修正**（新语义下必须显式管理状态）：

1. `_verify-encoding.js` 的「默认编码生效」拆成两条：先证明**记录优先**（同一份字节在默认编码改成 1252 后
   仍按 gbk 解出），再删掉记录、证明**没有记录时设置里的默认编码确实生效**；
2. A2 段的两次**显式试读**（windows-1252 / utf-8）会把该文件的记录改掉，而 C 段依赖它被当成 BOM 文件 ——
   所以还原夹具字节的同时也要 `rememberEncoding(…, 'utf-8-bom')` 把记录调回来。

#### 二、本地历史的保留策略进设置

新增三个设置项（默认开、30 条 / 30 天，常量仍以 `shared/history.ts` 为准）：

- `historyEnabled`：关掉后 `pushHistory` 直接返回，不再新增快照（**已有历史仍可查看/回滚**）；
- `historyLimitPerFile` / `historyMaxAgeDays`：主进程在写快照与抽稀时从 kv settings 读，喂给
  `planHistoryPrune`（纯函数，参数化后仍可单测）。

设置面板「通用」页新增一组（开关 + 两档下拉），三语同步（388 键）。实测（同一个套件 G 段）：
关掉后连存两次**不再写快照**；上限设为 2 后连存 4 次**恰好剩 2 条**（且是最新的两条）。

#### 三、顺带修掉的一处配置债

`tsconfig.node.json` 也开 `allowImportingTsExtensions`：`shared/defaults.ts` 现在会被单测直接加载
（断言默认策略与常量一致），它的相对导入按 §4.56 的约定写显式 `.ts` ——
而它同时属于 node 工程，两边都得开这个开关。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**111/111** 单测） |
| `node tools/run-suites.js` | **8/8 套件 PASS**（encoding 34/34、wave3 19/19…） |
| `tools/_verify-md-fidelity.js` | **73 PASS / 0 FAIL / 17 SKIP**（90 条断言；新增元数据 4 条 + 历史策略 2 条） |

#### 五、还剩什么（下一轮）

1. **Wave 3.2**：三处真相源（WYSIWYG / 源码 textarea / 代码块 CM）收敛成单向数据流。
2. **嵌套样式**（§4.57 记录的结构缺口）：让 `mdStyle` 支持样式集合。
3. **老套件迁移**：约 40 个仍按 `Symbol(pinia)` 取 store（生产构建下会失败），「改到谁就顺手迁谁」。

### 4.59 Wave 3.2：编辑面 ⇄ 真源的**单向数据流账本**（本次）

> 这一节回答一个问题：**正文有三个能改它的地方（Tiptap 面板 / 源码 textarea / 代码块里的
> CodeMirror），凭什么保证它们不会互相打架？**
> 之前的答案是「每个编辑面各自发明一套判断要不要跟着更新的规则」，于是有了四条通道、
> 三种启发式，和一批看着像玄学的 bug。现在的答案是一个**世代号 + 一个作者标记**。

#### 一、收敛之前：四套判断，三种启发式

| 通道 | 收敛前的判断 | 曾经的漏判形态 |
| --- | --- | --- |
| Tiptap ⇄ store | 比字符串 `syncedMd === content` + 世代号 `files.syncEpoch` | 「切回原编码」时新旧文本恰好相等 → 状态栏变了、正文不动 |
| 源码 textarea → Tiptap | **另一条** 200ms `setContent` 定时器（`scheduleSplitSync`） | 分屏里停顿一下的更新被静默窗吞掉 |
| 切模式时再对齐一次 | `syncEditorContent()` 自己再比一次字符串 | 三处判断对同一件事给出不同结论 |
| 代码块 CodeMirror | 150ms 防抖 + 「节点文本快照相等就跳过」 | 快照过期（CM 已经又往前跑了几行）→ 用旧文本重建 CM，**快速回车丢字** |

根因不是某一条写错了，而是**没有唯一的写入者身份**：每个面都在猜「这次变化是不是我自己弄出来的」。

#### 二、收敛之后：账本（`src/renderer/src/lib/contentSync.ts`）

```
{ rev, author, applied: { wysiwyg, codeblock } }
```

- 谁改内容谁调 `files.setContent(md, author)`：`rev+1`、记下 `author`；
- 需要**命令式回灌**的编辑面（渲染动作是 `setContent` / `setState`）记下自己渲染到哪一代；
- 该编辑面要不要重渲染 ⇔ `files.contentIsStale(surface)`（= 它的 `applied` 落后于 `rev`），
  渲染完 `files.markContentApplied(surface)`。**不比较字符串、不看时间窗。**

三条推论，正好覆盖了上面每个漏判形态：

1. **自己的回声永不回灌自己**：`write()` 顺手把作者的 `applied` 推到最新，所以「刚打完字就
   触发替换」这类时序问题在结构上不存在（A2 断言：输入后内容与光标都不动）；
2. **文本恰好相等也要换内容**：整篇替换（打开文件 / 恢复草稿 / 切编码 / 载入历史）作者记为
   `external`，它**不动任何 applied** ⇒ 所有编辑面都落后 ⇒ 都按新内容重渲染一次（A6 断言）；
3. **嵌套编辑面**：代码块的 CodeMirror 是 Tiptap 文档里的**子编辑面**，它写内容时先把文本写回
   Tiptap 节点，所以 `write(codeblock)` 会**连宿主 `wysiwyg` 一起**标记为最新 —— 否则宿主会把
   md 重新灌回去，把光标从代码块里踢出来（A5 断言）。

**一个必须记住的坑：回灌时读 store，不要读 `props`。** Vue 的 `watch` 默认跑在渲染之前
（pre-flush），而 `props.modelValue` 是父组件**上一次渲染**时传下来的 —— 在 watcher 里读 props
会拿到上一代内容，等于把编辑器灌成旧文本。这不是「偶尔有点旧」那么轻：编辑器里那次 `setContent`
会触发 md 标记归一化插件再产生一次事务 → `onUpdate` → 250ms 防抖 flush 把旧文本写回 store，
**源码面刚敲的那行就没了**（正是本轮实测抓到的那次偶发失败：`_verify-wave3.js` A4 在整轮矩阵里红、
单跑绿）。修法是本节的立场本身 —— 真源只有一个，就直接读它：
`files.current?.content`（代码块那侧同理，`props.node.textContent` 换成按 pos 现读 PM 文档）。

#### 三、四个编辑面各自的角色

| 编辑面 | 角色 | 实现要点 |
| --- | --- | --- |
| Tiptap 面板 | 命令式副本 | `watch(files.contentRev)` → `contentIsStale('wysiwyg')` 才 `setContent`；分屏下源码面逐键输入时 **200ms 合并重解析（渲染节流，不是第二条真源）** |
| 源码 textarea | 声明式副本 | 模板 `:value="files.current?.content"` 就是唯一回灌通道：DOM 值已等于新值时浏览器不动光标，所以「自己写的」那条路径不需要代码再判断一次 |
| 代码块 CodeMirror | 子编辑面（写 + 读） | 写：`editorStore.noteWrite('codeblock')` 挂牌，序列化时消费成作者；读：节点文本变了才重建，且**触发时重新读节点文本**、**CM 拿着光标时绝不覆盖**（改成再等一轮） |
| 外部整篇替换 | 作者 = `external` | 打开/草稿/切编码/载入历史统一走 `setContent(..., 'external')` / `noteExternalReplace()` |

`files.syncEpoch` 与 `editorStore.syncedMd` 一并删除：前者就是账本的 `rev`（且账本还知道是谁写的），
后者是字符串版本的 `applied.wysiwyg`。`docs/optimization-program.md` 里 Wave 3.2 的那条待办到此收口。

#### 四、老套件迁移：不再按 `Symbol(pinia)` 的名字取 store

`tools/` 下 50+ 个 CDP 套件原本靠 `Object.getOwnPropertySymbols(provides).find((s) => String(s) === 'Symbol(pinia)')`
取 store —— 生产构建会把 symbol 描述压掉，于是**同一套件的行为取决于实例是 dev 还是构建产物**（最坑的一类漂移）。

本轮把 77 个套件统一改成**按结构认 pinia**（`prov[s]` 是对象且 `_s instanceof Map`），并把
`t.url.includes('5173')` 换成 `index\.html|5173`。A/B 实测（对着 `out/` 构建产物的隔离实例）：

| | 迁移前（HEAD 版本） | 迁移后 |
| --- | --- | --- |
| 19 个「只按 symbol 名字找、没有结构兜底」的套件 | **13 个直接崩**：`TypeError: Cannot read properties of null (reading '_s')` | **0 个崩** |
| 其中端到端跑通（exit 0 且有真实输出） | 4 个 | 7 个 |

剩下的差异都不是 pinia 的问题：`_regress-*` 那几个用的是早已改名的旧选择器（`.mode-seg-btn`，
现在是 `.seg-btn` / `role="tab"`），`_test-export-full.js` 需要 5173 上的 dev server。
`tools/_regress-split-live.js` 顺手迁到 `tools/lib/harness.js` 并修好选择器，现在进默认矩阵
（它盯的正是本节的账本：分屏双向同步 + 切换文件 + 每次输入后账本必须收敛）。

#### 五、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**120/120** 单测，新增 `tests/contentSync.test.mjs` 9 条） |
| `npx eslint .` | 0 error / 0 warning |
| `node tools/run-suites.js` | **9/9 套件 PASS**（新增 `_regress-split-live` 8 条：模式切换 / 右→左 / 左→右 / 账本收敛 / 切文件） |
| `tools/_verify-wave3.js` | A 段 9 条（含账本作者、落后判定、代码块作者标记）|

#### 六、还剩什么（下一轮）

1. **嵌套样式**（§4.57 记录的结构缺口）：让 `mdStyle` 支持样式集合。
2. **其余老套件**：`_regress-*` / `_repro-*` 还有十来个用着旧选择器，按「改到谁就顺手迁谁」继续收；
   迁移时一律 `require('./lib/harness')` + `Reporter`（有 `--- N/M PASS` 才能进矩阵）。
3. **`files` store 继续瘦身**：内容/编码相关的动作已可独立，下一步把「最近文档/置顶」整块移出。

#### 七、附：一次真实事故的恢复办法（值得记下来）

本轮施工中真的把 `src/renderer/src/stores/files.ts`（647 行）毁过一次：用
`(Get-Content -Raw) -replace … | Set-Content -Encoding UTF8` 改一处字面量，先被 ANSI 码页
（GBK）解码、再按 UTF-8 写回 —— 文件当场变成乱码，而且那次解码是**有损**的（约 180 处字节丢失，
`?`/`U+FFFD` 占位，个别换行被吃掉）。当时该文件有大量**未提交**改动，`git checkout` 等于丢掉两波成果。

救回来的三条线索，按可靠性从高到低：

1. **会话转录（最权威）**：DSH 的会话记录落在 `~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd`
   （**多帧 zstd**：Node 的 `zstdDecompressSync` 只吃第一帧，要按 `28 B5 2F FD` 魔数切片逐帧解）。
   里面按顺序存着每一次 `write` / `edit` 的**完整 payload** —— 拿 HEAD 版本当基线，把这一串
   `old_string → new_string` 按序重放，就能重建出事故前的文件（脚本化的字面量替换可放在 VM 沙箱里
   跑，只改内存里的字符串，不碰磁盘）。
2. **反解编码（结构完整、局部损坏）**：`iconv.decode(iconv.encode(损坏文本, 'gbk'), 'utf8')`
   能把大部分还原回来（GBK 那一步没丢的字节都在）。剩下的 `U+FFFD` 用「上下文窗口 + 上面那份重放文本」
   当字典逐个补 —— 注意上下文要**在相邻损坏点处切断**，否则窗口里带着 `U+FFFD`，在干净字典里永远搜不到。
3. **转录里的 `read` 结果**：本会话读过的每一段文件内容都在转录里（带行号），是逐字权威的局部证据。

最后用三件事交叉验证：行数对得上（事故前 609 行 + 本轮 4 处改动 = 648 行）、
`npm run typecheck` 与 `npx eslint` 全绿、单测与套件矩阵全绿。**教训**：批量改源码一律用 Node 脚本
（见 README 开发约定第 7 条），别让 PowerShell 碰源码字符串。

### 4.60 Wave 1 收尾（一）：嵌套样式与 YAML front matter（本次）

> Wave 1 留下的 8 个 `lossy` 缺口里，最伤内容的两个：**嵌套样式**（`**粗体里的 `代码`**`
> 会被写成 `**粗体里的 **`代码`** …**` 这种 CommonMark 下根本不成立的孤儿标记，渲染直接坏掉）
> 和 **YAML front matter**（被解析成「分割线 + 段落 + 分割线」，元数据静默变成正文）。
> 本节记这两个的改法与验收。

#### 一、嵌套样式：`mdStyle` 的样式从「一个值」改成「一个集合」

**原来为什么表达不出来**：`mdStyle` 只有一个 `style` 属性，而 ProseMirror 里**同一种 mark 只能挂一个**。
`**粗体里的 `行内代码`**` 要求那段代码同时是粗体与代码 —— 一个属性存不下两个样式，于是：

1. 解析时行内代码的遗留 mark `code` 带 `excludes: '_'`（**排斥一切其它 mark**），把外层的 bold 直接丢掉了
   （所以那段代码在模型里从来就不是粗体）；
2. 归一化物化标记时按「单个样式各补一对」，外层构造在内层之前被合上 →
   `**粗体里的 **`行内代码`** 应该整段加粗**`，其中 `**粗体里的 **` 在 CommonMark 里前面的
   `**` 无法闭合（闭合定界符右边必须是标点/非空白），**整段渲染成字面星号**。

**改法**（三处，都很小）：

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 样式集合 | `MdStyle.attrs.styles: StyleKind[]` | 按固定顺序 `bold → strike → italic → code` 规范化（`styleList()`），顺序固定才能保证「同一份文档每次解析/序列化得到同一串标记」（幂等是套件硬门槛） |
| DOM 呈现 | `MdStyle.renderHTML` | 只出一个元素：标签取集合里最外那个样式（`strong`/`s`/`em`/`code`），全部样式写进 `data-md-styles="bold code"`，其余样式的外观由 CSS 属性选择器补齐。**不能**渲染成嵌套的 `<strong><code>` —— DOM 回读时同类型 mark 后者会顶掉前者，样式丢失并触发回写 churn |
| 标记物化 | `normalizeAtoms` + 新的 `materializeStyledRun()` | 按**样式栈**开关：相邻两段取样式集合的公共前缀保持不动，只开关差集 → 标记天然嵌套。单一样式时它退化成原来的「两边各一对」，所以既有行为不变 |
| 放开互斥 | `CodeQuiet.extend({ excludes: '' })` | 上行默认 `excludes: '_'` 让行内代码排斥一切 mark，嵌套样式在**解析那一刻**就少一半 |

顺带把「按标记配对找构造」的那段扫描改成**深度计数**（`start` +1 / `end` -1），否则外层 `**` 会在
遇到内层的 `` ` `` 时以为「缺 end」而补一个 `**`，把构造劈成两半 —— 这正是旧的扁平物化写法。

**验收**：夹具 `nested-styles.md` 从 `lossy` 升到 **exact**（原文与往返逐字节相同，且幂等）；
`emphasis.md` 里的 `***粗斜体***、**加粗里的 *斜体* 嵌套**` 也回到 exact。端到端断言见
`_verify-md-fidelity.js` 的 A/B 矩阵与幂等段。

#### 二、YAML front matter：做成文档开头的**真实节点**

**为什么不做成「编辑器外面的一个小字符串」**：§4.59 刚把「正文只有一个真源」收敛干净。
front matter 存在组件 ref 或 store 单独字段里就又出现两处表示 —— 而源码模式 textarea 里它明明就在正文里。
做成节点后**文档文本 = 节点序列化结果**，一行不多一行不少，WYSIWYG 里也看得见这段 YAML。

**判定（保守优先，`src/shared/frontmatter.ts`，纯函数有 11 条单测）**：

1. 必须从文档**第一个字符**开始；
2. 收尾分隔符是独立的 `---` 或 `...` 行；
3. 块内至少有一行顶层 `key:` —— 这条是**排除**用的：CommonMark 里 `---\n一段文字\n---`
   （分割线夹文字）合法且常见，没有键值就不能当 YAML 吃掉。

**往返三段**（与 `MdEscape` 同一套 `parse.setup` 机制）：markdown-it **block 规则**只在第 0 行认领
（`state.line` 直接跳到块后首行）→ 推自定义 token → 渲染成 `<pre data-md-frontmatter>原文</pre>`
→ `Frontmatter` 节点的 `parseHTML` 认领它、`storage.markdown.serialize` 把原文**逐字写回**。

**取舍**（都写进代码注释，免得以后当 bug 报）：

- 节点是 `atom`：WYSIWYG 里**只读**，改 YAML 走源码模式（做成可编辑需要一整套 YAML 编辑器，那是功能不是保真）；
- 只能待在文档开头：用户把它拖到中间后再序列化就不再是 front matter（解析规则同样只认开头，语义一致，
  不会出现「看着还在、保存后跑进正文」的错位）。

**验收**：夹具 `frontmatter.md` 升到 **exact**；套件新增 H 段 4 条端到端断言 ——
① 首节点是 `frontmatter` 且 WYSIWYG 里渲染出同样的 YAML；② 在正文末尾敲字后 YAML 逐字不变；
③ 源码模式里 YAML 就是正文开头（改它的入口通）；④ 分割线夹文字**不**被误判成 front matter。

#### 三、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**131/131** 单测：新增 `tests/frontmatter.test.mjs` 11 条） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **81 PASS / 0 FAIL / 13 SKIP**（94 条断言；Wave 1 缺口从 8 个减到 6 个） |
| `node tools/run-suites.js` | 见下一节（矩阵全绿） |

**还剩什么**：`table`（列对齐 + 单元格转义竖线）、`html-inline`、`task-lists-ordered`、
`lists-adjacent-ordered`、`images-inline`、`images-linked` 六个缺口，按内容损坏严重度继续收（下一轮）。

### 4.61 Wave 1 收尾（二）：表格、行内 HTML、列表编号（本次）

> 接 §4.60，本轮把剩下 6 个缺口里的 4 个收掉（表格 / 行内 HTML / 有序任务列表 / 相邻有序列表），
> 只剩两个图片缺口。这一节记的是「为什么这些看起来简单的改法其实各有坑」。

#### 一、表格：解析侧本来就对，坏的是写回

先把事实查清楚再动手（这一步很值）：markdown-it 会把列对齐写成单元格的
`style="text-align:center"`，`@tiptap/extension-table` 的 `align` 属性认领它；
单元格里的 `\|` 也被正确解成**字面竖线**。所以 `align` **本来就存得下**，
丢信息的是 tiptap-markdown 内置的表格序列化器：

- 分隔行永远写裸 `---` → 列对齐丢失；
- 单元格内容不转义 → 内容里的 `|` 被当成列分隔符，**整行结构被拆坏**
  （`| 转义 \| 竖线 |  |  |` 重新解析成 4 列）。

改法就是接管 `table` 节点的 markdown 序列化（`lib/editor/tableMarkdown.ts`）：
分隔行按各列表头的 `align` 生成（`:---` / `:---:` / `---:`），单元格先渲染进输出缓冲再把竖线转义
（逐字符写没法插转义）。复杂表格（合并单元格、一格多块）仍退回 HTML —— 那是 Markdown
表格语法表达不了的东西，硬拼成管道表才是真的丢结构。纯文本规则抽在 `tableAlign.ts`，
6 条单测（含「已经是 `\|` 的不重复加反斜杠」这种幂等性）。

#### 二、行内 / 块级 HTML：原文进模型，WYSIWYG 按源码显示

Markdown 允许直接嵌 HTML，而 ProseMirror 的 DOMParser **只认识 schema 里有的节点** ——
未知标签一律剥掉只剩文字：`<kbd>Ctrl</kbd>` → `Ctrl`、注释整条消失、`<br>` 还被写成 `\`
（语义从「HTML 换行」变成「Markdown 硬换行」）。

解法与 `MdEscape`、front matter 同一套：在 markdown-it 那一层认领（`lib/editor/htmlPassthrough.ts`）：

| 形态 | 进模型 | 写回 |
| --- | --- | --- |
| 行内（`html_inline` token） | `<span data-md-html>` → `MdHtml` mark（open/close 空 + `escape:false`） | 逐字写回 |
| 块级（`html_block` token） | `<pre data-md-htmlblock>` → `HtmlBlock` 原子节点 | 原样写回 |

**两个踩到的坑**（都写进代码注释了）：

1. **任务列表的复选框**是 `markdown-it-task-lists` 插件**生成**的 `html_inline` token
   （`<input class="task-list-item-checkbox" …>`），不是用户写的 HTML。若一并「原样保留」，
   任务列表会变成一堆标签文本 —— `task-lists.md` 直接从 exact 掉到 lossy。所以按插件写死的
   class 名放行这类 token。
2. **不透明内容不能切开样式构造**：`**加粗里的 <kbd>Ctrl</kbd> 还是加粗**` 里，
   行内 HTML 在原子模型里是「不透明内容」，一开始会把它当边界、把加粗构造劈成两半。
   改成：样式栈物化时把不透明内容**原样穿过**（不参与栈、也不打断外层构造）。

WYSIWYG 里行内 HTML **按源码显示**（淡色等宽）：把任意 HTML 真渲染出来是另一个功能
（要沙箱、要样式隔离），而「把标签吃掉」是静默丢内容 —— 两害相权取保真。

#### 三、列表：有序任务列表 + 相邻有序列表

- **有序任务列表**（`1. [ ] x`）：`taskList` 新增 `ordered` 属性（解析时按 `<ol>`/`<ul>` 标签记住，
  序列化时有序写 `1. `/`2. `）。上游的任务列表序列化器直接复用无序列表那份、永远写 `- `，
  于是列表**类型**从有序变无序（渲染从数字变圆点）。只覆盖 `serialize`、不动
  tiptap-markdown 默认 spec 里的 `parse.setup`/`updateDOM`（否则任务列表整体失效）。
- **相邻有序列表**（`1./2./3.` + 空行 + `5./6.`）：这一条**不是缺陷**，是 CommonMark 语义 ——
  空行不结束有序列表，它和后面是**同一个**松散列表，渲染序号由位置决定。所以正确的处理是
  给判级器加一条规范化规则（19）：编号按位置重算（**首项**编号保留，那是 `<ol start>`，有语义），
  同一个列表里项与项之间的空行不参与比对（松散是整表属性，源码位置保留不下来）。
  - 规则必须**幂等**：`1) a` 与 `2. b` 的空行判断若区分分隔符，第一遍是两个列表、第二遍
    两边都是 `.` 又成一个列表 —— 判级结果随遍数漂移。所以有序列表的分隔符在这条规则里不区分
    （规则 7 本来就会把 `)` 归一为 `.`）。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **94 PASS / 0 FAIL / 5 SKIP**（99 条断言） |
| `node tools/run-suites.js` | 见矩阵（全绿） |
| 夹具分级 | exact **13** / normalized **16** / lossy **2**（四轮累计：8 → 6 → 4 → 2） |

#### 五、还剩什么（下一轮）

只剩两个**图片**缺口，它们要动的是同一个结构决策：图片目前是**块级节点**（`inline: false`）。

1. `images-inline.md`：段落中间的图片被拆成独立块，前后文字被切成两段；
2. `images-linked.md`：`[![alt](img)](url)` 的**外层链接**丢失（块级节点上挂不了 link mark）。

计划（下一轮）：把图片改成**内联节点**（或按上下文双形态），并复跑 `images.md`（当前 exact）、
`_verify-local-media.js`（本地媒体白名单）与字节级用例，确认块级写法（独立成段的图片）仍然逐字节一致。

### 4.62 Wave 1 收尾（三）：图片改成行内节点 —— Wave 1 缺口清零

> 最后两个缺口（`images-inline.md` / `images-linked.md`）其实是**同一个结构决策**造成的：
> 图片被配成**块级节点**。Markdown 的 `![alt](src)` 本来就是**行内语法** —— 它能出现在段落中间
> （`图标 ![](a.png) 后面还有字`），也能被链接包住（`[![alt](a.png)](url)`）。
> 做成块级节点时这两种写法都表达不出来：段落被拆成「文字 / 图片 / 文字」三段；
> 外层链接因为块节点上挂不了 mark 而**整个丢掉**。

**改法**：`Image.configure({ inline: true })`。三处配套调整：

| 位置 | 调整 | 为什么 |
| --- | --- | --- |
| `extensions.ts` | 删掉自定义的块级 markdown 序列化器（原来补了 `closeBlock`） | 那个序列化器是为了解决「块级图片黏成一行 / 吞掉下一个标题」；行内之后图片在段落里，段落自己负责换行，直接用 tiptap-markdown 的默认实现（prosemirror-markdown 的 image 规则：alt 转义、src 括号转义、title 引号） |
| `style.css` | `img` 默认 `display: inline-block` + `vertical-align: middle`；`p > img:only-child` 才 `display: block; margin: .4em auto` | 「独立成段的图片」观感与改之前**完全一致**（居中、独占一行），而段落中间的图片不再把段落拆开 |
| `style.css` | 删掉文件后部**重复的一份** `.md-preview img` 规则 | 它位置更靠后、会覆盖上面的行内排版（重复定义本来就是个隐患） |

**验收**（三个图片夹具全部 `exact` 且幂等，Wave 1 的 8 个缺口清零）：

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **100 PASS / 0 FAIL / 1 SKIP**（101 条断言；唯一 SKIP 是文档化的字节级行为「保存补文末换行」） |
| `node tools/run-suites.js` | 9/9 套件 PASS |
| 夹具分级 | exact **15** / normalized **16** / lossy **0**（四轮累计 lossy：8 → 6 → 4 → 2 → **0**） |

新增 M 段 2 条端到端断言：段落中间的图片与文字仍在**同一个**段落里；`[![…](…)](url)`
的两个图片都带着 link mark（外层链接没丢）。

### 4.63 工程化收尾（二）：`recent` store 拆分 + 嵌套样式渲染断言（本次）

#### 一、最近文档 / 置顶 / 最近文件夹：从 `files` store 拆出来

**为什么拆**：这份数据的归属是「**用户开过什么**」，与「当前工作区 / 当前文档」是两件事 ——
关掉所有文档、切换工作区、甚至工作区打不开时，这份历史都还在。挂在 `files` 上时它既管文档生命周期
又管历史列表（评审报告 Wave 5 那条「store 拆分」），`files.ts` 一度到 646 行。

**边界**（这是这次拆分的关键取舍）：

| 归属 | 放哪 | 理由 |
| --- | --- | --- |
| 「列表怎么变」（去重、置顶优先、截断、并入当前工作区） | `lib/recent.ts` 纯函数（**已有单测**） | 规则易测、无状态 |
| 「把结果落盘 + 给 UI 排好序的视图」 | 新 `stores/recent.ts` | 只做这两件事，94 行 |
| 数据本身 | 仍在 `settings`（SQLite kv） | **键名不变 ⇒ 升级不需要迁移**，既有套件（`_verify-session` 等断言 `settings.recentFiles`）也不用改 |

两个设计细节：

- `folders(root)` 只接一个参数而**不反过来 import `files` store** —— 需要工作区根目录的地方
  由调用方传进来（`RecentList` 里就是 `recent.folderList(files.root)`）。两个 store 互相引用
  在这类代码里很容易变成循环 import；
- 置顶判断给的是 **`pinnedPaths: Set<string>`** 而不是数组：列表每行都要问「这个置没置顶」，
  数组 `includes` 是 O(n)，模板里按行调用就是 O(n²)。

`files.ts` 646 → 593 行，调用点只有三处（打开文件夹、打开文件、另存为）改成 `useRecentStore()`。

#### 二、嵌套样式的**渲染**也要有断言（不只是序列化）

上一轮把行内代码的 `excludes` 放开之后，「粗体里的行内代码」这段文本的渲染变成：
**一个** `<strong data-md-styles="bold code">` + CSS 的 `[data-md-styles~='code']` 规则。
这里有个容易被忽略的盲区：**CSS 规则漏了的话，序列化仍然「保真」（往返字节不变），
但用户看到的那段代码不再像代码** —— 保真套件量不到观感。

所以补一条计算样式断言（`_verify-md-fidelity.js` 的 N 段）：加载 `nested-styles.md`，
取 `[data-md-styles~="code"]`，断言 ① 标签是 `strong`（集合里最外的样式决定标签）、
② `data-md-styles` 正好是 `bold code`、③ 计算 `font-weight ≥ 700`（粗体生效）、
④ 计算 `font-family` 命中等宽字体（代码外观生效）。四者缺一都会红。

顺带复核上一轮列出的两处遗留：`.md-preview img` 规则现在只有**一份**（重复的那份已删，
它位置更靠后、会覆盖行内排版）；主题**没有独立 CSS 文件**（明/暗/羊皮纸都是 `style.css` 里的
CSS 变量），所以不存在「另一份主题文件也要同步属性选择器」的问题。

#### 三、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **101 PASS / 0 FAIL / 1 SKIP**（102 条断言） |
| `node tools/run-suites.js` | **9/9 套件 PASS**（`_verify-session` 仍绿 ⇒ recentFiles 数据键未变） |


