# 审计清单逐项台账（2026-09-26 复核）

> 对象：桌面上的 `Lumin-项目改进清单-2026-09-24.md`（105 条发现）。
> 这份台账回答一个问题：**清单里的每一条，现在的状态是什么、证据在哪、还没做的卡在哪。**
>
> 判定口径（与清单 §0.2 一致）：
> - **已修**：当前代码里有可复现的实现或门禁（测试/守卫套件），并给出 `路径:行` 或提交号；
> - **部分**：主症状已消，但清单点名的某个子断言还没满足（写清缺哪条）；
> - **未做**：仓库内可做、本轮没做（写清为什么与建议落点）；
> - **外部阻塞**：需要证书 / 真实渠道 / 未验证平台 / 联网安装 / 真机断电等外部条件，
>   或平台本身做不到（例如 Windows 上无法对目录 `fsync`）。
>
> 统计（按条目）：**已修 ~86 / 部分 ~11 / 未做 ~4 / 外部阻塞 ~4**（明细见各节）。
> 本台账本身受 `tests/docsClaims.test.mjs` 的"路径必须存在"门禁保护。

## §2 数据安全与持久化（19 条）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 2.1 | 保存期间继续输入被判"已保存" | 已修 | `src/renderer/src/stores/files.ts` 快照比对 + `tools/_verify-save-safety.js`（15 条）；`51b76b7` |
| 2.2 | 换文档/关窗丢挂起序列化 | 已修 | `src/renderer/src/lib/editorFlush.ts` + save-safety C 段 |
| 2.3 | 连续打字不写草稿 | 已修 | `DRAFT_MAX_WAIT_MS`（`files.ts`）+ save-safety B 段 |
| 2.4 | 多窗口未命名草稿只剩一份 | 已修 | `src/main/drafts.ts`（先写序号键再删源）+ `tests/drafts.test.mjs` |
| 2.5 | 删除是永久删除 | 已修 | `src/main/fileOps.ts` 走 `shell.trashItem`，失败才 rm 并回报 |
| 2.6 | 重命名静默覆盖 | 已修 | `fileOps.ts` 目标存在即 `TARGET_EXISTS`；`tools/_verify-rename.js` 21/21 |
| 2.7 | 无外部改动检测 | 已修 | `ipc.ts` 写前 mtime 比对 + 冲突三条出路；`tools/_verify-external-change.js` |
| 2.8 | 目录删/改名后路径不更新 | 已修 | `fileOps.ts` `PARENT_MISSING` 不再 mkdir；`_verify-file-lifecycle.js` |
| 2.9 | 载入历史无脏确认 | 已修 | `files.ts` 走 `confirmDiscardIfDirty`；`_verify-history-restore.js` |
| 2.10 | 保存失败不重试 | 已修 | 退避 5s→60s + 持久通知 + 红态 |
| 2.11 | 关窗 2.5s 强杀 | 已修 | `src/shared/closeGuard.ts` + `_verify-close-guard.js` + `tests/closeGuard.test.mjs` |
| 2.12 | 编码往返静默改字节 | 已修 | `src/shared/encodingMemory.ts` + `_verify-encoding.js` |
| 2.13 | 草稿非原子/无 GC/撞键 | 已修 | `src/main/drafts.ts`（sha1 名 + 原子写 + GC） |
| 2.14 | SQLite 无体积控制/无降级 | 已修 | 64MB 封顶 + `integrityCheck`/`rebuildFtsIndex`/`vacuum` |
| 2.15 | 无自动备份/工作区导出 | 已修 | `services/dbBackup.ts` + `workspaceBackup.ts` + `_verify-backup.js` |
| 2.16 | 目录项 fsync / tmp 残留 | **平台不可落地** | 实测 Windows 上 `fs.open(dir)+fsync` → `EPERM`（Node 无法对目录 fsync）；tmp 残留由启动清扫解决（`fileOps.ts`） |
| 2.17 | 系统关机/注销未处理 | 已修 | `session-end` + `services/shutdown.ts` + `tests/shutdown.test.mjs` |
| 2.18 | 两窗口同文件各自保存 / tmp 固定名 | 已修 | 窗口去重 + 随机 tmp 名 + `services/writeQueue.ts` |
| 2.19 | 主进程同步 SQLite 大库卡顿 | 已修（**并记录"不下推 SQL"的判据**） | 根因（`LENGTH(content)` 扫正文 2.3s）已换 `bytes` 列；剩余元数据扫描实测 **2000 行 ≈ 6.5ms**，`tests/historyPruneCost.test.mjs` 量它并断言查询不碰 `content`；`189e124` |

## §3 编辑内核、同步与 Markdown 保真（6 条 + 保真表）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 3.1 | 同路径重开回滚未落盘编辑 | 已修 | `files.ts` `openPath` 统一入口；`_verify-save-safety.js`；`ac32812` |
| 3.2 | CM 光标保护是 150ms 推迟 | 已修 | `CodeBlockView.vue` 真源优先；`_regress-cb.js`；`601c1e0` |
| 3.3 | 账本第三面是死码 | 已修（"applied 只是账目"口径 + 注明） | `lib/contentSync.ts` + `tests/contentSync.test.mjs` |
| 3.4 | `flushWysiwyg` 丢作者牌 | 已修 | `useEditorMode.ts` 传 `consumeWriteIntent()` |
| 3.5 | 源码模式会话光标恒 pos=1/len=0 | 已修 | `lib/session.ts` 采集/还原 selection + scrollRatio；`b89068a` |
| 3.6 | 分屏序列化顶源码栏光标 | 已修 | `EditorView.vue` 保存/恢复 selection；`9ef6a81` |

**保真风险清单**（以 `tools/fixtures/md/EXPECT.json` 实测为准：33 份 = exact 17 / normalized 16 / lossy 0）：
脚注 已修（exact，`footnotePassthrough.ts`）；有序列表**起始序号**已有夹具覆盖
（`lists-adjacent-ordered.md`，规则 19：首项编号是语义、后续按位置重算）；
引用式链接 / 定义列表 / Setext / 缩进代码块 = `normalized`（形式改写、语义保留，均为文档化口径，
要 exact 属产品决策）；UTF-16 列号（emoji/组合字符）未专门覆盖 —— 见"仍未做"。

## §4 安全边界（7 条）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 4.1 | 文档链接可打开任意本地程序 | 已修 | `services/links.ts` 扩展名黑名单 + `ipc.ts` 纵深；`c9b1e94` |
| 4.2 | `file:read/write/exists` 无白名单 | 已修 | `services/pathGrants.ts` + `_verify-path-grants.js`；`b6bee5b` |
| 4.3 | `shell:openPath` 是任意路径入口 | **已修（本轮）** | 加授权闸 + 链接激活时记只读授权；运行时断言 `outside-path-shell-open-refused` / `link-activation-grants-readonly`（`_verify-path-grants.js` 11/11）；`fac60d2` |
| 4.4 | 生产 CSP 与 meta 不一致 | 已修 | `src/shared/csp.ts` 单一真相源 + 打包态断言（`_verify-packaging-fast.js` F3/F4） |
| 4.5 | `connect-src` 放行任意 `ws:` | 已修 | prod 只有 `'self'`，`ws:` 仅 dev |
| 4.6 | `events.on` 无通道白名单 | **已修（本轮）** | preload 六条白名单 + 双向对账测试；`fac60d2` |
| 4.7 | 文档路径明文写 `%TEMP%` | **已修（本轮）** | 日志迁 `<userData>/logs` + 512KB 轮转 + 诊断/「打开日志目录」同一来源；`f39ae72` |

## §5 依赖、许可与"代码合法性"（13 条）

| # | 项 | 状态 | 证据 / 阻塞 |
| --- | --- | --- | --- |
| 5.1 | Electron 39 已 EOL | **未做 · 外部条件** | 实测已装 39.8.10 / 最新 **44.4.5**（落后 5 个大版本）；升级计划见 `docs/electron-upgrade.md`。**需要一次能联网的 `npm install` + 独立分支 + 完整矩阵**（本机 npm 被策略禁用远程包获取） |
| 5.2 | 无 LICENSE 但声明 MIT | 已修 | `LICENSE` + `package.json` + `electron-builder.yml` 三处一致；`tests/guards.test.mjs`；`455dd56` |
| 5.3 | 产物里无第三方许可声明 | 已修 | `THIRD-PARTY-NOTICES.md`（300 包）+ `tools/gen-notices.js --check` + asar 实存；`3991c72` |
| 5.4 | Windows 无代码签名 | **外部阻塞（证书）+ 配置可做** | 全仓无签名配置；electron-builder 支持 `CSC_LINK`/`CSC_KEY_PASSWORD` 环境变量，拿到证书后只需在发布流程里设环境变量（`RELEASE.md` 已写） |
| 5.5 | lockfile 指向第三方镜像、无 `.npmrc` | **已修（本轮）** | `.npmrc` 显式声明 registry + `tests/dependencyPolicy.test.mjs` 对账（主机一致 + integrity 齐全）；`9aed076` |
| 5.6 | 生产依赖链有弃用包 | **部分（本轮登记 + 守卫）** | 5 个（`boolean`/`lodash.isequal` 为 PROD，`glob`/`inflight`/`rimraf` 为 dev）写进 `dependencyPolicy.test.mjs` 的只减不增名单；**顶掉需要联网 `overrides` + 重生成 lock** |
| 5.7 | 「关于」页假技术栈 + 无 i18n | 已修 | 依赖从产物内 `package.json` 读、全量接 i18n |
| 5.8 | `package.json` 缺元数据 | 部分 | `private` / `license` / `homepage` 已处理；**`repository` 待真实远端地址**（拿到就能补，属外部信息） |
| 5.9 | `^` 泛滥 / Node 版本不一致 | **部分（本轮收 engines）** | `engines.node` `>=22` → **`>=22 <25`** + CI 版本对账（`dependencyPolicy.test.mjs`）；把 electron/electron-builder 收成 `~` 需同步 lock（联网） |
| 5.10 | 两个 KaTeX 版本 | **未做 · 需联网** | 实测 `katex` 0.18.5 与 `mermaid/node_modules/katex` 0.16.x 各一份；修法是 `overrides` + 验 mermaid 渲染（需 `npm install`） |
| 5.11/12 | 真实自动更新渠道 | **外部阻塞** | `publish` 仍是占位；`updater.ts` 识别占位并如实提示，不发明 URL |
| 5.13 | 合规结论（无 GPL/遥测） | 已核 | 生产闭包 300 包，许可分布见 `THIRD-PARTY-NOTICES.md`；`grep` 无 GPL/SSPL/遥测 |

## §6 架构与可维护性（5 条）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 6.1 | 打包态路径缺常驻覆盖 | **已修（本轮）** | `_verify-packaging-fast.js` 已进 `package.yml`（打包后自动跑，无产物时如实 SKIP）；`9e3d471` |
| 6.2 | 大文件与职责混杂 | **本轮大幅推进（仍部分）** | `main/index.ts` 早已三刀（`windowPlacement.ts`/`openRequest.ts` + 单测）；本轮把 `stores/files.ts` 的**五类判据**抽成 `lib/filesCore.ts`（保存快照 / 草稿时序 / 同路径重开三分支 / 改名搬家算术 / 退避延时）并补 **23 条单测**（`tests/filesCore.test.mjs`，`bbd261f`）。**诚实**：`files.ts` 总行数没降（1260 → 1309，多出来的是契约注释），剩下 `savePromise` 并发闸门与"冲突→确认→强制覆盖"整串仍留在 store（每步都夹 IPC/模态框，纯化只能注入假壳，原因写在 `filesCore.ts` 文件头） |
| 6.3 | 格式清单散落 5 处 | 已修 | `src/shared/exportFormats.ts` 单一清单，五处 import；`0595cbf` |
| 6.4 | 设置无 schema 版本 | 已修 | `settingsSchema.ts` 版本 + 迁移；`022277f` |
| 6.5 | 仓库卫生 | **已修（本轮）** | `tsBuildInfoFile` 落 `node_modules/.cache` + 守卫；`5380618` |

## §7 功能完整度（9 条 + 能力矩阵）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 7.1 | 图片不能粘贴/拖入/选择 | 已修 | `lib/editor/imagePaste.ts` + `insertImage.ts`；`24a141e`。另修：拖入图片不再同时弹"不支持的文件类型"（`d014773`，端到端受限于合成 File 无路径，已加静态守卫） |
| 7.2 | 删除不可恢复 | 已修 | 见 2.5 |
| 7.3 | 打字机模式是空入口 | 已修（按审计 S 方案摘掉入口） | `menu.ts` 无该项，README 如实写明；`8c7c0b4` |
| 7.4 | 全局搜索只搜打开过的 | 已修 | 工作区索引 + 命中定位；`2738986` |
| 7.5 | i18n 只做一半 | 已修 | 硬编码中文=0 / 死键=0 双守卫；`8c7c0b4`、`0bb4405` |
| 7.6 | 导出"能出文件不能交付" | 部分 | EPUB 拆章带图、PDF 页码/页眉/分页已做（`c1e0b33`）；**真打印机（`webContents.print`）未做** |
| 7.7 | 标签有数据层没界面 | 已修 | 状态栏编辑 + 列表展示 + 过滤；`17ef136` |
| 7.8 | 自动更新不可用 | 外部阻塞 | 见 5.11 |
| 7.9 | README 与实现漂移 | 已修 | README 限制表 + **新增"每条声明必须落到代码"守卫**（本轮 `02c24f5`） |

**能力矩阵（本轮新增/仍缺）**：

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| **目标字数 / 阅读时长** | **本轮已做** | `src/shared/readingTime.ts`（唯一字数实现，主进程复用）+ 状态栏两格 + `_verify-bars-no-filename.js` 22/22；`40469d5` |
| **表格列对齐可设置** | **本轮已做** | `lib/editor/tableColumnAlign.ts` + 工具栏四项 + 端到端断言（`_verify-table-fidelity.js` 19/20+1SKIP）；`40469d5`（并修掉命令层重复派发的真 bug） |
| **设置 / 快捷键导入导出** | **本轮已做** | `src/shared/settingsFile.ts` + 三条 IPC + 设置页两个按钮；`40469d5` |
| **文件树内拖放移动** | **本轮已做**（移动到文件夹；刻意不做任意排序） | `lib/treeMove.ts`（纯规则）+ `files.moveNode` + 右键「移动到…」键盘路径 + 撤销卡；`tests/treeMove.test.mjs` 11/52；`e0e20ab` |
| **跨文件（工作区级）替换** | **本轮已做** | `shared/workspaceReplace.ts`（纯逻辑）+ `main/services/workspaceReplace.ts`（IO 编排）+ `workspace:replaceAll` + 全局搜索里的替换行；`tests/workspaceReplace.test.mjs` 15/59；`2104822` |
| 表格列宽拖拽 | 未做 | `extensions.ts` 里 `resizable: false`（列宽进 Markdown 无标准语法，需要一个落点方案） |
| 拼写检查 | 未做 | 需接 `session.setSpellCheckerLanguages` 并解决自绘右键菜单与原生建议的冲突；**需真机实测** |
| 导入（Word/HTML/批量） | 未做 | 导出的对称面；目前可打开扩展名只有 Markdown 家族 |
| **真打印机打印** | **本轮已做（需真机确认）** | 复用 PDF 导出那条隐藏窗口渲染链（`withRenderedDocument`），`silent:false` 弹系统对话框、`printBackground:true`、三态如实反馈 + 5 分钟兜底；纯函数 `shared/printOptions.ts` + `tests/printOptions.test.mjs` 8 条；`664cdcb`。**本机无打印机，出纸与否必须由用户在真机上点一次** |
| **首次引导 / 示例文档** | **本轮已做** | `lib/onboarding.ts`（`shouldShowOnboarding` 纯函数）+ `OnboardingPanel.vue`（三入口，绝不静默写盘）+ 三语整篇示例文档；`tests/onboarding.test.mjs` 11 条；`664cdcb`。观感需人工看一眼 |
| 模板 / 日记 | 未做 | 与"首次引导"同族，属产品范围决策 |
| 定义列表语法节点 / 引用式链接保真 | 部分 | 现有夹具为 `normalized`（形式改写、语义保留），要 exact 属产品决策 |
| 双链 / 反向链接面板 | 未做 | 现只做"跟随 + 缺失时可创建" |
| 真 docx 导出 | 未做 | 现为 HTML 存 `.doc`，设置页已如实说明 |

## §8 UI / UX 与可访问性（17 条）

已修 14：浮层 `role=dialog`+`aria-modal`、开关 `role=switch`+`aria-checked`（唯一实现 `SettingSwitch.vue`）、
代码块高亮四色 ≥4.5（`themeTokens` 门禁）、`--ink-2b` 分档、焦点可见（本轮补 `.range` 与全局搜索 + 守卫
`tests/focusVisibility.test.mjs`）、右键菜单键盘路径、悬停按钮可聚焦、`aria-live`（本轮补**按级别切换**
`role="alert"`/`assertive` 与搜索结果数播报）、`prefers-reduced-motion` 全局兜底、字号/圆角/任意值闭集、
硬编码色收口（含**导出模板与令牌逐条对齐**，`5a5f039`）、危险操作确认与撤销（本轮补**重命名撤销**，
`dfc7e97`）、纯鼠标交互（分隔条/手柄/mermaid 按钮）、940×600 设置页布局、设计令牌文档。

**部分（本轮进展 + 仍缺）**：
- 语义色当文字用：**本轮已修** —— 新增 `--accent-ink`/`--danger-ink`/`--warning-ink`/`--ok-ink`
  文本档（三主题），把文字用法全部迁过去，图形色不变；门禁 `tests/themeTokens.test.mjs`
  要求四个文本档对纸与 panel-2 都 ≥4.5（实测最低 4.84）；`05629b2`。
- **分段控件未收口（可访问性那一半已补）**：设置页 6 处内联按钮组本轮统一补了
  `role="group"` + `aria-label` + `aria-pressed`（读屏器能读出"当前选的是哪一个"，`9ead730`）；
  **视觉统一到 `SegmentedControl` 仍未做** —— 该组件要求每段带图标（`SegmentItem.icon` 必填），
  文字型分组要先改组件接口，属"改到谁迁谁"的剩余项。
- 组件清单文档：**本轮已补** `docs/manual/09-components.md`（含欠账点名）+ 索引与路径门禁；`0e52f49`。

## §9 发布、运维与可观测性（3 条）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 9.1 | 无崩溃/运行日志收集 | 部分 | 诊断导出 + `<userData>/logs/app.log`（本轮：轮转 + 主进程未捕获异常/未处理 rejection 落盘 + 不吞崩溃）；`f39ae72`。**崩溃转储（`crashReporter`）仍未做** —— 需要上报渠道 |
| 9.2 | 无发布流程文档 | 已修 | `RELEASE.md` + `docs/packaging-install-test.md`；`ebbf218` |
| 9.3 | 无 CI 产物/发布工件 | 已修（本轮补门禁口径） | `package.yml`（打包 + SHA256 + 产物）并新增打包态套件步骤；`ci.yml` 补 `notices/docs:facts/docs:tokens` 三道门禁；`693b51b`、`9e3d471` |

## §10 测试、CI 与工程化（20 条）

已修：覆盖矩阵扩容 + 分档数据化（110 套件 / 默认 60）、CI 跑 CDP 子集（`cdp.yml`）、
0 断言探针 → `NOASSERT` + `--probe`、一次性脚本登记、`verify-tiptap.js` 删除与覆盖迁移、
套件清单写错不再静默、i18n 键用没用/绕不绕过、README 数量账目对账、CHANGELOG↔版本联动、
**死引用清理**（本轮删掉指向已删文件的 `tools/run-verify.ps1`，`2781d5d`）、
**flaky 隔离范式**（本轮：骨架 `preconditionSkip`/`requireFocus`/`framesAlive` + 3 条迁移 +
只减不增的欠账名单 19 条；`4669a7b`）、**"必跑清单 + 触发条件"表**（`tools/README.md`，`4669a7b`）、
**文档门禁补"功能清单↔实现"**（本轮 `docsClaims` 新增，`02c24f5`）。

**部分 / 未做**：
- flaky 欠账：仍有 19 条注入真实按键的套件没有守卫（名单在 `tests/tooling.test.mjs`，只减不增）；
- 单测覆盖：**本轮推进** —— `stores/files.ts` 的五类判据已抽成 `lib/filesCore.ts` 并补
  **23 条状态机单测**（`bbd261f`，覆盖"保存期间继续输入"、草稿 1.2s/10s 边界、同路径重开三分支、
  改名搬家算术、退避封顶）；仍未直接覆盖的是 `savePromise` 并发闸门与"冲突→确认→覆盖"整串
  （每步夹 IPC/模态框，见 §6.2）；
- 文档规模：**CHANGELOG 已按轮次归档两册**（本轮 `docs/changelog/archive-02.md`，逐字校验；
  主文件 155KB/52 段 → 6KB/2 段，`664de5e`）；README 的数字账目早由生成式门禁接管；
- 重复实现：**已收口** —— 菜单定位 `lib/menuPlacement.ts`（`7a503fe`）、悬停弹层
  `composables/useHoverPopover.ts` + 纯函数 `planPopoverPos`（`d0b4656`），
  两处都带"组件里不许再出现本地公式"的去重守卫；
- 零引用大文件补测：实测口径下 ≥80 行 **123** 个、零引用 **31 → 26**（本轮补 5 个模块：
  `launchIntent` / `footnotePassthrough` / `cjkEmphasis` / `inputRules` / `menu/providers`，
  合计 68 test / 244 assert，`2cbad2c`）；**主因不是"不值得测"而是"测不动"** ——
  src 里大量相对 import 不带扩展名、Node 原生 ESM 解析不了（新增测试侧解析助手绕开），
  另有 12 个 `.vue`（仓库无 @vue/test-utils）与只能靠 CDP 的主进程模块；
- CI 加固：**已补** —— 8 处 `uses` 全部 pin 到 commit SHA（逐个查 GitHub API 确认 SHA 与
  `v4.x.y` 标签一致）、新增 `CONTRIBUTING.md` / `SECURITY.md` / `.github/CODEOWNERS`、
  `dependabot.yml` 的 github-actions 段加分组与 PR 上限（`e8337fb`）；
  **仍需用户提供真实 GitHub 用户名** —— CODEOWNERS 里的 `@yang_bai_bai` 是占位，
  写成不存在的用户会让规则**静默失效**（语法正确、无报错、只是不请求评审）。

## §11 需要实测才能定论（10 条）

已实测 8 条：CSP/`lumin-file://`（打包态 F3/F4/F5）、保存期输入（save-safety）、
草稿最大等待（10s）、多窗口同文件、重命名撞名、关机/注销、六类往返夹具、CM 光标方向。
**仍未实测 2 条**：原子写在真断电下的表现（需 VM + 强制断电）、Linux `fs.watch` 递归
（需 Linux 机器；现为静默降级，建议至少给可见提示）。

## §12 建议的推进顺序（三个冲刺）

冲刺 1（数据安全 9 条）：**全部已完成**。
冲刺 2：已完成 6 条；代码签名 / 真实渠道为外部阻塞；Electron 升级为独立分支。
冲刺 3：搜索索引、导出质量、标签、诊断已完成；21（拆分）**部分完成** —— `files.ts` 的判据已抽进
`lib/filesCore.ts` 并有 23 条单测，但总行数没降、`savePromise` 闸门与"冲突→确认→覆盖"整串仍在 store。

---

## 验证快照（本轮收尾，实测）

| 门禁 | 结果 |
| --- | --- |
| 单元测试 `node --test "tests/*.test.mjs"` | **736 条全绿**（本轮 596 → 736） |
| 类型检查 | `tsc -p tsconfig.node.json` **0**；`vue-tsc -p tsconfig.web.json` **0** |
| 风格 | `eslint --cache --max-warnings 0 .` **0** |
| 本地全量门禁 `npm run ci` | **exit 0**（typecheck + lint + test:unit + notices:check + docs:facts:check + docs:tokens:check + build） |
| CDP 默认矩阵 `node tools/run-suites.js` | **60 个套件：59 PASS / 0 FAIL / 0 NOASSERT / 1 FLAKY** —— `_verify-cb-languages.js` 首跑 3/5、重跑 5/5（审计 flaky 表里的已知项：语言包按需 `import()`，首跑量到未挂载的静态态），**不是回归**；另有 5 条断言按环境如实 SKIP（SKIP 不算失败） |
| 打包态 | `npx electron-builder --dir` 产出 `dist/win-unpacked/Lumin.exe`；`_verify-packaging-fast.js` 6/6（对产物跑 CSP / `lumin-file://` / asar 懒加载 / `isPackaged`） |

> 跑矩阵前请清场：杀掉残留的测试实例（命令行含 `Temp\lumin-*` 的 electron 进程）
> 并删掉 `%TEMP%\lumin-suites-ud` —— 否则会话恢复会把**上一轮套件的夹具文档**带回编辑器，
> 表现为某些套件读到别的套件的字节（本轮踩到过；用户自己的 `%APPDATA%\Lumin` 实例**不要动**）。

---


## 本轮（收尾批次）发现并修掉的真缺陷

这几条**不在清单原文里**，是"补测试 / 补断言 / 迁移范式"时被守卫抓出来的，都已修复并留下回归：

1. **任务列表输入规则在非首项上改错项**：`inputRules.ts` 用 `$from.index(itemDepth)` 当"第几个列表项"，
   而 prosemirror 的 `ResolvedPos.index(d)` 是"层 d 那个节点的第几个**子节点**" ⇒ 恒为 0 ⇒
   `[x] ` 敲在第二项会把**第一项**勾上；同一处还按"文本全等"找目标，导致在有正文的项上**静默失效**
   （真实编辑器里只留下被转义的 `\[x\]`）。修法：`index(itemDepth - 1)` + `startsWith` 候选 +
   取离光标最近者 + 连尾随空格一起剥。回归：`tests/inputRules.test.mjs` 15/15、
   `_verify-input-rules.js` E 段、真编辑器探针 3/3（`4aa7968`）。
2. **表格列对齐的命令层重复派发**：命令里自己 `view.dispatch(tr)`，Tiptap 命令层又派发一次 ⇒
   点一下抛 `RangeError: Applying a mismatched transaction`（纯函数层完全正确）。
   修法：用命令拿到的 `state`/`dispatch`。回归：`_verify-table-fidelity.js` 的列对齐段（`40469d5`）。
3. **两条用 Tailwind z 类名找菜单的验收套件**：z 层级收进令牌后类名从 `z-[160]` 变成
   `z-[var(--z-critical)]`，两条套件静默变红（0 断言，看着像环境抖动）。
   修法：改语义锚点 `role="menu"`；并加守卫禁止工具链写死数字型 z 类名（`e42b679`）。
4. **测试用 `index(depth + 1)` 的同类错误**已写进列表代码注释（`tableColumnAlign.ts` 与
   `menu/context.ts` 的 `colIndex`）——后者目前只被"rows 禁用判据"消费，未改，登记在此。
5. **`refreshDir` 级联删缓存**导致已展开子目录渲染成"空文件夹"（既有缺口）：
   本轮的 `moveNode` 特意改用两次 `loadChildren` 避开；`renameNode`/`undoRename`/右键刷新仍走老路，
   **未改**，登记在此。



1. **Electron 39 → 44 升级**（最高风险，需联网安装 + 独立分支 + 完整矩阵；计划已写在 `docs/electron-upgrade.md`）。
2. **`stores/files.ts` 拆分 + 状态机单测**（§6.2/§10.7）：拆出编码/EOL/标签等纯逻辑后补 6~10 条断言。
3. **分段控件收口**（§8.10）：设置页 6 处内联按钮组换 `SegmentedControl`。
4. **跨文件替换 / 列宽拖拽 / 拼写检查 / 导入 / 真打印机 / 模板·日记 / 定义列表节点 / 双链 / 首次引导**（§7 能力矩阵剩余项）。
5. **~44 个零引用大文件补测**（优先 `tableMarkdown` / `listMarkers` / `mathMarkers` / `inputRules` / `fileOps` / `database`）。
6. **代码签名 + 真实更新渠道**（外部资源）；**崩溃转储**（需上报渠道）。
7. **`repository` 字段 / lockfile 规格收紧 / 弃用包顶掉 / 双 KaTeX** —— 需要真实远端地址或一次联网 `npm install`。
8. **平台验证**：mac / Linux（`build:mac` / `build:linux` 会明确拒绝，不产出未验证的包）。
