// PDF 页眉/页脚模板（src/shared/pdfTemplates.ts）：纯函数，毫秒级。
//
// 这是"PDF 有页码/页眉"这条交付**唯一可自动验证的证据** —— PDF 里的文字是矢量绘制，
// 去解析内容流断言"第 1 页 / 共 3 页"不值得；而 Chromium 的模板契约很明确：
// 只有 `.pageNumber` / `.totalPages` / `.title` / `.date` 这几个类会被替换。
// 所以把模板抽成纯函数，直接钉住"页码占位符在不在"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pdfFooterTemplate, pdfHeaderTemplate } from '../src/shared/pdfTemplates.ts'

test('页脚模板：必须带 pageNumber 与 totalPages 占位符（Chromium 的契约）', () => {
  const footer = pdfFooterTemplate(0.79)
  assert.match(footer, /class="pageNumber"/)
  assert.match(footer, /class="totalPages"/)
  assert.match(footer, /padding:0 0\.79in/, '边距要跟着用户设置走，否则页码会压到正文上')
})

test('页眉模板：右对齐 + 标题，且标题要转义', () => {
  const header = pdfHeaderTemplate('我的<书>&"引号"', 0.5)
  assert.ok(header.includes('我的&lt;书&gt;&amp;&quot;引号&quot;'), header)
  assert.match(header, /text-align:right/)
  assert.match(header, /font-size:8px/, 'Chromium 不继承页面样式：字号必须写在行内')
})

test('模板不含页面样式依赖（Chromium 的模板是独立片段）', () => {
  for (const tpl of [pdfHeaderTemplate('x', 1), pdfFooterTemplate(1)]) {
    assert.equal(/var\(--/.test(tpl), false, '模板里不能用 CSS 变量')
    assert.equal(/<html|<body/.test(tpl), false, '模板只应是片段，不是整页')
  }
})
