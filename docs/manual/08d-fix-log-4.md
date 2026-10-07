# 附录 4.74–4.85：草稿弹窗 / 版式与主题 / 状态栏重排

> 本文件是 [附录索引](./08-appendix.md) 的第 4/5 片，
> 内容为原 `08-appendix.md` 的第 2636–3358 行（**逐行原样**，拆片脚本见 commit 说明）。
> 线上（live）的优化台账在 [docs/optimization-waves.md](../../optimization-waves.md)。

---

### 4.74 草稿提示改成**独立强制弹窗**（先选「恢复 / 丢弃」才能继续编辑）

**用户口径**：取消「检测到未保存的草稿（比磁盘文件更新）」原来那条提示的样式与位置；
当当前内容与磁盘文件不一致要触发这个提示时，改成**单独弹窗**，不做出选择就无法继续编辑此文档。

#### 一、形态：从「编辑区上方的内联横幅」到「独立弹窗」

- 触发条件**完全不变**（`files.draftRestore`：打开文档时发现未保存草稿，且它比磁盘文件新；
  未命名缓冲区走另一条文案）。变的只是呈现与强制性：
  - 弹窗挂在 `EditorView.vue` 里（`<Teleport to="body">`），沿用 `ModalHost` 的对话框语言
    （半透明遮罩 + 圆角卡片 + `--shadow-2`），但**不进通知中心、也不与通知带混排**；
  - 遮罩 `@click.self` **什么都不做**（点外面不关）、Esc 也**不关** —— 必须明确点一个；
  - 打开时焦点给「恢复」（回车即恢复），Tab 只在「丢弃 / 恢复」之间循环；
  - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题元素带 id）。

#### 二、「不选就不能编辑」要挡住的是**所有写入途径**，不只是键盘

第一版只加了键盘闸门（捕获阶段吞 keydown），结果被自己的套件当场打红：
`Input.insertText`（CDP 的文本插入，等同 IME 组字 / 粘贴那一类）**不产生 keydown**，
照样把 `BLOCKED` 写进了文档 —— 这正是中文输入法路径上的真实漏洞。修法是三层一起上：

| 层     | 做法                                                                              | 挡住什么                                  |
| ------ | --------------------------------------------------------------------------------- | ----------------------------------------- |
| 渲染面 | `editorStore.instance?.setEditable(false)`（DOM 变 `contenteditable=false`）      | 键盘、IME、粘贴、拖放 —— 浏览器层面就拒绝 |
| 源码面 | `textarea.source-editor` 加 `:readonly`                                           | 同上（源码模式下编辑的是它）              |
| 事件层 | 捕获阶段吞掉 `keydown`（放行 Tab/回车/空格）与 `beforeinput / paste / cut / drop` | 兜底：任何漏网的写入途径                  |

#### 三、验收

- `tools/_verify-draft-banner.js` **27/27**（原 25 条 + 本轮新增两条）：
  - `modal-blocks-editing-until-chosen`：弹窗开着时**真的往编辑器里打字**（先聚焦渲染面/源码面，
    再 `Input.insertText` + 一次 `keyDown`），文档内容必须一字未变（这条最初是红的，见上表）；
  - `modal-esc-does-not-close`：Esc 之后弹窗仍在。
    另把 `restore-brings-content-back` 的判据从全等改成「去掉结尾换行后相等」—— 序列化会把 markdown
    规整成结尾带换行（`# hello draft` → `# hello draft\n`），不是内容差异；本轮在恢复前多插了一段等待，
    时序一变就撞上规整后的值（假失败）。
- `_verify-new-document` 23/23（同一条 `banner` 探针换成 `.draft-modal`）、
  `_verify-notifications` 32/32、`_verify-notify-style` 22/22、`_verify-toast-tip` 21/21、
  `_verify-surfaces` 37/37、`_verify-a11y` 6/6、`_verify-i18n` 5/5、`_verify-session` 17/17、
  `_regress-layout` 9/9、`_verify-local-media` 10/10。
- 新增 i18n 键 `editor.draftTitle` / `editor.draftHint`（三语同步）；`sidebar.css` 里原来那套
  `.restore-bar` / `.draft-reveal` 样式随之删除（`.draft-modal` 只留遮罩兜底与最小高度）。

### 4.75 三处版式微调：通知操作按钮靠右 / 分屏左栏滚动条贴左 / 分隔条「抓住」动效

**用户口径**：① 通知的布局、结构与样式再优化，操作按钮放右边（原来在左边）；② 分屏时渲染面（左栏）
的滚动条也放左边；③ 分隔条的鼠标点击动效自然一点。

#### 一、通知：操作按钮从「正文下方（左）」搬到行内右侧

`.ntf-row` 从两列栅格（文本 · 信息条）扩成三列（文本 · **操作按钮** · 信息条）：按钮列 `auto`、
`justify-content: flex-end`、与标题首行同一条基线（沿用 `align-items: start` 的那条 20px 起始线 ——
所以 `_verify-notify-style` 的「信息条与标题首行对齐」仍然成立）。窄窗口允许换行，但两枚按钮仍成组靠右。
实测：内容 320–976、按钮 1000–1147、信息条 1171–1248（窗口右缘 1304 − 内衬 56 = 1248 ✓）。

#### 二、分屏：左栏滚动条贴左

`.editor-scroll` 在 `ui.editorMode === 'split'` 时加 `editor-scroll--split-left`：
容器 `direction: rtl`（Chromium 里纵向滚动条跟着书写方向走 ⇒ 贴左），**内容再 `direction: ltr` 复位**
（否则标点、数字与西文混排、列表编号的方向会跟着翻）。滚动条仍占那 6px 布局宽度，
所以两栏正文几何完全不变（实测 pane 520 / 滚动容器 520 / 内容 514），只是滚动条换了一侧：
两侧各自贴外缘，中间分界线干净。

#### 三、分隔条：按下只「加深一度」，不加宽

把手平时 3×36（`--edge-strong`）；hover 变 3×56 + `--accent`（**宽度始终 3px**，只动高度与颜色）。
**按下 / 拖拽期间宽度、高度、发光、缩放全不变**，只把颜色从 `--accent` 走到更深一档的 `--accent-ink`
（三主题各一档，见 `theme.css`）。热区仍从 11px 扩到 23px（为了好抓），但它的底是**透明**的 ——
`:active` 与 `.dragging` 都撤掉 hover 的软底，所以视觉上不会出现「点一下就变宽」。

| 状态            | 把手尺寸         | 把手颜色                     | 热区                 |
| --------------- | ---------------- | ---------------------------- | -------------------- |
| 静止            | 3×36             | `--edge-strong`              | 11px 透明            |
| hover           | 3×56             | `--accent`                   | 11px `--accent-soft` |
| **按下 / 拖拽** | **3×56（不变）** | **`--accent-ink`（深一档）** | 23px **透明**        |

实测：idle 3×36 `rgb(210,213,219)` → 按下 3×56 `rgb(55,65,81)`（= `--accent-ink`）→
拖拽中 3×56 同色、热区 23px 透明 → 松开回到 3×36。
（`:hover` 那一档在隔离窗口里量不到 —— CDP 的 `mouseMoved` 不产生真实 hover 命中，
所以 hover 只由 CSS 声明保证，按下/拖拽两档是实测的。）

#### 四、顺带修掉两条「批量跑才出现」的假失败（`_verify-surfaces`）

- **T 段主题循环**由 `sleep(900)` 改成轮询：批量跑时主题还没落地就量，令牌会落后一档
  （实测 dark 读到 light 的纸色、sepia 读到 dark 的）。稳定性判据必须**同时**包含实际表面色
  （body 与两个 pane 的计算色）—— 只等 CSS 变量不够：`body` 的 `background-color` 还有 ~300ms 过渡，
  实测读到过渡中间色 `rgb(19,21,26)` 而外壳是 `rgb(11,13,18)`，于是「body 就是外壳色」判红。
- **F2**（分屏左栏跟上且账本收敛）同样由定长 sleep 改成轮询到条件成立：批量负载下
  「右栏输入 → 序列化 → 回灌左栏 → 账本收敛」这条链 900ms 走不完（实测 `leftHas=false / stale=true`，
  单独跑 37/37）。轮询只去掉假红，不会造假绿：一直不收敛仍然判红。

验收：默认矩阵 **33/33**（`NOASSERT 0`）；`_regress-divider` 4/4、`_regress-split-live` 8/8、
`_verify-surfaces` 37/37、`_verify-link-open` 63/63（它点的是 `.ntf-action`，按钮换位置不受影响）、
`_verify-notify-style` 22/22、`_verify-notifications` 32/32、`_verify-toast-tip` 21/21、
`_regress-layout` 9/9、`_verify-segmented-control` 16/16、`_verify-cb-virtualization` 9/9。
另：单独跑时 `_verify-editor-menu` 51/51、`_verify-surface-stress` 72/72 ——
全量连跑里那两条红是**负载相关**的（stress 的「1MB 切回渲染 ≤26s」实测 38s，属机器忙/前序套件 GC 压力）。

### 4.76 表格保真：单元格里按回车不再让整张表退化成 HTML（用户报障）

**用户报障**：单元格「**实测痛点**」后按一下回车，`.md` 源码里整张表变成
`<table style="min-width: 50px;">…` 一整段 HTML。落盘后再打开，markdown-it 只当 HTML 块解析
⇒ **管道表结构丢失**（数据问题，不是显示问题）。

#### 一、根因：序列化判据过宽（两步复现）

1. 单元格里回车 → Tiptap 默认 `splitBlock` 在格子里多出**第二个段落**（既有行为，本轮**没动**）；
2. `lib/editor/tableMarkdown.ts` 的判据原来是 `cell.childCount !== 1 ⇒ 复杂表格 ⇒ 退回 HTML`，
   于是**一个不含任何内容的空段落**就把整张表打成了 HTML。
   空段落没有内容可保真、多段落也并非表达不了（GFM 单元格可以用行内 `<br>` 表达多行）——
   **判据本身就是根因**。

#### 二、修法（只改序列化侧）

| 改动                     | 说明                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `isSimpleTable()`        | 判据改成「表头在第一行 + 没有合并单元格 + 每格只由**段落**组成」，段数不限                                                                 |
| `cellInlineNode()`（新） | 把单元格的段落合成**一段**行内序列：空段落丢掉、非空段落之间插 `hardBreak`（`state.inTable` ⇒ `<br>`），再交给 `renderInline` **一次**渲染 |
| 换行处的标记符归位       | 「紧跟换行的、只由标记符组成」的尾巴提到 `<br>` **之前**                                                                                   |

三条踩过的坑（都是实测，别再走一遍）：

- **必须一次 `renderInline`**：标记符开合是状态机，分多次渲染再拼接会把闭合标记推到后面的内容里，
  写出 `**a<br>**` 这种尾巴上多一个空 `**` 的坏结构。
- **截出来必须立刻写回**（哪怕只是为了转义竖线）：`state.out` 与标记符状态必须同步。
- **标记符是真实文本**（§4.13）：光标停在「**实测痛点**」这种被样式包住的文字末尾时，
  回车切点落在**内容与闭合标记符之间**，闭合的 `**` 被留在第二个段落里
  （实测结构：段 0 = [`**`, 实测痛点]、段 1 = [`**`]）。序列化时把这个尾巴提到换行前之后，
  **回车这一步一个字都不改动源码**，而且输出幂等。

#### 三、验收

| 场景                                | 结果                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| 用户现场：单元格回车                | `\| **实测痛点** \| 36,005 字符…` —— 与回车前**逐字节相同**（旧行为是整表变 HTML）；重灌一次仍相同 |
| 回车后再打一行字                    | `\| **实测痛点**<br>第二行 \| …`（换行在样式对之外、无多余 `**`、仍不是 HTML）                     |
| 历史坏文档（一格两段 / 一堆空段落） | `\| 一格 \| 两段<br>真有内容 \|`（旧行为是 HTML）                                                  |
| 合并单元格                          | 照旧退回 HTML（**刻意钉住**：一条断言守着它别被顺手改坏）                                          |

新增 `tools/_verify-table-fidelity.js`（15 条：14 PASS + 1 SKIP，已进默认矩阵）。
相邻套件：`_verify-md-fidelity` 101/102、`_verify-table-width` 25/25、`_verify-surfaces` 37/37、
`_verify-inline-formats` 182/182、`_regress-layout` 9/9；默认矩阵 **34/34**。

#### 四、两条如实记录的边界

- **已知问题（与表格无关）**：行内标记符模型在**解析**时会把 `<br>` 读回样式对**内** ——
  `**实测痛点**<br>第二行` 重灌一次会再序列化成 `**实测痛点<br>**第二行`（随后是不动点，不再继续漂）。
  任何「加粗文字 + 硬换行」都一样（正文里的 Shift+Enter 同样），属行内标记符模型那条线，本轮不动。
- **已经落盘成 HTML 的文档不会自动修回来**：应用侧没有「HTML 表格 → markdown 表格」的转换。

### 4.77 大纲可放编辑区右侧（三栏模式，可选）+ 深色主题改中性灰

#### 一、三栏模式（设置项 `outlineOnRight`，出厂 **false**）

**用户口径**：加一个设置，把大纲放到编辑区右边（左目录 | 中编辑区 | 右大纲），这样目录和大纲能同时
看到；**默认沿用当前结构**（左栏里切「文件 / 大纲」页签），三栏只在显式打开后生效；打开后大纲可折叠。

- 设置项两个：`outlineOnRight`（出厂 false）+ `outlineRightExpanded`（出厂 true，仅前者打开时有意义），
  均落在 kv 里；默认值由 `tests/settingsDefaults.test.mjs` 钉住（「默认不动」是明确需求，写错会波及所有老用户）。
- 打开后：左栏页签行**整行隐藏**、只留文件树；编辑区右侧出现 `OutlinePanel.vue`（复用 `Outline.vue`）。
  展开 220px（顶部「大纲 + 收起箭头」+ 标题列表）／折叠 34px 窄轨（只留展开箭头）。
  折叠态刻意**不用浮层把手**：窄轨永远可见可点，也省掉指针热区那套逻辑。
- 打开时顺手把右侧面板设为展开、并把 `ui.sidebarTab` 收回 `files`（否则会看到「左栏停在大纲页签」
  或「右侧是折叠窄轨」，像是设置没生效）。
- 布局实现：`EditorView` 里给内核套一层横排容器（`flex min-h-0 flex-1`），内核仍是 `flex-1`，
  `data-editor-kernel` 锚点语义不变（查找栏与各套件依赖它）。
  ⚠️ 注意这次包装会让「带子的下一个兄弟就是内核」这类**DOM 相邻**假设失效 ——
  `_verify-notifications` 的 `stripBeforeKernel` 已改成用 `compareDocumentPosition` 判文档顺序（实测红过一次）。

#### 二、深色主题：中性灰，编辑区比侧栏浅一档

| 角色                     | 改前                  | 改后                                   |
| ------------------------ | --------------------- | -------------------------------------- |
| 外壳 / 侧栏 `--app`      | `#0b0d12`             | **`#2b2e33`**                          |
| 编辑区（纸）`--paper`    | `#12141a`             | **`#35383d`**（实测纸/壳 **1.157:1**） |
| 面板 / 浮层              | `#16181f` / `#1c1f27` | `#3a3d43` / `#454a51`（严格亮于纸）    |
| 表头 / hover `--panel-2` | `#1e2129`             | `#44484f`                              |
| 代码块底                 | `#1a1d26`             | `#303338`（比纸再暗一档）              |

主进程镜像同步：`shared/theme.ts` 的 `PAPER_BY_THEME.dark = '#35383d'`（`tests/themeTokens.test.mjs`
逐主题钉着它与 CSS 一致）。浅色与羊皮纸**一个字没动**。

调这一版时被两条既有断言逼回来的两处，值得记下来：

1. **`--panel-2` 不只是 chrome 的 hover 底**，它同时是**画在纸上的表头底**：放到 `#383b42` 时与纸
   只有 1.065:1，CDP 的 T6「表头在纸上可辨」判红 ⇒ 最终 `#44484f`（≈1.18:1）。
2. **`--panel` / `--elevate` 必须严格亮于纸**（`themeTokens` 不变量②）：第一版 `--panel` 取 `#33363b`，
   比纸还暗，单测直接红 —— 浮层会像凹进去的洞。

#### 三、验收

- `tools/_verify-outline-right.js`（**15 条**，已进默认矩阵）：默认结构不变（页签在、无右侧面板）/
  设置面板里那个开关真实可点 / 三栏几何（面板 1084→1304 = 220px，内核缩到 264→1084，面板在内核右侧）/
  面板列出文档标题 / 折叠（34px、列表消失、`aria-expanded=false`、按钮名变「展开大纲」）/ 展开回 220px /
  关掉即还原；套件自身**还原现场**不污染后续套件。
- 深色：单测 **300/300**（含 `themeTokens` 全部不变量 + 纸色镜像一致）；`_verify-surfaces` 37/37
  （逐主题量关系）、`_verify-neutral-accent` 10/10、`_verify-sidebar-tree-style` 32/32、
  `_verify-toc-style-scroll` 23/23；隔离实例实测 `body`/`aside` = `rgb(43,46,51)`、纸 = `rgb(53,56,61)`。
- 相邻：`_regress-layout` 9/9、`_verify-a11y` 6/6、`_verify-i18n` 5/5、`_verify-session` 17/17、
  `_verify-notifications` 32/32；默认矩阵 **35/35**。

#### 四、后续两处修正（用户口径）

1. **右侧大纲可拖宽**：左缘 5px 拖拽手柄（与左侧栏同一套做法），宽度落新设置 `outlineRightWidth`
   （出厂 220，钳位 **160~420**）；折叠态是窄轨、不出现手柄。拖拽期间关掉宽度过渡（否则会追着指针滑）。
2. **箭头方向永远不变**（「不论收起还是展开都是 `<`」）——**根因在 `Icon.vue` 而不是面板**：
   它原来在 setup 里调一次 `parts()` 再解构 `paths/circles/rects`，那是一份**静态快照**，
   `name` 变化不会重算。所以面板的宽度、`aria-label`、`title` 全跟着状态翻转，**只有箭头是死的**。
   改成 `computed` 后：展开 `chevron-right`（`m9 18 6-6-6-6`）、折叠 `chevron-left`（`m15 18-6-6 6-6`），
   两态的 `path d` 实测不同。这是**组件级**修复 —— 任何「动态 name」的图标都跟着受益。
3. 套件随之加到 **22 条**：箭头方向（守上面那个响应式 bug）、折叠态无手柄、
   拖宽后设置同步、两端钳位 420/160。

### 4.78 默认为手动保存 + 状态栏保存格去噪 + 取消列表入场动画

**用户口径**：① 保存模式默认改手动保存；手动时状态栏不要再显示「手动保存」四个字；自动保存时那一格的
文字不要强调色、统一成同一种灰，并取消前面的小圆点。② 取消「项目出场」的动画。

#### 一、默认保存方式：自动 → 手动

`defaults.ts` 的 `autoSave: false`。三条一起写清楚：

- 为什么该默认手动：自动保存会在作者还没写完一句时就把半成品写进磁盘，
  外部同步盘/版本工具会看到一串中间态；
- **手动 ≠ 丢字**：关窗/异常退出仍写草稿（`drafts` 那套与 `autoSave` 无关），关窗也有脏确认；
- 兼容性：设置落在 kv 里，**已有用户不受影响**，只有全新 profile 拿到新默认值。

#### 二、状态栏那一格：只说状态，不说模式；无圆点、无强调色

| 项                   | 改前                                                         | 改后                                                                      |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 文字                 | 手动模式恒显示「手动保存」；自动模式显示保存中/未保存/已保存 | 两模式统一显示 **保存中 / 未保存的更改 / 已保存**（不再出现「手动保存」） |
| 圆点                 | 自动模式带 `bg-ok` / `bg-warning` 小圆点（保存中还 ping）    | **整个圆点删掉**                                                          |
| 颜色                 | `text-ok` / `text-warning` 强调色                            | 与状态栏其它项**同一个灰**（实测都是 `rgb(138,145,158)`）                 |
| `title`/`aria-label` | 就是那行文字                                                 | 改成「保存方式：手动保存」——**说明当前模式 + 可点切换**                   |

最后一行是这次改动里唯一需要动脑的地方：可见文字变短之后，界面上仍要能回答
「现在是哪种保存」与「点它能换吗」，所以把这两条放进 `title`/`aria-label`，
而保存方式本身仍完整写在点击后的弹层里（那里的「自动保存 / 手动保存」文案没动）。

#### 三、取消启动遮罩的过场动画（用户澄清后重做的部分）

原先这句「取消项目出场的动画」我先理解成了**列表条目**的入场动画，删掉了 `.list-enter-*` /
`.link-row-enter-*` —— **那是误读**，已原样恢复（文件树 / 文件列表 / 大纲 / 全局搜索结果的行照旧淡入）。
用户澄清要的是：**打开应用时那块遮罩的过场动画**。对应实现是 `App.vue` 里

```html
<Transition name="fade"><SkeletonScreen v-if="ui.booting" /></Transition>
```

处理：去掉外面那层 `<Transition>` —— 骨架屏**保留**（启动期间盖住半初始化的 UI、避免闪色），
但**就绪后直接消失、不再淡出**。`.fade-*` 那套 CSS 不能删（设置浮层 / 全局搜索 / 草稿弹窗还在用）。

判据写进套件（`boot-mask-has-no-transition`）：把 `ui.booting` 打开 → 骨架屏立刻出现且
**不带任何 `*-enter-active` 类**；关掉 → **60ms 内**从 DOM 消失。有 fade 时它会多留 ~200ms，
这条断言就是用来钉住「没有那 200ms」的（而不是靠肉眼判断"看着是不是不闪了"）。

#### 四、验收

- `tools/_verify-bars-no-filename.js` 11 → **16 条**（新增四条见上表 + 列表入场规则数）并**纳入默认矩阵**；
- 全新 profile 实测：`autoSave === false`、状态栏 `已保存`、无圆点、颜色与统计项一致；
- `tests/settingsDefaults.test.mjs` 钉住「默认手动 + 间隔仍为正数」；单测 **301/301**；
- 默认矩阵 **36/36**（`NOASSERT 0`）。

### 4.79 侧栏头部整行去掉（文件夹成为目录树顶层节点）+ 大纲位置进工具栏 + 工具带悬停动效

**用户口径**（三条）：
① 侧栏上方"显示文件夹名称"的那块区域「最近打开的文档」「新建文档」取消、文件夹名也取消，
但文件夹要**作为目录树结构的顶层文件夹**（像 Typora）；
② 大纲放在编辑器左侧/右侧，也要出现在**顶部工具栏的视图工具**里；
③ 侧栏下方的搜索与切换视图，鼠标放上去/拿开时要有出现与消失的动效。

#### 一、头部整行去掉，文件夹改当树顶那一行

| 项           | 改前                                                                       | 改后                                                                                         |
| ------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 侧栏第一行   | `📁 文件夹名`（点击重新选文件夹）+ 最近文档 + 新建文件（列表视图还有刷新） | **整行不存在**（只剩页签行）                                                                 |
| 文件夹名     | 头部那一行标题                                                             | `FileTree` 的**第一个 `TreeNode`**（`data-tree-root-row="true"`），可展开/收起、可作拖放落点 |
| 一级条目缩进 | `depth 0`                                                                  | `depth 1`（`aria-level` 2，`data-tree-parent` = 根路径）                                     |
| 「刷新」     | 头部按钮（仅列表视图）                                                     | 面板底部文件工具带（仍**仅列表视图**；树视图由 `fs.watch` 自更新）                           |
| 无工作区时   | 头部同一位置是「打开文件夹」                                               | **整行也不存在**（§4.84 的口径：没开文件夹时侧栏里只剩页签，文件区一个按钮一句提示都没有）   |

顶层那一行**不是**工作区里的普通条目，`TreeNode` 用新的 `isRoot` 分支关掉四件事：
不可拖动（拖走整个工作区没有意义）、F2 重命名、Delete 删除、「移动到…」；
右键只弹**根菜单**（新建文件 / 新建文件夹 / 刷新 / 关闭工作区）。
根菜单抽成 `composables/useWorkspaceRootMenu.ts`：树容器空白处与顶层行弹的是同一份
（此前那段逻辑只长在 `FileTree.onRootContextMenu` 里，直接复制会给"两处慢慢走样"埋雷）。

搜索过滤的口径跟着下沉到 `TreeNode.visibleChildren()`：**目录永远留着**、只按名字过滤文件
（与改造前"顶层目录不过滤"完全一致，现在每一层都这样 —— 否则搜 `guide` 时，位于 `docs`
目录里的那篇 `guide.md` 会因为父目录名不匹配而整支消失）。

#### 二、大纲位置（左栏 ⇄ 编辑区右侧）：工具栏视图区 + 视图菜单 + 命令表

- 唯一实现是新的 `composables/useOutlineSide.ts`：设置面板那枚开关改成转发它，工具栏与菜单共用。
  打开时"右侧面板展开 + 左栏页签收回文件"（原有口径）；
  关掉时**恢复成打开前那一页**（第十轮改成这样，取代了当时"一律切到大纲"的写法；详见 §4.85）。
- 工具栏那一枚是**状态开关**（`data-outline-side`，active = 现在在右侧），提示文案说下一步；
  刻意**不用第二枚分段控件**：工具栏里已有一枚三段控件，两枚会互相抢视觉，而且
  `_verify-segmented-control.js` 的"分段控件恰好两处"是既有口径。
- 另外补了应用内「视图」菜单项（文案与开关 title 同源，`active` 打勾）、
  原生菜单项（`outline-side` 命令，三语）、命令注册表 `view.outlineSide`（出厂不绑键）。

#### 三、底部工具带：出现与消失都有动效

问题出在 `visibility` 是离散属性：旧写法 `transition: opacity .15s` 会让它在过渡**一开始**
就翻成 hidden，把仍在淡出的那一帧掐掉 —— 表现就是"进去柔和、出来生硬"。

现在：隐藏 = 淡出 + 下沉 6px **走完**才翻 `visibility`（`transition: … visibility 0s linear .18s`），
出现 = 反向的同一组过渡（`visibility 0s`）；只动 `opacity` / `transform`（合成层），
`prefers-reduced-motion` 下三样全关。三个显示条件（`aside:hover` / `aside:focus-within` /
`files--pinned`）一个没动。

#### 四、选中态：去掉左侧那条 3px 灰色条，只留层级竖线（用户口径）

树里同时存在两种"线"，用户问该留哪个。结论：**留层级竖线（`[data-tree-children]::before`），
删掉选中行左侧那条 3px 浅灰色条（`.tree-row.is-current::before`）**。理由：

- 选中已经有**三重**提示：整行 `--accent-soft` 底 + `--accent-ink` 文字（500 字重）+ `--accent` 图标；
  灰条是第四重，而且**只有它是中性色** —— 一灰一蓝说同一件事，冗余感主要来自这个颜色冲突。
- 灰条贴在侧栏最左缘（x≈0），而层级竖线画在**箭头中线**上（`--tree-pad + depth*16 + 7`）。
  文件在两三级深时两者差 40px 以上：灰条已经脱离那一行的内容重心，"指出位置"的作用被竖线
  和缩进抢走，噪音却留着。
- 它也不是滚动锚点（逐行绘制、跟着行一起滚），没有"看不到选中项时还能定位"的额外价值。

层级竖线是另一类信息（我在哪个文件夹里）、只在展开目录下出现、只有 38% 透明度、不表达状态，
所以保留。**顺带保住的判据**：`selected-state-does-not-shift-content` —— 挂/摘 `is-current`
时 `label` 左缘必须一像素不差（底色与字重都不该动盒模型）。

#### 五、验收

- 新套件 `tools/_verify-sidebar-root-and-outline-side.js`（**31 条**）进默认矩阵：
  头部不再有文件夹名/最近/新建（侧栏里第一个按钮就是页签）、顶层行 = 工作区根且默认展开、
  子级整体下沉一级、顶层行不可拖动且不是"当前文档"、顶层行右键只有根菜单且不含重命名/删除、
  工具带的过渡参数（`visibility` 延迟 ≥ 0.1s）+ 真实鼠标进出四拍、刷新只在列表视图的工具带里、
  工具栏开关与「视图」菜单项是同一条实现（点完右侧大纲面板出现/消失、左栏页签跟着走）。
- `tools/_verify-sidebar-search.js` 的 C 段边界从"侧栏头部工作区按钮"改成"侧栏页签"
  （头部那行已不存在，断言要点不变：`[data-sidebar-files]` 之外不抢 Ctrl+F）；
  `_verify-sidebar-refresh.js`（8 条）改成验"工具带里的刷新、仅列表视图"；
  `_verify-welcome-removed.js` 的"侧栏最近文档下拉"整段改走「文件 → 最近文档」二级菜单
  （`RecentList.vue` 是同一个组件，固定/清除/列出三条覆盖不丢；两条"滚动关菜单"跟着
  侧栏下拉一起退役 —— 那条规则仍由 `_verify-editor-menu.js` 的 C 段与导出弹层守着）；
  `_verify-notifications.js` 的"最近列表移除 → 撤销"入口同样改走文件菜单。
- 验收实测：单测 **736/736**；`vue-tsc` / `eslint` 0 error；`npm run ci` 0；
  默认矩阵 61 条里 **60 条全绿**，唯一红的是本套件自己 —— 当时它跑的是**改动前的构建**，
  缺"搜索时自动展开收起的顶层节点"那条行为，重建后单跑 **31/31**，
  连同文件树相关的 `_verify-sidebar-tree-style`（32）/ `_verify-wave3`（23）/
  `_verify-sidebar-search`（10）/ `_verify-a11y`（23）/ `_verify-welcome-removed`（32）
  一起复跑全绿。
- 一处**顺带补上的状态**：顶层文件夹可被用户收起，而"收起 + 搜索"会得出"什么都没搜到"的假象
  （命中项都在收起的子树里）—— `FileTree` 因此在筛选词变化时确保顶层节点是展开的
  （只在已收起时展开，用户手动收起且不搜索时不受打扰），套件里 `search-re-expands-the-collapsed-root`
  与 `search-results-are-visible-again` 两条钉住它。

### 4.80 手动保存模式下关窗问「是否保存更改？」（对齐 Typora 的实测行为）

**用户口径**（附他自己的实测）：Typora 默认是手动保存，需要在设置里开启自动保存；
未启用自动保存时关闭会提示「是否保存更改？／如果不保存，您的更改将会丢失。」—— Lumin 也要这样。
（这一条纠正了我此前"Typora 默认开启自动保存"的错误说法：他的机器上默认是手动，实测为准。）

#### 一、改造前是什么行为（要防的回归）

关窗**一句都不问**：`files.flushAll()` 直接把有路径的文档落盘、未命名文档只写草稿 ——
老注释写得很明白：「避免关闭时弹出保存对话框」。对选了手动保存的用户来说，这是
"我没让它保存，它自己保存了"：磁盘上悄悄出现一份他没打算写进去的版本。

#### 二、现在的口径

| 情形                               | 关窗时做什么                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 自动保存**开着**                   | 不问，直接落盘（改动本来就在写盘路上）                                                               |
| 手动保存 + **脏** + 关窗/退出应用  | 弹三选一：**保存 / 不保存 / 取消**（标题「是否保存更改？」，正文「如果不保存，您的更改将会丢失。」） |
| 手动保存 + 干净                    | 不问（没什么可丢的）                                                                                 |
| **系统关机/注销**（`session-end`） | 不问，直接落盘 —— 系统不会等用户点按钮，弹出来只会把窗口卡在一条没人能回答的对话框上                 |

判定收在纯函数 `shared/closePrompt.ts` 的 `planClosePrompt({ autoSave, dirty, reason })`
（单测 5 条）：这条规则同时被「默认保存方式」「退出路径」「系统关机」三处口径影响，
埋在 `requestClose` 里就只能靠真开关窗去试。

三条出路各自的收尾（写清楚是因为它们的失败方式互不相同）：

1. **保存** → `files.save()` 后落盘关窗。未命名文档会走「另存为」——
   **取消另存为或写盘失败就不关窗**（用户以为自己保存了才是最糟的结果）。
2. **不保存** → 不落盘（**不能**走 `flushAll()`，它会保存有路径的文档），并且把这一篇的**草稿一起删掉**
   （`files.discardCurrentDraft()`）：草稿是崩溃兜底、编辑期间一直在写，留着它下次启动就会弹
   "检测到未保存的草稿（比磁盘文件更新）" —— 与用户刚选的"不保存"自相矛盾。
   这条路上有两个**必须堵住的口子**，都是跑套件时实测出来的：
   - `EditorView.onBeforeUnmount` 还会兜底调一次 `flushAll()`（窗口销毁路径，它会保存有路径的文档 +
     写草稿）—— 不拦住的话用户刚选的「不保存」会在窗口消失前被那条兜底推翻。加 `files.discardOnClose`
     让它变成空操作，由 `requestClose` 每轮复位；
   - 草稿写盘是**发了不等**的（`void this.writeDraft()`）：删除动作可能抢在那次 IPC 之前完成，
     于是草稿在删除**之后**又被写回磁盘。所以先把已经在飞的那一次 await 回来（`files.draftWrite`）再删。
3. **取消** → 窗口继续活着。这一条**需要主进程配合**，两件事：
   ① 新增 `app:cancelClose`（`main/ipc.ts`）清掉这一轮守卫状态（顺带 `session.clearQuitting()` 复位 ——
   它是"窗口槽位要不要保留"的判据，留着会让之后的**单独**关窗被误当成整体退出、
   把用户明确关掉的窗口在下次启动又拉回来）。不撤守卫的话：`close` 那一刻它就起来了，
   渲染层在等用户点按钮时没人在落盘 ⇒ 连续 `CLOSE_FALLBACK_MS`（2.5s）没心跳就强关。
   ② 心跳带 `deciding: true` 表示"正等人回答"：**这段等待不计入 30 秒总上限**
   （`CLOSE_FALLBACK_MAX_MS`）—— 总上限防的是"渲染进程卡死却一直发心跳"，
   而用户在对话框前想多久都合法（Typora 也一样）；不问的话用户犹豫 30 秒，
   窗口会在他点「取消」之前被强关。卡死仍然兜得住：那时连 `deciding` 的心跳也停了，
   2.5 秒判据照常生效。

配套的接口改动：

- `app:before-close` 的 payload 从 `{ quitting }` 扩成 `{ quitting, reason }`，
  `reason ∈ window | quit | session-end`。渲染层据此决定问不问 ——
  这让"系统关机不问"成为一条**写下来的口径**，而不是靠"反正也来不及"；
- 三选一确认框加在既有的 `ModalHost` 上（`ui.confirmTriple` → `resolveTriple('confirm'|'alt'|'cancel')`，
  钩子 `data-triple-confirm` / `data-triple-alt` / `data-triple-cancel`，根节点 `data-triple="true"`）：
  两键的 `ui.confirm` 表达不了三个答案，而"用两张对话框串起来"最容易出的事故是
  "我问了保存吗？他以为是取消"。Esc 与点遮罩 = 取消（关窗场景里唯一安全的默认）。

#### 三、验收

- 新套件 `tools/_verify-close-save-prompt.js`（**21 条**，自管实例 4 轮，进默认矩阵）：
  R1「取消」（文案逐字 + 三按钮 + **取消后 3.2 秒窗口仍活着** —— `app:cancelClose` 的回归防线 +
  磁盘未动 + 缓冲区仍是脏的）；R1b「保存没成功」（把 `files.save` 换成返回 false，等价于
  「另存为被取消」→ 点「保存」后窗口仍活着、改动还在）；R1c「在对话框前等 32 秒」
  （跨过 30 秒总上限，窗口仍活着，之后点「取消」照样生效）；R2「不保存」（窗口关掉 + 磁盘未动 +
  **草稿被删**）；R3「保存」（窗口关掉 + 磁盘是新内容）；R4「自动保存开着」（关窗那一刻确实是脏的，
  但不弹框、直接落盘关窗）。自管实例的原因写在套件头：关窗是**真的把窗口关掉**，
  一个实例验不完这些出路。
  套件头还记了两条**排查用的坑**（都踩过）：① 关窗那条路最终会把页面关掉，所以
  `Runtime.evaluate` 的响应**永远不回来** —— 触发关窗必须"发包不等回执"，否则进程静默退出、
  运行器只看到 NOASSERT；② 应用退出时 9222 会先"半开"一小会儿（连接建上但既不回数据也不报错），
  探针必须带超时，否则同样静默退出。套件的退出钩子也会在"没跑完"时打一条
  `FAIL suite-ended-early`，不让半途死掉被当成全绿。
- `tests/closePrompt.test.mjs` **5 条**（手动+脏→问、退出也问、自动保存→不问、干净→不问、
  关机→不问且与"关窗"必须不同）。
- `tools/_verify-close-guard.js` 改成先 `autoSave = true` 再关窗（它量的是"慢落盘不被强杀"，
  走"不弹框直接 flush"那条路最干净；三条出路由新套件专门守）。

### 4.81 状态栏去掉「保存状态」那一格 + 整条透明

**用户口径**（两条，一起做）：① 底部状态栏的**保存状态区域去掉**，不论自动保存还是手动保存都不显示；
② 底部栏**变成透明状态**。

#### 一、去掉的是哪一块

状态栏最左边原先那一格（`data-save-cell`）：写着「保存中…／未保存的更改／已保存」，
写盘失败时变 danger 色并带 `data-save-error`，点开还能切「自动保存／手动保存」并进设置页。
现在**整块删除**（连同那层弹层）：

- **保存结果在别处已有反馈**：保存成功 = 内容落盘 + 标题栏脏标记消失；写盘失败仍会往通知中心
  留一张**持久卡片**（`files.saveNow` 那条路，`_verify-save-safety` 的 F 段继续守着）；
  "正在保存"这种瞬时态不值得常驻一行文字；
- **保存方式只剩一个入口**：设置 → 通用 → 自动保存（弹出层里那三个 i18n 键
  `statusbar.saveMode` / `autoSave` / `manualSave` 与 `statusbar.openSettings`、
  `statusbar.saveModeDetail` / `saveFailedDetail`，以及 `editor.saved` / `saving` / `unsaved` /
  `saveFailed`、`settings.autoSaveDesc` 一并删除 —— 留着就是零引用的死键，
  `tests/i18nKeys.test.mjs` 会当场变红）。

#### 二、透明：连顶部分隔线一起去掉

原来这一条是 `border-t border-edge bg-app`。现在 `bg-transparent` + **去掉 `border-t`**：
它不再是"压在页面底下的一条带子"，只剩一行贴在背景上的信息（浅色主题下背景是外壳的 `#fafafa`，
与白纸之间只剩一层很淡的色差，没有线）。
另加 `data-status-bar` 锚点：`_verify-bars-no-filename.js` 原先靠 `h-7 + border-t` 这两个 class
嗅探它，去掉边框后必然找不到（那条断言会以"状态栏不存在"的形式假红）。

> 想要"底栏也是白纸"而不是"透明"的话，把 `bg-transparent` 换成 `bg-paper` 即可（一个词）。
> ——**这句后来真的用上了**：见 §4.82 末尾（用户拍板"一张纸到底"，底栏改用纸色，
> §4.81 这里的"透明"口径随之被取代；"没有保存状态格"与"没有顶部分隔线"两条保留）。

#### 三、验收

- `tools/_verify-bars-no-filename.js` **16 → 21 条**：删掉四条"保存状态格"的断言
  （文字 / 无圆点 / 同灰 / 只说状态不说模式），新增三条：
  `statusbar-has-no-save-state`（没有 `[data-save-cell]`，整条里也不出现"已保存/未保存/保存中"字样）、
  `statusbar-is-transparent`（computed background 必须是 `rgba(0, 0, 0, 0)`）、
  `statusbar-has-no-top-border`（`border-top-width: 0px`）；定位改用 `data-editor-toolbar` / `data-status-bar`；
- `tools/_verify-save-safety.js` F 段把"状态栏红态"那条改成 `status-bar-has-no-save-cell`，
  "失败必须看得见"改由**持久通知卡片**那一条承担；
- `tools/_verify-local-media.js` 里那条「状态栏『打开设置…』仍生效」随弹层一起删掉，
  换成"那一格确实不在了"的边界断言。

### 4.82 顶部菜单栏与快捷工具栏改成「纸」色（与编辑区同色）

**用户口径**：① 把顶部工具栏（应用内菜单栏）和编辑工具栏的颜色改成白色，**和编辑区域一个颜色**；
② 先提交一次 git，万一不好看可以回退。

#### 一、改了什么

两条栏的根 class：`bg-app` → **`bg-paper`**。

|                               | 改前                       | 改后                                                    |
| ----------------------------- | -------------------------- | ------------------------------------------------------- |
| 应用内菜单栏 `TopMenuBar.vue` | `bg-app`（浅色 `#fafafa`） | `bg-paper`（浅色 `#ffffff`，与写作区同色）              |
| 快捷工具栏 `Toolbar.vue`      | `bg-app`                   | `bg-paper`                                              |
| 分隔线                        | `border-b border-edge`     | **保留**（给这一条栏一个可辨的下边缘）                  |
| 深色 / 羊皮纸主题             | 跟随 `--app`               | 跟随 `--paper`（口径是"与编辑区同色"，不是写死 `#fff`） |

#### 二、验收

- `tools/_verify-bars-no-filename.js` 21 → **24 条**，新增：
  `menu-bar-follows-paper`、`editor-toolbar-follows-paper`（两条栏的 computed background
  必须**等于 `--paper` 的解析值**）、`bars-differ-from-chrome-in-this-theme`
  （当前主题下 `--paper` ≠ `--app` —— 否则上面两条等于没验到东西）。
- 顺带复跑（都是对颜色/主题敏感的套件）：`_verify-surfaces` 37/37、`_verify-neutral-accent` 10/10、
  `_verify-theme-auto` 11/11、`_verify-toolbar-settings` 38/38、
  `_verify-sidebar-root-and-outline-side` 31/31，全绿。
- 视觉留证（隔离实例、浅色主题、1304×821）：`%TEMP%\lumin-bars-full.png`
  —— 菜单栏 / 工具栏 / 写作区连成同一块白；底栏是一条**没有分隔线**的淡灰信息行。

#### 三、底栏一并改成纸色（用户拍板"一张纸到底"）

§4.82 讨论时给过两条自洽的路：**① 一张纸**（顶栏 + 写作区 + 底栏都用 `--paper`，只留左侧栏是外壳灰）、
**② 全外壳色**（顶栏退回 `bg-app`，底栏维持透明=淡灰）。判据是"色差 ≥ 约 1.08:1 两段式才立得住，
且所有 chrome 必须一致"——而浅色主题下 `#fafafa` 与 `#ffffff` 只有 **≈1.04:1**（深色 ≈1.16:1，
所以两段式只在深色成立），于是选了①。

改动：底栏 `bg-transparent` → **`bg-paper`**（`border-t` 仍然不画 —— 这一行是信息不是带子；
上方两条栏各自的 `border-b` 已经交代了边界）。于是整个窗口只剩**左侧栏**一处外壳色，
它也就成了唯一一条真正的分界线。
套件里那条 `statusbar-is-transparent` 随之换成 **`statusbar-follows-paper`**
（底栏 computed background 必须等于 `--paper` 的解析值），`statusbar-has-no-top-border` 保留。

### 4.83 状态栏重排：左=文档｜右=视图与入口（并砍掉版本号 / 语言 / 主题 / 阅读时长）

**用户口径**（原话拆条）：去掉版本号、语言切换、主题切换、阅读时间；标签**仅在有标签时**显示；
布局改成 **左 = 文档（统计/标签），右 = 视图与入口（行列/编码/行尾 + 一个 `⋯`）**。

#### 一、为什么原来读起来是"杂乱且无序"

| 症状               | 具体表现                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| 四类东西混在一排   | 文档统计（字/行/字符）、文档元信息（编码/行尾/标签）、**设置**（主题/语言）、**版本号**         |
| 三段式失衡         | 左边空着、中间被 `flex-1` 顶到正中间、右边挤一堆 —— 三个视觉落点，没有一条扫读路径              |
| 有重复与低价值项   | 中英混排下"字符"与"字"几乎重复；"行 4"和"行1,列1"两个"行"容易混读；阅读时长由字数推导，增量最低 |
| 常驻的稀有态与动作 | `UTF-8` / `LF` 都是默认值却常驻；"添加标签"是**动词短语**混在名词堆里                           |
| 无层级             | 全部同一灰度同一字号，唯一的分隔符只有一处竖线                                                  |

行业口径（写作类 Typora/Notion/Bear 极简 vs IDE 类 VS Code 严格分区）的共识是同一条：
**状态栏只放"会变化的高频状态"**；默认值不常驻、设置与版本不进状态栏、稀有态才出现。

#### 二、改成了什么

```
左： 24 字   4 行   31 字符   [目标字数(设了才有)]   [标签(有标签才有)]
右： 行 1, 列 1    UTF-8    LF    │    ⋯
                                        ├ 外观：跟随系统 / 浅色 / 深色 / 羊皮纸
                                        ├ 语言：简体中文 / English / Русский
                                        ├ 添加标签…
                                        ├ 设置
                                        └ 关于 Lumin（版本号在这里，不再在状态栏）
```

- **删掉**：版本号（`app.getVersion` 那次调用与那个 span 一起去掉；版本只在「关于」页）、
  语言按钮（`nextLanguage` 循环切换）、主题弹层（原来那枚写着当前主题名的按钮）、
  预计阅读时长（`data-status-reading-time` 整块）；
- **标签格**：`v-if="docTags.length"` —— 没标签就不渲染。于是"第一次加标签"必须有别的入口，
  放进 `⋯`（`data-more-edit-tags`，文案 `statusbar.addTags`），否则就是个死角；
- **`⋯`**：`data-status-more` + 菜单容器 `data-status-more-menu`，行内钩子
  `data-more-theme` / `data-more-language` / `data-more-edit-tags` / `data-more-settings` /
  `data-more-about`。菜单**向上弹**（它在窗口最底边），与原先主题弹层同一个 `pop` 动效；
- **i18n**：新增 `statusbar.more`；`statusbar.addTags` 保留（"添加标签…"）；删除变成死键的
  `statusbar.switchLanguage` 与 `statusbar.readingTime` / `readingTimeHours` /
  `readingTimeHourMin` / `readingTimeTooltip`（`tests/i18nKeys.test.mjs` 会当场判红）；
  主题/语言的**分组标题**直接复用 `settings.appearance` 与 `settings.language`。
- **阅读时长的口径保留**：`shared/readingTime.ts` 与它的单测都还在（`wordGoalProgress` 仍被目标字数用），
  只是不再在界面上显示 —— 删的是"显示"，不是"算法"。

#### 三、验收

- `tools/_verify-bars-no-filename.js` 24 → **26 条**：删掉两条阅读时长断言，
  新增 `statusbar-has-more-entry`、`statusbar-has-no-reading-time`、`statusbar-has-no-version`、
  `statusbar-hides-tag-cell-when-no-tags`、`more-menu-holds-low-frequency-entries`
  （4 个主题 + 3 种语言 + 标签/设置/关于三项都在菜单里）；原来的
  `statusbar-keeps-theme-and-language` 换成上面的 `⋯` 断言；
- `tools/_verify-tags.js`（7 条）：① 改成"没标签时**不该有**标签格"，
  ② 加标签的真实交互改走 `⋯` →「添加标签…」，③ 断言加完之后标签格自己长出来（端到端证明"有标签才显示"）；
- `tools/_verify-local-media.js`：状态栏主题选择改走 `⋯` 里的 `[data-more-theme="…"]`；
- 顺带修掉一条**早已过期**的断言：`tools/_verify-toast-tip.js` 的
  `strip-is-previous-sibling-of-kernel` 用 `nextElementSibling` 判"通知带紧邻内核"，
  而三栏大纲那轮给内核套了一层 panes 容器（`div.flex.min-h-0.flex-1`）⇒ 它一直是红的
  （该套件属 `needs-build` 档、不在默认矩阵里，所以没被日常回归发现）。
  改成 `compareDocumentPosition` 判文档顺序（与 `_verify-notifications.js` 同款修法），
  断言名改为 `strip-before-kernel-in-document-order`，现在 21/21。
  **教训**：在这类套件的模板字符串里，注释中不能出现反引号 —— 会提前结束模板串（本轮踩了两次）。
- **排查用的一次性探针，绝不要复用矩阵的 userData / 9222**：本轮我用
  `%TEMP%\lumin-suites-ud`（`run-suites.js` 的实例目录）起了个手工探针、往里写了一条通知，
  结果下一次矩阵里 `_verify-notifications` 假红 7 条（计数与状态被那条通知搅了），
  再往后还因为**遗留实例占着 9222** 让两条套件变成 NOASSERT（`start-isolated.ps1` 只在**开始时**
  判端口，起完之后 9222 归谁它就不管了 —— 端口被别的实例占着时它会报出一个"假的 READY"）。
  正确做法：探针用**独立的** `-UserData`（例如 `%TEMP%\lumin-probe-ud`），收尾时
  `-CleanupOnly` + 按 user-data-dir 精确杀进程，确认 9222 空闲再跑矩阵。

> 回退方式：这一步是**提交之后**做的，`git checkout -- .` 即可整体丢弃
> （提交 `74d5e510` 是"底栏透明 + 保存态去掉"的还原点）。

### 4.84 没打开文件夹时侧栏彻底空着；Ctrl+F 在侧栏里改搜文件名

**用户口径**（同一轮三条）：

1. 新建一个**没有打开任何文件夹**的窗口时，取消侧栏最上方那一小行「打开文件夹」；
2. 同样这种窗口，**文件区里的所有按钮与文字提示**都取消；
3. 在**左侧侧边栏区域**按 `Ctrl+F`，打开的是**侧栏的搜索**，而不是当前文档内容的搜索。

三条其实是一条：**"没开文件夹"的侧栏要真的空着**，而"人在侧栏里"时快捷键要跟着走。

#### 一、删掉侧栏顶部那一小行「打开文件夹」（第 1 条）

`AppSidebar.vue` 里 `v-if="!files.root"` 的那一行（`data-sidebar-open-folder`，
图标 + 「打开文件夹」文字）整行删除。

来龙去脉值得记一句：`docs/changelog/archive-02.md` 里记着上一轮"**先删后按口径恢复**"——
当时用户的说法是"没打开任何文件夹时，左侧侧栏上方工具栏的「打开文件夹」要保留"。
本轮口径**反转**（要求侧栏空着），所以这一枚也去掉了；有工作区时那一行本来就不存在
（文件夹名是目录树的顶层节点，§4.79）。打开文件夹的入口仍在：顶部菜单「文件 → 打开文件夹…」
（含最近的文件夹）、`Ctrl+Shift+O`、以及窗口跳转列表。

#### 二、文件区里连"首次引导块"一起下线（第 2 条）

`FileTree.vue` 里原来还有一块挂在纯函数 `shouldShowOnboarding` 上的**首次引导块**
（`OnboardingPanel.vue`：标题「开始写作」+ 一句说明 + 新建文件 / 打开文件夹 / 插入示例文档
三枚按钮 + 示例说明文字）。它的出现条件是"**没有工作区 且 还没有真正在编辑的东西**"，
也就是用户说的"新建一个没有打开任何文件夹的窗口"——正是要清掉的那一堆按钮和文字。

删干净为原则（不留没有界面的死码），随之下线的还有：

| 删掉的东西                       | 说明                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `components/OnboardingPanel.vue` | 引导块本体（三枚按钮 + 文案 + 插示例的确认框）                    |
| `lib/onboarding.ts`              | `shouldShowOnboarding` 纯函数与 `SAMPLE_DOC_KEY`                  |
| `tests/onboarding.test.mjs`      | 11 条单测（**已删**，随功能一起下线）                             |
| 三语 `onboarding.*`（9 个键）    | 含整篇 `onboarding.sampleDoc` 示例文档（中/英/俄各一份 Markdown） |
| 三语 `open.openFolder`           | 只被那一行按钮引用，删完就是死键（`tests/i18nKeys` 当场判红）     |

> **能力变化要说清楚**：**「插入示例文档」这条路没了**（首次启动不再有示例可插）。
> 「新建文档 / 打开文件 / 打开文件夹」都还有菜单与快捷键入口，只是侧栏里不再重复一遍。
> 想让首次启动仍有引导的话，正确的做法是给它一个不占侧栏的位置（例如空编辑区里的一层），
> 而不是把按钮塞回侧栏——那也是本轮之前"欢迎页 → 侧栏空态"一路收敛下来的方向。

#### 三、Ctrl+F：判据从"文件面板内"放宽到"整个左侧栏"（第 3 条）

第八轮做过一次分流，但当时把"侧栏"限定在文件面板 `[data-sidebar-files]` **内部**
（`isFocusInSidebarFiles()`）。于是下面三种现场仍然会弹出**正文查找栏**，正是用户报的现象：

| 现场                                | 旧判据为什么漏掉                                 |
| ----------------------------------- | ------------------------------------------------ |
| 焦点在侧栏**页签**（文件 / 大纲）上 | 页签在 `[data-sidebar-files]` **外面**           |
| 点在树行之间的**空白**处            | 空白不可聚焦，焦点压根没挪进面板（还在编辑器里） |
| 鼠标在侧栏里、焦点在编辑器          | 旧判据只看焦点，不看指针                         |

现在：

- 新增区域锚点 `data-sidebar-root`（挂在 `AppSidebar.vue` 的 `<aside>` 上）；
- 判定收进纯函数 **`lib/ctrlFRoute.ts`**：`有工作区 ∧ 文件面板可见 ∧（焦点在侧栏 ∨ 指针在侧栏）`
  → `sidebar-files`，否则 `document`；单测 `tests/ctrlFRoute.test.mjs` **6 条**；
- 现场判定在 `useAppActions.ts` 的 `ctrlFTargetNow()`：读 `document.activeElement.closest('[data-sidebar-root]')`
  与 `[data-sidebar-root]:hover`（指针那一半必须用真实指针事件，合成事件不会置上 `:hover`）；
- 消费端不变：`ui.requestSidebarSearch()` → `FileTree.vue` 里 `openSearch()`（展开 + 聚焦）。

两条仍然走正文查找的边界（各有理由，别当漏改）：

1. **没有工作区**：侧栏里根本没有文件名搜索这回事（没有文件名可筛），开了也是空框；
2. **左栏正在显示大纲**：那份搜索框此刻不可见（文件面板被 `v-show` 藏着），
   而大纲是对正文的导航 —— 在它上面按 `Ctrl+F`，想找的仍是正文。

#### 四、验收

- `tools/_verify-sidebar-search.js` **10 → 12 条**：A（焦点在树行 → 侧栏搜索，含"真打一个字会过滤"）、
  B（焦点在编辑区 → 正文查找）、**C（焦点在侧栏页签 → 侧栏搜索，本轮口径反转）**、
  **D（指针停在侧栏上、焦点在编辑区 → 侧栏搜索）**、E（大纲条目 → 正文查找）、
  **E2（没有工作区 → 正文查找）**、末条（放大镜 title 里有 `Ctrl+F`）；
- `tools/_verify-sidebar-root-and-outline-side.js` **31 → 34 条**：新增"没工作区时侧栏里
  **只剩两个页签**、文件区**按钮 0 个、文字为空**"三条（只数**看得见**的按钮：
  大纲面板是 `v-show` 常驻 DOM 的，不能把藏着的按钮算进来）；
- `tools/_verify-sidebar-refresh.js`：把"没有工作区时保留「打开文件夹」"那条**反过来**
  （`no-open-folder-entry-without-workspace-either`）；
- `tools/_verify-welcome-removed.js`：`sidebar-header-keeps-open-folder` →
  `sidebar-header-drops-open-folder-too`（那一条本身就是上一轮"先删后恢复"的产物，本轮按新口径再改）；
- 单测：删 11 条（onboarding）、加 6 条（ctrlFRoute），合计 **741 → 736**。

> **教训（第三次踩，值得单独记）**：这些套件的探针是**模板字符串**，
> 注释里出现反引号会提前结束模板串 —— 本轮在 `_verify-toast-tip.js` 与
> `_verify-sidebar-root-and-outline-side.js` 上各踩了一次，症状是 `node --check` 报
> "missing ) after argument list"，而错误行指向注释本身。写这类注释时用
> "（反引号略）"或直接不写符号。

### 4.85 大纲搬回左栏时，恢复到"打开前的那一页"

**用户口径（第十轮，原话）**：「优化一下把大纲放到右侧再放到左侧的逻辑 ——
如果将大纲放到右侧之前的视图是"文件"，那将大纲再切换到左侧后显示的视图依然是"文件"；
如果……是"大纲"，那……依然是"大纲"。」

#### 一、改了什么

`composables/useOutlineSide.ts` 里那个开关只多了一件事：**打开时记下左栏当前的页签，关掉时把它放回去**。

| 场景                                            | 改前               | 改后                                                         |
| ----------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| 打开前停在**文件** → 放到右侧 → 搬回左侧        | 页签被切到**大纲** | 仍是**文件**（用户本来在看目录，不该被切走）                 |
| 打开前停在**大纲** → 放到右侧 → 搬回左侧        | 页签切到**大纲**   | 仍是**大纲**（旧行为在这个方向上恰好一致）                   |
| 没有记录（启动时 `outlineOnRight` 已经是 true） | —                  | 退回**大纲**：那一步刚把大纲搬回左栏，亮起它最不容易让人迷惑 |

记忆放在 `ui.sidebarTabBeforeOutlineRight`（`'files' | 'outline' | null`）：

- **会话内、不落库**：它是"刚才在看哪一页"的临时记忆，重启后无从得知；
- **只在打开那一刻写**：三栏模式打开期间页签行是隐藏的（`v-if="!settings.outlineOnRight"`），
  页签不会再变，所以不需要在别处维护；
- **顺序要紧**：先记账再改页签 —— 反了的话永远记成"文件"，正是要避免的那种结果；
- **用掉即清空**（`null`）：留着会被上一次的判断污染，下一个"打开前"就不再是真实的现场。

`AppSidebar.vue` 里那个 `watch(settings.outlineOnRight)` 一个字没动：它继续兜住
"任何来源把 `outlineOnRight` 改成 true"时的收敛（左栏页签收回文件）。

#### 二、验收（按用户要求：**只验这一个功能**）

- `tools/_verify-sidebar-root-and-outline-side.js` **34 → 36 条**：
  - `toolbar-toggle-brings-outline-back-to-sidebar` 拆成
    `toggle-back-restores-the-files-tab`（打开前是文件 ⇒ 搬回来还是文件）
    与 `toggle-back-consumes-the-remembered-tab`（记忆用掉即清空）；
  - 新增 `toggle-back-restores-the-outline-tab`：先把页签切到「大纲」再走一轮
    "放到右侧 → 搬回左侧"，断言打开时记下的值 = `outline` 且搬回来仍是「大纲」。
- `tools/_verify-outline-right.js` 26/26（它只断言三栏开关与页签行本身，与本轮无关，用来确认没碰到）。
- 本轮**没有**复跑 62 条的默认矩阵、也没有重跑其它既有套件 —— 用户明确要求
  "只需要测试这个功能，之前已经有的逻辑和功能统统不需要再测试一遍"。
  （改动面只有一个 composable 里的三行 + 一个 store 字段，`vue-tsc` / `eslint` / build 全绿。）

### 4.88 浏览器自带功能的收口：DevTools 走「顶部栏 → 帮助」、取消 F12 与「Ctrl+R 刷新」等一批键

**用户口径（两轮）**：
① 「取消点击 F12 出现开发者工具的功能，取而代之的是在顶部工具栏中添加一项：
'打开开发者工具'，点击就出现开发者工具。」
② 「取消 Electron/Chromium 自带但本项目不需要的功能」，点名「按 Ctrl+R 刷新页面」。

#### 一、F12 / Ctrl+R 那两条路是怎么来的、怎么拆

来源是 `src/main/index.ts` 的 `optimizer.watchWindowShortcuts(window)`
（`@electron-toolkit/utils`）：开发态 `input.code === 'F12'` 直接
`webContents.openDevTools({ mode: 'undocked' })`；打包态则屏蔽 `Ctrl+R` 与
`Ctrl+Shift+I`（**漏了 macOS 的 `Cmd+Alt+I`**）。它只能整包开关，所以"只去掉某几条"在那一层做不到。

现在换成一份显式策略（`src/shared/shortcuts.ts`，纯函数、有单测 `tests/shortcuts.test.mjs`）。
**口径：任何构建下（含开发态）都拦**，原来的 `devShortcut`（开发态保留 `Ctrl+R`/`F5`/`F11`）已删除
（dev 态也不再需要刷新：`electron-vite dev --watch` 改文件会自动重建/重启）。

#### 二、被拦下的键（逐条理由）

| 键 | 理由 |
| --- | --- |
| `Ctrl/Cmd+R`、`Ctrl+Shift+R`、`F5`、`Ctrl+F5`、`Shift+F5` | **刷新族**。这不是浏览器：刷新只会丢未保存内容；开发态也不需要 |
| `F12`、`Ctrl+Shift+I/J/C`、`Cmd+Alt+I/J/C` | **DevTools 族**（开/关面板、控制台、检查元素）。改用工具栏那项；少一个键盘入口就少一条说不清的隐式路径 |
| `Ctrl/Cmd+U` | Chromium 的**查看源代码**（见下面"已知代价"） |
| `Ctrl/Cmd + = + - _ 0` | **整页缩放**。应用自己有字号设置；Chromium 的整页缩放会把版式/度量一起改掉 |
| `F7` | Caret Browsing（插入符号浏览） |
| `F11` | 浏览器/系统全屏。应用自己的「专注模式」是 `Mod+Shift+F`（`view.focusMode`），**不在这条路上**，仍然有效 |

鼠标那条路（Ctrl+滚轮 / 捏合）另有两道闸：每窗口 `setVisualZoomLevelLimits(1, 1)`
＋ 忽略 `zoom-changed` 后 `setZoomFactor(1)` 复位。

被拦下的键在主进程留一行 ASCII 日志 `[shortcuts] blocked <组合键> (<理由>)`
（每个窗口每个组合只记一次 —— `before-input-event` 每次按键都触发，不设闸会刷屏）。

#### 三、**故意没拦**的键（应用自己的；逐条核对过）

⚠️ `before-input-event` 里 `preventDefault()` 会**同时**吃掉渲染层 keydown 与菜单加速键
（Electron 文档原话）—— 拦错一条 = 应用自己的快捷键整个失效。所以
`blockedShortcut()` 的第一件事就是放行 `APP_OWNED_COMBOS`（清单在 `shortcuts.ts`，**应用赢**的兜底）：

| 键 | 它是什么 |
| --- | --- |
| `Mod+P` | **打印**（`file.print` → 「打印…」）。★ 见下面"为什么没拦 Ctrl+P" |
| `Mod+F` / `Mod+H` | 查找 / 替换 |
| `Mod+Shift+F` | 专注模式（**不是** F11 那条浏览器全屏） |
| `Mod+B` / `Mod+I` | 行内加粗 / 斜体（与 DevTools 的 `Ctrl+Shift+I` 只差 shift，判据必须带 shift） |
| `Mod+Z` / `Mod+Y` / `Mod+Shift+Z` | 撤销 / 重做 |
| `Mod+C` / `Mod+X` / `Mod+V` / `Mod+A` | 复制 / 剪切 / 粘贴 / 全选（原生菜单 role） |
| `Mod+N` / `Mod+Shift+N` / `Mod+O` / `Mod+Shift+O` / `Mod+S` / `Mod+Shift+S` / `Mod+W` | 新建 / 新窗口 / 打开 / 打开文件夹 / 保存 / 另存为 / 关闭窗口 |
| `Mod+Shift+E` | 导出 PDF（`shared/exportFormats.ts`） |
| `Mod+K` / `Mod+,` / `Mod+/` / `Mod+Shift+P` / `Mod+Tab` / `Mod+Shift+Tab` | 快捷键设置 / 设置 / 循环模式 / 命令面板 / 应用内切窗 |
| `Mod+E` / `Mod+Shift+X` / `Mod+Shift+Q` / `Mod+D` / `Ctrl+Space` | 行内代码 / 删除线 / 引用 / 代码块多光标加选 / 代码块补全 |

**为什么没拦 `Ctrl+P`**：它是**应用自己绑的**打印键（`useKeymap.ts` 的 `file.print`，
「打印…」走 `webContents.print()`）。Chromium 那套浏览器 UI 在 Electron 里并不存在，
没有"浏览器打印对话框"要拦 —— 拦了只会把应用自己的打印打死。验收套件刻意**不真按**
`Ctrl+P`（会弹出原生打印对话框），只做「策略放行 + `useKeymap.ts` 里 `Mod+P` 仍在」的静态断言。

#### 四、已知代价

代码块里 CodeMirror 的 `historyKeymap` 默认把 `Mod-u` 绑给 `undoSelection`
（`node_modules/@codemirror/commands/dist/index.js`），而本轮按用户口径拦掉了 `Ctrl+U`
（查看源代码）—— 于是代码块里"撤销选区内的改动"这条第三方默认键失效（整篇撤销 `Mod+Z` 仍在）。
取舍登记在 `shortcuts.ts` 的 `KNOWN_THIRD_PARTY_COLLISIONS`。

#### 五、入口：顶部栏「帮助」菜单（第五轮口径）

**用户原话（第五轮澄清）**：「并不是在编辑快捷工具栏中，而是在应用的顶部栏中的'帮助'里添加。」
—— 第三/四轮那枚放在**编辑区快捷工具栏**的按钮是听错了位置，已**整体移除**（按钮、`openDevTools()`
逻辑、`toolbar.openDevTools` 键一并清掉；套件里有一条反向断言守着"工具栏里不许再有它"）。

现在它在 `TopMenuBar.vue` 的**帮助组**里，是第三项（`设置` / `关于 Lumin` ‖ `打开开发者工具`，
中间一条分隔线）：

| 项 | 锚点 | 说明 |
| --- | --- | --- |
| `menu.openDevTools` | `[data-menu-item="menu.openDevTools"]` | 叶子菜单项统一带 `data-menu-item`（值 = i18n 键，**语言无关**）；套件不按本地化文字找 |

- i18n 键从 `toolbar.openDevTools` **改名**为 `menu.openDevTools`：三语都是**文本级**增删
  （在 `menu.devtools` 之后插入新键、删掉 `toolbar` 里那份并去掉前一行的尾逗号）。
  ⚠️ **不许**用 `JSON.parse → JSON.stringify` 重写整份语言包 —— 那会把文件里**转义的 `\uFFFD`**
  写成真实替换字符，`tests/encodingGuard` 立刻红（第三轮踩过）。
- 点击走**既有的** IPC `app:openDevTools`（`mode: 'detach'`，按 `event.sender` 定位窗口），
  失败弹通知（`runLeaf` 会静默吞异常，所以那一项自己 try/catch）。
- 原生菜单里 `role: 'toggleDevTools'` 那条**保留**（它在**视图**子菜单、不在帮助里；菜单栏默认隐藏，
  点它是显式动作）；`role: 'reload'` 那条也保留（同上 —— 删掉会让 `menu.reload` 变成死键，
  见 `tests/i18nKeys.test.mjs`）。两者与新入口**功能上重复但不冲突**：键盘入口已全部拦掉，
  留在菜单里的两条是"看得见的显式动作"。

#### 五之二、修：打开 DevTools 时焦点会"闪"一下到顶部栏的「文件」（第六/八轮用户报障）

**用户原话（第六轮）**：「点击『帮助』里的『打开开发者工具』后，DevTools 会打开，但紧接着焦点就被
顶部栏的『文件』抢走了。请分析原因并修复。」
**用户原话（第八轮，更细）**：「现在打开开发者工具的时候**还是会短暂聚焦闪烁到顶部栏『文件』上**」
—— 即最终落点修好了，但**中途那一帧**顶部栏仍然拿到了焦点（焦点环闪一下）。

**因果链**（CDP 实测：`focusin/focusout` + `window` blur/focus 全打点 + **逐帧采样**
`document.activeElement` + 包一层 `HTMLElement.prototype.focus` 记录调用栈）：

| 时刻 | 事件 | 焦点 |
| --- | --- | --- |
| 点正文后 | — | `.ProseMirror`（编辑面） |
| 点「帮助」 | `focusin` | `[data-topmenu-group="h"]`「帮助(H)」—— 菜单触发器，用户自己点的 |
| 点菜单项 | `focusout` → 下拉被 `close()` 移除 | 焦点落到 `body`（被聚焦的那个按钮从 DOM 消失） |
| DevTools 起来（+~190ms） | `focusout`（编辑面）→ `window-blur` | 编辑面（失活前它拿着焦点） |
| 重新激活的**同一毫秒** | `window-focus` → `focusin`（首个可聚焦元素） | **`[data-topmenu-group="f"]`「文件(F)」** |

要点三条：
1. **不是应用挪的**：包 `HTMLElement.prototype.focus` 后统计，**应用侧 `focus()` 调用数 = 0** ——
   是浏览器在窗口**重新激活**时跑 `SetInitialFocus`，把焦点给"文档里第一个可聚焦元素"。
2. **拦不住**：实测三种"事前避免"全部无效 —— 给编辑面加 `autofocus`、失活前把焦点放回编辑面、
   给 `body` 加 `tabindex=-1` 再 `focus()`；焦点照样落「文件」。
   （`tabindex="-1"` 那个偷懒改法还会把"初始焦点"推到下一个可聚焦元素上 —— 闪的位置换个地方而已，
   而且破坏键盘可达性，**明确不做**。）
3. **第六轮为什么还闪**：那一版在 `window focus` 里调 `editorStore.instance.commands.focus()`，
   而 **Tiptap 的 focus 命令内部走 `requestAnimationFrame`** —— 纠正晚**一整帧**（实测被抢 t=200、
   回到编辑面 t=214）。逐帧采样显示失活后有 **3 帧**画在「文件」上，那就是用户看到的闪。

**修法**（`TopMenuBar.vue` 的 `guardFocusWhileOpeningDevTools`，仅由这一条动作调用）：

- **先同步聚焦编辑面，再去 `await` 开 DevTools 的 IPC**（顺序关键：一进入 await 窗口就可能开始失活）；
- 在这段激活抖动里监听 `focusin`：一旦目标落在 `.topmenu-root` 里，**当场**用
  `editor.view.dom.focus({ preventScroll: true })`（**同步** DOM 聚焦，**不用** Tiptap 那条会
  走 rAF 的命令）挪回编辑面 —— 同一任务内完成，**下一帧绘制读到的已经是编辑面**，那一帧不会画焦点环；
- 监听只在这次动作后 **2.5s** 内存在；而且只在"窗口刚从失活恢复"的那一小段（blur 之后、
  下一次 focus 后 300ms 内）才纠正 —— 用户自己点顶部栏时窗口是聚焦状态、早过了这段，**不会被抢**；
- 2.5s 到点做一次兜底收尾并摘掉所有监听（**不做常驻钩子**）；
- 顶部栏的键盘契约**没有被改动**：它本来就只有 `Alt+F/E/D/V/H` 开分组 + `Esc` 关（外加原生
  `<button>` 的 Tab 序），没有 ←/→/Home/End 或 roving tabindex；本次改动一行代码都没碰
  `onKeydown` / `openGroup`。回归证据：`_verify-alt-menu.js` **3/3**、`_verify-toolbar-settings.js` **38/38**。

**实测效果**（同一套件的逐帧判据）：失活后画在顶部栏的帧数 **3 → 0**；
`focusin(文件)` 与 `focusout(文件)` 落在**同一毫秒**（同一任务），紧随 `focusin(编辑面)`。

> **事实边界（不可消除的部分）**：`mode: 'detach'` 的 DevTools 抢 OS 前台是**系统行为，无法阻止**；
> 而且那个 `focusin(文件)` **事件本身仍会发生一次**（浏览器发起的）。我们保证的是
> **"它不会被画出来"**（没有任何一帧的绘制状态是"顶部栏聚焦"），以及最终焦点回到编辑面。
> 用户会看到的：DevTools 窗口正常浮出、主窗口内的光标仍在文档里；
> 不会看到的：顶部栏「文件」上的焦点环闪一下。

#### 六、验收

- `tools/_verify-devtools.js`（**已登记进默认矩阵**）**52 条**：
  入口在顶部栏帮助里（`data-menu-item` 锚点 + 打开前不游离在 DOM 里）+ **反向**断言编辑区快捷
  工具栏里不再有那枚按钮 → **真实点击路径**（点「帮助」→ 点该项）后 `/json/list` 多出一个
  devtools 目标且主进程日志出现 `[devtools] opened …` → 再点一次报 `alreadyOpen: true` 且
  目标仍只有 1 个 → 关闭后目标消失 →
  **焦点闪烁口径**（第八轮新增）：逐帧采样 `activeElement`，断言**失活后没有任何一帧**落在顶部栏
  （改前 3 帧 / 改后 0 帧），且每次顶部栏 `focusin` 都在**同一任务内**被纠正（`focusout` ≤5ms；
  实测同毫秒），并有"应用侧 `focus()` 从不指向顶部栏"的反向栅栏 →
  `F12` 与 `Ctrl+Shift+I` 不再产生 devtools 目标 →
  `F7`/`F11` 留下被拦日志 → `Ctrl+U` 不产生新目标 → 缩放键与 Ctrl+滚轮都不改变 `devicePixelRatio` →
  **`Ctrl+R` / `F5` 不重载**（页面标记 `window.__reloadProbe` 必须还在；拦失败时它会被抹掉）→
  **应用自己的 `Ctrl+Shift+B`（侧栏）/ `Ctrl+,`（设置）/ `Ctrl+Shift+F`（专注模式）仍然生效**
  （"没误伤"的运行时证据；专注模式那条正是用户点名要确认的"F11 被拦 ≠ 应用没有全屏入口"）；
- `tests/shortcuts.test.mjs` **10 条**：每条被拦组合落在正确的理由桶里、应用自己那份清单
  （含点名核对的 29 个组合）一律放行、日志串必须是 ASCII；
- **改前红 / 改后绿**（同一套件、同一条命令，只换构建）：
  * 改前 = HEAD `b97b3f8` 的构建（入口还在工具栏、帮助里没有它）：
    `A-ANCHORS {"toolbarPresent":true,"toolbarHasOldButton":true,…}`、`A-HELP-MENU {"found":false}`，
    **32/46 PASS / 8 FAIL / 6 SKIP**；红的正是这一轮要修的八条
    （`toolbar-no-longer-has-open-devtools-button`、`help-menu-has-open-devtools-item`、
    `item-lives-inside-a-menu-panel`、`item-has-icon`、`topmenu-help-item-calls-openDevTools-api`、
    `topmenu-leaf-has-semantic-anchor`、`toolbar-no-longer-mentions-openDevTools`、
    `i18n-key-renamed-to-menu-namespace`），6 条 SKIP 是"前提不成立"的点击路径段；
  * 改后：`A-ANCHORS {"toolbarHasOldButton":false,…}`、
    `A-HELP-MENU {"found":true,"inMenu":true,"panelItems":["menu.settings","menu.about","menu.openDevTools"]}`，
    **46/46 PASS**（第五轮入口搬家的那一版套件）；
  * **第六轮（焦点）**同一套件扩到 **49 条**，新增的三条焦点断言：
    * 改前 = HEAD `0156fd7` 的构建（帮助入口已在，但**没有**焦点收尾）：
      `B-FOCUS-BEFORE-CLICK` = `{"topmenuGroup":"h","inTopBar":true,"text":"帮助(H)"}`（菜单触发器，
      正常）→ `B-FOCUS-AFTER-OPEN` = `{"tag":"BUTTON","topmenuGroup":"f","inTopBar":true,
      "inEditor":false,"text":"文件(F)"}`（**正是用户报障的现象**）→
      `FAIL open-devtools-does-not-steal-focus-to-topbar`、
      `FAIL open-devtools-returns-focus-to-editor`，共 **47/49 PASS / 2 FAIL**；
    * 改后：`B-FOCUS-AFTER-OPEN` = `{"tag":"DIV","cls":"tiptap ProseMirror …","inTopBar":false,
      "inEditor":true}`（焦点回到编辑面）、`C-FOCUS-AFTER-SECOND-CLICK` 同样是编辑面，**49/49 PASS**。
    * 说明：第二次点击那条断言（`second-click-focus-still-not-in-topbar`）在改前也是绿的
      —— 那时 DevTools 已经开着，第二次点击不会触发窗口激活抖动（改前读到的是 `BODY`）；
      真正红转绿的是 `B-FOCUS-*` 那两条。
  * 第四轮那批键（刷新族/缩放/查看源码/F7/F11）的改前/改后数字见本轮之前的记录：
    改前 **22/35**（`H-ctrl-r probe={"value":"GONE"}`、`H-f5 probe={"value":"GONE"}` —— 真的重载了）、
    改后全绿；其中"缩放键不改变缩放"与"`Ctrl+U` 不产生新目标"在**这套 Electron 构建里改前也是绿的**
    （键盘缩放/查看源码本就不生效），真正红转绿的是主进程那两条 `*-blocked-in-main-process` 断言
    与 `Ctrl+R`/`F5` 的重载探针。
- 顶部栏键盘入口回归（第六轮一并跑）：`_verify-alt-menu.js` **3/3**、`_verify-toolbar-settings.js` **38/38**。

---

