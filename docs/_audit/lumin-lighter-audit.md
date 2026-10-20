> ⚠️ **历史快照（2026-09 前后）**：本文件记录的是**当时**的状态与判断，勿当作现状引用；docs/ 的现状口径见手册与 README。路径引用可能已随代码演进失效（纳入 	ests/docsClaims.test.mjs 前已逐条登记）。

# Lumin 轻量化审计报告（启动 / 响应 / 运行时成本）

> **审计性质**：只读研究。未修改、未创建任何产品文件、未运行构建、未启动应用。
> 唯一新建文件就是本报告。
> **审计时刻**：本次会话期间 `out/` 被 owner 的并行构建**重建了两次**（entry chunk 哈希
> `index-BMSJMgn5.js` → `index-ClXEoIXK.js`）。下文所有体积数字取自最后一次落盘的构建产物，
> **两次构建的体积逐字节一致**（entry 1,585,771 字符 / EditorView 2,014,550 字符），
> 所以数字不受影响，但哈希会随每次构建变。
> **已完成的历史优化不要重复做**：见本仓库 `docs/optimization-program.md` 与手册 §4.21
> （FCP 668→280ms、通知/右键菜单 hydrate 移到 `requestIdleCallback`、主进程菜单后置、
> 多窗口错峰创建、`optimizeDeps`/`warmup`）。本报告只列**尚未做**的事。
> **数字口径**：标注 `【实测】` 的是我在磁盘上量到的字节/样本；标注 `【估计】` 的是推算。

---

## 0. 量到的基线（本次实测）

### 0.1 渲染层产物（`out/renderer/`）

| 类别 | 文件数 | 合计 |
|---|---|---|
| `.js` | **181** | **11,814.2 KB（11.54 MB）** |
| `.css` | 1（`index-DJV7q3Q5.css`） | **95.9 KB** |
| `.woff2` | 19 | 250.2 KB |
| `.woff` | 20 | 296.0 KB |
| `.ttf` | 20 | 501.6 KB |
| 字体合计 | **59** | **1,047.8 KB（1.02 MB）** |

### 0.2 首屏（eager）与懒加载的分界

`out/renderer/index.html` 只加载**一个** JS + **一个** CSS：

```
<script type="module" crossorigin src="./assets/index-ClXEoIXK.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-DJV7q3Q5.css">
```

* **首屏 eager 载荷 = entry 1,615,729 B + CSS 98,202 B ≈ 1.64 MB**【实测】
* entry 的 `__vite__mapDeps` 只有 3 项，且**全是 `import()` 目标**（不预加载）：
  `mermaid.core-BinthiFD.js`(1,229,436 B)、`_commonjsHelpers-CUmg6egw.js`(222 B)、
  `EditorView-DJ-juyR0.js`(2,013,891 B)。**entry 没有任何静态 `from "./x.js"` 导入**——
  也就是说 entry 自己就是那 1.58 MB 全部内容。【实测】
* `EditorView-DJ-juyR0.js` = **1.97 MB**，由 router 的动态 `import()` 触发，
  在 `doc-visible` 之前一定要付。【实测】
* **首屏总账（present 到文档可用）≈ 1.64 + 1.97 = 3.61 MB JS+CSS**【实测】

### 0.3 最大的 12 个 chunk

| 体积 | chunk | 归属 |
|---|---|---|
| 1,966.7 KB | `EditorView-DJ-juyR0.js` | Tiptap/PM + CM6 全量 + 编辑器业务代码 |
| 1,577.9 KB | `index-ClXEoIXK.js` | **首屏**：Vue+router+pinia+i18n + PM&tiptap core + 全部 UI 组件 |
| 1,273.9 KB | `cynefin-OW5HDTMX-DIG6njNI.js` | mermaid 图类型（按需） |
| 1,200.6 KB | `mermaid.core-BinthiFD.js` | mermaid 内核（按需） |
| 938.5 KB | `cytoscape.esm-CHzIQniu.js` | mermaid→cytoscape（按需） |
| 473.2 KB | `katex-oVG3DVWa.js` | **mermaid 自己带的 katex**（按需） |
| 413.4 KB | `architectureDiagram-…js` | mermaid 图类型 |
| 291.7 KB | `swimlanes-…js` | mermaid 图类型 |
| 209.5 KB | `cose-bilkent-…js` | mermaid 布局 |
| 197.0 KB | `sequenceDiagram-…js` | mermaid 图类型 |
| 130.5 KB | `ganttDiagram-…js` | mermaid 图类型 |
| 108.6 KB | `c4Diagram-…js` | mermaid 图类型 |

**mermaid 依赖子树合计 7,603.2 KB（7.43 MB，占全部 JS 的 64%）**【实测】——
全部在安装包里，全部按需加载，**启动时不加载**。

### 0.4 entry 内部字节级归属【实测：用库特征串在文件里的绝对偏移量出】

| 区间（字符偏移） | 大小 | 内容 |
|---|---|---|
| 0 – 113,369 | 113 KB | 业务工具库 + Vite 运行时 |
| 113,369 – 348,650 | **235 KB** | **Vue 3 runtime**（`createApp` 在这里） |
| 348,650 – 390,711 | 42 KB | **vue-i18n 内核** |
| 390,711 – 641,309 | **250 KB** | **三份语言包 + 全部静态导入组件（App.vue 那 13 个）** |
| **641,309 – ~1,053,000** | **≈412 KB** | **ProseMirror 全家桶（model/transform/state/view）+ Tiptap core** |
| ~1,053,000 – 1,230,533 | 178 KB | Tiptap 插件层 + Vue 编辑器组件 / FindReplaceBar |
| 1,230,533 – 1,462,135 | 231 KB | **katex.min.css（`?inline`，含 59 个 `@font-face`）+ Vite 运行时** |
| 1,462,135 – 1,582,886 | 121 KB | 剩余组件 + **内嵌 PNG base64（69,077 B 的 ICONS/图标段）** |

---

## 1. 机会清单（按「收益/风险」排序）

### R1 · 把 ProseMirror 从首屏 entry 里请出去（**最高收益**）

| 项 | 内容 |
|---|---|
| **机会** | entry 里 641,309–1,053,000 这 **≈412 KB** 的 ProseMirror + Tiptap core 是**纯走私**进来的：首屏根本不需要建编辑器。 |
| **证据** | 唯一的走私通道是 **`stores/find.ts:10-11`**：`import { findInDoc } from '../lib/editor/findInDoc'` + `import { setFindHit } from '../lib/editor/inlineMarks'`。而 `lib/editor/inlineMarks.ts:21-25` 静态导入 `Extension, Mark`（@tiptap/core）、`Plugin, PluginKey, TextSelection`（@tiptap/pm/state）、`Fragment, DOMParser`（@tiptap/pm/model）、`Decoration, DecorationSet`（@tiptap/pm/view）；`findInDoc.ts:9` 导入 `@tiptap/pm/model`。**关键**：`node_modules/prosemirror-state/package.json` 的 dependencies 是 `prosemirror-model` + `prosemirror-transform` + `prosemirror-view`，`prosemirror-view` 又反向依赖 state/transform ⇒ **只要 import 了 `@tiptap/pm/state` 的任何一个符号（哪怕只有一个 `TextSelection`），四个包一个都跑不掉**；`@tiptap/core` 的 `Mark.create`/`Extension.create` 同理把 Tiptap core（279.3 KB 未压缩）整份拉进来。走私链：`main.ts:12` → `App.vue:5` → `composables/useAppActions.ts:4` → `stores/find.ts:10-11`；第二条链 `App.vue:18`（FindReplaceBar，`:16`）与 `App.vue:11`（Toolbar，`Toolbar.vue:14`）也各拉一次同一模块。**注意**：`lib/session.ts:12` 的 `TextSelection` 也是同一条走私链（手册 §4.21 已点出，但只点了 session，没点 `find.ts`/`Toolbar.vue`/`FindReplaceBar.vue` 这三处）。 |
| **预期收益** | entry **-412 KB（-26%）**，首屏载荷 1.64 MB → **≈1.23 MB**；`EditorView` 因为懒加载、本来就带 PM，不受影响。【估计：字节区间是实测的，能省多少取决于 Rollup 是否能把它挪进 EditorView chunk——若挪不进去（被 entry 图里的其它路径咬住）收益为 0，所以**必须先跑一次 `--debug` 构建确认**】 |
| **实现方式** | ① 把 `stores/find.ts` 里对 `findInDoc` / `setFindHit` 的静态导入改成**动作内动态 `await import()`**（`matches()` 是 getter，改成 async 不行 → 改为在 `show()`/`select()` 里预热：首次 `show()` 时 `await import('../lib/editor/findInDoc')` 拿到函数存进模块级变量，getter 里判空返回 `[]`）；② `Toolbar.vue:14` 的 `selectionHasMdStyle` 与 `FindReplaceBar.vue:16` 的 `setFindHit` 同理，改成 `defineAsyncComponent` 或惰性 import 的封装；③ `lib/session.ts:12` 的 `TextSelection` 改成延迟取：`ed.state.selection.constructor` 或 `ed.commands.setTextSelection`（`session.ts:154` 已经在用 `ed.commands.setTextSelection`，那 `TextSelection.near` 这一处可以用 `ed.state.selection.$from` 的同类判据替代）。 |
| **风险** | **中**。改动面涉及查找替换、工具栏激活态、会话恢复三处；`_verify-find-replace.js`(12)、`_verify-session.js`(16)、`_verify-inline-formats.js`(183) 必须全绿。`stores/find.ts:70` 的 getter 依赖 `useEditorStore().tick`，懒加载后首次打开查找栏会多一次异步跳跃——必须保证 `show()` 里 `await` 完成后才 `select()`，否则会闪「0/0」。 |

### R2 · 每个代码块一个 CodeMirror 实例 → 改成「按需挂载/视口内挂载」

| 项 | 内容 |
|---|---|
| **机会** | `CodeBlockView.vue` 的 `onMounted` 给**每一个**代码块建一个完整 CM6 `EditorView`（含 `StyleModule.mount` → 每次 `document.head`/`adoptedStyleSheets` 注入、每次 `getRules` 全量比较）。 |
| **证据** | `components/editor/CodeBlockView.vue:5-24` 静态导入 `@codemirror/{state,view,commands,language,language-data,autocomplete,search}` + `@lezer/highlight`；一实例一份。**实测数字**：`out/_probe-fences-total-after.cpuprofile`（3.48 MB 采样、356,838 样本、207.9 s）：**`eq` @ `EditorView.js:33698` 占 41.1%**、**`mount` @ `EditorView.js:33041` 占 29.9%**（＋另外两个 `mount` 帧各 0.9%，合计 ≈31.7%）、`EditorView2` 构造 9.1%+0.2%+0.2%、**(garbage collector) 8.8%**、`getRules` @ 32992 3.9%。即 **≈71% 的 CPU 在 JS 对象深比较与 StyleModule 注入上**，GC 又吃掉 8.8%。对应的耗时基线在手册 §4.72 五：2000 个围栏（仅 56 KB 源文件）**装载 52–62 s**；977 KB 文档装载/回灌各 **≈16 s**。 |
| **预期收益** | 按上面占比 **【估计】减少 55–70% 的大文档装载时间**；56 KB/2000 fences 场景从 ~55 s 降到 ~18–25 s 量级。**完全不改功能**（用户看不见的代码块不建编辑器）。 |
| **实现方式** | 把 `CodeBlockView.vue` 拆成两级：静态态渲染成 `<pre><code>` + 一份**共享**的 CodeMirror `HighlightStyle`/`syntaxHighlighting`（只对当前块的文本跑 `highlightTree`，不需要 EditorView）；用 `IntersectionObserver`（root = `.editor-scroll`）在块进入视口 ±1 屏时**升级**成真正的 CM 实例，滚出后**降级**回收；`codeBlockViews.ts` 的 handle 注册表要跟着支持「未挂载」态（`codeBlockViews.ts:9` 的 `focusCodeBlock` 已有「无 CM 返回 false」分支，`keymap.ts:171` 已处理该退路）。 |
| **风险** | **中高**。这是本报告里唯一会动编辑器内核的项。牵涉 `_verify-cb-*` 系列（`_verify-cb-line-numbers`、`_verify-cb-typing`、`_verify-cb-delete-fix`、`_verify-cb-no-active-line`、`_verify-cb-button-line-numbers`）、`_regress-cb.js`、`_repro-rapidenter.js`、`_repro-backspace-after-cb.js`、`_repro-heading-cm*.js`、`_verify-math.js`、`_verify-surface-stress.js`。已知的硬约束：`CodeBlockView.vue:76-108` 的 `hasFocus` 守卫用**引用计数**（卸载顺序非 LIFO 会装回已置空 wrapper 并抛 `prevHasFocus is not a function`）——虚拟化会引入任意的挂载/卸载顺序，必须把计数改成「按块 id 的集合」而不是计数。建议**先只做「视口外不挂载」**（单向、不回收），跑一轮套件再考虑回收。 |

### R3 · 三份语言包全量进首屏 + KaTeX CSS 全量进首屏

| 项 | 内容 |
|---|---|
| **机会** | 首屏 entry 里两个纯浪费：**(a)** 三个语种的语言包全部静态打包（`i18n/index.ts:4-6`），实际只用 1 份；**(b)** `katex.min.css` 被 `?inline` 成字符串塞进首屏，它的**唯一用途是导出**（写 HTML/PDF 时的排版 CSS），编辑时不参与渲染。 |
| **证据** | **(a)** `src/renderer/src/i18n/index.ts:4-6` 三行静态 import `zh-CN.json`(60,083 B)/`en-US.json`(61,485 B)/`ru-RU.json`(76,169 B)（源文件字节【实测】），合计 197.7 KB 源码 → 进 entry 的 390,711–641,309 区间；在 entry 里能实测到「新建文档」出现 2 次、「Настройки」出现 3 次 ⇒ 三份确实都在。**(b)** `lib/export.ts:2` `import katexCss from 'katex/dist/katex.min.css?inline'`；`node_modules/katex/dist/katex.min.css` 被 Vite 内联后落在 entry 的 **1,230,533–1,462,135（231 KB，含 59 条 `@font-face` 的 `new URL(...)` 拼装 + Vite 运行时）**。`exportCss` 的唯一消费者是 `composables/useExport.ts:6`，而 `useExport` 被 `Toolbar.vue:7` 与 `TopMenuBar.vue:13` **静态**导入。 |
| **预期收益** | **(a)** 按 JSON 源码占比 **【估计】减去 2/3 的 JSON 体积 ≈ 40–45 KB**（保留 zh-CN，en-US 作为 fallback 也留 → 实际减 ~50 KB；若只留当前语言 + 一份 fallback 则减 ~45 KB）。**(b)** **【估计】≈130–230 KB**（katex.min.css 未压缩约 231 KB 中的 CSS 本体；字体文件 59 个 1,047.8 KB 本来就按需，不受影响）。两项合计 **【估计】首屏 -180 到 -280 KB**。 |
| **实现方式** | **(a)** `i18n/index.ts` 改成 `createI18n({ locale, fallbackLocale, messages: { [locale]: await import(...) } })` 或直接用 vue-i18n 的 `setLocaleMessage` 在 `settings.init()` 之后按 `settings.language` 动态 `import()`；`LANGUAGE_OPTIONS`（`i18n/index.ts:17-21`）是纯元数据、不用改；`applyAll()`（`stores/settings.ts:38`）调 `setLanguage` 的地方要改成 async 或 fire-and-forget + 重渲染。**(b)** `lib/export.ts` 把 `katexCss` 变成 `async function exportCss()`：`const { default: katexCss } = await import('katex/dist/katex.min.css?inline')`，并让 `useExport.ts:6` 的调用点 `await` 它。 |
| **风险** | **(a) 中**：换语言的**首帧**会短暂显示 fallback（或空白 key）。缓解：fallbackLocale 保留 en-US 且**同步**打包，只把「非当前语言」动态化 → 换语言时先显示英文、几十 ms 后替换。`_verify-i18n.js`、`tests/` 里的 i18n 守卫（手册 §4.51 提到「三语各 399 key」的自检）必须复跑。**(b) 低**：导出路径唯一，`_verify-export-fix*.js` / `_test-export-full.js` 覆盖；若 `?inline` + 动态 import 在 Vite 里有坑（会生成独立 chunk），退路是「导出时才 fetch 一份 CSS 文件」。 |

### R4 · App.vue 的 13 个组件全部静态导入 → 首屏就要付它们的代码

| 项 | 内容 |
|---|---|
| **机会** | `App.vue:11-23` 一口气静态 import 了侧栏、顶栏、通知中心、模态宿主、两种右键菜单、全局搜索、查找栏、本地历史、设置对话框、Tooltip、Icon。其中 `SettingsDialog.vue`(49 KB 源)、`TopMenuBar.vue`(21.6 KB)、`Toolbar.vue`(18.1 KB)、`LocalHistoryDialog.vue`、`GlobalSearch.vue` 都是**用户不点开就不需要**的。 |
| **证据** | `App.vue:11-23`（13 行静态 import）；`App.vue:128-136` 模板里它们全部**无条件**存在于 DOM（各自内部 `v-if`）。它们全部落在 entry 的 390,711–641,309 与 1,462,135–1,582,886 区间。`SettingsDialog.vue` 源码 50,176 B【实测】。 |
| **预期收益** | **【估计】首屏 -80 到 -150 KB**（源码 12.4+21.6+18.1+49+8.3+… ≈ 150 KB，minify 后约 90–110 KB + 模板编译产物）。真正能省多少取决于这些组件内是否还咬着首屏必需的东西（`SettingsDialog` 咬着 `SettingsKeymap`/`SettingsToolbar`/`Icon`），所以**必须构建后量**。 |
| **实现方式** | 对「点击后才需要」的 5 个改用 `defineAsyncComponent(() => import('./components/X.vue'))`，并用 `v-if` 把它挂在**触发它的状态**后面：`SettingsDialog` ← `ui.settingsOpen`；`LocalHistoryDialog` ← `ui.localHistory.open`；`GlobalSearch` ← `ui.globalSearchOpen`；`FindReplaceBar` ← `find.open`（注意 `stores/find` 本身还在 entry 里，见 R1）；`ContextMenu`/`EditorContextMenu` 保留静态（它们要挂全局事件，延迟挂载会丢第一次右键）。 |
| **风险** | **低–中**。延迟挂载会有一次「打开对话框晚一帧」的观感；`_verify-toolbar-settings.js`、`_verify-editor-menu.js`、`_verify-toc-*.js`、`_verify-keymap.js`、`_verify-local-media.js` 需复跑。**不要动** `SkeletonScreen`（它是 FCP 的关键，手册 §4.21）。 |

### R5 · 每键 / 每次选区变化：全文档 `textBetween` 算行号

| 项 | 内容 |
|---|---|
| **机会** | 光标行列（状态栏那个 `行:列`）每次选区变化都把**从文档开头到光标**的全部文本抽成字符串再 `split('\n')`。 |
| **证据** | `components/editor/WysiwygEditor.vue:49-54`：`updateCursor()` 里 `ed.state.doc.textBetween(0, $from.pos, '\n', '\n')` → `before.split('\n').length`。由 `onSelectionUpdate`（`WysiwygEditor.vue:92-95`）调用 ⇒ **每敲一个字符、每次点选、每次方向键都跑一次**。同类：`views/EditorView.vue:82-86` 的 `updateSourceCursor()` 在源码模式下对 `ta.value.slice(0, selectionStart).split('\n')`（`keydown`/`keyup`/`click`/`select` 四个监听，见 `EditorView.vue:719-723`）。复杂度 **O(光标位置字节数)**——在文档末尾打字时等于每次击键复制一遍整篇。 |
| **预期收益** | **【估计】每键减少 0.5–3 ms（大文档）**，取决于文档体积：按 977 KB 文档、光标在末尾、`textBetween` + `split` 约 1–3 ms/次推算。是「响应性」而非「体积」的收益，且**风险极低**。 |
| **实现方式** | 用**逐块累加**替代全文档抽取：从 `$from` 向上 `$from.depth` 遍历祖先，累加 `node.nodeSize` 与前面的兄弟节点 textContent 长度算出行号；或直接维护一个「上一次 positions → 行号」的增量缓存（PM 位置单调性可用于快速前进/回退）。源码模式那一处可以直接用「当前行开头在上一次 offset 附近」的二分：`ta.value.lastIndexOf('\n', selectionStart)` 与上一次结果做双向局部搜索。 |
| **风险** | **低**。行号显示口径必须与现在完全一致（包括软换行不算行、`\n` 作为段落分隔）。现有套件里 `_verify-layout`、`_verify-bars-no-filename.js`、`_verify-line-end-click.js` 有关联断言。 |

### R6 · `files.wordCount` 是 getter，每次内容变化做 3 次全文正则

| 项 | 内容 |
|---|---|
| **机会** | 状态栏字数/行数/字符数是 Pinia getter，直接对 `files.current.content`（整篇字符串）做 `replace` + 2 次 `match` + 1 次 `split`。 |
| **证据** | `stores/files.ts:76-84`（`wordCount`：`.replace(/[#>*`_~[\]()!|-]/g,' ')` → 两个 `match` 全文扫描）、`:85-90`（`lineCount`：`content.split('\n')` 生成整篇数组）、`:91-93`（`charCount`：`.length`）。消费方 `components/StatusBar.vue:217-221`。触发频率：`WysiwygEditor.vue:69-74` 的 `onUpdate` 是 **250ms 防抖**后 `emit` → `EditorView.vue:51 files.setContent(...)` 整体替换 `content` ⇒ **打字时约 4 次/秒**，每次 3 遍全文。 |
| **预期收益** | **【估计】每 250 ms 减少 2–8 ms（大文档）**，975 KB 文档上 3 遍全文正则约 5–15 ms ⇒ 状态栏更新会明显吃掉主线程空档。**这是「打字卡顿」在大文档下最可疑的剩余来源之一**（手册 §4.71 修掉的是归一化那条平方级路径，这条没被点过）。 |
| **实现方式** | ① 把 `wordCount`/`lineCount` 从 getter 改成 `state` 里的**缓存字段**，只在 `setContent` 时用**增量**或 `requestIdleCallback` 重算；② 计数只在**状态栏可见**时算（`v-if="files.current"` 已经在了，但 getter 仍被求值——加一个 `ui.statusbarVisible` 或 `IntersectionObserver`）；③ 最省事的一步：`lineCount` 改成维护一个 `\n` 的计数缓存，或直接用 PM 的 `doc.childCount`（注意口径差异：PM 顶层子节点数 ≈ 块数，不等于 `\n` 数）。 |
| **风险** | **低**。口径必须与主进程 `countWords`（`main/services/database.ts:154`）以及 `tests/` 中已钉住的字符集规则一致（`stores/files.ts:78-83` 的注释明确说「字符集与主进程 countWords 一致」）。改成空闲期计算后，字数显示会有最多一帧的滞后（可接受，但 `_verify-round-perf.js` 之类的耗时断言要复跑）。 |

### R7 · 每次事务全文档 `descendants` 重建大纲

| 项 | 内容 |
|---|---|
| **机会** | `editorStore.refreshOutline()` 在**每一个 PM transaction** 上遍历整篇文档收集 heading。 |
| **证据** | `stores/editor.ts:48-53`：`editor.on('transaction', () => { this.tick++; this.refreshOutline() })`；`stores/editor.ts:99-126`：`editor.state.doc.descendants(...)`（整篇遍历），后面 `:116-124` 有「标题集合不变则只改 pos」的短路（这一步已经优化过），但**遍历本身每次都跑**。消费方 `components/Outline.vue`。 |
| **预期收益** | **【估计】每事务 0.3–2 ms**（纯内存遍历，比 R5/R6 便宜，但同样与文档规模线性相关）。 |
| **实现方式** | 用 PM 的 `appendTransaction`/`docChanged` 之外的信息做增量：只在 `tr.docChanged` 时刷新（纯选区变化不刷新——**但 `:48-53` 把 `transaction` 和 `selectionUpdate` 分开监听了，`transaction` 事件在纯选区事务上也会触发**，所以加 `if (!tr.docChanged) return` 是最省的一步）；进一步可以记录「被改动节点的区间」，只在区间覆盖到 heading 或改变了块数时才重扫。 |
| **风险** | **低**。`_verify-toc.js`、`_verify-toc-load.js`、`_verify-toc-style-scroll.js` 覆盖。注意 `jumpToHeading`（`stores/editor.ts:139-158`）依赖 `outline[i].pos` 是最新的——若改成「不每次刷新」，必须保证在 `jumpToHeading` 前先刷新一次。 |

### R8 · 每次落盘：整篇字符串 split + 每行 3 个正则

| 项 | 内容 |
|---|---|
| **机会** | `getMarkdown()` 的收尾规则每次都把整篇 markdown `split('\n')` 再对每行跑 3 个正则。 |
| **证据** | `lib/editor/markdownStorage.ts:36` → `shared/documentText.ts:60-94`：`:62` 有快速通道（整篇无 `*~\`_` 直接返回，**这一步很好**），但一旦有任何一个标记字符，就 `:73 text.split('\n').map(line => …)`，每行 2 个围栏正则（`:75`、`:78`）+ 1 个 `MARKER_ONLY_LINE`（`:89`）。每次 flush（250ms 防抖）跑一次；手册 §4.71 记录 3000 字场景 avg 3.62 ms【引用手册实测】。 |
| **预期收益** | **【估计】大文档每次落盘省 1–5 ms**；对 977 KB 文档（≈2 万行）收益更明显。 |
| **实现方式** | 结果是**纯函数、可缓存**：把 `escapeMarkerOnlyLines(raw)` 的结果按 `raw` 做一次性 memo（Map 上限 2 条即可），因为同一份 markdown 会被 `flushSync`、源码面回灌、`contentIsStale` 判断读多次；更彻底的做法是只在 `raw` 真的包含「整行标记」形状时才走慢路径——用一条**整篇**的 `/^[*~`_]+\s*$/m` 预判取代逐行判定。 |
| **风险** | **低**，纯函数 + 有单测（手册提到 `documentText` 7 条 + `tests/inlineMarkers.test.mjs`）。 |

### R9 · 主进程：`electron-store` 仅用于一次性迁移，却在启动时同步建两个实例

| 项 | 内容 |
|---|---|
| **机会** | `electron-store` 现在只有一个用途（把老版本 config/workspace 迁进 SQLite），但它仍然在**主进程 bundle 求值阶段**（早于 `app.whenReady`）`new` 两个实例。 |
| **证据** | `src/main/store.ts:9-12`、`:19-22` —— `new Store({...})` 是模块级语句；`src/main/index.ts:21` 静态 `import { migrateLegacyStores } from './store'`；`migrateLegacyStores()`（`store.ts:25-35`）在 `whenReady` 里（`index.ts:347`）**先**判 `db.kvHas('settings')`，命中就早退（正常情况），但 `new Store()` 的**构造**已经在读盘了。`electron-store` 内部用 `conf` → `atomically` → 同步 `readFileSync`。 |
| **预期收益** | **【估计】主进程 bundle 求值期省 5–25 ms**（`conf` + `ajv` schema 校验 + 两次同步读盘 + JSON.parse）。**不影响首屏可见时刻**（窗口还没建），但会影响 `app-ready` 的时间点。 |
| **实现方式** | 把 `store.ts` 里的两个 `new Store()` 挪进 `migrateLegacyStores()` 内部（或 `await import('electron-store')`），`whenReady` 里第一次跑时判断 `db.kvHas('settings')`，命中就**根本不用加载 electron-store**。这样 `electron-store`/`conf`/`ajv` 这些代码可以从「每次启动执行」变成「只在首次迁移时执行」。 |
| **风险** | **低**。`migrateLegacyStores` 的行为必须逐字不变（老用户第一次升级时仍要迁移）。注意 `src/main/index.ts:5-6` 的导入顺序规矩（单实例锁必须排在会读 userData 的模块之前）——`store.ts` 已经在 `singleInstance` 之后，改动**不能**把它提到前面。 |

### R10 · 主进程：跳转列表/快捷方式建得比窗口还早

| 项 | 内容 |
|---|---|
| **机会** | `whenReady` 里在**创建窗口之前**写了开始菜单快捷方式 + 重建跳转列表。 |
| **证据** | `src/main/index.ts:422-423`：`taskbar.ensureShortcut()` / `taskbar.refreshJumpList()` 在 `:446` 的 `createWindow(...)` 之前。`taskbar.ts:317-368`（`ensureAppShortcut` → `shell.writeShortcutLink`）、`:404-443`（`refreshJumpList` → `app.setJumpList`）；另外 `taskbar.ts:5-8` 静态 import 了 `existsSync/readFileSync/readdirSync`，`:70` 会 `readFileSync(src)` + sha1，`:77` 会 `readdirSync(dir)` 扫图标目录。手册 §4.44 也说「启动时先写快捷方式、再注册跳转列表」。 |
| **预期收益** | **【估计】省 3–15 ms**（一次同步 `readFileSync` + 一次 `readdirSync` + 一次 `shell.writeShortcutLink` 的 COM 调用 + 一次 `setJumpList`）。同 R9，只影响「首个窗口开始加载」的时刻。 |
| **实现方式** | 把这两行挪到 `first.once('ready-to-show', …)`（`index.ts:460`）里或 `createWindow` 之后立刻 `setImmediate`/`setTimeout(0)`；跳转列表本来就有 `scheduleRefresh()`（`taskbar.ts:461`）做节流重建，启动这一次也可以走它。 |
| **风险** | **低–中**。`_verify-taskbar-jumplist.js`（25 KB，含冷启动那一段）必须复跑；风险点是「任务栏右键菜单第一项的名字」依赖快捷方式已存在——如果用户在窗口出来的**同一瞬间**就右键任务栏，可能看到旧名字。可接受。 |

### R11 · 主进程：`Menu.buildFromTemplate` 仍在 `whenReady` 同步跑

| 项 | 内容 |
|---|---|
| **机会** | 原生菜单构建（含三语词条解析）在窗口创建之后（已经优化过位置，`index.ts:472`），但仍是同步执行。 |
| **证据** | `src/main/index.ts:472 installMenu()` → `src/main/menu.ts:178 Menu.setApplicationMenu(Menu.buildFromTemplate(template))`；`menu.ts:38-48` 的 `currentLanguage()`/`t()` 每次构建都从 i18n JSON 取词。 |
| **预期收益** | **【估计】1–5 ms**。收益小，**不建议单独做**。 |
| **实现方式** | 若要动，用 `setImmediate(installMenu)`。 |
| **风险** | **中**：菜单不在窗口创建后立刻装，`Ctrl+N/O/S` 这些加速键会有一小段窗口期无效（`index.ts:258` 的注释说明「应用菜单仍安装，加速键继续生效」）。**收益不值这个风险 → 归入「看似能省但实际不划算」。** |

### R12 · mermaid 子树 7.43 MB + 59 个 KaTeX 字体文件全在安装包里

| 项 | 内容 |
|---|---|
| **机会** | 安装包/磁盘体积：`out/renderer/assets` 里 mermaid 依赖子树 **7,603.2 KB**、KaTeX 字体 **1,047.8 KB**、CodeMirror 语言 chunk **1,622.1 KB**（115 个动态 chunk）。这些**不影响启动**，但影响安装包（当前 123.2 MB【手册实测】）与磁盘占用、以及 `asar` 解压/首次读盘。 |
| **证据** | 【实测】§0.1、§0.3 的表格；`out/renderer/assets` 共 181 个 js。`@codemirror/language-data` 的 `languages` 表（`CodeBlockView.vue:16`）在 EditorView 里留下 **116 个 `import()` 目标**（115 个语言 + mermaid.core），合计 1,622.1 KB；而 UI 只列了 16 种语言（`CodeBlockView.vue:39-56`）。KaTeX 字体 59 个文件由 `katexCss`（entry）里的 `new URL(...)` 引用，**编辑时不用**（CSS 只在导出路径），`font-display:block` 保证未被使用的字体不会被抓取。 |
| **预期收益** | **【估计】安装包 -1.5 到 -3 MB**（把 `languages` 换成 16 个显式 import 可消掉约 100 个语言 chunk ≈ 1.4 MB 的**构建产物**，但 mermaid 的 7.4 MB 是 mermaid 上游行为、砍不掉——mermaid 11 把 katex/cytoscape/所有图类型都作为独立 chunk 发布，只有不用 mermaid 时才可以整体移除）。 |
| **实现方式** | ① `CodeBlockView.vue:16` 的 `import { languages } from '@codemirror/language-data'` → 改成对 `LANGUAGES` 那 16 项手写 `import('@codemirror/lang-javascript')` 等，产物体积立刻降；② KaTeX：如果「导出」功能能接受首用下载/懒加载，把 `katex/dist/katex.min.css` 归零（R3 已覆盖首屏那一半）。 |
| **风险** | **低**（① 只影响代码块语言下拉的可用语言集——**这是一处功能收窄，必须先跟 owner 确认**：现在用户可以在 markdown 里写任意 ` ```ocaml ` 并被高亮，改成 16 种后就退化成纯文本）。② 低。 |

---

## 2. 「看似能省但实际不划算的」

| 项 | 为什么不做 |
|---|---|
| **惰性化 SQLite 单例** | 手册 §4.21 已实测：`打开 + PRAGMA + 全部 CREATE IF NOT EXISTS + table_info` 在 1.6 MB 真实库上**只有 ~1.5 ms**。我复核了代码路径（`main/services/database.ts:179-186` 构造器 → `:188` `migrate()`），确认没有全文扫描、没有 FTS 重建，只有 3 次 `CREATE TABLE IF NOT EXISTS` + 1 次 `CREATE VIRTUAL TABLE IF NOT EXISTS`（`:320`）+ 2 次 `PRAGMA table_info` 列检查（`:231`、`:258`）。**~1.5 ms 不值得改结构。** |
| **`manualChunks` 手工拆包** | 手册 §4.21 已实测：拆 `vendor-vue/editor/code/diagram` 会触发 `Circular chunk`，并把**只被动态 import 的 mermaid 提到首屏 `modulepreload`**，首屏载荷暴涨。我复核了成因：语言 chunk 里普遍存在 `import "./index-ClXEoIXK.js"`（entry）与 `import "./_commonjsHelpers-…js"` 这类**副作用式静态回指**（例：`index-kvAF96zy.js` 静态依赖 `EditorView` + `index-8XscrOwe` + `index-Bqb9JYPN` + `index-Ch3b_lvJ` + entry + commonjsHelpers），这是 Rollup 的共享 chunk 机制，手工分组必然成环。**不要碰。** |
| **同步菜单后置 / 把 `installMenu` 挪更晚** | R11：收益 1–5 ms，代价是加速键空窗。 |
| **把 mermaid 换成更小的图库** | 7.43 MB 里 `cynefin`(1.27 MB)、`cytoscape`(938 KB)、`cose-bilkent`(209 KB) 都是 mermaid 11 的**内部**依赖，不是我们选的。要么整体保留，要么整体砍掉 mermaid 功能。**收益在安装包，不在启动**（全是按需加载）。 |
| **给 `EditorView` chunk 再拆一刀** | 它 1.97 MB 但**已经是一个动态 import 边界**；再拆只会把 CM6 与 PM 分离，而两者在「有代码块的文档」上都要加载，总字节不变，却多一次请求 + 多一层竞态。手册 §4.21 已经把 CM6 拆分列为「下一步」，但**我的实测给出反对意见**：`CodeBlockView.vue:5-24` 的 CM6 静态导入（`@codemirror/{state,view,commands,language,autocomplete,search}` + `@lezer/highlight`）**是每个代码块都要的**，而 977 KB 文档、2000 fences 场景下真正贵的是 **每个块的 `EditorView` 实例化**（R2），不是那 ~250 KB 的 CM6 框架代码。**先做 R2 的虚拟化，再评估 CM6 拆分**——否则拆完 CM6 后 `EditorView` chunk 只小 250 KB，而「2000 个 CM 实例」的 71% CPU 与 55 s 装载时间一点没变。 |
| **给 `@tiptap/pm` 加 `optimizeDeps` 或改 import 路径来减包** | `optimizeDeps.include`（`electron.vite.config.ts:47-50`）只影响 **dev** 预打包，对生产构建体积**零影响**。生产侧唯一的解法是 R1（把走私通道切断）。 |
| **`rollupOptions.output` 做 `modulePreload: false`** | entry 的 `__vite__mapDeps` 只列了 3 个 `import()` 目标，而实际动态导入有 116 个（R12 已量），说明 Vite 没有为它们注入 `modulepreload`。**没有可关的东西。** |
| **拿「首屏 chunk 从 935 KB 涨到 1.58 MB」当作这一次的锅** | 手册 §4.21 记的首屏 chunk ~935 KB 是**当时**的数字，现在是 1,615,729 B。差异来源我在 §0.4 逐段量过：多出来的是 PM/tiptap 走私（412 KB）与 katex CSS（231 KB）——**这两项正是 R1 与 R3**。不要把它归给业务代码膨胀。 |

---

## 3. 建议优先做的 5 项

| 序 | 做什么 | 为什么是它 | 量化目标 |
|---|---|---|---|
| **1** | **R1 切断 ProseMirror 走私通道**（`stores/find.ts`、`Toolbar.vue`、`FindReplaceBar.vue`、`lib/session.ts` 四处静态导入改惰性） | 单笔最大、判定最清晰、**首屏直接受益**；已有手册 §4.21 的结论背书「下一步是减字节」 | 首屏 **1.64 MB → ~1.23 MB**（-412 KB，-26%）【估计，需构建确认】 |
| **2** | **R3 语言包按需 + KaTeX CSS 延迟** | 两处都是「首屏装了永不用的字节」，实现独立、不碰编辑器内核；R3b（katex）几乎零风险 | 首屏 **再 -180 到 -280 KB**【估计】 |
| **3** | **R2 大文档下代码块按需挂载 CM**（先只做「视口外不挂载」，不做回收） | **响应性收益最大的一笔**：实测 71% CPU 在 `eq`+`mount`，2000 fences 装载 52–62 s、977 KB 文档 16 s | 【估计】装载耗时 **-55 到 -70%** |
| **4** | **R5 + R6 + R7 三处每次交互的全文扫描**（行号增量、字数缓存到 idle、大纲加 `tr.docChanged` 守卫 + 增量） | 三项都是**低风险 + 与文档规模线性相关**，合起来是「大文档打字手感」的剩余来源；R7 的第一版只需要加一行 `if (!tr.docChanged) return` | 【估计】大文档每键 **-3 到 -12 ms** |
| **5** | **R4 App.vue 的 5 个对话框组件改 `defineAsyncComponent`** | 独立、可增量落地；与 R1 有叠加效应（`GlobalSearch`/`FindReplaceBar` 一旦延迟，`stores/find` 的走私链也更容易断） | 【估计】首屏 **-80 到 -150 KB** |

> **落地顺序建议**：1 → 2b(katex) → 5 → 4 → 2a(语言包) → 7 → 5/6 → 3 → 9/10 → 12。
> 理由：先把「不碰编辑器内核」的都做完并复跑套件（1/2/4/5/9/10/12），
> 再动内核热路径（3/6/7/8），最后才考虑 R2 的虚拟化。

---

## 4. 复跑验收清单（每项改完必须跑的既有套件）

| 改动 | 必须复跑的套件 |
|---|---|
| R1 | `_verify-find-replace.js`、`_verify-session.js`、`_verify-inline-formats.js`、`_verify-keymap.js`、`_verify-editor-menu.js`、`tools/verify-tiptap.js`（手册 §52 标注的「待迁进矩阵」的那个） |
| R3a | `_verify-i18n.js`、`tools/_verify-theme-auto.js`、手册 §4.51 的「三语各 399 key」静态自检、`tests/mainConsoleAscii.test.mjs`（主进程菜单三语用同一份词条） |
| R3b | `_verify-export-fix.js`、`_verify-export-fix2.js`、`_test-export-full.js`、`_trigger-export.js` |
| R4 | `_verify-toolbar-settings.js`、`_verify-editor-menu.js`、`_verify-toc.js`、`_verify-toc-load.js`、`_verify-keymap.js`、`_verify-welcome-removed.js`、`_verify-notifications.js` |
| R5/R6/R7/R8 | `_verify-toc.js`、`_verify-toc-style-scroll.js`、`_verify-bars-no-filename.js`、`_verify-line-end-click.js`、`_verify-round-perf.js`、`_verify-md-fidelity.js`(101/102)、`tests/inlineMarkers.test.mjs` |
| R2 | `_verify-cb-line-numbers.js`、`_verify-cb-typing*.js`、`_verify-cb-delete-fix.js`、`_verify-cb-no-active-line.js`、`_verify-cb-button-line-numbers.js`、`_regress-cb.js`、`_repro-rapidenter.js`、`_repro-backspace-after-cb.js`、`_repro-heading-cm*.js`、`_verify-math.js`、`_verify-surface-stress.js`（注意：该套件里的 `many-fences-2000` 断言在手册 §4.72 五里记录了「改前改后都过不去」的环境敏感问题，**不要拿它当 R2 的判据**，改用 `_probe-fences-total.js` 的耗时数字） |
| R9/R10/R11 | `_verify-single-instance.js`（静态核对导入顺序）、`_verify-taskbar-jumplist.js`、`_verify-packaging.js`（A2 冒烟） |

---

## 5. 我没能做到的 / 需要 owner 补的

1. **R1 的净收益无法在不构建的前提下确认**。Rollup 可能因为 entry 图里还有别的 PM 引用（`stores/find` + `Toolbar` + `FindReplaceBar` + `lib/session` 四条）而无法把它移出 entry。**请跑一次 `electron-vite build` 后在 `out/renderer/assets/index-*.js` 上复量** `class Transform` 的偏移是否消失。
2. **未跑 `_startup-bench.js`**（任务禁止启动应用）。本报告的主进程时序结论全部来自代码顺序 + 手册 §4.21 的既有实测（FCP 280 ms / 窗口可见 376 ms / 文档可用 1120 ms）。R9/R10 的「5–25 ms / 3–15 ms」都是按代码路径的**估计**。
3. **`EditorView`(1.97 MB) 的内部构成没能逐段量**。我只确认了它含 CM6 全量 + PM 全量 + markdown-it（`MarkdownIt` 出现 23 次、`tokenize(` 13 次）+ tiptap-markdown；没有可疑的大字符串（最长 36 KB，是 PM 的 `findChild` 源码注释）或 base64。若需要精确归因，建议构建后跑一次 `rollup-plugin-visualizer`。
4. **`#/about` 路由（`AboutView`）只有 4.6 KB**，不是问题，顺带记录。
