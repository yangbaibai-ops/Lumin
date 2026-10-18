// ─── mermaid 编辑态 UX（源码框不限高 / 可编辑 / 滚动不跳）──────────────────────
//
// 用户报障（2026 第三轮）：
//   ① 点开源码框后「限制了最大高度、有竖直滚动条、显示不全」；
//   ② mermaid 代码块「无法编辑」（输入不进去/一编辑就退出）；
//   ③ 在 mermaid 图上向上滚滚轮时「不连续，直接跳到 mermaid 上方」。
//
// 这里钉的是**结构性成因与修法**（运行期数字见提交信息里的验收记录）：
//   ① 源码框高度由 JS 按 scrollHeight 写内联 height（含 1px 分隔线补偿），CSS 关掉内部滚动；
//   ② textarea 在 PM 的 DOM 树里，键盘事件会冒泡给 PM 的 keydown（ArrowUp 会 view.focus()、
//      Enter/Backspace 会直接改文档）—— 必须逐个 stopPropagation，并把 NodeView 的事件
//      隔离成"编辑岛"；同时 IME 组字期间不重渲染、不提交；
//   ③ 视口门异步换图会改变块高；块在视口上方时用锚点补偿 scrollTop，视觉位置不动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

installTsExtensionResolve()

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const { normalizeMermaidSource, mermaidAnchorScrollDelta } =
  await import('../src/renderer/src/lib/export.ts')

const vue = read('src/renderer/src/components/editor/CodeBlockView.vue')
const css = read('src/renderer/src/assets/overlays.css')

/** 模板（去注释）：只看"真的渲染什么" */
const template = vue.slice(vue.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '')
/** 脚本（去注释）：只看"真的执行什么" */
const script = vue
  .slice(vue.indexOf('<script setup'), vue.indexOf('</script>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** 顶层规则体（选择器必须从行首开始，避免误匹配 `.a > .b` 这类后代选择器） */
function topRuleBody(text, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(text)
  return m ? m[1] : null
}

/** 取两个函数声明之间的脚本体（end 省略 = 到 </script>） */
function fnBody(startMarker, endMarker) {
  const start = script.indexOf(startMarker)
  assert.ok(start >= 0, `找不到 ${startMarker}`)
  const end = endMarker ? script.indexOf(endMarker, start) : script.length
  assert.ok(end > start, `找不到 ${endMarker}`)
  return script.slice(start, end)
}

/** 规则体（允许组合选择器；用于既有契约里的 `.a, .b { … }`） */
function ruleBody(text, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`${esc}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`).exec(text)
  return m ? m[1] : null
}

// ─── ① 纯函数：空源码口径 + 锚点补偿 ──────────────────────────────────────────
test('空源码口径：只有空白 ⇒ 空；非空逐字保留（缩进/首尾空行不 trim 掉）', () => {
  assert.equal(normalizeMermaidSource(''), '')
  assert.equal(normalizeMermaidSource('   \n\t\n '), '')
  const src = '  graph TD\n    A --> B\n'
  assert.equal(
    normalizeMermaidSource(src),
    src,
    '非空源码必须逐字保留（缩进是 mermaid 排版的一部分）'
  )
  assert.equal(
    normalizeMermaidSource('\ngraph TD'),
    '\ngraph TD',
    '首部空行也属于源码，不能被 trim'
  )
})

test('滚动锚点补偿量：块在视口上方按高度差、在视口内按块顶偏移、在下方不补偿', () => {
  assert.equal(mermaidAnchorScrollDelta('above', -793, 0), -793, '缩 793px ⇒ scrollTop 减 793')
  assert.equal(mermaidAnchorScrollDelta('above', 500, 0), 500, '长 500px ⇒ scrollTop 加 500')
  assert.equal(mermaidAnchorScrollDelta('visible', 300, -20), -20, '块在视口里：只跟块顶偏移')
  assert.equal(mermaidAnchorScrollDelta('below', 999, 0), 0, '块在视口下方：视口内容没变，不动')
})

// ─── ② 源码框：不限高、无内部滚动条 ───────────────────────────────────────────
test('CSS：源码框 max-height:none、overflow 关掉内部滚动、只允许纵向 resize', () => {
  const body = topRuleBody(css, '.mermaid-source-input')
  assert.ok(body, '找不到顶层 .mermaid-source-input 规则')
  assert.match(body, /min-height:\s*130px/, '最小高度仍是 130px（块不会缩成一条缝）')
  assert.match(body, /max-height:\s*none/, '必须显式 max-height:none（用户报障：显示不全）')
  assert.match(
    body,
    /overflow-y:\s*hidden/,
    '不允许内部竖直滚动条（验收 scrollHeight===clientHeight）'
  )
  assert.match(body, /overflow-x:\s*hidden/, '源码框不横向滚动（长行由 textarea 软换行）')
  assert.match(body, /resize:\s*vertical/, '只允许纵向拖拽，不许横向')
  assert.doesNotMatch(body, /overflow-y:\s*(?:auto|scroll)/, 'overflow-y 不许是 auto/scroll')
})

test('自动增高：height 先 auto 再按 scrollHeight 写回，并补偿 1px 分隔线', () => {
  const body = fnBody('function autosizeMermaidSource', 'function captureMermaidScrollAnchor')
  assert.match(
    body,
    /el\.style\.height = 'auto'/,
    '必须先置 auto 才能量出"内容真实高度"（否则删行不会缩）'
  )
  assert.match(body, /el\.scrollHeight/, '高度基准必须是 scrollHeight')
  assert.match(
    body,
    /el\.offsetHeight - el\.clientHeight/,
    '源码框有 1px border-bottom，直接写 scrollHeight 会让 clientHeight 少 1px（验收要求相等）'
  )
  assert.match(body, /MERMAID_SOURCE_MIN_HEIGHT_PX/, '以最小高度为下限')
  assert.match(
    body,
    /el\.scrollTop = keepTop/,
    '改高度前后保住 textarea 自己的 scrollTop，避免 1px 内部滚动'
  )
  // 三个入口都要贴合：输入、组字结束、进入编辑态
  assert.ok(
    (script.match(/autosizeMermaidSource\(\)/g) || []).length >= 4,
    'autosize 至少要在 input / compositionend / startMermaidEdit 三处调用'
  )
})

// ─── ③ 可编辑：把 textarea 从 PM 的事件里隔离出来 ─────────────────────────────
test('事件隔离：textarea 的编辑事件逐个 stopPropagation，覆盖键盘/输入/粘贴/组字/指针', () => {
  const body = fnBody('const MERMAID_SOURCE_LOCAL_EVENTS =', 'function isolateMermaidSource')
  for (const type of [
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'paste',
    'cut',
    'copy',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'mousedown',
    'click',
    'drop'
  ]) {
    assert.match(body, new RegExp(`'${type}'`), `隔离清单缺 ${type}`)
  }
  const iso = fnBody('function isolateMermaidSource', 'function autosizeMermaidSource')
  assert.match(
    iso,
    /stopPropagation\(\)/,
    '隔离实现必须是 stopPropagation（不能 preventDefault，浏览器默认编辑还得留着）'
  )
  assert.doesNotMatch(iso, /preventDefault\(\)/, '隔离只拦冒泡，不许 preventDefault')
  assert.match(
    script,
    /isolateMermaidSource\(el\)[\s\S]{0,200}el\.focus\(\{ preventScroll: true \}\)/,
    '进入编辑态必须先装隔离、再 focus（focus 之前键盘就可能已经冒泡到 PM）'
  )
})

test('真因有注释钉住：PM 的 keydown 会抢焦点/改文档，`.cm-editor` 的 stopEvent 兜不住 textarea', () => {
  assert.match(vue, /selectVertically/, '必须把 ArrowUp/Down 抢焦点的真因写清楚')
  assert.match(vue, /splitBlock/, '必须把 Enter 直接改文档的真因写清楚')
  assert.match(vue, /joinBackward/, '必须把 Backspace 直接改文档的真因写清楚')
  assert.match(
    vue,
    /stopEvent（只认 `\.cm-editor`）/,
    '必须说明为什么 codeBlock 的 stopEvent 没兜住'
  )
})

// ─── ④ IME：组字不打断、不提交、Esc 只收候选 ─────────────────────────────────
test('IME 守卫：组字期间不排预览、组字结束补排；Esc/Ctrl+Enter 不提交', () => {
  const input = fnBody('function onMermaidSourceInput', 'function onMermaidCompositionStart')
  assert.match(
    input,
    /if \(mermaidComposing\.value\) return/,
    '组字期间不许排预览（mermaid.render 会打断候选词）'
  )

  const keydown = fnBody('function onMermaidSourceKeydown', 'watch(')
  assert.match(
    keydown,
    /if \(e\.isComposing \|\| mermaidComposing\.value\) return/,
    '组字中的 Esc 只能结束组字：不提交、不 preventDefault'
  )
  assert.match(keydown, /e\.key === 'Escape'/, '非组字时 Esc 仍要提交')
  assert.match(keydown, /commitMermaid\(\)/)

  const end = fnBody('function onMermaidCompositionEnd', 'function onMermaidSourceKeydown')
  assert.match(end, /mermaidComposing\.value = false/)
  assert.match(end, /onMermaidSourceInput\(\)/, '组字结束要补排一次预览')
  assert.match(end, /commitMermaid\(\)/, '组字期间被推迟的 blur 要在这里补提交')

  const commit = fnBody('function commitMermaid')
  assert.match(
    commit,
    /if \(mermaidComposing\.value\)/,
    '组字中的 blur 不许直接提交（会把半截拼音写进文档）'
  )
  assert.match(commit, /mermaidBlurWhileComposing = true/, '推迟到 compositionend 再提交')
  assert.match(template, /@compositionstart="onMermaidCompositionStart"/)
  assert.match(template, /@compositionend="onMermaidCompositionEnd"/)
})

// ─── ⑤ 提交语义：空内容 / 空白 / getMarkdown ──────────────────────────────────
test('提交：只有空白 ⇒ 清空块内容（tr.delete），非空 ⇒ 原样写回', () => {
  const commit = fnBody('function commitMermaid')
  assert.match(commit, /normalizeMermaidSource\(mermaidSource\.value\)/, '提交口径必须走共享纯函数')
  assert.match(
    commit,
    /if \(source === ''\) \{\s*tr\.delete\(pos \+ 1, pos \+ node\.nodeSize - 1\)/,
    '空内容不能 schema.text("")，必须 tr.delete'
  )
  assert.match(commit, /tr\.replaceWith\([\s\S]*schema\.text\(source\)/, '非空源码逐字写回')
  // 空块在显示态/编辑态都要有占位文案，不能留一个不可解释的空洞
  assert.match(
    template,
    /\{\{\s*props\.node\.textContent \|\| \$t\('editor\.mermaidEmpty'\)\s*\}\}/
  )
  assert.match(template, /\{\{\s*mermaidSource \|\| \$t\('editor\.mermaidEmpty'\)\s*\}\}/)
  assert.match(
    script,
    /if \(normalizeMermaidSource\(props\.node\.textContent \|\| ''\) === ''\)/,
    '空源码不交给 mermaid.render（必抛错）'
  )
})

// ─── ⑥ 滚动锚点：异步换图前后保住视觉位置 ────────────────────────────────────
test('显示态换图：先记录锚点、nextTick 后恢复；预览换图同样处理', () => {
  const render = fnBody('async function renderMermaid', 'async function renderMermaidPreview')
  assert.match(render, /captureMermaidScrollAnchor\(\)/, '换图前必须记录锚点')
  assert.match(
    render,
    /mermaidSvg\.value = normalizeMermaidSvg\(svg\)/,
    '尺寸清洗仍只有一处（既有契约）'
  )
  assert.match(
    render,
    /await nextTick\(\)[\s\S]*restoreMermaidScrollAnchor\(anchor\)/,
    'DOM 更新后必须恢复锚点'
  )
  const preview = fnBody('async function renderMermaidPreview', 'function onMermaidSourceInput')
  assert.match(preview, /captureMermaidScrollAnchor\(\)/)
  assert.match(preview, /restoreMermaidScrollAnchor\(anchor\)/)

  const helper = fnBody('function restoreMermaidScrollAnchor', 'async function renderMermaid')
  assert.match(helper, /mermaidAnchorScrollDelta\(/, '补偿量走纯函数（单测钉住三种位置）')
  assert.match(helper, /r\.bottom <= anchor\.viewTop \? 'above'/, '块整体在视口上方 = above')
  assert.match(helper, /r\.top >= anchor\.viewBottom \? 'below'/, '块整体在视口下方 = below')
  assert.match(helper, /anchor\.block\.isConnected/, '块已卸载时不拿 0 rect 去改 scrollTop')
})

test('CSS 契约未被破坏：只缩不放 / 两段分栏仍在', () => {
  const svg = ruleBody(css, '.mermaid-block .mermaid-render svg')
  assert.ok(svg)
  assert.match(svg, /max-width:\s*100%/)
  assert.match(svg, /height:\s*auto/)
  const edit = topRuleBody(css, '.mermaid-block .mermaid-edit')
  assert.ok(edit)
  assert.match(edit, /display:\s*flex/)
  assert.match(edit, /flex-direction:\s*column/)
  assert.doesNotMatch(vue, /mermaidEditHeight/, '两态等高锁定必须保持删除')
})
