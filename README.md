<div align="center">

# Lumin

**Write in Light** — 一款 Windows 优先的所见即所得 Markdown 编辑器

**Electron 39 · Vue 3.5 · Tiptap v3**

光标停在哪，Markdown 语法才现身（`#` `**` `- ` `>` `|`），移开就藏起来 —— 像 Typora 那样写作，而不是像写代码。

</div>

---

## 它是什么样的编辑器

打开一个 `.md`，看到的是**排版好的正文**，不是一堆星号和井号。想改哪句就点哪句：语法标记在你光标所在的那一段才出现，改完移开又回到干净的排版。表格、代码块、公式、图示都是**就地编辑** —— 不用切到别的模式，也不用按下预览键。

> **平台现状（别被"Electron 跨平台"误导）**：已实测、可交付的是 **Windows**。`build:mac` / `build:linux` 脚本在，但没做过运行验证，任务栏、快捷方式、安装器这些体验都是按 Windows 做的 —— 所以那两个命令会**明确拒绝**执行，而不是产出一个没验过的包。跨平台打磨是明确暂缓项。

---

## 功能一览

- **所见即所得**：标题 / 加粗 / 斜体 / 删除线 / 行内代码 / 引用 / 有序无序与任务列表 / 表格 / 图片 / 链接 / 分割线，全部双向转换
- **动态输入**：`# ` 出标题、`- ` 出列表、`[ ] ` 出任务列表
- **光标感知标记**：块级走 ProseMirror Decoration，行内走 DOM 类（本版 PM 的行内 Decoration 移除有缺陷，取舍写在 `lib/editor/markers.ts` 注释里）
- **三处格式化入口**：快捷工具栏 + 编辑器右键菜单 + 顶部菜单栏，同一套动作（工具栏**默认收起**，让写作面干净）
- **代码块**：CodeMirror 6 内嵌编辑，语言切换、行号、折叠、括号闭合与补全，语法高亮按需加载
- **Mermaid**：```` ```mermaid ```` 直接渲染成 SVG，点一下回源码改
- **数学公式**：行内 `$…$` 与块级 `$$…$$` 由 **KaTeX 本地渲染**（字体随包进产物，**离线可用、零 CDN 请求**）；点公式即在**上方浮出可编辑源码框**，逐键实时预览，`Esc` 收起，清空即删
- **大纲与侧栏**：标题自动收集、滚动联动、点击跳转；左栏页签（文件 / 大纲），树顶就是当前工作区文件夹；大纲也可切到编辑区右侧变成三栏
- **导出**：PDF / HTML / Word / EPUB，含 Mermaid 预渲染与 KaTeX 样式内联
- **数据可靠**：原子写盘、自动保存（可选）、崩溃与关窗草稿恢复、最近文档、本地历史（每次覆盖前留快照，可查看后载入编辑器）
- **多窗口与持久化**：一窗口一文档、一个文件只开一个窗口、会话槽位跨启动恢复文档与光标；SQLite（documents 元数据 + FTS5 trigram 全文索引，`Ctrl+Shift+P` 全局搜索）
- **三主题 × 三语言**：亮色 / 暗色 / 羊皮纸；zh-CN / en-US / ru-RU；状态栏有行列与字数

---

## 快速开始

```bash
# 需要 Node >= 22（engines 已声明）
npm install

npm run dev            # 开发模式（主进程 --watch 热重载）
npm run dev:isolated   # 同上，但用独立 profile，不碰你正在用的数据
npm run build          # 类型检查 + 构建到 out/
npm run build:win      # 打 Windows 安装包（electron-builder / NSIS）
```

> **单实例**：应用同时只允许一个实例。已经有 Lumin 在跑时再 `npm run dev`，它会打印一句提示后**干净退出**，并把你这次命令行参数转交给已在运行的实例（双击 `.md`、跳转列表都走这条路）—— **你原来那个窗口不会被动过**。想在开发时开第二个，用 `npm run dev:isolated`。
>
> 那句提示是**英文 ASCII**：Windows 控制台按代码页解读字节，写中文只会得到乱码。

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

## 项目结构

```
src/
├── main/        主进程：窗口生命周期、单实例、会话恢复、IPC、原子写盘、导出（PDF/HTML/Word/EPUB）、SQLite
├── preload/     contextBridge → window.luminAPI（渲染层唯一的进程边界）
├── shared/      跨进程共享的类型与**纯函数**（所以测得了）
└── renderer/    Vue 3 渲染层：编辑器内核扩展、组件、Pinia stores、命令与快捷键
tests/           node --test 单元测试（纯逻辑，毫秒级）
tools/           验收脚手架：lib/harness.js + run-suites.js + _verify-*.js（CDP 端到端）
tools/fixtures/  Markdown 往返保真夹具 + EXPECT.json（预期即契约）
docs/            设计手册 / 整改方案 / 打包实测
```

想动手改代码，先读 `docs/typora-wysiwyg-manual.md` 里对应模块的取舍与历次修复记录 —— 那里写着**为什么**是现在这样。

### 代码规模

<!-- facts:begin（由 tools/doc-facts.js 生成，勿手改）-->

| 范围 | 文件 | 行数 |
|---|---|---|
| `src/main` | 39 | 8977 |
| `src/preload` | 3 | 395 |
| `src/shared` | 37 | 4966 |
| `src/renderer` | 146 | 34894 |
| `src 合计` | 225 | 49232 |

口径：`src/main`/`preload`/`shared` 数 `.ts`，`src/renderer` 数 `.ts`+`.vue`（含子目录）。

<!-- facts:end -->

> 这几个数字**不要手写**：`npm run docs:facts:write` 重算，`npm run docs:facts:check` 在 `npm run ci` 里校验。

---

## 质量门禁

```bash
npm run typecheck   # tsc（主进程/preload）+ vue-tsc（渲染层），双工程
npm run lint        # ESLint（flat config）；0 error / 0 warning 是门槛
npm run test:unit   # node --test：纯逻辑单元测试（tests/）
npm run build       # 生产构建
npm run ci          # typecheck + lint + test:unit + build —— CI 用的就是它
```

除单元测试外，还有一套**真实桌面**的端到端验收（CDP 驱动真窗口、真鼠标键盘）：

```powershell
node tools/run-suites.js                            # 默认那一组（不需要 dev server）
node tools/run-suites.js --ci-subset                # PR 门禁跑的同一批
node tools/run-suites.js --suite=_verify-session.js # 点名跑
node tools/run-suites.js --all                      # 全量（多数需要 5173 上的 dev server）
```

每个套件都会**起一个全新隔离实例**（套件会改设置、写草稿、动 kv，串着跑必然互相污染），末行 `--- N/M PASS` 汇总成矩阵。GitHub runner 是无头的，所以 CI 上只在 PR 跑其中的子集（阻塞），更宽的一批放夜间（只通知）。

> ⚠️ `npm run build` 之后**要让实例重新加载**：渲染层是构建产物，旧实例还跑着旧 bundle。

---

## 已知限制与路线（诚实清单）

| 项 | 现状 | 计划 |
|---|---|---|
| **Markdown 往返保真** | ✅ 判级器 + 33 份夹具 + 三层套件（文档级 / 幂等 / 字节级）；分类计数 `exact 17 / normalized 16 / lossy 0`（由 `tools/fixtures/md/EXPECT.json` 实测，单测对账；每条 `normalized` 都写了 why 与修法）。脚注原样透传 | 逐条修剩余缺口（定义列表、行内 HTML 等） |
| 本地历史 / 回滚 | ✅ 每次写盘前留一份快照（每文件 30 条 / 30 天 / 全库 2000 条，策略在 `src/shared/history.ts`），菜单「本地历史…」可查看并载入编辑器（载入≠写盘） | 保留策略做成可配 |
| 行尾（CRLF/LF） | ✅ 行尾是文档级元数据：打开时按多数判定、内存一律 LF、写盘还原，状态栏可点切换（规则在 `src/shared/eol.ts`） | 多窗口一致性 |
| 查找替换 | ✅ `Ctrl+F`（焦点在文件面板时改搜文件名）、正则与捕获组、大小写、全部替换，两个编辑面都支持（纯逻辑在 `src/renderer/src/lib/findReplace.ts`） | 无 |
| 编辑器 ⇄ store 同步 | ✅ 单向数据流账本：三个编辑面共用 `rev + author + applied`，不存在第二条同步通道（`src/renderer/src/lib/contentSync.ts`） | 嵌套样式支持 |
| 文件树键盘可达 | ✅ `role="tree"` + roving tabindex + 方向键 / Home / End / Enter；`F2` 重命名、`Delete` 删除（`src/renderer/src/lib/treeFocus.ts`） | 拖放排序 |
| 诊断与日志 | ✅ 设置 → 高级：「复制诊断信息」（版本 / 平台 / 数据位置 / 设置快照 / 最近错误标题，**不含文档内容与最近文件清单**）+「打开日志目录」（`src/shared/diagnostics.ts`） | 崩溃转储 |
| 打字机模式 | ⛔ 已摘掉 —— 留一个点了只弹「功能待接入」的入口，等于承诺不存在的功能 | 若要做，按「光标行居中」重写后再放入口 |
| 自动更新 / 代码签名 | ❌ `publish` 仍是占位、未签名（Windows 会提示未知发布者） | 两条都卡在外部资源：没有代码签名证书、没有真实发布仓库地址，所以不发明占位 URL |
| Electron 版本 | ⚠️ 实装 **39.8.10**，而 39 已 EOL（Chromium 落后约 10 个大版本）；实测事实与复验清单见 `docs/electron-upgrade.md` | 单独分支升到受支持 major，跑完整矩阵（含打包态） |
| 跨平台 | ⚠️ mac / Linux 未验证 —— `build:mac` / `build:linux` 会**明确拒绝**（`tools/refuse-unverified-platform.js`），而不是产出没验过的包 | 明确暂缓 |

---

## 开发约定（认真但不多）

1. **一次一波**：不做"顺手把别的也改了"的提交；每波必须留下**可复跑的数字**（套件 `--- N/M PASS` 或命令 exit code）。
2. **一次真相**：跨进程的东西放 `src/shared/`（类型 + 纯函数）；能抽成纯函数的判定，就别写在 I/O 里 —— 那样才测得了。
3. **绝不碰用户数据**：验收与调试一律 `--user-data-dir=<临时目录>`。
4. **写盘一律走原子写**（临时文件 + fsync + rename）；绕过它等于放弃崩溃安全。
5. **提交信息**走 Conventional Commits（`fix(scope): …` / `feat(scope): …`），便于汇出 `CHANGELOG.md`。
6. **别用 PowerShell 改源码字符串**：`Get-Content -Raw` 会按系统 ANSI 码页解码，一步就把 UTF-8 文件变成乱码（中间那步有损）。批量改源码用 Node 脚本，PowerShell 只用来跑命令、读输出。

---

## License

MIT · Free & Open Source
