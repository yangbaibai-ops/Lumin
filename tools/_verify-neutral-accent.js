'use strict'
// ─── 验收：副色改中性灰 + 文字选区走浏览器默认 ──────────────────────────────────
//
// 用户口径（本轮）：
//   · 副色（accent）原来以紫色为主 ⇒ 改成**浅灰为主**，像主流编辑器那样靠明度差不靠色相；
//   · 选中文字的颜色「用默认颜色即可，无需紫色」。
//
// 判据一律量**关系/性质**，不钉死具体色值（调令牌不该让这条套件红，只有意图真塌了才该红）：
//   N1 三主题的 accent 家族都是**低饱和灰**（通道极差 ≤ 24）——「灰」的可计算定义；
//   N2 三主题都不再出现旧的紫色（回归守卫：直接点名那六个历史色值）；
//   N3 `--accent-soft` 药丸压在纸 / 外壳上都还看得见（≥1.05:1）——
//      灰淡底比彩色淡底更容易「糊进底里」，这条是改灰之后最需要守的关系；
//   N4 `--sel`（自绘淡底，查找命中）对纸仍可辨（≥1.1:1）；
//   N5 **正文文字选区没有 author 规则**（`::selection` 一条都不留，只剩 PM 的 hideselection）
//      ⇒ 选区颜色 = 浏览器默认；
//   N6 插入符（caret-color）跟正文色（--ink）一致，不是高亮色；
//   N7 链接仍是蓝色且与副色不同（灰副色下链接不能跟着变灰）；
//   N8 主按钮：按钮文字对按钮底色的对比度 ≥ 4.5:1（三主题；这正是把按钮令牌与副色解耦的原因）；
//   N9 代码高亮的两档结构色是**蓝色系**（b ≥ r 且 b > g）且仍有色相（极差 ≥ 20）——
//      副色变灰之后若沿用副色，关键字会与正文糊在一起；
//   N10 **标记符墨色**（`**` / `*` / `~~` / `` ` `` 的源码符号）：实测 `.md-marker` 显形后的字色
//      = `--marker`，且比 `--ink-3` **更淡**、也比副色更淡（1.6–4.5:1 之间仍看得见）——
//      用户口径「像是加粗 ** 这种符号的颜色改为再浅一点的灰色」。
//
// 跑法：node tools/_verify-neutral-accent.js（先起隔离实例）
const { connect, settle, waitEditor, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')
const { contrast, over, parseColor, rgbText, rat, sameColor } = require('./lib/color')

/** 历史紫色值（浅色/深色/羊皮纸三套里的全部紫）：出现即回归失败 */
const OLD_PURPLE = ['#6366f1', '#8b5cf6', '#4338ca', '#818cf8', '#a78bfa', '#c7d2fe']

const PROBE = `(() => {
  const root = getComputedStyle(document.documentElement)
  const tok = (n) => root.getPropertyValue(n).trim()
  const rgba = (n) => {
    const d = document.createElement('div')
    d.style.color = tok(n) || 'transparent'
    document.body.appendChild(d)
    const v = getComputedStyle(d).color
    d.remove()
    return v
  }
  // 所有 author 样式表里的 ::selection 规则（改主题不影响，量一次就够）
  const sels = []
  for (const sheet of document.styleSheets) {
    let rules = null
    try { rules = sheet.cssRules } catch (e) { continue }
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules && r.cssRules.length) { walk(r.cssRules); continue }
        if (r.selectorText && /::selection/i.test(r.selectorText)) {
          sels.push({ sel: r.selectorText, css: (r.style && r.style.cssText) || '' })
        }
      }
    }
    walk(rules)
  }
  const editor = document.querySelector('.editor-content .ProseMirror')
  const source = document.querySelector('textarea.source-editor')
  const link = document.querySelector('.md-preview a')
  const btn = document.querySelector('.btn-primary')
  const hljs = document.querySelector('.md-preview code.hljs, .md-preview pre code, .md-preview .cm-content')
  return JSON.stringify({
    theme: [...document.documentElement.classList].find((c) => c.startsWith('theme-')) || null,
    tokens: {
      paper: tok('--paper'), app: tok('--app'),
      accent: tok('--accent'), accent2: tok('--accent-2'), accentInk: tok('--accent-ink'),
      accentSoft: rgba('--accent-soft'), sel: rgba('--sel'),
      link: tok('--link'), tocLink: tok('--toc-link'),
      btnSolid: tok('--btn-solid'), btnInk: tok('--btn-ink'),
      codeKey: tok('--code-key'), codeKey2: tok('--code-key-2'),
      ink: tok('--ink')
    },
    caret: editor ? getComputedStyle(editor).caretColor : null,
    caretSource: source ? getComputedStyle(source).caretColor : null,
    linkColor: link ? getComputedStyle(link).color : null,
    btnBg: btn ? getComputedStyle(btn).backgroundImage : null,
    btnColor: btn ? getComputedStyle(btn).color : null,
    hasHljs: !!hljs,
    selectionRules: sels
  })
})()`

const chan = (c) => {
  const p = parseColor(c)
  if (!p) return null
  return { r: Math.round(p.r), g: Math.round(p.g), b: Math.round(p.b), a: p.a }
}
/** 通道极差 = 「有多彩」的可计算定义（纯灰为 0） */
const spread = (c) => {
  const p = chan(c)
  return p ? Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b) : NaN
}
/**
 * 「灰」的判据两条：
 *   1) 通道极差 ≤ 40（≈ 12% 饱和度上限）—— 暖灰 / 冷灰都算灰，真彩色（琥珀、绿、紫）远大于它；
 *   2) **不是紫/品红**：紫的特征是红与蓝**都**高于绿（`#6366f1` 这种靛紫也满足 b 远高于 g），
 *      而暖灰是 r>g>b、冷灰是 b>g>r，两者都不会「红蓝同时压过绿」。
 * 不钉死具体色值：调灰的深浅不该让这条红。
 */
const isGray = (c) => {
  const p = chan(c)
  if (!p) return false
  return spread(c) <= 40 && !(p.r > p.g + 6 && p.b > p.g + 6)
}

async function main() {
  const report = new Reporter('验收：副色中性灰 + 选区走默认')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const { ev } = app
  const rows = []

  try {
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(400)
    for (const th of ['light', 'dark', 'sepia']) {
      await ev(`(async () => { await window.__L.settings().setTheme(${JSON.stringify(th)}); return 'ok' })()`)
      await sleep(700)
      const m = JSON.parse(await ev(PROBE))
      rows.push(m)
      console.log(
        `${th} accent=${rgbText(m.tokens.accent)}(${spread(m.tokens.accent)}) ` +
          `accent2=${rgbText(m.tokens.accent2)}(${spread(m.tokens.accent2)}) ` +
          `accentInk=${rgbText(m.tokens.accentInk)}(${spread(m.tokens.accentInk)}) ` +
          `link=${rgbText(m.tokens.link)} caret=${rgbText(m.caret)} 按钮底=${m.tokens.btnSolid}/字=${m.tokens.btnInk}`
      )
      console.log(`      selection 规则 ${JSON.stringify(m.selectionRules)}`)
    }
    const fmt = (fn) => rows.map((r) => `${r.theme}: ${fn(r)}`).join(' | ')

    // ── N1 副色是灰 ──
    report.check(
      'N1 三主题的副色家族都是灰（通道极差 ≤ 40 且不是紫/品红）',
      rows.every(
        (r) =>
          isGray(r.tokens.accent) && isGray(r.tokens.accent2) && isGray(r.tokens.accentInk)
      ),
      fmt((r) => `accent 极差=${spread(r.tokens.accent)} accent2=${spread(r.tokens.accent2)} ink=${spread(r.tokens.accentInk)}`)
    )

    // ── N2 不再出现历史紫色 ──
    const purpleHit = []
    for (const r of rows) {
      for (const [k, v] of Object.entries(r.tokens)) {
        const t = String(v).replace(/\s+/g, '').toLowerCase()
        for (const p of OLD_PURPLE) {
          // 令牌值可能是 #xxxxxx，也可能是 rgba() 形式：两种都比一遍
          const p2 = parseColor(p)
          if (t === p || t.includes(`${p2.r},${p2.g},${p2.b}`)) purpleHit.push(`${r.theme}.${k}=${v}`)
        }
      }
    }
    report.check(
      'N2 三主题令牌里不再出现任何历史紫色值',
      purpleHit.length === 0,
      purpleHit.length ? JSON.stringify(purpleHit) : 'none'
    )

    // ── N3/N4 灰淡底仍然看得见 ──
    const pill = rows.map((r) => ({
      theme: r.theme,
      onPaper: contrast(over(r.tokens.accentSoft, r.tokens.paper), r.tokens.paper),
      onChrome: contrast(over(r.tokens.accentSoft, r.tokens.app), r.tokens.app),
      sel: contrast(over(r.tokens.sel, r.tokens.paper), r.tokens.paper)
    }))
    report.check(
      'N3 选中淡底（accent-soft）压在纸 / 外壳上都可辨（≥1.05:1）',
      pill.every((p) => p.onPaper >= 1.05 && p.onChrome >= 1.05),
      pill.map((p) => `${p.theme} 纸=${rat(p.onPaper)} 壳=${rat(p.onChrome)}`).join(' | ')
    )
    report.check(
      'N4 自绘淡底（--sel，查找命中）对纸可辨（≥1.1:1）',
      pill.every((p) => p.sel >= 1.1),
      pill.map((p) => `${p.theme} ${rat(p.sel)}:1`).join(' | ')
    )

    // ── N5 文字选区没有 author 规则 ──
    // 允许列表里只剩 prosemirror-view 运行时注入的 `.ProseMirror-hideselection`
    // （它只是把选区**藏起来**，不改颜色语义）。任何别的作者规则都会盖掉浏览器默认选区色 ⇒ 失败。
    // 第二十五轮起连 `.code-edit-input::selection` 也删了：那条守的是已被 CodeMirror 取代的
    // 「透明 textarea + 高亮层」旧架构，是死码。
    const rules = rows[0].selectionRules || []
    const allowed = (s) => /ProseMirror-hideselection/.test(s)
    const bad = rules.filter((r) => !allowed(r.sel))
    report.check(
      'N5 正文文字选区**没有** author `::selection` 规则（只剩 PM 的 hideselection）',
      bad.length === 0,
      JSON.stringify(rules)
    )

    // ── N6 插入符跟随正文色 ──
    report.check(
      'N6 插入符颜色 = 正文色 --ink（编辑器 + 源码面两处）',
      rows.every(
        (r) =>
          sameColor(r.caret, r.tokens.ink) &&
          (!r.caretSource || sameColor(r.caretSource, r.tokens.ink))
      ),
      fmt((r) => `caret=${rgbText(r.caret)} ink=${rgbText(r.tokens.ink)} 源码面=${rgbText(r.caretSource)}`)
    )

    // ── N7 链接仍是蓝的、且与副色不同 ──
    report.check(
      'N7 链接是蓝色（b ≥ r 且 b > g）且与副色不是同一个色',
      rows.every((r) => {
        const l = chan(r.linkColor || r.tokens.link)
        const a = chan(r.tokens.accent)
        return l && l.b >= l.r && l.b > l.g && l.b - l.g >= 40 && !(l.r === a.r && l.g === a.g && l.b === a.b)
      }),
      fmt((r) => `link=${rgbText(r.linkColor || r.tokens.link)} accent=${rgbText(r.tokens.accent)}`)
    )

    // ── N8 主按钮可读 ──
    const btnRows = rows.map((r) => ({
      theme: r.theme,
      c: contrast(r.tokens.btnInk, r.tokens.btnSolid)
    }))
    report.check(
      'N8 主按钮：按钮文字对按钮底色对比度 ≥ 4.5:1（三主题）',
      btnRows.every((b) => b.c >= 4.5),
      btnRows.map((b) => `${b.theme} ${rat(b.c)}:1`).join(' | ')
    )

    // ── N9 代码结构色仍是蓝色系 ──
    report.check(
      'N9 代码高亮结构色是蓝色系（b ≥ r、b > g、极差 ≥ 20），不与正文灰混淆',
      rows.every((r) => {
        const a = chan(r.tokens.codeKey)
        const b = chan(r.tokens.codeKey2)
        const blue = (c) => c && c.b >= c.r && c.b > c.g && c.b - c.g >= 20
        return blue(a) && blue(b)
      }),
      fmt((r) => `key=${rgbText(r.tokens.codeKey)} key2=${rgbText(r.tokens.codeKey2)}`)
    )

    // ── N10 标记符墨色（`**` 这类源码符号）──
    // 必须让标记**真的显形**才量得到字色：把光标放进加粗构造内部。
    const MARKS = `(() => {
      const ed = window.__L.ed()
      let pos = -1
      ed.state.doc.descendants((n, p) => {
        if (pos < 0 && n.isText && n.text && n.text.includes('加粗的字')) pos = p + 1
      })
      if (pos > 0) ed.chain().setTextSelection(pos).run()
      const root = getComputedStyle(document.documentElement)
      const tok = (n) => root.getPropertyValue(n).trim()
      const resolve = (n) => {
        const d = document.createElement('div')
        d.style.color = n
        document.body.appendChild(d)
        const v = getComputedStyle(d).color
        d.remove()
        return v
      }
      const marks = [...document.querySelectorAll('.ProseMirror .md-marker')]
      const shown = marks.filter((x) => parseFloat(getComputedStyle(x).fontSize) > 0)
      return JSON.stringify({
        theme: [...document.documentElement.classList].find((c) => c.startsWith('theme-')),
        marker: tok('--marker'),
        markerRgb: shown.length ? getComputedStyle(shown[0]).color : null,
        shown: shown.length,
        paper: resolve('var(--paper)'),
        ink3: resolve('var(--ink-3)'),
        accent: resolve('var(--accent)')
      })
    })()`
    const markRows = []
    for (const th of ['light', 'dark', 'sepia']) {
      await ev(`(async () => { await window.__L.settings().setTheme(${JSON.stringify(th)}); return 'ok' })()`)
      await sleep(500)
      await openDocWith(app, '普通文字 **加粗的字** 尾部。\n', `marker-tone-${th}.md`)
      await waitEditor(ev)
      await sleep(1000)
      const m = JSON.parse(await ev(MARKS))
      await sleep(400)
      const after = JSON.parse(await ev(MARKS))
      markRows.push(after.shown >= 2 ? after : m)
      console.log(
        `marker ${th} token=${rgbText(m.marker)} 实测=${rgbText(after.markerRgb)} 显形=${after.shown} ` +
          `标记/纸=${rat(contrast(after.markerRgb || m.marker, after.paper))}:1 ` +
          `ink3/纸=${rat(contrast(after.ink3, after.paper))}:1 accent/纸=${rat(contrast(after.accent, after.paper))}:1`
      )
    }
    const markOk = markRows.every((r) => {
      const cm = contrast(r.markerRgb || r.marker, r.paper)
      return (
        r.shown >= 2 &&
        sameColor(r.marker, r.markerRgb) &&
        cm < contrast(r.ink3, r.paper) &&
        cm < contrast(r.accent, r.paper) &&
        cm >= 1.6 &&
        cm <= 4.5
      )
    })
    report.check(
      'N10 标记符（`**`）墨色 = --marker，且比 --ink-3 更淡、比副色更淡（1.6–4.5:1 仍看得见）',
      markOk,
      markRows
        .map(
          (r) =>
            `${r.theme} ${rat(contrast(r.markerRgb || r.marker, r.paper))}:1（ink3 ${rat(contrast(r.ink3, r.paper))}:1 副色 ${rat(contrast(r.accent, r.paper))}:1）`
        )
        .join(' | ')
    )

    // ── 收尾：恢复原主题 ──
    await ev(`(async () => { await window.__L.settings().setTheme('light'); return 'ok' })()`)
    await sleep(300)
  } catch (err) {
    report.skip('suite-error', String(err && err.message))
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
