// 链接图片（README 徽章）点击前后一致性：
//   * 点击把 image 节点换成原文文本时，**link mark 必须保留**（否则 `<a>` 消失、下划线没了、
//     保存还会丢链接）；
//   * 图片链接**不画下划线**（本仓库用 border-bottom 画）；
//   * 并排段里的 widget 与静态渲染共用同一套几何规则（三态几何）。
// 这是静态契约测试：运行时几何另由 tools/_verify-image-ui.js（图片契约）与
// tmp/linkimg-verify.js（本次三态量具）在隔离实例上断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { imageGapBefore, linkAttrsOf } from '../src/renderer/src/lib/editor/imageLinkLayout.ts'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf-8')
const toolbar = read('../src/renderer/src/lib/editor/imageToolbar.ts')
const css = read('../src/renderer/src/assets/markdown.css')

/** 某选择器（出现在逗号分隔的选择器列表里）命中的所有规则体，拼起来便于断言 */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
const cssBodies = (selector) => {
  const out = []
  const re = /([^{}]+)\{([^}]*)\}/g
  let m
  while ((m = re.exec(cssNoComments)) !== null) {
    const list = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (list.includes(selector)) out.push(m[2])
  }
  return out.length ? out.join('\n') : null
}
const cssRule = cssBodies

test('并排间隙策略：三态答案一致（前一张是链接图 ⇒ 不吃 0.6em）', () => {
  const link = { link: { href: 'LICENSE' } }
  const bare = { link: null }
  // 初始：第一张链接、后三张裸图
  assert.equal(imageGapBefore(null), false)
  assert.equal(imageGapBefore(link), false)
  assert.equal(imageGapBefore(bare), true)
  // 点击后同一份文档（prev 仍是同一个 ImgSource）⇒ 答案不变
  assert.equal(imageGapBefore(link), false)
  assert.equal(imageGapBefore(bare), true)
  // 再点一次也不改变答案
  assert.equal(imageGapBefore(link), false)
  assert.equal(imageGapBefore(bare), true)
})

test('链接属性归一化：空值忽略，至少一个属性才算链接', () => {
  assert.equal(linkAttrsOf(null), null)
  assert.equal(linkAttrsOf({}), null)
  assert.equal(linkAttrsOf({ href: '', target: null }), null)
  assert.deepEqual(
    linkAttrsOf({ href: 'LICENSE', target: '_blank', rel: '', class: null, title: null }),
    {
      href: 'LICENSE',
      target: '_blank'
    }
  )
})

test('点击后的 widget 保留链接语义：有 link ⇒ 画同属性的 <a> 包 <img>', () => {
  assert.match(toolbar, /if \(img\.link\) \{\s*const a = document\.createElement\('a'\)/)
  assert.match(toolbar, /for \(const \[k, v\] of Object\.entries\(img\.link\)\)/)
  assert.match(toolbar, /a\.appendChild\(im\)/)
  assert.match(toolbar, /span\.appendChild\(a\)/)
  // 没有链接时仍是裸 img（不无中生有多余的 <a>）
  assert.match(toolbar, /\} else \{\s*span\.appendChild\(im\)\s*\}/)
})

test('节点 → 原文文本保留原 mark（link），而不是只挂 MdHtml', () => {
  assert.match(toolbar, /function imageTextMarks\(node: PMNode, mdHtml: MarkType \| undefined\)/)
  assert.match(toolbar, /const marks: Mark\[\] = \[\.\.\.node\.marks\]/)
  // 四处转换：nodeToRaw / replaceRaw / mouseup / normalizeToInlineText
  const calls = toolbar.match(/imageTextMarks\(/g) || []
  assert.ok(calls.length >= 5, `imageTextMarks 调用点过少：${calls.length}`)
  // 反向守卫：不许再出现"节点→文本只挂 mdHtml"的写法
  assert.doesNotMatch(
    toolbar,
    /const text = st\.schema\.text\(\s*alt \? `!\[\$\{alt\}\]\(\$\{src\}\)` : `!\[\]\(\$\{src\}\)`,\s*mdMark \? \[mdMark\.create\(\)\] : undefined\s*\)/
  )
  assert.match(toolbar, /link: linkAttrsOf\(node\.marks\)/)
})

test('点击命中的精确优先：相邻图片不再被前一张源码的 ±1 边界吞掉', () => {
  const exact = toolbar.indexOf('at.pos >= s.from && at.pos <= s.to')
  const fuzzy = toolbar.indexOf('at.pos >= s.from - 1 && at.pos <= s.to + 1')
  assert.ok(exact > 0 && fuzzy > exact, '必须先精确匹配，再退回 ±1')
})

test('图片链接不画下划线：text-decoration 与 border-bottom 都清 0，且不用 !important', () => {
  const rule = cssRule('.md-preview a:has(> img)')
  assert.ok(rule, '缺少 .md-preview a:has(> img) 规则')
  assert.match(rule, /text-decoration:\s*none/)
  assert.match(rule, /border-bottom:\s*0/)
  assert.match(rule, /display:\s*inline-block/)
  assert.match(rule, /vertical-align:\s*top/)
  assert.doesNotMatch(css, /a:has\(>\s*img\)[^{]*\{[^}]*!important/)
  // 普通正文链接的下划线仍在（只对"图片链接"清掉）
  const base = cssRule('.md-preview a')
  assert.match(base, /border-bottom:\s*1px solid/)
})

test('三态几何：并排段 widget 外壳不生成盒子，img/a 与静态同一套规则', () => {
  const shell = cssRule('.md-preview p.img-side-by-side .img-widget.img-widget--inline')
  assert.ok(shell, '缺少并排段 widget 透明外壳规则')
  assert.match(shell, /display:\s*contents/)
  const imgRule = cssRule('.md-preview p.img-side-by-side .img-widget.img-widget--inline > img')
  assert.ok(imgRule)
  assert.match(imgRule, /vertical-align:\s*top/)
  assert.match(imgRule, /margin-inline:\s*0/)
  const anchorRule = cssRule('.md-preview p.img-side-by-side .img-widget.img-widget--inline > a')
  assert.ok(anchorRule)
  assert.match(anchorRule, /vertical-align:\s*top/)
  assert.match(anchorRule, /line-height:\s*0/)
  // 静态链接图（p > a > img）也吃同一套 top / 0 外边距
  assert.match(css, /\.md-preview p > a > img,\s*\.md-preview a:has\(> img\) > img\s*\{/)
  // 间隙直接落在 img 上（外壳是 contents，挂壳上会被吞掉）
  const gap = cssRule('.md-preview p.img-side-by-side .img-widget img.img-gap-before')
  assert.ok(gap)
  assert.match(gap, /margin-inline-start:\s*0\.6em/)
})

test('链接图后面那张裸图的间隙仍由同一个排除条件决定', () => {
  const gap = cssRule('.md-preview p.img-side-by-side > .img-widget:not(.img-widget--linked) + img')
  assert.ok(gap)
  assert.match(gap, /margin-inline-start:\s*0\.6em/)
  assert.match(toolbar, /img-widget--linked/)
})

test('SVG 徽章保持原始样式（无圆角/阴影）；只有独立成段的正文大图保留卡片', () => {
  const base = cssRule('.md-preview img')
  assert.ok(base)
  assert.doesNotMatch(base, /border-radius/)
  assert.doesNotMatch(base, /box-shadow/)
  for (const sel of ['.md-preview p > img:only-child', '.md-preview p > a:only-child > img']) {
    const body = cssRule(sel)
    assert.ok(body, `缺少 ${sel}`)
    assert.match(body, /border-radius:\s*10px/)
    assert.match(body, /box-shadow:\s*var\(--shadow-2\)/)
  }
  const svg = cssRule(".md-preview img[src*='.svg']")
  assert.ok(svg, '缺少 SVG 保险规则')
  assert.match(svg, /border-radius:\s*0/)
  assert.match(svg, /box-shadow:\s*none/)
  assert.doesNotMatch(css, /img\[src\*=['"]\.svg['"]\][^{]*\{[^}]*!important/)
  // widget 不许用内联 style 把圆角/阴影加回去
  assert.doesNotMatch(toolbar, /borderRadius|boxShadow/)
})
