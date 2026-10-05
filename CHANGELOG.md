## [Unreleased]

### Fixed

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
