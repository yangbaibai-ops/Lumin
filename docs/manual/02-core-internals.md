<!-- 本文件由 docs/typora-wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

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
