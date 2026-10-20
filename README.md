# Lumin

**Write in Light** —— 一款 Windows 优先的所见即所得 Markdown 编辑器。

打开 `.md` 文件看到的就是排好版的正文，不是一堆 `#` 和 `*`。想改哪句就点哪句，
语法标记只在你光标所在的那一段出现；改完移开，又回到干净的排版。
表格、代码块、公式、流程图全部**就地编辑**，不需要切到源码模式，也不用按预览键。

**技术栈**：Electron 39 · Vue 3.5 · Tiptap 3 · CodeMirror 6 · Mermaid 11 · KaTeX 0.18

**为什么选它**

- **所见即所得**：标题、列表、表格、图片、链接都在正文上直接改，没有“源码 / 预览”往返。
- **公式完全离线**：KaTeX 与字体随包发布，断网、内网、离线笔记本上都能渲染，零 CDN 请求。
- **Mermaid 即时预览**：代码块标注为 `mermaid` 就渲染成图，点一下回到源码继续改。
- **中英拼写检查**：基于 Electron 内置拼写检查；中文按启发式规则提示常见混用。
- **防卡死护栏**：超大粘贴、长任务与渲染心跳都有保护，卡住时提示并给出恢复路径。
- **代码块体验**：内嵌 CodeMirror 6，行号、语言选择、括号补全、按需语法高亮。

## 截图

> 仓库目前还没有收录正式界面截图。占位说明与投稿规范见
> [`docs/screenshots/README.md`](docs/screenshots/README.md)。
> 在真实截图到位前，这里不放生成图或合成图。

## 功能

### 编辑

- 标题、加粗、斜体、删除线、行内代码、引用、有序 / 无序 / 任务列表、表格、图片、链接、分割线。
- 光标感知语法：行内标记只在光标进入时露出，离开即隐藏；`# `、`- `、`[ ] ` 等输入规则即时成形。
- 多光标、拖动选字、撤销 / 重做；查找替换支持正则与捕获组。
- 中文 / 日文输入法适配；行尾自动识别 CRLF / LF，状态栏可切换。

### 公式与图表

- 行内 `$…$`、块级 `$$…$$`，KaTeX 本地渲染；点公式在上方浮出源码框，逐键实时预览。
- Mermaid 流程图、时序图、甘特图等：代码块直接渲染，失败时保留源码并提示。
- 图表与公式导出到 PDF / HTML / Word / EPUB 时一并渲染。

### 代码块

- CodeMirror 6：行号、折叠、括号闭合与补全，百余种语言按需加载。
- 语言选择器、复制按钮、多光标；代码内容不经过 Markdown 往返改写。

### 文件与工作区

- 一个窗口一篇文档，一个文件只开一个窗口；下次启动恢复上次文档、光标与滚动位置。
- 文件夹工作区文件树、大纲联动、全局全文搜索（本地索引，不上传）。
- 自动保存可选；每次覆盖前留历史快照，可从菜单查看并载入编辑器。
- 崩溃或关窗前提示保存；大文档有粘贴规模护栏与恢复入口。

### 导出与打印

- PDF / HTML / Word / EPUB，公式、图表、代码高亮一并导出。
- 应用内打印预览，`Ctrl+P` 直接打印。

### 界面与语言

- 亮色 / 暗色 / 羊皮纸三种主题；简体中文 / English / Русский 三种界面语言。
- 大纲可放左栏页签，也可切到编辑区右侧形成“目录｜正文｜大纲”三栏。

## 安装

### 下载安装包

1. 到本仓库的 **Releases** 页面下载最新的 Windows 安装包（`Lumin-x.y.z-setup.exe`）。
2. 双击安装，按向导选择安装路径；安装器会创建开始菜单与桌面快捷方式。
3. 首次启动若出现 **“Windows 已保护你的电脑”**：安装包**尚未做代码签名**，
   点「更多信息」→「仍要运行」即可。这是已知限制，不是安装包损坏。

**系统要求**：Windows 10 / 11（64 位）；安装后约占 400 MB 磁盘空间。

### 从源码构建

```powershell
npm ci
npm run build:win
```

产物在 `dist/`：`Lumin-x.y.z-setup.exe`、`latest.yml` 与对应的 `.blockmap`。
需要 Node 22（`>= 22 <25`）与一个能运行 Electron 的 Windows 桌面会话。
macOS / Linux 目前不提供构建产物（`npm run build:mac` / `build:linux` 会明确拒绝）。

## 快捷键

下表是**出厂默认键**，不是文档里的示例。默认键定义在
[`src/renderer/src/composables/useKeymap.ts`](src/renderer/src/composables/useKeymap.ts)
（应用级命令）与 [`src/renderer/src/lib/editor/inlineMarks.ts`](src/renderer/src/lib/editor/inlineMarks.ts)
（编辑器内格式），快捷键解析服务在 [`src/renderer/src/lib/keymap/keys.ts`](src/renderer/src/lib/keymap/keys.ts)。
`Mod` 在 Windows 上就是 `Ctrl`；下表按 Windows 写法列出。所有键都可以在
「设置 → 快捷键」里改绑或解绑。

| 操作 | 快捷键 |
| --- | --- |
| 新建 / 新建窗口 | `Ctrl+N` / `Ctrl+Shift+N` |
| 打开文件 / 打开文件夹 | `Ctrl+O` / `Ctrl+Shift+O` |
| 保存 / 另存为 | `Ctrl+S` / `Ctrl+Shift+S` |
| 打印 / 导出 PDF | `Ctrl+P` / `Ctrl+Shift+E` |
| 关闭窗口 | `Ctrl+W` |
| 查找 / 替换 | `Ctrl+F` / `Ctrl+H` |
| 粘贴为纯文本 | `Ctrl+Shift+V` |
| 打开设置 | `Ctrl+,` |
| 打开快捷键设置 | `Ctrl+K` |
| 命令面板 | `Ctrl+Shift+P` |
| 加粗 / 斜体 | `Ctrl+B` / `Ctrl+I` |
| 删除线 / 行内代码 | `Ctrl+Shift+X` / `Ctrl+E` |
| 引用 | `Ctrl+Shift+Q` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y`（或 `Ctrl+Shift+Z`） |
| 插入表格 / 分割线 | `Ctrl+Alt+T` / `Ctrl+Alt+H` |
| 插入图片 / 代码块 | `Ctrl+Shift+Alt+I` / `Ctrl+Shift+Alt+C` |
| 插入链接 | `Ctrl+Alt+K` |
| 插入块级公式 / Mermaid | `Ctrl+Alt+M` / `Ctrl+Alt+G` |
| 上方 / 下方插入段落 | `Ctrl+Alt+↑` / `Ctrl+Alt+↓` |
| 切换侧栏 / 专注模式 | `Ctrl+Shift+B` / `Ctrl+Shift+F` |
| 循环编辑模式 | `Ctrl+/` |
| 应用内下一个 / 上一个窗口 | `Ctrl+Tab` / `Ctrl+Shift+Tab` |

> 全局搜索出厂**不绑键**：从「编辑」菜单或命令面板打开，也可以在设置里给它绑一个键。
> 导出 HTML / Word / EPUB 同样没有默认键，入口在「文件 → 导出」。

## 开发

```powershell
npm ci                 # 严格按 package-lock.json 安装
npm run dev            # 开发模式（主进程 --watch + 渲染层 HMR）
npm run dev:isolated   # 独立 profile，不碰你正在用的数据
npm run test:unit      # 纯逻辑单元测试（node --test）
npm run ci             # 类型 / ESLint / 单测 / 许可声明 / 文档数字 / 设计令牌 / 生产构建
npm run test:suites    # 默认 CDP 验收矩阵（需要真实桌面会话）
```

- 提交前至少跑 `npm run ci`；改了编辑行为再跑对应套件（`node tools/run-suites.js --suite=<文件名>`）。
- 文档里的数字由脚本生成：改了代码或文档后跑 `npm run docs:facts:write`。
- 开发约定、提交信息格式与验收套件规则见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与
  [`tools/README.md`](tools/README.md)。

## 已知限制

| 项 | 现状 | 说明 / 计划 |
| --- | --- | --- |
| 代码签名 | ❌ 安装包未签名 | 卡在外部资源（签名证书），不放置占位签名；安装时需走 SmartScreen 的“仍要运行” |
| macOS / Linux | ❌ 未验证、不提供构建 | 需要真实桌面环境做完整验收；构建脚本会明确拒绝，不发没验过的包 |
| 自动更新 | ❌ 更新渠道仍是占位地址 | 需要稳定的分发地址与签名链路；当前请手动下载新版本 |
| 中文拼写检查 | ⚠️ 启发式规则 | 覆盖常见中英混用与重复字，不承诺完整词典；误报可在右键菜单忽略 |
| 系统词典与语言包 | ⚠️ 依赖 Electron 内置拼写检查 | 可用语言取决于操作系统；Linux 上尤其受 hunspell 字典影响 |
| 超长文档 | ⚠️ 十万字量级建议分篇 | 大文档滚动已做优化；极端长文的虚拟滚动仍在路线图上 |
| 冷门 Markdown 扩展 | ⚠️ 脚注等按原样透传 | 继续补齐更少见的扩展语法；欢迎带最小样例提 issue |
| 版本快照 | ⚠️ 保留条数固定 | 每次覆盖前留快照；保留条数做成可配置仍在计划中 |
| 行尾格式 | ✅ 自动识别 CRLF / LF | 状态栏可手动切换；多窗口同时编辑的极端场景仍需注意 |

## 许可

- 本项目以 **MIT** 许可发布，全文见 [`LICENSE`](LICENSE)。
- 第三方依赖与许可声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
- 贡献指南见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，社区行为准则见 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
- 安全问题请按 [`SECURITY.md`](SECURITY.md) 的渠道私下报告，不要先开公开 issue。

---

# Lumin (English)

**Write in Light** — a Windows-first WYSIWYG Markdown editor.

Open a `.md` file and you see typeset prose, not a wall of `#` and `*`. Click the sentence you
want to change; the syntax marks appear only around your caret and disappear when you move away.
Tables, code blocks, math, and diagrams are edited in place — no source-mode round trip.

**Highlights**

- **WYSIWYG**: edit headings, lists, tables, images, and links directly on the rendered page.
- **Offline math**: KaTeX and its fonts ship with the app; no CDN requests.
- **Live Mermaid**: fenced blocks marked `mermaid` render immediately, click to edit the source.
- **Spellcheck**: Electron's built-in checker for English plus a heuristic pass for Chinese.
- **Freeze protection**: guards for huge pastes and long tasks, with a recovery path.
- **Code blocks**: CodeMirror 6 with line numbers, language picker, completion, lazy highlighting.

## Screenshots

No official screenshots are checked in yet. See
[`docs/screenshots/README.md`](docs/screenshots/README.md) for the placeholder and submission
guidelines. We do not publish generated or composited images as product screenshots.

## Features

- Markdown formatting, task lists, tables, images, links, and horizontal rules.
- Caret-aware syntax markers and input rules; multi-cursor; find & replace with regex.
- Inline and block math via KaTeX, with a live source editor above the formula.
- Mermaid diagrams rendered from fenced code blocks, with source preserved on failure.
- CodeMirror 6 code blocks: line numbers, folding, completion, on-demand language loading.
- Folder workspaces, outline navigation, and local full-text search.
- Export to PDF / HTML / Word / EPUB; in-app print preview.
- Multi-window editing, session restore, optional autosave, and version snapshots.
- Light / dark / sepia themes; Simplified Chinese, English, and Russian UI.

## Installation

1. Download the latest `Lumin-x.y.z-setup.exe` from the repository's Releases page.
2. Run the installer and choose an install location.
3. If Windows SmartScreen appears, click **More info → Run anyway**. The installer is
   **not code-signed** yet; this is a known limitation, not a corrupted download.

Windows 10 / 11 (64-bit) is the supported platform. macOS and Linux builds are not provided.

Build from source with Node 22:

```powershell
npm ci
npm run build:win
```

The artifacts (`Lumin-x.y.z-setup.exe`, `latest.yml`, and `.blockmap`) are written to `dist/`.

## Keyboard shortcuts

The table above lists the real factory defaults, defined in
[`src/renderer/src/composables/useKeymap.ts`](src/renderer/src/composables/useKeymap.ts) and
[`src/renderer/src/lib/editor/inlineMarks.ts`](src/renderer/src/lib/editor/inlineMarks.ts).
`Mod` maps to `Ctrl` on Windows. Every binding can be changed or unbound in Settings → Keymap.

## Development

```powershell
npm run dev            # development with HMR
npm run test:unit      # unit tests (node --test)
npm run ci             # typecheck + lint + unit + notices + docs checks + build
npm run test:suites    # default CDP acceptance matrix (needs a real desktop session)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for conventions and
[`docs/releasing.md`](docs/releasing.md) for the release checklist.

## Known limitations

- The Windows installer is unsigned; SmartScreen will warn about an unknown publisher.
- macOS and Linux are untested and not provided.
- Auto-update uses a placeholder channel; download new releases manually.
- Chinese spellcheck is heuristic and may produce false positives.
- Spellcheck dictionaries come from Electron / the operating system, not the app bundle.
- Very long documents (hundreds of thousands of characters) should be split into chapters.
- Rare Markdown extensions are passed through rather than rendered.
- The number of retained version snapshots is fixed.

## License

MIT. See [`LICENSE`](LICENSE), [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md),
[`CONTRIBUTING.md`](CONTRIBUTING.md), and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
For security reports, follow [`SECURITY.md`](SECURITY.md).
