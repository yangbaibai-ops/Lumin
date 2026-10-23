'use strict'
// ─── 设计令牌清单：一处生成、CI 校验（审计 §8 P2「没有设计令牌 / 组件清单文档」）────────
//
// 为什么要有它：主题令牌（`--paper` / `--ink-2` / `--accent` …）是**颜色与层级唯一的真相**，
// 但它们此前只存在于 `src/renderer/src/assets/theme.css` 与 `sidebar.css` 里 ——
// 想知道"有哪些令牌、三个主题各自是什么值、某个令牌到底有没有定义"，只能全文搜。
// 手写一份清单必然漂（README 的数字就是这么烂掉的，见 tools/doc-facts.js 的说明），所以：
//   * 令牌表只在这里从 CSS **抽**出来，不手写；
//   * 落进 `docs/design-tokens.md` 的 `<!-- tokens:begin -->` … `<!-- tokens:end -->`；
//   * `npm run docs:tokens:write` 重算，`npm run docs:tokens:check` 校验（进 `npm run ci`），
//     `tests/designTokens.test.mjs` 再钉一层（并检查同一声明块里没有重复令牌）。
//
// 口径：只认**声明块内**的 `--name: value;`（`var(--x)` 引用也能看出来），
// 注释里的示例不算（先剥注释）。值里的换行折成空格，表格里保持一行一项。
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const BEGIN = '<!-- tokens:begin（由 tools/doc-tokens.js 生成，勿手改）-->'
const END = '<!-- tokens:end -->'
const DOC = path.join(ROOT, 'docs/design-tokens.md')

/** 读文本时统一行尾：CRLF 检出 + LF 生成块不归一化，`--check` 会在干净克隆里假红 */
const { readLf } = require('./lib/text-eol.js')

/** 令牌的定义处：只扫这两个文件（其余 CSS 都是**消费**令牌，不是定义） */
const SOURCES = ['src/renderer/src/assets/theme.css', 'src/renderer/src/assets/sidebar.css']

/** 去掉块注释（令牌表不该把注释里的示例当成定义） */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 从一份 CSS 里抽出 `选择器 → [{name, value, line}]`。
 * 解析很朴素但够用：**花括号配平**地扫，`{` 之前的那段文本就是这个块的声明上下文
 * （`.theme-dark` / `:root` / `.theme-light .foo` 都能原样显示），块内的 `--x:` 行即令牌。
 */
function collectFromCss(relPath) {
  const abs = path.join(ROOT, relPath)
  const raw = stripComments(fs.readFileSync(abs, 'utf-8'))
  const blocks = []
  let i = 0
  let depth = 0
  let ctx = ''
  let current = null
  let line = 1
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\n') line += 1
    if (ch === '{') {
      depth += 1
      if (depth === 1) {
        current = { selector: ctx.trim().replace(/\s+/g, ' '), line, tokens: [] }
        blocks.push(current)
      }
      ctx = ''
      i += 1
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0) current = null
      ctx = ''
      i += 1
      continue
    }
    if (depth >= 1 && current) {
      // 块内：找 `--name: value;`（值允许折行，到 `;` 为止）
      const m = /^(--[a-z0-9-]+)\s*:\s*([^;]*);/i.exec(raw.slice(i))
      if (m && (i === 0 || /[\s;{]/.test(raw[i - 1]))) {
        current.tokens.push({
          name: m[1],
          value: m[2].replace(/\s+/g, ' ').trim(),
          line
        })
        line += (m[0].match(/\n/g) ?? []).length
        i += m[0].length
        continue
      }
    }
    ctx += ch
    i += 1
  }
  return blocks.filter((b) => b.tokens.length > 0)
}

function collectTokens() {
  return SOURCES.map((rel) => ({ file: rel, blocks: collectFromCss(rel) }))
}

function renderTokensBlock(sources = collectTokens()) {
  const total = sources.reduce((n, s) => n + s.blocks.reduce((m, b) => m + b.tokens.length, 0), 0)
  const lines = [
    BEGIN,
    '',
    '| 口径 | 值 |',
    '|---|---|',
    `| 定义令牌的文件 | ${sources.map((s) => '`' + s.file + '`').join(' / ')} |`,
    `| 声明块 | ${sources.reduce((n, s) => n + s.blocks.length, 0)} 个 |`,
    `| 令牌总数 | ${total} |`,
    `| 重复定义（同一声明块内） | ${sources.reduce(
      (n, s) =>
        n +
        s.blocks.reduce((m, b) => {
          const seen = new Set()
          return (
            m + b.tokens.filter((t) => (seen.has(t.name) ? true : (seen.add(t.name), false))).length
          )
        }, 0),
      0
    )} |`,
    '',
    '> 这张表由 `node tools/doc-tokens.js --write` 生成，`npm run docs:tokens:check` 校验；',
    '> 消费令牌的写法是 `var(--name)`，**不要在组件里写死颜色**（§8「token 未覆盖的硬编码色」）。'
  ]
  for (const src of sources) {
    lines.push('', `### ${src.file}`, '')
    for (const b of src.blocks) {
      lines.push(
        `**${b.selector}**（第 ${b.line} 行起，${b.tokens.length} 个）`,
        '',
        '| 令牌 | 值 |',
        '|---|---|'
      )
      for (const t of b.tokens) lines.push(`| \`${t.name}\` | \`${t.value}\` |`)
      lines.push('')
    }
  }
  lines.push(END)
  return lines.join('\n')
}

/** 把块写进文件（文件不存在时带一段说明性前言） */
function writeInto(text, rendered) {
  const a = text.indexOf(BEGIN)
  const b = text.indexOf(END)
  if (a >= 0 && b > a) return text.slice(0, a) + rendered + text.slice(b + END.length)
  return text.trimEnd() + '\n\n' + rendered + '\n'
}

const HEADER = `# 设计令牌（Design tokens）

本文件里的令牌表**由脚本生成**，不要手改：改令牌请改
\`src/renderer/src/assets/theme.css\`（或 \`sidebar.css\`），然后跑

\`\`\`powershell
npm run docs:tokens:write
\`\`\`

- 令牌是**颜色与层级唯一的真相**：组件里写 \`var(--name)\`，不要写死色值。
- 三个主题（light / dark / sepia）各自的取值都能在下面看到；
  对比度门禁见 \`tests/colorRelations.test.mjs\` 与 §8 的对比度表。
- \`npm run docs:tokens:check\` 在 CI 里守着"表与 CSS 一致"。

`

function main() {
  const write = process.argv.includes('--write')
  const rendered = renderTokensBlock()
  const existing = fs.existsSync(DOC) ? readLf(DOC) : HEADER + renderTokensBlock() + '\n'
  const body = write ? writeInto(existing, rendered) : existing
  if (write) {
    fs.writeFileSync(DOC, body.endsWith('\n') ? body : body + '\n', 'utf-8')
    console.log(`写入 ${path.relative(ROOT, DOC)}`)
    return 0
  }
  const a = body.indexOf(BEGIN)
  const b = body.indexOf(END)
  if (a < 0 || b <= a) {
    console.log(`FAIL: ${path.relative(ROOT, DOC)} 里没有令牌块 —— 跑 npm run docs:tokens:write`)
    return 1
  }
  const current = body.slice(a, b + END.length)
  if (current !== rendered) {
    console.log('FAIL: 设计令牌表与 CSS 不一致 —— 跑 npm run docs:tokens:write 重算')
    return 1
  }
  console.log(`tokens up to date (${SOURCES.length} files)`)
  return 0
}

module.exports = { BEGIN, END, DOC, SOURCES, collectTokens, renderTokensBlock, writeInto }

if (require.main === module) process.exit(main())
