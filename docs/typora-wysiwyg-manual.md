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
- **谁清槽位**：窗口被**单独关闭**时，主进程在 `closed` 里清掉它的槽位（下次启动不会把用户已关掉的窗口又拉回来）；**整体退出**（`before-quit`）则保留。渲染层只管写。
- **写入时机**：文档切换、光标移动（`ui.cursor`）、滚动（window 捕获阶段，容器重建也无需重绑）→ **800ms 节流**写一行 kv；关键路径补刀：关窗前（`app:before-close` 里 flush）、`pagehide`、切到后台。
- **开关**：设置 → 通用 →「启动时恢复上次会话」（`restoreSession`，默认开）。关掉后启动直接进编辑器（空白未命名缓冲区）——注意语义：会话记录的是**当前状态**，关着的时候该窗口的会话就被写成「无文档」，这与主流行为一致。
- **降级**：恢复的文档已不存在（被移动/删除）→ 通知中心告警一条，不阻断启动；未命名缓冲区不进会话（其内容本就由草稿机制保护，避免两套恢复逻辑打架）。

验收：`tools/_verify-session.js`（真实 reload 触发完整启动流程 + 直读 SQLite）：槽位分配、路径/光标/滚动落盘、reload 后三者精确恢复、开关两向、文件丢失告警、单独关窗清槽位；另做了**真·杀进程重启**复核（窗口数、文档、光标 1168/保存值 1166、滚动 0.5 全部对上）。

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
- **生命周期**：通知随窗口存在。窗口被**单独关闭**（非整体退出）时，除了清会话槽位，同时 `deleteNotificationsByScope` 清掉它的通知；新窗口领到槽位时（`claimFreshSlot()`）也先清一遍该作用域——槽位被复用时不会把上一任窗口的提示带给新窗口。整体退出（`before-quit`）保留，交给下次启动按槽位恢复到同一个窗口。
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
- **派发**：一个 window 捕获阶段的 `keydown`；只处理带修饰键的组合（纯字母键留给编辑器/输入框）；`when: 'notInInput'` 的命令在输入框里让行（Ctrl+F）；**录制期间整体让行**（否则「录 Ctrl+N」会真的新建文档）。
- **原生菜单不再自带 accelerator**（`src/main/menu.ts`）：否则用户改了键，原生那份照旧触发——两套真相 + 重复触发。菜单项保留（系统级可访问性），应用内快捷键统一由渲染层接管。

**默认键一览**（26 条，分 6 组；「导出」单独成组）：

| 分组 | 命令 | 默认键 |
|---|---|---|
| 文件 | 新建文档 / 新建窗口 / 打开… / 打开文件夹… / 保存 / 另存为… | `Ctrl+N` / `Ctrl+Shift+N` / `Ctrl+O` / `Ctrl+Shift+O` / `Ctrl+S` / `Ctrl+Shift+S` |
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

**验收**：`tools/_verify-keymap.js` **31/31**（隔离实例；含页面内的按键投递探针）：命令表 26 条且标题/分组 i18n 全部有值、默认键 `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Mod→Ctrl` 规范化、无重复默认键；默认键真的生效（`Ctrl+/` 切模式、`Ctrl+Shift+B` 侧栏、`Ctrl+Shift+P` 全局搜索）；`Ctrl+N` **只创建一份**（原生菜单已无 accelerator）；自定义后新键生效且旧键失效、用户绑定优先于默认绑定、冲突可见、解绑后按键无反应、恢复默认后默认键回来；**`Ctrl+Tab` / `Ctrl+Shift+Tab` 真的切换窗口**（focus/blur 事件流判定，含反向与自定义键）；设置界面 26 行 / 7 分组 / 45 个键位胶囊 / 搜索过滤 / 进入录制 / **录制期间按 Ctrl+N 不新建文档** / 录制写入生效；直读 SQLite 证明改键落库，reload 后解析结果仍是自定义键。回归：`_verify-editor-menu.js` 51/51、`_verify-open-file-routing.js` 22/22、`_verify-open-file-dedup.js` 21/21、`_verify-session.js` 16/16、`_verify-menu-export-submenu.js` 15/15、`_verify-window-title.js` 14/14、`_verify-bars-no-filename.js` 12/12、`_verify-welcome-removed.js` 32 项通过（另 2 项为既有的隔离实例环境跳过）、`_verify-alt-menu.js`（Alt+F 仍由应用内菜单接管）；`npm run build`（含双工程 typecheck）0 error。

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

- **`appId()`**：打包态 `com.lumin.app`（与安装器一致），开发态 `com.lumin.app.dev`（加后缀，避免和装好的版本互相顶掉快捷方式）。`src/main/index.ts` 里改成 `app.setAppUserModelId(taskbar.appId())`，并且**在建窗口之前**设置。
- **`ensureAppShortcut()`**：用 `shell.writeShortcutLink(path, 'create', {...})` 在开始菜单（`%APPDATA%\...\Start Menu\Programs\Lumin (dev).lnk`）写一条带 `target`（electron.exe / Lumin.exe）、`args`（开发态含**应用目录** + `--lumin-new-window`）、`appUserModelId`、`description` 的快捷方式；每次启动刷新一遍（幂等）。有了它：菜单第一项显示 **Lumin (dev)**，点它就是「electron.exe + 应用目录」→ **新的 Lumin 窗口**；用户「固定到任务栏」时，Windows 按 AUMID 复制这条快捷方式，**参数一起固定**。
- **Tasks 那条改名「新建窗口」**（按语言本地化）：它和「应用名」那条不再重名，各司其职（前者是显式动作，后者是 Windows 的启动项）。
- **最近文档**：custom 分类（分类名跟随界面语言），每条的 program/args 同样显式指向本应用。**故意不用 `app.addRecentDocument()`**：那个把点击交给**文件关联**，开发态 electron.exe 没有 `.md` 关联，用户点「最近」反而会叫起别的程序（机器上装了 Typora 就开 Typora）。
- **主进程解析这些开关**（`parseLaunchIntent`，冷启动与第二实例两条路都认）：
  - 运行中的实例收到 `--lumin-new-window` → 开干净新窗口（与「文件 → 新建窗口」同一路径，带 `--lumin-no-workspace`）；
  - 收到 `--lumin-open=<file>` → **先查这篇是否已在别的窗口开着**，是则把那窗口唤到前面（沿用 §4.28 的「一个文件只开一个窗口」），否则新开窗口打开它；
  - 什么都没有 → 聚焦已有窗口（原行为）。
  - 冷启动带 `--lumin-open` 时**不拉会话恢复**：意图很明确就是开这一篇，否则会先把一堆旧窗口恢复出来再把这篇插进去；槽位数据仍留在 kv，下次正常启动照旧恢复。
- **重建时机**：启动时先写快捷方式、再注册跳转列表；`window:docPath`（文档切换）后节流 1.5s 重建（等这次打开先落库）；换语言或最近列表变化（含界面上「清空最近」）时立即重建。

**验收**：`tools/_verify-taskbar-jumplist.js` **25/25**（隔离实例 + 主进程自检日志 + **真的再起一个进程**）：

- 标识与快捷方式：`shortcut ok=true`，**AUMID = `com.lumin.app.dev` 且不含 electron.exe**（这条直接钉住「名字显示成 Electron」的根因），target 是 electron.exe、args 含应用目录；`shell.readShortcutLink` **回读**校验磁盘上那条快捷方式与写入一致（不是只信我们的意图）；快捷方式文件确实存在于开始菜单；它的 target+args 恰好等于下一条里被验证过能开新窗口的命令。
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
