# Electron 升级评估（审计 §5 P0「Electron 39 已 EOL」）

> 结论先说：**该升，但必须单独一条分支、按下面的清单逐项复验**。
> 本文登记的是**实测事实 + 升级要复验什么**，不是"已经升好了"。

## 1. 现状（实测）

| 项 | 值 | 怎么测的 |
|---|---|---|
| `package.json` 声明 | `"electron": "^39.2.6"` | `package.json` 的 devDependencies |
| **实装版本** | `39.8.10` | `node_modules/electron/dist/version` |
| Chromium | `142.0.7444.265` | 应用内「复制诊断信息」/ `process.versions.chrome` |
| Node | `22.x` | 同上 |
| EOL | **2026-05-05**（39 已不在支持窗口内） | Electron 官方只维护最新 3 个 stable major |

`^39.2.6` 这个范围**永远升不到 40**：主版本被 `^` 锁死在 39。

## 2. 为什么这条是 P0

产品**解析的是用户/第三方 Markdown 与本地文件**，而内嵌浏览器（Chromium）在 39 那个分支上的
已知 CVE 不会再被修。渲染层又有 `lumin-file://` 协议与 `data:`/`blob:` 图片通路 ——
这些正好是"旧 Chromium + 用户内容"的组合。

## 3. 升级要怎么升（步骤）

1. **单独分支**：`chore/electron-<major>`。不要在功能提交里顺手升 ——
   这类升级的失败模式是"某处悄悄变了行为"，混在一起根本定位不了。
2. 改 `package.json` 的 `electron` 与（如果需要）`electron-builder`、`electron-vite`；
   `npm install` 后确认 `node_modules/electron/dist/version` 真的变了。
3. **按顺序跑**（每一步都要绿，不要跳到下一步）：
   ```powershell
   npm run ci
   npm run test:suites            # 默认矩阵
   npm run test:suites:all        # 全量（含 dev 档与 manual 档）
   ```
4. 重点复验（这些是最容易被 Chromium/Node 升级影响的）：
   - `lumin-file://` 协议与 `data:`/`blob:` 图片（`_verify-local-media`、`_verify-remote-image`、`_verify-image-insert`）；
   - CSP（`src/shared/csp.ts` 的单一真相源 + 打包态断言，见 `_verify-packaging.js`）；
   - 原生对话框与剪贴板（`file:chooseImage` / 粘贴图片）；
   - 打印导出（`printToPDF`，`_verify-*` 里没有自动覆盖 → 手动跑 RELEASE.md 冒烟第 7 条）；
   - 任务栏跳转列表（`_verify-taskbar-jumplist`，Windows 专属 API）；
   - 单实例锁与会话恢复（`_verify-single-instance`、`_verify-session*`）。
5. 升级完成后：更新本文的"现状"表、`README.md` 的已知限制表、以及 CHANGELOG。

## 4. 为什么不在这一轮直接升

- 它是**平台级**改动：Electron 主版本会同时动 Chromium / Node / V8，
  而本仓库的验证面（43 条默认套件 + 大部分要真实桌面会话）不是一次 `npm test` 能覆盖的；
- 审计自己给的建议也是"独立分支，跑完整矩阵"；
- 在没有把握一次全绿的情况下硬升，风险是**把可用的编辑器换成崩的编辑器** ——
  与"逐项优化、每波可复跑"的推进口径冲突。

所以这一轮的交付是：**把事实登记清楚 + 给出一条可执行的升级路径**，
并把版本漂移做成可见的（见 `tests/electronVersion.test.mjs`：本文记录的版本必须与
`node_modules/electron/dist/version` 一致，不一致就红 —— 免得文档慢慢过期而没人知道）。
