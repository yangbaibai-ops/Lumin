'use strict'
// ─── CDP 套件统一入口 ─────────────────────────────────────────────────────────
//
// 为什么需要它：tools/ 下有 50+ 个 `_verify-*.js`，此前**没有统一跑法** ——
// 每个都要人工先起隔离实例、记住哪些套件会互相污染（设置/kv/最近文档/草稿），
// 结果就是「上一轮跑过的数字」没人能复现。这个脚本把三件事固定下来：
//
//   1. **每个套件起一个全新隔离实例**（`start-isolated.ps1`，user-data-dir 在临时目录）：
//      套件会改设置、写草稿、动 kv，串着跑必然互相污染（实测同一套件两次结果不同）；
//   2. 解析套件末行的 `--- N/M PASS`，汇总成一张矩阵；有 FAIL 就非零退出；
//   3. 慢/需要 dev server 的套件**默认不跑**（`import('/src/...')` 的那批必须有
//      5173 上的 dev server），用 `--all` 或 `--suite=` 显式点名。
//
// 用法：
//   node tools/run-suites.js                     # 跑「快速、无 dev server 依赖」的一组
//   node tools/run-suites.js --suite=_verify-session.js,_verify-md-fidelity.js
//   node tools/run-suites.js --all --port=9223   # 全量（需要 dev server，失败会标 SKIP）
//   node tools/run-suites.js --keep              # 跑完不关实例（调试用）
//   node tools/run-suites.js --retry=0           # 关掉失败重跑（默认 1 次，见下面的 FLAKY）
//
// 判定档位：PASS / **FLAKY**（首次红、重跑绿：环境敏感，不判失败但会单独列出）/
//           FAIL（重跑仍红 = 真回归）/ SKIP（环境不支持，如实跳过）/
//           NOASSERT（一条断言都没产出 = 没测）。
// 约定：套件只允许连 `--remote-debugging-port` 暴露的页面，绝不 kill 进程；
//       实例由本脚本管理，绝不碰用户自己的 `%APPDATA%\lumin`。
//
// ⚠️ **跑之前先 `npm run build`，跑的过程中不要再 build**：实例加载的是 `out/`，
//    边跑边构建会把正在运行的实例指向半截产物 —— 表现是随机的两三条断言失败
//    （实测踩过：编码套件的「设置已落库」与「菜单标题跟随语言」同时红，看着像代码坏了）。

const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TOOLS = __dirname

/**
 * 「确实没有断言可产出」的套件白名单（**必须写理由**）。
 *
 * 背景（自查报告 H1）：判定只看退出码时，一个没产出断言的套件会显示 `0/0 PASS`，
 * 与「全部通过」只差一个数字。现在零断言一律记 NOASSERT 并让命令失败；
 * 如果某个套件天生无事可断言（例如它只做一次性清理），把它加到这里并写明原因。
 */
const EMPTY_OK = new Set([
  // 目前为空：所有已知的 0 断言套件都是**该修或该删**的（见 NOASSERT 汇总行）。
])

/** 默认跑的套件：不 import /src/...、单实例可跑完、覆盖核心回归面 */
const DEFAULT_SUITES = [
  // ⚠️ 自管实例的套件必须排在**最前面**：它们自己起/杀 Electron（3 轮），
  //    需要 9222 空闲，所以运行器不能先给它起一个实例。
  '_verify-session-last-closed.js',
  // 关窗「是否保存更改？」的三条出路（保存 / 不保存 / 取消）+ 自动保存开着时不弹框：
  // 同样是自管实例（关窗会把窗口真的关掉，一个实例验不完四条出路），也占 9222
  '_verify-close-save-prompt.js',
  // 备份验收也要自管实例：它靠 `LUMIN_EXPORT_DIR`（仅开发态的"另存为"旁路，
  // 见 src/main/testPaths.ts）跳过原生对话框，而环境变量必须在**实例启动前**给到。
  // 它用 9234，所以不占运行器的 9222。
  '_verify-backup.js',
  // 草稿 GC 验的是**启动路径**对已有文件的处理：夹具必须在实例起来之前躺在
  // `--user-data-dir` 里，所以不能用运行器那个"先删数据目录再起"的实例。端口 9235。
  '_verify-draft-gc.js',
  '_verify-md-fidelity.js', // Markdown 往返保真（Wave 1）
  '_verify-draft-banner.js', // 草稿横幅（未命名缓冲区的归属）
  // 顶部提示条（未保存 / 比磁盘新 / 关窗保存 三条路径共用的一套呈现）+ 通知内部布局：
  // 无模糊/无遮罩、贴顶、焦点在提示内、Tab 被限制在提示内、提示外点击不动正文光标（真鼠标）、
  // 通知在三语与 200 字符长文件名下不溢出、按钮不压在正文上、A 窗口的提示不影响 B 窗口
  '_verify-prompt-top-and-notify-layout.js',
  '_verify-new-document.js', // 新建 / Ctrl+N / Ctrl+S 落点
  '_verify-session.js', // 会话恢复
  '_verify-single-instance.js', // 单实例锁：第二个实例立刻干净退出（自管实例 + 独立调试端口）
  '_verify-local-media.js', // lumin-file:// 白名单 + 本地图片
  '_verify-encoding.js', // 编码判定与写回
  '_verify-wave3.js', // 编辑器⇄store 单向数据流账本 / 文件树键盘可达 / 原生菜单三语
  // 编辑器布局与代码块的核心回归（本轮从「自己连 CDP 的一次性脚本」迁到 harness + Reporter）
  '_regress-layout.js', // 常驻布局：代码块可聚焦可输入 / 跨面位置保持 / 源码回灌 / 大纲联动
  '_regress-split-live.js', // 分屏双向实时同步（同一账本的端到端回归）
  '_regress-cb.js', // 代码块打字 / 回车 / 空块退格删除 / 段落退格入块尾
  '_regress-divider.js', // 分屏分隔条拖拽改比例 + 双击复位 + 比例持久化
  '_regress-fileswitch.js', // 切文件（:key 重建）与「源码模式下切文件」
  '_regress-source-roundtrip.js', // 源码模式往返后的代码块可用性
  '_repro-rapidenter.js', // 快速连续回车不丢行（CM / PM / store 三处一致）
  '_verify-find-replace.js', // 编辑器内查找替换（两个编辑面 / 替换与全部替换 / 大小写）
  '_verify-inline-formats.js', // 行内格式矩阵：工具栏/快捷键/手打标记/组合（标记字符一个不能少）
  '_verify-input-rules.js', // Markdown 输入规则：`# `/`- `/`1. `/`> `/围栏/任务列表/链接（原 verify-tiptap 的独有覆盖）
  '_verify-math.js', // 数学公式（行内 `$…$` / 块级 `$$…$$`）：KaTeX 渲染 + 原文逐字保留
  // ── 第二十九轮：公式的**点击编辑**（用户口径「点击公式 → 上方展示可编辑源码 + 实时渲染」）──
  // 六条：渲染+保真 / 点击出上方源码框（矩形比较，不写死坐标）/ 逐键实时渲染（DOM 与序列化同步）/
  // 坏公式的错误态与不抛异常 / 尺寸与溢出（行内字号比例、块级居中、超宽不横向溢出）/
  // 不许破坏的对照（代码块里的 `$`、`\$` 转义、`**` 显隐）。锚点全是 data-*，不用坐标。
  '_verify-math-edit.js',
  // 两面一致性（实时渲染 ⇄ 源码）三层：见 docs/wysiwyg-test-plan.md
  // ── 自查报告整改时接入的四条（原来是「0 断言假通过」或新功能）──
  '_verify-remote-image.js', // 远程图片隐私闸门：不自动加载 / 点击加载 / 导出仍给真实 src
  '_verify-a11y.js', // 无障碍基线：icon-only 按钮必须有可访问名 + 状态属性一致
  '_verify-editor-menu.js', // 编辑器右键菜单（两级结构、分类悬停、动作齐全）
  '_verify-i18n.js', // 切换语言后顶部菜单文字随之变化（三语）
  '_verify-surfaces.js', // L2 双面端到端矩阵：切面无副作用 / 位置语义 / 状态语义 / 渲染结构
  '_verify-surface-fuzz.js', // L3 生成式语料往返（可复现种子 + 失败最小化）
  '_verify-surface-stress.js', // L4 极端/边界/压力（含 1MB 与 2000 代码块的耗时基线）
  // ── 清单 §2.I 收口时「从 --all 提进默认矩阵」的一批（有价值且单实例可跑完）──
  '_verify-toc.js', // 目录 [TOC]：插入 / 渲染 / 点击跳转 / 往返 / 重载还原（原两条 0 断言探针合并升级）
  '_verify-notifications.js', // 通知中心整体（CRUD / 顶部通知带 / 步进 / 多语言 / 重载存活 / 兼容层）
  '_verify-toolbar-settings.js', // 快捷工具栏：空白区右键菜单 + 显隐与排序设置
  // 开发者工具的入口与「取消 F12」：工具栏那项真的开得起来 + 按 F12 不再出现 devtools 目标
  '_verify-devtools.js',
  // CSP 的两半分发：meta 里无效的指令（frame-ancestors）必须由**响应头**下发 ——
  // 真窗口里读响应头（CDP Network 域）+ 读 DOM 里那份 meta + 读渲染层 console 的转发
  '_verify-csp.js',
  // 帮助 →「意见或 bug 反馈」：渠道清单来自 shared/feedback.ts（模板无 URL）+ 外链白名单
  // （负例必须被拒）+ 焦点回编辑面。**自管实例**（端口 9236，带 LUMIN_OPEN_EXTERNAL_DRY_RUN=1）
  '_verify-feedback.js',
  // Ctrl+P → **应用内打印预览**（PDF 与导出同一段流水）+ 预览里点打印走打印通路 + 关掉清临时文件。
  // **自管实例**（端口 9237，带 LUMIN_PRINT_DRY_RUN=1 与 LUMIN_EXPORT_DIR）
  '_verify-print-preview.js',
  '_verify-settings-layout.js', // 设置页在 940×600 / 125% 缩放下的横向布局（导航跟窗口走 + 主题卡 3 列）
  '_verify-zorder.js', // 浮层叠放顺序：--z-* 令牌真的到 DOM + 实测顺序（70 < 120 < 140 < 150…）
  '_verify-visual-scale.js', // 视觉尺度：字号令牌生效 + 计算字号/圆角都落在文档化档位里
  '_verify-cb-languages.js', // 代码块语言高亮矩阵（15 种 + 别名，清单外退化为纯文本）
  '_verify-cb-virtualization.js', // 代码块 CM 虚拟化：按需挂载 / 高度稳定 / 选区保护 / churn 后可打字
  '_verify-table-fidelity.js', // 表格保真：单元格回车不再退化成 HTML / 空段丢弃 / 多段用 <br> / 幂等
  '_verify-outline-right.js', // 三栏模式：大纲放右侧（左栏只剩文件树 / 右侧可折叠展开 / 关掉即还原）
  '_verify-outline-nav.js', // 目录高亮：点最后一条 / 滚到底点亮最后一节 / 高亮锁不永久
  '_verify-bars-no-filename.js', // 顶栏与状态栏：不再出现文件名；保存那格只说状态、不带圆点、同灰；列表入场动画已取消
  '_verify-mermaid-gate.js', // mermaid 视口门 + 首屏不预加载（清单 §2.G）
  '_verify-neutral-accent.js', // 副色必须是低饱和灰（通道极差断言）
  // ── 第九轮提进默认矩阵（纯合成事件：不依赖窗口出帧，适合批量跑）──
  '_verify-sidebar-search.js', // Ctrl+F 的去向：焦点在文件面板里搜文件名，否则搜正文（含两个边界）
  '_verify-rename.js', // 文件树就地重命名 + 新建文件（内容区切过去 / 无边框输入框 / 脏了先问）
  '_verify-sidebar-refresh.js', // 头部「刷新」只在列表视图下出现，且真的能刷新列表元数据
  // 本轮：侧栏头部整行去掉（文件夹成为目录树顶层节点）+ 大纲位置的工具栏/视图菜单入口
  // + 底部工具带的悬停动效（含"刷新"从头部搬到这条工具带）
  '_verify-sidebar-root-and-outline-side.js',
  // ── 第十轮：数据安全（保存期输入 / 草稿最大等待 / 换文档前 flush / 真实 mtime）──
  '_verify-save-safety.js',
  // ── 关窗兜底：慢落盘不再被 2.5 秒强杀（心跳延长；会话结束走同一条 before-close）──
  '_verify-close-guard.js',
  // ── 载入历史某一版：脏了先问 + 载入后立刻有草稿、并排上保存 ──
  '_verify-history-restore.js',
  // ── 文件生命周期：目录改名/删除后的路径一致性（索引 / 历史 / 最近列表 / 不许 mkdir 复活）──
  '_verify-file-lifecycle.js',
  // ── 外部改动检测：保存时不许静默覆盖别的程序写进去的版本（覆盖 / 另存为 / 重载）──
  '_verify-external-change.js',
  // ── 「在新窗口打开」去重：同一个文件不许开在两个窗口里各自保存 ──
  '_verify-open-in-new-window.js',
  // ── 第十一轮：路径授权闸（工作区外拒绝读写，正常流程全部放行）──
  '_verify-path-grants.js',
  // ── 第十二轮：关于页说的是事实（真实依赖清单 + 第三方许可声明，不硬编码）──
  '_verify-about.js',
  // ── 第十三轮：插入图片（粘贴 / 拖入 / 选文件三条入口共用一份落点与命名规则）──
  '_verify-image-insert.js',
  // ── 第十四轮：诊断信息（环境事实 + 隐私边界：不含文档内容与最近文件清单）──
  '_verify-diagnostics.js',
  // ── 第十五轮：文档标签（状态栏编辑 → SQLite → 列表展示与按标签过滤）──
  '_verify-tags.js',
  // ── 第十六轮：全局搜索索引（从未打开过的文档也能搜到）+ 命中定位 ──
  '_verify-search-index.js',
  // ── 第十七轮：导出质量（EPUB 拆章带图 / PDF 页码页眉 / 原子写）──
  '_verify-export-quality.js',
  // ── 第十八轮：数据库维护（完整性检查 / 重建索引 / 压缩）──
  '_verify-db-maintenance.js',
  // ── 多光标（报告 §P2 功能缺口：代码块支持，源码 textarea 与所见即所得不支持）──
  '_verify-multicursor.js',
  // ── 第十九轮：命令面板（Ctrl+Shift+P：打开 / 过滤 / ↑↓ / Enter / Esc / a11y / 三语 / 点击）──
  '_verify-command-palette.js',
  // ── 第二十轮：插入链接的弹窗（有选区只要链接 / 无选区要锚文字+链接 / 编辑既有链接预填）──
  // 语义锚点全是 data-link-*（不写死坐标）；纯合成事件（没有真实按键/指针）
  '_verify-link-dialog.js',
  // ── 快捷键「改绑」的显示 / 生效两条链（用户实测：改绑后显示与实际都还是默认键）──
  // 三条独立根因各钉一条：设置界面 computed 的依赖、命令表之外的硬编码键位监听（审计 D10）、
  // 同一默认键被两条命令占用（改绑一条后旧键被另一条接管）。它**不动态取源码模块**（不碰
  // dev server），所以能进 fast 档（老的 `_verify-keymap.js` 因为要 dev server 一直是
  // needs-dev、默认不跑）。
  '_verify-keymap-custom.js',
  // ── 代码块的撤销栈（本轮用户报障：选中文字 → 代码块 → Ctrl+Z 没反应）──
  // 口径：选中文字→代码块 = 一步可撤销；**焦点在代码块内时**一次 Ctrl+Z 也能撤掉
  // （原先被块内 CodeMirror 的空历史吃掉）；块内打字先撤块内编辑、再撤「创建代码块」；
  // Ctrl+Y / Ctrl+Shift+Z 重做；块内容被撤空不再抛 Empty text nodes。
  '_verify-undo-codeblock.js',
  // ── 拖放两条（用户报障：① 拖文件/文件夹进窗口不打开了；② 拖动选中的文字会改位置）──
  // ① 用 **CDP `Input.dispatchDragEvent`**（`DragData.files` = 真实磁盘路径，OS 级拖放模拟）
  //    真派发：文件 → 打开（无工作区在本窗口、并切侧栏）、文件夹 → 设成工作区根、
  //    非 Markdown → 明确拒绝、拖到**侧栏**也认、拖图片仍生成附件且不再双弹。
  //    回归成因：`@drop.prevent`（Vue 的 .prevent 先 preventDefault）与 `e.defaultPrevented`
  //    这个恒真判据把整条链静默关掉了（d014773 引入，本轮修）。
  '_verify-drop-open.js',
  // ② 真实鼠标手势划出 `DE` 再拖到 `A|B` 之间：文档必须逐字不变、选区原样保留；
  //    末尾还守"从系统拖入文件仍然打开"（两条改动不许互相打架）。
  '_verify-no-text-drag.js',
  // ── 文本文档（第七轮：除 .md 外还要能打开 .txt 等纯文本）──
  // 拖入 .txt 真的打开 / 文件树看得见六种文本类型 / 四种新类型逐个能开 / .md 仍旧走渲染面 /
  // 保存后扩展名不变（不许多出 .md）/ GBK 的 .txt 也能识别编码 /
  // 对话框 filters、拖入白名单、另存为后缀都派生自唯一真相源 src/shared/textFiles.ts
  // （原生对话框在 CDP 里点不动：那两条是静态 + 单测级证据，套件里如实标注）。
  '_verify-text-open.js',
  // ── 表格三条 UI/交互优化（本轮）──
  // ① 跨格拖选：真因**不是选区逻辑**（`tableEditing()` 早就在，跨格拖动实测已经产生
  //    `CellSelection` 且能对这一片删内容/改对齐），缺的是 `.selectedCell` 的样式 ——
  //    改前选中格与普通格的计算底色逐字节相同，用户"看不见自己选中了"。套件分三层判：
  //    选区语义 / `.selectedCell` 计数 / **伪元素真的有不透明底色**；另加"单格内拖选仍是文字选择"。
  // ② 表格快捷操作条：光标进表格才出现（多表格时只有一张）、不遮首行、Tab 可达、Esc 退出；
  //    列对齐/插入行列/删除表格一律以**序列化 Markdown** 为准；「列宽」是视图层三档，钉住文档不变。
  // ③ 大纲去圆点：条目行内只剩文本子元素、伪元素 content 为 none，且缩进仍随层级递增。
  // 4x 是"不许破坏"的对照：`**` 标记、表格往返幂等、拖动选中文字改位置仍被禁。
  '_verify-table-quickbar.js'
]

/** 自己管理 Electron 实例的套件（运行器不替它们起实例） */
const SELF_MANAGED = new Set([
  '_verify-session-last-closed.js',
  // 它自己起 4 轮实例（关窗是把窗口真的关掉，一个实例验不完四条出路），端口 9222
  '_verify-close-save-prompt.js',
  // 它自己起「首个实例 + 第二个实例」，并用 9231 而不是 9222，故不占运行器的实例
  '_verify-single-instance.js',
  // 它要用 LUMIN_EXPORT_DIR 起实例（工作区快照会弹原生「另存为」），端口 9234
  '_verify-backup.js',
  // 它要在实例起来**之前**往 --user-data-dir 里种草稿夹具（ps1 会先删目录），端口 9235
  '_verify-draft-gc.js',
  // 它起的是**打包后的 exe**（dist/win-unpacked），端口 9225，而且不能用运行器的隔离 profile
  '_verify-packaging-fast.js',
  // 它要在实例起来**之前**给 `LUMIN_OPEN_EXTERNAL_DRY_RUN=1`（"点了外链只记日志、不真开浏览器"），
  // 端口 9236 —— 环境变量只能在启动前给到，所以自管实例
  '_verify-feedback.js',
  // 它要在实例起来**之前**给 `LUMIN_PRINT_DRY_RUN=1`（"点预览里的打印只记账、不弹原生对话框"）
  // 与 `LUMIN_EXPORT_DIR`（导出落点旁路，用来交叉验证页数），端口 9237
  '_verify-print-preview.js',
  // ── 选区不变量矩阵（元素 × 手势 = 100 格）：**自管实例**（端口 9422/9423，
  //    userData `%TEMP%\xw-inv-ud(2)`，目录名刻意不含 "lumin"）。
  //    为什么自管：它按"每 ≤30 格换一个全新实例"跑（拖选会写下大量临时状态），
  //    而且要周期性 `Page.bringToFront`（窗口被遮挡时 rAF 降到 1/500ms，统计就不可信）。
  //    跑法：`node tools/run-suites.js --suite=_verify-selection-invariants.js --timeout=1800000`
  //    （实测一轮 ~5 分钟：100 格 × ~1.5s + 4 次换实例 + 2 次像素自证）。
  '_verify-selection-invariants.js'
])

function parseArgs(argv) {
  const args = {
    suite: null,
    all: false,
    keep: false,
    /**
     * 默认调试端口：**不再用 9222**（本机被无关 chrome 占着 ⇒ 新实例 DevTools `bind()` 失败，
     * 而 `connect()` 会连到那个无关进程上）。改成一个空闲端口，见 `tools/README.md`。
     */
    port: 9440,
    timeoutMs: 420000,
    retry: 1,
    tier: null,
    probe: false,
    ciSubset: false
  }
  for (const a of argv.slice(2)) {
    if (a === '--all') args.all = true
    else if (a === '--keep') args.keep = true
    else if (a.startsWith('--suite='))
      args.suite = a.slice('--suite='.length).split(',').filter(Boolean)
    else if (a.startsWith('--port=')) args.port = Number(a.slice('--port='.length))
    else if (a.startsWith('--timeout=')) args.timeoutMs = Number(a.slice('--timeout='.length))
    // 失败重跑次数（默认 1）。见 README 里「FLAKY 与 FAIL 的区别」
    else if (a.startsWith('--retry=')) args.retry = Math.max(0, Number(a.slice('--retry='.length)))
    // 按档挑套件：`--tier=fast` / `--tier=fast,needs-build`（分档见 tierOf）
    else if (a.startsWith('--tier='))
      args.tier = a.slice('--tier='.length).split(',').filter(Boolean)
    // 显式跑探针清单（默认只列不判，见 probeSuites）
    else if (a === '--probe') args.probe = true
    // CI 子集：默认矩阵里不注入真实输入的那批（见 ciSubset）
    else if (a === '--ci-subset') args.ciSubset = true
  }
  return args
}

/**
 * **两阶段/需人工介入**的套件：`--all` 里必须排除，否则每轮都报一个假 FAIL。
 *
 * `_verify-notify-restart.js` 的用法是 `seed` → **外部杀掉 Electron 并重启** → `check`，
 * 不带参数跑只会打印用法然后 `exit 1`（运行器读到 `0/0` 记成 FAIL）。
 * 它验证的是「跨进程重启」这件事，任何自动矩阵都给不了那个重启时机。
 */
const MANUAL = new Set(['_verify-notify-restart.js'])

/** 列出 tools 下所有 `_verify-*.js`（用于 --all） */
/**
 * 列出 tools 下所有套件（用于 `--all`）。
 *
 * ⚠️ 这里必须收**三类前缀**，不能只收 `_verify-*`：
 * 本仓库的套件按用途分了三种命名（`_verify-*` 功能验收 / `_regress-*` 回归 /
 * `_repro-*` 缺陷复现），只收 `_verify-*` 会让 `_repro-*` 里那些**既不在默认矩阵、
 * 也不在 `--all`** 的脚本永远没人跑（实测：8 个）。
 */
function allSuites() {
  return fs
    .readdirSync(TOOLS)
    .filter((f) => /^_(verify|regress|repro)-.*\.js$/.test(f))
    .filter((f) => !MANUAL.has(f))
    .sort()
}

/** 这个套件是否需要 dev server（页面里 import('/src/...')） */
function needsDevServer(file) {
  try {
    return /import\(\s*['"]\/src\//.test(fs.readFileSync(path.join(TOOLS, file), 'utf-8'))
  } catch {
    return false
  }
}

/**
 * 套件分档（清单 §10「覆盖矩阵不完整」建议 ③：让"哪一档该在什么时候跑"变成**数据**）。
 *
 *   fast        —— 默认矩阵（`DEFAULT_SUITES`）：纯合成事件为主，不需要人看着，回归时首选
 *   needs-build —— 要对着新构建/新实例跑，或在 `--all` 里按需点名（含 `_probe-*` 探针）
 *   needs-dev   —— 页面里 `import('/src/...')`，必须先起 `npm run dev` 的 5173
 *   manual      —— 需要人工介入（重启进程 / 真打包），任何自动矩阵都替代不了
 *
 * 分档只在**这一处**维护（不往 79 个套件文件里各插一行注解：那样改一次口径要动 79 个文件，
 * 而且注解与现实漂移时没人会发现）。`tests/tooling.test.mjs` 会守着三件事：
 * 每个套件恰好落在一档、`fast` 必须都真在 `DEFAULT_SUITES` 里、`needs-dev` 必须与
 * `needsDevServer()` 的实测结果一致。
 */
const TIER_MANUAL = new Set(['_verify-notify-restart.js', '_verify-packaging.js'])
/** 需要 dev server 的套件：与 needsDevServer() 的实测结果必须完全一致（tooling 测试守） */
const TIER_DEV = new Set([
  '_verify-keymap.js',
  '_verify-open-file-dedup.js',
  '_verify-open-file-routing.js',
  '_verify-save-as-workspace.js'
])

function tierOf(file) {
  if (TIER_MANUAL.has(file)) return 'manual'
  if (TIER_DEV.has(file)) return 'needs-dev'
  return DEFAULT_SUITES.includes(file) ? 'fast' : 'needs-build'
}

/**
 * **不产出断言的"探针"**（清单 §10 P1「0 断言探针在冒充 PASS」）。
 *
 * 它们不该混进判定（`_probe-*` 是排查/基准用的临时脚本），但也不能像以前那样**完全不可见** ——
 * 那正是审计说的问题：一个从不产出断言的脚本和一条 38 断言的套件在终端上长得一样。
 * 现在每轮矩阵末尾都会把这份名单打出来，`--probe` 可显式跑（那时**照常判定**，红就是红）。
 *
 * 历史上这里还额外登记过 `tools/verify-tiptap.js`（1488 行的遗留 CDP 矩阵）：它守的
 * input rules / 任务列表 / 链接 / 表格选择器 / 回车与退格语义已经迁进默认矩阵
 * （`_verify-input-rules.js` + `_verify-inline-formats.js` + `_verify-table-fidelity.js` 等），
 * 所以那个文件**已删除**（清单 §10 P0「不在任何矩阵、换机不可跑」的最终处理），名单里不再需要特例。
 */
function probeSuites() {
  return fs
    .readdirSync(TOOLS)
    .filter((f) => /^_probe-.*\.js$/.test(f))
    .sort()
}

/**
 * **CI 子集**（清单 §10「CI 不跑任何 CDP 套件」那条的落地）：默认矩阵里
 * *不注入真实输入* 的那批 —— 判据是**可测量的**：源码里不出现
 * `dispatchKeyEvent` / `dispatchMouseEvent` / `insertText`（真实按键与指针会被
 * "窗口不在前台"吃掉，那是无头 runner 上唯一稳不住的东西）。
 *
 * 于是「哪些套件适合进 CI」不再靠人挑：改一条套件、往里面加真实按键，它就自动出局。
 * workflow 用 `node tools/run-suites.js --ci-subset` 跑它，且**不阻塞 PR**（只通知）。
 */
const REAL_INPUT = /dispatchKeyEvent|dispatchMouseEvent|Input\.insertText/
function ciSubset() {
  return DEFAULT_SUITES.filter((f) => {
    try {
      return !REAL_INPUT.test(fs.readFileSync(path.join(TOOLS, f), 'utf-8'))
    } catch {
      return false
    }
  })
}

/**
 * 杀掉「建在临时目录里」的 Electron 实例（本仓库所有隔离实例的约定位置）。
 *
 * 为什么需要：运行器给每个套件起的实例用 `%TEMP%\lumin-suites-ud`，但**人工**起的
 * 隔离实例（`start-isolated.ps1` 默认 `%TEMP%\lumin-ud`、各类调试脚本各自的名字）
 * 会占着 9222，把整轮矩阵顶掉。按「命令行里的 user-data-dir 落在 %TEMP% 下」判定，
 * **不碰**用户自己的 `%APPDATA%\lumin` 实例。
 */
function killTempInstances() {
  const script = [
    `$tmp = $env:TEMP`,
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |`,
    `  Where-Object { $_.CommandLine -match '--user-data-dir="?([^"\\s]+)' -and $matches[1] -like "$tmp*" } |`,
    `  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  ].join('\n')
  spawnSync('powershell', ['-NoProfile', '-Command', script], { cwd: ROOT, stdio: 'ignore' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 隔离实例的 stdout 日志文件（`startInstance` 写、套件读）。
 * 口径与读取入口只有一处：`lib/harness.js` 的 `instanceLog()`（ps1 用同一规则拼文件名），
 * 并通过 `LUMIN_INSTANCE_LOG` 传给套件（见 `runSuite` 的环境变量）。
 */
const instanceLog = require('./lib/harness').instanceLog

/**
 * 起一个隔离实例。**非阻塞**（第 135 轮收口）。
 *
 * ⚠️ 旧实现用 `spawnSync('powershell', ['-File', start-isolated.ps1, …])` **同步等待**那个脚本；
 * 而该脚本的语义是"起实例 → 轮询端口 → READY → 退出" ⇒ 它在**本环境沙箱下起不来**时，
 * `spawnSync` 又没传 `timeout`，于是整个运行器**永久阻塞**（历史上多次把矩阵命令挂死，
 * 表头之后再无输出、实例日志只有一行 `CLEANED`）。
 *
 * 现在换成 `spawn`（非阻塞）+ 自己轮询 `http://127.0.0.1:<port>/json/list`，**硬超时 90s**，
 * 超时/失败都**如实返回**（`code` 非 0 + 日志尾部），绝不无限期挂住。
 *
 * 另外三条实测踩出来的坑（详见 `tools/README.md` 的"起实例的正确姿势"）：
 *   * 必须 `delete ELECTRON_RUN_AS_NODE`（置 `undefined` 会被 `spawn` 忽略，Electron 会退化成
 *     "用 node 跑 `.`" ⇒ 主进程秒退）；
 *   * 必须设 `LUMIN_TRUSTED_PATHS` 指向临时目录（否则临时目录里的夹具 `openPath` 回 `false`）；
 *   * 起之前要确认端口没被**残留实例**占着（否则新实例 DevTools `bind()` 失败，而 `connect()`
 *     会连到那个陈旧实例上 ⇒ 统计全是假数据）。
 */
function startInstance(port, userData, cleanupOnly = false) {
  const launchLog = path.join(os.tmpdir(), `lumin-suites-${path.basename(userData)}.log`)
  const fd = fs.openSync(launchLog, 'w')
  if (cleanupOnly) {
    // 只收尾：按 user-data-dir 精确杀（不按 "lumin" 关键字杀，避免误杀）
    const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${String(userData).replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { cwd: ROOT, stdio: 'ignore' })
    fs.closeSync(fd)
    const text = fs.existsSync(launchLog) ? fs.readFileSync(launchLog, 'utf-8') : ''
    return { code: r.status, text }
  }
  const electron = path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
  const childEnv = {
    ...process.env,
    LUMIN_DEBUG_PORT: String(port),
    LUMIN_TRUSTED_PATHS: os.tmpdir()
  }
  // ⚠️ 关键：必须 delete（置 undefined 会被 spawn 忽略）
  delete childEnv.ELECTRON_RUN_AS_NODE
  const proc = spawn('cmd.exe', ['/c', electron, '.', `--user-data-dir=${userData}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', fd, fd],
    detached: false
  })
  /** 同步探测 CDP 是否就绪（不起新进程，用 http 请求） */
  const ready = () => {
    try {
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:${port}/json/list").StatusCode } catch { 0 }`
        ],
        { cwd: ROOT, encoding: 'utf-8', timeout: 8000 }
      )
      return String(r.stdout || '').trim() === '200'
    } catch (e) {
      return false
    }
  }
  const t0 = Date.now()
  let ok = false
  while (Date.now() - t0 < 90000) {
    if (ready()) {
      ok = true
      break
    }
    if (proc.exitCode != null) break
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { stdio: 'ignore' })
  }
  fs.closeSync(fd)
  const text = fs.existsSync(launchLog) ? fs.readFileSync(launchLog, 'utf-8') : ''
  if (!ok) {
    try {
      proc.kill()
    } catch (e) {
      /* 忽略 */
    }
  }
  return { code: ok ? 0 : 1, text }
}

/**
 * 跑一个套件，返回 { code, pass, total, raw, skipped }
 * 环境变量里带上隔离实例的库与草稿目录：不少老套件直读 SQLite（`LUMIN_DB`）或草稿目录
 * （`LUMIN_DRAFTS_DIR`），不指过去它们读的就是**用户真实的数据**（曾让 6 项会话断言误报失败）。
 */
function runSuite(file, port, timeoutMs, userData) {
  const env = {
    ...process.env,
    LUMIN_DEBUG_PORT: String(port),
    LUMIN_DB: path.join(userData, 'lumin.db'),
    LUMIN_DRAFTS_DIR: path.join(userData, 'drafts'),
    // 有套件会**自己再起一个实例**（`--user-data-dir=$LUMIN_ISOLATED_USERDATA`）来验证
    // 「第二个进程把参数转交给首个实例」（如 _verify-taskbar-jumplist.js 的 C 段、
    // _verify-encoding.js）。它们读的就是这个变量，缺了它就会退回一个**写死的旧目录名**
    // （%TEMP%\lumin-keymap-userdata）—— 那跟本运行器起的实例（%TEMP%\lumin-suites-ud）
    // 不是同一个 profile，于是第二个进程拿不到单实例锁、自己成了首实例、开出的窗口不在
    // 本运行器的调试端口上，表现成「一个窗口都没多出来」的假失败（实测 25/31，其中 6 条
    // 全红）。把实例真实目录告诉套件，才能真的走到「转交 → 新窗口」那条路径上。
    LUMIN_ISOLATED_USERDATA: userData,
    // 实例 stdout 日志的**确切路径**（本函数上面那个文件）：套件读它就能看到主进程
    // `console.log` 打了什么 —— GUI 子系统里主进程没有控制台，这是唯一可读的出口。
    // 用例见 `_verify-devtools.js`（断言工具栏那枚按钮真的把 IPC 送到了主进程）。
    LUMIN_INSTANCE_LOG: instanceLog(userData)
  }
  const r = spawnSync(process.execPath, [path.join(TOOLS, file)], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024
  })
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // 汇总行三种写法都认：新套件的 `--- N/M PASS`、老套件的 `TOTAL n PASS x FAIL y`、
  // **以及更老的「逐行 `PASS x` / `FAIL y` 但从不打汇总行」那一批**（自查报告 H1 的第二种成因：
  // 这类套件其实一直在断言，只是运行器把它们的成绩读成 0/0 —— 实测 `_verify-editor-menu.js`
  // 51 条、`_verify-notify-style.js` 11 条、`_verify-cb-no-active-line.js` 12 条都是这样被"清零"的）。
  let pass = 0
  let total = 0
  let fail = 0
  let skip = 0
  // ⚠️ **SKIP 不是 FAIL**（清单 §1.C.1）：`--- N/M PASS` 里的 M 是「断言总数」，含 SKIP
  // （Reporter 的 total = passed + failed + skipped），所以 `M - N` **不等于**失败数 ——
  // 老写法把它当失败数，于是「FAIL 0 SKIP 1」的套件被判 FAIL：实测 `_verify-md-fidelity.js`
  // （101/102）、`_verify-round-24.js`（15/16）、`_verify-theme-auto.js` 退出码 0、FAIL 0，
  // 却每轮报红。现在优先认三个数分开写的 `TOTAL … FAIL … SKIP …`；
  // 退到老格式或只有 `--- N/M PASS` 时，用 **SKIP 行数**从 M 里扣掉再算失败数。
  const skipLines = raw.split('\n').filter((l) => /^\s*SKIP\b/.test(l)).length
  const full = [
    ...raw.matchAll(/TOTAL\s+(\d+)\s+PASS\s+(\d+)\s+FAIL\s+(\d+)\s+SKIP\s+(\d+)/g)
  ].pop()
  const tot = full ? null : [...raw.matchAll(/TOTAL\s+(\d+)\s+PASS\s+(\d+)\s+FAIL\s+(\d+)/g)].pop()
  const bar = full || tot ? null : [...raw.matchAll(/---\s*(\d+)\/(\d+)\s*PASS/g)].pop()
  if (full) {
    total = Number(full[1])
    pass = Number(full[2])
    fail = Number(full[3])
    skip = Number(full[4])
  } else if (tot) {
    pass = Number(tot[2])
    fail = Number(tot[3])
    skip = Math.max(0, Number(tot[1]) - pass - fail)
    total = pass + fail + skip
  } else if (bar) {
    pass = Number(bar[1])
    total = Number(bar[2])
    skip = Math.min(skipLines, Math.max(0, total - pass))
    fail = Math.max(0, total - pass - skip)
  } else {
    const lines = raw.split('\n')
    const okLines = lines.filter((l) => /^\s*PASS\b/.test(l)).length
    const badLines = lines.filter((l) => /^\s*FAIL\b/.test(l)).length
    if (okLines + badLines > 0) {
      pass = okLines
      fail = badLines
      total = okLines + badLines
    }
  }
  const skipped =
    /NO-APP-PAGE|SKIP: 没有可用窗口|SKIP: 9222 上已有|NO_PINIA|INSTANCE-NOT-READY|SKIP: 前置条件不满足/.test(
      raw
    )
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    pass,
    total,
    fail,
    skip,
    raw,
    skipped: skipped && !total
  }
}

async function main() {
  const args = parseArgs(process.argv)
  let suites = args.suite ?? (args.all ? allSuites() : DEFAULT_SUITES)
  if (args.probe) suites = probeSuites()
  if (args.ciSubset) suites = ciSubset()
  if (args.tier) {
    // 按档挑：档位是数据（tierOf），所以「今晚只跑 fast 那一档」不需要再记一张表
    const before = suites.length
    suites = suites.filter((s) => args.tier.includes(tierOf(s)))
    console.log(`--tier=${args.tier.join(',')} → ${suites.length}/${before} 个套件`)
  }
  /**
   * 清单里写了但盘上不存在的套件：**必须报出来并让命令失败**。
   * 原来是一句 `filter(existsSync)` 静默丢弃 —— 一次重命名就能让覆盖悄悄变少而矩阵照旧全绿
   * （与 NOASSERT 想解决的"绿灯什么都证明不了"是同一类问题）。
   */
  const missing = suites.filter((s) => !fs.existsSync(path.join(TOOLS, s)))
  if (missing.length) {
    console.log(`清单里列了但盘上不存在（改名/删除后没同步清单？）：${missing.join(', ')}`)
    return 1
  }
  suites = suites.filter((s) => fs.existsSync(path.join(TOOLS, s)))
  if (!suites.length) {
    console.log('没有可跑的套件')
    return 0
  }

  const userData = path.join(os.tmpdir(), `lumin-suites-ud`)
  const tierCount = {}
  for (const s of suites) tierCount[tierOf(s)] = (tierCount[tierOf(s)] ?? 0) + 1
  console.log(
    `## CDP 套件矩阵（${suites.length} 个，端口 ${args.port}，实例数据目录 ${userData}）` +
      `\n## 分档：${Object.entries(tierCount)
        .map(([k, v]) => `${k}×${v}`)
        .join(
          ' / '
        )}（fast=默认回归 / needs-build=要对着新构建 / needs-dev=要 5173 / manual=要人看着）`
  )
  // 开场先收尾：上一轮留下的实例、以及人工起的隔离实例都会占着 9222，
  // 把第一个套件（可能是自管实例的）顶掉 —— 先清掉临时目录下的实例再开始。
  startInstance(args.port, userData, true)
  killTempInstances()
  await sleep(1500)
  const rows = []
  for (const file of suites) {
    const devNeeded = needsDevServer(file)
    if (devNeeded && !args.all) {
      console.log(`SKIP ${file} | 需要 dev server（import('/src/...')），用 --all 显式跑`)
      rows.push({ file, status: 'SKIP', pass: 0, total: 0 })
      continue
    }
    process.stdout.write(`… [${tierOf(file)}] ${file} `)
    const selfManaged = SELF_MANAGED.has(file)
    if (!selfManaged) {
      let inst = startInstance(args.port, userData)
      if (inst.code === 2) {
        // 端口被占：可能是人工起的隔离实例（%TEMP% 下）——清一遍再试一次
        killTempInstances()
        await sleep(1500)
        inst = startInstance(args.port, userData)
      }
      if (inst.code !== 0) {
        console.log(
          `\rFAIL ${file} | 隔离实例没起来（exit ${inst.code}）\n${inst.text.trim().slice(0, 200)}`
        )
        if (inst.code === 2) {
          console.log(
            '    提示：调试端口被别的 Electron 实例占着。先关掉它（多半是上一轮留下的隔离实例）：\n' +
              `      Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select ProcessId,CommandLine\n` +
              '      （按 CommandLine 里的 --user-data-dir 判断；**不要**动用户自己的 %APPDATA%\\lumin 实例）'
          )
        }
        rows.push({ file, status: 'FAIL', pass: 0, total: 0 })
        continue
      }
    }
    const res = runSuite(file, args.port, args.timeoutMs, userData)
    /**
     * 判定只看两件事：**套件退出码**与**打印过的 FAIL 行**（老套件里存在"只打印、退出码仍 0"
     * 的写法，实测 `_verify-notifications.js` 就是这一类）。
     * ⚠️ SKIP **不参与**失败判定（清单 §1.C.1）：环境不支持而如实 SKIP 的断言不该把整轮判红 ——
     * 它们在行尾单独显示 `SKIP n`，整体退出码也不受 SKIP 影响。
     */
    let status = res.code === 0 && res.fail === 0 ? 'PASS' : 'FAIL'
    if (res.skipped && res.total === 0) status = 'SKIP'
    /**
     * ─── 失败重跑一次：**FLAKY 与 FAIL 分开**（默认 `--retry=1`）─────────────────
     *
     * 为什么要有这一档：CDP 套件住在真实桌面里 —— 机器忙、窗口被遮挡、首帧还没稳定时，
     * 「等布局/等焦点/等帧」类断言会随机红一条。实测：同一套件批跑红、单独重跑绿
     * （本轮 `_regress-cb` / `_verify-cb-virtualization` / `_verify-outline-right` 三条都这样）。
     * 混在一起报 FAIL 的后果是**没人再信红灯**，真回归反而被当成噪音。
     *
     * 口径：重跑一次（**全新实例**），过了记 `FLAKY`（打印出来、不判失败），
     * 两次都红才是 `FAIL` —— 真回归不会因为重跑而变绿。
     */
    let retries = 0
    let firstRun = null
    while (status === 'FAIL' && retries < args.retry) {
      retries += 1
      if (firstRun === null) firstRun = `${res.pass}/${res.total}`
      if (!selfManaged) {
        const again = startInstance(args.port, userData)
        if (again.code !== 0) break
      }
      const retryRes = runSuite(file, args.port, args.timeoutMs, userData)
      if (retryRes.code === 0 && retryRes.fail === 0 && retryRes.total > 0) {
        status = 'FLAKY'
        res.pass = retryRes.pass
        res.total = retryRes.total
        res.skip = retryRes.skip
      }
    }
    /**
     * ⚠️ **零断言 = NOASSERT，不算通过**（自查报告 H1）。
     *
     * 原来只看退出码：一个套件如果**压根没产出断言**（没打印 `--- N/M PASS` / `TOTAL` 行，
     * 退出 0），终端上显示 `0/0 PASS`，和「全部通过」只差一个数字 —— 于是"绿灯"什么都证明不了。
     * 实测：非默认矩阵里抽样 8 个套件，**8/8 都是 0/0 却被记成 PASS**
     * （`_verify-i18n` / `_verify-editor-menu` / `_verify-alt-menu` / `_verify-toast-tip` /
     * `_verify-notifications` / `_verify-notify-style` / `_verify-cb-no-active-line`，
     * 外加当时还存在、后来随覆盖补齐被删掉的 `_verify-export-fix2`）。
     * 现在把它们单列为 NOASSERT 并让整体退出码非零，逼着人**要么修好、要么删掉**；
     * 确实"无事可断言"的套件请写进 EMPTY_OK 并注明理由。
     */
    if (status === 'PASS' && res.total === 0 && !EMPTY_OK.has(file)) status = 'NOASSERT'
    console.log(
      `\r${status} ${file} | ${res.pass}/${res.total}${res.skip ? ` SKIP ${res.skip}` : ''}${
        selfManaged ? '（自管实例）' : ''
      }${devNeeded ? '（需要 dev server）' : ''}${
        status === 'FLAKY' ? `  ← 首次 ${firstRun} 红、重跑绿（环境敏感，不是回归）` : ''
      }${status === 'NOASSERT' ? '  ← 没有产出任何断言，等于没测' : ''}`
    )
    if (status === 'FAIL') {
      const tail = res.raw
        .split('\n')
        .filter((l) => /^FAIL|^ERROR|^TOTAL/.test(l))
        .slice(0, 8)
        .join('\n    ')
      if (tail) console.log('    ' + tail)
    }
    rows.push({ file, status, pass: res.pass, total: res.total, skip: res.skip, firstRun })
    if (!args.keep) await sleep(500)
  }

  const failed = rows.filter((r) => r.status === 'FAIL')
  const pass = rows.filter((r) => r.status === 'PASS')
  const skipped = rows.filter((r) => r.status === 'SKIP')
  const noassert = rows.filter((r) => r.status === 'NOASSERT')
  const flaky = rows.filter((r) => r.status === 'FLAKY')
  if (!args.keep) startInstance(args.port, userData, true) // 收尾：别把实例留在 9222 上
  console.log(
    `\nTOTAL ${rows.length} PASS ${pass.length} FAIL ${failed.length} SKIP ${skipped.length} NOASSERT ${noassert.length} FLAKY ${flaky.length}`
  )
  const skippedAssertions = rows.reduce((n, r) => n + (r.skip || 0), 0)
  if (skippedAssertions)
    console.log(
      `（另有 ${skippedAssertions} 条断言按环境如实 SKIP —— SKIP 不算失败，见清单 §1.C.1）`
    )
  if (flaky.length) {
    console.log(
      'FLAKY（重跑绿：环境敏感，未判失败；若某条反复出现在这里，请按"套件不稳"修而不是忽略）' +
        flaky.map((r) => `${r.file}(首次 ${r.firstRun})`).join(', ')
    )
  }
  if (failed.length) console.log('FAILED ' + failed.map((r) => r.file).join(', '))
  if (noassert.length) {
    console.log('NOASSERT（没有产出断言，等于没测）' + noassert.map((r) => r.file).join(', '))
    console.log('  → 修好它，或删掉它；确实无事可断言的请加进 run-suites.js 的 EMPTY_OK 并写理由。')
  }
  // 探针脚本的**普查**：默认不判它们，但必须让人看见它们存在
  // （清单 §10：以前这批"从不产出断言的脚本"在终端上和真套件长得一模一样）
  if (!args.probe) {
    const probes = probeSuites()
    if (probes.length) {
      console.log(
        `未纳入判定（探针，共 ${probes.length} 个）：${probes.join(', ')}\n` +
          '  → 想跑它们：node tools/run-suites.js --probe（那时照常判定，红就是红）'
      )
    }
  }
  // NOASSERT 与 FAIL 一样让命令失败：否则「绿灯」继续骗人
  return failed.length || noassert.length ? 1 : 0
}

/**
 * 只有**直接跑**（`node tools/run-suites.js`）才执行矩阵。
 * `require()` 它（例如 tests/tooling.test.mjs 要核对分档与清单）只拿导出，不起实例。
 */
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('ERROR ' + (e && e.stack ? e.stack : e))
      process.exit(1)
    })
}

// 供测试核对的单一真相（分档、清单、套件全集都在这里，不另抄一份）
module.exports = {
  DEFAULT_SUITES,
  TIER_DEV,
  TIER_MANUAL,
  EMPTY_OK,
  SELF_MANAGED,
  MANUAL,
  allSuites,
  probeSuites,
  ciSubset,
  needsDevServer,
  tierOf
}
