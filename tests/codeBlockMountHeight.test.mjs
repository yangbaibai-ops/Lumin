// ─── 代码块「静态态 ↔ 挂载态」不跳变 + 自动换行（tag `codeblock-wrap-no-fold`）───────
//
// 来源一（`codeblock-mount-no-jump`，用户报障）：点 mermaid 下面那一行，再向上滚一格，屏上的
// mermaid 直接消失、视口落进上面那个 150 行代码块的中间。实测真因有两层：
//
//   ① **两态高度不一致**：同一个块 静态 `<pre>` 3036px… 而挂载态 CM 3881px（差 845px）。
//      不是"差几像素"，而是每次「静态 ↔ 挂载」都把下方内容整体推走。三条来源：
//        * `.md-preview pre`（0,1,1）盖掉 `.cb-static`（0,1,0）⇒ 14px 内边距、1.6 行高、
//          `.8em` 外边距、1px 边框全都回来了（静态态凭空多出 20px 外边距 + 少 4px 行高）；
//        * `.md-preview pre code`（0,1,2）盖掉 `.cb-static-code` 的 `font: inherit`
//          ⇒ 静态态正文 10.75px 而 CM 12.5px；
//        * `.cm-content` 被 prosemirror.css 的
//          `.ProseMirror [contenteditable="false"] [contenteditable="true"] { white-space: pre-wrap }`
//          命中（代码块外壳为了隔离 CM 正好标了 contenteditable=false）⇒ CM **折行**，
//          而它只测量视口里那几十行、其余按"不折行"估高 ⇒ 块高在滚动中持续长高。
//   ② **滚动中还在切换**：切换本身就是一次 DOM 重建，滚动中发生一次就抖一次。
//
// 来源二（本轮口径变更，tag `codeblock-wrap-no-fold`）：用户要求**显示代码时不出横向滚动条、
// 一行放不下就折行**，且**去掉折叠箭头/折叠键位**（mermaid 块不受影响）。上一版为了两态等高
// 把两态都钉成 `white-space: pre`（不换行）；本轮两态**一起**改成换行，但「两态等高」这条
// 约束**不放松** —— 改成换行的同时必须：
//   * 两态换行口径逐项相同（pre-wrap + overflow-wrap:anywhere + 同字号/行高/内边距）；
//   * 挂载态开 `EditorView.lineWrapping`（CM 才会按折出来的视觉行量高度，而不是边滚边补）；
//   * 两态**文字列同宽同起点**（行号槽 width、正文左右内边距都对齐），否则同一行会一态折、
//     另一态不折 ⇒ 高度又对不上；
//   * 横向滚动条整条移除（`.cb-static` 与 `.cm-scroller` 都 `overflow-x: hidden`）。
// 折叠：CM 侧不许再有 `foldGutter` / `foldKeymap` / `.cm-foldPlaceholder`（折叠 UI 与键位
// 全部移除；行号保留）。`tools/_verify-cb-line-numbers.js` / `_verify-cb-virtualization.js`
// 里「fold gutter 必须存在」的断言属于上一版口径，本轮起应改成「不存在」。
//
// 所以契约是四条：两态排版逐项相同（①）、换行且无横向滚动（②）、滚动中不做切换（③）、
// 挂载时把光标放回用户点的位置且不滚页面（④）。数值改动请同时改 overlays.css 与 CodeBlockView.vue。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODE_SCROLL_IDLE_MS,
  CODE_UNMOUNT_DELAY_MS,
  WARM_MEASURE_MAX_LINES,
  caretOffsetInBlock,
  msUntilScrollIdle,
  noteScrollActivity,
  resetScrollActivity,
  shouldWarmMeasureLines,
  staticFallbackMinHeight
} from '../src/renderer/src/lib/editor/codeBlockMountPolicy.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const overlays = read('src/renderer/src/assets/overlays.css')
const codeBlockVue = read('src/renderer/src/components/editor/CodeBlockView.vue')

/** 取一条规则的全部声明（去掉注释）；找不到返回 null */
function ruleDecls(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(css)
  return m ? m[1].replace(/\/\*[\s\S]*?\*\//g, '') : null
}

/** `padding: 10px 4px 14px` → { top: 10, right: 4, bottom: 14, left: 4 } */
function padding4(value) {
  const px = value
    .split(/\s+/)
    .filter(Boolean)
    .map((v) => Number.parseFloat(v))
  const [t, r = t, b = t, l = r] = px
  return { top: t, right: r, bottom: b, left: l }
}

const STATIC_SELECTOR = '.md-preview pre.cb-static'
const CM_CONTENT_SELECTOR = '.md-preview .code-block-wrapper .cm-editor-container .cm-content'
const CM_SCROLLER_SELECTOR = '.cm-editor-container .cm-scroller'

test('两态高度契约 ①：静态态与 CM 的**上下内边距**必须一致', () => {
  const staticDecls = ruleDecls(overlays, STATIC_SELECTOR)
  assert.ok(
    staticDecls,
    `找不到 ${STATIC_SELECTOR} 规则（静态态靠它压过 .md-preview pre 的 14px 16px）`
  )
  const staticPad = /padding:\s*([^;]+);/.exec(staticDecls)
  assert.ok(staticPad, '静态态必须显式写 padding（否则 .md-preview pre 的 14px 16px 会生效）')
  const s = padding4(staticPad[1])

  // CM 的上下内边距写在 cmTheme 的 '.cm-content' 里（padding: '10px 0 14px'）
  const themePad = /'\.cm-content':\s*\{[\s\S]{0,1200}?padding:\s*'([^']+)'/.exec(codeBlockVue)
  assert.ok(themePad, "找不到 cmTheme 里 '.cm-content' 的 padding —— 它是挂载态的唯一来源")
  const c = padding4(themePad[1])

  assert.equal(s.top, c.top, `上内边距不一致：静态 ${s.top}px / CM ${c.top}px`)
  assert.equal(s.bottom, c.bottom, `下内边距不一致：静态 ${s.bottom}px / CM ${c.bottom}px`)
  assert.ok(
    s.top > 0 && s.bottom > 0,
    'padding 必须是具体 px（写 0 会让两态都变，但语义上不该为 0）'
  )
})

test('两态高度契约 ②：换行口径（pre-wrap + anywhere）与文字列几何必须逐项一致', () => {
  const staticDecls = ruleDecls(overlays, STATIC_SELECTOR)
  const cmDecls = ruleDecls(overlays, CM_CONTENT_SELECTOR)
  assert.ok(
    cmDecls,
    `找不到 ${CM_CONTENT_SELECTOR} 规则：CM 内容区会退回 prosemirror.css 的 pre-wrap 但没人钉住`
  )
  // 静态态：12.5px / 1.65（= 20.625px，与 CM 的 .cm-content 同一个数）
  assert.match(staticDecls, /font-size:\s*12\.5px/, '静态态字号必须 12.5px（= CM 的 # 12.5px）')
  assert.match(
    staticDecls,
    /line-height:\s*1\.65/,
    '静态态行高必须 1.65（与 cmTheme 的 .cm-scroller 一致）'
  )
  // ── 换行口径（本轮口径变更：不换行 → 换行）──
  assert.match(staticDecls, /white-space:\s*pre-wrap/, '静态态必须换行（用户口径：不出横向滚动条）')
  assert.match(
    staticDecls,
    /overflow-wrap:\s*anywhere/,
    '静态态必须 overflow-wrap:anywhere（否则无空格长串仍会撑出横向溢出）'
  )
  assert.match(
    cmDecls,
    /white-space:\s*pre-wrap/,
    'CM 内容区必须 white-space:pre-wrap（两态同口径）'
  )
  assert.match(cmDecls, /overflow-wrap:\s*anywhere/, 'CM 内容区必须 overflow-wrap:anywhere')
  assert.doesNotMatch(
    staticDecls,
    /white-space:\s*pre\s*;/,
    '静态态不许再是 white-space:pre（那是上一版「不换行」口径，会产生横向滚动条）'
  )
  // ── 横向滚动条移除 ──
  assert.match(staticDecls, /overflow-x:\s*hidden/, '静态态必须 overflow-x:hidden（不许横向滚动）')
  assert.doesNotMatch(staticDecls, /overflow-x:\s*auto/, '静态态不许再自己横向滚动')
  const scrollerDecls = ruleDecls(overlays, CM_SCROLLER_SELECTOR)
  assert.ok(scrollerDecls, `找不到 ${CM_SCROLLER_SELECTOR} 规则`)
  assert.match(scrollerDecls, /overflow-x:\s*hidden/, 'CM scroller 必须 overflow-x:hidden')
  assert.doesNotMatch(
    scrollerDecls,
    /overflow:\s*auto/,
    'CM scroller 不许再写 overflow:auto（那会同时开启横向滚动条）'
  )
  // CM 自己也要知道自己折行：lineWrapping 扩展是「两态等高」的前提
  assert.match(
    codeBlockVue,
    /EditorView\.lineWrapping/,
    'buildCmExtensions 必须包含 EditorView.lineWrapping（否则 CM 只把折行当"量到了才知道"）'
  )
  // 特异性：必须压过 prosemirror.css 的 (0,3,0) —— 四个类/属性 token
  const tokens = CM_CONTENT_SELECTOR.split(/\s+/).filter(Boolean)
  assert.equal(
    tokens.length,
    4,
    `CM 内容区规则必须有 4 个复合选择器（压过 .ProseMirror [ce=false] [ce=true] 的 0,3,0）：${CM_CONTENT_SELECTOR}`
  )
  // 静态态还要把 .md-preview pre 带进来的外边距/边框清掉（否则凭空多 20px 高 + 一圈内边框）
  assert.match(
    staticDecls,
    /margin:\s*0/,
    '静态态必须 margin:0（.md-preview pre 的 .8em 外边距会多出 20px）'
  )
  assert.match(
    staticDecls,
    /border:\s*0/,
    '静态态必须 border:0（外框由 .code-block-wrapper 画，否则挂载时边框消失）'
  )
  // ── 两态文字列同宽同起点（行号槽 + 正文左右内边距）──
  // 行号槽对齐 CM 的 `.cm-lineNumbers .cm-gutterElement`（padding 0 3px 0 5px、min-width 20px）。
  const gutterDecls = ruleDecls(overlays, '.cb-static-gutter')
  assert.ok(gutterDecls, '找不到 .cb-static-gutter 规则')
  assert.match(
    gutterDecls,
    /padding:\s*0 3px 0 5px/,
    '静态行号槽内边距必须抄 CM 的 0 3px 0 5px（差 1px 就可能让同一行只在一态折）'
  )
  assert.match(gutterDecls, /min-width:\s*20px/, '静态行号槽 min-width 必须与 CM 的 20px 一致')
  // 正文左右内边距对齐 CM `.cm-line` 的 `0 2px 0 6px`。
  const codeDecls = ruleDecls(overlays, '.md-preview pre.cb-static .cb-static-code')
  assert.ok(codeDecls, '找不到 .md-preview pre.cb-static .cb-static-code 规则')
  assert.match(codeDecls, /font:\s*inherit/, '静态态正文必须 font:inherit（否则字号被打回 0.86em）')
  assert.match(codeDecls, /line-height:\s*inherit/, '静态态正文行高必须 inherit')
  assert.match(
    codeDecls,
    /padding:\s*0 2px 0 6px/,
    '静态态正文左右内边距必须抄 CM `.cm-line` 的 0 2px 0 6px（两态折行点才会一致）'
  )
  assert.match(codeDecls, /min-width:\s*0/, '静态态正文必须 min-width:0（flex 项要能收窄）')
  assert.match(codeDecls, /white-space:\s*pre-wrap/, '静态态正文也必须 pre-wrap')
  // 契约用特异性解决，不许 !important
  for (const decls of [staticDecls, cmDecls, codeDecls, gutterDecls, scrollerDecls]) {
    assert.doesNotMatch(decls, /!\s*important/, '两态契约不许用 !important')
  }
})

test('折叠已整条移除：没有 foldGutter / foldKeymap / 折叠占位符（行号保留）', () => {
  // 源码：CM 扩展里不许再引入折叠（否则左侧又会出现折叠箭头 / Ctrl-Shift-[ 又能折叠）。
  // 先剥注释：说明文字里**提到**被删掉的 API 不算命中（与上面 mountCode 的写法同口径）。
  const vueCode = codeBlockVue.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.doesNotMatch(
    vueCode,
    /\bfoldGutter\b/,
    'CodeBlockView 不许再用 foldGutter（用户口径：去掉左侧折叠箭头）'
  )
  assert.doesNotMatch(
    vueCode,
    /\bfoldKeymap\b/,
    'CodeBlockView 不许再用 foldKeymap（Ctrl-Shift-[ 不得再折叠）'
  )
  assert.doesNotMatch(
    vueCode,
    /cm-foldPlaceholder/,
    '折叠占位符样式也该删掉（功能没了，样式没有存在意义）'
  )
  const cssCode = overlays.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(cssCode, /cm-foldGutter|cm-foldPlaceholder/, '样式表里不许再有折叠相关规则')
  // 行号是保留的：设置开着时仍然挂 lineNumbers()
  assert.match(
    codeBlockVue,
    /lineNumberCompartment\.of\(settings\.codeLineNumbers \? lineNumbers\(\) : \[\]\)/,
    '行号必须保留（只删除折叠，不动行号）'
  )
  assert.match(
    codeBlockVue,
    /<span\s+v-if="settings\.codeLineNumbers"[\s\S]{0,200}?class="cb-static-gutter"/,
    '静态态行号也保留'
  )
})

test('换行估值修正不许改页面高度：挂载期以静态精确高度为 min-height 地板', () => {
  // 换行后 CM 对视口外的行只能按字符数估高（空格断行 + anywhere 断长串会让实际视觉行更多）。
  // 实测 150 行块：静态 4025px（精确）/ CM 先算 3922px，滚过整块 3922→3963→4005→4025。
  // 静态高度是浏览器排完整篇量出来的 ⇒ 挂载期拿它当地板，CM 的估值怎么变都改不动页面高度。
  const mountFn = /async function mountCmForVirtualization\(\)[\s\S]*?\n\}/.exec(codeBlockVue)
  assert.ok(mountFn, '找不到 mountCmForVirtualization')
  assert.match(
    mountFn[0],
    /containerMinHeight\.value = staticH > 0 \? staticH : null/,
    '挂载时必须先量静态 <pre> 的精确高度当 min-height 地板'
  )
  assert.doesNotMatch(
    mountFn[0],
    /nextTick\(\(\) => \{\s*containerMinHeight\.value = null/,
    '挂载后不许在下一拍立刻撤地板（那会让 CM 的折行估值修正在滚动中改写页面高度，c6d8b8b 的跳变复发）'
  )
  // 撤地板的三个时机：内容变了 / 宽度变了 / 卸载（少一个都会留下过期高度）
  assert.match(
    codeBlockVue,
    /EditorView\.updateListener\.of\(\(u\) => \{\s*if \(u\.docChanged\) \{[\s\S]{0,300}?dropHeightFloor\(\)/,
    'docChanged 时必须撤地板（内容变了，旧高度不再成立）'
  )
  assert.match(codeBlockVue, /new ResizeObserver/, '宽度变化要能撤地板（窗口/分屏改变折行宽度）')
  assert.match(
    codeBlockVue,
    /cmLastWidth = w\s*\n\s*dropHeightFloor\(\)/,
    'ResizeObserver 检出宽度变化后必须撤地板'
  )
  assert.match(
    codeBlockVue,
    /\(\) => settings\.codeLineNumbers,[\s\S]{0,400}?dropHeightFloor\(\)/,
    '切换行号会改变行号槽宽 ⇒ 也必须撤地板'
  )
  const applyFn = /function applyNodeText\(force = false\): void \{[\s\S]*?\n\}/.exec(codeBlockVue)
  assert.ok(applyFn, '找不到 applyNodeText')
  assert.match(
    applyFn[0],
    /dropHeightFloor\(\)[\s\S]*?cmView\.setState/,
    '外部整篇替换走 setState（不触发 updateListener）⇒ setState 之前必须显式撤地板'
  )
  assert.match(codeBlockVue, /cmWidthWatch\?\.disconnect\(\)/, 'teardown 必须断开宽度观察器')
})

test('折行高度全量测量（printing 口径）：≤1200 行才做，量不准要有兜底', () => {
  // 只做到这一步还不够：CM 对视口外的行按字符数估高，滚一下就把真实高度补进 heightMap，
  // heightMap 变了 → `.cm-gutters` 的 minHeight 变 → 块内行位置变 → Chromium 的 scroll anchoring
  // 把一次 -120 的滚轮吃掉 21px。所以挂载时用 printing 口径一次性量准全文行高（滚动中不再修正）。
  assert.equal(WARM_MEASURE_MAX_LINES, 1200, '全量测量的行数上限变了要同步注释与验收数据')
  assert.equal(shouldWarmMeasureLines(1), true)
  assert.equal(shouldWarmMeasureLines(WARM_MEASURE_MAX_LINES), true, '等于上限仍要做')
  assert.equal(shouldWarmMeasureLines(WARM_MEASURE_MAX_LINES + 1), false, '超上限不做（退回地板）')
  assert.equal(shouldWarmMeasureLines(0), false)
  assert.equal(shouldWarmMeasureLines(Number.NaN), false)
  assert.equal(shouldWarmMeasureLines(Number.POSITIVE_INFINITY), false)
  // 源码契约：挂载时调用；printing 必须在 finally 里复位；teardown 要释放观察器/计时器
  const mountFn = /async function mountCmForVirtualization\(\)[\s\S]*?\n\}/.exec(codeBlockVue)
  assert.ok(mountFn, '找不到 mountCmForVirtualization')
  assert.match(mountFn[0], /armWarmMeasure\(\)/, '挂载时必须触发全量行高测量')
  assert.match(
    codeBlockVue,
    /function warmMeasureWrappedLines\(\): void \{[\s\S]*?printing = true[\s\S]*?measure\(\)/,
    '全量测量必须走 CM 的 printing 口径（关掉视口限制）'
  )
  assert.match(
    codeBlockVue,
    /finally \{[\s\S]{0,200}?printing = false/,
    'printing 必须在 finally 里复位（否则 CM 永远按"打印"口径渲染全文）'
  )
  assert.match(
    codeBlockVue,
    /shouldWarmMeasureLines\(cmView\.state\.doc\.lines\)/,
    '全量测量必须走纯函数判上限'
  )
  assert.match(codeBlockVue, /releaseWarmMeasure\(\)/, 'teardown 必须释放全量测量的观察器/计时器')
})

test('滚动中不切换：切换要等滚停，且用户交互（点/光标）不排队', () => {
  // 纯函数：滚动活动门
  resetScrollActivity()
  assert.equal(msUntilScrollIdle(1000), 0, '从来没滚动过 ⇒ 立刻可切换（首屏打开就要挂）')
  noteScrollActivity(1000)
  assert.equal(msUntilScrollIdle(1000), CODE_SCROLL_IDLE_MS, '刚滚完 ⇒ 还要等满一个 idle 窗口')
  assert.equal(
    msUntilScrollIdle(1000 + CODE_SCROLL_IDLE_MS / 2),
    Math.ceil(CODE_SCROLL_IDLE_MS / 2)
  )
  assert.equal(msUntilScrollIdle(1000 + CODE_SCROLL_IDLE_MS), 0, '停够 idle 窗口 ⇒ 0')
  assert.equal(msUntilScrollIdle(5000), 0, '停了很久 ⇒ 0')
  noteScrollActivity(2000)
  assert.equal(msUntilScrollIdle(2100), CODE_SCROLL_IDLE_MS - 100, '又滚了一下 ⇒ 窗口重新计时')
  resetScrollActivity()
  assert.equal(msUntilScrollIdle(0), 0)

  // 卸载延迟必须比滚动 idle 更长：否则"滚出 600px 边距"会在滚动中就把块卸掉
  assert.ok(
    CODE_UNMOUNT_DELAY_MS >= 2 * CODE_SCROLL_IDLE_MS,
    `卸载延迟（${CODE_UNMOUNT_DELAY_MS}ms）必须明显长于滚动 idle（${CODE_SCROLL_IDLE_MS}ms）`
  )

  // 源码契约：视口判定走滚动活动门（`scheduleNear`），watcher 本身同步执行
  const gate = /function scheduleNear\(next: boolean\): void \{[\s\S]*?\n\}/.exec(codeBlockVue)
  assert.ok(gate, '找不到 scheduleNear —— 滚动活动门的唯一落地点')
  assert.match(gate[0], /msUntilScrollIdle\(/, '视口判定必须问滚动活动门（否则滚动中就切换）')
  assert.match(gate[0], /nearViewport\.value = next/, 'scheduleNear 必须只改 nearViewport')
  // 只有 scheduleNear 能改 nearViewport（IO 回调必须走门，不许直接赋值）
  const ioBlock = /stopMountWatch = watchCodeBlockMount\(el, \(near\) => \{[\s\S]*?\n {4}\}\)/.exec(
    codeBlockVue
  )
  assert.ok(ioBlock, '找不到 watchCodeBlockMount 的回调')
  assert.doesNotMatch(
    ioBlock[0],
    /nearViewport\.value\s*=/,
    'IO 回调不许直接改 nearViewport（必须经 scheduleNear）'
  )
  assert.match(ioBlock[0], /scheduleNear\(true\)/, 'near=true 要走门（滚停后再挂）')
  assert.match(ioBlock[0], /scheduleNear\(false\)/, 'near=false 要走门（滚停后再卸）')
  assert.match(ioBlock[0], /UNMOUNT_DELAY_MS/, '离开视口必须还有 500ms 延迟（来回滚一点不该挂/卸）')
  // 卸载前记高度用的是 CM 自己的高度（不是 NodeView 外壳的 2px 边框）
  assert.match(
    codeBlockVue,
    /const h = cmView\.dom\.getBoundingClientRect\(\)\.height/,
    '卸载时要量 .cm-editor 的高度（外壳带 2px 边框，记进去会抖 2px）'
  )
  assert.match(
    codeBlockVue,
    /staticFallbackMinHeight\(h\)/,
    'min-height 兜底必须走纯函数（宁高勿矮）'
  )
  // 挂载那一帧不许留"空容器"（块高会塌成 2px）：容器带 min-height 兜底
  assert.match(
    codeBlockVue,
    /class="cm-editor-container"\s*\n\s*:style="containerMinHeight \? \{ minHeight: containerMinHeight \+ 'px' \} : null"/,
    '挂载态容器必须带第一帧的 min-height 兜底（否则空容器会让块高塌成 2px）'
  )
})

test('锚点补偿：挂载后光标落在用户点的位置，且**不许**滚页面', () => {
  // 纯函数：PM 偏移 → CM 偏移
  assert.equal(caretOffsetInBlock(10, 11, 500), 0, '光标在节点正文开头 ⇒ 偏移 0')
  assert.equal(caretOffsetInBlock(10, 16, 500), 5, '正文第 6 个字符 ⇒ 偏移 5')
  assert.equal(caretOffsetInBlock(10, 5000, 20), 20, '越界必须夹到文档末尾（不能抛 RangeError）')
  assert.equal(caretOffsetInBlock(10, 0, 500), 0, '选区在节点之前 ⇒ 0')
  assert.equal(caretOffsetInBlock(Number.NaN, 5, 10), 0, '非有限数 ⇒ 0')
  assert.equal(caretOffsetInBlock(10, 10, 0), 0, '空文档 ⇒ 0')

  // 源码契约：挂载路径用 focusCmAtSelection（原位、不滚），不再用 focusCmAtEnd（块尾 + 滚动）
  const mountFn = /async function mountCmForVirtualization\(\)[\s\S]*?\n\}/.exec(codeBlockVue)
  assert.ok(mountFn, '找不到 mountCmForVirtualization')
  assert.match(mountFn[0], /focusCmAtSelection\(\)/, '挂载后必须把光标放回用户点的位置')
  // 断言前先剥注释：注释里**提到** focusCmAtEnd（解释为什么不能用它）不该算命中
  const mountCode = mountFn[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.doesNotMatch(
    mountCode,
    /focusCmAtEnd\(\)/,
    '挂载路径不许用 focusCmAtEnd()：它带 scrollIntoView:true，会把整页拽到块尾（用户报障）'
  )
  const selFn = /function focusCmAtSelection\(\): void \{[\s\S]*?\n\}/.exec(codeBlockVue)
  assert.ok(selFn, '找不到 focusCmAtSelection')
  assert.match(selFn[0], /scrollIntoView:\s*false/, 'focusCmAtSelection 必须 scrollIntoView:false')
  // 键盘路径（代码块后段落行首 Backspace）仍要块尾定位（scrollIntoView:true 是它的语义）
  assert.match(codeBlockVue, /focusCmAtEnd,/, 'handle 仍要暴露 focusCmAtEnd 给键盘拦截用')
})

test('min-height 兜底：宁高勿矮（ceil），非法值不设', () => {
  assert.equal(staticFallbackMinHeight(3118.4), 3119, '小数必须向上取整（矮了就是内容跳一下）')
  assert.equal(staticFallbackMinHeight(3118), 3118)
  assert.equal(staticFallbackMinHeight(0), null, '0 ⇒ 不设（别把块压成 0 高）')
  assert.equal(staticFallbackMinHeight(Number.NaN), null)
  assert.equal(staticFallbackMinHeight(-12), null)
  assert.equal(staticFallbackMinHeight(Number.POSITIVE_INFINITY), null)
})
