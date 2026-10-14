'use strict'
/**
 * 第一百一十二轮取证：源码区域（字形 + 空白带）与"图片以外"的**交界处**点击 ⇒ 显隐闪烁
 * 对每个候选点：点击（mousedown→mouseup）并逐帧记录
 *   revealed / open / class / ov / bg / sel.from 及它与 img.from,img.to 的关系
 *   + 全部判据各自的结论（intersects(空光标) / contained / coversBeyond / intersectsSource / caretInside / bandAt 命中）
 * 用法：node tmp/boundary-probe.js <port> <tag> [shown|hidden]
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'red'
const MODE = process.argv[4] || 'shown'
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
  const click = async (x, y, settle = 420) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(settle) }
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
  await click(away.x, away.y)
  const out = { tag: TAG, mode: MODE, innerWidth: await ev(`innerWidth`) }
  // 页面里装一个"判据快照"函数：把 frame 里所有会参与显隐/底色决策的判据都算出来
  await ev(`window.__snap = () => {
    const v = window.__vt.ed().view
    const s = v.state.selection
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const pm = document.querySelector('.ProseMirror')
    const open = pm.getAttribute('data-img-open')
    // 现算全部源码区间（与实现同一来源：扫描 <img> 标签）
    const ranges = []
    v.state.doc.descendants((node, pos) => {
      if (!node.isText) return true
      const t = node.text || ''
      for (const m of t.matchAll(/<img\\b[^>]*\\/?>/gi)) { const at = m.index || 0; ranges.push({ from: pos + at, to: pos + at + m[0].length }) }
      return true
    })
    const rel = ranges.map((r) => {
      const intersectsEmpty = s.empty ? s.from <= r.to && s.from >= r.from : null
      const contained = !s.empty && s.from >= r.from && s.to <= r.to
      const coversBeyond = !s.empty && s.from <= r.from && s.to >= r.to && (s.from < r.from || s.to > r.to)
      const intersectsSource = !s.empty && s.from < r.to && s.to > r.from
      const caretInside = s.empty && s.from > r.from && s.from < r.to
      const caretAtBoundary = s.empty && (s.from === r.from || s.from === r.to)
      return { r, intersectsEmpty, contained, coversBeyond, intersectsSource, caretInside, caretAtBoundary }
    })
    const ovEl = document.querySelector('.img-src-overlay')
    return {
      t: 0, from: s.from, to: s.to, empty: s.empty,
      revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      cls: el ? String(el.className).replace('img-src-revealed--editing','RE').replace('img-src-revealed','R') : null,
      bg: el ? getComputedStyle(el).backgroundColor : null,
      ov: document.querySelectorAll('.img-src-overlay > div').length,
      ovEl: !!ovEl,
      open,
      rel
    }
  };
  window.__err = null;
  window.__sample2 = (ms) => { const o = []; const t0 = performance.now(); let done = false
    return new Promise((res) => { const fin = () => { if (done) return; done = true; clearTimeout(fb); clearInterval(iv); res(o) }
      const push = () => { try { const f = window.__snap(); f.t = +(performance.now()-t0).toFixed(1); o.push(f) } catch (e) { window.__err = String(e && e.message || e); fin() } }
      // 定时器采样（8ms）为主：窗口被遮挡时 rAF 会被 Chromium 节流甚至停摆，逐帧取证不能靠它
      const iv = setInterval(() => { push(); if (performance.now()-t0 > ms) fin() }, 8)
      const fb = setTimeout(() => { push(); fin() }, ms + 800) }) }; 'ok'`)
  const revealState = async (from254) => {
    await click(away.x, away.y, 320)
    if (from254) {
      for (let i = 0; i < 3; i++) {
        const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
        if (!pt) break
        await click(pt.x, pt.y, 700)
        const cur = await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? Number(el.getAttribute('data-img-from')) : null })()`)
        if (cur === 254) break
      }
    }
    await sleep(300)
  }
  const geo = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    if (!el) return { none: true }
    return { from: Number(el.getAttribute('data-img-from')), frags: [...el.getClientRects()].map(R), ov: [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect())) }
  })()`)
  const run = async (label, x, y) => {
    const pre = await json(`window.__snap()`)
    const frames = []
    await mouse('mousePressed', x, y)
    for (let i = 0; i < 24; i++) { frames.push(await json(`window.__snap()`)); await sleep(12) }
    await mouse('mouseReleased', x, y)
    for (let i = 0; i < 30; i++) { frames.push(await json(`window.__snap()`)); await sleep(12) }
    const t0 = performance.now()
    const ded = []
    for (const f of frames) {
      const k = `${f.revealed ? 'R' + (f.cls && f.cls.includes('RE') ? 'E' : '') : '-'}|bg${f.bg === 'rgb(228, 230, 234)' ? 'E' : f.bg === 'rgba(0, 0, 0, 0)' ? 'O' : '?'}|ov${f.ov}|sel${f.from}-${f.to}-${f.empty ? 'E' : '-'}|open${f.open}`
      if (!ded.length || ded[ded.length - 1].k !== k) ded.push({ k, f })
    }
    return { label, x, y, pre, frames: frames.length, seq: ded.map((d, i) => `#${i} ${d.k}`), judgements: ded.map((d) => ({ k: d.k, rel: d.f.rel.map((r) => `${r.r.from}-${r.r.to}:` + (r.intersectsEmpty === null ? '' : 'IE' + (r.intersectsEmpty ? 1 : 0)) + (r.contained ? ' C' : '') + (r.coversBeyond ? ' CB' : '') + (r.intersectsSource ? ' IS' : '') + (r.caretInside ? ' CI' : '') + (r.caretAtBoundary ? ' @B' : '')) })) }
  }

  if (MODE === 'shown') await revealState(true)
  const g = await geo()
  out.geo = g
  if (!g.none) {
    const f0 = g.frags[0]
    const bandTop = g.ov.length ? g.ov[0].t : f0.t
    const bandBottom = g.ov.length ? g.ov[0].b : f0.b
    const bandY = Math.round((f0.b + bandBottom) / 2)
    const midY = Math.round((f0.t + f0.b) / 2)
    out.points = { f0, bandTop, bandBottom, bandY, midY }
    out.runs = []
    // 交界处多点：源码片段右/左边界（x 方向）、覆盖带下边界（y 方向）、片段上边界（y 方向）
    out.runs.push(await run('右边界-2', Math.round(f0.r - 2), bandY))
    out.runs.push(await run('右边界+2', Math.round(f0.r + 2), bandY))
    out.runs.push(await run('左边界-2', Math.round(f0.l - 2), bandY))
    out.runs.push(await run('左边界+2', Math.round(f0.l + 2), bandY))
    out.runs.push(await run('带下边界-2', Math.round((f0.l + f0.r) / 2), Math.round(bandBottom - 2)))
    out.runs.push(await run('带下边界+2', Math.round((f0.l + f0.r) / 2), Math.round(bandBottom + 2)))
    out.runs.push(await run('片段上边界-2', Math.round((f0.l + f0.r) / 2), Math.round(f0.t - 2)))
    out.runs.push(await run('片段上边界+2', Math.round((f0.l + f0.r) / 2), Math.round(f0.t + 2)))
    out.runs.push(await run('带内中部(对照)', Math.round((f0.l + f0.r) / 2), bandY))
    const clip = { x: Math.max(0, Math.floor(f0.l) - 60), y: Math.max(0, Math.floor(bandTop) - 30), width: Math.min(1200, Math.ceil(f0.w) + 120), height: Math.ceil(bandBottom - bandTop) + 60 }
    await shotFile(clip, `tmp/boundary-${TAG}.png`)
    out.clip = clip
  }
  fs.writeFileSync(`tmp/boundary-${TAG}.json`, JSON.stringify(out, null, 1))
  for (const r of out.runs || []) {
    console.log(`== ${r.label} (${r.x},${r.y})`)
    for (const s of r.seq) console.log('   ' + s)
    for (const j of r.judgements) console.log('     判据 ' + j.rel.join(' | '))
  }
  console.log('geo', JSON.stringify(out.geo))
  ws.close()
  process.exit(0)
}
main().catch((e) => { log('FAIL ' + (e && e.stack ? e.stack : e.message)); process.exit(1) })
