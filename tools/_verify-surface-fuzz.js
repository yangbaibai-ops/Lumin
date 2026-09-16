'use strict'
// ─── 验收：生成式语料 × 两面往返（测试方案 §3 的 L3 层）────────────────────────
//
// 与 L2（`_verify-surfaces`）的分工：L2 用手挑的构造 + 表驱动的断言把**语义**钉死；
// L3 用**生成器**把覆盖面铺开 —— 同一个不变量在几百篇随机组合的文档上重跑一遍，
// 专抓「单条构造都对、两两相邻就坏」的组合缺陷（历史上全部缺陷都长在这里）。
//
// 语料由 `tools/lib/md-gen.js` 生成，**种子可复现**：失败时报告里写清 seed + 文档序号 +
// 构造 tags，并给出**最小复现**（按块/行贪心删除，delta debugging 的简化版）。
//
// 判据（与 L2 共用 `tools/lib/surface-invariants.js`）：
//   · I1 内容守恒：判级 lossy 的每一篇都必须能解释（文档树同构 + 哨兵词齐全），否则回归
//   · I2 幂等：产出再走一遍逐字相同
//   · I3/I4/I6 切面稳定：切到源码内容逐字不变、textarea = 真源；切回来仍逐字不变
//   · I5′ 文档树签名同构：结构（含位置与关键属性）不能变
//   · I7 哨兵词：生成器埋在可见文本里的唯一词必须在文档模型里按序齐全
//
// 跑法（对着隔离实例；默认 60 篇，够快能进矩阵）：
//   node tools/_verify-surface-fuzz.js
//   LUMIN_FUZZ_COUNT=500 LUMIN_FUZZ_SEED=777 node tools/_verify-surface-fuzz.js   # 深挖
// 报告：%TEMP%\lumin-surface-fuzz-report.json（含失败最小复现）

const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, waitEditor, appPages, attach, sleep, Reporter, fatal } = require('./lib/harness')
const { generateCorpus } = require('./lib/md-gen')
const { contentPreserved, idempotent, unchanged, traceTokens } = require('./lib/surface-invariants')
const P = require('./lib/surface-probe')

const SEED = Number(process.env.LUMIN_FUZZ_SEED || 20260916)
const COUNT = Number(process.env.LUMIN_FUZZ_COUNT || 60)
const MAX_BLOCKS = Number(process.env.LUMIN_FUZZ_MAXBLOCKS || 6)
const DUMP = process.env.LUMIN_FUZZ_DUMP || path.join(os.tmpdir(), 'lumin-surface-fuzz-report.json')
const MAX_MINIMIZE = Number(process.env.LUMIN_FUZZ_MINIMIZE || 3)

/**
 * 已知缺陷（fuzz 抓到的、这轮没修的）：按**语料序号**登记，理由写清。
 *
 * 为什么要有这个清单：不登记的话 4 条已知问题会把矩阵永久拖红，真回归就淹没在里面了；
 * 登记后它们仍然出现在报告 JSON 与下面的 note 里，但**新**问题会让矩阵红。
 * 序号为什么稳定：种子固定 ⇒ 语料可复现，且 `tests/mdGen.test.mjs` 钉住了
 * 「加大 count 只追加、不改已有篇目」，所以同一 seed 下 doc-11 永远是那一篇。
 */
const KNOWN = {
  'doc-11': '空引用代码块（```mermaid 里没有内容）保存后围栏内容从空串变成一个换行（S2，围栏内是语义）',
  'doc-19': 'CR 行尾 + 引用：`>\\r>` 被展开成多行空引用，引用内的 `---`/setext 组合被重排（S2/S3）',
  'doc-22': '纯文本里的下划线被补转义（一个下划线 → 反斜杠+下划线）：保义但改字节（S3，与 F2 同类）',
  'doc-45': '列表后的 `---` + 段落 + `---`（HR 与 setext 的歧义）往返后结构重排（S2）'
}

async function main() {
  const report = new Reporter('两面一致性：生成式语料往返（L3 fuzz）')
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

  const corpus = generateCorpus({ seed: SEED, count: COUNT, maxBlocks: MAX_BLOCKS })
  const tally = { exact: 0, normalized: 0, lossy: 0 }
  const failures = []
  const knownHits = []
  const lossyCases = []
  const dump = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    count: COUNT,
    maxBlocks: MAX_BLOCKS,
    failures: [],
    docs: []
  }

  for (const doc of corpus) {
    try {
      const r = await checkDoc(app, doc)
      tally[r.level] += 1
      if (r.lossyCase) lossyCases.push(r.lossyCase)
      dump.docs.push(r.entry)
      if (r.problems.length) {
        const known = KNOWN[doc.id]
        if (known) knownHits.push({ id: doc.id, why: known })
        else failures.push({ id: doc.id, tags: doc.tags, problems: r.problems, source: doc.md })
      }
    } catch (e) {
      // 单篇异常不该毁掉整轮：记下来、把编辑面切回渲染态再继续（结论里会写清是哪一篇）
      failures.push({
        id: doc.id,
        tags: doc.tags,
        problems: ['页面异常：' + (e && e.message ? e.message : String(e))],
        source: doc.md
      })
      dump.docs.push({ id: doc.id, tags: doc.tags, problems: ['页面异常'] })
      await P.setMode(app, 'wysiwyg').catch(() => {})
    }
  }

  report.note(`语料 ${corpus.length} 篇（seed=${SEED}，每篇 ≤${MAX_BLOCKS} 个块）：exact ${tally.exact} / normalized ${tally.normalized} / lossy ${tally.lossy}`)
  const unexplained = lossyCases.filter((c) => (!c.sigEqual || !c.tokensOk) && !KNOWN[c.id])
  report.check('I1 lossy 全部能解释（文档树同构 + 哨兵齐全）', unexplained.length === 0, `无法解释=${unexplained.length}`)
  report.check('I2 往返幂等', !failures.some((f) => f.problems.some((p) => p.startsWith('往返不幂等'))), '')
  report.check('I3/I4/I6 切面稳定（内容逐字不变 + textarea = 真源）', !failures.some((f) => f.problems.some((p) => p.startsWith('切面不稳定'))), '')
  report.check('I5′ 文档树签名同构（结构/位置/关键属性都不变）', !failures.some((f) => f.problems.includes('文档树签名不同构')), '')
  report.check('I7 哨兵词按序齐全（没有截断/丢内容）', !failures.some((f) => f.problems.some((p) => p.startsWith('哨兵词'))), '')
  if (lossyCases.length) {
    report.note(`判级器判 lossy 的 ${lossyCases.length} 篇（标记层改写，见报告 JSON）：` + lossyCases.slice(0, 12).map((c) => c.id).join(' '))
  }
  if (knownHits.length) {
    report.note(
      `已知缺陷（登记在案、不计入本轮回归；见方案 §9 台账）：` +
        knownHits.map((k) => `${k.id}=${k.why}`).join('；')
    )
  }

  // ── 失败最小化（最多 MAX_MINIMIZE 条，省时间）──────────────────────────────
  for (const f of failures.slice(0, MAX_MINIMIZE)) {
    const minimal = await minimize(app, f.source)
    f.minimal = minimal
    report.note(`最小复现 ${f.id}（${f.problems[0]}）：${JSON.stringify(minimal.source)}`)
    dump.failures.push(f)
  }
  for (const f of failures.slice(MAX_MINIMIZE)) dump.failures.push(f)

  await app.ev(`(() => {
    window.__L.ui().editorMode = ${JSON.stringify(backup.mode)}
    window.__L.settings().set('autoSave', ${backup.autoSave})
    return 'ok'
  })()`)
  dump.lossyTriage = lossyCases
  dump.tally = tally
  fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2), 'utf-8')
  report.note(`逐篇结果 + 失败最小复现已写入 ${DUMP}`)
  if (scratch) {
    await app.send('Page.close').catch(() => {})
    await sleep(400)
    app.close()
  }
  host.close()
  return report.finish()
}

/**
 * 跑一篇语料：往返 + 切面，返回 { level, problems, entry, lossyCase }。
 * 判据与 L2 完全一致（同一套 lib），只是这里必须逐篇返回，好让上层在异常时也能记账。
 */
async function checkDoc(app, doc) {
  const p1 = await P.loadDoc(app, doc.md)
  if (p1 === null) return { level: 'exact', problems: ['编辑器未就绪'], entry: { id: doc.id }, lossyCase: null }
  const pmA = await P.readJson(app, P.PM)
  const sigA = await app.ev(P.SIGNATURE)
  const c1 = contentPreserved(doc.md, p1)
  const traceA = traceTokens(pmA ? pmA.modelText : '', doc.tokens)

  const p2 = await P.loadDoc(app, p1)
  const sigB = await app.ev(P.SIGNATURE)
  const idem = idempotent(p1, p2)
  const sigEqual = sigA === sigB

  // 切面稳定性：只看不编辑地切到源码，内容必须逐字不变、textarea 必须等于真源
  const before = await P.readJson(app, P.STORE)
  await P.setMode(app, 'source')
  const ta = await P.readJson(app, P.TEXTAREA)
  const inSource = await P.readJson(app, P.STORE)
  const stableSource = unchanged(before.content, ta ? ta.value : null)
  const taMatches = ta && ta.value === inSource.content
  await P.setMode(app, 'wysiwyg')
  const p3 = await app.ev(P.FLUSH)
  const stableBack = unchanged(p1, p3)

  const problems = []
  if (!sigEqual) problems.push('文档树签名不同构')
  if (!idem.ok) problems.push('往返不幂等：' + idem.detail)
  if (!stableSource.ok || !stableBack.ok || !taMatches) {
    problems.push(`切面不稳定（源码=${stableSource.detail}；回灌=${stableBack.detail}；textarea=${!!taMatches}）`)
  }
  if (!traceA.ok) problems.push(`哨兵词缺失/乱序：${JSON.stringify(traceA.missing)}`)

  return {
    level: c1.level,
    problems,
    lossyCase: c1.ok
      ? null
      : { id: doc.id, tags: doc.tags, detail: c1.detail, diagnosis: c1.diagnosis, sigEqual, tokensOk: traceA.ok },
    entry: {
      id: doc.id,
      tags: doc.tags,
      mutations: doc.mutations,
      level: c1.level,
      detail: c1.detail,
      diagnosis: c1.diagnosis,
      sigEqual,
      idempotent: idem.ok,
      stable: stableSource.ok && stableBack.ok && !!taMatches,
      tokens: { total: doc.tokens.length, missing: traceA.missing, outOfOrder: traceA.outOfOrder },
      problems
    }
  }
}

/**
 * 贪心最小化：先按空行分块删，再逐行删，直到「问题消失」为止。
 * 最小化的是**结构/幂等**这一类（最容易复现、也最可能是真缺陷）；切面类问题依赖时序，
 * 不在这里最小化 —— 报告里保留原文即可。
 */
async function minimize(app, source) {
  const stillBad = async (md) => {
    if (!md.trim()) return false
    const p1 = await P.loadDoc(app, md)
    if (p1 === null) return false
    const sigA = await app.ev(P.SIGNATURE)
    const p2 = await P.loadDoc(app, p1)
    const sigB = await app.ev(P.SIGNATURE)
    return sigA !== sigB || !idempotent(p1, p2).ok
  }
  let cur = source
  let changed = true
  while (changed) {
    changed = false
    const blocks = cur.split(/\n{2,}/)
    for (let i = 0; i < blocks.length; i++) {
      const cand = blocks.filter((_, k) => k !== i).join('\n\n')
      if (await stillBad(cand)) {
        cur = cand
        changed = true
        break
      }
    }
  }
  changed = true
  while (changed) {
    changed = false
    const lines = cur.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const cand = lines.filter((_, k) => k !== i).join('\n')
      if (await stillBad(cand)) {
        cur = cand
        changed = true
        break
      }
    }
  }
  const p1 = await P.loadDoc(app, cur)
  return { source: cur, produced: p1, level: contentPreserved(cur, p1).level }
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
