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
| E2E（CDP） | `tools/run-suites.js` + `tools/lib/harness.js`（79 个套件文件） | 在**隔离实例**（临时 userData + 调试端口）里驱动真实页面：编辑面往返、文件树、会话恢复、导出、主题、无障碍、i18n 三语、窗口与通知…… | 本地按需：默认矩阵 43 条，`--all` 全量 |
| 打包 | `_verify-packaging.js`（manual 档） | 真打包 + 启动 exe + 打包态 CSP | 发版前手动 |

**CI 跑什么、不跑什么、为什么**：`.github/workflows/ci.yml` 只跑类型/风格/单测/构建 ——
CDP 套件需要真实桌面会话（窗口焦点、单实例锁、真实按键），在无头 runner 上不稳，硬跑只会
制造"没人再信的红灯"。为此另有一条**不阻塞 PR** 的夜间 job（`.github/workflows/cdp.yml`），
跑 `--ci-subset`：由**可测量判据**推出的一批套件（源码里不出现 `dispatchKeyEvent` /
`dispatchMouseEvent` / `Input.insertText` 的那些），失败只通知不拦合并。

套件自身的口径（这几条是README「质量门禁」的展开，也是踩过的坑）：
`NOASSERT`（一条断言都没产出的套件）与 `FAIL` 一样让命令失败；缺失的套件名会让命令失败而不是被静默丢弃；
环境不满足（窗口拿不到焦点、没出帧）**如实 SKIP**，SKIP 不算失败；首次红、重跑绿记 `FLAKY` 并单独列出。
分档（fast / needs-build / needs-dev / manual）与探针普查（`_probe-*`、`verify-tiptap.js`）在
`run-suites.js` 里是数据，`tests/tooling.test.mjs` 守着它们不漂。

> 历史说明：`tools/verify-tiptap.js`（1473 行 / 百余条具名断言）是早期唯一的 CDP 资产，
> **已弃用**（不在任何矩阵里；它守的气泡菜单 / input rules / 标记符 / 表格 / 粘贴已由默认矩阵里的
> `_verify-inline-formats`、`_regress-cb`、`_verify-table-fidelity`、`_verify-md-fidelity`、
> `_verify-link-paste` 等接管）。它的硬编码绝对路径已改成 `%TEMP%` + `LUMIN_TIPTAP_DIR`，
> 想跑仍需要 `npm run dev` 起的 dev 实例。**不要再把它当 E2E 层的证据引用。**


### 6.3 性能策略

- 序列化只在防抖窗口末尾执行一次（250ms），不随每次击键跑全文档；
- SQLite 写盘 500ms 防抖 + WAL（读不阻塞写）；
- 大纲/字数统计用 `descendants` 单次遍历；
- CodeMirror 实例按代码块惰性创建，mermaid 动态 `import`。

### 6.4 安全基线

- 渲染进程无 Node 权限：`contextIsolation: true`、`nodeIntegration: false`、preload 白名单桥接；
- CSP 白名单 + `lumin-file://` 协议隔离本地资源；
- 打开文件只读自己的工作区根目录。

---
