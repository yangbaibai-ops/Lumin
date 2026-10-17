// ─── mermaid 尺寸「只缩不放」+ 编辑态「代码在上、实时预览在下」──────────────────
//
// 用户报障（2026）：
//   ① 竖向 mermaid 被 width:100% 拉满整屏（一个方框占满可视区）；
//   ② 点图进入源码态后「有代码没图」，要的是同一块内代码在上、实时预览在下。
//
// 这里钉四类事实（都是**结构性**的，运行期数字见 tools 里的验收记录与提交信息）：
//   ① `normalizeMermaidSvg()` 把 viewBox 的自然宽高写回 width/height、摘掉内联 style；
//   ② 编辑器与导出侧的 CSS 契约都是 `max-width:100% + height:auto`，**没有 width:100%**
//      （有它就是无条件放大，竖图必然一屏一个框）；
//   ③ 编辑态的 DOM 是「源码框 → 错误提示 → 预览」纵向两段，互斥的 v-if/v-else 已删除；
//   ④ 防抖 300ms（验收窗口 ≤400ms）、失败保留上一张成功的图。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

installTsExtensionResolve()

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const { normalizeMermaidSvg, nextMermaidPreviewState } =
  await import('../src/renderer/src/lib/export.ts')

const vue = read('src/renderer/src/components/editor/CodeBlockView.vue')
const css = read('src/renderer/src/assets/overlays.css')
const exp = read('src/renderer/src/lib/export.ts')

/** 模板（去注释）：只看"真的渲染什么" */
const template = vue.slice(vue.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '')
/** 脚本（去注释）：只看"真的执行什么" */
const script = vue
  .slice(vue.indexOf('<script setup'), vue.indexOf('</script>'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** 取出一个 CSS 规则体；selector 必须是**完整**选择器（不能只是更长选择器的前缀） */
function ruleBody(text, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 选择器之后只允许：空白 + `{`（单条）或 `,` + 后续选择器列表 + `{`（组合选择器）
  const m = new RegExp(`${esc}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`).exec(text)
  return m ? m[1] : null
}

/** 声明级 `width:`（不能误伤 `max-width:` / `min-width:`） */
const hasWidthDecl = (body) => /(?:^|;)\s*width\s*:/.test(body.replace(/\s+/g, ' '))

// ─── ① SVG 清洗：自然尺寸写回属性 ─────────────────────────────────────────────
test('清洗：竖向图 width/height = viewBox 自然值（不再写 width:100%）', () => {
  const input =
    '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 346px;" viewBox="0 0 346 590" role="graphics-document"><style>.node{fill:none}</style><g/></svg>'
  const out = normalizeMermaidSvg(input)
  assert.match(out, /<svg[^>]*\swidth="346"/, 'width 必须是 viewBox 的自然宽')
  assert.match(out, /<svg[^>]*\sheight="590"/, 'height 必须是 viewBox 的自然高')
  assert.match(out, /viewBox="0 0 346 590"/, 'viewBox 必须保留（缩放比例全靠它）')
  assert.doesNotMatch(out, /\swidth="100%"/, 'width="100%" 是把竖图拉满整屏的根源')
  assert.doesNotMatch(out, /\sstyle="/, '内联 style（max-width）必须摘掉：缩放口径只能有一处')
  assert.match(out, /<style>\.node\{fill:none\}<\/style>/, 'svg 内容里的 <style> 必须原样保留')
})

test('清洗：宽扁图同样写自然值；负 minX/minY 与小数不丢精度', () => {
  const out = normalizeMermaidSvg(
    '<svg width="100%" style="max-width: 1741px;" viewBox="-8 -8 1741.4375 94"><g/></svg>'
  )
  assert.match(out, /\swidth="1741.4375"/)
  assert.match(out, /\sheight="94"/)
  // 没有 width / height 属性时补在最前面（mermaid 的某些版本只给 viewBox）
  const added = normalizeMermaidSvg('<svg viewBox="0,0,320,240"><g/></svg>')
  assert.match(added, /\swidth="320"/)
  assert.match(added, /\sheight="240"/)
})

test('清洗：没有 viewBox 时保守兜底 —— 百分比宽度必须去掉，固定 height 去掉', () => {
  const out = normalizeMermaidSvg('<svg width="100%" height="120"><g/></svg>')
  assert.doesNotMatch(out, /width="100%"/)
  assert.doesNotMatch(out, /height="120"/)
})

// ─── ② CSS 契约：只缩不放（编辑器 + 导出同一口径）──────────────────────────────
test('编辑器 CSS：svg 只有 max-width:100% + height:auto，没有 width:100% / flex 放大', () => {
  const svgRule = ruleBody(css, '.mermaid-block .mermaid-render svg')
  assert.ok(svgRule, '找不到 .mermaid-block .mermaid-render svg 规则')
  assert.match(svgRule, /max-width:\s*100%/, '宽图必须靠 max-width 缩到容器宽')
  assert.match(svgRule, /height:\s*auto/, 'height:auto 才能按内在比例等比缩放')
  assert.equal(
    hasWidthDecl(svgRule),
    false,
    'svg 不许有 width 声明：width:100% 会无条件放大（竖图一屏一个框）'
  )
  assert.doesNotMatch(svgRule, /flex\s*:/, 'svg 不该再作为 flex 项被 grow 撑满')

  const hostRule = ruleBody(css, '.mermaid-block .mermaid-render > .mermaid-svg-host')
  assert.ok(hostRule, '找不到 .mermaid-svg-host 规则')
  assert.match(hostRule, /min-width:\s*0/, '缺 min-width:0：窄窗口下宿主会被 min-content 顶住')
  assert.match(hostRule, /max-width:\s*100%/, '缺 max-width:100%：宽图会溢出内容列')
  assert.equal(hasWidthDecl(hostRule), false, '宿主不许写 width:100%：那等于把每张图都撑满')
  assert.doesNotMatch(hostRule, /flex\s*:/, '宿主不许 flex-grow：它必须按自然宽 shrink-to-fit')
})

test('导出 CSS：与编辑器同一条「只缩不放」契约（同一份文档两种观感会漂）', () => {
  const svgRule = ruleBody(exp, '.md-mermaid svg')
  assert.ok(svgRule, '导出模板缺 .md-mermaid svg 规则')
  assert.match(svgRule, /max-width:\s*100%/)
  assert.match(svgRule, /height:\s*auto/)
  assert.equal(hasWidthDecl(svgRule), false, '导出侧也不许 width:100%')

  const hostRule = ruleBody(exp, '.md-mermaid .mermaid-svg-host')
  assert.ok(hostRule, '导出模板缺 .md-mermaid .mermaid-svg-host 规则')
  assert.match(hostRule, /min-width:\s*0/)
  assert.match(hostRule, /max-width:\s*100%/)
  assert.equal(hasWidthDecl(hostRule), false, '导出侧宿主也不许 width:100%')

  // 渲染入口必须共用 normalizeMermaidSvg（不是各写一遍 replace）
  assert.match(
    exp,
    /wrap\.innerHTML = `<div class="mermaid-svg-host">\$\{normalizeMermaidSvg\(svg\)\}<\/div>`/
  )
})

test('组件用的是 lib/export 的同一对函数（尺寸/预览状态只有一处实现）', () => {
  assert.match(
    script,
    /import \{ nextMermaidPreviewState, normalizeMermaidSvg \} from '\.\.\/\.\.\/lib\/export'/,
    'CodeBlockView 必须引用共享的 normalizeMermaidSvg / nextMermaidPreviewState'
  )
  assert.match(script, /mermaidSvg\.value = normalizeMermaidSvg\(svg\)/, '显示态渲染必须走清洗函数')
})

// ─── ③ 编辑态 DOM：代码在上、预览在下（两段同时存在）────────────────────────────
const editRegionStart = template.indexOf('v-if="editingMermaid"')
const editRegionEnd = template.indexOf('<button', editRegionStart)

test('编辑态结构：源码框与预览在**同一个** v-if 分支里，纵向顺序是 源码 → 错误 → 预览', () => {
  assert.ok(editRegionStart > 0 && editRegionEnd > editRegionStart, '找不到编辑态分支')
  const region = template.slice(editRegionStart, editRegionEnd)
  // 两段都在（不是 v-if / v-else 二选一）。注意：仅允许**预览内部**在
  // 「上次成功的图 / 源码占位」之间用 v-else —— 那不是"代码 vs 图"的互斥。
  assert.match(region, /data-mermaid-source/, '编辑态缺源码框')
  assert.match(region, /data-mermaid-preview/, '编辑态缺实时预览容器')
  assert.doesNotMatch(region, /<textarea[^>]*v-else/, '源码框不许再与预览互斥（v-else）')
  assert.doesNotMatch(
    region,
    /v-else[^>]*data-mermaid-preview/,
    '预览容器不许与源码框互斥（v-else）'
  )
  // 错误提示是唯一允许的条件渲染，且夹在源码与预览之间（"预览上方"）
  const srcAt = region.indexOf('data-mermaid-source')
  const errAt = region.indexOf('data-mermaid-error')
  const prevAt = region.indexOf('data-mermaid-preview')
  assert.ok(srcAt >= 0 && errAt > srcAt && prevAt > errAt, 'DOM 顺序必须是 源码 → 错误提示 → 预览')
  assert.match(region, /v-if="mermaidPreviewError"/, '错误提示只在渲染失败时出现')
  assert.match(region, /v-html="mermaidEditSvg"/, '预览必须渲染实时预览图（mermaidEditSvg）')
})

test('编辑态布局 CSS：纵向 flex、两段都不锁定高度、预览可收缩', () => {
  const box = ruleBody(css, '.mermaid-block .mermaid-edit')
  assert.ok(box, '缺 .mermaid-edit 规则')
  assert.match(box, /display:\s*flex/)
  assert.match(box, /flex-direction:\s*column/)
  assert.match(box, /min-width:\s*0/)

  const preview = ruleBody(css, '.mermaid-block .mermaid-preview')
  assert.ok(preview, '缺 .mermaid-preview 规则')
  assert.match(preview, /min-width:\s*0/)
  assert.match(preview, /max-width:\s*100%/)

  const previewSvg = ruleBody(css, '.mermaid-block .mermaid-edit .mermaid-preview svg')
  assert.ok(previewSvg, '预览里的 svg 也要走同一条只缩不放规则')
  assert.match(previewSvg, /max-width:\s*100%/)
  assert.match(previewSvg, /height:\s*auto/)
  assert.equal(hasWidthDecl(previewSvg), false, '预览 svg 也不许 width:100%')

  // 等高锁定已删除：块高必须由两段内容自然决定
  assert.doesNotMatch(
    vue,
    /mermaidEditHeight/,
    'mermaidEditHeight（两态等高）必须删掉：现在是两段共存'
  )
})

// ─── ④ 防抖 + 失败保留旧图 ────────────────────────────────────────────────────
test('防抖：300ms（验收窗口 300–400ms），输入事件只排一次定时器', () => {
  const m = /const MERMAID_PREVIEW_DEBOUNCE_MS = (\d+)/.exec(script)
  assert.ok(m, '缺 MERMAID_PREVIEW_DEBOUNCE_MS 常量')
  const ms = Number(m[1])
  assert.ok(ms >= 300 && ms <= 400, `防抖必须落在 300–400ms（实测 ${ms}）`)
  assert.match(template, /@input="onMermaidSourceInput"/, 'textarea 的 input 必须接实时预览')
  const fn = script.slice(
    script.indexOf('function onMermaidSourceInput'),
    script.indexOf('function onMermaidSourceKeydown')
  )
  assert.match(
    fn,
    /clearTimeout\(mermaidPreviewTimer\)/,
    '连续输入时必须清掉上一个定时器（防抖而不是排队）'
  )
  assert.match(fn, /setTimeout\(/, '输入后要排一次渲染')
  assert.match(fn, /renderMermaidPreview\(\)/, '定时器到点要真的渲染预览')
  // 渲染回来必须认「最新一次」（异步乱序不能覆盖新图）
  assert.match(script, /if \(seq !== mermaidPreviewSeq \|\| !editingMermaid\.value\) return/)
})

test('失败保留上一张成功的图：状态迁移是纯函数，catch 里不覆盖 mermaidEditSvg', () => {
  const old = { svg: '<svg id="last-good"/>', error: false }
  const failed = nextMermaidPreviewState(old, null)
  assert.equal(failed.svg, old.svg, '渲染失败必须原样保留上一张图')
  assert.equal(failed.error, true, '渲染失败必须置错误标记（预览上方那行提示）')

  const okState = nextMermaidPreviewState(failed, '<svg id="new"/>')
  assert.equal(okState.svg, '<svg id="new"/>')
  assert.equal(okState.error, false, '成功渲染要清掉错误提示')

  const fn = script.slice(script.indexOf('async function renderMermaidPreview'))
  const catchAt = fn.lastIndexOf('catch {')
  assert.ok(catchAt > 0, 'renderMermaidPreview 必须有 catch')
  const catchBody = fn.slice(catchAt, fn.indexOf('function onMermaidSourceInput'))
  assert.match(
    catchBody,
    /nextMermaidPreviewState\([\s\S]*?null\s*\)/,
    '失败路径要走状态迁移（保留旧图）'
  )
  assert.doesNotMatch(
    catchBody,
    /mermaidEditSvg\.value\s*=\s*['"`]/,
    '失败路径绝不能把预览换成错误文本'
  )
  // 失败时清掉 mermaid 可能留在 body 里的临时节点
  assert.match(catchBody, /removeMermaidTempNode\(id\)/)
})

// ─── ⑤ 提交语义：Esc / Ctrl+Enter / 点块外都走 commitMermaid ──────────────────
test('提交语义：Esc 与 Ctrl(Cmd)+Enter 都提交；未改动时不发事务', () => {
  const keydown = script.slice(
    script.indexOf('function onMermaidSourceKeydown'),
    script.indexOf('function startMermaidEdit')
  )
  assert.match(keydown, /e\.key === 'Escape'/, 'Esc 必须提交')
  assert.match(
    keydown,
    /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key === 'Enter'/,
    'Ctrl/Cmd+Enter 必须提交'
  )
  assert.match(keydown, /commitMermaid\(\)/, '两条键盘路径都要落回 commitMermaid')
  assert.match(template, /@blur="commitMermaid"/, '点块外（textarea blur）必须提交')

  const commit = script.slice(script.indexOf('function commitMermaid'), script.indexOf('</script>'))
  assert.match(
    commit,
    /if \(!editingMermaid\.value\) return/,
    '重复提交守卫（Esc 后卸载触发 blur 不能再来一次事务）'
  )
  assert.match(
    commit,
    /if \(source === props\.node\.textContent\) return/,
    '未改动 ⇒ 不发事务（getMarkdown 不变）'
  )
  assert.match(commit, /clearTimeout\(mermaidPreviewTimer\)/, '退出时必须清掉待执行的预览定时器')
})

test('没引入 !important / 硬编码颜色（新增的 mermaid 规则）', () => {
  for (const selector of [
    '.mermaid-block .mermaid-edit',
    '.mermaid-block .mermaid-preview',
    '.mermaid-block .mermaid-preview-error'
  ]) {
    const body = ruleBody(css, selector)
    assert.ok(body, `缺 ${selector} 规则`)
    assert.doesNotMatch(body, /!important/, `${selector} 不许 !important`)
    assert.doesNotMatch(
      body,
      /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i,
      `${selector} 不许硬编码颜色（走令牌）`
    )
  }
})
