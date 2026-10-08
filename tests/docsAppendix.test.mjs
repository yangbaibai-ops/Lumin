// ─── 附录拆片的守卫（报告 §6.2 P1「文档收敛」）────────────────────────────────
//
// 背景：`docs/manual/08-appendix.md` 原先 3516 行、只有一个顶层小节，翻起来和改起来都难受。
// 现在拆成"索引 + 5 片"，**内容逐行原样**（拆的那一刻用 sha256 比对过：重组后的 3516 行与原文件
// 完全一致）。拆完必须防止三件事，否则拆片就是净损失：
//   ① 越拆越肥（索引又长回去）；
//   ② 有分片变成孤儿（没人从索引点得进去）；
//   ③ **内容悄悄丢/重复**（手抄最容易出的事，而这是仓库的历史记录）。
// 所以这里钉住：索引与分片的行数预算、面包屑、以及"每个 §4.x 小节在所有分片里恰好出现一次"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const MANUAL = path.join(ROOT, 'docs/manual')

/** 拆片的分片（顺序即历史顺序）；改名字要同时改索引与这里 */
const PARTS = [
  '08a-fix-log-1.md',
  '08b-fix-log-2.md',
  '08c-fix-log-3.md',
  '08d-fix-log-4.md',
  '08e-wave-records.md',
  // 第十一轮新增：08d 已经顶到 1000 行预算（999 + 一条指向新片的说明），§4.90 另开一片
  '08f-fix-log-5.md'
]

const lineCount = (f) => fs.readFileSync(f, 'utf-8').replace(/\r\n/g, '\n').split('\n').length

test('附录索引：够短（≤200 行）、点到每一片、保留参考表与各类入口', () => {
  const index = fs.readFileSync(path.join(MANUAL, '08-appendix.md'), 'utf-8')
  assert.ok(
    lineCount(path.join(MANUAL, '08-appendix.md')) <= 200,
    '索引又长回去了（拆片的意义就没了）'
  )
  for (const p of PARTS) {
    assert.match(index, new RegExp(`\\(./${p.replace('.', '\\.')}\\)`), `索引没有指向 ${p}`)
  }
  // 参考表留在索引里（附录 A/B/C 是速查用的，不该被拆走）
  assert.match(index, /^### 附录 A/m)
  assert.match(index, /^### 附录 B/m)
  assert.match(index, /^### 附录 C/m)
  // 索引要给出"live 台账在哪"，免得读者只在历史记录里找当前状态
  assert.match(index, /optimization-waves\.md/)
  assert.match(index, /packaging-install-test\.md/)
})

test('每个分片：有标题、有回索引的面包屑、行数在预算内', () => {
  for (const p of PARTS) {
    const file = path.join(MANUAL, p)
    assert.ok(fs.existsSync(file), `${p} 不存在（索引里却点得到它）`)
    const text = fs.readFileSync(file, 'utf-8')
    assert.match(text, /^# /m, `${p} 缺少一级标题`)
    assert.match(text, /\[附录索引\]\(\.\/08-appendix\.md\)/, `${p} 缺少回索引的面包屑`)
    const n = lineCount(file)
    assert.ok(n <= 1000, `${p} 有 ${n} 行，超过预算（拆片目标 <1000）`)
    assert.ok(n >= 50, `${p} 只有 ${n} 行 —— 像是被误删`)
  }
})

test('内容不丢也不重：§4.x 小节在所有分片里恰好出现一次，且总量对得上', () => {
  const seen = new Map()
  let total = 0
  for (const p of PARTS) {
    const text = fs.readFileSync(path.join(MANUAL, p), 'utf-8')
    total += lineCount(path.join(MANUAL, p))
    for (const m of text.matchAll(/^#{2,3} §?4\.(\d+)\b/gm)) {
      const id = `4.${m[1]}`
      seen.set(id, (seen.get(id) ?? 0) + 1)
    }
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`)
  assert.deepEqual(dupes, [], `这些小节在分片里出现了多次（拆片时重复了）：${dupes.join(', ')}`)
  assert.ok(seen.size >= 45, `只找到 ${seen.size} 个 §4.x 小节 —— 像是丢了一大段`)
  // 首尾与两波记录都必须还在
  for (const id of ['4.39', '4.85', '4.86', '4.87']) {
    assert.ok(seen.has(id), `§${id} 不见了（拆片时丢了）`)
  }
  // 行数下限：拆片只该"搬家"，不该变短
  assert.ok(total >= 3400, `五个分片合计只有 ${total} 行，比拆片前（3516 行）少太多`)
})

test('拆片后的文件是 UTF-8 无 BOM（文档不该带 BOM：会污染 grep 与 diff 的第一行）', () => {
  for (const p of ['08-appendix.md', ...PARTS]) {
    const buf = fs.readFileSync(path.join(MANUAL, p))
    assert.notEqual(buf[0], 0xef, `${p} 带 BOM`)
    assert.notEqual(buf[1], 0xbb, `${p} 带 BOM`)
  }
})
