# 发布检查清单（RELEASE.md）

> 来源：审计 §9「[P2] 无发布流程文档与版本联动」。目标是让发版**照着做**就行，
> 而不是靠记忆 —— 每一步都写了"跑什么、看什么、什么算通过"。

## 0. 前置

- 目标平台：**Windows**（mac / Linux 未验证：`npm run build:mac|build:linux` 会明确拒绝，不会产出没验过的包）。
- 本地环境：Node 22（与 CI 的 `node-version: 22` 对齐）、能跑 Electron 的桌面会话。
- 需要签名时另见 `docs/electron-upgrade.md` 同目录的说明；**没有证书就不要签名**，
  也不要发明 `publish` 的仓库地址（占位 URL 会把"未签名"变成"更新报错"）。

## 1. 版本号（唯一来源）

- 版本号只写在 `package.json` 的 `version`（打包器直接吃它，`electron-builder.yml` 的
  `artifactName` 也吃它）。
- **CHANGELOG 必须有同名标题**：`## [x.y.z] - YYYY-MM-DD` —— 由
  `tests/docsFacts.test.mjs` 守着（没有这条标题，`npm run test:unit` 就红）。
- 发版那一步：把 `## [Unreleased]` 里的条目整理到新的 `## [x.y.z] - <日期>` 段下。

## 2. 全绿门禁（缺一不可）

```powershell
npm ci                       # 与 lockfile 完全一致
npm run ci                   # typecheck + lint(--max-warnings 0) + 单测 + notices:check + docs:facts:check + docs:tokens:check + build
npm run test:suites          # 默认矩阵（55+ 条 CDP 套件，起隔离实例）
```

- 文档数字若漂了：`npm run docs:facts:write` 重算后**一起提交**（别手改那些数字）。
- 设计令牌表（`docs/design-tokens.md`）同理：改了 `theme.css` / `sidebar.css` 之后跑
  `npm run docs:tokens:write`（CI 里由 `docs:tokens:check` 与 `tests/designTokens.test.mjs` 守着）。
- 依赖变了：`npm run notices` 重算 `THIRD-PARTY-NOTICES.md`（`notices:check` 会拦）。

## 3. 打包

```powershell
npm run build:unpack         # 只出目录（快：先确认能起来）
npm run build:win            # 出安装包（NSIS）
```

产物与校验和：

```powershell
Get-ChildItem dist\*.exe | Get-FileHash -Algorithm SHA256
```

- 把 `文件名 + SHA256` 写进 release notes（测试者据此核对下载是否完整）。
- 打包产物里必须带上 `THIRD-PARTY-NOTICES.md`（合规）：`npm run test:suites:all` 里的
  `_verify-packaging.js`（manual 档）会验"真打包 + 启动 exe + 打包态 CSP"。

## 4. 冒烟清单（人工，10 分钟）

| #   | 动作                       | 期望                                                                     |
| --- | -------------------------- | ------------------------------------------------------------------------ |
| 1   | 双击安装包 → 安装 → 启动   | 窗口出现、无未签名拦截以外的报错                                         |
| 2   | 首次启动                   | 没有工作区时是空态而不是报错                                             |
| 3   | 打开一个文件夹工作区       | 文件树列出 `.md`，点开能编辑                                             |
| 4   | 打字 → Ctrl+S              | 状态栏从"未保存"到"已保存"，磁盘内容一致                                 |
| 5   | 关窗再启动                 | 恢复上次文档与光标（`restoreSession` 默认开）                            |
| 6   | 粘贴一张截图进正文         | 图片落在 `<工作区>/assets/`，能渲染（见 `_verify-image-insert.js`）      |
| 7   | 导出 PDF 一次              | 生成的文件能打开、中文不乱码                                             |
| 8   | 设置 → 高级 → 复制诊断信息 | 复制到一段**不含文档内容**的环境事实                                     |
| 9   | 帮助 → 关于                | 版本与 `package.json` 一致、第三方许可能展开                             |
| 10  | 卸载                       | 卸载后用户数据目录按预期保留/清理（见 `docs/packaging-install-test.md`） |

## 5. 已知的"不要做"

- **不要**在没有真实仓库地址时打开原生菜单里的「打开项目主页」（`menu.homepage` 键留着但菜单项注释着）。
- **不要**把 `publish` 填成占位 URL：那会让自动更新在用户侧报错。没有更新渠道时，
  设置里的「自动检查更新」保持关闭（默认就是关的）。
- **不要**在没跑 `npm run test:suites` 的情况下发版：CI 只覆盖类型/风格/单测/构建，
  真正会坏的那半边（布局、同步、快捷键、文件树、导出）全在 CDP 套件里。
