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
import { readFileSync, existsSync } from 'node:fs'
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
  const docs = ['README.md', 'docs/typora-wysiwyg-manual.md', 'docs/optimization-program.md']
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
