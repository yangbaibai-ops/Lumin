// 文档里的数字必须对得上（清单 §10「README 的数量账目大面积过期（且没有任何测试对账）」）。
//
// 这条测试只做"对账"这一件事，数字本身由 `tools/doc-facts.js` 一处生成：
//   * README / tools/README 的 `facts` 块 == 现在实测出来的事实（改了代码不同步 → 红）；
//   * README「已知限制」表里的 EXPECT 分类计数 == `tools/fixtures/md/EXPECT.json` 实测；
//   * `package.json` 的 version 必须在 CHANGELOG 里有对应标题（发版时能回答"1.0.0 里有什么"）。
//
// 为什么值得单开一条：这三处都是**人写的、会漂的、以前没人看的**数字。
// 漂了的后果不是"不好看"，而是会让人照着一个不存在的缺口去修（README 曾写 `lossy 8`，
// 实测是 0 —— 会有人去找那 8 个不存在的已知限制）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8')
const TOOLS_README = fs.readFileSync(path.join(ROOT, 'tools', 'README.md'), 'utf-8')

test('docs：README 与 tools/README 的 facts 块与实测一致', () => {
  const facts = require(path.join(ROOT, 'tools', 'doc-facts.js'))
  const check = (file, text, rendered) => {
    const a = text.indexOf(facts.BEGIN)
    const b = text.indexOf(facts.END)
    assert.ok(a >= 0 && b > a, `${file} 里没有 facts 标记块`)
    const current = text.slice(a, b + facts.END.length)
    assert.equal(current, rendered, `${file} 的 facts 块过期了 —— 跑 npm run docs:facts:write 重算`)
  }
  const f = facts.collectFacts()
  check('README.md', README, facts.renderReadmeBlock(f))
  check('tools/README.md', TOOLS_README, facts.renderToolsBlock(f))
})

test('docs：README 的 EXPECT 分类计数与 EXPECT.json 实测一致', () => {
  const expectPath = path.join(ROOT, 'tools', 'fixtures', 'md', 'EXPECT.json')
  const expect = JSON.parse(fs.readFileSync(expectPath, 'utf-8'))
  const counts = { exact: 0, normalized: 0, lossy: 0 }
  for (const [k, v] of Object.entries(expect)) {
    if (k.startsWith('$')) continue
    assert.ok(v.class in counts, `${k} 的 class 非法：${v.class}`)
    counts[v.class] += 1
  }
  for (const [cls, n] of Object.entries(counts)) {
    assert.match(
      README,
      new RegExp(`${cls} ${n}\\b`),
      `README 里应写着 \`${cls} ${n}\`（EXPECT.json 实测），否则会让人去找不存在的缺口`
    )
  }
})

test('docs：package.json 的版本在 CHANGELOG 里有对应标题', () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8')
  assert.match(
    changelog,
    new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm'),
    `CHANGELOG 里没有 \`## [${version}]\` 标题：发版时无法回答"${version} 里有什么"`
  )
})

test('docs：CHANGELOG 的版本段都带日期（[Unreleased] 除外）', () => {
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8')
  const versions = [...changelog.matchAll(/^## \[([^\]]+)\](.*)$/gm)].map((m) => ({
    name: m[1],
    tail: m[2]
  }))
  assert.ok(versions.length >= 2, `CHANGELOG 里至少该有 [Unreleased] 与一个版本段`)
  for (const v of versions) {
    if (v.name === 'Unreleased') continue
    // 带日期才叫"发布的版本"；`[Unreleased · 描述]` 这种历史写法允许保留
    if (v.name.startsWith('Unreleased')) continue
    assert.match(v.tail, /- \d{4}-\d{2}-\d{2}/, `版本段 \`${v.name}\` 缺少日期`)
  }
})
