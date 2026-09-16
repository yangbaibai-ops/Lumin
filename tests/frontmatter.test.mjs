// YAML front matter 识别（src/shared/frontmatter.ts）的单测。
//
// 这层决定「打开一份带 front matter 的笔记，保存后元数据还在不在」——判宽了会把
// CommonMark 里合法的「分割线 + 文字 + 分割线」误吃成 YAML（渲染形态整个变样），
// 判窄了则真实笔记的 title/tags 被拆成正文（元数据静默丢失）。所以两边都要有断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFrontmatter, hasFrontmatter } from '../src/shared/frontmatter.ts'

test('标准 front matter：原文原样取出（含分隔符、不含收尾换行）', () => {
  const doc = '---\ntitle: 测试文档\ntags: [a, b]\ndate: 2024-01-01\n---\n\n# 正文标题\n'
  const fm = extractFrontmatter(doc)
  assert.deepEqual(fm, {
    raw: '---\ntitle: 测试文档\ntags: [a, b]\ndate: 2024-01-01\n---',
    nextLine: 5
  })
  // nextLine 就是「块之后第一行」：空行 → 再下一行才是标题
  assert.equal(doc.split('\n')[fm.nextLine], '')
  assert.equal(doc.split('\n')[fm.nextLine + 1], '# 正文标题')
})

test('收尾分隔符写成 ... 也算（YAML 文档结束标记）', () => {
  assert.equal(extractFrontmatter('---\ntitle: x\n...\n\nbody\n')?.raw, '---\ntitle: x\n...')
})

test('不在文档开头就不认（正文里的分割线照旧是分割线）', () => {
  assert.equal(extractFrontmatter('\n---\ntitle: x\n---\n'), null)
  assert.equal(extractFrontmatter('正文\n\n---\ntitle: x\n---\n'), null)
})

test('块内没有 key：按 CommonMark 处理（分割线夹文字），不当 YAML 吃', () => {
  const doc = '---\n就一段文字\n---\n\n后面\n'
  assert.equal(extractFrontmatter(doc), null)
  assert.equal(hasFrontmatter(doc), false)
})

test('没有收尾分隔符就不认（`---` 是主题分割线）', () => {
  assert.equal(extractFrontmatter('---\ntitle: x\n\n正文\n'), null)
})

test('首行不是 `---`（例如 `----` / `--- x`）不认', () => {
  assert.equal(extractFrontmatter('----\ntitle: x\n---\n'), null)
  assert.equal(extractFrontmatter('--- x\ntitle: x\n---\n'), null)
})

test('只有开头与收尾两行（空 front matter）不算 —— 空块没有键，按分割线处理', () => {
  assert.equal(extractFrontmatter('---\n---\n'), null)
})

test('分隔符行尾允许空格；正文里的 `---` 不会被当收尾', () => {
  const doc = '---   \ntitle: x\n---\t\n\n---\n\n正文\n'
  assert.equal(extractFrontmatter(doc)?.raw, '---   \ntitle: x\n---\t')
})

test('只认第一个收尾分隔符：块内的 YAML 多行写法不会被截断', () => {
  const doc = '---\ntitle: x\ntags:\n  - a\n  - b\n---\n\n正文\n'
  assert.equal(extractFrontmatter(doc)?.raw, '---\ntitle: x\ntags:\n  - a\n  - b\n---')
})

test('CRLF 文档也能认（内存里通常已是 LF，但粘贴/外部输入不保证）', () => {
  const fm = extractFrontmatter('---\r\ntitle: x\r\n---\r\n\r\n正文\r\n')
  assert.equal(fm?.raw, '---\r\ntitle: x\r\n---')
})

test('取值是「原文」：注释、空行、缩进、行尾空格一个都不动', () => {
  const raw = '---\n# 注释\n\nversion: "1.0"  \nlist: [1, 2]\n---'
  assert.equal(extractFrontmatter(raw + '\n\n正文\n')?.raw, raw)
})
