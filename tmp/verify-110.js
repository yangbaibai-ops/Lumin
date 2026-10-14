'use strict'
/**
 * 第一百零九/一百一十轮验收：
 *   A（闪烁）逐帧：手势 X=点空白带 / Y=点源码字形，去重序列（无 A→B→A）
 *   B（空白带拖动）：与"同一 x 列字形上按下并拖到同一终点"的选区等价（Δ0）
 * 用法：node tmp/verify-110.js <port> <tag> [all|A|B]
 */
const fs = require('fs')
const { decodePNG } = require('./png')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const MODE = process.argv[4] || 'all'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-banddrag-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 30000)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const shotFile = async (clip, file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, settle = 420) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(settle) }
  const dragPath = async (x0, y0, x1, y1, steps = 14, sampler = false) => {
    if (sampler) await startSampler(900)
    await mouse('mousePressed', x0, y0)
    await sleep(45)
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1 })
      await sleep(18)
    }
    await sleep(40)
    await mouse('mouseReleased', x1, y1)
    await sleep(180)
  }
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
  }
  const startSampler = async (ms = 650) => {
    await ev(`window.__sample = (() => {
      const frames = []; const evs = []; const t0 = performance.now()
      const mark = (k, e) => evs.push({ t: +(performance.now() - t0).toFixed(1), k, cls: e && e.target && e.target.className ? String(e.target.className).slice(0, 26) : null })
      const onBlur = (e) => mark('blur', e); const onFocus = (e) => mark('focus', e)
      const onFI = (e) => mark('focusin', e); const onFO = (e) => mark('focusout', e)
      window.addEventListener('blur', onBlur, true); window.addEventListener('focus', onFocus, true)
      document.addEventListener('focusin', onFI, true); document.addEventListener('focusout', onFO, true)
      const snap = () => {
        const pm = document.querySelector('.ProseMirror')
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const s = window.__vt.ed().state.selection
        return {
          t: +(performance.now() - t0).toFixed(1),
          ov: document.querySelectorAll('.img-src-overlay > div').length,
          ovEl: !!document.querySelector('.img-src-overlay'),
          cls: el ? String(el.className).replace('img-src-revealed--editing', 'RE').replace('img-src-revealed', 'R').replace('ProseMirror-widget', '').trim() : null,
          bg: el ? getComputedStyle(el).backgroundColor : null,
          open: pm ? pm.getAttribute('data-img-open') : null,
          n: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
          sel: s.from + (s.empty ? '' : '-' + s.to)
        }
      }
      return new Promise((res) => {
        const step = () => {
          frames.push(snap())
          if (performance.now() - t0 > ${ms}) {
            window.removeEventListener('blur', onBlur, true); window.removeEventListener('focus', onFocus, true)
            document.removeEventListener('focusin', onFI, true); document.removeEventListener('focusout', onFO, true)
            res({ frames, evs })
          } else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
    })(); 'started'`, false)
  }
  const readSampler = () => ev(`window.__sample.then((r) => JSON.stringify(r))`).then((s) => JSON.parse(s))
  const bgName = (b) => (b === 'rgb(228, 230, 234)' ? 'EDGE' : b === 'rgba(0, 0, 0, 0)' ? 'OFF' : b)
  const dedupe = (frames) => {
    const out = []
    for (const f of frames) {
      const k = [f.ov, f.cls, f.bg, f.open, f.n, f.sel].join('|')
      if (!out.length || out[out.length - 1].k !== k) out.push({ k, f })
    }
    return out.map((x) => `${x.f.t}ms ov${x.f.ov}${x.f.ovEl ? '(el)' : ''} ${x.f.cls || '-'} bg${bgName(x.f.bg)} open=${x.f.open} n${x.f.n} sel${x.f.sel}`)
  }

  // ── setup
  await ev(`(() => {
    if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK'
  })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300)
  await send('Emulation.clearDeviceMetricsOverride').catch(() => null)
  await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900)
  await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(900)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }

  const out = { tag: TAG, mode: MODE, innerWidth: await ev(`innerWidth`), mdBefore: await ev(`window.__vt.ed().storage.markdown.getMarkdown().length`) }
  const sha = () => ev(`(async () => { const md = window.__vt.ed().storage.markdown.getMarkdown(); const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2,'0')).join('') })()`)
  out.shaBefore = await sha()
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  const TARGET_FROM = 254
  const widgetPt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="${TARGET_FROM}"] img'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  out.away = away
  out.widgetPt = widgetPt

  const stateOf = () => json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const pm = document.querySelector('.ProseMirror')
    const s = window.__vt.ed().state.selection
    return { revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      from: el ? Number(el.getAttribute('data-img-from')) : null,
      cls: el ? String(el.className) : null,
      bg: el ? getComputedStyle(el).backgroundColor : null,
      ov: document.querySelectorAll('.img-src-overlay > div').length,
      ovEl: !!document.querySelector('.img-src-overlay'),
      open: pm.getAttribute('data-img-open'),
      sel: { from: s.from, to: s.to, empty: s.empty } }
  })()`)

  /** 每个手势前钉死状态：收起 → 激活 254 → 光标放到末尾边界（非编辑态、有底色、有覆盖层） */
  const reset = async () => {
    await click(away.x, away.y, 320)
    let from = null
    for (let i = 0; i < 3; i++) {
      const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="${TARGET_FROM}"] img'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
      if (!pt) break
      await click(pt.x, pt.y, 700)
      from = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? Number(el.getAttribute('data-img-from')) : null })()`)
      if (from === TARGET_FROM) break
      await click(away.x, away.y, 300)
    }
    if (from === TARGET_FROM) {
      await ev(`(() => {
        const v = window.__vt.ed().view
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const f = Number(el.getAttribute('data-img-from'))
        const to = f + (el.textContent || '').length
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, to)))
        return 'ok'
      })()`)
    }
    // 覆盖层是逐帧补画的：等它出现（最多 900ms），并把"等了多久 / 有没有出现"记下来
    let waited = 0
    let st = await stateOf()
    while (st.ov === 0 && waited < 900) {
      await sleep(60)
      waited += 60
      st = await stateOf()
    }
    return { ...st, activated: from === TARGET_FROM, ovWaitedMs: waited, ovOk: st.ov > 0 }
  }

  const bands = async () => json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return null
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
    const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    let texts = []
    if (tn && tn.length) { const rg = document.createRange(); rg.selectNodeContents(tn); texts = [...rg.getClientRects()].map(R) }
    // 正文文字（第一段落的文字盒，用来当"拖出源码进入正文"的终点）
    const p = el.closest('p, li, div')
    const pt = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 2)
    let bodyText = null
    if (pt) { const rg = document.createRange(); rg.setStart(pt, 0); rg.setEnd(pt, Math.min(6, pt.length)); bodyText = R(rg.getBoundingClientRect()) }
    return { from: Number(el.getAttribute('data-img-from')), len: (el.textContent || '').length, frags: [...el.getClientRects()].map(R), texts, ov: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())), bodyText, block: R(p.getBoundingClientRect()) }
  })()`)

  out.pre = await reset()
  out.bands = await bands()
  const b = out.bands
  if (!b) { out.error = '没有显形源码'; fs.writeFileSync(`tmp/v110-${TAG}.json`, JSON.stringify(out, null, 1)); console.log(JSON.stringify(out, null, 1)); ws.close(); process.exit(0) }
  const f0 = b.frags[0]
  const t0 = b.texts[0]
  /** 覆盖层缺失时的兜底（HEAD 上偶发）：带 = 片段下沿到"同行图片下沿"之间 */
  const rowBottom = await ev(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const p = el ? el.closest('p, li, div') : null
    if (!p) return null
    let m = 0
    for (const im of p.querySelectorAll('img')) m = Math.max(m, im.getBoundingClientRect().bottom)
    return m || null
  })()`)
  const ovBottom = b.ov.length ? b.ov[0].b : (rowBottom && rowBottom > f0.b ? rowBottom : f0.b + 108)
  out.bandFallback = !b.ov.length
  const bandY = Math.round((f0.b + ovBottom) / 2)
  const glyphY = Math.round((t0.t + t0.b) / 2)
  const midX = Math.round((f0.l + f0.r) / 2)
  out.points = { band: { x: midX, y: bandY }, glyph: { x: midX, y: glyphY }, row: { t: f0.t, b: f0.b, bottom: ovBottom }, overlays: b.ov }

  if (MODE === 'all' || MODE === 'A') {
    // ── A：逐帧（X 点空白带 / Y 点源码字形）
    const gesture = async (name, p, extra = {}) => {
      const pre = await reset()
      await startSampler(650)
      await sleep(50)
      await mouse('mousePressed', p.x, p.y)
      await sleep(60)
      await mouse('mouseReleased', p.x, p.y)
      const r = await readSampler()
      out['A_' + name] = { pre, point: p, seq: dedupe(r.frames), evs: r.evs, frames: r.frames.length }
    }
    await gesture('X_band', { x: midX, y: bandY })
    await gesture('Y_glyph', { x: midX, y: glyphY })
    // 对照：点图片激活
    const pre = await reset()
    await startSampler(650)
    await sleep(50)
    await click(widgetPt.x, widgetPt.y, 120)
    const r = await readSampler()
    out.A_Z_activate = { pre, seq: dedupe(r.frames), evs: r.evs }
    // 点其它段落（收起）
    await reset()
    await click(away.x, away.y)
    out.A_elsewhere = await stateOf()
  }

  if (MODE === 'all' || MODE === 'B') {
    // ── B①：三组等价（空白带按下拖动 vs 同一 x 列字形按下拖动，同一终点）
    const endPoints = [
      { name: '向左拖', end: { x: Math.round(f0.l + 40), y: glyphY } },
      { name: '向右拖', end: { x: Math.round(f0.l + 380), y: glyphY } },
      { name: '拖出源码进入正文', end: { x: b.bodyText ? Math.round(b.bodyText.l + 40) : 400, y: b.bodyText ? Math.round((b.bodyText.t + b.bodyText.b) / 2) : 420 } }
    ]
    out.B = []
    for (const e of endPoints) {
      await reset()
      await dragPath(midX, bandY, e.end.x, e.end.y, 14, true)
      const bandSel = await stateOf()
      const bandSeq = dedupe((await readSampler()).frames)
      await reset()
      await dragPath(midX, glyphY, e.end.x, e.end.y)
      const glyphSel = await stateOf()
      out.B.push({
        name: e.name,
        start: { band: { x: midX, y: bandY }, glyph: { x: midX, y: glyphY } },
        end: e.end,
        band: bandSel.sel,
        glyph: glyphSel.sel,
        dFrom: Math.abs(bandSel.sel.from - glyphSel.sel.from),
        dTo: Math.abs(bandSel.sel.to - glyphSel.sel.to),
        bandSeq
      })
      if (e.name === '向右拖') {
        const clip = { x: Math.max(0, Math.floor(f0.l) - 30), y: Math.max(0, Math.floor(b.ov[0].t) - 24), width: Math.min(1150, Math.ceil(f0.r - f0.l) + 60), height: Math.ceil(b.ov[0].b - b.ov[0].t) + 48 }
        await shotFile(clip, 'tmp/band-drag-select.png')
      }
    }
    // ── B②：单击仍是空光标；字形上拖动仍得非空选区
    await reset()
    await click(midX, bandY)
    out.B_singleClick = await stateOf()
    await reset()
    await dragPath(Math.round(f0.l + 20), glyphY, Math.round(f0.l + 200), glyphY)
    out.B_glyphDrag = await stateOf()
    // ── 带内终点（指针一路留在空白带里）⇒ 按列映射（记录口径差异）
    await reset()
    await dragPath(midX, bandY, Math.round(f0.l + 380), bandY)
    out.B_inBandDrag = await stateOf()
  }

  // ── 共同不破坏项
  await reset()
  out.keep = {}
  out.keep.bandClick = await (async () => { await click(midX, bandY); return stateOf() })()
  await reset()
  out.keep.revealGesture = await (async () => {
    await click(away.x, away.y, 250)
    await startSampler(700)
    await sleep(40)
    await mouse('mousePressed', widgetPt.x, widgetPt.y)
    await sleep(150)
    const press = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
    await mouse('mouseReleased', widgetPt.x, widgetPt.y)
    await sleep(420)
    const release = await ev(`document.querySelectorAll('.ProseMirror [data-img-revealed]').length`)
    const bg = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? getComputedStyle(el).backgroundColor : null })()`)
    const r = await readSampler()
    return { press, release, bg, seq: dedupe(r.frames) }
  })()
  out.keep.hit = await json(`(() => {
    const j = (el) => ({ tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 34) : null, overlay: !!(el && el.closest && el.closest('.img-src-overlay')) })
    return { mid: j(document.elementFromPoint(${midX}, ${bandY})) }
  })()`)
  out.keep.layoutOn = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return { para: R(p.getBoundingClientRect()), imgs: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())), h2: R(document.querySelector('.ProseMirror h2').getBoundingClientRect()), scrollH: document.querySelector('.editor-scroll').scrollHeight }
  })()`)
  await ev(`(() => { const s = document.createElement('style'); s.id='xw-off'; s.textContent='.img-src-overlay{display:none !important}'; document.head.appendChild(s); return 'ok' })()`)
  await sleep(300)
  out.keep.layoutOff = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    return { para: R(p.getBoundingClientRect()), imgs: [...p.querySelectorAll('img')].map((im) => R(im.getBoundingClientRect())), h2: R(document.querySelector('.ProseMirror h2').getBoundingClientRect()), scrollH: document.querySelector('.editor-scroll').scrollHeight }
  })()`)
  await ev(`document.getElementById('xw-off')?.remove()`)
  await sleep(250)
  out.keep.layoutSame = ['para', 'imgs', 'h2', 'scrollH'].every((k) => JSON.stringify(out.keep.layoutOn[k]) === JSON.stringify(out.keep.layoutOff[k]))
  // 编辑态
  await reset()
  const tp = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); const a = Math.min(20, Math.max(0, tn.length - 3)); const rg = document.createRange(); rg.setStart(tn, a); rg.setEnd(tn, Math.min(a+3, tn.length)); const r = rg.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  for (let k = 0; k < 2; k++) { await click(tp.x, tp.y, 600); if ((await stateOf()).cls && (await stateOf()).cls.includes('--editing')) break }
  out.keep.editing = await stateOf()
  // 隐藏 + 往返
  await click(away.x, away.y)
  out.keep.hidden = await stateOf()
  out.shaAfter = await sha()
  out.mdRoundtripSame = out.shaBefore === out.shaAfter
  out.keep.modal = await ev(`document.querySelectorAll('.lm-prompt__card').length`)
  fs.writeFileSync(`tmp/v110-${TAG}.json`, JSON.stringify(out, null, 1))
  fs.writeFileSync(`tmp/v110-${TAG}.txt`, require('./v110-sum')(out))
  console.log(require('./v110-sum')(out))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL ' + (e && e.stack ? e.stack : e.message)); process.exit(1) })
