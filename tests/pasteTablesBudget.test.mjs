// ─── 粘贴（含两张表 + 任务清单 + 嵌套列表）的"预算内完成" + 序列化线性 + 拼写单段上限 ──
//
// 这一轮用户第二次复报"还是会卡死"，内容只有 8–10 KB（两张表、任务清单、嵌套列表、
// 引用、行内代码）。实测真因两条：
//   ① `dragGuard` 往 ProseMirror 管理的 `<a>` 写 `draggable=false` ⇒ PM 的 DOMObserver
//      反复重渲染 ⇒ 主线程死循环（MutationObserver 2.5s 触发 9451 次，CDP 全超时）；
//   ② 序列化器 `atBlank()` 快路径把 `text()` 误判成"以换行结尾" ⇒ 列表/引用/任务清单
//      被压平（数据保真缺陷）。
// 真实浏览器里的证据见 `tmp/paste2-accept-*.json`（长任务 / 心跳 / 结构断言）。
//
// 本文件钉住能在 Node 里证明的三件事（不需要 DOM）：
//   1. 这份内容的规模画像**远在护栏预算之内**（不会被误降级/误拒绝）；
//   2. 表格序列化是**线性**的（不再对已写出的全文做 slice ⇒ 不会单元格数 × 全文长度）；
//   3. 中文拼写检查对超长段落**跳过**（只少提示、不丢内容），且计数可见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { MarkdownSerializerState, defaultMarkdownSerializer } from 'prosemirror-markdown'
import {
  decidePaste,
  scanPastedHtml,
  PASTE_MAX_DEPTH,
  PASTE_MAX_ELEMENTS
} from '../src/shared/../renderer/src/lib/editor/pasteGuardCore.ts'
import { serializeTable } from '../src/renderer/src/lib/editor/tableMarkdown.ts'
import { installFastMarkdownSerializer } from '../src/renderer/src/lib/editor/serializerFastPath.ts'
import {
  HEAVY_WORK_BUDGET_MS,
  runBudgeted,
  shouldDeferHeavyWork,
  workBudgetStats
} from '../src/renderer/src/lib/editor/workBudget.ts'
import {
  scanZhDoc,
  zhSpellStats,
  ZH_MAX_PARAGRAPH_CHARS
} from '../src/renderer/src/lib/editor/zhSpellcheck.ts'
import { setZhSpellcheckEnabled } from '../src/renderer/src/lib/editor/zhSpellcheckBridge.ts'

const labels = { omittedImage: (mb) => `[img ${mb}]` }

/** 类思源夹具：两张表（6×2 / 8×2）+ 任务清单 + 4 层嵌套列表 + 引用块，正文 ~9 KB */
function siyuanFixture() {
  const row = (cells, tag = 'td') =>
    `<tr>${cells.map((c) => `<${tag}><p>${c}</p></${tag}>`).join('')}</tr>`
  const t1 = [
    ['装饰器', '作用'],
    ['@property', '把一个方法变成只读属性'],
    ['@staticmethod', '不接收 self'],
    ['@classmethod', '第一个参数是 cls'],
    ['@dataclass', '自动生成 __init__'],
    ['@contextlib.contextmanager', '把生成器变成上下文管理器']
  ]
  const t2 = [
    ['主题', '掌握标准'],
    ['作用域与闭包', '能说清 LEGB 查找顺序；能手写闭包；能解释延迟绑定（**延迟绑定**）'],
    ['迭代协议', '能区分 __iter__ 与 __next__；能写出惰性生成器（`惰性求值`）'],
    ['描述符', '能写出最小的 __get__ / __set__ 实现，并解释优先级'],
    ['异步与事件循环', '能画出 coroutine → Task → event loop 的调度关系'],
    ['内存与引用', '能解释引用计数与循环垃圾回收的分工'],
    ['类型标注', '能写泛型函数与 Protocol'],
    ['测试与调试', '能用 fixture 组织共享状态']
  ]
  const table = (rows) =>
    `<div data-type="NodeTable" class="table"><table><colgroup><col style="width:184px"><col style="width:184px"></colgroup>` +
    rows.map((cells, i) => row(cells, i === 0 ? 'th' : 'td')).join('') +
    `</table></div>`
  const tasks = [
    '写最小示例',
    '用 functools.wraps 修一遍',
    '把 maxsize 调成 0',
    '记录一次排查'
  ].map(
    (x, i) => `<li><p><input type="checkbox"${i === 2 ? ' checked' : ''} disabled> ${x}</p></li>`
  )
  return (
    `<div data-type="NodeDocument" class="protyle-wysiwyg">` +
    `<div data-type="NodeHeading"><h1>Markdown 进阶笔记</h1></div>` +
    `<div data-type="NodeParagraph"><p>这一节把 **装饰器**、` +
    `<code>asyncio</code> 放在一起看，参考 https://docs.python.org/3/ 与 https://peps.python.org/ 。</p></div>` +
    table(t1) +
    table(t2) +
    `<div data-type="NodeList"><ul>${tasks.join('')}</ul></div>` +
    `<div data-type="NodeList"><ul><li><p>语言基础</p><ul><li><p>作用域</p><ul><li><p>全局与局部</p><ul><li><p>闭包</p></li></ul></li></ul></li></ul></li></ul></div>` +
    `<div data-type="NodeBlockquote"><blockquote><p>先把「能跑」当作底线。</p></blockquote></div>` +
    `<div data-type="NodeParagraph"><p>${'补充说明：这一段用来把体积推到 8–10 KB 量级。'.repeat(60)}</p></div>` +
    `</div>`
  )
}

test('夹具规模在护栏预算内：两张表 + 任务清单 + 嵌套列表 ⇒ allow（不降级、不拒绝）', () => {
  const html = siyuanFixture()
  const text =
    '# Markdown 进阶笔记\n\n- [ ] 任务一\n- [ ] 任务二\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  const scan = scanPastedHtml(html)
  // 规模画像：元素/深度都远低于降级阈值（这正是"上次的 base64 护栏不会触发"的原因）
  assert.ok(scan.elements > 0)
  assert.ok(scan.elements < PASTE_MAX_ELEMENTS, `elements=${scan.elements}`)
  assert.ok(scan.maxDepth < PASTE_MAX_DEPTH, `depth=${scan.maxDepth}`)
  assert.equal(scan.images.length, 0, '这份内容没有内联图片')

  const decision = decidePaste({ html, text }, labels)
  assert.equal(decision.kind, 'allow', '体积/结构正常的富文本必须原样放行')

  // 预算内：扫描一次应当远低于单次重活预算（这是"粘贴 ≤500ms"的第一段）
  const t0 = performance.now()
  runBudgeted('paste-scan', () => scanPastedHtml(html), { budgetMs: HEAVY_WORK_BUDGET_MS })
  const ms = performance.now() - t0
  assert.ok(ms < HEAVY_WORK_BUDGET_MS, `扫描耗时 ${ms.toFixed(1)}ms 超出预算`)
  assert.equal(workBudgetStats().overruns, 0, '正常规模的粘贴不该触发预算超限')
})

test('重活预算：超预算会记账并进入冷却，但**结果照常返回**（不丢内容）', () => {
  const before = workBudgetStats().overruns
  const value = runBudgeted(
    'simulated-heavy',
    () => {
      const until = performance.now() + HEAVY_WORK_BUDGET_MS + 40
      while (performance.now() < until) {
        /* 模拟一次超预算的同步重活 */
      }
      return 'kept'
    },
    { budgetMs: HEAVY_WORK_BUDGET_MS }
  )
  assert.equal(value, 'kept', '超预算也必须把结果交回去')
  assert.equal(workBudgetStats().overruns, before + 1)
  assert.equal(shouldDeferHeavyWork(), true, '超预算后可选重活应进入冷却')
})

test('表格序列化：不再对"已写出的全文"做 slice（单元格数 × 全文长度 → 线性）', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      text: { group: 'inline' },
      table: { group: 'block', content: 'tableRow+' },
      tableRow: { content: '(tableHeader|tableCell)+' },
      tableHeader: {
        content: 'block+',
        attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, align: { default: null } }
      },
      tableCell: {
        content: 'block+',
        attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, align: { default: null } }
      }
    }
  })
  const { paragraph, tableRow, tableHeader, tableCell } = schema.nodes
  const p = (s) => paragraph.create(null, s ? schema.text(s) : undefined)
  const header = schema.nodes.tableHeader.create({ align: null }, p('列一'))
  const rows = [tableRow.create(null, [header, tableHeader.create({ align: null }, p('列二'))])]
  for (let i = 0; i < 200; i += 1) {
    rows.push(
      tableRow.create(null, [
        tableCell.create(null, p(`第 ${i} 行`)),
        tableCell.create(null, p('值'))
      ])
    )
  }
  const table = schema.nodes.table.create(null, rows)

  installFastMarkdownSerializer()
  // 用上游默认的节点/标记规则（单元格里只有文本，`renderInline` 会按 `text` 规则走
  // `state.text()` —— 与真实序列化器同一条路径，才量得准）
  const state = new MarkdownSerializerState(
    defaultMarkdownSerializer.nodes,
    defaultMarkdownSerializer.marks,
    {}
  )
  // 大前缀：模拟"表格出现在长文档靠后的位置"（旧实现会把这个前缀整串复制 200 次）
  state.out = 'X'.repeat(200_000)

  const origSlice = String.prototype.slice
  let maxSliceLen = 0
  String.prototype.slice = function slice(a, b) {
    if (this.length > maxSliceLen) maxSliceLen = this.length
    return origSlice.call(this, a, b)
  }
  try {
    serializeTable(state, table)
  } finally {
    String.prototype.slice = origSlice
  }
  // 单元格渲染只允许 slice"这一格的短串"，绝不允许 slice 已累积的全文
  assert.ok(maxSliceLen < 4096, `最大的 slice 接收者长度 ${maxSliceLen}（应远小于 200000）`)
  // 表格部分（前缀之后）逐行核对
  const md = state.out.slice(200_000)
  assert.match(md, /^\| 列一 \| 列二 \|$/m, '表头行')
  assert.match(md, /^\| --- \| --- \|$/m, '分隔行')
  assert.match(md, /\| 第 199 行 \| 值 \|/, '最后一行内容')
  assert.equal(md.split('\n').filter((l) => l.startsWith('| 第')).length, 200, '200 行数据都在')
  assert.equal(state.out.length > 200_000, true, '前缀必须原样保留（不许截断别人的输出）')
})

test('中文拼写检查：超长段落按单段上限跳过（只少提示，不丢内容）且计数可见', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      text: { group: 'inline' }
    }
  })
  setZhSpellcheckEnabled(true)
  const long = '我们的的文档。' + '这里是一段很长的正文。'.repeat(800)
  assert.ok(long.length > ZH_MAX_PARAGRAPH_CHARS, `夹具长度 ${long.length} 应超过上限`)
  const longDoc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text(long))
  ])
  const skippedBefore = zhSpellStats().skippedLongBlocks
  assert.deepEqual(scanZhDoc(longDoc), [], '超长段落不扫（避免"段数 × 段长"叠加）')
  assert.equal(zhSpellStats().skippedLongBlocks, skippedBefore + 1, '跳过要记账（可见，不静默）')

  // 正常段落照旧命中 —— 降级不能把功能一起关掉
  const shortDoc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text('这是我们的的文档。'))
  ])
  const issues = scanZhDoc(shortDoc)
  assert.ok(issues.length >= 1, '正常段落仍然报"的的"')
})
