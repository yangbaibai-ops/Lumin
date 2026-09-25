// ─── markdown-it 渲染规则「打补丁」的单测 ─────────────────────────────────────────
//
// 审计 §10 P1「48 个 ≥80 行的 src 文件零引用」里的又一批：这几处**都是"给 markdown-it 的
// 渲染规则套一层"**，而这类代码有两个只在运行时才暴露的坑：
//   ① **重复包装**：`parse.setup` 每次 parse 前都会被调，套两层就会写出双份 `data-*`
//      （甚至递归），所以每个补丁都有幂等标记；
//   ② **任务列表复选框**：那是 markdown-it-task-lists **生成**的 html_inline token，
//      把它也当"用户写的行内 HTML"就会渲染成一堆标签文本（实测 `task-lists.md` 从 exact 掉 lossy）。
// 两条都是"错了整篇文档就变样"的逻辑，之前没有任何单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchHtmlRules } from '../src/renderer/src/lib/editor/htmlPassthrough.ts'
import { patchBulletListOpen } from '../src/renderer/src/lib/editor/listMarkers.ts'

// ── patchHtmlRules：行内 / 块级 HTML 的渲染规则 ────────────────────────────────
const fakeMd = () => ({ renderer: { rules: {} } })

test('patchHtmlRules：行内 HTML 包成 data-md-html 并转义', () => {
  const md = fakeMd()
  patchHtmlRules(md)
  assert.equal(
    md.renderer.rules.html_inline([{ content: '<kbd>' }], 0),
    '<span data-md-html>&lt;kbd&gt;</span>'
  )
})

test('patchHtmlRules：任务列表复选框 token **原样通过**（不能被当作用户写的 HTML）', () => {
  const md = fakeMd()
  patchHtmlRules(md)
  const checkbox = '<input class="task-list-item-checkbox" type="checkbox" checked>'
  assert.equal(md.renderer.rules.html_inline([{ content: checkbox }], 0), checkbox)
  // 用户手写的 <input>（没有那个 class）仍然按 HTML 原文保留、转义
  const manual = '<input type="text">'
  assert.match(md.renderer.rules.html_inline([{ content: manual }], 0), /^<span data-md-html>/)
})

test('patchHtmlRules：块级 HTML 进 data-md-htmlblock，逐字保留并收尾换行', () => {
  const md = fakeMd()
  patchHtmlRules(md)
  assert.equal(
    md.renderer.rules.html_block([{ content: '<div>\n块\n</div>' }], 0),
    '<pre data-md-htmlblock>&lt;div&gt;\n块\n&lt;/div&gt;</pre>\n'
  )
})

test('patchHtmlRules：重复调用只包装一次（幂等，避免双份属性/递归）', () => {
  const md = fakeMd()
  patchHtmlRules(md)
  const first = md.renderer.rules.html_inline
  patchHtmlRules(md)
  assert.equal(md.renderer.rules.html_inline, first, '第二次调用不该再换一个新函数')
  assert.equal(md.renderer.rules.html_block, md.renderer.rules.html_block)
})

test('patchHtmlRules：拿不到实例时安静返回（不抛）', () => {
  assert.doesNotThrow(() => patchHtmlRules(null))
  assert.doesNotThrow(() => patchHtmlRules(undefined))
  assert.doesNotThrow(() => patchHtmlRules({}))
  assert.doesNotThrow(() => patchHtmlRules({ renderer: {} }))
})

// ── patchBulletListOpen：把源码里的 `-`/`*`/`+` 记到 data-bullet ──────────────
function bulletMd(original) {
  const md = { renderer: { rules: {} } }
  if (original) md.renderer.rules.bullet_list_open = original
  return md
}
const token = (markup) => ({
  markup,
  attrs: {},
  attrSet(k, v) {
    this.attrs[k] = v
  }
})

test('patchBulletListOpen：把 token.markup 记进 data-bullet，并原样调用原规则', () => {
  let calls = 0
  const md = bulletMd(() => {
    calls += 1
    return 'ORIG'
  })
  patchBulletListOpen(md)
  const t = token('*')
  assert.equal(md.renderer.rules.bullet_list_open([t], 0, {}, {}, {}), 'ORIG')
  assert.equal(t.attrs['data-bullet'], '*')
  assert.equal(calls, 1)
})

test('patchBulletListOpen：没有原规则时退回 self.renderToken', () => {
  const md = bulletMd(null)
  patchBulletListOpen(md)
  const t = token('+')
  const self = { renderToken: () => 'SELF' }
  assert.equal(md.renderer.rules.bullet_list_open([t], 0, {}, {}, self), 'SELF')
  assert.equal(t.attrs['data-bullet'], '+')
})

test('patchBulletListOpen：重复调用不会套两层（原规则每次只被调一次）', () => {
  let calls = 0
  const md = bulletMd(() => {
    calls += 1
    return 'ORIG'
  })
  patchBulletListOpen(md)
  const once = md.renderer.rules.bullet_list_open
  patchBulletListOpen(md)
  assert.equal(md.renderer.rules.bullet_list_open, once, '第二次不该再包一层')
  md.renderer.rules.bullet_list_open([token('-')], 0, {}, {}, {})
  assert.equal(calls, 1, '一次渲染只调用一次原规则（套两层会调两次）')
})

test('patchBulletListOpen：token 没有 markup 时不写属性（不炸）', () => {
  const md = bulletMd(() => 'ORIG')
  patchBulletListOpen(md)
  const t = {
    attrs: {},
    attrSet(k, v) {
      this.attrs[k] = v
    }
  }
  assert.equal(md.renderer.rules.bullet_list_open([t], 0, {}, {}, {}), 'ORIG')
  assert.deepEqual(t.attrs, {})
})
