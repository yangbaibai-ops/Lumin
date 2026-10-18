// ─── 窄窗口布局：整页不得出现横向溢出（回归守卫）──────────────────────────────
//
// 现场（标签 layout-no-horizontal-overflow）：窗口窄到 ~1100 / 1000 / 800 时，表格右缘、
// 代码块右缘与部分正文被切在应用外（`#app { overflow: hidden }` 把溢出裁掉）。
//
// 实测到的真因**不在**表格/代码块自己，而在 flex 链：
//   `[data-editor-kernel]` 是横排 flex 里的 flex 项，默认 `min-width: auto` 会把它的
//   最小宽度取成内容的 min-content —— 10 列表格（单元格 `min-width: 96px`，合计 ≈1208）
//   加正文列左右内缩后 ≈1320，于是内核拒绝收缩到 736/536，整块编辑区被画到窗口外。
//
// 本文件守两件事（浏览器实测数字与截图见提交信息）：
//   ① `min-width: 0` 链完整：App 的 <main>、编辑器内核、渲染/源码两个 pane 都能收缩；
//   ② 「块内滚动」/「折行」容器还在：宽表格在 .tableWrapper 里滚；普通 .md-preview pre
//      （mermaid 源码占位等）在块内滚；**代码块（静态态与 CM 态）按 tag `codeblock-wrap-no-fold`
//      改为自动折行、不横向滚动**（用户口径），靠 min-width:0 + overflow-wrap:anywhere
//      把长串在列内断开，而不是撑宽整页。删掉任何一条，长内容都会重新去撑整页。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const editorView = read('src/renderer/src/views/EditorView.vue')
const appVue = read('src/renderer/src/App.vue')
const overlays = read('src/renderer/src/assets/overlays.css')
const markdown = read('src/renderer/src/assets/markdown.css')

test('min-width: 0 链：外壳、编辑器内核与两个 pane 都必须能收缩', () => {
  // 外壳：sidebar 固定 260，主列必须能吃掉剩余宽度
  assert.match(
    appVue,
    /<main class="[^"]*\bmin-w-0\b/,
    'App.vue 的 <main> 缺 min-w-0：侧栏存在时主列会按内容 min-content 撑宽'
  )
  // 真凶：内核（data-editor-kernel）是横排 flex 项。少了 min-w-0，表格的 min-content
  // （10 列 × 96px ≈ 1320）会把整个编辑区顶到窗口外。
  assert.match(
    editorView,
    /data-editor-kernel[\s\S]{0,600}?class="[^"]*\bmin-w-0\b/,
    '编辑器内核 [data-editor-kernel] 缺 min-w-0：窄窗口下它不会收缩，整块内容被裁到应用外'
  )
  // 渲染 pane / 源码 pane：split 与 source 两种布局同样依赖这条链
  assert.match(
    editorView,
    /class="h-full min-w-0 bg-paper"/,
    '渲染 pane 缺 min-w-0（split 左栏 / wysiwyg 全宽都会按内容撑宽）'
  )
  assert.match(
    editorView,
    /class="h-full min-w-0 overflow-hidden bg-paper"/,
    '源码 pane 缺 min-w-0（split 右栏 / source 全宽都会按内容撑宽）'
  )
})

test('宽表格只能在 .tableWrapper 内部横向滚动，不许撑整页', () => {
  assert.match(
    overlays,
    /\.md-preview \.tableWrapper\s*\{[^}]*overflow-x:\s*auto/,
    '.md-preview .tableWrapper 的 overflow-x:auto 没了：宽表格会重新把整页顶出横向溢出'
  )
  // 表格本体保持 `display: table`（宽度由 width:100% + auto 布局决定）；
  // 不许改成 display:block 做滚动容器（会让表格退化成 shrink-to-fit，撑不满写作区）。
  const tableRule = markdown.match(/\.md-preview table\s*\{[^}]*\}/)
  assert.ok(tableRule, '.md-preview table 规则不见了？')
  assert.match(
    tableRule[0],
    /width:\s*100%/,
    '.md-preview table 必须 width:100%（否则宽表格会缩成内容宽）'
  )
  assert.match(tableRule[0], /table-layout:\s*auto/, '.md-preview table 的 auto 布局被改了？')
  // 注释里就写着"不能用 display:block"——只对声明部分做断言，别被说明文字误伤
  const tableDecls = tableRule[0].replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(
    tableDecls,
    /display:\s*block/,
    '.md-preview table 被改成 display:block 做滚动容器：表格会退化成 shrink-to-fit（见 markdown.css 原注释）'
  )
})

test('代码块长行在框内折行（无横向滚动）；普通 pre / 表格仍各自块内滚动', () => {
  // 代码块（tag `codeblock-wrap-no-fold`）：用户口径是**折行、不出横向滚动条**。
  // CM 侧：scroller 只留竖向滚动，横向 hidden；内容区 pre-wrap + anywhere。
  assert.match(
    overlays,
    /\.cm-editor-container \.cm-scroller\s*\{[^}]*overflow-x:\s*hidden/,
    'CodeMirror 的 .cm-scroller 必须 overflow-x:hidden（用户口径：代码不出现横向滚动条）'
  )
  assert.doesNotMatch(
    overlays,
    /\.cm-editor-container \.cm-scroller\s*\{[^}]*overflow:\s*auto/,
    '.cm-scroller 不许再用 overflow:auto（那会同时开出横向滚动条）'
  )
  assert.match(
    overlays,
    /\.md-preview \.code-block-wrapper \.cm-editor-container \.cm-content\s*\{[^}]*white-space:\s*pre-wrap/,
    'CM 内容区必须 pre-wrap（折行后 CM 才不会把行撑出横向滚动）'
  )
  // 静态态：折行 + overflow-x:hidden（不再自己横向滚）
  assert.match(
    overlays,
    /\.md-preview pre\.cb-static\s*\{[^}]*white-space:\s*pre-wrap/,
    '静态态代码块（.cb-static）必须折行（用户口径：一行放不下就分行）'
  )
  assert.match(
    overlays,
    /\.md-preview pre\.cb-static\s*\{[^}]*overflow-x:\s*hidden/,
    '静态态代码块必须 overflow-x:hidden（不许出现横向滚动条）'
  )
  assert.doesNotMatch(
    overlays,
    /\.md-preview pre\.cb-static\s*\{[^}]*overflow-x:\s*auto/,
    '静态态代码块不许再 overflow-x:auto（那是上一版「不换行 + 块内横滚」口径）'
  )
  assert.match(
    overlays,
    /\.md-preview pre\.cb-static \.cb-static-code\s*\{[^}]*overflow-wrap:\s*anywhere/,
    '静态态正文必须 overflow-wrap:anywhere（无空格长串也要在列内断开）'
  )
  // 普通 pre（mermaid 源码占位等）仍按块内横向滚动，不受代码块口径影响
  assert.match(
    markdown,
    /\.md-preview pre\s*\{[^}]*overflow-x:\s*auto/,
    '普通 .md-preview pre 必须自己滚（导出/预览与 mermaid 占位共用）'
  )
  assert.match(
    overlays,
    /\.code-block-wrapper\s*\{[^}]*overflow:\s*hidden/,
    '代码块外壳必须裁住内部内容，否则滚动条/折行残影会画到圆角外'
  )
})

test('mermaid 尺寸「只缩不放」：宿主可收缩、svg 只靠 max-width 缩小（无 width:100%）', () => {
  assert.match(
    overlays,
    /\.mermaid-block \.mermaid-render > \.mermaid-svg-host[\s\S]{0,200}?min-width:\s*0/,
    '.mermaid-svg-host 缺 min-width:0：窄窗口下图表宿主会按 SVG 固有宽度撑宽'
  )
  assert.match(
    overlays,
    /\.mermaid-block \.mermaid-render svg[\s\S]{0,600}?max-width:\s*100%/,
    'mermaid svg 缺 max-width:100%：长图表可能溢出内容列（79357ba 的无横向溢出）'
  )
  // 尺寸口径（2026 用户报障）：width:100% 会把竖图无条件放大到一屏一个框。
  // 只对**声明**做断言，注释里出现 width:100% 是说明文字（先剥注释）。
  const block = /\.mermaid-block \.mermaid-render svg[^{}]*\{([^}]*)\}/.exec(overlays)
  assert.ok(block, '找不到 .mermaid-block .mermaid-render svg 规则')
  const decls = block[1].replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(
    decls,
    /(?:^|;)\s*width\s*:/,
    'mermaid svg 不许再写 width:100%：竖图会被放大到一屏一个框（只缩不放）'
  )
  assert.match(decls, /height:\s*auto/, 'svg 必须 height:auto 才能按内在比例等比缩放')
})
