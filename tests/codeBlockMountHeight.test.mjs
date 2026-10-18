// ─── 代码块「静态态 ↔ 挂载态」不跳变（tag `codeblock-mount-no-jump`）─────────────
//
// 用户报障：点 mermaid 下面那一行，再向上滚一格，屏上的 mermaid 直接消失、视口落进
// 上面那个 150 行代码块的中间。实测真因有两层，都在本文件里钉住：
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
// 所以契约是三条：两态排版逐项相同（本文件 ①）、滚动中不做切换（②）、挂载时把光标放回
// 用户点的位置且不滚页面（③）。数值改动请同时改 overlays.css 与 CodeBlockView.vue。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODE_SCROLL_IDLE_MS,
  CODE_UNMOUNT_DELAY_MS,
  caretOffsetInBlock,
  msUntilScrollIdle,
  noteScrollActivity,
  resetScrollActivity,
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
  const themePad = /'\.cm-content':\s*\{[\s\S]{0,900}?padding:\s*'([^']+)'/.exec(codeBlockVue)
  assert.ok(themePad, "找不到 cmTheme 里 '.cm-content' 的 padding —— 它是挂载态的唯一来源")
  const c = padding4(themePad[1])

  assert.equal(s.top, c.top, `上内边距不一致：静态 ${s.top}px / CM ${c.top}px`)
  assert.equal(s.bottom, c.bottom, `下内边距不一致：静态 ${s.bottom}px / CM ${c.bottom}px`)
  assert.ok(
    s.top > 0 && s.bottom > 0,
    'padding 必须是具体 px（写 0 会让两态都变，但语义上不该为 0）'
  )
})

test('两态高度契约 ②：行高 / 字号 / 不换行三项必须一致（换行会让 CM 边滚边量）', () => {
  const staticDecls = ruleDecls(overlays, STATIC_SELECTOR)
  const cmDecls = ruleDecls(overlays, CM_CONTENT_SELECTOR)
  assert.ok(
    cmDecls,
    `找不到 ${CM_CONTENT_SELECTOR} 规则：CM 内容区会退回 prosemirror.css 的 pre-wrap`
  )
  // 静态态：12.5px / 1.65（= 20.625px，与 CM 的 .cm-content 同一个数）
  assert.match(staticDecls, /font-size:\s*12\.5px/, '静态态字号必须 12.5px（= CM 的 # 12.5px）')
  assert.match(
    staticDecls,
    /line-height:\s*1\.65/,
    '静态态行高必须 1.65（与 cmTheme 的 .cm-scroller 一致）'
  )
  assert.match(staticDecls, /white-space:\s*pre/, '静态态必须不换行（长行走块内横向滚动）')
  // CM 侧：同一个口径
  assert.match(
    cmDecls,
    /white-space:\s*pre/,
    'CM 内容区必须 white-space:pre（否则 CM 折行 ⇒ 高度随滚动增长）'
  )
  assert.doesNotMatch(cmDecls, /white-space:\s*pre-wrap/, 'CM 内容区不许 pre-wrap')
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
  // 静态态正文也要压过 `.md-preview pre code`（0,1,2 ⇒ 0.86em）
  const codeDecls = ruleDecls(overlays, '.md-preview pre.cb-static .cb-static-code')
  assert.ok(codeDecls, '找不到 .md-preview pre.cb-static .cb-static-code 规则')
  assert.match(codeDecls, /font:\s*inherit/, '静态态正文必须 font:inherit（否则字号被打回 0.86em）')
  assert.match(codeDecls, /line-height:\s*inherit/, '静态态正文行高必须 inherit')
  // 契约用特异性解决，不许 !important
  for (const decls of [staticDecls, cmDecls, codeDecls]) {
    assert.doesNotMatch(decls, /!\s*important/, '两态契约不许用 !important')
  }
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
