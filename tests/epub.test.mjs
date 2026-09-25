// EPUB 组装（src/shared/epub.ts）：纯函数，毫秒级。
//
// 审计 §7 第 18 条点名两个缺陷：EPUB **只打一个 chapter1.xhtml**、**ZIP 里没有图片**
// （正文里的本地图是 lumin-file://，阅读器不认 → 导出的书里图全裂）。
// 拆章与图片内嵌的规则都在这个纯模块里，所以这条测试能直接钉住它们。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChapterXhtml,
  buildNavXhtml,
  buildOpf,
  imageSrcs,
  isLocalImageSrc,
  plainText,
  rewriteImageSrcs,
  splitChapters,
  xmlEscape
} from '../src/shared/epub.ts'

const DOC = [
  '<p>前言一段。</p>',
  '<h1>第一章</h1>',
  '<p>正文一</p>',
  '<h1>第二章</h1>',
  '<p>正文二</p>'
].join('\n')

test('splitChapters：按 `<h1>` 拆章，章前内容成为前言章', () => {
  const chapters = splitChapters(DOC, '我的书')
  assert.equal(chapters.length, 3)
  assert.equal(chapters[0].title, '我的书')
  assert.equal(chapters[1].title, '第一章')
  assert.equal(chapters[2].title, '第二章')
  assert.ok(chapters[1].html.startsWith('<h1>第一章</h1>'), '章内应保留 h1 本身')
  assert.ok(!chapters[1].html.includes('第二章'), '章与章之间不能串味')
})

test('splitChapters：没有 h1 时整篇一章（保持旧行为，不做惊喜）', () => {
  const chapters = splitChapters('<p>只有正文</p>', '无标题书')
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, '无标题书')
})

test('splitChapters：只认 h1（h2 不拆章）', () => {
  const chapters = splitChapters('<h1>A</h1><h2>a1</h2><h2>a2</h2><h1>B</h1><p>b</p>', '书')
  assert.equal(chapters.length, 2)
  assert.ok(chapters[0].html.includes('a2'), 'h2 应留在同一章里')
  assert.equal(chapters[1].title, 'B')
})

test('splitChapters：空章（只有空白）会被丢掉', () => {
  const chapters = splitChapters('<h1>A</h1>\n\n<h1>B</h1><p>b</p>', '书')
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, 'B')
})

test('plainText：剥标签 + 解实体 + 折空白', () => {
  assert.equal(plainText('<h1>一 &amp; 二</h1>'), '一 & 二')
  assert.equal(plainText('<p>a\n   b</p>'), 'a b')
  assert.equal(plainText('&lt;tag&gt;'), '<tag>')
})

test('imageSrcs / isLocalImageSrc：只收本地图，远程与 data 不参与打包', () => {
  const html =
    '<img src="lumin-file:///D%3A/a.png"><img src="https://x/y.png"><img src="data:image/png;base64,AA">'
  assert.deepEqual(imageSrcs(html), [
    'lumin-file:///D%3A/a.png',
    'https://x/y.png',
    'data:image/png;base64,AA'
  ])
  assert.equal(isLocalImageSrc('lumin-file:///D%3A/a.png'), true)
  assert.equal(isLocalImageSrc('assets/a.png'), true)
  assert.equal(isLocalImageSrc('https://x/y.png'), false)
  assert.equal(isLocalImageSrc('data:image/png;base64,AA'), false)
  const chapters = splitChapters(`<h1>A</h1>${html}`, '书')
  assert.deepEqual(chapters[0].images, ['lumin-file:///D%3A/a.png'])
})

test('rewriteImageSrcs：只换映射里的，src 含正则元字符也不出错', () => {
  const html = '<img src="a+b(1).png"><img src="https://x/y.png">'
  const out = rewriteImageSrcs(html, { 'a+b(1).png': 'images/img-1.png' })
  assert.ok(out.includes('src="images/img-1.png"'))
  assert.ok(out.includes('src="https://x/y.png"'), '没映射的必须原样')
})

test('buildChapterXhtml：带 xhtml 命名空间与 xml:lang（EPUB3 要求）', () => {
  const xhtml = buildChapterXhtml(
    { title: '第一章', html: '<p>x</p>', images: [] },
    { title: '书', lang: 'zh-CN', css: 'body{}' }
  )
  assert.ok(xhtml.includes('xmlns="http://www.w3.org/1999/xhtml"'))
  assert.ok(xhtml.includes('xml:lang="zh-CN"'))
  assert.ok(xhtml.includes('<title>第一章</title>'))
  assert.ok(xhtml.includes('href="styles.css"'))
})

test('buildNavXhtml：每章一条，标题进目录', () => {
  const nav = buildNavXhtml(
    [
      { title: '第一章', html: '', images: [] },
      { title: '第二章', html: '', images: [] }
    ],
    { title: '书', lang: 'zh-CN', tocTitle: '目录' }
  )
  assert.ok(nav.includes('epub:type="toc"'))
  assert.ok(nav.includes('chapter-1.xhtml'))
  assert.ok(nav.includes('chapter-2.xhtml'))
  assert.ok(nav.includes('>第一章</a>'))
})

test('buildOpf：manifest 收全部章节与图片、spine 按序、lang/modified 落元数据', () => {
  const opf = buildOpf({
    title: '我的书',
    author: 'Lumin',
    lang: 'zh-CN',
    chapters: 3,
    images: ['img-1.png', 'img-2.jpg'],
    id: 'lumin-1',
    modified: '2026-09-24T00:00:00Z'
  })
  assert.ok(opf.includes('href="chapter-1.xhtml"') && opf.includes('href="chapter-3.xhtml"'))
  assert.ok(opf.includes('href="images/img-1.png"') && opf.includes('media-type="image/png"'))
  assert.ok(opf.includes('media-type="image/jpeg"'))
  assert.ok(opf.includes('<itemref idref="ch1"/>') && opf.includes('<itemref idref="ch3"/>'))
  assert.ok(opf.includes('<dc:language>zh-CN</dc:language>'))
  assert.ok(opf.includes('properties="nav"'), 'nav 必须带 properties="nav"')
})

test('xmlEscape：五个字符都转（`&` 先转，避免二次转义）', () => {
  assert.equal(xmlEscape('&<>"\' &'), '&amp;&lt;&gt;&quot;&apos; &amp;')
})
