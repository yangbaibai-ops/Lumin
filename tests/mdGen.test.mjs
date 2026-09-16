// 生成式语料库（tools/lib/md-gen.js）的单测：钉住「生成器本身可信」。
//
// 为什么生成器也要测：整套 L3（生成式语料往返）的可信度全押在它身上 ——
// 如果生成器不确定（同种子两次不一样）、覆盖不到某类构造、或者哨兵词漏埋，
// 那么「200 篇全过」这个数字就是假的。所以这里钉四件事：
//   确定性 / 追加稳定 / 构造全覆盖 / 结构声明自洽（含最坏随机源不抛异常）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  generateCorpus,
  rngFor,
  BLOCKS,
  INLINE,
  MUTATIONS,
  MUTATION_IDS,
  emptyStruct
} = require('../tools/lib/md-gen.js')

const STUB = () => 'ZQ0X0'

test('同种子两次生成逐字相同（失败才能复现）', () => {
  const a = generateCorpus({ seed: 12345, count: 25 })
  const b = generateCorpus({ seed: 12345, count: 25 })
  assert.deepEqual(
    a.map((d) => d.md),
    b.map((d) => d.md)
  )
  const c = generateCorpus({ seed: 54321, count: 25 })
  assert.notDeepEqual(
    a.map((d) => d.md),
    c.map((d) => d.md)
  )
})

test('加大 count 只追加，不改变已有用例（第 i 篇只依赖 seed+i）', () => {
  const small = generateCorpus({ seed: 999, count: 10 })
  const large = generateCorpus({ seed: 999, count: 40 })
  for (let i = 0; i < small.length; i++) {
    assert.equal(large[i].md, small[i].md, `第 ${i} 篇不该变`)
  }
})

test('每条块级构造都能被语料覆盖到（400 篇内）', () => {
  const corpus = generateCorpus({ seed: 7, count: 400 })
  const seen = new Set()
  for (const d of corpus) for (const t of d.tags) seen.add(t)
  const missing = BLOCKS.filter((c) => !seen.has(c.id)).map((c) => c.id)
  assert.deepEqual(missing, [], '这些构造在 400 篇里一次都没出现（权重/抽样写错了？）')
})

test('每条构造自己可调用：最坏随机源（0 与 0.999）都不抛异常且写出非空文本', () => {
  const extremes = [() => 0, () => 0.999999999]
  for (const rng of extremes) {
    for (const c of BLOCKS) {
      const md = c.make(rng, STUB, () => ' ZQinline')
      assert.equal(typeof md, 'string')
      assert.ok(md.length > 0, `${c.id} 产出为空`)
    }
    for (const c of INLINE) {
      const md = c.make(rng, STUB)
      assert.equal(typeof md, 'string')
      assert.ok(md.length > 0, `行内 ${c.id} 产出为空`)
    }
  }
  for (const m of MUTATIONS) assert.equal(typeof m.apply('a\nb\n'), 'string')
})

test('结构声明自洽：键名属于已知结构、标签非空、哨兵词键名不写错', () => {
  const known = new Set(Object.keys(emptyStruct()))
  for (const c of [...BLOCKS, ...INLINE]) {
    assert.ok(
      Array.isArray(c.tags) && c.tags.length > 0,
      `${c.id} 缺少 tags（失败报告要靠它指认元凶）`
    )
    for (const k of Object.keys(c.struct ?? {})) {
      assert.ok(known.has(k), `${c.id} 的结构键 ${k} 不在 emptyStruct() 里（拼写错了？）`)
    }
  }
  assert.deepEqual([...MUTATION_IDS].sort(), MUTATION_IDS.slice().sort())
})

test('哨兵词：每篇至少一个、篇内唯一、且都真的出现在正文里', () => {
  const corpus = generateCorpus({ seed: 4242, count: 60 })
  for (const d of corpus) {
    assert.ok(d.tokens.length > 0, `${d.id} 没有哨兵词`)
    assert.equal(new Set(d.tokens).size, d.tokens.length, `${d.id} 哨兵词重复`)
    for (const t of d.tokens) {
      assert.ok(d.md.includes(t), `${d.id} 的哨兵词 ${t} 不在正文里（埋点位置写错了）`)
    }
  }
})

test('文档级变异按字面生效（行尾 / BOM / 文末换行）', () => {
  const byId = new Map(MUTATIONS.map((m) => [m.id, m]))
  assert.equal(byId.get('eol-crlf').apply('a\nb\n'), 'a\r\nb\r\n')
  assert.equal(byId.get('eol-cr').apply('a\nb\n'), 'a\rb\r')
  assert.equal(byId.get('bom').apply('a\n'), '\ufeffa\n')
  assert.equal(byId.get('no-final-newline').apply('a\n\n'), 'a')
})

test('规模有上界（语料别把套件拖垮）', () => {
  const corpus = generateCorpus({ seed: 31337, count: 80 })
  const max = Math.max(...corpus.map((d) => d.md.length))
  assert.ok(max < 20000, `最大一篇 ${max} 字符，超出预期上界`)
  assert.equal(rngFor(1, 0)(), rngFor(1, 0)(), '随机源必须可重放')
})
