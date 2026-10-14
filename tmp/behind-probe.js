'use strict'
/**
 * 第一百一十一轮取证：图片实体（源码未显形）周边的拖选死区
 *   起点：图片右侧 / 图片正上/下方 / 反向（图片左侧文字上按下往右拖）
 *   逐帧记录 selection.from/to/empty + posAtCoords 在图片盒各 x 的返回值 + 图片盒与源码区间
 * 用法：node tmp/behind-probe.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'red'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-behind-fixture.md'
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
  const click = async (x, y, settle = 400) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(settle) }
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
  await click(away.x, away.y) // 确保未激活（源码隐藏）
  const out = { tag: TAG, innerWidth: await ev(`innerWidth`), away }
  out.state0 = await json(`(() => ({ revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, widgets: document.querySelectorAll('.ProseMirror [data-img-widget]').length }))()`)
  // 图片盒 + 卡片源码区间（探针里自己按 tag 扫描文档算出来，仅用于报告）
  out.boxes = await json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const v = window.__vt.ed().view
    // 扫描文档里的 <img ...> 原文区间
    const ranges = []
    v.state.doc.descendants((node, pos) => {
      if (!node.isText) return true
      const t = node.text || ''
      for (const m of t.matchAll(/<img\\b[^>]*\\/?>/gi)) {
        const at = m.index || 0
        ranges.push({ from: pos + at, to: pos + at + m[0].length })
      }
      return true
    })
    return {
      ranges,
      widgets: [...document.querySelectorAll('.ProseMirror [data-img-widget]')].map((w) => ({ from: Number(w.getAttribute('data-img-from')), inline: w.getAttribute('data-img-inline'), rect: R(w.getBoundingClientRect()) })),
      para: (() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); return p ? R(p.getBoundingClientRect()) : null })()
    }
  })()`)
  const W = out.boxes.widgets
  out.deadzone = await json(`(() => {
    const v = window.__vt.ed().view
    const at = (x, y) => { const p = v.posAtCoords({ left: x, top: y }); return p ? p.pos : null }
    const w = document.querySelector('.ProseMirror [data-img-widget]')
    const r = w.getBoundingClientRect()
    const y = Math.round((r.top + r.bottom) / 2)
    const xs = [r.left + 2, r.left + r.width * 0.25, r.left + r.width / 2, r.left + r.width * 0.75, r.right - 2, r.right + 12, r.right + 40].map((x) => Math.round(x))
    return { y, pts: xs.map((x) => ({ x, pos: at(x, y) })) }
  })()`)
  // 手势：按下 → 多步拖动 → 松开；逐帧记录
  const gesture = async (name, from, to, steps = 16, settleFrames = 8) => {
    const pre = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '/' + s.to + '/' + s.empty })()`)
    await ev(`window.__frames = (async () => {
      const o = []; const t0 = performance.now()
      return await new Promise((res) => { const step = () => {
        const s = window.__vt.ed().state.selection
        o.push({ t: +(performance.now()-t0).toFixed(1), from: s.from, to: s.to, empty: s.empty, anchor: s.anchor, head: s.head })
        if (performance.now()-t0 > 1400) res(o); else requestAnimationFrame(step)
      }; requestAnimationFrame(step) }) })(); 'started'`, false)
    await mouse('mousePressed', from.x, from.y)
    await sleep(45)
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 })
      await sleep(22)
    }
    await sleep(60)
    const beforeUp = await ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '/' + s.to + '/' + s.empty })()`)
    await mouse('mouseReleased', to.x, to.y)
    await sleep(500)
    const frames = JSON.parse(await ev(`window.__frames.then((f) => JSON.stringify(f))`))
    const ded = []
    for (const f of frames) { const k = `${f.from}-${f.to}-${f.empty ? 'E' : '-'}`; if (!ded.length || ded[ded.length-1].k !== k) ded.push({ k, t: f.t }) }
    return { name, from, to, pre, beforeUp, seq: ded.map((x) => `${x.t}ms ${x.k}`), frames: frames.length }
  }
  const w0 = W[0]
  const w1 = W[1]
  out.gestures = []
  // ① 图片右侧空白按下 → 向左拖（用户报障的手势；源码未显形）
  out.gestures.push(await gesture('① 图片右侧 → 向左拖', { x: Math.round(w1.r + 40), y: Math.round((w1.t + w1.b) / 2) }, { x: Math.round(w0.l + 6), y: Math.round((w0.t + w0.b) / 2) }))
  // ③a 图片正下方空白按下 → 向左拖
  out.gestures.push(await gesture('③a 图片下方 → 向左拖', { x: Math.round((w0.l + w0.r) / 2), y: Math.round(w0.b - 3) }, { x: Math.round(w0.l + 4), y: Math.round((w0.t + w0.b) / 2) }))
  // ③b 图片正上方空白按下 → 向左拖
  out.gestures.push(await gesture('③b 图片上方 → 向左拖', { x: Math.round((w0.l + w0.r) / 2), y: Math.round(w0.t + 3) }, { x: Math.round(w0.l + 4), y: Math.round((w0.t + w0.b) / 2) }))
  // ② 反向：图片前面文字按下 → 向右拖过图片
  out.gestures.push(await gesture('② 文字 → 向右拖过图', { x: Math.round(w0.l - 60), y: Math.round((w0.t + w0.b) / 2) }, { x: Math.round(w1.r + 30), y: Math.round((w1.t + w1.b) / 2) }))
  // ④ 松手停在图盒内（右半 / 左半）
  out.gestures.push(await gesture('④a 右侧空白按下 → 松在图盒右半', { x: Math.round(w1.r + 40), y: Math.round((w1.t + w1.b) / 2) }, { x: Math.round(w1.l + w1.w * 0.75), y: Math.round((w1.t + w1.b) / 2) }))
  out.gestures.push(await gesture('④b 文字上按下 → 松在图盒左半', { x: Math.round(w0.l - 60), y: Math.round((w0.t + w0.b) / 2) }, { x: Math.round(w0.l + w0.w * 0.25), y: Math.round((w0.t + w0.b) / 2) }))
  for (const g of out.gestures) {
    log(`${g.name}: pre=${g.pre} beforeUp=${g.beforeUp}`)
    for (const s of g.seq) log('    ' + s)
  }
  // 截图：④ 之后的选区（能看出跨过图片）
  const clip = { x: Math.max(0, Math.floor(out.boxes.para.l) - 20), y: Math.max(0, Math.floor(out.boxes.para.t) - 20), width: Math.min(1200, Math.ceil(out.boxes.para.w) + 40), height: Math.ceil(out.boxes.para.h) + 40 }
  await shotFile(clip, `tmp/behind-${TAG}.png`)
  out.clip = clip
  fs.writeFileSync(`tmp/behind-${TAG}.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL ' + (e && e.stack ? e.stack : e.message)); process.exit(1) })
