# Lumin 功能 × 自动化测试 覆盖矩阵

> **本文是一次只读审计的产物**（不修改 `src/`、不提交、不执行任何套件）。
> 数据来源：`tools/_*.js`（98 个）的文件头注释与断言名、`tools/run-suites.js`（默认矩阵）、
> `tools/verify-tiptap.js`（69KB 遗留总套件）、`tests/*.test.mjs`（23 个单测文件）、
> `README.md`、`docs/typora-wysiwyg-manual.md`、`docs/wysiwyg-test-plan.md`。

## 0. 口径与计数约定

| 记号 | 含义 |
|---|---|
| **断言数** | 该套件内 `report.check('…')` / `c('…')` / `check('…')` 的**实际调用条数**（模板字面量名另计，已说明）。`0` = 脚本只 `console.log` 观察值、仅在异常时 `FAIL`，靠退出码判定 —— **不是断言**。 |
| **强** | 有端到端断言，且覆盖该功能的多个侧面（正常 + 边界 + 持久化）。 |
| **部分** | 有断言但只覆盖一个侧面/一个入口，或只覆盖纯函数层。 |
| **仅间接** | 没有直接断言，只能靠别的断言顺带（或只有静态源码核对、注释级证据）。 |
| **非矩阵** | 该套件有真断言，但**不在** `run-suites.js` 的默认矩阵里，也不在 `--all` 里（`--all` 只收 `_verify-*`）。 |

**规模事实**（本次实测）：

- `tools/_*.js` 共 **98** 个：`_verify-*` 66、`_regress-*` 6、`_repro-*` 9、`_check-*` 5、`_test-*` 3、`_exp-*` 2，另有 `_btn-check` / `_time-close` / `_set-windowstate` / `_startup-bench` / `_trigger-export` 各 1。
- 全部工具脚本里带名字的断言调用共 **949** 条（含少量重复名与辅助函数）。
- `run-suites.js` **默认矩阵 21 个**套件；`--all` 理论上有 **66 个**（全部 `_verify-*`），另有 **6 个 `_regress-*` / 1 个 `_repro-*` 只出现在默认矩阵**。
- 关键发现：**`tools/verify-tiptap.js`（1473 行 / 114 项断言）不在任何矩阵里**，却是气泡菜单、input rules、标记符、表格编辑、全局搜索、粘贴的唯一自动化资产（详见 §3.3）。

---

## 1. 功能清单 × 覆盖矩阵

### 1.1 编辑核心

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| WYSIWYG 富文本渲染（标题/粗斜/删除线/下划线/行内代码/引用/列表/任务/表格/图片/链接/分割线） | `verify-tiptap.js` A/B（**非矩阵**）；`_verify-md-fidelity`（N1/T1/I1–I3）；`_verify-surfaces`（E0 标题字号递减） | 26（legacy）+ 6 + 1 | 强 | 逐元素渲染的主证据在 legacy 套件里；矩阵内只覆盖公式/表格/HTML/结构的几个切面 |
| 动态输入语法 input rules（`# ` / `- ` / `[ ] ` / 围栏 / `---`） | `verify-tiptap.js` B/E（`heading-input-rule`、`bullet-input-rule`、`task-input-rule`、`hr-enter-rule`，**非矩阵**）；`_check-heading-rule.js`（探针，0 断言） | 6（legacy） | 部分 | 矩阵内**零断言**；坏掉不会红 |
| 光标感知标记符显隐（块级 Decoration / 行内 DOM 类） | `verify-tiptap.js` B（`bold-marker-reveal/boundary/hide-on-exit/no-layout`、`heading-marker-hide-on-exit`，**非矩阵**）；`_verify-blockquote-style`（`no-gt-marker-idle/editing` 2 条） | 8（legacy）+ 2 | 部分 | 引用 `>` 有矩阵断言；`**` / `` ` `` / `#` 只有 legacy |
| 代码块：CodeMirror 6 内嵌、聚焦、打字、回车、空块退格删除 | `_regress-cb`(3)、`_regress-layout`(7)、`_regress-source-roundtrip`(4)、`_repro-rapidenter`(2)、`_verify-cb-no-active-line`(12) | 28 | 强 | 手册 §4.59 的「丢字」类数据损坏有专测（三处行数一致） |
| 代码块：行号开关（设置项 + 工具栏悬停小选项） | `_verify-cb-line-numbers`(13)、`_verify-cb-button-line-numbers`(26) | 39 | 强 | 含持久化、状态重建后仍生效、窄窗钳制 |
| 代码块：语言切换 / 语法高亮按需加载 / 括号补全 / 折叠 | `_verify-mermaid-blur`（`switch-away-creates-cm` 断言语言切到 javascript）、`_verify-cb-line-numbers`（`fold-gutter-kept` 1 条） | 2 | 部分 | **语法高亮按需加载与括号闭合/补全无任何断言**；语言切换只顺带验了一格 |
| Mermaid 图表：渲染成 SVG、点击回源码、点块外回图表、跨块切换 | `_verify-mermaid-blur`(22)、`_verify-mermaid-cross-block`(6) | 28 | 强 | 含焦点不被 PM 抢回、guard 装上/释放 |
| 表格：宽度撑满 + 单元格 min-width + 横向滚动 | `_verify-table-width`(14) | 14 | 强 | 1/2/3/12/20 列都验了 |
| 表格：单元格内键入、Tab 加行、悬停网格插入 | `verify-tiptap.js` D/F（`table-cell-edit`、`table-default-3x3`、`table-grid-picker-2x3`，**非矩阵**）；`_check-table-edit.js`（探针，0 断言）；`_verify-editor-menu`（表格动作执行 1 条） | 6（legacy）+ 1 | 部分 | 矩阵内只在右键菜单动作里验了一条「加行」 |
| 选区气泡菜单（加粗/斜体/下划线/删除线/行内代码/链接/清除格式） | `verify-tiptap.js` D（`bubble-menu-visible`、`bubble-bold-applied`、`bubble-stays-open`，**非矩阵**） | 3（legacy） | 仅间接 | **矩阵内零断言**；7 个按钮里只有 3 项被验过 |
| 数学公式 KaTeX（行内 `$…$` / 块级 `$$…$$`） | `_verify-math`(7)、`tests/mathScan.test.mjs`(9) | 16 | 强 | 渲染 + 原文逐字保留 + 坏公式不崩 + 光标露出原文 |
| 超链接：手打语法成形、点击展开源码、移开收敛、破坏语法保字面、空标签不崩 | `_verify-links`(12)、`verify-tiptap.js` I（**非矩阵**） | 12 + 4 | 强 | 矩阵内覆盖完整 |
| 粘贴：markdown 链接 / 块级 markdown / HTML | `_verify-link-paste`(3)；`verify-tiptap.js` G（`paste-md-blocks`、`paste-heading-editable` 等，**非矩阵**）；`_repro-paste.js`（探针） | 3 + 6 | 部分 | 只验了右键菜单「粘贴」；`Ctrl+V` 通道未断言 |
| 双面一致性：实时渲染 ⇄ 源码 ⇄ 分屏（I1–I12） | `_verify-surfaces`(18)、`_verify-surface-fuzz`(5)、`_verify-surface-stress`(8×12 用例)、`_regress-split-live`(5)、`_regress-fileswitch`(5) | 151+ | 强 | L2/L3/L4 三层齐；L3 为 500 篇生成语料（seed 777）、L4 为 12 个压力用例（1MB / 2000 围栏 / 100k 混合） |
| 大纲：标题收集、点击跳转、源码面清空 | `_regress-layout`（L8/L9 2 条）、`_verify-toc-style-scroll`（`outline-click-also-smooth`） | 3 | 部分 | **滚动联动高亮（active heading follows scroll）无断言** |
| `[TOC]` 目录节点：插入 / 渲染 / 点击跳转 / markdown 往返 | `_verify-toc.js`、`_verify-toc-load.js`（**探针，0 断言**）；`_verify-toc-style-scroll`(21，样式 + 平滑滚动) | 21 | 部分 | 插入与反向解析只有探针；样式与滚动有真断言 |
| 引用 blockquote 样式（3px 灰条、无底色圆角、编辑态无 `>`） | `_verify-blockquote-style`(12) | 12 | 强 | 含三主题令牌、markdown 原文不变、开关仍可用 |
| front matter / 行内与块级 HTML / 任务列表复选框的保真 | `_verify-md-fidelity`（H1–H4、I1–I3 共 7 条）、`tests/frontmatter.test.mjs`(11) | 18 | 强 | front matter 单测很细（`...` 收尾、CRLF、空块不认） |
| Markdown 往返保真（主信誉线） | `_verify-md-fidelity`(~35)、`tests/md-fidelity.test.mjs`(20)、`tests/mdGen.test.mjs`(8)、`tests/surfaceInvariants.test.mjs`(10)、`tools/fixtures/md/` 31 份夹具 + `EXPECT.json` | 73+ | 强 | `exact 9 / normalized 14 / lossy 8`（lossy 是 EXPECT.json 里写明理由的已知缺口） |
| 撤销 / 重做 | `_verify-cb-no-active-line`（`undo-restores-cm/pm` 2 条）、`_verify-surfaces`（D4 切面后撤销 1 条） | 3 | 部分 | 代码块内撤销与「切面后撤销安全」有；**全局编辑序列 Ctrl+Z/Ctrl+Y 无专测** |
| 大文档 / 畸形输入的性能与不崩 | `_verify-surface-stress`（12 用例 × 8 断言 = 96） | 96 | 强 | 每用例带 `budget`（打开/切源码/切回耗时），超预算即 FAIL |
| 打字机模式 | 无 | 0 | — | README 明示「菜单里有入口，点了提示功能待接入」→ 不算已交付功能 |

### 1.2 文件与工作区

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 打开「窗口外的文件」的落点规则（本窗口 / 新窗口 / 切侧栏） | `_verify-open-file-routing`(18) | 18 | 强 | **需要 dev server**（`import('/src/lib/openFile.ts')`），只在 `--all` 里跑 |
| 「一个文件只开一个窗口」+ 跨窗口聚焦 + 最小化唤醒 | `_verify-open-file-dedup`(21)、`_verify-packaging` D 段 | 21+ | 强 | 注册表清账、not-open 分支都验了 |
| 新建（文件菜单 / Ctrl+N）：新窗口 + 同工作区 + 未命名缓冲区 + 不落盘 | `_verify-new-document`(23)、`_verify-new-window-clean`(13) | 36 | 强 | 顺带验了「Ctrl+N 只触发一次」在 `_verify-keymap` |
| 「新建窗口」= 干净窗口（不继承工作区） | `_verify-new-window-clean`(13) | 13 | 强 | 干净窗口仍能自己开文件/开文件夹 |
| 保存 / 原子写 / 落盘字节正确 | `_verify-md-fidelity`（切 LF/CRLF 后落盘、元数据落库）、`_verify-surfaces` D5/D6 | 6 | 强 | 走真实 flush 管线（beforeunload），不是直接调写文件 |
| **自动保存（到磁盘）** | 无 | 0 | **空缺** | 所有套件都只是把 `settings.autoSave` **关掉**（`_verify-surfaces`/`_verify-wave3`/`_regress-split-live`/`_repro-rapidenter`/`_verify-md-fidelity`），没有一条断言验「开着时真的写盘」 |
| 另存为（对话框无法自动化 → 用等价序列覆盖） | `_verify-new-document`（`static-save-without-path-goes-to-save-as` 等 4 条）、`_verify-save-as-workspace`(17) | 21 | 部分 | 直接静态核对 + 等价序列；原生对话框本身无法作答（`window.luminAPI` 是冻结对象） |
| 另存为后侧栏对准（工作区内展开 / 工作区外重定根） | `_verify-save-as-workspace`(17) | 17 | 强 | 含 `ancestorDirs` / `parentDir` / `isInside` 边界 |
| 文件树就地重命名（右键 → 行内输入 → 回车） | `_verify-rename`(13) | 13 | 强 | Esc 取消、扩展名不选中、磁盘真改名都验了 |
| 重命名时 `documents.path` UNIQUE 冲突修复 | `_verify-rename-fix`(9) | 9 | 强 | 造出「陈旧索引行」真实场景 + FTS 仍可用 |
| **删除文件 / 删除文件夹（行为）** | 仅 `_verify-rename`（`file-row-menu-has-delete` 断言菜单项存在） | 1 | **空缺** | 菜单项存在 ≠ 删除可用；没有一条断言执行删除 |
| **文件树新建文件 / 新建文件夹（行为）** | `_verify-3tasks.js`（探针，0 断言）、`_verify-rename`（`dir-row-menu-offers-create`）、`_verify-keymap`（`ctrl-n-creates-no-file`） | 2 | **空缺** | 只有「菜单项在」与「Ctrl+N 不建文件」，落到新文件 + 就地重命名的链路只被探针打印过 |
| 工作区打开 / 最近文档 / 固定 / 移除 / 清除 / 二级子菜单 | `_verify-welcome-removed`(41) | 41 | 强 | 含内层滚动不关菜单、外层滚动关菜单 |
| **拖拽文件进窗口打开** | 无（`_verify-open-file-routing` 只在头注释里说「共用同一实现」并静态核对四处调用点） | 0 | **空缺** | 真正 `dragover`/`drop` 事件从未被派发 |
| 本地历史：保存前留快照 / 载入改缓冲 / 清空 / 保留策略可配 | `_verify-md-fidelity` E 段（6 条）、`tests/history.test.mjs`(6) | 12 | 部分 | 数据层齐；`LocalHistoryDialog.vue` 的对话框交互（列表渲染、点击载入按钮）无端到端断言 |
| 全局搜索 `Ctrl+Shift+P`（SQLite FTS5 trigram） | `_verify-keymap`（`default-global-search-fires` 1 条）；`verify-tiptap.js` D（`sqlite-search`、`sqlite-content-match`、`global-search-modal`，**非矩阵**）；`shell-test.js` / `shell-test2.js`（非矩阵、无 harness） | 1 + 3 | 部分 | 矩阵内只验「快捷键打开了面板」；**检索结果、结果点击跳转、FTS 命中率无矩阵断言** |
| 单实例锁 + 命令行参数转交 | `_verify-single-instance`(15)、`_verify-packaging` D 段 | 15+ | 强 | 自管实例、独立端口、独立 userData |
| 打开未保存更改的确认对话框 | `_verify-new-document`（`untitled-save-goes-through-save-as` 顺带） | 1 | 仅间接 | `lib/dialog.ts` 的「唯一实现」没有专测 |

### 1.3 查找与导航

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 查找替换：Ctrl+F 开关栏、前后命中循环、大小写、替换、全部替换、两个编辑面 | `_verify-find-replace`(12)、`tests/findReplace.test.mjs`(11) | 23 | 强 | 源码面替换回灌渲染面也验了 |
| 文件树键盘可达（ARIA tree + roving tabindex + 方向键/Home/End/Enter） | `_verify-wave3` B1–B10(13) | 13 | 强 | 空目录不崩、`←` 逐级收起 |
| 目录/大纲点击跳转 + 平滑滚动 + 减少动效降级 | `_verify-toc-style-scroll`(21) | 21 | 强 | 中途采样证明是动画而非瞬时 |
| 命令面板 / 转到行 / 转到符号 | 无 | 0 | — | 未实现 |
| 全局搜索结果导航（上一处/下一处） | 无 | 0 | — | 未实现 |
| 正则 / 全词匹配查找 | 无 | 0 | — | 未实现（查询串按字面量处理，有单测证明） |

### 1.4 导出

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 导出入口：一级「导出」+ 悬停二级四格式 + 动作接线 | `_verify-menu-export-submenu`(15) | 15 | 强 | 刻意**不点击**导出项（会弹原生「另存为」）；只断言「四个二级项各自接线到 `runExport('<格式>')`」 |
| **导出产物本身（PDF / HTML / Word / EPUB）** | 无。`_test-export-full.js`、`_test-pdf.js`、`_trigger-export.js`、`_verify-export-fix.js`、`_verify-export-fix2.js` 全是探针（0 断言，只打印） | 0 | **空缺** | 这是最大的功能级空洞：格式正确性、Mermaid 预渲染、KaTeX 样式内联、中文字体全部无人守 |
| **导出设置页（`settings.export` 页签）** | 无 | 0 | **空缺** | `SettingsDialog.vue` 有该页签，没有任何套件打开它 |
| 导出里的 Mermaid 预渲染 | `_test-mermaid.js`（探针，0 断言） | 0 | **空缺** | 只验了 `renderMermaidInHtml` 在页面上下文能跑 |
| 导出里的本地图片（`lumin-file://` 转 data URL） | 无 | 0 | **空缺** | — |

### 1.5 编码与行尾

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 编码判定链（UTF-8 / BOM / UTF-16LE / GBK / Shift_JIS / Windows-1251） | `_verify-encoding`(37)、`tests/encodings.test.mjs`(5) | 42 | 强 | auto 与显式选择、`explicit-choice-beats-bom` 都验了 |
| 每文件记忆编码 + 「选择编码重新打开」菜单（一级 + 二级 14 项 + 当前标记） | `_verify-encoding`（`reopen-*`、`menu-*`、`dom-submenu-*` 共 ~15 条） | 15 | 强 | 含视口钳制与真实点击切换 |
| 按原编码写回（GBK 文件保存后仍 GBK、UTF-8 BOM 仍在） | `_verify-encoding`（`save-keeps-gbk-bytes`、`save-gbk-roundtrip-equal`、`save-keeps-utf8-bom`） | 3 | 强 | 字节级校验 |
| 状态栏显示当前编码 + 提示 | `_verify-encoding`（`statusbar-shows-encoding`、`statusbar-has-tooltip`） | 2 | 强 | — |
| 行尾判定 / 内存归一 LF / 按元数据写回 / 未命名用默认值 | `_verify-md-fidelity`（行尾 6 条）、`tests/eol.test.mjs`(6)、`_verify-surfaces` D5 | 13 | 强 | `hasUniformEol` 告诉我们「这次保存会不会改到行尾」 |
| 多窗口编码/行尾一致性 | `_verify-md-fidelity`（元数据 B 窗口 2 条 + 每文件记录优先 1 条） | 3 | 部分 | README 里「多窗口一致性还没做」是错的：已有断言 |
| **状态栏点击切换行尾（CRLF ⇄ LF）** | 无（套件都通过设置或元数据改） | 0 | 仅间接 | 改链路验了，点状态栏这个入口没验 |

### 1.6 会话与草稿

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 会话恢复：文档 + 光标 + 滚动比例 + 路由 | `_verify-session`(17)、`tests/session.test.mjs`(9) | 26 | 强 | 用页面 reload 走真实恢复路径（argv → bootstrap → restoreSession） |
| 「单独关窗 vs 整体退出」的恢复语义 | `_verify-session-last-closed`(8)、`tests/session.test.mjs`(9) | 17 | 强 | 自管实例、3 轮真实起杀 |
| 会话开关（`restoreSession=false` → 落在编辑器） | `_verify-session`（`toggle-off-shows-welcome`、`toggle-on-restores-again`） | 2 | 强 | 注意断言名还叫 *welcome*，实际已是「落到编辑器」 |
| 草稿横幅只在真需要时出现（假阳性回归） | `_verify-draft-banner`(25)、`tests/drafts.test.mjs`(11)、`tests/filesRules.test.mjs`(9) | 45 | 强 | 含无主草稿归属、跨窗口隔离、重开空白缓冲区、重启后行为 |
| 崩溃/关窗草稿恢复正文 | `_verify-draft-banner`（③⑦⑧ 共 ~8 条）、`_verify-session-last-closed` C | 10 | 强 | 含「恢复后消耗掉草稿」 |
| 文件丢失时不阻塞启动 + 告警通知 | `_verify-session`（`missing-file-does-not-open`、`missing-file-notifies`） | 2 | 强 | — |

### 1.7 多窗口

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 一窗口一文档 / 新窗口槽位领取 | `_verify-session`（`new-window-has-slot` 等）、`_verify-new-window-clean`(13) | 6 | 强 | — |
| 应用内 Ctrl+Tab / Ctrl+Shift+Tab 切换窗口（真实焦点转移） | `_verify-keymap`（`ctrl-tab-*`、`rebound-window-cycle-works` 5 条） | 5 | 强 | 含改键后仍生效 |
| 第二实例参数转交给首实例（新窗口 / 打开文件 / 重复文件不重开） | `_verify-packaging` D 段（~8 条）、`_verify-taskbar-jumplist` C 段 | 15+ | 强 | — |
| 多窗口工作区互不影响 | `_verify-new-window-clean`（`window-a-untouched`、`global-workspace-unchanged`）、`_verify-welcome-removed` | 3 | 强 | — |

### 1.8 设置

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 设置面板结构（6 页签：general/editor/appearance/keymap/export/links） | 分散：keymap=`_verify-keymap`（`settings-keymap-tab-renders`）、links=`_verify-link-open`（`links-tab-renders`）、editor=`_verify-cb-line-numbers`、appearance=`_verify-segmented-control`+各样式套件 | 6+ | 部分 | **没有任何套件断言「6 个页签都在、都能打开」**；页面自身也没有导航回归 |
| 快捷键：命令表、默认键、自定义、解绑、恢复、冲突、录制、持久化 | `_verify-keymap`(33) | 33 | 强 | 矩阵里最厚的单套件之一；含 reload 后仍在（SQLite） |
| 设置落库（SQLite settings / 每文件记录 / menu_usage） | `_verify-encoding`（`setting-persisted-in-sqlite`）、`_verify-cb-line-numbers`（`persisted-flipped`）、`_verify-keymap`（`custom-binding-persisted-in-sqlite`）、`_verify-link-open`（`linkCreateMode-persisted`）、`_verify-editor-menu-extras`（3 条直读 SQLite） | 7 | 强 | `_verify-editor-menu-extras` / `_verify-notify-disk` 用 `node:sqlite` 直读库文件 |
| 代码块行号设置项 | `_verify-cb-line-numbers`(13) | 13 | 强 | — |
| 链接页签：创建策略三态 + 历史列表 + 单条删除 + 清空 | `_verify-link-open` I 段（7 条） | 7 | 强 | — |
| 主题设置（亮/暗/羊皮纸） | 令牌级：`_verify-segmented-control`（`theme-tokens-drive-colors`）、`_verify-sidebar-tree-style`（`theme-driven-selection`）、`_verify-sidebar-handle-style`（`theme-tokens-adapt`）、`_verify-editor-menu-extras`（三主题配色 3 条）、`_verify-toc-style-scroll`（`default-color-follows-token`） | 7 | 部分 | 「选中某个主题 → 全应用真的换色」没有一条端到端断言，只有局部令牌断言 |
| **主题 = 跟随系统（auto）** | `_verify-theme-auto.js`（探针，0 断言；只打印 `themeClass`/`prefersDark`） | 0 | **空缺** | 曾经的真实 bug（只标题栏更新、内容仍深色）现在无人守 |
| **导出设置页** | 无 | 0 | **空缺** | 见 §1.4 |
| 语言设置（zh-CN / en-US / ru-RU） | 见 §1.9「三语言」 | — | 部分 | — |
| 本地历史保留策略设置 | `_verify-md-fidelity` G 段（`历史 保留条数按设置抽稀（上限 2）`） | 1 | 部分 | 只有一个上限值的断言 |
| 菜单栏开关（`nativeMenuBar`） | `verify-tiptap.js`（`settings-sqlite-persist`，**非矩阵**） | 1（legacy） | 仅间接 | 矩阵内无 |

### 1.9 界面与 i18n

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 主进程原生菜单：无硬编码中文 + 三语 key 齐全 + 键集合一致 | `tests/menu.test.mjs`(4) | 4 | 强 | 静态核对，但覆盖面准 |
| 原生菜单按持久化语言重建（三语） | `_verify-wave3` C1/C2（读实例 stdout 的 `[menu] rebuilt` 自检行） | 2 | 强 | — |
| 命令表标题/分组已翻译 | `_verify-keymap`（`titles-and-groups-translated`） | 1 | 强 | — |
| 编码菜单标题跟随语言 | `_verify-encoding`（`i18n-menu-title-follows-language`） | 1 | 强 | — |
| 通知文案 i18n（en） | `_verify-notifications`（`i18n-en`、`level-label-from-i18n`） | 2 | 强 | — |
| **界面正文（非菜单）三语文案完整性与 ru-RU** | `_verify-i18n.js`（探针，0 断言，只打印菜单文字）；`tests/menu.test.mjs` 只覆盖主进程菜单 + 三份语言包键集合 | 0 | **空缺** | 语言包键集合一致 ≠ 渲染层用到的每个 key 都有值 |
| 工具栏 / 分段控件（编辑器模式 3 段、侧栏视图 2 段） | `_verify-segmented-control`(16)、`_verify-bars-no-filename`（`toolbar-still-has-buttons`） | 17 | 强 | 含指示块几何、aria、动画落点、横向不溢出 |
| 侧栏文件树视觉规范（27px 行高、6px 圆角、16px 缩进、令牌配色） | `_verify-sidebar-tree-style`(26) | 26 | 强 | 三主题下选中态都验了 |
| 列表视图排版（分割线、去后缀、后缀标签字号） | `_verify-filelist-view`(13) | 13 | 强 | — |
| 侧栏折叠后的左缘悬停把手（阈值/迟滞/动效/键盘） | `_verify-sidebar-handle`(19)、`_verify-sidebar-handle-style`(19) | 38 | 强 | 两个套件有重叠，见 §3.4 |
| 状态栏（保存态、字数/行数/字符数、光标位置、编码、主题/语言入口） | `_verify-bars-no-filename`(12)、`_verify-encoding`（2 条） | 14 | 强 | 顺带钉死了「两条栏里不出现文件名」 |
| 窗口标题与任务栏标题（`文件名 - Lumin` / `• ` 脏标记 / 多窗口可区分） | `_verify-window-title`(14) | 14 | 强 | 另用 Win32 枚举核对真实原生标题 |
| 编辑器右键菜单（两级结构、8 个表格动作、最近使用、键盘导航、贴边钳制） | `_verify-editor-menu`(51)、`_verify-editor-menu-extras`(4)、`_verify-link-paste`(3) | 58 | 强 | 矩阵里断言最多的套件 |
| 全局 tooltip（750ms 延迟、title 接管与还原、响应式 title 不被覆写） | `_verify-tooltip`(6)、`_verify-notify-style`（2 条） | 8 | 强 | 矩阵内覆盖完整 |
| 通知带形态与位置（编辑区上方整幅 / 空态不占位 / 无级别图标与级别名）+ 进出场动效（含高度） | `_verify-toast-tip.js`(21)；`verify-tiptap.js`（`toast` 相关，**非矩阵**） | 21 | 强 | 三轮改写的产物：位置（static + 紧邻内核之前 + 整幅铺满编辑区宽）、形态（组件无盒子；带只有底部 1px 分界 + 顶部内高光）、动效（CSS 规则 + 真实进出场采样：opacity 0→1 与带高 0→终值的中间值）|
| 通知中心（CRUD、顶部通知区、级别图标、步进切换、多语言、不自动消失、重载存活） | `_verify-notifications`(32) | 32 | 强 | — |
| **代码块 CM 虚拟化（F 项 / O2）**：按需挂载 / 高度稳定 / 选区保护 / churn 后可打字 | `_verify-cb-virtualization`(9)、`_regress-cb`(3)、`_verify-cb-button-line-numbers`(26)、`_verify-cb-no-active-line`(12)、`_verify-cb-languages`(5) | 55 | 强 | 60 块文档里 `.cm-editor` ≤ 12 且滚到哪挂到哪；实测 120 块打开 1070→**193ms**、CM 实例 120→**4**；180 块 9101→**184ms**、180→**4** |
| 代码块语言高亮矩阵（15 种 + 别名；清单外退化为纯文本） | `_verify-cb-languages`(5) | 5 | 强 | ⚠️ 虚拟化之后必须**逐个围栏滚进视野再量**（否则量到的是一堆静态态 ⇒ 假失败） |
| 通知落盘 + 窗口作用域隔离 + 跨重启持久化 | `_verify-notify-disk`(8)、`_verify-notify-multiwindow`(21)、`_verify-notify-restart`(6) | 35 | 强 | 三套件分层；`notify-restart` 是两阶段（seed/check，中间由外部硬杀+重启），默认矩阵与 `--all` 都不跑 —— 由 `run-suites.js` 的 `MANUAL` 排除 |
| 通知带样式与版式（整幅中性淡底 + 只有底部 1px 分界 + 顶部内高光；两列栅格 + 标题/正文共用 measure + 信息条与标题首行结构对齐；空态连元素都不渲染；长正文就地滚动） | `_verify-notify-style`(22) | 22 | 强 | 非破坏式（临时插一条再硬删）；四轮改写：旧口径「宽 384 / 圆角 6」→「无盒子」→「整幅带 + 空态不占位」→「版式重排（栅格/measure/对齐）」 |
| **通知策略（哪些动作不发通知）** | 反向断言只有 `_verify-link-open` 的一条（`no-created-notification`）；其余被取消的成功类通知**无断言** | 1 | 仅间接 | ⚠️ **缺口**：口径写在 `stores/ui.ts` 的 `toast()` 注释里（失败/降级、需作答、结果不在界面上的三类才发），但没有套件守「保存 / 重命名 / 删除 / 全部替换 / 切换保存方式 / 已创建」这些**不得再发通知**——有人加回去矩阵不会红。真要守，可在 `_verify-notifications` 里加一组「动作 → 不得新增通知」的负向断言 |
| 欢迎页移除后的空态（侧栏空态三入口、文件菜单、路由回落、`/about` 仍在） | `_verify-welcome-removed`(41) | 41 | 强 | — |
| About 页内容 | `_verify-welcome-removed`（`about-still-works` 1 条） | 1 | 仅间接 | 只验路由可达，不验内容 |
| 图标与打包资源（exe 嵌我们的图标、反证 electron 图标） | `_verify-packaging`（B 段 ~7 条） | 7 | 强 | 逐像素比对 |

### 1.10 任务栏与系统集成

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| Windows 跳转列表（任务项 + 最近文档 + 命令行带应用目录） | `_verify-taskbar-jumplist`(39) | 39 | 强 | 三层验证：注册返回值、命令行、真拉起一个 Lumin 窗口 |
| 快捷方式 / AppUserModelID（不污染用户快捷方式） | `_verify-taskbar-jumplist`（`shortcut-*`、`isolated-*` 共 ~12 条） | 12 | 强 | 有「隔离实例不写用户 shortcut」的护栏 |
| 文件关联（仅 `.md`）+ 裸路径参数启动打开文件 | `_verify-packaging`（C/F/G 段） | 4 | 强 | 含中文夹具 + 编码链路 |
| 打包链路（`build:unpack` / NSIS / 配置单一来源 / appId 一致） | `_verify-packaging`(30) | 30 | 强 | ⚠️ 明确**绝不运行安装包** |
| **窗口位置/大小持久化（`windowState`）** | `_check-windowstate.js`（读）、`_set-windowstate.js`（写）—— **辅助探针，0 断言** | 0 | **空缺** | 两个脚本是给人做手工验证用的；没有「改了窗口尺寸 → 重启 → 恢复」的断言 |
| **关闭窗口耗时（不应再等 2.5s）** | `_time-close.js`（探针，0 断言） | 0 | **空缺** | 曾经修过的性能问题，现在只有打印值 |
| 自动更新 / 代码签名 | 无 | 0 | — | README 明示 `publish` 仍是占位、未签名 → 未交付 |

### 1.11 安全

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| `lumin-file://` 白名单：扩展名闸 + 位置闸（工作区/已打开文档目录之内） | `_verify-local-media`（3 条）、`tests/media.test.mjs`(8)、`tests/paths.test.mjs`(5)、`tests/imageSrc.test.mjs`(8) | 24 | 强 | 相对图片解析 + 真的加载成功 + 越界 404 |
| 危险协议（`javascript:`）拒绝，绝不 `shell.openExternal` | `_verify-link-open` F 段（4 条） | 4 | 强 | 含「不出现在历史表」 |
| 非文本目标不可创建 + 父目录一并创建 + 已存在拒绝覆盖（`wx`） | `_verify-link-open` A/B/G 段（~10 条） | 10 | 强 | — |
| 原子写（临时文件 + fsync + rename） | `_verify-md-fidelity`（落盘字节）间接；无专测 | 0 | 仅间接 | `fileOps.writeFile` 的崩溃安全本身没有断言 |
| **CSP 响应头（含禁 `eval`、`connect-src 'self'`）** | 无直接断言。仅注释级证据：`_verify-local-media`（「CSP 的 connect-src 是 'self'」）、`_verify-table-width`（「CSP 禁内联脚本/eval」） | 0 | **空缺** | 协议行为被间接测过，但**没有一条断言检查响应头真的带上了 CSP** |
| **导航拦截（`will-navigate` / `setWindowOpenHandler`）** | 无 | 0 | **空缺** | `src/main/index.ts:279/291` 有实现，`tools/` 里没有任何引用 |
| **webPreferences 安全兜底（`sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`）** | 无 | 0 | **空缺** | `src/main/index.ts:211-213`；`_verify-packaging` 不检查 |
| IPC 路径校验 | `tests/paths.test.mjs`(5)、`tests/filesRules.test.mjs`(9)、`_verify-open-file-routing`（`isInside-prefix-boundary`） | 15 | 部分 | 纯函数层强；IPC 入口的校验没有端到端断言 |
| 单实例锁（不抢用户 GPU 缓存） | `_verify-single-instance`（`没有 GPU 磁盘缓存报错` 1 条） | 15 | 强 | — |

### 1.12 性能

| 功能 | 覆盖它的套件或单测 | 断言数 | 覆盖强度 | 备注 |
|---|---|---|---|---|
| 大文档打开 / 切面 / 回灌耗时预算 | `_verify-surface-stress`（12 用例 × `toSource`/`back` 预算断言） | 24 | 强 | 阈值给得宽，但**超预算即 FAIL** |
| 主进程 console 输出必须 ASCII（Windows 代码页安全） | `tests/mainConsoleAscii.test.mjs`(2) | 2 | 强 | 扫描器自证 + 全 `src/main` 扫描 |
| 工程门禁（typecheck / lint / test:unit / build） | `tests/tooling.test.mjs`(5)、`tests/lockfile.test.mjs`(6)、`npm run ci` | 11 | 强 | 不属用户功能，但守住「数字可复跑」 |
| **启动耗时基准** | `_startup-bench.js`（基准脚本，0 断言，需生产包） | 0 | **空缺** | 只输出「首窗可见 / 全部就绪」耗时 |
| **输入延迟基准** | `_measure-latency.js`（探针，0 断言） | 0 | **空缺** | 切模式耗时只打印 |

---

## 2. 覆盖空白清单（按重要性排序）

> 判据：**面向用户的功能，且在任何 `tools/` 脚本或 `tests/` 里都没有自动化断言**（探针脚本只打印观察值，不算）。共 **18 条**。

| # | 空白 | 为什么重要 | 怎么验最省事（现成套件可扩写） |
|---|---|---|---|
| 1 | **导出产物本身（PDF / HTML / Word / EPUB）** | 用户交付物。格式正确性、Mermaid 预渲染、KaTeX 样式内联、中文/编码、本地图片转换，全部无人守。现有 `_verify-export-fix*.js` / `_test-pdf.js` / `_trigger-export.js` 只是「能跑不报错」 | 扩写 `_verify-menu-export-submenu.js`：它已经能从组件实例读到四个二级项的 `runExport('<fmt>')` 接线。把「读接线」升级为「在 `LUMIN_PDF_TEST` 旁路下真调一次 `runExport`，再断言产物字节/文本」（`main/export.ts` 已有 `buildExportHtml` 可注入断言点，`_test-export-full.js` 里的全链路调用可直接搬进来当 fixture） |
| 2 | **自动保存（到磁盘）** | README 把它算作数据层卖点；所有套件却都先 `settings.set('autoSave', false)` 把它关掉。开着时是否真写盘、写盘时机、脏标记是否归零，无人验 | 扩写 `_verify-draft-banner.js`（它已经是「未保存内容 → 落盘 → 重启 → 可恢复」的框架）：把 `autoSave` 保持开启，等一个防抖周期后断言磁盘字节 == 真源内容，并断言 `files.dirty` 归零 |
| 3 | **删除文件 / 删除文件夹（行为）** | 破坏性操作，且是右键菜单第二个入口。现在只有 `file-row-menu-has-delete` 断言「菜单项存在」 | 扩写 `_verify-rename.js`：它已有「右键文件行 → 点菜单项 → 断言磁盘变化」的完整机制（`rename-applied-on-disk`）。复制那条链路成「点删除 → 断言文件没了 / 进了回收站（或按实现断言不进索引）」 |
| 4 | **文件树新建文件 / 新建文件夹（行为）** | 每个新文档的第一步。现在只有「菜单项在」+「Ctrl+N 不建文件」 | 扩写 `_verify-rename.js`（同一套行内输入框机制：`rename-input-appears` / `rename-applied-on-disk` 可直接复用）；或把 `_verify-3tasks.js` 探针里的 `files().newFileAt(dir)` 调用升级成 harness 套件并补断言 |
| 5 | **拖拽文件进窗口打开（`dragover` / `drop`）** | README 明列的功能；`_verify-open-file-routing.js` 只在头注释里说「共用同一实现」并静态核对调用点，真正的拖放事件从未派发 | 扩写 `_verify-open-file-routing.js`：它已经 `import('/src/lib/openFile.ts')` 拿到真实模块。加一步用 CDP `Input.dispatchDragEvent`（或 `DataTransfer` + `dispatchEvent(new DragEvent('drop'))`，`_repro-paste.js` 里已有构造 `DataTransfer` 的写法）真派发一次，再复用现有三条落点断言 |
| 6 | **CSP 响应头 / 导航拦截 / webPreferences 安全兜底** | 这三条是 Electron 应用的安全底线（`src/main/index.ts:211-213, 279, 291, 311`）。全在 `tools/` 里零引用 —— 被误删或被 `sandbox: false` 覆盖也不会红 | 新建一个静态 + 运行时混合套件（成本最低）：① 静态读 `src/main/index.ts` 断言三处同时存在（照 `tests/menu.test.mjs` 的「读源码断言」模式）；② 运行时用 `app.ev('fetch(location.href).then(r=>r.headers.get("content-security-policy"))')` 或 CDP `Network.getResponseBody`/`responseReceivedExtraInfo` 读响应头；③ 派发一次 `location.href='https://example.com'` 断言主窗口 URL 未变 |
| 7 | **窗口位置/大小持久化（`windowState`）** | 每次启动的体验。`_check-windowstate.js` / `_set-windowstate.js` 只是给人手工看 `kv` 的辅助脚本 | 扩写 `_verify-session.js`：它已能 `reload` 走真实启动流程、直读 SQLite `kv`。加「改窗口尺寸 → reload → 断言 `kv.windowState` 与实际 bounds 一致」 |
| 8 | **主题「跟随系统（auto）」** | 曾有真实 bug（切 auto 后内容仍深色，只标题栏更新）。`_verify-theme-auto.js` 只 `console.log`，永远绿 | 扩写 `_verify-segmented-control.js`（已有主题令牌断言）：用 CDP `Emulation.setEmulatedMedia({features:[{name:'prefers-color-scheme',value:'dark'}]})` 切换系统偏好（`_verify-toc-style-scroll.js` 已用过 `setEmulatedMedia` 模拟「减少动态效果」），断言 `html.theme-*` 类与关键背景色真的跟着变 |
| 9 | **状态栏点击切换行尾（CRLF ⇄ LF）** | README 把「状态栏可点切换」当卖点；套件全走设置/元数据链路，这个最常用的入口没验 | 扩写 `_verify-md-fidelity.js`（行尾段已有「切到 LF/CRLF 后落盘」4 条）：把「通过设置切」换成「真实点击状态栏那一格」，其余断言原样复用 |
| 10 | **全局搜索的检索与跳转（FTS5）** | README 明列 `Ctrl+Shift+P` 全局搜索。矩阵内只验「快捷键打开了面板」（1 条） | 扩写 `_verify-keymap.js`（它已经用 `ui().openGlobalSearch()` 驱动面板）：加「输入关键词 → 断言结果行数/命中片段 → 点击结果 → 断言文档被打开或跳到该处」。`verify-tiptap.js` D 段的 `sqlite-search` / `sqlite-content-match` 可以直接搬 |
| 11 | **界面正文（非菜单）文案的三语完整性，尤其 ru-RU** | 三个语言包「键集合一致」有单测，但渲染层实际用到的 key 是否都有值、ru-RU 是否漏译，无人验 | 扩写 `_verify-i18n.js`（现在是探针）：它已能切语言并读 DOM。加「遍历主要界面区域（工具栏/状态栏/设置六页签/右键菜单）断言无裸 key、无空串」，并把 `verify-tiptap.js` 里已验证过的选择器复用过来。**注意 README 说 `_verify-i18n.js` 是 i18n 的唯一套件是错觉** —— 覆盖其实分散在 5 个套件里 |
| 12 | **语法高亮按需加载 / 括号闭合与补全 / 代码块折叠** | README 明列代码块的这四项卖点。只有 `fold-gutter-kept` 1 条碰到折叠（且只断言 gutter 存在） | 扩写 `_verify-mermaid-blur.js`（它已有「语言切到 javascript → CM 建立」的机制）：切到 js/python 后断言 `.cm-content` 里出现 token 类名（高亮已加载）；输入 `(` 断言自动补 `)`。折叠点击断言 `.cm-foldGutter` 行数变化 |
| 13 | **选区气泡菜单（7 个按钮）** | README 明列的编辑核心入口。矩阵内零断言，只有非矩阵的 `verify-tiptap.js` 验了 3 项 | 扩写 `_verify-links.js`（它已有「真实选区 → 工具栏插入链接 → 点击展开源码」的选区机制）：在选区上断言 `.bubble-menu` 出现、7 个按钮齐全，逐个点击断言 markdown 变化。`verify-tiptap.js` D 段的选择器与断言可直接搬 |
| 14 | **`[TOC]` 插入与反向解析** | README 明列功能；现在只有 `_verify-toc.js` / `_verify-toc-load.js` 两个探针（0 断言） | 把两个探针合起来升级成 harness 套件（`_verify-toc-style-scroll.js` 已有 21 条断言可作模板）：插入 `[TOC]` → 断言标题列表与文档标题一致 → 点条目 → 断言光标落到标题 → 断言 markdown 往返仍是 `[TOC]` |
| 15 | **大纲滚动联动高亮** | README 明列「滚动联动高亮」；现在只有「大纲非空」（`_regress-layout` L8） | 扩写 `_regress-layout.js`：它已能读大纲项并验证「源码模式清空」。加「滚动正文到第 3 个标题 → 断言大纲第 3 项带 active 类」 |
| 16 | **导出设置页 + 其余设置页签的导航回归** | `SettingsDialog.vue` 有 6 个页签，但没有一条断言「6 个都在、都能打开、内容非空」 | 扩写 `_verify-keymap.js`（已有 `settings-keymap-tab-renders`）：一次遍历 6 个页签点击并断言各自根节点出现 + 无裸 i18n key。是本节里性价比最高的一条 |
| 17 | **启动耗时 / 输入延迟 / 关窗耗时**（3 个基准） | 已有 3 个基准脚本（`_startup-bench.js`、`_measure-latency.js`、`_time-close.js`），但都只打印、不判定，**性能回归不会红** | 给三者各加一条阈值断言（`report.check('启动首窗可见 ≤ Xms', ms <= X)`）；`_startup-bench` 需要生产包，可只在 `--all` 或人工跑，但断言必须写进脚本 |
| 18 | **toast 位置与不遮挡底栏 / About 页内容** | 位置这一半**已补齐**：`_verify-toast-tip.js` 现在 21 条断言（编辑区上方整幅带、整条在视口内、不压状态栏、组件无盒子、真实进出场动效采样含带高动画），`_verify-notify-style.js` 22 条覆盖形态、版式、空态不占位与就地滚动。剩 About 页内容只验路由可达 | About 在 `_verify-welcome-removed.js` 的 `about-still-works` 后面加两条内容断言 |

---

## 3. 套件健康度

### 3.1 三类清单

**A. 在默认矩阵里（`run-suites.js` `DEFAULT_SUITES`，33 条）** —— 不需要 dev server，逐个起全新隔离实例：

`_verify-session-last-closed`（自管实例）、`_verify-md-fidelity`、`_verify-draft-banner`、`_verify-new-document`、`_verify-session`、`_verify-single-instance`（自管实例）、`_verify-local-media`、`_verify-encoding`、`_verify-wave3`、`_regress-layout`、`_regress-split-live`、`_regress-cb`、`_regress-divider`、`_regress-fileswitch`、`_regress-source-roundtrip`、`_repro-rapidenter`、`_verify-find-replace`、`_verify-inline-formats`、`_verify-math`、`_verify-remote-image`、`_verify-a11y`、`_verify-editor-menu`、`_verify-i18n`、`_verify-surfaces`、`_verify-surface-fuzz`、`_verify-surface-stress`、`_verify-toc`、`_verify-notifications`、`_verify-toolbar-settings`、`_verify-cb-languages`、`_verify-cb-virtualization`、`_verify-mermaid-gate`、`_verify-neutral-accent`。

> **本轮（清单 §2.I / §2.F）从 `--all` 提上来的 7 条**：`_verify-toc`（由两条 0 断言探针合并升级）、
> `_verify-notifications`(32)、`_verify-toolbar-settings`(37)、`_verify-cb-languages`(5)、
> `_verify-cb-virtualization`(9，F 项新增)、`_verify-mermaid-gate`(4)、`_verify-neutral-accent`(10)。
> 实测整轮 **33/33 PASS**（另有 4 条断言按环境如实 SKIP —— SKIP 不算失败，见下）。

**B. 只在 `--all` 里（42 个 `_verify-*` + 1 个 `MANUAL`）** —— 其中 **4 个必须 dev server**（`import('/src/…')`），`--all` 下才会真跑，否则标 SKIP：

`_verify-keymap`、`_verify-open-file-dedup`、`_verify-open-file-routing`、`_verify-save-as-workspace`。

其余 42 个「有真断言但没进默认矩阵」（完整清单以 `node tools/run-suites.js --all` 为准）：

`_verify-alt-menu`、`_verify-bars-no-filename`、`_verify-blockquote-style`、`_verify-cb-button-line-numbers`、`_verify-cb-line-numbers`、`_verify-cb-no-active-line`、`_verify-drag-selection`、`_verify-editor-menu-extras`、`_verify-filelist-view`、`_verify-link-open`、`_verify-link-paste`、`_verify-links`、`_verify-marker-hold`、`_verify-menu-export-submenu`、`_verify-mermaid-blur`、`_verify-mermaid-cross-block`、`_verify-new-window-clean`、`_verify-notify-disk`、`_verify-notify-multiwindow`、`_verify-notify-style`、`_verify-packaging`、`_verify-rename`、`_verify-rename-fix`、`_verify-round-24`、`_verify-round-perf`、`_verify-segmented-control`、`_verify-sidebar-handle`、`_verify-sidebar-handle-style`、`_verify-sidebar-tree-style`、`_verify-table-width`、`_verify-taskbar-jumplist`、`_verify-theme-auto`、`_verify-toast-tip`、`_verify-toc-style-scroll`、`_verify-tooltip`、`_verify-welcome-removed`、`_verify-window-title` 等。

另外 `_verify-notify-restart` 是**两阶段**套件（`seed` → 外部硬杀重启 → `check`），由
`run-suites.js` 的 `MANUAL` 集排除：不带参数跑只会打印用法并退出 1，进矩阵就是每轮一个假红。

> ✅ **0 断言探针已清空**（曾经的问题：`--all` 里混着一批只打印、不断言的脚本，被记成 `PASS 0/0`）。
> 现在 `run-suites.js` 把「零断言」记成 **NOASSERT 并让整轮失败**（H1 的落地），且这批脚本已按
> §2.I 处理完：`_verify-3tasks` / `_verify-backspace-enter-cb` / `_verify-bs-md` /
> `_verify-cb-delete-fix` / `_verify-cb-typing{,,2,3}` **删除**（其功能已由 `_verify-editor-menu`、
> `_verify-notifications`、`_verify-new-document`、`_verify-rename`、`_regress-cb`、
> `_verify-inline-formats` 接管）；`_verify-toc` + `_verify-toc-load` **升级并合并**成一条
> 7 断言的 harness 套件（TOC 在本仓库没有别的覆盖）。实测默认矩阵 `NOASSERT 0`。

**C. 一次性探针 / 基准 / 截图 / 辅助类（0 断言，不该当套件）**：
`_check-cm-drag`、`_check-heading-rule`、`_check-new-window`、`_check-table-edit`、`_check-windowstate`（读 kv）、`_set-windowstate`（写 kv）、`_exp-hidden`、`_exp-ta-hidden`、`_measure-latency`、`_shot-heading-badge`（截图）、`_btn-check`、`_time-close`、`_startup-bench`、`_trigger-export`、`_test-export-full`、`_test-mermaid`、`_test-pdf`、`_repro-backspace-after-cb`、`_repro-cb-delete`、`_repro-cb-delete2`、`_repro-heading-cm`、`_repro-heading-cm2`、`_repro-paste`、`_repro-sourcemode`、`_repro-split`。

### 3.2 建议纳入矩阵（按性价比排序）

| 建议 | 理由 |
|---|---|
| ✅ `_verify-notifications.js`(32)、`_verify-toolbar-settings.js`(37)、`_verify-toc.js`(7)、`_verify-cb-languages.js`(4)、`_verify-mermaid-gate.js`(4)、`_verify-neutral-accent.js`(10) | **本轮已纳入默认矩阵**（§2.I），整轮 32/32 |
| `_verify-window-title.js`(14) | 每窗口体验的基础项；无需 dev server（仍未纳入） |
| `_verify-menu-export-submenu.js`(15) | 导出唯一入口；无需 dev server（仍未纳入） |
| `_verify-taskbar-jumplist.js`(39) / `_verify-packaging.js`(30) | 系统集成；但两者都会起额外进程/构建，建议放「显式点名」档（`--suite=`）而不是默认 |
| `_verify-rename.js`(13) + `_verify-rename-fix.js`(9) | 数据破坏面，且 `_verify-rename-fix` 守的是用户真实踩过的 UNIQUE 冲突 |
| `_verify-links.js`(12) + `_verify-link-paste.js`(3) | 编辑核心；无需 dev server |
| `_verify-table-width.js`(14)、`_verify-filelist-view.js`(13)、`_verify-tooltip.js`(6) | 无需 dev server 的纯 UI 回归，跑得便宜 |
| `verify-tiptap.js` | **治本方案**：把它拆进 harness + Reporter，删掉硬编码的 `D:/code_workspace/Lumin-test-workspace` 与 `C:/Users/yangbaibai/Desktop/新建文件夹`，让 114 项断言能进矩阵。它是气泡菜单/input rules/标记符/表格编辑/全局搜索唯一的自动化资产 |

### 3.3 「非矩阵大资产」专项：`tools/verify-tiptap.js`

- 体量：1473 行、**114 项具名断言**、10 个分组（A 打开渲染 / B input rules+标记符 / C 代码块 / D 表格+气泡菜单+HTML+主题+全局搜索 / E 分割线+标题退格+设置持久化 / F 表格插入+真实键入 / G 边界打字不丢粗体 / H Ctrl+左键 / I 链接交互 / J 标记内回车合并）。
- 拉它进来的三个障碍：
  1. **硬编码机器路径**：`tests/` 之外的 `D:/code_workspace/Lumin-test-workspace` 与 `USER_WS = 'C:/Users/yangbaibai/Desktop/新建文件夹'`（后者分明是某次调试留下的答案）；
  2. **必须 dev server**（写死 `5173` 与 `9222`），而 `run-suites.js` 的默认矩阵刻意排除这类；
  3. **不用 harness + Reporter**：自己的 `results`/`logErrors` 汇总，`run-suites.js` 解析不了它的输出（不认识 `--- N/M PASS`）。
- 结论：**它守的功能（气泡菜单、input rules、标记符显隐、表格编辑、全局搜索）在矩阵里等于没守**。这是本次审计最重要的单项发现。

### 3.4 其它健康度问题

| 问题 | 证据 | 影响 |
|---|---|---|
| 假绿：0 断言探针混进 `--all` 并计为 PASS | 见 §3.1 的 ✅ | **已修**：`run-suites.js` 把零断言记 `NOASSERT` 并让整轮失败；那批探针已删/升级（见 §3.5） |
| SKIP 被当成 FAIL | `--- N/M PASS` 的 M 含 SKIP，老写法 `fail = M - N` 把如实 SKIP 的断言判红（实测 `_verify-md-fidelity` 101/102、`_verify-round-24` 15/16、`_verify-theme-auto` 每轮报红） | **已修**（清单 §1.C.1）：优先认 `TOTAL … FAIL … SKIP …`，退路用 SKIP 行数扣减；状态只看退出码 + FAIL 行 |
| 断言重叠/双份真相 | `_verify-sidebar-handle.js`(19) 与 `_verify-sidebar-handle-style.js`(19) 覆盖同一把手（阈值/迟滞/外观各写一遍）；`_verify-cb-line-numbers.js`(13) 与 `_verify-cb-button-line-numbers.js`(26) 都验「行号开关 → gutter 变化 → 落库」 | 维护成本翻倍，改样式要同时改两处 |
| 老套件各抄一份 CDP 骨架 | `_check-*`/`_exp-*`/`_repro-*`/`_verify-3tasks` 等 ~25 个文件里都有各自的 `const CDP = 'http://127.0.0.1:9222/json'` + `attach` + 按 `Symbol(pinia)` 取 store（生产构建下 symbol 描述会被压掉 → 只在 dev 页面能跑） | 与 `lib/harness.js` 头注释里写明的踩坑一模一样，属于「新套件已收口、老套件仍在漂移」 |
| 自管实例的套件排在最前是硬约定 | `run-suites.js` 注释：「自管实例的套件必须排在最前面」 | 往 `DEFAULT_SUITES` 前面插新套件会静默打乱（`_verify-session-last-closed` / `_verify-single-instance` 需要 9222 空闲） |
| `--all` 只收 `_verify-*` | `allSuites()` 用 `/^_verify-.*\.js$/` 过滤 | `_regress-*` / `_repro-*` **永远不会**被 `--all` 带上，只有默认矩阵里那 7 个在跑；其余 `_repro-*`（9 个探针）算「已知只手工跑」 |
| 命名与语义漂移 | `_verify-session.js` 的 `toggle-off-shows-welcome` 实际断言的是「落在编辑器」（欢迎页已删） | 断言名误导后来人 |
| README 与事实不一致 | README「查找替换 ❌ 功能待接入」，但 `_verify-find-replace.js`(12) + `tests/findReplace.test.mjs`(11) 已完整覆盖；README「EOL 多窗口一致性还没做」，但 `_verify-md-fidelity` 已有 3 条多窗口断言 | 审计/排期会基于错误前提 |
| 探针里有硬编码绝对路径 | `_verify-3tasks.js`（`D:\code_workspace\Lumin-test-workspace`）、`verify-tiptap.js`（两个）、`_check-windowstate.js` 等 | 换机器即废；也说明它们**从未打算进矩阵** |

### 3.5 建议归档（从 `tools/` 挪到 `tools/_archive/` 或直接删）

| 归档对象 | 理由 |
|---|---|
| `_repro-backspace-after-cb`、`_repro-cb-delete`、`_repro-cb-delete2`、`_repro-heading-cm`、`_repro-heading-cm2`、`_repro-paste`、`_repro-sourcemode`、`_repro-split` | 对应的修复都已被 harness 套件接管：退格/删块 → `_regress-cb`；抢焦点 → `_verify-mermaid-cross-block`/`_regress-layout`；源码/分屏 → `_regress-layout`/`_regress-split-live`/`_regress-source-roundtrip`；粘贴 → `_verify-link-paste` |
| `_exp-hidden`、`_exp-ta-hidden` | 纯实验脚本（0 断言、无输出约定） |
| `_btn-check` | 在 DOM 里按按钮中文文字找 `.mode-seg-btn` —— `lib/harness.js` 的 `clickMode()` 注释明确说这是「换语言就整轮发红」的写法，已被替代 |
| `_check-new-window`、`_check-windowstate`、`_set-windowstate`、`_time-close`、`_shot-heading-badge`、`_measure-latency`、`_startup-bench` | 手工调试/基准/截图工具。基准值有历史价值 → 保留但**移出 `tools/_*.js` 命名空间**（例如 `tools/bench/`），避免被 `--all` 或目录扫描当成套件 |
| `_verify-cb-typing`、`_verify-cb-typing2`、`_verify-cb-typing3` | 三代同题探针（代码块打字/回车），已被 `_regress-cb`(3) + `_repro-rapidenter`(2) 取代 |
| `_verify-export-fix`、`_verify-export-fix2`、`_test-export-full`、`_test-pdf`、`_test-mermaid`、`_trigger-export` | 「曾经修过一个导出 bug」的一次性复现脚本。⚠️ 归档前先按 §2 第 1 条把导出产物断言补上，否则导出这条线**彻底归零** |
| `_verify-3tasks`、`_verify-alt-menu`、`_verify-bs-md`、`_verify-cb-delete-fix`、`_verify-toc`、`_verify-toc-load`、`_verify-i18n`、`_verify-theme-auto`、`_verify-toast-tip` | 0 断言探针。**但 `_verify-toc`/`_verify-toc-load`/`_verify-i18n`/`_verify-theme-auto` 承载的功能在别处没有覆盖** —— 先按 §2 第 8/11/14 条升级成 harness 套件，再归档原始探针 |

### 3.6 `--all` 全量复核结果（2026-09，68 条：56 PASS / 10 FAIL / 1 SKIP / 1 NOASSERT）

> 做法：`node tools/run-suites.js --all`。下面每条都写清**是不是本轮（清单 A–J）造成的**，
> 以及证据。✅ = 本轮已修。

| 套件 | 结果 | 判定与证据 |
| --- | --- | --- |
| ✅ `_verify-welcome-removed` | 31/34 → **34/34** | **本轮 E 造成的**（工具栏默认收起后 `toolbar.found === false`，而该段断言要求工具栏存在）+ 它自己把环境跳过写成 `FAIL … \| SKIP: …`（§1.C 同类）。已补「显式打开工具栏」夹具 + 改走 skip 通道 |
| `_verify-cb-line-numbers` | 8/13 | **既有**（设置面板开关的真实点击不生效）。三轮对照复现：把工具栏默认值改回 `true`、把 B 项改动 stash 掉，它照样红 ⇒ 与本轮改动无关 |
| ✅ `_verify-sidebar-handle` | 3/21 → **21/21** | **既有（选择器过期 + 三处常量与现设计脱节）**：它找 `button.absolute.left-0`，而把手早已换成 `App.vue` 的 `.sidebar-handle`；热区常量 31/33 是旧版 32px 热区的数（实现已是 120/200）、把手尺寸 18×48 → 22×56、「收起只露 4px」→ 现设计整体退到窗口外。本轮一并修正（同题 `-style` 套件 19/19） |
| `_verify-open-file-dedup` / `_verify-open-file-routing` / `_verify-save-as-workspace` | 0/0 FAIL | **既有（运行器的 dev-server 探测漏判）**：三者间接 `import('/src/…')`，`needsDevServer()` 的静态正则没识别出来，于是跑在构建产物上并报 `Failed to fetch dynamically imported module: file:///D:/src/…`（按本文件 §3.1 的口径它们**本该被标 SKIP**） |
| `_verify-packaging` | 2/4 | **既有（环境）**：`electron-builder` 在本环境跑不起来（离线/权限，与 `npm install` 的 `EALLOWREMOTE` 同一类限制），不是代码回归 |
| `_verify-menu-export-submenu` | 12/15 | **待查**：`WIRING` 探针靠 `__vueParentComponent` 从菜单按钮往上找 `GROUPS`（`setupState.GROUPS`），拿不到时 3 条接线断言全空。该套件不在默认矩阵，本轮未动它相关代码 |
| `_verify-editor-menu-extras` | 5/7 | **待查**：`file-tree-menu-still-works` / `usage-row-on-disk`（文件树右键菜单 + 落库），很可能需要工作区夹具；本轮未动文件树 |
| `_verify-rename-fix` | 0/0 **NOASSERT** | **待修/待删**：运行期一条断言都没产出（我的静态扫描没抓出来，因为文件里确实有 Reporter）。要么补断言，要么按 §2.I 的口径删掉 |
| `_verify-keymap` | SKIP | **正确跳过**：需要 dev server（`import('/src/…')`），`--all` 下如实标 SKIP |
| `_check-cm-drag`、`_check-heading-rule`、`_check-table-edit` | 「确认是环境抖动而非真实回归」的最小复测脚本，环境（Chromium 节流/焦点）问题已由 harness 的 `transitionTo()` 式轮询解决 |

- ✅ **已完成（清单 §2.I，2026-09 收口）**：
  * 0 断言脚本：`_verify-3tasks`、`_verify-backspace-enter-cb`、`_verify-bs-md`、`_verify-cb-delete-fix`、`_verify-cb-typing{,,2,3}` **已删除**（功能由 `_verify-editor-menu` / `_verify-notifications` / `_verify-new-document` / `_verify-rename` / `_regress-cb` / `_verify-inline-formats` 接管）；
    `_verify-toc` + `_verify-toc-load` **升级并合并**成一条 7 断言的 harness 套件并纳入默认矩阵。
  * 一次性探针：14 个 `_probe-*` 逐条核对，删掉 8 个（`_probe-cjk-flank` / `_probe-fixture` / `_probe-four` / `_probe-paste` / `_probe-taskA` / `_probe-taskB` / `_probe-fences-hot{,2}`），
    保留 6 个**常驻测量工具**（`_probe-startup` / `_probe-perf` / `_probe-fences-total` / `_probe-modeswitch` / `_probe-cpu-top` / `_probe-md-baseline`）并在 `tools/README.md` 里列成表。
- 仍未归档（保留建议）：`_repro-*` 里的一次性复现、`_check-*`/`_exp-*` 手工调试脚本、导出/打包类一次性脚本 —— 见下表。

---

## 4. 一句话结论

- **断言总量不缺**（工具脚本里 949 条具名断言、单测 176 个 `test()`），**缺的是分布**：
  最厚的资产（`verify-tiptap.js` 114 条、编辑器菜单 51 条、通知 31 条）里有一半不在默认矩阵；
  而用户最在意的交付面（**导出产物、自动保存、删除/新建文件、拖放打开、安全三件套**）**一条断言都没有**。
- 优先做三件事：① 把 `verify-tiptap.js` 拆进 harness；② 给 `run-suites.js` 加 **PROBE 判定**（`total === 0` 不许计 PASS）；③ 按 §2 的 18 条空白逐条补，前 8 条性价比最高。
