// ─── 表格拖选"落定一致"契约（第一百四十轮）────────────────────────────────────
//
// 用户报障：在表格里拖选，**按下**时看到的选中范围（图 1）与**抬起**后（图 2）不一致；
// 切到别的应用再切回（图 3）又对了。逐帧实测（`tmp/tblsel/`，两套实例、zh 开/关/只英文）
// 得到的两条真因都**不在**中文检查层，而在"选区绘制层"的交接：
//
//   ① 兜底高亮（CSS Highlight `lumin-img-drag`）与 `.sel-band` **同色叠加**：
//      旧判据要求片段矩形**完整**落在带里（容差 0.5px），表格第 2 行 "首次唤起搜索面板（"
//      的右缘比带多 2.4px ⇒ 整段又进 Highlight、在带上盖了 143px ⇒ 同色叠两层（更暗）；
//      松手 `clearTempPaint` 撤掉高亮 ⇒ 同一片立刻变浅 = "按下 / 抬起不一致"。
//   ② 带的"被不透明块盖住"是**逐片撤**的，但旧代码用"整条带是否被完整保留"反推
//      `dropped`：一条带被 `code` 从中间切成两半时两半都"完整保留" ⇒ `dropped=false`
//      ⇒ 中间那一小段既没有带、原生又被关着 ⇒ 松手后**完全失去选中样式**。
//
// 这两条都属于"绘制层交接"，与 `zhSpellcheck` 的 Decoration 无关：关掉中文检查（decos=0）
// 逐帧数据完全相同（模型、带矩形、原生区间），唯一差别只是原生 `getClientRects()` 的
// **碎片数**（15 → 12，Decoration.inline 把文本节点拆开了），合并后的带矩形一个不差。
//
// 所以本测试钉住四件事：①逐片记账；②兜底高亮的容差；③收尾窗口关闭后按最终模型补画；
// ④中文检查层不得参与选区几何（只允许 inline 装饰、只给视觉属性）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const TOOLBAR = () => read('src/renderer/src/lib/editor/imageToolbar.ts')
const ZH = () => read('src/renderer/src/lib/editor/zhSpellcheck.ts')

/** 取出某个顶层 const/函数到下一个顶层声明之间的源码（与 perfSelection.test.mjs 同一手法） */
function blockOf(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker)
  assert.ok(a >= 0, `找不到起点 ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  assert.ok(b > a, `找不到终点 ${endMarker}`)
  return src.slice(a, b)
}

test('表格落定一致 ①：被不透明块盖住的片**逐片记账**（不能只看整条带是否保留）', () => {
  const src = TOOLBAR()
  const split = blockOf(
    src,
    'const splitByCover = (r: RectBox): RectBox[] => {',
    'const keptRects: RectBox[] = []'
  )
  assert.match(src, /const removedSlices: RectBox\[\] = \[\]/, '必须有逐片记账的 removedSlices')
  assert.match(
    split,
    /removedSlices\.push\(\{ left: cursor, right: k\.l/,
    '保留区间的补集要逐片记下来'
  )
  assert.match(src, /const dropped = removedSlices\.length > 0/, 'dropped 必须由"撤过片"决定')
  assert.doesNotMatch(
    src,
    /const hiddenRects = drawn\.filter/,
    '旧的"整条带是否被完整保留"判据必须删掉（中间被切开时它会漏判）'
  )
  // 交回原生的片段判定也必须用逐片集合
  assert.match(
    src,
    /const handledByNative = \(f: SelFrag\): boolean => \{[\s\S]*?removedSlices\.some\(/
  )
})

test('表格落定一致 ②：兜底高亮与带不得同色叠加（覆盖判定有 4px/2px 容差）', () => {
  const src = TOOLBAR()
  assert.match(src, /const SEL_COVER_TOL_X = 4/, 'x 容差 4px（实测漏判 2.4px）')
  assert.match(src, /const SEL_COVER_TOL_Y = 2/, 'y 容差 2px')
  const covered = blockOf(src, 'const covered = (r: RectBox): boolean =>', 'let missFrag = 0')
  assert.match(covered, /SEL_COVER_TOL_X/, 'covered 必须用容差')
  assert.match(covered, /SEL_COVER_TOL_Y/)
  // 兜底只补"确实没盖到"的片段；容差把"99% 已盖住"的片段排除掉
  assert.match(
    src,
    /for \(const f of intentFrags\) \{\s*if \(handledByNative\(f\)\) continue\s*if \(f\.rects\.every\(covered\)\) continue/,
    '兜底高亮必须跳过已覆盖的片段'
  )
})

test('表格落定一致 ③：收尾窗口关闭后按**最终模型**重画一次（不把拖动期那一份留在屏上）', () => {
  const src = TOOLBAR()
  assert.match(src, /let settleRepaintTimer: ReturnType<typeof setTimeout> \| 0 = 0/)
  const cancel = blockOf(src, 'const cancelWatch = (): void => {', 'const textSelAt = (')
  assert.match(cancel, /settleStampAt = Date\.now\(\)/, '先盖收尾印记')
  assert.match(
    cancel,
    /if \(boxDrag == null && view\.dom\?\.isConnected\) \{[\s\S]*?settledKey = null[\s\S]*?paintSettledSel\(view\)/,
    '收尾出口要立刻按最终模型补画（新手势已经开始时让位）'
  )
  assert.match(cancel, /data-img-settle-repaint/, '补画留诊断锚，供套件/探针取证')
  assert.match(
    cancel,
    /SETTLE_STAMP_MS \+ 40/,
    '窗口关闭后再补一次（骑过 PM DOMObserver 的读回尾巴）'
  )
  // 销毁路径必须清掉定时器（换文档/切模式时不能把旧视图的补画留在队列里）
  const destroy = src.slice(src.lastIndexOf('destroy: () => {'))
  assert.match(destroy, /clearTimeout\(settleRepaintTimer\)/, 'destroy 要清 setTimeout')
})

test('表格落定一致 ④：中文检查层不参与选区几何（只出 inline 装饰 + 视觉属性）', () => {
  const zh = ZH()
  assert.match(
    zh,
    /Decoration\.inline\(issue\.from, issue\.to, \{/,
    '中文命中只能是 Decoration.inline'
  )
  assert.doesNotMatch(zh, /Decoration\.widget/, '中文层不得生成 widget（会改 DOM 结构/行盒）')
  const deco = blockOf(
    zh,
    'export function buildZhDecorations',
    'export const zhSpellcheckPluginKey'
  )
  assert.match(deco, /class: 'zh-spell-issue'/)
  assert.match(deco, /'data-zh-spell'/)
  assert.doesNotMatch(
    deco,
    /\bstyle\b|\bwidth\b|\bheight\b|\bpadding\b|\bmargin\b/,
    '装饰不得带任何布局属性'
  )

  // 选区几何侧（visibleFrags / paintSelBands）不许读中文检查状态
  const geom = blockOf(TOOLBAR(), 'const visibleFrags = (', 'const widgetRange = (')
  const paint = blockOf(TOOLBAR(), 'const paintSelBands = (', 'const revealedSourceInSel = (')
  assert.doesNotMatch(geom + paint, /zhSpell|zh-spell|ZH_|__LZHSPELL/i, '选区几何不得读中文检查层')
  // 落定态只按模型画：nativeDocRange 只允许出现在拖动期（它会把原生 DOM 区间并进来）
  const settled = blockOf(TOOLBAR(), 'const paintSettledSel = (', 'const clearLiveSel = (')
  assert.doesNotMatch(settled, /nativeDocRange/, '落定态不得再并原生区间（那是拖动期的事）')
  assert.match(settled, /view\.state\.selection/, '落定态必须按模型选区画')
})
