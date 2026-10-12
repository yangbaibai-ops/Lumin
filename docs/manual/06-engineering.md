<!-- 本文件由 docs/typora-wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

## 6. 工程化与质量保障

### 6.1 类型与静态检查

- 双 tsconfig：`tsconfig.node.json`（main/preload）+ `tsconfig.web.json`（renderer，vue-tsc）；
- `npm run typecheck` 进 CI；`prettier` + `eslint` 统一风格；
- 扩展装配处的类型注意点：`@tiptap/extension-table` 无默认导出（具名导入）；v3 的 InputRule 是配置对象 API（从 `@tiptap/core` 导入 `InputRule`/`textblockTypeInputRule`）。

### 6.2 测试分层

| 层 | 工具 | 覆盖 | 多久跑 |
|---|---|---|---|
| 单元 | `node --test`（`tests/*.test.mjs`，三百多条断言） | 纯函数与数据规则：草稿/会话/编码/行尾/内联标记/表格对齐/查找替换/大文档降级/语言包与 IPC 契约/路径与授权闸/工具链自检 | 每次 `npm run ci` |
| 静态门禁 | 三条（`docsClaims` / `encodingGuard` / `i18nHardcoded`+`i18nKeys`+`tooling`） | 文档不许出现已移除功能且引用的路径必须存在；`.ps1` 含非 ASCII 必须有 BOM；界面文案不得硬编码中文、语言包不得有死键；套件清单与分档不许漂 | 每次 `npm run ci` |
| E2E（CDP） | `tools/run-suites.js` + `tools/lib/harness.js`（**130 个套件文件**，实测；`--all` 收录 129，**默认矩阵 **78 条****，`manual` 档 1 条要人工介入） | 在**隔离实例**（临时 userData + 调试端口）里驱动真实页面：编辑面往返、文件树、会话恢复、导出、主题、无障碍、i18n 三语、窗口与通知…… | 本地按需：默认矩阵 **78 条**，`--all` 全量 |
| 打包 | `_verify-packaging-fast.js`（**快组**，自管实例端口 9225；`needs-build` 档） | 只对着 `dist/win-unpacked` 产物：`<meta>` CSP 逐字等于 `shared/csp.ts`、CSP 真的拦远程 `connect-src`、`lumin-file://` 本地图片能显示、asar 里的懒加载 chunk 可用、`app.isPackaged` 为真 | 发版前 / 改到主进程与 CSP 时：先 `npm run build:unpack`，再 `--suite=_verify-packaging-fast.js` |
| 打包（慢组） | `_verify-packaging.js`（manual 档） | 真打包全链路：exe 内嵌图标逐像素、裸路径参数、第二实例转发、NSIS 产物与 SHA256、配置单一来源 | 发版前手动 |

**CI 跑什么、不跑什么、为什么**：`.github/workflows/ci.yml` 跑类型/风格/单测/**许可声明与
文档数字三道门禁**/构建（与本地 `npm run ci` 逐条对齐，审计 §10 P2 指出过这里少跑三条）——
CDP 套件需要真实桌面会话（窗口焦点、单实例锁、真实按键），在无头 runner 上不稳，硬跑只会
制造"没人再信的红灯"。为此另有一条**不阻塞 PR** 的夜间 job（`.github/workflows/cdp.yml`），
跑 `--ci-subset`：由**可测量判据**推出的一批套件（源码里不出现 `dispatchKeyEvent` /
`dispatchMouseEvent` / `Input.insertText` 的那些），失败只通知不拦合并。
另外 `.github/workflows/package.yml` 打完包会跑一次 `_verify-packaging-fast.js`（打包态那几条
只有对着产物才有意义，见上表；没有产物时套件自己如实 SKIP）。

套件自身的口径（这几条是README「质量门禁」的展开，也是踩过的坑）：
`NOASSERT`（一条断言都没产出的套件）与 `FAIL` 一样让命令失败；缺失的套件名会让命令失败而不是被静默丢弃；
环境不满足（窗口拿不到焦点、没出帧）**如实 SKIP**，SKIP 不算失败；首次红、重跑绿记 `FLAKY` 并单独列出。
分档（fast / needs-build / needs-dev / manual）与探针普查（`_probe-*`）在
`run-suites.js` 里是数据，`tests/tooling.test.mjs` 守着它们不漂。

> 历史说明：`tools/verify-tiptap.js`（1488 行 / 85 条具名断言）是早期唯一的 CDP 资产，**已删除**——
> 它不在任何矩阵里、换机不可跑（清单 §10 P0）。它的独有覆盖先补进默认矩阵
> （新增 `_verify-input-rules.js`：块级快捷输入 `# `/`- `/`1. `/`> `/围栏、任务列表与
> Markdown 链接两条自研规则、回车与退格语义、表格按钮的两条入口），其余部分早已由
> `_verify-inline-formats`、`_regress-cb`、`_verify-table-fidelity`、`_verify-md-fidelity`、
> `_verify-link-paste` 等接管（git 历史仍可查）。
> 它守的键语义口径留在 `_verify-input-rules.js` 的 D 段里，不要再引用那个文件名当证据。


### 6.3 性能策略

- 序列化只在防抖窗口末尾执行一次（250ms），不随每次击键跑全文档；
- SQLite 写盘 500ms 防抖 + WAL（读不阻塞写）；
- 大纲/字数统计用 `descendants` 单次遍历；
- CodeMirror 实例按代码块惰性创建，mermaid 动态 `import`。

### 6.4 安全基线

- 渲染进程无 Node 权限：`contextIsolation: true`、`nodeIntegration: false`、preload 白名单桥接；
- CSP 白名单 + `lumin-file://` 协议隔离本地资源；
- 打开文件只读自己的工作区根目录。

### 6.5 依赖体检

审计 §5 的几条（registry 隐式指向第三方镜像 / Node 版本口径不一 / 生产链路里的弃用包）
现在的口径与判据：

- **依赖源**：项目根有 `.npmrc`，显式声明 `registry`（默认 npmmirror —— 国内网络下 `npm ci`
  从几分钟降到几十秒）。完整性由 lockfile 的 `integrity`（sha512）保证：镜像改了内容 npm 会拒绝安装。
  `tests/dependencyPolicy.test.mjs` 守住"lock 里每个 tarball 的主机 == `.npmrc` 配的 registry"
  且每条都有哈希 —— 换源时不可能漏改 lock。
- **Node 版本**：`package.json` 的 `engines.node` 是**有界**范围 `>=22 <25`（此前是 `>=22`：
  本机跑 Node 26 也叫"符合声明"，但产物并不保证能跑）。同一条测试会对账三份 workflow 里的
  `node-version`，越界即红。
- **已弃用包**：以 lockfile 的 `deprecated` 字段为准，名单**只减不增**（新增一个就红，
  逼着人当场决定换掉还是写下原因）。当前 5 个：
  `boolean`（打包期生产依赖，上游未换）、`lodash.isequal`（electron-updater 的生产依赖，
  作者建议改用 `node:util.isDeepStrictEqual` 但未发新版）、`glob` / `inflight` / `rimraf`
  （仅 dev 链路，等上游升级）。

**联网实测（2026-09-26，`npm outdated` / `npm view`）**：`electron` 已装 39.8.10、最新 **44.4.5**
（落后 5 个大版本，Chromium 相应落后 —— 这是本清单里**最大的已知风险**，升级涉及原生依赖与
全套 CDP 矩阵，必须单独分支，计划与复验步骤见 `docs/electron-upgrade.md`）；`mermaid`
11.17.2 → 12.0.0、`eslint` 9.39.4 → 10.11.0、`@types/node` 22.20.1 → 26.6.3（与运行时版本口径
不一致，属于"类型定义超前"）、`katex` 0.18.5 → 0.18.9、`iconv-lite` 0.6.3 → 0.7.3，
其余多为补丁级更新。

**环境限制（诚实登记）**：本机 npm 被策略禁用了远程包获取（安装时报
`EALLOWREMOTE ... Fetching packages of type "remote" have been disabled`，只有 registry 读操作
可用）。因此**所有会改动 lockfile 的动作**都没在这一轮做：把 `electron` / `electron-builder`
的 `^` 收成 `~`、用 `overrides` 顶掉上面的弃用包、统一两份 KaTeX、以及 Electron 大版本升级 ——
它们都需要一次能联网的 `npm install`（`npm install --package-lock-only` 也行）来同步 lock。
在能联网的环境里，命令与顺序是：

```powershell
# ① 收紧规格（package.json）→ ② 同步 lock → ③ 跑门禁
npm install --package-lock-only
npm run ci
```

> 现在 package.json 与 package-lock.json 的依赖规格**是一致的**（`npm ci` 可跑）——
> 改动规格却不重生成 lock 会让 `npm ci` 直接失败，所以那一半必须与 lock 一起提交。

---
