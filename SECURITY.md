# 安全策略（SECURITY.md）

> 来源：审计 §10 P2「无 CODEOWNERS / CONTRIBUTING / SECURITY」。这份文档回答三个问题：
> **漏洞怎么报**、**哪些版本被支持**、**哪些已知问题是外部的、短期不会修**。
>
> 最后一条尤其重要：把一个"卡在证书/仓库地址上"的已知项当成新漏洞反复报，
> 对双方都是浪费 —— 所以下面**明说**。

## 支持的版本

| 版本 | 状态 |
| --- | --- |
| `1.0.x`（当前 `main`） | ✅ 接收安全报告并会处理 |
| 更早的版本 / 自己改过的分支 | ❌ 不支持，请先复现到当前 `main` 或最新打包版 |

**平台**：只验 **Windows 10/11**。macOS / Linux **未验证**（`npm run build:mac|build:linux`
会明确拒绝产出安装包，而不是发一个没验过的包）。在未验证平台上发现的问题我们**收**，
但不会优先修 —— 那属于"支持范围之外"，不是安全响应。

## 怎么报漏洞

**请用 GitHub Security Advisories 私下报告**：
<https://github.com/yangbaibai-ops/Lumin/security/advisories/new>

这是当前**唯一**的私密报告渠道 —— 本仓库是个人项目，没有 PGP key 或 bug bounty。
**请勿在公开 Issue 里贴漏洞细节**（复现步骤、概念验证、受影响文件都不要贴）；
如果只是想先打个招呼，可以开一个只写「我想报告一个安全问题，请给一个私密渠道」的
issue，**不写细节**。

Advisory 里请尽量带上：

1. 影响版本（应用内「帮助 → 关于」里的版本号；打包版还是开发态）；
2. 平台（Windows 10/11）+ 是不是打包版；
3. 复现步骤；
4. 影响判断：能读到你**本来无权访问**的文件吗？能执行代码吗？能绕过哪个校验？
5. 概念验证（如有）。

> ⚠️ 上面的链接是 GitHub 的「私密漏洞报告」入口：内容只有仓库维护者可见，修复发布前不公开。
> **不要**把未修复的漏洞细节贴进公开 issue。
>
> **也不要贴真实文档内容 / 最近文件清单**：诊断信息（设置 → 高级 →「复制诊断信息」）
> 刻意不含这两项，贴日志时请照此裁剪。

**我们会做什么**（个人项目，尽力而为、不承诺 SLA）：收到 Advisory 后 7 天内回一条确认；
确认可复现后给出修复计划或"已知/不修"的判断；修好并在 `CHANGELOG.md` 里记一句
（除非你要求匿名）。请给我们**修复窗口再公开**。

## 哪些是**已知的 / 外部的**（不是新漏洞，别重复报）

这几项在 `README.md`「已知限制与路线（诚实清单）」与 `RELEASE.md` 里已经登记，
成因全部**在仓库之外**：

1. **没有代码签名**：Windows 会提示"未知发布者"。**不是缺陷，是缺证书** ——
   仓库不会为了好看而假签名或发明证书信息。
2. **自动更新是占位**：`dev-app-update.yml` 的 `url` 是 `https://example.com/auto-updates`
   （`electron-builder.yml` 的 `publish` 同为占位），**更新渠道不存在**。
   刻意留占位而不写一个看起来像真的地址 —— 那样只会把"未签名"变成"更新报错"。
   这意味着：**当前没有远程更新通道，也就没有"更新被劫持"这一类攻击面**；
   同时也意味着请**从你信任的来源**获取安装包，并自行核对 `SHA256SUMS.txt`
   （打包 job 会连同工件一起产出 `dist/SHA256SUMS.txt`）。
3. **Electron 版本落后 / 已 EOL**：实装 39.8.10（`package.json` 的 `^39.2.6` 锁在 39），
   Electron 39 已于 **2026-05-05 EOL**，Chromium 落后约 10 个大版本。
   因此**上游已公开、已在受支持 major 里修掉的 Chromium 漏洞，本应用可能仍然受影响** ——
   这是我们知情并已登记的技术债（复验清单见 `docs/electron-upgrade.md`），
   欢迎提"请升级 Electron"的 issue，但**它不算未知漏洞**；升级是单独分支 + 跑完整矩阵的事。
4. **macOS / Linux 未验证**：见上「支持的版本」。跨平台渲染问题（字体、路径大小写、
   文件关联）在那边属于"未支持"，不是安全缺陷。
5. **验收套件需要真实桌面会话、且会起隔离实例**：`tools/_verify-*.js` 连的是本机 CDP 端口。
   默认起隔离实例并给临时 `--user-data-dir`；**手工调试时请照 `README.md`「开发约定」第 4 条
   自己起隔离实例**，不要让你正在用的那份 profile 暴露在调试端口上。

## 我们认真对待的攻击面（报这些很有价值）

- **路径授权**：`src/main` 的路径校验与 `pathGrants`（打开外部链接、`lumin-file://` 协议、
  文档内相对图片）。绕过它去读/写授权目录之外的文件是高优先级问题。
- **IPC 边界**：preload 暴露的通道是否被渲染层滥用（应只有白名单里的 `invoke`）。
- **渲染层注入**：Markdown 里的 HTML / 链接是否被当作可执行内容处理；
  导出链路（HTML/PDF）是否把不可信内容带进可执行上下文。
- **CSP 与打包态**：打包态（`dist/win-unpacked/Lumin.exe`）的 CSP 必须和 dev 一致地被守住 ——
  这正是 `_verify-packaging-fast.js` 断言的那几条（CSP / `lumin-file://` 图片 / asar 懒加载）。
- **写盘安全**：绕过 `fileOps.writeFile`（临时文件 + fsync + rename 的原子写）导致的
  数据损坏或部分写入。
- **依赖与供应链**：`package-lock.json` 之外的代码进入构建；
  CI action 的可变性 —— workflow 里的 `uses:` 已 pin 到 commit SHA，请连同 `.github/dependabot.yml`
  的 `github-actions` 条目一起看。

## 我们的安全工程口径（可复核）

- **最小权限**：三个 workflow 都显式 `permissions: contents: read`。
- **action pin 到 SHA**：用可变标签（`@v4`）时，标签被移动 / 仓库被接管会让同一条 workflow
  静默跑另一份代码；pin 到 40 位 SHA 后由 dependabot 的 PR 来更新，diff 在评审里可见。
- **不发明占位 URL / 不假签名**：`publish` 与 `dev-app-update.yml` 保持明显的占位值。
- **用户数据默认不外泄**：诊断信息不含文档内容与最近文件清单；
  主进程日志写入 `<userData>/logs`（`src/main/services/appLog.ts`），不自动上报。
- **诚实清单**：`README.md` 的「已知限制」表是**结论而非承诺**，数字有测试对账
  （`npm run docs:facts:check`）—— 我们会把没做的事写出来。

## 致谢

修好的报告会记进 `CHANGELOG.md`（除非你要求匿名）。谢谢。
