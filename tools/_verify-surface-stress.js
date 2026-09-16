'use strict'
// ─── 验收：极端 / 边界 / 特殊输入下的两面一致性（测试方案 §3 的 L4 层）──────────
//
// L2/L3 验的是「常规文档对不对」，这一层专门喂**压力和畸形输入**，回答两个问题：
//   1. **还能不能不出错**（不崩、不丢内容、结构不变形）；
//   2. **代价有多大**（打开 / 切面 / 回灌的耗时，超预算即 FAIL）。
//
// 为什么必须单独一层：大文档的性能退化与畸形输入的崩溃，在几十篇小语料里永远碰不到，
// 而它们恰恰是「用户第一次用就会遇到」的那种问题（粘一篇 1MB 的笔记进来）。
//
// 用例表（`CASES`）里每一项自带 `build()` 与 `budget`，加用例 = 加一行（见测试方案 §8）。
//
// ⚠️ `budget` 的语义是**基线守卫**，不是「理想值」：数字取首轮实测 × 约 1.5（见方案 §7）。
//    首轮实测暴露了两个**真实的性能问题**（已记进方案 §9 的台账，尚未修）：
//      · `scale-1mb-plain`：977KB 文档装载 16.2s、切回渲染 16.4s；
//      · `many-fences-2000`：2000 个围栏代码块（56KB！）装载 51.9s —— 每个代码块都挂一个
//        CodeMirror 实例，代价随块数线性膨胀。
//    这两条基线就是「别再变慢」的守卫；要变快得改产品代码（虚拟化/懒挂载），单独立项。
// 判据：
//   · 不崩：任何一步抛异常 / 超时都算 FAIL 并记录现场
//   · 结构守恒：往返前后文档树签名同构（I5′）
//   · 切面稳定：切到源码再回来，内容逐字不变（I3/I4）
//   · 内容完整：埋在头/中/尾的哨兵词都还在（I7）
//   · 时间预算：三个耗时各自 ≤ budget（毫秒）
//
// 跑法（对着隔离实例）：node tools/_verify-surface-stress.js
// 报告：%TEMP%\lumin-surface-stress-report.json（含每例耗时）

const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, waitEditor, attach, sleep, Reporter, fatal } = require('./lib/harness')
const { contentPreserved, unchanged, traceTokens } = require('./lib/surface-invariants')
const P = require('./lib/surface-probe')

const DUMP = process.env.LUMIN_STRESS_DUMP || path.join(os.tmpdir(), 'lumin-surface-stress-report.json')

const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('')

/** 用例表：规模 / 畸形 / 混合。budget 单位毫秒，按「实测 × 3」给宽（见方案 §7） */
const CASES = [
  {
    id: 'scale-1mb-plain',
    why: '约 1MB 纯段落：有没有 O(n²)（每次按键都整篇重排/重解析）',
    build: () => {
      const para = (i) => `## 小节 ${i}\n\n第 ${i} 段正文，${'内容'.repeat(40)}。\n\n- 甲\n- 乙\n\n`
      let md = ''
      let i = 0
      while (md.length < 1_000_000) md += para(i++)
      return { md, tokens: ['小节 0', '小节 ' + Math.floor(i / 2), '小节 ' + (i - 1)] }
    },
    // 首轮实测：load 16.2s / back 16.4s（见文件头的性能台账）
    budget: { load: 26000, toSource: 4000, back: 26000 }
  },
  {
    id: 'scale-20k-lines',
    why: '两万行（一万个短段落）：块级解析与序列化的规模',
    build: () => {
      const md = repeat(10_000, (i) => `第 ${i} 行。\n\n`)
      return { md, tokens: ['第 0 行', '第 9999 行'] }
    },
    budget: { load: 12000, toSource: 4000, back: 8000 }
  },
  {
    id: 'scale-200k-single-line',
    why: '单行 200KB：行内解析/装饰会不会退化成平方级',
    build: () => {
      const md = '超长行 ' + 'x'.repeat(200_000) + ' 结尾\n'
      return { md, tokens: ['超长行', '结尾'] }
    },
    budget: { load: 12000, toSource: 4000, back: 8000 }
  },
  {
    id: 'deep-list-100',
    why: '100 层嵌套列表：递归深度与缩进归一',
    build: () => {
      const md = repeat(100, (i) => '  '.repeat(i) + `- 第 ${i} 层\n`)
      return { md, tokens: ['第 0 层', '第 99 层'] }
    },
    budget: { load: 6000, toSource: 3000, back: 5000 }
  },
  {
    id: 'deep-quote-40',
    why: '40 层嵌套引用：引用前缀与懒续行的边界',
    build: () => {
      const md = repeat(40, (i) => '> '.repeat(i + 1) + `第 ${i} 层引用\n`)
      return { md, tokens: ['第 0 层引用', '第 39 层引用'] }
    },
    budget: { load: 6000, toSource: 3000, back: 5000 }
  },
  {
    id: 'many-fences-2000',
    why: '2000 个围栏代码块：节点数量带来的卡顿',
    build: () => {
      const md = repeat(2000, (i) => '```js\nconst v' + i + ' = ' + i + '\n```\n\n')
      return { md, tokens: ['const v0 = 0', 'const v1999 = 1999'] }
    },
    // 首轮实测：load 51.9s（每个代码块一个 CodeMirror 实例）—— 见文件头性能台账
    budget: { load: 80000, toSource: 6000, back: 12000 }
  },
  {
    id: 'wide-table-200x30',
    why: '200 行 × 30 列宽表：表格列宽计算与选择',
    build: () => {
      const cell = (r, c) => `r${r}c${c}`
      const head = '| ' + Array.from({ length: 30 }, (_, i) => '列' + i).join(' | ') + ' |\n'
      const delim = '| ' + Array.from({ length: 30 }, () => '---').join(' | ') + ' |\n'
      const body = Array.from({ length: 200 }, (_, r) =>
        '| ' + Array.from({ length: 30 }, (_, c) => cell(r, c)).join(' | ') + ' |'
      ).join('\n')
      return { md: head + delim + body + '\n', tokens: ['r0c0', 'r199c29'] }
    },
    budget: { load: 15000, toSource: 5000, back: 10000 }
  },
  {
    id: 'many-inline-5000',
    why: '一段里 5000 处行内样式：标记栈物化的代价',
    build: () => {
      const md = '行内 ' + repeat(5000, (i) => `**粗${i}** _斜${i}_ \`码${i}\` `) + '\n'
      return { md, tokens: ['粗0', '粗4999'] }
    },
    budget: { load: 12000, toSource: 4000, back: 8000 }
  },
  {
    id: 'math-800',
    why: '800 个行内公式 + 100 个块级公式：KaTeX 装饰的规模',
    build: () => {
      const inline = '公式 ' + repeat(800, (i) => `$a_${i}^2$ `) + '\n\n'
      const blocks = repeat(100, (i) => `$$\nb_${i} = ${i}\n$$\n\n`)
      return { md: inline + blocks, tokens: ['a_0', 'b_99'] }
    },
    budget: { load: 12000, toSource: 4000, back: 8000 }
  },
  {
    id: 'unicode-heavy',
    why: 'emoji/ZWJ/组合符/RTL/零宽/NBSP 混排：代理对与双向文本的边界',
    build: () => {
      const md =
        'emoji ' +
        repeat(2000, () => '😀👨‍👩‍👧‍👦🏳️‍🌈') +
        '\n\n组合 ' +
        repeat(2000, () => 'e\u0301a\u0300') +
        '\n\nRTL ' +
        repeat(500, () => 'مرحبا שלום ') +
        '\n\n零宽 ' +
        repeat(500, () => 'a\u200bb\u00a0c ') +
        '\n'
      return { md, tokens: ['emoji', '零宽'] }
    },
    budget: { load: 12000, toSource: 4000, back: 8000 }
  },
  {
    id: 'malformed-unclosed',
    why: '未闭合的围栏/强调/链接/公式/HTML 注释/front matter：解析器不能崩、不能吞内容',
    build: () => {
      const md = [
        '```js',
        'const unclosed = 1',
        '',
        '**未闭合粗体',
        '',
        '[未闭合链接](https://e.com',
        '',
        '$未闭合公式',
        '',
        '<!-- 未闭合注释',
        '',
        '---',
        'title: 未闭合 front matter',
        '',
        '尾巴哨兵',
        ''
      ].join('\n')
      return { md, tokens: ['const unclosed = 1', '尾巴哨兵'] }
    },
    budget: { load: 6000, toSource: 3000, back: 5000 }
  },
  {
    id: 'mixed-real-100k',
    why: '真实感混合文档（标题/列表/表格/代码/公式/HTML/front matter）约 100KB',
    build: () => {
      const unit = (i) =>
        [
          `## 第 ${i} 节`,
          '',
          `正文 ${i}，含 \`行内码\`、**粗体**、_斜体_ 与 $a_${i}^2$。`,
          '',
          '| 甲 | 乙 |',
          '| --- | ---: |',
          '| a | b |',
          '',
          '- 一',
          '- 二',
          '',
          '```js',
          `const x${i} = ${i}`,
          '```',
          '',
          `<div class="blk">HTML ${i}</div>`,
          '',
          '> 引用 ' + i,
          '',
          '$$',
          `c_${i} = ${i}`,
          '$$',
          ''
        ].join('\n')
      let md = '---\ntitle: 压测\n---\n\n'
      let i = 0
      while (md.length < 100_000) md += unit(i++)
      return { md, tokens: ['第 0 节', `const x${i - 1} = ${i - 1}`] }
    },
    // 首轮实测：load 33.7s（100 个代码块 + 100 张表 + 公式/HTML 混合）—— 见文件头性能台账
    budget: { load: 55000, toSource: 5000, back: 8000 }
  }
]

async function main() {
  const report = new Reporter('两面一致性：极端/边界/压力（L4）')
  const host = await connect()
  if (!(await settle(host.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  let app = host
  const scratch = await P.openScratchWindow(host)
  if (scratch) app = await attach(scratch)
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '临时窗口未就绪')
    return report.finish()
  }
  if (!(await waitEditor(app.ev))) {
    report.skip('editor-ready', '编辑器未就绪')
    return report.finish()
  }
  const backup = await P.readJson(
    app,
    `JSON.stringify({ mode: window.__L.ui().editorMode, autoSave: window.__L.settings().autoSave })`
  )
  await app.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(200)

  const dump = { generatedAt: new Date().toISOString(), cases: [] }
  const only = process.env.LUMIN_STRESS_ONLY

  for (const c of CASES) {
    if (only && !c.id.includes(only)) continue
    let md = ''
    let tokens = []
    try {
      const built = c.build()
      md = built.md
      tokens = built.tokens
    } catch (e) {
      report.check(`${c.id} 造用例`, false, String(e && e.message))
      continue
    }
    const row = { id: c.id, why: c.why, bytes: md.length, budget: c.budget }
    try {
      // 预热一次（不计时）：排除「第一次装载要建样式/字体」的固定成本
      await P.loadDoc(app, '# 预热\n\n暖一下。\n')
      await sleep(150)

      const t0 = Date.now()
      const p1 = await P.loadDoc(app, md)
      const loadMs = Date.now() - t0
      const pmA = await P.readJson(app, P.PM)
      const sigA = await app.ev(P.SIGNATURE)

      const t1 = Date.now()
      await P.setMode(app, 'source')
      const ta = await P.readJson(app, P.TEXTAREA)
      const toSourceMs = Date.now() - t1

      const t2 = Date.now()
      await P.setMode(app, 'wysiwyg')
      const p3 = await app.ev(P.FLUSH)
      const backMs = Date.now() - t2

      const sigB = await app.ev(P.SIGNATURE)
      const trace = traceTokens(pmA ? pmA.modelText : '', tokens)
      const stable = unchanged(p1, p3)
      const taOk = ta && ta.value === p1
      const level = contentPreserved(md, p1)

      Object.assign(row, {
        loadMs,
        toSourceMs,
        backMs,
        sigEqual: sigA === sigB,
        stable: stable.ok,
        textareaMatches: !!taOk,
        level: level.level,
        detail: level.detail,
        tokensMissing: trace.missing,
        docSize: pmA ? pmA.size : null,
        perf: await P.readJson(app, P.PERF).catch(() => null)
      })

      report.check(
        `${c.id} 打开装载 ≤ ${c.budget.load}ms`,
        loadMs <= c.budget.load,
        `${loadMs}ms（${(md.length / 1024).toFixed(0)}KB）`
      )
      report.check(`${c.id} 切到源码 ≤ ${c.budget.toSource}ms`, toSourceMs <= c.budget.toSource, `${toSourceMs}ms`)
      report.check(`${c.id} 切回渲染 ≤ ${c.budget.back}ms`, backMs <= c.budget.back, `${backMs}ms`)
      report.check(`${c.id} 结构守恒（签名同构）`, sigA === sigB, '')
      report.check(`${c.id} 切面稳定 + textarea = 真源`, stable.ok && !!taOk, `stable=${stable.ok} ta=${!!taOk}`)
      report.check(
        `${c.id} 内容完整（头/中/尾哨兵都在）`,
        trace.ok,
        trace.missing.length ? `缺 ${JSON.stringify(trace.missing)}` : `${trace.found}/${trace.total}`
      )
    } catch (e) {
      row.error = e && e.message ? e.message : String(e)
      report.check(`${c.id} 不崩`, false, row.error)
      await P.setMode(app, 'wysiwyg').catch(() => {})
    }
    dump.cases.push(row)
    report.note(
      `${c.id}: ${(row.bytes / 1024).toFixed(0)}KB load=${row.loadMs}ms toSource=${row.toSourceMs}ms back=${row.backMs}ms 判级=${row.level ?? 'n/a'}`
    )
  }

  await app.ev(`(() => {
    window.__L.ui().editorMode = ${JSON.stringify(backup.mode)}
    window.__L.settings().set('autoSave', ${backup.autoSave})
    return 'ok'
  })()`)
  fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2), 'utf-8')
  report.note(`每例耗时与判级已写入 ${DUMP}`)
  if (scratch) {
    await app.send('Page.close').catch(() => {})
    await sleep(400)
    app.close()
  }
  host.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
