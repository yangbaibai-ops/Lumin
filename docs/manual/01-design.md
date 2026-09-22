<!-- 本文件由 docs/typora-wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

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
│  │    └─ （原「自绘选区气泡菜单」已在第 25 轮移除，见 §3.8）        │
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
