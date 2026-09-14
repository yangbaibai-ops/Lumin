// 验收：工具栏「代码块」按钮的悬停小选项（开启/关闭行号）
// A. 悬停按钮 ~300ms → 按钮下方弹出小选项；弹层里的 switch 与设置项同源（默认开）
// B. 指针从按钮移入弹层（跨 8px 空隙）弹层不消失；离开超过宽限才收起；点击外部立即收起
// C. 弹层里真实点击 → 行号槽消失 / 恢复，switch 与 title 同步，且持久化到 SQLite
// D. 主操作不受影响：直接点按钮 → 插入/取消代码块（弹层是否展开都一样）
// E. 窄窗口下弹层被钳制在视口内
// 建议 NEW_WINDOW=1：在当前 app 里另开窗口跑，完全不碰用户窗口
const CDP = 'http://127.0.0.1:9222/json'
let ws,
  id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(m, p) {
  return new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails)
    throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
async function moveTo(x, y, wait = 20) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    button: 'none',
    buttons: 0
  })
  await sleep(wait)
}
async function clickAt(x, y, wait = 500) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(40)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(wait)
}
/** 把指针挪到按钮上并等弹层出现。
 * 必须先移到别处：点击其它位置（mousePressed）不会改变悬停目标，
 * 若指针「本来就在按钮上」，再 move 到同一坐标不会触发 mouseenter，弹层不会重开。
 * 落点必须在编辑区：侧边栏宽 305px，x=200 会点到文件树（会切走当前文档）。 */
const PARK = { x: 620, y: 320 }
async function hoverButton(btn, wait = 700) {
  await moveTo(PARK.x, PARK.y, 150)
  await moveTo(btn.x, btn.y, wait)
}
const MD = [
  '# 代码块按钮验收',
  '',
  '```js',
  'const a = 1',
  'const b = 2',
  'const c = 3',
  '```',
  '',
  '尾段'
].join('\n')

/** 按钮 / 弹层 / 行号槽状态；期望文案取自页面 i18n，避免绑死某一种语言。
 * 按钮优先按 title 现找；全局 tooltip 会在悬停时临时移除 title 属性
 * （lib/tooltip.ts 的 removeAttribute），此时退回上一次找到的元素（仍在文档里就用）。 */
const STATE = `(() => {
  const T = (k) => document.querySelector('#app').__vue_app__.config.globalProperties.$t(k)
  let btn = Array.from(document.querySelectorAll('.icon-btn')).find((b) => b.title === T('editor.codeBlock'))
  if (!btn && window.__cbBtn && document.contains(window.__cbBtn)) btn = window.__cbBtn
  if (btn) window.__cbBtn = btn
  const pop = document.querySelector('.code-block-popover')
  const sw = pop?.querySelector('button[role="switch"]')
  const nums = document.querySelector('.cm-lineNumbers')
  const visible = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).filter((e) => {
    const cs = getComputedStyle(e)
    return cs.visibility !== 'hidden' && e.getBoundingClientRect().height > 0
  })
  const r = btn?.getBoundingClientRect()
  const pr = pop?.getBoundingClientRect()
  return JSON.stringify({
    btn: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) } : null,
    pop: pr ? { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + pr.height / 2), left: Math.round(pr.left), right: Math.round(pr.right), top: Math.round(pr.top), bottom: Math.round(pr.bottom), w: Math.round(pr.width) } : null,
    popLabel: sw?.querySelector('span')?.textContent?.trim() ?? null,
    popAction: sw?.getAttribute('aria-label') ?? null,
    popHasTitle: sw ? sw.hasAttribute('title') : null,
    popSwitchOn: sw ? (sw.querySelector('.switch')?.classList.contains('on') ?? null) : null,
    ariaChecked: sw?.getAttribute('aria-checked') ?? null,
    wantLabel: T('editor.codeLineNumbers'),
    wantTitleOn: T('editor.lineNumbersOn'),
    wantTitleOff: T('editor.lineNumbersOff'),
    setting: window.__vt.settings().codeLineNumbers,
    numbers: visible.map((e) => e.textContent.trim()).filter(Boolean),
    hasGutter: !!nums,
    codeBlocks: (() => { let n = 0; window.__vt.ed()?.state.doc.descendants((x) => { if (x.type.name === 'codeBlock') n++ }); return n })(),
    vw: window.innerWidth
  })
})()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  let page = targets.find((t) => t.type === 'page' && t.url.includes('5173'))
  if (!page) {
    console.log('NO-APP-PAGE')
    return
  }
  let tempWindow = null
  if (process.env.NEW_WINDOW === '1') {
    const opener = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      opener.onopen = res
      opener.onerror = rej
    })
    let oid = 0
    const opending = new Map()
    opener.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && opending.has(m.id)) {
        opending.get(m.id)(m)
        opending.delete(m.id)
      }
    }
    const osend = (method, params) =>
      new Promise((res) => {
        const i = ++oid
        opending.set(i, res)
        opener.send(JSON.stringify({ id: i, method, params }))
      })
    await osend('Runtime.evaluate', {
      expression: '(window.luminAPI.app.newWindow(), "ok")',
      returnByValue: true
    })
    const preexisting = new Set(
      targets.filter((t) => t.type === 'page' && t.url.includes('5173')).map((t) => t.id)
    )
    for (let i = 0; i < 60; i++) {
      await sleep(400)
      const list = await (await fetch(CDP)).json()
      const fresh = list.filter(
        (t) => t.type === 'page' && t.url.includes('5173') && !preexisting.has(t.id)
      )
      if (fresh.length) {
        page = fresh[fresh.length - 1]
        tempWindow = page
        break
      }
    }
    opener.close()
    if (!tempWindow) {
      console.log('SKIP: 第二个窗口未出现')
      return
    }
    console.log('（在第二个窗口里验收，用户窗口不受影响）')
  }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await send('Page.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)) === 'y') break
  }

  await ev(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const pinia = app._context.provides[sym] ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map) ?? Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s]).find((v) => v && typeof v === "object" && v._s instanceof Map)
    window.__vt = { ui: () => pinia._s.get('ui'), files: () => pinia._s.get('files'), settings: () => pinia._s.get('settings'), ed: () => pinia._s.get('editor')?.instance ?? null }
    return 'ok'
  })()`)
  await ev(
    `(() => { if (!location.hash.includes('/editor')) location.hash = '#/editor'; return 'ok' })()`
  )
  await sleep(400)

  const before = JSON.parse(
    await ev(
      `(() => { const f = window.__vt.files(); return JSON.stringify({ path: f.current?.path ?? null, dirty: !!f.dirty, lineNumbers: window.__vt.settings().codeLineNumbers }) })()`
    )
  )
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  if (before.dirty) {
    console.log('SKIP: 当前文档有未保存修改')
    if (tempWindow) await send('Page.close').catch(() => {})
    ws.close()
    return
  }
  console.log('BEFORE ' + JSON.stringify(before))

  await ev(
    `(async () => { const f = window.__vt.files(); if (f.current) await f.close(); await f.openUntitled(); return 'ok' })()`
  )
  await ev(
    `(async () => { for (let i = 0; i < 200 && !window.__vt.ed(); i++) await new Promise((r) => setTimeout(r, 20)); return 'ed' })()`
  )
  await ev(
    `(() => { window.__vt.files().setContent(${JSON.stringify(MD)}); window.__vt.ed().commands.setContent(${JSON.stringify(MD)}, { emitUpdate: false }); return 'ok' })()`
  )
  await ev(
    `(async () => { for (let i = 0; i < 200 && !document.querySelector('.cm-lineNumbers'); i++) await new Promise((r) => setTimeout(r, 25)); return 'cm' })()`
  )
  await sleep(600)

  const s0 = JSON.parse(await ev(STATE))
  console.log(
    'A0 ' +
      JSON.stringify({
        btn: s0.btn,
        pop: s0.pop,
        numbers: s0.numbers,
        setting: s0.setting,
        want: { label: s0.wantLabel, on: s0.wantTitleOn, off: s0.wantTitleOff }
      })
  )
  c('code-block-button-present', !!s0.btn, JSON.stringify(s0.btn))
  c('popover-hidden-before-hover', s0.pop === null)
  c(
    'setting-matches-before',
    s0.setting === before.lineNumbers,
    JSON.stringify({ now: s0.setting, before: before.lineNumbers })
  )
  // 行号槽状态必须与设置一致（设置默认开，但用户可能已关掉，因此不硬编码期望值）
  c(
    'gutter-matches-setting',
    s0.hasGutter === s0.setting &&
      (s0.setting ? s0.numbers.join(',') === '1,2,3' : s0.numbers.length === 0),
    JSON.stringify({ setting: s0.setting, numbers: s0.numbers })
  )

  // ── A. 悬停 ~300ms 弹出小选项 ────────────────────────────────────────────
  await hoverButton(s0.btn)
  const s1 = JSON.parse(await ev(STATE))
  console.log('A ' + JSON.stringify(s1.pop) + ' label=' + s1.popLabel + ' action=' + s1.popAction)
  c('hover-opens-popover', !!s1.pop, JSON.stringify(s1.pop))
  c(
    'popover-below-button',
    !!s1.pop && s1.pop.top >= s1.btn.bottom,
    JSON.stringify({ btnBottom: s1.btn.bottom, popTop: s1.pop && s1.pop.top })
  )
  c(
    'popover-in-viewport',
    !!s1.pop && s1.pop.left >= 0 && s1.pop.right <= s1.vw,
    JSON.stringify(s1.pop)
  )
  c(
    'popover-has-line-number-option',
    s1.popLabel === s1.wantLabel,
    'label=' + s1.popLabel + ' want=' + s1.wantLabel
  )
  c(
    'popover-switch-reflects-setting',
    s1.popSwitchOn === s1.setting && s1.ariaChecked === String(s1.setting),
    JSON.stringify({ setting: s1.setting, on: s1.popSwitchOn, aria: s1.ariaChecked })
  )
  const wantActionTitle = s1.setting ? s1.wantTitleOff : s1.wantTitleOn
  c(
    'popover-action-label-follows-state',
    s1.popAction === wantActionTitle,
    'aria-label=' + s1.popAction + ' want=' + wantActionTitle
  )
  // title 必须为空：全局 tooltip 会移除 title，若这里挂了随状态变化的 title 会互相打架
  c('popover-row-has-no-title', s1.popHasTitle === false, 'hasTitle=' + s1.popHasTitle)

  // ── B. 按钮 → 弹层（8px 空隙）不断开 ─────────────────────────────────────
  let gapKept = 0
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await moveTo(
      s0.btn.x + ((s1.pop.x - s0.btn.x) * i) / steps,
      s0.btn.y + ((s1.pop.y - s0.btn.y) * i) / steps,
      25
    )
    if (await ev(`!!document.querySelector('.code-block-popover')`)) gapKept++
  }
  const s2 = JSON.parse(await ev(STATE))
  console.log('B-cross ' + JSON.stringify({ steps, gapKept, pop: s2.pop }))
  c('crossing-gap-keeps-popover', gapKept === steps, `kept=${gapKept}/${steps}`)
  c('pointer-lands-inside-popover', s2.pop !== null, JSON.stringify(s2.pop))

  // 离开弹层（向下 120px）→ 宽限后收起
  await moveTo(s2.pop.x, s2.pop.bottom + 120, 600)
  const popGone = await ev(`!!document.querySelector('.code-block-popover')`)
  c('leaving-closes-popover', popGone === false, 'open=' + popGone)

  // 点击外部立即收起
  await hoverButton(s0.btn)
  const reopened = await ev(`!!document.querySelector('.code-block-popover')`)
  await clickAt(PARK.x, PARK.y + 60, 300)
  const afterOutside = await ev(`!!document.querySelector('.code-block-popover')`)
  console.log('B-outside ' + JSON.stringify({ reopened, afterOutside }))
  c(
    'outside-click-closes-popover',
    reopened === true && afterOutside === false,
    JSON.stringify({ reopened, afterOutside })
  )

  // ── C. 弹层里真实点击 → 行号切换 → 再点回（不预设初始态，只看是否跟随设置）──
  await hoverButton(s0.btn)
  const s3 = JSON.parse(await ev(STATE))
  const flipped = !before.lineNumbers
  await clickAt(s3.pop.x, s3.pop.y, 700)
  const after1 = JSON.parse(await ev(STATE))
  console.log(
    'C-1 ' +
      JSON.stringify({
        setting: after1.setting,
        hasGutter: after1.hasGutter,
        numbers: after1.numbers,
        switchOn: after1.popSwitchOn,
        action: after1.popAction
      })
  )
  c(
    'click-flips-setting',
    after1.setting === flipped &&
      after1.hasGutter === flipped &&
      (flipped ? after1.numbers.join(',') === '1,2,3' : after1.numbers.length === 0),
    JSON.stringify({ expect: flipped, setting: after1.setting, numbers: after1.numbers })
  )
  c('popover-stays-open-after-toggle', after1.pop !== null)
  c(
    'switch-and-action-follow-state',
    after1.popSwitchOn === flipped &&
      after1.ariaChecked === String(flipped) &&
      after1.popAction === (flipped ? after1.wantTitleOff : after1.wantTitleOn),
    JSON.stringify({ on: after1.popSwitchOn, aria: after1.ariaChecked, action: after1.popAction })
  )

  const s4 = JSON.parse(await ev(STATE))
  await clickAt(s4.pop.x, s4.pop.y, 800)
  const after2 = JSON.parse(await ev(STATE))
  console.log('C-2 ' + JSON.stringify({ setting: after2.setting, numbers: after2.numbers }))
  c(
    'click-flips-back',
    after2.setting === before.lineNumbers &&
      after2.hasGutter === before.lineNumbers &&
      (before.lineNumbers ? after2.numbers.join(',') === '1,2,3' : after2.numbers.length === 0),
    JSON.stringify({ expect: before.lineNumbers, setting: after2.setting, numbers: after2.numbers })
  )

  await sleep(700)
  const persisted = await ev(
    `(async () => (await window.luminAPI.settings.getAll()).codeLineNumbers)()`
  )
  c(
    'persisted-to-disk',
    persisted === before.lineNumbers,
    'persisted=' + persisted + ' expect=' + before.lineNumbers
  )

  // ── D. 主操作：直接点按钮仍然插入/取消代码块 ─────────────────────────────
  await ev(`(() => { window.__vt.ed().commands.setTextSelection(1); return 'ok' })()`)
  await sleep(200)
  const s5 = JSON.parse(await ev(STATE))
  await clickAt(s5.btn.x, s5.btn.y, 900)
  const afterClick = JSON.parse(await ev(STATE))
  console.log(
    'D ' +
      JSON.stringify({ before: s5.codeBlocks, after: afterClick.codeBlocks, pop: !!afterClick.pop })
  )
  c(
    'button-click-inserts-code-block',
    afterClick.codeBlocks === s5.codeBlocks + 1,
    JSON.stringify({ before: s5.codeBlocks, after: afterClick.codeBlocks })
  )
  c('button-click-closes-popover', afterClick.pop === null)

  await clickAt(s5.btn.x, s5.btn.y, 900)
  const toggled = JSON.parse(await ev(STATE))
  c(
    'button-click-toggles-back',
    toggled.codeBlocks === s5.codeBlocks,
    'codeBlocks=' + toggled.codeBlocks
  )

  // ── E. 窄窗口钳制 ────────────────────────────────────────────────────────
  await send('Emulation.setDeviceMetricsOverride', {
    width: 520,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(500)
  // 窄窗口下工具栏横向滚动，按钮默认在视口外；把它滚到最右端，才真正压到钳制分支
  await ev(
    `(() => { const b = window.__cbBtn; if (b) b.scrollIntoView({ block: 'nearest', inline: 'end' }); return 'ok' })()`
  )
  await sleep(400)
  const s6 = JSON.parse(await ev(STATE))
  const btnVisible = !!s6.btn && s6.btn.left >= 0 && s6.btn.right <= s6.vw
  await hoverButton(s6.btn)
  const narrow = JSON.parse(await ev(STATE))
  console.log(
    'E-narrow ' + JSON.stringify({ vw: narrow.vw, btnVisible, pop: narrow.pop, btn: narrow.btn })
  )
  c(
    'narrow-popover-clamped',
    btnVisible && narrow.pop !== null && narrow.pop.left >= 0 && narrow.pop.right <= narrow.vw,
    JSON.stringify({ vw: narrow.vw, btnVisible, pop: narrow.pop })
  )
  c(
    'narrow-popover-pushed-left',
    btnVisible && narrow.pop !== null && narrow.pop.left <= narrow.btn.left,
    JSON.stringify({ btnLeft: narrow.btn?.left, popLeft: narrow.pop?.left })
  )
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(500)

  // 复原
  await ev(`(async () => {
    const f = window.__vt.files(), s = window.__vt.settings(), ui = window.__vt.ui()
    ui.settingsOpen = false
    await f.close()
    ${before.path ? `await f.openPath(${JSON.stringify(before.path)})` : ''}
    await window.luminAPI.drafts.remove('untitled')
    s.set('codeLineNumbers', ${before.lineNumbers})
    await window.luminAPI.settings.update({ codeLineNumbers: ${before.lineNumbers} })
    return 'ok'
  })()`)
  await sleep(800)
  const restored = JSON.parse(
    await ev(
      `(async () => { const s = await window.luminAPI.settings.getAll(); const f = window.__vt.files(); return JSON.stringify({ persisted: s.codeLineNumbers, path: f.current?.path ?? null, dirty: !!f.dirty }) })()`
    )
  )
  c(
    'state-restored',
    restored.persisted === before.lineNumbers && restored.path === before.path,
    JSON.stringify(restored)
  )

  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  console.log(results.join('\n'))
  if (tempWindow) {
    await send('Page.close').catch(() => {})
    await sleep(400)
  }
  ws.close()
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
