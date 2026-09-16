# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
本项目在此文件建立之前的变更，以「历史主题汇总」压缩记录；每轮的取舍与验收细节见 `docs/typora-wysiwyg-manual.md`。

## [Unreleased]

### Added

- **单元测试基建**（`tests/`，`node --test` 原生 TS 类型剥离，零新依赖）：草稿归属判定矩阵、会话恢复计划矩阵、
  搜索高亮分段、图片相对路径解析、路径工具、编码表、`lumin-file` 访问规则、**package.json ↔ package-lock 一致性自检**。
  共 **57 条**断言，`npm run test:unit` 秒级完成。
- **CI**（`.github/workflows/ci.yml`，Windows runner）：`npm ci` → typecheck → lint（`--max-warnings 0`）→ 单测 → 构建。
  CDP 套件因为需要真实桌面会话，不进 CI（跑法见 README）。
- **纯函数层**：`shared/drafts.ts` 的 `planUntitledDraft()`、`shared/session.ts` 的 `planRestoreFromSlots()`、
  `shared/media.ts` 的 `isMediaExtension()` / `isWithinAnyRoot()`、`renderer/lib/imageSrc.ts`、`renderer/lib/highlight.ts`。
  把「判定」从 I/O 里剥出来，才能被毫秒级单测覆盖。
- **相对路径图片真正可用**：`![](img/a.png)` 现在按**文档目录**解析成 `lumin-file://` 绝对 URL 并加载
  （此前 `resolveLocalImageSrc` 是空实现，相对图片渲染不出来）。
- `.gitattributes`：行尾与二进制类型的单一事实来源（此前完全依赖各机器的 `core.autocrlf`）。
- `npm run ci`（本地一键门禁）与 `npm run lint:fix`；`engines.node >= 22`。

### Changed

- **写盘改为原子写**：`fileOps.writeFile` 走「同目录临时文件 → `fsync` → `rename` 覆盖」。
  中途崩溃/断电/磁盘满不会再截断用户唯一的一份稿件（同分区 rename 是原子的）。
  写盘失败时保留原文件，并把**原因**带给用户（不再只提示一句「保存失败」）。
- **全文索引节流**：自动保存（默认 3 秒）不再每次都全量重建 FTS5 索引（`DatabaseSync` 是同步 API，跑在主进程）。
  改为按文件合并、2 秒窗口批量重建 + 批次事务；超大文档只索引前 256KB；搜索前与退出前各补一次 flush。
- `lumin-file://` 协议只服务**媒体文件**且只服务**工作区内 / 已打开文档目录内**的路径（两道白名单）。
- 渲染层搜索结果不再用 `v-html` 拼 HTML：主进程改成返回带控制字符标记的**数据**，渲染层按段渲染 `<em>`。
- README 重写：平台现状（Windows 优先）、真实的质量门禁命令、目录结构、文档地图、已知限制与路线。
- `.prettierrc.yaml` 增加 `endOfLine: auto`（工作树是 CRLF，默认 LF 校验会产生 ~2.2k 条假告警）。

### Fixed

- 换文档后正文里的图片可能指向**上一个文档的目录**（`openPath`/`saveAs` 里 `currentDir` 赋值晚于 `current`）。
- 主进程缺少 `will-navigate` 兜底：文档里的链接若未被点击拦截覆盖，窗口会被整个导航走（应用 UI 消失、CSP 失效）。
- **lint 门禁不可用**：此前 `npm run lint` 报 912 errors / 7260 warnings（`tools/**` 898 个 error + CRLF 假告警）。
  现在 `tools/**`、`build/**` 已忽略，行尾规则对齐，`src` 的 14 个 error 全部修掉 → **0 error / 0 warning**。
- 模板里的内联多语句被 prettier 吃掉分号导致的构建失败：`@click`/`@dblclick` 的多语句抽成方法
  （`collapseSidebar` / `openGeneralSettings` / `pickTheme` / `resetSplitRatio`）。

### Removed

- 死代码：`wasCrashed()` / crash-flag 机制（写而不读，从未有人消费）、`releaseSlot()`（从未被调用）。
- 未使用的运行时依赖 `@electron-toolkit/preload`（`src` 中 0 处引用），并同步了 `package-lock.json`。
- pnpm 专用字段 `allowScripts`（本仓库用 npm）。
- 被误提交的构建日志 `build-out.txt` / `typecheck-out.txt` 与 `dev-app-update.yml`（已退出跟踪并加入 `.gitignore`）。

### Docs

- 新增手册 §4.51（本轮优化的范围、改法、验收数字与遗留项）。
- `docs/optimization-program.md` 顶部台账更新：已完成项与剩余波次。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0（tsc + vue-tsc） |
| `npm run lint` | **0 error / 0 warning** |
| `npm run test:unit` | **57/57 pass** |
| `npm run ci` | exit 0（上四项 + 构建） |
| `npm run build` | exit 0 |
| `tools/_verify-draft-banner.js` | 25/25 |
| `tools/_verify-new-document.js` | 23/23 |
| `tools/_verify-session.js` | 17/17 |
| `tools/_verify-session-last-closed.js` | 8/8 |
| `tools/_verify-taskbar-jumplist.js` | 31/31 |
| `tools/_verify-local-media.js`（新增） | 10/10 |

### 仍待办（按仓库整改方案排序）

- **Wave 1**：~~Markdown 往返保真套件~~ → **本轮已完成**，见下一节。
- **Wave 2**：文档级元数据模型（编码 / EOL / BOM 落库）、本地历史与回滚、以编码/EOL 保存。
- **Wave 3**：编辑器 ⇄ store 显式意图状态机；文件树键盘可达；原生日志文案接三语。
- **工程化**：~~`tools/lib/harness.js` + `tools/run-suites.js`~~ → **本轮已完成**；
  剩余：`files` store 拆分；`store` 里那份为绕循环导入而复制的 `confirmIfDirty` 收敛到 `services/dialog`。

## [Unreleased · 老套件迁移（一）] — `_regress-*` 全部 + 最有价值的 `_repro-*`

### Changed

- **6 个老套件迁到 `tools/lib/harness.js` + `Reporter` 并纳入矩阵**：`_regress-layout`（9 条）、
  `_regress-cb`（3）、`_regress-divider`（4）、`_regress-fileswitch`（5）、
  `_regress-source-roundtrip`（4）、`_repro-rapidenter`（4，且把断言扩到 **store 正文行**）。
  它们此前全部发红，原因不是产品坏了而是套件自己过期：按**中文按钮文字**找 `.mode-seg-btn`
  （现在是 `role="tablist"` + 三个 `role="tab"`，文案可本地化 ⇒ 换语言就整轮跑不了）。
- `harness.js` 新增三个公共能力：`clickMode(app, 0|1|2)`（**按序号**点模式分段控件，语言无关）、
  `waitRestored()`（等 `.view-restoring` 结束）、`openDocWith(app, md, name)`
  （走 `files.current` + path 变化加载文档 ⇒ 触发 `:key` 重建）。

### Fixed

- **代码块「内容末尾的空行」往返丢失**（迁移中被 `_repro-rapidenter` 的 store 侧断言抓到）：
  CommonMark 里收尾围栏前的换行是「最后一行的行终止符」，不算内容 —— 内容 `a\n` 写成
  `a` + 换行 + 围栏，重新解析回来变成 `a`，**保存一次少一行**。现在内容以换行结尾时，
  收尾围栏前多写一个换行（`lib/editor/codeBlock.ts`）；夹具 `code-fence.md` 补了对应一例。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **15/15 套件 PASS**（从 9 个扩到 15 个） |
| `_verify-md-fidelity.js` | **101 PASS / 0 FAIL / 1 SKIP**（夹具新增「内容末尾带空行」一例） |

### Docs

- 手册新增 §4.64：迁了哪 6 个、为什么按序号点模式控件、迁移本身的两个教训
  （不能直接 `setContent` 加载文档 / 焦点要确认两次）、顺手修掉的保真缺口，
  以及**剩下 83 个脚本的定位表**（回归守卫 / 一次性探针 / 测量基准 / 截图工具 / 尚未迁的老套件）。

## [Unreleased · 工程化收尾（二）] — recent store 拆分 + 嵌套样式渲染断言

### Changed

- **`stores/recent.ts`（新）**：最近文档 / 置顶 / 最近文件夹从 `files` store 整块拆出来。
  这份数据的归属是「用户开过什么」，与「当前工作区 / 当前文档」是两件事（关掉所有文档、
  切换工作区，历史都还在）。`files.ts` 646 → 593 行；调用点（打开文件夹 / 打开文件 / 另存为）
  改为 `useRecentStore()`。
  - 边界：规则仍在 `lib/recent.ts` 纯函数（有单测），store 只负责落盘 + 给 UI 排好序的视图；
    数据仍存 `settings`（SQLite kv），**键名不变 ⇒ 无迁移**，既有套件断言不受影响；
  - `folderList(root)` 由调用方传根目录，**不反过来 import `files` store**（避免循环引用）；
  - 置顶判断给 `pinnedPaths: Set<string>`（列表每行都要问，数组 `includes` 是 O(n²)）。

### Added

- `_verify-md-fidelity.js` 新增 **N 段**：嵌套样式的**计算样式**断言 ——
  加载 `nested-styles.md` 后取 `[data-md-styles~="code"]`，断言标签是 `strong`、
  `data-md-styles` 为 `bold code`、`font-weight ≥ 700`、`font-family` 命中等宽字体。
  这条补的是「CSS 漏了属性选择器时，序列化仍然保真但代码看着不像代码」那个盲区
  （保真套件量不到观感）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **101 PASS / 0 FAIL / 1 SKIP**（102 条断言） |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 复核 | `.md-preview img` 规则只剩一份（重复的那份已删）；主题无独立 CSS 文件（明/暗/羊皮纸都是 `style.css` 里的 CSS 变量），无需同步第二份属性选择器 |

### Docs

- 手册新增 §4.63（recent store 拆分的边界与两个设计细节、渲染断言的动机）；
  `docs/optimization-program.md` 台账更新。

## [Unreleased · Wave 1 收尾（三）] — 图片改成行内节点（Wave 1 缺口清零）

> 最后两个 `lossy` 夹具（`images-inline` / `images-linked`）是同一个结构决策造成的：
> 图片被配成**块级节点**，而 Markdown 的 `![alt](src)` 本来是**行内语法**。

### Changed

- `Image.configure({ inline: true })`：段落中间的图片不再把段落拆成「文字 / 图片 / 文字」三段；
  `[![alt](img)](url)` 的外层链接也能正常挂在图片上（块级节点挂不了 mark，外链整个丢）。
- 删掉自定义的块级图片序列化器（原来为了修「块级图片黏成一行 / 吞掉下一个标题」而补 `closeBlock`）：
  行内之后段落自己负责换行，直接用 tiptap-markdown 的默认实现（alt/括号/引号转义都对齐 prosemirror-markdown）。
- `style.css`：`img` 默认 `display: inline-block` + `vertical-align: middle`，
  `p > img:only-child` 才按块级居中 —— 「独立成段的图片」观感与改之前一致；
  同时删掉文件后部**重复的一份** `.md-preview img`（它位置更靠后，会覆盖行内排版）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **100 PASS / 0 FAIL / 1 SKIP**（101 条；唯一 SKIP 是文档化的「保存补文末换行」字节级行为） |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 夹具分级 | exact **15** / normalized **16** / lossy **0** —— **Wave 1 的 8 个缺口全部清零**（8→6→4→2→0） |

### Docs

- 手册新增 §4.62（为什么图片要改成行内、三处配套调整、验收数字）；`docs/optimization-program.md` 台账更新。

## [Unreleased · Wave 1 收尾（二）] — 表格、行内 HTML、列表编号

> 接上一节，把剩下 6 个 `lossy` 缺口里的 4 个收掉，只剩两个图片缺口。

### Added

- **表格列对齐与单元格转义竖线**：接管 `table` 节点的 markdown 序列化
  （`lib/editor/tableMarkdown.ts`）—— 分隔行按各列表头的 `align` 生成（`:---` / `:---:` / `---:`），
  单元格内容渲染后转义 `|`（不转义会被当成列分隔符，**整行结构被拆坏**）。
  解析侧本来就是对的（markdown-it → 单元格 `align` 属性 → `\|` 解成字面竖线），坏的一直是写回。
  复杂表格（合并单元格/一格多块）仍退回 HTML。纯文本规则抽在 `lib/editor/tableAlign.ts`，6 条单测。
- **行内 / 块级 HTML 原样保留**（`lib/editor/htmlPassthrough.ts`）：`parse.setup` 覆盖 markdown-it 的
  `html_inline` / `html_block` 渲染规则 → 行内包成 `<span data-md-html>` 由 `MdHtml` mark
  （`escape:false`）逐字写回，块级包成 `<pre data-md-htmlblock>` 由 `HtmlBlock` 原子节点原样写回。
  任务列表插件**生成**的复选框 token 按插件写死的 class 名放行（否则任务列表会变成一堆标签文本）。
- 有序任务列表：`taskList` 新增 `ordered` 属性（解析时按 `<ol>`/`<ul>` 标签记住）。

### Changed

- 行内标记模型：**不透明行内内容（行内 HTML、展开态的链接源码）在样式栈物化时原样穿过** ——
  既不参与样式栈，也不打断外层构造（`**加粗里的 <kbd>Ctrl</kbd> 还是加粗**`）。
- 判级器新增规则 19：**有序列表编号按位置重算**（首项编号保留 —— 那是 `<ol start>`，有语义），
  同一个列表里项与项之间的空行不参与比对（松散是整表属性，源码位置保留不下来）。
  这条规则必须幂等，所以有序列表在它眼里不区分 `)` 与 `.`（规则 7 本来就会归一）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **94 PASS / 0 FAIL / 5 SKIP**（99 条断言；新增 T 段表格 2 条、I 段 HTML 3 条） |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 夹具分级 | exact **13** / normalized **16** / lossy **2**（只剩图片两个） |

### Docs

- 手册新增 §4.61（表格为什么坏在写回、HTML 的两个坑、列表编号为什么是「规范化」而不是「缺陷」）；
  `docs/optimization-program.md` 台账更新。

## [Unreleased · Wave 1 收尾（一）] — 嵌套样式与 YAML front matter

> Wave 1 的 8 个 `lossy` 缺口里，这两个是「内容真的坏掉」的那一类：嵌套样式写出 CommonMark
> 下不成立的孤儿标记（渲染成字面星号），front matter 把 YAML 元数据变成正文。

### Added

- **YAML front matter 原样保留**：文档开头的 `---…---` 成为**真实节点**（`lib/editor/frontmatter.ts`）——
  markdown-it block 规则只在第 0 行认领、推自定义 token、渲染成 `<pre data-md-frontmatter>`，
  节点的 `parseHTML` 认领它、序列化把原文逐字写回。判定抽成纯函数 `shared/frontmatter.ts`
  （保守规则：必须有顶层 `key:`，否则 CommonMark 里合法的「分割线夹文字」会被误吃），11 条单测。
  节点是 atom：WYSIWYG 里只读可见，改 YAML 走源码模式。
- 单测 `tests/frontmatter.test.mjs`（11 条）；`_verify-md-fidelity.js` 新增 H 段 4 条端到端断言
  （首节点是 frontmatter 且渲染同样内容 / 编辑正文后 YAML 逐字不变 / 源码模式里 YAML 就在开头 /
  分割线夹文字不被误判）。

### Changed

- **`mdStyle` 的样式从单个值改成集合**（`styles: StyleKind[]`，按 `bold→strike→italic→code` 规范化）：
  PM 里同一种 mark 只能挂一个，`**粗体里的 `行内代码`**` 这种嵌套必须靠集合表达。
  DOM 只渲染**一个**元素（标签取最外样式，全部样式写进 `data-md-styles`），其余样式的外观交给
  CSS 属性选择器 —— 渲染成嵌套标签会让 DOM 回读时后者顶掉前者（样式丢失 + 回写 churn）。
- **标记物化改成按样式栈开关**（新的 `materializeStyledRun()`）：相邻两段取样式集合的公共前缀保持不动、
  只开关差集，于是标记天然嵌套；单一样式时退化成原来的「两边各一对」，既有行为不变。
  找配对标记的扫描改成**深度计数**，否则外层 `**` 会在内层 `` ` `` 处误判「缺 end」而把构造劈成两半
  （这正是旧写法把 `**粗体里的 `代码`**` 写成 `**粗体里的 **`代码`** …**` 的那一步）。
- `CodeQuiet` 放开 `excludes: '_'`：上行默认让行内代码**排斥一切 mark**，解析时会把外层粗体丢掉，
  嵌套样式在一开始就少一半。
- 工具栏/气泡菜单的样式激活态改用 `selectionHasMdStyle()`（按集合判断，而不是属性相等）；
  粘贴去粗体只从集合里摘掉 `bold`，保留行内代码等其余样式。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**131/131** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **81 PASS / 0 FAIL / 13 SKIP** |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 夹具分级 | exact **11** / normalized **14** / lossy **6**（本轮前 9/14/8） |

### Docs

- 手册新增 §4.60（两个缺口的改法、取舍与验收；含「为什么不能渲染成嵌套标签」这类踩坑记录）；
  `docs/optimization-program.md` 台账与 Wave 1 收尾小节更新。

## [Unreleased · Wave 3.2] — 编辑面 ⇄ 真源的单向数据流账本

> 正文有三个能改它的编辑面（Tiptap 面板 / 源码 textarea / 代码块里的 CodeMirror），
> 加上「打开文件 / 恢复草稿 / 切编码 / 载入历史」四类整篇替换 —— 此前四条通道各自发明了
> 「这次变化要不要跟着更新」的判断（比字符串、600ms 静默窗、150ms 快照相等），
> 于是有一批看着像玄学的 bug：**快速回车丢字、切回原编码后正文不刷新、分屏里停顿后的更新被吞掉**。

### Added

- **`src/renderer/src/lib/contentSync.ts`**：真源内容的 **世代号 `rev` + 作者 `author` + 各命令式编辑面
  `applied`**。谁改内容谁自增世代并署名；编辑面要不要重渲染只问一句「我落后了吗」——
  **不比较字符串、不看时间窗**。纯函数，`tests/contentSync.test.mjs` 9 条断言直接覆盖。
- 代码块 CodeMirror 成为一等编辑面：写内容时 `editorStore.noteWrite('codeblock')` 挂牌，
  序列化落库时消费成账本作者；它同时是 Tiptap 文档的**子编辑面**，所以这次写入会连宿主一起
  标记为最新（否则宿主把 md 回灌进文档，光标会被踢出代码块）。

### Changed

- **Tiptap 面板**：同步判断从 `syncedMd === content` + `files.syncEpoch` 改为
  `files.contentIsStale('wysiwyg')`；分屏下源码面逐键输入时仍合并 200ms 重解析，
  但那只是**渲染节流**，不再是一条独立的同步通道。
- **代码块 CodeMirror 的外部同步**：从「150ms 防抖 + 节点文本快照相等就跳过」改成三条结构性规则 ——
  **触发时重新读节点文本**（不用 watch 队列里的过期快照）、文本一致就不动、
  **CM 拿着光标时绝不覆盖**（再等一轮，失焦后对齐）。旧写法在快照过期时会把 CM 状态回滚，是丢字的根因之一。
- 整篇替换（`setContent(..., 'external')` / `noteExternalReplace()`）**不动任何 `applied`** ⇒
  所有编辑面都落后 ⇒ 文本恰好相同也要重渲染一次，修掉「切回原编码时状态栏变了、正文不动」。
- **回灌时内容从 store 现读，不再读 `props.modelValue`**：Vue 的 `watch` 跑在渲染之前，
  props 是父组件上一次渲染传来的 —— 读它会拿到上一代内容，把编辑器灌成旧文本；
  而那次 `setContent` 会触发 md 标记归一化再产生一次事务 → `onUpdate` → 防抖 flush 把旧文本
  写回 store，**源码面刚敲的那行就没了**（整轮矩阵里偶发、单跑不复现的那次失败）。
  代码块 CodeMirror 同侧也改成按 pos 现读 PM 文档（`props.node.textContent` 同样可能落后一拍）。

### Removed

- `files.syncEpoch`（= 账本的 `rev`，且账本还知道是谁写的）与 `editorStore.syncedMd`
  （= 字符串版本的 `applied.wysiwyg`）。
- `EditorView` 里那条 200ms 的 `scheduleSplitSync` 第二条同步通道，以及切模式时的
  `syncEditorContent()` 字符串比较 —— 三个编辑面现在共用同一个账本。

### Fixed（工具链）

- **77 个 CDP 套件不再按 `Symbol(pinia)` 的 symbol 描述取 store**：改成按结构认
  （`prov[s]` 是对象且 `_s instanceof Map`），页面识别也不再写死 `5173`。
  生产构建会压掉 symbol 描述，旧写法等于「同一套件在 dev 与构建产物下行为不同」。
  A/B 实测：19 个原本没有结构兜底的套件里 **13 个在构建产物上直接崩
  （`TypeError: Cannot read properties of null (reading '_s')`）→ 0 个崩**，其中 4 个从「崩」变成端到端跑通。
- `tools/_regress-split-live.js` 迁到 `tools/lib/harness.js` + `Reporter`，并修好旧选择器
  （`.mode-seg-btn` → 工具栏那个 `role="tab"` 分段控件），现在进默认矩阵。
- `tools/_verify-session.js` 改设置后**等它真落库**（`settings.getAll()` 轮询）再 `Page.reload`：
  原来固定 `sleep 600ms`，机器忙时主进程读到的还是旧值，表现为偶发的
  「关了会话恢复却仍恢复出文档」（整轮矩阵里红、单跑绿）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**120/120** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **9/9 套件 PASS**（新增 `_regress-split-live`：分屏双向同步 8 条） |
| `tools/_verify-wave3.js` | A 段 9 条（账本作者 / 落后判定 / 代码块作者标记 / 整篇替换） |

### Docs

- 手册新增 §4.59（账本协议、四个编辑面的角色、老套件迁移的 A/B 数字，以及一次真实文件事故的恢复办法）；
  `docs/optimization-program.md` 台账与 Wave 3.2 小节更新；README 开发约定新增「不要用 PowerShell 做源码字符串手术」。

## [Unreleased · Wave 2 尾巴] — 多窗口元数据一致性与历史保留策略可配

> Wave 2 当时留了两条尾巴：两个窗口打开同一文件时元数据可能各说各话；本地历史的保留策略写死在代码里。

### Changed

- **编码优先级：显式指定 > 每文件记录 > 全局默认**（`file:read` 增加 `opts.softDefault`）。
  * 「选择编码重新打开」等**显式**动作照旧压过一切（用户刚点的必须听）；
  * 「打开文件时的设置默认值」是**软默认**：该文件有记录时让位给记录 ——
    用户上次手选的 GBK、或自动判定出的非 UTF-8 都记在 `documents.encoding` 里，
    于是第二个窗口（哪怕它的「默认编码」设置不同）打开同一文件会解出同一份内容，
    改了全局默认也不会把老文件解成乱码。
  * 没有记录时才用设置里的默认编码；`_verify-encoding.js` 的两条断言按新优先级拆成
    「记录优先」与「无记录时默认编码生效」两件事（顺带修好该套件里「显式试读污染记录」的测试顺序问题）。
- **本地历史保留策略进设置**：新增 `historyEnabled` / `historyLimitPerFile` / `historyMaxAgeDays`
  三个设置项（默认开、30 条 / 30 天），主进程在写快照与抽稀时从设置读取；关掉后不再新增快照，
  已有历史仍可查看/回滚。设置面板「通用」页新增一组带开关与两档下拉的项，三语同步（388 键）。
- `tsconfig.node.json` 也开 `allowImportingTsExtensions`（`shared/defaults.ts` 现在会被单测加载，
  它的相对导入按 §4.56 的约定写显式 `.ts`）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（111/111 单测） |
| `node tools/run-suites.js` | 8/8 套件 PASS |
| `tools/_verify-md-fidelity.js` | **73 PASS / 0 FAIL / 17 SKIP**（90 条断言；新增元数据 4 条 + 历史策略 2 条） |

新增断言（都在真实窗口里跑）：窗口 A 用 auto 打开 GBK 文件并落库 → 窗口 B 打开同一文件时
**编码与行尾都与库记录一致**；窗口 B 把「默认编码」改成 windows-1252 后重开，**每文件记录仍然优先**；
关掉历史后连存两次**不再写快照**；上限设为 2 后连存 4 次**恰好剩 2 条**（最新的两条）。

## [Unreleased · 反斜杠转义保留] — Wave 1 头号缺口

> Wave 1 留下的第一号缺口：`\*` 被 markdown-it 的 escape 规则**吃掉**反斜杠，于是
> 「字面星号」往返后变成「斜体标记」—— 语义变了，而信息在解析那一刻就丢了，后面补不回来。

### Added

- **`MdEscape` mark + markdown-it escape 规则替换**（`parse.setup` 钩子，与列表标记保留同一套机制）：
  转义字符渲染成 `<span data-md-escape>\X</span>`，再由 `escape:false` 的 mark **逐字写回**。
  规则照抄上游的三种分支（`\`+换行=硬换行 / `\`+空格=字面反斜杠 / 其余保留 `\X`）——
  漏掉第一种会让「反斜杠硬换行」退化成「字面反斜杠 + 软换行」，整段被并成一行（实测夹具立刻变红）。
- 夹具 `escapes.md` 扩到 6 个边界：非标点反斜杠（`C:\temp`）、`\`+空格、`\`+emoji（代理对）、
  反斜杠硬换行、与粗体/行内代码/链接混排。
- 新夹具 `nested-styles.md` 记录一个**结构性**已知缺口：标记模型是「扁平的」（一个 `mdStyle`
  只能带一个 style 值），所以「粗体里套行内代码/链接」这类嵌套样式表达不出来。

### Fixed

- **`\*`/`\_`/`\#`/`\---`/`\[`/`\\` 现在原样往返**（`escapes.md` 从「已知缺口 lossy」升级为 **exact**）；
  `$$` 公式块里的反斜杠也不再被补成 `\\`（`math.md` 从 lossy 升到 normalized）。
- **孤儿标记字符不再漂移**：`$a * b$` 里那个不成对的 `*` 此前会被写出器补成 `\*`（源码漂移），
  因为「包成字面量标记」那条路径只对**成对**的标记生效（`PATTERN_TEST`）。现在不成对的也走同一条路。
- **转义文本在样式构造里的位置**：`**粗体里的 \* 星号**` 曾被打散成两个 `**…**` 构造
  （输出 `****\*****`）—— 原因是转义文本被当成「其它节点」切断了同样式连续段。
  现在它作为**带样式的 verbatim 文本**参与构造，只是不参与标记派生。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0 |
| `npm run test:unit` | 110/110 |
| `tools/_verify-md-fidelity.js` | **67 PASS / 0 FAIL / 17 SKIP**（31 份夹具；exact 9 / normalized 14 / lossy 8，lossy 全部有 why 与修法） |
| `node tools/run-suites.js` | 8/8 套件 PASS |

## [Unreleased · 工程化收口] — store 拆分与对话框收敛

> 整改方案的最后两项工程债：`files` store 一份承担四件事、`confirmIfDirty` 抄了四份。

### Changed

- **`files` store 瘦身**（703 → 535 行，且抽出来的规则都有单测）：
  * **派生缓存拆成独立 store** `stores/workspaceDocs.ts`：「列表视图」的文章扫描结果与失效世代
    和「当前文档 + 文件树」的生命周期完全不同（它只有一个消费者 `FileList.vue`），拆开后各自演进；
    files store 只在结构变化/保存时调用 `invalidate()` / `bumpMtime()`（单向依赖）。
  * **规则抽成纯函数模块**：`lib/recent.ts`（最近文档/文件夹/置顶的去重·置顶·截断·并入当前工作区）、
    `lib/draftRules.ts`（草稿键与「值不值得端给用户」判定 —— 这块出过三次真 bug）、
    `lib/docText.ts`（未命名文档的编码/行尾、编码显示名、历史时间格式）。
    store 里对应的 action 变成一行「算好 → 落盘」。
  * 单测补 `tests/filesRules.test.mjs`（9 条）。「会被 node --test 加载」的模块改用显式 `.ts` 扩展名
    （Node 的 ESM 解析不做扩展名补全），tsconfig 相应开 `allowImportingTsExtensions`。
- **未保存更改确认收敛成一份**：新增 `lib/dialog.ts`（`confirmDiscardChanges` / `confirmDiscardIfDirty`），
  原先四处各写一遍的 `ui.confirm({ title: t('editor.dirtyConfirmTitle'), ... })`
  （`useAppActions`、`stores/files.ts`、`TreeNode.vue`、`FileList.vue`）全部改为调用它。
  关键设计：该模块**只依赖 ui store 与 i18n**，「脏不脏」由调用方作为参数传入 ——
  于是 store 也能用，不再需要「为绕循环导入复制一份」（那正是当初抄四遍的原因）。
  * 命名说明：整改方案写的是 `services/dialog`，但本仓库的 `services/` 是**主进程**约定，
    渲染层没有这一层，故落在 `lib/dialog.ts`（与 `lib/errors.ts` 同级）。
- `tools/run-suites.js` 头部补一条踩坑说明：**跑套件时不要同时 `npm run build`**
  （实例加载 `out/`，边跑边构建会让它读到半截产物，表现为随机的两三条断言失败）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **110/110**（101 → 110） |
| `npm run ci` | exit 0 |
| `node tools/run-suites.js` | **8/8 套件 PASS** |
| `tools/_verify-md-fidelity.js` | 63 PASS / 0 FAIL / 19 SKIP |
| `tools/_verify-wave3.js` | 19/19 PASS |

## [Unreleased · Wave 3] — 显式意图同步 / 文件树键盘可达 / 原生菜单三语

> Wave 3 是「内核收敛 + 可访问性 + 打磨小刺」。三条都是**删掉猜、改成明说**：
> 编辑器同步不再靠两条会漏判的启发式；文件树不再是"只能用鼠标"；非中文用户按 Alt 不再看到一屏中文。

### Changed

- **编辑器 ⇄ store：显式意图状态机取代两条回声启发式**（手册 §4.54）：
  * 旧写法靠「刚 emit 过的内容相等」+「距 emit < 600ms」猜「这次变化是不是自己的回声」，
    两处明确漏判：按原编码切回来时内容恰好相等 → 被当成回声丢掉（状态栏变、正文不变）；
    刚打完字就恢复草稿/切编码 → 落在静默窗里被丢掉。
  * 现在 **store 明确表态**：凡是要编辑器换内容的动作都自增 `files.syncEpoch`
    （打开文件 / 恢复草稿 / 重新解释编码 / 载入历史）。编辑器只看世代是否变化：
    变了就按新内容 `setContent`，没变就不动编辑器 —— 既不回滚文档、也不重置光标。
  * 顺带去掉每次 modelValue 变化都做**整篇字符串比较**的开销（旧实现的第一条过滤）。

### Added

- **文件树键盘可达（ARIA tree + roving tabindex）**：`role="tree"`/`treeitem`、`aria-expanded`、
  `aria-selected`、`aria-level`、单一可 Tab 行（空闲时也有落点）；`↑/↓` 移动、`→` 展开（已展开则进第一个子项）、
  `←` 收起（已收起则回父项）、`Home/End` 首尾、`Enter/Space` 打开。
  实现放 `lib/treeFocus.ts`（递归组件里用 DOM 顺序当 ARIA 遍历顺序；子项是异步加载的，进子项用轮询而不是单次 tick）。
  键盘焦点有可见描边（`:focus-visible`，鼠标点击不出现）。
- **原生菜单三语**：语言包移到 `src/shared/i18n/`（主进程与渲染层**共用一份**），`main/menu.ts` 全部标签走
  语言包（不再硬编码中文），并在 `settings:update` 里语言变化时**立即重建**菜单；
  加一行 ASCII 自检日志 `[menu] rebuilt lang=… top=…` 供验收脚本读。
- 单测 `tests/menu.test.mjs`（静态自检：菜单里没有硬编码中文、`T()` 的 key 在三份语言包都存在、
  顶层菜单带助记符、三份键集合一致）—— 这条**当场抓出** 4 个漏翻的键（剪切/复制/粘贴/全选）。
- 验收套件 `tools/_verify-wave3.js`（19 条）：意图同步 5 条、文件树键盘 11 条、原生菜单 2 条、工作区夹具 1 条。

### Fixed

- `menu.cut/copy/paste/selectAll` 四个键在语言包里根本不存在（原生菜单会显示英文 key）——
  由新增的静态自检发现并补齐。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **101/101**（97 → 101） |
| `npm run ci` | exit 0 |
| `tools/_verify-wave3.js` | **19/19 PASS** |
| `tools/_verify-md-fidelity.js` | 63 PASS / 0 FAIL / 19 SKIP |
| `node tools/run-suites.js` | **8/8 套件 PASS**（session-last-closed 8/8、md-fidelity 63/82、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 33/33、wave3 19/19） |

### 仍待办

- 工程化：`files` store 拆分（现在 ~700 行）、`confirmIfDirty` 收敛到 `services/dialog`。
- 其余评审缺口：多窗口元数据一致性、历史保留策略可配、Wave 1 的反斜杠转义保留（钩子方案已验证）。
- 仍有约 40 个老套件按 `Symbol(pinia)` 名字取 store（生产构建下会失败），按「改到谁就顺手迁谁」继续收口。

## [Unreleased · Wave 2] — 文档级元数据（编码 / 行尾 / BOM）与本地历史

> Wave 1 之后，评审报告的第二波是「文档级元数据没有模型」这一个根因下的三件事：
> 编码只活在这一进程的 `current` 上、EOL 根本没人管、保存成功即清草稿（一次误保存无法挽回）。
> 本波把它们收进 `documents` 表与一条**写盘前的快照链**。

### Added

- **`src/shared/eol.ts`（纯函数 + 单测）**：`detectEol`（按多数行尾判定）、`toLf`、`toEol`、`hasUniformEol`。
  约定：**内存里的文本永远是 LF**，行尾是文档属性，落盘时才展开 —— 只有一个真相，
  编辑器怎么改都不会污染行尾。
- **文档级元数据落库**：`documents` 表新增 `encoding` / `eol` / `had_bom` 三列并写**迁移**
  （`PRAGMA table_info` + `ALTER TABLE`，与 notifications 的加列方式一致）。
- **老 `fileEncodings` kv 表的一次性迁移**：能对上 `documents` 行的条目搬进表，
  剩下的留在 kv 兜底（文件还没进索引时仍可用），迁完打标记不重复扫。
- **本地历史（数据安全）**：新表 `documents_history` + `shared/history.ts` 的**抽稀策略（纯函数 + 单测）**：
  每文件最多 30 条、超过 30 天且不是该文件最新 3 条就丢、全库封顶 2000 条。
  快照取自**磁盘上现有的字节**（即将被覆盖的那一版），在主进程 `file:write` 里统一记录 ——
  所有写盘路径（保存/另存为/以后的回滚写回）都自动有历史，不依赖调用方记得调用。
- **本地历史界面**：`LocalHistoryDialog.vue` + 文件菜单「本地历史…」+ `window.luminAPI.history`。
  语义是**载入缓冲、不直接写盘**：用户看清了再 Ctrl+S（选错版本也不会毁文件）。
- 文件菜单新增「行尾」二级（以 LF / CRLF 保存）与「以编码保存」二级；状态栏新增**可点的行尾标记**；
  设置面板新增「默认行尾」（只影响新建/未命名文档）。
- 三语新增 11 个键（`statusbar.eolTooltip`、`menu.saveWithEol/eolLf/eolCrlf/saveWithEncoding/localHistory`、
  `settings.defaultEol/defaultEolHint`、`history.*`、`toast.eolChanged/savedWithEncoding/historyRestored/historyNeedsFile`），
  三份语言包键集合保持一致（377 键）。

### Fixed

- **CRLF 文件「打开→动一下→保存」被整文件改成 LF**（git 里就是整文件 diff）：
  现在打开时判定行尾、写回时还原。`_verify-md-fidelity.js` 的 crlf 字节级用例从「已知缺口」变成 PASS。
- **二级菜单可能超出视口，最后几项点不到**：菜单项变多后（本波在文件菜单里加了三项），
  「选择编码重新打开」那 14 项会有一部分渲染到窗口外面。现在二级浮层按「到窗口底部还剩多少」钳高并内部滚动
  （套件新增 `submenu-clamped-to-viewport` / `submenu-item-clickable` 两条断言盯着）。
- `DocMeta` 曾经有两份定义（`shared/types.ts` 与 `main/services/database.ts`），
  现在只保留 shared 那份并再导出，避免同名接口各自漂移。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **97/97**（86 → 97：新增行尾 6 条 + 历史策略 5 条） |
| `npm run ci` | exit 0 |
| `tools/_verify-md-fidelity.js` | **63 PASS / 0 FAIL / 19 SKIP**（82 条断言；新增行尾 6 条 + 历史 6 条，crlf 缺口转 PASS） |
| `node tools/run-suites.js` | **7/7 套件 PASS**（exit 0）：session-last-closed 8/8、md-fidelity 63/82（0 FAIL）、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 33/33 |

### 仍待办（Wave 2 剩余 + Wave 3）

- Wave 2 剩余：状态栏 EOL 与编码的**多窗口一致**（同一文件两个窗口读到同一元数据，已有库表基础，
  还差「打开时以库为准」的取舍）；本地历史的**设置面板开关与保留策略可配**。
- Wave 3：编辑器 ⇄ store 显式意图状态机；文件树键盘可达；主进程菜单三语化。
- 工程化：`files` store 拆分；`confirmIfDirty` 收敛到 `services/dialog`。

## [Unreleased · Wave 1] — Markdown 往返保真

> 上一轮把「Wave 1：Markdown 往返保真套件」列为第一优先，理由是它是**写作工具的信誉底线**：
> 用户打开一份 `.md`、动一下、保存 —— 文件不该变，内容更不该被吃掉。
> 本轮把它做成可复跑的数字，并在过程中查实并修掉了 **7 类内容损坏缺陷**。
> 完整的原理、判级规则、踩坑与已知缺口见手册 §4.52。

### Added

- **判级器** `tools/lib/md-fidelity.js`（纯函数、零依赖）：`exact` / `normalized` / `lossy` 三档，
  规范化只收 18 条「CommonMark 语义上站得住脚」的保义改写（`RULES` 导出，文档可直接引用），
  并给出「规范化到底改了什么」与逐行差异说明。
- **夹具库** `tools/fixtures/md/`：**30 份** Markdown 夹具 + `EXPECT.json` 预期表。
  `EXPECT.json` 即契约：`lossy` 必须写清**为什么**与**修法**（没有 why 的 lossy 等于把缺陷藏进预期）。
- **验收套件** `tools/_verify-md-fidelity.js`：文档级往返（走应用**自己的落盘管线**：
  `TyporaEditor.flushSync`，用 `beforeunload` 同步触发）+ 幂等回归 + 字节级真开真存
  （CRLF / UTF-8 BOM / GB18030 / 文末无换行）；逐份原文与产出落 `%TEMP%\lumin-md-fidelity-report.json`。
- **CDP 公共骨架** `tools/lib/harness.js`：连页面、注入 pinia 访问器（**按结构找**，不按
  `Symbol(pinia)` 名字找 —— 生产构建会压掉 symbol 描述）、键鼠模拟、`--- N/M PASS` 结果汇总。
- **套件统一入口** `tools/run-suites.js`：逐个套件起**全新隔离实例**（套件会改设置/写草稿/动 kv，
  串着跑必然互相污染）、自动带上 `LUMIN_DB`/`LUMIN_DRAFTS_DIR`、汇总矩阵、有 FAIL 非零退出。
- **纯函数** `src/shared/documentText.ts`：文档文本收尾规则与代码围栏长度。
- 单测 `tests/md-fidelity.test.mjs`（判级器自身：每条规则一个同义改写用例 + 反例 + 幂等）、
  `tests/documentText.test.mjs`。

### Fixed（内容损坏类，全部由新套件查实）

- **代码块里出现成对反引号时，一次编辑后整段代码并成一行**：标记模型的「源码权威重推」把
  `codeBlock` 当普通段落（PM 里 `isTextblock` 对代码块也为真），拿代码文本再喂 markdown-it，
  而重推走的 DOMParser 不保留空白 → 换行全塌成空格。现在逐字块（`spec.code`）排除在归一化之外。
- **行内代码里的反斜杠每保存一次多一层**（非幂等增长）：`mdStyle(code)` 正文没有 `escape:false`
  保护。新增 `mdCodeLiteral` mark（空包裹 + `escape:false`）贴在代码样式正文上。
- **软换行被写成行尾 `\`**：`breaks: true` 让 markdown-it 把段内换行渲染成 `<br>` → hardBreak → `\`。
  改为 `breaks: false`（语义从「强制换行」回到「软换行 ≡ 空格」）。
- **无序列表标记被抹平**（`*`/`+` → `-`）、**相邻两个列表之间被插两个空行** → 再解析并成一个
  松散列表，每次保存都在漂。现在解析时记录标记（`parse.setup` 钩子给 `<ul>` 打 `data-bullet`）、
  序列化写回原标记，标记不同时只断行不插空行。
- **任务列表每个任务项之间被塞空行**（`tight` 属性只挂在 bulletList/orderedList 上）；
  `1. [ ] x` 变成「空的有序项 + 无序任务列表」（`ol` 形态没有 parse 规则）。
- **相邻图片被粘成一行、图片后紧跟的标题被吞进同一段**：块级 Image 用了行内序列化器。补 `closeBlock`。
- **内容里含 ``` 的代码块围栏被提前闭合**（后面正文被解析成代码）：围栏长度按内容自适应。
- **序列化产出不含文末换行**：文档文本收尾规则 `withFinalNewline()`，收在
  `markdownStorage.getMarkdown()`（编辑器内容 → 文档文本的唯一出口）。

### Changed

- 编辑器扩展集 `breaks: false`；新增 `listMarkers.ts`（列表标记/紧松）、`markdownTypes.ts`（序列化类型声明）；
  `MdCodeLiteral` 注册位置紧贴 `MdStyle`（最内层 mark 才生效）。
- `tools/_isolated-instance.ps1` → **`tools/start-isolated.ps1`**（标准入口，退出码化、端口判定改 TCP、
  按 8.3 短路径正确杀旧实例、日志按数据目录分文件、必须存 UTF-8 with BOM）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **81/81**（57 → 81） |
| `npm run ci` | exit 0 |
| `tools/_verify-md-fidelity.js` | **50 PASS / 0 FAIL / 20 SKIP**（30 夹具；SKIP = `EXPECT.json` 里写了修法的已知缺口） |
| `node tools/run-suites.js` | **7/7 套件 PASS**（exit 0）：session-last-closed 8/8、md-fidelity 50/70（0 FAIL）、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 31/31 |

### 已知缺口（`EXPECT.json` 逐条写了修法，Wave 2 的起点）

反斜杠转义保留（`\*`）、行内 HTML、表格列对齐 + 单元格转义竖线、公式（应用**没有数学节点**）、
链接包裹的图片、段落中间的图片、有序任务列表编号、YAML front matter、
CommonMark 同标记相邻列表的重编号、CRLF 与文末无换行（字节级）。

## [历史主题汇总] — 1.0.0 之前

> 详细内容见 `docs/typora-wysiwyg-manual.md` 的 §4.x 各节。

- **编辑器内核**：Tiptap v3 + `tiptap-markdown` 装配、光标感知标记符（块级 Decoration / 行内 DOM 类）、
  代码块 CodeMirror NodeView、Mermaid 渲染、表格与任务列表、气泡菜单与工具栏、大纲联动。
- **数据层**：SQLite（`node:sqlite`）+ FTS5 trigram 全文索引 + 全局搜索；自动保存与崩溃草稿；
  会话槽位恢复（关窗 / 重启 / 多窗口）；最近文档与最近文件夹。
- **多窗口模型**：一窗口一文档、「一个文件只开一个窗口」、窗口作用域隔离通知、会话槽位身份。
- **编码**：判定链 + 每文件记忆 + 按编码读写 + 「选择编码重新打开」（含显式替换的强制同步）。
- **Windows 集成**：AppUserModelID、开始菜单快捷方式、任务栏跳转列表、内容寻址的运行期图标。
- **打包与发布**：electron-builder / NSIS 安装器、文件关联、卸载清理、安装实测报告。
- **界面**：三主题、三语言、侧栏三种视图、分段控件、左缘展开把手、设置面板与快捷键系统。
