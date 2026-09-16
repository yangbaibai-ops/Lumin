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
  const listed = [...src.matchAll(/'( _verify[^']*|_verify[^']*)'/g)].map((m) => m[1])
  assert.ok(listed.length >= 5, `默认清单太少：${listed.length}`)
  for (const f of listed) {
    assert.ok(fs.existsSync(path.join(TOOLS, f)), `run-suites 默认清单里的 ${f} 不存在`)
  }
})
