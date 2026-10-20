<!-- 本文件由 docs/wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

## 3. 关键交互的实现细节

### 3.1 Input Rules：源码标记的即时转换

Input Rule 是 ProseMirror 的正则触发机制：每次文本插入后，用正则匹配光标前的文本，命中就执行一个替换事务。

本项目在 `src/renderer/src/lib/editor/inputRules.ts`（`WysiwygInputRules` 扩展）中注册：

| 输入 | 规则 | 结果 |
|---|---|---|
| `# ` | StarterKit 自带 `textblockTypeInputRule` | 段落 → `heading(level=1)` |
| `- ` | `wrappingInputRule` | 段落 → `bulletList > listItem` |
| `- [ ] ` | 自定义规则（`/^\[([ xX]?)\] $/`） | `bulletList` → `taskList` + 勾选框 |
| `1. ` | `wrappingInputRule` | 段落 → `orderedList` |
| `> ` | `wrappingInputRule` | 段落 → `blockquote` |
| ` ```js ` | StarterKit | `codeBlock(language='js')` |
| `| a | b |` | 表格扩展规则 | 创建 2 列表格 |
| `---` + 回车 | `WysiwygKeymap`（Enter 键绑定） | `horizontalRule`（**回车确认式**，见下） |
| `**加粗**`、`` `代码` `` | 成对标点规则 | 自动应用 mark |

**分割线为什么是「回车确认式」**：Typora 里输入 `---` 并不会立刻变成横线——否则 `---你好` 这类文本根本无法输入。正确语义是：整段内容恰好为 `---`/`***`（可带尾随空格）且光标在段尾时，**按 Enter 才转换**。实现要点：

1. 通过 `StarterKit.configure({ horizontalRule: false })` 关闭 StarterKit 自带的即时输入规则，再独立注册 `HorizontalRule.extend({ addInputRules: () => [] })`——只保留节点与渲染，去掉即时转换（`src/renderer/src/lib/editor/extensions.ts`）；
2. 在 `WysiwygKeymap` 扩展里绑定 Enter：条件为「空选区 + 父块是 paragraph + 光标在段尾 + 文本匹配 `/^(-{3,}|\*{3,})\s*$/`」，满足则用事务把整段替换为 `[horizontalRule, 新空段落]`，光标落在新段落（`src/renderer/src/lib/editor/keymap.ts`）；
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

**标题行首退格（本项目自研语义，`WysiwygKeymap`）**：光标位于标题第一个字前（含空标题）按 Backspace → 整行**取消标题格式**（降级为段落，内容保留），而不是默认的 `joinBackward` 并入上一行——后者正是「按退格跑到上一行、还改变上一行层级」bug 的根源。实现：

```ts
Backspace: ({ editor }) => {
  const { $from, empty } = editor.state.selection
  if (!empty) return false
  if ($from.parent.type.name !== 'heading') return false
  if ($from.parentOffset !== 0) return false
  return editor.chain().focus().setParagraph().run()
}
```

**键盘优先级（关键坑）**：Tiptap v3 把每个扩展的 `addKeyboardShortcuts` 变成独立 keymap 插件，按扩展 `priority`（默认 100）降序执行，先返回 true 的绑定胜出。core 的 Enter/Backspace（`splitBlock`/`joinBackward` 链）默认优先于一般用户扩展，因此自定义键盘语义的扩展必须显式设置 `priority: 200`（`WysiwygKeymap` 即是），否则拦截永远不会生效；条件不匹配时返回 false 交还后续绑定，不影响其他按键行为。

本项目验收矩阵（`tools/_verify-input-rules.js` 的 D 段）覆盖：任务列表回车语义、标题行首退格降级且不影响上一行、分割线回车确认（`---` 不立即转、回车后才转）。

### 3.3 光标感知标记符（源码的「浮现」）

Typora 的招牌细节：光标进入一个块或行内样式时，该处的 Markdown 源码标记以淡色浮现（标题前的 `#`、引用前的 `>`、加粗两端的 `**`），光标离开即消失。实现分两层（`src/renderer/src/lib/editor/markers.ts` + `style.css`）：

**块级**（heading/blockquote/listItem）：

1. `markersPlugin` 用 `Decoration.node` 在选区所在块的 DOM 上挂 `md-reveal` 类（注意：本 PM 版本装饰的 `pos` 必须用 `descendants` 回调给的 0-based `contentPos`，且要传 `parent` 以判断容器）；
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

### 3.8 选区浮动菜单（气泡菜单 · 已移除）

> ⚠️ **本节描述的东西已经在第二十五轮被移除**（组件 77 行 + CSS 40 行一起删除，`WysiwygEditor.vue`
> 里不再有气泡菜单）。原因：它从第二十二轮起就是 `BUBBLE_MENU_ENABLED = false` 的死码（模板
> `v-if` 恒假），却仍在每次选区变化时重算状态；功能与快捷工具栏 + 编辑器右键菜单 **100% 重复**。
> **正文保留，作为「自绘浮动层」的原理与踩坑记录**（坐标系、视口钳制、焦点保持这些结论对今天
> 仍然有效 —— 查找浮条、表格/代码块弹层、右键菜单都在用同一套思路）。

Tiptap v3 官方已无 Vue 版 BubbleMenu 组件，本项目当时自绘（`WysiwygEditor.vue`）。要点：

1. **触发**：`onSelectionUpdate` 中 `selection.empty` 为假时定位显示；
2. **坐标**：`view.coordsAtPos(from/to)` 返回**视口坐标**，减去气泡的**定位上下文**（`.wysiwyg-container`，`position:relative`）的 `getBoundingClientRect()`，得到容器相对坐标；气泡 `absolute + transform: translateX(-50%)` 居中于选区、位于其上方 44px；
3. **坐标系教训**：最初用 `ed.view.dom`（`.ProseMirror`）的 rect 做参考系——它和定位上下文之间隔着 `px-6/pt-10` 内边距，气泡整体偏左 24px；滚动后还漂移。**必须用定位上下文自己的 rect**；
4. **视口钳制**：`coordsAtPos` 在选区滚出可视区时返回视口外坐标。若选区完全离开容器可视范围则隐藏气泡；部分可见时把 top/left 钳制在容器内（`top >= 8`、`left ∈ [8, width-8]`），气泡绝不渲染到窗口外；
5. **滚动跟随**：`onScroll` 里补一次重新定位；
6. **焦点保持**：容器挂 `@mousedown.prevent`，点按钮不抢编辑器焦点、选区不塌缩。

### 3.9 多语言与多主题架构

**多语言（vue-i18n）**：

- 词条按语言分文件（`src/shared/i18n/zh-CN.json` / `en-US.json` / `ru-RU.json`——**第二十五轮从 `src/renderer/src/i18n/locales/` 移到这里**，并改成「静态只留 zh-CN、其余由 `ensureLanguage()` 在切换前拉取」），`createI18n({ legacy: false, fallbackLocale: 'zh-CN' })`——composition API 模式（模板里 `$t()` / 脚本里 `useI18n()`）；
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
- 进出场用 Vue `<Transition>`（浮层 `pop`、模态 `fade/zoom`）；
- 动效全部收敛在 `transition-*` 与 `@media (prefers-reduced-motion: reduce)` 降级之内，减少动效敏感用户的干扰；
- 编辑器内容本身零动画（渲染稳定优先，防抖序列化与布局抖动风险最低）。

**写作区版心**：`WysiwygEditor.vue` 的内容容器 `mx-auto` 居中，常规模式 `max-w-[1320px]`、焦点模式 `max-w-[1140px]`（1.5 倍于旧值 880/760），宽度切换带 `transition-all duration-300` 平滑过渡。

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
  - 左 → 右：WysiwygEditor 防抖序列化 → files store → 源码面板 `:value` 自动刷新（既有管道，零新增代码）；
  - 右 → 左：输入即写 files store（持久化管道），另防抖 200ms 直接 `commands.setContent(…, { emitUpdate: false })` 进左侧 Tiptap——**不依赖 modelValue watch**（其 600ms 静默窗会吞掉紧邻渲染端 emit 的外部更新），且 `emitUpdate:false` 不产生 onUpdate 回声，双向永不回路；
- **分隔条**：拖拽调整左右比例（0.25~0.75 钳制），双击复位 0.5，拖拽结束才 `settings.set('splitRatio', …)` 落 SQLite kv（重启保持）；拖拽期间全局 `user-select:none` + `cursor:col-resize`，杜绝 CodeMirror/选区抢鼠标；
- **同步滚动**（分屏专属悬浮芯片「同步滚动」+ 设置页开关，`settings.syncScroll` 落 kv）：`scroll` 事件不冒泡但可捕获——在分屏容器挂 `@scroll.capture` 单点监听，左右任意一栏滚动（含左侧代码块 CodeMirror 内部滚动）都按**滚动进度比**（`scrollTop / (scrollHeight - clientHeight)`）映射到另一栏；busy 旗标 + 同值赋值不触发 scroll 的浏览器语义保证无回声振荡。两侧内容高度不同也能正确对齐进度（对比视图的通用做法）；
- 菜单/快捷键/分段控件三入口共用 `useEditorMode`——切换逻辑唯一。

验收：矩阵 phase F 的 `source-mode-enter/editable/fills-height/back-wysiwyg` 与 `split-mode-enter/source-to-wysiwyg/wysiwyg-to-source/divider-drag/sync-toggle/scroll-r2l/scroll-l2r`（74 项全绿）。

---
