# Lumin 整改方案（按波次执行）

> 本文是「做一次系统性优化」的执行清单。它把散落在评审意见里的问题**排成可独立验收的波次**，
> 每波都写清范围、涉及文件、验收标准与风险；已完成项附提交号，避免重复劳动。
>
> 用法：一次只做一波；每波结束时必须有**可复跑的验收数字**（本仓库惯例：`tools/_verify-*.js` 出 `--- N/M PASS`）。
> **不要并行改同一批文件** —— `src/renderer/src/i18n/locales/*`、`src/renderer/src/components/editor/*`、
> `src/renderer/src/stores/*` 是三个冲突高发区，跨波并行必打架。

---

## 0. 现状台账（清单里哪些已经做完了）

| 清单项 | 状态 | 提交 |
| --- | --- | --- |
| 打包链路（NSIS 安装器 / `fileAssociations` / `appId` / 图标单一来源） | ✅ 已完成 | `da6c28d` |
| 装/卸链路实测与 6 项缺陷修复（卸载残留关联、Publisher、AUMID、InstallLocation、dev profile） | ✅ 已完成 | `088716d`、`8c9f462`、`241b702` |
| 文件关联真正的门槛：main **解析裸文件路径**（`launchIntent.ts`）+ 三条入口收敛到 `handleOpenRequest` | ✅ 已完成 | `da6c28d` |
| 主进程不热更新 → `electron-vite dev --watch` + 构建自检（`buildStamp.ts`） | ✅ 已完成 | `027115a`、`496b622` |
| 图标按路径被 shell 缓存 → 内容寻址 `runtimeIconPath()` + profile 分名 | ✅ 已完成 | `cba76af`、`b34eac3` |
| 编码：三处入口（菜单重开 / 设置默认 / 状态栏显示）+ 每文件记忆 + 按编码回写 | ✅ 已完成 | `12b42de`、`cb4be25`、`af724c7` |
| 显式外部替换被回声启发式吞掉 → `syncEpoch` 强制同步 | ✅ 部分（只修了这一条路径，未收敛成状态机） | `496b622` |
| Markdown 保真套件 / 本地历史 / EOL / 以编码保存 / 文件树键盘可达 / CI / README / 单测 | ❌ 未做 | — |
| 编辑器⇄store 状态机收敛 / store 拆分 / `services/dialog` | ❌ 未做（本方案 Wave 3、Wave 5） | — |

---

## Wave 1：Markdown 往返保真（信誉底线，必须先做）

**为什么第一**：产品承诺「所见即所得且不破坏源文件」，但仓库里**没有**任何「刁钻 Markdown → 解析 → 序列化 → 差异」的验收。
任何语法被静默改写都是**无声丢内容**；而在没有这条指标之前，动编辑器内核（Wave 3）等于闭着眼睛改。

- **交付**：语料 `tools/fixtures/md-fidelity/*.md`（setext、引用式链接、行内 HTML、front-matter、表格对齐与 `\|`、
  嵌套/混合列表、`~~~` 与缩进代码块、硬换行、连续空行、数学、mermaid、`[TOC]`、中文与 emoji、CRLF 各一份）；
  套件 `tools/_verify-md-fidelity.js`；报告 `docs/markdown-fidelity-report.md`。
- **判定必须分三档**：`EXACT`（字节一致）/ `NORMALIZED`（语义等价但有规范化，须输出逐行 diff 供人审）/ `LOSSY`（丢内容或改语义，一律 FAIL）。
  LOSSY 至少两条判据：可见 token 缺失、结构标记数量减少（行数/围栏数/管道数/`[ ]` 数）、URL 被改写。
- **加一条幂等性回归**：每个夹具连做两轮往返，第二轮必须与第一轮完全一致 —— 不幂等等于用户每次保存都在改文件。
- **验收**：夹具总数、三档各自计数、幂等通过率、每条 LOSSY 的**最小复现片段**（原文 vs 往返）。
- **风险**：本轮**不改产品代码**，只出报告与修复建议，改法单独拍板。

## Wave 2：文件级元数据模型 + EOL + 以编码保存 + 本地历史

**为什么排第二**：这三件事是同一个根 ——「文档级元数据没有模型」。现在编码挂在 `current` 上、再配一张 kv 里的
`fileEncodings` 表（我上一轮为省迁移而选的临时方案），EOL/缩进/BOM 各写各的 → 两个窗口开同一文件会**各说各话**，
重启又会忘。把它一次做对，能同时消掉三类 bug。

- **DB**：`documents` 表加列（`encoding` / `eol` / `had_bom` / 可选 `cursor`、`scroll`），写**迁移**（本仓库已有 kv 兜底模式可参考）；
  老的 `fileEncodings` kv 表做一次性迁移后废弃。
- **服务**：主进程 `services/eol.ts`（检测/转换 CRLF↔LF，尊重 `.gitattributes`？—— 至少不猜，按文档记录）；
  编码读写沿用 `services/encoding.ts`，把「文档元数据」作为权威来源。
- **UI**：状态栏显示 `CRLF`/`LF` 与编码，**都可点**（点开切换，复用 Wave 2 新增的选择器）；文件菜单加
  「以编码保存…」「以 LF/CRLF 保存」；设置里默认编码/默认 EOL；三语齐全。
- **本地历史（数据安全）**：`documents_history` 表（path、保存时间、内容或差量），策略：每次保存前留一份、
  按时间抽稀（例如最近 1 小时内每次、之后每小时、保留 N 天），设置里可查看/恢复/关闭。**关键**：现在保存成功即清草稿，
  一次误保存无法挽回 —— 这条是写作工具的信誉底线。
- **验收**：两窗口同文件的编码/EOL 一致；重启后记住；保存后字节确为目标 EOL/编码；历史可回滚且保存不再清空历史；
  卸载/清库不影响。

## Wave 3：内核收敛 + 可访问性 + 打磨小刺

**为什么排第三**：Wave 1 已有保真门槛，这时候动内核才安全。

- **3.1 编辑器 ⇄ store 显式意图状态机**（清单第 1 条）：把 `nv === lastEmitted` 与 600ms 静默窗这两条**启发式**换成
  「意图 + 通道」：`open / reload / reopenWithEncoding / draftRestore / modeSwitch / userInput` 各自明确「谁写、谁读、谁清脏标记」。
  `syncEpoch` 只是本波的过渡产物，最终应被意图取代。
- **3.2 三处真相源收敛**（清单第 2 条）：WYSIWYG / 源码 textarea / 代码块 CodeMirror。方向：**模式切换走显式重建**
  （宁可重建也不要双向防抖），把 `scheduleSplitSync`、`syncEditorContent`、textarea 兜底收敛成单向数据流。
- **3.3 文件树键盘可达**：`role="tree"`/`treeitem`、`aria-expanded`、上下键移动、左右键展开收起、Home/End、Enter 打开。
- **3.4 打磨小刺**：原生菜单 `menu.ts` 硬编码中文 → 接三语；错误提示统一带上**原因**（参考编码那次的示范）；
  `lumin-file://` 协议处理器补路径校验（与 IPC 侧 `assertWorkspacePath` 同口径）并显式开 `webPreferences.sandbox`；
  状态栏编码/EOL 可点；`build/entitlements.mac.plist` 等模板残留清理或标注为「非发布目标」。
- **验收**：编码/图标/任务栏套件全绿 + 新增「模式切换与远程同步」套件（含快速连续切换、源码↔所见即所得往返、草稿恢复）。

## Wave 4：工程化地基

- `README.md`（是什么、快速开始、架构图、开发/打包流程、常见坑：`--watch`、构建自检、`dev:isolated`）
- `CHANGELOG.md`（按 Keep a Changelog 从 conventional commits 汇出）
- **CI**（GitHub Actions）：`typecheck` + 单元测试 + `build`（Windows runner）；CDP 套件因为依赖桌面会话，
  建议做成 `workflow_dispatch` 的可选 job，别硬塞进每次 PR。
- **验收脚手架收敛**：抽 `tools/lib/harness.js`（连接/求值/等待/断言/起隔离实例）+ `tools/run-suites.js`
  （起实例 → 按序跑 → 收尾 → 出矩阵），每个套件在文件头**声明前置条件**（是否需要 dev server、是否需要 `LUMIN_DB`）。
  先改 2~3 个套件做样板，不要一次改 50 个。
- **lint 转绿**：`.eslintignore`/flat config 里忽略 `tools/**`（它们是脚手架，CommonJS 风格合法），
  并修掉 `src` 下既有的 14 个 error → 让 `npm run lint` 成为**可信信号**（现在是 4000+ 告警把真错误淹掉了）。
- **单元测试方案（需拍板）**：纯逻辑（`pathUtils`、`encodings`、键位解析、Markdown 往返的纯函数部分）用
  `node --test` + esbuild 预打包（**零新依赖**）还是引入 `vitest`（生态更顺、但要加依赖）。我倾向后者用于长期，
  前者用于本轮先跑起来。

## Wave 5：大重构（单独里程碑）

- `files` store（~550 行）拆成 `documents / workspace / drafts / encoding`；主进程 `index.ts` 拆出 `windows.ts`/`boot.ts`。
- 新增不依赖 store 的 `services/dialog`，消掉 store 里那份为绕循环导入而复制粘贴的 `confirmIfDirty`。
- **要求**：重构前后**同一套件全绿**（先补齐覆盖再动刀）；建议单独分支、单独提交序列，便于 bisect。

---

## 需要拍板的问题

1. **单元测试**：`node --test` + esbuild（零依赖）还是 `vitest`（生态）？
2. **本地历史的保留策略**：留多久、存全量还是差量、是否默认开启？
3. **桌面快捷方式**：保持「总是创建并覆盖同名文件」（当前行为，主流）还是改成只建开始菜单？
4. **自动更新与签名**：要不要接真实更新渠道与代码签名（不签名会看到 SmartScreen「未知发布者」）？
5. **双栏对照 / 同窗口多文档**：是否纳入路线（现方案是「一文件一窗口 + 会话槽位」，自洽但迟早会有对照诉求）？

## 明确不建议做的

- 在没有 Wave 1 保真指标之前继续调编辑器性能或改同步逻辑；
- 跨平台（mac/Linux）适配打磨 —— 先把 Windows 打磨到「能交付」；
- 插件系统、多标签页（与「一文件一窗口」的既有选择冲突）。
