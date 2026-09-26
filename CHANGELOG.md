## [Unreleased]

> 当前没有未发布条目：本轮全部改动都属于 `1.0.0`（下面的版本段）。

> 说明：本文件里的**数字与断言条数是当时的实测值**（历史记录不追改）；会漂的数字
> （文件数/行数、夹具分类、套件条数）只在 README 与 `tools/README.md` 的
> `facts` 块里维护，由 `npm run docs:facts:check` 校验。

## [1.0.0] - 2026-09-24

### Added

- **单元测试基建**（`tests/`，`node --test` 原生 TS 类型剥离，零新依赖）：草稿归属判定矩阵、会话恢复计划矩阵、
  搜索高亮分段、图片相对路径解析、路径工具、编码表、`lumin-file` 访问规则、**package.json ↔ package-lock 一致性自检**。
  共 **57 条**断言，`npm run test:unit` 秒级完成。
- **CI**（`.github/workflows/ci.yml`，Windows runner）：`npm ci` → typecheck → lint（`--max-warnings 0`）→ 单测 → 构建。
  CDP 套件因为需要真实桌面会话，不进 CI（跑法见 README）。
- **纯函数层**：`shared/drafts.ts` 的 `planUntitledDraft()`、`shared/session.ts` 的 `planRestoreFromSlots()`、
  `shared/media.ts` 的 `isMediaExtension()` / `isWithinAnyRoot()`、`renderer/lib/imageSrc.ts`、`renderer/lib/highlight.ts`。
  把「判定」从 I/O 里剥出来，才能被毫秒级单测覆盖。
- **相对路径图片真正可用**：`![](img/a.png)` 现在按**文档目录**解析成 `lumin-file://` 绝对 URL 并加载
  （此前 `resolveLocalImageSrc` 是空实现，相对图片渲染不出来）。
- `.gitattributes`：行尾与二进制类型的单一事实来源（此前完全依赖各机器的 `core.autocrlf`）。
- `npm run ci`（本地一键门禁）与 `npm run lint:fix`；`engines.node >= 22`。

### Changed

- **写盘改为原子写**：`fileOps.writeFile` 走「同目录临时文件 → `fsync` → `rename` 覆盖」。
  中途崩溃/断电/磁盘满不会再截断用户唯一的一份稿件（同分区 rename 是原子的）。
  写盘失败时保留原文件，并把**原因**带给用户（不再只提示一句「保存失败」）。
- **全文索引节流**：自动保存（默认 3 秒）不再每次都全量重建 FTS5 索引（`DatabaseSync` 是同步 API，跑在主进程）。
  改为按文件合并、2 秒窗口批量重建 + 批次事务；超大文档只索引前 256KB；搜索前与退出前各补一次 flush。
- `lumin-file://` 协议只服务**媒体文件**且只服务**工作区内 / 已打开文档目录内**的路径（两道白名单）。
- 渲染层搜索结果不再用 `v-html` 拼 HTML：主进程改成返回带控制字符标记的**数据**，渲染层按段渲染 `<em>`。
- README 重写：平台现状（Windows 优先）、真实的质量门禁命令、目录结构、文档地图、已知限制与路线。
- `.prettierrc.yaml` 增加 `endOfLine: auto`（工作树是 CRLF，默认 LF 校验会产生 ~2.2k 条假告警）。

### Fixed

- 换文档后正文里的图片可能指向**上一个文档的目录**（`openPath`/`saveAs` 里 `currentDir` 赋值晚于 `current`）。
- 主进程缺少 `will-navigate` 兜底：文档里的链接若未被点击拦截覆盖，窗口会被整个导航走（应用 UI 消失、CSP 失效）。
- **lint 门禁不可用**：此前 `npm run lint` 报 912 errors / 7260 warnings（`tools/**` 898 个 error + CRLF 假告警）。
  现在 `tools/**`、`build/**` 已忽略，行尾规则对齐，`src` 的 14 个 error 全部修掉 → **0 error / 0 warning**。
- 模板里的内联多语句被 prettier 吃掉分号导致的构建失败：`@click`/`@dblclick` 的多语句抽成方法
  （`collapseSidebar` / `openGeneralSettings` / `pickTheme` / `resetSplitRatio`）。

### Removed

- 死代码：`wasCrashed()` / crash-flag 机制（写而不读，从未有人消费）、`releaseSlot()`（从未被调用）。
- 未使用的运行时依赖 `@electron-toolkit/preload`（`src` 中 0 处引用），并同步了 `package-lock.json`。
- pnpm 专用字段 `allowScripts`（本仓库用 npm）。
- 被误提交的构建日志 `build-out.txt` / `typecheck-out.txt` 与 `dev-app-update.yml`（已退出跟踪并加入 `.gitignore`）。

### Docs

- 新增手册 §4.51（本轮优化的范围、改法、验收数字与遗留项）。
- `docs/optimization-program.md` 顶部台账更新：已完成项与剩余波次。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0（tsc + vue-tsc） |
| `npm run lint` | **0 error / 0 warning** |
| `npm run test:unit` | **57/57 pass** |
| `npm run ci` | exit 0（上四项 + 构建） |
| `npm run build` | exit 0 |
| `tools/_verify-draft-banner.js` | 25/25 |
| `tools/_verify-new-document.js` | 23/23 |
| `tools/_verify-session.js` | 17/17 |
| `tools/_verify-session-last-closed.js` | 8/8 |
| `tools/_verify-taskbar-jumplist.js` | 31/31 |
| `tools/_verify-local-media.js`（新增） | 10/10 |

### 仍待办（按仓库整改方案排序）

- **Wave 1**：~~Markdown 往返保真套件~~ → **本轮已完成**，见下一节。
- **Wave 2**：文档级元数据模型（编码 / EOL / BOM 落库）、本地历史与回滚、以编码/EOL 保存。
- **Wave 3**：编辑器 ⇄ store 显式意图状态机；文件树键盘可达；原生日志文案接三语。
- **工程化**：~~`tools/lib/harness.js` + `tools/run-suites.js`~~ → **本轮已完成**；
  剩余：`files` store 拆分；`store` 里那份为绕循环导入而复制的 `confirmIfDirty` 收敛到 `services/dialog`。

---

> 归档口径（清单 §10 P2：文档规模已经超过人工同步能力；主文件只留基线 + 最新版本段）：
> `## [1.0.0]` 之后的 **50 个历史小节**已逐字搬到
> [`docs/changelog/archive-02.md`](docs/changelog/archive-02.md)；更早的 40 轮（含「历史主题汇总」）在
> [`docs/changelog/archive-01.md`](docs/changelog/archive-01.md)。
