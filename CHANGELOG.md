## [Unreleased]

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
