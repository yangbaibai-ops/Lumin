// 文档文本规则（src/shared/documentText.ts）的单测。
// 这三条规则看着琐碎，但直接决定「打开→保存文件会不会变」，所以钉死在这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  withFinalNewline,
  codeFenceFor,
  escapeMarkerOnlyLines,
  normalizeForDirtyCompare,
  sameDocumentText
} from '../src/shared/documentText.ts'

test('withFinalNewline：非空文档以且仅以一个换行结尾', () => {
  assert.equal(withFinalNewline('a'), 'a\n')
  assert.equal(withFinalNewline('a\n'), 'a\n')
  assert.equal(withFinalNewline('a\n\n\n'), 'a\n')
  assert.equal(withFinalNewline('a\nb'), 'a\nb\n')
  assert.equal(withFinalNewline('\n'), '\n')
})

test('withFinalNewline：空文档保持空（空白新文档不该被写成一个换行）', () => {
  assert.equal(withFinalNewline(''), '')
})

test('withFinalNewline 幂等', () => {
  for (const s of ['', 'a', 'a\n', 'a\n\n', '\n\n', '标题\n\n正文']) {
    assert.equal(withFinalNewline(withFinalNewline(s)), withFinalNewline(s), JSON.stringify(s))
  }
})

test('codeFenceFor：围栏必须比内容里最长的反引号串更长', () => {
  assert.equal(codeFenceFor('plain code'), '```')
  assert.equal(codeFenceFor('a ` b'), '```')
  assert.equal(codeFenceFor('a\n```\nb'), '````')
  assert.equal(codeFenceFor('`````'), '``````')
  assert.equal(codeFenceFor('~~~~'), '```', '波浪线内容不需要加长反引号围栏')
})

// ─── 脏判定归一化（用户报障：只切观看模式就出现"未保存"小圆点）───────────────
test('normalizeForDirtyCompare：行尾统一 LF、去掉末尾空行；中间内容不动', () => {
  assert.equal(normalizeForDirtyCompare('a\r\nb\r\n'), 'a\nb')
  assert.equal(normalizeForDirtyCompare('a\n\n'), 'a')
  assert.equal(normalizeForDirtyCompare('a\n\nb\n'), 'a\n\nb', '中间空行是内容，必须保留')
  assert.equal(normalizeForDirtyCompare('  a  '), '  a  ', '行内/行尾空格保留')
  assert.equal(normalizeForDirtyCompare(''), '')
})

test('★ sameDocumentText：只差尾随换行/CRLF 不算修改；真的改字才算', () => {
  // 打开一篇末尾没有换行的文件后，序列化会补一个 \n —— 这不是用户修改
  assert.equal(sameDocumentText('# 标题\n\n正文\n', '# 标题\n\n正文'), true)
  assert.equal(sameDocumentText('# 标题\n\n正文\n\n', '# 标题\n\n正文'), true)
  assert.equal(sameDocumentText('a\r\nb\r\n', 'a\nb'), true)
  // 真实编辑必须判为不同（反向用例）
  assert.equal(sameDocumentText('# 标题\n\n正文 X\n', '# 标题\n\n正文'), false)
  assert.equal(sameDocumentText('a\n\nb', 'a\nb'), false, '中间空行不能被归一化吃掉')
  // 模式切换前后内容一致（只差尾随换行）⇒ 干净
  assert.equal(sameDocumentText(withFinalNewline('第一段\n\n- 列表'), '第一段\n\n- 列表'), true)
})

// ─── escapeMarkerOnlyLines：整行标记字符逐字符转义 ───────────────────────────
// 不转义的后果很具体：空光标点「加粗」得到的 `****` 会被 CommonMark 当成分割线，
// 存盘重开后段落变成 `---`（内容被静默改写）；`~~~~` 更狠 —— 它开启代码围栏。
test('escapeMarkerOnlyLines：整行标记字符逐字符转义（分割线/围栏的三种开头）', () => {
  assert.equal(escapeMarkerOnlyLines('****'), '\\*\\*\\*\\*')
  assert.equal(escapeMarkerOnlyLines('~~~~'), '\\~\\~\\~\\~')
  assert.equal(escapeMarkerOnlyLines('___'), '\\_\\_\\_')
  assert.equal(escapeMarkerOnlyLines('***'), '\\*\\*\\*')
  assert.equal(escapeMarkerOnlyLines('**'), '\\*\\*')
  assert.equal(escapeMarkerOnlyLines('*'), '\\*')
  assert.equal(escapeMarkerOnlyLines('~~~~\n****'), '\\~\\~\\~\\~\n\\*\\*\\*\\*')
})

test('escapeMarkerOnlyLines：不是「整行标记」的一律不动', () => {
  assert.equal(escapeMarkerOnlyLines(''), '')
  assert.equal(escapeMarkerOnlyLines('**加粗**'), '**加粗**', '有正文内容')
  assert.equal(escapeMarkerOnlyLines('****x****'), '****x****', '有正文内容')
  assert.equal(escapeMarkerOnlyLines('---'), '---', '横线不在标记集合里（另有分割线规则）')
  assert.equal(escapeMarkerOnlyLines('- - -'), '- - -')
  assert.equal(escapeMarkerOnlyLines('> ****'), '> ****', '引用前缀')
  assert.equal(escapeMarkerOnlyLines('| ** |'), '| ** |', '表格单元格')
  assert.equal(escapeMarkerOnlyLines('**** 后面有字'), '**** 后面有字')
  assert.equal(escapeMarkerOnlyLines('\\*\\*'), '\\*\\*', '已经转义过的不重复加反斜杠')
})

test('escapeMarkerOnlyLines：缩进行与行尾空白', () => {
  assert.equal(escapeMarkerOnlyLines('    ****'), '    ****', '缩进行（代码块内容）按字面理解')
  assert.equal(escapeMarkerOnlyLines('\t****'), '\t****')
  assert.equal(escapeMarkerOnlyLines('****  '), '\\*\\*\\*\\*  ', '行尾空白保留')
})

test('escapeMarkerOnlyLines：代码围栏及其内部内容一律不动（围栏也是三个以上反引号）', () => {
  const doc = ['# 标题', '', '```js', '****', '~~~', '```', '', '````', '`', '````', ''].join('\n')
  assert.equal(escapeMarkerOnlyLines(doc), doc, '围栏行与围栏里的内容都不许转义')
  // 未闭合的围栏同样按「仍在围栏内」处理（宁可不动）
  const open = ['```', '****'].join('\n')
  assert.equal(escapeMarkerOnlyLines(open), open)
  // 两个反引号的「空行内代码」不是围栏 → 照常转义
  assert.equal(escapeMarkerOnlyLines('``'), '\\`\\`')
  assert.equal(escapeMarkerOnlyLines('```js'), '```js', '带 info 的围栏行不动')
  // 波浪线整行是**正文**（空段落点删除线得到的 `~~~~`）、不是围栏：本仓库的序列化器只写反引号围栏
  assert.equal(escapeMarkerOnlyLines('~~~~'), '\\~\\~\\~\\~')
  // 代码块内容里出现「```js」这种行时不能当成闭合（闭合围栏后面只能有空白）
  const tricky = ['```', '```js', '****', '```'].join('\n')
  assert.equal(escapeMarkerOnlyLines(tricky), tricky, '围栏内的 ```js 与 **** 都是代码内容')
  // 长围栏（内容含 ``` 时序列化器会自动加长）：短的三反引号行不闭合它
  const longFence = ['````', '```', '****', '````'].join('\n')
  assert.equal(escapeMarkerOnlyLines(longFence), longFence)
})

test('escapeMarkerOnlyLines：protect 里的行（原样写回的 HTML/公式块）一个字节都不动', () => {
  const html = ['<pre>', '****', '</pre>'].join('\n')
  assert.equal(
    escapeMarkerOnlyLines(html, ['****']),
    html,
    'HTML 块里的 `****` 行属于用户原文，不许加反斜杠'
  )
  // 不保护时要转义（说明 protect 确实是那条判据）
  assert.equal(escapeMarkerOnlyLines(html), '<pre>\n\\*\\*\\*\\*\n</pre>')
  // 其余行照常处理
  assert.equal(escapeMarkerOnlyLines('****\n~~~~', ['~~~~']), '\\*\\*\\*\\*\n~~~~')
})

test('escapeMarkerOnlyLines：幂等（转义后的行不再是纯标记行）', () => {
  for (const s of ['****', '~~~~', '***', '*', '**加粗**', '****  ']) {
    const once = escapeMarkerOnlyLines(s)
    assert.equal(escapeMarkerOnlyLines(once), once, JSON.stringify(s))
  }
})
