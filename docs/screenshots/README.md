# Screenshots

All images here are **real application screenshots**, captured from Lumin windows running against
two equivalent demo documents (one English, one Chinese) in isolated profiles. Nothing is a mockup
or a composite. The demo document, window, and profile contain no personal paths, user names, or
private documents, and the captures contain no desktop or taskbar.

## Bilingual sets

| Directory | UI language | README |
| --- | --- | --- |
| `en/` | English (`en-US`) | [README.md](../../README.md) |
| `zh/` | 简体中文 (`zh-CN`) | [README.zh-CN.md](../../README.zh-CN.md) |

Both directories use the **same file names**, so the two READMEs can reference the same feature
set in their own language:

| File | Shows |
| --- | --- |
| `hero.png` | Main window: typeset prose, inline math, an editable table, and the outline |
| `dark.png` | The same main window in the dark theme |
| `outline.png` | The outline in the left sidebar, following the current section |
| `mermaid.png` | A fenced `mermaid` block rendered in place |
| `codeblock.png` | A CodeMirror 6 block with syntax highlighting and the language picker outside the block |
| `spellcheck.png` | A misspelled word with its wavy underline and the app's suggestion menu |
| `image.png` | A local image resolved from a relative path |
| `split.png` | Split view: rendered document and Markdown source side by side |
| `source.png` | Source mode |
| `settings.png` | Settings → General, including the interface-language switch |
| `settings-keymap.png` | Settings → Shortcuts: factory defaults and reassignment controls |
| `palette.png` | The command palette, including the export commands |

## How they were captured

- Window content is captured through the DevTools protocol (`Page.captureScreenshot`), so only the
  application viewport is in the image: no desktop, no taskbar, and no window chrome.
- Each language gets its own isolated profile under `%TEMP%` (the profile directory name does not
  contain `lumin`), its own debugging port (`9548` for English, `9549` for Chinese), and a temporary
  demo workspace declared through `LUMIN_TRUSTED_PATHS`.
- Viewport: 1360 × 840 CSS pixels at device scale factor 1. Every PNG is under 500 KB.
- Before every shot the capture script reads the live `i18n` locale and asserts a known visible
  string in that language (the top menu label, the Settings title, or the command-palette
  placeholder). The per-shot evidence is written to `tmp/readme/shot-langs.json`.
- The English document uses `teh` as its misspelling; the Chinese document uses `我们的的`.

Notes for contributors:

- Capture from the real app, not from a design tool. Keep the demo document generic.
- Do not include desktop chrome, taskbars, recent-file lists, absolute paths, or account names.
- Keep the width at 1400 px or less and each file under 500 KB.
- Reference images from the READMEs with the language directory (`docs/screenshots/en/<name>.png`
  or `docs/screenshots/zh/<name>.png`).

---

# 截图说明

本目录中的图片都是**真实运行截图**：在隔离 profile 里用两份内容等价的演示文档（英文、中文各一份）
打开 Lumin 后截取。没有生成图或合成图；演示文档、窗口与 profile 中都不含个人路径、用户名或私人
文档，截图中也没有桌面或任务栏。

## 双语两套

| 目录 | 界面语言 | README |
| --- | --- | --- |
| `en/` | English（`en-US`） | [README.md](../../README.md) |
| `zh/` | 简体中文（`zh-CN`） | [README.zh-CN.md](../../README.zh-CN.md) |

两个目录使用**完全相同的文件名**，方便中英两版 README 按语言目录引用同一组功能：

| 文件 | 内容 |
| --- | --- |
| `hero.png` | 主界面：排好版的正文、行内公式、可编辑表格与大纲 |
| `dark.png` | 深色主题下的主界面 |
| `outline.png` | 左侧大纲，跟随当前章节 |
| `mermaid.png` | 由 `mermaid` 围栏代码块就地渲染的图表 |
| `codeblock.png` | CodeMirror 6 代码块、语法高亮，以及浮在块外的语言选择器 |
| `spellcheck.png` | 错词的波浪线与应用内建议菜单 |
| `image.png` | 由相对路径解析出的本地图片 |
| `split.png` | 双列：左侧渲染、右侧 Markdown 源码 |
| `source.png` | 源码模式 |
| `settings.png` | 设置 → 通用，含界面语言切换 |
| `settings-keymap.png` | 设置 → 快捷键：出厂默认值与改绑入口 |
| `palette.png` | 命令面板，含导出命令 |

## 采集方式

- 通过 DevTools 协议（`Page.captureScreenshot`）只截应用视口：没有桌面、任务栏或窗口边框。
- 每种语言使用独立的 `%TEMP%` 隔离 profile（目录名不含 `lumin`）、独立调试端口
  （英文 `9548`、中文 `9549`），并通过 `LUMIN_TRUSTED_PATHS` 声明一个临时演示工作区。
- 视口 1360 × 840 CSS 像素、设备缩放 1；每张 PNG 都小于 500 KB。
- 每张截图采集前都读取当前 `i18n` 语言，并断言一条该语言下已知可见文案（顶部菜单、
  设置页标题或命令面板占位符）。逐张证据写入 `tmp/readme/shot-langs.json`。
- 英文文档用 `teh` 作为错词，中文文档用 `我们的的`。

投稿约定：

- 必须从真实应用截取，不使用设计稿；演示文档保持通用内容。
- 不出现桌面、任务栏、最近文件列表、绝对路径或账号名。
- 宽度不超过 1400 px，单张不超过 500 KB。
- README 里按语言目录引用（`docs/screenshots/en/<name>.png` 或 `docs/screenshots/zh/<name>.png`）。
