// 工具链自检：这些坑一旦复发，整个验收体系给出的数字就是错的（而且看不出来）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const TOOLS = path.join(ROOT, 'tools')
const FIXTURES = path.join(TOOLS, 'fixtures', 'md')

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

test('PowerShell 脚本：含非 ASCII 就必须带 UTF-8 BOM', () => {
  // Windows PowerShell 5.1 读**无 BOM** 的 UTF-8 脚本时按 ANSI 解码：
  // 中文注释里的多字节序列会撞出引号 → 直接语法错误（实测：改一次注释，整套验收起不来实例）。
  const files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.ps1'))
  assert.ok(files.length > 0, 'tools 下应该有 .ps1')
  for (const f of files) {
    const buf = fs.readFileSync(path.join(TOOLS, f))
    const ascii = buf.every((b) => b < 0x80)
    if (ascii) continue
    assert.ok(
      buf.subarray(0, 3).equals(BOM),
      `${f} 含非 ASCII 但没有 UTF-8 BOM（PS 5.1 会按 ANSI 解码 → 语法错误）`
    )
  }
})

test('CDP 套件公共骨架导出约定 API', () => {
  const h = require(path.join(TOOLS, 'lib', 'harness.js'))
  for (const name of ['connect', 'settle', 'waitEditor', 'Reporter', 'clickSelector', 'pressKey']) {
    assert.equal(typeof h[name], 'function', `harness 缺少 ${name}`)
  }
  // 结果汇总格式必须机器可读（tools/run-suites.js 靠它出矩阵）
  const r = new h.Reporter()
  r.check('ok', true)
  r.check('bad', false)
  assert.equal(r.failed, 1)
})

test('判级器导出约定 API 与规则清单', () => {
  const m = require(path.join(TOOLS, 'lib', 'md-fidelity.js'))
  for (const name of [
    'classify',
    'normalizeMarkdown',
    'unifiedDiff',
    'worseThan',
    'LEVEL',
    'RULES'
  ]) {
    assert.ok(m[name], `md-fidelity 缺少 ${name}`)
  }
  assert.ok(m.RULES.length >= 15, '规则清单太短')
})

test('夹具库与 EXPECT.json 必须一一对应', () => {
  const expect = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'EXPECT.json'), 'utf-8'))
  const fixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md'))
  assert.ok(fixtures.length >= 25, `夹具太少：${fixtures.length}`)
  for (const f of fixtures) {
    const e = expect[f]
    assert.ok(e, `夹具 ${f} 没有预期（EXPECT.json）`)
    assert.ok(['exact', 'normalized', 'lossy'].includes(e.class), `${f} 的 class 非法：${e.class}`)
    // lossy 必须写清为什么 + 修法：没有 why 的 lossy 等于把缺陷藏进预期里
    if (e.class !== 'exact') {
      assert.ok(typeof e.why === 'string' && e.why.length >= 8, `${f} 非 exact 却没有 why`)
    }
  }
  for (const key of Object.keys(expect)) {
    if (key.startsWith('$')) continue
    assert.ok(fixtures.includes(key), `EXPECT.json 里的 ${key} 没有对应夹具`)
  }
})

test('套件统一入口存在且默认清单里的套件都在', () => {
  const src = fs.readFileSync(path.join(TOOLS, 'run-suites.js'), 'utf-8')
  /**
   * 清单里的**任何**套件文件名都要被这条守到 —— 不只是 `_verify-*`。
   *
   * 原来正则写的是 `_verify[^']*`，于是默认清单里的 6 个 `_regress-*` 与 1 个 `_repro-*`
   * 落在覆盖之外：把它们改名/写错，`run-suites.js` 的 `filter(existsSync)` 会**静默丢弃**，
   * 矩阵照旧全绿而覆盖悄悄变少（与 NOASSERT 想解决的"绿灯什么都证明不了"是同一类问题）。
   */
  const listed = [...src.matchAll(/'(_(?:verify|regress|repro)-[^']*\.js)'/g)].map((m) => m[1])
  assert.ok(listed.length >= 20, `默认清单太少：${listed.length}`)
  const unique = [...new Set(listed)]
  for (const f of unique) {
    assert.ok(fs.existsSync(path.join(TOOLS, f)), `run-suites 清单里的 ${f} 不存在`)
  }
  // 清单里出现过的每一类前缀都要被上面那条正则覆盖到（防止以后又漏一类）
  const prefixes = new Set(unique.map((f) => f.split('-')[0]))
  for (const p of prefixes) {
    assert.match(p, /^_(verify|regress|repro)$/, `清单里出现了未被守护的套件前缀：${p}`)
  }
})

test('套件分档：每个套件恰好落在一档，且 needs-dev 与实测一致', () => {
  /**
   * 分档是"哪一档该在什么时候跑"的**数据**（清单 §10 建议 ③）：`--tier=fast` 靠它挑套件。
   * 这里守住三件事，否则档位会慢慢漂成一个没人信的标签：
   *   ① 每个套件文件都能得到一档（tierOf 有兜底，但档名必须是四个之一）；
   *   ② `TIER_DEV` 与 `needsDevServer()` 的实测**完全一致**（漏登记 = 那档跑不起来）；
   *   ③ `manual` 的两个套件不在 `--all` 的自动清单里（人工介入的不能混进自动矩阵）。
   */
  const m = require(path.join(TOOLS, 'run-suites.js'))
  const files = m.allSuites()
  assert.ok(files.length >= 60, `套件全集太少：${files.length}`)
  const TIERS = new Set(['fast', 'needs-build', 'needs-dev', 'manual'])
  for (const f of files) {
    assert.ok(TIERS.has(m.tierOf(f)), `${f} 落到了未知档位 ${m.tierOf(f)}`)
  }
  for (const f of fs.readdirSync(TOOLS).filter((x) => /^_(verify|regress|repro)-.*\.js$/.test(x))) {
    assert.equal(
      m.needsDevServer(f),
      m.TIER_DEV.has(f),
      `${f} 的 needs-dev 档与实测不符（实测 needsDevServer=${m.needsDevServer(f)}）`
    )
  }
  for (const f of m.MANUAL) {
    assert.ok(!files.includes(f), `manual 档的 ${f} 不该出现在自动矩阵里`)
    assert.equal(m.tierOf(f), 'manual', `${f} 应在 manual 档`)
  }
  // fast 档 = 默认矩阵（两者是同一件事的两面）
  for (const f of m.DEFAULT_SUITES) {
    assert.equal(m.tierOf(f), 'fast', `默认矩阵里的 ${f} 不在 fast 档`)
  }
})

test('探针/遗留脚本被点名登记（不判定，但必须可见）', () => {
  /**
   * 清单 §10 P1：约 15 个"0 断言探针"在冒充 PASS —— 运行器现在把 `total === 0` 记 NOASSERT，
   * 但 `_probe-*` 与 `verify-tiptap.js` **根本不在扫描范围内**，于是连 NOASSERT 都不会被记。
   * 这条守住"它们仍然存在且仍被登记"：名单是数据（probeSuites），每轮矩阵末尾打印出来，
   * `--probe` 可以显式跑（那时照常判定）。
   */
  const m = require(path.join(TOOLS, 'run-suites.js'))
  const probes = m.probeSuites()
  assert.ok(probes.length >= 5, `探针名单太少：${probes.length}（是不是把 _probe-* 删光了？）`)
  for (const f of probes) {
    assert.ok(fs.existsSync(path.join(TOOLS, f)), `probeSuites 里的 ${f} 不存在`)
    assert.ok(!m.allSuites().includes(f), `${f} 不该同时出现在自动矩阵里（那会重复判定）`)
  }
  // 探针文件不能被顺手改名成 _verify-* 而不改这份名单
  const mismatched = fs
    .readdirSync(TOOLS)
    .filter((f) => /^_probe-.*\.js$/.test(f))
    .filter((f) => !probes.includes(f))
  assert.deepEqual(mismatched, [], `这些探针没被 probeSuites 收到：${mismatched.join(', ')}`)
})
