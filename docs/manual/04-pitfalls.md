<!-- 本文件由 docs/typora-wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

## 4. 实践坑位与解法（本项目实录）

这一章是本手册最有价值的部分：以下每个坑都在本项目开发中真实发生过，并留有对应代码与验收断言。

### 4.1 位置语义：packed position 与 contentPos

- **本 PM 版本的位置是「紧凑」的**：`doc.content.size === Σ child.nodeSize`，顶层子节点之间**没有** `+1` 的间隙。实测 `[h1(5), p(4), taskList(6), p(2)]` 的 `content.size = 17`。
- `descendants` 回调的 `pos` 是 0-based `contentPos`，**转绝对位置要 `+1`**（`outline`、`inputRules` 里都是这么用的）；
- **光标落点算术必须用 packed 偏移**：任务列表转换后的插入点 = `1 + Σ 前置兄弟.nodeSize + 1 + Σ 前置转换项.nodeSize + 1`（`inputRules.ts` 的实现），任何一个 `+1` 间隙假设都会让光标落到错误块。

### 4.2 替换原语对列表类型转换的敌意

把 `bulletList` 原地改成 `taskList` 时，逐个试过并**全部失败**的路径：

| 原语 | 失败方式 |
|---|---|
| `tr.deleteRange(from, to)` | `deleteRange(4,7)` 实际删掉 `[5,7)`——replaceStep 的 Fitter 会挪动 textblock 边界 |
| `tr.replace / replaceWith / delete` | 同样经 replaceStep，深度不匹配时抛 "Inconsistent open depths" |
| 原始 `ReplaceStep` / `Fragment.replace` | 抛 "Inconsistent open depths" |
| `ReplaceAroundStep` | "Content does not fit in gap"——旧 listItem 塞不进 taskList 的 gap |
| `tr.replaceRange` | 不报错但把 taskList 整个丢掉 |

**最终解法（已落地在 `inputRules.ts`）**：不原地改结构，而是**重建整层内容再整体替换**：

```ts
// 1. 遍历 doc 顶层 children，把目标 bulletList 替换为等价 taskList（递归转换 listItem）
// 2. 用 PACKED 偏移构造新 Fragment
tr.replace(0, doc.content.size, new Slice(Fragment.fromArray(children), 0, 0))
```

`Slice(0,0)` 满足 `fitsTrivially`，`replace` 走精确 ReplaceStep，schema 校验一次性通过，光标位置随后用 packed 偏移重算，`TextSelection.create` 显式放置。

> 通用经验：**PM 的替换原语面向「同构结构内的编辑」**；跨类型的结构性转换（bullet↔task、段落↔标题组）优先「重建 + 整体 replace」，而不是指望切片原语自动适配。

### 4.3 resolve 与选区的边界行为

- `resolve(n)` 落在节点开头时会**一路下降到最深叶子**：`[h1(5), p(4), taskList(6), p(2)]` 里 `resolve(12)` 给 paragraph（depth 3）、`resolve(13)` 给 taskItem、`resolve(14)` 给 taskList、`resolve(15)` 给 doc；
- 空 textblock 的内部位置解析到外层节点——判断「光标在哪个块」要同时看 `$from.parent` 和 `$from.depth`；
- `TextSelection.near` 会把光标从空段落「弹」出去（4→7 之类）——需要精确落点时用 `TextSelection.create(doc, pos)`（本项目任务列表转换后的光标就是这么放的）。

### 4.4 焦点管理

- PM 与 CodeMirror 的焦点争夺（完整五层防线见 §3.4）：`stopEvent` + DOM 事件阻断 + 焦点钉扎 + hasFocus 覆盖 + Enter 专用捕获处理器；
- 浮层（查找浮条、表格/代码块弹层、右键菜单）挂 `@mousedown.prevent` 防止点按钮时编辑器失焦、选区塌缩（§3.8）；
- CDP 自动化测试时，`visibilityState === 'hidden'` 的窗口会丢弃可信输入事件——测试前必须把窗口真正置前（`tools/run-verify.ps1` 的 user32 调用）。

### 4.5 序列化一致性

- **tight/loose list**：`tightLists: true` 时 serializer 决定项间空行，与解析器必须对称，否则「打开→保存」会漂移；
- **taskItem**：v3 的 `taskItem` 没有 `data-type` 属性（早期版本有），CSS 选择器与测试断言都不要依赖它；勾选状态在 `li[data-checked]` 上；
- **代码围栏语言**：`codeBlock(attrs.language)` 必须进 serializer 的 fence info，否则 `js` 语言丢失；
- **HTML 与换行**：`html: true, breaks: true` 意味着源码里的行内 HTML 会进渲染视图——这是有意的（Typora 同样支持），但导出 HTML 前要统一处理。

### 4.6 数据竞态：文件切换时的回写覆盖

场景：切文件时旧编辑器实例销毁，`blur/flushSync` 把旧文档内容写回当前文件槽——新打开的文档被旧内容覆盖。

解法（`TyporaEditor.vue`）：

1. `unmounting` 标志位：`onBeforeUnmount` 置位，`flushSync` 开头检查，卸载中的旧实例禁止回写；
2. 窗口级关闭走 `beforeunload` 监听单独 flush（不参与文件切换）；
3. 外部同步守卫：`watch(modelValue)` 里先比较 `getMarkdown(editor)` 与传入值，**不一致才 `setContent(nv, { emitUpdate: false })`**，避免 `setContent` 触发 onUpdate 造成回环与光标重置。

**回声过滤（本次修复，快速回车丢失的根因）**——同一 watch 的另两类拦截：

4. **blur 守卫**：`onBlur` 时若 `relatedTarget` 仍在编辑器内部（`.cm-editor` 内或 `view.dom` 内），**不落盘**。否则焦点在代码块与正文间每次翻转都触发一次 flushSync，把「上一轮」的旧 markdown 抢在本轮 `syncToNode` 之前 emit 出去；
5. **回声过滤 + 静默窗**：`flushSync` 记录 `lastEmitted` 与时刻；watch 收到 `nv === lastEmitted`（自身回声）或距最近 emit < 600ms（滞后回声）时直接跳过——只放行真正的低频外部事件（文件切换/草稿恢复）。完整竞态链见 §4.11。

### 4.7 装饰/类名残留与列表圆点（本次修复）

- 本 PM 视图移除行内 `Decoration` 时会留下孤儿 `<span class="md-reveal-inline">`（`patchOuterDeco/patchAttributes` 对 text 节点失效）→ 行内标记改为 PluginView 直接管理类名（§3.3）；
- `Decoration.node` 校验用 0-based `content.findIndex`，装饰 pos 传绝对位置会挂；
- **列表圆点**：`li.md-reveal { list-style: none } + ::before{content:'- '}` 会把圆点换成减号。Typora 语义是：圆点由 `ul` 的 `list-style: disc` 始终渲染，`- ` 只存在于源码与序列化里。已移除替换规则（`li.md-reveal { list-style: inherit }`），验收断言 `bullet-input-rule` 持续守护。

### 4.8 气泡菜单的坐标系与视口钳制（本次修复）

见 §3.8 第 3、4 条：参考系必须用定位上下文 rect；`coordsAtPos` 可能返回视口外坐标，必须钳制/隐藏，否则气泡出现在选区左侧 24px、甚至窗口外（表现为「点击按钮无效」）。

### 4.9 键盘语义优先级与「回车确认式」转换（本次修复）

- **core keymap 抢占**：Tiptap v3 每个扩展的 keymap 是独立插件，按扩展 `priority` 降序执行、先返回 true 者胜。core 的 Enter（`splitBlock`）与 Backspace（`joinBackward`）链默认优先于一般用户扩展——自定义键盘语义（标题退格降级、分割线回车确认）必须 `priority: 200`，否则拦截静默失效（详见 §3.2）；
- **即时转换的误伤**：分割线输入规则 `---` 即时生效会让 `---你好` 无法输入。有歧义的语法（`---` 既是分割线又是普通文本）应采用**回车确认式**转换：关闭即时输入规则（`horizontalRule: false` + 独立注册空输入规则的 HR 节点），改由 Enter 键绑定判断「整段恰为标记」后转换；
- **转义回写**：`---你好` 这样的段首横线文本在序列化时会被转义为 `\---你好`，保证下次解析不误判——这是 CommonMark 往返正确性的一部分，验收断言 `hr-text-kept` 直接守护。

### 4.10 大纲闪烁与 CodeMirror 行渲染（本次修复）

- **大纲闪烁根因**：`Outline.vue` 的列表 `:key` 曾含标题绝对位置 `pos`——代码块内每敲一键，其上方所有标题的 `pos` 位移 → 全部 key 变化 → `TransitionGroup` 整列进出动画重放 → 可视闪烁。修复：key 改为 `索引-层级-文本`（集合不变时稳定），`refreshOutline` 做差异跳过（标题集合不变时只原位更新 `pos`，不重建数组），并移到 `transaction` 钩子（保证跳转位置新鲜）——验收断言 `outline-dom-stable` 直接比较 DOM 元素引用；
- **CodeMirror 行渲染与断言**：CM 用独立 `.cm-line` div 渲染每一行，`cm-content.textContent` 拼接无分隔符——**不能**用 `textContent.includes('\n')` 断言换行，必须数 `.cm-line` 元素（验收断言 `cm-enter-newline` 的教训）；
- **嵌套 CM 的三条铁律**（§3.4 的实现依据）：跨模块 `Transaction instanceof` 判定会失效（事务落入 spec 合并路径、changes 丢失）；增量重绘 `docView.update` 在嵌入场景不可靠（state 更新而 DOM 不重绘）；`setState` 整文档重建是唯一稳定路径。

### 4.11 代码块快速回车丢失的完整竞态链（本次修复）

现象：代码块里慢慢一下一下回车正常，快速连点或按住回车时大量换行丢失、光标乱跳。

诊断实录（CDP 打点 + `view.dispatch` 补丁抓 PM 事务栈）：

1. **焦点全程在 CM 上**——`HTMLElement.focus` 补丁显示 47 次 focus 全部落在 `cm-content`，零次 tiptap；8 个 keydown 全部进入捕获处理器，`setState` 全部应用（CM 状态 1→9 行）。问题不在 CM；
2. **PM 文档在事务间被回滚**：`syncToNode` 的 8 个事务依次把节点推到 9 行，但每轮之后紧跟一个 `setContent` 事务（栈指向 `TyporaEditor.vue` 的 modelValue watch）把它打回**上一轮**的行数（9→3 收尾）；
3. **根因链**：每轮 Enter 的 `pinCmFocus` 把焦点从 PM 拉回 CM → 触发 PM blur → `onBlur` 立即 `flushSync` → **抢在本轮 `syncToNode` 之前** emit 上一轮的 markdown → 父组件 store 同步回流 `props.modelValue` → watch 比较「当前 PM 序列化 ≠ 旧快照」→ `setContent(旧快照)` 整体替换文档 → 代码块节点 props 更新 → `CodeBlockView` 的 watch 又把 CM 状态重置回旧内容。单次回车靠「syncToNode 在 watch 之后执行」的顺序碰巧自愈，快速输入时 watch 落在两轮 syncToNode 之间 → 真回滚；
4. **修复**（§4.6 第 4、5 条）：blur 守卫（焦点仍在编辑器内不落盘）+ 回声过滤 + 600ms 静默窗。另将 `CodeBlockView` 的 `props.node.textContent` watch 防抖 150ms，避免 Vue 异步队列里的过期快照把 CM 逐级回滚；
5. **验收**：`tools/_repro-rapidenter.js`——8 次 35ms 连发 + 10 次 15ms 按住速率，要求 `.cm-line` 与 PM codeBlock 行数双端 = 19。

### 4.12 粘贴内容的「开放 Slice 合并」：标题被吸进段落（本次修复）

现象：粘贴 Markdown 源码（或 HTML）后，`# 大标题` 显示成了普通段落文字——点击它不出现 `#` 标记符、块语义全丢（用户报「粘贴内容显示样式但不可编辑、点击大标题没有 #」）。

诊断链（逐层 CDP 打点）：

1. `markdown-it` 的解析**没有问题**——`parser.parse(text)` 输出 `<h1>…</h1><p>…</p><ul>…</ul>` 完整块结构；
2. `DOMParser.parseSlice(<body>…</body>, { context })` 产出的 Slice 是 `openStart/openEnd > 0` 的**开放结构**（body 包裹解析使首尾块处于开放上下文）；
3. `parseFromClipboard` 的后处理 `normalizeSiblings` 保留了 heading（实测 normalized=[heading,paragraph,bulletList]），但 `Slice.maxOpen` 会**重新把完整块算成开放**（它沿首尾节点向内容内走深度：h1→text 得 openStart=1，ul→listItem→p→text 得 openEnd=3），随后 `closeSlice` 判定「无需闭合」；
4. `replaceSelection(开放 Slice)` 把首个块的内容**并入当前段落**——`_ReplaceAroundStep` 的 slice 首节点已是 paragraph（标题文本被吸进去），列表因为是后续块而幸存。HTML 粘贴路径同样受影响；
5. 修复（`markdownPaste.ts`）：`clipboardTextParser` 按内容智能选择（含换行/块标记开头 → 块级解析并显式闭合；单行行内 → inline 解析保持开放）；**`transformPasted` 兜底**（插入前最后一道钩子）把首节点为文本块/引用/列表的伪开放 Slice 闭合为 0/0——编辑器内部复制粘贴的合法开放结构（部分段落、列表项）不受影响。

**补丁：粘贴标题去粗（本次）**：`transformPasted` 里 `stripBoldInHeadings` 递归遍历 Slice，剥除标题节点内所有文本的 `bold` 标记——外部 HTML 粘贴的 `h1<b>…</b>`（Word/网页标题常整段加粗）与 Markdown 粘贴的 `# **…**` 都归一为干净的 `# 标题`（标题本身即加粗样式，`**` 冗余）。验收：`paste-heading-no-bold`（节点无 bold 标记 + 源码无 `**`）。

### 4.13 真实文本标记模型（本次重构）

需求驱动（Typora 同款）：行内语法标记（`**`/`*`/`~~`/`` ` ``）必须是**文档中的真实文本**——光标在样式内/边界（'体'后、'被'前）时显现、移出隐藏，且标记可被选中编辑；**「标记文本即源码真值」（CommonMark 对齐）**：两侧标记相等且可识别才派生样式，**不成对/不可识别即整段字面量**——删单侧一个 `*` 后显示原始字符 `*加粗**`（不再自动转斜体），两侧各删一星成 `*加粗*` 才按 CommonMark 重派为斜体；标题的光标提示改为浅色 `H1~H6` 徽章（非可编辑源码标记）。

**数据模型**（`typoraInlineMarks.ts`，两条自定义 Mark）：
- `mdStyle`（attrs.style）：被样式的正文，WYSIWYG 渲染 `<strong>/<em>/<s>/<code>`（带 `data-md-style`），markdown 序列化 open/close 为空——**语法由标记文本自身承担**，序列化输出 == 源码；
- `mdMarker`（attrs.style + side）：语法标记文本，渲染 `.md-marker` span，序列化 `open/close: '' + escape: false`（标记字符原样输出；若被转义成 `\*`，序列化结果与源码不一致，会破坏外部同步回声过滤并引发 setContent 循环重放）。

**派生归一化**（appendTransaction）：每次文档变更后重建含样式/标记的文本块——识别「标记 + 正文 + 配对标记」模式（任意位置扫描，打字合并进同一文本节点也命中）派生样式；**两侧标记相等且可识别（`**`/`*`/`~~`/`` ` ``）→ 按标记文本决定样式；不配对/不可识别（如 `**5*`、回车把标记劈开）→ 整段字面量**：内容去 `mdStyle`、标记降级 `side:'literal'`（保留 mdMarker mark 使原样序列化 + 以可见字符渲染，CSS `.md-marker[data-side='literal']{font-size/weight/style/color:inherit}`）；带样式内容缺一侧标记（回车切段）→ 自动补齐完整构造；标记删空去样式；遗留 bold/italic/strike/code（解析/粘贴产物）自动转换。与主事务同组撤销（prosemirror-history 按时间戳合并）。

**关键坑位**（本版重打包 PM 的实测行为）：
1. **`Transaction.insertText(text, from, to)` 无 marks 参数**（marks 取自 storedMarks/位置）——带标记文本须走 `replaceRangeWith(from, to, schema.text(text, marks))`，否则 marks 数组被当成 `to` 位置抛 RangeError；
2. **DOM 观察器回写循环**：渲染后的 `<strong>`/marker span 被 PM 的 DOMObserver 解析回 legacy bold/纯文本，与文档比对不一致 → `readDOMChange` 回写 → 标记丢失 + 无限重放。修复：两个 mark 声明 `parseHTML`（`strong[data-md-style]`/`span.md-marker`，priority 60），DOM 解析还原原 mark，比对一致即止；
3. **显隐用 PM Decoration**（`.md-reveal-inline` 包在 marker span 内部，CSS `:has(> .md-reveal-inline)` 反向匹配）：DOM 类切换会被追加事务的重渲染冲掉，装饰随选区状态自动重建。**展开判定左右边界均含**（`from <= r.end && to >= r.start`）：光标落在正文/标记内或紧贴构造两端（`|**s**`、`**s**|`）都展开，可继续选中/编辑 `*`；完全移入相邻普通文本才折叠——折叠临界不再抢占光标（Typora 同款）；
4. **隐藏态必须零占位且可导航**：`opacity: 0` 保留布局盒（出现占位空隙）；`display: none` 移除文本节点导致浏览器光标无法导航/落位——箭头键会把光标落在错误位置，Enter 把标记劈成两半造成字符错乱/输入不可见。**正确方案 `font-size: 0`**：字形零宽不占布局，但文本节点仍在，光标可正常导航、标记可正常选中编辑，显现时 `font-size: inherit` 恢复；
5. 初始加载（解析产物无标记）在 onCreate 跑一次 `normalizeMdMarkers`；粘贴/打字由 appendTransaction 自动维护；
6. **标记内回车 = 普通字面量切段**（`keymap.ts` 不再拦截，priority 200 仅保留 `---/***` 段尾回车→分割线与标题首字前退格降级）：光标落在标记字符内部（如 `**5*|*`）按 Enter，PM 把构造文本切成两半——派生归一化把两个不成对片段降级为 `side:'literal'`，按**可见字符**原样落到两个新段落（`**5*` / `*`），序列化**零转义**（源码即 `**5*\n\n*`，无 `\*`），继续打字即时可见（字面量段没有隐藏标记，输入不会再"看不见"）；光标在正文中段回车同样切段，完整一侧的构造由派生自动补齐另一侧。此前"先跳到 run.end 再切段"的拦截已删除——它会伪造"跳出构造"的落点（`**5*` 变成 `**5**` 才换行）且新行输入异常。`appendTransaction` 整体包 try/catch 兜底，任何归一化异常都不会让编辑器崩溃。
7. **构造边界打字会"污染"标记文本**：光标紧贴构造起点（`|**5**`）打字时，PM 的 `insertText` 取 `$head.marks()`——位置右侧是 mdMarker 节点，新字符继承 mdMarker，与起始标记文本合并成同一节点 `2**`（终点同理得 `**2`）；此时两侧标记文本不配对，归一化误判「不成对 → 整段字面量」，渲染失粗，且源码仍是 `2**5**`（字面量标记原样序列化），content-equal 断言**永远抓不到**，须刷新才恢复。修复：`repairPollutedMarkers` 在 `normalizeAtoms` 开头把粘连在标记外侧的多余字符拆回普通文本、只保留干净标记本体（start 标记取 `MARKER_OF[style]` 的后缀、end 标记取前缀），随后正常识别重新派生样式。

**补丁：拖选跨出构造 ⇒ 整对标记入选区 + 行尾点击落点（第二十四轮）**：

- **选区含标记**（`expandOutsideMarkers`）：**只有选区真的碰到构造边界时才补标记** ——
  左边紧邻的是**开标记**且内侧紧邻的是**有样式的正文** ⇒ 起点左移到构造之前；右边镜像。
  判据逐字、不看 mark 的 side 属性，覆盖 `*`/`_`/`~~`/`` ` ``。
  ⚠️ **补的跨度必须取「那个标记节点自己的 `nodeSize`」，绝不能用容器边界**
  （`doc.resolve(pos).start()` / `.end()`）：那是**所在段落**的起止，不是标记的起止。
  一个构造后面还跟着普通文字时（用户原文 `**是同一个地方的两层**全片不允许出现任何一句解释这件事`），
  终点停在收尾 `**` 起点（12）会触发右侧规则，`resolve(12).end()` 给出**段落末尾**（30）——
  用户报的「从『地』拖到『层』却把这一行后面的字全选中了」正是它（实测选区 `[7,30]`）；
  改成 `t + rightOf(t).nodeSize` 后同一个手势得 `[7,14]`（= `地方的两层` + 收尾标记）。
  左侧 `resolve(f).start()` 是同类错误（`全片…在 **SH-058**，靠…` 里会把起点拉到段首）。
  **不能拿「两侧样式集合是否不同」当判据**（踩过的真 bug）：加粗正文 `SH-058` 内部
  `0`（有样式）与 `5`（**无**样式，行内标记模型会把同一段样式正文拆成多个文本节点）相邻，
  于是从「镜」往左拖到 `0` 时起点两侧样式集合不同 —— 被判成「跨出构造」，选区被撑到
  **段首**（用户报的「把前面的也选中了」）；正确结果是不动。取相邻节点必须用
  `resolve(pos).nodeBefore / nodeAfter`，**不能用** `maybeChild(index - 1)`：实测后者在同一
  段落里会给出错位节点（位置 18 左边拿到的是起始 `**`）。
  **必须挂在指针路径**（`handleDOMEvents.mouseup` 里 `setTimeout(0)`，等 PM 自己的 MouseUp
  流程走完再改写选区），**不能**放 `appendTransaction`：后者每次事务都跑，「连点两个样式按钮」
  的中间态（选中的正好是刚生成的那段正文，两侧紧邻的正是刚插入的标记）会被撑开，随后派生
  归一化只好把第二个样式套在第一对标记**外层** —— 实测 `粗+代码` 得到 `` `**abc**` `` 而不是
  `` **`abc`** ``（`_verify-inline-formats.js` D 段 4 条从绿变红）。命令式选区因此不被改写。
  实测口径：`**X**xx` 里从 `X` 的**内部**拖到 `xx` 末尾 ⇒ 抬起后 `[1,8]`（含开标记），
  屏幕上就是 `**[X**xx]`。
- **「拖选时先别冒 `**`、松开再显示」**（第二十四轮定稿；第二十六 / 二十七轮两次修正触发条件）：鼠标
  **拖选**时，标记不跟着选区一起进/出，松开鼠标才按最终选区显示。口径是**只去墨、绝不改占位**，两条
  合起来保证「整个手势期间版面一个像素都不动」：
  1. **冻结显隐装饰**：`pressHeld` 期间插件 `apply` 直接返回旧装饰集（谁显形谁折叠在手势期间
     不再变），松开时用一个 `SET_PRESS` 空事务按最终选区重算一次。冻结是**按下即置位**的
     （版面/显隐必须从按下列松开全程不变，见下条历史），副作用正好是用户要的：**按一下不会把
     光标所在构造的 `**` 收起来**；
  2. **CSS 只去墨**：`.press-hidden .md-marker:has(> .md-reveal-inline) { color: transparent }`
     —— 已显形的标记看不见，但 `font-size: inherit` 与占位照旧（类挂在**编辑区根节点**上，
     由后代选择器匹配；不是逐个 `.md-marker` 挂类，那样会被 PM 重渲染冲掉）。
  ⚠️ **去墨的两个触发条件，缺一不可**（两次用户报障各修掉一个）：
  1. **指针在按住期间真的移动了**（`mousemove` 超过 4px，`PRESS_DRAG_SLOP`）——
     第二十四轮那版是「`mousedown` 即去墨」，用户实测报障：光标在构造内（页面上正显示着 `**`）
     时「在别处按一下」，一次**没有拖动的按下**也让这些 `**` 瞬间消失、松手又回来（闪动）。
     「按下会改变选区」不能当判据：PM 在 `mousedown`（捕获阶段之后）本来就会按落点写一次选区，
     那是「点一下」的固有动作、不是拖动；而**一次按下本身不改版面**（冻结），所以「按住期间保持
     可见」与「拖选期间不显示」可以同时成立；
  2. **按下点落在「此刻已显形」的构造里**（`pressOnRevealedRun`，第二十七轮）——
     只判「移动了」还不够：光标在 A 构造内（A 的 `**` 正显示着）时，在**别处 B** 按下并拖动，
     A 的 `**` 照样去墨消失、松手才回来。用户口径：**去墨只在按下点落在已显形的那个构造
     （标记文本或样式正文）里时才启用，按下点在别处一律不去墨**。
     判据在 `mousedown`（**捕获**阶段，早于 PM 按落点写选区）取一次：`posAtCoords` 的位置
     `pos` 落在某个构造的 `rs <= pos < re`（**半开**）且该构造在当前选区下已显形
     （判据与 `buildRevealDecorations` 逐字相同）。**为什么半开**：显隐判据宽松（两端都含）是
     为了让「紧贴构造两端」的光标也能编辑标记；而这里判的是「指针有没有按在这个构造的字符上」，
     按在收尾标记**右侧的空白**里属于「在别处按下」（正是这次报的 B 区场景），两端都含就会误判。
     代价：按在收尾标记**右半边**（`posAtCoords` 给到 `re`）也算「别处」⇒ 不去墨 —— 方向是
     **少去墨**，与「宁可少藏，不可误伤」一致。**为什么可以只用按下点判**：装饰在按下时被冻结
     ⇒ 手势里可见的标记只有「按下时已显形」的那几颗，拖动**不可能**让新标记冒出来（第二十四轮
     「拖选时别冒」正是靠冻结实现的）—— 于是去墨只对「手指本来就按在那个构造上」的拖选
     （同构造内 / 跨构造）有意义。
  验收：`tools/_verify-inline-formats.js` 的 L 段（按下不松 ⇒ `**` 仍有字色、宽度、位置，DOM 里
  仍是那两颗星；**在 A 内**按下并拖动 ⇒ 去墨）与 M 段（**在别处 B**（同段落 / 另一段落，含
  「同段还有一颗折叠构造」的边界）按下并拖动 >4px ⇒ A 的 `**` 仍可见且版面不动）、
  `tools/_verify-marker-hold.js`（构造内按下并拖动 ⇒ 去墨；松开 ⇒ 恢复；整个过程版面不动）。
  **任何改占位的隐藏都不行**：一行里标记的宽度会变（一对 `**` 是 15.5px），而浏览器判光标
  落点、以及 PM 在拖拽每次 `mousemove` 上重算坐标，都发生在「当时的布局」上 —— 布局一变
  落点就跑到别的字符。四条错路都实测过、都撤了：
  * **按下即同步折叠**（`font-size: 0`）⇒ 点加粗字内部落到后面的普通文字（`**X**xx` 点 x=321
    得 pos 7 而非 3）；
  * **延后一拍折叠**（`setTimeout(0)`）⇒ `**…**` 段落的**行尾点击**失灵（落点跑到段首）；
  * **第一次 `mousemove` 才折叠** ⇒ 折叠发生在拖动**中途**，锚点按展开布局、焦点按折叠布局，
    整段拖选塌成一个光标；
  * **`position: absolute` + `opacity: 0`（「零占位隐藏」）** ⇒ 只在标记**本来就折叠**时才不占位；
    光标已在构造内（标记已显形、各占 15px）时按下，标记一脱离流整行左移 15px，于是
    「点『地』」落到下一个字（实测 `**是同一个地方的两层**…` 点在「地」得 pos 8）——
    这一条是本轮补的钩子，`_verify-drag-selection.js` 的 F 段钉住。
  收尾同时听 `mouseup`/`pointerup`/`pointercancel` + 窗口 `blur`（拖到别的窗口松手也不会留在
  隐藏态）。纯观感：模型、落盘字节、选区语义、`.md-marker` 的折叠机制一个都不动。
- **~~行尾空白处的拖选终点补到块尾~~（`snapDragHeadToLineEnd`，本轮删除）**：这个兜底的判据是
  「鼠标在该行最后一个可见字符右边」，而那个右缘是量**元素**得到的 —— `domAtPos` 在节点边界上
  会返回父元素，量到的其实是**整幅纸**的右缘，判据**恒为真**：任何一次行内拖拽都被当成
  「拖到行尾」，选区被灌到段尾（钩子日志实测 `clientX=449, lastCharRight=759.97`，它就是用户
  报告里 `[7,30]` 的产物之一）。删掉后语义没有缺口：浏览器把「拖到文字右侧空白」的终点卡在
  最后一个可见字符之后，而对 `**X**` 这种「收尾标记紧跟在有样式正文后面」的形态，那个落点
  **正好**是收尾标记的起点，`expandOutsideMarkers` 的右侧规则自然把它补进来。
- **「按住指针期间折叠标记」的历史与最终形态**：第二十二轮加入（`mousedown` **同步**折叠
  `font-size: 0`）→ 第二十四轮先整体移除（因为它使**整行文字左移** 15.5px，而浏览器判光标/焦点
  落点是在这个处理器**之后**：`**X**xx` 光标在构造内时 `X` 在 [319.5, 331.4]，按下后左移到
  [304, 315.9]，在 x=321（`X` 内部）按下会落到右边的 `xx`，即 **pos 7 而不是 3**，拖选只选中
  `xx`；三路映射 `view.posAtCoords`、强制 reflow、`caretPositionFromPoint`+`posAtDOM` 全给同一
  个错值 —— 它们都在按折叠后的真实布局算，谁都没错，错的是「按下就折叠」）→ 本轮以
  **「冻结装饰 + 只去墨」**的形态重新引入（见上面那条）：观感回到用户口径，而因为
  **版面在整个手势里一个像素都不动**，上面那些落点/拖选问题都不再出现。
  ⚠️ 第二十六轮把「去墨」从「按下即置位」改成「指针真的移动之后才置位」：**按下就折叠**与
  **按下就去墨**是同一类错（都是「一次没有拖动的按下改变了屏幕」）—— 前者挪版面、后者闪字，
  用户都报了；现在「按下冻结（谁也不变）+ 拖动才去墨（不挪版面）」，两个诉求同时成立。
  ⚠️ 第二十七轮再补一条「按下点必须落在已显形构造里」（`pressOnRevealedRun`）：只判「移动了」
  还是会**误伤无关构造** —— 光标在 A 构造内时在别处 B 按下并拖动，A 的 `**` 照样去墨。
  两次报障的共性都是「**判据只看了手势本身，没看手势和那个构造有没有关系**」。
- **行尾点击落到「块内容末尾」**（`**…**|` 而不是 `**…|**`）：判据是**纯几何一条** ——
  指针在该行**最后一个可见字符的右缘以右**。要点四条：
  1. **量矩形、不量容器**：按文本节点取 `Range.getClientRects()` 片段（`font-size: 0` 的折叠
     标记矩形宽 0，天然不计入）。⚠️ 别用 `domAtPos(pos).parentElement` 再取元素的
     `getBoundingClientRect().right` —— 位置落在节点边界上时 `domAtPos` 返回的是整个 `<p>`，
     量到的是**整幅纸**的右缘，判据恒真/恒假（本轮正是它让修正对某些夹具完全失效）。
  2. **「这一行」按与指针的垂直距离取最近的一行**（归并同行的片段矩形），全程不需要阈值常量；
     并且**只有点的是最后一行**才算行尾 —— 换行段落点中间某行右侧，用户要的是**那一行的行尾**
     （= 折行处），无条件补到段尾是错的。
  3. **落点取文本块内容末尾**（所有折叠标记之后），不是「可见文字之后」——
     用户看到的那点空白其实是「标记之后」，用户口径就是 `**…**|`。
  4. **同步判、延迟落**：判据必须在**点击当时的布局**上量（松手即解除按住隐藏、整行会左右移动）；
     落点必须在 PM 自己的 MouseUp 处理**之后**再写一次 —— 否则被它按折叠布局算回
     收尾 `**` **之前**（实测：点行尾空白时 `view.posAtCoords` 给出块尾 20，
     最终光标却停在 18）。
  ⚠️ 本项第一版**从没生效过**：守卫里写着 `if (found.pos >= end) return false`，而点行尾空白时
  `posAtCoords` 恰好给出块尾 —— 唯一需要修正的情形被这条守卫全挡掉；
  `_verify-round-24.js` 的 D 段还把**旧行为**（`contentEnd - 收尾标记长度`）当成了期望值
  （标注写「收尾标记之后」，算的是之前）。用户第五个报告（`**不给眼睛亮起来的机会**|`
  实际停在 `|**`）追到的就是这个。现在由 `tools/_verify-line-end-click.js`（7 条）钉住：
  末尾加粗的一行点行尾 ⇒ 块内容末尾；点最后一个可见字右半边 / 行中间字符 / 换行段落中间行
  都不被抢走。

**联动调整**：StarterKit 的 bold/italic/strike/code 以「安静版」注册（关闭输入规则与快捷键，mark 类型保留供解析）；工具栏改用 `toggleMdBold` 等新命令；`Ctrl+B/I/Shift+X/E` 快捷键接管。验收：`bold-marker-reveal/boundary/hide-on-exit/no-layout/boundary-left`（隐藏态零占位 + 光标边界显隐）、`roundtrip-markdown`（源码零转义往返）、`paste-heading-no-bold`、`boundary-type-start/end-keeps-bold/fold-back-bold`（G 阶段，构造边界打字不失粗）、`ctrl-click-plain-caret/plain-click-unchanged`（H 阶段，Ctrl+点击普通光标）、`link-plain-click-expand/link-auto-collapse/link-ctrl-keeps-link`（I 阶段，链接点击交互，§4.15）、`marker-enter-italic-live/backspace-join-no-purple-relift/bold-survives-after-merge`（J 阶段，标记内回车→斜体实时化/段首退格合并，§4.13）等 89 项全绿。

**补丁：标记内回车 → 段首退格合并（本次，J 阶段）**：`**5*|*` 回车字面量切段后再按 Backspace，此前本版 prosemirror-commands 的 `joinBackward` 要求光标真正在文本块内部，而 Enter/归一化常把光标留在**块边界（depth 0）**位置，join 失效 → 落到 `selectNodeBackward` 把上一段做成 NodeSelection（`.ProseMirror-selectednode` 紫色整选框）；即使后续拼回 `**5**`，两侧字面量标记也会永远停在可见字面量、须刷新才恢复。修复（三处，非硬编码）：
1. `typoraInlineMarks.ts` 新增 **reLiftLiteralPairs（字面量配对重提升）**：`side:'literal'` 只是"当时不成对"的过渡态——一旦两侧字面量标记在编辑/合并后重新围住无样式正文（整窗文本与完整构造模式吻合），立即还原为 start/正文 mdStyle/end，与任何输入/合并路径通用；
2. `keymap.ts` 段首/段间边界 Backspace（及对称 Delete）显式 `tr.join` 相邻同型段落，并把光标设到两段拼接缝，不再让 PM 走 selectNodeBackward；
3. `pointer.ts` 增加 **filterTransaction 护栏**：任何事务若要把文本块（段落/标题等）设为 NodeSelection，一律降级为文本光标（节点级整选只保留给图片等叶子）——紫色段选框从机制上不可能出现。

**补丁：整选逻辑整体取消（第二十二轮）**：用户要求「去掉 `.ProseMirror-selectednode` 外层的紫色边框，且取消这个选中的逻辑」。原先护栏只覆盖**文本块**，图片这类叶节点仍会被 PM 做成 `NodeSelection` 并套上主题色描边，于是紫色框仍有来源。现在 `filterTransaction` 把**任何** `NodeSelection` 都降级为 `TextSelection.near(pos, 1)`：点图片落到图片旁边的文本光标，选中态只有文本选区这一种。CSS 里 `.ProseMirror-selectednode { outline: none }` 一并保留为兜底（正常路径下该类不再落地）。删除图片仍按 Typora 习惯：光标落在图片一侧按 `Backspace`/`Delete`。验收见 `tools/_verify-round-perf.js` A 段（`selection` 不是 `NodeSelection`、文档里 `0` 个 `.ProseMirror-selectednode`、图片 `outline` 为 `none`、降级后仍能正常打字）。

**补丁：源码权威重推，实时渲染与刷新语义对齐（本次）**：用户复现出斜体同样滞后（`*5*|` 无法删到 `*5`；`**5**` 在结束标记两星之间回车后，首行 `**5*` 的 5 应实时显示斜体——按 markdown-it，`**5*` = 字面 `*` + 斜体 `5`，此前要刷新才出现）。根因：归一化只是“启发式配对/字面量化”，与 markdown-it 对**边缘源码**（不成对、劈裂、删除收尾）的解析语义不一致。修复（非硬编码）：
1. **复用同一条解析管线**：`typoraInlineMarks.ts` 新增 `resolveBlockContent` + `parseInlineHtml`——对含 `*~`` 的纯行内文本块，把其原文（标记文本即源码真值）喂给 tiptap-markdown 的 markdown-it parser（与加载/刷新完全同一引擎），解析结果经同一归一化转成标记模型；差异才替换（稳定态零开销），解析不可用回退原启发式。于是 `**5*` 实时即 字面`*`+斜体5、`*5**` 对称同理、`*5` 删尾后按字面量显示；
2. **零转义保持**：`literalizeStrayMarkers` 把解析产物中“未被样式消费”的裸 `*~`` 包成 mdMarker(literal)（escape:false），否则普通文本里的 `*` 会被 markdown 写出器加 `\`（`**5*` → `\**5*` 源码漂移）；
3. **删除收尾不再自动补齐**：删掉 `*5*` 的收尾 `*` 后按源码真值落为字面 `*5`（可继续删除），而不是引擎擅自把缺侧标记补回。
验证：原生键 CDP（删除到 `*5` 无转义；回车即斜体）+ 打字回归（逐字 `**5**`/`*5*` 最终正确零转义）+ J 阶段断言更新，89/89 全绿。

**补丁：字面量语义落地 ×3（本次）**：① **逐字符打字成样式**——打字识别正则（`typoraInlineMarks.ts` PATTERN/PATTERN_TEST）单星分支加 lookaround `(?<!\*)\*([^*\n]+?)\*(?!\*)`，杜绝输入 `**5**` 到中途 `**5*` 时把 `*5*` 误切为斜体（残星 + 序列化 `\*` 转义）；逐字输入 `*`,`*`,`5`,`*`,`*` 的最终产物为粗体 `**5**`、源码零转义。② **标记内回车字面量切段**（见上方坑位 6）。③ **行首粘贴不裂段**——光标位于构造起点（`|**5**`，pos=run.start）或文档首段边界（pos 0）粘贴内联文本时，PM 把插入合并进当前段落、归一化容错，得到同段 `2**5**`（不再出现 `2\n**5**` 两段）。验证：CDP 实测脚本（`tools/probe-three.js`，验证毕移除）三项断言全过 + 全量矩阵 77/77 全绿。

**补丁：构造边界打字不失粗（本次）**：光标落在粗体 `**5**` 的构造起点打字 `2`，此前因 mdMarker 继承粘连（坑位 7）导致整段字面量、渲染失粗、刷新才恢复；新增 `repairPollutedMarkers` 拆回普通文本后，起点/终点打字均保留粗体（`2**5**`、`2**5**3` 且 `strong` 内容为 `5`），光标移出折叠为纯粗体。验证：`tools/probe-boundary-type.js`（临时探针，验证毕已移除）三场景全过 + 矩阵新增 G 阶段 3 项断言，80/80 全绿。

### 4.14 鼠标语义：Ctrl/Cmd + 左键 = 普通点击（本次）

prosemirror-view 内置 `selectNodeModifier`（Win: `ctrlKey` / Mac: `metaKey`）：按住修饰键左键点击时，PM 在 `mousedown` 捕获该状态，`mouseup` 时经 `selectClickedNode` 把光标所在**最小可选中块**（段落/标题等文本块）做成 `NodeSelection` 整选，DOM 上整块套 `.ProseMirror-selectednode`（CSS 为主题色 outline 全选框）——Typora 没有这套逻辑。修复（`pointer.ts` → `TyporaPointer`，注册于扩展集）：在 **`mousedown` 阶段**拦截（PM 的 selectNode 状态在 mousedown 即被捕获——若用户先松开 Ctrl 再松鼠标，mouseup 时判断修饰键会漏网，mousedown 拦截才是确定的），`preventDefault` 掉浏览器默认行为后**退化为普通点击**：`posAtCoords` → `TextSelection.near` 把光标放到点击处。仅拦截 Ctrl/Cmd+左键，普通单击（含图片等节点的常规选中）、双击/三击选择均不受影响。验收（H 阶段）：`ctrl-click-plain-caret`（折叠 TextSelection 落在段落内、无 `.ProseMirror-selectednode`）、`plain-click-unchanged`。

### 4.15 链接交互：普通点击展开源码 / Ctrl+点击用浏览器打开（本次）

Typora 官方行为（support.typoraio.cn/Links/）：**Ctrl/Cmd+点击**链接跳转（网页/本地/应用），**普通点击**不跳转，而是把该链接原地展开为可编辑的 Markdown 源码 `[文字](网址)`。Lumin 实现（`pointer.ts` → `TyporaPointer` + `LinkSource` 标记）：

- **Ctrl/Cmd + 左键点击链接** → 交宿主注入的 `onOpenLink`（`pointer.ts` 的 `TyporaPointer` 选项；应用内为 `lib/linkOpen.ts`：网址→系统默认浏览器、同级文件名→新窗口、相对/绝对路径→默认应用，目标缺失时询问是否新建，详见 §4.17）；非链接处仍为 §4.14 的普通光标落点；
- **普通左键点击链接** → 展开：**不整体替换成纯文本**，而是把原 label 上的 link mark 换成 `linkSource(part:'label')`（**保留其内 mdStyle/mdMarker 等标记**，各 mark 序列化 open/close 为空 → 输出仍是原 label 字符），两侧补 `linkSource(part:'syntax')` 的 `[` 与 `](网址)`——效果：**原文标签保持链接外观**（主题色 + 下边框，CSS `.md-link-source` 与 `.md-preview a` 一致）、**新增的括号与网址以浅灰呈现**（`.md-link-syntax` = `--ink-3`）、源码往返恒等；
- **不自动选中、光标停在点击处**：展开前先把光标落到点击位置（mousedown 内 preventDefault 会阻止 PM 落光标，须先 `setSelection` 再展开），展开事务本身不 setSelection，PM 把光标按步骤映射进 label 的相对偏移——点到哪光标就在哪；
- **自动折叠**：光标移出展开区（appendTransaction 判定）、按 Esc、编辑器失焦 → 解析展开区整体文本 `[label](url)` 以 link mark 重建 label（内部 `**` 等由派生归一化还原）；改残则不还原、仅去掉 linkSource 标记保留原文；
- **联动归一化**：`typoraInlineMarks` 的 toAtoms/blockNeedsNormalize 把 linkSource 文本视为**不透明**（否则展开源码里的 `**` 会被派生归一化误转为样式标记）。

关键坑位：PM 的 mark 渲染必须有 `toDOM`（tiptap `renderHTML`）——缺省会抛 `mark.type.spec.toDOM is not a function`：事务已进 state（选区/文档都对）但 **DOM 构建中断**，视图停在旧 DOM，形成「状态已展开、界面仍是链接」的失同步；且**不能在 mousedown 事件回调里同步 dispatch**（实测 DOM 不随事务重建），须 `setTimeout(0)` 延后派发；parseHTML 需还原 `span.md-link-source`/`span.md-link-syntax` 避免 DOMObserver 回写循环。验收（I 阶段）：`link-plain-click-expand`（锚点消失、源码可见、label/syntax 双形态存在、光标折叠不选中、md 不变）、`link-auto-collapse`（光标移出折叠还原）、`link-ctrl-keeps-link`（Ctrl+点击不展开）。

### 4.16 设置中心（模态浮层）与系统级设置项（本次）

设置从「占用整页的路由视图」重构为 **Teleport 模态浮层**（`components/SettingsDialog.vue`，挂载于 App 根，z-120 遮罩 + 居中面板 + 左导航分组 + 右侧滚动内容），提供 **X 按钮 / Esc / 点击遮罩** 三种关闭方式，打开时不离开当前文档上下文；面板入场淡入微弹，关闭即时（本版 Teleport 内层 Transition 的 leave 卸载偶发残留，故采用即时显隐 + 入场动画）。入口统一走 `ui.openSettings()`（工具栏齿轮、侧边栏底部、菜单「设置」Ctrl+,），不再使用 `/settings` 路由。

新增/重构的系统级设置（均经 settings store → `settings:update` → **SQLite kv 持久化**，非 session）：
- **顶部菜单栏（`nativeMenuBar`，默认开）**：采用**应用内菜单栏 `TopMenuBar`**（VS Code 式，位置由 DOM 精确摆放、Alt+F/E/V/H 必达、菜单项与原生菜单同源动作）替代系统原生菜单条——主进程隐藏系统菜单条（`setMenuBarVisibility(false)`）避免双开/错位，应用菜单仍安装以保留 Ctrl+N/O/S 等加速键；`nativeMenuBar` 关闭时仅隐藏该菜单栏（快捷键仍可用），设置经 SQLite kv 持久化。
- **自动保存（`autoSave`，默认开）**：已有持久化字段；新增关闭时 `files.cancelAutoSave()` 取消**未触发的磁盘定时器**（草稿崩溃保护仍写）。状态栏左侧保存状态区为**入口按钮**：点击弹出**竖向选择菜单（自动保存 / 手动保存 + 打开设置…）**，选中即切换并持久化；切到手动保存时状态区文字显示 **「未开启自动保存」——不加强调色（沿用底部状态栏默认文字色）、且不显示前置状态圆点**。
- **排版与空白（`whitespace`，默认全开）**：编辑/导出两个维度分别控制「保留连续空格」「保留单个换行」——编辑维度经 `data-preserve-spaces/breaks` + CSS（段落 `pre-wrap`、软换行 `<br>` 显隐）实时生效；导出维度在导出 HTML/PDF/Word/EPUB 时叠加 `white-space: pre-wrap` 与 `<br>`→空格 策略。说明：连续回车产生的**空段落**属 Markdown 块级语义，打开/保存按规范合并为单个分段空行（主流引擎与 Typora 一致）。
- **多语言（i18n）**：基于 vue-i18n 的解耦架构，语言目录为纯 JSON 数据：`zh-CN` / `en-US` / `ru-RU`（俄文）三套全量键；新增语言 = 新增 `locales/{locale}.json` 并在 `i18n/index.ts` 的 `messages` 与 `Language` 联合类型登记（`LANGUAGE_OPTIONS` 自动驱动设置面板语言选择与状态栏快捷循环）。`settings.language` 经 SQLite kv 持久化，`document.documentElement.lang` 同步。已有 i18n 键位的界面（编辑区、工具栏、侧栏空态、设置面板等）随语言即时切换；存量硬编码文案按模块增量迁移中。
- **PDF 导出（优化）**：隐藏窗口 + 真实 Chromium 排版引擎渲染后 `printToPDF`；**等待 `document.fonts.ready` 与一次渲染帧稳定后再打印**，杜绝空白/缺字/未分页；按设置注入 A4/A5/Letter 与页边距、`printBackground`；失败时清理半成品文件并向上抛错（渲染层 Toast 提示）。

验收：CDP 实测浮层 开→X 关、开→Esc 关、原生菜单栏开关状态持久化回读、autoSave 开关持久化、语言三态切换与 `ru-RU` 持久化、`openTopMenu` IPC 无异常；全量矩阵 89/89 全绿。

### 4.17 链接目标解析与打开策略（本次）

§4.15 只区分了「是不是链接」，Ctrl/Cmd+点击一律丢给 `shell.openExternal`——于是 Markdown 里极常见的 `[下一篇](notes.md)`、`[资料](./assets/spec.pdf)` 这类**本地目标点不动**（`openExternal` 只认 http/https）。本次把「打开链接」升级为**分类解析 + 按需创建**的完整流程：

| 链接形态 | 判定 | 打开方式 |
| --- | --- | --- |
| `https://…`、`http://…`、`mailto:…` | `url` | 系统默认浏览器 / 邮件客户端 |
| `notes.md`（不含量分隔符） | `file`（相对**当前文档所在目录**） | **Lumin 新窗口**打开（`app:openInNewWindow`） |
| `./a/b.md`、`../x` | `relative` | 系统默认应用（`shell.openPath`） |
| `C:\a\b`、`\\server\share`、`/home/a` | `absolute` | 系统默认应用 |

- **目标不存在 → 询问是否创建**：询问**融合进编辑区上方的通知带**（像 Typora 一样直接在上面展示内容，**不是一个长方形卡片**，也不展示级别图标/级别名；带「创建并打开 / 取消」按钮，不弹模态、不打断写作，答完自动收起；同一目标只占一条通知）。策略可由 **设置 → 链接 → 目标不存在时** 三态控制：总是创建 / 每次询问（默认）/ 从不创建；父目录缺失会一并 `mkdir -p`。链接以分隔符结尾（`./notes/`）判定为文件夹，否则为文件。
  - 实现要点：通知表新增 `actions` / `payload` 两列（JSON 文本，旧库走 `ALTER TABLE` 升级），因此**按钮与负载随通知一起持久化**；点击时按 `payload.kind` 找渲染层注册表（`lib/notificationActions.ts`）里的处理器执行，不会出现「按钮还在、逻辑没了」的死按钮。负载只存「原始链接 + 当时的基准目录」，处理器会**重新解析**——等待期间文件若已被别处创建，会直接落到「打开」分支。
- **非文本目标不凭空创建**：`.png`/`.pdf` 之类已经存在时交系统默认应用；不存在时直接提示「该类型的文件无法新建」——造一个空的二进制文件没有意义。
- **安全**：`shell.openExternal` 只放行 http/https/mailto 白名单（任意 scheme 交给系统处理器是历史上的高危面，如 `javascript:`、`ms-msdt:`）；分类前先排除 Windows 盘符（`C:\x` 会被 `new URL()` 误判成 scheme `c:`）；创建文件用 `flag: 'wx'`——**绝不覆盖**已有内容。`file://` URL 先 `fileURLToPath` 再按路径规则处理。
- **持久化（SQLite，非 session）**：`link_history` 表以链接文本为主键 upsert（`kind / resolved_path / action / created_entry / count / created_at / last_used`），记录每一次打开、以及「放弃创建」；设置项 `linkCreateMode` 落在 `kv.settings`。**设置 → 链接**页签可查看历史（含类型/动作/次数/时间徽章）、逐条删除、一键清空（完整 CRUD）。
- **解耦**：主进程 `services/links.ts` 只做「分类 + 路径解析 + 探测/创建」，**不打开任何东西**；打开动作由渲染层 `lib/linkOpen.ts` 编排（确认弹窗、通知、落库都在 UI 层）。编辑器内核不依赖任何 store——`TyporaPointer` 暴露 `onOpenLink` 选项注入（默认实现仅开浏览器），`buildEditorExtensions({ onOpenLink })` 在 `TyporaEditor.vue` 里接上应用逻辑。

验收：`tools/_verify-link-open.js`（真实文件系统 + 真实新窗口 + 直读 SQLite）：分类矩阵、缺失目标「是/否」两条分支、创建后打开、协议白名单拒绝、非文本不创建、历史 CRUD 与落盘。

### 4.18 会话恢复：重启回到上次的文档与位置（本次）

此前每次启动都停在欢迎页——写作工具里这是最容易被吐槽的一处（Typora/VS Code 都会回到上次的位置）。本次按「一窗一文档」的既有模型做**每窗口会话**：
- **记录什么**：`{ path, pos, len, scrollRatio }`。位置不用 scrollTop 而用**滚动比例**、光标除 PM 位置外还带上当时的文档长度——文件被外部改过、窗口大小/字体/主题变了，也能按比例落到同一处（与 EditorView 视图位置记忆同一套思路）。
- **存在哪**：SQLite `kv.session = { slots: [SessionSlot|null] }`，按**窗口槽位**索引存放。主进程在创建窗口时分配槽位（`--lumin-session-slot=N` 走 additionalArguments，preload 解析），启动时按槽位重建：几个窗口就是几份上下文，各自恢复各自的文档（上限 5 个，避免窗口风暴）。显式 `--lumin-open` 的窗口优先打开指定文件，不参与恢复。
- **谁动槽位**：渲染层只管写；主进程在窗口 `closed` 里分两种情形处理 —— **单独关窗**保留槽位并标记 `closed`（下次启动若没有别的窗口「活着退出」就恢复它，见 §4.45），**整体退出**（`before-quit` / 菜单退出 / 系统关机）原样保留，下次启动把当时活着的窗口全部恢复。
- **写入时机**：文档切换、光标移动（`ui.cursor`）、滚动（window 捕获阶段，容器重建也无需重绑）→ **800ms 节流**写一行 kv；关键路径补刀：关窗前（`app:before-close` 里 flush）、`pagehide`、切到后台。
- **开关**：设置 → 通用 →「启动时恢复上次会话」（`restoreSession`，默认开）。关掉后启动直接进编辑器（空白未命名缓冲区）——注意语义：会话记录的是**当前状态**，关着的时候该窗口的会话就被写成「无文档」，这与主流行为一致。
- **降级**：恢复的文档已不存在（被移动/删除）→ 通知中心告警一条，不阻断启动；未命名缓冲区不进会话（其内容本就由草稿机制保护，避免两套恢复逻辑打架）。

验收：`tools/_verify-session.js`（真实 reload 触发完整启动流程 + 直读 SQLite）：槽位分配、路径/光标/滚动落盘、reload 后三者精确恢复、开关两向、文件丢失告警、单独关窗保留槽位并标记关闭；另做了**真·杀进程重启**复核（窗口数、文档、光标 1168/保存值 1166、滚动 0.5 全部对上）。

### 4.19 去掉欢迎页，能力重排到三个入口（本次）

Lumin 是写作工具，没有文档时就该是一篇空白稿纸——Typora、iA Writer、Bear 都没有欢迎页。会话恢复（§4.18）之后，欢迎页更只在异常路径出现（首启、用户关掉恢复、上次没开文档、文档丢失），专门为它维护一个路由 + 一套 hero 样式不划算。于是：

- **删除 `views/WelcomeView.vue`**，`/` 一律重定向到 `/editor`：没有文档时 `EditorView` 挂载即建空白未命名缓冲区，「无文档」从此只有一种表现，异常降级也走同一条路（不再有「欢迎页 / 空编辑器」两种空态）。
- **能力重排到三个已有一等入口**（这才是关键，删页面不等于删能力）：
  1. **侧栏空态**（`FileTree.vue`，未打开工作区时）：三个入口按钮 + 快捷键提示——原来欢迎页「这是什么应用、能干什么」的作用由它承担（后来按 §4.24 精简为一行图标按钮）；
  2. **侧栏头部「最近文档」按钮**（`SidebarRecentButton.vue`，当时新增，位于「新建文件」**左侧**）：点击展开最近文档下拉（固定优先 + 按时间倒序，行内可 固定/取消固定/移除 + 清除记录）。
     ⚠️ **已在 §4.79 删除**：侧栏头部整行去掉（文件夹改为目录树的顶层节点），最近文档只保留下面第 3 条的「文件 → 最近文档」二级菜单；组件文件 `SidebarRecentButton.vue` 同时删除（零引用）。
  3. **顶栏「文件」菜单**：原有「新建文档 / 新建窗口 / 打开文件 / 打开文件夹」保持不变，新增两个**一级项 + 悬停二级菜单**——`最近文档 ▸` 与 `最近文件夹 ▸`（`SubMenu` 类型 + `RecentList.vue` 共用组件）。
- **最近文档 / 最近文件夹 → 一律在新窗口打开**（`openInNewWindow` / `openFolderInNewWindow`）：当前窗口的文档与工作区完全不受打扰，因此**不再需要脏数据确认**。为此把窗口创建参数收敛成 `WindowOpenOptions { openFile?, openFolder?, sessionSlot? }`，新增 `--lumin-open-folder=<dir>` 启动参数：新窗口以该文件夹为工作区（空白文档，等用户点开文件）。会话槽位（§4.18）随之扩展出 `folder` 字段——「只开着文件夹」的窗口也能在重启后回来；`planRestore()` 现在同时接受「有文档」与「有文件夹」的槽位。
  （已知边界：`workspace.root` 是**全局** kv 值，所以在一个窗口里换文件夹会影响其它窗口的下次初始化；每窗口独立工作区是后续可做的一步。）
- **二级菜单实现**（`TopMenuBar.vue`）：一级行悬停 → 右侧浮层（贴死左侧面板、重叠 1px），指针移出后 **160ms 宽限**再收起、进入浮层即撤销 —— 与编辑器右键菜单同一套「悬停意图」思路，避免「怎么都移不到二级上」；右侧放不下自动翻到左侧；Esc 先收二级再收一级。二级内容由插槽渲染（`slot: 'recentFiles' | 'recentFolders'`），列表与行内操作全部复用 `RecentList.vue`。
- **浮层关闭条件抽成公共判断**（`lib/popoverClose.ts`）：`shouldCloseOnScrollOrResize(e, ...panels)` —— **浮层内部滚动不关闭**、外部滚动与缩放才关闭。此前「滚动即关闭」的监听挂在 window 捕获阶段，而列表自带滚动条，滚动它同样会冒到 window，于是「菜单里有滚动条却滚不动，一滚就消失」；浮层经 Teleport 挂到 body，判断「是否在内部」必须显式传元素而非靠 DOM 祖先关系。侧栏最近文档下拉、导出菜单、表格选择器、代码块弹层统一改用它（编辑器右键菜单里原本就是同一套逻辑）。
- **新增持久化字段 `recentFolders`**：打开文件夹（`files.setRoot`）时记一笔（去重 + 置顶，最多 12 条，落 SQLite kv）；列表展示时并入「当前工作区」，避免历史用户看到空列表。
- **工具栏不再有「打开」按钮**：同一能力不在工具栏、侧栏、菜单三处重复；打开文件仍走菜单 / `Ctrl+O` / 侧栏空态。
- **i18n 收敛**：`welcome.*` 命名空间整体退场——`searchPlaceholder` 迁到 `common.*`（全局搜索在用），其余文案迁到新的 `open.*`（复用既有译文，新增 `recentFolders/emptyFolders/clearFolders/pin/unpin/removeRecent/hint`）；三语言键集合保持一致（顶层与各命名空间均校验过）。
- **顺带清掉**欢迎页里的「未保存草稿恢复卡」：`openUntitled()` 本来就会把草稿挂到编辑器的草稿提示上（当时是横幅，后来改成**独立强制弹窗**，见 §4.74），同一能力不再有两处实现；`/about` 仍承担版本、技术栈等信息面板的角色。

验收：`tools/_verify-welcome-removed.js`（无会话启动落在编辑器 + 侧栏空态三入口 + 工具栏分裂按钮的最近文档/固定/清除 + 文件菜单含最近项）。

### 4.20 通知按窗口隔离（本次）

**问题**：在任一窗口保存文件产生的提示，会在**所有窗口**同时弹出——通知表是全局的，而且主进程每次变更都 `BrowserWindow.getAllWindows()` 广播一遍，于是「A 窗口的提示」变成了「每个窗口都有的提示」。

**根因**：主进程能力（IPC handler、SQLite、广播）天然是所有窗口共享的，渲染进程又无法自证身份。Electron 没有「这个状态属于哪个窗口」的原生答案，必须自己建一层**窗口身份**。

**方案（最小且主流）**：给通知加**窗口作用域**，作用域由主进程从 IPC 发送方反查，渲染层既不传也传不了。

- **窗口身份**（`src/main/services/windowScope.ts`，新增）：`window.id → w<会话槽位>`，创建窗口时 `bindWindowScope(win, slot)` 登记、`closed` 时自动注销；`scopeOfSender(event.sender)` 用 `BrowserWindow.fromWebContents` 反查。选**会话槽位**而不是 `webContents.id`：槽位是本项目里唯一**跨启动稳定**的窗口身份（§4.18 按槽位重建窗口），这样「窗口 A 没处理完的提示」重启后仍回到窗口 A，而不是变成孤儿行或串到别的窗口。没有槽位的窗口退化成一次性随机作用域——底线是「宁可各自独立，不可互相串台」。
- **存储层**（`services/database.ts`）：`notifications` 新增 `scope TEXT NOT NULL DEFAULT ''` 列（旧库 `ALTER TABLE` 升级；升级时把 `scope=''` 的历史行一次性删掉——它们是「全局共享」时期的产物，无法归属，留着只会在所有窗口都查不到却永久占表）。索引换成 `(scope, closed_at, created_at DESC)` 并删掉被它覆盖的旧索引。`add/list/update/close/closeAll/remove/clearClosed/prune` **全部带 scope 条件**，连 `mergeKey` 去重与「每窗口保留 200 条」的裁剪也按作用域各自进行——不会出现「另一个窗口的同名提示把我的卡片顶掉」。
- **IPC 层**（`src/main/ipc.ts`）：每个 handler 用 `scopeOf(event)` 取作用域；变更信号由「广播给所有窗口」改成**只回给发起窗口**（`event.sender.send('notifications:changed')`）。
- **生命周期**：通知随窗口存在。窗口被**单独关闭**（非整体退出）时，除了把会话槽位标记为「已关闭」（§4.45，不清内容），同时 `deleteNotificationsByScope` 清掉它的通知；新窗口领到槽位时（`claimFreshSlot()`）也先清一遍该作用域——槽位被复用时不会把上一任窗口的提示带给新窗口。整体退出（`before-quit`）保留，交给下次启动按槽位恢复到同一个窗口。
- **渲染层零改动**：`stores/notifications.ts` 的调用签名与数据流不变（store → IPC → SQLite，UI 只读 store），只是语义从「全局通知中心」变成「本窗口通知中心」——解耦的好处在这里体现：隔离完全落在主进程一侧，UI 不知情也不需要知情。

**边界与取舍**：① 升级瞬间，旧库里未关闭的全局通知会被丢掉一次（无法归属到窗口，且多为一过性的「已保存」）；② 每个窗口的未读提示不跨窗口汇总——这正是本次要的行为；③ 槽位索引在单次运行内只增不减（`releaseSlot` 未被调用），因此作用域清理主要覆盖「关窗即清」与「重启后复用槽位」两条路径，`claimFreshSlot()` 的清理是后者的安全网。

验收：`tools/_verify-notify-multiwindow.js`（新建临时窗口 A/B/C，全程不碰用户窗口）：A 的通知**不出现在 B**、DB 行的 `scope` 等于 A 的槽位、同 mergeKey 只在各自窗口内合并、`closeAll/clearClosed` 只作用本窗口、关窗后该作用域行被物理清掉、新窗口干净且各占独立槽位、用户已有窗口快照前后一致；`tools/_verify-notify-disk.js` 直读 `lumin.db` 核对 `scope` 列/索引/行内容/软关闭/关窗清理；`tools/_verify-notify-restart.js`（两阶段，中间由外部硬杀进程 + 重启）核对「重启后按槽位恢复到同一个窗口，且那条通知只回到这个窗口」。

### 4.21 启动速度优化（本次）

**方法论**：先测量再动手，所有结论都以生产包（`npm run build` + `electron .`）的实测数字为准，dev 数字不作为依据。

- **打点**：主进程 `LUMIN_STARTUP_LOG=1` 时输出 `[startup] app-ready / ipc-registered / first-window-created / first-window-loaded / remaining-windows-created / first-window-painted`（含 `t+ms` 与 `process.uptime`）；渲染层统一 `performance.mark('lumin:*')`（`boot-start / settings / shell / files / editor-mounted / doc-visible / idle-tasks-started / notifications / editor-menu`），零开销、DevTools Performance 面板可见。基准脚本 `tools/_startup-bench.js <label> [轮数]`：从 spawn 进程起算，逐窗口记录「窗口可见」（`document.visibilityState` 变 visible）与「文档可用」（编辑器挂载且骨架屏退场），复用单个 CDP 连接轮询以避免测量噪声。

**实测（同一脚本 3 轮中位数，生产包，2 个窗口）**：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 首次内容绘制 FCP | 668 ms | **280 ms** |
| 窗口可见（`show()`） | 386 ms | 376 ms |
| 文档可用（首个窗口） | 1151 ms | 1120 ms |
| 文档可用（全部窗口） | 1157 ms | 1136 ms |

**改了什么**：

1. **首帧骨架屏内联进 `index.html`**（纯 HTML/CSS，不用 JS，中性半透明灰因此适配明/暗/羊皮纸主题）：窗口出现时立刻是「应用骨架 + 呼吸的 LUMIN」，Vue 挂载时整棵 `#app` 子树被替换。这是 FCP 从 668ms → 280ms 的原因——首帧不再等模块脚本执行 + Vue 挂载骨架组件。
2. **渲染层启动链路重排**（`renderer/src/main.ts`）：主题/语言 + 本窗口要打开的文档留在关键路径上；通知中心与右键菜单「最近使用」的 hydrate 改到 `requestIdleCallback`（它们只影响顶部通知区与菜单次要分区），并且不再互相串行等待。
3. **多窗口会话恢复错峰创建**（`main/index.ts` + `services/session.ts`）：`planRestore()` 改为按 `savedAt` 倒序（**用户最后停留的窗口排第一**），首个窗口先建、等它 `did-finish-load` 后再建其余（兜底 1.5s），避免 N 个渲染进程同时抢 CPU/磁盘。
4. **主进程初始化顺序**：`registerIpc()` 保持在窗口之前（渲染层启动即发 IPC），`installMenu()`（原生菜单）挪到窗口创建之后——它不影响首屏。
5. **dev 侧预打包与预热**（`electron.vite.config.ts`）：`optimizeDeps.include` 列出真实用到的 specifier（含 `@tiptap/pm/*` 这类子路径，只写根包名覆盖不到），`server.warmup.clientFiles` 预热首屏链路，消除首次进入编辑器时 "new dependencies optimized, reloading" 造成的二次加载。

**测量后被否掉的两项**（记录在此，避免以后重复踩）：

- **惰性化 SQLite 单例**：实测「打开 + PRAGMA + 全部 `CREATE ... IF NOT EXISTS` + `table_info` 检查」在真实库（1.6MB，含 FTS trigram）上只有 **~1.5ms**，不值得为它改结构 → 放弃。
- **`manualChunks` 手工拆包**：拆出 `vendor-vue/editor/code/diagram` 后 Rollup 报 `Circular chunk`，并且把**只被动态 import 的 mermaid（4.9MB）提到了首屏 `modulepreload`**——首屏载荷反而暴涨，启动更慢 → 已回退，保留 Vite 默认的「按动态 import 边界拆包」（编辑器仍是懒加载 chunk，mermaid/katex 按需加载）。

**剩余瓶颈（优化后首个窗口的自身时间轴，相对 navigationStart）**：模块解析执行 → `boot-start` ≈225ms（首屏 chunk ~935KB，其中还夹着一部分 ProseMirror：`lib/session.ts` 顶层 `import { TextSelection } from '@tiptap/pm/state'`）→ `shell` ≈95ms（settings IPC + Vue 挂载）→ `files` ≈25ms → `editor-mounted` ≈20ms → `doc-visible` ≈250ms（EditorView chunk 1.9MB 的加载/执行 + ProseMirror 文档构建与首帧，其中 CodeMirror 6 与 `@codemirror/language-data` 是静态导入）。**下一步的正确做法是「减字节」而不是继续重排**：把 CM6 从编辑器 chunk 里拆成按需加载（只含代码块的文档才付这份成本，用 `_verify-cb-*` 系列套件兜底），以及把 ProseMirror 从首屏 chunk 里请出去（session 里的 `TextSelection` 改为惰性获取）。这两项都会改变编辑器内部加载时序，属于独立改动 + 独立验收，本次不做。

**回归验收**：`_verify-session.js` 16/16（含槽位与光标/滚动恢复）、`_verify-welcome-removed.js` 34/34、`_verify-notifications.js` 30/30、`_verify-editor-menu.js` 全 PASS、`_verify-link-open.js` 62/62、`_verify-notify-multiwindow.js` 21/21、`_verify-notify-restart.js` 6/6（错峰创建后仍按槽位恢复，且通知只回到原窗口）、`_verify-alt-menu.js`（Alt+F 仍由应用内菜单接管，原生菜单条不拦截）；`npm run build`（含 `typecheck` 双工程）与 `eslint` 均零错误。

### 4.22 窗口标题跟随打开的文档（本次）

**问题**：多窗口时 Windows 任务栏把每个窗口列成一项，而所有窗口的标题都是「Lumin」——最小化后想把某个文档调出来，只能一个个点开看，等于没有窗口切换能力。

**方案**：标题跟随本窗口打开的**文件**（Typora 是 `文件名 - Typora`，VS Code 是 `● 文件名 - 文件夹 - 应用名`，同一套主流做法）。新增 `renderer/src/composables/useWindowTitle.ts`，在 `App.vue` 的 `setup` 里调一次，用 `watchEffect` 把 `files` 的状态映射成标题——**只有真的打开了文件才进标题，否则就是纯应用名**：

| 本窗口状态 | 标题 |
|---|---|
| 打开了文件 | `文件名.md - Lumin` |
| 该文件有未保存改动 | `• 文件名.md - Lumin` |
| 没有打开任何文件（只开着工作区 / 未命名缓冲区，含其有未保存改动） | `Lumin` |

**几个刻意的决定**：

- **只写 `document.title`，不加任何 IPC**：Electron 会把渲染层的页面标题同步成原生窗口标题，任务栏、Alt+Tab、窗口缩略图用的都是它。所以主进程不需要再存一份标题，也不需要在窗口创建时 `setTitle`——一份真相，零同步成本。
- **天然按窗口隔离**：每个窗口的渲染层各自计算自己的标题，多窗口之间不可能互相影响（与 §4.20 的通知作用域是同一个「窗口私有状态」的思路）。
- **「没打开文件」就不带任何后缀**：未命名缓冲区的编号是每个渲染进程各自从 1 开始的，带上它反而会让两个「新建窗口」同时叫 `Untitled-1.md`（正是本功能要消掉的重名）；只开着工作区也不代表「打开了什么」。未保存内容另有提示通道——状态栏「未保存」+ 工具栏小圆点，标题保持纯 `Lumin` 最干净也最符合直觉。
- **不落 SQLite**：标题是**派生状态**（由当前文件实时算出来），不是用户数据；重启后由会话恢复（§4.18）重新算出同样的标题。为它建表只会多一份可能不一致的副本。
- **不新增 i18n 文案**：`•`、` - `、`Lumin` 都不是需要翻译的自然语言。
- **HMR 友好**：挂在 `App.vue` 的 setup 里（而不是 `renderer/src/main.ts`）——改 `main.ts` 会让 Vite 整页重载，丢掉当前窗口未保存的内容；组件级 HMR 只重跑 setup。

**验收**：`tools/_verify-window-title.js` 14/14（没打开文件 → `Lumin`（无工作区 / 有工作区 / **未命名缓冲区有未保存改动** / 关掉文件后 都是 `Lumin`）、打开文件 → `文件名 - Lumin`、改动后 → `• 文件名 - Lumin`、重新打开 → 前缀消失、**目录树里改名 → 标题跟随**、两个窗口各自显示自己的文件互不串台）。套件用**独立 `--user-data-dir`** 的实例跑，并在每段前把状态重置成「无文档无工作区」，因此不碰用户正在用的窗口和数据、且可重复运行。另用 Win32 `EnumWindows` 直接读**原生窗口标题**交叉核对（任务栏用的就是它）：实测用户实例里「只开着工作区」的窗口标题为 `Lumin`、打开了文件的窗口为 `未命名-17.md - Lumin`，与 `document.title` 完全一致。

### 4.23 「新建窗口」是干净窗口（本次）

**问题**：文件 → 新建窗口 出来的新窗口，会顺带把当前工作区（文件夹树）也带出来，不是「一张白纸」。

**原因**：`workspace.root` 在 SQLite kv 里是**全局**值（§4.19 记过这条边界），而且主进程的文件操作校验（`fileOps.assertWorkspacePath` → `file:readDir/scanWorkspace/create/remove/rename`）也依赖它——它不是纯 UI 状态，不能简单地"按窗口拆"。新窗口启动时 `files.init()` 读的就是这个全局根目录。

**方案（最小改动，不碰全局语义）**：给「新建窗口」加一个启动开关，只让**那一个窗口**不继承工作区：

- 主进程 `WindowOpenOptions` 增加 `noWorkspace`，透传 `--lumin-no-workspace=1`；**只有** `app:newWindow`（= 文件 → 新建窗口，全项目唯一调用点）带它；
- 渲染层 `files.init({ inheritWorkspace })`：`false` 时不读 kv 根目录，于是侧栏是该工作区的空态入口（按 §4.24 为一行图标按钮 + 快捷键提示），编辑器里是一张空白未命名缓冲区，标题按 §4.22 就是纯 `Lumin`（没打开文件）；
- **全局根目录一个字都没动**：其它窗口的文件夹树、主进程的路径校验、下次启动的工作区全都保持原样（这也是为什么不采用"清空 kv 根目录"这种看起来更省事的做法）。

**边界（有意保持的差异）**：只有「新建窗口」是干净的；**「在新窗口打开文件」** 与 **「最近文件夹 → 新窗口」** 语义不变——前者仍继承工作区并多打开一个文件，后者本来就要把指定文件夹作为工作区。干净窗口随后自己「打开文件夹」时，仍然会写全局根目录（与既有行为一致；**每窗口独立工作区**仍是后续可做的一步）。另外，一个既没有文档也没有工作区的干净窗口在重启后不会被恢复（会话恢复要求槽位里有文档或文件夹），这是「没内容可恢复」的既有语义。

**验收**：`tools/_verify-new-window-clean.js` 13/13，全程走**真实 UI 路径**（Alt+F 打开文件菜单 → 点「新建窗口」，不直接调 IPC）：新窗口 `startupNoWorkspace=true`、`root=null`、侧栏是空态入口且行数为 0、编辑器是未命名缓冲区、标题 `Lumin`（没打开文件）；**原窗口的根目录/树/槽位不变**、`workspace:getRoot` 仍是原值；干净窗口里打开文件正常（`alpha.md - Lumin`）且不会因此获得文件夹、随后也能自己打开文件夹；边界项——`openInNewWindow` 出来的窗口仍 `noWorkspaceFlag=false` 且继承工作区。回归：`_verify-session.js` 16/16、`_verify-notify-multiwindow.js` 21/21、`_verify-window-title.js` 14/14、`_verify-welcome-removed.js` 30 项通过（其中「最近文档/最近文件夹 → 新窗口」两项在隔离实例里因缺少工作区夹具而跳过，这两条路径本次未改动）。

**顺带修好的测试基建**：`_verify-session.js` / `_verify-notify-*.js` 直读 SQLite 的路径改为支持 `LUMIN_DB` 环境变量覆盖。此前它们硬编码 `%APPDATA%\lumin\lumin.db`，导致在 `--user-data-dir` 起的隔离实例上跑时读的是**用户真实库**（曾让 5 项会话断言误报失败）。

### 4.24 侧栏空态精简为一行图标按钮（本次）

**问题**：没打开工作区的窗口里，侧栏空态是「logo + 一句 slogan（开始你的灵感之旅）+ 一句描述（所见即所得的 Markdown 写作体验）+ 三个整行文字按钮」，占掉大半屏，和一个写作工具的侧栏气质不符——用户开个空窗口是为了立刻写字，不是为了看介绍。

**改法**（`components/FileTree.vue` 的空态区块）：

- **删掉 logo、标题 slogan、描述文案**（连同 i18n 里的 `open.emptyTitle` / `open.emptyDesc` 两个键一起删——三语言同步，不留死键）；
- **三个入口收成一行图标按钮**：新建文档 / 打开文件 / 打开文件夹，复用既有 `.icon-btn`（30×30，已有 hover/active 动效）+ `border border-edge` 描边，**不新增任何 CSS**；文案挪到 `title`（全局 tooltip 接管，750ms 延迟、主题化样式）与 `aria-label`（读屏可读），因此「图标没字」不等于「没有说明」；
- 保留一行 11.5px 的快捷键提示（`open.hint`：Ctrl+O 打开文件 · Ctrl+Shift+P 搜索文档）——它是空态里唯一还带信息的文字，也是那三个图标的可发现性补丁；不想要的话删一行即可；
- 空态根节点保留语义类名 `empty-hub`，验收脚本按它定位（也让断言不再依赖界面文案）。

**验收**：`tools/_verify-welcome-removed.js` 的 B 段改为按 `aria-label` 断言并新增两条——`empty-state-buttons-are-icon-only`（三个按钮 `textContent` 全为空）、`empty-state-has-no-hero-text`（空态区已无 slogan/描述文案），另有 `hasLogoSvg:false` 佐证 logo 已移除；`tools/_verify-new-window-clean.js` 13/13（空态识别改用三个 `aria-label`）。视觉不变量另行程序化核对：三按钮 30×30、同排等高、只含 3 个 svg、按钮下方才是提示、`--ink-2`/`--edge` 随 light/dark/sepia 主题令牌变化（切换后 150ms 内完成颜色过渡）。

### 4.25 工具栏与状态栏去掉文件名（本次）

**问题**：文件名同时出现在三个地方——窗口标题（任务栏）、编辑器工具栏右上角（文件 + 名称 + 未保存圆点）、底部状态栏左侧（名称）——重复且占地方；写作工具里这三处本来就是同一份信息的三种冗余呈现。

**改法**：

- **工具栏**（`Toolbar.vue`）：删掉整块「文档信息」（文件图标 + 文件名 + 未保存圆点）。未保存状态在状态栏有「已保存 / 未保存 + 圆点」的完整呈现，不会因为这次精简而丢失；工具栏右侧从「文档信息 · 专注模式 · 导出」变成「专注模式 · 导出」。
- **状态栏**（`StatusBar.vue`）：删掉左侧的分隔线与文件名（连同它上面那层「完整路径」的 `title` 提示），保留保存态、字数/行数/字符数、光标行列、主题与语言入口；没有文档时仍显示 `Lumin — Write in Light.` 占位。
- **清理**：`Toolbar.vue` 里只为显示名字而存在的 `docName` computed 与 `useFilesStore` 导入、`files` 变量一并删掉（`vue-tsc` 会以 TS6133 拦截这种死代码）；**没有 i18n 改动**（文件名是数据不是文案）。

文件名如今只在**窗口标题/任务栏**里出现（§4.22 的那套规则），需要看「我现在在哪个文件」时看任务栏或侧栏树即可，三处冗余收敛成一处。

**验收**：`tools/_verify-bars-no-filename.js` 12/12（两条栏都不再出现当前文件名、`title` 提示里也不残留；工具栏按钮 27 个不变；状态栏仍显示「已保存」、字数/行数/字符数、光标行列、主题/语言；窗口标题仍是 `visible-name-check.md - Lumin`）。`npm run typecheck`（主/渲染）0 error，`eslint` 对两个文件 0 error（余下警告均为既有的 prettier 换行偏好）。

### 4.26 打开外部文件的落点规则（本次）

**问题**：从系统外部打开一个文件（Ctrl+O / 打开文件 / 把文件拖进窗口）时落点不统一：没有工作区时不知道该不该顺手把侧栏切过去；已有工作区时也没有「新窗口打开」的语义，用户既可能打断当前窗口的现场，也可能打开了一个侧栏里根本看不见的文件。

**规则**（针对「窗口外的文件」这一条语义，实现在 `renderer/src/lib/openFile.ts`）：

| 本窗口状态 | 行为 |
|---|---|
| 这个文件**已经在本窗口打开** | 什么都不做：不重复打开、不新建窗口 |
| **没有打开任何文件夹** | 在**本窗口**打开，并把侧栏切到该文件所在文件夹 |
| **已打开文件夹** | 在**新窗口**打开；新窗口的侧栏对准该文件的文件夹（文件本来就在继承来的工作区里时保持原工作区，不做无谓的缩小） |

**为什么这样切**：核心诉求是「刚打开的文件必须能在侧栏里看见」。所以判据不是「文件属于哪个文件夹」，而是**本窗口有没有工作区**——没有工作区时本窗口就是一张白纸，直接用它最省事；已有工作区说明这个窗口正服务于另一个文件夹，硬塞进来既打断现场、又让侧栏与内容对不上，于是交给新窗口，并让新窗口自己把侧栏对准目标文件夹。反过来，若文件本来就在当前工作区内，新窗口保持原工作区即可（缩小范围反而丢了上下文）。

**实现要点**：

- **一处实现、四处入口**：`openExternalFile(path)` 被 Ctrl+O / 原生菜单、侧栏空态的「打开文件」按钮、文件菜单「打开…」、编辑器拖放四处调用（验收里有调用点静态核对）。侧栏树里点文件（同一工作区内切换）、最近文档 / 右键「在新窗口打开」、文档内链接点击各有既定行为，不走这条路径。
- **新窗口那一侧**（`renderer/src/main.ts` 的 `--lumin-open` 分支）：打开启动文件后，若该文件不在继承来的工作区内，就把工作区切到它的文件夹——这样「最近文档 → 新窗口」「右键 → 在新窗口打开」也自动获得同一可见性保证。
- **路径判断**（`samePath` / `isInside`）：Windows 大小写不敏感 + 正反斜杠归一，`isInside` 按**目录边界**比较（`C:\Docs` 不会把 `C:\Docs2` 判成内部），两者都有 null 兜底。
- **顺手修掉的 i18n 债**：拖放处理器里原本硬编码了三处中文（不支持的格式、脏数据确认标题与正文），现在复用既有的 `editor.dirtyConfirmTitle/Body` 并新增 `toast.unsupportedFile`（三语言同步、键集合一致）。

**验收**：`tools/_verify-open-file-routing.js` 22/22（在页面里 `await import('/src/lib/openFile.ts')` 驱动**真实模块**）：路径判断的大小写/分隔符/前缀边界；无工作区 → 本窗口打开 + 侧栏切到该文件夹且文件在树里可见；同一个文件再次打开 → `already-open`、窗口数不变、文档不变；有工作区 + 文件在外 → 新窗口（doc = 文件、root = 文件所在文件夹），原窗口完全不受影响；有工作区 + 文件在内 → 新窗口保持原工作区；另覆盖 `openInNewWindow`（最近文档/右键那条路）的两个分支。回归：`_verify-session.js` 16/16、`_verify-bars-no-filename.js` 12/12、`_verify-menu-export-submenu.js` 15/15、`_verify-welcome-removed.js` 32 项通过（其中「最近文档/最近文件夹 → 新窗口」两项在本机隔离实例里因缺工作区夹具跳过，其断言涉及的行为已由上一条用例覆盖）。

### 4.27 文件菜单「导出」收进二级菜单（本次）

原先文件菜单把四种导出格式平铺成四行，菜单过长、也把「导出」这个动作本身淹没了。现在一级只留一个 `导出 ▸`，四种格式进二级浮层（复用 §4.19 建立的二级菜单机制：贴死一级面板重叠 1px、悬停 160ms 宽限、右侧放不下翻到左侧、Esc 先收二级再收一级）。

- **菜单数据**：`SubMenu` 类型本来就支持 `children`（固定 Leaf 列表）与 `slot`（自定义组件）两种二级内容，`placeSub()` 也已按 `slot ? 300 : 220` 预留宽度——只是模板里此前只渲染了 `slot` 分支。本次补上 `children` 分支（行样式与一级项一致），因此**没有改任何定位/悬停逻辑**。
- **i18n**：新增 `menu.export`（导出 / Export / Экспорт），复用既有的 `menu.exportPdf/Html/Word/Epub`；三语言键集合保持一致。

**验收**：`tools/_verify-menu-export-submenu.js` 15/15：一级菜单只剩一个带箭头的一级项「导出」、不再平铺四行；悬停展开的二级浮层标题为「导出」且列出四种格式；浮层与一级面板贴死（`gap = -1`）；指针从一级行平移进浮层不会被关掉、悬停普通项会收起；Esc 先收浮层再收菜单；**动作接线**通过读组件实例的菜单数据断言四项各自调用 `runExport('pdf'|'html'|'word'|'epub')`——这里刻意不点击导出项：点击会真的走导出流程并弹出系统「另存为」对话框，而 `window.luminAPI` 是冻结对象（打桩无效），自动化无法取消原生对话框（第一版就踩了这个坑），因此改为「结构 + 悬停/关闭机制 + 接线」三段式验证。

### 4.28 一个文件只开一个窗口（本次）

**问题**：同一个文件可以在两个窗口里各开一份——多开的那份不会同步，改哪一份都可能被另一份覆盖，用户也分不清哪个是「正本」。

**方案**：主进程维护一张「哪个窗口开着哪个文档」的注册表，打开文件时先查表。

- **注册表**（`src/main/services/openDocs.ts`）：`window.id → 文档路径`。数据来自渲染层在**文档切换时**的上报（`window:docPath`），因此是**精确即时**的，不依赖会话槽位那套 800ms 节流写库；窗口关闭时 `forgetWindow()` 清账，不留已销毁窗口的条目。路径比较与渲染层同一套判据（Windows 大小写不敏感 + 分隔符归一）。
- **查表与聚焦**（`src/main/ipc.ts` 的 `window:focusByDoc`）：返回 `'focused'` / `'not-open'`。命中别的窗口时把那个窗口**唤到前面**（最小化则先 `restore()`，再 `show()` + `focus()`，Windows 任务栏随之激活）；命中的唯一窗口就是调用方自己时不聚焦、也不新建（渲染层已先判掉「本窗口已打开」，主进程这层是兜底）。
- **落点规则随之调整为四步**（`renderer/src/lib/openFile.ts`）：
  1. 已在本窗口打开 → 什么都不做；
  2. **已开在别的窗口 → 聚焦那个窗口**；
  3. 本窗口没有工作区 → 在本窗口打开 + 侧栏切到该文件的文件夹；
  4. 本窗口已有工作区且没人开着 → 新窗口打开。
  **顺序很关键**：一开始我把「本窗口没有工作台就直接打开」放在第 2 步之前，结果一个已经开在别处的文件会在无工作台的窗口里**又开一份**（正是要消灭的重复；回归用例 `no-workspace-still-focuses-existing` 就是这条），现已把它排到查表之后。
- **覆盖面**：Ctrl+O / 打开文件 / 拖文件进窗口（走 `openExternalFile`）与**最近文档**（侧栏按钮、文件菜单二级，走 `openInWindowOrFocus`）都会先查表。**例外**：侧栏树右键的「在新窗口打开」是用户**显式**要求新窗口，保持原样（否则点了没有任何新窗口出现会像 bug）；文档内链接点击、`最近文件夹` 也各有既定行为。

**验收**：`tools/_verify-open-file-dedup.js` 21/21（隔离实例，两个窗口 A/B）：A 开着 `x.md` 后，B 问 `focusWindowByDoc(x.md)` → `focused` 且**窗口数不变**、A 获得焦点、B 不失焦于自身；A 最小化后再问 → `focused` 且 A 被还原并聚焦（`visibilityState=visible` + `hasFocus`）；没人开的文件 → `not-open`；**A 开着 x.md 而 B 没有工作台**时，B 走真实入口打开 x.md → `focused-existing`、B 不会多出一份、窗口数不变（回归用例）；B 打开没人开的 `y.md` → `opened-here` 且侧栏切到该文件夹；B 有工作区后打开没人开的 `z.md` → 新窗口；最近文档入口对已在别处打开的 `x.md` → `focused-existing` 且窗口数不变；关掉 A 后同一路径变回 `not-open`（注册表清账）。回归：`_verify-open-file-routing.js` 22/22、`_verify-session.js` 16/16、`_verify-bars-no-filename.js` 12/12；`npm run typecheck` 双工程 0 error，改动文件 `eslint` 0 error。

### 4.29 快捷键系统：命令注册表 + 可自定义键位 + Ctrl+Tab 切窗口（本次）

**目标**：把散落三处的按键处理收敛成一套可扩展、可自定义的系统，并补上应用内切换窗口的快捷键。

**改造前的问题**：快捷键有**两套真相**——主进程原生菜单自带 `accelerator`（Ctrl+N/O/S…），渲染层又有一份硬编码的 `keydown` 判断（`useAppActions` 里十几个 `if`）。用户既改不了键，也容易出现重复/绕过的行为；加一条快捷键要改两处。

**架构**（`renderer/src/lib/keymap/`，与 VS Code / Atom 同一套思路，只是规模小得多）：

```
keys.ts      按键表达式解析/规范化/格式化/匹配（Mod、Ctrl、Shift、Alt、Meta、Tab、F12、, …）
service.ts   命令注册表 + 解析（用户覆盖优先）+ 全局 keydown 派发 + 冲突计算 + 录制态
commands     应用级命令表（composables/useKeymap.ts）：id / i18n 标题 / 分组 / 默认键 / when / run
```

- **一处声明**：命令表的每一项 = 一条可被快捷键触发的命令，`run` 统一调 `handleMenu(action)`——和原生菜单**同一份实现**，因此不存在「菜单能做的事快捷键做不到」。
- **扩展方式**：加一条快捷键 = 命令表里加一项（设置界面、冲突检测、恢复默认、i18n 检查全部自动生效）；换默认键只改 `defaultKeys`，用户改过的不受影响。
- **解析优先级**（写在 `service.ts` 顶部注释里）：用户覆盖 > 代码默认；同一档内**后注册者胜**（与 VS Code「later wins」一致）；`keybindings[id] = null` 表示**明确解绑**。
- **派发**：一个 window 捕获阶段的 `keydown`；只处理带修饰键的组合（纯字母键留给编辑器/输入框）；`when: 'notInInput'` 的命令在输入框里让行（Ctrl+F）；**录制期间整体让行**（否则「录 Ctrl+N」会真的执行它 —— §4.47 之后这一下会**开一个新窗口**）。
- **原生菜单不再自带 accelerator**（`src/main/menu.ts`）：否则用户改了键，原生那份照旧触发——两套真相 + 重复触发。菜单项保留（系统级可访问性），应用内快捷键统一由渲染层接管。

**默认键一览**（26 条，分 6 组；「导出」单独成组）：

| 分组 | 命令 | 默认键 |
|---|---|---|
| 文件 | 新建 / 新建窗口 / 打开… / 打开文件夹… / 保存 / 另存为… | `Ctrl+N` / `Ctrl+Shift+N` / `Ctrl+O` / `Ctrl+Shift+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| 文件 | 关闭窗口 | `Ctrl+W` |
| 导出 | 导出为 PDF（HTML/Word/EPUB 默认不绑） | `Ctrl+Shift+E` |
| 编辑 | 查找 / 替换、全局搜索、设置 | `Ctrl+F`、`Ctrl+Shift+P`、`Ctrl+,` |
| 视图 | 切换侧边栏 / 专注模式 / 打字机模式 / 循环切换编辑模式 | `Ctrl+Shift+B` / `Ctrl+Shift+F` / `Ctrl+Shift+T` / `Ctrl+/`（模式直选三条默认不绑） |
| **窗口** | **切换到下一个窗口 / 上一个窗口** | **`Ctrl+Tab` / `Ctrl+Shift+Tab`** |
| 帮助 | 打开快捷键设置（关于默认不绑） | `Ctrl+K` |

`Ctrl+Tab` 由主进程按**窗口创建顺序循环**（1 个窗口不动、2 个来回切、N 个依次走），语义与浏览器 Ctrl+Tab 切标签页一致；目标窗口最小化时先还原再聚焦（`services/openDocs.ts` 的 `focusWindow`）。

**设置界面**（设置 → 快捷键，`components/SettingsKeymap.vue`）：搜索（命令名或按键）、按分组浏览、逐条显示键位胶囊 / 「已修改」/「冲突」标记、点键盘图标进入**录制**（Esc 取消、Backspace 解绑）、单条恢复默认、全部恢复默认，并显示已自定义条数；键位写入 `settings.keybindings`（SQLite kv，`null` = 解绑），三语言文案同步。

**本次顺带修掉的两个真 bug**（都是被验收用例逼出来的）：

1. **Pinia `$patch(对象)` 对嵌套对象是深合并**，所以「恢复默认」用 `$patch({ keybindings: {...} })` 删键会被合并回来 → 表现为「点了恢复默认却没生效」。改用 `$patch(函数)` 整体替换。
2. **`focusWindow` 只用 `isMinimized()` 判断**：窗口在应用处于后台时被最小化，Electron 可能报 `isMinimized() === false`，于是只调 `focus()` 得到「焦点给了它、但它还最小化着」的怪状态。改为 `isMinimized() || !isVisible()` 一起判断（`restore()` 对非最小化窗口本来就是 no-op）。

**验收**：`tools/_verify-keymap.js` **31/31**（隔离实例；含页面内的按键投递探针）——**§4.47 之后为 33/33**（C 段改为「窗口数 +1」判定，并新增「新窗口同工作区且未命名、不落盘」两条）：命令表 26 条且标题/分组 i18n 全部有值、默认键 `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Mod→Ctrl` 规范化、无重复默认键；默认键真的生效（`Ctrl+/` 切模式、`Ctrl+Shift+B` 侧栏、`Ctrl+Shift+P` 全局搜索）；`Ctrl+N` **只执行一次**（原生菜单已无 accelerator；§4.47 后「执行一次」= 只多一个窗口）；自定义后新键生效且旧键失效、用户绑定优先于默认绑定、冲突可见、解绑后按键无反应、恢复默认后默认键回来；**`Ctrl+Tab` / `Ctrl+Shift+Tab` 真的切换窗口**（focus/blur 事件流判定，含反向与自定义键）；设置界面 26 行 / 7 分组 / 45 个键位胶囊 / 搜索过滤 / 进入录制 / **录制期间按 Ctrl+N 不开新窗口** / 录制写入生效；直读 SQLite 证明改键落库，reload 后解析结果仍是自定义键。回归：`_verify-editor-menu.js` 51/51、`_verify-open-file-routing.js` 22/22、`_verify-open-file-dedup.js` 21/21、`_verify-session.js` 16/16、`_verify-menu-export-submenu.js` 15/15、`_verify-window-title.js` 14/14、`_verify-bars-no-filename.js` 12/12、`_verify-welcome-removed.js` 32 项通过（另 2 项为既有的隔离实例环境跳过）、`_verify-alt-menu.js`（Alt+F 仍由应用内菜单接管）；`npm run build`（含双工程 typecheck）0 error。

**范围与边界**：本表管**应用级命令**；编辑器内部的排版键（`Ctrl+B/I/U`、`Ctrl+Z/Y`、Markdown 输入规则等）由 ProseMirror / CodeMirror 自己的 keymap 处理，属编辑器内核语义，**不在**设置里改（要改需把编辑器键也搬进注册表，是另一件事）。另外，侧栏树右键的「在新窗口打开」仍是显式新建窗口，不参与 §4.28 的去重。

### 4.30 另存为之后侧栏跟到保存位置（本次）

**问题**：另存为把文件写到别处后，侧栏还停在原来的工作区——那份新文件在侧栏里根本看不见，像是「存丢了」。

**规则**（`stores/files.ts` 的 `syncWorkspaceToPath` / `revealPath`，与 §4.26「刚打开的文件必须能看见」同一条原则）：

| 保存位置 | 侧栏行为 |
|---|---|
| 当前工作区**之外**，或本窗口**没有工作区** | 工作区切到该文件所在文件夹（`setRoot`，并记入最近文件夹） |
| 当前工作区**之内**（含深层子目录） | **不缩小范围**，逐级展开路径把文件露出来；列表视图则让文档缓存重扫一次 |

- `saveAs()` 的时序：先写盘，**成功后**才同步侧栏（`const ok = await this.save(); if (ok) await this.syncWorkspaceToPath(path)`）——写失败不该把侧栏带走。
- 落成 store 动作而不是写在组件里：侧栏状态（`root` / `expanded` / `dirCache` / `docsEpoch`）本来就归 `files` store 管；将来「重命名到别处」「移动到文件夹」也能复用同一个动作。
- **顺带抽出 `lib/pathUtils.ts`**：`normPath` / `samePath` / `isInside` / `parentDir` / `ancestorDirs`。原先 `samePath`、`isInside` 只存在于 `lib/openFile.ts`，而 store 也要判「在不在工作区内」——直接 import 会形成 `stores/files ↔ lib/openFile` 循环，抽出公共模块后两边共用同一套判据（Windows 大小写不敏感 + 分隔符归一 + 目录边界），`lib/openFile.ts` 仍转出这两个函数供调用方就近引用。

**验收**：`tools/_verify-save-as-workspace.js` **17/17**（隔离实例 + 真实文件系统）：路径工具边界（`ancestorDirs`：直接子文件 / 深层嵌套 / 工作区外为空；`parentDir('C:\x') === 'C:\'`、裸文件名 → `''`；`C:\Docs` 不把 `C:\Docs2` 判成内部）；保存到工作区内 → root 不变、`sub` 被展开且树里能看到 `b.md`；保存到工作区外 → root 切成目标文件夹并落库（`workspace:getRoot` 一致）、树里能看到 `c.md`；深层路径 `d1/d2/deep.md` → 两级祖先都展开；没有工作区时保存 → 同样切到该文件夹；并静态核对 `saveAs()` 在保存成功后调用了它。回归：打开文件落点 22/22、一文件一窗口 21/21、会话 16/16、工具栏去文件名 12/12；`npm run typecheck` 双工程 0 error。

**说明**：原生「另存为」对话框无法在自动化里作答，因此上面用「改路径 → `save()` 写真实文件 → `syncWorkspaceToPath`」的等价序列验证，并静态核对 `saveAs` 的调用点；对话框本身与本功能无关。

### 4.31 分段控件重做：滑动指示块（本次）

**问题**：工具栏的「实时渲染 / 分屏 / 源码」原来是三个图标+文字按钮各自填充（激活项 `accent-soft` 底 + 强调色字），读起来像「三个小按钮」而不是一个控件；加上三段中文标签，横向也占地方。侧栏的「树 / 列表」是另一套写法，同一类交互两种长相。

**做法**：抽出一个通用 `components/SegmentedControl.vue`，两处共用（工具栏 3 段、侧栏 2 段），采用当代主流的**滑动指示块（sliding thumb）**：

- **一条中性轨道 + 一个随选中项平移的抬升色块**：轨道用 `--panel-2` + `--edge` 描边 + 极轻内阴影；指示块用 `--elevate` + 发丝描边 + 1px 投影——「浮起来」的三件套让它在浅色/深色/羊皮纸下都立得住。
- **不需要测量 DOM**：指示块宽度 `calc((100% - 内外边距) / 段数)`、位移 `translateX(序号 × 100%)`（百分比相对**指示块自身**宽度），因此尺寸变化/字体变化都不会错位，也没有测量后的跳动。
- **动效只走 transform**（`0.24s cubic-bezier(.4,0,.2,1)`，合成层），并遵循 `prefers-reduced-motion`。
- **克制的强调色**：激活项文字转 `--ink`、图标用 `--accent` 点一下，而不是整块染色；未激活 `--ink-3`、悬停 `--ink-2`。
- **工具栏只留图标**（文案在 `title`——悬停提示会带上 `Ctrl+/`——与 `aria-label` 上），控件宽度从约 180px 收到 108px，工具栏更透气；`role="tablist"/"tab"` + `aria-selected` 保持不变，两个控件的无障碍名称新增 i18n 词条（`editor.viewMode` / `sidebar.filesView`，三语言同步）。
- 顺手删掉已无引用的 `.mode-seg` / `.mode-seg-btn` 死 CSS（38 行）。

**验收**：`tools/_verify-segmented-control.js` **16/16**（隔离实例，几何与状态都按 DOM 实测）：两处控件段数正确（3 / 2）、每段只有 1 个图标且无可见文字、提示里带 `Ctrl+/`、`aria-selected` 与激活段一致、各段等宽；**指示块宽度 = 一段宽（±1px）且与激活段左边缘重合**；点击第 3 段 → 模式变 `source`、`aria-selected` 跟着走、**指示块位移正好两段宽**（21→89，段宽 34）；侧栏切到列表视图且指示块跟上；指示块带 transform 过渡与投影、底色 ≠ 轨道底色；light/dark/sepia 三主题下轨道与指示块颜色各不相同（令牌驱动）；工具栏无横向溢出（`scrollWidth - clientWidth = 0`）。回归：工具栏去文件名 12/12（按钮数仍 27）、去欢迎页 32 项通过（另 2 项为既有的隔离实例环境跳过）；`npm run typecheck` 双工程 0 error。另存了三张 3× 截图（浅色/深色/羊皮纸）到 `%TEMP%\lumin-seg-*.png` 供人工看观感。

### 4.32 左缘展开把手重做（本次）

**用户反馈的三点**：① 长得不好看；② 出现/消失「卡卡的」；③ 热区太小，鼠标要靠得很近才现身。

**② 的根因（值得记一笔）**：把手原先是 Tailwind 工具类拼的——`-translate-x-1` / `translate-x-0` 在 **Tailwind v4 里写的是 `translate` 长属性**，而类上声明的过渡是 `transition-[opacity,transform,color]`：**被动画化的属性（transform）和实际承载位移的属性（translate）不是同一个**，于是位移根本不参与过渡，只有透明度在淡入淡出，看起来就是「啪地跳一下」。另外 `top-1/2 -translate-y-1/2` 把纵向居中混在同一个属性里，也让位移难以单独控制。

**改法**：

- **把位移交给 `transform`**：新增 `.sidebar-handle` 类（style.css），收起态 `translate3d(-100%, -50%, 0)`、浮现态 `translate3d(0, -50%, 0)`——**整体退到窗口之外**，不再只挪 4px（原来收起时还会露出一条边，视觉上像「没关干净」）。过渡显式写在 `transform` / `opacity` 上：`transform .3s cubic-bezier(.22,1,.36,1)`（带一点回弹的缓出，滑出更顺）+ `opacity .22s`，并加 `will-change: transform, opacity` 走合成层。
- **③ 双阈值迟滞**：`EDGE_SHOW_PX = 120`（原来是 86，热区扩大约 40%）、`EDGE_HIDE_PX = 200`。指针进 120px 内浮现、退到 200px 外才收起，**中间 80px 是迟滞带**——单阈值时指针停在边界上会反复闪现，这是「忽有忽无」的另一个来源。
- **① 外观**：22×56 的小药丸，只在右侧圆角（12px）贴住窗口边缘；`--elevate` 92% 半透明 + `backdrop-filter: blur(10px)`（与工具栏/状态栏同一套玻璃语言）+ `--shadow-2` 轻投影；默认 `--ink-3`，悬停/键盘聚焦时转 `--accent` 并加一圈 `--accent-soft` 光环，悬停再往外探 2px 提示可点；遵循 `prefers-reduced-motion`（此时只保留淡入淡出）。
- 键盘 Tab 聚焦仍会浮现（原行为保留）、点击展开后把手卸载并落库（`sidebarVisible`）不变。

**验收**：`tools/_verify-sidebar-handle-style.js` **19/19**（隔离实例 + CDP 真实指针移动）：折叠后把手存在；**收起态整体在窗口外**（`left=-22 / right=0`）+ `opacity:0` + `pointer-events:none`；指针到 x=80 → 浮现且左边缘贴 0；**退到 x=150（迟滞带内）仍保持浮现**（不闪）；退到 x=260 → 收起；再次靠近 x=100 → 又浮现；过渡属性确认为 `transform, opacity, color, box-shadow` 且带 `cubic-bezier(.22,1,.36,1)`/`0.3s`；**位移落在 `transform` 上而 `translate` 长属性为 `none`**（即上一轮那个坑已修掉）；`will-change` 含 transform；圆角为 `0 12px 12px 0`；玻璃质感 + 投影；三主题下底色/字色各不相同（令牌驱动）；键盘聚焦浮现；点击后侧边栏展开且设置落库、把手卸载。回归：分段控件 16/16、工具栏去文件名 12/12、会话 16/16、去欢迎页 32 项通过；`npm run typecheck` 双工程 0 error。另存 `%TEMP%\lumin-handle-{light,dark,sepia}.png` 三张 3× 截图供观感确认。

### 4.33 目录对齐 Typora（去掉左侧色条、默认蓝色）+ 点击标题平滑滚动（本次）

**用户要求**：① 优化目录样式——**取消左侧颜色条**、做成 Typora 那样；② 点目录里的标题时界面要**滑过去**，而不是直接跳过去。

**样式改法**（`assets/style.css` 的「目录」段 + `components/editor/TocNodeView.vue`）：

- **去掉整套卡片化外观**：原先 `.md-toc` 有「目录」标题行 + 左侧色条 + 底色 + 外框 + 圆角，现在全删——目录就是一个普通块（`margin: .9em 0`），嵌在正文流里，与 Typora 的观感一致。
- **改成按层级的圆点列表**：条目带 `--toc-depth`（`min(level, 4) - 1`，0..3），`padding-left: calc(1.15em + var(--toc-depth) * 1.15em)` 由层级算缩进；`::before` 的圆点按层换字符 **`•` / `◦` / `▪`**（第 3 级起 0.9em 略小），圆点定位在 `left: calc(var(--toc-depth) * 1.15em)`。字号 1em、行高 1.75 与正文同款，颜色继承正文、悬停转 `--accent-2`——**全走主题令牌**，三套主题自动跟随。
- 只留一个内联变量（`--toc-depth`），缩进与圆点都在 CSS 里推导，DOM 里不再有装饰元素。
- **默认字色改为蓝色**（同日追问）：新增主题令牌 `--toc-link`，条目 `color: var(--toc-link)`。**没有直接用 `--accent`**——浅色/深色主题的 accent 是靛紫（#6366f1 / #818cf8），到了一直走暖色的羊皮纸主题就变成琥珀（#b45309），用 accent 就「不是蓝的」。所以三套主题各自给一个蓝并校过对比度（按各自的 `--app` 底色算）：浅色 `#2563eb`（blue-600，在 #f5f6f8 上 ≈4.7:1）、深色 `#60a5fa`（blue-400，在 #0f1116 上 ≈7.5:1）、羊皮纸 `#1d4ed8`（blue-700，在 #f1e9d5 上 ≈5.5:1）——都过 AA（正文 4.5:1）。悬停时文字与圆点一起用 `color-mix(in srgb, var(--toc-link) 78%, var(--ink))`——浅色变深、深色变亮，不额外加令牌，也不会从蓝跳成紫（原来是 hover → `--accent-2`）。

**平滑滚动改法**（新增 `src/renderer/src/lib/editor/smoothScroll.ts` + `stores/editor.ts` 的 `jumpToHeading`）：

- **一个动作，两处受益**：目录条目与侧栏大纲调用的是**同一个** `editorStore.jumpToHeading(pos)`，所以「目录能滑、大纲也能滑」，以后改一处两边都对。
- **流程**：先只移动光标（`setTextSelection`）→ 把 focus 顺带造成的瞬时滚动**原样复位** → 再对 `.editor-scroll` 做 `behavior: 'smooth'` 的滚动；目标位置用 `view.domAtPos(pos)` 找到标题的 DOM 元素，顶部留 12px 呼吸位。
- **不再用 ProseMirror 的 `.scrollIntoView()`**：它一步写死 `scrollTop`，视觉上就是「啪」地跳（这正是用户反馈的问题）。
- **无障碍**：`prefers-reduced-motion: reduce` 时退化为瞬时定位（`scrollContainerTo` 第三参由 `prefersReducedMotion()` 决定）。
- **坑 1**：`scrollTo({ behavior })` 的显式取值**优先于** CSS 的 `scroll-behavior`——所以打字机模式下容器自带的 `smooth` 也能被我们强制瞬时复位，不会被 CSS 反噬。
- **坑 2（实测抓到的「偶发瞬移」）**：Tiptap 的 `focus()` 默认 `scrollIntoView: true`，而它是在 **`requestAnimationFrame` 里**补一次 `scrollIntoView`（瞬时滚动）。若我们的平滑动画同步启动，那一帧的瞬时滚动会把动画打断 —— 表现为「多数时候滑、偶尔还是直接跳过去」。修法两步：`focus(null, { scrollIntoView: false })` 关掉它；并把平滑滚动排到下一帧执行（`document.hidden` 时直接瞬时，免得 rAF 不触发导致回到前台才莫名滚动）。

**验收**：`tools/_verify-toc-style-scroll.js` **23/23**（隔离实例，样式与滚动全部按 DOM / 逐帧滚动位置实测）：

- 样式：无色条（判据是 `border-left` **宽度 0**，不是 `style: none`——Tailwind preflight 给所有元素写了 `border-style: solid`）、条目无底色/外框/阴影/伪元素底色、无「目录」标题行、3 个条目圆点恰为 `•`/`◦`/`▪`、缩进 20/39/59px 单调递增、`font-size: 17px` / `line-height: 29.75px` / `cursor: pointer`。
- 滚动：从文档底部（`scrollTop 2506`）点「一级标题 Alpha」→ 逐帧采样得到 **50 个不同值**（2506 → 2504 → 2497 → 2483 → … → 28），最终停在该标题上方 12px（`headingTop 40` / `finalTop 28`），光标落在该标题；**并额外断言「平滑调用之后不允许再出现任何滚动写入」**——这条就是坑 2 那个 bug 的回归护栏（探针实测只应有 `scrollTo{top:2506,behavior:'instant'}` 与 `scrollTo{top:28,behavior:'smooth'}` 两条，之后为空）。
- `prefers-reduced-motion: reduce` 模拟下同一路径只采到 2 个值（瞬时）、落点相同；侧栏大纲点击同样平滑（证明是同一个动作）。
- 颜色（**23 项**里的 6 项）：默认字色三套主题都是蓝且**等于令牌解析值**（用临时元素取 `var(--toc-link)` 的计算色，不把色值写死在套件里）、且 ≠ 正文墨色；用真实指针移上去验证悬停色仍是蓝且确实变深（`color-mix` 会算出浮点格式 `color(srgb …)`，套件里的解析两种格式都吃）；light/dark/sepia 轮换时逐主题断言 `rgb(37,99,235)` / `rgb(96,165,250)` / `rgb(29,78,216)`。
- 截图：`%TEMP%\lumin-toc-{light,dark,sepia}.png`（3×）供人工看观感。
- 回归：分段控件 16/16、工具栏去文件名 12/12、会话 16/16、去欢迎页 32 项通过（另 2 项为既有的隔离实例环境跳过）、旧目录用例 `_verify-toc.js` 的插入/点击/往返仍正常（3 个条目、点击后光标落在「二级标题B」、Markdown 仍往返成 `[TOC]`）；`npm run typecheck:web` 0 error。
- 顺带修了验收脚手架在**全新配置目录**下的三处隐含假设（侧栏默认收起、标签页可能停在大纲、编辑器模式跨会话持久化），并给 `tools/*.ps1` 补了 UTF-8 BOM——PowerShell 5.1 会把「无 BOM 的 UTF-8」按 ANSI 解码，中文注释里的引号会把脚本整体解析搞崩。

### 4.33.1 目录高亮：点最后一条却亮到倒数第三条（末屏边界）+ 这几种逻辑的术语

> **两轮报障，两个根因。** 第一轮的修法（bottom clamp + 800ms 锁）**不够**：用户第二轮反馈
> 「点倒数第三个却亮到倒数第四、而且直接跳过倒数第二和倒数第三」，于是把判定规则重写成
> **纯函数 + 单测**（`lib/editor/scrollSpy.ts`）、把锁改成**只在用户自己滚动时解锁**。
> 下面是最终形态。

**用户口径**：①（第一轮）最后三个标题挨得很近（同一屏能显示），点**最后一个**标题时本应最后一条
高亮，但目录只高亮到倒数第三；②（第二轮）「还不行 —— 现在直接跳过倒数第二和倒数第三；我点的是
倒数第三个，但大纲亮到倒数第四」。

**根因（两个，互不相同）**：

1. **末屏边界**（滚动侦测的经典缺陷）：判定规则是「容器上沿往下 90px 那条线**上方**最后一个标题」。
   文档最后几节很短时，它们的标题**永远压不到那条线上**（容器已经滚到底、滚不动了）——
   于是这几节要么永远点不亮（旧行为：停在倒数第四），要么用一个「到底就点亮最后一条」的补丁，
   结果是**跳过**中间那两节（第一轮的修法，用户第二轮报障的正是这个「跳过」）。
2. **选择 vs 侦测的优先级**：点目录是「**用户选的**」，滚动侦测是「**系统算的**」。旧代码每次滚动
   都用侦测结果覆盖 `activeHeading` —— 平滑滚动落地（约 300–500ms）之后，高亮就被挪到「判定线
   算出来的那条」。第一轮加的 800ms 自动解锁只把这件事推迟了半秒，落地后照样被覆盖。

**最终修法**：

1. **判定规则抽成纯函数** `src/renderer/src/lib/editor/scrollSpy.ts`（有单测
   `tests/scrollSpy.test.mjs`，6 条）：
   * 常规：判定线之上最后一个标题；
   * **末尾补偿（尾部等分）**：先找「滚到底时能压线的最后一个标题」，从它压线那一刻起，把
     **剩余滚动距离平分给「它 + 后面追不上的那几条」**，依次点亮，滚到底正好是最后一条 ——
     不跳过、也不提前跳到末尾。同一条规则天然覆盖了旧的 bottom clamp（`scrollTop = maxScroll`
     时 `frac = 1` ⇒ 最后一条）。
   * 坐标用**文档坐标**（相对偏移 + scrollTop）：第一版直接用相对偏移推「滚到底能压线的最后一个」，
     在不可滚动 / 标题已越过判定线时算出负起点，把高亮甩到最后一条 —— 单测当场抓到。
2. **点击锁只在用户滚动时解锁**：`jumpToHeading()` 立刻点亮被点的那条并 `activePinned = true`；
   解锁只发生在`wheel` / `touchstart` / 按下指针 / 按键（`.editor-scroll` 上四个监听器）——
   用户一旦自己滚，就说明他想看的是「跟随阅读位置」。换文档/切模式时 `applyActive()` 复位。
3. 顺带修掉一个「点了完全没反应」的坑：平滑滚动原本只挂在 `requestAnimationFrame` 上，而**窗口被
   遮挡时 Chromium 可能根本不派发 rAF**（`document.hidden` 仍是 false）—— 探针实测 `scrollTop`
   一直是 0。现在 rAF 与一个 120ms 兜底定时器**谁先到谁生效**（只跑一次）。

**验收**：

* `tools/_verify-outline-nav.js`（**13 条**，已进默认矩阵）—— 11 个标题的专门夹具
  （前 7 节各占近一屏、末尾 4 节很短 ⇒ 复现「好几节同屏」）。实测（一次完整跑的输出）：
  点第 6 条 → `scrollTop 0→2084`（点目录真的滚过去）；点**最后一条**立刻 `activeIdx=10`、
  落定后仍 `10` 且 `atBottom=true`；点**倒数第 3 条** → `activeIdx=8`（`scrollTop=maxScroll`，
  正是旧代码会亮成倒数第四的那种几何）；点**倒数第 2 条** → `9`；点第 5 条 → `4`；
  末尾细采样（30px 一步）走过的序列 `[4,5,6,7,8,9,10]` —— **一节都不跳过**，且严格递增；
  滚到底 = 最后一条；再 wheel 滚一格 → `pinned` 变 false、高亮回到侦测（10 → 3）。
* **套件确实抓得住这两个根因**（都当场验过）：① 把「末尾补偿」临时改成 `false &&` → 红两条
  （点最后一条落定后 `activeIdx` 落到 **7**，即「最后一个越过 90px 线的标题」）；
  ② 把点击锁临时改成「设完立刻置 false」→ 红四条，其中 `click-3rd-from-last-stays-on-3rd`
  实测 `activeIdx=10`（点倒数第三、亮到最后一条 —— 与用户报障同源）。
* **窗口不产生帧时如实 SKIP**：滚动事件与平滑滚动都挂在帧上，窗口被遮挡时它们都不跑
  （实测用户自己的 Lumin 在前台时，隔离实例里 `scrollTop` 恒为 0）。套件开跑先问一句
  「rAF 会不会被派发」，不会就把 11 条滚动相关断言标 SKIP 并写明原因 —— 不制造假红。

**术语（用户问「这两种逻辑有没有官方术语」）** —— 有，分三档说清楚哪些是公认名、哪些只是描述性说法：

| 逻辑 | 术语 | 性质 |
| --- | --- | --- |
| 从**滚动位置**反推「现在读到哪一节」 | **scroll spy / scrollspy**（Bootstrap 把这个模式做成了同名组件，术语由此普及）；也叫 scroll-position tracking / active-section tracking | 公认名 |
| 那个面板本身 | **table of contents (TOC)** / **outline**（VS Code 叫 Outline，Typora 叫「大纲」）；`<nav>` 里的一组 jump links | 公认名 |
| 点条目 → 跳过去 | **anchor navigation / fragment navigation**（HTML 的 `#fragment` 跳转）；这套交互统称 **TOC navigation** | 公认名 |
| 本 bug 这一类 | **scrollspy 的「末屏/底部边界」问题**（last-section / bottom-of-page edge case） | 描述性（社区说法） |
| 「到底即点亮最后一条」 | **bottom clamp**（到边界就钳住）；Bootstrap 的 Scrollspy 文档也专门交代了这个边界行为 | 描述性 |
| 「点谁就钉住谁」 | **pinned / latched / sticky active item**；实现层面叫 **manual override**（手动覆盖侦测）或 **user-intent lock**；从 UI 反馈角度也叫 **optimistic highlight**（先亮，等真实状态追上来） | 描述性（没有单一官方名） |

相邻但**不是**同一件事的两个术语（容易被混谈）：**`scroll-margin`** 是「跳转落点留白」的 CSS 属性；
**scroll anchoring**（滚动锚定）是浏览器在内容变化时**保持视觉位置不跳**的机制。

### 4.34 侧栏文件树重做：单色图标 + 16px 网格 + 三种状态（本次）

**用户要求**：重新设计左侧侧栏文件树的样式，**不要太花里胡哨，简约大气**，符合项目与「大厂」审美。

**三条设计决定**（都为了「安静」）：

1. **图标全部单色**：文件夹原来是 `color-mix(--warning 70%, --ink-3)` 的琥珀色——颜色语义不对（`--warning` 是警示色），视觉上也花。现在类型图标统一 `--ink-3`，靠字形区分（`folder` / `folderOpen` / `file`），选中时才整体转 `--accent`。
2. **固定 16px 缩进网格 + 等距行**：行高锁 27px、圆角 6px、字号 13px，缩进 `padding-left: calc(8px + depth * 16px)`（原来的 14px 步进偏挤）。层级靠间距表达，**不画连线、不做色条**。
3. **只有三种状态**：默认 `--ink-2` / 悬停 `--panel-2` + `--ink` / 当前项 `--accent-soft` + `--accent` + 500 字重（悬停当前项时底色只是同色系加深到 16%，不换色系）。展开箭头 12px，收起不变换、展开 `rotate(90deg)`，过渡 0.18s。

**实现**：行/箭头/图标/空目录提示/重命名输入框全部收敛到 `style.css` 的「侧栏文件树」CSS 块（`.tree-row` / `.tree-chevron` / `.tree-icon` / `.tree-label` / `.tree-empty-hint` / `.tree-rename-input`），`TreeNode.vue` 模板只留结构（十几行 Tailwind 工具类去掉，缩进由 `--tree-depth` 在 CSS 里算）；展开/收起从全局 `.list-*`（带 `scale(0.98)`、250ms）换成专用的 `.tree-*` 过渡（0.14s、`opacity` + `translateY(-2px)`，不带缩放）。同时补了几个测试钩子（`data-tree-row` / `data-tree-scroll` / `data-tree-children` / `data-tree-chevron` / `data-tree-icon` / `data-tree-empty-folder`）。

**顺手修掉两个真 bug**（都是「看着像样式、其实是缺陷」）：

- **选中文件时图标不变色**：原来 `class="text-ink-3" :class="isCurrent ? 'text-accent' : ''"` —— 两个 `text-*` 工具类同时存在、特异性相同，生成的 CSS 里 `text-ink-3` 在后面，把 `text-accent` 压掉了，于是选中行的文字是强调色、图标还是灰的。改成父状态选择器 `.tree-row.is-current .tree-icon` 后必然生效。
- **箭头旋转其实没有动画**：`class="transition-transform"` + `:class="isOpen ? 'rotate-90' : ''"` —— Tailwind v4 的 `rotate-90` 写的是 **`rotate` 长属性**，而过渡声明的属性是 `transform`，两者不是一个属性，所以旋转是「啪」地跳（和 §4.32 侧栏把手踩的是同一个坑）。现在用 `.tree-chevron.is-open { transform: rotate(90deg) }` + `transition: transform 0.18s`。

**验收**：`tools/_verify-sidebar-tree-style.js` **24/24**（隔离实例 + 夹具工作区三层嵌套/空目录/未展开目录，全部按 DOM 实测）：行高全为 27px、圆角 6px、字号 13px；**缩进步进 16px**（图标槽与文字各测一次，行盒子整宽不变是设计如此）；类型图标同色且等于 `--ink-3` 令牌、尺寸 15px；默认文字 = `--ink-2`；悬停（真实指针）底色 = `--panel-2`、文字 = `--ink`；选中底色 = `--accent-soft`、文字与图标 = `--accent`、字重 500；选中项悬停是同色系加深（alpha 0.16 > 0.10）；未展开目录箭头 `transform: none`、展开目录为 `matrix(0,1,-1,0,0,0)`（正好 90°），且过渡确实挂在 `transform` 上；空目录提示文字与同级子项文字左对齐（75 = 75px）；`.tree-*` 过渡为 `opacity, transform 0.14s`（无 scale），收起后子节点在 180ms 内从 DOM 消失；三套主题下选中底色都来自各自令牌。另存 `%TEMP%\lumin-tree-{light,dark,sepia}.png` 三张截图供人工看观感。

**回归**：分段控件 16/16、工具栏去文件名 12/12、会话 16/16、去欢迎页 32 项通过（另 2 项为既有的隔离实例环境跳过）；`npm run typecheck:web` 0 error，改动文件 eslint 0 error。

### 4.35 任务栏右键对齐 Typora：应用标识 + 快捷方式 + 跳转列表（本次）

**用户反馈（两轮）**：① 右键任务栏里其他应用（如 Typora）的图标会列出很多条目，其中一条就叫应用名，点它出来一个**全新窗口**；Lumin 那条却叫「Electron」，点下去出来的是 **Electron 原生窗口**。② 第一轮改完仍然如此：右键只有三项——「Electron」「固定到任务栏」「关闭窗口」。

**根因**（第一轮只治了半张菜单，第二轮才找到真正的那半张）：

1. **任务栏右键菜单第一项的名字与点击行为，来自该 AUMID（应用标识）注册的那条开始菜单快捷方式。** Windows 只认「标识 → 快捷方式」这条链：**名字**取快捷方式的显示名，**点击执行的命令**取它的 target + args。开发态跑的是 `electron.exe`，而 `@electron-toolkit/utils` 的 `setAppUserModelId()` 在开发态用的正是 `process.execPath`——那个标识在 Windows 眼里就是 electron.exe 本身：名字显示成「Electron」，点击执行**不带参数**的 electron.exe（= Electron 自带的示例窗口），「固定到任务栏」固定下来的也是这条无参数快捷方式。**应用侧改不了别人的快捷方式，但可以自己注册一条正确标识的快捷方式**，让 Windows 认这一条。
2. 应用侧此前没注册任何跳转列表条目，于是连 Tasks／最近文档都没有。
3. 为什么第一轮改完没变化：Win11 里**只有固定到任务栏的图标**右键才展开完整跳转列表；未固定时就是「应用名 / 固定到任务栏 / 关闭窗口」三项——第一项正是根因 1 那条。所以光注册 Tasks 是不够的，必须先把**标识**换对。

**改法**（`src/main/services/taskbar.ts`）：

- **`appId()`**：打包态 `com.lumin.app`（与安装器一致），开发态 `com.lumin.app.dev`（加后缀，避免和装好的版本互相顶掉快捷方式）。`src/main/index.ts` 里改成 `app.setAppUserModelId(taskbar.appId())`，并且**在建窗口之前**设置。**（后续修正：开发态再按配置目录分流 —— 默认配置目录才是 `.dev`，隔离实例用 `.dev.test`，原因见 §4.46。）**
- **`ensureAppShortcut()`**：用 `shell.writeShortcutLink(path, 'create', {...})` 在开始菜单（`%APPDATA%\...\Start Menu\Programs\Lumin (dev).lnk`）写一条带 `target`（electron.exe / Lumin.exe）、`args`（开发态含**应用目录** + `--lumin-new-window`）、`appUserModelId`、`description` 的快捷方式；每次启动刷新一遍（幂等）。有了它：菜单第一项显示 **Lumin (dev)**，点它就是「electron.exe + 应用目录」→ **新的 Lumin 窗口**；用户「固定到任务栏」时，Windows 按 AUMID 复制这条快捷方式，**参数一起固定**。
- **Tasks 那条改名「新建窗口」**（按语言本地化）：它和「应用名」那条不再重名，各司其职（前者是显式动作，后者是 Windows 的启动项）。
- **最近文档**：custom 分类（分类名跟随界面语言），每条的 program/args 同样显式指向本应用。**故意不用 `app.addRecentDocument()`**：那个把点击交给**文件关联**，开发态 electron.exe 没有 `.md` 关联，用户点「最近」反而会叫起别的程序（机器上装了 Typora 就开 Typora）。
- **主进程解析这些开关**（`parseLaunchIntent`，冷启动与第二实例两条路都认）：
  - 运行中的实例收到 `--lumin-new-window` → 开干净新窗口（与「文件 → 新建窗口」同一路径，带 `--lumin-no-workspace`）；
  - 收到 `--lumin-open=<file>` → **先查这篇是否已在别的窗口开着**，是则把那窗口唤到前面（沿用 §4.28 的「一个文件只开一个窗口」），否则新开窗口打开它；
  - 什么都没有 → 聚焦已有窗口（原行为）。
  - 冷启动带 `--lumin-open` 时**不拉会话恢复**：意图很明确就是开这一篇，否则会先把一堆旧窗口恢复出来再把这篇插进去；槽位数据仍留在 kv，下次正常启动照旧恢复。
- **重建时机**：启动时先写快捷方式、再注册跳转列表；`window:docPath`（文档切换）后节流 1.5s 重建（等这次打开先落库）；换语言或最近列表变化（含界面上「清空最近」）时立即重建。

**验收**：`tools/_verify-taskbar-jumplist.js` **25/25**（隔离实例 + 主进程自检日志 + **真的再起一个进程**）——该套件现为 **31/31**，新增的断言见 §4.46：

- 标识与快捷方式：`shortcut ok=true`，**AUMID 是我们自己的且不含 electron.exe**（这条直接钉住「名字显示成 Electron」的根因；§4.46 之后隔离实例的期望值改为 `com.lumin.app.dev.test`），target 是 electron.exe、args 含应用目录；`shell.readShortcutLink` **回读**校验磁盘上那条快捷方式与写入一致（不是只信我们的意图）；快捷方式文件确实存在于开始菜单；它的 target+args 恰好等于下一条里被验证过能开新窗口的命令。
- 跳转列表：`status=ok tasks=1 title="新建窗口"`（`setJumpList` 的返回值，Windows 真收下了）。
- **行为**：带 `--lumin-new-window` 起第二进程 → 多出一个窗口，且该窗口 `location.href` 是我们的渲染页、`window.luminAPI` 在、标题是 `Lumin`——即**不是** Electron 原生窗口；带 `--lumin-open=<beta.md>` → 新窗口打开的正是那篇；同一篇再来一次不多开；不带参数再来一次不多开；冷启动带 `--lumin-open=<alpha.md>` → 只开一个窗口并直接打开该文档。

**踩坑记录**：

- Windows 上主进程的 `console.log` 拿不到——把 electron 的 stdout 重定向到文件后，里面只有 Chromium 那行 `DevTools listening`（GUI 子系统进程没有控制台）。所以自检信息落 `%TEMP%\lumin-taskbar.log`，且只在 `LUMIN_DEBUG_PORT`／`LUMIN_STARTUP_LOG` 打开时写。
- `shell.writeShortcutLink(path, 'replace', ...)` 在**文件还不存在**时会失败（`replace` 的语义是「只替换已存在的」）——用 `'create'`（它会覆盖已存在的）。
- **验收里不要真的去 shell 打开这条 .lnk**：它是应用自己的快捷方式，不带 `--user-data-dir`，于是会连到「默认配置目录」那个实例上——也就是**用户正在用的那个应用**，等于拿验收去动用户的窗口（踩过一次，用户那边多出一个窗口）。所以改成断言「快捷方式的 target+args 等于已通过隔离验证的那条命令」，真正的启动行为由隔离实例那条用例负责。

**用户侧需要做的一步**：重启 Lumin（标识在启动时设置），之后右键任务栏图标第一项就是「Lumin (dev)」；把旧的「Electron」固定取消、重新固定新的按钮，固定下来的那条快捷方式会带参数（Windows 按 AUMID 复制我们自己写的那条）。若名字没立刻变，是 shell 缓存没刷新，重登或重启资源管理器即可。

**回归**：会话 16/16、目录 23/23、文件树 24/24、打开落点 22/22、单文件单窗口 21/21、新窗口干净 13/13、另存为切工作区 17/17、重命名 13/13、去欢迎页 32 项（另 2 项既有环境跳过）、工具栏去文件名 12/12；`npm run typecheck` 0 error。

> 打包提醒：`package.json` 目前还没有 electron-builder 配置，将来加的时候 `appId` 要写成 `com.lumin.app`（与 `appId()` 的打包分支一致），安装器就会建出同名标识的 `Lumin.lnk`，与现在的开发态逻辑严丝合缝。

**顺带修的三处验收脚手架问题**：

- 三套用例里「找文件树的行」还在用 Tailwind 的 `.group` / `.group.cursor-pointer`——§4.34 把行样式搬进 CSS 后这些类没了，于是行数恒为 0；统一改用新钩子 `[data-tree-row]`（同时避免误匹配「最近文档」下拉里的 `.group` 行）。
- `tools/_verify-tree-indent.js` 删除：它只打印不断言，且绑定的是旧几何（`paddingLeft === '6px'`）。
- `tools/_verify-rename.js` 从「只打印」改成真断言（13 条）：走真实右键菜单 → 重命名 → 真实文本输入（`Input.insertText`，会**替换已选中的主干**、保留 `.md`）→ 回落后直接用 fs 验证磁盘结果，并覆盖 Esc 取消。写这套时顺便确认了「只选主干、扩展名不动」这条设计确实生效（`selStart/selEnd = 0/5`）。
- **另一个必须记住的环境事实**：用户正在跑的 dev 应用**不会**自动拿到主进程改动——`electron-vite dev` 从 11:34 起就没有重建 `out/main`（渲染层是 HMR，主进程不是）。本次已手动 `electron-vite build` 重建，重启应用即生效。

### 4.36 应用图标：一条折起来的「光带 L」（本次）

**用户要求**：设计并换上项目的应用图标，简约大气。

**第一版为什么被打回**：初版是「靛蓝方块 + 居中一个白字母 L（等宽 6、占字面 47%）」。用户反馈「缺乏设计感、很单调、土」——这个评价是对的：它只是把字体字母摆在方块正中，**没有结构、没有光、比例也怯**，跟任何一个 UI 套件的占位图标没有区别。于是推倒重做字形本身。

**设计**（`resources/icon.svg` 是母版，下面都是它的参数）：

概念是「**一条折起来的光带写出的 L**」：L 不再是一笔字母，而是**一条折带**——竖面与横面在折角处被一条 45° 折痕分开，受光面与背光面有明度差，于是它有「体积」而不是「字形」。

| 元素 | 规格（32 网格） |
| --- | --- |
| 底板 | 圆角方块 `rx=8`（25%），**对角 135° 渐变** `#262A42 → #12131F`（对角而不是垂直：光来自左上角，垂直渐变会显廉价） |
| 辉光 | 字后面一团同色系 `rgba(99,102,241,.55)` 径向辉光（字自己发光，名字叫 Lumin 就该这样） |
| 玻璃边 | 内圈一条渐隐描边 `rgba(255,255,255,.20 → 0)`，给出边缘的一线反光 |
| 字形 | 折带外轮廓 `M10 7 H17 V16 H24 A2 2 0 0 1 26 18 V23 A2 2 0 0 1 24 25 H8 V9 A2 2 0 0 1 10 7 Z`——**占字面 59%**（x 8..26、y 7..25），三个外角 r=2 圆角、**内侧折角保持尖锐**（圆与锐的对比就是设计感的来源） |
| 折痕 | `M8 16 H17 L8 25 Z`：从内侧折角斜下到左缘的 45° 折痕，压一层 `rgba(14,16,36,.34)` 当背光面 |
| 字色 | 对角渐变 `#FFFFFF → #A9B4FF`（上亮下冷的「发光」而不是死白） |

**三个底，一套字形**（`VARIANTS` 表；`INSTALL_VARIANT` 决定装哪一个）：A 深色底 + 字发光（默认，最「高级」也最不容易和一堆蓝色图标撞脸）、B 靛蓝斜向渐变 + 白字（明亮饱和）、C 纸感浅底 + 靛蓝字（贴亮色主题）。三者的字形、比例、折痕完全一致，只换「光」的处理——所以换口味只是改一行常量再跑一次脚本。

**两个尺寸档**：16/24/32px 用**方角字形**（`M8 7 H17 V16 H26 V25 H8 Z`）+ **平色底**（`#1A1C2C`）+ 更重的折痕（.44）+ 关掉辉光与描边；48px 以上才用圆角、渐变、辉光、描边。渐变与柔光在 16px 下只会变成脏点，方角对齐像素网格才锐利——这是「不靠等比缩小糊过去」的常规做法。

**生成方式（零新依赖）**：`tools/build-app-icon.js`

- 光栅化交给**项目自己的 Chromium**：Chromium 有 canvas，图标又只是圆角矩形 + 渐变 + 一笔折线，直接用图元画比引 sharp / canvas 之类的依赖更省；母版 SVG 与 canvas 用**同一组常量**，两边不会走样。
- **Electron 不允许 CDP 建临时页面**（`Target.createTarget` 与 `PUT /json/new` 都返回失败），所以就在已有页面里画：只创建游离 canvas、画完立刻 `width=height=0` 释放，不碰应用 DOM；也**不用** data:/blob: 图片（应用页面 CSP 里没有 `blob:`）。
- **ICO 自己打包**：6 字节头 + 每张 16 字节目录项 + PNG 负载（Vista 起支持），比装一个 `png-to-ico` 更可控。
- **写完立刻回读校验**，并且**按 32 网格坐标取像素**证明「画出来的就是设计的样子」：圆角外必须 `alpha=0`、笔画正中必须近白、折角内侧必须是底板色（证明确实是 L 不是实心块）、大档上下亮度必须差 >8（渐变在）、小档上下必须完全同色且等于 `#5A5CE8`（平色在）。

**产物**（都在 `resources/`）：

- ~~`icon.svg` / `icon-small.svg`~~（**已删除**）：它们曾是第一版/第二版设计的 SVG 母版，但都不是当前
  设计的真相源（用户交付的是位图，没有 SVG 母版），留着只会让人误以为「改它就能改图标」。
  真要重新生成旧设计母版：`node tools/build-app-icon.js`（默认写 `%TEMP%`，见 §4.36 的脚本警告）。
- `icon.png` **1024×1024** 带 alpha（窗口图标 + macOS/Linux 打包图标 + ICO 各档的母图）
- `icon.ico`：**16/24/32/48/64/128/256** **七档**，全部 32 位带 alpha、DIB（BITMAPINFOHEADER +
  BGRA + AND mask）负载（Windows 的任务栏、窗口、快捷方式都读它），由 `node tools/pack-ico.js`
  从 `icon.png` 打出

> **图标更换记录（本次 / 第二轮）**：`resources/icon.png` 与 `resources/icon.ico` 已整体换成**用户桌面的
> 当前图标**（`Lumin.png` 1024×1024 / SHA256 `622127C6…`、`Lumin.ico` 51754 B / SHA256 `0420F0ED…`，
> 按字节原样复制）。这一轮与上一轮（§4.36 首轮记录）的关键差别：
>
> 1. **交付的 `.ico` 不能直接用**：它只有**一个 256×256 的 PNG 压缩条目**，而
>    `System.Drawing.Icon.ToBitmap()`（GDI+，资源管理器取图标走的就是这条路）对它抛
>    `Requested range extends past the end of the array` —— **抽不出图 = 缺省图标**，而且构建与运行
>    都不会报任何错。上一轮交付的 9 档 DIB 没这个问题，所以当时直接复制就能用。
>    本轮的做法：保留交付的 `icon.png` 当母图，用 `node tools/pack-ico.js` 把它打成
>    **七档 32 位 BGRA DIB**（含 AND 掩码；档位与旧图标一致：16/24/32/48/64/128/256）。
>    这样既拿到用户的设计，又是资源管理器读得动的容器格式。
> 2. **应用内标识不再另画**：骨架屏与「关于」页原先用的是 `Icon.vue` 里那条手绘折线 `logo`，
>    与图标不同源。现在改成**图标位图本身**（`resources/icon.png` 的 128×128 下采样，
>    内嵌成 data URI 放在 `src/renderer/src/assets/iconPng.ts`）—— 不引用任何外部文件，
>    换设备 / 换目录 / 换平台都照常显示（这是用户明确要求的）。
> 3. **单一来源的守卫从脚本搬进单测**：`tests/toolIcon.test.mjs`（6 条）静态盯着四件事 ——
>    `icon.ico` 必须是七档 DIB、每档负载字节数可复算、ICO 像素确由 `icon.png` 缩出来、
>    内嵌位图与 `icon.png` 同步（不同步直接报红）、`build/` 下不许再有 `icon.*`。
> 4. **`_verify-packaging.js` 的中心区亮度判别重新标定**：现行图标是白底 + 黑色衬线 L，
>    32px 档中心 8×8 实测 luma≈178，Electron 图标 66（差 112，阈值仍取 60）。
>    同时在该断言旁记下了 PNG-in-ICO 这个坑，免得下次换图标再踩一遍。
> 5. `tools/build-app-icon.js`（旧设计生成器）**默认不再写入 `resources/`**：产物落
>    `%TEMP%\lumin-icon-redesign\`，要覆盖得显式加 `--force`。


> **图标更换记录（上一轮 / 已被本轮取代）**：`resources/icon.ico` / `resources/icon.png` 当时换成了用户
> 交付的 `Lumin_2.*`（源文件 `Lumin_2.ico` 432254 B / SHA256 `605F02DD…`、`Lumin_2.png` 1628821 B /
> `35C211B4…`，按字节原样复制安装）。这一轮的结论**已被上面的「第二轮」覆盖**，保留下来的只有它的
> 教训：**档位与负载格式会随交付物变化，别假设它和上一份一样**（那次是 7 档 PNG → 9 档 DIB，这次是
> 1 档 PNG → 七档 DIB）。

**接线**：

- 窗口图标沿用 `resources/icon.png?asset`（electron-vite 会把导入改写成 `path.join(__dirname, '../../resources/icon.png')`，所以任务栏按钮用的就是这张新图）。
- **任务栏快捷方式与跳转列表条目**改用 `resources/icon.ico`（它们只认 exe/dll/ico 资源，PNG 在这里没用；之前借的是 electron.exe 的图标）——`ensureAppShortcut()` 的 `icon` 与两条 task 的 `iconPath` 都指向它。
- **应用内标识**（`Icon.vue` 的 `logo`）换成与图标同源的折线 `M9 8 V16.5 H15.5`（24 viewBox 折算），启动骨架屏与「关于」页各给一个较粗的 `stroke-width`，它才像「标识」而不是一枚普通线性图标。

**验收**：`tools/build-app-icon.js` 自检 **14/14**（文件结构 + 像素取样）；`tools/_verify-taskbar-jumplist.js` **27/27**（新增两条：快捷方式的 `icon` 是 `icon.ico` 且文件存在、`readShortcutLink` 回读的 icon 与写入一致）。另外用 **Windows 自己的 COM** 独立复核了那条 `.lnk`：`IconLocation = D:\code_workspace\Lumin\resources\icon.ico,0`。各档观感另存 `%TEMP%\lumin-icon-sheet.png`（浅色/深色两条 + 原尺寸，供人工看）。

**打包注意**：`?asset` 在打包后仍指向 `app.asar` 内的 `resources/`——窗口图标 Electron 自己能读，但**任务栏/快捷方式要的是真实文件**，所以将来配 electron-builder 时要把 `resources/**` 放进 `asarUnpack`（并把 `win.icon` 指到 `resources/icon.ico`）。

**顺带修的脚手架问题**（都是「dev server 不在跑就整片挂掉」这类）：

- 48 个验收套件都用 `Symbol(pinia)` 的描述去找 Pinia 实例，而**生产构建里这个 Symbol 没有描述**，于是加载 `out/renderer` 时全部报 `Cannot read properties of undefined (reading '_s')`；统一加了一条鸭子类型兜底（在 provides 里找带 `_s` 的 Map）。
- `tools/_isolated-instance.ps1` 新增 `-NoDevServer`：不连 dev server，直接加载构建好的 `out/renderer`（dev server 没在跑时用）。注意少数套件自己按 `5173` 过滤页面或 `import /src/...`，那些仍然必须配 dev server。
- 回归（无 dev server 模式）：文件树 24/24、目录 23/23、工具栏去文件名 12/12、跳转列表 27/27；`npm run typecheck` 0 error。

---

### 4.37 文件编码：判定链 + 每文件记忆 + 按编码读写（本次）

**用户要求**：适配不同编码（UTF-8 等）；设置里能选；顶部「文件」菜单加一级「选择编码重新打开」+ 二级编码列表，选中即按该编码重读当前文档。

**判定链**（`src/main/services/encoding.ts` 的 `decodeBuffer`，顺序即优先级）：

1. **调用方显式指定的具体编码**（用户在「选择编码重新打开」里点了某个编码）：**必须听用户的，BOM 也不能挡**。这一条最初写成了「BOM 优先」，复核时改掉了 —— 那样对带 BOM 的文件，菜单点了等于没反应，用户会以为功能坏了。现在 BOM 仍有用：它若**正好属于**所选编码，就把它摘掉并把 `hadBom` 记下来（写回时补回）；若与所选编码不符（用户就是要强行换个解释），那几个字节按普通字节解、`hadBom=false`。顺带得到一个明确能力：**显式选「UTF-8」= 去掉 BOM**（选「UTF-8 BOM」相反，保存必然带 BOM）；
2. **BOM 嗅探**（`EF BB BF` → UTF-8 BOM、`FF FE` → UTF-16 LE、`FE FF` → UTF-16 BE）：自动模式下 BOM 是文件自己写的声明，比任何猜测都可靠；
3. **该文件上次记住的编码**（kv `fileEncodings`）：同一个文件反复打开保持一致；
4. **严格 UTF-8 能过 → UTF-8**（`new TextDecoder('utf-8', { fatal: true })`）：UTF-8 是当代默认，「通过 fatal 校验」是很强的证据；
5. **按系统语言兜底**：`app.getLocale()` → zh → GB18030、ja → Shift_JIS、ko → EUC-KR、ru → Windows-1251、其它 → Windows-1252；
6. **最后兜底 UTF-8（有损）**：理论上到不了（1252 能解码任意字节），留作保险。

UTF-16 在写回时**总是补 BOM**：没有 BOM 的 UTF-16 文件几乎无法被别的软件识别，所以哪怕用户是从无 BOM 的 UTF-8 切过来的，也给他补上（这是「选 UTF-16」这个动作的合理预期）。

**为什么必须引 iconv-lite**：Node 的 `TextDecoder`（Electron 带完整 ICU）能解很多编码，但 **`TextEncoder` 只支持 UTF-8** —— 「按原编码写回」标准库做不到。所以 UTF-8 家族走 Node 内置，其余**解码与编码**都走 iconv-lite（纯 JS、无原生编译、极主流；本项目 mermaid → d3 → d3-dsv 本来就带着它）。本次把 `iconv-lite@0.6.3` 提升为**直接依赖**（package.json + lockfile 均已更新，`npm ls iconv-lite` 首行即它）。

**每文件编码记忆**：kv key `fileEncodings`，形如 `{ [小写路径]: EncodingId }`，**插入序当 LRU** 裁到 200 条；重复写入先删键再插回队尾（真正的 LRU 语义）。**只记「用户显式选过的」或「判定为非 UTF-8 的」**——纯 UTF-8 不占条目，否则这张表很快被日常文档塞满，真正需要记的反而被挤掉。

**UI 三处入口**：

- **设置 → 通用 → 编码**：下拉选「默认编码」（自动检测 + 全部 13 种）+ 一行说明（默认编码的作用、临时切换走「文件 → 选择编码重新打开」），经 `settings.defaultEncoding` 落 SQLite kv；
- **文件 → 选择编码重新打开**（一级）→ 悬停二级：**自动检测 + 全部编码**，**当前生效的那个打勾并高亮**（沿用「导出」二级菜单的结构与样式，新增 `active` 标记）；
- **状态栏**：文档打开时在统计与主题切换之间显示当前编码名（专有名，如 `GBK`）+ tooltip。

`stores/files.reopenWithEncoding()` 三个要点：脏文档先问（就地写 `ui.confirm`，**没有**引 `composables/useAppActions.confirmIfDirty`——那个模块反过来依赖本 store，会循环导入）；换进来时 **savedContent 一起更新 = 标记为干净**（语义是「重新解释磁盘字节」，磁盘没变，不该留成未保存态）；**不弹成功 toast**（用户口径「以其他编码打开不弹提示」—— 重新解释的结果当场可见：正文变了、状态栏编码格变了、菜单里当前编码打了勾；失败仍弹）。保存按当前编码 + `hadBom` 写回（`file:write(p, content, encoding, hadBom)`），UTF-8 BOM 文件存完 BOM 仍在。

**验收**：`tools/_verify-encoding.js` **53 条（50 PASS / 0 FAIL / 3 SKIP）**（隔离实例 + Node/iconv-lite 写出的真实夹具 + 真实指针点击；3 条 SKIP 是生产构建拿不到 `setupState` 的既有项，同一行为有 DOM 断言）：

- **解码**：UTF-8 → `utf-8`；UTF-8 BOM → `utf-8-bom` 且 `hadBom=true`（正文不含 BOM 字符）；UTF-16LE(BOM) → `utf-16le`；GBK 正文与期望**逐字相等**（中文系统判定为 `gb18030`，GBK 超集，允许两者之一）；Shift_JIS / Windows-1251 用显式编码打开，正文与编码都对；三条自动检测（两种 UTF-8 + UTF-16LE）全判对。
- **显式选择压过 BOM**（复核时补的 3 条）：带 BOM 的文件显式按 `windows-1252` 打开 → 正文确实变了（不再等于 UTF-8 文本）、`hadBom=false`（即菜单对 BOM 文件不再是「点了没反应」）；`reopenWithEncoding('utf-8')` → 正文干净（首字符码点 35 而非 `U+FEFF`）、`hadBom=false`、`dirty=false`，随后保存 → 文件头前三字节变成 `[35, 32, 228]`（BOM 被去掉）；断言后把夹具还原成带 BOM，供后面「保存保留 BOM」的用例继续验。
- **重新打开**：`reopenWithEncoding('windows-1252')` 打开 GBK 文件 → 正文确实乱码（`# ÖÐÎÄ G…`）；再 `reopenWithEncoding('gbk')` → 正文恢复、`encoding='gbk'`、**`dirty === false`**。
- **重新打开不发通知**（B3，用户口径）：用通知库的**前后差集**证明重新打开一条通知都没发（`B3-reopen-notify []`）—— 不是「我没看见有弹窗」。
- **乱码缓冲区不许落盘**（B2，数据损坏那条路）：按错误编码重新解释后继续编辑、自动保存开着 → 磁盘 59 字节一个没动、warning 通知点名当前编码且只发一次；手动保存先弹 danger 确认（`pending:"pending"` 时确实没写），取消 → `saveResult:false`、磁盘不动、标记继续武装；确认 → 写入的正是屏幕上那份文字（`sameAsBuffer:true`）、标记清除、第二次保存不再问。
- **保存回写**：GBK 文件改内容保存 → 磁盘 80 字节、`iconv.decode(bytes,'gbk')` 与文本完全相等，且这些字节**不等于** UTF-8 编码（没偷偷写成 UTF-8）；UTF-8 BOM 文件保存后前三字节仍是 `EF BB BF`，其余等于新文本。
- **设置生效**：同一串字节 `C4 E3 BA C3` 在两种编码下都合法 → 默认编码 `gbk` 解出「你好」、`windows-1252` 解出「ÄãºÃ」，两次不同且各自正确；**node:sqlite 直读隔离实例 DB** 断言 `settings.defaultEncoding === 'windows-1252'` 已落库，`fileEncodings` 记忆表 5 条。
- **菜单**：`setupState.GROUPS` 里文件菜单含 `menu.reopenWithEncoding`，二级 **14 项**且 `active` 恰为 `['GBK']`；同时用真实指针展开做 DOM 断言（14 行、GBK 行 `bg-accent-soft` + 打勾、其余无勾）；**真实点击**「Windows-1252」→ `files.current.encoding` 变为 `windows-1252` 且正文变乱码。
- **i18n**：三语 8 个 key 齐全（`toast.reopenedWithEncoding` 已随「不弹提示」删除，换成 `toast.encodingReopenAutoSaveSkipped`）；切到 `en-US` 后重开菜单，一级项文本变成 `Reopen with Encoding`。
- **状态栏**：`[data-status-encoding]` 文本含 `GBK`，title 是那句 tooltip。

**回归**：打开落点 22/22、会话 16/16、另存为切工作区 17/17、工具栏去文件名 12/12、导出二级菜单 15/15、目录样式与平滑滚动 23/23；`npm run typecheck` 两工程 0 error；改动文件 eslint 0 error（`src/main/fileOps.ts` 那条 `no-useless-escape` 是既有正则的存量问题，不在本次 diff 内）。

**已知取舍与风险**（验收里都如实体现）：

1. **GBK/GB18030 与 Shift_JIS 会互相误判**：无 BOM 且非法 UTF-8 的文件只能按系统语言猜 —— 中文系统下日文 Shift_JIS 会被猜成 GB18030（乱码），日文系统下中文 GBK 会被猜成 Shift_JIS（乱码）。这是「没有元信息的双字节编码」的固有歧义，任何编辑器都只能猜；缓解手段就是「选择编码重新打开」+ 每文件记忆（选一次以后这个文件都对）。套件里 Shift_JIS/Windows-1251 走显式编码路径正因此。
2. **GBK 与 GB18030 不区分**：中文系统下 GBK 文件判成 GB18030（超集，正文正确）；想让它显示成 `GBK` 手动选一次即可，之后走每文件记忆。
3. **i18n key 命名偏差**：规格写的是 `status.encodingTooltip`，但本项目状态栏文案统一在 `statusbar.*`（没有 `status` 组），实际落在 **`statusbar.encodingTooltip`**；其余 key 与规格一致。
4. **`setupState` 内省只在开发构建可用**：Vue 生产构建不把 `<script setup>` 绑定挂到 `setupState`，所以套件同时保留 **DOM 断言**。本次 31/31 是在开发渲染层（dev server 5173）下跑出的；用 `-NoDevServer` 跑时 setupState 那三条显示 SKIP，DOM 三条照常断言。

### 4.38 开发态主进程热重载：`electron-vite dev --watch`（本次）

**症状**：改主进程代码（如新增编码功能）后，界面上能看到新菜单（渲染层走 dev server 热更新），但点下去报错 —— 像是功能坏了；而且**每次都要手动重启应用**才可能生效，甚至重启也没用（加载的还是旧主进程构建产物）。

**根因**：`electron-vite@5` 的 dev 命令里，**主进程/preload 的监听是可选开关**（`-w, --watch`：*rebuilds when main process or preload script modules have changed on disk*，见 `node_modules/electron-vite/dist/cli.js`），而本仓库的 `dev` 脚本是 `electron-vite dev` —— **没开**。于是渲染层热更新正常、主进程永远不重建：应用进程里跑的一直是启动那一刻加载的旧主进程。实测：用户 dev server 19:51 启动，20:48 落地的主进程功能到 22:00 都没触发过任何重建（`out/main/index.js` 的 mtime 一直是手动构建的时间）。

**改法**（一个词）：

```json
"dev": "electron-vite dev --watch"
```

**验证**（隔离实例，`--watch` 且把参数透传给 electron：`electron-vite dev --watch -- --user-data-dir=…`）：

- 启动后 `out/main/index.js` 随启动构建（22:07:10）；
- 改一行主进程文件 → **主进程产物重建**（mtime 22:07:10 → 22:07:57）且日志出现 `electron main process rebuilt successfully` / `restarting electron app...`；
- **应用进程号变化**：PID 24544 → 24932（即自动重启，不再需要人工重启）。

**对编码功能的意义**：编码切换本身**从来不需要重启** —— 「选择编码重新打开」是重新读盘 + 就地换内容，切一次生效一次；之前需要重启纯粹是因为主进程代码没被重建过。开了 `--watch` 之后，这类「渲染层新、主进程旧」的错配不会再出现。

> 顺带说明：打包产物里主进程与渲染层来自同一次构建，不存在这种错配；它是**开发态专属**问题。渲染层遇到旧主进程时会提示「编码功能需要重启应用后生效」（见 §4.37），而不是含糊地报失败。

---
