# 附录 4.86–4.87：两波按报告优化的交付记录

> 本文件是 [附录索引](./08-appendix.md) 的第 5/5 片，
> 内容为原 `08-appendix.md` 的第 3359–3516 行（**逐行原样**，拆片脚本见 commit 说明）。
> 线上（live）的优化台账在 [docs/optimization-waves.md](../../optimization-waves.md)。

---

## §4.86 按桌面评审报告逐条优化（波次 1：数据丢失路径 + 便宜的正确性/体验修复）

**背景**：桌面上那份《Lumin 项目评审报告》（26 页 / 13 张表，五路并行只读审计 + 竞品检索）
列出 60+ 条可执行项。用户要求"按报告逐条优化，无需审批，全部专业地做"。
于是把它拆成波次：**波次 1 = 会丢用户内容的三条路 + 成本极低、用户可见的十几项**；
性能、窄窗、Electron 升级、分发链与壁垒功能放进波次 2（清单见 `docs/optimization-waves.md`）。

### 一、数据安全三条（报告 §4.2 的 P0）

三条都是"用户内容会静默消失"这一类，修法都落在**临界区/时序**上，而不是加提示语：

1. **并发保存的 mtime 校验不在临界区**：`file:write` 先 `stat` 比对、再 `serializeWrite` 入队 ——
   两窗口同文件并发保存时两次都拿到同一个旧 mtime、都通过校验，后到者覆盖先写者，
   而先写者在渲染层被标成"已保存"（`finishSave` 把 `savedContent` 设成自己那一版）⇒ 关窗不提示。
   现在检测移进队列回调（与 `recordHistoryBeforeOverwrite` 同临界区）。
   验收用的是**确定性判据**：先把文件 mtime 回拨 10 秒，这样"第一次写之后 mtime 必然变"
   不依赖两次 rename 的毫秒级间隔，断言"恰好一次 `conflict:true` + 磁盘上恰好一个赢家"。
2. **删除正在编辑的文档/目录不 flush、不问脏**：输入有 250ms 防抖、草稿还有 1.2s 防抖，
   而回收站与本地历史只覆盖**已写进磁盘**的版本 ⇒ 防抖窗口里的那段输入永久消失。
   现在 `removeNode` 先收口握手区并落一份草稿；删目录时在摘路径后再以「未命名」键留一份。
3. **「不保存」不确认关窗**：`requestClose` 的 `discard` 分支在 `try` 里 `return`，
   于是写在 `try` 之后的 `confirmClose()` 被跳过，窗口只能等主进程 2.5 秒兜底强杀。
   改成"一条出口 + `closeNow` 标志"后，任何新增分支都不会再漏（取消/保存失败显式置 false）。

附带两处一致性缺口：`finishSave` 清草稿前先 `await draftWrite`（否则在飞的写会落在删除之后，
下次启动弹出**已被撤销**的内容）；`db.upsertDocument` 失败不再把一次**已成功落盘**的保存
判成失败（否则重试带着旧 mtime 命中冲突检测，用户看到"磁盘被别的程序改过"）。

### 二、索引只增不删（报告 §4.2 P1-1）

`file:remove` 对目录只调 `deleteDocument(目录路径)` —— 那条 SQL 按 `path = ?` 精确匹配，
**永远命不中**：删掉目录后 `documents`/`documents_fts`/`documents_history` 里那一批幽灵文档
长期留着（搜得到、最近/标签里看得到、点开打不开）。现在：

- `database.deleteDocumentsUnder(dir)`：按**目录边界前缀**批量删（大小写不敏感，
  转义 `%_\`），返回行数；
- `file:remove` 在删盘**之前**判断类型（删完再 stat 只会失败，目录会被当文件走精确匹配那条路）；
- `workspaceIndex.indexWorkspace` 收尾按"本轮真实扫到的路径集合"对账 prune，
  **扫到 `MAX_FILES` 上限时跳过对账**（没扫全就删 = 误删）。
- 同时补 `PRAGMA busy_timeout = 3000`：此前只有 WAL/synchronous，
  外部工具占用库时写会直接 SQLITE_BUSY 冒到"保存失败"。

### 三、设置：一份真相 + 原生菜单主题真的生效（报告 §3.2 P0-1/P0-2）

- 新增 `src/main/services/appSettings.ts`：主进程**唯一**设置写入口（kv → 归一 → 原生主题 →
  广播 `settings:changed`）。`ipc.ts` 的 `commitSettings`、两处"备份目录"写点全部改走它；
  渲染层订阅新出站通道（preload 白名单里已登记，`i18nAndIpc` 双向对账）就地 patch store。
  以前的问题是"补偿写在调用点"：任何新增的"主进程改设置"都得自己记得同步，否则 store 的
  `persist()` 会把整份设置回写、把主进程那一步打回去（注释里记录过"选了别的盘，重启变回默认"）。
- 原生菜单主题项写的是 **electron-store**（`store.ts` 自述它只是历史配置的一次性迁移源），
  渲染层收到 `theme-changed` 却去 SQLite 重读 ⇒ **点了没反应**。改走 `patchSettings` 后，
  菜单的四个主题项与界面上那四个按钮走同一条路。

### 四、验收集（本波新增/扩面的断言）

| 套件                        | 变化                | 这一波新增的关键判据                                                                             |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `_verify-save-safety`       | 15 → **17**         | 同路径并发写恰好一次冲突；磁盘上恰好一个赢家                                                     |
| `_verify-file-lifecycle`    | 11 → **15**         | 删脏文档留草稿且内容正确；删目录后逐路径查库为 `null`                                            |
| `_verify-close-save-prompt` | 21 → **22**         | 点「不保存」到进程退出 < 2000ms（≥2500ms 即走了兜底）                                            |
| `_verify-a11y`              | 23 → **31**         | 侧栏 tabs 语义 + tabpanel 闭环；专注模式退出胶囊可见可用；`⋯` 菜单语义与 Esc 还焦点              |
| `tests/themeTokens`         | 面矩阵 3 → **4** 个 | `--ink-3`/`--accent` 四表面 ≥3:1；`--link` 四表面 ≥4.5；find-current 专测                        |
| `tests/guards`              | +1                  | 「设置只有一个写入口」（扫 `src/main/**` 的 `kvSet('settings'` 与 `menu.ts` 的 `settingsStore`） |
| `tests/i18nHardcoded`       | +3                  | 英文硬编码扫描器（文本节点 + 可见属性）+ 两处真实修复                                            |
| `tests/docsClaims`          | 扫描域 +2           | `docs/_audit/*.md` 与 `docs/optimization-waves.md`；抓出 3 条失效引用                            |
| `tests/settingsPatch`       | 新增 4 条           | `deepMerge` 的三条语义（数组替换 / `undefined` 不覆盖 / 深合并）                                 |

### 五、报告里**没成立**的一条（如实记录）

架构审计说 `EditorContextMenu.vue` 有几处浮动 Promise。复核 `stores/editorMenu.ts:102/114`：
`openAt()` 与 `close()` 返回 **void**，不是 Promise —— 那几处不是漏 catch。
本波**不改**，理由留在这里，免得下一轮有人照着报告再"修"一遍。

### 六、全量矩阵抓出来的两处"套件把实现细节当契约"

全量矩阵第一轮 60/62，两红都不是"套件太脆"这么简单 —— **其中一条是真的产品问题**：

1. `_verify-toolbar-settings` 34/38：`submenu-opens-on-hover` 与后两条连锁失败。
   根因是套件按**字面量** `[role="menu"][aria-label="submenu"]` 找二级菜单，而本轮把那个
   aria-label 改成走语言包（中文界面渲染成「子菜单」）⇒ 选择器落空。
   同类写法还有 3 个套件（用 `:not([aria-label="submenu"])` 排除子菜单 —— 改完之后只是
   **碰巧**还对）。修法：组件加语言无关锚点 `data-context-submenu`，4 个套件 5 处选择器改用它。
2. `_verify-sidebar-search` 10/12：B 段（焦点在正文里时 Ctrl+F 必须找正文）变红 ——
   **这是真问题**。`ctrlFTarget` 把"指针此刻悬在侧栏"与"焦点在侧栏"等权，于是
   "鼠标停在侧栏（上一次交互的残留）→ 点进正文 → Ctrl+F"会打开侧栏的文件名搜索；
   而同一套件 D 段（先点正文、再把鼠标移到侧栏树行）要求相反结果 ——
   两段在"焦点 + 此刻指针"上完全一样，**只有时序能区分**。
   修法：新增 `lib/pointerRegion.ts` 记"最近一次指针交互 / 最近一次焦点交互"的序号，
   `ctrlFTarget` 加 `sidebarPointerRecent` 一档（焦点在侧栏 → 侧栏；最近动的是鼠标且在侧栏 →
   侧栏；否则焦点在编辑区 → 正文；都不沾才看此刻悬停）。单元测试 6 → 9 条覆盖四种组合。

### 七、波次 1 没做的事（波次 2 清单）

大文档代码块回收（977 KB ≤5s / 2000 围栏 ≤15s）、窄窗断点（900/760）、Electron 升级（39 已 EOL）、
IO 层单测（`fileOps`/`database`/`encoding` 需要先做可注入边界，它们都 import `electron`）、
真实仓库/下载页与更新通道、代码签名、拼写检查、真 `.docx`、命令面板、多光标、双链、便携版，
以及 `files` store / `SettingsDialog` / `main/index.ts` 的拆分欠账 —— 全部记在
`docs/optimization-waves.md` 的"波次 2"里，做完一项销一项。

---

## §4.87 波次 2：大文档性能 —— 先复测报告的数字，再按实测标定降级闸

**方法论**：这一波没有直接照着报告的数字改代码，而是**先用自己的探针把报告的两个主张复测一遍**。
结果一个是陈旧的、一个是真问题 —— 两种结论都进了台账（`docs/optimization-waves.md` §2.1）。

### 一、两个数字的复测

- **2000 个代码围栏（报告：装载 52–62 s）**：`tools/_probe-fences-total.js` 实测
  **load+flush 756ms / 切源码 578ms / 切回 116ms / 全程 1450ms**。原因：代码块 CM 虚拟化
  （F 项）之后每块不再常驻一个 CodeMirror —— 500 围栏时 CM 实例峰值 **10 个**（虚拟化前 500 个），
  离屏块退回 `<pre class="cb-static">`；`_verify-cb-virtualization` 18 条守着"按需挂载 / 高度稳定 /
  选区保护"，`_verify-surface-stress` 的 2000 围栏档 72/72。**这条主张已经过时。**
- **977 KB 文档（报告：装载/回灌各 ≈16 s）**：新探针 `tools/_probe-bigprose.js`（真文件、
  每档一个全新隔离实例、量到 **DOM 稳定**为止）实测 **open 1.97s + render 4.37s = 6.34s
  不可用、RSS 1272MB**；1.1MB / 420k 字符 → 8.59s、1247MB。**这条是真的**（1.4GB 常驻），
  但形态与报告不同：慢的不是装载，是渲染面的 DOM 构建。

### 二、为什么旧阈值漏掉了它

降级闸（`lib/largeDoc.ts`，超阈值直接进源码模式）此前的字符阈值是 **1M**，依据是旧审计那句
"572,262 字符 → 打开 **2.24s**"。那句话量的是 `openPath` 返回（读盘 + 解析），
而**用户真正能用的时刻是 DOM 稳定**（多 2–3 倍）。于是 373k / 420k 字符的散文
（977 KB / 1.1 MB 文件）既没触发围栏闸也没触发字符闸，代价就是 6–9 秒 + 1.2 GB。

CPU 采样（`LUMIN_PROBE_PROFILE=1`，6930ms）说明这 4.4 秒的构成：
markdown-it `ParserBlock.tokenize` 717ms、prosemirror-markdown `atBlank` 1168ms、
PM 内部（`nodesBetween` / `nodeSize` / `isLeaf`）约 490ms、GC 411ms、
我们自己的滚动恢复 `applyScrollRatio` 356ms —— **第三方解析与 PM 建 DOM 是常数**，
不是一次改动能消掉的，所以这一波按同一套机制（降级 + 明确告知 + 可切回）标定阈值。

### 三、改动与效果

`HEAVY_CHARS` **1M → 300k**（围栏仍 800；依据是实测 **17 µs/字符** ⇒ 5 秒线 ≈ 290k），
并把降级原因做成纯函数 `heavyReason()`（`fences` / `chars`）+ 三语新文案
（一份 977 KB 的纯散文没有几个代码块，说"有 0 个代码块"只会让人困惑）。

| 指标（同一份 977 KB 文档 / 同一探针） | 改前             | 改后                                 |
| ------------------------------------- | ---------------- | ------------------------------------ |
| 入口模式                              | 渲染面           | **源码面**（附原因提示，可一键切回） |
| `open`                                | 1965–2173 ms     | **454 ms**                           |
| 默认可用（open + 入口就绪）           | 6340 ms          | **454 ms**                           |
| 入口常驻内存                          | 1272 MB          | **604 MB**                           |
| DOM 元素 / 布局对象                   | 30,939 / 151,977 | **97 / 169**                         |
| 报告验收线（977 KB ≤5s）              | FAIL             | **PASS**                             |
| 1.1 MB 那一档                         | 8.59s / 1247MB   | **0.53s / 624MB**                    |

**代价如实写在这里**：用户坚持切回渲染面时，977 KB 仍要 +3.4s / ~1.2GB。
根治只能靠**段落级虚拟化**（让 PM 只建视口附近的段落 DOM）—— 那是另一个量级的工程，
已作为"性能的下一刀"记进波次 2 余项，不在这一波冒充完成。

### 四、验收

`tests/largeDoc.test.mjs` 6 → **8 条**（阈值钉住、降级原因可区分、"20 万字中文长篇要闸住"、
"1.6 万字稿子不该被闸到"）；`_verify-surface-stress` **72/72**（含 1 MB 与 2000 围栏两档）、
`_verify-cb-virtualization` **18/18**、`_verify-open-in-new-window` 3/3；单测 **749/749**；
新增可复跑探针 `tools/_probe-bigprose.js`（`LUMIN_PROBE_BYTES` / `LUMIN_PROBE_PROFILE` /
`LUMIN_PROBE_SWITCH` 三个环境开关）。
