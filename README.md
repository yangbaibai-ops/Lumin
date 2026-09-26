# Lumin — Write in Light

一款 **Windows 优先**的所见即所得 Markdown 编辑器：**Electron + Vue 3 + Tiptap v3**。
光标所在处才显示 Markdown 语法标记（`#` / `**` / `- ` / `>` / 表格 `|`），移出即隐藏 —— 与 Typora 同一体验。

> **平台现状（别被「Electron 跨平台」误导）**：已实测并可交付的是 **Windows**；
> `build:mac` / `build:linux` 脚本与 `electron-builder.yml` 里的 mac/linux 段存在，但**未做过运行验证**，
> 且任务栏 / 快捷方式 / 安装器这些体验是按 Windows 做的。跨平台打磨是**明确暂缓**项（见 `docs/optimization-program.md`）。

---

## 功能

- ✅ **所见即所得编辑**：Tiptap v3 + `tiptap-markdown` 双向转换；标题 / 加粗 / 斜体 / 删除线 / 行内代码 / 引用 / 有序无序列表 / 任务列表 / 表格 / 图片 / 链接 / 分割线
- ✅ **动态输入语法**：`# ` 标题、`- ` 列表、`[ ] ` 任务列表
- ✅ **光标感知标记符**：块级用 ProseMirror Decoration，行内用 DOM 类（本版 PM 的行内 Decoration 移除有缺陷，见 `lib/editor/markers.ts` 注释）
- ✅ **格式化入口：快捷工具栏 + 编辑器右键菜单 + 顶部菜单栏**（三处同一套动作；工具栏**出厂默认收起**以求写作面干净，可在「视图 → 显示快捷工具栏」、设置 → 编辑器 → 快捷工具栏里打开，并可逐项显隐与排序）
- ✅ **代码块**：CodeMirror 6 NodeView 内嵌编辑、语言切换（语法高亮按需加载）、行号、折叠、括号闭合与补全
- ✅ **Mermaid 图表**：```` ```mermaid ```` 代码块自动渲染为 SVG，点击回到源码编辑（`securityLevel: 'strict'`）
- ✅ **大纲**：标题自动收集、滚动联动高亮、点击跳转
- ✅ **表格**：插入 / 编辑单元格 / Tab 加行（列分隔符 `|` 随光标浮现）
- ✅ **数据层**：文件系统操作（打开 / 保存 / 新建 / 重命名 / 删除 / 拖拽打开）、自动保存、**崩溃与关窗草稿恢复**、最近文档、SQLite 持久化（documents 元数据 CRUD + FTS5 trigram 全文索引 + `Ctrl+Shift+P` 全局搜索）
- ✅ **导出**：PDF / HTML / Word / EPUB（主进程侧实现，含 Mermaid 预渲染与 KaTeX 样式内联）
- ✅ **多窗口**：一窗口一文档；「一个文件只开一个窗口」；会话槽位跨启动恢复文档与光标位置
- ✅ **三主题**（亮色 / 暗色 / 羊皮纸）+ **三语言**（zh-CN / en-US / ru-RU）+ 状态栏光标行列与字数统计

---

## 技术栈（实测版本）

| 层 | 选型 |
|---|---|
| 运行时 | Electron 39（内置 Node 22） |
| 界面 | Vue 3.5 · Pinia 4 · Vue Router 5 · vue-i18n 11 · Tailwind CSS 4 |
| 编辑内核 | Tiptap v3（StarterKit / Table / TaskList / Image / Placeholder）· `tiptap-markdown` · CodeMirror 6 · Mermaid 11 · KaTeX 0.18 |
| 持久化 | `node:sqlite`（`DatabaseSync` + FTS5 trigram），零原生依赖 |
| 构建 | electron-vite 5 · electron-builder 26 · TypeScript 5.9 · ESLint 9（flat config）· Prettier 3 |

---

## 快速开始

```bash
# 要求 Node >= 22（engines 已声明）
npm install

npm run dev            # 开发模式（主进程 --watch 热重载）
npm run dev:isolated   # 同上，但用独立 profile（不碰你正在用的那套数据）
npm run build          # 类型检查 + 构建到 out/
npm run build:win      # 打 Windows 安装包（electron-builder / NSIS）
```

> **单实例**：应用同一时刻只允许一个实例。已经有 Lumin 在跑（比如你的 `npm run dev` 还开着）时，
> 再执行一次 `npm run dev` 会**立刻**退出并打印一段提示，因为第二个 Electron 进程抢不到单实例锁 ——
> 它会把命令行参数转交给已在运行的那个实例（双击 `.md`、跳转列表都走这条路），然后干净退出；
> **你原来那个窗口不会被动过**。
>
> 想在开发时同时开第二个实例，用 `npm run dev:isolated`（独立 `%APPDATA%\Lumin (dev)`，不抢锁）；
> 想让当前这份 dev 会话跑在你常用的 profile 上，先关掉已有实例再 `npm run dev`。
>
> 提示本身是**英文**（ASCII）：Windows 控制台按代码页解读字节（中文系统是 GBK），写中文只会得到
> 乱码、连换行都会被吃掉 —— 主进程的 console 输出因此一律走 ASCII（有测试守着）。

---

## 质量门禁

**下面这些命令是可信的**（CI 与本地跑同一套）：

```bash
npm run typecheck   # tsc（主进程/preload）+ vue-tsc（渲染层），双工程
npm run lint        # ESLint（flat config）；0 error / 0 warning 是门槛
npm run test:unit   # node --test：纯逻辑单元测试（见 tests/）
npm run ci          # typecheck + lint + test:unit + build（CI 用的就是它）
npm run build       # 生产构建
```

> **CDP 验收套件不在 CI 里跑**：`tools/_verify-*.js` 需要**真实桌面会话**（鼠标键盘、窗口焦点），
> 因此按需手动执行。统一入口会**逐个套件起全新隔离实例**（套件会改设置/写草稿/动 kv，串着跑必然互相污染），
> 并把末行的 `--- N/M PASS` 汇总成矩阵：
>
> ```powershell
> node tools/run-suites.js                            # 默认那一组（不需要 dev server）
> node tools/run-suites.js --suite=_verify-session.js # 点名跑
> node tools/run-suites.js --all                      # 全量（多数需要 5173 上的 dev server）
> ```
>
> 单跑某个套件时，先起隔离实例（**别**用你自己的 `%APPDATA%\lumin`）：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-isolated.ps1
> node tools\_verify-md-fidelity.js
> ```
>
> 新套件一律 `require('./lib/harness')` 取公共骨架（连页面、pinia 访问器、键鼠模拟、结果汇总），
> 别再各抄一份 —— 抄出来的副本会漂移（页面地址写死 5173、按 `Symbol(pinia)` 名字取 store 等）。
>
> ⚠️ **`npm run build` 之后必须让实例重新加载**：渲染层是构建产物，**旧实例仍跑旧 bundle**。
> `run-suites.js` 每个套件都会起全新实例，所以用矩阵验证没问题；手工拿探针脚本连 9222 时，
> 若端口上还挂着上一次的实例，你验证的是**改动之前**的代码（本轮就因此误判过一次嵌套样式没生效）。

---

## 目录结构

```
src/
├── main/                 # 主进程（文件数与行数见下表「代码规模」）
│   ├── index.ts          #   窗口生命周期、单实例、会话恢复计划、自定义协议、安全兜底
│   ├── ipc.ts            #   全部 IPC handler（含路径校验）
│   ├── fileOps.ts        #   文件读写（**原子写**）、扫描、路径校验
│   ├── drafts.ts         #   草稿 I/O；归属判定抽到 shared/drafts.ts（纯函数，有单测）
│   ├── menu.ts           #   原生菜单（隐藏；保留系统级可访问性）
│   ├── i18n.ts           #   主进程取词入口（原生菜单 / 对话框 / 跳转列表 / 导出模板共用）
│   └── services/         #   database / encoding / session / windowScope / taskbar / links / pathGrants / updater…
├── preload/              # contextBridge → window.luminAPI（渲染层唯一的进程边界）
├── shared/               # 跨进程共享的类型与**纯函数**（可单测）
└── renderer/src/         # 渲染层
    ├── views/            #   EditorView（三模式布局）/ AboutView
    ├── components/       #   顶栏、侧栏、文件树、工具栏、状态栏、设置、全局搜索、编辑器组件…
    ├── stores/           #   Pinia：files（文件树+当前文档）/ workspaceDocs（列表视图派生缓存）/ settings / ui / editor / notifications / editorMenu
    ├── composables/      #   命令动作、快捷键、导出、编辑器模式
    └── lib/              #   编辑器内核扩展、路径/错误/高亮工具、键位服务、会话、i18n

tests/                    # node --test 单元测试（纯逻辑，毫秒级）
tools/                    # 验收脚手架：lib/harness.js（骨架）+ run-suites.js（入口）+ _verify-*.js（CDP 端到端）
tools/fixtures/md/        # Markdown 往返保真夹具 + EXPECT.json（预期即契约）
docs/                     # 手册 / 整改方案 / 打包实测
```

### 代码规模

<!-- facts:begin（由 tools/doc-facts.js 生成，勿手改）-->

| 范围 | 文件 | 行数 |
|---|---|---|
| `src/main` | 31 | 7016 |
| `src/preload` | 2 | 219 |
| `src/shared` | 25 | 2896 |
| `src/renderer` | 121 | 24516 |
| `src 合计` | 179 | 34647 |

口径：`src/main`/`preload`/`shared` 数 `.ts`，`src/renderer` 数 `.ts`+`.vue`（含子目录）。

<!-- facts:end -->

> 这几个数字**不要手写**：`npm run docs:facts:write` 重算，`npm run docs:facts:check`
> 在 `npm run ci` 里校验 —— 手写数字必然会漂（README 曾经写着「renderer 86 文件 / ~15.4k 行」，
> 实测已是 114 / 22.7k，而没有任何测试会红）。


**内核要点**（动手前先读这些文件的注释）：

| 文件 | 为什么重要 |
|---|---|
| `lib/editor/extensions.ts` | 扩展集组装；StarterKit 关闭内置 codeBlock（由 CodeMirror NodeView 接管）与 bulletList（保留源码标记） |
| `lib/editor/listMarkers.ts` | 列表保真：标记字符（`-`/`*`/`+`）保留、相邻列表不插空行、任务列表紧松 |
| `lib/editor/markdownStorage.ts` | **编辑器内容 → 文档文本的唯一出口**（含文末换行规则；改这里要同时想外部同步比较） |
| `lib/editor/typoraInlineMarks.ts` | 真实文本标记模型：派生归一化 + 「源码权威重推」；**逐字块（代码块）必须排除** |
| `lib/editor/markers.ts` | 光标感知标记符；块级与行内两条不同实现路径（PM 的已知缺陷） |
| `lib/contentSync.ts` | **编辑面 ⇄ 真源的单向数据流账本**（世代号 + 作者 + 各面无 applied）；三个编辑面共用同一套判断 |
| `components/editor/TyporaEditor.vue` | 账本驱动的同步：要不要换内容只问 `files.contentIsStale('wysiwyg')` —— 不比字符串、不看静默窗 |
| `stores/files.ts` | 文件树 + 当前文档 + 草稿/自动保存的状态机；规则在 `lib/recent.ts` / `lib/draftRules.ts` / `lib/docText.ts`，派生缓存在 `stores/workspaceDocs.ts` |
| `lib/dialog.ts` | 未保存更改确认的**唯一实现**（脏不脏由调用方传参，故 store 也能用） |
| `lib/treeFocus.ts` | 文件树的 ARIA keyboard 导航（roving tabindex / 方向键 / Home·End / Enter） |
| `main/services/session.ts` | 会话槽位：「整体退出」与「单独关窗」的恢复语义 |
| `shared/drafts.ts` + `main/drafts.ts` | 未命名草稿归属（窗口实例 uid；无主草稿只交给启动窗口） |
| `shared/documentText.ts` | 文档文本收尾规则与代码围栏长度（纯函数，有单测） |

---

## 文档地图

| 文档 | 解决什么问题 |
|---|---|
| `docs/typora-wysiwyg-manual.md` | **事实上的设计手册**：每个模块的取舍、踩过的坑、历次修复记录（按 §4.x 检索） |
| `docs/optimization-program.md` | **整改方案**：按波次排的问题清单与验收口径（Wave 1~5） |
| `docs/electron-upgrade.md` | **Electron 升级评估**：实装版本与 EOL 事实、升级步骤与要复验的清单 |
| `RELEASE.md` | **发布检查清单**：版本号来源、全绿门禁、打包与校验和、10 分钟人工冒烟 |
| `docs/packaging-install-test.md` | 安装 / 卸载链路的实测报告 |
| `CHANGELOG.md` | 按 Keep a Changelog 汇出的变更记录 |

---

## 已知限制与路线（诚实清单）

| 项 | 现状 | 计划 |
|---|---|---|
| **本地历史 / 版本回滚** | ✅ 已有：每次写盘前留一份「即将被覆盖」的快照（每文件 30 条 / 30 天 / 全库 2000 条），
文件菜单「本地历史…」可查看并载入编辑器（载入≠写盘，看清了再保存） | 保留策略做成可配（Wave 2 剩余） |
| **Markdown 往返保真** | ✅ 判级器 + **33 份夹具** + 三层套件（文档级/幂等/字节级）；`exact 17 / normalized 16 / lossy 0`（分类计数由 `EXPECT.json` 实测，`npm run test:unit` 里有一条对账；`normalized` 每条都写了 why 与修法）。脚注（`[^1]` 与 `[^1]: 定义`）**原样透传**（行内 mark + 块级原子节点，见 `lib/editor/footnotePassthrough.ts`） | 逐条修剩余缺口（定义列表退化成段落对、行内 HTML…） |
| **EOL（CRLF/LF）** | ✅ 行尾是文档级元数据：打开时判定（按多数）、内存一律 LF、写盘时还原；状态栏可点切换。多窗口一致性还没做 | Wave 2 剩余 |
| **查找替换** | ✅ 已实现：`Ctrl+F`（焦点在文件面板时改搜文件名）、正则 + 捕获组（`$1`）、大小写、全部替换、两个编辑面（Tiptap / 源码 textarea） | 无 |
| **打字机模式** | ⛔ 已**摘掉**（原先菜单与 `Ctrl+Shift+T` 只弹一句「功能待接入」——留着一个不存在的入口等于承诺不存在的功能） | 若要做，按"光标行居中"重写后再放入口 |
| 编辑器 ⇄ store 同步 | ✅ **单向数据流账本**：三个编辑面（Tiptap / 源码 textarea / 代码块 CM）共用 `rev + author + applied`，不存在第二条同步通道 | 嵌套样式（`mdStyle` 支持样式集合） |
| 文件树键盘可达 | ✅ `role="tree"` + roving tabindex + 方向键/Home/End/Enter（`lib/treeFocus.ts`）；`F2` 重命名、`Delete` 删除、`Shift+F10`/菜单键唤出上下文菜单（`TreeNode.vue`） | 拖放排序 |
| 自动更新 / 代码签名 | ❌ `publish` 仍是占位、未签名（Windows 会提示未知发布者）。两条都**卡在外部资源**（证书、真实仓库地址），所以不发明占位 URL | 拿到证书与地址后一起做 |
| **Electron 版本** | ⚠️ 实装 **39.8.10**（`^39.2.6` 锁死在 39），而 39 已于 **2026-05-05 EOL**（Chromium 落后约 10 个大版本）—— 实测事实与复验清单见 `docs/electron-upgrade.md` | 单独分支升到受支持 major + 跑完整矩阵（含打包态） |
| 诊断与日志 | ✅ 设置 → 高级：「复制诊断信息」（版本 / 平台 / Electron / 数据位置 / 启动参数 / 设置快照 / 最近错误标题，**不含文档内容与最近文件清单**）＋「打开日志目录」 | 崩溃转储（`crashReporter`）等有上报渠道时再谈 |
| 跨平台 | ⚠️ mac / Linux 未验证（`npm run build:mac` / `build:linux` 会明确拒绝，而不是产出一个没验过的包） | 明确暂缓 |

---

## 开发约定

1. **一次一波**：不做「顺手把别的也改了」的提交；每波结束必须留下**可复跑的数字**（套件 `--- N/M PASS` 或命令 exit code）。
2. **一次真相**：跨进程的东西放 `src/shared/`（类型 + 纯函数）；能抽成纯函数的判定就别写在 I/O 里 —— 那样才测得了。
3. **主进程改动要重启**：`npm run dev` 会 `--watch` 自动重启；渲染层走 HMR（改 i18n JSON 有时需要手动刷新一次）。
4. **绝不碰用户数据**：验收/调试一律 `--user-data-dir=<临时目录>`；涉及用户快捷方式、任务栏图标、系统目录的代码必须按 profile 分流（踩过：验收实例把用户的任务栏图标搞成了缺省图标）。
5. **提交信息**：Conventional Commits（`fix(scope): …` / `feat(scope): …`），便于汇出 CHANGELOG。
6. **写盘一律走 `fileOps.writeFile`**：它是「临时文件 + fsync + rename」的原子写；绕过它等于放弃崩溃安全。
7. **不要用 PowerShell 做源码的字符串手术**：`Get-Content -Raw` 不带 `-Encoding` 时按系统 ANSI 码页
   （中文 Windows 上是 GBK）解码，`Set-Content -Encoding UTF8` 再写回 —— 一步就把整份 UTF-8 源文件
   变成乱码，而且**中间那一步是有损的**（解不开的字节变成 `?`，跟着换行一起吃掉）。
   批量改源码用 Node 脚本（`fs.readFileSync(f, 'utf8')` + 字面量替换 + `writeFileSync(f, t, 'utf8')`），
   PowerShell 只用来跑命令和读输出。真踩了也有救：见 `docs/typora-wysiwyg-manual.md` §4.59 末尾的恢复办法。

---

## License

MIT · Free & Open Source
