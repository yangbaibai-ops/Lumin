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
import { readTextNormalized } from './lib/readTextNormalized.mjs'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
// 行尾归一：Windows CI 用 CRLF 检出，而 doc-facts 渲染的 facts 块是 LF。
// 直接比较会在干净克隆里因为 `\r` 假红（本地 LF 工作区看不出来）。
const README = readTextNormalized(path.join(ROOT, 'README.md'))
const TOOLS_README = readTextNormalized(path.join(ROOT, 'tools', 'README.md'))

test('docs：对外 README 不含 HTML（发布页要求纯 Markdown 可解析）', () => {
  /**
   * 产品决定：本仓库只发布安装包、源码不开源 ⇒ `README.md` 是**给使用者看的发布页**，
   * 要求**纯 Markdown**（不放 `<div align="center">` 这类 HTML，也不放 HTML 注释）。
   * 工程账目（源码规模 / 套件数）一律留在 `tools/README.md` 的 facts 块里（下一条守着）。
   *
   * 历史：这里曾给"四枚徽章用 `<p>` 包住、保证 GitHub 上同一行"留过例外；但 Lumin
   * 自己打开 README 时裸 HTML 会显示成代码块（8ec3b7c 已把徽章改回纯 Markdown），
   * 例外随之取消 —— **任何** HTML 标签都算红。
   */
  assert.ok(!/<!--/.test(README), 'README 里不应出现 HTML 注释')
  const tag = README.match(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>/)
  assert.equal(tag, null, `README 应为纯 Markdown，不应出现 HTML 标签：${tag && tag[0]}`)
})

test('docs：tools/README 的 facts 块与实测一致', () => {
  const facts = require(path.join(ROOT, 'tools', 'doc-facts.js'))
  const a = TOOLS_README.indexOf(facts.BEGIN)
  const b = TOOLS_README.indexOf(facts.END)
  assert.ok(a >= 0 && b > a, 'tools/README.md 里没有 facts 标记块')
  const current = TOOLS_README.slice(a, b + facts.END.length)
  assert.equal(
    current,
    facts.renderToolsBlock(facts.collectFacts()),
    'tools/README.md 的 facts 块过期了 —— 跑 npm run docs:facts:write 重算'
  )
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
    /**
     * 对外 README **不写工程账目**（发布页）；但**既然写了就必须对得上** ——
     * 写错数字的后果是让人去找一个不存在的缺口（README 曾写 `lossy 8`，实测是 0）。
     */
    const m = README.match(new RegExp(`${cls} (\\d+)\\b`))
    if (m) assert.equal(Number(m[1]), n, `README 写了 ${cls} ${m[1]}，实测是 ${cls} ${n}`)
  }
  // 账目本身要有落脚处：工程文档（tools/README.md 的 facts 块由 doc-facts 生成）
  assert.match(
    TOOLS_README,
    new RegExp(`exact ${counts.exact}\\b`),
    'tools/README.md 应记录 exact 计数'
  )
  assert.match(
    TOOLS_README,
    new RegExp(`normalized ${counts.normalized}\\b`),
    'tools/README.md 应记录 normalized 计数'
  )
})

test('docs：package.json 的版本在 CHANGELOG 里有对应标题', () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
  const changelog = readTextNormalized(path.join(ROOT, 'CHANGELOG.md'))
  assert.match(
    changelog,
    new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm'),
    `CHANGELOG 里没有 \`## [${version}]\` 标题：发版时无法回答"${version} 里有什么"`
  )
})

test('docs：CHANGELOG 的版本段都带日期（[Unreleased] 除外）', () => {
  const changelog = readTextNormalized(path.join(ROOT, 'CHANGELOG.md'))
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

test('docs：组件清单文档存在、被索引，且它点名的组件文件都在（审计 §8 P2）', () => {
  /**
   * 审计 §8 P2「没有设计令牌 / 组件清单文档」：令牌文档（`docs/design-tokens.md`）是生成式 + 有门禁的，
   * 但"哪个控件必须用哪个组件"此前没有任何可查的落点 —— 于是同一个开关攒出三种实现。
   * 这条守住：① 文档在；② 被手册目录索引到（不然没人会翻到）；
   * ③ 它**点名的每一个路径都存在**（文档里的路径是最容易烂的东西）。
   */
  const rel = 'docs/manual/09-components.md'
  const file = path.join(ROOT, rel)
  assert.ok(fs.existsSync(file), `${rel} 必须存在（组件清单：开关/分段/滑杆/浮层/播报）`)
  const doc = fs.readFileSync(file, 'utf-8')
  const index = fs.readFileSync(path.join(ROOT, 'docs', 'wysiwyg-manual.md'), 'utf-8')
  assert.match(index, /manual\/09-components\.md/, '手册目录里没有索引到组件清单')
  // 必写的几类控件都要在这份清单里出现（否则它退化成一个空壳）
  for (const key of ['SettingSwitch', 'SegmentedControl', '.range', 'aria-modal', 'aria-live']) {
    assert.ok(doc.includes(key), `组件清单里应当写到 ${key}`)
  }
  // 文档里点名的仓库路径必须存在（`src/...` / `docs/...`；URL 与代码块里的通配已排除）
  const refs = [...doc.matchAll(/`((?:src|docs)\/[\w./-]+)`/g)].map((m) => m[1])
  assert.ok(refs.length >= 5, `组件清单只引用了 ${refs.length} 个路径，太少了`)
  for (const r of refs) {
    if (r.includes('*')) continue
    assert.ok(fs.existsSync(path.join(ROOT, r)), `组件清单引用的路径不存在：${r}`)
  }
})

test('docs：工程手册的套件数字与 run-suites.js 实测一致（审计 §10 P1）', () => {
  /**
   * `docs/manual/06-engineering.md` 的 §6 写过「79 个套件文件 / 默认矩阵 43 条」，
   * 而实测是另一回事（套件长了一轮又一轮）。数字漂了的后果与 README 那条一样：
   * 有人会照着过期数字判断"覆盖到底够不够"。
   *
   * 这里不生成文档（手册是散文），只**对账**：手册里那三个数字必须等于 run-suites.js 的实测。
   * 改套件规模时要么同步手册，要么把话说成不带数字（后者请顺手删掉这条断言里的对应行）。
   */
  const m = require(path.join(ROOT, 'tools', 'run-suites.js'))
  const manual = fs.readFileSync(path.join(ROOT, 'docs', 'manual', '06-engineering.md'), 'utf-8')
  const files = fs
    .readdirSync(path.join(ROOT, 'tools'))
    .filter((f) => /^_(verify|regress|repro)-.*\.js$/.test(f)).length
  const all = m.allSuites().length
  const def = m.DEFAULT_SUITES.length
  assert.ok(files > 0 && all > 0 && def > 0, '实测数字异常，检查 run-suites.js 的导出')
  assert.match(
    manual,
    new RegExp(`\\*\\*${files} 个套件文件\\*\\*`),
    `手册应写着 ${files} 个套件文件`
  )
  assert.match(manual, new RegExp(`收录 ${all}`), `手册应写着 --all 收录 ${all}`)
  assert.match(manual, new RegExp(`默认矩阵 \\*\\*${def} 条\\*\\*`), `手册应写着默认矩阵 ${def} 条`)
})
