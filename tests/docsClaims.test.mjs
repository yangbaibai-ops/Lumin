// ─── 文档与代码的一致性门禁（自查报告 H3）──────────────────────────────────────
//
// 为什么需要它：2026-09-22 的一次真实事故 —— 第二十五轮删掉了「选区气泡菜单」与「下划线」，
// 但 `README.md` 一直把它们写成 ✅（对外功能清单 = 产品定位的表述），手册 §3.8 也按"现行实现"
// 叙述；更糟的是那一轮的 CHANGELOG 自称"已清理 README 的失真声明"，而
// `git show 7c56bdf --name-only` 里根本没有 `README.md`。另一例：`src/main/fileOps.ts` 的注释
// 长期写着"本仓库连本地历史都还没有"，而本地历史早已落地。
//
// 这类漂移靠人工同步不可靠（手册 2,900 行 + CHANGELOG 2,000+ 行 + 台账 240 行），
// 所以这里立两道最便宜的自动检查：
//   1. **禁止清单**：README 的功能清单里不许再出现已经移除的功能（气泡菜单 / 下划线 / Underline）；
//   2. **路径存在性**：文档里用代码体引用的仓库路径必须真的存在（防止改名/删除后文档继续引用）。
// 两道都是"宁可少查、不可乱红"的口径：只查明确的、可判定的东西；有意的历史叙述请写进引用块
// 或代码体里（本文件的规则只管"正文散文"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** 去掉代码块与引用块，只留正文散文（历史叙述通常写在引用块里，不该被这里判红） */
function prose(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
}

test('README 不再宣传已移除的功能（气泡菜单 / 下划线 / Underline）', () => {
  const body = prose(read('README.md'))
  const forbidden = [
    ['选区气泡菜单', '该组件已在第二十五轮删除（见 CHANGELOG）'],
    ['下划线', '唯一语义不可 Markdown 往返的按钮，已删除；不要再写回功能清单'],
    ['Underline', 'StarterKit 里已显式 `underline: false`，技术栈表不该再列它']
  ]
  const hits = forbidden.filter(([word]) => body.includes(word)).map(([w, why]) => `${w} —— ${why}`)
  assert.deepEqual(hits, [], 'README 的正文里出现已移除功能的声明：\n' + hits.join('\n'))
})

test('文档里引用的仓库路径都存在（README / 手册 / 台账）', () => {
  // 为什么**不含 CHANGELOG.md**：它是追加式历史记录，每条都描述"当时"的状态，
  // 里面出现后来被删掉的文件名是正确的（例如 `_verify-export-fix.js`）。
  // 这里只查"活文档"——README / 手册 / 台账——它们描述的是**现在**。
  //
  // ⚠️ 手册按章拆到 `docs/manual/*.md` 之后（清单 §2.H），活文档的集合变成「索引 + 各章」：
  // 只扫索引会漏掉各章里引用的路径，所以这里把 `docs/manual/` 下的分片**一起**扫。
  const docs = [
    'README.md',
    'docs/typora-wysiwyg-manual.md',
    'docs/optimization-program.md',
    // 逐条记录桌面评审报告各项处理状态的活台账（波次 1 = 2026-10-04）
    'docs/optimization-waves.md',
    ...readdirSync(join(ROOT, 'docs/manual'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => `docs/manual/${f}`),
    /**
     * `docs/_audit/` 也纳入（报告 §6.2 P1）：这几份是**历史快照**，此前不在任何文档门禁的
     * 扫描域里 —— 于是 `coverage-matrix.md` 里"默认矩阵 21 个 / `tools/verify-tiptap.js`
     * 1473 行"这类早已作废的说法一直没人拦（那个文件其实已经删了）。
     * 路径引用会随代码演进而失效，让它们至少在"指向的文件还在不在"这一层受同样的约束。
     * ⚠️ 历史快照里"当时存在、后来删了"的路径是**正常**的：本文件的行内豁免
     * （`删除/已删/移除/不存在`）就是给它们准备的通道。
     */
    ...readdirSync(join(ROOT, 'docs/_audit'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => `docs/_audit/${f}`)
  ]
  // 只认「以仓库根为起点、带已知扩展名」的引用，避免把叙述性名字当路径。
  // ⚠️ 结尾必须有 `\b`：否则 `...zh-CN.json` 会被 `\.js` 抢先匹配成 `...zh-CN.js`
  //（踩过：`js` 在交替里排在 `json` 前面，正则回溯后恰好命中前缀）。
  const re =
    /(?:src|tools|tests|docs|resources|build)\/[\w./@-]+\.(?:json|mjs|css|vue|ts|js|md|ico|png|plist|nsh|yml)\b/g
  /**
   * 解析口径要宽容：文档里常写 `renderer/src/xxx`（相对 `src/`）或 `src/lib/xxx`（相对
   * `src/renderer/src/`）这类简写 —— 只要**在任一约定根下存在**就算通过，不去猜作者的原意。
   */
  const resolve = (p) =>
    [p, `src/renderer/${p}`, `src/main/${p}`, `src/${p}`, `src/renderer/src/${p}`].some((c) =>
      existsSync(join(ROOT, c))
    )
  const missing = []
  /**
   * `docs/_audit/` 里的**已知历史路径**（报告 §6.2 P1）。
   *
   * 这几份是当时的快照：里面提到的文件后来被删/改了名，**在当时是对的**。
   * 逐条登记而不是整目录豁免 —— 这样"快照里新出现的失效路径"仍然会被拦下
   * （纳入扫描域的第一轮就抓到下面这三条，正是这个门禁的价值）。
   */
  const AUDIT_ALLOW = new Map([
    [
      'docs/_audit/coverage-matrix.md → tools/verify-tiptap.js',
      '该总套件已删除（拆进 harness 与 _verify-* 套件）'
    ],
    ['docs/_audit/lumin-lighter-audit.md → tools/verify-tiptap.js', '同上'],
    [
      'docs/_audit/ui-inventory.md → src/starter-kit.ts',
      '该文件从未存在于仓根（当时写的是包内路径 @tiptap/starter-kit）'
    ]
  ])
  for (const doc of docs) {
    const seen = new Set()
    read(doc)
      .split('\n')
      // 明说「已删除 / 已移除 / 下面这些不存在」的行属于历史说明，不该判红
      .filter((l) => !/删除|已删|移除|不存在/.test(l))
      .forEach((line) => {
        for (const m of line.matchAll(re)) {
          const p = m[0]
          if (seen.has(p)) continue
          seen.add(p)
          if (AUDIT_ALLOW.has(`${doc} → ${p}`)) continue
          if (!resolve(p)) missing.push(`${doc} → ${p}`)
        }
      })
  }
  assert.deepEqual(
    missing,
    [],
    '文档引用了不存在的路径（改名/删除后忘了同步）：\n' + missing.join('\n')
  )
})

test('README「已知限制与路线」表：每条声明都要能落到代码或写出阻塞原因（审计 §10 P2）', () => {
  /**
   * 审计 §10 P2 的缺口原文：「文档一致性门禁存在，但只查『禁词 + 路径存在性』……
   * 它**不检查"功能清单/已知限制"与实现是否一致**」，并点名 README 曾把已实现的查找替换
   * 写成「菜单里有入口，点了提示功能待接入」（低报也是失真）。
   *
   * 这里不试图理解自然语言，只钉两条**可判定**的规则（"宁可少查、不可乱红"）：
   *   ① 标了 ✅ / ⚠️ 的行必须至少引用一个**存在的**仓库路径（= 有声明的代码证据）；
   *   ② 标了 ❌ / ⛔ 的行"计划"列不许为空（= 说清卡在哪，而不是留一个 ❌ 就走）。
   * 表格按行解析时会先合并跨行的单元格（README 里有两行是折行的）。
   */
  const lines = read('README.md').split('\n')
  const start = lines.findIndex((l) => /^##\s+已知限制/.test(l))
  assert.ok(start > 0, 'README 里找不到「已知限制与路线」章节')
  /** 把续行并进上一条表格行（表格行以 `|` 开头） */
  const rows = []
  for (let i = start; i < lines.length; i += 1) {
    const l = lines[i]
    if (/^##\s/.test(l) && i !== start) break
    if (/^\|/.test(l)) rows.push(l)
    else if (rows.length && l.trim() && !/^\|/.test(l)) rows[rows.length - 1] += ' ' + l.trim()
  }
  const body = rows.filter((r) => !/^\|\s*-{2,}/.test(r) && !/\|\s*项\s*\|/.test(r))
  assert.ok(body.length >= 8, `只解析到 ${body.length} 条限制，解析口径可能不对`)

  /**
   * 路径识别比上一条宽容：README 里常写相对简写（`lib/treeFocus.ts`、`shared/history.ts`），
   * 只要在任一约定根下存在就算"落到了代码"（不逼着作者把每个引用都写全）。
   */
  const pathRe =
    /(?:src|tools|tests|docs|resources|build|lib|components|stores|composables|assets|views|shared|services)\/[\w./@-]+\.(?:json|mjs|css|vue|ts|js|md|ico|png|plist|nsh|yml)\b/g
  const resolve = (p) =>
    [p, `src/renderer/${p}`, `src/main/${p}`, `src/${p}`, `src/renderer/src/${p}`].some((c) =>
      existsSync(join(ROOT, c))
    )
  const problems = []
  for (const row of body) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length < 3) continue
    const [item, status, plan] = cells
    const done = /✅|⚠️/.test(status)
    const notDone = /❌|⛔/.test(status)
    /**
     * ⚠️ 对外 README **刻意不提源码**（本仓库只发布安装包：源码不开源、另行授权）⇒
     * 这里**不再强制** ✅/⚠️ 行引用仓库路径；但只要它引用了，就必须真的存在
     * （避免文档里出现一个不存在的文件，把人指到空处）。
     */
    if (done) {
      const refs = [...status.matchAll(pathRe)].map((m) => m[0])
      for (const r of refs) {
        if (!resolve(r)) problems.push(`「${item}」引用的路径不存在：${r}`)
      }
    }
    if (notDone && !plan) problems.push(`「${item}」标了未实现，却没写清卡在哪（计划列为空）`)
  }
  assert.deepEqual(problems, [], 'README 功能清单与实现/阻塞原因对不上：\n' + problems.join('\n'))
})

test('i18n 三语包的键数一致（既有口径，这里再钉一次）', () => {
  const flat = (o, p = '') =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]
    )
  const packs = ['zh-CN', 'en-US', 'ru-RU'].map((l) => ({
    l,
    keys: flat(JSON.parse(read(`src/shared/i18n/${l}.json`))).sort()
  }))
  assert.deepEqual(packs[1].keys, packs[0].keys, 'en-US 与 zh-CN 的键必须完全一致')
  assert.deepEqual(packs[2].keys, packs[0].keys, 'ru-RU 与 zh-CN 的键必须完全一致')
})
