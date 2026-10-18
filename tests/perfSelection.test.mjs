// ─── 性能守护（本轮：键入 / 拖选 / 滚动）──────────────────────────────────────
//
// 这些断言不是"跑一遍性能"，而是把**已经验证有效的结构**钉住：谁把按 doc 的缓存、
// 命中测试的几何预筛、按帧合并、有限区间遍历改回去，单测立刻红。
//
// 真实数字的基线/复测见 `tools/perf/run-perf.js`（同一夹具、同一脚本、前后对比）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const TOOLBAR = () => read('src/renderer/src/lib/editor/imageToolbar.ts')

test('拖选热路径：collectImgSources 按 doc 身份缓存（纯选区事务不再全文档扫描）', () => {
  const src = TOOLBAR()
  assert.match(
    src,
    /if \(perfFlag\('imgCache'\) && imgSrcCacheDoc === state\.doc\)/,
    '必须按 state.doc 身份命中缓存'
  )
  assert.match(src, /imgSrcCacheDoc = state\.doc/, '计算完必须更新缓存 doc')
  // 缓存命中的返回值也必须是同一份列表（不要每次 slice 出大数组）
  assert.match(src, /return imgSrcCacheList/)
})

test('decorations：doc/打开态不变时走缓存，不再每次事务重建整篇装饰', () => {
  const src = TOOLBAR()
  assert.match(src, /cached\.doc === state\.doc/)
  assert.match(src, /cached\.open === open/)
  assert.match(src, /cached\.editing === openEditing/)
  assert.match(src, /perfCount\('decoBuild'\)/)
  assert.match(src, /perfCount\('decoHit'\)/)
  assert.match(
    src,
    /const applyDecoSelection = \(state: EditorState, cache: DecoCache\): DecorationSet/
  )
  // widget 构造器必须只有一份（两态复用，PM 不会每次事务拆图重建 DOM）
  const hits = src.match(/Decoration\.widget\(\s*\/\/ ⚠️ 挂在/g) || []
  assert.equal(hits.length, 1, '图片 widget 装饰只允许有一个构造器（makeRawWidgetDeco）')
})

test('覆盖判定：elementsFromPoint 之前必须有几何预筛（普通正文零命中测试）', () => {
  const src = TOOLBAR()
  const atCand = src.indexOf('const opaqueCandidates')
  const atHit = src.indexOf('document.elementsFromPoint')
  assert.ok(atCand > 0 && atHit > atCand, 'opaqueCandidates 必须先于 elementsFromPoint 声明')
  assert.match(src, /if \(!cands\.length\) return \[r\]/, '带与候选块无 y 交叠时整条直接保留')
  assert.match(src, /if \(!any\) return null/, 'x 不在任何候选块内时不做命中测试')
})

test('visibleFrags：只遍历选区两端之间的文本节点（不再整篇 walk）', () => {
  const src = TOOLBAR()
  const fn = src.slice(src.indexOf('const visibleFrags = ('), src.indexOf('const widgetRange = ('))
  assert.match(fn, /view\.domAtPos\(from\)/)
  assert.match(fn, /view\.domAtPos\(to\)/)
  assert.match(fn, /const pastEnd = \(t: Node\)/)
  assert.match(fn, /if \(pastEnd\(t\)\) break/)
})

test('绘制：同一帧的多次 live 重绘合并成一次；落定/清空会取消排队帧', () => {
  const src = TOOLBAR()
  assert.match(src, /let livePaintRaf = 0/)
  assert.match(src, /livePaintRaf = window\.requestAnimationFrame\(flushLivePaint\)/)
  assert.match(src, /perfCount\('paintSkip'\)/)
  // clearLiveSel 与 clearSelBands 都要取消排队中的帧
  const cancelCount = (src.match(/cancelAnimationFrame\(livePaintRaf\)/g) || []).length
  assert.ok(
    cancelCount >= 2,
    `取消排队帧的出口必须覆盖 clearLiveSel/clearSelBands（实际 ${cancelCount}）`
  )
})

test('选区带：每帧只建一次 DOM（不再"建 → 回读 → 清空 → 再建"）', () => {
  const src = TOOLBAR()
  assert.doesNotMatch(
    src,
    /for \(const d of Array\.from\(node\.children\)\)/,
    '旧的回读循环必须删掉'
  )
  const fn = src.slice(
    src.indexOf('const paintSelBands = ('),
    src.indexOf('const revealedSourceInSel = (')
  )
  const replaces = (fn.match(/node\.replaceChildren\(/g) || []).length
  assert.equal(replaces, 1, `paintSelBands 里只允许一次 replaceChildren（实际 ${replaces}）`)
})

test('打字：光标已在视口内时跳过 PM 逐层 scrollRectIntoView 测量（贴近边缘仍交回 PM）', () => {
  const src = read('src/renderer/src/components/editor/TyporaEditor.vue')
  assert.match(src, /handleScrollToSelection: \(view\) =>/)
  assert.match(src, /if \(!perfFlag\('fastScroll'\)\) return false/)
  assert.match(src, /caret\.top >= box\.top \+ pad && caret\.bottom <= box\.bottom - pad/)
  assert.match(src, /const pad = 10/, '判据必须比 PM 的 scrollMargin(5px) 更保守')
})

test('性能测量脚本与夹具生成器在仓库里（可复现）', () => {
  for (const p of [
    'tools/perf/run-perf.js',
    'tools/perf/fixtures.js',
    'tools/perf/probe.js',
    'tools/perf/raise-window.ps1',
    'tools/perf/pin-window.ps1'
  ]) {
    assert.ok(existsSync(join(ROOT, p)), `${p} 必须存在（基线/复测脚本随提交保留）`)
  }
  const runner = read('tools/perf/run-perf.js')
  assert.match(runner, /--only=drag/, '用法注释里保留最小复现命令')
  assert.match(runner, /disable-backgrounding-occluded-windows/, '遮挡时 rAF 停摆的开关必须保留')
  assert.match(runner, /xw-perf-ud/, 'userData 名不含 lumin')
})
