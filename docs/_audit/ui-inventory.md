> ⚠️ **历史快照（2026-09 前后）**：本文件记录的是**当时**的状态与判断，勿当作现状引用；docs/ 的现状口径见手册与 README。路径引用可能已随代码演进失效（纳入 	ests/docsClaims.test.mjs 前已逐条登记）。

# Lumin 面向用户控件接线审计（只读静态审计）

- 审计对象：`D:\code_workspace\Lumin`（Electron 39 / Vue 3.5 / Tiptap 3.31 / vue-i18n 11 / Pinia / SQLite）
- 审计方式：**纯静态**（read / grep / glob + 只读 PowerShell 扫描）。未运行 npm、未启动 Electron、未修改 `src/` 下任何文件、未提交 git。
- 审计产出：`docs/_audit/ui-inventory.md`（本文件的**唯一**新增内容；`docs/_audit/` 目录与同目录另两份审计在本会话期间一并产生）
- 关于 git：**本次审计没有执行任何写操作**（未 `add`、未 `commit`）。但本会话期间**另一个并发进程/代理**在同一工作区创建了提交 `3843195`（2026-09-16 21:01:59，`test(docs): 日常与深度使用验收：逐控件盘点 + i18n/设置/IPC/覆盖矩阵四份审计…`），该提交把本文件当时的快照一并纳入版本库；本文档最后一行修正（摘要里的「34 条 → 42 条」）当前仍以 `M docs/_audit/ui-inventory.md` 的形式留在工作区。除本文件外，本会话未改动 `src/` 与任何其它文件。
- 口径：
  - **是否接线** = 控件 → 处理函数 → store/IPC → 主进程/编辑器内核 这条链路上每一跳都存在且不是占位实现。`部分` = 链路通但行为与文案/预期不符，或只在某些模式下通。
  - 「显示文案」优先写 i18n key；直接写中文表示**硬编码**（这是缺陷线索，见 §3）。
  - 行号取自本次审计时的文件内容（文件尾部总行数已核对）。
- 统计：**逐条列出控件 281 行** —— 原生菜单 42 行（含 3 个容器子菜单与 5 个 mac 专属项）、应用内菜单 47 行、工具栏 24、编辑器视图内 12、状态栏 10、侧边栏 35、查找替换 8、全局搜索 8、通知中心 6、模态宿主 4（另 6 条触发面）、本地历史 4、设置面板 40、设置·快捷键 6、编辑器右键菜单 30 个动作（表内 24 行，表格删除类合并）、文件树右键 4（文字列出）、关于页 5。快捷键体系共 **48** 条：应用级命令注册表 26 条 + 编辑器内核/局部按键 22 条（详见 §1.17）。
- **本文件是本次审计唯一新增/修改的文件**；`src/` 未改动，未运行 npm/electron，未做 git 写操作（工作区里存在另一并发进程在 21:01:59 创建的提交 `3843195`，见文件头说明）。

---

## 0. 摘要（先看这条）

**两条最重的结论：**

1. **原生应用菜单整条链路当前不可达**（`src/main/index.ts:255` 启动即 `setMenuBarVisibility(false)` + `setAutoHideMenuBar(false)`，而渲染层从未调用 `app.setMenuBar`，见 §3 D1）——所以 `src/main/menu.ts` 里那 42 条三语菜单项（含导出子菜单、主题子菜单、重新加载、开发者工具、项目主页）**用户看不到、点不到**。它们的 i18n 与语种切换逻辑本身是正确的（51 个 `menu.*` 键全部被引用，无死键）。
2. **设置面板与「关于」页几乎整体未走 i18n**（`SettingsDialog.vue` 92 行含中文、`AboutView.vue` 8 行含中文且完全没引入 `useI18n`），同时 `settings.themeDesc / fontSans / pdfMargin / languageDesc …` 等键**已经存在却没人用**（附录 A）。三语用户切到 en-US / ru-RU 后，设置面板与关于页仍是中文。

另外两个「功能级」缺陷：**打字机模式根本不存在**（点了只弹「功能待接入」，`useAppActions.ts:140`）、**编辑区选区浮动菜单被代码写死关闭**（`WysiwygEditor.vue:213` `BUBBLE_MENU_ENABLED = false`，7 个按钮永不渲染）。

---

## 1. 总览表

> 说明：绝大多数控件**没有稳定 DOM id**，只有少数带 `data-*` 钩子（`data-status-*` / `data-tree-*` / `data-history-*` / `data-setting-*` / `data-command` / `data-encoding-item` / `data-outline-item` / `data-local-history`）。其余只能用「结构选择器 + title 文案」定位，而 title 文案随语言变化 —— 这对后续 CDP 测试是实打实的障碍（§4 R14）。

### 1.1 原生应用菜单（`src/main/menu.ts`，42 条，全部不可达，见 D1）

| 来源        | 控件 id/选择器                 | 显示文案（i18n key）        | 绑定的动作/命令                                               | 是否接线                                   | 备注                                                  |
| ----------- | ------------------------------ | --------------------------- | ------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| menu.ts:56  | mac: app 菜单 → about          | `menu.about` → `T('about')` | `role: 'about'`                                               | 否（不可达+仅 mac）                        | 菜单条隐藏；且 `role:'about'` 无自定义 label 生效路径 |
| menu.ts:62  | mac: services                  | （无 label）                | `role: 'services'`                                            | 否（仅 mac）                               | —                                                     |
| menu.ts:64  | mac: 隐藏                      | `menu.hide`                 | `role: 'hide'`                                                | 否（仅 mac）                               | —                                                     |
| menu.ts:65  | mac: 全部显示                  | `menu.unhide`               | `role: 'unhide'`                                              | 否（仅 mac）                               | —                                                     |
| menu.ts:67  | mac: 退出                      | `menu.quit`                 | `role: 'quit'`                                                | 否（仅 mac）                               | —                                                     |
| menu.ts:75  | 文件 → 新建                    | `menu.new`                  | `send('new')` → `handleMenu('new')` → `newDocumentWindow()`   | 链接线，UI 不可达                          | 与 TopMenuBar/快捷键三处一致                          |
| menu.ts:76  | 文件 → 打开…                   | `menu.openFile`             | `send('open')`                                                | 链接线，UI 不可达                          | —                                                     |
| menu.ts:77  | 文件 → 打开文件夹…             | `menu.openFolder`           | `send('open-folder')`                                         | 链接线，UI 不可达                          | —                                                     |
| menu.ts:79  | 文件 → 保存                    | `menu.save`                 | `send('save')`                                                | 链接线，UI 不可达                          | —                                                     |
| menu.ts:80  | 文件 → 另存为…                 | `menu.saveAs`               | `send('save-as')`                                             | 链接线，UI 不可达                          | —                                                     |
| menu.ts:83  | 文件 → 导出                    | `menu.export`               | 容器（子菜单）                                                | 链接线，UI 不可达                          | —                                                     |
| menu.ts:85  | 文件 → 导出 → PDF              | `menu.exportPdf`            | `send('export-pdf')`                                          | 链接线，UI 不可达                          | —                                                     |
| menu.ts:86  | 文件 → 导出 → HTML             | `menu.exportHtml`           | `send('export-html')`                                         | 链接线，UI 不可达                          | —                                                     |
| menu.ts:87  | 文件 → 导出 → Word (.doc)      | `menu.exportWord`           | `send('export-word')`                                         | 链接线，UI 不可达                          | —                                                     |
| menu.ts:88  | 文件 → 导出 → EPUB             | `menu.exportEpub`           | `send('export-epub')`                                         | 链接线，UI 不可达                          | —                                                     |
| menu.ts:93  | mac: 关闭窗口                  | `menu.closeWindow`          | `role: 'close'`                                               | 否（不可达，且仅 mac）                     | Windows 分支没有这一项，见 D27                        |
| menu.ts:94  | 非 mac: 退出                   | `menu.quit`                 | `role: 'quit'`                                                | 否（不可达）                               | `role:'quit'` 带平台默认加速键                        |
| menu.ts:100 | 编辑 → 撤销                    | `menu.undo`                 | `role: 'undo'`                                                | 否（不可达；角色默认键 Ctrl+Z 疑似仍生效） | 见 D23                                                |
| menu.ts:101 | 编辑 → 重做                    | `menu.redo`                 | `role: 'redo'`                                                | 否（同上；角色默认键 Ctrl+Y）              | 见 D23                                                |
| menu.ts:103 | 编辑 → 剪切                    | `menu.cut`                  | `role: 'cut'`（Ctrl+X）                                       | 否（同上）                                 | —                                                     |
| menu.ts:104 | 编辑 → 复制                    | `menu.copy`                 | `role: 'copy'`（Ctrl+C）                                      | 否（同上）                                 | —                                                     |
| menu.ts:105 | 编辑 → 粘贴                    | `menu.paste`                | `role: 'paste'`（Ctrl+V）                                     | 否（同上）                                 | —                                                     |
| menu.ts:106 | 编辑 → 全选                    | `menu.selectAll`            | `role: 'selectAll'`（Ctrl+A）                                 | 否（同上）                                 | —                                                     |
| menu.ts:108 | 编辑 → 查找 / 替换             | `menu.findReplace`          | `send('find')` → `find.toggle()`                              | 链接线，UI 不可达                          | —                                                     |
| menu.ts:109 | 编辑 → 全局搜索（全文索引）    | `menu.globalSearch`         | `send('global-search')`                                       | 链接线，UI 不可达                          | —                                                     |
| menu.ts:115 | 视图 → 切换侧边栏              | `menu.toggleSidebar`        | `send('toggle-sidebar')`                                      | 链接线，UI 不可达                          | —                                                     |
| menu.ts:118 | 视图 → 编辑器模式              | `menu.editorMode`           | 容器（子菜单）                                                | 链接线，UI 不可达                          | —                                                     |
| menu.ts:120 | 视图 → 编辑器模式 → 所见即所得 | `menu.wysiwyg`              | `send('mode-wysiwyg')`                                        | 链接线，UI 不可达                          | —                                                     |
| menu.ts:121 | 视图 → 编辑器模式 → 分屏对比   | `menu.split`                | `send('mode-split')`                                          | 链接线，UI 不可达                          | —                                                     |
| menu.ts:122 | 视图 → 编辑器模式 → 源码模式   | `menu.source`               | `send('mode-source')`                                         | 链接线，UI 不可达                          | —                                                     |
| menu.ts:125 | 视图 → 专注模式                | `menu.focus`                | `send('toggle-focus')`                                        | 链接线，UI 不可达                          | —                                                     |
| menu.ts:126 | 视图 → 打字机模式              | `menu.typewriter`           | `send('toggle-typewriter')` → **占位 toast**                  | **否**                                     | 见 D2                                                 |
| menu.ts:129 | 视图 → 主题                    | `menu.theme`                | 容器（子菜单）                                                | 链接线，UI 不可达                          | 主题另有状态栏/设置入口                               |
| menu.ts:132 | 视图 → 主题 → 跟随系统         | `menu.themeAuto`            | `settingsStore.set('theme','auto')` + `send('theme-changed')` | 链接线，UI 不可达                          | 直写主进程 store（不经渲染层 settings store）         |
| menu.ts:139 | 视图 → 主题 → 浅色             | `menu.themeLight`           | 同上 `'light'`                                                | 链接线，UI 不可达                          | —                                                     |
| menu.ts:146 | 视图 → 主题 → 深色             | `menu.themeDark`            | 同上 `'dark'`                                                 | 链接线，UI 不可达                          | —                                                     |
| menu.ts:153 | 视图 → 主题 → 羊皮纸           | `menu.themeSepia`           | 同上 `'sepia'`                                                | 链接线，UI 不可达                          | —                                                     |
| menu.ts:162 | 视图 → 重新加载                | `menu.reload`               | `role: 'reload'`（默认 Ctrl+R）                               | 否（不可达，但默认键疑生效）               | D23                                                   |
| menu.ts:163 | 视图 → 开发者工具              | `menu.devtools`             | `role: 'toggleDevTools'`（默认 Ctrl+Shift+I）                 | 否（同上）                                 | D23                                                   |
| menu.ts:169 | 帮助 → 设置                    | `menu.settings`             | `send('settings')`                                            | 链接线，UI 不可达                          | —                                                     |
| menu.ts:170 | 帮助 → 关于 Lumin              | `menu.about`                | `send('about')`                                               | 链接线，UI 不可达                          | —                                                     |
| menu.ts:171 | 帮助 → 在浏览器中打开项目主页  | `menu.homepage`             | `shell.openExternal('https://github.com')`                    | **部分**                                   | URL 是占位符，见 D26                                  |

### 1.2 应用内顶部菜单 `TopMenuBar.vue`（47 条）

组定义在 `TopMenuBar.vue:172-351`；顶栏按钮 `483-489`；二级浮层 `531-593`。

| 来源               | 控件 id/选择器                                 | 显示文案（i18n key）      | 绑定的动作/命令                                                                           | 是否接线 | 备注                                                                                                       |
| ------------------ | ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| TopMenuBar.vue:483 | `.topmenu-root > button:nth-child(1)`（Alt+F） | `menu.file`               | 展开文件组                                                                                | 是       | 无 data-* 钩子                                                                                             |
| TopMenuBar.vue:483 | 第 2 个按钮（Alt+E）                           | `menu.edit`               | 展开编辑组                                                                                | 是       | —                                                                                                          |
| TopMenuBar.vue:483 | 第 3 个按钮（Alt+D）                           | `menu.paragraph`          | 展开段落组                                                                                | 是       | **原生菜单没有这一组**，D28                                                                                |
| TopMenuBar.vue:483 | 第 4 个按钮（Alt+V）                           | `menu.view`               | 展开视图组                                                                                | 是       | —                                                                                                          |
| TopMenuBar.vue:483 | 第 5 个按钮（Alt+H）                           | `menu.help`               | 展开帮助组                                                                                | 是       | —                                                                                                          |
| TopMenuBar.vue:181 | 文件 → 新建                                    | `menu.new`                | `newDocumentWindow()`（新窗口+未命名文档）                                                | 是       | 与 Ctrl+N、原生菜单同源                                                                                    |
| TopMenuBar.vue:185 | 文件 → 新建窗口                                | `menu.newWindow`          | `luminAPI.app.newWindow()`                                                                | 是       | 原生菜单缺此项（D27）                                                                                      |
| TopMenuBar.vue:187 | 文件 → 打开…                                   | `menu.openFile`           | `confirmIfDirty()` → `chooseOpenFile()` → `openExternalFile()` → `router.push('/editor')` | 是       | —                                                                                                          |
| TopMenuBar.vue:201 | 文件 → 打开文件夹…                             | `menu.openFolder`         | `files.openFolder()`                                                                      | **部分** | 未做脏数据确认（`handleMenu('open-folder')` 路径做了，`useAppActions.ts:60-64`）——同一功能两条入口行为不同 |
| TopMenuBar.vue:204 | 文件 → 最近文档                                | `open.recent`             | 二级浮层 `RecentList kind="files"`                                                        | 是       | `RecentList` 数据来自 stores/recent                                                                        |
| TopMenuBar.vue:205 | 文件 → 最近文件夹                              | `open.recentFolders`      | 二级浮层 `RecentList kind="folders"`                                                      | 是       | 选中 → `openFolderInNewWindow`                                                                             |
| TopMenuBar.vue:207 | 文件 → 保存                                    | `menu.save`               | `files.save()` + toast                                                                    | 是       | —                                                                                                          |
| TopMenuBar.vue:214 | 文件 → 另存为…                                 | `menu.saveAs`             | `files.saveAs()` + toast                                                                  | 是       | —                                                                                                          |
| TopMenuBar.vue:223 | 文件 → 导出                                    | `menu.export`             | 二级 `children`：4 种格式                                                                 | 是       | —                                                                                                          |
| TopMenuBar.vue:227 | 文件 → 导出 → PDF                              | `menu.exportPdf`          | `runExport('pdf')`                                                                        | 是       | 源码模式下内容错，D20                                                                                      |
| TopMenuBar.vue:228 | 文件 → 导出 → HTML                             | `menu.exportHtml`         | `runExport('html')`                                                                       | 是       | 同上                                                                                                       |
| TopMenuBar.vue:229 | 文件 → 导出 → Word                             | `menu.exportWord`         | `runExport('word')`                                                                       | 是       | 同上                                                                                                       |
| TopMenuBar.vue:230 | 文件 → 导出 → EPUB                             | `menu.exportEpub`         | `runExport('epub')`                                                                       | 是       | 同上                                                                                                       |
| TopMenuBar.vue:234 | 文件 → 本地历史…                               | `menu.localHistory`       | `files.openHistory()` → `ui.openLocalHistory()`                                           | 是       | 未落盘文档给提示 toast                                                                                     |
| TopMenuBar.vue:242 | 文件 → 行尾                                    | `menu.saveWithEol`        | 二级：LF / CRLF                                                                           | 是       | 这两项在原生菜单里没有                                                                                     |
| TopMenuBar.vue:247 | 文件 → 行尾 → 以 LF 保存                       | `menu.eolLf`              | `files.setEol('lf',{save:true})`                                                          | 是       | 当前项打勾                                                                                                 |
| TopMenuBar.vue:243 | 文件 → 行尾 → 以 CRLF 保存                     | `menu.eolCrlf`            | `files.setEol('crlf',{save:true})`                                                        | 是       | —                                                                                                          |
| TopMenuBar.vue:248 | 文件 → 以编码保存                              | `menu.saveWithEncoding`   | 二级：当前编码 + 13 种编码                                                                | 是       | —                                                                                                          |
| TopMenuBar.vue:151 | 文件 → 以编码保存 → 保存                       | `menu.saveWithEncoding`   | `files.save()`                                                                            | 是       | 一级与二级第一项同名，文案重复（S3，小）                                                                   |
| TopMenuBar.vue:159 | 文件 → 以编码保存 → UTF-8 …                    | `e.label`（专有名）       | `files.saveWithEncoding(id)`                                                              | 是       | 13 项                                                                                                      |
| TopMenuBar.vue:254 | 文件 → 选择编码重新打开                        | `menu.reopenWithEncoding` | 二级：自动检测 + 13 种                                                                    | 是       | —                                                                                                          |
| TopMenuBar.vue:105 | 选择编码重新打开 → 自动检测                    | `encoding.auto`           | `files.reopenWithEncoding('auto')`                                                        | 是       | 脏文档会先确认                                                                                             |
| TopMenuBar.vue:265 | 编辑 → 撤销                                    | `menu.undo`               | `editorStore.instance?.commands.undo()`                                                   | 是       | 源码模式下 instance=null ⇒ 点了无反应（D 见 §3 D42）                                                       |
| TopMenuBar.vue:266 | 编辑 → 重做                                    | `menu.redo`               | `commands.redo()`                                                                         | 是       | 同上                                                                                                       |
| TopMenuBar.vue:268 | 编辑 → 查找 / 替换                             | `menu.findReplace`        | `useFindStore().show()`                                                                   | 是       | 与原生菜单 `send('find')` 走 `toggle()` 不同（幂等差异，S3）                                               |
| TopMenuBar.vue:273 | 编辑 → 全局搜索                                | `menu.globalSearch`       | `ui.openGlobalSearch()`                                                                   | 是       | —                                                                                                          |
| TopMenuBar.vue:281 | 段落 → 代码块                                  | `editor.codeBlock`        | `toggleCodeBlock()`                                                                       | 是       | —                                                                                                          |
| TopMenuBar.vue:286 | 段落 → 引用                                    | `editor.quote`            | `toggleBlockquote()`                                                                      | 是       | —                                                                                                          |
| TopMenuBar.vue:292 | 段落 → 无序列表                                | `editor.ul`               | `toggleBulletList()`                                                                      | 是       | —                                                                                                          |
| TopMenuBar.vue:297 | 段落 → 有序列表                                | `editor.ol`               | `toggleOrderedList()`                                                                     | 是       | —                                                                                                          |
| TopMenuBar.vue:302 | 段落 → 任务列表                                | `editor.task`             | `toggleTaskList()`                                                                        | 是       | —                                                                                                          |
| TopMenuBar.vue:308 | 段落 → 分割线                                  | `editor.hr`               | `setHorizontalRule()`                                                                     | 是       | —                                                                                                          |
| TopMenuBar.vue:313 | 段落 → 提升标题级别                            | `editor.raiseHeading`     | `raiseHeadingLevel()`                                                                     | **部分** | 非标题时静默返回，无禁用态                                                                                 |
| TopMenuBar.vue:314 | 段落 → 降低标题级别                            | `editor.lowerHeading`     | `lowerHeadingLevel()`                                                                     | **部分** | 同上                                                                                                       |
| TopMenuBar.vue:322 | 视图 → 切换侧边栏                              | `menu.toggleSidebar`      | `ui.sidebarVisible` 取反 + 持久化                                                         | 是       | —                                                                                                          |
| TopMenuBar.vue:330 | 视图 → 所见即所得                              | `menu.wysiwyg`            | `setMode('wysiwyg')`                                                                      | 是       | —                                                                                                          |
| TopMenuBar.vue:331 | 视图 → 分屏对比                                | `menu.split`              | `setMode('split')`                                                                        | 是       | —                                                                                                          |
| TopMenuBar.vue:332 | 视图 → 源码模式                                | `menu.source`             | `setMode('source')`                                                                       | 是       | —                                                                                                          |
| TopMenuBar.vue:335 | 视图 → 专注模式                                | `menu.focus`              | `ui.focusMode` 取反                                                                       | 是       | 图标 `'focus'` 不在图标表 → 退化成 info 图标（D18）                                                        |
| TopMenuBar.vue:347 | 帮助 → 设置                                    | `menu.settings`           | `ui.openSettings()`                                                                       | 是       | —                                                                                                          |
| TopMenuBar.vue:348 | 帮助 → 关于 Lumin                              | `menu.about`              | `router.push('/about')`                                                                   | 是       | —                                                                                                          |
| TopMenuBar.vue:188 | 文件 → 打开…（图标）                           | 图标名 `'folder-open'`    | —                                                                                         | **否**   | 图标表里是 `folderOpen`，静默退回 info 图标（D18）                                                         |

### 1.3 编辑器工具栏 `Toolbar.vue`（24 项）

> **变更说明（本轮，晚于下表）**：工具栏已改为**由目录驱动**（`src/shared/toolbarItems.ts`），
> 项目顺序与显隐存在 `settings.toolbarItems`（`toolbarVisible` 控制整条栏的显隐）。
> 表内行号与「24 项」是审计当时（改动前）的快照，**未逐行重排**——改动后的接线如下：
>
> | 类别            | 项目                                                                                                                         | 说明                                                                                        |
> | --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
> | 可调整（21 项） | 侧边栏 / 撤销 / 重做 ‖ 标题 1-3 ‖ 加粗·斜体·下划线·删除线·行内代码 ‖ 引用·无序·有序·任务·代码块 ‖ 表格·分割线·链接·图片·目录 | id 见 `shared/toolbarItems.ts` 的 `TOOLBAR_ITEMS`；`‖` 为分组（组间画分隔线），换序只在组内 |
> | 固定（4 项）    | 模式分段控件、专注模式、导出、设置                                                                                           | 不参与排序/隐藏，避免工具栏被调成「没法切模式」                                             |
> | 新增入口        | 工具栏**空白区右键** → 关闭工具栏 / 调整工具项（二级为项目勾选列表）                                                         | `Toolbar.vue` 的 `onToolbarContextMenu`（判定：`[data-toolbar-item]` 之外即空白）           |
> | 新增入口        | 视图 → 显示快捷工具栏（应用内菜单 + 原生菜单 `toggle-toolbar`）                                                              | 关闭后唯一的「开关型」入口                                                                  |
> | 新增入口        | 设置 → 编辑器 → 快捷工具栏（开关 + 组内上/下移 + 隐藏/加入 + 恢复默认）                                                      | `SettingsToolbar.vue`；右键菜单的「调整工具项」即定位到该区块                               |
>
> 同时修掉下表两条「部分」：撤销/重做改为真 `:disabled`（D24），源码模式下编辑器命令按钮统一禁用（D25）。

| 来源                           | 控件 id/选择器                   | 显示文案（i18n key）                               | 绑定的动作/命令                               | 是否接线 | 备注                                                                        |
| ------------------------------ | -------------------------------- | -------------------------------------------------- | --------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| Toolbar.vue:228                | `.icon-btn[title^="切换侧边栏"]` | `menu.toggleSidebar` + `(Ctrl+Shift+B)`            | `ui.sidebarVisible` 取反 + 持久化             | 是       | Ctrl+Shift+B 与 keymap 一致                                                 |
| Toolbar.vue:239                | `.icon-btn[title="撤销"]`        | `editor.undo`                                      | `chain().focus().undo()`                      | **部分** | `!canUndo()` 只改透明度（`opacity-40`），未 `:disabled`（D24）              |
| Toolbar.vue:247                | `.icon-btn[title="重做"]`        | `editor.redo`                                      | `chain().focus().redo()`                      | **部分** | 同上                                                                        |
| Toolbar.vue:259                | 加粗                             | `editor.bold`                                      | `toggleMdBold()`                              | **部分** | 源码模式 instance=null ⇒ 静默 no-op 且无禁用（D42）                         |
| Toolbar.vue:259                | 斜体                             | `editor.italic`                                    | `toggleMdItalic()`                            | **部分** | 同上                                                                        |
| Toolbar.vue:259                | 下划线                           | `editor.underline`                                 | `toggleUnderline()`                           | **部分** | 同上；Underline 由 StarterKit 默认注册，命令存在                            |
| Toolbar.vue:259                | 删除线                           | `editor.strike`                                    | `toggleMdStrike()`                            | **部分** | 同上                                                                        |
| Toolbar.vue:259                | 行内代码                         | `editor.inlineCode`                                | `toggleMdCode()`                              | **部分** | 同上                                                                        |
| Toolbar.vue:273                | 标题 1/2/3（三个按钮）           | `editor.heading` + 序号                            | `toggleHeading({level})`                      | **部分** | 同上                                                                        |
| Toolbar.vue:288                | 引用                             | `editor.quote`                                     | `toggleBlockquote()`                          | **部分** | 同上                                                                        |
| Toolbar.vue:288                | 无序列表                         | `editor.ul`                                        | `toggleBulletList()`                          | **部分** | 同上                                                                        |
| Toolbar.vue:288                | 有序列表                         | `editor.ol`                                        | `toggleOrderedList()`                         | **部分** | 同上                                                                        |
| Toolbar.vue:288                | 任务列表                         | `editor.task`                                      | `toggleTaskList()`                            | **部分** | 同上                                                                        |
| ToolbarCodeBlockButton.vue:136 | 代码块按钮                       | `editor.codeBlock`                                 | `toggleCodeBlock()`                           | **部分** | 同上；同文件 167 行有行号开关弹层 → `settings.set('codeLineNumbers')`（是） |
| ToolbarTableButton.vue:130     | 表格按钮                         | `editor.table`                                     | `insertTable(3,3)` / 悬停网格选择器           | 是       | 弹层被表格/代码块包裹时落到文末插入                                         |
| Toolbar.vue:304                | 分割线                           | `editor.hr`                                        | `setHorizontalRule()`                         | 是       | —                                                                           |
| Toolbar.vue:307                | 链接                             | `editor.link`                                      | `ui.prompt('插入链接','https://example.com')` | **部分** | 弹窗标题/占位硬编码中文（D13）                                              |
| Toolbar.vue:310                | 图片                             | `editor.image`                                     | `ui.prompt('插入图片','图片地址 / 相对路径')` | **部分** | 同上                                                                        |
| Toolbar.vue:313                | 目录                             | `editor.toc`                                       | `insertTableOfContents()`                     | 是       | 图标用了 `list`（与无序列表同图标，S3）                                     |
| Toolbar.vue:324                | 模式分段控件（3 段）             | `editor.wysiwyg/split/source`，title 带 `(Ctrl+/)` | `setMode(v)` via `useEditorMode`              | 是       | title 里写死 `Ctrl+/`，用户改了 `view.cycleMode` 后提示不会更新（S3）       |
| Toolbar.vue:334                | 专注模式                         | `editor.focus` + `(Ctrl+Shift+F)`                  | `ui.focusMode` 取反                           | 是       | —                                                                           |
| Toolbar.vue:347                | 导出                             | `editor.export`                                    | 展开弹层（4 项）                              | 是       | 弹层项 `editor.exportPdf/Html/Word/Epub`                                    |
| Toolbar.vue:357                | 设置                             | `settings.title`                                   | `ui.openSettings()`                           | 是       | —                                                                           |
| —                              | （缺）保存                       | —                                                  | —                                             | —        | **工具栏没有保存按钮**，而设置面板文案提到「保存按钮」（D41）               |

### 1.4 编辑器视图内控件（`EditorView.vue` / `WysiwygEditor.vue` / `CodeBlockView.vue`，12 项）

| 来源                      | 控件 id/选择器                               | 显示文案（i18n key）                                                                  | 绑定的动作/命令                                                        | 是否接线           | 备注                                                        |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| EditorView.vue            | 草稿弹窗 → 恢复                              | `common.restore`                                                                      | `files.applyDraftRestore(true)`                                        | 是                 | 本轮从「编辑区上方的内联横幅」改成**独立弹窗**（强制选择）  |
| EditorView.vue            | 草稿弹窗 → 丢弃                              | `common.discard`                                                                      | `files.applyDraftRestore(false)`                                       | 是                 | 同上；弹窗 `role=dialog` + `aria-modal` + `aria-labelledby` |
| EditorView.vue:563        | `.split-divider`                             | `title="拖动调整左右比例（双击复位）"`（硬编码）                                      | `startSplitDrag` / `resetSplitRatio`                                   | 是                 | 文案硬编码（D15）                                           |
| EditorView.vue:595        | `.split-sync-chip`                           | `title` 三元 `同步滚动已开启（点击关闭）`/`开启同步滚动`；正文 `同步滚动`（均硬编码） | `settings.set('syncScroll', !)`                                        | 是                 | 文案硬编码（D15）；与设置面板同一 setting                   |
| WysiwygEditor.vue:329-375  | `.bubble-btn` × 7                            | 硬编码 `加粗/斜体/下划线/删除线/行内代码/链接/清除格式`                               | `toggleMdBold/Italic/Underline/Strike/Code`、`addLink`、`clearFormats` | **否（永不渲染）** | `BUBBLE_MENU_ENABLED=false`（:213）整块死代码（D3）         |
| CodeBlockView.vue:661     | `.code-block-select`                         | 语言名（javascript…mermaid）                                                          | `watch(selectedLanguage)`（:339）写回节点                              | 是                 | 无 aria-label                                               |
| CodeBlockView.vue:668     | `.mermaid-render`                            | `title="点击编辑源码"`（硬编码）                                                      | `startMermaidEdit`                                                     | 是                 | 文案硬编码（D16）                                           |
| CodeBlockView.vue:695     | `.cm-editor-container`                       | —（无文案）                                                                           | CodeMirror 6 编辑岛                                                    | 是                 | —                                                           |
| App.vue:105               | `.sidebar-handle`                            | `sidebar.expand`                                                                      | `expandSidebar()`                                                      | 是                 | 有 title + aria-label                                       |
| App.vue:92                | `<TopMenuBar v-if="settings.nativeMenuBar">` | —                                                                                     | —                                                                      | 是                 | 开关语义见 D22                                              |
| App.vue:138               | `SkeletonScreen`                             | `LUMIN`                                                                               | 无（启动骨架）                                                         | 是                 | `ui.booting` 控制                                           |
| EditorContextMenu.vue:236 | `.ecm-panel`（编辑器右键菜单）               | 见 §1.14                                                                              | —                                                                      | 是                 | —                                                           |

### 1.5 状态栏 `StatusBar.vue`（10 项）

> ⚠️ **本节是当时（审计时）的快照，行号与构成都已过时**：此后状态栏改过三轮 ——
> §4.81 去掉最左那格「保存状态」（连带保存方式弹层）、§4.82 整条与编辑区同为纸色、
> §4.83 去掉版本号/语言/主题/阅读时长并把标签格改成"有标签才显示"、整条重排为
> 「左=文档（统计/目标/标签）｜右=视图与入口（行列/编码/行尾 + `⋯`）」。
> 下面这些行保留下来是为了对照**当时的**判断（含 D32/D40 两条发现），不要再照它改代码。

| 来源              | 控件 id/选择器       | 显示文案（i18n key）                                                         | 绑定的动作/命令                                              | 是否接线         | 备注                                                                      |
| ----------------- | -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------- |
| StatusBar.vue:102 | 保存状态区（左）     | `statusbar.manualSave` / `editor.saving` / `editor.unsaved` / `editor.saved` | 打开保存方式弹层                                             | 是               | —                                                                         |
| StatusBar.vue:145 | 保存方式 → 自动保存  | `statusbar.autoSave` + `settings.autoSaveDesc`                               | `settings.set('autoSave', true)` + toast                     | 是               | —                                                                         |
| StatusBar.vue:172 | 保存方式 → 手动保存  | `statusbar.manualSave` + `Ctrl+S common.save`                                | `settings.set('autoSave', false)` + `files.cancelAutoSave()` | 是               | —                                                                         |
| StatusBar.vue:200 | 保存方式 → 打开设置… | `statusbar.openSettings`                                                     | `ui.openSettings('general')`                                 | 是               | —                                                                         |
| StatusBar.vue:231 | 编码显示（只读）     | 专有名（UTF-8…）                                                             | **无**                                                       | **否（无点击）** | 文案 tooltip `statusbar.encodingTooltip`；相邻行尾可点，行为不一致（D40） |
| StatusBar.vue:246 | 行尾按钮             | `LF` / `CRLF` + `statusbar.eolTooltip`                                       | `files.toggleEol()`（立即写回）                              | 是               | —                                                                         |
| StatusBar.vue:259 | 主题按钮             | `settings.themeAuto/Light/Dark/Sepia`                                        | 展开主题弹层                                                 | 是               | **无 title/aria-label**（D32）                                            |
| StatusBar.vue:282 | 主题弹层 4 项        | `settings.theme*`                                                            | `settings.setTheme(mode)`                                    | 是               | 打勾态正确                                                                |
| StatusBar.vue:301 | 语言按钮             | `langShort` + `statusbar.switchLanguage`                                     | `settings.setLanguage(nextLanguage(...))`                    | 是               | 循环切换三语                                                              |
| StatusBar.vue:310 | 版本号               | `v{version}`                                                                 | `app.getVersion()`                                           | 是               | —                                                                         |

### 1.6 侧边栏（`AppSidebar` / `FileTree` / `TreeNode` / `FileList` / `RecentList` / `Outline`）

> **本轮（§4.79）变更**：侧栏头部整行去掉（最近文档 / 新建文件 / 工作区名 / 刷新都不在那儿了），
> 文件夹改当目录树的**顶层节点**；「刷新」只在列表视图下挪到面板底部的文件工具带；
> 新增工具栏「大纲位置」开关。下表里失效的行按老规矩标 `~~已删~~`，新增的行直接列出。

| 来源                           | 控件 id/选择器                      | 显示文案（i18n key）                       | 绑定的动作/命令                                      | 是否接线          | 备注                                                                                                                                                  |
| ------------------------------ | ----------------------------------- | ------------------------------------------ | ---------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~AppSidebar.vue:74~~          | ~~最近文档按钮~~                    | `open.recent`                              | —                                                    | **已删**          | 组件 `SidebarRecentButton.vue` 一并删除（零引用）；入口仍在「文件 → 最近文档」二级菜单与 Windows 跳转列表                                             |
| ~~AppSidebar.vue:75~~          | ~~新建文件（头部）~~                | `context.newFile`                          | —                                                    | **已删**          | 改为：树里任意一行（含顶层文件夹行）右键 →「新建文件」                                                                                                |
| ~~AppSidebar.vue:82~~          | ~~打开文件夹（头部，无工作区时）~~  | `open.openFolder`                          | —                                                    | **已删（§4.84）** | 曾在"没工作区时"保留过一轮；用户新口径要求侧栏在没开文件夹时完全空着，连同三语 `open.openFolder` 一起删除（入口：文件菜单 / Ctrl+Shift+O / 跳转列表） |
| ~~AppSidebar.vue:92~~          | ~~工作区名（可点）~~                | —                                          | —                                                    | **已删**          | 文件夹名改由 `FileTree` 的顶层节点承担（Typora 式）：`[data-tree-row][data-tree-root-row="true"]`                                                     |
| ~~AppSidebar.vue:100~~         | ~~刷新（头部）~~                    | —                                          | —                                                    | **已删**          | 见下方 `data-sidebar-refresh`（工具带，仅列表视图）                                                                                                   |
| AppSidebar.vue                 | 标签：文件 / 大纲                   | `sidebar.files` / `sidebar.outline`        | `ui.sidebarTab`                                      | 是                | 新增 `data-sidebar-tab="files                                                                                                                         | outline"` 钩子（套件定位用） |
| FileTree.vue                   | 顶层文件夹行                        | 工作区文件夹名                             | 展开/收起（`files.toggleDir`）、拖放落点、右键根菜单 | 是                | `TreeNode` 的 `isRoot` 分支：不可拖动、无重命名/删除/移动到                                                                                           |
| FileTree.vue                   | 文件工具带 → 刷新（**仅列表视图**） | `sidebar.refresh`                          | `files.refreshDir(root)`                             | 是                | 跟着头部一起搬过来；工具带默认隐藏、悬停侧栏才出现（带淡入淡出+位移动效）                                                                             |
| Toolbar.vue                    | 大纲位置开关                        | `outline.toRight` / `outline.toLeft`       | `useOutlineSide().toggleOutlineSide`                 | 是                | `data-outline-side`；`aria-pressed` = 当前是否在编辑区右侧；同一开关也在「视图」菜单 / 原生菜单 / 设置页                                              |
| ~~AppSidebar.vue:111~~         | ~~标签行（原行号）~~                | `sidebar.files` / `sidebar.outline`        | `ui.sidebarTab='files'`                              | 是                | —                                                                                                                                                     |
| ~~AppSidebar.vue:138~~         | ~~设置~~                            | `settings.title`                           | `ui.openSettings()`                                  | **已删**          | 本轮去掉侧栏底部那一行；设置仍在「帮助 → 设置」（应用内菜单）等入口                                                                                   |
| ~~AppSidebar.vue:145~~         | ~~关于~~                            | `about.title`                              | `router.push('/about')`                              | **已删**          | 同上；关于仍在「帮助 → 关于」与设置导航里                                                                                                             |
| ~~AppSidebar.vue:152~~         | ~~收起侧边栏~~                      | `sidebar.collapse`（该 i18n 键已随之删除） | `ui.sidebarVisible=false` + 持久化                   | **已删**          | 折叠仍有「视图 → 显示侧边栏」+ Ctrl+Shift+B；展开用 `App.vue` 的左缘把手（`.sidebar-handle`）                                                         |
| AppSidebar.vue:162             | 宽度拖拽手柄                        | —                                          | `settings.set('sidebarWidth', clamp 200..420)`       | 是                | 无 aria/键盘替代                                                                                                                                      |
| FileTree.vue:136               | 过滤输入框                          | `sidebar.filterPlaceholder`                | 本地 `filter` ref                                    | 是                | —                                                                                                                                                     |
| FileTree.vue:141               | 清空过滤                            | 图标 x                                     | `filter=''`                                          | 是                | 无 title/aria（S3）                                                                                                                                   |
| FileTree.vue:146               | 树/列表分段控件                     | `sidebar.viewTree` / `sidebar.viewList`    | `ui.sidebarFilesView`                                | 是                | 会话级，不持久化                                                                                                                                      |
| ~~FileTree.vue:203~~           | ~~空态 → 新建文档~~                 | —                                          | —                                                    | **已删（§4.84）** | 连同整块空态（含首次引导块）一起下线：没开文件夹时文件区里一个按钮一句提示都没有                                                                      |
| ~~FileTree.vue:211~~           | ~~空态 → 打开文件~~                 | —                                          | —                                                    | **已删（§4.84）** | 同上（入口：文件菜单 / Ctrl+O）                                                                                                                       |
| ~~FileTree.vue:219~~           | ~~空态 → 打开文件夹~~               | —                                          | —                                                    | **已删（§4.84）** | 同上（入口：文件菜单 / Ctrl+Shift+O）                                                                                                                 |
| FileTree.vue:72                | 树右键 → 新建文件                   | `context.newFile`                          | `files.newFileAt`                                    | 是                | —                                                                                                                                                     |
| FileTree.vue:77                | 树右键 → 新建文件夹                 | `context.newFolder`                        | `ui.prompt(...)` → `createDirAt`                     | **部分**          | 输入框预填「新建文件夹」（D31）                                                                                                                       |
| FileTree.vue:78                | 树右键 → 刷新                       | `sidebar.refresh`                          | `files.refreshDir`                                   | 是                | —                                                                                                                                                     |
| FileTree.vue:79                | 树右键 → 关闭工作区                 | `sidebar.closeWorkspace`                   | `files.setRoot(null)` + toast                        | 是                | —                                                                                                                                                     |
| FileList.vue:114               | 列表视图刷新                        | `sidebar.refresh`                          | `forceTick++` → `docsStore.load()`                   | 是                | 与 fs.watch 推送语义重叠                                                                                                                              |
| FileList.vue:140               | 列表条目                            | 文件名 + `sidebar.modifiedAt`              | `openDoc(path)`                                      | 是                | 时间用 `Intl.DateTimeFormat(settings.language)`，随语言变                                                                                             |
| TreeNode.vue:97                | 条目右键 → 在新窗口打开             | `context.openNewWindow`                    | `app.openInNewWindow`                                | 是                | 仅文件                                                                                                                                                |
| TreeNode.vue:103               | 目录右键 → 新建文件/文件夹          | `context.newFile/newFolder`                | `newFileAt` / `prompt`                               | 是                | —                                                                                                                                                     |
| TreeNode.vue:113               | 右键 → 重命名                       | `context.rename`                           | 就地重命名                                           | 是                | Enter 提交 / Esc 取消 / blur 提交                                                                                                                     |
| TreeNode.vue:114               | 右键 → 删除                         | `context.delete`                           | `ui.confirm(deleteConfirm*)` → `removeNode`          | 是                | 危险色                                                                                                                                                |
| TreeNode.vue:208               | 重命名输入框                        | —                                          | `commitRename` / `cancelRename`                      | 是                | —                                                                                                                                                     |
| TreeNode.vue:231               | 空文件夹提示                        | `sidebar.emptyFolder`                      | —                                                    | 是                | 纯提示                                                                                                                                                |
| RecentList.vue:71              | 条目                                | `item.title` / `item.path`                 | `emit('select', path)`                               | 是                | —                                                                                                                                                     |
| RecentList.vue:94              | 置顶/取消置顶                       | `open.pin` / `open.unpin`                  | `recent.togglePin`                                   | 是                | 悬停才显形                                                                                                                                            |
| RecentList.vue:102             | 从列表移除                          | `open.removeRecent`                        | `recent.removeFile` / `removeFolder`                 | 是                | —                                                                                                                                                     |
| RecentList.vue:121             | 清除记录                            | `open.clearRecent` / `open.clearFolders`   | `recent.clearAll()` / `clearFolders()`               | **行为不符**      | 文档分支会连文件夹+置顶一起清（D19）                                                                                                                  |
| Outline.vue:14                 | 大纲条目                            | `h.text`（无标题时 `（无标题）` 硬编码）   | `editorStore.jumpToHeading(pos)`                     | 是                | 硬编码见 D17；空态 `sidebar.emptyOutline`                                                                                                             |
| ~~SidebarRecentButton.vue:83~~ | ~~最近文档按钮（弹层）~~            | `open.recent`                              | —                                                    | **已删**          | 组件已删（零引用）；`RecentList.vue` 仍在「文件」菜单的二级浮层里用                                                                                   |

### 1.7 查找 / 替换栏 `FindReplaceBar.vue`（8 项）

| 来源                   | 控件 id/选择器 | 显示文案（i18n key）                    | 绑定的动作/命令             | 是否接线 | 备注                                         |
| ---------------------- | -------------- | --------------------------------------- | --------------------------- | -------- | -------------------------------------------- |
| FindReplaceBar.vue:68  | 查询输入框     | `find.placeholder`                      | `find.setQuery`             | 是       | Enter 下一个 / Shift+Enter 上一个 / Esc 关闭 |
| FindReplaceBar.vue:88  | 上一个         | `find.prev`                             | `find.step(-1)`             | 是       | `:disabled="find.count===0"` 正确处理        |
| FindReplaceBar.vue:96  | 下一个         | `find.next`                             | `find.step(1)`              | 是       | 同上                                         |
| FindReplaceBar.vue:104 | 区分大小写     | `find.caseSensitive`（按钮文字是 `Aa`） | `find.toggleCase()`         | 是       | 有 aria-pressed                              |
| FindReplaceBar.vue:113 | 关闭           | `find.close`                            | `find.hide()`               | 是       | —                                            |
| FindReplaceBar.vue:120 | 替换输入框     | `find.replacePlaceholder`               | `find.setReplacement`       | 是       | Enter 替换 / Ctrl+Shift+Enter 全部替换       |
| FindReplaceBar.vue:130 | 替换           | `find.replace`                          | `find.replaceCurrent()`     | 是       | 无命中时仍可点（no-op，无禁用）              |
| FindReplaceBar.vue:137 | 全部替换       | `find.replaceAll`                       | `find.replaceAll()` + toast | 是       | 同上                                         |

### 1.8 全局搜索 `GlobalSearch.vue`（8 项）

| 来源                 | 控件 id/选择器 | 显示文案（i18n key）                                                   | 绑定的动作/命令                                  | 是否接线 | 备注                 |
| -------------------- | -------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | -------- | -------------------- |
| GlobalSearch.vue:109 | 搜索输入框     | `common.searchPlaceholder`                                             | `ui.globalSearch.query` → 180ms 防抖 `db.search` | 是       | —                    |
| GlobalSearch.vue:116 | 索引计数       | **硬编码 `{n} 篇索引`**                                                | 只读                                             | 是       | 未走 i18n（D9）      |
| GlobalSearch.vue:122 | 关闭           | **硬编码 `关闭 (Esc)`**                                                | `ui.closeGlobalSearch()`                         | 是       | 未走 i18n（D9）      |
| GlobalSearch.vue:129 | 结果条目       | 标题/片段/路径                                                         | `openResult(r)`                                  | 是       | ↑↓ 选择 / Enter 打开 |
| GlobalSearch.vue:134 | 加载态         | **硬编码 `搜索中…`**                                                   | —                                                | 是       | 未走 i18n（D9）      |
| GlobalSearch.vue:185 | 无结果         | **硬编码 `未找到匹配内容`**                                            | —                                                | 是       | 未走 i18n（D9）      |
| GlobalSearch.vue:188 | 空态           | **硬编码 `全局搜索已索引的文档内容` / `打开或保存文档后即可全文搜索`** | —                                                | 是       | 未走 i18n（D9）      |
| GlobalSearch.vue:200 | 底部提示       | **硬编码 `选择 / 打开 / 关闭 / SQLite FTS5 全文索引`**                 | —                                                | 是       | 未走 i18n（D9）      |

### 1.9 通知中心 `NotificationCenter.vue`（6 项）

> ⚠️ 本节是**当时的审计快照**（行号对应快照时的文件）。2026-09 之后通知 UI 重做过三次：
> 先从右下角浮层搬到**编辑区上方**，再取消长方形卡片样式，最后**连级别图标与级别名一并取消**
> （只留标题 / 说明 / 操作 / 关闭）+ 空态不占位 —— 现在是「编辑区上方一整幅带」。
> 下面表里的「卡片」「级别标签」口径、`notifications.level.*` 键与行号都已过期。

| 来源                       | 控件 id/选择器       | 显示文案（i18n key）                  | 绑定的动作/命令                                          | 是否接线 | 备注                               |
| -------------------------- | -------------------- | ------------------------------------- | -------------------------------------------------------- | -------- | ---------------------------------- |
| NotificationCenter.vue:115 | 卡片动作按钮（动态） | 由调用方给（`links.actionCreate` 等） | `notifications.runAction` → `dispatchNotificationAction` | 是       | 未注册处理器时只收卡片，不留死按钮 |
| NotificationCenter.vue:128 | 关闭此通知           | `notifications.close`                 | `notifications.close(id)`                                | 是       | —                                  |
| NotificationCenter.vue:149 | 上一条               | `notifications.prev`                  | `step(-1)`                                               | 是       | 仅 total>1                         |
| NotificationCenter.vue:160 | 下一条               | `notifications.next`                  | `step(1)`                                                | 是       | 仅 total>1                         |
| NotificationCenter.vue:168 | 全部关闭             | `notifications.closeAll`              | `notifications.closeAll()`                               | 是       | 仅 total>1（单条时无「清空」入口） |
| NotificationCenter.vue:141 | 级别标签             | `notifications.level.*`（动态拼接）   | 只读                                                     | 是       | —                                  |

### 1.10 模态宿主 `ModalHost.vue`（4 个按钮 + 6 条触发面）

| 来源             | 控件 id/选择器        | 显示文案（i18n key）                             | 绑定的动作/命令               | 是否接线 | 备注                                    |
| ---------------- | --------------------- | ------------------------------------------------ | ----------------------------- | -------- | --------------------------------------- |
| ModalHost.vue:62 | 确认框 → 取消         | **硬编码 `取消`**                                | `resolveConfirm(false)`       | 是       | common.cancel 存在未用（D11）           |
| ModalHost.vue:65 | 确认框 → 确定         | **硬编码 `确定`**                                | `resolveConfirm(true)`        | 是       | common.ok 存在未用（D11）               |
| ModalHost.vue:90 | 输入框 → 取消         | **硬编码 `取消`**                                | `resolvePrompt(null)`         | 是       | —                                       |
| ModalHost.vue:93 | 输入框 → 确定         | **硬编码 `确定`**                                | `resolvePrompt(trim           |          | null)`                                  | 是  | Enter 同效 |
| —                | 触发面：脏数据确认    | `editor.dirtyConfirmTitle/Body`（lib/dialog.ts） | `confirmDiscardIfDirty`       | 是       | 4 处调用点已收敛到 lib/dialog           |
| —                | 触发面：路由守卫      | **硬编码**（router/index.ts:41-42）              | `ui.confirm`                  | 是       | **绕过 lib/dialog 的第二份实现**（D12） |
| —                | 触发面：删除确认      | `editor.deleteConfirmTitle/Body`                 | `TreeNode.handleAction`       | 是       | —                                       |
| —                | 触发面：清空历史确认  | `history.clearTitle/Body`                        | `LocalHistoryDialog.clearAll` | 是       | —                                       |
| —                | 触发面：插入链接/图片 | 工具栏路径硬编码；右键菜单路径走 `editorMenu.*`  | `ui.prompt`                   | **部分** | 同一动作两套文案来源（D13）             |
| —                | 触发面：新建文件夹    | `context.newFolder` + `sidebar.newFolderHint`    | `ui.prompt`                   | 是       | 预填值见 D31                            |

### 1.11 本地历史 `LocalHistoryDialog.vue`（4 项）

| 来源                       | 控件 id/选择器                   | 显示文案（i18n key） | 绑定的动作/命令                            | 是否接线 | 备注                              |
| -------------------------- | -------------------------------- | -------------------- | ------------------------------------------ | -------- | --------------------------------- |
| LocalHistoryDialog.vue:92  | `[data-history-clear]` 清空      | `history.clear`      | `ui.confirm` → `history.clear(path)`       | 是       | 仅在有条目时出现                  |
| LocalHistoryDialog.vue:100 | 关闭                             | `common.close`       | `ui.closeLocalHistory()`                   | 是       | Esc 亦可（但会与其他浮层抢，D33） |
| LocalHistoryDialog.vue:122 | `[data-history-item]` 载入某版本 | 时间 + 预览 + 大小   | `history.get(id)` → `files.restoreHistory` | 是       | 不直接写盘，变未保存态            |
| LocalHistoryDialog.vue:144 | 底部说明                         | `history.hint`       | —                                          | 是       | —                                 |

### 1.12 设置 `SettingsDialog.vue`（40 项）

页签：`tabs`（:31-38）通用 / 编辑器 / 外观 / 快捷键 / 导出 / 链接；左侧导航 `218-231`；「关于 Lumin」按钮 `233-239`；关闭按钮 `252-258`；遮罩点击关闭 `206`；Esc 关闭 `70-74`。

| 来源                   | 控件 id/选择器                               | 显示文案（i18n key）                                         | 绑定的动作/命令                                                    | 是否接线 | 备注                                                                                                                   |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| SettingsDialog.vue:218 | 导航：通用                                   | `settings.general`                                           | `switchTab('general')`                                             | 是       | —                                                                                                                      |
| SettingsDialog.vue:218 | 导航：编辑器                                 | `settings.editor`                                            | `switchTab('editor')`                                              | 是       | —                                                                                                                      |
| SettingsDialog.vue:218 | 导航：外观                                   | `settings.appearance`                                        | `switchTab('appearance')`                                          | 是       | —                                                                                                                      |
| SettingsDialog.vue:218 | 导航：快捷键                                 | `settings.keymap`                                            | `switchTab('keymap')`                                              | 是       | —                                                                                                                      |
| SettingsDialog.vue:218 | 导航：导出                                   | `settings.export`                                            | `switchTab('export')`                                              | 是       | —                                                                                                                      |
| SettingsDialog.vue:218 | 导航：链接                                   | `settings.links`                                             | `switchTab('links')`                                               | 是       | —                                                                                                                      |
| SettingsDialog.vue:233 | 关于 Lumin                                   | **硬编码 `关于 Lumin`**                                      | `goAbout()`                                                        | 是       | about.title 未用（D6）                                                                                                 |
| SettingsDialog.vue:252 | 关闭 X                                       | **硬编码 `关闭`**（`:title="'关闭'"`）                       | `ui.closeSettings()`                                               | 是       | common.close 未用（D6）                                                                                                |
| SettingsDialog.vue:215 | 面板标题                                     | **硬编码 `设置` / `个性化你的 Lumin`**                       | —                                                                  | 是       | settings.title 未用（D6）                                                                                              |
| SettingsDialog.vue:249 | 分组标题                                     | `tabs.label`（i18n）                                         | —                                                                  | 是       | —                                                                                                                      |
| SettingsDialog.vue:250 | 副标题                                       | **硬编码 `设置将自动保存到本机 SQLite 数据库`**              | —                                                                  | 是       | 未走 i18n（D6）                                                                                                        |
| SettingsDialog.vue:275 | 语言三选（中文/English/Русский）             | `LANGUAGE_OPTIONS.label`（专有名）                           | `settings.setLanguage`                                             | 是       | 唯一真正三语化的设置项                                                                                                 |
| SettingsDialog.vue:268 | 「语言」小标题 + 271/272 说明                | **硬编码 `语言`/`界面语言`/`界面显示语言`**                  | —                                                                  | 是       | `settings.language/languageDesc` 未用（D6）                                                                            |
| SettingsDialog.vue:302 | 自动保存开关                                 | **硬编码 `自动保存` + 长说明**                               | `toggleAutoSave()` → `settings.set('autoSave')` + `cancelAutoSave` | 是       | `settings.autoSave/autoSaveDesc` 未用；说明提到「保存按钮」但工具栏没有（D41）                                         |
| SettingsDialog.vue:316 | 自动保存间隔滑块（1–30s）                    | **硬编码 `自动保存间隔`**                                    | `settings.set('autoSaveInterval')`                                 | 是       | 仅 autoSave 开启时显示                                                                                                 |
| SettingsDialog.vue:342 | 顶部菜单栏开关                               | **硬编码 `顶部菜单栏`** + 说明                               | `settings.set('nativeMenuBar')`                                    | **部分** | 名字/描述/实际语义都对不上，见 D22；描述中「Alt+F/E/V/H 照常生效」是错的（关闭后 TopMenuBar 不挂载 ⇒ Alt 导航也失效）  |
| SettingsDialog.vue:358 | 启动时恢复上次会话                           | `settings.restoreSession/Desc`                               | `settings.set('restoreSession')`                                   | 是       | —                                                                                                                      |
| SettingsDialog.vue:377 | 自动检查更新                                 | `settings.autoCheckUpdate/Desc`                              | `settings.set('autoCheckUpdate')` → `onSettingsChanged` 立即查一次 | 是       | —                                                                                                                      |
| SettingsDialog.vue:393 | 默认编码下拉（auto + 13 项）                 | `settings.encoding/defaultEncoding` + `encoding.auto`        | `settings.set('defaultEncoding')`                                  | 是       | 说明 `settings.encodingHint`                                                                                           |
| SettingsDialog.vue:422 | 默认行尾下拉                                 | `settings.defaultEol/DefaultEolHint`                         | `settings.set('defaultEol')`                                       | 是       | 带 `data-setting-eol` 钩子                                                                                             |
| SettingsDialog.vue:453 | `[data-setting-history-switch]` 本地历史开关 | `settings.historyEnabled/historyHint`                        | `settings.set('historyEnabled')`                                   | 是       | —                                                                                                                      |
| SettingsDialog.vue:463 | `[data-setting-history-limit]` 每文件保留    | `settings.historyLimit`                                      | `settings.set('historyLimitPerFile')`                              | 是       | `:disabled="!historyEnabled"` 正确                                                                                     |
| SettingsDialog.vue:483 | `[data-setting-history-age]` 保留时长        | `settings.historyMaxAge` + `historyDays`                     | `settings.set('historyMaxAgeDays')`                                | 是       | 同上                                                                                                                   |
| SettingsDialog.vue:509 | 侧边栏开关                                   | **硬编码 `侧边栏`/`默认显示左侧边栏`**                       | `settings.set('sidebarVisible')`                                   | **部分** | 未使用 `settings.sidebar`/`sidebarDesc`；且改它**不会**同步 `ui.sidebarVisible`（当前会话不生效，需重启/或用其它入口） |
| SettingsDialog.vue:523 | 编辑器模式三选                               | **硬编码 `实时渲染/分屏对比/源码模式` + 说明**               | `settings.set('editorMode')`                                       | **部分** | 只落库，当前会话 `ui.editorMode` 不变（D21）                                                                           |
| SettingsDialog.vue:521 | 「默认编辑器模式」标题                       | **硬编码**                                                   | —                                                                  | 是       | `settings.editorMode` 键未用                                                                                           |
| SettingsDialog.vue:564 | 分屏同步滚动开关                             | **硬编码 `分屏同步滚动` + 说明**                             | `settings.set('syncScroll')`                                       | 是       | 与 EditorView 芯片同一 setting，即时生效                                                                               |
| SettingsDialog.vue:580 | 代码块行号开关                               | **硬编码 `代码块行号` + 说明**                               | `settings.set('codeLineNumbers')`                                  | 是       | 与代码块按钮弹层同一 setting                                                                                           |
| SettingsDialog.vue:598 | 字号滑块 13–26px                             | **硬编码 `字号`**                                            | `settings.set('fontSize')` → CSS 变量                              | 是       | `settings.fontSize` 键未用                                                                                             |
| SettingsDialog.vue:620 | 行高滑块 1.3–2.6                             | **硬编码 `行高`**                                            | `settings.set('lineHeight')`                                       | 是       | `settings.lineHeight` 键未用                                                                                           |
| SettingsDialog.vue:641 | 字体三选                                     | **硬编码 `无衬线/衬线/等宽`**                                | `settings.set('fontFamily')`                                       | 是       | `settings.fontSans/Serif/Mono` 未用                                                                                    |
| SettingsDialog.vue:660 | 预览区                                       | **硬编码 `预览效果/标题示例 Heading/所见即所得的正文排版…`** | 只读（跟随字号/行高/字体）                                         | 是       | 预览内容本身是示例文案                                                                                                 |
| SettingsDialog.vue:694 | 主题四选卡片                                 | **硬编码 `跟随系统/浅色/深色/羊皮纸` + 描述**                | `settings.setTheme(mode)`                                          | 是       | `settings.theme/themeDesc` 未用；这里**没**用三语的 `menu.theme*`                                                      |
| SettingsDialog.vue:775 | PDF 页边距滑块 8–50mm                        | **硬编码 `页边距`**                                          | `settings.set('export', {...pdf.margin})`                          | 是       | `settings.pdfMargin` 未用                                                                                              |
| SettingsDialog.vue:795 | PDF 页面尺寸 A4/A5/Letter                    | **硬编码 `页面尺寸`**                                        | `settings.set('export', {...pdf.pageSize})`                        | 是       | `settings.pdfPageSize` 未用                                                                                            |
| SettingsDialog.vue:818 | 「支持的格式」列表                           | **硬编码 4 行名称+描述**                                     | 只读                                                               | 是       | `settings.exportNote` 未用                                                                                             |
| SettingsDialog.vue:884 | 链接 → 清空记录                              | `settings.linksClear`                                        | `links.clear()`                                                    | 是       | 仅在有记录时出现                                                                                                       |
| SettingsDialog.vue:862 | 链接 → 创建策略三选                          | `settings.linksAsk/Always/Never`                             | `settings.set('linkCreateMode')`                                   | 是       | —                                                                                                                      |
| SettingsDialog.vue:946 | 链接历史 → 删除单条                          | `settings.linksForget`                                       | `links.forget(target)`                                             | 是       | —                                                                                                                      |
| SettingsDialog.vue:849 | 快捷键页签（组件）                           | 见 §1.13                                                     | —                                                                  | 是       | —                                                                                                                      |

> 结构说明：`SettingsDialog.vue:849` 把 `keymap` 页签指向 `SettingsKeymap`，`links` 页签在 `watch(..., {immediate:true})` 里按需 `loadLinkHistory()`；主题/语言/字体走 `settings.applyAll()`，其余设置只是写库。**没有「恢复默认设置」入口**（`settings.reset()` 无任何调用点，`settings.reset` 键也未使用）。

### 1.13 设置·快捷键 `SettingsKeymap.vue`（6 项）

| 来源                   | 控件 id/选择器              | 显示文案（i18n key）                      | 绑定的动作/命令                      | 是否接线 | 备注                                                                          |
| ---------------------- | --------------------------- | ----------------------------------------- | ------------------------------------ | -------- | ----------------------------------------------------------------------------- |
| SettingsKeymap.vue:128 | 全部恢复默认                | `keymap.resetAll`                         | `settings.resetAllKeybindings()`     | 是       | `:disabled="customizedCount===0"` 正确                                        |
| SettingsKeymap.vue:143 | 搜索命令/按键               | `keymap.searchPlaceholder`                | 本地 `filter`                        | 是       | 同时匹配标题/键位/命令 id                                                     |
| SettingsKeymap.vue:197 | `[data-command]` 修改快捷键 | `keymap.edit`                             | `startRecording(id)` → `onRecordKey` | 是       | 录制期间 `setKeymapRecording(true)` 让全局服务让行；Esc 取消 / Backspace 解绑 |
| SettingsKeymap.vue:205 | 恢复默认（单条）            | `keymap.resetOne`                         | `settings.resetKeybinding(id)`       | 是       | `:disabled="!c.customized"` 正确                                              |
| SettingsKeymap.vue:170 | 冲突徽标                    | `keymap.conflict` + `keymap.conflictWith` | 只读                                 | 是       | 冲突提示只说「后者取胜」，未给一键解绑                                        |
| SettingsKeymap.vue:217 | 无匹配                      | `keymap.noMatch`                          | —                                    | 是       | —                                                                             |

> `commands` 计算属性（:21-24）依赖 `settings.keybindings` + `currentKeymap()`；服务在 `App.vue:35` 安装，早于子组件挂载，因此不会读到 null。用户手改成非法表达式时（如 `Ctrl+`）走 `isValid()` 分支显示「未绑定」（:190-193）。

### 1.14 编辑器右键菜单 `EditorContextMenu.vue`（30 个动作，来自 `lib/editor/menu/actions.ts`）

一级分类由 `lib/editor/menu/providers.ts` 组装：剪贴板横向行（:33-51）+ 表格（:54-86，条件 `inTable`）+ 段落（:89-121，代码块内只留「正文」）+ 格式（:124-142）+ 插入（:145-164）+ 最近使用（`buildRecentSection`，最多 5 项）。

| 来源                      | 动作 id                                                                              | 显示文案（i18n key）                        | 显示快捷键                                | 绑定的动作                                                     | 是否接线 | 备注                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| actions.ts:65             | `clipboard.copy`                                                                     | `editorMenu.copy`                           | `Ctrl+C`                                  | `document.execCommand('copy')`                                 | 是       | 保留 PM 富文本复制路径                                                    |
| actions.ts:74             | `clipboard.cut`                                                                      | `editorMenu.cut`                            | `Ctrl+X`                                  | `execCommand('cut')`                                           | 是       | 无选区时 disabled                                                         |
| actions.ts:81             | `clipboard.paste`                                                                    | `editorMenu.paste`                          | `Ctrl+V`                                  | `readClipboard()` → `pasteHTML`/`pasteText`                    | 是       | 失败走 `editorMenu.pasteFailed`                                           |
| actions.ts:113            | `clipboard.selectAll`                                                                | `editorMenu.selectAll`                      | `Ctrl+A`                                  | `selectAll()`                                                  | 是       | —                                                                         |
| actions.ts:124            | `paragraph.text`                                                                     | `editorMenu.paragraph`                      | 无                                        | `setParagraph()`                                               | 是       | —                                                                         |
| actions.ts:132            | `paragraph.h1/h2/h3`                                                                 | `editorMenu.heading1/2/3`                   | **`Ctrl+1/2/3`（假）**                    | `toggleHeading`                                                | **部分** | 没有任何绑定，见 D5                                                       |
| actions.ts:159            | `paragraph.quote`                                                                    | `editorMenu.quote`                          | 无                                        | `toggleBlockquote()`                                           | 是       | —                                                                         |
| actions.ts:167            | `paragraph.bulletList`                                                               | `editorMenu.bulletList`                     | 无                                        | `toggleBulletList()`                                           | 是       | —                                                                         |
| actions.ts:175            | `paragraph.orderedList`                                                              | `editorMenu.orderedList`                    | 无                                        | `toggleOrderedList()`                                          | 是       | —                                                                         |
| actions.ts:183            | `paragraph.taskList`                                                                 | `editorMenu.taskList`                       | 无                                        | `toggleTaskList()`                                             | 是       | —                                                                         |
| actions.ts:191            | `paragraph.codeBlock`                                                                | `editorMenu.codeBlock`                      | 无                                        | `toggleCodeBlock()`                                            | 是       | —                                                                         |
| actions.ts:201            | `format.bold`                                                                        | `editorMenu.bold`                           | `Ctrl+B`                                  | `toggleMdBold()`                                               | 是       | 与内核 `Mod-b` 一致                                                       |
| actions.ts:210            | `format.italic`                                                                      | `editorMenu.italic`                         | `Ctrl+I`                                  | `toggleMdItalic()`                                             | 是       | —                                                                         |
| actions.ts:219            | `format.underline`                                                                   | `editorMenu.underline`                      | `Ctrl+U`                                  | `toggleUnderline()`                                            | 是       | StarterKit 默认键                                                         |
| actions.ts:228            | `format.strike`                                                                      | `editorMenu.strike`                         | **无（漏显示）**                          | `toggleMdStrike()`                                             | 是       | 内核实际绑了 `Mod-Shift-x`（inlineMarks.ts:1318），菜单没显示（S3） |
| actions.ts:236            | `format.inlineCode`                                                                  | `editorMenu.inlineCode`                     | **无（漏显示）**                          | `toggleMdCode()`                                               | 是       | 内核实际绑了 `Mod-e`（:1319），菜单没显示（S3）                           |
| actions.ts:246            | `insert.link`                                                                        | `editorMenu.link`                           | **`Ctrl+K`（假）**                        | `ui.prompt(editorMenu.linkPrompt/linkPlaceholder)` → `setLink` | **部分** | Ctrl+K 实际被全局 keymap 抢走（D4）                                       |
| actions.ts:267            | `insert.image`                                                                       | `editorMenu.image`                          | 无                                        | `ui.prompt(imagePrompt/imagePlaceholder)`                      | 是       | 文案走 i18n（与工具栏路径不同）                                           |
| actions.ts:281            | `insert.table`                                                                       | `editorMenu.table`                          | 无                                        | `insertTable(3,3,header)`                                      | 是       | 表格内 disabled                                                           |
| actions.ts:289            | `insert.hr`                                                                          | `editorMenu.hr`                             | 无                                        | `setHorizontalRule()`                                          | 是       | —                                                                         |
| actions.ts:297            | `insert.toc`                                                                         | `editorMenu.toc`                            | 无                                        | `insertTableOfContents()`                                      | 是       | —                                                                         |
| actions.ts:307-365        | `table.rowAbove/rowBelow/colBefore/colAfter/toggleHeader/deleteRow/deleteCol/delete` | `editorMenu.row*/col*/toggleHeader/delete*` | 无                                        | 对应 PM 表格命令                                               | 是       | 单行/单列时删除 disabled                                                  |
| EditorContextMenu.vue:286 | 清除最近使用                                                                         | `editorMenu.clearRecent`                    | —                                         | `menu.clearUsage()` → `menuUsage.reset`                        | 是       | —                                                                         |
| —                         | 键盘操作                                                                             | —                                           | ↑↓ / →/Enter 进二级 / ←/Esc 退 / Esc 关闭 | `store` 动作                                                   | 是       | —                                                                         |

### 1.15 文件树/列表右键菜单 `ContextMenu.vue`

通用容器（`ui.openContextMenu`），项由调用方给：`TreeNode.vue:100-121`（4 项）、`FileTree.vue:72-83`（4 项，作用在根）。渲染见 `ContextMenu.vue:52-66`，无 disabled 使用（数据结构支持 `disabled`）。

### 1.16 关于页 `AboutView.vue`（5 项）

| 来源             | 控件 id/选择器 | 显示文案                        | 绑定的动作/命令                      | 是否接线 | 备注                                                                                                |
| ---------------- | -------------- | ------------------------------- | ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| AboutView.vue:83 | 返回           | **硬编码 `返回`**               | `goBack()`（`router.back()` 或 `/`） | 是       | `about.back` 未用（D7）                                                                             |
| AboutView.vue:30 | 版本号         | **硬编码 `版本`**               | `app.getVersion()`                   | 是       | `about.version` 未用                                                                                |
| AboutView.vue:31 | 平台           | **硬编码 `平台`**               | `app.getPlatform()`                  | 是       | 无对应 i18n 键                                                                                      |
| AboutView.vue:16 | 技术栈         | **硬编码 `技术栈`** + 10 个包名 | 只读                                 | 是       | `about.stack` 未用；`highlight.js`/`Marked.js` 是否仍在用值得核（Markdown 由 tiptap-markdown 处理） |
| AboutView.vue:50 | 简介段落       | **硬编码中文**                  | 只读                                 | 是       | `about.desc`/`about.title`/`about.license` 未用                                                     |

### 1.17 快捷键总表

#### A. 应用级命令注册表 `composables/useKeymap.ts`（25 条，唯一声明处）

| id                           | 标题（i18n key）            | 默认键          | 守卫           | 动作                                  | 与 UI 是否一致                                 |
| ---------------------------- | --------------------------- | --------------- | -------------- | ------------------------------------- | ---------------------------------------------- |
| `file.new` (:28)             | `menu.new`                  | `Mod+N`         | always         | `newDocumentWindow()`                 | 与原生/应用内菜单一致                          |
| `file.newWindow` (:35)       | `menu.newWindow`            | `Mod+Shift+N`   | always         | `app.newWindow()`                     | 原生菜单**无**此项（D27）                      |
| `file.open` (:42)            | `menu.openFile`             | `Mod+O`         | always         | `chooseOpenFile` + `openExternalFile` | 一致                                           |
| `file.openFolder` (:49)      | `menu.openFolder`           | `Mod+Shift+O`   | always         | `files.openFolder()` + 脏确认         | 应用内菜单路径**未**做脏确认（S3）             |
| `file.save` (:56)            | `menu.save`                 | `Mod+S`         | always         | `files.save()`                        | 一致                                           |
| `file.saveAs` (:63)          | `menu.saveAs`               | `Mod+Shift+S`   | always         | `files.saveAs()`                      | 一致                                           |
| `file.exportPdf` (:70)       | `menu.exportPdf`            | `Mod+Shift+E`   | always         | `runExport('pdf')`                    | UI 未在任何地方显示该键（S3）                  |
| `file.exportHtml` (:77)      | `menu.exportHtml`           | null            | always         | `runExport('html')`                   | 未绑定                                         |
| `file.exportWord` (:84)      | `menu.exportWord`           | null            | always         | `runExport('word')`                   | 未绑定                                         |
| `file.exportEpub` (:91)      | `menu.exportEpub`           | null            | always         | `runExport('epub')`                   | 未绑定                                         |
| `file.closeWindow` (:98)     | `keymap.closeWindow`        | `Mod+W`         | always         | `app.close()`                         | 原生菜单仅在 mac 有「关闭窗口」                |
| `edit.findReplace` (:107)    | `menu.findReplace`          | `Mod+F`         | **notInInput** | `find.toggle()`                       | 一致；输入框内不抢键                           |
| `edit.globalSearch` (:116)   | `menu.globalSearch`         | `Mod+Shift+P`   | always         | `ui.openGlobalSearch()`               | **另有硬编码同键监听**（D10）                  |
| `app.settings` (:123)        | `menu.settings`             | `Mod+,`         | always         | `ui.openSettings()`                   | 一致                                           |
| `view.toggleSidebar` (:132)  | `menu.toggleSidebar`        | `Mod+Shift+B`   | always         | 侧栏取反                              | 工具栏/侧栏 title 显示同键                     |
| `view.focusMode` (:139)      | `menu.focus`                | `Mod+Shift+F`   | always         | `ui.focusMode` 取反                   | 工具栏 title 显示同键                          |
| `view.typewriterMode` (:146) | `keymap.typewriterMode`     | `Mod+Shift+T`   | always         | **`pendingRefactor` toast**           | 功能不存在（D2）                               |
| `view.modeWysiwyg` (:153)    | `editor.wysiwyg`            | null            | always         | `setMode('wysiwyg')`                  | 未绑定                                         |
| `view.modeSplit` (:160)      | `editor.split`              | null            | always         | `setMode('split')`                    | 未绑定                                         |
| `view.modeSource` (:167)     | `editor.source`             | null            | always         | `setMode('source')`                   | 未绑定                                         |
| `view.cycleMode` (:174)      | `keymap.cycleMode`          | `Mod+/`         | always         | `cycleMode()`                         | 工具栏 title 写死 `Ctrl+/`（改键后不更新，S3） |
| `window.next` (:184)         | `keymap.nextWindow`         | `Mod+Tab`       | always         | `app.cycleWindow(1)`                  | 无任何 UI 提示                                 |
| `window.prev` (:191)         | `keymap.prevWindow`         | `Mod+Shift+Tab` | always         | `app.cycleWindow(-1)`                 | 无 UI 提示                                     |
| `window.minimize` (:198)     | `keymap.minimizeWindow`     | null            | always         | `app.minimize()`                      | 无 UI 入口                                     |
| `help.about` (:207)          | `menu.about`                | null            | always         | `router.push('/about')`               | 未绑定                                         |
| `help.keymap` (:214)         | `keymap.openKeymapSettings` | `Mod+K`         | always         | `ui.openSettings('keymap')`           | **与右键菜单「链接 Ctrl+K」冲突**（D4）        |

默认键冲突检测：25 条默认键**互不重复**（`resolveCommands` 的 conflictWith 在默认状态下为空）。用户改键后由设置界面就地提示冲突。

#### B. 编辑器内核快捷键（不走命令表，用户不可改）

| 来源                      | 键                                        | 行为                                                         | 备注                                                        |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| inlineMarks.ts:1316 | `Mod-b`                                   | `toggleMdBold`                                               | 与菜单 `format.bold` 标注一致                               |
| inlineMarks.ts:1317 | `Mod-i`                                   | `toggleMdItalic`                                             | 一致                                                        |
| inlineMarks.ts:1318 | `Mod-Shift-x`                             | `toggleMdStrike`                                             | 菜单未标注（S3）                                            |
| inlineMarks.ts:1319 | `Mod-e`                                   | `toggleMdCode`                                               | 菜单未标注（S3）                                            |
| StarterKit(Underline)     | `Mod-u`                                   | `toggleUnderline`                                            | 菜单标注 `Ctrl+U`，一致                                     |
| StarterKit(UndoRedo)      | `Mod-z` / `Mod-y` / `Mod-Shift-z`         | undo / redo                                                  | **与原生菜单 role 的默认键重叠**（D23，待运行时确认优先级） |
| extensions.ts:36-47       | —                                         | Bold/Italic/Strike/Code 的默认输入规则与快捷键被**主动清空** | 行内样式改由 mdStyle 派生归一化负责                         |
| keymap.ts:187             | `Enter`                                   | `---`/`***` 成行 → 分割线                                    | priority 200                                                |
| keymap.ts:215             | `Backspace`                               | 标题降级 / 进代码块 / 段间 join                              | —                                                           |
| keymap.ts:239             | `Delete`                                  | 段间 join（forward）                                         | —                                                           |
| EditorView.vue:72         | `Tab`（源码 textarea）                    | 插入两个空格                                                 | 阻止默认移焦                                                |
| FindReplaceBar.vue:31     | `Enter` / `Shift+Enter` / `Esc`           | 下一个 / 上一个 / 关闭                                       | 输入框内                                                    |
| FindReplaceBar.vue:41     | `Enter` / `Shift+Enter`+`Ctrl` / `Esc`    | 替换 / 全部替换 / 关闭                                       | 替换框内                                                    |
| TopMenuBar.vue:444        | `Alt+F/E/D/V/H`、`Esc`                    | 展开/收起应用内菜单                                          | **仅当 TopMenuBar 挂载**（D22）                             |
| GlobalSearch.vue:59       | `Esc` / `↑↓` / `Enter`                    | 关闭 / 选择 / 打开                                           | 面板内                                                      |
| GlobalSearch.vue:82       | **`Ctrl+Shift+P`（document 级，硬编码）** | 打开全局搜索                                                 | 绕过命令表（D10）                                           |
| SettingsDialog.vue:70     | `Esc`                                     | 关闭设置                                                     | window 级，无互斥（D33）                                    |
| LocalHistoryDialog.vue:60 | `Esc`                                     | 关闭历史浮层                                                 | window 级，无互斥（D33）                                    |
| ModalHost.vue:23          | `Esc`                                     | 取消确认/输入                                                | 挂在遮罩上（靠冒泡）                                        |
| EditorContextMenu.vue:188 | `Esc` / `↑↓` / `→` / `←` / `Enter`        | 菜单导航                                                     | —                                                           |
| FileTree.vue:48           | 方向键 / Home / End / Enter               | ARIA tree 导航（lib/treeFocus.ts）                           | 有 roving tabindex                                          |
| TreeNode.vue:217          | `Enter` / `Esc`（重命名中）               | 提交 / 取消                                                  | —                                                           |
| TreeNode.vue:132          | —                                         | 新建文件夹输入框预填文案                                     | D31                                                         |

---

## 2. 三处一致性（原生菜单 / 应用内 TopMenuBar / 快捷键）

> 记法：✅ 三处都有且一致；⚠️ 有但不一致；❌ 缺失。

| 功能                                     | 原生菜单（menu.ts）        | 应用内 TopMenuBar      | 快捷键（useKeymap）                   | 其它入口                                         | 结论                                                                 |
| ---------------------------------------- | -------------------------- | ---------------------- | ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| 新建                                     | ✅ `menu.new`              | ✅ `menu.new`          | ✅ `Mod+N`                            | 侧栏空态、侧栏 + 按钮                            | ✅ 一致（同一实现 `newDocumentWindow`）                              |
| 新建窗口                                 | ❌                         | ✅ `menu.newWindow`    | ✅ `Mod+Shift+N`                      | —                                                | ⚠️ 原生菜单缺（D27）                                                 |
| 打开文件                                 | ✅                         | ✅                     | ✅ `Mod+O`                            | 侧栏空态、拖放                                   | ✅                                                                   |
| 打开文件夹                               | ✅                         | ✅                     | ✅ `Mod+Shift+O`                      | 侧栏头部/工作区名                                | ⚠️ 应用内菜单路径缺脏确认                                            |
| 保存                                     | ✅                         | ✅                     | ✅ `Mod+S`                            | 状态栏保存方式弹层                               | ✅                                                                   |
| 另存为                                   | ✅                         | ✅                     | ✅ `Mod+Shift+S`                      | —                                                | ✅                                                                   |
| 导出 ×4                                  | ✅（二级）                 | ✅（二级）             | ⚠️ 仅 PDF 绑 `Mod+Shift+E`，其余未绑  | 工具栏导出弹层                                   | ⚠️ 四份入口，键位只映一个；UI 未显示该键                             |
| 关闭窗口                                 | ⚠️ 仅 mac（`role:close`）  | ❌                     | ✅ `Mod+W`                            | 系统标题栏                                       | ⚠️ Windows 上原生菜单无此项                                          |
| 退出                                     | ⚠️ 非 mac 走 `role:quit`   | ❌                     | ❌                                    | 系统标题栏                                       | ⚠️ 键位表里没有                                                      |
| 撤销/重做                                | ✅ role（默认键 Ctrl+Z/Y） | ⚠️ 无禁用态            | ❌（内核自理）                        | 工具栏                                           | ⚠️ 原生 role 与内核键位重叠（D23）                                   |
| 剪切/复制/粘贴/全选                      | ✅ role                    | ❌                     | ❌（内核自理）                        | 编辑器右键菜单（含假快捷键）                     | ⚠️ 菜单项在各语言下都是 roles，但都不可达                            |
| 查找/替换                                | ✅ `send('find')`          | ✅ `show()`            | ✅ `Mod+F`（notInInput）              | 工具栏「查找」欠奉（只有 Ctrl+F）                | ⚠️ 原生走 `toggle`、应用内走 `show`，重复按行为不同                  |
| 全局搜索                                 | ✅                         | ✅                     | ✅ `Mod+Shift+P` + **硬编码同键监听** | 无                                               | ⚠️ 键位双真相（D10）                                                 |
| 切换侧边栏                               | ✅                         | ✅                     | ✅ `Mod+Shift+B`                      | 工具栏按钮、侧栏收起按钮、左缘把手               | ✅ 五处同键，文案带键位提示                                          |
| 编辑器模式 ×3                            | ✅（二级）                 | ✅（3 项）             | ⚠️ 3 条未绑 + `Mod+/` 循环            | 工具栏分段控件、设置「默认编辑器模式」           | ⚠️ 设置项语义不同且当前会话不生效（D21）；工具栏提示写死 `Ctrl+/`    |
| 专注模式                                 | ✅                         | ✅                     | ✅ `Mod+Shift+F`                      | 工具栏按钮                                       | ✅                                                                   |
| 打字机模式                               | ✅（点了没用）             | ❌                     | ✅ `Mod+Shift+T`（点了没用）          | 无                                               | ❌ 功能整体不存在（D2）                                              |
| 主题 ×4                                  | ✅（二级）                 | ❌                     | ❌                                    | 状态栏主题弹层（3 语）、设置外观页（硬编码中文） | ⚠️ 主题在应用内菜单没有；两处文案来源不同（`menu.theme*` vs 硬编码） |
| 本地历史                                 | ❌                         | ✅ `menu.localHistory` | ❌                                    | 无                                               | ⚠️ 只有应用内菜单一个入口                                            |
| 行尾 LF/CRLF                             | ❌                         | ✅（二级）             | ❌                                    | 状态栏行尾按钮（点击轮换）                       | ⚠️ 原生菜单缺                                                        |
| 以编码保存                               | ❌                         | ✅（二级）             | ❌                                    | 无                                               | ⚠️ 原生菜单缺                                                        |
| 选择编码重新打开                         | ❌                         | ✅（二级）             | ❌                                    | 状态栏编码 tooltip 只是提示                      | ⚠️ 原生菜单缺                                                        |
| 段落（引用/列表/代码块/分割线/升降标题） | ❌                         | ✅（整组）             | ❌                                    | 工具栏（无升降标题、无「转为正文」）             | ⚠️ 原生菜单没有「段落」概念；工具栏缺 2 项                           |
| 重新加载                                 | ✅ `role:reload`           | ❌                     | ❌                                    | 无                                               | ⚠️ 不可达（D1）；默认 Ctrl+R 疑生效                                  |
| 开发者工具                               | ✅ `role:toggleDevTools`   | ❌                     | ❌                                    | 无                                               | ⚠️ 不可达；默认 Ctrl+Shift+I 疑生效                                  |
| 设置                                     | ✅                         | ✅                     | ✅ `Mod+,`                            | 工具栏、状态栏保存弹层（侧栏底部那处本轮已删）   | ✅ 五处入口                                                          |
| 关于                                     | ✅                         | ✅                     | ⚠️ 未绑                               | 设置导航（侧栏底部那处本轮已删）                 | ✅                                                                   |
| 项目主页                                 | ✅（URL 是占位符）         | ❌                     | ❌                                    | 无                                               | ⚠️ D26                                                               |
| 最小化                                   | ❌                         | ❌                     | ⚠️ 未绑                               | 系统标题栏                                       | ⚠️ 命令存在但无入口                                                  |

**一键位重复清单（默认状态）**：应用级 25 条默认键彼此不重复。跨层重复有三处：

1. `Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z`（内核 UndoRedo）与原生菜单 `role: undo/redo` 的默认加速键重叠；
2. `Ctrl+X/C/V/A`（原生菜单 role）与浏览器/编辑器内建行为重叠；
3. `Ctrl+R`、`Ctrl+Shift+I`（原生菜单 `role: reload/toggleDevTools`）不在任何键位表里，用户既看不到也改不掉。

**自定义后新增冲突风险**：`SettingsKeymap` 只对**命令表内部**做冲突检测（`resolveCommands` 的 `conflictWith`），**不会**检测与内核键（`Mod-b/i/u/x/y/z/e`、CodeMirror 的 `Mod-f` 等）以及上表原生 role 默认键的冲突 —— 用户完全可以把某命令设成 `Ctrl+B`，设置界面不会报冲突，实际却与加粗互抢（S2，见 D43）。

---

## 3. 缺陷清单

> 格式：严重度 | 现象 | 证据（文件:行） | 建议修法

### S1 功能不可用

**D1 | S1 | 原生应用菜单（34 项）整条链路不可达**

- 现象：启动即隐藏原生菜单条并禁用 Alt 唤起；渲染层没有任何地方调用 `app.setMenuBar`，因此用户**无法**打开原生菜单。`menu.ts` 里精心做的三语化、导出/主题子菜单、重新加载、开发者工具全部是死 UI。
- 证据：`src/main/index.ts:255-256`（`setMenuBarVisibility(false)` + `setAutoHideMenuBar(false)`）；`src/main/ipc.ts:160-165`（`app:setMenuBar` 实现）；`src/preload/index.ts:38`（暴露）；全仓 grep `setMenuBar` 只有这三处 + 类型声明，**无调用点**。
- 建议：三选一 ——（a）删除原生菜单的可见性假设，在「设置→通用」里给「显示系统菜单栏」开关并调用 `app.setMenuBar`；（b）承认原生菜单只服务无障碍/系统快捷键，把它的项收敛到与 TopMenuBar 同一份数据源并让 Alt 可唤起；（c）若确认永不使用，删掉 `menu.ts` 与 51 个 `menu.*` 键，改成纯快捷键注册表。

**D2 | S1 | 「打字机模式」根本不存在，但三个入口都指向它**

- 现象：原生菜单「视图→打字机模式」、快捷键 `Mod+Shift+T`、设置里的键位条目全部可用，但点击只弹一条「打字机模式: 功能待接入」的 toast；`ui.typewriterMode` 状态永远为 false，CSS 里有 `.typewriter-scroll` 却无人使用；TopMenuBar 无该项、工具栏无按钮（所以功能也确实无处可开）。
- 证据：`src/renderer/src/composables/useAppActions.ts:139-141`（`case 'toggle-typewriter': pendingRefactor('打字机模式')`）、`:74-77`（`pendingRefactor` 只 toast）；`src/main/menu.ts:126`；`src/renderer/src/composables/useKeymap.ts:146-152`；`src/renderer/src/stores/ui.ts:56`；`src/renderer/src/assets/style.css:1317`（`.typewriter-scroll` 无引用）。
- 建议：要么实现（滚动容器把当前行钉在垂直 40% 位置，状态存 `ui/settings`），要么把菜单项、命令、i18n 键一并移除，别留「点了没反应」的入口。

**D3 | S1 | 编辑区选区浮动格式菜单被代码写死关闭（7 个按钮永不渲染）**

- 现象：`加粗/斜体/下划线/删除线/行内代码/链接/清除格式` 七个气泡按钮的实现都在（含定位、钳制、样式），但开关常量为 false，永不出现。
- 证据：`src/renderer/src/components/editor/WysiwygEditor.vue:213`（`const BUBBLE_MENU_ENABLED = false`）、`:219-223`（提前 return）、`:318-376`（模板与 7 个按钮）、`:291-302`（`addLink` 硬编码中文 prompt）。
- 建议：若产品决定不上，删掉模板与 `bubbleActive`/`updateBubbleMenu` 死代码（顺带去掉两处硬编码中文）；若要上，改为设置项并给文案 key（`editor.bold` 等已存在）。

### S2 行为不符预期

**D4 | S2 | `Ctrl+K` 被全局命令抢走，而右键菜单把它标成「链接」**

- 现象：编辑器右键菜单「链接」右侧显示 `Ctrl+K`，但 Tiptap 3 的 Link 扩展**没有** `Mod-k` 绑定（已在 `node_modules/@tiptap/extension-link` 中确认无 `addKeyboardShortcuts`），真正响应 Ctrl+K 的是 `help.keymap`（打开 设置→快捷键）。用户想插链接，得到的是设置面板。
- 证据：`src/renderer/src/lib/editor/menu/actions.ts:250`（`shortcut: 'Ctrl+K'`）；`src/renderer/src/composables/useKeymap.ts:214-220`（`id: 'help.keymap'`, `defaultKeys: 'Mod+K'`）；`src/renderer/src/lib/keymap/service.ts:174-175`（命中即 `preventDefault + stopPropagation`，编辑器收不到）。
- 建议：把 `help.keymap` 默认键改成 `Mod+Alt+K` 之类不撞车的组合，并把 `insert.link` 标注成 `Mod+Alt+K` 或空；若确实想要 Ctrl+K 插链接，就在内核里注册 `Mod-k`（`Link.extend({addKeyboardShortcuts})`）并把全局命令让开。

**D5 | S2 | 右键菜单标注的 `Ctrl+1/2/3` 没有任何实现**

- 现象：段落分类下的「一级/二级/三级标题」都显示 Ctrl+1/2/3，按下无任何反应（Tiptap Heading 无默认快捷键，命令表也没有这三条）。
- 证据：`src/renderer/src/lib/editor/menu/actions.ts:136,145,154`。
- 建议：内核注册 `Mod-1/2/3`（Tiptap v3 支持 `addKeyboardShortcuts`），或删掉这三个 shortcut 标注。

**D6 | S2 | 设置面板整体未 i18n（92 行中文），且已有键闲置**

- 现象：三语用户在 en-US / ru-RU 下打开设置，除语言选择器本身外全部是中文；「主题/字体/PDF/导出说明」等本来就有对应 i18n 键。
- 证据：`src/renderer/src/components/SettingsDialog.vue` 中：主题文案 `:95-124`、编辑器模式 `:126-130`、字体标签 `:132-141`、面板头 `:215-216`、`:250`、关闭按钮 `:254`、语言小节 `:268-272`、自动保存 `:295-299`、菜单栏 `:335-339`、侧边栏 `:506-507`、默认编辑器模式 `:521`、分屏同步滚动 `:559-561`、代码块行号 `:575-577`、字体与排版 `:589-592,614,637,653`、预览 `:661,678,681-682`、主题 `:691-692`、PDF `:766,769,793`、格式说明 `:818-825,842-843`；未使用的既有键：`settings.themeDesc/fontSans/fontSerif/fontMono/languageDesc/sidebarDesc/pdfMargin/pdfPageSize/exportNote`（见附录 A）。
- 建议：把上述字符串替换为 `t('settings.*')`，缺的键补三语；主题文案直接复用 `settings.theme*`，与状态栏保持一份。

**D7 | S2 | 关于页完全不支持 i18n**

- 现象：`AboutView.vue` 没有 `useI18n`，页面 8 行中文；`about.*` 的 7 个键（含 title/desc/version/stack/license/back/github）全部闲置。
- 证据：`src/renderer/src/views/AboutView.vue:1-13`（无 i18n 引入）、`:50-53,57,61,68,81,85`；`src/shared/i18n/zh-CN.json:293-301`。
- 建议：接 `t('about.*')`；`github` 链接与真实仓库地址一起补上（同时修 D26）。

**D8 | S2 | 编辑器空文档占位符硬编码中文**

- 现象：任何语言下，空文档都显示「在此开始写作…（输入 # 创建标题）」。
- 证据：`src/renderer/src/lib/editor/extensions.ts:148-150`；`editor.placeholder` 键在三语包里都存在但无人引用（附录 A）。
- 建议：`Placeholder.configure({ placeholder: i18n.global.t('editor.placeholder') })`，并改为在语言切换时重建（或改用可选扩展在 `applyAll()` 后重建编辑器）。

**D9 | S2 | 全局搜索面板硬编码中文**

- 证据：`src/renderer/src/components/GlobalSearch.vue:120`（篇索引）、`:122`（关闭 (Esc)）、`:134`（搜索中…）、`:185`（未找到匹配内容）、`:193-194`（两句空态）、`:205,209,212`（选择/打开/关闭）、`:217`（SQLite FTS5 全文索引）。
- 建议：补 `search.*` 键（或复用 `common.searchPlaceholder`/`common.close`），清理空态文案到 i18n。

**D10 | S2 | 全局搜索存在第二套键位真相（硬编码 Ctrl+Shift+P）**

- 现象：除命令表的 `edit.globalSearch`，`GlobalSearch.vue` 还在 `document` 上写死 `Ctrl/Cmd+Shift+P` 再开一次。用户在设置里把 `edit.globalSearch` 改成别的键后，Ctrl+Shift+P 仍然能打开全局搜索，键位表与实际行为不一致；而把命令解绑也去不掉这个监听。
- 证据：`src/renderer/src/components/GlobalSearch.vue:81-89`；`src/renderer/src/composables/useKeymap.ts:116-122`。当前之所以「不出双开」，只因命令表 handler 在 window 捕获阶段先 `stopPropagation`（`lib/keymap/service.ts:174-175`）——属于实现巧合而非设计。
- 建议：删掉 `onDocKeydown` 那段，只留命令表一条路。

**D11 | S2 | 模态对话框按钮硬编码「取消/确定」**

- 证据：`src/renderer/src/components/ModalHost.vue:62-65,90-97`；`common.cancel`(`common.ok`) 键存在未用。
- 建议：`t('common.cancel')` / `t('common.ok')`。

**D12 | S2 | 路由守卫里的脏数据确认是第二份实现且硬编码**

- 现象：离开编辑器去 `/about` 时的确认框文案写死在路由里，与 `lib/dialog.ts` 的 i18n 版并行存在；改一处文案另一处不会变。
- 证据：`src/renderer/src/router/index.ts:35-49`（`title: '有未保存的更改'`、`body: '当前文档有未保存的更改，确定要离开吗？'`）vs `src/renderer/src/lib/dialog.ts:22-29`。
- 建议：守卫改为 `await confirmDiscardIfDirty(files.dirty)`（`lib/dialog` 只依赖 ui store，不会循环导入）。

**D13 | S2 | 「插入链接/图片」存在两套文案来源（工具栏路径硬编码）**

- 证据：`src/renderer/src/components/Toolbar.vue:167-187`（`ui.prompt('插入链接','https://example.com')`、`ui.prompt('插入图片','图片地址 / 相对路径')`）vs 右键菜单走 `editorMenu.linkPrompt/imagePrompt`（`lib/editor/menu/actions.ts:252-279`）。同类动作两种行为：右键菜单取消返回 `false` 不记使用频次、工具栏取消直接 return。
- 建议：工具栏也走 `buildEditorMenuActions`（文件头注释里本就写了「后续把 Toolbar 迁到这里即可消除重复」）。

**D14 | S2 | 侧栏三个按钮的 title 硬编码中文**

- 证据：`src/renderer/src/components/AppSidebar.vue:82`（`title="打开文件夹"`）、`:94`（`files.root + '\n点击重新选择文件夹'`）、`:102`（`title="刷新"`）。
- 建议：`t('open.openFolder')` / `t('sidebar.clickReselect')` / `t('sidebar.refresh')`（三键都已存在）。

**D15 | S2 | 分屏分隔条与同步滚动芯片硬编码中文**

- 证据：`src/renderer/src/views/EditorView.vue:567`（拖动提示）、`:599`（两种 title）、`:603`（`<span>同步滚动</span>`）。
- 建议：补 `editor.syncScroll*` 键。

**D16 | S2 | Mermaid「点击编辑源码」提示硬编码**

- 证据：`src/renderer/src/components/editor/CodeBlockView.vue:672`。
- 建议：补 `editor.mermaidEdit`（或 `menu.edit` 语义的专用键）。

**D17 | S2 | 大纲无标题项占位「（无标题）」硬编码**

- 证据：`src/renderer/src/stores/editor.ts:115`（`text: node.textContent || '（无标题）'`）。
- 建议：store 里不落文案，改成 `text: ''` 由 `Outline.vue` 渲染 `t('sidebar.untitledHeading')`。

**D18 | S2 | 三个图标名写错，静默降级成 info 图标**

- 现象：`Icon.vue:189` 对未知名字回退 `ICONS.info`，于是「文件→打开…」变成 ⓘ、「视图→专注模式」变成 ⓘ、状态栏行尾按钮变成 ⓘ。
- 证据：`src/renderer/src/components/TopMenuBar.vue:188`（`icon: 'folder-open'`，表里是 `folderOpen`）、`:336`（`icon: 'focus'`，表里无此项，只有 `maximize`）、`src/renderer/src/components/StatusBar.vue:253`（`name="align-left"`，表里只有 `align-center`）；回退逻辑 `src/renderer/src/components/Icon.vue:189`。
- 建议：改名为 `folderOpen` / `maximize`（或补 `focus`）/ 补一个行尾图标；把回退改成开发期 `console.warn`，避免以后再静默。

**D19 | S2 | 「最近文档 → 清除记录」会连最近文件夹和置顶一起清掉**

- 现象：按钮文案是「清除记录」（`open.clearRecent`），实际调用 `clearAll()`，把 `recentFiles`、`recentFolders`、`pinnedFiles` 全部清空 —— 用户的置顶与文件夹历史被一并删除，且没有确认框、不能撤销。
- 证据：`src/renderer/src/components/RecentList.vue:48-52`（`clearCurrent` → `recent.clearAll()`）、`src/renderer/src/stores/recent.ts:87-93`。
- 建议：文档分支改为 `recent.clearFiles()` + `pinnedFiles` 只清被删的那些；或加确认框并改文案「清除全部记录（含文件夹与置顶）」。

**D20 | S2 | 源码模式下导出的是 Markdown 原文，不是渲染结果**

- 现象：源码模式下 `editorStore.instance` 为 `null`（设计如此），`useExport` 于是走 fallback：把 Markdown 原文塞进一个 `<p>`、只把换行换成 `<br>`。导出的 PDF/Word/EPUB/HTML 全是源码文本（`# 标题`、`**粗体**` 原样出现）。
- 证据：`src/renderer/src/composables/useExport.ts:21-22`；`src/renderer/src/stores/editor.ts:89-97`（`applyActive` 在 `active=false` 时把 `instance` 置 null）；`src/renderer/src/views/EditorView.vue:419,501`（源码模式 `setActive(false)`）。工具栏的导出按钮在源码模式下**依然可点**（`Toolbar.vue:346-355` 无条件渲染）。
- 建议：导出改用常驻的 `editorStore.editor`（`stores/editor.ts:22` 的 `editor` 字段在源码模式下仍在），或在源码模式下把 Markdown 走一次 `Markdown.parse` 再导出；两者都不可行时至少禁用导出按钮并提示。

**D21 | S2 | 「默认编辑器模式」设置改了当前会话不生效**

- 现象：在设置里把模式从「实时渲染」改成「源码模式」，界面毫无变化（指示块只在设置面板里变），要重启才生效；文案没有任何「重启后生效」的提示。
- 证据：`src/renderer/src/components/SettingsDialog.vue:523-532`（只 `settings.set('editorMode', ...)`）；`src/renderer/src/stores/settings.ts:22-37`（`applyAll` 只处理主题/语言/字体，不碰 `ui.editorMode`）；`ui.editorMode` 只在启动时赋值一次：`src/renderer/src/main.ts:44-46`。
- 建议：要么在 `applyAll()` 里同步 `ui.editorMode = this.editorMode`，要么把该项明确标注为「下次启动生效」。

**D22 | S2 | 「顶部菜单栏」设置的名字与描述都不符合实际，且描述内容错误**

- 现象：设置 key 叫 `nativeMenuBar`，但它控制的是**应用内** `TopMenuBar`（`App.vue:92`）；同名 IPC `app.setMenuBar`（真正控制系统菜单条）无人调用；描述只写「文件(F)/编辑(E)/视图(V)/帮助(H)」，实际顶栏有 5 组（多「段落(D)」）；描述还承诺「关闭后…Alt+F/E/V/H 等照常生效」，而 Alt 导航的处理函数就挂在 `TopMenuBar` 上（未挂载即失效）。
- 证据：`src/renderer/src/components/SettingsDialog.vue:335-339`、`src/renderer/src/App.vue:92`、`src/renderer/src/components/TopMenuBar.vue:444-459,467-470`、`src/shared/defaults.ts:26`、`src/preload/index.ts:38`。
- 建议：设置重命名为 `appMenuBar`（含迁移），描述改成实际行为并补「段落」；若确实要控制系统菜单条，则同时调用 `app.setMenuBar`，别让名字继续误导。

**D23 | S2 | 原生菜单 role 自带默认加速键，与「菜单不设 accelerator」的设计声明矛盾，且不可见不可改**

- 现象：`menu.ts` 顶部注释明确写「这里故意不设 accelerator」，但 `role: 'undo'|'redo'|'cut'|'copy'|'paste'|'selectAll'|'reload'|'toggleDevTools'` 在 Electron 里各自带默认加速键（Ctrl+Z/Y/X/C/V/A、Ctrl+R、Ctrl+Shift+I）。这些键即便菜单条隐藏也会注册，用户既看不到它们的来源，也无法在「设置→快捷键」里改；`Ctrl+Z/Ctrl+Y` 与内核 UndoRedo（`Mod-z/Mod-y/Mod-Shift-z`）语义重叠。
- 证据：`src/main/menu.ts:12-14`（注释）、`:100-106`（编辑 roles）、`:162-163`（reload/devtools）；键位表里没有这些键：`src/renderer/src/composables/useKeymap.ts:26-221`。
- 建议：给不需要默认键的 role 显式 `accelerator: ''`（或用自定义 `click` 取代 role），把 Ctrl+R / Ctrl+Shift+I 明确划归开发者用途并在文档里写清；`Ctrl+Z/Y` 让给编辑器内核。**哪些键真的抢在渲染层之前，需要 CDP 实测（§4 R2）。**

**D24 | S2 | 工具栏撤销/重做只是「看起来禁用」**

- 现象：不可撤销时按钮只是 `opacity-40`，仍可点击、可 Tab 聚焦、点击后无任何反馈。
- 证据：`src/renderer/src/components/Toolbar.vue:239-254`（`:class="{ 'opacity-40': !canUndo() }"`，无 `:disabled`）。
- 建议：加 `:disabled="!canUndo()"`，或保留可点但给出「没有更多可撤销」的反馈。

**D25 | S2 | 源码模式下工具栏富文本按钮全部静默失效**

- 现象：源码模式下点加粗/斜体/列表/插入图片等，什么都不发生（`editorStore.instance` 为 null，`runInline`/`runBlock` 直接 return），也没有禁用态或提示。
- 证据：`src/renderer/src/components/Toolbar.vue:115-124,145-153,167-187`（`if (!ed) return`）、`src/renderer/src/stores/editor.ts:89-97`。
- 建议：按 `ui.editorMode === 'source'` 统一置灰这些按钮（并用 `title` 说明「源码模式不可用」）。

**D26 | S2 | 帮助→「在浏览器中打开项目主页」指向 `https://github.com`**

- 证据：`src/main/menu.ts:171`（`shell.openExternal('https://github.com')`）。
- 建议：换成真实仓库/官网地址并从配置读取（`package.json` 的 `homepage`/`repository`）。

**D27 | S2 | 原生菜单缺「新建窗口」，应用内菜单有**

- 证据：`src/main/menu.ts:74-95`（File 子菜单无 newWindow）vs `src/renderer/src/components/TopMenuBar.vue:185`、`src/renderer/src/composables/useKeymap.ts:35-41`。
- 建议：原生菜单补一项 `send('new-window')`（`handleMenu` 已支持，`useAppActions.ts:86-88`）。

**D28 | S2 | 两套菜单只有约一半功能重叠，且差异项各自「单向可达」**

- 现象：只在应用内菜单的：新建窗口、最近文档/文件夹、本地历史、行尾、以编码保存、选择编码重新打开、段落整组；只在原生菜单的：主题、打字机模式、重新加载、开发者工具、项目主页、关闭窗口(mac)。结合 D1，后一组实际**全部不可达**（主题靠状态栏/设置兜住，打字机与重载/DevTools 无其它入口）。
- 证据：`src/main/menu.ts:54-174` vs `src/renderer/src/components/TopMenuBar.vue:172-351`。
- 建议：以一份声明式菜单数据（id + i18n key + 动作）同时喂给原生菜单与 TopMenuBar，从根上消除漂移。

**D29 | S2 | 状态栏「编码」是纯展示，与相邻可点的「行尾」行为不一致**

- 现象：点编码没有任何反应（没有下拉、没有提示），而右边的行尾点击即切换并写回；用户会以为编码也能点。
- 证据：`src/renderer/src/components/StatusBar.vue:231-239`（`<span>` 无 `@click`）vs `:246-255`（`<button @click="files.toggleEol()">`）。
- 建议：要么让编码也可点（弹出「选择编码重新打开/以编码保存」二级），要么把行尾也降级为纯展示 + tooltip，二者保持一致。

**D30 | S2 | 命令表里有 6 条命令既无 UI 提示也无入口，用户无从发现**

- 现象：`file.exportHtml/Word/Epub`、`view.modeWysiwyg/Split/Source`、`help.about`、`window.minimize` 默认未绑定，设置界面里显示为「未绑定」，但没有任何界面提示这些功能存在于别处（菜单/工具栏），也没有「一键绑定」引导。
- 证据：`src/renderer/src/composables/useKeymap.ts:77-97,153-173,198-204,207-213`。
- 建议：至少在设置里按分组给「未绑定」项一个可读的提示（例如「功能入口：文件→导出」）。

**D31 | S2 | 命令表内部的冲突检测覆盖不到内核键与 role 默认键**

- 现象：`SettingsKeymap` 的冲突提示只比较命令表内部（`resolveCommands`）。用户把 `file.save` 改成 `Ctrl+B`，界面不报冲突，但实际加粗（内核 `Mod-b`）与保存会互抢，且谁赢取决于 `findMatch` 与内核 keymap 的执行顺序。
- 证据：`src/renderer/src/lib/keymap/service.ts:105-132`（只对传入的 commands 做冲突统计）；内核键位：`lib/editor/inlineMarks.ts:1314-1320`。
- 建议：把内核保留键（`Mod-b/i/u/e/x/y/z/Shift-*` 等）与原生 role 默认键作为一张只读的「保留键表」参与冲突检测。

### S3 观感或文案

**D32 | S3 | 状态栏主题按钮没有 title / aria-label**

- 证据：`src/renderer/src/components/StatusBar.vue:259-275`（无 `:title`），对照同一行的语言按钮 `:301-308`（有 `:title`）；全局 tooltip 只识别 `[title]`（`src/renderer/src/lib/tooltip.ts:77`）。
- 建议：补 `:title="t('statusbar.theme')"` + `:aria-label`。

**D33 | S3 | 一次 Esc 会同时关掉多个浮层**

- 现象：设置面板与本地历史浮层都在 `window` 上监听 Escape 且互不感知；若两者同时打开（历史浮层 → 打开设置），一次 Esc 会把两个都关掉。同理 `FindReplaceBar`、`EditorContextMenu`、`TopMenuBar` 各自处理 Esc。
- 证据：`src/renderer/src/components/SettingsDialog.vue:70-74`、`src/renderer/src/components/LocalHistoryDialog.vue:60-65`、`src/renderer/src/components/FindReplaceBar.vue:34-37,45-48`、`src/renderer/src/components/EditorContextMenu.vue:191-194`、`src/renderer/src/components/TopMenuBar.vue:446-450`。
- 建议：引入浮层栈（`ui.overlays: string[]`），只有栈顶响应 Esc。

**D34 | S3 | 设置里「自动保存」说明提到的「保存按钮」不存在**

- 证据：`src/renderer/src/components/SettingsDialog.vue:297-300`（「手动模式下仅在保存按钮 / Ctrl+S 时写入」）；工具栏没有保存按钮（`src/renderer/src/components/Toolbar.vue:222-387` 全列无保存），保存入口只有文件菜单、应用内菜单与 Ctrl+S。
- 建议：文案改为「仅在 Ctrl+S / 文件→保存时写入」。

**D35 | S3 | 工具栏「目录」按钮与「无序列表」共用同一个图标**

- 证据：`src/renderer/src/components/Toolbar.vue:313-315`（`<Icon name="list">`）vs `:208`（无序列表也用 `list`）。
- 建议：给目录一个独立图标（图标表里有 `book`，或新增 `list-tree`）。

**D36 | S3 | 工具栏/状态栏里的快捷键提示是写死的字符串，改键后不同步**

- 证据：`src/renderer/src/components/Toolbar.vue:36`（`` `${t(m.labelKey)} (Ctrl+/)` ``）、`:230`（`+ ' (Ctrl+Shift+B)'`）、`:337`（`+ ' (Ctrl+Shift+F)'`）；`src/renderer/src/components/AppSidebar.vue:154`（`+ ' (Ctrl+Shift+B)'`）；`src/renderer/src/components/StatusBar.vue:189`（`Ctrl+S {t('common.save')}`）。用户在设置里改键后这些提示不会变。
- 建议：从 `currentKeymap().get(id)?.keys` 取实际键位渲染。

**D37 | S3 | 「以编码保存」一级与二级第一项同名；一级/二级重复入口**

- 证据：`src/renderer/src/components/TopMenuBar.vue:248-252`（一级 `menu.saveWithEncoding`）与 `:151-156`（二级第一项也是 `menu.saveWithEncoding`，动作是 `files.save()` 即普通保存）。
- 建议：二级第一项换文案（如 `menu.saveCurrentEncoding`），或去掉它。

**D38 | S3 | 右键菜单漏标两个真实快捷键**

- 证据：`src/renderer/src/lib/editor/menu/actions.ts:228-243`（删除线/行内代码无 `shortcut`），内核实际绑定 `Mod-Shift-x` / `Mod-e`（`inlineMarks.ts:1318-1319`）。
- 建议：补 `Ctrl+Shift+X` / `Ctrl+E`，并从一份共享表生成，避免再漏。

**D39 | S3 | 新建文件夹输入框预填了「新建文件夹」**

- 证据：`src/renderer/src/components/TreeNode.vue:132-136`、`src/renderer/src/components/FileTree.vue:107-111`（`ui.prompt(title, hint, t('context.newFolder'))` 第三参数是默认值）；`stores/ui.ts:106-110` 把它写进输入框。
- 建议：第三参数传 `''`，或传一个更合适的默认名（如 `notes`）。

**D40 | S3 | 「提升/降低标题级别」在非标题上无操作也无禁用反馈**

- 证据：`src/renderer/src/components/TopMenuBar.vue:62-84`（`if (!ed.isActive('heading')) return`）；菜单项没有 `active`/`disabled` 概念（`Leaf` 类型见 `:32-40`）。
- 建议：给 `Leaf` 增加 `disabled` 并在组装时按上下文禁用，或至少在非标题时给出 toast。

**D41 | S3 | 编辑器右键菜单「清除最近使用」无二次确认且不可撤销**

- 证据：`src/renderer/src/components/EditorContextMenu.vue:286-289` → `stores/editorMenu.ts:178-181`（`usage = {}` + `menuUsage.reset()`）。
- 建议：清空属于破坏性操作，加 `ui.confirm` 或提供撤销。

**D42 | S3 | 通知中心「全部关闭」只在多于 1 条时出现**

- 证据：`src/renderer/src/components/NotificationCenter.vue:148`（`v-if="total > 1"`）。
- 建议：单条时也保留入口（或明确这是设计意图，写进注释）。

**D43 | S3 | 应用内菜单的图标在窄窗口/深色主题下缺少可辨识度（观察项，非阻塞）**

- `TopMenuBar` 顶栏 5 个按钮纯文字，无图标；同组的二级项有图标。属于设计取舍，列为观察项备查（不做缺陷计数）。

### S4 结构隐患

**D44 | S4 | 未声明依赖：5 个 `@tiptap/*` 包被直接 import 但不在 `package.json`**

- 现象：`@tiptap/core`、`@tiptap/extension-bold`、`-italic`、`-strike`、`-code` 均未在 `dependencies` 里声明（`package.json` 只声明了 `starter-kit/underline/image/table/task-item/task-list/horizontal-rule/placeholder/pm/vue-3`），当前靠 starter-kit 的传递依赖被提升才能构建。
- 证据：`src/renderer/src/lib/editor/extensions.ts:5-9`（以及 `@tiptap/core` 在 12 个文件里的 import）；`package.json` dependencies 段。
- 建议：把这 5 个包显式写进 `dependencies`（版本与 starter-kit 对齐 `^3.31.0`）。

**D45 | S4 | 一批 IPC 面已暴露但全仓无调用点**

- 现象：`app.toggleMaximize`、`app.setMenuBar`、`db.setPinned`、`db.listRecent`、`db.setTags`、`db.getDocument`、`db.deleteDocument`、`notifications.clearClosed`、`history.stats` 在 preload 暴露、主进程实现，渲染层从不调用。
- 证据：`src/preload/index.ts:36,38,100-101,103-105,112,121`；grep 全仓确认无调用（唯一命中的是 `db.stats` 与 `workspace.setRoot`）。
- 建议：要么接入（`db.setPinned`/`listRecent` 看起来是「最近文档」迁到 SQLite 的半成品，目前 recent 仍走 kv 设置），要么删掉，避免「有 API 但没人用」造成的误判。

**D46 | S4 | `handleMenu` 的 switch 没有 default 分支，未知动作静默丢弃**

- 证据：`src/renderer/src/composables/useAppActions.ts:79-152`（含 `case 'theme-changed'` 等，无 `default`）；调用面包括原生菜单 `menu:action`（`:168`）与命令表。
- 建议：加 `default: console.warn('[menu] unknown action', action)`，让拼写错误与协议漂移可见。

**D47 | S4 | 键盘事件监听分散在 7 个组件 + 1 个服务里，无统一注册表**

- 证据：`useKeymap.ts`（命令表）、`GlobalSearch.vue:82`（硬编码 Ctrl+Shift+P）、`TopMenuBar.vue:468`（window capture keydown 处理 Alt）、`FindReplaceBar`/`ModalHost`/`SettingsDialog`/`LocalHistoryDialog`/`EditorContextMenu`/`SidebarRecentButton.vue:69`（Esc）。同一份「哪些键被占用」的事实被拆到 8 处。
- 建议：把浮层内的按键交给统一 keymap（带 `when` 上下文条件），或至少集中登记；这也是 D33/D10 的根因。

**D48 | S4 | 菜单/工具栏文案与 i18n 键的对应关系靠人工维持，已有 72 个键无人引用**

- 证据：见附录 A。典型：`settings.fontSans/Serif/Mono`（设置里硬编码了同样的中文）、`common.ok/cancel`（ModalHost 硬编码）、`editor.placeholder`（内核硬编码）、`editor.typewriter`/`menu.typewriter`（功能不存在）、`about.*`（关于页硬编码）。
- 建议：加一条 CI 检查（例如把「未被引用的键」与「硬编码中文」都报出来），否则这类漂移只会继续增长。

**D49 | S4 | 绝大多数控件没有稳定的测试钩子**

- 现象：只有 `data-status-encoding`、`data-status-eol`、`data-tree-*`、`data-history-*`、`data-setting-*`、`data-command`、`data-encoding-item`、`data-outline-item`、`data-local-history`、`data-tree-empty-folder` 这些钩子；工具栏 24 个按钮、应用内菜单 41 项、设置面板大部分控件都没有 `data-*`。
- 影响：CDP 测试只能靠 `title` 文案（随语言变）或 `nth-child`（随结构调整），极其脆弱。
- 建议：给每个控件加 `data-test="toolbar.bold"` 之类的稳定钩子，或统一约定 `data-action="<commandId>"`。

---

## 4. 覆盖不到 / 需要运行时验证（供后续 CDP 测试）

静态审计**无法判断**的项，逐条列出并给出建议的验证手段（CDP = Chrome DevTools Protocol，通过主进程 `--remote-debugging-port` 或 `webContents.debugger` 接入）。

| #   | 待验证项                                                                                                                 | 为什么静态看不出来                                                       | 建议验证方式                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 原生菜单 role 的默认加速键（Ctrl+Z/Y/X/C/V/A、Ctrl+R、Ctrl+Shift+I）是否真的在菜单条隐藏时仍生效，以及是否抢在渲染层之前 | Electron 的实现细节，代码里看不出来                                      | CDP 派发按键 + 断言 `document` 是否收到事件；`Ctrl+R` 观察是否发生 reload（`performance.getEntriesByType('navigation')` 或页面 `lumin:*` mark 消失） |
| R2  | `Ctrl+Z/Ctrl+Y` 的最终归属（内核 UndoRedo vs 原生 role）与编辑结果是否一致                                               | 取决于主进程菜单加速键与渲染层 keymap 的优先级                           | 在编辑器里输入 → Ctrl+Z → 断言 DOM 文本与 `files.current.content`（可用 `window.__pinia`? 见 R5）                                                    |
| R3  | `Mod+Tab` / `Mod+Shift+Tab`（窗口循环）在 Electron 里能否到达渲染层                                                      | Chromium 可能吞掉 Ctrl+Tab                                               | 开两个窗口，CDP 发 Ctrl+Tab，断言 `window:cycle` 返回值与焦点窗口                                                                                    |
| R4  | 应用级快捷键在**输入框内**的真实行为（尤其 `notInInput` 守卫）                                                           | `isTextEntry`/`isDocumentSurface` 的边界靠 DOM 结构与 `closest` 结果决定 | 分别在查找框、设置搜索框、源码 textarea、代码块 CodeMirror、ProseMirror 内按 Ctrl+F/Ctrl+S/Ctrl+K                                                    |
| R5  | 用户改键后行为是否真的跟随（含 D10 的 Ctrl+Shift+P 硬编码监听）                                                          | 需要真实交互 + 持久化往返                                                | 设置里把 `edit.globalSearch` 改成 `Mod+Alt+G`；断言 Ctrl+Shift+P **仍**打开（证明 D10）、新键也打开、旧键在解绑后不再打开                            |
| R6  | `BUBBLE_MENU_ENABLED` 打开后气泡菜单是否可用（当前关闭，无法静态判断其定位/事件是否正确）                                | 代码被短路                                                               | 临时改常量（或在 CDP 里注入）后选中文本，断言 `.bubble-menu` 出现且 7 个按钮可用                                                                     |
| R7  | 打字机模式 toast 的真实文案与「功能待接入」的呈现                                                                        | 需要真实点击                                                             | 菜单/快捷键触发后断言通知卡片标题                                                                                                                    |
| R8  | 导出内容在三种模式下的真实产物（D20）                                                                                    | 需要走一次真实导出并读文件                                               | 源码模式/分屏/实时渲染各导出一次 HTML（无对话框，最易自动化），断言输出是否含 `<h1>` 还是 `# `                                                       |
| R9  | 原生菜单是否真的不可达（Alt 键、Windows 菜单键、屏幕阅读器）                                                             | 系统级行为                                                               | Alt 键按下后断言 `Menu` 可见性（需主进程侧断言或截图对比）                                                                                           |
| R10 | 语言切换后各处文案的真实刷新范围（尤其硬编码部位与 `Placeholder`、`Intl` 时间格式）                                      | 需要切换三语逐屏截图                                                     | 三语下截图：顶栏、工具栏、设置全部分组、关于页、全局搜索、空文档占位、大纲占位                                                                       |
| R11 | 「设置→顶部菜单栏」关闭后 Alt+F/E/V/H 是否真的失效（D22 的描述错误）                                                     | 需要真实按键                                                             | 关掉开关，CDP 发 Alt+F，断言 `.topmenu-drop` 不出现                                                                                                  |
| R12 | 最近文档「清除记录」的破坏范围（D19）                                                                                    | 需要造数据                                                               | 造 2 文件 + 2 文件夹 + 1 置顶 → 点清除 → 断言 `settings.recentFolders`/`pinnedFiles` 是否被清                                                        |
| R13 | 通知中心单卡片的多条切换与「全部关闭」边界、可交互卡片按钮派发                                                           | 需要真实产生通知                                                         | 触发链接创建询问（点击文档里指向不存在文件的链接）后断言卡片与按钮                                                                                   |
| R14 | 无 `data-*` 钩子的控件在自动化里的实际可定位性                                                                           | 需在真实 DOM 里试选择器                                                  | 先跑一遍「按 title 文本定位」的用例，统计随语言切换的失效率（决定是否要先补 D49）                                                                    |
| R15 | 二级菜单（TopMenuBar 的编码/导出/最近列表、右键菜单二级）在窄窗口/小高度下的可达性                                       | 依赖运行时尺寸与 `placeSub` 的钳制                                       | 把窗口压到 800×600 与 1024×500，逐个二级菜单断言最后一项在视口内                                                                                     |

> 另：`docs/_audit/` 目录在本会话之前不存在（由本次会话创建；同目录另有 `coverage-matrix.md`、`i18n-and-settings.md` 两份并发审计，与本文件主题互补 —— 前者是「功能 × 自动化测试覆盖矩阵」，后者是「i18n 与设置项盘点」）。本审计未触碰 `src/`、未运行 `npm`/`electron`、未做 git 写操作。

---

## 附录 A：i18n 键资产盘点

- 三语包结构**完全一致**：`zh-CN.json` / `en-US.json` / `ru-RU.json` 各 399 个叶子键，**键集合两两相同**（无缺失、无多余）。
- 命名空间分布：`editor` 57、`settings` 58、`menu` 51、`editorMenu` 42、`keymap` 27、`sidebar` 27、`links` 24、`toast` 23、`common` 19、`open` 13、`find` 11、`statusbar` 9、`notifications` 8、`about` 7、`history` 7、`update` 6、`context` 5、`app` 3、`encoding` 1、`session` 1。
- **引用不到位的键 72 个**（脚本扫描：整仓 `.vue/.ts` 里搜不到该键字符串，且已排除动态拼接导致的误报）。其中**确定是「有键却硬编码」**的：

| 键                                                                                | 本应出现在               | 实际硬编码位置                                                            |
| --------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `about.title/desc/version/stack/license/back`                                     | AboutView                | `AboutView.vue:50-85`                                                     |
| `common.ok/cancel/confirm/close`                                                  | ModalHost / 设置关闭按钮 | `ModalHost.vue:62-97`、`SettingsDialog.vue:254`                           |
| `editor.placeholder`                                                              | 编辑器 Placeholder 扩展  | `extensions.ts:149`                                                       |
| `editor.typewriter`、`menu.typewriter`、`keymap.typewriterMode`                   | 打字机模式（功能不存在） | `useAppActions.ts:140`                                                    |
| `settings.themeDesc/themeAuto/Light/Dark/Sepia`                                   | 设置外观页               | `SettingsDialog.vue:95-124,691-692`（这里用的是 `settings.*` 里的另一套） |
| `settings.fontSans/fontSerif/fontMono`                                            | 设置字体选择             | `SettingsDialog.vue:132-141,653`                                          |
| `settings.languageDesc/sidebarDesc/pdfMargin/pdfPageSize/exportNote`              | 设置对应小节             | `SettingsDialog.vue:272,507,769,793,842`                                  |
| `settings.linksDeclinedBadge`                                                     | 链接历史徽章             | `SettingsDialog.vue:930-939`（用的是 `links.actionDeclined`）             |
| `sidebar.workspace/openWorkspace/clickReselect/newFile/newFileHint/openFolderBtn` | 侧栏                     | `AppSidebar.vue:82,94,102` 等                                             |
| `statusbar.mode/theme`                                                            | 状态栏                   | 主题按钮无 title（D32）                                                   |
| `toast.fileCreated/createFailed/copyPath`                                         | —                        | 无调用（能力未接）                                                        |

- 其余「未引用」项多为动态拼接（`notifications.level.*` 由 `t(\`notifications.level.${level}\`)` 使用）或原生菜单的前缀取键（`menu._`由`LOCALES[lang].menu[key]`以短键名取出，已单独核对：51 个`menu._`键**全部**被`menu.ts`或`TopMenuBar.vue` 引用）。

## 附录 B：审计方法与可复现命令

1. 文件枚举：`glob src/**/*.vue`、`glob src/{main,preload,shared,renderer}/**/*`，逐目录确认无遗漏（`components/editor`、`lib/editor/menu`、`lib/keymap`、`stores`、`i18n`）。
2. 三语键集合比对：PowerShell `ConvertFrom-Json` 展平三层键后用 `Compare-Object`（结果：三者均为 399 键，差异为空）。
3. 键引用扫描：把 `src/**/*.vue|*.ts`（排除 `shared/i18n`）拼成文本，对每个键做 `IndexOf` 判断；再对 `menu.*` 单独用 `T('<suffix>')` 形式复核。
4. 硬编码中文扫描：逐行匹配 `[\u4e00-\u9fff]`，输出「文件 → 行号列表」，再人工区分注释与用户可见文案（注释占绝大多数）。
5. 图标名核对：把 `Icon.vue` 的 `ICONS` 键与所有 `name=` / `icon:` 取值对比，发现 3 处未注册名（D18）。
6. 依赖核对：`package.json` 依赖列表 vs `src/**` 里 `from '@tiptap/...'` 的包名（D44）。
7. IPC 面核对：`src/preload/index.ts` 暴露的每个方法名在 `src/renderer/**` 里 grep 调用点（D45）。
8. 快捷键核对：`useKeymap.ts` 的 25 条命令 × `defaultKeys` 去重；再与内核 `addKeyboardShortcuts`（`inlineMarks.ts`、`keymap.ts`、`pointer.ts`）以及零散 `addEventListener('keydown')` 对照（§1.17）。
9. 编辑器扩展核对：`extensions.ts` 的注册顺序与 `StarterKit.configure` 的开关，确认 `toggleUnderline`/`toggleBulletList`/`insertTable` 等命令真实存在（`node_modules/@tiptap/starter-kit/src/starter-kit.ts:263`）。
10. 未运行任何构建/测试（`npm run typecheck`、`lint`、`test:unit` 均未执行）——若要确认以上静态结论中涉及类型/构建的部分（如 D44 的依赖提升），建议补跑 `npm run ci`。
