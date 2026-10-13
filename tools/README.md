# tools/ —— 验收脚本的写法约定

> 来源：自查报告 **S1**。`tools/` 的规模比 `src/` 还大（账目见下方「现状与迁移进度」的自动统计块）。
> 74 个 `_verify-*.js` 各写各的 CDP 连接、目标过滤、断言收集。结论不是"一次性重写"，
> 而是**改到谁迁谁 + 新脚本一律用 harness**。

## 三层结构（新脚本只需要认识第一层）

| 层 | 位置 | 职责 |
| --- | --- | --- |
| **harness** | `tools/lib/harness.js` | 连 CDP、挑应用页、注入 `window.__L`、等待就绪、打开文档、`Reporter`、`fatal`。**新脚本只许用这一层。** |
| 工具库 | `tools/lib/color.js`、`tools/lib/*.js` | 颜色/几何等可复用探针（`SURFACE_PROBE` 之类）。 |
| 运行器 | `tools/run-suites.js` | 矩阵、隔离实例、解析 `--- N/M PASS` / `TOTAL …` / 逐行 `PASS|FAIL`，**零断言记 NOASSERT 并失败**。 |

## 新脚本模板（照抄即可）

```js
'use strict'
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) return 1 // 实例没起来：返回非零，别假装通过
  const report = new Reporter('这次验收的名字')
  await openDocWith(app, '# 标题\n\n正文\n', 'fixture.md')
  await sleep(800)
  const got = JSON.parse(await app.ev(`JSON.stringify((() => ({ a: 1 }))())`))
  report.check('一句话说清断言', got.a === 1, JSON.stringify(got))
  return report.finish() // 有 FAIL 返回 1
}

main().then((c) => process.exit(c)).catch(fatal)
```

## 硬性规矩（都是踩过的坑）

1. **必须产出断言**：`Reporter.check` 至少一条。只打印观察值、然后 `exit 0` 的脚本会被运行器判
   `NOASSERT` 并让整轮失败（实测过 8 个这样的套件被当成"全绿"）。
2. **退出码要诚实**：断言失败就非零退出（用 `report.finish()`），不要 `process.exit(0)` 了事。
3. **打印了 FAIL 行也算失败**（运行器会数行）—— 别只打印不退出。
4. **不要自己写 CDP 连接**：用 `connect()`/`settle()`。自己写的版本会踩「端口上还留着旧实例 →
   量到旧页面」这类坑（`_probe-*` 脚本就翻过车）。
5. **自管实例的脚本**要放进 `run-suites.js` 的 `SELF_MANAGED`，否则运行器先起的实例会占着端口。
6. **临时探针用完就删**，命名 `_probe-*`；留下的验收脚本命名 `_verify-*`（运行器识别）。
7. **别把状态留给下一个套件**：改过设置/工作区/文档的脚本要复原（隔离实例的下一个套件会复用进程）。
8. **中文源文件一律 UTF-8 无 BOM**（`.ps1` 例外，必须带 BOM），见 `tests/encodingGuard.test.mjs`；
   **不要用 PowerShell 的 `Get-Content`/`Set-Content` 往返改这些文件**（会把 UTF-8 变成 mojibake）。
9. **要量快捷工具栏的套件必须显式打开它**：`await showToolbar(app)`（harness 提供）。
   工具栏**出厂默认收起**（清单 §1.E 选项②），而运行器给每个套件用的都是全新 userData ⇒
   默认值每次都生效 —— 不显式打开的套件会拿不到 `[role="tablist"]`（模式分段控件），
   表现成「切面没生效」的假失败（实测 `_regress-layout` / `_regress-divider` /
   `_regress-source-roundtrip` / `_verify-find-replace` 都踩过）。
10. **SKIP 不算失败**（运行器口径）：环境不支持就如实 `report.skip(...)`，别把 SKIP 写成 FAIL，
   也别用退出码表达 SKIP —— 运行器只把「退出码非 0」与「打印过 FAIL 行」判红。
11. **要验"打包态"就对着产物跑，别在 dev 里推理**：`_verify-packaging-fast.js`（自管实例、端口 9225）
    只对着 `dist/win-unpacked/Lumin.exe` 断言 CSP / `lumin-file://` 图片 / asar 懒加载 / `isPackaged`。
    它**自己不做构建**：没有产物就如实 SKIP 并提示先跑 `npm run build:unpack`。
    这条规矩是踩出来的：打包态**首屏相对图片**曾因"文档 → 窗口"登记慢一拍而 404，
    而浏览器对失败的 `<img>` 不会重试 —— dev 里永远看不到，只有对着产物跑才暴露（已修）。
12. **靠真实按键/帧的套件：拿不到前置条件就 `preconditionSkip`，不要 `throw new Error`**
    （清单 §10 P1「已知 flaky 的套件没有隔离」）。用户自己那套 Lumin 可能正占着前台，
    于是 CDP 注入的按键会丢 —— 那看着像产品缺陷，实际是环境。骨架给了公共入口：

    ```js
    const { preconditionSkip, fatal } = require('./lib/harness')
    // …等焦点若干次之后仍然没拿到：
    throw preconditionSkip('编辑器拿不到焦点（真实输入会打到 body 上）——环境抖动，不算失败')
    main().then((c) => process.exit(c)).catch(fatal) // fatal 把它按 SKIP 结算（exit 0）
    ```

    运行器认得 `SKIP: 前置条件不满足` 前缀并记 **SKIP**（不是 FAIL、也不是 0 断言的 NOASSERT）；
    两侧字面口径由 `tests/tooling.test.mjs` 守着。

    **已知欠账**（实测清点 2026-09-26：`_verify|_regress|_repro` 前缀的套件 **110 个**，
    其中 **34 个**注入真实按键；已有守卫的 **15 个** —— `preconditionSkip` / `requireFocus` /
    `requireFrames` / `ensureFocus` / 窗口级 SKIP 各算一种，于是**剩 19 个没有任何守卫**）。
    清点命令（数字是量出来的，不是估的；口径与 `tests/tooling.test.mjs` 那条守卫逐字一致）：

    ```powershell
    Get-ChildItem tools -Filter "_*.js" | ? Name -match "^_(verify|regress|repro)-" |
      ? { Select-String -Path $_.FullName -Pattern "dispatchKeyEvent|pressKey\(|Input\.insertText" -Quiet } |
      ? { -not (Select-String -Path $_.FullName -Pattern "preconditionSkip\(|requireFocus\(|requireFrames\(|ensureFocus\(|SKIP: 没有可用窗口|SKIP: 9222 上已有" -Quiet) } |
      % Name
    ```

    收口方式：**改到谁就顺手迁谁**。已迁的样例：`_verify-inline-formats.js`（硬失败 →
    `preconditionSkip`）、`_verify-new-document.js`（Ctrl+N / Alt+F 两段用 `requireFocus`）、
    `_repro-rapidenter.js`（`ensureFocus` + `report.skip` → `requireFocus`）、
    `_verify-outline-nav.js`（自带出帧探测 → 骨架的 `framesAlive`）。
    那 19 个名字**同时写进了 `tests/tooling.test.mjs` 的欠账名单**：名单只减不增（加了守卫却
    不删登记会红，往上限之上加新名字也会红），所以"还剩多少"这件事不需要靠人记。

## 现状与迁移进度

<!-- facts:begin（由 tools/doc-facts.js 生成，勿手改）-->

- `tools/` 共 **217 个文件 / 62986 行**（`.js`/`.mjs`/`.ps1`/`.md`）；
- 套件文件 **128 个**（_regress-* 6 / _repro-* 9 / _verify-* 113），默认矩阵 **77 个**，分档：fast 77 / needs-build 46 / needs-dev 4 / manual 1；
- 另有 **12 个**探针/遗留脚本默认只列不判（`--probe` 显式跑）；
- 单元测试 **109 个** `tests/*.test.mjs`；Markdown 往返夹具 **33 份**（exact 17 / normalized 16）；
- `docs/manual/` **17 份 / 5875 行**，`docs/` 下共 **35 份** md。

<!-- facts:end -->

- 默认矩阵：见 `run-suites.js` 的 `DEFAULT_SUITES`（不 import `/src/...`、单实例能跑完、覆盖核心回归面），
  按档挑用 `--tier=fast`；全量用 `npm run test:suites:all`。
- 迁移进度：**改到谁迁谁**。迁移过的脚本会在文件头注明"已用 harness"；剩下的老脚本仍能跑，
  但新写的必须用 harness（这条由 review 把关，不加自动门禁 —— 自动检查"是否 import harness"
  会把一批历史脚本变成噪音）。

## 不在默认矩阵里的套件：**什么时候必须跑**（清单 §10 P1）

默认矩阵（`DEFAULT_SUITES`，60 条）是"纯合成事件、单实例能跑完、覆盖核心回归面"的那一批。
剩下 49 条按需跑 —— 但"按需"不等于"想不起来就跑"：下面这张表就是触发条件，
改动落在哪一块就顺手跑对应那条（`--suite=` 支持逗号分隔的多条）。

| 套件 | 触发条件 |
| --- | --- |
| `_verify-packaging-fast.js`（自管实例，端口 9225） | 改**主进程 / CSP / 资源协议 / 打包配置**之后：先 `npm run build:unpack`，再 `node tools/run-suites.js --suite=_verify-packaging-fast.js`。`package.yml` 打完包也会自动跑一次 |
| `_verify-packaging.js`（manual 慢组） | **发版前**手动：真打包 + exe 图标逐像素 + 文件关联双击 + 第二实例转发 + SHA256 |
| `_verify-link-open.js`（64 条断言） | 改链接解析 / `UNSAFE_TARGET_EXT` / 路径授权（`pathGrants`）之后 |
| `_verify-round-perf.js`（38 条） | 改编辑器渲染、大文档路径、代码块挂载策略之后 |
| `_verify-sidebar-tree-style.js`（32 条） | 改文件树样式之后（**窗口可见时跑**：被遮挡时不出帧，会如实 SKIP） |
| `_verify-cb-line-numbers.js` | 改代码块行号 / 装订线之后 |
| `_verify-keymap.js`、`_verify-open-file-dedup.js`、`_verify-open-file-routing.js`、`_verify-save-as-workspace.js` | 这 4 条 `import('/src/...')`，**必须先起 dev server（5173）**：`npm run dev` 另开一个终端，再 `node tools/run-suites.js --tier=needs-dev` |
| `_verify-notify-restart.js`（manual） | 人工三步：种一条通知 → 杀进程 → 重启后确认它还在（进程重启语义只能人看着验） |
| `_verify-image-ui.js`（13 条，自管实例；裸 CDP，端口取 `LUMIN_DEBUG_PORT`，默认 9333） | 改**图片交互**之后：居中 / 源码标记四态（点开·点别处·完全包住·边界切进）/ 悬浮工具栏（100/75/50/25、与源码行不相交）/ 缩放进源码（`<img … style="zoom:50%;" />`、原地更新不新增标签）/ 远程图无占位图标且未点击不发请求。跑法：`node tools/run-suites.js --suite=...` 不适用（它自管连接），直接 `LUMIN_DEBUG_PORT=9333 node tools/_verify-image-ui.js`（实例需已带 `--remote-debugging-port`） |

`--all` 一次跑完自动能跑的全部（109 条，含默认矩阵与上面这些）；`--probe` 单跑 7 个探针。
判定口径不因"按需"而放松：`FAIL` / `NOASSERT` 一律让命令非零退出，`FLAKY` 会单独列出来
（首次红、重跑绿），SKIP 如实计数、不算失败（清单 §1.C.1）。

## 常驻的测量/分析工具（**不是**套件，别删）

这些 `_probe-*` 刻意保留：它们是「改之前先量一遍」的尺子，清单里的性能项（O1/O2/O3、冷启动）
都靠它们做前后对照。清单 §2.I 收口时逐条核对过，其余一次性探针已删除。
默认矩阵每轮末尾会把它们**列出来但不判定**；想跑：`node tools/run-suites.js --probe`。

| 工具 | 用途 | 跑法 |
| --- | --- | --- |
| `_probe-startup.js` | 冷启动 / 内存基线：页面可见、首屏、编辑器就绪、RSS（三连跑取中位） | `node tools/_probe-startup.js` |
| `_probe-perf.js` | 打字每键耗时量化 + 热点定位 | `node tools/_probe-perf.js`（需隔离实例） |
| `_probe-fences-total.js` | 2000 围栏文档「装载 + 切面」全程 CPU 归因 | `node tools/_probe-fences-total.js` |
| `_probe-modeswitch.js` | 围栏文档「切到源码」耗时（性能回退的现场尺子） | `node tools/_probe-modeswitch.js` |
| `_probe-cpu-top.js` | 读 `.cpuprofile`，按 functionName + 位置聚合 self time | `node tools/_probe-cpu-top.js <profile>` |
| `_probe-md-baseline.js` | markdown-it 对照基准（CJK flanking 夹具的 strong 数量与内容） | `node tools/_probe-md-baseline.js` |

## 不产出断言的脚本：登记表（清单 §10「18 个一次性脚本没有归属」）

以前这批脚本**没有任何说明**：既不在矩阵里，也不在文档里，新人无法判断该跑哪个、该删哪个。
现在按用途分三类登记如下。判据是"**它还能回答什么问题**"，不是"它当下红不红"
（它们都不产出 `--- N/M PASS`，运行器不判它们 —— 见 `run-suites.js` 的 `probeSuites()`）。

**A. 长期有效（性能 / 目检的尺子，改动前后各跑一次）**

| 脚本 | 用途 |
| --- | --- |
| `_startup-bench.js` | 启动耗时基准（生产包）：从 spawn 到「文档可见」，逐窗口记时刻 |
| `_measure-latency.js` | 点/键延迟量化：按模式分段按钮逐个量下去（改交互前后对照） |
| `_shot-theme.js` | 取三主题界面截图（整窗 + 侧栏/工具栏），人工目检用（已用 harness） |
| `_shot-heading-badge.js` | 量 H1 徽章与标题文字的垂直居中并截图 |

**B. 一次性复现（问题若复发，直接复跑这条最小脚本）**

| 脚本 | 复现什么 |
| --- | --- |
| `_check-cm-drag.js` | 代码块内拖选是否真的产生非空选区 |
| `_check-heading-rule.js` | `# ` + 空格 → h1 的 input rule |
| `_check-table-edit.js` | 表格单元格定位后键入（`1` → `19`） |
| `_time-close.js` | `app.close()` 后窗口真正关闭的耗时（验证不再等 2.5s） |
| `_trigger-export.js` | 真实导出链路（`Ctrl+Shift+E` → `runExport('pdf')`，配 `LUMIN_PDF_TEST` 旁路对话框） |
| `_test-export-full.js` | 含 mermaid/表格/任务的文档走完整 `buildExportHtml` |
| `_test-mermaid.js` | `renderMermaidInHtml` 在真实渲染层上下文中（动态 import） |
| `_test-pdf.js` | 独立复现 `printToPDF`（隐藏窗口 + data URL），验证导出链路本身可用 |

**C. 手动调试小工具（查一份数据 / 一个窗口的状态）**

| 脚本 | 用途 |
| --- | --- |
| `_check-windowstate.js` | 读 SQLite 里的 `windowState`（窗口位置/大小持久化） |
| `_set-windowstate.js` | 写一个测试用 `windowState`（验证启动恢复） |
| `_check-new-window.js` | 连上指定 URL 的窗口，读它当前打开的文件（多窗口调试） |

**已删除**（内容已被矩阵内套件替代，或纯实验无输出约定）：`_btn-check.js`
（在 DOM 里按中文按钮文字点 `.mode-seg-btn` —— 换语言就整轮发红，已被
`_verify-segmented-control.js` 的 16 条断言替代）、`_exp-hidden.js`、`_exp-ta-hidden.js`
（纯实验脚本，0 断言、无输出约定；隐藏编辑面切换后的往返行为已由 `_verify-surfaces.js`
与 `_regress-*` 覆盖）。
