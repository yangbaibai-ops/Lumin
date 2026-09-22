# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
本项目在此文件建立之前的变更，以「历史主题汇总」压缩记录；每轮的取舍与验收细节见 `docs/typora-wysiwyg-manual.md`。

## [Unreleased]

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

## [Unreleased · O3 语言包收窄] — 删掉 `@codemirror/language-data`，改 15 项显式映射（构建 −0.98MB）

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.B（自查报告 O3）。原状：`CodeBlockView.vue`
> 用 `languages` 表找 `load()` —— 那张表覆盖 115 种语言，构建产物里留下 **116 个 `import()` 目标
> （实测合计约 1.6MB）**，而组件自己的语言清单只有 15 种（+ mermaid 走预览）。

### Changed

- **显式映射表**（`components/editor/CodeBlockView.vue`）：14 种走 `@codemirror/lang-*`
  （javascript / typescript / python / html / css / json / sql / java / go / rust / cpp / php / yaml），
  `bash` / `ruby` 走 `@codemirror/legacy-modes/mode/{shell,ruby}` + `StreamLanguage.define()`；
  另加 `LANGUAGE_ALIASES`（`js/jsx/mjs/cjs/ts/tsx/py/htm/xml/svg/sh/shell/zsh/console/yml/c++/cc/cxx/h/hpp/golang/rb/mysql/postgres/sqlite`）
  与原 `language-data` 的别名口径对齐；认不出来的语言**如实退回纯文本**（与原行为一致）。
- **取舍写进代码注释**：从此只高亮这 15 种（清单外语言按纯文本渲染）——这正是清单 §3
  点明的「要么省体积、要么保留任意语言」二选一，用户口径是「需要单独排期的全部同意」，故按文档收窄。
- `package.json`：删 `@codemirror/language-data`，把 13 个原本只作为它传递依赖的包（12 个 `lang-*` +
  `legacy-modes`）**升为直接依赖**（版本取当前已装版本）；`package-lock.json` 的根依赖集合同步。
  ⚠️ 本环境**禁止 npm 联网**（`EALLOWREMOTE`，npmmirror 被策略挡住），所以 lock 是用一次性脚本
  离线对齐根 entries 的（这些包本来就在 lock 树里）——`tests/lockfile.test.mjs` 6/6 通过，
  `npm ci` 所需的三条一致性（根集合一致 / 声明项在树里 / 无悬空引用）都成立。

### Added

- `tools/_verify-cb-languages.js`（4 条）：**22 个围栏（15 种语言 + 7 个别名）逐个必须有高亮 span**
  （CM 的 HighlightStyle 生成的 `<span class="ͼ…">`）、清单外语言（`text` / `makefile`）**必须没有**
  span（证明是「如实退化成纯文本」而不是静默停摆）、语言选择框仍是 16 项。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 构建产物 | JS 文件 **191 → 89**（−102 个 chunk）；总体积 **11.56MB → 10.58MB（−1,002KB）**；`EditorView-*.js` 2,509.13 → **2,472.47 kB** |
| `_verify-cb-languages.js`（新增） | **4/4** |
| 代码块回归 | `_regress-cb` 3/3、`_verify-cb-button-line-numbers` 26/26（本套件整条链路点工具栏按钮 ⇒ 补了「显式打开工具栏」夹具）、`_verify-md-fidelity` 101/102（1 条按环境 SKIP）、`_verify-surface-stress` 72/72 |
| `tests/lockfile.test.mjs` / `vue-tsc` / `eslint` | 6/6 / exit 0 / 0 error 0 warning |

**顺带查清的两条既有失败（与 B/E 无关，已登记到清单 §2.I）**：
`_verify-cb-line-numbers.js` 8/13（设置面板里的开关「真实点击」不生效，5 条断言连带失败）——
用「把工具栏默认值改回 true」与「stash 掉 B 的改动」两次对照复现，确认它与本轮两项改动都无关；
`_verify-cb-typing2.js`（0 断言老脚本，硬编码外部工作区路径）报 `no cm`。

**顺带修掉编码门禁的一个假阳性**（`tests/encodingGuard.test.mjs`）：它剥代码块用的是
`` /```[\s\S]*?```/g `` —— 正文里只要**提到**一次三个反引号（本轮 CHANGELOG 写了
「只要看到 ```mermaid 就加载」），后面所有围栏的配对就整体错位，本该剥掉的历史乱码引用
漏成「正文」并报假 mojibake。改成按**行首**配对（允许缩进）：`` /^[ \t]*```[\s\S]*?^[ \t]*```/gm ``。

## [Unreleased · E 快捷工具栏默认收起] — 写作面优先（清单 §1.E 选项②）

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.E（报告里列为「需要拍板」，用户口径是
> 「需要单独排期和拍板的全部同意」，故按文档给出的选项 ② 实现）。

### Changed

- `src/shared/defaults.ts`：`toolbarVisible: true → **false**` —— 本产品是「纸面优先」的写作工具，
  最显眼的那条 44px 常驻 chrome 恰在正文上方；而它承载的动作**三处重复**（快捷工具栏 /
  编辑器右键菜单 / 顶部菜单栏），收起来不丢功能。三条重新打开的入口都在：视图 → 显示快捷工具栏
  （应用内 + 原生菜单 `toggle-toolbar`）、设置 → 编辑器 → 快捷工具栏、工具栏空白区右键（栏在时可见）。
  **已存在的用户设置不受影响**（落在 kv 里，只有全新 profile 才拿到新默认值）。
- `tools/lib/harness.js` 新增 `showToolbar(app)`：打开工具栏并**等它真的挂上**
  （返回是否等到）。运行器给每个套件用的都是全新 userData，所以「默认收起」每个套件都会生效。
- 夹具显式打开工具栏（用 `showToolbar` 或各自的 store 访问器）：
  `_regress-layout` / `_regress-divider` / `_regress-source-roundtrip`（用 `clickMode` 切面）、
  `_verify-find-replace`（源码面用例）、`_verify-inline-formats`（整套在点工具栏按钮）、
  `_regress-split-live`（模式分段控件 + 几何）、`_verify-segmented-control`、`_verify-bars-no-filename`。
- `tools/README.md` 补两条规矩：要量工具栏的套件必须 `await showToolbar(app)`；SKIP 不算失败。
- `tests/toolbarItems.test.mjs` 的默认值断言改为 `false`（并写明为什么是刻意收起的）；
  README 的功能清单、`docs/_audit/i18n-and-settings.md` 的设置矩阵同步。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| `tests/toolbarItems.test.mjs` | 13/13（默认值断言已翻转） |
| 工具栏相关套件 | `_verify-segmented-control` 16/16、`_verify-bars-no-filename` 12/12、`_verify-inline-formats` 182/182、`_regress-split-live` 8/8、`_verify-toolbar-settings` 37/37、`_verify-find-replace` 24/24 |
| 默认矩阵全量（26 条） | 第一轮暴露 3 条真回归（`_regress-layout` 6/9、`_regress-divider` 0/1、`_regress-source-roundtrip` 3/4 —— 全是「用工具栏分段控件切面」的夹具）→ 补夹具后 **26/26 全绿** |
| `eslint --cache .` | 0 error 0 warning |

## [Unreleased · O1 mermaid 按需（视口门 + 干掉首屏预加载）] — 远处不渲染，`mermaid.core` 不再首屏取

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§2.G。原状：`CodeBlockView.vue` 的 `onMounted`
> 只要看到 ```mermaid 就 `import('mermaid')` 并渲染 —— 哪怕块远在屏幕外。

### Changed

- **视口门**（`components/editor/CodeBlockView.vue`）：用 `IntersectionObserver`
  （`rootMargin: 200px`）把「import + 渲染」推迟到块**进入视口附近**才发生；门未开时块内是
  **源码占位**（`.mermaid-placeholder`，等宽淡色、可点击进源码编辑），所以块始终有高度、
  不会是个空洞，放行后 SVG 一到位就替换。容器带 `data-mermaid-gated="pending"` 便于验收。
  提前 200px 放行 ⇒ 「源码→图表」的高度变化发生在**屏幕外**，正常滚动看不到跳动。
  导出不受影响（那条路走 `renderMermaidInHtml(html)`，与编辑器视图解耦）。
- **干掉首屏预加载**（`electron.vite.config.ts`）：实测**Vite 默认的 modulePreload 会把
  `mermaid.core`（1.23MB）在首屏就取**（路由 chunk 的「动态 import 依赖」被插成
  `<link rel=modulepreload>`，与文档里有没有 mermaid 块无关）——这跟「mermaid 按需」的初衷相反。
  现在 `build.modulePreload.resolveDependencies` 把 `mermaid` / `cynefin` / `cytoscape` 一族
  从预加载依赖里剔掉，真正需要时由 `import('mermaid')` 现取。

### Added

- `tools/lib/harness.js`：`watchEvents(app, onEvent)` —— 订阅 CDP **事件**（原来的句柄只处理带 id
  的响应）。用于验证「某个懒加载 chunk 到底有没有被取」这类页面侧看不到的事。
- `tools/_verify-mermaid-gate.js`（4 条）：① 远处块不渲染（无 `svg` + `pending` + 有占位）；
  ② 启动后 `link[rel=modulepreload]` 里**不含** mermaid 一族；③ 滚入视口后渲染出来、占位被替换；
  ④ chunk 变成「滚入才取」。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| `_verify-mermaid-gate.js`（新增） | **4/4** |
| mermaid 既有回归 | `_verify-mermaid-blur.js` 22/22、`_verify-mermaid-cross-block.js` 18/18 |
| 代码块回归 | `_regress-cb.js` 3/3、`_verify-math.js` 7/7 |
| `vue-tsc` / `eslint` / `electron-vite build` | exit 0 / 0 error / exit 0（`EditorView-*.js` 2,509.13 kB） |

**过程中查清的两件事（如实记录）**：
1. 页面侧的 `performance.getEntriesByType('resource')` 在本应用里**恒为空**（实测 `resTotal=0`），
   用它写「没有取某个 chunk」这种否定断言会**永远通过**（假绿）——已改为读
   `link[rel=modulepreload]`（可靠）+ CDP 事件（只作参考：`file://` 下 Network 事件并不完整）。
2. 顺带发现 `tools/_verify-cb-typing.js`（老式 0 断言脚本，要求外面先摆好一份带代码块的文档）
   在矩阵里会直接崩（`Cannot read properties of null`）——**与本次改动无关**，已登记到清单 §2.I
   （老脚本迁移/归档）一起处理。

## [Unreleased · S3 第一期] — `lib/editor/defer.ts`：把「躲开 PM 事件顺序」的延后一拍收口

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.D 第 1 步（自查报告 S3）。编辑器里有一批
> `setTimeout(fn, 0)` 不是防抖也不是节流，而是「必须等 ProseMirror 自己那一轮处理跑完」；
> 它们散在十几处，每处都要重读注释才敢改。

### Added

- **`src/renderer/src/lib/editor/defer.ts`**：`deferAfterPmEvent(fn) => cancel`。模块头把两类
  真实约束写清楚了：① 同步 dispatch 会被 PM 自己的 MouseUp/Blur 处理覆盖（实测：点行尾空白时
  `posAtCoords` 给出块尾，最终光标停在收尾 `**` 之前）；② 松手瞬间 `.pressHidden` 解除、
  显隐装饰重算、整行左右移动，所以**判据同步量、落点延后写**。文件里同时写明
  **不能用微任务替代**（`queueMicrotask`/`Promise.then` 仍在本轮 PM 事件内）。
- `tests/defer.test.mjs`（4 条）：同步阶段不执行 / 顺序是「同步 → 延后」/ 连续两次
  `await Promise` 仍未执行（证明微任务不能替代）/ `cancel()` 撤销后永不执行。

### Changed

- 已收口到 `deferAfterPmEvent()` 的三处（「新写的 + 下次改到的」口径，不全量替换）：
  `lib/editor/pointer.ts`（点击链接 → 展开源码）、`lib/editor/typoraInlineMarks.ts`
  （`handleDOMEvents.mouseup` 的拖选撑标记 + 行尾落点）、
  `components/editor/TyporaEditor.vue`（`onCreate` 后的 `normalizeMdMarkers()`）。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 单测 | 295 → **299/299**（新增 4 条） |
| `vue-tsc` / `eslint` | exit 0 / 0 error 0 warning |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,507.58 kB） |
| 编辑器内核套件 | `_verify-drag-selection` 10/10、`_verify-line-end-click` 7/7、`_verify-marker-hold` 11/11、`_verify-inline-formats` 182/182、`_verify-find-replace` 24/24、`_verify-round-24` 15/16 SKIP 1 —— **6/6 全绿** |

## [Unreleased · 套件诚实性三处（清单 §1.C）] — SKIP 不再算失败 / 主题切换改轮询 / 剪贴板先哨兵校验

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.C。三处都是「信号不诚实」：要么把正常的 SKIP
> 判成红灯，要么让机器负载决定成败，要么让真实剪贴板混进结论。

### Fixed

- **C1 SKIP 被当成 FAIL**（`tools/run-suites.js`）——判定原来有两处会把 SKIP 算成失败：
  ① `--- N/M PASS` 里的 M 是**断言总数**（含 SKIP，`Reporter.total = passed + failed + skipped`），
  老写法 `fail = M - N` 于是把 SKIP 当失败；② 状态判定用 `skipped || (code===0 && fail===0)`。
  实测后果：`_verify-md-fidelity.js`（101/102）、`_verify-round-24.js`（15/16）、
  `_verify-theme-auto.js` 退出码 0、FAIL 0，却**每轮报红**。现在：优先认三数分开写的
  `TOTAL … FAIL … SKIP …`；退到老格式或 `--- N/M PASS` 时用 **SKIP 行数**从 M 里扣掉；
  状态只看「退出码 + FAIL 行」，SKIP 单独在行尾显示（`PASS x/y SKIP n`），并在一轮结束时
  汇总「另有 N 条断言按环境如实 SKIP —— SKIP 不算失败」。
- **C2 批次敏感**（`tools/_verify-sidebar-tree-style.js`）——主题循环原来是
  `set('theme')` + **固定 `sleep(900)`** 就读计算样式；批量跑（机器更忙）时会读到上一套主题的颜色，
  实测单独 32/32、批量 29/32。改成**轮询双条件**：`<html>` 的 `theme-*` 类到位 + `--paper`
  真的换了 + **关键颜色连续两次采样相同**（侧栏/行/body 都在 `transition: background-color` 上，
  只等变量变会读到**过渡途中的插值色** —— 这正是先前 30/32 里 `sel`/`body` 仍是上一套值的原因）。
- **C3 系统剪贴板污染**（`tools/_verify-inline-formats.js`）——粘贴夹具依赖**真实剪贴板**，
  批量和单独跑结果不同（179/182 vs 182/182）。现在：① 开头写一个**哨兵值**并读回校验，
  确认读写通路可用；② 每次 `writeClipboard(md)` 后**读回比对**，不一致就 `SKIP` 并注明是环境问题
  （不再把它算成「编辑器丢字符」的假回归）。

### Verification（本轮实测）

| 项 | 结果 |
| --- | --- |
| 三个曾被记红的套件 | `_verify-round-24.js` **PASS 15/16 SKIP 1**、`_verify-md-fidelity.js` **PASS 101/102 SKIP 1**、`_verify-theme-auto.js` **PASS 11/11**（改前均记 FAIL） |
| 靶子验证（临时假套件，已删） | 故意打印 `FAIL` 并 `exit 1` 的假套件仍被记 **FAIL**；零断言的假套件仍被记 **NOASSERT** —— 放宽 SKIP 没有削弱另两道闸 |
| C2 | `_verify-sidebar-tree-style.js` 单独 **32/32**；风格批次（surfaces 37 / neutral-accent 10 / tree-style 32 / toc-style-scroll 23 / segmented-control 16 / a11y 6）**6/6 全绿** |
| C3 | `_verify-inline-formats.js` **182/182** |

## [Unreleased · S4 数据库版本化迁移] — `services/migrations.ts` + 临时库单测

> 来源：桌面《Lumin-待优化清单-2026-09-22.md》§1.A（自查报告 S4）。原状：163 行顺序幂等 DDL
> 散在 `database.ts`，末尾挂着一次性迁移 `migrateFileEncodings()` —— 能用，但**没有版本号**，
> 无法表达「这一步只在 v2→v3 时跑」，也看不出某个库落在哪一版。

### Changed

- **新增 `src/main/services/migrations.ts`**（264 行）：`SCHEMA_VERSION` / `MIGRATIONS` 步骤表 /
  `readSchemaVersion(db)` / `runMigrations(db)`。从 `user_version + 1` 开始依次执行未跑过的步骤，
  **每步成功后就地写下版本号**（崩溃后重跑只重做未完成的那一步）。此后新增改动一律追加一步，
  形如 `{ version: 2, up: (db) => … }`，对更老的库天然生效。
  - ⚠️ 该文件**不 import electron**（只吃 `node:sqlite` 的 db 句柄），所以单测能直接建临时库跑它。
  - 原有 DDL 原样收成 **migration 1**（保持幂等 ⇒ 对老库/新库都安全），**SQL 语义一字不改**：
    尤其 `DELETE FROM notifications WHERE scope = ''` 那条一次性清理与 FTS 的 trigram 检查都保持原样。
  - `migrateFileEncodings()` 也搬进 migration 1（它本来就是一次性迁移的形态），
    内部自带的 kv 读写（`kvGet`/`kvSet`）与 `LuminDatabase` 的同名方法**同语义**。
- `database.ts`：删掉 `migrate()` 与 `migrateFileEncodings()`（−185 行，1089 → 904），
  constructor 改调 `runMigrations(this.db)`，首次迁移时打一行 **ASCII** 日志
  `[db] schema migration: v0 -> v1`（主进程 console 必须是 ASCII，见 `tests/mainConsoleAscii.test.mjs`）。
- **唯一一处行为差异（如实记录）**：FTS「空表重建索引」原来**每次启动**都检查一次，现在只在
  migration 1 里跑一次 —— 语义等价：那次重建只在「FTS 表被 DROP 重建」时才有意义，而
  DROP/CREATE 本身就发生在 migration 1 内；将来若再换分词器，会作为新的一步迁移做同样的重建。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tests/migrations.test.mjs`（新增，`node:sqlite` 临时库） | **4/4**：① 空库 → `user_version=1`、六张表 + FTS(trigram) + documents 三列元数据全在；② 重复跑 4 次幂等不抛错；③ 老库（documents+kv+无 scope 列的 notifications）→ 补齐 `actions/payload/scope`、无归属老通知被清掉；④ kv `fileEncodings` → `documents.encoding`（路径小写+反斜杠归一）、对不上的条目留在 kv、`fileEncodingsMigrated` 打标记、再跑不覆盖 |
| 单测总量 | 291 → **295/295** |
| `vue-tsc` / `tsc -p tsconfig.node.json` | exit 0 / exit 0 |
| `eslint --cache .` | **0 error / 0 warning**（新增文件按 prettier 规整过） |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,507.47 kB 不变） |
| 真库路径回归 | `_verify-notify-disk.js` 8/8（直读 `lumin.db` 的表/列/索引）、`_verify-encoding.js` 34/34（文档级元数据）、`_verify-session.js` 17/17 |

## [Unreleased · 通知重做（四）：版式重排 + 通知降噪（保存等常规成功不再通知）]

> 用户口径：① 重构通知的布局与元素排版，使其更合理、更具审美；② 「保存文件」这类无需通知的
> 取消掉，保留必要的通知。

### Changed — 版式（`NotificationCenter.vue` + `overlays.css`）

- **两列栅格**取代 `flex + gap`：`grid-template-columns: minmax(0,1fr) auto` + 24px 列间距 ——
  左列文本可压缩、右列信息条按内容宽，且两者**天然从同一条顶线开始**。
- **信息条与标题首行结构对齐**：`.ntf-meta { height: 20px }` 就是标题行高
  （标题 `line-height: 20px`），删掉了原来 `margin-top: -3px` 的魔术补正 ——
  实测 `titleTop=87 / metaTop=87 / metaHeight=20`。
- **标题与正文共用同一条 measure（720px）**：此前标题能一路顶到右侧 ✕ 底下（行宽近 990px）。
  长标题现在换行在可读宽度内，信息条仍留在首行右侧。
- **间距节奏**：内衬 `padding: 11px 40px 13px`；正文 `margin-top: 4px`；按钮组 `margin-top: 12px`；
  分隔竖线 `12px` 高、左右 `8px`。短通知（标题+一行说明）整条 **70px**。
- **操作按钮改走全局 `.btn` 家族口径**：次按钮 `--edge-strong` 描边、hover 走副色淡底
  （与 `.btn-outline` 一致）；**主按钮改用 `--btn-solid/--btn-solid-2/--btn-ink/--glow`**
  （与 `.btn-primary` 同一套令牌）—— 之前主按钮拿副色（中性灰）当底、又拿 `--accent-ink` 当字，
  对比度只有 2 档；现在浅色/深色下都是实心渐变 + 光晕 + 高对比文字（截图核对）。
- 图标按钮圆角 8→7px、步进合成一簇（`.ntf-steps`：‹ 计数 › 等宽居中）。

### Changed — 通知降噪（10 个调用点）

**口径**（写进 `stores/ui.ts` 的 `toast()` 注释，作为以后加通知时的判据）：
只发三类 —— **失败/降级**、**需要用户作答**、**结果不在界面上**；动作结果在界面上已经可见的
常规成功**一律不发**。

| 取消（动作结果就在界面里） | 保留（必要） |
| --- | --- |
| 保存 / 另存为（4 处：文件菜单、应用内菜单、`saveWithEncoding`）—— 标题脏标记与状态栏就是反馈 | 打开失败、保存失败、导出失败、重命名失败、链接协议被拦、重文档降级源码模式、会话恢复时文件已不在、更新检查失败 |
| 打开文件夹 / 关闭工作区 —— 文件树即结果 | 链接目标不存在时的「创建并打开 / 取消」（需要作答） |
| 重命名 / 删除成功 —— 那一行会跟着变 | 导出成功（落盘路径）、更新检查结果、「功能待接入」占位（结果不在界面上） |
| 切换保存方式 —— 状态栏与勾选态会变 | |
| 全部替换 —— 查找栏自己的计数会变 | |
| 链接「已新建并打开」—— 文件随即被打开 | |

随之**真正成为死键**并已从三份语言包删除的 10 个键：`toast.saved`、`toast.folderOpened`、
`toast.workspaceClosed`、`toast.fileRenamed`、`toast.fileDeleted`、`toast.manualSave`、
`toast.autoSaveOn`、`toast.savedWithEncoding`、`find.replaced`、`links.created`
（三语键集合仍完全一致）。`docs/_audit/i18n-and-settings.md` 的占位符表与死键说明同步更新。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` / `eslint --cache .` | exit 0 / 0 error |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,507.47 kB） |
| `node --test tests/*.test.mjs` | **291/291 pass**（含三语键集合一致性） |
| `_verify-notify-style.js` | **22/22**：新增 `two-column-grid`、`title-and-body-share-measure`（720px）、`meta-aligns-with-title-line`（真实几何 top/height 对齐，非负 margin）；空态不占位、整幅带、只剩 3 个操作图标等原有断言全绿 |
| `_verify-toast-tip.js` / `_verify-notifications.js` | **21/21** / **32/32** |
| `_verify-link-open.js` | **63/63**：`created-notification-shown` → **`no-created-notification`**（反向断言：`links:created` 不再产生）+ `card-closed-after-accept` |
| 受影响的既有流程回归 | `_verify-find-replace`(24/24，全部替换不再弹通知)、`_verify-new-document`(23/23)、`_verify-encoding`(34/34，以编码保存不再弹通知)、`_verify-session`(17/17)、`_verify-wave3`(23/23)、`_verify-rename`(13/13) |
| 截图核对（临时探针，已删） | 短通知 70px / 长标题在 720px 内换行且信息条仍在首行 / 多条步进 / 长正文 + 三个操作按钮（主按钮实心渐变）/ 深色主题 |

### Docs

- 覆盖矩阵新增一行「**通知策略（哪些动作不发通知）**」并**如实标为缺口**：口径写在代码注释里，
  但没有套件守「不得再发」的负向断言（只有 link-open 那一条）。

## [Unreleased · 通知重做（三）：去级别 + 整幅带设计 + 空态不占位 + 高度动效]

> 用户口径：① 取消通知的图标和告警等级的提示，保留标题、信息、操作按钮和关闭按钮；
> ② 现在的样式不好看、没有设计感，重新设计得符合项目审美；③ 没有通知时不要挤内容
> （现在始终有一小条可见，影响观感）；④ 通知出现挤开内容时要动效。

### Changed

- **去级别**：级别图标、级别底色方块、级别名（「通知 / 已完成 / 告警 / 报错」）全部从界面上移除，
  只留**标题 / 说明 / 操作按钮 / 关闭按钮**（+ 时间与多条的 ‹ n/m ›、全部关闭）。组件里的
  `LEVEL` 映射随之删除；数据层不变（`NotificationLevel` 类型与 SQLite `level` 列仍在，
  同 `mergeKey` 合并、窗口作用域照旧）——`types.ts` 的注释写明「界面上不再展示级别」。
- **重新设计：整幅通知带**（不再是浮层卡片，也不是裸露的一行字）：
  - 形态 = **与编辑区同宽的整幅带**，中性淡底 `--accent-soft`（与侧栏选中、草稿横幅同一族）
    + 底部 `1px --edge` 分界 + 顶部 1px 内高光。强调只靠**明度差**，不用色相 —— 与主题文件头
    「副色用中性灰」的口径一致，三套主题各自取令牌，无需分主题写样式。
  - 节奏 = 左右内缩 **40px**，与写作区正文列（`TyporaEditor.vue` 的 `px-10`）对齐；标题
    13.5/500、说明 12.5/1.7 且限 **720px** 可读行宽；右侧信息条用 1px 竖线分隔成
    「时间 | 步进 | 关闭」三簇（`.ntf-sep`），步进改用紧凑档图标按钮（22px）。
  - 组件本身**没有盒子**：无边框、无圆角、无底色、无外投影（面属于带，不属于组件）。
- **空态不占位**：`v-if` 提到 Transition 内层 —— 没有通知时 DOM 里**连元素都没有**
  （实测创建前 / 关闭后 `[data-editor-kernel]` 的 top 都是 76，`bandHeight=0`），
  编辑区上方不再常驻一小条空白。
- **出现/消失的动效**：进出场把**高度、透明度、位移**一起动
  （`grid-template-rows: 0fr ↔ 1fr` + `opacity 0↔1` + `translateY(-8px)`，0.26s/0.2s），
  于是「通知带挤开正文」本身就是动画。⚠️ 0fr 要真塌成 0 高度，带子必须带
  `min-height: 0` + `overflow: hidden`（否则 fr 轨道的自动最小尺寸会把它撑回内容高度）。
- i18n：`notifications.level.{info,success,warning,error}` 这 4 个键**真正成为死键**（界面上不再
  使用），已从三份语言包一并删除（三语键集合仍完全一致）。两份审计文档中「该键被动态拼接使用、
  不是死键」的结论同步更新为「改版后已删除」。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` / `eslint --cache .` | exit 0 / 0 error |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,507.40 kB） |
| `node --test tests/*.test.mjs` | **291/291 pass**（含三语键集合一致性） |
| `_verify-toast-tip.js` | **21/21**：`enter-rule-collapses-height`（规则里 0fr/1fr + 带子 min-height:0）、真实采样进场 opacity 0→1 用时 262ms、**带高 0→67.5px 出现 7 个中间值**、离场渐隐 0.779 → 284ms 后消失；几何：带 left/right = 内核 left/right（264/1304，整幅铺满），组件无边框/圆角/底色/外投影 |
| `_verify-notify-style.js` | **19/19**：空态 `bandHeight=0` 且 DOM 无元素；带只有底部 1px 分界 + 仅 inset 内高光；标题内缩 40px；**无级别图标**（只剩 2 个步进 + 1 个关闭图标）、信息条只剩时间；长正文 maxH 46vh / maxW 720px 就地滚动 |
| `_verify-notifications.js` | **32/32**：三级别的图标/颜色断言 → 改为「无级别视觉差异」；关闭键改按信息条末位按钮定位（可访问名随语言变） |
| `_verify-notify-multiwindow.js` / `_verify-link-open.js` / `_verify-a11y.js` | **21/21** / **62/62** / **6/6** |
| 截图核对（临时探针，已删） | 浅色短通知 68px 带 / 多条（时间｜‹ 1/3 ›｜全部关闭｜✕）/ 长正文 462px 带内滚动 + 按钮 / 深色 / 羊皮纸 / 空态（无带、正文顶到 76） |

## [Unreleased · 通知条取消长方形样式] — 内容直接展示在编辑区上方那块区域里（像 Typora）

> 用户口径：**不是把原来的通知卡片原样挪到上面**，而是取消长方形组件，把通知的标题/说明等
> 直接放在编辑区上方那块区域里展示。

### Changed

- `NotificationCenter.vue` 去掉卡片外壳：不再有 `rounded-md` + `border border-edge` + 底色 +
  阴影 + 毛玻璃 + `min-h-[104px]` + 固定 `w-[min(384px,…)]`。现在整条是**外壳底色上的一段内容**：
  级别色图标 + 标题一行，正文与操作按钮另起一行，右侧是「级别 · 时间 + ‹ n/m › + 全部关闭 + ✕」
  （原来这些在卡片底栏里）。容器类名 `.ntf-card` 不再存在，改为 `.ntf-item`（外加
  `data-notification-center` / `data-ntf-item` / `data-ntf-meta` / `data-ntf-count` 稳定钩子）。
- 宽度：写死的 384px 窄条 → `w-full max-w-[820px]`（在编辑区内居中）。用户要的「显示得更全」
  现在有两层含义：横向用上了整栏宽度（长正文不再在 384px 里折成一团），纵向正文上限 `max-h-[46vh]`
  且**在区域内就地滚动**（不再把编辑区一路往下推，也不会被窗口底边裁掉）。
- `overlays.css`：`.ntf-card` 的背景/阴影/毛玻璃声明删除，只留 `.ntf-item` 的进出场 transition；
  级别不再有底色方块（`LEVEL.tint` 一并删掉，只保留文字色令牌）。
- 级别识别方式不变：仍靠**图标颜色 + 级别名**（`text-accent` / `text-ok` / `text-warning` / `text-danger`），
  三套主题自动适配。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` | exit 0 |
| `eslint --cache .` | 0 error |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,508.50 kB） |
| `node --test tests/*.test.mjs` | **291/291 pass** |
| `_verify-toast-tip.js` | **17/17**（新增 `no-card-box`、`uses-horizontal-room`；动效真实采样仍在：进场 0→1、离场渐隐后消失） |
| `_verify-notifications.js` | **32/32**（`compact-width-and-taller`+`smaller-radius` → `no-card-box`+`uses-horizontal-room`+`shown-above-editor-kernel`；meta/count 改从 `data-*` 钩子读） |
| `_verify-notify-style.js` | **15/15**（改写为「不是长方形组件」：无边框/圆角/阴影/毛玻璃/底色 + 铺满可读栏宽 + 长正文就地滚动；替掉旧的 384/6px/8px 三条） |
| `_verify-notify-multiwindow.js` / `_verify-link-open.js` | **21/21** / **62/62**（选择器与断言随新结构更新；link-open 的「卡片位置」→「通知在编辑区上方且无盒子」） |
| `_verify-a11y.js` | **6/6**（按钮迁移后 icon-only 可访问名不变） |
| 截图核对（临时探针，已删） | 浅色/深色/长正文三张：短通知就是一行文字（标题左、级别·时间与步进靠右）；长正文在区域内滚动且带操作按钮 |

### Docs

- 手册 §链接（目标不存在 → 询问是否创建）与更新检查章节的「右下角/卡片」口径改为
  「编辑区上方的通知区、不是长方形卡片」；覆盖矩阵的 toast/通知两行按新语义与新断言数更新；
  `docs/_audit/ui-inventory.md` §1.9 标注为审计快照并说明行号与「卡片」口径已过期。

## [Unreleased · 通知条搬到编辑区上方] — 位置/动效断言重写，顺手修好三个套件里过期的位置与数据目录假设

> 用户口径：把通知组件移到**编辑界面上方**出现（像 Typora 一样），位置和本项目
> 「检测到未保存的草稿（比磁盘文件更新）」那条横幅差不多，这样更方便、显示得也更全；
> 出现和消失要有动效。

### Changed

- **通知中心：右下角浮层 → 编辑区上方的文档流顶条**（`NotificationCenter.vue` 外层容器 +
  挂载点从 `App.vue` 移到 `EditorView.vue`，紧贴草稿横幅之下、编辑器内核之前）：
  - 外层容器 `pointer-events-none fixed bottom-12 right-4 z-[200] flex justify-end`
    → `pointer-events-none flex flex-none justify-center px-4 pt-3`。
    卡片本体（**宽 384 / 圆角 6px / 图标圆角 8px**）一个字符没改 —— 那三条是被断言钉住的既有口径。
  - 位置不再是「贴着窗口底边往上长」，而是**文档流里的一块**（`position: static`，容器正好是
    `[data-editor-kernel]` 的前一个兄弟）。实测卡片 `top=88 / bottom=192`、与内核顶边**齐平**（间距 0）、
    整张在视口内（`vh=821`）、状态栏顶边 `793` —— 于是**长通知不会再被窗口底边裁掉**。
  - 正文可见高度 `max-h-[38vh]` → `max-h-[52vh]`（用户要的「显示得更全」；超出仍在卡片内滚动）。
  - 动效方向跟着位置走：`.ntf-enter-from` / `.ntf-leave-to` 的 `translateY(10px)`
    → `translateY(-10px) scale(0.98)`（**自上方进场、向上离场**），220ms 时长不变。
  - **代价（如实说明）**：挂载点在 EditorView 里，所以 `/about` 这类非编辑路由上不再渲染通知条。
    这是本次的取舍 —— 通知的产生场景（保存/导出/文件树/查找/菜单）全部发生在编辑界面，
    而要「不遮挡正文、不被底边裁掉」就必须让它参与编辑区的布局。

### Fixed — 顺着这次搬家暴露/发现的套件问题

- `tools/_verify-toast-tip.js`：原来按 `.fixed.bottom-12.right-4` 找容器、断言「距底部 ≥40px /
  距右边 ≥8px」—— 通知条不再是浮层，这些断言会变成 null 比较（**实现正确也会红**）。
  改写为 16 条真断言：文档流证据（static + 容器紧邻内核之前）、几何（384 宽 / 整张在视口内 /
  不压状态栏 / 在内核之上）、动效（CSS 规则 + **真实进出场 opacity 采样**）。顺手迁到 `lib/harness`。
- `tools/_verify-link-open.js`：`card-anchored-bottom-right` → `card-shown-at-editor-top`
  （static + 整张在视口内 + 在内核之前）。**另修两个与本轮无关的假失败**：该套件直读 SQLite 时
  写死 `%APPDATA%\lumin\lumin.db`，读的是**用户真实 profile**，在运行器的隔离实例下恒为 `[]` ——
  连带 `create-mode-persisted-by-click` 一起假红（59/62 → **62/62**）；改用运行器已经提供的 `LUMIN_DB`。
- `tools/run-suites.js`：新增 `MANUAL` 排除集，把 `_verify-notify-restart.js` 移出 `--all`。
  它是两阶段套件（`seed` → **外部硬杀 + 重启** → `check`），不带参数跑只会打印用法并 `exit 1`，
  运行器读成 `0/0 FAIL` —— 每轮一个**假红**。该套件的真实用法与其 6 条断言保持不变。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` / `tsc --noEmit`（node） | exit 0 |
| `eslint --cache .` | 0 error |
| `electron-vite build` | exit 0（`EditorView-*.js` 2,508.71 kB，与搬家前一致） |
| `node --test tests/*.test.mjs` | **291/291 pass** |
| `_verify-toast-tip.js` | **16/16**（含真实动效采样：进场 0→1 用时 284ms；离场渐隐 0.939 → 257ms 后离场） |
| `_verify-notifications.js` | **31/31** |
| `_verify-notify-style.js` | **11/11** |
| `_verify-notify-multiwindow.js` | **21/21** |
| `_verify-link-open.js` | **62/62**（改前 59/62，三条全是过期假设 + 错数据目录） |
| 截图核对（临时探针，已删） | 长通知整张可见、正文滚动条在卡片内；多条时 `‹ 1/3 ›` 与「全部关闭」正常 |

## [Unreleased · 按自查报告整改] — 质量信号/隐私/文档与编码门禁/无障碍

> 用户口径：把《Lumin 自查报告 2026-09-22》里的问题都修掉。做法沿用报告里的优先级：
> **P0（当天可完成）全做，P1 做掉，P2/P3 的结构性重构按报告结论留待单独排期**（见文末「本轮未动」）。

### Fixed — 硬伤

- **H1 质量信号失真：零断言被当成通过**（`tools/run-suites.js`）
  * 判定原来只看退出码，于是「没产出任何断言」的套件显示 `0/0 PASS`，与「全绿」只差一个数字；
    实测抽样 8 个非默认矩阵套件 **8/8 都是 0/0 却被记成 PASS**。
  * 现在：`total === 0 && PASS` → **`NOASSERT`**，汇总行单列并让命令**非零退出**（要豁免得写进
    `EMPTY_OK` 并注明理由）。
  * **同时发现第二种成因并修掉**：`_verify-editor-menu.js`（51 条）、`_verify-notify-style.js`（11 条）、
    `_verify-cb-no-active-line.js`（12 条）、`_verify-notifications.js`（31 条）其实一直在断言，
    只是用老式「逐行 `PASS x` / `FAIL y`」而没有汇总行，被运行器读成 0/0。现在解析器认这种格式，
    并且**打印了 FAIL 行即判失败**（即使退出码是 0）。
  * 三个真的只打印不断言的套件补上了断言：`_verify-i18n.js`（5 条：两份语言包确实不同、菜单数量一致、
    EN 含 File/Help、ZH 含 文件/帮助）、`_verify-alt-menu.js`（3 条：Alt+F 能打开应用内菜单、含文件菜单项）、
    `_verify-toast-tip.js`（3 条：toast 高于状态栏、右侧留白、tooltip 完整在视口内）。
  * 两个**永远不可能生效**的导出套件删掉（`_verify-export-fix.js` / `_verify-export-fix2.js`：
    它们 monkey-patch `contextBridge` 暴露的**只读**对象），其意图改成**纯函数单测**
    `tests/exportPayload.test.mjs`（5 条）—— 顺带把构造逻辑抽成
    `src/renderer/src/lib/exportPayload.ts`，并用「先证明 Proxy 本身 clone 不了」的有牙断言钉死：
    传给 IPC 的必须是普通对象（这正是当年「导出 PDF 必失败」的根因）。
  * 默认矩阵接入 4 条：`_verify-remote-image.js` / `_verify-a11y.js`（新增）+
    `_verify-editor-menu.js` / `_verify-i18n.js`（复活）；新增脚本 `npm run test:suites`
    与 `test:suites:all`（`ci` 保持无头安全，不含 GUI 套件）。
- **H2 远程图片默认无条件加载（隐私）**
  * 新增设置 `remoteImages`（`click` 默认 / `always`），实现见 `src/renderer/src/lib/remoteImages.ts`：
    浏览时远程图渲染成 `<span class="img-guard" data-src=…>` —— **没有 `src` 属性就不会发请求**；
    点击/回车放行（会话级白名单）并就地换成真 `<img>`；本地图与 `data:` 内联图不受影响。
  * **导出必须放行**：`getHTML()` 期间由 `beginExportRender()/endExportRender()` 开一个同步窗口，
    否则导出的文档里图片全丢 —— 这条有单测，也有套件断言。
  * i18n 三语各加 3 个键（`settings.remoteImages` / `settings.remoteImagesHint` /
    `editor.imageRemoteHidden`）；占位样式见 `style.css` 的 `.md-preview .img-guard`。
  * 验收：新增 `tools/_verify-remote-image.js` **7/7**（DOM 里没有任何 http(s) 的 `img`、
    占位带 `data-src`、`getHTML()` 仍含真实 src、点击后出真图、策略 `always` 直接出图）。
- **H3 文档与代码一致性没有门禁**
  * 新增单测 `tests/docsClaims.test.mjs`：① README 正文不许再出现已移除功能（气泡菜单 / 下划线 /
    Underline）；② README、手册、台账里用代码体引用的仓库路径必须存在（含简写根的宽容解析；
    历史叙述行、CHANGELOG 这类追加式日志不查）；③ 三语包键数一致。
  * 用它查出并修掉 4 处真实漂移：手册的 i18n 路径与 fallback（`renderer/src/i18n/locales/*.json` →
    `src/shared/i18n/*.json`，`fallbackLocale` 早已是 zh-CN）、两个早已移除的临时探针引用、
    `build/icon.ico`（已删的模板占位图）、`app-update.yml`（打包产物，仓库里没有）。
  * 另修 `src/main/fileOps.ts` 的陈旧注释：「本仓库连本地历史都还没有」——本地历史早已落地
    （`database.ts` 历史表 + `ipc.ts` 写盘钩子），现在写清两层的分工。
- **H4 源码编码没有门禁（一次真实事故）**
  * 新增单测 `tests/encodingGuard.test.mjs`：扫 `src/tests/tools/docs/build/resources` + 根文档，
    查 ① `U+FFFD`、② 正文里的 GBK↔UTF-8 双重编码特征（跳过行内代码/引用块，并豁免本文件）、
    ③ 非 `.ps1` 文本文件不许带 BOM（`.ps1` 反过来要求带，见 `tests/tooling.test.mjs`）。
  * **它立刻抓到 7 个带 BOM 的文件**（4 个 `.ps1` + 3 个 `_verify-notify-*`），已按规则分别处理；
    写这份门禁的过程中我自己又用 PowerShell 往返改坏了一次文件（mojibake + BOM），
    被它当场拦住 —— 这条门禁的价值是实测过的。

### Added — 报告里的 P1/P2 小项

- **O5 无障碍基线**：新增 `tools/_verify-a11y.js`（6/6）—— icon-only 按钮必须有可访问名、
    根元素有 `lang` 与主题类、侧栏分段控件的 `aria-label`/`aria-selected` 齐全、
    查找栏展开后 `aria-expanded` 一致。实测当前 0 个缺名按钮。
- **O6 安全与数据安全断言**：新增 `tests/guards.test.mjs`（5 条）—— 窗口安全三件套不许回退、
    CSP 必须 `default-src 'self'` + `script-src 'self'`、`shell.openExternal` 一律先过 scheme 白名单、
    用户文档落盘必须走 `fileOps.writeFile`（直接写盘的文件逐个登记并写理由）、
    卸载不许删用户数据。**顺带修了一处真实口径分裂**：`src/main/index.ts` 的
    `setWindowOpenHandler` 原来自己写了 `/^https?:\/\//` 就地判据，现在统一走 `links.safeExternalUrl()`。
- **S5 不再产出未验证的平台包**：`build:mac` / `build:linux` 改成
    `tools/refuse-unverified-platform.js` —— 直接失败并打印「为什么不做、要做得先补什么」，
    而不是让人不小心发出一个没验证过的包。

### Fixed — 整改过程中被既有测试抓住的两处回归（如实记录）

- `resources/icon.png` 换成交付原图后，**应用内标识（内嵌 128×128 位图）没同步** ——
  被 `tests/toolIcon.test.mjs` 抓住，已跑 `node tools/sync-app-icon.js` 重新生成
  （这是上一轮换图标时漏掉的一步）。
- 我一度把 4 个 `.ps1` 的 BOM 当成「多余」删掉，被 `tests/tooling.test.mjs` 抓住：
  Windows PowerShell 5.1 读非 ASCII 脚本**必须**有 BOM。已复原，并把例外写进编码门禁。

### 本轮未动（按报告结论留待单独排期）

- **S1**（tools/ 比 src/ 大、无统一 harness）、**S2**（`style.css` 2,160 行、32 个组件仅 4 个 scoped）、
  **S3**（编辑器内核 2,533 行 + 62 处 `setTimeout`）、**S4**（`database.ts` 971 行、无版本化迁移）：
  都是多天量级、且 S2 需要三主题目视核对的重构，报告里已给出做法与成本。
- **O1**（mermaid 家族 3.5MB 按需收窄）、**O2**（代码块 CodeMirror 虚拟化）、**O3**
  （`@codemirror/language-data` 1.4MB 取舍）：报告结论是「需要拍板」，未擅自改行为。
- **O4**（主进程启动后置项 10–40ms）：报告结论是「不建议做」，维持原样。

### Verification

| 门禁 | 结果 |
| --- | --- |
| `npm run test:unit` | **286/286**（本轮 +23：exportPayload 5 / encodingGuard 4 / docsClaims 3 / remoteImages 6 / guards 5；另有既有 263 条全绿） |
| `vue-tsc` / `tsc` / `eslint --cache .` / `electron-vite build` | exit 0 / exit 0 / **0 error 0 warning** / exit 0 |
| `tools/_verify-remote-image.js` | **7/7** |
| `tools/_verify-a11y.js` | **6/6** |
| 复活的旧套件 | `_verify-editor-menu.js` **51/51**、`_verify-notifications.js` **31/31**、`_verify-cb-no-active-line.js` **12/12**、`_verify-notify-style.js` **11/11**、`_verify-i18n.js` **5/5**、`_verify-alt-menu.js` **3/3**、`_verify-toast-tip.js` **3/3** |
| 回归批（image 相关改动 + 相邻面） | `_verify-remote-image.js` 7/7 · `_verify-a11y.js` 6/6 · `_verify-editor-menu.js` 51/51 · `_verify-i18n.js` 5/5 · `_verify-local-media.js` 10/10 · `_verify-find-replace.js` 24/24 · `_verify-surfaces.js` 37/37 · `_verify-notifications.js` 31/31；两个**既有**批次敏感项：`_verify-inline-formats.js` 批量里 179/182、**单独跑 182/182**（前一个套件留下的剪贴板/实例状态影响粘贴夹具），`_verify-md-fidelity.js` 批量里退出码非零但自身计数 `102 PASS 101 FAIL 0 SKIP 1`、**单独跑退出码 0** —— 两者都与本轮改动无关（单独跑全绿），已记录为「套件对批次状态敏感」这一类既有问题 |
| `run-suites.js` 的 NOASSERT 门禁自检 | 故意点名两个空断言套件 → 显示 `NOASSERT` 且退出码 1 |

## [Unreleased · 应用图标按交付资产重新装档] — 母图换成交付原图，ICO 补到 11 档

> 用户口径：桌面 `Lumin图标/` 里给了 `png/` 与 `ico/` 两套（各 36 个尺寸），
> 要求把项目图标换成这套、并把**合适的尺寸放到正确的位置**。

### 先核实：交付的东西到底是什么

| 核查项 | 结果 |
| --- | --- |
| `png/Lumin-size-1024-*.png`（母图）vs 项目原 `resources/icon.png` | 同为 1024×1024 的**同一设计**：逐像素比 1,048,576 个像素里只有 1,647 个不同、最大通道差 **3/255**（等于重新导出了一次）；缩到 32×32 后只有 7 个像素差 ≤2 |
| `ico/` 目录里的 36 个文件 | **不是 ICO**：文件头是 PNG（`89 50 4E 47`），只是扩展名写成了 `.ico` —— 正是 `electron-builder.yml` 与 `tools/_verify-packaging.js` 里记过的那个坑（PNG-in-ICO 在 GDI+ `Icon.ToBitmap()` 路径上取不到图，资源管理器会显示缺省图标）。**不能直接用** |
| 交付的各档 PNG vs「母图按框滤波缩到该档」 | 取景/留白**一致**（16/20/32/64/128/256 逐档边距与墨迹占比完全相同，其余档差 ≤3%），说明各档就是同一张图的等比缩放，没有为小尺寸单独改形 |
| 现有打包产物 | `dist/win-unpacked/Lumin.exe` 与 `dist/Lumin-1.0.0-setup.exe` 抽出来的 32×32 图标与 `resources/icon.ico` **一致**（同像素值）→ 安装器图标本来就已经跟着应用图标走，`nsis.installerIcon` 无需另配 |

**结论：这套设计项目里本来就在用**（上一轮换图标用的就是它）。所以本轮不是「换一张新图」，
而是把交付资产**按项目的正确位置装档**，并把尺寸档补齐。

### Changed

- `resources/icon.png` ← 交付的 **1024×1024 母图**（733,821 B）。它是**唯一**该进仓库的 PNG：
  主进程的窗口图标（非 Windows 分支 `import appIconPng from '../../resources/icon.png?asset'`）
  与 electron-builder 的 linux/mac `icon` 都用它。其余 35 个尺寸**不放进仓库** ——
  ICO 由这张母图生成，放进来只会变成没人读的死重量。
- `resources/icon.ico` 由 `node tools/pack-ico.js` 重新打档（**这是 yml 里写明的换图流程**）：
  **7 档 → 11 档**（372,526 B → 440,766 B，全部是 32 位 BGRA DIB + AND 掩码）。
  原有 7 档（16/24/32/48/64/128/256）的负载**字节完全不变**，新增 **20 / 40 / 72 / 96**：
  它们分别对应 125%（16→20、32→40）、150% / 175% 与任务栏大图标；缺了这几档时 Windows
  只能拿 32 或 128 去插值，任务栏与 Alt+Tab 会发糊。交付目录里本来就有这几档，
  说明设计在这些尺寸下是过审的。
- `tools/pack-ico.js`：`SIZES` 补上 20/40/72/96 并写清「为什么是这几档」；
  顺带更正注释里「档位都整除母图尺寸」的说法 —— `downscale` 用的是按边界的面积加权框滤波，
  非整数倍率（1024/20、/72、/96）一样正确，不会退化成最近邻。

### Verification

| 项 | 结果 |
| --- | --- |
| `node tools/pack-ico.js`（自带自检） | `WROTE resources/icon.ico`；11 档全是 DIB，自检通过 |
| `node tools/pack-ico.js --check` | `{"entries":[16,20,24,32,40,48,64,72,96,128,256],"ok":true}` |
| `electron-vite build` + `electron-builder --win` | exit 0；`dist/win-unpacked/Lumin.exe` 与 `dist/Lumin-1.0.0-setup.exe` 重新产出 |
| 打包复验（与 `_verify-packaging.js` 的 B 段同口径；临时脚本已删） | 11 档负载在 `dist/win-unpacked/Lumin.exe`（211,300,864 B）里**逐字节全部命中 11/11**；安装器 `Lumin-1.0.0-setup.exe`（130,620,381 B）同样 **11/11**；反证：`node_modules/electron/dist/electron.exe` **0/11** |
| 抽取渲染（.NET `Icon.ExtractAssociatedIcon().ToBitmap()`，与资源管理器同一条 GDI+ 路径） | 从新 exe 抽出 32×32 正常出图（未触发 PNG-in-ICO 的 `Requested range extends past the end of the array`），人工核对为「白底圆角卡片 + 黑色衬线 L + 纸纹」 |
| 运行时（开发态窗口 / 任务栏）图标路径 | 启动后 `%TEMP%\lumin-icons\` 里生成了**按新内容哈希命名**的副本 `lumin-a549bc29.ico`（440,766 B），与 `resources/icon.ico` **逐字节一致**；旧的 `lumin-3c76e6c5.ico` 是上一版 —— 这正是 `taskbar.runtimeIconPath()` 用内容哈希换路径来击穿 Windows 图标缓存的机制 |
| 仓库体积 | 图标资产 372,526 + 733,751 → **440,766 + 733,821 B**（净 +68KB，全部落在 exe 资源里，安装包 130MB 量级下无感） |

## [Unreleased · 讨论里列的问题逐项核实与修复] — 引用快捷键 / 专注模式 / 文档失真

> 用户口径：把前两轮讨论（工具栏的必要性与成本、产品定位与工具栏是否冲突）里我列出的
> **全部问题和 bug** 修掉。做法：**先逐项实测**，能复现的才改；复现不了的按「结论：不是 bug」记录。

### 核实结论（两条我说错了，这里更正）

| 讨论里的说法 | 实测 | 结论 |
| --- | --- | --- |
| 右键菜单把删除线的键标成 `Ctrl+Shift+X`，而 Tiptap 内建是 `Mod-Shift-s`，所以**提示是假的** | `typoraInlineMarks.addKeyboardShortcuts` 里**真的绑了** `'Mod-Shift-x' → toggleMdStrike()`；`Mod-Shift-s` 那条内建虽然被 `file.saveAs` 挡住，但我们从不依赖它 | **不是 bug**，提示与真实绑定一致。我当时只查了 Tiptap 的扩展，漏查了我们自己的 keymap |
| 工具栏弹簧区带 `data-toolbar-item`，会**吞掉空白区右键**（审计里的 A1 悬案） | 实测右键弹簧区 **menuOpen=true**（能弹）；分段控件上右键 menuOpen=false（正确）。原因：弹簧区是 `min-w-2 flex-1` 在 `items-center` 行里，**高 0px**，命中测试落不到它身上，那个属性是惰性的 | **不是 bug**，A1 结案。属性冗余但无害，且套件按 `[data-toolbar-item]` 计数，故**保持原样** |

### Fixed

- **引用（blockquote）没有任何可用快捷键**：Tiptap 自带的是 `Mod-Shift-b`，而 `Mod+Shift+B` 被本应用的
  「切换侧栏」（`view.toggleSidebar`，全局捕获阶段）占用 → 内建那条**永远按不出来**，右键菜单里这条
  动作此前也不显示任何键。现在在 `lib/editor/keymap.ts` 的 `TyporaKeymap` 里补 **`Mod-Shift-q`**
  （与 Typora 的引用快捷键一致；与 27 条应用级默认键无冲突，因为它是编辑器级绑定），
  并在 `lib/editor/menu/actions.ts` 的 `paragraph.quote` 上写出 `Ctrl+Shift+Q` 提示。
  实测：段落 → 引用 ✓、再按一次切回 ✓、右键菜单显示 `引用 Ctrl+Shift+Q` ✓、`Ctrl+Shift+B` 仍切侧栏 ✓。
- **专注模式名不副实（定位冲突的那一条）**：`focusMode` 原先只收窄正文列（1140px）+ 压暗侧栏，
  **最显眼的 44px 常驻工具栏却留着** —— 与本产品「纸面优先的 Typora 式写作」定位相抵。
  现在专注模式下**工具栏一并隐藏**（`EditorView.vue`：`v-if="settings.toolbarVisible && !ui.focusMode"`）。
  退路不受影响：`Ctrl+Shift+F`、视图菜单、状态栏都能切回来，所以顶栏**故意保留**。
  实测：进入专注 → 写作区顶边 76 → **32**（省下 44px）、退出即恢复。
  连带修：查找浮条是按写作区顶边定位的，工具栏显隐/专注切换后**必须重新量一次**，
  否则会悬在旧高度 —— `FindReplaceBar.vue` 新增对 `[settings.toolbarVisible, ui.focusMode]` 的 watch。
  实测：普通态浮条 y=86（内核顶 76+10），切到专注后 **y=42**（内核顶 32+10）✓。
- **对外文档仍在宣传已被移除的功能**（README 是产品的功能清单，等于定位的对外表述）：
  * `README.md`：删掉「✅ 选区气泡菜单：加粗/斜体/下划线/…」（该组件第 25 轮已删）、
    功能列表里的「下划线」、技术栈表里的 `Underline`；补一条真实的
    「✅ 格式化入口：快捷工具栏 + 编辑器右键菜单 + 顶部菜单栏（三处同一套动作；工具栏可整体关闭、
    逐项显隐与排序）」。
  * `docs/typora-wysiwyg-manual.md`：§3.8 标题改为「选区浮动菜单（气泡菜单 · 已移除）」并在节首
    加显著说明（正文保留，作为「自绘浮动层」的原理与踩坑记录 —— 坐标系/视口钳制/焦点保持这些结论
    对今天的查找浮条、弹层、右键菜单仍然有效）；架构树里那一行标注已移除；文件职责表里
    `TyporaEditor.vue` 的后缀去掉气泡菜单；§3.x 两处「气泡菜单 …」改成仍在用的浮层；
    §5「步骤 8」标注气泡菜单部分已移除。

### 记录更正（我自己的错误）

- 第 25 轮 CHANGELOG 写的「清理失真文档：`README.md` 的『选区气泡菜单 ✅』、手册 §3.8 的气泡菜单
  实现说明」**两处都不准确**：`git show 7c56bdf --name-only` 里**没有 `README.md`**（最近 8 个提交
  也都没碰过它），手册那 83 行新增里也没有 §3.8 的更正。也就是说：**代码删了、对外表述没跟上，
  我还在 CHANGELOG 里登记为已完成**。本轮把 README 与手册 §3.8 真正改到位，并留下这条更正记录 ——
  它是「同一批动作有多套手工维护的入口/清单」这一成本的实例，而这次踩的是我自己。

### Verification

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` / `eslint --cache .` / `electron-vite build` | exit 0 / 0 error 0 warning / exit 0 |
| `npm run test:unit` | **263/263** |
| `tools/_verify-toolbar-settings.js`（工具栏显隐/排序/空白右键） | **37/37** |
| `tools/_verify-find-replace.js`（我改了 FindReplaceBar 的定位 watch） | **24/24** |
| `tools/_verify-inline-formats.js`（格式键与工具栏动作的相邻面） | **182/182** |
| `tools/_verify-bars-no-filename.js` | **12/12** |
| 修复验收探针（临时，已删；**6/6 PASS**） | `Ctrl+Shift+Q` 段落→引用、再按切回；专注模式隐藏工具栏（内核顶 76→32）、退出恢复；查找浮条普通态 y=86 / 专注态 y=42（都 = 内核顶 + 10） |
| 二次探针（临时，已删；**2/2 PASS**） | `Ctrl+Shift+B` 仍切侧栏（新键没抢）；右键菜单「段落」子菜单里 `引用 Ctrl+Shift+Q` 真的渲染出来 |
| `_verify-keymap.js` | **SKIP**（它要 dev server，不在默认矩阵）——本轮没有改 `useKeymap.ts` 的命令表（`git status` 可证），新增的 `Mod-Shift-q` 是**编辑器级**绑定，故「命令表 27 条 / 无重复默认键」不受影响；上面那条 `Ctrl+Shift+B` 探针直接覆盖了「新键没抢旧键」的风险 |
| `_verify-editor-menu.js` | 0/0（该套件在本环境本来就不产出断言，非本轮回归） |

## [Unreleased · 查找：不压工具栏 + 精确落位 + Typora 命中配色]

> 用户口径（三条）：① Ctrl+F 的查找/替换组件**会遮挡快捷工具栏**；
> ② 命中多处时，点上下切换**不会定位到准确的字符位置**；
> ③ 匹配的字符要有**底色**，当前匹配也要有颜色，「颜色和 Typora 保持一致即可」。

### Fixed

- **浮条压住快捷工具栏**：`top: 62px` 是拍脑袋常数，而顶部菜单栏（32px）+ 工具栏（44px）= 76px
  —— 62 正好落在工具栏里。现在按**写作区内核的实际顶边**定位：新增语义锚点
  `[data-editor-kernel]`（`EditorView.vue` 里那个 `relative flex min-h-0 flex-1` 容器，
  wysiwyg / split / source 三种模式下都是同一个矩形），浮条 = 它的顶边 + 10px。
  工具栏可被设置隐藏、菜单栏在 Windows 上也可能不显示，所以必须量而不能写死；
  量不到时退回「工具栏下沿 + 10」。实测：工具栏底 76 → 浮条 y **86**（间隙 10px）。
- **上下切换不定位到准确字符**：两处原因都修了。
  * 链上的 `scrollIntoView()` 交给 PM 默认实现，只做**最小滚动** —— 命中被滚到容器边缘，
    而顶边恰好压着工具栏/浮条，看着就像「没跳准」；跨行命中还会按选区 head 偏。
    现在按命中自己的**几何矩形**（`coordsAtPos` 两端）做一次带安全边的滚动
    （上留 56px、下留 16px，只补差值），源码面则把命中行放到视口约 1/3 处。
  * 实测：连续 `step(1)` **14 次** + 反向 **6 次**，每次当前命中的矩形都完整落在滚动容器可视区内、
    不在工具栏/浮条之下（20/20）。

### Changed

- **命中配色改成 Typora 的口径**（原来所有命中都只有一道 `--sel` 灰底、且**只画当前那一处**）：
  * 命中高亮从「只画当前命中」改成**整批都画**：`.find-hit`（全部）/ `.find-hit-current`（当前），
    桥的契约随之从 `(active, from, to)` 扩成 `(ranges[], current)` —— 仍是**纯数据**、零依赖，
    store 一侧照旧不认识 ProseMirror（首屏 entry 不受影响）。整批上限 2000 处（防「单空格」这类
    上万命中的极端情况）。
  * 配色取自 **Typora 自己的截图逐像素采样**（浅色 `github` 主题：命中 `#FDECD5` 淡琥珀 /
    当前命中 `#FFCF8F` 重琥珀）；深色照 Typora `night.css` 的**蓝色**高亮（半透明蓝底 +
    实蓝 `#428BCA` 当前项 + 白字，typora-issues#5760 明确提到 night 主题的搜索高亮是蓝色）；
    羊皮纸跟随浅色暖色系但各压深一档。三套值全部走令牌（`--find-hit-bg` / `--find-current-bg` …），
    改主题只动令牌。
  * 实测浅色计算值：命中 `rgb(253,236,213)`、当前 `rgb(255,207,143)`，两者不同 ✓。

### Verification

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` / `eslint --cache .` / `electron-vite build` | exit 0 / 0 error 0 warning / exit 0 |
| `tools/_verify-find-replace.js` | **24/24**（展开/收起、Aa 与 .* 开关、替换当前/全部、Esc 离场、源码面、非法表达式） |
| `_verify-round-24.js` / `_verify-inline-formats.js` / `_verify-marker-hold.js` | 15/16 + 1 SKIP / 182/182 / 11/11 |
| `_verify-drag-selection.js` / `_verify-line-end-click.js`（同一个装饰插件，回归） | 10/10 / 7/7 |
| 三项要求的临时探针（已删；**8/8 PASS**） | ① 浮条 y=86 ≥ 工具栏底 76、与内核顶边差 10px；③ 命中元素 240 个（全部命中都有底色）、当前命中恰好 1 个且颜色不同、浅色值 = Typora 采样；② step +14 / −6 全部完整可见；关闭后高亮清零 |
| 截图核对（浅色 / 深色整窗） | 浮条稳在快捷工具栏**下方**、不再压住图标行；浅色为淡琥珀底 + 重琥珀当前项，深色为蓝色系（当前项实蓝白字） |

## [Unreleased · 查找/替换栏重做] — 尺寸间距对齐全局语言

> 用户口径：Ctrl+F 出来的查找、替换组件「有一点生硬」，要求更好看、更简约、布局更合理、
> 大小与间距合适。

### Changed

- **`FindReplaceBar.vue` 的尺寸/间距口径与全局对齐**（原来是 4px 间隙 + 6px 内边距 + 26px 控件
  + 6px 圆角，和刚收敛过的侧栏/工具栏不是一套语言）：
  * 控件高 **28px**、按钮 26px、圆角 **12/9/7px**（条 / 输入组 / 按钮）、行内间隙 **6px**、
    条内边距 **8px**；
  * 两行之间不再靠 `gap` 硬挤：**1px 发丝线 + 上下各 8px** 留白分层；
  * 输入框不再当「带边框的灰块」：**输入组**（放大镜 + input + 命中计数）自己是一块
    `--panel-2` 软底，里面 input 全透明；聚焦给整组 **3px `--accent-soft` 柔光环**
    —— 与侧栏那个搜索框同一套语言，不再出现「边框突然变强调色」的生硬切换。
- **布局更合理**：
  * **命中计数搬进输入组右端**（原来是浮在行中间一个 46px 定宽、右对齐的孤立数字，
    把视觉节奏切断了）；
  * **两行输入框左缘严格对齐**：替换行左侧留出与「三角 22px + 间隙 6px」等宽的
    `.find-gutter`，实测两个 input 的 `x` 都是 930；
  * 动作组（上一个/下一个）与开关组（Aa / .*）之间加 **1px×16px 竖分隔**，
    分组一眼可读；「替换 / 全部替换」由裸文字改成**带 1px 描边的幽灵按钮**。
- **两个真实的实现改进**（顺手修的）：
  * 折叠三角原来的旋转用 Tailwind `rotate-90`（写的是 `rotate` 长属性）配
    `transition-transform` —— **根本不会动**（style.css 里记过这个坑）。改成 scoped 样式里
    对 `svg` 做 `transform: rotate(90deg)` + 0.18s 过渡，现在真的会转。
  * 正则写错时，红色只描在 1px 边框上很容易被忽略 —— 改成整组 `box-shadow: 0 0 0 1px danger`
    + 计数区红字「表达式无效」+ 正则芯片红字，三处同时提示。
- `prefers-reduced-motion: reduce` 下三处过渡全部关闭。

### Verification

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` / `eslint --cache .` / `electron-vite build` | exit 0 / 0 error 0 warning / exit 0 |
| `tools/_verify-find-replace.js`（唯一碰这根栏的套件，24 条：展开/收起、Aa 与 .* 开关、替换当前/全部、Esc 离场、源码面、非法表达式） | **24/24** |
| `_verify-inline-formats.js` / `_verify-marker-hold.js`（命中高亮与标记的相邻面） | 182/182 / 11/11 |
| 几何 + 三态截图（临时探针，已删） | 收起 `421×46`、展开 `421×91`、`padding 8px`、`radius 12px`、行高 28px、两行 input 的 `x` 都是 **930**（左缘对齐）；截图核对：软底输入组 + 计数在内、动作/开关之间有竖线、替换行发丝线分层、按钮描边；非法态整组红环 + 红字 + 正则芯片红字 |

## [Unreleased · 浅色写作区改纯白] — `--paper: #ffffff`

> 用户口径：把**文本编辑区域**在浅色主题下变成**纯白**。

### Changed

- **浅色主题的写作区（纸）`--paper: #fcfcfb → #ffffff`**（`style.css` 的 `.theme-light` 块）：
  编辑器渲染面、源码面、设置里的排版预览、启动骨架的正文区全部跟着变纯白（它们都铺这个令牌）。
  连带的口径变化，都已写进注释与测试：
  * **与外壳的明度差反而更大**：`--app` 仍是 `#f2f3f7`，纸/外壳对比度 1.09 → **1.12**
    （不变量①「纸比外壳亮」更强了）；正文对纸的对比度也从 15.3 提到 **15.57**。
  * **与 `--panel`/`--elevate` 同色**（浅色下 `#ffffff` 是亮度上限，这一档明度差不可能再有）：
    对话框 / 菜单 / 气泡 / 输入框这些浮层改由 **1px `--edge` 边框 + `--shadow-2` 投影**立起来
    —— 它们本来就都带边框或投影，实机截图核对无「浮层融进纸里」的情况。深色 / sepia 不受影响，
    仍是「面板比纸再亮一档」。
  * `src/shared/theme.ts` 的窗口底色镜像（主进程防闪白用）同步为 `#ffffff`；
    `tests/themeTokens.test.mjs` 会把两边钉在一起，不同步就会红。
- `tests/themeTokens.test.mjs` 的**不变量②**按新口径重写：底线改为「面板**不比纸暗**」；
  深色 / sepia 仍要求**严格更亮**（保留原意图）；浅色则要求「纸与面板都是纯白」——
  如果哪天有人把纸改回近白却没同步这条例外，这里会红。

### Verification

| 门禁 | 结果 |
| --- | --- |
| `npm run test:unit`（263 条） | **263/263**（含重写后的不变量②、窗口底色与 `--paper` 逐主题一致） |
| 数值关系（测试打印） | ink/paper 对比度 `light 15.57 / dark 15.29 / sepia 9.81`；面/纸对比度 light `codeBg 1.119 / panel2 1.193 / edge 1.25 / edgeStrong 1.47`（阈值 1.05 / 1.08 / 1.1 / 1.25 全部通过，且比改前更高） |
| `vue-tsc --noEmit` / `electron-vite build` | exit 0 / exit 0 |
| `tools/_verify-surfaces.js`（T 段就是「写作区铺 --paper + 与外壳的关系」） | **37/37** |
| `_verify-neutral-accent.js` / `_verify-sidebar-tree-style.js` / `_verify-toc-style-scroll.js` / `_verify-theme-auto.js` / `_verify-blockquote-style.js` / `_verify-marker-hold.js` / `_verify-segmented-control.js` | 10/10 / 32/32 / 23/23 / 11/11 / 13/13 / 11/11 / 16/16 |
| 计算样式探针（临时，已删；5/5 PASS） | `--paper` 解析为 `rgb(255,255,255)`；**渲染面 = 源码面 = `rgb(255,255,255)`**；外壳 `rgb(242,243,247)`（两段式不塌）；代码块 `rgb(241,242,245)` 在白纸上仍可辨 |
| 实机截图（三主题整窗） | `lumin-theme-light.png`：侧栏浅灰 + 写作区纯白，边界清楚；深色 / sepia 未受影响 |

## [Unreleased · 侧栏文件工具贴底 + 观感收敛] — 搜索与树/列表切换移到面板下方并重做样式

> 用户口径：① 侧栏顶部的「搜索文件名」和「树 / 列表」切换放在上面太影响视觉，移到下方；
> ② 这一行控件「不好看、太影响观感」，要求再优化，保持大气好看、简约简洁；
> ③ 搜索框再收敛：**平常只剩一枚放大镜图标，点开才展开成输入框**；
> ④ 修掉失焦时的**闪烁**，并为展开/收起加**好看的动效**；
> ⑤ 反馈「展开的时候还是会出现闪烁」—— 用**逐帧**采样（页面内 `requestAnimationFrame`）定位并修掉。

### Fixed

- **展开时闪烁（逐帧实测定位到的三处，都已修）**：页面内逐帧记录「外壳宽度 / 背景 /
  焦点环 / 输入框是否存在与 opacity」，抓到两个真实信号与一处循环：
  * **焦点环在 28px 的小方块上先亮一下**：展开瞬间输入框就拿到焦点，环立刻出现，
    而那时外壳还只有 28px —— 眼睛看到的是「小方框亮一圈，然后才长开」。
    修法：`box-shadow` 也参与过渡并**延后 60ms**（`0.16s ease 0.06s`），
    等外壳长到 ~100px 再淡入 ⇒ 观感变成「字段长开的同时光环浮现」。
    修后逐帧：`w=57.7/99.8/133.9` 时环仍是全透明，`w=147` 起才从 `rgba(17,24,39,0)` 淡到 `0.067`。
  * **「空条帧」**：输入框带 40ms 延迟的淡入 ⇒ 外壳已经变宽、里面却什么都没有（约 3–4 帧）。
    修法：输入框**不做进场动画**，占位文字第一帧就在，靠 `overflow: hidden` 随宽度被揭示。
    （`<Transition>` 的 `name` 故意不叫 `fade` —— style.css 里的全局 `.fade-enter-*`
    会把淡入加回来。）离场仍保留 0.16s 淡出，收起时文字跟着宽度一起收进去。
  * **「点一下图标」会先收起再展开**（宽度先缩后长 = 闪一下）：点图标时 `mousedown`
    先把焦点从输入框拿走 → `blur` 触发 → 同步收起；随后这一下的 `click` 又展开。
    修法两道护栏：图标上 `@mousedown.prevent`（不抢焦点 ⇒ blur 压根不发生）+
    `onSearchBlur` **延迟一拍再判**（下一拍焦点仍在壳内就不收起）。
- **搜索框失焦闪烁（结构性问题，已根治）**：上一版是「收起时按钮 `v-if` 立刻出现 +
  旧输入框还在 `fade` 淡出」—— 两个兄弟元素同时占着同一个 `flex-1` 槽位，中间帧必然抖一下
  （而且展开时是反过来的：按钮先消失、输入框才淡入）。
  现在**只有一个元素会变形**：`.file-search` 外壳（放大镜按钮**始终在壳里、从不卸载**），
  收起 28px 宽 / 透明底 → 展开 100% 宽 / 白面底；输入框只是壳里的一个 `v-if` 子元素。
  于是「按钮与正在淡出的输入框同框」这种中间帧在结构上不可能出现。
  实测证据：整个过渡期间每 30ms 采样一次，`[data-sidebar-search]` 恒为 **1** 个、
  `.file-search__icon` 恒为 **1** 个且**始终是同一个 DOM 节点**（`sameIconNode: true`）。

### Changed

- **展开/收起的动效**（本轮新增，都在合成/绘制层）：
  * 外壳 `width` 28px ⇄ 100%，`0.2s cubic-bezier(0.32,0.72,0,1)`；`overflow: hidden`
    让输入框随宽度**被揭示**出来，而不是「先出现再被挤」——这也是没有宽度抖动的原因；
  * 外壳 `background-color` 透明 ⇄ `--panel` 同长过渡；展开后才出现 `focus-within`
    的 `--accent-soft` 光环；
  * 输入框自身一次 `0.14s` 淡入（带 40ms 延迟，跟住宽度揭示的节奏）。
  * 放大镜按钮位置**一个像素都不动**（左右内缩恒为 7px：7 + 图标 14 + 7 = 28px 正好居中），
    观感就是「同一枚放大镜长出了一个输入框」。实测：收起/展开两态 `iconLeft` 都是 17。
  * 实测宽度序列（30ms 采样）：展开 `28 → 99.8 → 147.3 → 157.9 → 161.9 → 163.6 → 164`；
    收起 `58 → 34.1 → 30.1 → 28.4 → 28` —— 都是连续单调的中间帧，不是瞬变。
  * `prefers-reduced-motion: reduce` 下三条过渡全部关闭。

- **搜索平常收起成一枚放大镜**（`data-sidebar-search-toggle` → `data-sidebar-search-box`）：
  静息态这一行只有「一枚 28×28 图标（`icon-btn` 自带悬停浅底 + title/aria-label）」和右侧的
  分段控件；点图标 → 白面输入框淡入（复用全局 `fade` 过渡）并自动聚焦。
  收起规则三条，目的都是**筛选条件不能悄悄消失**：
  * 失焦且输入为空 → 收起；
  * 失焦但**有内容** → 保持展开（否则条件被藏进一个看不见的输入框里）；
  * `Esc` → 清空并收起；输入框里的 × 只清空、不收起；离开「文件」页签 / 关掉工作区也收起
    （面板是 `v-show` 常驻的，不收起下次回来会「自己开着」）。
  收起/展开共用一个 `flex-1` 槽位，收起时图标靠左、空白自然把分段控件推到右边，
  展开时输入框占满 —— 不需要额外撑宽的占位元素，也没有宽度动画带来的抖动。
- **`FileTree.vue` 的「搜索 + 视图切换」从面板顶部移到**文件面板底部**（`data-sidebar-filetools`）：
  顶部从此只剩「工作区名 → 页签 → 树」，视线第一落点不再被一个输入框抢走。
  布局仍是「内容 flex-1 + 工具带 flex-none」，所以工具带**永远贴在侧栏最下方**，
  且只在**打开了工作区**时出现（没有工作区时仍是那三个图标 + 提示文案的空态）。
- 为什么留在 `FileTree` 而不是并进 `AppSidebar` 的全局底栏（设置 / 关于 / 收起）：
  它只服务「文件」页签 —— 切到大纲时不该出现；放在这里视觉上同样是侧栏最下方，
  语义上仍属于文件面板。
- **观感口径（第二次调整）：这一行只允许一个「有形状的控件」**（原版是两个「带边框 + 投影」的
  白块并排，在侧栏底部互相抢视觉）：
  * **搜索框去掉 1px 边框**，只用一块白面（`--panel`）+ 10px 圆角表达；聚焦时才补一圈
    `--accent-soft` 柔光环（`focus-within:shadow-[0_0_0_3px_var(--accent-soft)]`）——
    静息态少一条线；内缩与图标同步收一档（`px-2.5`、图标 12.5px），固定 `h-7`。
  * **分段控件新增 `variant="quiet"`**（`SegmentedControl.vue`）：轨道透明、无发丝边、无投影，
    指示块换成一枚 `--panel-2` 软底块；选中图标改用字色而不是品牌色（旁边就是输入框，
    一点彩色就会显得跳）。`quiet` **只把边框改成透明**，所以高度/内缩/指示块定位的算式与
    `track` 档逐像素一致 —— 换档不会引起任何位移，验收里的几何断言也不受影响。
  * `size="sm"` 由 26px 调到 **28px**，与搜索框**同高**，成对出现时是一条齐平的带子。
  * **树视图图标从 `chevron-right`（那是「展开」的语义）换成真正的树形图标**
    `list-tree`（新增到 `Icon.vue`，Lucide 同款：竖干线 + 两条右分支），与列表图标成对可辨。
  * 分隔仍是 1px `--edge` + 与页签/树行同一条竖线的 10px 内缩；不加阴影、不加底色。
    树区底部内边距 `pb-3 → pb-1.5`（工具带自带间距，避免两段留白叠加）。
    顺带给清除按钮补了 `aria-label`。

### Verification

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` / `eslint --cache .` / `electron-vite build` | exit 0 / 0 error 0 warning / exit 0 |
| `tools/_verify-segmented-control.js` | **16/16**（侧栏那个分段控件换了档位又被移动过：指示块仍与激活段重合、点击仍切视图、工具栏那个仍是抬升白块） |
| `tools/_verify-sidebar-tree-style.js` | **32/32**（树行几何、选中态、缩进、空目录提示对齐） |
| `tools/_verify-filelist-view.js` / `_verify-rename.js` / `_verify-round-24.js` / `_verify-bars-no-filename.js` | 13/13 / 13/13 / 15/16 + 1 SKIP / 12/12 |
| 几何 + 三主题截图核对（临时探针，已删） | 搜索框与分段控件**同为 28px**（`sameHeight: true`）、搜索框 `border-width: 0` + 白面 + 10px 圆角、分段控件 `border-color: transparent` / `background: transparent` / `box-shadow: none`、指示块 `--panel-2` 且无投影；树区 149→737 紧贴工具带（737→778），`aside` 底 821。浅色 / 深色两张截图确认：一条分隔线 + 一枚白面搜索框 + 一枚软底指示块的「安静一行」，与下方「设置 / 关于 / 收起」层次分明 |
| 收起/展开行为（临时探针，已删） | **RESULT PASS**：静息只有 `[data-sidebar-search-toggle]`（28×28，`aria-expanded=false`，`aria-label=搜索文件名…`）→ 点开变成 `[data-sidebar-search-box]` 且 `document.activeElement` 就是输入框 → **空内容失焦自动收起** → 输入 `guide` 后失焦**保持展开且内容还在**；另有静息态截图（只有一枚放大镜 + 右边的树/列表软底指示块） |
| 动效与「不闪」（临时探针，已删） | **RESULT PASS**：过渡期间每 30ms 采样，`[data-sidebar-search]` 恒 1 个、`.file-search__icon` 恒 1 个且节点身份不变；展开宽度 `28→99.8→147.3→157.9→161.9→163.6→164`、收起 `58→34.1→30.1→28.4→28`（连续单调）；`transitionProperty/Duration = width, background-color 0.2s`；两态 `iconLeft` 都是 17（放大镜不动）；另截了一张展开 50ms 的中间帧：白面 + 柔光环 + 占位文字完整，无裁切/抖动 |
| 逐帧复核（临时探针，已删；9/9 PASS） | 页面内 rAF 逐帧记录三个「闪烁信号」全为 0：**宽度回退帧=0**、**空条帧=0**（输入框存在即不透明）、**窄壳上出现可见焦点环=0**；`transition = width, background-color, box-shadow / 0.2s, 0.2s, 0.16s`；两态 `iconLeft` 都是 17、`segLeft` 恒 180（分段控件不动）；行为不变：有内容失焦保持展开（`value=guide`）、`Esc` 清空并收起、**再点一次图标宽度恒为 164（不再先缩后长）** |

## [Unreleased · 轻量化 + 按钮去留 + 代码收敛 + 树行高] — 首屏 entry −53%，删死码与坏按钮（承第二十五轮）

> 用户八项要求：① 侧栏文件树行高再加一点、选中项前加浅灰色条；② 探索更轻量化的方式（保持功能完整）；
> ③ 审查文章界面按钮的去留与成本；④ 遍历项目检查解耦/减量/复用并改正；⑤ 样式再优化（更简约大气）；
> ⑥ 只对本对话的改动做测试；⑦ git 提交；⑧ 完成后关机。

### Changed — 轻量化（先量后改，全部有前后对照）

- **首屏 entry chunk 1,615,729 B → 764,073 B（−53%）**，三段改动：
  1. **切断 ProseMirror 走私通道**（−691KB）：`stores/find.ts` 原先直接
     `import { setFindHit } from '../lib/editor/typoraInlineMarks'`，而那模块静态 import
     `@tiptap/core` + `@tiptap/pm/{state,model,view}`；`prosemirror-state` 的 deps 又链到 model +
     transform + **view**，于是「import 一个函数」把整份 ProseMirror 钉进 entry。而本 store 挂在
     `App.vue → useAppActions → stores/find` 这条**静态**链上 —— 连欢迎页都要付这份钱。
     新增 **`lib/editor/findBridge.ts`（零依赖）**：编辑器在 `onCreate` 里
     `registerFindHit(setFindHit)`、`destroy` 里注销；store/`FindReplaceBar` 只认这座桥。
     `lib/session.ts` 的 `TextSelection` 也从顶层静态 import 改成**用到时动态 import**
     （那时编辑器必然已加载，模块缓存直接命中）。
     复验：`out/renderer/index-*.js` 里 `class Transform` / `prosemirror` / `tiptap` **全部消失**。
  2. **KaTeX 样式表延迟加载**（−231KB）：`lib/export.ts` 的 `import katex.min.css?inline` 是
     模块求值期的常量（含 59 条 `@font-face`），而该模块在 `App.vue → useAppActions → useExport`
     静态链上。改成 `getExportCss()`（首次导出时动态 import 并缓存）。
  3. **按需出现的浮层改异步组件**（−80KB）+ **语言包按需加载**（−160KB）：
     `App.vue` 里设置面板/全局搜索/查找栏/本地历史/两个右键菜单改 `defineAsyncComponent`
     （首屏一个都不显示）；`i18n/index.ts` 静态只留 `zh-CN`，其余语言由 `ensureLanguage()`
     在**切换前**拉取并 `setLocaleMessage`（先装包再切 locale，避免一帧原始 key）。
- **冷启动实测（`tools/_probe-startup.js`，三连跑取中位）**：页面可见 651→665ms、
  首屏可用 956→969ms、RSS 398→399MB —— **在噪声内没变**。诚实结论：这段墙钟由
  Electron 进程启动（~500ms）与 `EditorView` 那 2.5MB chunk（开文档必付）主导，
  首屏 JS 少 850KB 只换来 FCP 208→190ms。**要真降启动时间，得动 Electron 侧或编辑器内核**，
  不是拆 entry（见下「没做的」）。
- **每键成本：统计量一趟扫完 + 大纲只在文档变化时重算**：
  `stores/files.ts` 的 `wordCount`/`lineCount`/`charCount` 原先各自全文扫一遍（三个 getter 挂在
  `current.content` 上，打字时每代都重算）；现在按**内容串身份**缓存，一趟扫出三个数。
  `stores/editor.ts` 的 `transaction` 监听原先**每个事务**都重算大纲（纯选区变化也跑），
  现在只在 `transaction.docChanged` 时跑。

### Changed — 样式收敛（第 5 项的落地口径）

第 5 项「样式再优化、更简约大气」本轮**没有再做一次视觉重做**，而是把重复与不一致收干净
（视觉上因此更「齐」而不是更「花」）：
- 删除 15 条永不匹配的 CSS 与 3 个死 keyframes、2 个死变量（约 190 行）——`style.css` 从
  2,459 行降到 2,326 行，规则集与「实际会被渲染成什么」重新对齐；
- 把 `.bubble-*` 那套与工具栏重复的第二套浮层 UI 整块删掉（少一套视觉语言）；
- 侧栏树行高 27→29→**32px**、选中项加 3px 浅灰条：与「安静但有结构」的既有口径一致；
- 上一轮的中性灰副色 + 默认选区 + 更淡的标记符继续生效（截图核对见
  `tools/_shot-theme.js` 三主题整窗与选区特写）。
**进一步的美化（间距节奏、字号阶梯、圆角统一）没有做**：审计指出的真正阻塞项是
`style.css` 单文件 2,300 行、且 32 个组件里只有 3 个有 `<style>` —— 在拆文件之前做视觉微调，
只会让「谁覆盖谁」更难维护；这条留给下一轮（拆 CSS 需要三主题目视核对，不能静态判）。

### Removed — 按钮去留（审计结论，含成本）

- **选区气泡菜单整块删除**（`TyporaEditor.vue` 77 行 + `style.css` 40 行 + 旧套件 3 条断言）：
  它从第二十二轮起就是 `BUBBLE_MENU_ENABLED = false` 的死码（模板 `v-if` 恒假），
  但**每次选区变化仍在重算气泡状态**；功能与顶部工具栏 + 编辑器右键菜单 100% 重复。
  `README.md` 与手册把它记成「已交付」也一并改掉。
- **下划线按钮删除**（外加 `StarterKit.configure({ underline: false })`）：这是**唯一语义不可
  Markdown 往返**的生产按钮 —— 落盘裸 HTML `<u>`，重开被 `htmlPassthrough` 转成字面文本
  （屏幕上就是 `<u>abc</u>`），与 `**` 嵌套还会丢掉下划线（数据损坏类）。宁可摘掉入口，
  也不留一个会坏文件的按钮；将来要恢复就做成一等 mark（`escape:false`，同 MdHtml）。
  连带删除 `editor.underline` / `editorMenu.underline`（三语包）、`format.underline`、
  `providers.ts` 的分节项，并更新 `_verify-inline-formats.js` 的 E 段。
- **分割线按钮从工具栏目录移除**：与手打 `---`/`***` + Enter 完全等价（输入规则），
  另有顶部菜单栏与右键菜单两条图形入口；`editor.hr` 的 i18n 保留（菜单栏还在用）。
- **15 条已证实永不匹配的 CSS + 3 个死 keyframes + 2 个死变量**（约 190 行）：
  `.code-edit-*`（旧「透明 textarea + 高亮层」架构，早被 CodeMirror 取代）、`.md-math-input`、
  `.typewriter-scroll`、`mark.lm-find-mark`/`.lm-current`、`.mermaid-error pre`、
  `.code-wrap`/`.code-lang`、`lm-slide-up`/`lm-slide-in-right`/`lm-caret-blink`、
  `--block-active`/`--editor-bg`（三个主题各声明一份，零 `var()` 引用）。

### Fixed — 工具栏与对话框（审计里的「看着能用其实没用」）

- **源码模式下表格/代码块按钮灰显**：`editorStore.instance === null` 时它们此前可点但静默无效
  （通用路径早有 `:disabled`，这两个独立组件漏了）。
- **链接/图片的 prompt 文案走 i18n**：原先硬编码中文（`'插入链接'`/`'插入图片'`），
  而 `editorMenu.linkPrompt/imagePrompt` 早就有三语文案。
- **编辑器右键菜单的假快捷键提示**：`insert.link` 标的 `Ctrl+K` 实际绑的是「打开快捷键设置」、
  标题 1/2/3 标的 `Ctrl+1/2/3` 全仓**没有任何绑定**（照着按什么也不会发生）；同时把
  `format.strike`/`format.inlineCode` **真实存在却没显示**的快捷键补上。
- **导出弹层的关闭判据改成语义锚点**（`data-export-pop` / `data-export-pop-anchor`）：
  原判据是 Tailwind 生成的类名 `.fixed.z-\[100\]`，而表格/代码块弹层用同一串类名 ——
  点它们会顺手把导出菜单一起收掉。
- **确认对话框的 Esc 真的能关了**：`@keydown` 挂在**不可聚焦**的遮罩 div 上，事件永远冒泡不到
  它（那条 Escape 一直是失效的）；改成挂 `document`。顺带把硬编码的「确定/取消」换成
  `common.confirm`/`common.cancel`（三语早已存在，只是没接线）。
- **路由守卫复用 `lib/dialog.ts`**：`router/index.ts` 自己又写了一份脏确认（硬编码中文），
  与 `lib/dialog.ts` 顶部「这是唯一实现」的注释直接矛盾。
- **工具栏按钮补 `aria-label`**（除 `title` 外）：全局 tooltip 悬停时会**摘掉 `title`**，
  屏读器那时读不到可访问名。

### Added

- `tools/_probe-startup.js`：可重复的冷启动/资源基线（三段计时 + navigation timing + JS 堆 +
  全部 electron 进程常驻内存），自己起实例、自己轮询调试端口，**专治「量到旧页面」**
  （实测踩过：端口上有手工实例时量出 148ms 的假冷启动）。
- `docs/_audit/lumin-lighter-audit.md`：轻量化审计报告（体积逐段归属、12 项机会与风险、
  8 项「看似能省但不划算」）。
- `tools/_verify-neutral-accent.js` 的 N5 改为「**一条 author `::selection` 都不留**」
  （唯一那条 `.code-edit-input` 随旧架构删除，N5b 相应移除）。

### Docs

- 手册新增：轻量化取舍与「没做/不建议做」的量化理由、按钮去留台账、树行高与选中色条口径。
- 清理失真文档：`README.md` 的「选区气泡菜单 ✅」、手册 §3.8 的气泡菜单实现说明。

### 没做的（量化理由写在审计报告与手册里）

- **代码块 CodeMirror 虚拟化**（响应性最大一笔，实测 `eq` 41% + StyleModule `mount` 32% 的 CPU
  都在「每块一个 EditorView 实例」上）：会动编辑器内核与 8 个套件的既有前提，本轮不做。
- **`@codemirror/language-data` 换 16 种显式语言**（省 ~1.4MB 产物）：会收窄「任意语言高亮」，
  与「功能完整」冲突，不做。
- **主进程 `ensureShortcut`/`jumpList` 挪到 ready-to-show、electron-store 延迟实例化**（估 10–40ms）：
  对 665ms 的墙钟无意义，不做。
- **tools/ 的 85 个脚本迁到统一 harness**（19,963 行）：按「改到谁迁谁」推进，不做大爆炸迁移。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` + `tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit`（`node --test tests/*.test.mjs`） | **263/263**（`toolbarItems` 的两条夹具换了真实存在的 id —— 它们原先用 `underline`/`hr`，那两个已不在目录里） |
| `electron-vite build` | exit 0 |
| 首屏 entry chunk | 1,615,729 B → **764,073 B（−53%）**；产物里不再有 `class Transform`/`prosemirror`/`tiptap` |
| 冷启动三连跑（`_probe-startup.js`） | 页面 651→665ms、首屏 956→969ms、RSS 398→399MB（**噪声内不变**，诚实结论见上） |
| `tools/_verify-sidebar-tree-style.js` | **32/32**（行高 32px、选中项 3px 浅灰条、且色条不推移行内内容） |
| `tools/_verify-neutral-accent.js` | **10/10**（三主题副色是灰、无历史紫、淡底可辨、**一条 author `::selection` 都不留**、插入符=正文色、链接蓝、按钮对比度、代码结构色蓝、标记符更淡） |
| `tools/_verify-round-24.js` / `_verify-marker-hold.js` / `_verify-drag-selection.js` / `_verify-line-end-click.js` | 15/16 + 1 SKIP / 11/11 / 10/10 / 7/7 |
| `tools/_verify-toolbar-settings.js`（32 条定制断言，此前不在默认矩阵） | **37/37** —— 含「右键空白区弹菜单」「逐项隐藏/恢复」 |
| `tools/_verify-inline-formats.js` | **171/173 PASS、0 FAIL**（E 段改为「下划线入口与 mark 都已移除」的回归断言） |
| `tools/_verify-find-replace.js` / `_verify-surfaces.js` / `_verify-blockquote-style.js` / `_verify-toc-style-scroll.js` / `_regress-layout.js` / `_regress-cb.js` / `_verify-i18n.js` | 24/24 / 37/37 / 13/13 / 23/23 / 9/9 / 3/3 / 通过 |

> **两个既有失败（不是本轮引入，已用基线复跑或机制证明）**：
> * `tools/_verify-export-fix.js`（0/0，退出码 1）：它靠 monkey-patch `window.luminAPI.export.pdf`
>   来截获调用，而 `contextBridge.exposeInMainWorld` 暴露的对象是**只读**的 —— 补丁根本不生效，
>   于是走了真实导出（弹原生保存对话框）、`__exportCapture` 永远为 null。机制与本轮改动无关
>   （证据：探针里 `luminAPI.export.pdf = …` 替换后仍调用真实 IPC）。
> * `tools/_verify-menu-export-submenu.js`（12/15）：探针爬 Vue 组件内部结构找菜单分组，
>   早已与重构后的结构脱节（上一轮已用 `git stash` 复跑基线确认同样红）。

## [Unreleased · 副色改中性灰 + 文字选区走浏览器默认] — 去掉紫色（承第二十四轮）

> 用户口径：① 副色（accent）原来以紫色为主 ⇒ 改成**浅灰为主**，像 Typora 那样靠明度差不靠色相；
> ② 选中文字的颜色「用默认颜色即可，无需紫色」；③ 加粗 `**` 这类**源码符号的颜色再浅一点**。

### Changed

- **副色（accent 家族）改中性灰**：浅色 `#6b7280` / 深色 `#8a919e` / 羊皮纸暖灰 `#8a7f6b`，
  配套 `--accent-soft`（选中淡底，浅色 7% 墨 / 深色 8% 白）、`--accent-ink`（淡底上的文字）、
  `--accent-2`（次级强调）。凡是跟着副色走的地方（图标、焦点环、工具/侧栏选中态、开关、
  勾选态、引用条以外的强调、`--glow`、块悬停底色、`**` 标记的着色…）**一起变灰**，无需逐个改。
  判据写成性质而不是色值：**通道极差 ≤ 40 且不是紫/品红**（暖灰/冷灰都算灰）。
- **实心主按钮与副色解耦**（新增 `--btn-solid` / `--btn-solid-2` / `--btn-ink`）：
  深色主题的 `--accent` 必须够亮（暗底上的图标/焦点环），而「白字压在按钮上」要的是够深 ——
  一个令牌兼两个角色必然有一头不达标。三主题实测按钮文字对比度 **7.56 / 6.87 / 6.11 : 1**。
- **代码高亮的结构色独立成板岩蓝**（新增 `--code-key` / `--code-key-2`）：关键字/标签/属性
  原来借用副色，副色变灰之后会与正文灰糊在一起；板岩蓝与字符串绿、数字琥珀区分得开，也不沾紫。
- **链接保持蓝色**（新增 `--link`，目录条目 `--toc-link: var(--link)`）：灰副色下链接跟着变灰
  就和正文分不开了。
- **标记符的墨色再淡一档**（新增 `--marker` 令牌，用户第三条口径）：`**`/`*`/`~~`/`` ` `` 这些
  源码符号原来是 `color-mix(副色 70%, --ink-3)`，副色变灰之后偏重、抢正文注意力。现在三主题
  都往**贴近背景**的方向取值 —— 浅色 `#a4aab4`（对纸 **2.28:1**，比 `--ink-3` 的 3.09:1 更淡）、
  深色 `#666c78`（3.49:1；深色下「更淡」= 更暗，不是更亮）、羊皮纸 `#b3a894`（2.14:1）。
  同一个令牌一并收掉 `.md-meta`（代码围栏 / 行内代码的标记）、`h1~h6 > .md-heading-marker`（`#`）
  与 `.md-escape-backslash`（`\`）—— 它们原先各写一套 `color-mix`，语义其实是同一个「源码符号」。
- **插入符跟随正文色**：`caret-color` 从 `var(--accent)` 改成 `var(--ink)`（6 处）。

### Fixed

- **文字选区交回浏览器默认**：撤掉全部 author `::selection` 规则（原来 5 处：全局、源码面、
  front matter、代码块编辑层）。用户口径之外还有一条硬理由：默认色自带正确的文字反色
  （`HighlightText`），而自己涂半透明色时，一旦底色接近（淡灰底 + 淡灰选中）就会看不见。
  唯一保留的是 `.code-edit-input::selection`（那层 textarea 的文字是透明的，不能让系统去
  「反色画文字」；底色取系统 `Highlight`、`color` 继续 `transparent`，观感与默认一致）。
  `--sel` 令牌因此只剩「自绘淡底（查找命中）」一个用途，注释与套件措辞同步改过。
- **导出 HTML 的引用色条一直是正文色**：`export.ts` 的独立排版 CSS 里引用了 `var(--edge-strong)`
  但 `:root` **没定义**这个令牌 —— 失效的 `var()` 在计算值阶段回退成 `currentColor`。
  本轮补齐（顺带把导出主题的紫色也换成中性灰 + `--link`）。
- `tools/_verify-blockquote-style.js` 的 `bar-is-gray-not-accent` 原来写死旧紫色字面量
  （`99,102,241`），换副色后永远成立、等于没守；改成跟**实测的 `--accent` 计算值**比。

### Verification

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` + `vue-tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit` | **263/263 pass** |
| `electron-vite build` | exit 0 |
| `tools/_verify-neutral-accent.js`（新增，11 条） | **11/11** —— 三主题副色家族都是灰（极差 21/24/26、20/21/9、31/26/28，且都不是紫）、令牌里零历史紫色值、淡底药丸在纸/壳上可辨（1.15/1.23/1.15 与 1.15/1.20/1.14）、自绘淡底对纸可辨（1.25/1.61/1.24）、正文选区无 author `::selection`、代码块编辑层底色 = 系统 `Highlight` 且文字透明、插入符 = `--ink`、链接是蓝色且与副色不同、主按钮对比度 7.56/6.87/6.11:1、代码结构色是蓝色系、**标记符墨色 = `--marker` 且比 `--ink-3` / 副色都更淡**（浅色实测 2.28:1 vs ink3 3.09:1 vs 副色 4.71:1；深色 3.49 / 3.92 / 5.81；羊皮纸 2.14 / 2.69 / 3.59） |
| 截图人工核对（`tools/_shot-theme.js`） | 三主题整窗 + 浅/深「真实拖拽选中」特写：选区是**系统蓝底白字**，工具栏/侧栏/引用条/表头/代码块都是中性灰；标记符特写：浅色 `**` = rgb(164,170,180)、深色 = rgb(102,108,120)（都比改前更贴近背景） |
| 回归 14 套件 | **0 FAIL**（`_verify-surfaces` T 段量的是关系，换令牌仍全绿；`_verify-sidebar-tree-style`、`_verify-toc-style-scroll`、`_verify-blockquote-style`、`_verify-theme-auto`、`_verify-inline-formats` 183/184 等） |

## [Unreleased · 查找命中高亮不露标记 + 树行高 + 选区含标记 + 行尾落点] — 四项交互口径（承第二十三轮）

> 用户报四件事：① 查找命中的文字要高亮，且命中的加粗文字**不要冒出 `**`**（除非鼠标选中）；
> ② 侧栏文件树行高太窄，`g` 这类带降部的字母显示不全；③ 选区跨出有格式的文字时，
> 把成对的 `**` 也一起选上（例如 `**派出所…两层。** 全片` 全选时两侧 `**` 要被选中）；
> ④ 一行只有 `**诊室（底层空间）**` 时，点 `）` 后面光标停在 `**…|**`，希望像 Typora 那样
> 落在 `**…**|`（整块内容之后）。

### Added

- **查找命中高亮**（`.find-hit`，装饰层）：跳转命中除了设选区，另加一层底色。
  为什么不能只靠选区：查找栏打开时焦点在输入框里，编辑区那份是**失焦选区**（浏览器画得很淡），
  在深色主题下几乎看不见；而且跳转过去那点高亮一闪就没。`.find-hit` 只画底色、不改字号，
  对光标导航与命中测试零影响（与 `.md-marker` 的零字号折叠互不相干）。
  实现在 `typoraInlineMarks` 的装饰层：`SET_FIND_HIT` 事务元数据同时携带
  「命中范围」与「查找态」，`props.decorations` 把它与显隐装饰**合并**返回
  （同一插件 key 只能有一份 `decorations`，分两个 key 会各算各的、后者覆盖前者）。
  适配器是 `setFindHit(active, from, to)`：find store 在 `select()` / `hide()` 里调它，
  **不 import store**（视图自己记 `ownView`，由 `onCreate`/`onDestroy` 维护），避免
  「编辑器内核 ⇄ store」耦合与初始化时序问题。
- **按住鼠标时标记不显形、松开才显示**（`.press-hidden` + `pressHeld`）：用户口径
  「鼠标放在加粗文字上别立刻冒 `**`，**鼠标抬起时才显示**，其余逻辑与功能不变」。
  定稿的隐藏态是**只去墨、绝不改占位**，由两条合起来保证「整个手势期间版面一个像素都不动」：
  * **冻结显隐装饰**：`pressHeld` 期间插件 `apply` 直接返回旧装饰集，谁显形谁折叠在手势
    期间不再变（松开时用一个 `SET_PRESS` 空事务按最终选区重算一次）；
  * **CSS 只去墨**：`.press-hidden .md-marker:has(> .md-reveal-inline) { color: transparent }`
    —— 已显形的标记看不见，但 `font-size: inherit` 与占位照旧。
  为什么必须这么绕（本轮实测三轮的结论）：一行里标记的宽度随显隐变化（一对 `**` 是 15.5px），
  而**浏览器判光标落点**、以及 **PM 在拖拽每次 `mousemove` 上重算坐标**，都发生在「当时的布局」上
  —— 布局一变，落点/终点就跑到别的字符。试过并**实测放弃**的错路：
  * 按下即同步折叠 ⇒ 点加粗字内部落到后面的普通文字（`**X**xx` 点 x=321 得 pos 7 而非 3）；
  * 延后一拍折叠（`setTimeout(0)`）⇒ `**…**` 段落的**行尾点击**失灵（落点跑到段首）；
  * 第一次 `mousemove` 才折叠 ⇒ 折叠发生在拖动**中途**，整段拖选塌成一个光标；
  * `position: absolute` + `opacity: 0`（上一版的「零占位隐藏」，本轮实测推翻）⇒
    **只在标记本来就折叠时**才不占位；光标已在构造内（标记已显形、各占 15px）时按下，
    标记一脱离流整行就左移 15px，于是「点『地』」落到了下一个字
    （实测钩子：`**是同一个地方的两层**…` 点在「地」得 pos 8，`_verify-drag-selection.js` 的
    F 段现在钉住这条）。
  类挂在**编辑区根节点**上（不是逐个 `.md-marker` 挂类）：标记元素会被 PM 重渲染换掉，
  逐个挂类会丢，后代选择器不会。收尾时同时听 `mouseup`/`pointerup`/`pointercancel` +
  窗口 `blur`（拖到别的窗口松手也不会留下隐藏态）。纯观感：模型、落盘字节、选区语义、
  `.md-marker` 的折叠机制一个都不动。

### Fixed

- **拖选把「本行后面的字」全选中（用户第四个报告，本轮找到真根因）**：原文
  `**是同一个地方的两层**全片不允许出现任何一句解释这件事`，从「地」拖到「层」，
  抬起后选区变成 `[7,30]` = `地方的两层**全片不允许出现任何一句解释这件事`。
  根因不在拖拽本身，而在 `expandOutsideMarkers` 补标记跨度时的**容器语义**：
  右侧用了 `doc.resolve(t).end()` —— 那是**所在段落**的末尾（30），不是收尾标记的末尾（14）。
  终点正好停在收尾 `**` 起点（12）时就触发右侧规则，一次补到段尾。同一行的左边
  `doc.resolve(f).start()` 是**同类错误**（`全片…在 **SH-058**，靠…` 里会把起点拉到段首），
  只是那个夹具恰好没触发。修法：改用**相邻标记节点自己的 `nodeSize`**
  （`f - leftOf(f).nodeSize` / `t + rightOf(t).nodeSize`）—— 结构量，与容器无关。
  实测：同一手势 `[7,30]` → `[7,14]`（= `地方的两层` + 收尾标记），不含后面的文字。
  新增 `tools/_verify-drag-selection.js`（10 条）用原文钉住：正拖/反拖/终点停在字符内/
  起点在构造首字/拖到行尾/单击落点/版面不变。
- **删掉 `snapDragHeadToLineEnd`（「拖到行尾就补到块尾」的兜底）**：它是上一轮为「收尾 `**`
  选不中」加的启发式，判据是「鼠标在该行最后一个可见字符右边」—— 而那个右缘是量**元素**
  得到的，`domAtPos` 在节点边界上返回父元素 ⇒ 量到的其实是整幅纸的右缘，判据**恒为真**，
  任何一次行内拖拽都被当成「拖到行尾」。实测它就是用户报告里 `[7,30]` 的产物之一
  （勾子日志：`clientX=449, lastCharRight=759.97`）。
  删掉之后语义并没有缺口：浏览器把「拖到文字右侧空白」的终点卡在最后一个可见字符之后，
  而对 `**X**` 这种「收尾标记紧跟在有样式正文后面」的形态，那个落点**正好**是收尾标记的起点，
  修好的右侧规则自然把它补进来（`_verify-drag-selection.js` 的 A/E 两段分别钉住
  「拖到标记前 ⇒ 含标记不含后文」与「拖到行尾 ⇒ 含后文」）。
- **行尾点击其实没生效（用户第五个报告，本轮找到真根因）**：一行里**末尾几个字是加粗**时
  （`…**不给眼睛亮起来的机会**`）点这一行右侧空白，期望 `**…**|`，实际停在 `**…|**`。
  三处叠加，全部修掉：
  1. 行尾修正的第一条守卫是 `if (found.pos >= end) return false` —— 而点行尾空白时
     `view.posAtCoords` **恰好**给出块尾（实测 `foundPos=20=end`），这条守卫把**唯一需要修正
     的情形全挡掉了**（所以第一版从没生效过）；
  2. 挡掉之后落点由 PM 自己的 MouseUp 处理决定，它按折叠布局把光标算到收尾 `**` **之前**
     （实测 `…会**` 得 18、`**…会**` 得 34，而块内容末尾是 20 / 36）；
  3. 判据里的元素用 `domAtPos(found.pos).parentElement` 取，位置落在节点边界上时
     `domAtPos` 返回的是整个 `<p>`（右缘 = 整幅纸）⇒ 换个夹具就恒假。
  修法：判据改成纯几何的 `lineEndCaretTarget`（指针在该行最后一个可见字符右缘以右；
  「这一行」按与指针的垂直距离取最近的一行，**只有点的是最后一行**才算行尾 ——
  换行段落点中间行右侧不会被送去段尾），落点取**文本块内容末尾**；
  并且**同步判、延迟落**：判据必须在点击当时的布局上量（松手会解除按住隐藏、整行会左右移动），
  落点必须在 PM 自己的 MouseUp 处理之后再写一次（否则被它覆盖）。
  实测：A 行 `**…机会**` 点行尾 ⇒ 20（旧 18）、整行加粗 ⇒ 36（旧 34）；
  点最后一个可见字右半边 / 行中间字符 / 换行段落中间行 都不被抢走。
  新增 `tools/_verify-line-end-click.js`（7 条）钉住；`_verify-round-24.js` 的 D 段期望值
  一并从**旧行为**（`contentEnd - 收尾标记长度` = 43）改成块内容末尾（45）——
  那条断言此前**把 bug 写成了期望值**（标注写「收尾标记之后」，算的却是之前）。
- **查找命中处不再露出 `**`**：查找的选法是程序化的 `setTextSelection(from, to)`，
  在编辑器状态里与用户手选**长得一模一样**，但语义不同 —— 那是「跳到这一处」而不是
  「要编辑这里的标记」。修法：`setFindHit(active, …)` 把「查找栏正在高亮」这个事实
  带给标记显隐装饰，查找期间整份显隐装饰为空（标记全部保持折叠）；查找栏一关立刻恢复
  正常的「光标落在构造内才展开」。**不是**绕过 Vue 的 `:style`，也不是改模型/字节。
- **侧栏文件树行高 27px → 29px，且标签行盒不再等于字号**：`.tree-row` 的 `line-height: 1`
  让行盒正好等于 13px 字号，而 CJK/拉丁字形的 ascent+descent 实测约 17px ——
  `.tree-label` 的 `overflow: hidden` 于是把 `g`/`y`/`p` 的降部裁掉（用户报「字母显示不全」）。
  现在行高 29px、`.tree-label` 的 `line-height: 1.3`（行盒 ≈ 16.9px）。空文件夹提示同步到 29px。
- **拖选跨出构造时把整对标记括进来**（`expandOutsideMarkers`）：**只有选区真的碰到构造边界时
  才补标记** —— 左边紧邻的是**开标记**且内侧紧邻的是**有样式的正文** ⇒ 起点左移到构造之前；
  右边镜像。判据逐字、不看 mark 的 side 属性，覆盖 `*`/`_`/`~~`/`` ` ``。
  **不能拿「两侧样式集合是否不同」当判据**（本轮踩到的真 bug）：加粗正文 `SH-058` 内部
  `0`（有样式）与 `5`（**无**样式，行内标记模型会把同一段样式正文拆成多个文本节点）相邻，
  于是从「镜」往左拖到 `0` 时，起点两侧的样式集合不同 —— 被判成「跨出构造」，选区被撑到
  **段首**（用户报的「把前面的也选中了」）。正确结果是不动。
  另外取相邻节点必须用 `resolve(pos).nodeBefore / nodeAfter`，**不能用**
  `maybeChild(index - 1)`：实测后者在同一个段落里会给出**错位的节点**（加粗段 `**SH-058**`
  内的位置 18，左边拿到的却是起始 `**`）。
  **挂在指针路径**（`handleDOMEvents.mouseup` 里 `setTimeout(0)`，等 PM 自己的 MouseUp 流程
  走完），**不是** `appendTransaction`：后者每次事务都跑，「连点两个样式按钮」的中间态
  （选中的正好是刚生成的那段正文，两侧紧邻的正是刚插入的标记）会被撑开，随后派生归一化只好
  把第二个样式套在第一对标记**外层** —— 实测 `粗+代码` 得到 `` `**abc**` `` 而不是
  `` **`abc`** ``，把 `_verify-inline-formats.js` 的 D 段 4 条从绿变红。
  命令式选区（含拖拽以外的所有路径）因此**不**被改写。
- **行尾点击落到整块末尾**（`**…**|` 而不是 `**…|**`）：⚠️ 本轮第一版**没修好**（见下面
  的「行尾点击其实没生效」），第二版才真正落地。现状：判据是几何一条 ——
  **指针在该行最后一个可见字符的右缘以右**（逐字量矩形，折叠标记没有矩形天然不计入；
  「这一行」按与指针的垂直距离取最近的一行，且**只有点的是最后一行**才算行尾，
  换行段落点中间行右侧不会被送去段尾）；落点 = **文本块内容末尾**（所有折叠标记之后）。
  判据在**点击当时的布局**上量，落点在 PM 自己的 MouseUp 处理**之后**再写一次
  （PM 会把光标按折叠布局算到收尾 `**` 之前，实测 `…会**` 得 18 而块尾是 20）。
  实测：点「空」字右半边不会被抢走（指针仍在字符矩形内）。

> **③ 的补充：用户用最小例子 `X[Xxx]` ⇒ `**[X**xx]` 对齐口径后，查出真正的元凶**
>
> 用户报「从加粗字内部拖到后面的普通文字，抬起后只选中了后面的普通文字」。复现发现：
> 这不只是选区的边界问题，而是**折叠标记把整行的坐标搞错了**：
>
> 1. `**X**xx`、光标在构造内 ⇒ 标记显形，`X` 在 x∈[319.5, 331.4]；
> 2. 用户在 x=321（`X` 内部）按下 —— 第二十二轮的「按住指针折叠标记」在 `mousedown`
>    **同步**折叠，`X` 随即左移到 [304, 315.9]；
> 3. 浏览器的光标/焦点落点是在这个处理器**之后**才判的 ⇒ x=321 落到它右边的 `xx`
>    （**pos 7 而不是 3**），拖选于是只选中了「xx」。
>
> 三路映射（`view.posAtCoords`、强制 reflow、`caretPositionFromPoint` + `posAtDOM`）
> 全给同一个错值 —— 它们都在按折叠后的真实布局算，**谁都没错**，错的是「按下就折叠」。
>
> **修法：整体移除「按住指针期间折叠标记」**（`pointerHolding` / `SET_SUPPRESSED` /
> `onMarkerPointerDown` / `setMarkerSuppression` 一并删除）。标记在按住/拖选期间保持当前
> 显隐态（选区进入构造时自然显形，与 Typora 一致），光标落点与用户看到的字形永远一致。
> 试过两条折中、都实测后放弃：延后一拍折叠（`setTimeout(0)`）会让 `**…**` 段落的
> **行尾点击失灵**（落点跑到段首）；改成第一次 `mousemove` 才折叠则会让折叠发生在拖动**中途**，
> 锚点按展开布局、焦点按折叠布局，端点跑到起点左边。
>
> 另外曾把「拖到行尾空白」的选区终点补到可见文字之后（`snapDragHeadToLineEnd`，量**元素**
> 右缘当判据）—— **本轮已删除**：`domAtPos` 在节点边界上返回父元素，量到的是整幅纸的右缘，
> 判据恒为真，任何行内拖拽都被当成「拖到行尾」（见本轮 Fixed 的两条）。收尾标记改由
> `expandOutsideMarkers` 的右侧规则补进来（按相邻标记节点自己的 `nodeSize`）。
>
> 验收：`_verify-marker-hold.js` 按新口径重写（8/8，断言 B/C 从「按住即折叠」改成
> 「按住/拖动期间**保持显示**」）；`_verify-round-24.js` 的 C 段起点 x 改为**现扫**出来的
> （取「落点正好是正文第一个字符」的那个 x）—— 正文首字左边贴着一个**宽 0** 的折叠标记，
> 写死偏移会把锚点放进标记里（实测踩到）。
>
> **第四个报告（反向拖选「把前面的也选中了」）**：用户给了一整行
> `全片唯一一次空间切换在 **SH-058**，靠一个拉镜完成，不切。`，从「镜」往左拖到 `0` 时
> 选区被撑到段首。根因是 `expandOutsideMarkers` 的判据「左边界两侧样式集合不同」——
> 加粗正文 `SH-058` 内部 `0`（有样式）与 `5`（无样式）相邻（行内标记模型会把同一段样式正文
> 拆成多个文本节点），于是「选区起点在构造内部」被误判成「碰到构造边界」。
> 改成**结构性判据**：左边紧邻的必须是**标记文本节点**、内侧紧邻的必须是**有样式正文**，
> 两者同时成立才补标记（左右各自独立）。取相邻节点改用 `resolve(pos).nodeBefore / nodeAfter`
> —— `maybeChild(index - 1)` 在同一段落里会给出错位节点（实测位置 18 左边拿到的是起始 `**`）。
> `_verify-round-24.js` 新增 C2 段（2 条）用该行原文钉住。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` + `vue-tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit` | **263/263 pass** |
| `electron-vite build` | exit 0 |
| `tools/_verify-marker-hold.js`（重写，11 条） | **11/11** —— 按住左键标记**只剩透明墨**（字色 `rgba(0, 0, 0, 0)`、宽度仍 15px）、**正文与「标记之后」文字的屏幕位置一个像素都不变**（`xBravo`/`xCharlie` 逐拍比对，实测三拍全 `353.7`/`423.4`）、拖动中同样、松开即恢复字色且位置仍不变、单击后恢复、拖到编辑区外松手也不留隐藏态 |
| `tools/_verify-drag-selection.js`（新增，10 条） | **10/10** —— 用户原文 `**是同一个地方的两层**全片…`：正拖「地→层」= `[7,14]` 且**不含** `全片`；反拖等价；终点停在「层」之前不补收尾标记（`[7,11]`）；起点在构造首字 ⇒ 补开标记（`[1,14]`）；拖到行尾 ⇒ 到块尾且含后文（`[7,30]`，位置从文档现算）；**标记已显形时单击加粗字光标落在被点的字上**（`[7]`，旧版会得 8）；手势期间参考字位置不变 |
| `tools/_verify-line-end-click.js`（新增，7 条） | **7/7** —— 末尾加粗的一行（标记折叠）点行尾右侧空白 ⇒ 光标 = 块内容末尾（20，旧行为 18）；整行加粗 ⇒ 36（旧 34）；点最后一个可见字右半边 ⇒ 18（留在构造内）；点行中间字符 ⇒ 落在该字符（10）；标记已显形时点行尾 ⇒ 仍 20；段内硬换行点**第一行**右侧 ⇒ 42（= 硬换行位置，**不是**段尾 57） |
| `tools/_verify-round-24.js`（16 条） | **15/16 + 1 SKIP**（连跑多轮稳定）—— 查找命中高亮有可见底色、命中时 4 个标记全部零宽、关栏后高亮摘掉且标记恢复；树行高 29px 且行盒 > 字号；真实拖拽跨出构造 ⇒ 起点含开标记、文本含两侧 `**`，程序化选区不被撑开；**选区起点落在加粗正文内部 ⇒ 不撑到段首**（用 `全片唯一一次空间切换在 **SH-058**，靠一个拉镜完成，不切。` 原文钉住）；行尾点击落到**块内容末尾**（位置从文档现算；期望值本轮从旧的 43 改成 45）、点字符内部不被抢走 |
| 回归：`_verify-inline-formats`（**183/184**，1 条是既有的「下划线」SKIP、0 FAIL）/ `_verify-find-replace`（24/24）/ `_verify-surfaces`（37/37）/ `_regress-layout`（9/9）/ `_regress-cb`（3/3）/ `_verify-math`（7/7）/ `_verify-md-fidelity`（101/102，1 条既有 SKIP）/ `_verify-wave3`（23/23）/ `_verify-sidebar-tree-style`（30/30）/ `_verify-marker-hold`（11/11）/ `_verify-drag-selection`（10/10）/ `_verify-line-end-click`（7/7）/ `_verify-round-24`（15/16 + 1 SKIP） | **13/13 套件 0 FAIL**（`_verify-keymap` 需要 dev server，按设计 SKIP） |

> 口径说明：`_verify-inline-formats.js` 在本机不同时段的总数会在 175～184 之间浮动
> （套件内含「打不开就跳过」的探测项），判据是**同一时刻改前/改后同值** —— 已用
> `git stash` 前后各跑一次确认（均为 172/175 PASS）。


## [Unreleased · 取消节点整选框 + 分屏拖拽重写 + 设置面板压暗可拖] — 拖分隔条不再掉帧、设置不再糊背景（承第二十二轮的另三项）

> 用户报三件事：① 去掉 `.ProseMirror-selectednode` 的紫色外框，并且**取消这套整选逻辑**；
> ② 分屏拖中间竖线「有点卡」，要求**深度优化、必要时重构，但必须保证速度与性能开销**；
> ③ 设置面板的背景遮罩「**暗一点就行，不要模糊**」，面板本身保持正常颜色，并且**设置窗口要能在
> 窗口内被拖动**。

### Fixed

- **不再有节点级整选**（`lib/editor/pointer.ts`）：`filterTransaction` 原先只把**文本块**的
  `NodeSelection` 降级成文本光标，图片等行内/叶节点仍是整选 —— 那就是紫色外框的来源。
  现在**任何** `NodeSelection` 都降级为 `TextSelection.near()`：点图片落到图片旁的文本光标，
  要删图仍然 `Backspace` 即可（`docs/typora-wysiwyg-manual.md` 的键盘习惯不变）。
  CSS 侧同时摘掉 `.ProseMirror-selectednode { outline: none }`——框已经没有来源了。

### Changed

- **分屏拖拽重构**（`views/EditorView.vue` + `assets/style.css`）：先量化再动手，
  重文档（400 段）下每帧成本的三块来源与处理：

  | 来源 | 实测 | 处理 |
  | --- | --- | --- |
  | 分隔条是 flex 子项，改宽度时它跟着重排、还占掉 11px | 左栏宽度与比例对不上（516 vs 611） | 改成**绝对定位浮层**（`left: var(--split-left)`），不参与两侧布局 |
  | `.split-dragging *` 的全量 `user-select: none !important` | 开始/结束各一次**全子树**样式重算 ≈ **26ms** | 规则只作用在 `body` 上，并让拖拽中的内容区 `pointer-events: none` |
  | 每帧写宽度 + 整篇重排 | 写宽度 ≈ 15.6ms、重排无法避免（文本必须按新宽度折行） | 指针事件按 **rAF 合帧**：一帧最多写一次；拖拽期两栏加 `contain: layout paint` 并关过渡 |

  性能基线（`tools/_verify-round-perf.js` 的 p95 门禁，400 段 + 8 个代码块）：
  **p95 33.3ms / max 33.5ms / over33 21→9**（改之前同一台机 p95 33.4 / **max 66.8** / over33 21）。
- **pane 宽度只有一个写入方**（本轮发现的真问题）：拖拽期必须绕过 Vue（否则每帧重渲染），
  但「松手后清 inline 交回 Vue」会留下两份状态 —— Vue 的 `patchStyle` 拿上一次渲染的值比对，
  而 DOM 已被外部改过，补丁**短路**。实测（隔离实例 + `MutationObserver` 记录 style 属性的
  每一次写入）：松手后 Vue **一次都没写** pane 的 style，`clearInline` 清完就没人再写，
  左栏掉到 **516px**（≈ 内容 max-content），而 `settings.splitRatio` 已是 0.5875，两者对不上。
  现在 `syncPaneLayout()` 是唯一写入方（模式切换、双击复位、拖拽结束都走它），
  模板不再给两个 pane 挂 `:style`；分隔条位置仍由 Vue 的 CSS 变量绑定驱动。
- **设置面板遮罩从「模糊」改「压暗」**（`.settings-scrim`）：`backdrop-filter` 去掉，
  改 `rgb(0 0 0 / 32%)`（暗色主题 42%）——用户常在读文档时顺手调设置，糊掉正文没法看。
  面板本身不加滤镜，颜色与其它弹层一致。
- **设置面板可在窗口内拖动**（`SettingsDialog.vue`）：标题栏是把手（`.settings-drag-handle`，
  `cursor: grab/grabbing` + 拖拽握把图标），位移只走 `translate3d`（不触发布局），
  拖动中 `transition: none`；越界时**保证面板还有一部分留在视口内**。位置是**会话级**：
  每次打开回到居中，不跨次保留（`_verify-round-perf.js` 有断言钉住）。

### Fixed（用户运行时报出）

- **`Extraneous non-props attributes (data-toolbar-item)` 警告**：工具栏给「表格」「代码块」
  两个按钮组件打 `data-toolbar-item` 用来判断右键是否落在项目上，而这两个组件的模板是
  **两个根节点**（按钮容器 `div` + `Teleport` 到 body 的悬停弹层，见
  `ToolbarTableButton.vue` / `ToolbarCodeBlockButton.vue`）——Vue 的 fallthrough 只在
  **单根**组件上生效，多根时属性无处可挂，于是每次渲染都告警，且该属性**根本没落到 DOM**
  （实际后果：在这两个按钮上右键会被 `isOnItem` 判为空白区，弹出工具栏菜单而不是项目自身菜单）。
  修法是显式转交：两个组件各加 `defineOptions({ inheritAttrs: false })` + 容器上 `v-bind="$attrs"`。
  同类多根组件还有 `SidebarRecentButton.vue`（也是 `div` + `Teleport`），但它调用处没传任何属性，
  不会告警，暂不动。
  另注：这条 warning 只在开发模式可见——`src/main/index.ts` 里对渲染进程 warning/error 的
  转发是 `if (is.dev)` 包的，打包版不会打印。验收：`tools/_verify-toolbar-settings.js`
  新增 2 条（两个按钮的容器确实带 `data-toolbar-item`；在表格按钮上真右键不弹工具栏菜单），37/37。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` + `vue-tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit` | **263/263 pass** |
| `electron-vite build` | exit 0 |
| `tools/_verify-round-perf.js`（本季新增，22 条） | **22/22** —— 节点整选不再出现 + 降级后仍可打字；拖拽中 inline 直写、松手后保留终态且与比例一致、模式来回切换不残留宽度；帧率基线 p95 ≤ 34ms；设置遮罩无 `backdrop-filter`、面板可拖、重开复位 |
| `tools/_verify-toolbar-settings.js`（新增 2 条 → 37 条） | **37/37** |
| 回归：`_verify-inline-formats`（183/184）/ `_verify-surfaces`（37/37）/ `_regress-layout`（9/9）/ `_regress-cb`（3/3）/ `_regress-divider`（4/4）/ `_verify-sidebar-tree-style`（29/29）/ `_verify-filelist-view`（13/13）/ `_verify-marker-hold`（8/8）/ `_verify-find-replace`（24/24）/ `_verify-toolbar-settings`（37/37）/ `_verify-bars-no-filename`（12/12） | **12/12 套件全绿**（`_verify-inline-formats` 唯一未过项是既有的模板保真差异，与分栏尺寸断言无关，见上一轮记录） |

> 诚实说明：分屏的**布局重排本身省不掉**（文本必须按新宽度重新折行）；本轮消掉的是
> 每帧重复的中间层（浮层分隔条、全子树样式重算、多写一次宽度）。进一步实验
> （`content-visibility` / `cssText` 合并写入 / 更大范围 `contain`）实测**没有收益**，
> 没有采纳。


## [Unreleased · 页签常驻修复 + 标记抬手才显示 + 侧栏直角] — 文件/大纲切一次就空、拖选时 `**` 乱冒（承第二十二轮）

> 用户报三件事：① 打开文件夹后「文件 → 大纲 → 文件」切回来什么都不显示，再切大纲也空；
> ② 拖选加粗文字时两侧 `**` 立刻冒出来，希望**松开鼠标再显示**；③ 去掉「文件 / 大纲」里
> 选中项的圆角。

### Fixed

- **页签切一次就空**（`AppSidebar.vue`）：内容区原先用 `<Transition mode="out-in">` +
  `v-if`/`key` 重挂组件，而文件树的数据是**惰性拉进 dirCache** 的、键盘焦点初始化又依赖
  「已经渲染出来的行」—— 卸载/重挂的时序一旦没对上，树就停在「没有任何行」且**自己没有恢复路径**；
  大纲同理（只读 editor store 的 outline，编辑器实例重建那一刻可能正好是空的）。
  改成**两个面板常驻 DOM、切页签只切显隐**（`v-show`）：数据、滚动位置、展开状态全部原样保留，
  这类状态机问题从根上没有了，也省掉每次切换的重挂成本。
- **文件树自愈**：切回「文件」页签时若根目录缓存为空（被 `setRoot`/`refreshDir`/事件竞态清过），
  主动重新拉一次 —— 之前它只读缓存、从不自己拉，缓存空了就永远空着。
- **`mousedown` 不再落在空处**：焦点初始化只在「文件」页签可见时做，避免隐藏着的树去抢焦点。

### Changed

- **标记在指针抬起后才显示**（`typoraInlineMarks.ts`）：按住左键期间（含拖选全程）把
  `.md-marker` 的展开装饰折叠，`mouseup`/`pointerup`/`pointercancel` 时立刻恢复。
  只动「要不要给 `.md-reveal-inline`」，**不碰** `.md-marker` 的折叠机制（那是渲染结构，
  与光标导航/命中绑在一起）—— 模型、落盘字节、选区语义一个都不动。
  两处必须踩准（都实测踩过）：
  * 锚点用 **mousedown** 而不是 pointerdown：pointerdown 在部分环境（含 CDP 合成的输入）
    不会被派发，押在它上面会「代码看着对、实际不折叠」；
  * 抑制开关的变化必须**进事务元数据**（`SET_SUPPRESSED`）：PM 只在
    `docChanged || selectionSet` 时调插件 `apply`，只翻模块布尔量的话空事务会被当成
    「什么都没变」，标记照样显示；去重也不能用「模块标志是否翻转」，否则 `mousedown`
    先置位会让派发永远不发生（拖到编辑区外松手后标记回不来）。
- **侧栏「文件 / 大纲」选中项改直角**：`.tree-row` 去掉 6px 圆角、大纲行去掉 `rounded-lg`，
  hover/选中底色贯通侧栏整宽（与两侧边界对齐）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` + `vue-tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit` | **263/263 pass** |
| `electron-vite build` | exit 0 |
| `tools/_verify-marker-hold.js`（新增 8 条） | **8/8**，连跑 3 轮稳定（光标在构造内显示 → 按住折叠 → 拖动中仍折叠且实测零宽 → 松开恢复 → 单击不卡住 → 拖到编辑区外松手也恢复） |
| 回归：`_verify-inline-formats` / `_verify-surfaces` / `_regress-layout` / `_regress-cb` / `_verify-sidebar-tree-style` / `_verify-filelist-view` / `_verify-find-replace` / `_verify-toolbar-settings` / `_verify-bars-no-filename` | 全绿（`_verify-sidebar-tree-style` 的 `row-radius-6` 断言按本轮口径改成 `row-square-corners`） |

### 顺带修的既有问题（与本轮功能相邻）

- `tools/_verify-filelist-view.js` 是**文件列表视图重构后没跟着更新**的老套件：它读
  `files().docs` / `files().docsLoading` / `files().loadDocs()`（都已迁到 `workspaceDocs` store），
  在任何实例上都直接抛 `TypeError`；而且它没有统一的 `--- N/M PASS` 结论行，`run-suites.js`
  会把它记成 `0/0 FAIL`。现在：改用 `workspaceDocs`、自备夹具工作区（不再依赖实例里恰好有工作区）、
  补齐结论行 —— 13/13。

## [Unreleased · 查找栏折叠替换 + 正则查找 + 大纲去左右留白] — Ctrl+F 只出查找、Ctrl+H 直接出替换（承第二十一轮）

> 用户要三件事：① Ctrl+F 只出现查找，前面给一个折叠三角，点开才出替换；Ctrl+H 直接出替换；
> ② 查找支持正则表达式；③ 取消左侧边栏「目录」区域左右两侧的间距。

### Added

- **折叠三角**（`FindReplaceBar.vue` 的 `find-disclosure`）：Ctrl+F 只出查找一行，
  左侧三角朝右；点一下（或 Ctrl+H）下拉出替换行，三角转 90°。为什么这样分：绝大多数查找
  都不替换，常驻两行会一直占着右上角。
- **Ctrl+H → 直接出替换**：新命令 `edit.replace`（`useKeymap.ts`，分组「编辑」、可自定义键位）
  + 菜单动作 `replace`（应用内「编辑」菜单 + 原生菜单「替换」）。栏已开着时按 Ctrl+H 就地展开
  （不会先关再开）。
- **正则查找**（默认关）：查找栏新增 `.*` 开关，打开后查询串按正则解释 —— 元字符、`|`、`()`
  分组都生效；右栏计数在语法错时显示**「表达式无效」**并把输入框与开关标红（不是静默零匹配，
  也不是抛异常）。正则模式下替换串支持 **`$1` / `$&` / `$$`** 按捕获组展开（`$\`` 与 `$'` 不支持：
  它们要「命中在整篇里的位置」，而渲染面的文档坐标与纯文本偏移不同源 —— 与其给个大部分时候对的，
  不如原样保留）。

### Fixed

- **捕获组映射丢了**（本轮自查发现）：`findInRuns` 把块内文本坐标映射回文档坐标时只搬了
  `from/to`，把 `groups`/`whole` 丢了 —— 结果是渲染面的 `$1` 静默展开成空串，「替换成功了但内容不对」。
  现在整条匹配对象一起带走，并在单测里钉住（`findInRuns` 的捕获组断言）。

### Changed

- **大纲（侧边栏「目录」页签）去掉左右留白**：容器 `px-2` 撤掉，行的 hover/选中底色铺满侧栏宽度
  （与「文件」树一致）；行内左侧留白仍由每级缩进负责，缩进参考线不受影响。
- `edit.findReplace`（Ctrl+F）不再限制 `when: 'notInInput'`：在各家编辑器里 Ctrl+F 都是「就地查找」，
  在查找框里再按一次应当把它关掉，而不是漏给输入框。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` + `vue-tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit` | **263/263 pass**（`findReplace` 单测由 11 条扩到 23 条：正则元字符/中文码点/非法表达式/零长匹配/捕获组/两位组号/`$`` 与 `$'` 保留/`findInRuns` 带组映射） |
| `electron-vite build` | exit 0 |
| `tools/_verify-find-replace.js` | **24/24**（新增：Ctrl+F 只出查找、三角展开/收起、Ctrl+H 直接出替换（开着与关着两种）、非法正则显示「表达式无效」、`$2$1` 端到端展开、关正则后回字面量） |

## [Unreleased · 图标整体更换（第二轮）+ 应用内标识同源] — 桌面交付的 Lumin 图标进了每一个位置（承第二十轮）

> 用户要求：把项目图标换成桌面的 `Lumin.png` / `Lumin.ico`，**各个位置都要换**，并且**不要用引用形式**
> （怕换设备后显示不出来）。逐位置盘了一遍，真正的坑不在「换哪几个文件」，而在交付的 `.ico` 本身。

### Fixed

- **交付的 `Lumin.ico` 在 Windows 上抽不出图**：它只有**一个 256×256 的 PNG 压缩条目**，而
  `System.Drawing.Icon.ToBitmap()`（GDI+，资源管理器取图标走的就是这条路）对它抛
  `Requested range extends past the end of the array` —— **构建和运行都不报错，用户看到的是缺省图标**。
  做法：保留交付的 `icon.png`（1024×1024）当母图，新增 `tools/pack-ico.js` 把它打成
  **七档 32 位 BGRA DIB**（16/24/32/48/64/128/256，含 AND 掩码）—— 容器格式与旧图标一致，
  像素来自交付原图（先 premultiply 再整数框滤波，透明边缘不发黑）。

### Changed

- `resources/icon.png` / `resources/icon.ico` 换成桌面交付的那份（PNG 按字节原样复制，
  SHA256 `622127C6…`；ICO 由上面那份 PNG 重新打档）。删掉 `resources/icon.svg` /
  `icon-small.svg` —— 它们是第一/第二版设计的 SVG 母版，都不是现行设计的真相源，留着只会误导。
- **应用内标识改为图标本图**：启动骨架屏与「关于」页原先用 `Icon.vue` 里那条手绘折线 `logo`，
  与图标不同源。现在用 `resources/icon.png` 的 **128×128 下采样内嵌成 data URI**
  （`src/renderer/src/assets/iconPng.ts`，由 `tools/sync-app-icon.js` 生成）——
  **不引用任何外部文件**，换设备 / 换目录 / 换平台都照常显示。
- `tools/build-app-icon.js`（旧设计生成器）**默认不再写 `resources/`**：产物落
  `%TEMP%\lumin-icon-redesign\`，要覆盖得显式加 `--force`。
- `_verify-packaging.js`：中心区亮度判别按新图标重新标定（32px 中心 8×8 luma≈178 vs Electron 66），
  并把 PNG-in-ICO 这个坑记在断言旁；顺手修掉两条「复用模式」的假红 —— `LUMIN_PKG_SKIP_BUILD=1`
  时**不再清空 dist**（那正是要复用的产物），跳过的断言改为 `SKIP` 而不是 FAIL。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` + `vue-tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit` | **251/251 pass**（新增 `tests/toolIcon.test.mjs` 6 条：母图正方形/七档 DIB/负载字节数可复算/ICO 像素确由母图缩出/内嵌标识同步/build 下无旧图标） |
| `electron-vite build` | exit 0 |
| `tools/_verify-taskbar-jumplist.js` | **31/31**（快捷方式 icon 指向运行时内容寻址副本，与 `resources/icon.ico` 字节一致） |
| exe 内嵌图标（独立复核） | 七档负载 **7/7 逐字节命中 `dist/win-unpacked/Lumin.exe`**；同一批字节在 `electron.exe` 里 7/7 不存在；GDI+ 抽出的 32×32 中心 8×8 = (178,178,179) |
| `node tools/pack-ico.js --check` / `node tools/sync-app-icon.js --check` | 均 exit 0 |

### Docs

- `docs/typora-wysiwyg-manual.md` §4.36 增补「第二轮图标更换记录」（PNG-in-ICO 的坑、判据重标定、
  单一来源守卫搬进单测）；`docs/packaging-install-test.md` 的 I-03 复验结论同步更新。

## [Unreleased · 快捷工具栏可关可调 + 编辑区右键菜单收窄] — 工具栏空白区右键菜单 / 设置里的显隐与排序（承第十九轮）

> 用户要两件事：① 编辑区工具栏的空白区加右键菜单（关闭工具栏 / 调整工具项），并把
> 「开关 + 调整」一并放进设置；② 编辑区右键菜单的宽度收窄一点。
> ①的实现要点是**让工具栏本身变成数据**：此前 24 个按钮是写死在模板里的，
> 「调顺序 / 关掉某一项」必须先在数据层有一份目录。

### Added

- **快捷工具栏项目目录**（`src/shared/toolbarItems.ts`）：21 个可调整项（侧边栏 / 撤销 / 重做 ‖
  标题 1-3 ‖ 加粗…行内代码 ‖ 引用…代码块 ‖ 表格…目录），每项带稳定 id、图标、文案 key 与
  **视觉分组**；分组只在渲染时决定分隔线位置，因此换序只在同组内进行（跨组换序会把分隔线搅乱，
  在 `moveToolbarItem` 里被拒绝）。同文件给出纯函数：`sanitizeToolbarItems`（丢掉未知 id / 去重 /
  保留空数组）、`moveToolbarItem`、`insertToolbarItemByOrder`。
- **工具栏空白区右键菜单**（`Toolbar.vue` 的 `onToolbarContextMenu`）：一级两项 ——
  「关闭工具栏」「调整工具项」；二级（悬停展开）是**项目勾选列表**，已显示项带勾且排在前面，
  点一下即从工具栏移除、再点回来即按出厂顺序插回原位。判定「空白」用 `[data-toolbar-item]`：
  右键落在任意按钮上时不弹这个菜单（与按钮的左键行为一致）。
- **通用右键菜单支持子菜单**（`ContextMenu.vue`）：条目带 `children` 时右侧出现 `›`，
  悬停或 → 展开，`checked` 显示勾选态。子菜单是独立浮层，配「安全区 + 160ms 收起宽限」——
  与编辑器右键菜单同一套指针判定（此前只有编辑器菜单有这套）。
- **设置 → 编辑器 → 快捷工具栏**（`SettingsToolbar.vue`）：整条栏的开关 + 组内上/下移 +
  隐藏/加入 + 恢复默认，改动即时生效并落 SQLite。右键菜单的「调整工具项」直接打开这一区块
  并高亮一下（`ui.toolbarAdjustFocus`），不再另起模态浮层（避免模态套模态）。
- **视图 → 显示快捷工具栏**（应用内菜单 + 原生菜单 `toggle-toolbar`）：工具栏关掉后右键菜单
  也随栏消失，这是唯一的「开关型」入口。
- 设置项 `toolbarVisible` / `toolbarItems`（默认 = 目录顺序，即改动前的工具栏）。

### Changed

- **编辑区右键菜单收窄**：一级面板 `min-width 268 / max-width 320` → **234 / 268**，
  条目内边距 8px → 7px（最长条目「右侧插入列 + 快捷键」仍完整显示，实测 234px）。
  二级菜单（190~260）尺寸不动。
- 工具栏按钮改为**一条通用渲染路径**（图标 + 序号 + 激活态 + 禁用态），行为对齐：
  撤销/重做用真 `:disabled`（回退栈空时不再「看起来能点」，D24 修复）；
  源码模式下编辑器命令按钮统一禁用（D25 修复），但侧边栏开关保持可用。
- 工具栏项目 `data-toolbar-item` / 工具栏根 `data-editor-toolbar`、右键菜单面板
  `role=menu` + `aria-label` —— 既是无障碍语义，也是验收脚本的定位锚点（不靠 Tailwind 类名）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` + `vue-tsc --noEmit` | exit 0 |
| `npx eslint --cache .` | **0 error / 0 warning** |
| `npm run test:unit` | **245/245 pass**（新增 `tests/toolbarItems.test.mjs` 13 条：清洗/去重/空数组语义/同组换序边界/按目录插回） |
| `electron-vite build` | exit 0 |
| `tools/_verify-toolbar-settings.js`（新增 35 条） | **35/35 PASS**（空白区右键 → 两项；按钮上右键不弹；二级勾选列表；关掉某项后 settings 与工具栏同步；关闭工具栏后 DOM 消失；视图菜单与设置开关两条恢复路径；设置里上移/隐藏/加入/恢复默认；编辑区右键菜单 234px） |

### Docs

- `docs/_audit/ui-inventory.md` §1.3：工具栏改为目录驱动后的接线与新增入口说明（表内行号仍是
  审计当时的快照，未逐行重排）。

## [Unreleased · CJK 标点旁的加粗 + 打字卡顿] — 中文引号/全角标点旁的 `**…**` 成对 + 每键成本与文档长度解耦（承第十八轮）

> 用户报两件事：① `**一句话**：……押在了**「保存路径」与「Markdown 保真」**这两件……`
> 这一整段**加粗渲染成字面星号**、加粗区间错位；② 「写入内容变的非常卡，非常非常卡」。
> 两件都先取证再改：**①的根因不在本仓库的字面量化**（那条怀疑被证伪），在 markdown-it 的
> flanking 判定；**②的根因是每键都把全篇带样式的块重算一遍**（50 段文档实测每键 51 次
> markdown-it 解析）。详见手册 §4.71。

### Fixed

- **CJK/全角标点旁的 `**…**` 不再渲染成字面星号**：`押在了**「保存路径」与「Markdown 保真」**这两件`
  在 stock markdown-it 下**开/闭定界符都不成立**（`「`/`」`/`：`/`（`/`）` 算标点 ⇒ 这个 `**`
  既不是 left-flanking 也不满足闭合条件），整段定界符配对整体错位 ⇒ 两处 `**` 落成字面文本。
  同一段文字在不同上下文里还会**渲染不一致**（单独一行因内部「手打标记识别」而加粗、放进长段落
  变字面星号）——这条不一致本身就是缺陷。
  修法：在 **markdown-it 那一层**（`parse.setup` 钩子，与 escape / 冗余嵌套强调同一套机制）换掉
  emphasis 的 flanking 判定，**CJK/全角标点不参与 `*` 的标点分类**；加载/刷新与实时重推因此
  共用同一条规则。上游 `balance_pairs` 与 rule-of-3（`**2****2**` 那类语义）一个都没动。
- **打字卡顿**：`typoraInlineMarks.appendTransaction` 每次事务都遍历全篇 textblock 并对每个
  「带样式标记」的块跑整段归一化（含 markdown-it 重推）—— 而 `blockNeedsNormalize` 对已带
  markup 的块**恒为真**，于是每敲一个字全篇每个加粗段落都重算一遍。修复：按块记忆
  「已归一的块节点」（PM 节点不可变 + 结构共享 ⇒ 没被编辑的块引用不变），只重算被这次编辑
  改到的块；纯选区变化直接跳过。装饰同理按块缓存清单（块内相对偏移）。

### Changed

- `typoraInlineMarks` 的装饰构建改为**按块缓存清单**（`decoCache: WeakMap<PMNode, BlockDecos>`）：
  一次遍历块内容同时产出 mdMarker 构造与转义段（此前是两次全文遍历），每键只对变化过的块重扫
  marks。**不做「只算可见视口」是故意的**：转义拆分出的 `.md-escape-backslash`/`.md-escape-char`
  是常显渲染结构，而 PM 的 docView 惰性构建、滚动不重建 —— 视口外不带这套装饰，滚过去就会看到
  反斜杠直接露在正文里。
- `inlineMarkerCore.styleList()` 加无分配快路径（入参已是规范序时直接浅拷贝）。
- `tools/lib/harness.js` 新增 `bringToFront(app)`；`_verify-inline-formats.js` 的取焦点重试每轮
  调用它 —— 用户**自己的** Lumin 窗口占着前台时被测实例拿不到焦点，真实输入类断言会报
  `NO-FOCUS`（本轮实测复现，与代码无关）。

### 口径（本轮新增，需要显式知情）

- **CJK/全角标点不参与 `*` 的 flanking 判定**（`、。〈〉《》「」『』【】〔〕`、全角 ASCII 变体、
  `‘’“”`、`—` `―` `…`）。这是对 CommonMark 的**一处有意偏离**（严格 CommonMark / GitHub / VSCode
  会把这类输入渲染成字面星号）；产品口径取「中文写作里它必须成粗」，且与编辑器内部的
  「手打标记识别」保持一致。偏离**只影响**「CJK/全角标点紧贴 `*` 定界符」这一类输入：
  31 份 md 夹具逐份 diff，放宽前/后 **30 份 HTML 完全相同**（唯一变化的是 `_` 的
  `：__加粗__`，所以最终**只对 `*` 放宽**），最终 **31 份全部相同**（改动半径 = 0）。
  要回到严格 CommonMark：删掉 `cjkEmphasis.ts` 的注册（`extensions.ts` 一行）与两个单测即可，
  套件 J 组的「markdown-it 对照基准」断言会立刻变红，不会被静默绕过。
- `_` 的判定**完全保持上游语义**：它的 `can_open` 里 `isLastPunctChar` 是正向使能项（intraword
  限制），放宽标点会把 `下划线形式：__加粗__` 关掉（实测 emphasis.md 夹具变红）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（typecheck + lint **0 error / 0 warning** + 单测 **222/222** + 构建） |
| `_verify-inline-formats.js` | **183/184 PASS + 1 SKIP**（新增 J 组夹具 15 条 + 最小复现 4 条 + K 组性能 5 条） |
| 六套件门禁（行内格式 / 保真 / 布局 / 代码块 / 源码往返 / 查找替换） | **6/6 全绿**：`183/184`、`101/102`、`9/9`、`3/3`、`4/4`、`12/12` |
| `node tools/run-suites.js` | 22 套件 **19 PASS / 3 FAIL**，三条红**全部**是环境/抖动（复跑与「原代码对照」取证）：<br>· `_verify-session-last-closed.js` 5/8 → **单独复跑 8/8**；<br>· `_verify-md-fidelity.js` 99/102（两条历史快照断言）→ **复跑 101/102**；<br>· `_verify-surface-stress.js` 70/72（`many-fences-2000 装载 ≤ 80s` 实测 188.7s、`mixed-real-100k ≤ 55s` 实测 61.7s）→ **原代码同机复量同样报红**（见手册 §4.71 五） |
| 打字每键（3000 字多段文档，末尾逐字 100 字） | 修复前 avg 14.54 / p95 19.7 / max 40.1ms → 修复后 **0.65 / 0.9 / 1.4ms**；每键 markdown-it 解析 **51 → 2** 次 |
| `_verify-surface-stress.js` 的 `many-fences-2000 切到源码 ≤ 6000ms` | **红，但与本轮无关**：把**改动前的代码**重新构建再量，同一条断言同样报红（21.9s vs 本轮 21.8s；同一份原代码的 `load` 也从 53.7s 漂到 62s）。根因是 CDP evaluate 会把跨帧的 CodeMirror 建实例工作「吸收」到下一个阶段，归因随环境漂移。取证表见手册 §4.71 五 |

### Docs

- 手册新增 §4.71（取证、根因、改法、口径、验收与前后对照表）。

## [Unreleased · 行内标记的字节保真] — 字面量化补齐「样式正文」这一档 + 转义反斜杠按光标显隐（承第十七轮）

> 用户报：实时渲染区输入 `**2****2**`，源码变成 `**2\*\*\*\*2**`。**先取证再改**：隔离实例跑了
> 四条写入路径，报障里的两条推断（「输入中间态把标记锁成字面文本」「一次性写入不会这样」）**都被证伪**
> ——逐字键入 / 一次性 `insertContent` / 从磁盘装载**三条都**产生转义。真根因是字面量化漏了
> 「样式正文里的裸标记字符」，被 markdown 写出器补了反斜杠。详见手册 §4.70「五、六」。

### Fixed

- **样式正文里的裸标记字符不再被补反斜杠**（`**2****2**` 逐字节留住）：
  `typoraInlineMarks.ts` 的 `literalizeStrayMarkers` 见到 `mdStyle` 就整段跳过，
  于是 `**2****2**` 中间那四颗星（CommonMark 语义：**一个** `<strong>` 包住字面文本
  `2****2`）落进普通文本分支，被 `MarkdownSerializerState.esc()` 转义成 `\*\*\*\*`。
  同类受害输入：`**a * b**` → `**a \* b**`、`*a**b*` → `*a\*\*b*`。
- 字面量化下沉到纯逻辑核心后**顺带修掉装载路径的同一问题**（此前只有「源码权威重推」那条路
  会字面量化，带 legacy mark 的块走常规归一化时不做）。
- **真实剪贴板粘贴丢字符**（本轮顺带查出、上一轮遗留）：Ctrl+V 粘贴 `**2****2**` 落成
  `**2**2**`（少两个星号）、`**a * b**` 落成 `**a  b*`。根因是 tiptap 的 **mark 粘贴规则**
  （`markPasteRule` 的 appendTransaction，只在 `uiEvent === 'paste'` 时触发）：markdown 粘贴
  解析出「一个 legacy bold 文本节点 `2****2`」之后，它又把这批定界符当语法消费掉。
  `extensions.ts` 的四个「安静版」mark 此前只关了 `addInputRules` / `addKeyboardShortcuts`，
  本轮把 `addPasteRules` 一并关掉（同一理由：样式由标记文本派生，吃掉 `**` 就等于删用户的字符）。
  取证链：真剪贴板复现 → 同一 slice 带/不带 `paste` meta 对照（不带 → 正确，带 → 丢两个字符）
  → 忠实复刻 PM 的 appendTransaction 循环认出 keyless 粘贴规则插件。

### Added

- `inlineMarkerCore`：`splitStrayMarkerRuns()`（字面量化的唯一判据：只有 `*`/`~`/`` ` `` 的
  **连续段**可能被字面量化）、`literalizeStrayAtoms()`（无样式正文 → `mdMarker(literal)`；
  **样式正文 → verbatim 原子 + `MdEscape` 的 `escape:false` 逐字写回**）、
  `hasStrayMarker()`、`needsSourceReparse()`（「源码权威重推」的触发判据，同时就是
  **已字面化标记的重新评估机制**：文本一变就把整段原文重喂 markdown-it）。全部进单测。
- `typoraInlineMarks.escapeDecorations()` + `style.css` 的 `.md-escape-backslash` /
  `.md-escape-char`：**转义反斜杠拆成两个 span 且按光标显隐（暗色 `--ink-3`，三套主题各自定义）**，
  与 `.md-marker` 复用同一套机制（`.md-reveal-inline` + `font-size: 0` 折叠，不用 `display:none`）。
  纯观感：模型、`textContent`、落盘字节一个都不动
  （`data-md-escape` 仍由 `MdEscape.renderHTML` 承载，解析语义不变）。

### Changed

- **转义反斜杠从「暗色常显」改为「跟 `**` 一样按光标显隐」**（用户反馈的行为修订）：
  `escapeDecorations()` 新增 `collectEscapeRuns()` —— 反斜杠之间只隔着各自的被转义字符时算
  **一段**（`\*\*\*\*` = 1 段 4 个，光标在任一位置都**同时**显示 / 同时折叠；`\* \*` 中间有空格
  = 2 段，各显各的）。显隐判据与 mdMarker 构造**逐字一致**（`from <= run.end && to >= run.start`，
  左右边界均含 → 光标紧贴段两端也显示）；`style.css` 的 `.md-escape-backslash` 默认
  `font-size: 0`，带 `.md-reveal-inline` 时 `font-size: inherit` + 同一条淡入动画。
  被转义的字面字符（`.md-escape-char`）始终正常显示。
- **只有「真转义」（`\` + ASCII 标点）参与折叠**：实测发现 `C:\Users\x` 这类 Windows 路径
  在装载路径上**同样是 `MdEscape` 文本节点**（逐字写回的载体，不是 CommonMark 转义）——
  若一起折叠，路径在屏幕上会少字符（`C:Usersx`）。所以非标点 `\X` 一律常显（复用同一个
  `.md-reveal-inline` 的「已展开」态，判据复用既有常量 `ASCII_PUNCT`），取舍是
  「宁可多显示一个反斜杠，也绝不把内容藏起来」。
- `literalizeStrayMarkers`（Fragment 级、只在重推路径调用）删除，逻辑并入 `normalizeAtoms`
  末尾的原子级字面量化 —— 两条路径（重推 / 常规归一化）行为一致，且可被毫秒级单测覆盖。
- `resolveBlockContent` 的重推条件改调 `needsSourceReparse()`（纯逻辑核心），
  「纯行内文本」判定抽成 `isPureInlineContent()`。

### 口径修正（本轮）

- **`**2****2**` 的正确语义是「一个 `<strong>` 包住字面 `2****2`」**，不是两个相邻 `<strong>`：
  CommonMark §6.2「3 的倍数」规则只在前一定界符串**同时能开能闭**时生效（`**` 与 `****` 的长度和
  6 是 3 的倍数且都不是 3 的倍数 → 不许配对），最后的 `**` 回头配上最前面的 `**`。
  markdown-it（默认 + commonmark preset）与 marked 三方实测一致 → 实时渲染区显示
  「粗体的 `2****2`（星号可见）」**才是**与 GitHub / VS Code 一致的行为。
  本轮按 CommonMark 语义实现，未按报障时的预期改成「两个相邻粗体 2、星号隐藏」。
- **已知边界（保留现状，不引入结构损坏）**：带链接 / 下划线 mark 的**无样式**文本里的裸标记字符
  仍会被补反斜杠（`[a*b](url)` → `[a\*b](url)`）——`mdMarker(literal)` 挂不住那些 mark，
  硬切会把链接劈成 `[a](u)*[b](u)`。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（typecheck + lint 0/0 + 单测 **217/217** + 构建） |
| `_verify-inline-formats.js` | **159/160 PASS + 1 SKIP**（SKIP = 「下划线 + 加粗」已知缺口；转义反斜杠显隐一组 29 条） |
| `_verify-md-fidelity.js` | **101/102**（不回退） |
| 五套件门禁（行内格式 / 保真 / 布局 / 代码块 / 查找替换） | 全绿：`159/160`、`101/102`、`9/9`、`3/3`、`12/12` |
| `node tools/run-suites.js` | **22 个套件，全绿**（数字见手册 §4.70） |

### Docs

- 手册 §4.70 新增「五、样式正文里的字面标记字符被补反斜杠（本轮，任务 A）」与
  「六、转义反斜杠的观感：拆成两个 span + 按光标显隐（本轮行为修订，任务 B）」，并补「已知边界」三条；
- `docs/optimization-program.md` 台账加行。

## [Unreleased · 日常与深度使用验收] — 逐控件盘点 + 结构面审计（i18n / 设置 / IPC / 覆盖矩阵）

> 视角：日常使用（每个按钮/菜单/设置项）与深度使用（边界状态、结构一致性）。
> 报告：桌面《lumin-日常与深度使用测试验收报告.md》；原始审计见 `docs/_audit/`。

### Added

- `tests/i18nAndIpc.test.mjs`（进 `npm run ci`，5 条）：三语 key 集合必须一致、en/ru 不许残留中文、
  代码里字面量 key 必须存在于语言包、preload 调用的 IPC 通道主进程必须注册、主进程死通道必须登记原因。
- `docs/_audit/i18n-and-settings.md`：i18n 覆盖统计（三语各 **399** key、零缺失、零漏翻译、**59 条死键**）
  + 30 个设置项的「UI ↔ 默认值 ↔ 消费点」矩阵 + 缺陷清单（含逐条 `文件:行` 证据）。
- `docs/_audit/coverage-matrix.md`：**121 行**功能 × 套件覆盖矩阵（12 个功能域）、**18 条零覆盖空白**、
  套件健康度三分类，以及两条结构发现（见下）。

### 关键发现（本轮未全部修完，逐条见报告 §5）

- **S1**：设置面板切 en/ru 后仍以中文为主（约 60 处硬编码），而词条早已存在于语言包（死键）→ 属于
  「翻译做完了没接上」；同类还有 `AboutView` 整页、`ModalHost` 的「取消/确定」、浮动工具条 title、
  全局搜索面板、原生对话框「所有文件」、未命名文档名、router 离开确认（与已本地化的 `lib/dialog.ts` 重复）。
- **S2 测试基建**：`tools/verify-tiptap.js`（1473 行 / **114 条具名断言**，守着气泡菜单、input rules、
  表格编辑、全局搜索、粘贴）**不在任何矩阵里** —— 硬编码绝对路径 + 写死 dev server + 不用 harness。
- **S4 假绿**：`--all` 里约 15 个 0 断言探针被运行器按退出码判成 `PASS 0/0`。
- **S3/S4 健壮性**：`settings:update`（设置唯一写入点）零入参校验；`splitRatio` 载入不 clamp；
  `autoSaveInterval` NaN → 0ms 定时器；非法 `defaultEncoding` 被当显式编码并**污染该文件的编码记忆**；
  `nativeMenuBar` 名实不符（`app:setMenuBar` 无调用者）；死 IPC 通道 `file:getPathForFile`。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | **181/181**（新增 5 条 i18n/IPC 守卫） |
| `npx eslint .` | **0 error / 0 warning** |
| `electron-vite build` | 成功 |
| `node tools/run-suites.js` | 21 个套件 20 绿（`_verify-find-replace` 单跑 12/12、成套连跑 10/12 → 测试时序问题，已记台账） |

### Docs

- 手册新增 §4.69（本轮结论摘要与待办）；optimization-program 台账同步；桌面另存完整验收报告。

## [Unreleased · 双面一致性测试] — 实时渲染 ⇄ 源码的全面验收（L0–L4）

> 目标：按「专业、可复跑、可扩展」的方式把两个编辑面（wysiwyg / source / split + 代码块内 CM）
> 的一致性测一遍，回答「结构、渲染、数据有没有问题，哪些处理得不够好」。方案见
> **`docs/wysiwyg-test-plan.md`**（质量模型、不变量 I1–I12、分层、生成器设计、预算、扩展方式、结果台账）。

### Added

- **L0 纯函数性质测试**（进 `npm run ci`）：`tools/lib/md-gen.js`（生成式语料库：40+ 块级 + 30+ 行内构造、
  三种接缝、上下文包裹、LF/CRLF/CR/BOM/文末换行变异、种子可复现）+ `tools/lib/surface-invariants.js`
  （内容守恒 / 幂等 / 切面稳定 / 哨兵词追踪 / 结构扫描 / 损失分诊）+ 19 条单测（含「判据不许误报/漏报」）。
- **L2 `tools/_verify-surfaces.js`（30 条）**：切面无副作用、源码面完整性、文档树签名同构、
  光标位置语义（跨面按比例、同源精确、切回可续写）、dirty/撤销/保存、**表驱动的渲染结构**（13 条：
  标题字号递减、代码块 CodeMirror、引用缩进、表格对齐、任务复选框、KaTeX、front matter、行内代码、粗体）、分屏同世代。
- **L3 `tools/_verify-surface-fuzz.js`**：生成式语料往返（默认 60 篇，`LUMIN_FUZZ_SEED/COUNT` 可调），
  失败时按块/行**贪心最小化**给出最小复现；已知缺陷登记在 `KNOWN`（不拖红矩阵，但仍在报告里）。
- **L4 `tools/_verify-surface-stress.js`（72 断言）**：12 个极端/边界/畸形用例 × 6 类断言
  （不崩 / 结构守恒 / 切面稳定 / 内容完整 / 三处耗时基线）：1MB 文档、两万行、单行 200KB、
  100 层列表、40 层引用、2000 个围栏、200×30 宽表、5000 处行内样式、800 公式、Unicode 重载、
  未闭合构造、100 代码块 + 100 表的真实混合文档。
- `tools/lib/surface-probe.js`：三套件共用的双面探针（页面侧表达式 + 装载/切面工具），
  把踩过的坑（不 flush 会被回灌覆盖、源码模式装载静默失败、`textContent` 漏原子节点原文）写进文件头。

### Fixed（都是测试查出来的真实缺陷）

- **S1 · 深层嵌套静默丢内容**：50 层以上的列表/引用在保存时**整段消失** —— markdown-it 的块解析器
  `if (state.level >= maxNesting) { state.line = endLine; break }` 触顶即跳过剩余行，而默认
  `maxNesting: 100`、每个列表层吃 2 级 ⇒ 实际上限 ≈ 50 层。实测 100 层列表只剩 49 层。
  修法：新增 `src/renderer/src/lib/editor/parseLimits.ts`，用 `parse.setup` 钩子把 `maxNesting` 抬到 1000。
  回归：`deep-list-100`（哨兵 100/100）；深度扫描 64/100 层从 lossy 变 exact。
- **S2 · 段尾孤立反斜杠被改写**：`a\`（CommonMark 里是字面反斜杠）保存一次变成 `a\\`（文件涨一个字符）。
  根因：自定义 escape 规则在 `pos + 1 >= posMax` 时 `return false`，markdown-it 当普通文本 → 序列化器转义。
  修法：`typoraInlineMarks.ts` 补「段尾字面反斜杠」分支，走 `md_escape`（`escape:false`）逐字写回。

### 已知未修（fuzz 抓到并登记）

`> ```mermaid` + `> ``` `（空引用代码块）内容从空串变一个换行；CR 行尾 + 引用的空行展开与 setext 重排；
纯文本下划线补转义（保义但改字节）；列表后 `---`+段落+`---` 的 HR/setext 歧义重排。三条性能问题
（977KB 文档装载/回灌各 ~16s；2000 个代码块 52s；混合 98KB 34s）已立基线守卫，建议代码块虚拟化。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**176/176** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `electron-vite build` | 成功 |
| `node tools/run-suites.js` | **21 个套件**：20 绿，`_verify-find-replace` 在**成套连跑**时 10/12、单独跑 12/12 → 判定为**测试隔离/时序问题**（S4，已记台账；非产品回归） |
| L2 / L3 / L4 | **30/30** / 5 类不变量通过（4 篇命中已登记缺陷） / **72/72** |

### Docs

- 新增 `docs/wysiwyg-test-plan.md`（方案 + 结果台账 §9：F1–F12 逐条现象/根因/状态/回归）；
  手册新增 §4.68；optimization-program 台账同步；桌面另存一份《双面一致性测试验收报告》。

## [Unreleased · 单实例提示的终端编码] — 提示改成纯 ASCII（Windows 控制台代码页）

> 承接上一节：修好「第二个实例干净退出」之后，用户终端里那条中文提示是**乱码**，
> 而且四行被并成一行 —— 这次的根因是 Windows 控制台的代码页，不是单实例逻辑。

### Fixed

- **提示改成纯 ASCII**。上一版用 `fs.writeSync(2, 中文)` 写提示；Windows 控制台按**代码页**解读
  字节（中文系统 cmd 是 936/GBK），而写出去的是 UTF-8 —— 中文整个变乱码，更麻烦的是行尾那个
  非法尾字节会把**换行一起吃掉**：

  ```
  [Lumin] 宸叉湁瀹炰緥鍦ㄨ繍琛岋紙鍗曞疄渚嬮攣琚畠鎸佹湁锛夛紝鏈鍚姩宸查€€鍑恒€?        鍛戒护琛屽弬鏁?…
  ```

  试过「先识别控制台、再交给 Node 转码（WriteConsoleW）」这条路，走不通：Electron 自己把
  `isTTY` 的 spec 标成「on some machines 不可靠」压掉了（
  [electron/electron@62b1034](https://github.com/electron/electron/commit/62b1034c6be9a0590d3cea8978927e67650b0a08)），
  本机实测在真实控制台下 `process.stderr.isTTY` 仍是 `undefined`、`new tty.WriteStream(2)`
  直接 `ERR_TTY_INIT_FAILED`，而管道下子进程 `[Console]::IsOutputRedirected` 为真 ——
  两种落点都拿不到可信信号。既然探测不可靠，就只能让**内容**不依赖探测：ASCII 在任意代码页、
  管道、日志文件里都是对的。提示里的关键信息（要不要新开实例、怎么重启）本来就是命令，英文不影响操作。

  顺带立规矩并落地：**主进程 console 输出一律 ASCII**。原先三处中文 console 输出一并改成英文
  （`[protocol] refused lumin-file request`、`[profile] isolated dev profile active`、
  `[db] encoding metadata migration: …`），中文说明留在界面与文档里。

### Added

- `tests/mainConsoleAscii.test.mjs`：扫描 `src/main/**/*.ts` 里所有 `console.*` 的**实参文本**，
  出现非 ASCII 就红（含「扫描器本身先自证」的两个断言：注释里的 console 调用不算、
  含中文的实参必须被认出来、纯 ASCII 的不许误报）。这条规则违反了不会有任何报错，只会在用户
  终端里显示成乱码 —— 所以拿测试钉住，而不是靠 review 时肉眼检查。
- `tools/_verify-single-instance.js` 增加断言「提示是纯 ASCII」+ 提示文案改为英文版
  （13 → 14 条）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**159/159** 单测，新增 2 条 ASCII 守卫） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **18/18 套件 PASS**（`_verify-single-instance` **14/14**） |
| 现场复现 `npm run dev`（已有实例在跑） | 四行 ASCII 提示可读、exit 0、1314ms、无缓存报错 |

### Docs

- README「快速开始」注明提示是英文（终端代码页不吃 UTF-8 中文）；手册 §4.67 增补这一坑与验收。

## [Unreleased · 单实例锁] — 「`npm run dev` 报一堆缓存错就退出」的真因

> 现场：dev 实例还开着时再执行一次 `npm run dev`，控制台刷出三条 Chromium 磁盘缓存报错，
> 然后整个命令就结束了、窗口也没出来。根因不在 electron-vite，而在主进程的单实例写法。

### Fixed

- **第二个实例不再跑完整启动流程**。此前 `src/main/index.ts` 用的是 Electron 文档里的写法
  `if (!app.requestSingleInstanceLock()) app.quit()`，而 **`app.quit()` 在 ready 之前只是「标记」**：
  ready 一到，`app.whenReady()` 的回调照常执行（实测对照见新套件 E 项）—— 于是被锁挡下的第二个
  Electron 进程照样开 SQLite、写设置、建窗口、装菜单、拉 GPU 进程，与首个实例**共用同一个
  userData**，两边的 Chromium 磁盘缓存互相争抢：

  ```
  ERROR:net\disk_cache\cache_util_win.cc:25  Unable to move the cache: 拒绝访问。(0x5)
  ERROR:net\disk_cache\disk_cache.cc:236     Unable to create cache
  ERROR:gpu\ipc\host\gpu_disk_cache.cc:724   Gpu Cache Creation failed: -2
  ```

  这个进程退出后，electron-vite 的 dev 命令跟着结束 —— 用户看到的就是「报错 + 没窗口」。

  修法：新增 `src/main/singleInstance.ts`，抢不到锁就 `app.exit(0)`（实测**不返回**，退出码 0，
  且不再出现那三条报错）并同步写一行中文提示（`fs.writeSync(2, …)`：重定向下 `console` 是异步的，
  紧接着退出会把提示吞掉）。该模块在 `index.ts` 里排在 `./menu` / `./ipc`
  （→ `services/database` 的模块级 `new LuminDatabase()`）**之前**求值，所以第二个实例连首个实例的
  SQLite 都不会打开、更不会跑迁移。
- **`app.setName('Lumin')` 挪进上述模块**：userData（以及按它认定的锁）由 app name 推导，名字必须
  早于抢锁与首次 `getPath('userData')`。顺带修掉一个跨平台隐患：此前 `setName` 晚于 `database.ts`
  的模块级 `new`，库落在 `.../lumin` 而其余数据落在 `.../Lumin`（Windows 大小写不敏感所以看不出来，
  macOS/Linux 上是两个目录）。

### Added

- `tools/_verify-single-instance.js`（**13 条，已进默认矩阵**，自管两个实例 + 独立调试端口 9231）：
  第二个实例必须**自己退出**（不是被超时杀掉）、退出码 0、提示里说清「已有实例在运行」并给出
  `npm run dev:isolated` 的出路、输出里**没有** `[menu] rebuilt`（=没跑启动流程）、**没有**上面那三条
  缓存报错；另加两条回归保护：命令行参数仍被转交（首个实例把目标 `.md` 开成新窗口）、构建产物里
  守卫的求值顺序早于 `new LuminDatabase`；外加一条根因对照（`app.quit()` 早于 ready 时 whenReady 回调照跑）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**157/157** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **18/18 套件 PASS**（新增 `_verify-single-instance` 13/13） |
| 现场复现（同一个 userData 再起一个实例） | 打印提示、**exit 0**、耗时 ~0.2s，无缓存报错 |

### Docs

- README「快速开始」补单实例说明（第二次 `npm run dev` 为什么会自己退出、要用 `dev:isolated`）；
  手册新增 §4.67（根因、两段实测证据、修法与验收）；`docs/optimization-program.md` 台账同步。

## [Unreleased · 数学公式渲染] — 功能缺口清零（KaTeX）

### Added

- **数学公式渲染**：`$…$` 行内、`$$…$$` 块级（单行与多行写法都认），KaTeX 画出来。
  - **公式原文一个字符都不动，渲染只是视图**（与「标记文本即源码」模型一致）：
    行内是带 `MdMath` mark 的文本节点（`escape:false`，序列化逐字写回），
    渲染靠**装饰**（KaTeX 组件 + 原文折叠，光标落进去就露出 `$…$` 原文可编辑，与行内标记显隐同一套交互）；
    块级是 `MathBlock` 原子节点（原文在属性里），屏幕呈现走 NodeView。
  - 识别规则抽成纯函数 `lib/mathScan.ts`（9 条单测）：不跨行、内容非空、
    **闭合 `$` 后不能紧跟数字**（否则「价格 $5 和 $6」会被吃成公式）、`\$` 不是起点、`$$` 不当行内公式。
  - 公式写坏不让整篇崩：KaTeX `throwOnError: false`，失败降级成红字，原文照旧。
- `tools/_verify-math.js`：7 条端到端断言（原文进文档 / 行内渲染 + 折叠 / 块级 display /
  下划线与星号不被误判 / store 逐字 / 光标落进露出原文 / 坏公式不崩），已进默认矩阵。

### Fixed

- **`*` 不再把公式切开**：`toAtoms` 与 `literalizeStrayMarkers` 此前只把行内 HTML、展开态链接
  当「不透明内容」，公式没算 —— 于是 `$a * b$` 被 `literalizeStrayMarkers` 在 `*` 处切成两个文本节点，
  公式碎成两段（实测 4 个公式渲染成 5 个）。现在 `mdMath` 与它们一视同仁。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**157/157** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **17/17 套件 PASS** |
| 夹具 | `math.md` normalized → **exact**；合计 **16 exact / 15 normalized / 0 lossy** |

### Docs

- 手册新增 §4.66（两条链路、三个坑、验收；并给这条线收口：两个功能缺口都做完了）。

## [Unreleased · 编辑器内查找替换] — 菜单/Ctrl+F 的功能缺口补齐

> 此前菜单里的「查找 / 替换」与 `Ctrl+F` 都只 toast 一句「功能待接入」。

### Added

- **编辑器内查找替换**：右上角查找栏（`components/FindReplaceBar.vue`），
  `Ctrl+F` 打开/关闭 · `Enter` 下一个 · `Shift+Enter` 上一个（首尾循环）· `Esc` 关闭 ·
  `Aa` 区分大小写 · 「替换」只动当前命中 · 「全部替换」一次改完。
  - **两个编辑面共用一份查询状态，各自算匹配**：实时渲染/分屏在 ProseMirror 文档里**按块**找
    （`lib/editor/findInDoc.ts`，位置是文档位置）；源码模式在 `files.current.content` 里找
    （位置是字符偏移）。计数显示的是**当前编辑面**的结果 —— 比显示一个对不上的数字诚实。
  - 纯逻辑抽在 `lib/findReplace.ts`（转义、查找、循环步进、替换计划、片段→位置映射），
    **无依赖可单测**：`tests/findReplace.test.mjs` 11 条。
  - 全部替换在渲染面走**一个事务、从后往前**替换：位置不会互相顶掉，Ctrl+Z 一次整体撤销。
  - 三语各新增 11 个 `find.*` 键。
- `tools/_verify-find-replace.js`：12 条端到端断言（入口 / 命中与循环 / 大小写 /
  替换与全部替换 / Esc / 源码面的查找与替换 / 回灌渲染面），已进默认矩阵。

### Fixed

- **「下一个」不再抢焦点**：查找的选中与滚动**一律不 focus**（`setTextSelection` +
  `scrollIntoView` 不需要焦点，编辑器照样画出选区与命中高亮）。第一版用了 `focus()`，
  结果下一次 Enter 落到正文里 —— 按两下「下一个」等于在文档里敲了两个回车，实测把整段写坏。
  焦点只在**关闭查找栏**时归还给当前编辑面。
- **源码模式下 `Ctrl+F` 不再失灵**：快捷键系统的 `notInInput` 守卫把源码 textarea 与
  代码块里的 CodeMirror 也算成「表单输入框」，于是最需要查找的源码模式反而按不出来。
  现在 `isTextEntry()` 先排除**文档自己的编辑面**（`.source-editor`、`.ProseMirror`/`.md-preview` 之内）；
  查找栏自己的输入框仍被挡住（在栏里按 Ctrl+F 不该把栏关掉）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**148/148** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **16/16 套件 PASS**（新增 `_verify-find-replace` 12 条） |
| `_verify-md-fidelity.js` | 101 PASS / 0 FAIL / 1 SKIP |

### Docs

- 手册新增 §4.65（结构：一份查询状态两个编辑面、两个只有真跑起来才暴露的坑、交互与验收）。

## [Unreleased · 老套件迁移（一）] — `_regress-*` 全部 + 最有价值的 `_repro-*`

### Changed

- **6 个老套件迁到 `tools/lib/harness.js` + `Reporter` 并纳入矩阵**：`_regress-layout`（9 条）、
  `_regress-cb`（3）、`_regress-divider`（4）、`_regress-fileswitch`（5）、
  `_regress-source-roundtrip`（4）、`_repro-rapidenter`（4，且把断言扩到 **store 正文行**）。
  它们此前全部发红，原因不是产品坏了而是套件自己过期：按**中文按钮文字**找 `.mode-seg-btn`
  （现在是 `role="tablist"` + 三个 `role="tab"`，文案可本地化 ⇒ 换语言就整轮跑不了）。
- `harness.js` 新增三个公共能力：`clickMode(app, 0|1|2)`（**按序号**点模式分段控件，语言无关）、
  `waitRestored()`（等 `.view-restoring` 结束）、`openDocWith(app, md, name)`
  （走 `files.current` + path 变化加载文档 ⇒ 触发 `:key` 重建）。

### Fixed

- **代码块「内容末尾的空行」往返丢失**（迁移中被 `_repro-rapidenter` 的 store 侧断言抓到）：
  CommonMark 里收尾围栏前的换行是「最后一行的行终止符」，不算内容 —— 内容 `a\n` 写成
  `a` + 换行 + 围栏，重新解析回来变成 `a`，**保存一次少一行**。现在内容以换行结尾时，
  收尾围栏前多写一个换行（`lib/editor/codeBlock.ts`）；夹具 `code-fence.md` 补了对应一例。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **15/15 套件 PASS**（从 9 个扩到 15 个） |
| `_verify-md-fidelity.js` | **101 PASS / 0 FAIL / 1 SKIP**（夹具新增「内容末尾带空行」一例） |

### Docs

- 手册新增 §4.64：迁了哪 6 个、为什么按序号点模式控件、迁移本身的两个教训
  （不能直接 `setContent` 加载文档 / 焦点要确认两次）、顺手修掉的保真缺口，
  以及**剩下 83 个脚本的定位表**（回归守卫 / 一次性探针 / 测量基准 / 截图工具 / 尚未迁的老套件）。

## [Unreleased · 工程化收尾（二）] — recent store 拆分 + 嵌套样式渲染断言

### Changed

- **`stores/recent.ts`（新）**：最近文档 / 置顶 / 最近文件夹从 `files` store 整块拆出来。
  这份数据的归属是「用户开过什么」，与「当前工作区 / 当前文档」是两件事（关掉所有文档、
  切换工作区，历史都还在）。`files.ts` 646 → 593 行；调用点（打开文件夹 / 打开文件 / 另存为）
  改为 `useRecentStore()`。
  - 边界：规则仍在 `lib/recent.ts` 纯函数（有单测），store 只负责落盘 + 给 UI 排好序的视图；
    数据仍存 `settings`（SQLite kv），**键名不变 ⇒ 无迁移**，既有套件断言不受影响；
  - `folderList(root)` 由调用方传根目录，**不反过来 import `files` store**（避免循环引用）；
  - 置顶判断给 `pinnedPaths: Set<string>`（列表每行都要问，数组 `includes` 是 O(n²)）。

### Added

- `_verify-md-fidelity.js` 新增 **N 段**：嵌套样式的**计算样式**断言 ——
  加载 `nested-styles.md` 后取 `[data-md-styles~="code"]`，断言标签是 `strong`、
  `data-md-styles` 为 `bold code`、`font-weight ≥ 700`、`font-family` 命中等宽字体。
  这条补的是「CSS 漏了属性选择器时，序列化仍然保真但代码看着不像代码」那个盲区
  （保真套件量不到观感）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **101 PASS / 0 FAIL / 1 SKIP**（102 条断言） |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 复核 | `.md-preview img` 规则只剩一份（重复的那份已删）；主题无独立 CSS 文件（明/暗/羊皮纸都是 `style.css` 里的 CSS 变量），无需同步第二份属性选择器 |

### Docs

- 手册新增 §4.63（recent store 拆分的边界与两个设计细节、渲染断言的动机）；
  `docs/optimization-program.md` 台账更新。

## [Unreleased · Wave 1 收尾（三）] — 图片改成行内节点（Wave 1 缺口清零）

> 最后两个 `lossy` 夹具（`images-inline` / `images-linked`）是同一个结构决策造成的：
> 图片被配成**块级节点**，而 Markdown 的 `![alt](src)` 本来是**行内语法**。

### Changed

- `Image.configure({ inline: true })`：段落中间的图片不再把段落拆成「文字 / 图片 / 文字」三段；
  `[![alt](img)](url)` 的外层链接也能正常挂在图片上（块级节点挂不了 mark，外链整个丢）。
- 删掉自定义的块级图片序列化器（原来为了修「块级图片黏成一行 / 吞掉下一个标题」而补 `closeBlock`）：
  行内之后段落自己负责换行，直接用 tiptap-markdown 的默认实现（alt/括号/引号转义都对齐 prosemirror-markdown）。
- `style.css`：`img` 默认 `display: inline-block` + `vertical-align: middle`，
  `p > img:only-child` 才按块级居中 —— 「独立成段的图片」观感与改之前一致；
  同时删掉文件后部**重复的一份** `.md-preview img`（它位置更靠后，会覆盖行内排版）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **100 PASS / 0 FAIL / 1 SKIP**（101 条；唯一 SKIP 是文档化的「保存补文末换行」字节级行为） |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 夹具分级 | exact **15** / normalized **16** / lossy **0** —— **Wave 1 的 8 个缺口全部清零**（8→6→4→2→0） |

### Docs

- 手册新增 §4.62（为什么图片要改成行内、三处配套调整、验收数字）；`docs/optimization-program.md` 台账更新。

## [Unreleased · Wave 1 收尾（二）] — 表格、行内 HTML、列表编号

> 接上一节，把剩下 6 个 `lossy` 缺口里的 4 个收掉，只剩两个图片缺口。

### Added

- **表格列对齐与单元格转义竖线**：接管 `table` 节点的 markdown 序列化
  （`lib/editor/tableMarkdown.ts`）—— 分隔行按各列表头的 `align` 生成（`:---` / `:---:` / `---:`），
  单元格内容渲染后转义 `|`（不转义会被当成列分隔符，**整行结构被拆坏**）。
  解析侧本来就是对的（markdown-it → 单元格 `align` 属性 → `\|` 解成字面竖线），坏的一直是写回。
  复杂表格（合并单元格/一格多块）仍退回 HTML。纯文本规则抽在 `lib/editor/tableAlign.ts`，6 条单测。
- **行内 / 块级 HTML 原样保留**（`lib/editor/htmlPassthrough.ts`）：`parse.setup` 覆盖 markdown-it 的
  `html_inline` / `html_block` 渲染规则 → 行内包成 `<span data-md-html>` 由 `MdHtml` mark
  （`escape:false`）逐字写回，块级包成 `<pre data-md-htmlblock>` 由 `HtmlBlock` 原子节点原样写回。
  任务列表插件**生成**的复选框 token 按插件写死的 class 名放行（否则任务列表会变成一堆标签文本）。
- 有序任务列表：`taskList` 新增 `ordered` 属性（解析时按 `<ol>`/`<ul>` 标签记住）。

### Changed

- 行内标记模型：**不透明行内内容（行内 HTML、展开态的链接源码）在样式栈物化时原样穿过** ——
  既不参与样式栈，也不打断外层构造（`**加粗里的 <kbd>Ctrl</kbd> 还是加粗**`）。
- 判级器新增规则 19：**有序列表编号按位置重算**（首项编号保留 —— 那是 `<ol start>`，有语义），
  同一个列表里项与项之间的空行不参与比对（松散是整表属性，源码位置保留不下来）。
  这条规则必须幂等，所以有序列表在它眼里不区分 `)` 与 `.`（规则 7 本来就会归一）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **94 PASS / 0 FAIL / 5 SKIP**（99 条断言；新增 T 段表格 2 条、I 段 HTML 3 条） |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 夹具分级 | exact **13** / normalized **16** / lossy **2**（只剩图片两个） |

### Docs

- 手册新增 §4.61（表格为什么坏在写回、HTML 的两个坑、列表编号为什么是「规范化」而不是「缺陷」）；
  `docs/optimization-program.md` 台账更新。

## [Unreleased · Wave 1 收尾（一）] — 嵌套样式与 YAML front matter

> Wave 1 的 8 个 `lossy` 缺口里，这两个是「内容真的坏掉」的那一类：嵌套样式写出 CommonMark
> 下不成立的孤儿标记（渲染成字面星号），front matter 把 YAML 元数据变成正文。

### Added

- **YAML front matter 原样保留**：文档开头的 `---…---` 成为**真实节点**（`lib/editor/frontmatter.ts`）——
  markdown-it block 规则只在第 0 行认领、推自定义 token、渲染成 `<pre data-md-frontmatter>`，
  节点的 `parseHTML` 认领它、序列化把原文逐字写回。判定抽成纯函数 `shared/frontmatter.ts`
  （保守规则：必须有顶层 `key:`，否则 CommonMark 里合法的「分割线夹文字」会被误吃），11 条单测。
  节点是 atom：WYSIWYG 里只读可见，改 YAML 走源码模式。
- 单测 `tests/frontmatter.test.mjs`（11 条）；`_verify-md-fidelity.js` 新增 H 段 4 条端到端断言
  （首节点是 frontmatter 且渲染同样内容 / 编辑正文后 YAML 逐字不变 / 源码模式里 YAML 就在开头 /
  分割线夹文字不被误判）。

### Changed

- **`mdStyle` 的样式从单个值改成集合**（`styles: StyleKind[]`，按 `bold→strike→italic→code` 规范化）：
  PM 里同一种 mark 只能挂一个，`**粗体里的 `行内代码`**` 这种嵌套必须靠集合表达。
  DOM 只渲染**一个**元素（标签取最外样式，全部样式写进 `data-md-styles`），其余样式的外观交给
  CSS 属性选择器 —— 渲染成嵌套标签会让 DOM 回读时后者顶掉前者（样式丢失 + 回写 churn）。
- **标记物化改成按样式栈开关**（新的 `materializeStyledRun()`）：相邻两段取样式集合的公共前缀保持不动、
  只开关差集，于是标记天然嵌套；单一样式时退化成原来的「两边各一对」，既有行为不变。
  找配对标记的扫描改成**深度计数**，否则外层 `**` 会在内层 `` ` `` 处误判「缺 end」而把构造劈成两半
  （这正是旧写法把 `**粗体里的 `代码`**` 写成 `**粗体里的 **`代码`** …**` 的那一步）。
- `CodeQuiet` 放开 `excludes: '_'`：上行默认让行内代码**排斥一切 mark**，解析时会把外层粗体丢掉，
  嵌套样式在一开始就少一半。
- 工具栏/气泡菜单的样式激活态改用 `selectionHasMdStyle()`（按集合判断，而不是属性相等）；
  粘贴去粗体只从集合里摘掉 `bold`，保留行内代码等其余样式。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**131/131** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `_verify-md-fidelity.js` | **81 PASS / 0 FAIL / 13 SKIP** |
| `node tools/run-suites.js` | **9/9 套件 PASS** |
| 夹具分级 | exact **11** / normalized **14** / lossy **6**（本轮前 9/14/8） |

### Docs

- 手册新增 §4.60（两个缺口的改法、取舍与验收；含「为什么不能渲染成嵌套标签」这类踩坑记录）；
  `docs/optimization-program.md` 台账与 Wave 1 收尾小节更新。

## [Unreleased · Wave 3.2] — 编辑面 ⇄ 真源的单向数据流账本

> 正文有三个能改它的编辑面（Tiptap 面板 / 源码 textarea / 代码块里的 CodeMirror），
> 加上「打开文件 / 恢复草稿 / 切编码 / 载入历史」四类整篇替换 —— 此前四条通道各自发明了
> 「这次变化要不要跟着更新」的判断（比字符串、600ms 静默窗、150ms 快照相等），
> 于是有一批看着像玄学的 bug：**快速回车丢字、切回原编码后正文不刷新、分屏里停顿后的更新被吞掉**。

### Added

- **`src/renderer/src/lib/contentSync.ts`**：真源内容的 **世代号 `rev` + 作者 `author` + 各命令式编辑面
  `applied`**。谁改内容谁自增世代并署名；编辑面要不要重渲染只问一句「我落后了吗」——
  **不比较字符串、不看时间窗**。纯函数，`tests/contentSync.test.mjs` 9 条断言直接覆盖。
- 代码块 CodeMirror 成为一等编辑面：写内容时 `editorStore.noteWrite('codeblock')` 挂牌，
  序列化落库时消费成账本作者；它同时是 Tiptap 文档的**子编辑面**，所以这次写入会连宿主一起
  标记为最新（否则宿主把 md 回灌进文档，光标会被踢出代码块）。

### Changed

- **Tiptap 面板**：同步判断从 `syncedMd === content` + `files.syncEpoch` 改为
  `files.contentIsStale('wysiwyg')`；分屏下源码面逐键输入时仍合并 200ms 重解析，
  但那只是**渲染节流**，不再是一条独立的同步通道。
- **代码块 CodeMirror 的外部同步**：从「150ms 防抖 + 节点文本快照相等就跳过」改成三条结构性规则 ——
  **触发时重新读节点文本**（不用 watch 队列里的过期快照）、文本一致就不动、
  **CM 拿着光标时绝不覆盖**（再等一轮，失焦后对齐）。旧写法在快照过期时会把 CM 状态回滚，是丢字的根因之一。
- 整篇替换（`setContent(..., 'external')` / `noteExternalReplace()`）**不动任何 `applied`** ⇒
  所有编辑面都落后 ⇒ 文本恰好相同也要重渲染一次，修掉「切回原编码时状态栏变了、正文不动」。
- **回灌时内容从 store 现读，不再读 `props.modelValue`**：Vue 的 `watch` 跑在渲染之前，
  props 是父组件上一次渲染传来的 —— 读它会拿到上一代内容，把编辑器灌成旧文本；
  而那次 `setContent` 会触发 md 标记归一化再产生一次事务 → `onUpdate` → 防抖 flush 把旧文本
  写回 store，**源码面刚敲的那行就没了**（整轮矩阵里偶发、单跑不复现的那次失败）。
  代码块 CodeMirror 同侧也改成按 pos 现读 PM 文档（`props.node.textContent` 同样可能落后一拍）。

### Removed

- `files.syncEpoch`（= 账本的 `rev`，且账本还知道是谁写的）与 `editorStore.syncedMd`
  （= 字符串版本的 `applied.wysiwyg`）。
- `EditorView` 里那条 200ms 的 `scheduleSplitSync` 第二条同步通道，以及切模式时的
  `syncEditorContent()` 字符串比较 —— 三个编辑面现在共用同一个账本。

### Fixed（工具链）

- **77 个 CDP 套件不再按 `Symbol(pinia)` 的 symbol 描述取 store**：改成按结构认
  （`prov[s]` 是对象且 `_s instanceof Map`），页面识别也不再写死 `5173`。
  生产构建会压掉 symbol 描述，旧写法等于「同一套件在 dev 与构建产物下行为不同」。
  A/B 实测：19 个原本没有结构兜底的套件里 **13 个在构建产物上直接崩
  （`TypeError: Cannot read properties of null (reading '_s')`）→ 0 个崩**，其中 4 个从「崩」变成端到端跑通。
- `tools/_regress-split-live.js` 迁到 `tools/lib/harness.js` + `Reporter`，并修好旧选择器
  （`.mode-seg-btn` → 工具栏那个 `role="tab"` 分段控件），现在进默认矩阵。
- `tools/_verify-session.js` 改设置后**等它真落库**（`settings.getAll()` 轮询）再 `Page.reload`：
  原来固定 `sleep 600ms`，机器忙时主进程读到的还是旧值，表现为偶发的
  「关了会话恢复却仍恢复出文档」（整轮矩阵里红、单跑绿）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**120/120** 单测） |
| `npx eslint .` | **0 error / 0 warning** |
| `node tools/run-suites.js` | **9/9 套件 PASS**（新增 `_regress-split-live`：分屏双向同步 8 条） |
| `tools/_verify-wave3.js` | A 段 9 条（账本作者 / 落后判定 / 代码块作者标记 / 整篇替换） |

### Docs

- 手册新增 §4.59（账本协议、四个编辑面的角色、老套件迁移的 A/B 数字，以及一次真实文件事故的恢复办法）；
  `docs/optimization-program.md` 台账与 Wave 3.2 小节更新；README 开发约定新增「不要用 PowerShell 做源码字符串手术」。

## [Unreleased · Wave 2 尾巴] — 多窗口元数据一致性与历史保留策略可配

> Wave 2 当时留了两条尾巴：两个窗口打开同一文件时元数据可能各说各话；本地历史的保留策略写死在代码里。

### Changed

- **编码优先级：显式指定 > 每文件记录 > 全局默认**（`file:read` 增加 `opts.softDefault`）。
  * 「选择编码重新打开」等**显式**动作照旧压过一切（用户刚点的必须听）；
  * 「打开文件时的设置默认值」是**软默认**：该文件有记录时让位给记录 ——
    用户上次手选的 GBK、或自动判定出的非 UTF-8 都记在 `documents.encoding` 里，
    于是第二个窗口（哪怕它的「默认编码」设置不同）打开同一文件会解出同一份内容，
    改了全局默认也不会把老文件解成乱码。
  * 没有记录时才用设置里的默认编码；`_verify-encoding.js` 的两条断言按新优先级拆成
    「记录优先」与「无记录时默认编码生效」两件事（顺带修好该套件里「显式试读污染记录」的测试顺序问题）。
- **本地历史保留策略进设置**：新增 `historyEnabled` / `historyLimitPerFile` / `historyMaxAgeDays`
  三个设置项（默认开、30 条 / 30 天），主进程在写快照与抽稀时从设置读取；关掉后不再新增快照，
  已有历史仍可查看/回滚。设置面板「通用」页新增一组带开关与两档下拉的项，三语同步（388 键）。
- `tsconfig.node.json` 也开 `allowImportingTsExtensions`（`shared/defaults.ts` 现在会被单测加载，
  它的相对导入按 §4.56 的约定写显式 `.ts`）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（111/111 单测） |
| `node tools/run-suites.js` | 8/8 套件 PASS |
| `tools/_verify-md-fidelity.js` | **73 PASS / 0 FAIL / 17 SKIP**（90 条断言；新增元数据 4 条 + 历史策略 2 条） |

新增断言（都在真实窗口里跑）：窗口 A 用 auto 打开 GBK 文件并落库 → 窗口 B 打开同一文件时
**编码与行尾都与库记录一致**；窗口 B 把「默认编码」改成 windows-1252 后重开，**每文件记录仍然优先**；
关掉历史后连存两次**不再写快照**；上限设为 2 后连存 4 次**恰好剩 2 条**（最新的两条）。

## [Unreleased · 反斜杠转义保留] — Wave 1 头号缺口

> Wave 1 留下的第一号缺口：`\*` 被 markdown-it 的 escape 规则**吃掉**反斜杠，于是
> 「字面星号」往返后变成「斜体标记」—— 语义变了，而信息在解析那一刻就丢了，后面补不回来。

### Added

- **`MdEscape` mark + markdown-it escape 规则替换**（`parse.setup` 钩子，与列表标记保留同一套机制）：
  转义字符渲染成 `<span data-md-escape>\X</span>`，再由 `escape:false` 的 mark **逐字写回**。
  规则照抄上游的三种分支（`\`+换行=硬换行 / `\`+空格=字面反斜杠 / 其余保留 `\X`）——
  漏掉第一种会让「反斜杠硬换行」退化成「字面反斜杠 + 软换行」，整段被并成一行（实测夹具立刻变红）。
- 夹具 `escapes.md` 扩到 6 个边界：非标点反斜杠（`C:\temp`）、`\`+空格、`\`+emoji（代理对）、
  反斜杠硬换行、与粗体/行内代码/链接混排。
- 新夹具 `nested-styles.md` 记录一个**结构性**已知缺口：标记模型是「扁平的」（一个 `mdStyle`
  只能带一个 style 值），所以「粗体里套行内代码/链接」这类嵌套样式表达不出来。

### Fixed

- **`\*`/`\_`/`\#`/`\---`/`\[`/`\\` 现在原样往返**（`escapes.md` 从「已知缺口 lossy」升级为 **exact**）；
  `$$` 公式块里的反斜杠也不再被补成 `\\`（`math.md` 从 lossy 升到 normalized）。
- **孤儿标记字符不再漂移**：`$a * b$` 里那个不成对的 `*` 此前会被写出器补成 `\*`（源码漂移），
  因为「包成字面量标记」那条路径只对**成对**的标记生效（`PATTERN_TEST`）。现在不成对的也走同一条路。
- **转义文本在样式构造里的位置**：`**粗体里的 \* 星号**` 曾被打散成两个 `**…**` 构造
  （输出 `****\*****`）—— 原因是转义文本被当成「其它节点」切断了同样式连续段。
  现在它作为**带样式的 verbatim 文本**参与构造，只是不参与标记派生。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0 |
| `npm run test:unit` | 110/110 |
| `tools/_verify-md-fidelity.js` | **67 PASS / 0 FAIL / 17 SKIP**（31 份夹具；exact 9 / normalized 14 / lossy 8，lossy 全部有 why 与修法） |
| `node tools/run-suites.js` | 8/8 套件 PASS |

## [Unreleased · 工程化收口] — store 拆分与对话框收敛

> 整改方案的最后两项工程债：`files` store 一份承担四件事、`confirmIfDirty` 抄了四份。

### Changed

- **`files` store 瘦身**（703 → 535 行，且抽出来的规则都有单测）：
  * **派生缓存拆成独立 store** `stores/workspaceDocs.ts`：「列表视图」的文章扫描结果与失效世代
    和「当前文档 + 文件树」的生命周期完全不同（它只有一个消费者 `FileList.vue`），拆开后各自演进；
    files store 只在结构变化/保存时调用 `invalidate()` / `bumpMtime()`（单向依赖）。
  * **规则抽成纯函数模块**：`lib/recent.ts`（最近文档/文件夹/置顶的去重·置顶·截断·并入当前工作区）、
    `lib/draftRules.ts`（草稿键与「值不值得端给用户」判定 —— 这块出过三次真 bug）、
    `lib/docText.ts`（未命名文档的编码/行尾、编码显示名、历史时间格式）。
    store 里对应的 action 变成一行「算好 → 落盘」。
  * 单测补 `tests/filesRules.test.mjs`（9 条）。「会被 node --test 加载」的模块改用显式 `.ts` 扩展名
    （Node 的 ESM 解析不做扩展名补全），tsconfig 相应开 `allowImportingTsExtensions`。
- **未保存更改确认收敛成一份**：新增 `lib/dialog.ts`（`confirmDiscardChanges` / `confirmDiscardIfDirty`），
  原先四处各写一遍的 `ui.confirm({ title: t('editor.dirtyConfirmTitle'), ... })`
  （`useAppActions`、`stores/files.ts`、`TreeNode.vue`、`FileList.vue`）全部改为调用它。
  关键设计：该模块**只依赖 ui store 与 i18n**，「脏不脏」由调用方作为参数传入 ——
  于是 store 也能用，不再需要「为绕循环导入复制一份」（那正是当初抄四遍的原因）。
  * 命名说明：整改方案写的是 `services/dialog`，但本仓库的 `services/` 是**主进程**约定，
    渲染层没有这一层，故落在 `lib/dialog.ts`（与 `lib/errors.ts` 同级）。
- `tools/run-suites.js` 头部补一条踩坑说明：**跑套件时不要同时 `npm run build`**
  （实例加载 `out/`，边跑边构建会让它读到半截产物，表现为随机的两三条断言失败）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **110/110**（101 → 110） |
| `npm run ci` | exit 0 |
| `node tools/run-suites.js` | **8/8 套件 PASS** |
| `tools/_verify-md-fidelity.js` | 63 PASS / 0 FAIL / 19 SKIP |
| `tools/_verify-wave3.js` | 19/19 PASS |

## [Unreleased · Wave 3] — 显式意图同步 / 文件树键盘可达 / 原生菜单三语

> Wave 3 是「内核收敛 + 可访问性 + 打磨小刺」。三条都是**删掉猜、改成明说**：
> 编辑器同步不再靠两条会漏判的启发式；文件树不再是"只能用鼠标"；非中文用户按 Alt 不再看到一屏中文。

### Changed

- **编辑器 ⇄ store：显式意图状态机取代两条回声启发式**（手册 §4.54）：
  * 旧写法靠「刚 emit 过的内容相等」+「距 emit < 600ms」猜「这次变化是不是自己的回声」，
    两处明确漏判：按原编码切回来时内容恰好相等 → 被当成回声丢掉（状态栏变、正文不变）；
    刚打完字就恢复草稿/切编码 → 落在静默窗里被丢掉。
  * 现在 **store 明确表态**：凡是要编辑器换内容的动作都自增 `files.syncEpoch`
    （打开文件 / 恢复草稿 / 重新解释编码 / 载入历史）。编辑器只看世代是否变化：
    变了就按新内容 `setContent`，没变就不动编辑器 —— 既不回滚文档、也不重置光标。
  * 顺带去掉每次 modelValue 变化都做**整篇字符串比较**的开销（旧实现的第一条过滤）。

### Added

- **文件树键盘可达（ARIA tree + roving tabindex）**：`role="tree"`/`treeitem`、`aria-expanded`、
  `aria-selected`、`aria-level`、单一可 Tab 行（空闲时也有落点）；`↑/↓` 移动、`→` 展开（已展开则进第一个子项）、
  `←` 收起（已收起则回父项）、`Home/End` 首尾、`Enter/Space` 打开。
  实现放 `lib/treeFocus.ts`（递归组件里用 DOM 顺序当 ARIA 遍历顺序；子项是异步加载的，进子项用轮询而不是单次 tick）。
  键盘焦点有可见描边（`:focus-visible`，鼠标点击不出现）。
- **原生菜单三语**：语言包移到 `src/shared/i18n/`（主进程与渲染层**共用一份**），`main/menu.ts` 全部标签走
  语言包（不再硬编码中文），并在 `settings:update` 里语言变化时**立即重建**菜单；
  加一行 ASCII 自检日志 `[menu] rebuilt lang=… top=…` 供验收脚本读。
- 单测 `tests/menu.test.mjs`（静态自检：菜单里没有硬编码中文、`T()` 的 key 在三份语言包都存在、
  顶层菜单带助记符、三份键集合一致）—— 这条**当场抓出** 4 个漏翻的键（剪切/复制/粘贴/全选）。
- 验收套件 `tools/_verify-wave3.js`（19 条）：意图同步 5 条、文件树键盘 11 条、原生菜单 2 条、工作区夹具 1 条。

### Fixed

- `menu.cut/copy/paste/selectAll` 四个键在语言包里根本不存在（原生菜单会显示英文 key）——
  由新增的静态自检发现并补齐。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **101/101**（97 → 101） |
| `npm run ci` | exit 0 |
| `tools/_verify-wave3.js` | **19/19 PASS** |
| `tools/_verify-md-fidelity.js` | 63 PASS / 0 FAIL / 19 SKIP |
| `node tools/run-suites.js` | **8/8 套件 PASS**（session-last-closed 8/8、md-fidelity 63/82、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 33/33、wave3 19/19） |

### 仍待办

- 工程化：`files` store 拆分（现在 ~700 行）、`confirmIfDirty` 收敛到 `services/dialog`。
- 其余评审缺口：多窗口元数据一致性、历史保留策略可配、Wave 1 的反斜杠转义保留（钩子方案已验证）。
- 仍有约 40 个老套件按 `Symbol(pinia)` 名字取 store（生产构建下会失败），按「改到谁就顺手迁谁」继续收口。

## [Unreleased · Wave 2] — 文档级元数据（编码 / 行尾 / BOM）与本地历史

> Wave 1 之后，评审报告的第二波是「文档级元数据没有模型」这一个根因下的三件事：
> 编码只活在这一进程的 `current` 上、EOL 根本没人管、保存成功即清草稿（一次误保存无法挽回）。
> 本波把它们收进 `documents` 表与一条**写盘前的快照链**。

### Added

- **`src/shared/eol.ts`（纯函数 + 单测）**：`detectEol`（按多数行尾判定）、`toLf`、`toEol`、`hasUniformEol`。
  约定：**内存里的文本永远是 LF**，行尾是文档属性，落盘时才展开 —— 只有一个真相，
  编辑器怎么改都不会污染行尾。
- **文档级元数据落库**：`documents` 表新增 `encoding` / `eol` / `had_bom` 三列并写**迁移**
  （`PRAGMA table_info` + `ALTER TABLE`，与 notifications 的加列方式一致）。
- **老 `fileEncodings` kv 表的一次性迁移**：能对上 `documents` 行的条目搬进表，
  剩下的留在 kv 兜底（文件还没进索引时仍可用），迁完打标记不重复扫。
- **本地历史（数据安全）**：新表 `documents_history` + `shared/history.ts` 的**抽稀策略（纯函数 + 单测）**：
  每文件最多 30 条、超过 30 天且不是该文件最新 3 条就丢、全库封顶 2000 条。
  快照取自**磁盘上现有的字节**（即将被覆盖的那一版），在主进程 `file:write` 里统一记录 ——
  所有写盘路径（保存/另存为/以后的回滚写回）都自动有历史，不依赖调用方记得调用。
- **本地历史界面**：`LocalHistoryDialog.vue` + 文件菜单「本地历史…」+ `window.luminAPI.history`。
  语义是**载入缓冲、不直接写盘**：用户看清了再 Ctrl+S（选错版本也不会毁文件）。
- 文件菜单新增「行尾」二级（以 LF / CRLF 保存）与「以编码保存」二级；状态栏新增**可点的行尾标记**；
  设置面板新增「默认行尾」（只影响新建/未命名文档）。
- 三语新增 11 个键（`statusbar.eolTooltip`、`menu.saveWithEol/eolLf/eolCrlf/saveWithEncoding/localHistory`、
  `settings.defaultEol/defaultEolHint`、`history.*`、`toast.eolChanged/savedWithEncoding/historyRestored/historyNeedsFile`），
  三份语言包键集合保持一致（377 键）。

### Fixed

- **CRLF 文件「打开→动一下→保存」被整文件改成 LF**（git 里就是整文件 diff）：
  现在打开时判定行尾、写回时还原。`_verify-md-fidelity.js` 的 crlf 字节级用例从「已知缺口」变成 PASS。
- **二级菜单可能超出视口，最后几项点不到**：菜单项变多后（本波在文件菜单里加了三项），
  「选择编码重新打开」那 14 项会有一部分渲染到窗口外面。现在二级浮层按「到窗口底部还剩多少」钳高并内部滚动
  （套件新增 `submenu-clamped-to-viewport` / `submenu-item-clickable` 两条断言盯着）。
- `DocMeta` 曾经有两份定义（`shared/types.ts` 与 `main/services/database.ts`），
  现在只保留 shared 那份并再导出，避免同名接口各自漂移。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **97/97**（86 → 97：新增行尾 6 条 + 历史策略 5 条） |
| `npm run ci` | exit 0 |
| `tools/_verify-md-fidelity.js` | **63 PASS / 0 FAIL / 19 SKIP**（82 条断言；新增行尾 6 条 + 历史 6 条，crlf 缺口转 PASS） |
| `node tools/run-suites.js` | **7/7 套件 PASS**（exit 0）：session-last-closed 8/8、md-fidelity 63/82（0 FAIL）、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 33/33 |

### 仍待办（Wave 2 剩余 + Wave 3）

- Wave 2 剩余：状态栏 EOL 与编码的**多窗口一致**（同一文件两个窗口读到同一元数据，已有库表基础，
  还差「打开时以库为准」的取舍）；本地历史的**设置面板开关与保留策略可配**。
- Wave 3：编辑器 ⇄ store 显式意图状态机；文件树键盘可达；主进程菜单三语化。
- 工程化：`files` store 拆分；`confirmIfDirty` 收敛到 `services/dialog`。

## [Unreleased · Wave 1] — Markdown 往返保真

> 上一轮把「Wave 1：Markdown 往返保真套件」列为第一优先，理由是它是**写作工具的信誉底线**：
> 用户打开一份 `.md`、动一下、保存 —— 文件不该变，内容更不该被吃掉。
> 本轮把它做成可复跑的数字，并在过程中查实并修掉了 **7 类内容损坏缺陷**。
> 完整的原理、判级规则、踩坑与已知缺口见手册 §4.52。

### Added

- **判级器** `tools/lib/md-fidelity.js`（纯函数、零依赖）：`exact` / `normalized` / `lossy` 三档，
  规范化只收 18 条「CommonMark 语义上站得住脚」的保义改写（`RULES` 导出，文档可直接引用），
  并给出「规范化到底改了什么」与逐行差异说明。
- **夹具库** `tools/fixtures/md/`：**30 份** Markdown 夹具 + `EXPECT.json` 预期表。
  `EXPECT.json` 即契约：`lossy` 必须写清**为什么**与**修法**（没有 why 的 lossy 等于把缺陷藏进预期）。
- **验收套件** `tools/_verify-md-fidelity.js`：文档级往返（走应用**自己的落盘管线**：
  `TyporaEditor.flushSync`，用 `beforeunload` 同步触发）+ 幂等回归 + 字节级真开真存
  （CRLF / UTF-8 BOM / GB18030 / 文末无换行）；逐份原文与产出落 `%TEMP%\lumin-md-fidelity-report.json`。
- **CDP 公共骨架** `tools/lib/harness.js`：连页面、注入 pinia 访问器（**按结构找**，不按
  `Symbol(pinia)` 名字找 —— 生产构建会压掉 symbol 描述）、键鼠模拟、`--- N/M PASS` 结果汇总。
- **套件统一入口** `tools/run-suites.js`：逐个套件起**全新隔离实例**（套件会改设置/写草稿/动 kv，
  串着跑必然互相污染）、自动带上 `LUMIN_DB`/`LUMIN_DRAFTS_DIR`、汇总矩阵、有 FAIL 非零退出。
- **纯函数** `src/shared/documentText.ts`：文档文本收尾规则与代码围栏长度。
- 单测 `tests/md-fidelity.test.mjs`（判级器自身：每条规则一个同义改写用例 + 反例 + 幂等）、
  `tests/documentText.test.mjs`。

### Fixed（内容损坏类，全部由新套件查实）

- **代码块里出现成对反引号时，一次编辑后整段代码并成一行**：标记模型的「源码权威重推」把
  `codeBlock` 当普通段落（PM 里 `isTextblock` 对代码块也为真），拿代码文本再喂 markdown-it，
  而重推走的 DOMParser 不保留空白 → 换行全塌成空格。现在逐字块（`spec.code`）排除在归一化之外。
- **行内代码里的反斜杠每保存一次多一层**（非幂等增长）：`mdStyle(code)` 正文没有 `escape:false`
  保护。新增 `mdCodeLiteral` mark（空包裹 + `escape:false`）贴在代码样式正文上。
- **软换行被写成行尾 `\`**：`breaks: true` 让 markdown-it 把段内换行渲染成 `<br>` → hardBreak → `\`。
  改为 `breaks: false`（语义从「强制换行」回到「软换行 ≡ 空格」）。
- **无序列表标记被抹平**（`*`/`+` → `-`）、**相邻两个列表之间被插两个空行** → 再解析并成一个
  松散列表，每次保存都在漂。现在解析时记录标记（`parse.setup` 钩子给 `<ul>` 打 `data-bullet`）、
  序列化写回原标记，标记不同时只断行不插空行。
- **任务列表每个任务项之间被塞空行**（`tight` 属性只挂在 bulletList/orderedList 上）；
  `1. [ ] x` 变成「空的有序项 + 无序任务列表」（`ol` 形态没有 parse 规则）。
- **相邻图片被粘成一行、图片后紧跟的标题被吞进同一段**：块级 Image 用了行内序列化器。补 `closeBlock`。
- **内容里含 ``` 的代码块围栏被提前闭合**（后面正文被解析成代码）：围栏长度按内容自适应。
- **序列化产出不含文末换行**：文档文本收尾规则 `withFinalNewline()`，收在
  `markdownStorage.getMarkdown()`（编辑器内容 → 文档文本的唯一出口）。

### Changed

- 编辑器扩展集 `breaks: false`；新增 `listMarkers.ts`（列表标记/紧松）、`markdownTypes.ts`（序列化类型声明）；
  `MdCodeLiteral` 注册位置紧贴 `MdStyle`（最内层 mark 才生效）。
- `tools/_isolated-instance.ps1` → **`tools/start-isolated.ps1`**（标准入口，退出码化、端口判定改 TCP、
  按 8.3 短路径正确杀旧实例、日志按数据目录分文件、必须存 UTF-8 with BOM）。

### Verification（本轮实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **81/81**（57 → 81） |
| `npm run ci` | exit 0 |
| `tools/_verify-md-fidelity.js` | **50 PASS / 0 FAIL / 20 SKIP**（30 夹具；SKIP = `EXPECT.json` 里写了修法的已知缺口） |
| `node tools/run-suites.js` | **7/7 套件 PASS**（exit 0）：session-last-closed 8/8、md-fidelity 50/70（0 FAIL）、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 31/31 |

### 已知缺口（`EXPECT.json` 逐条写了修法，Wave 2 的起点）

反斜杠转义保留（`\*`）、行内 HTML、表格列对齐 + 单元格转义竖线、公式（应用**没有数学节点**）、
链接包裹的图片、段落中间的图片、有序任务列表编号、YAML front matter、
CommonMark 同标记相邻列表的重编号、CRLF 与文末无换行（字节级）。

## [历史主题汇总] — 1.0.0 之前

> 详细内容见 `docs/typora-wysiwyg-manual.md` 的 §4.x 各节。

- **编辑器内核**：Tiptap v3 + `tiptap-markdown` 装配、光标感知标记符（块级 Decoration / 行内 DOM 类）、
  代码块 CodeMirror NodeView、Mermaid 渲染、表格与任务列表、气泡菜单与工具栏、大纲联动。
- **数据层**：SQLite（`node:sqlite`）+ FTS5 trigram 全文索引 + 全局搜索；自动保存与崩溃草稿；
  会话槽位恢复（关窗 / 重启 / 多窗口）；最近文档与最近文件夹。
- **多窗口模型**：一窗口一文档、「一个文件只开一个窗口」、窗口作用域隔离通知、会话槽位身份。
- **编码**：判定链 + 每文件记忆 + 按编码读写 + 「选择编码重新打开」（含显式替换的强制同步）。
- **Windows 集成**：AppUserModelID、开始菜单快捷方式、任务栏跳转列表、内容寻址的运行期图标。
- **打包与发布**：electron-builder / NSIS 安装器、文件关联、卸载清理、安装实测报告。
- **界面**：三主题、三语言、侧栏三种视图、分段控件、左缘展开把手、设置面板与快捷键系统。
