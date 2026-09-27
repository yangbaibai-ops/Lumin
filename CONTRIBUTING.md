# 贡献指南（CONTRIBUTING.md）

> 来源：审计 §10 P2「无 CODEOWNERS / CONTRIBUTING / SECURITY」。目标是让**外部贡献者不用猜**：
> 怎么把项目跑起来、改完要跑什么、什么算通过、提交信息写成什么样。
>
> 这份文档里凡是**已有唯一真相源**的东西（门禁命令、套件规矩）都只**引用**、不复述 ——
> 复述出来的副本一定会漂（`ci.yml` 的头部注释就为这件事写过一段检讨）。

## 1. 环境要求

- **Node `>= 22 <25`**（`package.json` 的 `engines`；CI 用 `node-version: 22`）。
- **Windows 10/11**：目标平台只有 Windows（见下「支持范围」）。mac / Linux 能读代码，
  但 `npm run build:mac` / `build:linux` 会**明确拒绝**而不是产出一个没验过的包
  （`tools/refuse-unverified-platform.js`）。
- 一个**能跑 Electron 的桌面会话**：验收套件（CDP）要真实窗口、真实焦点，不能在无头容器里跑。

## 2. 跑起来

```powershell
npm ci                 # 严格按 package-lock.json 装（CI 用的就是它，别用 npm install 交 PR）
npm run dev            # 开发模式（主进程 --watch 热重载，渲染层 HMR）
npm run dev:isolated   # 同上，但用独立 profile（不碰你正在用的那套数据）
npm run build          # 类型检查 + 构建到 out/
```

- **单实例**：应用同一时刻只允许一个实例。你的 `npm run dev` 还开着时再跑一次会**立刻退出**并把
  参数转交给已在运行的那个实例 —— 这不是崩溃。开发时想同时开第二个实例请用 `npm run dev:isolated`。
- **绝不碰用户数据**：调试/验收一律走临时目录或隔离实例，理由与踩过的坑见 `README.md`「开发约定」第 4 条。

## 3. 改完必须跑的四条

```powershell
npm run typecheck      # tsc（主进程/preload）+ vue-tsc（渲染层），双工程
npm run lint           # ESLint flat config；0 error / 0 warning 是门槛（阈值写在脚本里，不是命令行参数）
npm run test:unit      # node --test：纯逻辑单元测试（tests/*.test.mjs）
npm run ci             # 上面这些 + notices:check + docs:facts:check + docs:tokens:check + electron-vite build
```

`npm run ci` 是**权威口径**：`.github/workflows/ci.yml` 与 `package.yml` 跑的都是同一批门禁，
「CI 与本地一致」这件事由注释与脚本对齐，而不是靠人记。想只跑单元测试：

```powershell
npm run test:unit                                   # 等价于 package.json 里那条
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "tests/*.test.mjs"
```

## 4. 验收套件（CDP）—— 按需跑，口径不放松

统一入口是 `node tools/run-suites.js`（矩阵、隔离实例、解析 `--- N/M PASS`）：

```powershell
node tools/run-suites.js            # 默认矩阵（不需要 dev server）
node tools/run-suites.js --suite=_verify-packaging-fast.js   # 点名跑
node tools/run-suites.js --all      # 全量（多数需要 5173 上的 dev server）
npm run test:suites                 # 等价于第一条
```

**写新套件之前请先读 `tools/README.md`**：它列了 12 条硬性规矩（必须产出断言、退出码要诚实、
不许自己写 CDP 连接、SKIP 不算失败、打包态要对着产物跑、靠真实按键的套件拿不到前置条件要
`preconditionSkip` 而不是 `throw`……），以及"哪些套件什么时候必须跑"的触发条件表。
**这里不复制那些规则**（复述必漂），只强调三条最容易犯的：

1. 新脚本**只许用 `tools/lib/harness.js`** 这一层，别再各抄一份连接/断言骨架。
2. 只打印、`exit 0`、零断言的脚本会被运行器判 **NOASSERT 并让整轮失败**。
3. 改到哪块就顺手跑对应那条套件（`tools/README.md` 有"改动 → 必须跑的套件"对照表）；
   `_verify-packaging-fast.js` 必须**先** `npm run build:unpack` 再跑。

> **CDP 套件有意不进 push/PR 门禁**：它们需要真实桌面会话，在 runner 上可能不稳。
> 夜间 job（`.github/workflows/cdp.yml`）只跑可测量的子集且 `continue-on-error`，**不阻塞合并**。

## 5. 提交信息

- 格式：**Conventional Commits** —— `feat(scope): …` / `fix(scope): …` / `docs` / `refactor` / `test` / `chore`，
  便于汇出 `CHANGELOG.md`。scope 用改动落点（`editor` / `tree` / `export` / `ci` …）。
- **正文写中文、写详细**（本仓库的既有风格）：说清「**为什么**改」而不只是「改了什么」——
  引用了哪个审计项/清单编号、复现路径是什么、为什么选这个方案而不是那个。
  一个可对照的真实例子：`.github/workflows/ci.yml` 头部的注释，把「曾经自称一致却漏跑三条门禁」
  这件事完整写在了文件里。
- **一次一波**：不做"顺手把别的也改了"的提交。每波结束必须留下**可复跑的数字**
  （套件 `--- N/M PASS` 或命令 exit code）——这是 `README.md`「开发约定」第 1 条。
- 改了 `src/` 的行为请同时更新 `CHANGELOG.md` 的 `## [Unreleased]` 段。

## 6. 什么算"可以合并"

- [ ] `npm run ci` 全绿（exit 0）。
- [ ] 行为有改动 → 有对应的单测或验收套件断言；**没有断言的改动不算验过**。
- [ ] 改了 `src/**` 的对外行为 / 文档里的数字 → `npm run docs:facts:write` 或 `docs:tokens:write`
      重算后**一起提交**（别手改那些数字，`npm run docs:facts:check` 会拦）。
- [ ] 依赖变了 → `npm run notices` 重算 `THIRD-PARTY-NOTICES.md`（`notices:check` 会拦）。
- [ ] 中文文本文件一律 **UTF-8 无 BOM**（`.ps1` 例外，必须带 BOM）；
      **不要用 PowerShell 的 `Get-Content`/`Set-Content` 往返改源码** —— 会把 UTF-8 变成 mojibake，
      而且 `eslint` / `tsc` / `build` **全绿也发现不了**（`tests/encodingGuard.test.mjs` 就是为那次事故立的）。
      改源码用 Node 脚本（`fs.readFileSync(f,'utf8')` + 字面量替换 + `writeFileSync(f,t,'utf8')`）。

## 7. 需要更多背景时看哪里

- `README.md` —— 功能、目录结构、质量门禁、**已知限制与路线（诚实清单）**、开发约定。
- `tools/README.md` —— 验收脚本的三层结构、12 条硬规矩、套件矩阵与触发条件。
- `RELEASE.md` —— 发版检查清单（版本号唯一来源、全绿门禁、打包、冒烟）。
- `docs/manual/` —— 工程手册（含组件清单 `09-components.md`）。
- `SECURITY.md` —— 漏洞怎么报、支持范围、哪些是已知的外部 blocker。

## 8. 支持范围与行为准则

- 支持范围、已知限制（未签名 / Electron EOL / mac·Linux 未验证）见 `SECURITY.md`。
- 提交 PR 即表示同意：讨论对事不对人；不提交来源不明的大段代码；
  不把用户数据（文档内容、最近文件清单）贴进 issue —— 见下。

**报 Bug 时不要贴真实文档内容**：诊断信息（设置 → 高级 → 复制诊断信息）**刻意不含**文档内容与
最近文件清单，需要贴日志时请照此裁剪。用 `.github/ISSUE_TEMPLATE/bug_report.yml` 模板。

## License

MIT · 贡献即按 `LICENSE` 授权。
