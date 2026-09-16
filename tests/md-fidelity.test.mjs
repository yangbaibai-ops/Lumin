// ─── 判级器自身的单测（不依赖 Electron）────────────────────────────────────────
//
// 判级器是「Markdown 往返保真」套件的裁判，裁判自己错了整个套件就没意义，所以：
//   1. 每条规范化规则都要有一个「同义改写的两个写法判 normalized」的用例；
//   2. 每条规则都不能把**真差异**吃掉（负例：内容不同必须判 lossy）；
//   3. 规范化必须**幂等**：normalize(normalize(x)) === normalize(x)，否则套件会飘；
//   4. 对全部夹具跑一遍幂等 + 自反（classify(x, x) === exact）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { classify, normalizeMarkdown, worseThan, RULES } = require('../tools/lib/md-fidelity.js')

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, '..', 'tools', 'fixtures', 'md')

const level = (a, b) => classify(a, b).level

test('RULES 是文档化的规则清单', () => {
  assert.ok(RULES.length >= 15, `规则太少：${RULES.length}`)
  assert.ok(RULES.every((r) => typeof r === 'string' && r.length > 0))
})

test('自反：同一份文本判 exact', () => {
  assert.equal(level('# 标题\n\n正文\n', '# 标题\n\n正文\n'), 'exact')
})

test('同义改写判 normalized，真差异判 lossy', () => {
  // 无序列表标记
  assert.equal(level('- a\n- b\n', '* a\n+ b\n'), 'normalized')
  // 有序列表 ) → .
  assert.equal(level('1) a\n', '1. a\n'), 'normalized')
  // 有序列表编号按位置重算（规则 19）：同一个列表里编号只是装饰
  assert.equal(level('1. a\n2. b\n\n5. c\n6. d\n', '1. a\n\n2. b\n\n3. c\n\n4. d\n'), 'normalized')
  // 但列表**首项**编号有语义（<ol start>）：从 5 开始的列表不能与从 1 开始的混为一谈
  assert.equal(level('5. a\n6. b\n', '1. a\n2. b\n'), 'lossy')
  assert.equal(level('5. a\n6. b\n', '5. a\n6. b\n'), 'exact')
  // 围栏 ~~~ → ```
  assert.equal(level('~~~js\nlet a = 1\n~~~\n', '```js\nlet a = 1\n```\n'), 'normalized')
  // Setext → ATX
  assert.equal(level('标题\n===\n', '# 标题\n'), 'normalized')
  // 缩进代码 → 无 info 围栏
  assert.equal(level('    let a = 1\n', '```\nlet a = 1\n```\n'), 'normalized')
  // 硬换行的两种写法
  assert.equal(level('a  \nb\n', 'a\\\nb\n'), 'normalized')
  // HTML 实体
  assert.equal(level('a &amp; b\n', 'a & b\n'), 'normalized')
  // 引用式链接展开
  assert.equal(level('[a][r]\n\n[r]: https://x\n', '[a](https://x)\n'), 'normalized')
  // 段内软换行 ≡ 空格
  assert.equal(level('一行\n二行\n', '一行 二行\n'), 'normalized')
  // 连续空行压缩 + 文末补换行
  assert.equal(level('a\n\n\n\nb', 'a\n\nb\n'), 'normalized')
  // 强调标记下划线 → 星号
  assert.equal(level('__粗__ 与 _斜_\n', '**粗** 与 *斜*\n'), 'normalized')
  // 表格单元格空白
  assert.equal(
    level('|a|b|\n|-|-:|\n|1|2|\n', '| a | b |\n| --- | ---: |\n| 1 | 2 |\n'),
    'normalized'
  )

  // ── 负例：这些必须判 lossy ──
  assert.equal(level('# 标题\n', '# 另一个标题\n'), 'lossy', '文字变了不能被规则吃掉')
  assert.equal(level('**粗**\n', '*粗*\n'), 'lossy', '加粗变斜体是语义变化')
  assert.equal(level('- a\n- b\n', '- a\n'), 'lossy', '少了一个列表项')
  assert.equal(
    level('| a | b |\n| --- | --- |\n| 1 | 2 |\n', '| a | b |\n| --- | --- |\n| 1 | 3 |\n'),
    'lossy'
  )
  assert.equal(level('a\n\nb\n', 'a\nb\n'), 'lossy', '段落合并是结构变化')
  assert.equal(level('```js\nlet a = 1\n```\n', '```\nlet a = 1\n```\n'), 'lossy', '语言丢了')
})

test('围栏内容原样：代码块里的写法差异不能被规范化掩盖', () => {
  assert.equal(level('```\n* a\n```\n', '```\n- a\n```\n'), 'lossy')
  assert.equal(level('```\na   \n```\n', '```\na\n```\n'), 'lossy')
  assert.equal(level('```\n\n\n\n```\n', '```\n\n```\n'), 'lossy')
})

test('行内代码内容原样', () => {
  assert.equal(level('`a * b`\n', '`a - b`\n'), 'lossy')
  assert.equal(level('`__x__`\n', '`**x**`\n'), 'lossy')
})

test('词内下划线不是强调标记', () => {
  assert.equal(level('snake_case_word\n', 'snake_case_word\n'), 'exact')
  assert.equal(level('snake_case_word\n', 'snake*case*word\n'), 'lossy')
})

test('单行块不吸收下一行（标题/分割线/围栏/表格）', () => {
  assert.equal(level('# 标题\n正文\n', '# 标题 正文\n'), 'lossy')
  assert.equal(level('---\n正文\n', '--- 正文\n'), 'lossy')
})

test('HTML 实体还原（命名 / 十进制 / 十六进制）', () => {
  assert.equal(level('a &amp; b\n', 'a & b\n'), 'normalized')
  assert.equal(level('a &lt;b&gt;\n', 'a <b>\n'), 'normalized')
  assert.equal(level('&copy; &nbsp; 结束\n', '© \u00a0 结束\n'), 'normalized')
  assert.equal(level('&#169; &#x2603;\n', '© ☃\n'), 'normalized')
  // 不认识的实体不动，且不能被当成「已还原」
  assert.equal(level('&notanentity;\n', '&notanentity;\n'), 'exact')
})

test('链接目标的百分号编码视为同一种写法', () => {
  assert.equal(level('[a](https://x/%E4%B8%AD%E6%96%87)\n', '[a](https://x/中文)\n'), 'normalized')
  assert.equal(
    level('[a](https://x/a%2Fb)\n', '[a](https://x/a/b)\n'),
    'lossy',
    '%2F 是保留字符，不能当等义'
  )
})

test('裸 URL 与自动链接尖括号等价', () => {
  assert.equal(level('见 https://x.example/a\n', '见 <https://x.example/a>\n'), 'normalized')
})

test('Setext 下划线与分割线的歧义按 CommonMark 判定', () => {
  // 前面是段落文本 → Setext 标题
  assert.equal(level('标题\n---\n', '## 标题\n'), 'normalized')
  assert.equal(level('标题\n===\n', '# 标题\n'), 'normalized')
  // 前面是空行/块边界 → 分割线，保持分割线
  assert.equal(level('a\n\n---\n', 'a\n\n---\n'), 'exact')
  assert.equal(level('---\n\na\n', '---\n\na\n'), 'exact')
  assert.equal(level('---\n', '## \n'), 'lossy', '空文档开头的 --- 不是标题')
})

test('$$ 块级公式：单行与多行写法归一', () => {
  assert.equal(level('$$ x = 1 $$\n', '$$\nx = 1\n$$\n'), 'normalized')
  assert.equal(level('$$\nx = 1\n$$\n', '$$\n x = 1 \n$$\n'), 'normalized')
  assert.equal(level('$$ x = 1 $$\n', '$$\nx = 2\n$$\n'), 'lossy')
})

test('缩进代码块的尾随空行不属于代码块', () => {
  assert.equal(level('    代码\n\n正文\n', '```\n代码\n```\n\n正文\n'), 'normalized')
  assert.equal(
    level('    代码\n\n正文\n', '```\n代码\n```\n正文\n'),
    'lossy',
    '少一个空行，正文会并进代码块'
  )
})

test('围栏长度：内容里有 ``` 时不能用三个反引号', () => {
  assert.equal(level('````\n```\n````\n', '````\n```\n````\n'), 'exact')
  assert.equal(
    level('```\nplain\n```\n', '````\nplain\n````\n'),
    'normalized',
    '更长的围栏是等义的'
  )
  assert.equal(
    level('````\n```\n````\n', '```\n```\n```\n'),
    'lossy',
    '内容损坏：围栏被内容提前闭合'
  )
})

test('围栏内的成对反引号与新行不能被「软换行合并」吃掉', () => {
  // 这条是给一个真实 bug 立的规矩：代码块里的换行塌成空格属于内容损坏
  assert.equal(
    level('```js\nlet a = `x`\nlet b = 2\n```\n', '```js\nlet a = `x` let b = 2\n```\n'),
    'lossy'
  )
})

test('非必要转义：\\\\ 与 \\ 等价', () => {
  assert.equal(level('路径 C:\\temp\n', '路径 C:\\\\temp\n'), 'normalized')
  // 主动转义（\* 表示字面星号）不能被当成等价
  assert.equal(level('\\*字面星号\\*\n', '*斜体*\n'), 'lossy')
})

test('相邻列表之间的空行：标记不同无义，标记相同有义', () => {
  assert.equal(level('- a\n\n* b\n', '- a\n* b\n'), 'normalized', '不同标记本身就分开两个列表')
  assert.equal(level('- a\n\n- b\n', '- a\n- b\n'), 'lossy', '同标记的空行会让列表变松散')
  assert.equal(level('- a\n\n- b\n', '- a\n\n- b\n'), 'exact')
})

test('规范化幂等：normalize(normalize(x)) === normalize(x)', () => {
  const samples = [
    '- a\n  - b\n\n* c\n',
    '~~~js\nlet a = 1\n~~~\n',
    '标题\n===\n\n正文\n',
    '    indented\n\n段落\n',
    'a  \nb\n\nc\\\nd\n',
    '|a|b|\n|-|:-:|\n|1|2|\n',
    '[a][r]\n\n[r]: https://x\n',
    '__粗__ 与 _斜_ 与 snake_case\n',
    '> 引用\n> - 列表\n',
    '```\n`{3}\n```\n'
  ]
  for (const s of samples) {
    const once = normalizeMarkdown(s)
    assert.equal(normalizeMarkdown(once), once, `不幂等：${JSON.stringify(s)}`)
  }
})

test('全部夹具：幂等 + 自反 exact', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md'))
  assert.ok(files.length >= 20, `夹具太少：${files.length}`)
  for (const f of files) {
    const md = fs.readFileSync(path.join(FIXTURES, f), 'utf-8')
    const once = normalizeMarkdown(md)
    assert.equal(normalizeMarkdown(once), once, `夹具不幂等：${f}`)
    assert.equal(level(md, md), 'exact', `夹具不自反：${f}`)
  }
})

test('worseThan 的等级序', () => {
  assert.equal(worseThan('lossy', 'exact'), true)
  assert.equal(worseThan('normalized', 'exact'), true)
  assert.equal(worseThan('lossy', 'normalized'), true)
  assert.equal(worseThan('exact', 'exact'), false)
  assert.equal(worseThan('normalized', 'normalized'), false)
  assert.equal(worseThan('exact', 'normalized'), false, '比预期更好不算回归')
})
