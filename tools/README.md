# tools/ —— 验收脚本的写法约定

> 来源：自查报告 **S1**。现状是 `tools/` 有 145 个文件 / 约 31,000 行，比 `src/`（约 27,000 行）还大；
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

## 现状与迁移进度

- 默认矩阵：见 `run-suites.js` 的 `DEFAULT_SUITES`（不 import `/src/...`、单实例能跑完、覆盖核心回归面）。
- 全量：`npm run test:suites:all`（74 个 `_verify-*` + 6 个 `_regress-*` + 9 个 `_repro-*`）。
- 迁移进度：**改到谁迁谁**。迁移过的脚本会在文件头注明"已用 harness"；剩下的老脚本仍能跑，
  但新写的必须用 harness（这条由 review 把关，不加自动门禁 —— 自动检查"是否 import harness"
  会把一批历史脚本变成噪音）。
