## [Unreleased]

### Added

**设置：隐藏行内标记字符（`hideInlineMarkers`，默认关 —— 用户口径）**

- 用户原话：「设置内容是是否显示例如加粗 `**` 这样的字符，默认开启（按钮显示关闭），
  用户开启后不展示这样类似的字符。」**措辞判断**：取「默认仍然显示、开关打开才隐藏」——
  同一句里的「按钮显示关闭」与「默认开启」只有按这个读法才自洽（把"默认开启"读成默认隐藏会
  与它自己后半句冲突，也会让所有老用户升级后突然看不到 `**`）。所以设置项名是
  「**隐藏**行内标记字符」，`boolean`，默认 `false`。
- 位置：**设置 → 编辑器 →「编辑行为」卡片**（`syncScroll` / 代码块行号那一栏），
  三语都有键（`settings.hideInlineMarkers` / `…Desc`），开关按 `data-setting-hide-inline-markers`
  取稳定锚点（CDP 套件不按本地化文字找控件）。
- 语义：打开后所见即所得里**任何情况下**都不再显形成对标记（`**`/`*`/`~~`/`` ` ``），
  包括光标落进构造、选区紧贴两端 —— 只影响**显示**，标记仍是文档里的真实文本，
  保存 / 导出 / 往返**一个字节都不变**（套件里有字节断言）。
- 实现：显隐本来就只由 `typoraInlineMarks` 的装饰层决定 ⇒ `buildRevealDecorations` 在开关
  打开时不再推 `.md-reveal-inline`（标记停在 CSS 默认的 `font-size: 0` 折叠态：零占位、
  文本节点仍在、光标照旧可导航）。**不返回空集**：同一个函数还产出转义反斜杠的拆分 span
  （`.md-escape-backslash` / `.md-escape-char`），少了它 `\*` 的反斜杠会露在正文里、Windows
  路径那种非标点转义还会少字符。手势逻辑（冻结/去墨）在隐藏态自然失效
  （`pressOnRevealedRun` 直接返回 false），不留"永不显形却还在去墨"的怪状态。
- **改设置立刻生效**，不用重开文档：设置 store 的 `applyAll()`（覆盖启动 / 本地改 / 主进程改 /
  导入 / 恢复默认五条路径）把开关推给新的零依赖桥 `lib/editor/markerVisibility.ts`，
  内核收到通知后 dispatch 一个带 `SET_MARKERS_HIDDEN` 元数据的空事务让装饰重算
  （与「查找命中」「按住/松开」同一套机制）。走桥而不是让 store import 内核：后者会把
  整份 ProseMirror 钉进首屏 entry chunk（`findBridge.ts` 当初就是这个理由）。
- **口径边界**（写进 `shared/defaults.ts` 与内核注释）：**字面量标记**（未配对 / 切段残留的
  `*`，`data-side='literal'`）与**转义反斜杠**（`\*`）**不在**这个开关里 —— 前者是用户正文
  （藏起来等于丢字符），后者的折叠/拆分是同一条渲染结构、且非标点转义必须常显。
  块级标记（`#` 标题前缀、`>` 引用符，`markers.ts`）也不在这一轮口径里。
- 验收（先确认**会红**、重建后转绿）：`tools/_verify-inline-formats.js` 新增 N 段 8 条 ——
  修前 **198/204**（6 条 FAIL 全是 N 段：开关不存在、打开后仍显形 `revealed:2/w:15`、
  正文没左移、没落库、光标来回仍显形），修后 **204/204**；另有 `tests/settingsDefaults.test.mjs`
  钉住「默认必须仍是照旧显示」（老 profile 缺键 ⇒ 升级后行为不变）。
  相邻面：`_verify-marker-hold` / `_verify-settings-layout` / `_verify-a11y` 全绿（见本轮报告）。

### Changed

**浏览器自带功能的收口：DevTools 走「顶部栏 → 帮助」、取消 F12 与「Ctrl+R 刷新」等一批键**

- 用户原话（第三轮）：「取消点击 F12 出现开发者工具的功能，取而代之的是在顶部工具栏中添加一项：
  '打开开发者工具'，点击就出现开发者工具。」
- 用户原话（第四轮）：「取消 Electron/Chromium 自带但本项目不需要的功能」，点名「按 Ctrl+R 刷新页面」。
- 用户原话（第五轮，澄清入口位置）：「并不是在编辑快捷工具栏中，而是在应用的顶部栏中的'帮助'里添加。」
  —— 入口因此**从编辑区快捷工具栏搬到顶部栏的「帮助」菜单**（那枚工具栏按钮已整体移除）。
  详细清单/逐条理由/故意没拦的清单见 `docs/manual/08d-fix-log-4.md` §4.88 与 `src/shared/shortcuts.ts`。
- **取消 F12 / 全部浏览器自带键**：`src/main/index.ts` 不再调用 `@electron-toolkit/utils` 的
  `optimizer.watchWindowShortcuts`（开发态用 F12 开/关 DevTools、打包态只屏蔽 `Ctrl+R` 与
  `Ctrl+Shift+I` 且漏了 macOS 的 `Cmd+Alt+I`，只能整包开关）。改成一份**可单测**的显式策略
  （`src/shared/shortcuts.ts`）：`blockedShortcut()` 在**任何构建下**拦下
  刷新族（`Ctrl/Cmd+R`、`Ctrl+Shift+R`、`F5`、`Ctrl+F5`）、DevTools 族（`F12`、
  `Ctrl+Shift+I/J/C`、`Cmd+Alt+I/J/C`）、查看源码（`Ctrl/Cmd+U`）、整页缩放
  （`Ctrl/Cmd + = - 0`）、`F7`、`F11`。原来的 `devShortcut`（开发态保留
  `Ctrl+R`/`F5`/`F11`）**已删除** —— 刷新族现在一律拦（dev 态也不需要：
  `electron-vite dev --watch` 改文件会自动重建）。
  应用自己绑过的组合由 `APP_OWNED_COMBOS` 兜底放行（`Mod+P` 打印、`Mod+F/H` 查找替换、
  `Mod+Shift+F` 专注模式、`Mod+B/I`、`Mod+Z/Y`、`Mod+D`、代码块的 `Ctrl+Space`…）：
  `before-input-event` 的 `preventDefault()` 会同时吃掉渲染层 keydown 与菜单加速键，
  拦错一条就是"应用自己的快捷键整个失效"。
- **整页缩放的鼠标那条路**也一并关掉：每窗口 `setVisualZoomLevelLimits(1, 1)`
  （捏合/触控板）＋ 忽略 `zoom-changed`（Ctrl+滚轮）后 `setZoomFactor(1)` 复位
  —— 应用自己有字号设置，Chromium 的整页缩放会把版式搞坏。
- **入口：顶部栏「帮助」菜单**（第五轮口径）：「打开开发者工具」是 `TopMenuBar.vue` 帮助组里的
  第三项（设置 / 关于 ‖ 打开开发者工具，中间一条分隔线），锚点 `[data-menu-item="menu.openDevTools"]`
  （叶子菜单项统一带 `data-menu-item` = i18n 键，语言无关；套件不按本地化文字找），
  点击走**既有的** IPC `app:openDevTools`（失败会弹通知，`runLeaf` 会静默吞异常所以自己 try/catch）。
  编辑区快捷工具栏里那枚按钮与 `toolbar.openDevTools` 键**已一并删除**（当时放在那里是听错了位置）。
  i18n 键从 `toolbar.openDevTools` **改名**为 `menu.openDevTools`（三语**文本级**增删：
  在 `menu.devtools` 之后插入新键、删掉 `toolbar` 里那份并去掉前一行的尾逗号 ——
  绝不用 `JSON.parse → stringify` 重写整份 JSON，那会把转义的 `\uFFFD` 写成真实字符）。
- **修：打开 DevTools 会把焦点抢到顶部栏的「文件」（用户报障，第六轮）**。因果链（CDP 实测的
  焦点时间线）：① 点菜单项 → `runLeaf` 先关下拉 → 被聚焦的那个按钮从 DOM 里消失 → 焦点落到
  `body`；② 主进程用 `mode: 'detach'` 开 DevTools → 主窗口 blur、紧接着 focus 回来（实测两次）；
  ③ **Chromium 在窗口重新激活时把焦点给文档里第一个可聚焦元素** = 顶部栏第一个分组按钮「文件」
  （实测：`window-blur` 之后的那个 `window-focus` 里 `activeElement` **已经**是
  `[data-topmenu-group="f"]`，紧跟一条 `focusin` 到它）—— 应用里没有任何一行代码去 focus 它。
  修法（`TopMenuBar.vue` 的 `refocusEditorAfterDevTools`）：这条动作成功后**把焦点交回编辑面**，
  并盯住那一小段激活抖动（`window` 的 focus 事件；2.5s 后自动摘掉监听，不做全局钩子）；
  只在"焦点确实丢了（body）或确实在顶部栏里"时才动手 —— 用户若自己点了别处就不抢。
  **没有**用 `tabindex="-1"` 之类把顶部栏踢出 tab 序的偷懒改法（那会破坏键盘可达性）。
- **接线**：IPC `app:openDevTools` / `app:closeDevTools`（`src/main/ipc.ts`，
  按 `event.sender` 定位窗口而不是 `getFocusedWindow()`），preload 按既有 `window.luminAPI.app.*`
  风格暴露，`mode: 'detach'` 独立窗口（不挤坏文档布局），返回值 `{ ok, alreadyOpen, windowId }`
  可观测（失败会弹通知，不留"点了没反应"）。被拦下的键在主进程留一行 ASCII 日志
  `[shortcuts] blocked <组合键> (<理由>)`（每个窗口每个组合只记一次，供验收取证）。
- **验收**：`tools/_verify-devtools.js`（默认矩阵）**49 条**——顶部栏「帮助」里真有那一项、
  **真实点击**（点帮助 → 点该项）后 `/json/list` 里多出一个 devtools 目标且主进程日志出现
  `[devtools] opened …`、再点一次报 `alreadyOpen: true`；**反向**断言编辑区快捷工具栏里
  **不再有**那枚按钮；**焦点口径**（第六轮新增）：点击前后各读一次 `document.activeElement`，
  断言打开后焦点**不在顶部栏**（`inTopBar === false` 且 `topmenuGroup === null`）且**回到编辑面**
  （`.ProseMirror` 或 `.source-editor`）；`F12` 与 `Ctrl+Shift+I` 不再产生 devtools 目标、
  `F7`/`F11` 留下被拦日志、
  `Ctrl+U` 不产生新目标、缩放键与 Ctrl+滚轮都不改变 `devicePixelRatio`、
  **Ctrl+R / F5 不重载**（页面标记 `window.__reloadProbe` 必须还在）、
  以及**应用自己的 `Ctrl+Shift+B` / `Ctrl+,` / `Ctrl+Shift+F` 仍然生效**
  （"没误伤"的运行时证据；最后那条正是"F11 被拦 ≠ 应用没有全屏入口"的确认）。
  顶部栏的键盘入口回归：`_verify-alt-menu.js` **3/3**、`_verify-toolbar-settings.js` **38/38**。
  `tests/shortcuts.test.mjs` **10 条**把"拦哪些 / 放行哪些"逐条钉死（含"应用自己的键一律不被拦"
  与"日志串必须是 ASCII"）。

### Added

**文件类型图标：`.md` / `.markdown` 用自己的文档图标（与应用图标分开）**

- 用户交付了一枚文档图标（纸页 + 折角 + serif "L" + `M↓` 徽标）。它原来是 450×600、
  非正方形且四角透明 —— 处理成**正方形母图**（裁到实际内容后四周补 8% 透明留白，
  因为 Windows 文件图标需要呼吸空间、不能顶到边），再交给仓库既有的打包器打成
  **11 档 32 位 BGRA DIB** 的 `resources/doc-md.ico`。
- 用户交付的 `.ico` 只有**一个 192² 的 PNG 压缩条目** —— 正是仓库注释里警告过的形态
  （GDI+ 的 `Icon.ToBitmap()` 读不了它，资源管理器会显示缺省图标），所以没有直接用，
  而是从 PNG 母图重打。
- `tools/pack-ico.js` 参数化（`--png` / `--out`，默认行为不变），让"应用图标"与"文档图标"
  走**同一条打包纪律**；`electron-builder.yml` 的 `fileAssociations[].icon` 两条都指向
  `resources/doc-md.ico`（exe / 任务栏 / 快捷方式仍用 `resources/icon.ico`）。
- 新增守卫（`tests/toolIcon.test.mjs`）：文档图标母图必须正方形且 ≥256、ICO 必须每档都是
  **DIB**（不能是 PNG 压缩档）、必须同时含 16 与 256 档、**必须与应用图标不同**、
  且 `fileAssociations` 的两条都真的指向它 —— 单测 819 → **820/820**。
- **装包实测**：`electron-builder --win` 成功产出 `dist/Lumin-1.0.0-setup.exe`，
  生成的 NSIS 脚本里可见两条关联都注册到 `$INSTDIR\resources\doc-md.ico`：
  `File "/oname=$INSTDIR\resources\doc-md.ico" …` + `APP_ASSOCIATE "md" … "$INSTDIR\resources\doc-md.ico"`。

### Docs

**报告逐条覆盖表：新增 `docs/report-coverage.md`**

- 一张表回答"报告里每一条现在什么状态、证据在哪、还缺什么"：P0/P1/P2 三档逐条列出状态
  （✅ 已做 / 🟡 代码就绪待外部输入 / ⏳ 未做）、一句话做法与可复跑证据（套件与断言数、提交号）。
- 末尾把**需要外部输入**的三项（更新渠道 URL、仓库/官网地址、签名证书）单独成表：
  写清"改哪里""缺了会怎样"，以及拿到之后 `npm run dist:check:release` 即转绿。

### Added

**命令面板（Ctrl+Shift+P，报告 §P3「壁垒功能」）**

- 新增 `CommandPalette.vue`（`role=listbox` + `aria-activedescendant` + Esc 回焦）、
  `useCommandPalette.ts`（命令注册表，**复用既有动作**而不是新造业务逻辑）、
  `lib/commandPalette.ts`（纯过滤/排序层，10 条单测）；三语 i18n 各 +7 键。
- `Mod+Shift+P` 从「全局搜索」让给面板（VS Code / Typora 的通行键）：全局搜索仍在命令表、
  编辑菜单与面板里可搜到，用户自定义过的绑定优先 —— 冲突口径写在 `useKeymap.ts` 注释里。
- 验收：`tools/_verify-command-palette.js`（已登记进默认矩阵）**17/17 PASS**，覆盖打开/过滤/
  ↑↓/Enter 执行/Esc 关闭/a11y 属性/三语/点击执行；`tests/commandPalette.test.mjs` 10/10。
- 复核时修掉三处（子代理没实际跑通套件的证据）：① 套件里 CDP 的 `modifiers` 写成 3（Alt+Ctrl）
  而 Ctrl+Shift 是 **10**（位标志）⇒ 面板永远打不开；② 4 条中文关键词硬编码在 `src/`（i18n 守卫拦下）
  ⇒ 关键词与本地化标签重复，删掉中文别名；③ Tailwind 任意值 155 → 164（浮层尺寸）已在
  `tests/visualScale.test.mjs` 登记并写明"一次性、后续先收进令牌"。

### Added

**多光标：代码块里可用（报告 §P2「功能缺口」）**

- 本仓只有**代码块**跑 CodeMirror（源码模式是 `<textarea>`、所见即所得是 ProseMirror），
  所以多光标先落在代码块 —— 那也是这类写作工具最常需要它的地方（批量改代码 / front matter /
  Markdown 表格列）。
- `CodeBlockView.vue` 的 CM 扩展列表补三条（缺一不可）：`EditorState.allowMultipleSelections.of(true)`
  （状态层允许多选区，关着时后加的选区会把前一个换掉）、`rectangularSelection()` + `crosshairCursor()`
  （Alt 拖拽列选择）、`Mod-d → selectNextOccurrence`（键盘逐个加选）。
- 验收：新增 `tools/_verify-multicursor.js`（已登记进默认矩阵）**3 PASS / 0 FAIL / 2 SKIP** ——
  代码块滚进视野后挂载 CM、Mod-d 后出现 ≥2 个**可见**光标（`.cm-cursor`）、
  **打一个字符同时落在两处**（判据落在 DOM 与文本上，不看内部对象）。
- **两条如实 SKIP（不假装通过）**：① Alt+单击加光标 —— `@codemirror/view` 6.43 未导出
  `clickAddsSelectionRange`，公共 API 拿不到（列选择走 Alt+拖拽，DOM 判据不同）；
  ② 源码模式那条边界断言 —— 本轮没能用 DOM 确认进入源码模式。
- **边界写清**：多光标**只在代码块里保证可用**；源码 textarea 与所见即所得面不做（后者要改选择模型
  与输入法路径，属另一件大工程）。这条同时写进了代码注释、本 CHANGELOG 与台账 §2.11。

### Docs

**文档收敛：`docs/manual/08-appendix.md` 3516 行拆成「索引 + 5 片」（报告 §6.2 P1）**

- 实测原文件 **3516 行**、只有 3 个顶层小节（其中 `## 8. 附录` 一节从第 3 行一直铺到 3358 行），
  改一行要在一份三千多行的文件里翻 —— 报告说的"3500+ 行"基本对得上。
- 拆法按**时间与主题**切成五片（内容**逐行原样**，只用脚本按行号切片，不手抄）：
  | 文件                                                       | 覆盖                                             | 行数   |
  | ---------------------------------------------------------- | ------------------------------------------------ | ------ |
  | `08-appendix.md`（索引：保留附录 A/B/C 速查表 + 分片目录） | —                                                | **85** |
  | `08a-fix-log-1.md`                                         | §4.39–§4.52 编码/打包/草稿语义/安装链路          | 917    |
  | `08b-fix-log-2.md`                                         | §4.53–§4.64 元数据与历史 / 数据流账本 / 套件迁移 | 793    |
  | `08c-fix-log-3.md`                                         | §4.65–§4.73 查找替换 / 数学公式 / 一致性与验收   | 860    |
  | `08d-fix-log-4.md`                                         | §4.74–§4.85 草稿弹窗 / 版式与主题 / 状态栏重排   | 723    |
  | `08e-wave-records.md`                                      | §4.86–§4.87 两波按报告优化的交付记录             | 158    |
- **内容保全有证据，不靠"我看着没丢"**：拆片脚本把索引前 65 行 + 五个分片正文重组回来，
  sha256 与原文件**完全一致**（`fe620c234e2223d2`，3516 行）——每一行恰好出现一次、顺序不变。
- 新增 `tests/docsAppendix.test.mjs` **4 条守卫**：索引 ≤200 行（防"越拆越肥"）、每片有回索引的
  面包屑且 ≤1000 行、**所有 §4.x 小节在分片里恰好出现一次**（防丢/防重，并要求 §4.39/§4.85/§4.86/§4.87
  仍在）、拆片后无 BOM。
- 顺手降低一条测试的偶发：`atomicWrite` 的并发写用例载荷 200 KB → 64 KB
  （它测的是 rename 的**原子性**，与体积无关；200 KB×2 在整仓并行跑时命中过 2 次偶发，
  单独跑 5/5 全绿。大字节不截断另有 1 MiB 那条断言盯着）。

### Docs

**Electron 升级第一次尝试的实测记录（39.8.10 → 44.5.1，未完成）**

- 建分支 → 装最新 stable（44.5.1）→ 按 `docs/electron-upgrade.md` §3 的清单跑。
  **代码侧没有阻碍**：`electron-vite build` 通过、`tsc`/`vue-tsc` 0、bundle 体积与 39 基本一致。
- 卡点是**本机环境**，不是代码，三条都如实记进了 `docs/electron-upgrade.md` §5：
  ① npm 的 install-scripts 白名单拦下了 `electron` / `esbuild` / `electron-winstaller` 的安装脚本
  （二进制要手动补 `node node_modules/electron/install.js`）；
  ② 这次 install 重排依赖树、剪掉了顶层 `fs-extra@10`（`app-builder-lib` 的硬依赖）——
  **仓库自己的守卫当场抓到**（`tests/lockfile.test.mjs` 列出 11 条 `… → fs-extra` 悬空引用），
  再跑一次 `npm install` 也没补回来，带着这样的锁文件不能合；
  ③ `electron-builder` 在这台机器上多次跑到 packaging 阶段被外部终止 ⇒ 打包态复验做不了。
- 处置：`main` 与 `node_modules` 已恢复到 39.8.10（`npm ci` + 手动补 electron 二进制，
  单测回到 **805/805**），分支已删；§3 清单不变，§5 补了一段"下次按这个顺序做"的可执行步骤
  （先确认安装脚本白名单 → 干净装 → 只改 electron 一个包 → 立刻跑单测看悬空引用 → 再跑矩阵 →
  打包复验换一台不会被中途杀进程的机器）。
- 价值：把"这条为什么还没做"从一句判断变成**可复跑的证据链**，并证明仓库的锁文件守卫是有效的。

### Added

**便携版：免安装 + 数据随身（报告 §P2「功能缺口：便携版」）**

- 便携版有两种含义，混起来会出一个最难查的问题：**免安装**是打包器给的（`portable` target），
  而 **数据随身**必须应用自己做 —— Electron 默认仍把 userData 放 `%APPDATA%\Lumin`，
  于是"绿色版"换台机器打开会像"全空了"，而原机器上那份数据还在。
- 新增 `src/shared/portable.ts`（纯函数、可单测）：electron-builder 的 portable target 运行时会
  注入 `PORTABLE_EXECUTABLE_DIR`，据此把 userData 指到 `<exe 同级>/LuminData`。
  拒绝 `.asar` 路径（只读，改过去必然写不进）；末尾分隔符归一化。
- `main/index.ts` 在**任何模块级 userData 读取之前**执行：建目录 → `app.setPath('userData', …)`
  → 记一行 ASCII 日志；建不出来（U 盘只读/被占用）时**退回默认并留日志**（宁可数据留在本机，
  也不能因为写不了 U 盘而起不来）。
- 顺带修掉一个会破坏便携版的隐患：`drafts.ts` 原来在**模块级**捕获
  `app.getPath('userData')` —— 改路径对它无效，便携包里草稿会留在 `%APPDATA%` 而其它数据跟着 exe 走
  （"一半随身"比不随身更难查）。改成惰性求值，并加了一条**全仓扫描**的守卫测试。
- 打包：`electron-builder.yml` 新增 `portable` 段（**不放进** `win.target`，免得每次发版都多产一个
  几十 MB 的包），`npm run build:portable` 显式产出 `Lumin-<版本>-portable.exe`。
- 验收：新增 `tests/portable.test.mjs` **6 条**（非便携模式绝不改路径、两种分隔符拼接、末尾斜杠与
  空格归一、拒 asar、主进程真的接上且失败有回退、**全仓无模块级 userData 捕获**、打包 target 与脚本口径）；
- ⚠️ 过程中修掉一个我自己引入的配置错误：`verifyUpdateCodeSignature` 属于 **win** 段
  （scheme.json 的 `WindowsConfiguration.properties`），放进 `nsis` 段会让 electron-builder 的
  schema 校验**拒掉整个配置**（报错只有一句 `configuration.nsis should be null`，极难定位）。
  实测 `electron-builder --win portable` 已能通过校验并进入 packaging；测试也改成断言"它在哪个段里"。
- **未跑完的一步（如实记录）**：便携包的完整产出（`npm run build:portable` 到 exe）本轮没跑完 ——
  本机在 packaging 阶段被外部终止（同一现象本轮也打断了两次长批次套件运行）。已写进
  `docs/distribution.md` 与打包手动清单，发版前补跑。 **运行时实测**：带 `PORTABLE_EXECUTABLE_DIR` 启动，`<dir>/LuminData/` 里出现了 `logs/`、缓存与
  数据库等整套数据；未设置该变量时行为与原来一致。

### Added

**分发链：外部输入清单 + 一键切换 + 发版门禁（报告 §7.4 A 可做的部分）**

- 报告这一块点名"真实仓库地址 / 官网 / 更新渠道 / 代码签名证书"——这些值**代码变不出来**，
  能做的是让"拿到就能接上"成为一句可执行的话：
  - 新增 `src/shared/distribution.ts`：占位值判据（空 / `example.*` / `localhost` / 模板尖括号）
    与"渠道 / 仓库 / 主页 / 签名是否就绪"四个判定，**只有这一份**。运行时 `updater` 改用它
    （删掉了自己那份占位域名数组；`tests/distribution.test.mjs` 有一条守卫盯着不许回退）；
  - 新增 `tools/distribution-check.mjs` + `npm run dist:check`：打印当前值 + 待办清单，
    每项都写清"改哪里"与"缺了会怎样"；`npm run dist:check:release`（`--release`）
    在**任何一项未就绪时 exit 1** —— 免得带着 `example.com` 的更新地址发出去（已实测 exit=1）；
  - 新增 `docs/distribution.md`：四项输入的逐步操作（GitHub Releases / 自建静态源两种渠道、
    签名环境变量、发版检查清单），并说明"为什么不做成写死配置"。
- **代码签名一键化**（不改配置文件）：electron-builder 自认 `CSC_LINK` + `CSC_KEY_PASSWORD`
  （Windows 也可用 `WIN_CSC_*`）—— 设了就自动签，没设就产未签名包。`electron-builder.yml`
  里把安全相关的 `win.verifyUpdateCodeSignature: true` **显式钉住**（它在 win 段——见下面便携版那条的踩坑记录）
  （该版本默认就是 true，写出来是为了升级 electron-builder 时不被悄悄改掉）。
- 验收：新增 `tests/distribution.test.mjs` **7 条**（占位判定含清单自证、渠道就绪的 generic/github
  两条路、清单五项 id 稳定且每项都有 how/missing、真实仓库现状如实报出、updater 不许自带一份判据、
  打包配置的签名校验与"卸载不删用户数据"、工具可导入且渲染含待办）；
  `npm run dist:check` 输出 4 项待办、`--release` exit 1；单测 792 → **799/799**；
  `_verify-about` 7/7、`_verify-settings-layout` 7/7、`_verify-notifications` 36/36。

### Fixed

**按下鼠标不再让 `**` 闪一下（用户实测：在别处按下/拖动就消失、松开才回来）**

- 现象（两轮报障，同一个功能）：① 光标在一处行内标记内（页面上正显示着 `**`）时，在**别处**
  按下左键并**按住** —— 这些 `**` 立刻消失；松开鼠标又出现。② 按下那一下修掉之后，**拖动**仍然
  会让它们消失：在别处 B 按下并拖动去选字符，A 处正显示着的 `**` 变成透明、松手才回来。
- 根因（两次都不是标记重建逻辑错，而是**判据错**）：
  - ① 是一条**时序**错误：`typoraInlineMarks` 的 `mousedown`（编辑区根节点、捕获）无条件把
    `.press-hidden` 挂上，而 CSS `.press-hidden .md-marker:has(> .md-reveal-inline) { color: transparent }`
    把**已显形**标记的字色变透明（占位照旧 ⇒ 所以松手就回来）。「按下即冻结显隐装饰」本身没错
    （它保证整个手势里版面/显隐一个像素都不变，第二十四轮那些落点结论都靠它），错在把「去墨」
    也放在按下那一刻。
  - ② 是**判据只看手势、没看手势和那个构造有没有关系**：去墨只认「指针按住期间移动 >4px」，
    于是拖动会把**无关构造**上正在显示的标记一起藏掉。
- 修法：
  - ① 两件事拆成两个时机 —— `pressHeld`（按下即冻结装饰）与 `pressInkHidden`
    （**指针在按住期间移动超过 4px 之后**才去墨）；`mousemove`（document、捕获）判位移，
    `mouseup` / `pointerup` / `pointercancel` / 窗口 `blur` 的收尾不变；
  - ② 去墨再加一道资格（`pressOnRevealedRun`）：**只有按下点落在「此刻已显形」的构造里**
    （`posAtCoords` 的位置 `pos` 满足 `rs <= pos < re` **半开**，且该构造在当前选区下已显形 ——
    在 `mousedown` 捕获阶段取一次，`PM` 随后写选区不影响）才允许去墨，按下点在别处一律不去墨。
    半开（不照抄显隐判据的两端都含）的理由：按在收尾标记**右侧的空白**里就是用户说的「别处按下」，
    两端都含会把它误判成「在构造上」；代价是按在收尾标记**右半边**也算「别处」⇒ 不去墨 ——
    方向是「宁可少藏，不可误伤」。
  - 「拖选时先别冒 `**`」的诉求保留：去墨只改字色、不改占位；按下点在那个构造上时，拖动一开始
    就去墨、松开即恢复（同构造内 / 跨构造拖选仍然安静）。为什么可以只用按下点判：装饰在按下时被
    冻结 ⇒ 手势里可见的标记只有「按下时已显形」的那几颗，拖动不可能让新标记冒出来（第二十四轮
    「拖选时别冒」正是靠冻结实现的）。
- 验收（两轮都先确认**会红**、重建后转绿）：`_verify-inline-formats.js` 新增 L 段 7 条（①，
  修前 **188/189** → 修后 **189/189**）与 M 段 7 条（②，修前 **194/196**，两条 M 断言实测
  `inkHidden:[true,true] pressHidden:true` → 修后 **196/196**）；`_verify-marker-hold.js`
  在①那轮按新口径改写并在②那轮**原样保持绿**（14/14，说明②没有推翻构造内拖动的口径）。
  相邻面 `_verify-drag-selection` 10/10、`_verify-round-24` 15/16（1 SKIP）、
  `_verify-line-end-click` 7/7、`_verify-links` 12/12；单测 **820/820**、`tsc` / `vue-tsc` 0、
  `eslint --max-warnings 0` 0、`doc-facts` / `doc-tokens` check OK。

**替换字符标记（状态栏 U+FFFD 警告）跟着解码与保存一起重算（报告 §4.2 P2）**

- 这个标记的含义写在状态栏 tooltip 里："这份文件里有字节没能按当前编码解出来（已显示为
  U+FFFD）—— 直接保存会改写它们的字节"，可见它属于**最近一次解码**这个事实。查下来有两处漏：
  - `reopenWithEncoding()`（「用其他编码重新打开」）更新了 content / encoding / hadBom / eol，
    **唯独没更新 `hadReplacement`** ⇒ 从 GBK 切到 UTF-8（乱码变 U+FFFD）之后标记还是灭的、
    切回去还是不灭 —— 该亮的没亮、该灭的没灭；
  - `finishSave()` 之后不重算 ⇒ 用户把那几个坏字符删掉再保存，磁盘上已经没有了，标记却一直红着。
- 修法：重新解码处按解码结果赋值；保存成功处按**写进去的那一份**快照重算
  （`hasReplacementChar(snapshot)`，与主进程解码用的是 shared 里同一个纯函数 ——
  用 snapshot 而不是 `doc.content`：await 期间可能又敲了字，标记要描述磁盘上那一份）。
- 验收：`_verify-encoding` 57 → **59 条**并新增两步 —— 按 UTF-8 重新解释 GBK 文件后
  `data-encoding-replaced` 必须变成 `1`、切回 GBK 必须消失（先跑一次确认**会红**，
  重建后转绿，证明这条断言确实钉的是本次修复）；`_verify-save-safety` 17/17、
  `_verify-md-fidelity` 106/107（1 SKIP）、`_verify-external-change` 8/8、
  `_verify-file-lifecycle`；单测 **792/792**、`vue-tsc` 0。

**搜索索引启动对账：`reconcileFts()`（报告 §4.2 P2「FTS 2s 节流，崩溃即不一致」）**

- 报告这一条在**数据层**成立：FTS 写入是 2 秒防抖批量（`FTS_DEBOUNCE_MS`），崩在窗口里就留下
  "`documents` 有行、`documents_fts` 没有行"的空洞，而且**永远不会自愈**（写队列已经丢了）。
- 但**用户可见的影响比报告说的小一号**（这是量出来的）：`search()` 在 FTS 无结果或抛错时会退回
  `documents` 的 LIKE 扫描，所以"搜不到"不会发生 —— 丢的是**片段与排序**（LIKE 那条路
  `titleSnippet`/`bodySnippet` 都是空串）。反向的孤儿行（FTS 有、documents 没有）会被 JOIN 挡掉，
  只浪费空间。
- 新增 `reconcileFts()`：缺的按 `documents` 重建、多的删掉，一批一个事务（与 `flushFtsIndex`
  同一套纪律）；开库后跑一次，补了/删了多少写进启动日志（`[db] fts reconcile: +N -M`），
  失败只记一行日志、不拦启动。
- 验收：`tests/database.test.mjs` 9 → **11 条** —— 用**第二个 SQLite 连接**制造不一致现场
  （不往生产代码里开 test-only 口子）：删 FTS 行 → 断言"仍能搜到但片段为空"（把真实影响面写进
  测试）→ `reconcileFts()` 补 1 行 → 片段回来；孤儿行删掉且对账**收敛**（第二次返回 0/0）。
- 回归：`_verify-search-index` 10/10、`_verify-db-maintenance` 6/6、`_verify-tags` 7/7、
  `_verify-session` 22/22、`_verify-md-fidelity` 106/107（1 SKIP）；单测 **792/792**。

**草稿目录：停放草稿的数量上限 + 总量预算 + 写盘补 fsync（报告 §4.2 P2）**

- 报告的原话是"停放草稿永不 GC 且无总量上限"。查证属实：`planDraftGc` 只清三类 ——
  写盘临时文件残留、**file-** 草稿超过 30 天、连 JSON 都解不开的旧文件；而未命名/停放草稿
  是**用户动作**产生的（每关一个未保存的窗口就停放一份），一天能堆几十份，既不过期也没人提醒。
- `planDraftGc` 增两条判据（纯函数，`tests/drafts.test.mjs` 21 → **26 条**）：
  - **数量上限** `DRAFT_MAX_UNTITLED = 20`：未命名/停放草稿超过 20 份时淘汰**最旧**的
    （那正是用户最不可能回去找的），且**不外溢到 file- 草稿**（它们有自己的年龄判据）；
  - **总量预算** `DRAFT_MAX_TOTAL_BYTES = 32 MB`：超预算时最旧优先淘汰，但**至少留
    `DRAFT_MIN_KEEP = 3` 份** —— 预算不该把用户仅有的恢复依据删光（拿"整洁"换"丢内容"）。
    两条新原因 `too-many-untitled` / `size-budget` 会出现在启动日志的 `[drafts] gc removed …` 里。
- **草稿写盘补 fsync**：原来只有"临时文件 + rename"，而 rename 只保证目录项可见、数据还在
  页缓存里 —— 断电/蓝屏时可能留下一份零长度草稿（而草稿是崩溃恢复的唯一依据）。
  现在直接复用 `services/atomicWrite.ts`（与用户文档保存同一条纪律）。
  顺带把 `DRAFT_TMP_RE` 扩成同时认旧名 `.tmp` 与新名 `.lumin-tmp`（否则升级后旧残留永远清不掉）。
- 验收：`tests/drafts.test.mjs` **26/26**；默认矩阵 62 条分 5 组跑 ——
  **60 PASS + 1 FLAKY（`_verify-surface-fuzz` 重跑绿）+ 1 FAIL（`_verify-session-last-closed`，
  已登记的自管实例抖动套件；同一轮内另一次运行它 8/8 全绿）**，无回归；
  `_verify-draft-banner` 29/29、`_verify-draft-gc` 6/6、`_verify-close-save-prompt` 22/22、
  `_verify-save-safety` 17/17、`_verify-new-document` 25/25。

### Tests

**IO 层单测（报告 §6.2 收口）：SQLite 持久层解耦 + 9 条真库断言**

- 与原子写 / 编解码同一个病根，而且是最后一块：`services/database.ts` 顶层
  `import { app } from 'electron'`，单例又在模块顶层 `new` —— **import 就等于开库**，
  于是 `node --test` 里直接 `ERR_MODULE_NOT_FOUND`；这片"搜索索引 / 标签 / 历史 / 编码记忆"
  的持久层此前只能靠 CDP 套件从外面敲。
- 解耦（三处，都顺手把设计理顺）：
  - electron 改成**惰性 require**（只有"没显式给路径"时才问 `userData`），
    并由 `createRequire` 兜底 ESM（主进程是 CJS、`node --test` 是 ESM，两条路行为一致）；
  - 单例改成**惰性**：`initDatabase(路径)` 显式指定（测试与将来的多 profile），
    不指定则首次访问 `db` 时用 electron 的 userData —— 对外表现与原来完全一致，
    顺带去掉"启动顺序被 import 顺序隐式决定"这个隐患；
  - `db` 句柄改成一层 Proxy 转发给当前实例并绑定 `this` —— 几十处 `db.xxx()` 调用点**一行没改**。
- `database.ts` 的相对 import 按仓库既有约定写全 `.ts`（`tsconfig.node.json` 的
  `allowImportingTsExtensions` 就是为这条设的；`tests/migrations.test.mjs` 早已是这个前提）。
- 新增 `tests/database.test.mjs`（**9 条**，临时目录 + 真 `node:sqlite` 库）：`countWords`/`clipForIndex`、
  upsert → 读回元数据与 `stats()`、**FTS 保存后立刻可搜 / 删除后搜不到**（幽灵文档那条路）、
  **`deleteDocumentsUnder` 按目录边界删且不误伤 `notes-archive` 这类同前缀兄弟目录**、
  `pruneWorkspace` 只对账本工作区、`renameDirectory` 连子孙文档一起搬、标签与置顶可读回、
  `setDocumentTextMeta` 不覆盖正文、**惰性单例换库文件后是全新空库**。
- 回归：`_verify-search-index` 10/10、`_verify-db-maintenance` 6/6、`_verify-tags` 7/7、
  `_verify-encoding` 54/57（3 SKIP）、`_verify-history-restore` 7/7、`_verify-file-lifecycle`；
  单测 776 → **785/785**。

### Tests

**IO 层单测（报告 §6.2 后半）：编解码抽出纯实现 `services/textCodec.ts` + 16 条字节断言**

- 与原子写同一个病根：`encoding.ts` 顶层 `import { app } from 'electron'`（拿系统语言）与
  `import { db }`（编码记忆），于是"打开→保存会不会改字节"这件**写作工具最核心的正确性**
  在 `node --test` 里根本进不来，只能靠 `_verify-encoding.js`（54 条，要真窗口）从外面敲。
- 新增 `src/main/services/textCodec.ts`（零 electron / 零 db / 零 IO）：`sniffBom`、`isStrictUtf8`、
  `localeFallback(locale)`、`decodeBuffer(buf, requested, remembered, locale)`、`encodeText`、
  `bomBelongsTo`、`decodeAs`；判定链顺序与行为**逐条保持**。系统语言改为**注入**
  （`encoding.ts` 传 `app.getLocale()`），`encoding.ts` 从 308 行瘦到 148 行，只留编码记忆与产品语义。
- 新增 `tests/textCodec.test.mjs`（**16 条**）：无 BOM UTF-8、UTF-8 BOM（认得出 + 摘掉 + hadBom）、
  UTF-16LE/BE、显式编码优先于 BOM（选 UTF-8 = 去掉 BOM）、显式与 BOM 冲突时听用户的、
  GB18030 中文环境猜对、Shift_JIS 日文猜对而西欧猜错（"按环境猜"的边界）、记忆优先于严格 UTF-8、
  语言兜底五档映射、非法字节不抛、UTF-16 总写 BOM、往返保真（UTF-8 / 含 BOM / UTF-16LE 逐字符相等）、
  有损档（Shift_JIS + emoji 变 `?`）。
- **两条测试写错后更正的记录**（都留在注释里，免得下一轮有人再"修"一遍）：
  ① `encodeText('a','utf-8',true)` 不写 BOM 是**对的** —— UTF-8 的 BOM 由编码 id `utf-8-bom` 表达，
  而"显式选 UTF-8"的产品语义就是去掉 BOM；带 BOM 打开的文件其 encoding 就是 `utf-8-bom`，
  所以"打开→保存"不会掉 BOM（已补一条专门的往返断言）。
  ② **GB18030 不是有损档**：它是全 Unicode 编码，emoji 也写得进去；真正会丢字的是
  Shift_JIS / Windows-1252 这类（断言已改用 Shift_JIS）。
- 回归：`_verify-encoding` 54/57（3 SKIP）、`_verify-save-safety` 17/17、`_verify-file-lifecycle`、
  `_verify-md-fidelity` 106/107（1 SKIP）、`_verify-external-change` 8/8；单测 760 → **776/776**。
- 剩余（下一轮）：`database` 的 IO 断言 —— 需要把 `app.getPath('userData')` 从模块顶层挪成
  "composition root 注入 + 惰性单例"。

### Tests

**IO 层单测（报告 §6.2）：原子写抽出成可单测的模块，配 10 条 IO 断言**

- 报告的原话是"`fileOps.writeFile` / `database` / `encoding` 目前只由本地手动套件背书"。
  根因很清楚：那段**最不能出错**的代码（同目录临时文件 → fsync → rename）在 `fileOps.ts` 里
  **手抄了三遍**（文本写 / 二进制写 / 备份复制），而 `fileOps.ts` import 了 `electron`
  （回收站要用 `shell`）、`services/database`、`services/encoding` —— 于是它在 `node --test` 里
  **根本 import 不进来**。
- 新增 `src/main/services/atomicWrite.ts`（零 electron 依赖，只用 node 内置）作为唯一实现：
  `atomicWrite` / `atomicWriteBytes` / `atomicWriteEncoded` / `copyFileAtomic` / `tempPathFor`，
  三处调用点全部改走它，行为逐条保持（默认 `requireParent` **绝不** `mkdir -p`；
  二进制 / 备份 / 导出通道允许建目录）。
- 新增 `tests/atomicWrite.test.mjs`（**10 条**，每条对应一种"用户会丢内容"的真实故障）：
  写入即替换 + 返回真实 mtimeMs；不留 `.lumin-tmp`；**父目录缺失抛 `PARENT_MISSING` 且绝不
  重建目录**；`requireParent:false` 的 mkdir -p 语义；**失败时清理临时文件且不破坏目标**；
  临时路径同目录 + 随机后缀 + 能被启动清扫的正则识别；1 MiB 逐字节往返；
  **并发写同一路径最终必是完整的一方**；原子复制建目录；注入式写入走同一条 fsync+rename 路径。
- 守卫同步：`tests/guards.test.mjs` 的直接写盘例外表加上 `services/atomicWrite.ts`
  （写明理由：它写的是临时文件，绝不对用户文档直接落盘）。
- 回归：`_verify-save-safety` 17/17、`_verify-file-lifecycle`、`_verify-encoding` 54/57（3 SKIP）、
  `_verify-backup` 19/19、`_verify-image-insert` 9/9、`_verify-external-change` 8/8、
  `_verify-history-restore` 7/7；单测 750 → **760/760**。
- 剩余（下一轮）：`database` / `encoding` 的 IO 断言要先做可注入边界 —— 两者的
  `app.getPath('userData')` / `app.getLocale()` 都在模块顶层 import electron，
  计划是"composition root 注入 + 惰性单例"。

### Changed

**窄窗策略：两档宽度断点 + 最小窗口尺寸（报告 §5.2 P0-1「全仓零宽度断点」）**

- 报告点名的现象：`@media` 全仓只有 3 处且**全是** `prefers-reduced-motion`，一条宽度断点都没有；
  侧栏硬钳 200–420、右侧大纲 160–420 ⇒ 窄窗下正文只剩 200–340px。
- 更前置的一个问题：窗口最小尺寸是 **940×600**，而 1366×768 的笔记本在 150% 缩放下
  可用逻辑尺寸只有 **911×512** —— "最小窗口"比屏幕还大，窗口必然伸到屏幕外
  （右边缘的大纲与状态栏 `⋯` 永远够不着）。最小尺寸降到 **760×520**
  （`windowPlacement.ts` 与 `index.ts` 同源常量，`index.ts` 不再写字面量）。
- 两档断点（`chrome.css`，面板宽度从行内 `width` 换成 `--sidebar-w` / `--outline-w`
  自定义属性才可能被媒体查询夹取）：
  - **≤900px**：右侧大纲 `min(var(--outline-w), 22vw)`；
  - **≤760px**：侧栏 `30vw`、大纲 `20vw`；正文内边距 56px → 32px（900 档）→ 20px（760 档）
    （Tailwind 的 `max-[900px]:px-8 max-[760px]:px-5`）。
  - 百分比是**量出来的**：第一版 34vw/26vw 在 760 视口下正文只剩 **234px**，
    收到 30vw/20vw 后回到 340px 量级 —— `_verify-a11y` 的窄窗断言把这条钉住了。
- 验收：`_verify-a11y` 31 → **36 条**（新增两条视口下的"无横向溢出 / 面板被夹住 / 正文仍可用"
  共 5 条）；`_verify-visual-scale` 5/5、`_verify-outline-right` 26/26、
  `_verify-sidebar-root-and-outline-side` 36/36、`_regress-layout` 9/9、`_regress-divider` 4/4、
  `_verify-settings-layout` 7/7；`tests/visualScale.test.mjs` 新增「窄窗两档断点存在」守卫
  （断点值出现在四处，改一处就得四处对齐）。

**性能：把"大文档降级闸"按实测重新标定（报告 §4.2 / §7.4 的性能项）**

- 先用**新探针**复测报告的两个数字（`tools/_probe-fences-total.js` / 新增 `tools/_probe-bigprose.js`）：
  **① 2000 围栏的 56 KB 文档：全程 1450ms**（报告写的是 52–62 s）—— 代码块 CM 虚拟化（F 项）
  已经解决，500 围栏时 CM 实例峰值 10 个（虚拟化前 500 个），`_verify-cb-virtualization` 18 条守着；
  **② 977 KB 散文：open 1.97s + render 4.37s = 6.34s、RSS 1272MB** —— 报告说的"1.4GB 常驻"是真的，
  但慢的不是装载而是 **DOM 稳定**，且**旧阈值没拦住它**。
- 旧闸的字符阈值 1M 是照旧审计"572,262 字符 → 打开 2.24s"定的，而那句话量的是 `openPath` 返回，
  用户真正能用的时刻是 DOM 稳定（差 2–3 倍）。CPU 采样证明这 4.4 秒是第三方常数
  （markdown-it tokenize 717ms、prosemirror-markdown `atBlank` 1168ms、PM 内部约 490ms、GC 411ms），
  一次改动消不掉 ⇒ 按实测 **17 µs/字符** 标定 5 秒线：`HEAVY_CHARS` **1M → 300k**（围栏仍 800）。
- 效果（同一份 977 KB 文档，同一探针）：入口从渲染面改为**源码面**，
  `open` 1965→**454ms**、默认可用 **6340→454ms**、入口常驻 **1272→604MB**、
  DOM 元素 30,939→**97**；报告验收线（977 KB ≤5s）从 FAIL 变 **PASS**。1.1MB 那档同样：8.59s→**0.53s**。
- 提示文案按原因区分：新增纯函数 `heavyReason()`（`fences` / `chars`）+ 三语
  `toast.heavyDocSourceModeChars`（一份 977 KB 的纯散文没几个代码块，说"有 0 个代码块"只会让人困惑）。
- **诚实标注代价**：用户坚持切回渲染面时成本仍在（+3.4s / ~1.2GB）—— 根治要段落级虚拟化，
  已记进 `docs/optimization-waves.md` 的波次 2 余项。
- 单测 `tests/largeDoc.test.mjs` 6 → **8 条**；回归 `_verify-surface-stress` 72/72、
  `_verify-cb-virtualization` 18/18、单测 749/749。

**修掉波次 1 引入的一处竞态：`settings:changed` 回播会把刚改的设置打回去**

- 现象：`_verify-md-fidelity` 的"历史 关闭后不再写快照"**间歇性**红（`entries=2`）——
  用户关掉本地历史，快照照写。
- 根因：回播的是**整份设置快照**，而渲染层的落库是 **250ms 节流**的。序列：
  `set('historyEnabled', false)`（进队列）→ 上一次落库的**回播**此刻到达（快照取自更早，
  该键还是 true）→ `applyRemote()` 整份 `$patch` 把它**打回** → 随后的落库把 true 写回 kv
  → 主进程 `recordHistoryBeforeOverwrite` 读到 true。红与不红取决于那次回播与 `set` 的先后，
  所以它是间歇的（修复前 3 次跑红 2 次）。
- 修法：`writeSettings(next, { broadcast })` —— **渲染层发起**的写入只落库不回播
  （`ipc.ts` 的 `commitSettings` 传 `broadcast: false`，渲染层本来就有这份状态），
  只有**主进程侧**的改动（原生菜单主题、备份目录选择）才广播，那才是回播存在的理由。
- 验收：`_verify-md-fidelity` 连跑 3 次 **PASS 0 FLAKY**；`_verify-backup` 新增一条
  「主进程侧写设置 → 渲染层 store 被动同步」（渲染层先放假值 → 调 `useDefaultDir()` →
  断言 store 被改回 `null`）并全绿（19/19）；`_verify-md-fidelity` 也补了一条
  「关闭设置真的落库了」的前置断言 —— 以后这类问题一眼能看出是"设置没到"还是"历史没关"。

### Fixed

**数据安全：堵住报告点名的三条"静默丢改动"路径（报告 §4.2 P0-1/P0-2/P0-3、P1-2/P1-3）**

- **并发保存不再静默覆盖**：`file:write` 的 mtime 冲突检测原本在 `serializeWrite` **外面** ——
  同一文件被两个窗口打开并各自保存时，两次写都拿到同一个旧 mtime、都通过校验，
  后到者覆盖先写者，而先写者还会在渲染层被标成"已保存"（关窗不提示）。
  现在检测移进队列临界区：第二次 stat 看到的是第一次刚写下的 mtime，如实回报 `conflict`。
  验收：`_verify-save-safety` 15 → **17 条**（同路径两次并发写必须恰好一次冲突、磁盘上恰好一个赢家，
  判据用"先把 mtime 回拨 10 秒"保证确定性）。
- **删除正在编辑的文档/目录前先收口握手区**：编辑器的输入有 250ms 防抖、草稿还有 1.2s 防抖，
  直接删会把这一段吞掉（回收站与本地历史只覆盖**已写进磁盘**的版本）。现在 `removeNode`
  先 `flushEditorBeforeReplace()`、脏则立刻写一份草稿；删目录那条路在摘掉路径后再用
  「未命名」键留一份；删除确认框对"脏的当前文档"多说一句警告（三语）。
  验收：`_verify-file-lifecycle` 11 → **15 条**。
- **「不保存」真的会确认关窗**：`requestClose` 原来在 `try` 里 `return`，而 `confirmClose()` 写在
  `try` 之后 —— 选「不保存」那条路正好跳过了它，窗口只能等主进程 2.5 秒的兜底强杀。
  现在改成"一条出口 + `closeNow` 标志"。验收：`_verify-close-save-prompt` 21 → **22 条**
  （点「不保存」到进程退出必须 < 2s）。
- **保存清草稿前先等在飞的草稿写落地**：`finishSave` 直接 `drafts.remove`，而在飞的
  `draftWrite` 可能落在它之后 → 草稿被写回 → 下次启动按 `restorableDraft` 弹出**已经被撤销**的内容。
- **索引写失败不再污染保存结果**：`db.upsertDocument` 失败只降级成"索引未更新 + 一条日志"，
  不再让渲染层把一次**已经成功落盘**的保存记成失败（那会带着旧 mtime 退避重试 → 假冲突）。
- **SQLite 补 `busy_timeout = 3000`**：此前只有 WAL/synchronous，外部工具占用库时写会直接
  SQLITE_BUSY 冒到"保存失败"。

**一致性：索引只增不删（报告 §4.2 P1-1）**

- 删目录时改为按**目录边界前缀**批量删索引（`deleteDocumentsUnder`）：原来只 `deleteDocument(目录路径)`，
  那条 SQL 按 `path = ?` 精确匹配，永远命不中 —— 幽灵文档会长期留在 `documents`/FTS/`documents_history`
  里（搜得到、点不开）。工作区索引收尾还会按"本轮真实扫到的路径集合"对账 prune
  （扫到 MAX_FILES 上限时跳过对账，避免误删）。验收：`_verify-file-lifecycle` 的
  `delete-directory-prunes-index` 逐路径查库，三篇必须全部为 `null`。

**设置：一份真相 + 原生菜单主题真的生效（报告 §3.2 P0-1/P0-2）**

- 新增 `main/services/appSettings.ts` 作为主进程**唯一**设置写入口（kv + 原生主题 + 广播
  `settings:changed`）；`ipc.ts` 的 `commitSettings` 与两处"备份目录"写点全部改走它，
  渲染层订阅新出站通道就地把 store patch 回来（此前主进程直接 `kvSet` 不通知，
  界面会显示旧值到重启，反之 store 的 `persist` 还会把主进程那一步打回去）。
- 原生菜单的主题项此前写的是 **electron-store**（`store.ts` 自述它只是历史配置的一次性迁移源），
  渲染层收到 `theme-changed` 却去 SQLite 重读 ⇒ **点了没反应**。现在改走 `patchSettings({ theme })`，
  并删掉 `theme-changed` 这条死菜单动作。验收：单测守卫「设置只有一个写入口」
  （`src/main/**` 除白名单外不许出现 `kvSet('settings'`，`menu.ts` 不许再碰 `settingsStore`）。
- 删掉 `electron.vite.config.ts` 里零引用的 `@codemirror/language-data` 预构建项（报告 §3.2 P1-3）。

**可访问性与对比度（报告 §5.1/§5.2）**

- **四处对比度漏洞**（含扩面后新抓到的第 5 处）：light `--ink-3` #8a919e→#7d8595、`--link`
  #2563eb→#1f57dd；dark `--ink-2`/`--ink-2b` #b3b8c0→#b6bbc3、`--ink-3` #8a9099→#949aa6、
  `--link` #6cb0f5→#84c1f9、`--find-current-bg` #428bca→#3576b0；sepia `--ink-3` #94836a→#8a7a61、
  `--accent` #8a7f6b→#857a66。实测：`--ink-3/--panel-2` = 3.11/3.25/3.14（原 2.66/2.86/2.77）、
  `--link/--panel-2` = 5.08/4.80/5.05（原 4.33/4.01）、dark `--ink-2/--elevate` = 4.63（原 4.48）、
  dark 查找当前命中白字 = 4.81（原 3.63）。`themeTokens.test.mjs` 的面矩阵从 3 个扩到 **4 个**
  （补 `--elevate`），`--ink-3`/`--accent` 四表面各守 3:1，链接与 find 三色单独成测。
  导出模板（`lib/export.ts`）同步，`docs/design-tokens.md` 重算。
- **专注模式把退出入口一起藏掉**（报告 §5.2 P0-2）：工具栏被 `v-if` 卸载时，专注开关（它就在
  工具栏里）随之消失，而原注释声称"状态栏也能切回来" —— 状态栏并没有那个入口。
  现在专注模式下多一枚悬浮退出胶囊（右下、半透明、hover/focus 变实、三语标签），并改掉错注释。
- **状态栏 `⋯` 浮层**：`z-50` → `z-[var(--z-popover)]`（原层级比 dialog/page 都低，会被压住）；
  补 `role="menu"`/`role="menuitem"`/`aria-haspopup` 与 ↑↓、Home/End、Esc（关闭并把焦点还给触发按钮）。
  z 守卫从"只拦 `z-[数字]`"扩到**Tailwind 命名数字档**（只留 Settings 页吸顶栏一处豁免）。
- **侧栏「文件 / 大纲」页签补 tabs 语义**（报告 §5.2 P1-5）：`role=tablist/tab`、`aria-selected`、
  roving `tabindex`、`aria-controls` ↔ `role=tabpanel`/`aria-labelledby` 闭环，并加 ←/→/Home/End 切换。
  顺带修正 `_verify-a11y` 里量错控件的断言（它此前量的是文件树里的树/列表分段控件，
  顶部页签是零覆盖）。`_verify-a11y` 23 → **31 条**。

**i18n（报告 §5.4）**

- 英文硬编码纳入门禁：新增扫描器（模板文本节点里 ≥3 个单词的英文句子 +
  `aria-label`/`title`/`placeholder`/`alt` 里未绑定的英文），并修掉两处真实案例
  （状态栏标语改走语言包、`aria-label="submenu"` 走 `t('common.submenu')`）。
- 删掉 `en-US`/`ru-RU` 里重复的 `toast.encodingLossySave`（JSON 取后者，静默覆盖前者）；
  俄语 `wordGoalValue` 从 `{n} слов` 改成复数中性的 `Слов: {n}`；设置页备份时间补 locale。

**工程与文档（报告 §6）**

- **端到端接进 PR 门禁**：`cdp.yml` 拆成 `cdp-pr`（`pull_request` + `--ci-subset` + **阻塞**）与
  `cdp`（夜间/手动 + `continue-on-error`）。此前"合并前没有任何端到端红灯"。
- **Ctrl+F 的分流改成看"最近一次交互在哪儿"**：原来把"指针此刻悬在侧栏"与"焦点在侧栏"等权，
  于是"鼠标停在侧栏（上一次交互的残留）→ 点进正文 → Ctrl+F"会打开侧栏的文件名搜索。
  新增 `lib/pointerRegion.ts` 记指针/焦点交互的时序，`ctrlFTarget` 增加
  `sidebarPointerRecent` 一档（焦点在侧栏 → 侧栏；最近动的是鼠标且在侧栏 → 侧栏；
  否则焦点在编辑区 → 正文）。`tests/ctrlFRoute.test.mjs` 6 → 9 条。
- 子菜单浮层加**语言无关**锚点 `data-context-submenu`：它的 `aria-label` 现在走语言包
  （中文界面是「子菜单」），4 个套件里 5 处按字面量 `aria-label="submenu"` 定位的选择器
  全部改用它 —— 否则那条契约会在下次改文案时继续骗人。
- `docs/_audit/` 纳入 `docsClaims` 扫描域 + 6 份快照加「历史快照」横幅；
  纳管第一轮即抓出 3 条失效引用（逐条登记理由，不整目录豁免）。
- 新增 `docs/optimization-waves.md`：逐条记录桌面评审报告各项的处理状态 / 证据 / 验收口径 /
  剩余工作（波次 1 完成，波次 2 待做清单在文末）。

### Changed

- **大纲搬回左栏时恢复到"放到右侧之前"的那一页**（用户口径）：
  打开前停在「文件」⇒ 搬回左侧后仍是「文件」；停在「大纲」⇒ 仍是「大纲」。
  实现只多了一件事：`useOutlineSide` 在**打开的那一刻**把左栏页签记进
  `ui.sidebarTabBeforeOutlineRight`（会话内、不落库），关掉时放回去并清空 ——
  没有记录时（例如启动时 `outlineOnRight` 已经是 true）退回「大纲」，
  因为那一步刚把大纲搬回左栏，亮起它最不容易让人迷惑。
  取代了上一轮"关掉时一律切到大纲"的写法。验收只跑这一个功能的套件
  （`_verify-sidebar-root-and-outline-side` 34 → 36 条），未复跑默认矩阵（用户要求）。
- **没打开文件夹时，侧栏彻底空着；Ctrl+F 在侧栏里改搜文件名**（用户口径，同一轮三条）：
  - **去掉侧栏顶部那一小行「打开文件夹」**：原来没有工作区时它会出现（`data-sidebar-open-folder`），
    有工作区时那一行本来就不存在（文件夹名是目录树的顶层节点）。现在**整个侧栏**里都没有它了；
  - **文件区里一个按钮、一句提示都不再出现**：随之下线的是**首次引导块**
    （`OnboardingPanel.vue`：标题 + 说明 + 新建文件 / 打开文件夹 / 插入示例 + 示例说明）——
    它的出现条件正是"新建的空白窗口"（没有工作区 + 还没有真正在编辑的东西）。
    一个没有界面的功能不留死码，所以 `lib/onboarding.ts`、`tests/onboarding.test.mjs` 与
    三语 `onboarding.*`（含整篇示例文档）一起删掉。入口仍在「文件」菜单（含最近文档 / 最近文件夹）、
    Ctrl+N / Ctrl+O 与窗口跳转列表里 —— 侧栏空着就是空着；
  - **Ctrl+F 在左侧栏里 → 侧栏的文件名搜索**：判据从"焦点在 `[data-sidebar-files]` 里"
    放宽成"焦点**或指针**在整个左侧栏里"（新增 `data-sidebar-root` 区域锚点）。
    旧判据漏掉三种现场：焦点在侧栏**页签**上、点在树行之间的**空白**（焦点没挪进面板）、
    鼠标在侧栏里而焦点还在编辑器 —— 那三种都还会弹出正文查找栏，正是用户报的现象。
    规则收在纯函数 `lib/ctrlFRoute.ts`（`tests/ctrlFRoute.test.mjs` 6 条）；两条边界照旧走正文查找：
    没有工作区（没有文件名可筛）、左栏正在显示大纲（那份搜索框此刻不可见）。
- **状态栏重排为「左=文档｜右=视图与入口」，并去掉版本号 / 语言 / 主题 / 阅读时长**（用户口径）：
  - **删**：`v1.0.0`（版本号只在「关于」里）、语言切换按钮、主题切换弹层、预计阅读时长；
  - **标签格改成"有标签才显示"**：没标签时不占位、不写"添加标签"——状态栏只放"会变化的状态"，
    不放"可以做什么"；第一次加标签的入口搬到右侧 `⋯`（那条入口不依赖"已经有标签"，不留死角）；
  - **左 = 文档**：字数 / 行数 / 字符数（+ 目标字数，设了才有）→ 标签；
  - **右 = 视图与入口**：行:列 / 编码 / 行尾 → `⋯`（主题、语言、添加标签、设置、关于）；
  - 这样这一行从 11 项降到 4–6 项，且每类都有固定位置（原来统计被 `flex-1` 顶到正中间，
    眼睛有三个落点）。阅读时长的**口径与纯函数**保留在 `shared/readingTime.ts`（仍被目标字数共用、
    单测仍在），只是不再显示。
- **顶部菜单栏 / 快捷工具栏 / 状态栏统一为「纸」色（一张纸到底）**（用户口径）：
  前两条栏 `bg-app` → `bg-paper`；**状态栏也跟着从 `bg-transparent` 改成 `bg-paper`**
  （§4.81 的"透明"口径被这一轮取代）。浅色主题下原来是"外壳 `#fafafa` + 白纸"两段式，
  而两者只差 **≈1.04:1**（深色 ≈1.16:1）—— 两段式只在深色成立、浅色下读起来像"没对齐的白"。
  现在菜单栏 / 快捷工具栏 / 写作区 / 状态栏是同一块纸色，整个窗口只剩**左侧栏**是外壳灰，
  边界靠两条 `border-b` 发丝线交代；状态栏仍然不画 `border-t`（它是一行信息，不是一条带子）。
  深色与羊皮纸主题各自跟随 `--paper`（口径是"与编辑区同色"，不是写死 `#fff`）。
  验收：`_verify-bars-no-filename.js` 21 → **24 条**（新增：菜单栏、快捷工具栏、状态栏的
  computed background 必须等于 `--paper` 的解析值；并断言当前主题下 `--paper` ≠ `--app`，
  否则前三条等于没验）。
- **状态栏去掉「保存状态」那一格，整条改为透明**（用户口径）：不论自动保存还是手动保存都不再显示
  保存状态（原先那格写着「保存中／未保存的更改／已保存」，失败时变 danger 色，点开还能切保存方式）；
  同时 `bg-app` → `bg-transparent` 并**去掉顶部分隔线** —— 它不再是"压在页面底下的一条带子"。
  保存结果的反馈仍在：成功 = 内容落盘 + 标题栏脏标记消失，失败 = 通知中心的持久卡片；
  保存方式只剩「设置 → 通用 → 自动保存」一个入口（连同那层弹层与 11 个 i18n 键一起删除，
  否则就是零引用死键）。新增 `data-status-bar` 锚点：`_verify-bars-no-filename` 原先靠
  `h-7 + border-t` 嗅探这条栏，去掉边框后会以"状态栏不存在"的形式假红。
- **手动保存模式下关窗会问「是否保存更改？」**（用户口径，对齐 Typora 的实测行为）：
  自动保存关着（本项目出厂默认）且当前文档有未保存改动时，关窗 / 退出应用前弹三选一
  ——「保存 / 不保存 / 取消」（标题「是否保存更改？」，正文「如果不保存，您的更改将会丢失。」）。
  改造前是**一句都不问**：`flushAll()` 直接把有路径的文档落盘、未命名文档只写草稿
  （老注释写的是"避免关闭时弹出保存对话框"）—— 对选了手动保存的用户来说，
  那是"我没让它保存，它自己保存了"。
  - 判定收在纯函数 `shared/closePrompt.ts`（`tests/closePrompt.test.mjs`）：自动保存开着 → 不问
    （改动本来就在写盘路上）；系统关机/注销（`session-end`）→ 不问（没人能点那个按钮）；
    手动 + 脏 → 问；
  - **保存** → `files.save()` 后落盘关窗；**保存没成功（另存为被取消 / 写盘失败）则不关窗**
    （用户以为自己保存了是最糟的结果）；
  - **不保存** → 不落盘，并把这一篇的草稿一起删掉（否则下次启动又弹"检测到未保存的草稿"，
    与刚选的"不保存"自相矛盾）。这里有两个必须堵住的口子，都是实测踩出来的：
    ① `EditorView.onBeforeUnmount` 还会兜底调一次 `flushAll()`（它会保存有路径的文档 + 写草稿），
    所以加了 `files.discardOnClose` 让它变成空操作；② 草稿写盘是"发了不等"的，
    关窗时要先把**已经在飞**的那一次等回来再删（`files.draftWrite`），否则它的 IPC 落在删除之后、
    草稿又回到磁盘上；
  - **取消** → 窗口继续活着。这需要主进程配合，两件事：
    ① 新增 `app:cancelClose`（`main/ipc.ts`）撤掉这一轮的关窗守卫 —— 不撤的话兜底计时器照跑
    （连续 2.5 秒没心跳就强关），用户点了「取消」却看着窗口关掉；顺带 `session.clearQuitting()`
    复位（它是"窗口槽位要不要保留"的判据，留着会让之后的单独关窗被误当成整体退出）；
    ② 心跳带 `deciding: true` 表示"正等人回答"：这段等待**不计入 30 秒总上限** ——
    兜底的总上限防的是"渲染进程卡死却一直发心跳"，而用户在对话框前想多久都是合法的
    （实测口径：等 32 秒后窗口仍活着，卡死仍由"心跳停了 2.5 秒"兜底）；
  - `app:before-close` 的 payload 多带一个 `reason`（`window` / `quit` / `session-end`），
    渲染层据此决定问不问 —— 这也让"系统关机不问"成为一条**写下来的口径**，
    而不是靠"反正也来不及"。
  - 三选一确认框加在既有的 `ModalHost` 上（`ui.confirmTriple`，钩子 `data-triple-*`）：
    两键的 `ui.confirm` 表达不了"保存 / 不保存 / 取消"三个答案，
    而用两张对话框串起来最容易出的事故是"我问了保存吗？他以为是取消"。
- **侧栏头部整行去掉，文件夹成为目录树的顶层节点（Typora 式）**（用户口径）：
  原先那一行是「📁 文件夹名（点击重新选文件夹）+ 最近文档 + 新建文件」（列表视图下还有刷新），
  本轮整行摘掉，`FileTree` 的**第一行**改为工作区文件夹本身 —— 可展开/收起、可当拖放落点
  （把条目移回根）、右键就是「根菜单」（新建文件 / 新建文件夹 / 刷新 / 关闭工作区）。
  连带三件事：
  - 顶层文件夹那一行**不是**工作区里的普通条目：不能拖动、不能重命名、不能删除
    （删掉它 = 删掉整个工作区），`TreeNode` 用新的 `isRoot` 分支关掉这些动作；
  - 根菜单抽成 `composables/useWorkspaceRootMenu.ts`：树的空白处与顶层文件夹那一行弹的是
    **同一份**（两处各写一份的话，"根上能做什么"会慢慢走样）；
  - 「刷新」跟着从头部搬到面板底部的文件工具带，仍然**只在列表视图**下出现
    （树视图由主进程 `fs.watch` 自更新，用不到它）；树视图下它的旧位置不再有任何按钮。
  - 没有工作区时头部那枚「打开文件夹」**后来也去掉了**（§4.84 的同一轮口径：
    没开文件夹时侧栏完全空着）—— 这一条在下面那条新口径里，这里只留个指路。
  - 删除 `components/SidebarRecentButton.vue`（零引用）：最近文档的入口仍在
    顶部「文件 → 最近文档」二级菜单与 Windows 跳转列表里。
- **大纲位置（左侧边栏 ⇄ 编辑区右侧）进入顶部工具栏的视图区**（用户口径）：
  快捷工具栏的模式分段控件右侧多了一枚状态开关（`data-outline-side`），active 高亮 = 现在在右侧，
  提示文案说**下一步**（「把大纲放到编辑区右侧（三栏）」/「把大纲放回左侧边栏」）。
  同时补进应用内「视图」菜单、原生菜单（`outline-side` 命令）与命令注册表（`view.outlineSide`，出厂不绑键）。
  实现只有一份：`composables/useOutlineSide.ts`（设置面板那枚开关也改成转发它）——
  打开时"右侧面板展开 + 左栏页签收回文件"，关掉时"左栏页签切到大纲"，
  关掉那一条是本轮新增：把大纲搬回左栏后页签跟着亮起来，用户才看得到它去哪了。
- **侧栏底部工具带（搜索 / 刷新 / 树-列表切换）的出现与消失都有动效**（用户口径）：
  原先只有 `opacity .15s`，`visibility` 会在过渡一开始就翻成 hidden，把仍在淡出的那一帧掐掉
  （进去柔和、出来生硬）。现在隐藏是"淡出 + 下沉 6px 走完才翻 visibility"（`visibility` 延迟 0.18s），
  出现是反向的同一组过渡，只动 `opacity` / `transform`（合成层），
  `prefers-reduced-motion` 下三样全关。
- **文件树选中态去掉左侧那条 3px 浅灰色条，只留层级竖线**（用户口径：两条线并存有点冗余）：
  选中已经有整行 `--accent-soft` 底 + `--accent-ink` 文字（500 字重）+ `--accent` 图标三重提示，
  灰条是第四重、而且是**唯一的中性色**信号（一灰一蓝说同一件事）；它又贴在侧栏最左缘、
  层级深时离该行内容 40px 以上，指示作用已被竖线与缩进抢走。层级竖线
  （`[data-tree-children]::before`，38% 透明度、只在展开目录下出现）不表达状态，保留。
  `_verify-sidebar-tree-style.js` 的断言从"3px 灰条存在"改成"没有那条 `::before`"，
  并保住 `selected-state-does-not-shift-content`（挂/摘选中态 `label` 左缘一像素不差）。

### Added

- `tools/_verify-close-save-prompt.js`（**21 条**断言，自管实例 4 轮，已进默认矩阵）：关窗三选一的
  三条出路各跑一遍真实 UI 路径 —— 弹框文案逐字（「是否保存更改？」/「如果不保存，您的更改将会丢失。」）、
  三个按钮、**取消后窗口必须跨过 2.5 秒兜底仍活着**（`app:cancelClose` 的回归防线）、
  **保存失败（另存为被取消）也不许关窗**、**在对话框前等 32 秒（跨过 30 秒总上限）也不许被强关**、
  不保存则磁盘不动 + 草稿被删、保存则落盘后再关、以及自动保存开着时**不弹框**直接落盘。
  `tests/closePrompt.test.mjs`（5 条）钉住判定规则本身。
- `tools/_verify-sidebar-root-and-outline-side.js`（**31 条**断言，已进默认矩阵）：把上面三件事钉在
  真实界面上 —— 头部不再有文件夹名/最近/新建、顶层节点是工作区根且子级整体下沉一级、
  顶层行右键只有根菜单且不含重命名/删除、工具带的过渡参数（含 visibility 的延迟）与真实悬停进出、
  「刷新」只在列表视图的工具带里、工具栏开关与「视图」菜单项是同一条实现。
  同时把 `_verify-sidebar-search.js` 的边界用例从"头部工作区按钮"换成"侧栏页签"
  （那一行已不存在）。

> 说明：本文件里的**数字与断言条数是当时的实测值**（历史记录不追改）；会漂的数字
> （文件数/行数、夹具分类、套件条数）只在 README 与 `tools/README.md` 的
> `facts` 块里维护，由 `npm run docs:facts:check` 校验。

## [1.0.0] - 2026-09-24

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

| 门禁                                   | 结果                    |
| -------------------------------------- | ----------------------- |
| `npm run typecheck`                    | exit 0（tsc + vue-tsc） |
| `npm run lint`                         | **0 error / 0 warning** |
| `npm run test:unit`                    | **57/57 pass**          |
| `npm run ci`                           | exit 0（上四项 + 构建） |
| `npm run build`                        | exit 0                  |
| `tools/_verify-draft-banner.js`        | 25/25                   |
| `tools/_verify-new-document.js`        | 23/23                   |
| `tools/_verify-session.js`             | 17/17                   |
| `tools/_verify-session-last-closed.js` | 8/8                     |
| `tools/_verify-taskbar-jumplist.js`    | 31/31                   |
| `tools/_verify-local-media.js`（新增） | 10/10                   |

### 仍待办（按仓库整改方案排序）

- **Wave 1**：~~Markdown 往返保真套件~~ → **本轮已完成**，见下一节。
- **Wave 2**：文档级元数据模型（编码 / EOL / BOM 落库）、本地历史与回滚、以编码/EOL 保存。
- **Wave 3**：编辑器 ⇄ store 显式意图状态机；文件树键盘可达；原生日志文案接三语。
- **工程化**：~~`tools/lib/harness.js` + `tools/run-suites.js`~~ → **本轮已完成**；
  剩余：`files` store 拆分；`store` 里那份为绕循环导入而复制的 `confirmIfDirty` 收敛到 `services/dialog`。

---

> 归档口径（清单 §10 P2：文档规模已经超过人工同步能力；主文件只留基线 + 最新版本段）：
> `## [1.0.0]` 之后的 **50 个历史小节**已逐字搬到
> [`docs/changelog/archive-02.md`](docs/changelog/archive-02.md)；更早的 40 轮（含「历史主题汇总」）在
> [`docs/changelog/archive-01.md`](docs/changelog/archive-01.md)。
