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

## [Unreleased · UI 三处] — 通知操作按钮移到右侧 / 分屏左栏滚动条贴左 / 分隔条加「抓住」动效

> 用户口径：① 再优化通知的布局、结构与样式，把操作按钮放到**右边**（原来在左边）；
> ② 进入分屏视图时，渲染面（左栏）的滚动条放到**左边**而不是右边；
> ③ 分屏中间拖动比例的组件，鼠标**点上去不要变宽，只是颜色加深一度**。

### Changed

- **通知：操作按钮从「正文下面（左侧）」搬到行内**右侧**。**
  `.ntf-row` 由两列栅格（文本 · 信息条）改成三列（文本 · **操作按钮** · 信息条），
  按钮列右对齐、与标题首行同一条基线（沿用 `align-items: start` 的同一条 20px 起始线，
  不破坏 `_verify-notify-style` 的「信息条与标题首行对齐」断言）；窄窗口允许换行但仍成组靠右。
  实测：内容 320–976、按钮 1000–1147、信息条 1171–1248（窗口右缘 1304 − 内衬 56 = 1248 ✓）。
- **分屏：左栏（渲染面）的滚动条移到左边。** `.editor-scroll` 在 `ui.editorMode === 'split'` 时
  加 `editor-scroll--split-left`：容器 `direction: rtl`（Chromium 里纵向滚动条跟着书写方向走 ⇒ 贴左），
  内容再 `direction: ltr` 复位（否则标点/数字/列表编号的排版方向会跟着翻）。
  滚动条仍占那 6px 布局宽度 ⇒ 两栏正文几何完全不变（实测 pane 520 / 滚动容器 520 / 内容 514），
  两侧滚动条各自贴外缘、中间分界线干净。
- **分隔条：按下时**只把颜色加深一度**（不加宽）。** 把手平时 3×36（`--edge-strong`），
  hover 变 3×56 + `--accent`（宽度始终 3px）；**按下 / 拖拽期间宽度、高度、发光、缩放全都不变**，
  只把颜色从 `--accent` 走到更深一档的 `--accent-ink`（三主题各自的一档，见 `theme.css`）。
  热区仍会从 11px 扩到 23px —— 那是为了好抓，且它的底是**透明**的（`:active` 与 `.dragging` 都撤掉
  hover 的软底），所以视觉上不会出现「点一下就变宽」。
  实测四态：idle 3×36 `rgb(210,213,219)` → **按下 3×56 `rgb(55,65,81)`（= `--accent-ink`）** →
  拖拽中 3×56 同色、热区 23px 透明 → 松开回到 3×36。

### Fixed（顺带：两条「批量跑才出现」的假失败）

- `_verify-surfaces` 的 **T 段主题循环**由 `sleep(900)` 改成轮询：批量跑时主题还没落地就量，
  令牌会**落后一档**（dark 读到 light 的纸色、sepia 读到 dark 的），T2 假红。
  稳定性判据必须同时包含**实际表面色**（body 与两个 pane 的计算色）—— 只等 CSS 变量不够：
  `body` 的 `background-color` 还有 ~300ms 过渡，实测读到过渡中间色 `rgb(19,21,26)`
  而外壳是 `rgb(11,13,18)`，于是「body 就是外壳色」判红。
- 同套件的 **F2**（分屏左栏跟上且账本收敛）也由 `sleep(900)` 改成轮询到条件成立：
  「右栏输入 → 序列化 → 回灌左栏 → 账本收敛」这条链在批量负载下 900ms 走不完
  （实测 `leftHas=false / stale=true`，单独跑 37/37）。轮询只去掉假红、不会造假绿：不收敛仍判红。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 默认矩阵（33 条） | **33/33 PASS**（`NOASSERT 0`） |
| 受影响套件 | `_regress-divider` 4/4、`_regress-split-live` 8/8、`_verify-surfaces` 37/37、`_verify-link-open` 63/63（通知操作按钮）、`_verify-notify-style` 22/22、`_verify-notifications` 32/32、`_verify-toast-tip` 21/21、`_regress-layout` 9/9、`_verify-segmented-control` 16/16、`_verify-cb-virtualization` 9/9 |
| 几何实测（隔离实例 + 截图，临时探针已删） | 见上：通知三列位置、分屏 `direction: rtl` + 内容 `ltr` 且两侧几何不变、分隔条三段状态 |
| 门禁 | `vue-tsc` exit 0、`eslint` 0 error 0 warning、`electron-vite build` exit 0 |

## [Unreleased · 草稿提示改成独立强制弹窗] — 不选「恢复 / 丢弃」就不能编辑这个文档

> 用户口径：取消「检测到未保存的草稿（比磁盘文件更新）」那条提示原来的样式与位置；当文档当前内容
> 与磁盘文件不一样、需要触发这个提示时，改成**单独弹窗**，不做出选择就无法继续编辑此文档。

### Changed

- **形态**：编辑区上方那条内联提示（`.restore-bar` + `.draft-reveal`）整块撤掉，改成挂在
  `EditorView.vue` 的**独立弹窗**（`<Teleport to="body">`，沿用 ModalHost 的对话框语言：半透明遮罩 +
  圆角卡片 + `--shadow-2`）。触发条件**不变**（`files.draftRestore`），变的只是呈现与强制性：
  * `role="dialog"` + `aria-modal="true"` + `aria-labelledby`；
  * 遮罩 `@click.self` **什么都不做**、Esc **不关** —— 必须明确选一个；
  * 打开时焦点给「恢复」（回车即恢复，危险的「丢弃」不占默认焦点），Tab 只在两个按钮间循环；
  * 它**不是通知**：既不进 `NotificationCenter`、也不与通知带混排（那块区域只剩通知）。
- 新增 i18n 键 `editor.draftTitle`（「未保存的草稿」）与 `editor.draftHint`（「选择「恢复」或「丢弃」
  后才能继续编辑这个文档。」），三语同步；`sidebar.css` 里那套横幅样式随之删除。

### Fixed

- **「不选就不能编辑」第一版只挡了键盘，被自己的套件当场打红**：捕获阶段吞 `keydown` 挡不住
  `Input.insertText`（CDP 的文本插入，等同 **IME 组字 / 粘贴**那一类 —— 不产生 keydown），
  文档照样被写进 `BLOCKED`。这正是中文输入法路径上的真实漏洞。改成三层一起挡：
  | 层 | 做法 | 挡什么 |
  | --- | --- | --- |
  | 渲染面 | `editorStore.instance?.setEditable(false)` | 键盘/IME/粘贴/拖放（DOM 层直接拒绝） |
  | 源码面 | `textarea.source-editor` 加 `:readonly` | 源码模式下编辑的就是它 |
  | 事件层 | 捕获阶段吞 `keydown`（放行 Tab/回车/空格）与 `beforeinput / paste / cut / drop` | 兜底 |
- `_verify-draft-banner` 的 `restore-brings-content-back` 由全等改成「去掉结尾换行后相等」：
  序列化会把 markdown 规整成结尾带换行（`# hello draft` → `# hello draft\n`），不是内容差异 ——
  本轮在恢复前多插了一段等待，时序一变就撞上规整后的值（假失败）。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| `_verify-draft-banner` | **27/27**（原 25 + 新增 `modal-blocks-editing-until-chosen`、`modal-esc-does-not-close`） |
| 相邻套件 | `_verify-new-document` 23/23、`_verify-notifications` 32/32、`_verify-notify-style` 22/22、`_verify-toast-tip` 21/21、`_verify-surfaces` 37/37、`_verify-a11y` 6/6、`_verify-i18n` 5/5、`_verify-session` 17/17、`_regress-layout` 9/9、`_verify-local-media` 10/10 |
| 实测（隔离实例 + 截图核对，临时探针已删） | `role=dialog` / `aria-modal=true` / 标题「未保存的草稿」/ 按钮「丢弃 · 恢复」/ 焦点在「恢复」；`.ProseMirror` 的 `contenteditable=false`、源码 textarea `readOnly=true`；整窗截图确认遮罩盖住工具栏与侧栏、卡片居中 |
| 门禁 | `vue-tsc` exit 0、`eslint` 0 error 0 warning、`electron-vite build` exit 0、单测 299/299 |

## [Unreleased · UI 三处微调] — 正文列左右内缩 40→56px / 侧栏底部那一行去掉 / H1–H3 改整枚字形

> 用户口径：① 稍微增加编辑区域内容与左右两侧的间隔；② 由我判断侧栏下方的「设置 / 关于 / 折叠」
> 是否还需要，不需要就优化掉；③ 顶部栏 H1/H2/H3 的字体显示很怪，优化显示样式。

### Changed

- **正文列左右内缩 40px → 56px**：`TyporaEditor.vue` 的 `editor-content` 由 `px-10` 改 `px-14`
  （实测计算值 `40px 56px 160px`）。源码面同步放宽（`.source-editor` 左右 24 → 40px、
  `.source-editor--split` 24 → 32px）；通知带跟着对齐同一列（`padding: 11px 56px 13px`，
  它的「与正文列对齐」断言也改成 56px）。
- **侧栏底部那一行整行删除**（设置 / 关于 Lumin / 收起侧边栏）。判断依据是「三条功能都另有入口，
  且都不是唯一入口」：设置与关于在顶部「帮助」菜单（应用内菜单与原生菜单同源），
  折叠在「视图 → 显示侧边栏」+ `Ctrl+Shift+B`；而**展开**本来就有 `App.vue` 的左缘把手
  （`.sidebar-handle`，指针进左缘热区即滑出）。删除后侧栏只剩「工作区头部 + 文件/大纲」。
  随之删掉 `AppSidebar.vue` 里只服务于那一行的 `collapseSidebar()`、以及已成为死键的
  `sidebar.collapse`（三语同步；`sidebar.expand` 仍被左缘把手使用，保留）。
  `_verify-local-media.js` 的「侧栏收起仍生效」改成驱动**同一条真实入口**（视图菜单项），
  断言的行为（`ui.sidebarVisible === false`）不变。
- **H1 / H2 / H3 改成整枚描边字形**：新增 `heading-1/2/3` 图标（H 与数字**同一套 1.8px 描边**，
  沿用 lucide 的几何），`shared/toolbarItems.ts` 的三个标题项指向它们，工具栏不再额外拼一个
  `<span>` 数字。原因（实测旧写法）：图标是 15px 描边、数字是 10px **粗体**正文，字重/颜色/基线
  三者都对不齐（数字基线偏移 8px、字重 700 对描边 1.8），放大看就是「H 1」两个元素并排 ——
  正是用户说的「很怪」。层级信息仍在 `title` / `aria-label`（「标题 1」）里，可访问性不变。

### Fixed（顺带修掉一条 `--all` 里的既有失败）

- `_verify-sidebar-handle.js` **3/21 → 21/21**：
  * 选择器 `button.absolute.left-0` 早已被更早的侧栏重构换成 `.sidebar-handle`（改用当前选择器）；
  * 三处常量/期望与现设计脱节：热区 `31/33` 是旧版 32px 热区的数（实现已是 `EDGE_SHOW_PX=120` /
    `EDGE_HIDE_PX=200`）⇒ 改成 100/260；把手尺寸 18×48 → **22×56**；「收起只露 4px」→
    现设计是 `translate3d(-100%)` **整体退到窗口外**，断言改为「整块在左边界之外」。
  这条已从 `docs/_audit/coverage-matrix.md` §3.6 的失败清单里划掉。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 几何（隔离实例实测） | `editor-content` padding = `40px 56px 160px`；侧栏 `aside` 内已无「设置 / 关于 / 收起」三个按钮；标题按钮 `span` 数 = 0、`svg` = 1（整枚字形） |
| 截图核对（临时探针，已删） | H1/H2/H3 放大图：三者与相邻的 B/I 图标同一套描边、同色、同基线；整窗图：正文列左右留白变宽、侧栏底部那一行消失、底部只剩状态栏 |
| 受影响套件 | `_verify-notify-style` 22/22、`_verify-local-media` 10/10、`_verify-sidebar-handle` 21/21、`_verify-sidebar-handle-style` 19/19、`_verify-a11y` 6/6、`_verify-segmented-control` 16/16、`_verify-toolbar-settings` 37/37、`_verify-welcome-removed` 34/34、`_verify-inline-formats` 182/182、`_verify-surfaces` 37/37、`_regress-layout` 9/9、`_verify-i18n` 5/5、`_verify-toc-style-scroll` 23/23 |
| 门禁 | `vue-tsc` exit 0、`eslint` 0 error 0 warning、`electron-vite build` exit 0、单测 299/299 |

## [Unreleased · `--all` 全量矩阵复核] — 修掉本轮 E 造成的一条 + 登记其余既有失败

> 收尾动作：`node tools/run-suites.js --all`（68 条：56 PASS / 10 FAIL / 1 SKIP / 1 NOASSERT）。
> 逐条判定「是不是本轮清单 A–J 造成的」，结果写进 `docs/_audit/coverage-matrix.md` §3.6。

### Fixed

- `_verify-welcome-removed.js` **31/34 → 34/34**，两处都在这一条里：
  * **本轮 E 造成的**：C 段断言「工具栏里不再有『打开文件/最近文档』按钮」，但它要求
    `toolbar.found === true` —— 工具栏出厂默认收起后工具栏不在 DOM 里，于是以「找不到工具栏」失败。
    已补「显式打开工具栏」夹具（断言因此仍然在测它本来的东西）。
  * **它自己的 SKIP-as-FAIL**：环境不具备时写的是 `c(name, false, 'SKIP: …')` —— 打印了 FAIL 行，
    运行器按「打印过 FAIL 行」判定 ⇒ 在自己的跳过路径上必然报红（与清单 §1.C 同类）。
    新增 `skip()` 通道，如实打 `SKIP` 行。

### Docs

- `docs/_audit/coverage-matrix.md` 新增 **§3.6「`--all` 全量复核结果」**：10 条 FAIL + 1 NOASSERT
  逐条给出判定与证据 —— 1 条本轮已修（上）、3 条既有（cb-line-numbers：三轮对照复现证明与 B/E 无关；
  sidebar-handle：选择器过期，同题 style 套件 19/19；packaging：本环境跑不了 electron-builder）、
  3 条运行器 dev-server 探测漏判（`open-file-dedup` / `open-file-routing` / `save-as-workspace`
  本该按 §3.1 口径标 SKIP）、2 条待查（`menu-export-submenu` 的 `GROUPS` 遍历、`editor-menu-extras`
  的文件树右键）、1 条 NOASSERT 待修/待删（`rename-fix`）。

## [Unreleased · F 代码块 CodeMirror 虚拟化（O2）] — 不再「每块一个实例」：120 块打开 1070→193ms、CM 120→4

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§2.F 与配套施工图《Lumin-F项实施方案-代码块CM虚拟化.md》。
> 原状：每个代码块一个 Vue NodeView + 一个完整 CodeMirror `EditorView`；500 围栏文档打开 22.8s /
> 常驻 1.4GB，1500 围栏 >185s —— 瓶颈是**块数**不是字符数（纯散文 572k 字符只要 2.24s）。

### Added

- **`src/renderer/src/lib/editor/codeBlockMountPolicy.ts`**：挂载判定（**纯函数** `shouldMountCm()`：
  `视口附近 ∨ 选区所在 ∨ 刚点过`）+ 一个**共享的** `IntersectionObserver`（`CODE_MOUNT_MARGIN_PX = 600`，
  按块登记/注销）。观察根用默认视口 —— IntersectionObserver 的相交矩形会被祖先裁剪，分屏下也准，
  不必给两个 pane 各建 observer。没有 `IntersectionObserver` 的环境直接放行（宁可不省，不能不可编辑）。
- **`tools/_verify-cb-virtualization.js`**（9 条，已进默认矩阵）：60 块文档里 `.cm-editor` ≤ 12、
  视口内三块必挂、滚到第 40 块才挂且高度漂移 ≤ 20%、滚过后挂载数仍小、**选区落进屏幕外的第 55 块
  必须强制挂载**、来回滚（挂/卸 churn）之后第一块仍**可打字**（同时守「卸载丢字符」与
  「`hasFocus` 守卫计数不归零」两条风险）、换文档后旧块全卸且新文档照常。

### Changed

- **`CodeBlockView.vue` 三态**：mermaid 态（不变）/ **已挂载态**（视口附近、选区所在或刚点过）/
  **静态态**（`<pre class="cb-static">` 等宽文本 + CSS 行号，**不建 CM**）。
  挂载条件变化由 `watch(cmMounted)` 驱动；**卸载顺序**是
  `syncToNode()`（先落盘最后几个字符）→ `teardownCm()` → 记高度 → 静态态 `minHeight` 固定 →
  `unregisterCodeBlockHandle()`（否则 `findCodeBlockHandle` 会命中没有 CM 的块）。
  离开视口附近**延迟 500ms** 才卸（来回滚一点不该反复挂/卸）；点静态块会挂上并把光标交给 CM
  （事件**不** `preventDefault`，让 PM 先把光标放进块里 ⇒ 选区条件也成立）。
- **静态态与 CM 同一套排版**（`overlays.css` 的 `.cb-static`：12.5px / `--font-mono` / 1.65 /
  `padding: 10px 4px 14px`，行号走 `.cb-static-gutter`），配合 `minHeight` ⇒ 挂/卸切换高度几乎不差。
- **`keymap.ts`（P0 / 风险 R1）**：「代码块后空段行首 Backspace」原来**找不到句柄也 `return true`**
  （按键被吃掉）—— 虚拟化后「屏幕外的块没有句柄」是常态，已改成 `if (!handle) return false`。
- 两条既有套件的**契约更新**（它们原来假定「代码块一定有 CM」）：
  * `_verify-surfaces.js` 的「代码块走 CM 渲染」改成**接受两种形态**（远块是静态态，等宽字体仍成立）；
  * `_verify-cb-languages.js` 改成**逐个围栏滚进视野再量**（否则量到的是一堆静态态 ⇒ 假失败），
    并顺手把「等语言 chunk 到位」也并进轮询（原来只等挂载，会读到未配语言的空文档）。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| **前后对比**（同一机器/探针，每个状态新建隔离 profile） | 120 围栏（≈7k 字符）：打开 **1,070ms → 193ms**、CM 实例 **120 → 4**；180 围栏（≈10.5k 字符）：打开 **9,101ms → 184ms**、CM 实例 **180 → 4** |
| 默认矩阵（33 条，含新套件） | **33/33 PASS**（`NOASSERT 0`；另有 4 条断言按环境如实 SKIP） |
| 代码块相邻面 | `_regress-cb` 3/3、`_verify-cb-button-line-numbers` 26/26、`_verify-cb-languages` 5/5、`_regress-layout` 9/9、`_regress-source-roundtrip` 4/4、`_repro-rapidenter` 4/4、`_verify-md-fidelity` 101/102、`_verify-toc-style-scroll` 23/23、`_verify-surfaces` 37/37、`_verify-surface-stress` 72/72 |
| `vue-tsc` / `eslint` / `electron-vite build` | exit 0 / 0 error 0 warning / exit 0（`EditorView-*.js` 2,477.59 kB） |
| 单测 | 299/299 |

**未做（如实记录）**：施工图的 **P2「静态态也做语法高亮」**。理由：挂载边距 600px（约两屏），
静态块在正常阅读中基本不会出现在屏幕上（只有快滚时一闪）；真要做就用 Lezer 解析器 + `highlightTree`
生成静态 HTML，不为高亮再建 CM 实例 —— 留作独立一步。
另：`heavyMode`（≥200 围栏自动降级源码模式）**保持不变**，虚拟化之后这个阈值原则上可放宽
（方案 §6 提到 200 → 800），但那是一次独立的行为取舍。
回滚点：`shouldMountCm()` 改成恒真即回到旧行为；`UNMOUNT_DELAY_MS` / `CODE_MOUNT_MARGIN_PX` 两个常量。

## [Unreleased · H 文档体系拆分] — 手册按章拆、CHANGELOG 归档老轮次、台账分离已完成

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§2.H。原状：`docs/typora-wysiwyg-manual.md`
> **3,934 行**、`CHANGELOG.md` **2,581 行**、`docs/optimization-program.md` 台账 **501 行** ——
> 人类已经很难在里面找到「现在到底是怎么实现的」。

### Changed（三处都是**逐字节搬运 + 行数守恒校验**，没有改写内容）

- **手册**：`docs/typora-wysiwyg-manual.md` 变成**索引**（标题 + 引言 + 指向各章的目录），
  正文按章拆到 `docs/manual/`：`01-design`(82) / `02-core-internals`(85) / `03-interactions`(205) /
  `04-pitfalls`(841) / `05-plan`(91) / `06-engineering`(33) / `07-roadmap`(34) / `08-appendix`(2540)。
  校验：各章合计 3,911 行 + 索引前半段 23 行 = 原文 3,934 行 ✓。
  **章节内部的小节号（§4.23 之类）一字未动**，所以 CHANGELOG / 台账里「见手册 §4.23」这类引用仍然有效。
- **CHANGELOG**：主文件只留「基线 `[Unreleased]` 段 + 最近 8 轮」（352 行），较老的 **40 轮**（含
  「历史主题汇总」）搬到 `docs/changelog/archive-01.md`（2,228 行），主文件末尾留一行指路。
- **台账**：`docs/optimization-program.md` 只留「现状台账 + Wave 4/5 + 需要拍板 + 明确不建议做的」，
  Wave 1 – Wave 3.2 及之后各轮的已完成记录（410 行）搬到 `docs/_audit/done.md`，主文件留指路。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 行数守恒 | 手册 3,911 + 23 = **3,934 ✓**；CHANGELOG 主文件 353 行 + 归档 2,228 行（+ 表头）✓；台账 54 + 410 + 37 + 指针 = **501 ✓** |
| `tests/docsClaims.test.mjs` | 活文档集合改为「README + 手册索引 + **`docs/manual/*.md` 8 个分片** + 台账」——只扫索引会漏掉各章引用的路径；实测无缺失路径 |
| 单测 | **299/299**（含编码门禁与路径存在性） |
| 引用有效性 | 手册各章标题号不变 ⇒ CHANGELOG/台账/代码注释里「见手册 §4.xx」的引用不需要改 |

## [Unreleased · I tools/ 收口：0 断言脚本清空 + 常驻探针定编 + 默认矩阵 26→32]

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§2.I。原状：`tools/` 178 文件 / 31,896 行
> （比 `src/` 还大），其中 14 个 `_probe-*` 里不少是一次性调试脚本，`--all` 里还混着 0 断言探针。

### Removed（15 个文件）

- **0 断言脚本 7 个**（功能在别处有覆盖，逐条核对过）：`_verify-3tasks`（老 UI 的菜单/toast/重命名 →
  `_verify-editor-menu` / `_verify-notifications` / `_verify-new-document` / `_verify-rename`）、
  `_verify-backspace-enter-cb`、`_verify-bs-md`、`_verify-cb-delete-fix`、`_verify-cb-typing`、
  `_verify-cb-typing2`、`_verify-cb-typing3`（代码块打字/回车/退格 → `_regress-cb` +
  `_verify-inline-formats` + `_verify-surfaces`）。后三个在矩阵里本来就会崩（要求外面先摆好文档）。
- **一次性探针 8 个**：`_probe-cjk-flank`、`_probe-fixture`、`_probe-four`、`_probe-paste`、
  `_probe-taskA`、`_probe-taskB`、`_probe-fences-hot`、`_probe-fences-hot2`
  （对应的问题都已修好并有套件守着；取证结论都留在 CHANGELOG/手册里）。
- `_verify-toc-load`：内容并进升级后的 `_verify-toc`（见下）。

### Added / Changed

- **`_verify-toc.js` 从「0 断言探针」升级为 7 条断言的 harness 套件**（TOC 在本仓库没有别的覆盖，
  所以按「先升级、再归档原始探针」办）：插入目录建节点 / 渲染三个标题链接 / 点击跳转把光标落到目标标题
  （判据是「光标所在块是 heading 且邻近文本是该标题」，不再赌固定偏移）/ markdown 往返仍是 `[TOC]` /
  重载 `[TOC]` 还原为目录节点 / **围栏代码里的 `[TOC]` 必须保持字面文本**（新的边界断言）。
- **默认矩阵 26 → 32**（把有价值的旧套件从 `--all` 提上来）：`_verify-toc`(7)、
  `_verify-notifications`(32)、`_verify-toolbar-settings`(37)、`_verify-cb-languages`(4)、
  `_verify-mermaid-gate`(4)、`_verify-neutral-accent`(10)。
- `tools/README.md`：把 **6 个常驻测量工具**列成表（`_probe-startup` 冷启动/RSS、`_probe-perf`
  每键耗时、`_probe-fences-total` 2000 围栏 CPU 归因、`_probe-modeswitch` 切面耗时、
  `_probe-cpu-top` profile 聚合、`_probe-md-baseline` markdown-it 对照基准），并写明「这些别删」。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 默认矩阵（32 条） | **32/32 PASS**（另有 4 条断言按环境如实 SKIP；`NOASSERT 0`） |
| `_verify-toc.js` | **7/7**（新增的「围栏内 `[TOC]` 保持文本」也通过） |
| `tools/` 体量 | 文件 145 → 128、`_verify-*` 76 → 68、`_probe-*` 14 → 6（保留的 6 个已登记为常驻工具） |

## [Unreleased · J 覆盖台账同步] — 矩阵条数/新增与删除/NOASSERT 与 SKIP 口径

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§2.J。台账（`docs/_audit/coverage-matrix.md`）
> 没跟上这几轮的变化：新套件、复活/删除的套件、`NOASSERT` 与 SKIP 口径都没记。

### Docs

- §3.1 A/B 两段重写：默认矩阵 **32 条**（逐个点名）+ 「从 `--all` 提上来的 6 条」+ 实测 32/32；
  `--all` 侧改为「42 个有真断言但不在默认矩阵」并注明**完整清单以 `run-suites.js --all` 为准**
  （不再手工维护一份必然漂移的长名单）；`_verify-notify-restart` 记入 `MANUAL` 排除的理由。
- 0 断言那段的 ⚠️ 改成 ✅：**NOASSERT 已是硬门禁**（零断言 = 整轮失败），那批探针已删/升级。
- §3.2「建议纳入矩阵」勾掉本轮已纳入的 6 条；§3.4 新增/更新两行口径（假绿已修、SKIP 不再算失败）；
  §3.5 增加「已完成（2026-09 收口）」小节，写清删了哪些、保留哪些、为什么。

## [Unreleased · O3 语言包收窄] — 删掉 `@codemirror/language-data`，改 15 项显式映射（构建 −0.98MB）

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.B（自查报告 O3）。原状：`CodeBlockView.vue`
> 用 `languages` 表找 `load()` —— 那张表覆盖 115 种语言，构建产物里留下 **116 个 `import()` 目标
> （实测合计约 1.6MB）**，而组件自己的语言清单只有 15 种（+ mermaid 走预览）。

### Changed

- **显式映射表**（`components/editor/CodeBlockView.vue`）：14 种走 `@codemirror/lang-*`
  （javascript / typescript / python / html / css / json / sql / java / go / rust / cpp / php / yaml），
  `bash` / `ruby` 走 `@codemirror/legacy-modes/mode/{shell,ruby}` + `StreamLanguage.define()`；
  另加 `LANGUAGE_ALIASES`（`js/jsx/mjs/cjs/ts/tsx/py/htm/xml/svg/sh/shell/zsh/console/yml/c++/cc/cxx/h/hpp/golang/rb/mysql/postgres/sqlite`）
  与原 `language-data` 的别名口径对齐；认不出来的语言**如实退回纯文本**（与原行为一致）。
- **取舍写进代码注释**：从此只高亮这 15 种（清单外语言按纯文本渲染）——这正是清单 §3
  点明的「要么省体积、要么保留任意语言」二选一，用户口径是「需要单独排期的全部同意」，故按文档收窄。
- `package.json`：删 `@codemirror/language-data`，把 13 个原本只作为它传递依赖的包（12 个 `lang-*` +
  `legacy-modes`）**升为直接依赖**（版本取当前已装版本）；`package-lock.json` 的根依赖集合同步。
  ⚠️ 本环境**禁止 npm 联网**（`EALLOWREMOTE`，npmmirror 被策略挡住），所以 lock 是用一次性脚本
  离线对齐根 entries 的（这些包本来就在 lock 树里）——`tests/lockfile.test.mjs` 6/6 通过，
  `npm ci` 所需的三条一致性（根集合一致 / 声明项在树里 / 无悬空引用）都成立。

### Added

- `tools/_verify-cb-languages.js`（4 条）：**22 个围栏（15 种语言 + 7 个别名）逐个必须有高亮 span**
  （CM 的 HighlightStyle 生成的 `<span class="ͼ…">`）、清单外语言（`text` / `makefile`）**必须没有**
  span（证明是「如实退化成纯文本」而不是静默停摆）、语言选择框仍是 16 项。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 构建产物 | JS 文件 **191 → 89**（−102 个 chunk）；总体积 **11.56MB → 10.58MB（−1,002KB）**；`EditorView-*.js` 2,509.13 → **2,472.47 kB** |
| `_verify-cb-languages.js`（新增） | **4/4** |
| 代码块回归 | `_regress-cb` 3/3、`_verify-cb-button-line-numbers` 26/26（本套件整条链路点工具栏按钮 ⇒ 补了「显式打开工具栏」夹具）、`_verify-md-fidelity` 101/102（1 条按环境 SKIP）、`_verify-surface-stress` 72/72 |
| `tests/lockfile.test.mjs` / `vue-tsc` / `eslint` | 6/6 / exit 0 / 0 error 0 warning |

**顺带查清的两条既有失败（与 B/E 无关，已登记到清单 §2.I）**：
`_verify-cb-line-numbers.js` 8/13（设置面板里的开关「真实点击」不生效，5 条断言连带失败）——
用「把工具栏默认值改回 true」与「stash 掉 B 的改动」两次对照复现，确认它与本轮两项改动都无关；
`_verify-cb-typing2.js`（0 断言老脚本，硬编码外部工作区路径）报 `no cm`。

**顺带修掉编码门禁的一个假阳性**（`tests/encodingGuard.test.mjs`）：它剥代码块用的是
`` /```[\s\S]*?```/g `` —— 正文里只要**提到**一次三个反引号（本轮 CHANGELOG 写了
「只要看到 ```mermaid 就加载」），后面所有围栏的配对就整体错位，本该剥掉的历史乱码引用
漏成「正文」并报假 mojibake。改成按**行首**配对（允许缩进）：`` /^[ \t]*```[\s\S]*?^[ \t]*```/gm ``。

## [Unreleased · E 快捷工具栏默认收起] — 写作面优先（清单 §1.E 选项②）

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.E（报告里列为「需要拍板」，用户口径是
> 「需要单独排期和拍板的全部同意」，故按文档给出的选项 ② 实现）。

### Changed

- `src/shared/defaults.ts`：`toolbarVisible: true → **false**` —— 本产品是「纸面优先」的写作工具，
  最显眼的那条 44px 常驻 chrome 恰在正文上方；而它承载的动作**三处重复**（快捷工具栏 /
  编辑器右键菜单 / 顶部菜单栏），收起来不丢功能。三条重新打开的入口都在：视图 → 显示快捷工具栏
  （应用内 + 原生菜单 `toggle-toolbar`）、设置 → 编辑器 → 快捷工具栏、工具栏空白区右键（栏在时可见）。
  **已存在的用户设置不受影响**（落在 kv 里，只有全新 profile 才拿到新默认值）。
- `tools/lib/harness.js` 新增 `showToolbar(app)`：打开工具栏并**等它真的挂上**
  （返回是否等到）。运行器给每个套件用的都是全新 userData，所以「默认收起」每个套件都会生效。
- 夹具显式打开工具栏（用 `showToolbar` 或各自的 store 访问器）：
  `_regress-layout` / `_regress-divider` / `_regress-source-roundtrip`（用 `clickMode` 切面）、
  `_verify-find-replace`（源码面用例）、`_verify-inline-formats`（整套在点工具栏按钮）、
  `_regress-split-live`（模式分段控件 + 几何）、`_verify-segmented-control`、`_verify-bars-no-filename`。
- `tools/README.md` 补两条规矩：要量工具栏的套件必须 `await showToolbar(app)`；SKIP 不算失败。
- `tests/toolbarItems.test.mjs` 的默认值断言改为 `false`（并写明为什么是刻意收起的）；
  README 的功能清单、`docs/_audit/i18n-and-settings.md` 的设置矩阵同步。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| `tests/toolbarItems.test.mjs` | 13/13（默认值断言已翻转） |
| 工具栏相关套件 | `_verify-segmented-control` 16/16、`_verify-bars-no-filename` 12/12、`_verify-inline-formats` 182/182、`_regress-split-live` 8/8、`_verify-toolbar-settings` 37/37、`_verify-find-replace` 24/24 |
| 默认矩阵全量（26 条） | 第一轮暴露 3 条真回归（`_regress-layout` 6/9、`_regress-divider` 0/1、`_regress-source-roundtrip` 3/4 —— 全是「用工具栏分段控件切面」的夹具）→ 补夹具后 **26/26 全绿** |
| `eslint --cache .` | 0 error 0 warning |

## [Unreleased · O1 mermaid 按需（视口门 + 干掉首屏预加载）] — 远处不渲染，`mermaid.core` 不再首屏取

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§2.G。原状：`CodeBlockView.vue` 的 `onMounted`
> 只要看到 ```mermaid 就 `import('mermaid')` 并渲染 —— 哪怕块远在屏幕外。

### Changed

- **视口门**（`components/editor/CodeBlockView.vue`）：用 `IntersectionObserver`
  （`rootMargin: 200px`）把「import + 渲染」推迟到块**进入视口附近**才发生；门未开时块内是
  **源码占位**（`.mermaid-placeholder`，等宽淡色、可点击进源码编辑），所以块始终有高度、
  不会是个空洞，放行后 SVG 一到位就替换。容器带 `data-mermaid-gated="pending"` 便于验收。
  提前 200px 放行 ⇒ 「源码→图表」的高度变化发生在**屏幕外**，正常滚动看不到跳动。
  导出不受影响（那条路走 `renderMermaidInHtml(html)`，与编辑器视图解耦）。
- **干掉首屏预加载**（`electron.vite.config.ts`）：实测**Vite 默认的 modulePreload 会把
  `mermaid.core`（1.23MB）在首屏就取**（路由 chunk 的「动态 import 依赖」被插成
  `<link rel=modulepreload>`，与文档里有没有 mermaid 块无关）——这跟「mermaid 按需」的初衷相反。
  现在 `build.modulePreload.resolveDependencies` 把 `mermaid` / `cynefin` / `cytoscape` 一族
  从预加载依赖里剔掉，真正需要时由 `import('mermaid')` 现取。

### Added

- `tools/lib/harness.js`：`watchEvents(app, onEvent)` —— 订阅 CDP **事件**（原来的句柄只处理带 id
  的响应）。用于验证「某个懒加载 chunk 到底有没有被取」这类页面侧看不到的事。
- `tools/_verify-mermaid-gate.js`（4 条）：① 远处块不渲染（无 `svg` + `pending` + 有占位）；
  ② 启动后 `link[rel=modulepreload]` 里**不含** mermaid 一族；③ 滚入视口后渲染出来、占位被替换；
  ④ chunk 变成「滚入才取」。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| `_verify-mermaid-gate.js`（新增） | **4/4** |
| mermaid 既有回归 | `_verify-mermaid-blur.js` 22/22、`_verify-mermaid-cross-block.js` 18/18 |
| 代码块回归 | `_regress-cb.js` 3/3、`_verify-math.js` 7/7 |
| `vue-tsc` / `eslint` / `electron-vite build` | exit 0 / 0 error / exit 0（`EditorView-*.js` 2,509.13 kB） |

**过程中查清的两件事（如实记录）**：
1. 页面侧的 `performance.getEntriesByType('resource')` 在本应用里**恒为空**（实测 `resTotal=0`），
   用它写「没有取某个 chunk」这种否定断言会**永远通过**（假绿）——已改为读
   `link[rel=modulepreload]`（可靠）+ CDP 事件（只作参考：`file://` 下 Network 事件并不完整）。
2. 顺带发现 `tools/_verify-cb-typing.js`（老式 0 断言脚本，要求外面先摆好一份带代码块的文档）
   在矩阵里会直接崩（`Cannot read properties of null`）——**与本次改动无关**，已登记到清单 §2.I
   （老脚本迁移/归档）一起处理。

## [Unreleased · S3 第一期] — `lib/editor/defer.ts`：把「躲开 PM 事件顺序」的延后一拍收口

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.D 第 1 步（自查报告 S3）。编辑器里有一批
> `setTimeout(fn, 0)` 不是防抖也不是节流，而是「必须等 ProseMirror 自己那一轮处理跑完」；
> 它们散在十几处，每处都要重读注释才敢改。

### Added

- **`src/renderer/src/lib/editor/defer.ts`**：`deferAfterPmEvent(fn) => cancel`。模块头把两类
  真实约束写清楚了：① 同步 dispatch 会被 PM 自己的 MouseUp/Blur 处理覆盖（实测：点行尾空白时
  `posAtCoords` 给出块尾，最终光标停在收尾 `**` 之前）；② 松手瞬间 `.pressHidden` 解除、
  显隐装饰重算、整行左右移动，所以**判据同步量、落点延后写**。文件里同时写明
  **不能用微任务替代**（`queueMicrotask`/`Promise.then` 仍在本轮 PM 事件内）。
- `tests/defer.test.mjs`（4 条）：同步阶段不执行 / 顺序是「同步 → 延后」/ 连续两次
  `await Promise` 仍未执行（证明微任务不能替代）/ `cancel()` 撤销后永不执行。

### Changed

- 已收口到 `deferAfterPmEvent()` 的三处（「新写的 + 下次改到的」口径，不全量替换）：
  `lib/editor/pointer.ts`（点击链接 → 展开源码）、`lib/editor/typoraInlineMarks.ts`
  （`handleDOMEvents.mouseup` 的拖选撑标记 + 行尾落点）、
  `components/editor/TyporaEditor.vue`（`onCreate` 后的 `normalizeMdMarkers()`）。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 单测 | 295 → **299/299**（新增 4 条） |
| `vue-tsc` / `eslint` | exit 0 / 0 error 0 warning |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,507.58 kB） |
| 编辑器内核套件 | `_verify-drag-selection` 10/10、`_verify-line-end-click` 7/7、`_verify-marker-hold` 11/11、`_verify-inline-formats` 182/182、`_verify-find-replace` 24/24、`_verify-round-24` 15/16 SKIP 1 —— **6/6 全绿** |

## [Unreleased · 套件诚实性三处（清单 §1.C）] — SKIP 不再算失败 / 主题切换改轮询 / 剪贴板先哨兵校验

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.C。三处都是「信号不诚实」：要么把正常的 SKIP
> 判成红灯，要么让机器负载决定成败，要么让真实剪贴板混进结论。

### Fixed

- **C1 SKIP 被当成 FAIL**（`tools/run-suites.js`）——判定原来有两处会把 SKIP 算成失败：
  ① `--- N/M PASS` 里的 M 是**断言总数**（含 SKIP，`Reporter.total = passed + failed + skipped`），
  老写法 `fail = M - N` 于是把 SKIP 当失败；② 状态判定用 `skipped || (code===0 && fail===0)`。
  实测后果：`_verify-md-fidelity.js`（101/102）、`_verify-round-24.js`（15/16）、
  `_verify-theme-auto.js` 退出码 0、FAIL 0，却**每轮报红**。现在：优先认三数分开写的
  `TOTAL … FAIL … SKIP …`；退到老格式或 `--- N/M PASS` 时用 **SKIP 行数**从 M 里扣掉；
  状态只看「退出码 + FAIL 行」，SKIP 单独在行尾显示（`PASS x/y SKIP n`），并在一轮结束时
  汇总「另有 N 条断言按环境如实 SKIP —— SKIP 不算失败」。
- **C2 批次敏感**（`tools/_verify-sidebar-tree-style.js`）——主题循环原来是
  `set('theme')` + **固定 `sleep(900)`** 就读计算样式；批量跑（机器更忙）时会读到上一套主题的颜色，
  实测单独 32/32、批量 29/32。改成**轮询双条件**：`<html>` 的 `theme-*` 类到位 + `--paper`
  真的换了 + **关键颜色连续两次采样相同**（侧栏/行/body 都在 `transition: background-color` 上，
  只等变量变会读到**过渡途中的插值色** —— 这正是先前 30/32 里 `sel`/`body` 仍是上一套值的原因）。
- **C3 系统剪贴板污染**（`tools/_verify-inline-formats.js`）——粘贴夹具依赖**真实剪贴板**，
  批量和单独跑结果不同（179/182 vs 182/182）。现在：① 开头写一个**哨兵值**并读回校验，
  确认读写通路可用；② 每次 `writeClipboard(md)` 后**读回比对**，不一致就 `SKIP` 并注明是环境问题
  （不再把它算成「编辑器丢字符」的假回归）。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 三个曾被记红的套件 | `_verify-round-24.js` **PASS 15/16 SKIP 1**、`_verify-md-fidelity.js` **PASS 101/102 SKIP 1**、`_verify-theme-auto.js` **PASS 11/11**（改前均记 FAIL） |
| 靶子验证（临时假套件，已删） | 故意打印 `FAIL` 并 `exit 1` 的假套件仍被记 **FAIL**；零断言的假套件仍被记 **NOASSERT** —— 放宽 SKIP 没有削弱另两道闸 |
| C2 | `_verify-sidebar-tree-style.js` 单独 **32/32**；风格批次（surfaces 37 / neutral-accent 10 / tree-style 32 / toc-style-scroll 23 / segmented-control 16 / a11y 6）**6/6 全绿** |
| C3 | `_verify-inline-formats.js` **182/182** |

## [Unreleased · S4 数据库版本化迁移] — `services/migrations.ts` + 临时库单测

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.A（自查报告 S4）。原状：163 行顺序幂等 DDL
> 散在 `database.ts`，末尾挂着一次性迁移 `migrateFileEncodings()` —— 能用，但**没有版本号**，
> 无法表达「这一步只在 v2→v3 时跑」，也看不出某个库落在哪一版。

### Changed

- **新增 `src/main/services/migrations.ts`**（264 行）：`SCHEMA_VERSION` / `MIGRATIONS` 步骤表 /
  `readSchemaVersion(db)` / `runMigrations(db)`。从 `user_version + 1` 开始依次执行未跑过的步骤，
  **每步成功后就地写下版本号**（崩溃后重跑只重做未完成的那一步）。此后新增改动一律追加一步，
  形如 `{ version: 2, up: (db) => … }`，对更老的库天然生效。
  - ⚠️ 该文件**不 import electron**（只吃 `node:sqlite` 的 db 句柄），所以单测能直接建临时库跑它。
  - 原有 DDL 原样收成 **migration 1**（保持幂等 ⇒ 对老库/新库都安全），**SQL 语义一字不改**：
    尤其 `DELETE FROM notifications WHERE scope = ''` 那条一次性清理与 FTS 的 trigram 检查都保持原样。
  - `migrateFileEncodings()` 也搬进 migration 1（它本来就是一次性迁移的形态），
    内部自带的 kv 读写（`kvGet`/`kvSet`）与 `LuminDatabase` 的同名方法**同语义**。
- `database.ts`：删掉 `migrate()` 与 `migrateFileEncodings()`（−185 行，1089 → 904），
  constructor 改调 `runMigrations(this.db)`，首次迁移时打一行 **ASCII** 日志
  `[db] schema migration: v0 -> v1`（主进程 console 必须是 ASCII，见 `tests/mainConsoleAscii.test.mjs`）。
- **唯一一处行为差异（如实记录）**：FTS「空表重建索引」原来**每次启动**都检查一次，现在只在
  migration 1 里跑一次 —— 语义等价：那次重建只在「FTS 表被 DROP 重建」时才有意义，而
  DROP/CREATE 本身就发生在 migration 1 内；将来若再换分词器，会作为新的一步迁移做同样的重建。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tests/migrations.test.mjs`（新增，`node:sqlite` 临时库） | **4/4**：① 空库 → `user_version=1`、六张表 + FTS(trigram) + documents 三列元数据全在；② 重复跑 4 次幂等不抛错；③ 老库（documents+kv+无 scope 列的 notifications）→ 补齐 `actions/payload/scope`、无归属老通知被清掉；④ kv `fileEncodings` → `documents.encoding`（路径小写+反斜杠归一）、对不上的条目留在 kv、`fileEncodingsMigrated` 打标记、再跑不覆盖 |
| 单测总量 | 291 → **295/295** |
| `vue-tsc` / `tsc -p tsconfig.node.json` | exit 0 / exit 0 |
| `eslint --cache .` | **0 error / 0 warning**（新增文件按 prettier 规整过） |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,507.47 kB 不变） |
| 真库路径回归 | `_verify-notify-disk.js` 8/8（直读 `lumin.db` 的表/列/索引）、`_verify-encoding.js` 34/34（文档级元数据）、`_verify-session.js` 17/17 |

---

> 更早的 40 轮已经归档到 [`docs/changelog/archive-01.md`](docs/changelog/archive-01.md)
> （清单 §2.H：主文件只留基线 + 最近若干轮）。
