# 整改台账 · 已完成部分

> 从 `docs/optimization-program.md` 拆出（清单 §2.H：台账里已完成项不该和「接下来做什么」挤在一起）。
> 下面是 Wave 1 – Wave 3.2 以及后续各轮的**已完成记录**，逐字节搬运；主台账只留现状台账、Wave 4/5、需要拍板与不建议做的。

---

## Wave 1：Markdown 往返保真（信誉底线，必须先做）—— ✅ 本轮完成

**为什么第一**：产品承诺「所见即所得且不破坏源文件」，但仓库里**没有**任何「刁钻 Markdown → 解析 → 序列化 → 差异」的验收。
任何语法被静默改写都是**无声丢内容**；而在没有这条指标之前，动编辑器内核（Wave 3）等于闭着眼睛改。

**实际交付**（与计划的差异都记在这里）：

- 语料落在 `tools/fixtures/md/*.md`（**30 份**）+ **`EXPECT.json` 预期表**（原计划是 `md-fidelity/*.md`；
  多出的预期表是关键新增：`lossy` 必须写明「为什么」与「修法」，否则等于把缺陷藏进预期里）。
- 套件 `tools/_verify-md-fidelity.js`：三层 —— 文档级（走应用自己的落盘管线 `flushSync`）、幂等、字节级
  （CRLF/BOM/GB18030/文末无换行）。逐份结果落 `%TEMP%\lumin-md-fidelity-report.json`。
- 判定三档照计划：`exact` / `normalized` / `lossy`；规范化收了 18 条**保义改写**规则（`RULES` 导出），
  而不是把「像」的东西都算通过。
- **风险项改了**：计划里写「本轮不改产品代码」，实际查实了 **7 类内容损坏缺陷**（代码块换行被并、
  行内代码反斜杠非幂等增长、软换行写成 `\`、列表标记被抹平且相邻列表被插空行、任务列表被拆散、
  图片粘行与吞标题、围栏被内容提前闭合），全部修掉并把每条写成单测/夹具。
  理由：这些是「用户会丢内容」的缺陷，只报告不修等于明知有洞不补。
- **验收数字**：`_verify-md-fidelity.js` = **50 PASS / 0 FAIL / 20 SKIP**（SKIP 全部是 `EXPECT.json` 里
  写了修法的已知缺口）；单测 57 → **81**；`node tools/run-suites.js` 矩阵见 CHANGELOG。

## Wave 2：文件级元数据模型 + EOL + 以编码保存 + 本地历史
- **加一条幂等性回归**：每个夹具连做两轮往返，第二轮必须与第一轮完全一致 —— 不幂等等于用户每次保存都在改文件。
- **验收**：夹具总数、三档各自计数、幂等通过率、每条 LOSSY 的**最小复现片段**（原文 vs 往返）。
- **风险**：本轮**不改产品代码**，只出报告与修复建议，改法单独拍板。

## Wave 2：文件级元数据模型 + EOL + 以编码保存 + 本地历史 —— ✅ 本轮完成（两处剩余见下）

**为什么排第二**：这三件事是同一个根 ——「文档级元数据没有模型」。现在编码挂在 `current` 上、再配一张 kv 里的
`fileEncodings` 表（我上一轮为省迁移而选的临时方案），EOL/缩进/BOM 各写各的 → 两个窗口开同一文件会**各说各话**，
重启又会忘。把它一次做对，能同时消掉三类 bug。

**实际交付**（与计划的差异记在这里，细节与踩坑见手册 §4.53）：

- **DB**：`documents` 表加 `encoding` / `eol` / `had_bom` 三列 + 迁移（`PRAGMA table_info` + `ALTER TABLE`）；
  老的 kv `fileEncodings` 做**一次性迁移**（能对上 documents 行的搬进去，对不上的留 kv 兜底）。
  计划里的 `documents_history` 也落地了。
- **行尾**：计划写的是「主进程 `services/eol.ts`」，实际放在 **`src/shared/eol.ts`（纯函数）** ——
  这样能被 `node --test` 直接覆盖；服务层只负责「打开时判定 + 写盘时展开」（`fileOps.readFileInfo/writeFile`）。
  约定：**内存里文本永远是 LF**，行尾是文档属性。
- **UI**：状态栏行尾标记**可点**（LF ⇄ CRLF 且立即写回）；文件菜单加「行尾」（以 LF/CRLF 保存）与
  「以编码保存」两个二级；设置面板加「默认行尾」；三语同步。
- **本地历史**：快照取自**磁盘上现有的字节**（在主进程 `file:write` 里统一记录，所有写盘路径自动覆盖）；
  抽稀策略是纯函数（每文件 30 条 / 30 天 / 全库 2000 条，每文件最新几条不受年龄限制）；
  回滚语义是**载入缓冲、不直接写盘**（选错版本不会毁文件）。
- **验收数字**：单测 97/97；`_verify-md-fidelity.js` 63 PASS / 0 FAIL / 19 SKIP；
  `node tools/run-suites.js` 7/7 套件 PASS。行尾与历史各有 6 条端到端断言。

**Wave 2 剩余（下一轮）**：

1. **多窗口一致性**：两个窗口开同一文件时，编码/行尾以库为准（库表已就位，还差「打开时优先用库里的元数据」
   这一步取舍与套件）。
2. **历史保留策略可配**：设置面板开关 + 保留天数/条数（当前是常量 + 纯函数策略）。
3. 顺带：Wave 1 留下的第一号缺口「反斜杠转义保留」（钩子方案已验证可用）。

> **Wave 1 留给本波的已知缺口**（`tools/fixtures/md/EXPECT.json` 里逐条写了修法）：
> CRLF 与文末无换行（字节级）、反斜杠转义保留（`\*`）、行内 HTML、表格列对齐与单元格转义竖线、
> 公式（应用**没有数学节点**，`$$` 里的反斜杠会被补成 `\\`）、链接包裹的图片、段落中间的图片、
> 有序任务列表编号、YAML front matter、CommonMark 同标记相邻列表的重编号。
> 其中「反斜杠转义保留」的修法已经验证过钩子可用（`parse.setup` 替换 markdown-it 的 inline escape 规则
> + `escape:false` 的 mark），可以优先做。

## Wave 3：内核收敛 + 可访问性 + 打磨小刺 —— 3.1 / 3.3 / 3.4（菜单三语）本轮完成

**为什么排第三**：Wave 1 已有保真门槛，这时候动内核才安全。

**实际交付**（与计划的差异记在这里，细节见手册 §4.54）：

- **3.1 编辑器 ⇄ store 显式意图状态机** ✅：契约是「**凡是要编辑器换内容的动作都自增 `files.syncEpoch`**」
  （打开文件 / 恢复草稿 / 重新解释编码 / 载入历史）。编辑器只判断世代是否变化：变了就 `setContent`，
  没变就不动它。两条启发式（内容相等 + 600ms 静默窗）连同 `lastEmitted`/`lastEmitTime` 一起删除，
  也顺带免掉每次 modelValue 变化的整篇字符串比较。
  计划里写的 `open / reload / reopenWithEncoding / draftRestore / modeSwitch / userInput` 六种意图，
  实际收敛成**一个世代号**（`modeSwitch` 走既有的 `syncEditorContent` 单向路径）——
  能用一个数字说清的事不必上状态机。
- **3.2 三处真相源收敛** ❌ 未做（WYSIWYG / 源码 textarea / 代码块 CodeMirror）：本波只动了 store→编辑器
  那一条通道；模式切换仍走既有的「常驻 DOM + 显式同步」。留作下一轮。
- **3.3 文件树键盘可达** ✅：`role="tree"`/`treeitem`、`aria-expanded`/`aria-selected`/`aria-level`、
  roving tabindex（空闲时也有落点）、`↑↓ ←→ Home/End Enter/Space`，实现见 `lib/treeFocus.ts`。
- **3.4 打磨小刺**（部分）✅：原生菜单接三语（语言包移到 `shared/i18n` 与渲染层共用，换语言立即重建，
  并加静态自检单测）；状态栏编码/EOL 可点（上一波）；错误提示带原因（第一波已做）。
  剩余：`lumin-file://` 的 `webPreferences.sandbox` 显式化、`build/entitlements.mac.plist` 模板残留标注。
- **验收**：新增 `tools/_verify-wave3.js`（19 条：意图同步 5 + 文件树 11 + 原生菜单 2 + 夹具 1）；
  `node tools/run-suites.js` **8/8 套件 PASS**；单测 101/101。

**下一轮起点**：3.2 三处真相源收敛；工程化（`files` store 拆分、`confirmIfDirty` 收敛）；
多窗口元数据一致性；Wave 1 的反斜杠转义保留。

## Wave 3.2：编辑面 ⇄ 真源的单向数据流账本 —— ✅ 本轮完成（2026-09-16 第八轮）

**为什么必须做**：正文有三个能改它的编辑面（Tiptap 面板 / 源码 textarea / 代码块里的 CodeMirror），
当时它们各自发明了一套「这次变化要不要跟着更新」的判断 —— 四条通道、三种启发式（比字符串、
600ms 静默窗、150ms 快照相等），于是有一批「看着像玄学」的 bug：快速回车丢字、切回原编码后正文不刷新、
分屏里停顿后的更新被静默窗吞掉。根因不是哪条判断写错了，而是**没有唯一的写入者身份**。

**实际交付**（细节见手册 §4.59）：

- `src/renderer/src/lib/contentSync.ts`（纯函数，9 条单测）：真源内容配一个 `rev` 世代号 + `author` 作者；
  命令式编辑面（Tiptap / 代码块 CM）记 `applied`，要不要重渲染只问 `shouldApply()` —— **不比字符串、不看时间窗**。
- 四个编辑面的角色：Tiptap = 命令式副本；源码 textarea = 声明式副本（`:value` 就是唯一回灌通道，
  且 DOM 值相等时浏览器不动光标，所以「自己写的」不需要代码再判断）；
  代码块 CM = **子编辑面**（写内容时连宿主一起标记为最新，否则宿主回灌会把光标踢出代码块）；
  打开/草稿/切编码/载入历史 = 作者 `external`，**不动任何 applied** ⇒ 所有面都落后 ⇒ 文本恰好相等也重渲染。
- 删除 `files.syncEpoch` 与 `editorStore.syncedMd`（前者就是账本的 `rev`，后者是字符串版的 `applied.wysiwyg`），
  以及 `EditorView` 里那条 200ms 的 `scheduleSplitSync` 第二条通道。
- 代码块 CM 的外部同步从「150ms 快照相等」改成三条结构性规则：**触发时重读节点文本**、
  文本一致就不动、**CM 拿着光标时绝不覆盖**（改成再等一轮）。

**顺带完成的工程项**：`tools/` 下 77 个 CDP 套件改按结构认 pinia（`prov[s]._s instanceof Map`），
不再按 `Symbol(pinia)` 的 symbol 描述取 store —— 那是「同一套件在 dev 与生产构建下行为不同」的根源。
A/B 实测：19 个原本没有结构兜底的套件里 **13 个在构建产物上直接崩（`reading '_s'`）→ 0 个崩**，
其中 4 个从「崩」变成端到端跑通。`tools/_regress-split-live.js` 顺手迁到 `tools/lib/harness.js`、
修好旧选择器，现在进默认矩阵（盯的就是本轮的账本）。

**验收数字**：`npm run ci` exit 0（单测 **120/120**，新增 `tests/contentSync.test.mjs` 9 条）；
`npx eslint .` 0/0；`node tools/run-suites.js` **9/9 套件 PASS**；
`tools/_verify-wave3.js` A 段 9 条（含作者标记、落后判定、代码块作者）。

**下一轮起点**：嵌套样式（`mdStyle` 支持样式集合）；其余 `_regress-*` / `_repro-*` 老套件按
「改到谁就顺手迁谁」继续迁到 `tools/lib/harness.js`；`files` store 继续瘦身（最近文档/置顶整块移出）。

## Wave 1 收尾（一）：嵌套样式 + YAML front matter —— ✅ 本轮完成（2026-09-16 第九轮）

**为什么先做这两个**：8 个 lossy 缺口里，这两个是**内容真的坏掉**的那一类 ——
嵌套样式会写出 CommonMark 下不成立的孤儿标记（渲染成字面星号），front matter 会把 YAML
元数据变成正文。其余 6 个是「结构被改写但不丢内容」，排在后面。

**嵌套样式**（细节见手册 §4.60）：

- `mdStyle` 的样式从单个值改成**集合**（`styles: StyleKind[]`，按固定顺序规范化）——
  PM 里同一种 mark 只能挂一个，嵌套必须靠集合；DOM 只渲染**一个**元素（标签取最外样式，
  全部样式写进 `data-md-styles`），其余样式的外观交给 CSS 属性选择器；**不能**渲染成嵌套标签，
  否则 DOM 回读时后者顶掉前者（样式丢失 + 回写 churn）。
- 标记物化改成**样式栈**：相邻两段取样式集合的公共前缀保持不动、只开关差集 → 标记天然嵌套；
  单一样式时退化成原来的「两边各一对」，既有行为不变。找配对标记的扫描改成深度计数，
  否则外层 `**` 会在内层 `` ` `` 处误判「缺 end」而把构造劈成两半。
- `CodeQuiet` 放开 `excludes: '_'`：上行默认让行内代码**排斥一切 mark**，嵌套样式在解析那一刻就少一半。
- 顺带修掉一个同类潜在缺口：`**粗体 *斜体* 粗体**` 这类 legacy mark 组合此前也会被扁平物化。

**YAML front matter**：做成文档开头的**真实节点**（不是编辑器外的一小段字符串 —— 那会重新引入
「正文两处表示」，与 §4.59 的收敛相悖）。markdown-it block 规则只在第 0 行认领，判定放在纯函数
`shared/frontmatter.ts`（保守规则：必须有顶层 `key:`，否则 CommonMark 里合法的「分割线夹文字」会被误吃），
11 条单测覆盖两侧边界。节点是 atom：WYSIWYG 里只读可见，改 YAML 走源码模式。

**验收**：`npm run ci` exit 0（单测 **131/131**）；`npx eslint .` 0/0；
`_verify-md-fidelity.js` **81 PASS / 0 FAIL / 13 SKIP**；`node tools/run-suites.js` **9/9 套件 PASS**；
夹具分级 `exact 11 / normalized 14 / lossy 6`（本轮前是 9/14/8）。

**下一轮起点**：Wave 1 剩余 6 个缺口按内容损坏严重度继续收 —— 表格（列对齐 + 单元格转义竖线）、
行内 HTML、有序任务列表、相邻有序列表、内联图片、链接图片。

## Wave 1 收尾（二）：表格 + 行内 HTML + 列表编号 —— ✅ 本轮完成（2026-09-16 第十轮）

**实际交付**（细节与踩坑见手册 §4.61）：

- **表格**：解析侧本来就对（markdown-it → 单元格 `align`；`\|` 解成字面竖线），坏的一直是**写回**。
  接管 `table` 的 markdown 序列化：分隔行按表头 align 生成，单元格内容渲染后转义 `|`
  （不转义会被当列分隔符、**整行结构被拆坏**）；复杂表格退回 HTML。纯文本规则进 `tableAlign.ts`（6 条单测）。
- **行内 / 块级 HTML**：`parse.setup` 覆盖 `html_inline` / `html_block` 渲染规则 →
  `MdHtml` mark（行内，逐字写回）/ `HtmlBlock` 节点（块级，原样写回）。两个坑：
  ① 任务列表插件生成的复选框 token 必须放行（否则任务列表变成标签文本）；
  ② 不透明行内内容在样式栈物化时要**原样穿过**，不能打断外层构造。
- **有序任务列表**：`taskList.ordered` 属性（按 `<ol>`/`<ul>` 记住）；只覆盖 `serialize`，
  保留 tiptap-markdown 默认 spec 的 `parse.setup`/`updateDOM`。
- **相邻有序列表**：不是缺陷而是 CommonMark 语义（空行不结束列表），改判级器加规则 19
  （编号按位置重算、首项编号保留、同列表内项间空行不参与比对）—— 规则必须幂等，
  所以有序列表在它眼里不区分 `)` 与 `.`。

**验收**：`npm run ci` exit 0（单测 **137/137**）；`npx eslint .` 0/0；
`_verify-md-fidelity.js` **94 PASS / 0 FAIL / 5 SKIP**；`node tools/run-suites.js` **9/9**；
夹具分级 `exact 13 / normalized 16 / lossy 2`（只剩两个图片缺口）。

**下一轮起点**：`images-inline.md` 与 `images-linked.md` —— 都要把图片从**块级节点**改成
内联形态（或按上下文双形态），并复跑 `images.md`（当前 exact）、`_verify-local-media.js`
与字节级用例，确认「独立成段的图片」仍然逐字节一致。

## Wave 1 收尾（三）：图片改成行内节点 —— ✅ 本轮完成（2026-09-16 第十一轮）

**为什么这两个缺口是同一个问题**：图片配的是**块级节点**，而 Markdown 的 `![alt](src)` 本来就是
**行内语法**（能出现在段落中间、能被链接包住）。块级形态下这两种写法都表达不出来：段落被拆成
「文字 / 图片 / 文字」三段；外层链接因为块节点挂不了 mark 而整个丢掉。

**实际交付**：`Image.configure({ inline: true })`；删掉自定义的块级序列化器（原来为修
「块级图片黏成一行/吞掉下一个标题」而补的 `closeBlock` —— 行内之后段落自己管换行，
默认实现已对齐 prosemirror-markdown 的 alt/括号/引号转义）；CSS 默认行内 + `p > img:only-child`
按块级居中（「独立成段的图片」观感不变），并删掉文件后部重复的一份 `.md-preview img` 规则。

**验收**：`npm run ci` exit 0（单测 137/137）；`npx eslint .` 0/0；
`_verify-md-fidelity.js` **100 PASS / 0 FAIL / 1 SKIP**（101 条；唯一 SKIP 是文档化的
「保存补文末换行」字节级行为）；`node tools/run-suites.js` 9/9；
夹具分级 **exact 15 / normalized 16 / lossy 0** —— Wave 1 的 8 个缺口全部清零（8→6→4→2→0）。

**Wave 1 到此收口。** 下一波回到评审报告里的其他方向（`files` store 继续瘦身、
老套件继续迁到 `tools/lib/harness.js`、以及功能缺口如查找替换 / 数学公式渲染）。

## 工程化收尾（二）：`recent` store 拆分 + 嵌套样式渲染断言 —— ✅ 本轮完成（2026-09-16 第十二轮）

- **`stores/recent.ts`**：最近文档 / 置顶 / 最近文件夹整块从 `files` store 拆出
  （`files.ts` 646 → 593 行）。边界：规则留在 `lib/recent.ts` 纯函数（有单测），
  store 只落盘 + 给 UI 排好序的视图；数据仍存 `settings`（**键名不变 ⇒ 无迁移**）；
  `folderList(root)` 由调用方传根目录以避免两个 store 互相 import；
  置顶判断给 `Set`（列表每行都要问，数组是 O(n²)）。
- **渲染断言**：`_verify-md-fidelity.js` 新增 N 段，断言「粗体里的行内代码」那段文本的
  **计算样式**（标签 `strong`、`data-md-styles="bold code"`、`font-weight ≥ 700`、等宽字体）——
  补的是「CSS 漏了属性选择器时序列化仍保真、但观感已经坏了」这个盲区。
- **复核上一轮列出的两处**：`.md-preview img` 只剩一份规则；主题无独立 CSS 文件
  （明/暗/羊皮纸都是 `style.css` 里的 CSS 变量），不需要同步第二份属性选择器。

**验收**：`npm run ci` exit 0（单测 137/137）；`npx eslint .` 0/0；
`_verify-md-fidelity.js` **101 PASS / 0 FAIL / 1 SKIP**；`node tools/run-suites.js` **9/9**。

**下一轮起点**：老套件迁移（`_regress-*` 5 个 + 价值最高的几个 `_repro-*` 迁到
`tools/lib/harness.js` + `Reporter` 并纳入矩阵），然后是功能缺口（查找替换、数学公式渲染）。

## 老套件迁移（一）：`_regress-*` 全部 + 最有价值的 `_repro-*` —— ✅ 本轮完成（2026-09-16 第十三轮）

**实际交付**（细节与教训见手册 §4.64）：

- 6 个套件迁到 `lib/harness.js` + `Reporter` 并**纳入默认矩阵**：`_regress-layout`(9) /
  `_regress-cb`(3) / `_regress-divider`(4) / `_regress-fileswitch`(5) /
  `_regress-source-roundtrip`(4) / `_repro-rapidenter`(4，断言扩到 store 正文行)。
  它们此前全红的原因是**套件自己过期**（按中文按钮文字找 `.mode-seg-btn`），
  现在模式切换统一走 harness 的 `clickMode(app, 序号)`，语言无关；
- harness 补三个公共能力：`clickMode` / `waitRestored` / **`openDocWith`**（走
  `files.current` + path 变化 ⇒ `:key` 重建 —— 这是唯一不踩「代码块 CM 持焦时不被覆盖」
  那条规则的加载方式，直接 `setContent` 会让后续断言看到上一份文档的内容）；
- **迁移中抓到一个真实保真缺口并修掉**：代码块内容以换行结尾时（用户在块尾敲过回车），
  收尾围栏前必须多留一个空行 —— 否则 CommonMark 把那个换行当成「最后一行的行终止符」，
  重新打开少一行。夹具 `code-fence.md` 补例；
- **剩下 83 个脚本的定位写进手册**（回归守卫 / 一次性探针 / 测量基准 / 截图工具 /
  尚未迁的老 `_verify-*`），并明确「改到谁就顺手迁谁」的节奏。

**验收**：`npm run ci` exit 0（单测 137/137）；`npx eslint .` 0/0；
`node tools/run-suites.js` **15/15 套件 PASS**；`_verify-md-fidelity.js` **101 PASS / 0 FAIL / 1 SKIP**。

**下一轮起点**：功能缺口 —— 编辑器内查找替换、数学公式渲染（`$…$` / `$$…$$`，KaTeX 已是依赖）。

## 功能缺口（一）：编辑器内查找替换 —— ✅ 本轮完成（2026-09-16 第十四轮）

**实际交付**（细节与两个坑见手册 §4.65）：

- 查找栏（`components/FindReplaceBar.vue`）：`Ctrl+F` 开关 · `Enter`/`Shift+Enter` 前后循环 ·
  `Esc` 关闭 · `Aa` 区分大小写 · 「替换」只动当前命中 · 「全部替换」一次改完；
- **两个编辑面共用一份查询状态、各自算匹配**：渲染/分屏在 ProseMirror 文档里按块找
  （位置是文档位置），源码模式在 `files.current.content` 里找（字符偏移）；计数显示当前面的结果；
- 纯逻辑进 `lib/findReplace.ts`（无依赖，11 条单测）；全部替换在渲染面走**一个事务、从后往前**
  （位置不失效、Ctrl+Z 一次撤销）；三语各 +11 键；菜单与快捷键接通（原来只 toast「功能待接入」）。

**两个只有真跑起来才暴露的坑**（都修了，也都写进文档）：

1. 查找的选中/滚动**不能 focus** —— 否则下一次 Enter 落到正文里，按两下「下一个」等于在文档里
   敲两个回车（实测把整段写坏）；
2. 快捷键守卫 `notInInput` 把源码 textarea 与代码块 CM 也算「表单输入框」→ 源码模式 Ctrl+F 失灵；
   现在先排除**文档自己的编辑面**。

**验收**：`npm run ci` exit 0（单测 **148/148**）；`npx eslint .` 0/0；
`node tools/run-suites.js` **16/16 套件 PASS**（新增 `_verify-find-replace` 12 条）。

**下一轮起点**：功能缺口二 —— **数学公式渲染**（`$…$` / `$$…$$`；KaTeX 已在依赖里，
但目前只用于导出 CSS，应用没有数学节点，`math.md` 夹具只是「文本往返保义」）。

## 功能缺口（二）：数学公式渲染 —— ✅ 本轮完成（2026-09-16 第十五轮）

**实际交付**（细节与三个坑见手册 §4.66）：KaTeX 渲染行内 `$…$` 与块级 `$$…$$`
（单行/多行都认）。**公式原文一个字符都不动，渲染只是视图**：

- 行内：markdown-it 行内规则（在强调规则**之前**认领）→ `MdMath` mark（`escape:false`）逐字写回；
  渲染靠**装饰**（KaTeX 组件 + 原文折叠 `font-size: 0`），光标落进去就露出原文可编辑；
- 块级：block 规则 → `MathBlock` 原子节点，屏幕呈现走 **NodeView**（PM 的 DOMOutputSpec 注不了 HTML）；
- 识别规则抽成纯函数 `lib/mathScan.ts`（9 条单测）：不跨行、内容非空、闭合 `$` 后不紧跟数字、
  `\$` 不是起点、`$$` 不当行内公式。

**三个坑**：① `mdMath` 漏进「不透明内容」名单 → `$a * b$` 被 `literalizeStrayMarkers` 从 `*` 处切开
（实测 4 个公式渲染成 5 个）；② 这套 prosemirror-view（1.42）的 `Decoration` 没有 `replace`、
也没导出 `WidgetType`，只能 `widget` + `inline` 两步拼；③ `renderSpec` 不认 `innerHTML` → 块级走 NodeView。

**验收**：`npm run ci` exit 0（单测 **157/157**）；`npx eslint .` 0/0；
`node tools/run-suites.js` **17/17 套件 PASS**（新增 `_verify-math` 7 条）；
夹具 `math.md` normalized → **exact**（合计 16 exact / 15 normalized / **0 lossy**）。

**这条线的收口**：评审报告里列的两处功能缺口（编辑器内查找替换、数学公式渲染）都已完成；
默认矩阵从 9 个套件涨到 17 个。后续可继续的方向：其余老 `_verify-*` 套件按「改到谁就顺手迁谁」
继续收口、`files` store 继续瘦身、打包/更新链路（签名与真实更新渠道，需要拍板）。

## 缺陷修复：单实例锁 —— ✅ 本轮完成（2026-09-16 第十六轮）

**现场**（用户报告）：dev 实例还开着时再执行一次 `npm run dev` → 控制台刷出三条 Chromium 磁盘缓存报错
（`Unable to move the cache: 拒绝访问。(0x5)` / `Unable to create cache` / `Gpu Cache Creation failed: -2`），
紧接着整个 dev 命令结束、窗口也没出来。

**根因**（两段，均实测）：① 主进程照抄官方文档的 `if (!app.requestSingleInstanceLock()) app.quit()`，
而 **`app.quit()` 在 ready 之前只是「标记退出」**：ready 一到 `app.whenReady()` 的回调照跑，
于是第二个实例完整启动一遍（开 SQLite / 写设置 / 建窗口 / 装菜单 / 拉 GPU 进程），与首个实例共用
userData → 两边同时写 Chromium 磁盘缓存，报出上面三条；② 这个进程一退，electron-vite 的 dev 命令跟着结束。

**修法**：新增 `src/main/singleInstance.ts`，在 `index.ts` 里排在所有会读 userData 的模块之前求值：
`app.setName('Lumin')`（名字决定 userData 与锁）→ `requestSingleInstanceLock()` →
抢不到就 `fs.writeSync(2, 提示)` + `app.exit(0)`（实测 `app.exit()` 不返回，退出码 0）。
**只退出还不够**：`services/database` 的 `db` 是模块级 `new LuminDatabase()`，守卫若排在它之后，
第二个实例仍会打开首个实例的 SQLite 并跑迁移 —— 所以顺序本身就是修复的一部分（与 `devProfile.ts`
靠 import 顺序先改 userData 同一套机制），并在套件里静态核对。

**验收**：`npm run ci` exit 0（单测 **157/157**）；`npx eslint .` **0/0**；
`node tools/run-suites.js` **18/18 套件 PASS**（新增 `_verify-single-instance` **13/13**，自管两个实例、
独立端口 9231）；现场复现：打印提示、**exit 0**、耗时 ~0.2s、无缓存报错。细节见手册 §4.67。

**续修（同轮）**：提示本身在用户终端里是**乱码**（中文变 `宸叉湁...`，还是四行并一行）—— 根因是
Windows 控制台按代码页解读字节（中文系统 936/GBK），而我们写的是 UTF-8；想「先认出控制台再交给
Node 转码」也走不通（Electron 把 `isTTY` 的 spec 标成不可靠并压掉了；实测控制台/管道两种落点都
拿不到可信信号）。于是提示改成**纯 ASCII**（关键信息本来就是命令），并立规矩：**主进程 console
输出一律 ASCII**（原先三处中文输出一并发英文）；规矩由 `tests/mainConsoleAscii.test.mjs` 守着
（扫描 `console.*` 实参文本，非 ASCII 就红，测试自带「扫描器先自证」断言）。
验收更新为：单测 **159/159**、`_verify-single-instance` **14/14**（新增「提示是纯 ASCII」）、
`npm run dev` 现场复现四行提示可读 / exit 0 / 1314ms / 无缓存报错。

## 缺陷修复：行内标记的光标漂移 / 冗余嵌套星号被吃 / 整行标记被当块级构造 —— ✅ 本轮完成（第十七轮）

**现场**（用户报的两个必现缺陷）：① 空光标点工具栏「加粗」得到 `*|***`（期望 `**|**`）；
② `**x**` 前后各手打一对 `**` 时期望 `****x****`，实际新增的四个 `*` 消失、只剩加粗的 `x`。

**根因**（三个，详见手册 §4.70）：
1. appendTransaction 的光标保护写成 `caretBlockStart = $sel.before(d) - 1` —— `before(d)` 本身就是
   「块之前的位置」，减一让顶层段落算出 **-1**、`>= 0` 守卫不成立 → 光标保护整段失效 →
   PM 把光标映射到被替换区间末尾（点加粗变 `****|`；手打 `**` 时第一颗星打完光标已被挪到块尾，
   第二颗星落到末尾 → `*x*`）。
2. `****x****` 被 CommonMark 解析成 `<strong><strong>`，而 PM 同种 mark 只能挂一个 →
   多出来的那对 `**` 在 HTML→PM 那一步就没了（打开时一次掉四个字符）。
3. 「源码权威重推」把整行文本喂给 markdown-it，`~~~~` 被当成**代码围栏**开头 → 解析产物文本为空 →
   空段落点「删除线」时四个 `~` 直接消失。

**修法**：① 锚点改回 `$sel.before(d)`，落点抽成纯函数 `blockCaretTarget()` 并单测钉死；
② 新增 `patchRedundantEmphasis`（挂在 `MdMarker` 的 `parse.setup`）：markdown-it 渲染遇到
**同类嵌套强调**时把多余那对定界符当字面文本写（复用 `MdEscape` 的 `escape:false`，否则会被
转义成 `\*\*`），归一化时随样式物化回 `****x****`，逐字节还原；
③ 重推加「不丢字符」护栏 `fragmentText(frag2) === block.textContent`，文本对不上就不采用。

**口径（本轮定稿）**：整行（去行尾空白后）只由标记字符组成时，**落盘逐字符转义**
（`shared/documentText.escapeMarkerOnlyLines()`，挂进 `getMarkdown` 唯一出口）——
不转义的话 `****` 是分割线、`~~~~` 是代码围栏，重开会把字符静默改写；
转义后重开仍是字面文本且跨编辑器一致。边界：反引号围栏及其内容、原样写回的
HTML/公式块/front matter（`attrs.source` 当 `protect` 集合）、缩进行、行尾空白都不动；
已知边界是「带容器前缀的整行」（`> ****` / `- ****`）暂不覆盖。手册 §4.70「四」。

**验收**：`npm run ci` exit 0（单测 **212/212**：新增 `tests/inlineMarkers.test.mjs` 25 条 +
`documentText` 7 条）；eslint **0/0**；新套件 `_verify-inline-formats.js`
（**102/103 PASS + 1 SKIP**）已进默认矩阵；`_verify-md-fidelity.js` **101/102** 不回退；
完整矩阵 **22/22 PASS**。

**后续任务（下轮，已登记不遗漏）**：给**下划线**一个一等 mark（序列化 `<u>…</u>` +
`escape:false`，与 `MdHtml` 同思路），让它与标记样式能安全嵌套。当前是**已知限制**：
下划线没有 Markdown 语法、序列化为裸 HTML `<u>`，为保住它而跳过重推会让同一段里的 `**`
在每次重开时指数膨胀（实测 4→8→12 颗星），所以现在的行为是「字节稳定、丢弃下划线」
（`_verify-inline-formats.js` 里登记为 SKIP 并写明原因，不是假绿）。

## 缺陷修复：行内标记的字节保真（样式正文里的字面标记被补反斜杠）+ 转义反斜杠按光标显隐 —— ✅ 本轮完成（第十九轮，转义显隐为二十轮行为修订）

**现场**（用户实测）：实时渲染区输入 `**2****2**` → 源码变成 `**2\*\*\*\*2**`。

**先取证（四条路径，隔离实例逐步打印 `doc.textContent` + 每个 text 节点的文本与 marks）**：
① 逐字键入 → 转义；② 一次性 `ed.commands.insertContent('**2****2**')` → **同样**转义；
③ 从磁盘装载同一份源码 → **同样**转义；④ 先打 `**2**` 再整段插入 `**2**` → 不转义
（但它干净是因为模型成了「两个相邻 strong」，与 CommonMark 解析无关）。
⇒ 报障时「输入中间态把标记锁成字面文本」「一次性写入不会这样」两条推断**都被证伪**；
且中间态的重新评估一直在工作（`**2***` 末尾那颗 literal 星在打到 `**2****2*` 时确实变回了斜体起始）。

**口径修正**：`**2****2**` 在 CommonMark 里是**一个** `<strong>` 包住字面文本 `2****2`
（§6.2「3 的倍数」规则只在前一定界符串同时能开能闭时生效 → `**` 与 `****` 不许配对，
最后的 `**` 回头配最前面的 `**`）。markdown-it（默认 + commonmark preset）与 marked 三方实测一致
→ 实时渲染区「粗体的 `2****2`，星号可见」**才是**与 GitHub / VS Code 一致的行为。
真正的缺陷只有一条：**字节被改写**（多了 `\*\*\*\*`）。

**根因**：`typoraInlineMarks.ts` 的 `literalizeStrayMarkers`（旧 472–517 行）见到 `mdStyle`
就整段跳过 —— 字面量化只覆盖无样式正文，样式正文里的裸标记字符被 markdown 写出器的
`esc()`（`` ` `` `*` `\` `~` `[` `]` `_`）补了反斜杠。

**顺带查出并修掉：真实粘贴丢字符**（上一轮遗留）。Ctrl+V 粘贴 `**2****2**` 落成 `**2**2**`
（少两个星号）。定位链：真系统剪贴板 + CDP Ctrl+V 复现 → 同一 slice 手工插入带/不带
`paste` meta 对照（不带 → 逐字节正确；带 → 丢两个字符）→ 忠实复刻 PM 的 appendTransaction
循环，看到 keyless 插件（源码即 tiptap `markPasteRule` 的 appendTransaction）在
`uiEvent === 'paste'` 时把定界符当语法消费。修法：`extensions.ts` 的四个「安静版」mark 连
`addPasteRules` 一起关掉（此前只关了输入规则与快捷键，同一理由：样式由标记文本派生）。

**修法**：① 字面量化下沉到纯逻辑核心 `inlineMarkerCore.literalizeStrayAtoms`（`normalizeAtoms`
末尾跑）：无样式正文 → `mdMarker(literal)`；**样式正文 → verbatim 原子 + `MdEscape` 的
`escape:false` 逐字写回**；代码正文与「带链接/下划线 mark 的无样式文本」不动（后者硬切会把
链接劈成 `[a](u)*[b](u)`）。② 重推判据抽成 `needsSourceReparse()`（同时是「已字面化标记的
重新评估」机制，单测钉死）。③ 转义反斜杠的观感：`escapeDecorations()` 在装饰层把 `\X` 拆成
`.md-escape-backslash` + `.md-escape-char`，模型与字节不动、`data-md-escape` 保留。
**显隐口径（用户反馈后的行为修订，第二十轮）**：反斜杠从「暗色常显」改为**跟 `**` 一样按光标显隐**
—— 复用 `.md-marker` 那一套（`.md-reveal-inline` + `font-size: 0` 折叠，不用 `display:none`），
判据与 mdMarker 构造逐字一致（`from <= run.end && to >= run.start`，边界均含）；
新增 `collectEscapeRuns()` 做**连续转义段**判定（`\*\*\*\*` = 1 段 4 个 → 同显同隐；
`\* \*` 中间有空格 = 2 段 → 各显各的）。**只有「真转义」（`\` + ASCII 标点，复用既有
`ASCII_PUNCT`）折叠**：实测 `C:\Users\x` 这类 Windows 路径在装载路径上同样是 MdEscape
文本节点，折叠会让路径少字符（`C:Usersx`）→ 非标点 `\X` 一律常显（宁可多显示一个反斜杠，
也绝不把内容藏起来）。

**验收**：单测 **217/217**（新增 5 条：判据/字面量化/归一化幂等/重推判据/重新评估）；
`_verify-inline-formats.js` **159/160 PASS + 1 SKIP**（SKIP = 「下划线 + 加粗」已知缺口登记；
相比上一轮 +20 条：转义反斜杠从「暗色常显」改为**按光标显隐**的成对断言 —— 光标在别段折叠
（font-size:0 / rect 宽 0 / 非 display:none，与 `.md-marker` 同口径）、落在段内三处可见且暗色、
连续段 `\*\*\*\*` 7 个位置都 4 个同显、紧贴段两端也显示、两段 `\* \*` 各显各的（含中间空格边界）、
键盘 ←→ 跨边界切换、三主题各两条、字节与 `textContent` 不变；另 3 条钉住**非标点 `\X`
（Windows 路径）不参与折叠**）；
`_verify-md-fidelity.js` **101/102** 不回退；`npm run ci` exit 0；eslint **0/0**；
5 套件门禁 `_verify-inline-formats / _verify-md-fidelity / _regress-layout / _regress-cb /
_verify-find-replace` = **5 PASS / 0 FAIL**（`9/9`、`3/3`、`12/12` 等）；22 套件默认矩阵全绿。

**已知边界（保留，不是遗漏）**：带链接/下划线 mark 的无样式文本里的裸标记字符仍会被补反斜杠
（`[a*b](url)` → `[a\*b](url)`）——宁可字节不完美，也绝不把链接劈开。
