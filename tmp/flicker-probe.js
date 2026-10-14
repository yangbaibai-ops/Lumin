'use strict'
/**
 * 第一百零九轮取证：两个手势（X 点空白带 / Y 点源码字形）的**逐帧**序列 + 事件顺序。
 * 每帧记录：覆盖层数量、.img-src-revealed 的 classList 与 computed background-color、
 *           data-img-open（插件状态 from:editing）、revealed 计数、选区、activeElement。
 * 另记 blur/focus/focusin/focusout 事件相对 mousedown 的时刻。
 * 用法：node tmp/flicker-probe.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-flicker-fixture.md'
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
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('timeout ' + method)) }, 30000); pending.set(i, (m) => { clearTimeout(t); res(m) }); ws.send(JSON.stringify({ id: i, method, params })) })
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
  const mouse = async (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const dismiss = async () => {
    for (let i = 0; i < 8; i++) {
      const hit = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`)
      if (!hit) break
      await sleep(650)
    }
  }
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

  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  const widgetPt = (i) => json(`(() => { const im = [...document.querySelectorAll('.ProseMirror [data-img-widget] img')][${i}]; if (!im) return null; const r = im.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  /** 按 data-img-from 精确定位某张图的 widget（index 会因为边界歧义点错源） */
  const widgetPtOf = (from) => json(`(() => {
    const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="${from}"] img')
    if (!w) return null
    const r = w.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  })()`)

  // 采样器：rAF 逐帧 + blur/focus 事件时间线
  const startSampler = async (ms = 650) => {
    await ev(`window.__sample = (() => {
      const frames = []; const evs = []; const t0 = performance.now()
      const mark = (k, e) => evs.push({ t: +(performance.now() - t0).toFixed(1), k, cls: e && e.target && e.target.className ? String(e.target.className).slice(0, 30) : null, act: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName).slice(0, 24) : null })
      const onBlur = (e) => mark('blur', e)
      const onFocus = (e) => mark('focus', e)
      const onFocusIn = (e) => mark('focusin', e)
      const onFocusOut = (e) => mark('focusout', e)
      window.addEventListener('blur', onBlur, true)
      window.addEventListener('focus', onFocus, true)
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('focusout', onFocusOut, true)
      const snap = () => {
        const pm = document.querySelector('.ProseMirror')
        const el = document.querySelector('.ProseMirror [data-img-revealed]')
        const s = window.__vt.ed().state.selection
        return {
          t: +(performance.now() - t0).toFixed(1),
          ov: document.querySelectorAll('.img-src-overlay > div').length,
          ovEl: !!document.querySelector('.img-src-overlay'),
          cls: el ? String(el.className).replace('img-src-revealed', 'R').replace('img-src-revealed--editing', 'RE').replace('ProseMirror-widget', '').trim() : null,
          bg: el ? getComputedStyle(el).backgroundColor : null,
          open: pm ? pm.getAttribute('data-img-open') : null,
          n: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
          sel: s.from + (s.empty ? '' : '-' + s.to),
          act: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName).slice(0, 24) : null,
          hasFocus: document.hasFocus()
        }
      }
      return new Promise((res) => {
        const step = () => {
          frames.push(snap())
          if (performance.now() - t0 > ${ms}) {
            window.removeEventListener('blur', onBlur, true); window.removeEventListener('focus', onFocus, true)
            document.removeEventListener('focusin', onFocusIn, true); document.removeEventListener('focusout', onFocusOut, true)
            res({ frames, evs })
          } else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
    })(); 'started'`, false)
  }
  const readSampler = () => ev(`window.__sample.then((r) => JSON.stringify(r))`).then((s) => JSON.parse(s))
  const dedupe = (frames) => {
    const out = []
    for (const f of frames) {
      const key = [f.ov, f.cls, f.bg, f.open, f.n, f.sel, f.act].join('|')
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, t: f.t, f })
    }
    return out
  }
  const brief = (frames) => frames.map((x) => `${x.f.t}ms ov${x.f.ov}${x.f.cls ? '+' + x.f.cls : ''} bg${x.f.bg === 'rgb(228, 230, 234)' ? 'EDGE' : x.f.bg === 'rgba(0, 0, 0, 0)' ? 'OFF' : x.f.bg} open=${x.f.open} n${x.f.n} sel${x.f.sel}`)

  const out = { tag: TAG, innerWidth: await ev(`innerWidth`), gestures: {} }

  // 隐藏
  await mouse('mousePressed', away.x, away.y); await mouse('mouseReleased', away.x, away.y); await sleep(400)
  // 精确激活第 2 张图（data-img-from=254；用户那一行：img1 与源码片段 A 同行）
  const TARGET_FROM = 254
  const pt = await widgetPtOf(TARGET_FROM)
  for (let i = 0; i < 3; i++) {
    await mouse('mousePressed', pt.x, pt.y); await mouse('mouseReleased', pt.x, pt.y); await sleep(800)
    const cur = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? Number(el.getAttribute('data-img-from')) : null })()`)
    if (cur === TARGET_FROM) break
    await mouse('mousePressed', away.x, away.y); await mouse('mouseReleased', away.x, away.y); await sleep(300)
  }
  const bands = await json(`(() => {
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { error: 'no revealed' }
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2) })
    const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(3, tn.length))
    return { from: Number(el.getAttribute('data-img-from')), cls: String(el.className), frags: [...el.getClientRects()].map(R), ov: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())), text0: R(rg.getBoundingClientRect()) }
  })()`)
  out.bands = bands
  if (bands.error || !bands.ov || !bands.ov.length) {
    out.error = 'bands 不可用：' + JSON.stringify(bands)
    fs.writeFileSync(`tmp/flicker-${TAG}.json`, JSON.stringify(out, null, 1))
    console.log(JSON.stringify(out, null, 1))
    ws.close(); process.exit(0)
  }
  const f0 = bands.frags[0]
  const t0 = bands.text0
  const bandPt = { x: Math.round((f0.l + f0.r) / 2), y: Math.round((f0.b + bands.ov[0].b) / 2) }
  const glyphPt = { x: Math.round((t0.l + t0.r) / 2), y: Math.round((t0.t + t0.b) / 2) }
  out.points = { band: bandPt, glyph: glyphPt }

  /** 每个手势前把状态钉死：收起 → 激活第 2 张图 → 光标放到"源码末尾边界"（非编辑态、有底色、有覆盖层） */
  const reset = async () => {
    await mouse('mousePressed', away.x, away.y)
    await mouse('mouseReleased', away.x, away.y)
    await sleep(350)
    await mouse('mousePressed', pt.x, pt.y)
    await mouse('mouseReleased', pt.x, pt.y)
    await sleep(800)
    await ev(`(() => {
      const v = window.__vt.ed().view
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const from = Number(el.getAttribute('data-img-from'))
      const to = from + (el.textContent || '').length
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, to)))
      return 'ok'
    })()`)
    await sleep(400)
    return json(`(() => {
      const el = document.querySelector('.ProseMirror [data-img-revealed]')
      const pm = document.querySelector('.ProseMirror')
      return { from: el ? Number(el.getAttribute('data-img-from')) : null, open: pm.getAttribute('data-img-open'), bg: el ? getComputedStyle(el).backgroundColor : null, ov: document.querySelectorAll('.img-src-overlay > div').length, cls: el ? String(el.className).replace('img-src-revealed', 'R') : null }
    })()`)
  }

  /** 一次手势：先钉状态 → 起采样 → 等一帧（让首帧记录"点击前"）→ mousedown → 60ms → mouseup → 读完 */
  const gesture = async (name, p) => {
    const pre = await reset()
    await startSampler(650)
    await sleep(50)
    await mouse('mousePressed', p.x, p.y)
    await sleep(60)
    await mouse('mouseReleased', p.x, p.y)
    const r = await readSampler()
    const d = dedupe(r.frames)
    out.gestures[name] = {
      point: p,
      pre,
      frames: r.frames.length,
      seq: brief(d),
      evs: r.evs,
      raw: d.map((x) => ({ t: x.t, ov: x.f.ov, cls: x.f.cls, bg: x.f.bg, open: x.f.open, n: x.f.n, sel: x.f.sel, act: x.f.act }))
    }
    return out.gestures[name]
  }

  await gesture('X_band', bandPt)
  await sleep(400)
  await gesture('Y_glyph', glyphPt)
  await sleep(400)
  await gesture('Z_activate', pt)
  // 逐帧图（把 X 手势的序列画成图片不必要；这里给修复后截图）
  fs.writeFileSync(`tmp/flicker-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log('X_band :', JSON.stringify(out.gestures.X_band.seq, null, 0))
  console.log('  evs  :', JSON.stringify(out.gestures.X_band.evs))
  console.log('Y_glyph:', JSON.stringify(out.gestures.Y_glyph.seq, null, 0))
  console.log('  evs  :', JSON.stringify(out.gestures.Y_glyph.evs))
  console.log('Z_activate:', JSON.stringify(out.gestures.Z_activate.seq, null, 0))
  console.log('  evs  :', JSON.stringify(out.gestures.Z_activate.evs))
  console.log('points', JSON.stringify(out.points), 'bands', JSON.stringify(out.bands))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL ' + (e && e.stack ? e.stack : e.message)); process.exit(1) })
