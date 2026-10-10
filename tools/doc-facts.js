'use strict'
// ─── 文档里那些"会过期"的数字：一处生成、CI 校验（清单 §10「README 的数量账目大面积过期」）──
//
// 为什么要有它：README 写过「主进程 19 文件 / ~4.6k 行」「renderer 86 / ~15.4k」「手工 2900 行」，
// 实测分别已经是 23/5.3k、114/22.7k、4367 —— 而且**没有任何测试会红**。手写数字必然漂，所以：
//   * 数字只在这一个脚本里算；
//   * 落进 README.md 与 tools/README.md 的 `<!-- facts:begin -->` … `<!-- facts:end -->` 之间；
//   * `npm run docs:facts:write` 重算写入，`npm run docs:facts:check` 校验（进 `npm run ci`）。
//
// 口径写死在下面的 `collectFacts()` 里（数的是哪一批文件），免得"文件数"变成各说各话。
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const BEGIN = '<!-- facts:begin（由 tools/doc-facts.js 生成，勿手改）-->'
const END = '<!-- facts:end -->'

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, out)
    else if (filter(e.name)) out.push(p)
  }
  return out
}
const countLines = (files) =>
  files.reduce((n, f) => n + fs.readFileSync(f, 'utf-8').split('\n').length, 0)

function collectFacts() {
  const groups = [
    ['src/main', walk(path.join(ROOT, 'src/main'), (n) => n.endsWith('.ts'))],
    ['src/preload', walk(path.join(ROOT, 'src/preload'), (n) => n.endsWith('.ts'))],
    ['src/shared', walk(path.join(ROOT, 'src/shared'), (n) => n.endsWith('.ts'))],
    ['src/renderer', walk(path.join(ROOT, 'src/renderer'), (n) => /\.(ts|vue)$/.test(n))]
  ].map(([name, files]) => ({ name, files: files.length, lines: countLines(files) }))
  const srcTotal = {
    name: 'src 合计',
    files: groups.reduce((n, g) => n + g.files, 0),
    lines: groups.reduce((n, g) => n + g.lines, 0)
  }

  const toolFiles = walk(path.join(ROOT, 'tools'), (n) => /\.(js|mjs|ps1|md)$/.test(n))
  const testFiles = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs'))
  const manual = fs
    .readdirSync(path.join(ROOT, 'docs/manual'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(ROOT, 'docs/manual', f))
  const docsMd = walk(path.join(ROOT, 'docs'), (n) => n.endsWith('.md'))

  // 套件：数字直接问运行器（分档与清单都只有那一处真相）
  const runner = require(path.join(ROOT, 'tools/run-suites.js'))
  const suites = runner.allSuites()
  const byPrefix = {}
  for (const f of suites) {
    const p = f.split('-')[0]
    byPrefix[p] = (byPrefix[p] ?? 0) + 1
  }
  const byTier = {}
  for (const f of suites) byTier[runner.tierOf(f)] = (byTier[runner.tierOf(f)] ?? 0) + 1

  const expect = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/md/EXPECT.json'), 'utf-8')
  )
  const fixtures = fs.readdirSync(path.join(ROOT, 'tools/fixtures/md')).filter((f) => f.endsWith('.md'))
  const classes = {}
  for (const [k, v] of Object.entries(expect)) {
    if (k.startsWith('$')) continue
    classes[v.class] = (classes[v.class] ?? 0) + 1
  }

  return {
    groups: [...groups, srcTotal],
    tools: { files: toolFiles.length, lines: countLines(toolFiles) },
    tests: testFiles.length,
    manual: { files: manual.length, lines: countLines(manual) },
    docs: { files: docsMd.length, lines: countLines(docsMd) },
    suites: {
      total: suites.length,
      defaultCount: runner.DEFAULT_SUITES.length,
      byPrefix,
      byTier,
      probes: runner.probeSuites().length
    },
    fixtures: { files: fixtures.length, classes },
    version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
  }
}

/**
 * README 里的那块。
 *
 * ⚠️ 对外 README **不展示源码规模**：本项目只发布安装包、源码另行出售，
 * 所以这块渲染成一段**对 GitHub 不可见**的注释锚点，只保留"数字由 doc-facts 统一生成"的秩序；
 * 需要内部账目（各目录文件数/行数）时看 `tools/README.md` 的块（工程文档，本就不对外）。
 */
function renderReadmeBlock() {
  return [
    BEGIN,
    '',
    '<!-- 本项目只发布安装包；源码规模等工程账目不在此展示（见 tools/README.md）。 -->',
    '',
    END
  ].join('\n')
}

/** tools/README.md 里的那块：脚手架与套件的账目 */
function renderToolsBlock(f) {
  const prefix = Object.entries(f.suites.byPrefix)
    .map(([k, v]) => `${k}-* ${v}`)
    .join(' / ')
  const tier = Object.entries(f.suites.byTier)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ')
  return [
    BEGIN,
    '',
    `- \`tools/\` 共 **${f.tools.files} 个文件 / ${f.tools.lines} 行**（\`.js\`/\`.mjs\`/\`.ps1\`/\`.md\`）；`,
    `- 套件文件 **${f.suites.total} 个**（${prefix}），默认矩阵 **${f.suites.defaultCount} 个**，分档：${tier}；`,
    `- 另有 **${f.suites.probes} 个**探针/遗留脚本默认只列不判（\`--probe\` 显式跑）；`,
    `- 单元测试 **${f.tests} 个** \`tests/*.test.mjs\`；Markdown 往返夹具 **${f.fixtures.files} 份**` +
      `（${Object.entries(f.fixtures.classes)
        .map(([k, v]) => `${k} ${v}`)
        .join(' / ')}）；`,
    `- \`docs/manual/\` **${f.manual.files} 份 / ${f.manual.lines} 行**，\`docs/\` 下共 **${f.docs.files} 份** md。`,
    '',
    END
  ].join('\n')
}

const TARGETS = [
  { file: path.join(ROOT, 'README.md'), render: renderReadmeBlock },
  { file: path.join(ROOT, 'tools/README.md'), render: renderToolsBlock }
]

function replaceBlock(text, rendered) {
  const a = text.indexOf(BEGIN)
  const b = text.indexOf(END)
  if (a < 0 || b < 0) throw new Error('找不到 facts 标记块')
  return text.slice(0, a) + rendered + text.slice(b + END.length)
}

function main() {
  const write = process.argv.includes('--write')
  const facts = collectFacts()
  let drift = 0
  for (const t of TARGETS) {
    const text = fs.readFileSync(t.file, 'utf-8')
    const rendered = t.render(facts)
    const next = replaceBlock(text, rendered)
    const rel = path.relative(ROOT, t.file).replace(/\\/g, '/')
    if (next === text) {
      console.log(`OK   ${rel}`)
      continue
    }
    if (write) {
      fs.writeFileSync(t.file, next, 'utf-8')
      console.log(`写入 ${rel}`)
    } else {
      drift += 1
      console.log(`漂移 ${rel}（跑 npm run docs:facts:write 重算）`)
    }
  }
  if (!write && drift) process.exit(1)
}

// 直接跑才执行（tests/docsFacts.test.mjs 要 import 这里的 collectFacts/render* 做对账）
if (require.main === module) main()

module.exports = { collectFacts, renderReadmeBlock, renderToolsBlock, TARGETS, BEGIN, END }
