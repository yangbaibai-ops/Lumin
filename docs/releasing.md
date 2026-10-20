# 发版流程（Release）

> 目标：任何维护者照这三步都能产出一个可下载、可核对、可回滚的 Windows 版本。
> 版本号唯一来源是 `package.json` 的 `version`；本轮保持 **1.0.0**，不跟着提交节奏升版。

## 发版三步

### 1. 改版本号并整理变更

1. 把 `package.json` 的 `version` 改成 `x.y.z`（例如 `1.0.0` → `1.1.0`）。
2. 在 `CHANGELOG.md` 顶部加同名标题：`## [x.y.z] - YYYY-MM-DD`，并把 `[Unreleased]`
   里的条目整理进去。`tests/docsFacts.test.mjs` 会检查这个标题存在。
3. 提交这次版本变更（建议单独一个 `chore(release): x.y.z` 提交），确认 `git status` 干净。

### 2. 构建安装包

```powershell
npm ci                 # 严格按 package-lock.json 安装
npm run ci             # 类型 / 风格 / 单测 / 许可声明 / 文档数字 / 设计令牌 / 生产构建
npm run build:win      # NSIS 安装包，产物在 dist/
```

产物至少应包含：

- `dist/Lumin-x.y.z-setup.exe`（NSIS 安装包）
- `dist/latest.yml`（自动更新元数据；即使当前 `publish` 还是占位地址也会生成）
- `dist/Lumin-x.y.z-setup.exe.blockmap`（增量更新块索引）

可选：先跑 `npm run test:suites` 过一遍默认 CDP 矩阵；发版前按下文“冒烟”至少手动点一遍。

### 3. 打 tag 并在 GitHub Release 上传

```powershell
git tag vx.y.z
git push origin main --tags
```

推送 `v*` tag 会触发 `.github/workflows/release.yml`（`windows-latest`）：
`npm ci` → `npm run build:win` → 用 `GITHUB_TOKEN` 创建 GitHub Release 并上传
`dist/Lumin-*-setup.exe`、`dist/latest.yml`、`dist/*.blockmap`。**不需要配置任何密钥**。

如果 CI 不可用，也可以手动建 Release，把上面三个文件拖进去，文件名不要改：

- 安装包与 `latest.yml` 必须同名同版本，否则 `electron-updater` 找不到更新。
- `latest.yml` 里的 `sha512` 由 electron-builder 生成，不要手改。
- 在 Release 说明里附上 `SHA256SUMS.txt`（CI 的 Package workflow 会产出）。

## 发版后核对

- [ ] Release 页能下载到 `.exe`、`latest.yml` 与 `.blockmap`。
- [ ] 安装包能安装、启动，版本号与 `package.json` 一致。
- [ ] “帮助 → 关于”里的版本与下载页一致。
- [ ] 卸载后 `%APPDATA%\Lumin` 里的用户数据仍在（`deleteAppDataOnUninstall: false`）。
- [ ] 已知限制没有变化：安装包**未签名**，SmartScreen 会提示“未知发布者”；
      macOS / Linux 仍未验证；自动更新渠道仍为占位。

## 不要做的事

- 不要把 `version` 只改在 tag 上而不改 `package.json`：打包器读的是后者。
- 不要手工编辑 `latest.yml` 或 `app-update.yml`。
- 不要在 `publish` 还是占位地址时对外宣称“支持自动更新”。
- 不要把 `CSC_LINK` / `CSC_KEY_PASSWORD` 写进仓库；签名只通过环境变量注入。
