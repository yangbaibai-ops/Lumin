// 界面上「用户看得见的中文」是否都走了语言包（静态）。
//
// 为什么需要这条（审计 §10「i18n：键对齐被守住了，但『键有没有被用』与『界面有没有绕过键』是空的」）：
//   三份语言包键集合一致、无空串、en/ru 无 CJK 残留 —— 这些门禁都在，但**没有任何一条**
//   拦得住「组件里直接写死中文」。于是 en/ru 用户打开设置页会看到整页中文，而 CI 全绿。
//   实测最集中的地方是 SettingsDialog.vue（同文件里既有 55 处 t('…')、又有几十处硬编码）。
//
// 判定分两路（扫描器在 `tests/lib/hardcodedTextScan.mjs`）：
//   ① 脚本里的**字符串字面量**含中日韩字符（`.ts` / `.vue` 的 `<script>`）；
//   ② `.vue` 模板里的**文本节点 / 属性值**含中日韩字符，且不在 `t(…)` / `$t(…)` 里。
//   注释一律先剥掉（注释里的中文是文档，不是界面）。
//
// 合法的中文（语言自称、语言代码…）走白名单，**每一条都要写理由**，且白名单只应缩小。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CJK,
  SRC,
  codeOf,
  scanHardcodedEnglish,
  scanHardcodedText,
  stringsOf,
  templateCjk,
  templateEnglishAttrs,
  templateEnglishText,
  walk
} from './lib/hardcodedTextScan.mjs'

test('扫描器自证：注释与正则里的引号都不能让它跑偏', () => {
  const sample = `
    // 注释里的中文：'中文'
    /* 块注释里的中文 */
    const re = /['"]/g
    const re2 = /[^\\w\\u4e00-\\u9fff]+/g
    const a = '中文文案'
    const b = "ascii only"
    const c = \`模板 \${'中文'} 里面\`
    function f() { return /[*~\`'"]/.test(s) }
  `
  const lits = stringsOf(sample).filter((l) => CJK.test(l.text))
  const texts = lits.map((l) => l.text)
  assert.ok(
    texts.some((t) => t.includes('中文文案')),
    `应捞到字符串里的中文：${JSON.stringify(texts)}`
  )
  assert.ok(
    texts.some((t) => t.includes('模板')),
    `应捞到模板串里的中文：${JSON.stringify(texts)}`
  )
  assert.ok(
    !texts.some((t) => t.includes('注释里的中文')),
    `注释里的中文不该被算：${JSON.stringify(texts)}`
  )
  assert.ok(
    lits.every((l) => l.kind === 'string'),
    `正则字面量不该被当成字符串：${JSON.stringify(lits)}`
  )
  assert.ok(!codeOf(sample).includes('注释里的中文'), 'stripComments 后不该残留注释正文')

  // 行号：报错要能直接定位，所以多行注释/多行模板串之后的行号也必须对得上
  const numbered = `
/* 第一行注释
   第二行注释
   第三行注释 */
const ok = 'ascii'
const bad = '中文第 6 行'
`
  const [lit] = stringsOf(numbered).filter((l) => CJK.test(l.text))
  assert.equal(lit.line, 6, `行号应为 6，实际 ${lit.line}`)
})

test('扫描器自证：模板里的文本/属性/插值', () => {
  const tpl = `
    <!-- <h1>注释里的中文</h1> -->
    <h1>界面标题</h1>
    <p>{{ t('a.b') }}</p>
    <p>
      {{
        '硬编码多行'
      }}
    </p>
    <input
      class="a b c"
      placeholder="多行标签里的占位"
    />
    <input :placeholder="t('x.y')" />
    <p title="中文标题">ok</p>
  `
  const found = templateCjk(tpl)
  const texts = found.map((f) => f.text)
  assert.ok(
    texts.some((t) => t.includes('界面标题')),
    '文本节点里的中文必须被捞到'
  )
  assert.ok(
    texts.some((t) => t.includes('硬编码多行')),
    '插值里的硬编码中文必须被捞到'
  )
  assert.ok(
    texts.some((t) => t.includes('多行标签里的占位')),
    '属性值里的中文必须被捞到'
  )
  assert.ok(
    texts.some((t) => t.includes('中文标题')),
    'HTML 属性值里的中文必须被捞到'
  )
  assert.ok(!texts.some((t) => t.includes('注释里的中文')), '注释里的中文不该被算')
  assert.ok(!texts.some((t) => t.includes('a.b')), "t('…') 不该被判成硬编码")
  assert.equal(found.length, 4, `应恰好 4 处：${JSON.stringify(texts)}`)
  // 行号：跨行的注释/标签/插值都要计数，否则报错位置会一路偏
  const lineOf = (needle) => found.find((f) => f.text.includes(needle))?.line
  assert.equal(lineOf('界面标题'), 3, `界面标题 应在第 3 行，实际 ${lineOf('界面标题')}`)
  assert.equal(lineOf('硬编码多行'), 6, `插值应在第 6 行，实际 ${lineOf('硬编码多行')}`)
  assert.equal(
    lineOf('多行标签里的占位'),
    10,
    `多行标签属性应在第 10 行（标签起行），实际 ${lineOf('多行标签里的占位')}`
  )
})

test('扫描器真的覆盖到 src（不能空扫通过）', () => {
  const offenders = scanHardcodedText()
  assert.ok(offenders.length < 400, `疑似扫错（一次报出 ${offenders.length} 处），先检查扫描器`)
  // 清单清零之后"必须有 offender"这条会永远红，所以空扫的防线改用另外两条：
  // ① 确实走到了足够多的 .vue；② 把真实模板喂给 templateCjk，必须能捞出中文。
  const vueFiles = walk(SRC).filter((f) => f.endsWith('.vue'))
  assert.ok(vueFiles.length >= 20, `只走到 ${vueFiles.length} 个 .vue，walk() 可能写错了`)
  const probe = readFileSync(join(SRC, 'renderer/src/components/TreeNode.vue'), 'utf-8')
  const tpl = probe.match(/<template>([\s\S]*)<\/template>/)[1].replace(/<!--[\s\S]*?-->/g, '')
  const found = templateCjk(`${tpl}\n<span>未接线的中文</span>`)
  assert.ok(
    found.some((o) => o.text.includes('未接线的中文')),
    'templateCjk 在真实模板上没认出中文，模板那一半可能失效了'
  )
})

test('界面文案不硬编码中文：新增的必须走语言包（白名单只应缩小）', () => {
  const offenders = scanHardcodedText()
  const lines = offenders.map((o) => `${o.rel}:${o.line} [${o.kind}] ${o.text}`)
  assert.deepEqual(
    offenders.map((o) => o.rel),
    [],
    `以下位置绕过了语言包（应改成 t('…') 或登记进白名单并写明理由），共 ${offenders.length} 处：\n${lines.join('\n')}`
  )
})

/**
 * ─── 英文硬编码（报告 §5.4 P2-2）──────────────────────────────────────────────
 *
 * CJK 扫描器只能抓中文 —— 本该走语言包的**英文**整片漏网。实测的两处：
 *   ① `StatusBar.vue` 状态栏标语（纯英文文本节点，en/ru 用户看到的是"没翻译的中文产品"）；
 *   ② `ContextMenu.vue` 二级菜单的 `aria-label="submenu"`（读屏器直接念字面量）。
 * 这一路只扫**用户看得见/听得见**的地方：模板文本节点里 ≥3 个单词的英文句子，
 * 以及 `aria-label`/`title`/`placeholder`/`alt` 属性值里的英文（未绑定的）。
 * 刻意不扫 `class`/`id`/变量名 —— 那些不是界面文案（第一版扫了，一次报出两百多条假阳性）。
 */
const ALLOW_EN = [
  {
    // 导出格式名是专有名词（PDF/HTML/Word/EPUB 在三种语言里都这么写），不需要翻译
    match: 'PDF · HTML · Word · EPUB',
    why: '导出格式专有名词，三语一致'
  }
]

test('界面文案不硬编码英文：文本节点与可见属性（白名单只应缩小）', () => {
  const offenders = scanHardcodedEnglish().filter(
    (o) => !ALLOW_EN.some((a) => o.text.includes(a.match))
  )
  const lines = offenders.map((o) => `${o.rel}:${o.line} [${o.kind}] ${o.text}`)
  assert.deepEqual(
    offenders.map((o) => o.rel),
    [],
    `以下位置把用户可见的英文写死在模板里（应改成 t('…')，或登记进 ALLOW_EN 并写明理由），共 ${offenders.length} 处：\n${lines.join('\n')}`
  )
})

test('英文扫描器自证：认得出真信号，也不把 class 列表当文案', () => {
  const tpl = `
<template>
  <div>
    <span v-if="!x">Lumin — Write in Light.</span>
    <button aria-label="submenu" />
    <div
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui"
      :class="cond ? 'a b c' : 'd e f'"
      @click="run($event)"
    >
      <span>{{ t('x.y') }}</span>
      <span :title="label">ok</span>
    </div>
  </div>
</template>`
  const attrOffenders = templateEnglishAttrs(tpl)
  const textOffenders = templateEnglishText(tpl)
  assert.deepEqual(
    attrOffenders.map((o) => o.text),
    ['aria-label="submenu"'],
    `属性扫描应只报 submenu：${JSON.stringify(attrOffenders)}`
  )
  assert.deepEqual(
    textOffenders.map((o) => o.text),
    ['Lumin — Write in Light.'],
    `文本扫描应只报标语（class 续行/插值/绑定属性都不算）：${JSON.stringify(textOffenders)}`
  )
})
