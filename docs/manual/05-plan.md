<!-- 本文件由 docs/wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

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
- **实现**：`extensions.ts` 按 §1.3 装配：StarterKit（`codeBlock:false`、link 不点击跳转）+ Image + Table 全家 + TaskList/TaskItem + Placeholder + CodeBlockCM + WysiwygInputRules + **MarkdownPaste**（粘贴块级解析/开放 Slice 闭合，§4.12，Markdown 自身 `transformPastedText: false` 让位）+ Markdown 双向转换 + WysiwygMarkers。
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
- **实现**：`inputRules.ts`（任务规则用「重建 + 整体 replace」）+ `keymap.ts`（`WysiwygKeymap`，priority 200：Enter→分割线、Backspace→标题降级）+ StarterKit 内建 keymap。
- **验收**：`heading-input-rule`、`bullet-input-rule`、`task-input-rule`、`task-enter-semantics`（phase B）、`hr-not-immediate`、`hr-enter-rule`、`hr-text-kept`、`heading-backspace-unheading`（phase E）。

### 步骤 6：光标感知标记符（✅）

- **目标**：光标进入块/样式时源码标记淡色浮现，离开即消失。
- **实现**：`markers.ts`（块级 Decoration.node + 行内 PluginView 类管理）+ `style.css` 的 `md-reveal*` 规则。
- **验收**：`heading-marker-hide-on-exit`、`bold-marker-reveal/hide-on-exit`（verify phase B）。

### 步骤 7：代码块 NodeView（✅）

- **目标**：代码块内嵌 CodeMirror 6（高亮/编辑/围栏保持），mermaid 代码块渲染 SVG。
- **实现**：`codeBlock.ts` + `CodeBlockView.vue`；焦点管理两件套（§3.4）。
- **验收**：`codemirror-mounted`、`codemirror-edit`、`cm-fence-kept`、`mermaid-svg`（verify phase A/C）。

### 步骤 8：选区气泡菜单与工具栏（✅ 气泡菜单部分已于第 25 轮移除）

- **目标**：选中文字弹出格式菜单（加粗/斜体/下划线/删除线/行内代码/链接/清除格式）。
- **实现**：`WysiwygEditor.vue` 自绘气泡；定位上下文 rect + 视口钳制 + 滚动跟随（§3.8）。
- **验收**：`bubble-menu-visible`、`bubble-bold-applied`、`bubble-stays-open`（verify phase D）。

### 步骤 9：数据持久化管道（✅）

- **目标**：输入 → 250ms 防抖序列化 → 500ms 防抖写盘 → SQLite 落库；blur/beforeunload 立即 flush。
- **实现**：`WysiwygEditor.vue` 的 `onUpdate` 防抖 + `files` store 写盘 + `unmounting` 守卫（§4.6）。
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
- **实现**：`tools/run-suites.js` + `tools/lib/harness.js`（默认矩阵：CDP 连接隔离实例，`Runtime.evaluate` + `Input.dispatchKeyEvent/insertText` 驱动；单条 `--suite=<文件名>` 可点跑）。
- **验收**：`node tools/run-suites.js` 全绿（PASS/FAIL/FLAKY/SKIP/NOASSERT 五个口径见 §6.2）。

> 历史：这一层最早是 `tools/verify-tiptap.js`（已删除：不在任何矩阵里、换机不可跑；覆盖迁进矩阵后移除，
> 见 §6.2 的历史说明）+ `tools/run-verify.ps1`（user32 置前窗口）。

---
