'use strict'
/**
 * 第一百一十三轮验收：P1（拖动期即时观感）逐帧证据 + P2（8 个手势逐个查 A→B→A）
 * Node 侧 11ms 轮询（遮挡时 rAF 会停摆）
 * 用法：node tmp/audit-113.js <port> <tag>
 */
const fs = require('fs')
const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const COPY = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-live-fixture.md'
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
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 380) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const shot = async (file, pad = 26) => {
    const clip = await json(`(() => { const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
      const r = p.getBoundingClientRect()
      return { x: Math.max(0, Math.floor(r.left) - ${pad}), y: Math.max(0, Math.floor(r.top) - ${pad}), width: Math.min(1210, Math.ceil(r.width) + ${pad * 2}), height: Math.ceil(r.height) + ${pad * 2} } })()`)
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
    return clip
  }
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(650) } }
  await ev(`(() => { if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK' })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300); await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(COPY)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900); await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(800)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }
  const away = await json(`(() => { const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-img-widget]') && (x.textContent||'').length > 5); const r = q.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) } })()`)
  const geo = () => json(`(() => {
    const R = (x) => ({ l: +x.left.toFixed(2), t: +x.top.toFixed(2), r: +x.right.toFixed(2), b: +x.bottom.toFixed(2), w: +x.width.toFixed(2), h: +x.height.toFixed(2) })
    const v = window.__vt.ed().view
    const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3)
    const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length))
    const ovs = [...document.querySelectorAll('.img-src-overlay > div')].map((d) => R(d.getBoundingClientRect()))
    return { widgets: [...p.querySelectorAll('[data-img-widget]')].map((w) => ({ from: Number(w.getAttribute('data-img-from')), ...R(w.getBoundingClientRect()) })),
      text: R(rg.getBoundingClientRect()), para: R(p.getBoundingClientRect()),
      revealed: el ? { from: Number(el.getAttribute('data-img-from')), frags: [...el.getClientRects()].map(R) } : null, ovs } })()`)
  await click(away.x, away.y)
  const g0 = await geo()
  const snap = () => json(`(() => {
    const s = window.__vt.ed().state.selection
    const el = document.querySelector('.ProseMirror [data-img-revealed]')
    const pm = document.querySelector('.ProseMirror')
    const marked = [...document.querySelectorAll('.ProseMirror [data-img-widget].img-selected')].map((w) => Number(w.getAttribute('data-img-from')))
    const nodes = [...document.querySelectorAll('.ProseMirror .img-selected')].length
    let hlLen = 0
    try { const h = CSS.highlights.get('lumin-img-drag'); if (h) for (const r of h) hlLen += (r.toString() || '').length } catch (e) {}
    return { from: s.from, to: s.to, empty: s.empty,
      revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length,
      cls: el ? String(el.className).replace('img-src-revealed--editing','RE').replace('img-src-revealed','R') : null,
      bg: el ? getComputedStyle(el).backgroundColor : null,
      ov: document.querySelectorAll('.img-src-overlay > div').length,
      open: pm.getAttribute('data-img-open'),
      imgSel: marked.length, imgSelFrom: marked.join(','), markedNodes: nodes, hl: hlLen }
  })()`)
  const out = { tag: TAG, geo0: g0, gestures: [] }
  /** 逐帧采样器：polls 次、间隔 11ms；期间记录 mark 下标 */
  const sampler = async (n, marks) => {
    const frames = []
    for (let i = 0; i < n; i++) { frames.push({ i, ...(await snap()) }); await sleep(11) }
    return { frames, marks }
  }
  const A2B2A = (seq) => {
    const hits = []
    for (let i = 0; i < seq.length; i++) {
      for (let k = i + 2; k < seq.length; k++) {
        if (seq[i] !== seq[k]) continue
        for (let j = i + 1; j < k; j++) if (seq[j] !== seq[i]) { hits.push(`${i}→${j}→${k}: ${seq[i].slice(0, 46)} ⇒ ${seq[j].slice(0, 46)} ⇒ 回到 ${seq[i].slice(0, 46)}`); break }
        break
      }
    }
    return hits
  }
  const simplify = (frames) => {
    const vis = [], full = []
    for (const f of frames) {
      const rev = f.revealed ? 'R' + (f.cls && f.cls.includes('RE') ? 'E' : '') : '-'
      const bgv = f.bg === 'rgb(228, 230, 234)' ? 'E' : f.bg === 'rgba(0, 0, 0, 0)' ? 'O' : '?'
      vis.push(`${rev}${bgv}ov${f.ov}open${f.open}img${f.imgSel}[${f.imgSelFrom}]hl${f.hl > 0 ? 1 : 0}`)
      full.push(`${vis[vis.length - 1]}|sel${f.from}-${f.to}${f.empty ? 'E' : ''}`)
    }
    return { vis, full }
  }
  const record = async (name, body, opts = {}) => {
    const pre = await snap()
    const frames = []
    const marks = {}
    const t0 = Date.now()
    let i = 0
    const pump = async (n) => { for (let k = 0; k < n; k++) { frames.push({ i: i++, t: Date.now() - t0, ...(await snap()) }); await sleep(11) } }
    await body({ pump, mark: (m) => (marks[m] = i), shot })
    const { vis, full } = simplify(frames)
    const dedVis = vis.filter((v, k) => k === 0 || v !== vis[k - 1])
    const dedFull = full.filter((v, k) => k === 0 || v !== full[k - 1])
    const g = { name, pre, frames: frames.length, marks, dedVis, dedFull, rbVis: A2B2A(dedVis), rbFull: A2B2A(dedFull),
      preUp: opts.preUp !== undefined ? opts.preUp : null }
    out.gestures.push(g)
    return g
  }
  const reveal254 = async () => {
    await click(away.x, away.y, 300)
    for (let k = 0; k < 3; k++) {
      const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
      if (!pt) break
      await click(pt.x, pt.y, 650)
      if ((await ev(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); return el ? Number(el.getAttribute('data-img-from')) : null })()`)) === 254) break
    }
    await sleep(300)
    return geo()
  }
  const w0 = g0.widgets[0]
  const w1 = g0.widgets[1]
  const textY = Math.round((g0.text.t + g0.text.b) / 2)

  // 1 点源码字形
  {
    const g = await reveal254()
    const tx = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); const a = Math.min(30, Math.max(0, tn.length - 3)); const rg = document.createRange(); rg.setStart(tn, a); rg.setEnd(tn, Math.min(a + 3, tn.length)); const r = rg.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await record('1 点源码字形', async ({ pump, mark }) => {
      await click(away.x, away.y, 260); await reveal254()
      mark('press'); await mouse('mousePressed', tx.x, tx.y); await pump(6)
      mark('release'); await mouse('mouseReleased', tx.x, tx.y); await pump(30)
    })
  }
  // 2 点空白带
  {
    const g = await reveal254()
    const f0 = g.revealed.frags[0]
    const bandY = Math.round((f0.b + g.ovs[0].b) / 2)
    const midX = Math.round((f0.l + f0.r) / 2)
    await record('2 点空白带', async ({ pump, mark }) => {
      await click(away.x, away.y, 260); await reveal254()
      mark('press'); await mouse('mousePressed', midX, bandY); await pump(6)
      mark('release'); await mouse('mouseReleased', midX, bandY); await pump(30)
    })
  }
  // 3 点交界缝（行盒内/字形盒外：frag.b 附近多点）
  {
    const g = await reveal254()
    const f0 = g.revealed.frags[0]
    await record('3 点交界缝(行盒下沿内, 多点)', async ({ pump, mark }) => {
      for (const dy of [-1, -3, -5]) {
        for (const x of [Math.round(f0.l + 8), Math.round((f0.l + f0.r) / 2), Math.round(f0.r - 8)]) {
          await click(away.x, away.y, 200); await reveal254()
          mark(`press(${x},${Math.round(f0.b + dy)})`)
          await mouse('mousePressed', x, Math.round(f0.b + dy)); await pump(4)
          mark('release'); await mouse('mouseReleased', x, Math.round(f0.b + dy)); await pump(22)
        }
      }
    })
  }
  // 4 点图片本体
  {
    await record('4 点图片本体', async ({ pump, mark }) => {
      await click(away.x, away.y, 260)
      const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
      mark('press'); await mouse('mousePressed', pt.x, pt.y); await pump(8)
      mark('release'); await mouse('mouseReleased', pt.x, pt.y); await pump(34)
    })
  }
  // 5 从图片后面往左拖（P1 主场景；拖动中截图）
  {
    await record('5 图后往左拖', async ({ pump, mark, shot }) => {
      await click(away.x, away.y, 260)
      const from = { x: Math.round(w1.r + 40), y: Math.round((w1.t + w1.b) / 2) }
      const to = { x: Math.round(g0.text.l + 6), y: textY }
      mark('press'); await mouse('mousePressed', from.x, from.y); await sleep(30)
      for (let k = 1; k <= 16; k++) { await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / 16, from.y + ((to.y - from.y) * k) / 16, { buttons: 1 }); await pump(2) }
      mark('shot'); await shot('tmp/drag-live-feedback-2.png')
      const mid = await snap()
      mark('release-pre'); await pump(2)
      await mouse('mouseReleased', to.x, to.y)
      out.p1 = { midDrag: mid, seqAtMidDrag: null }
      mark('release-post'); await pump(34)
    }, { preUp: null })
  }
  // 6 从空白带拖动
  {
    const g = await reveal254()
    const f0 = g.revealed.frags[0]
    const bandY = Math.round((f0.b + g.ovs[0].b) / 2)
    await record('6 空白带拖动', async ({ pump, mark }) => {
      await click(away.x, away.y, 260); await reveal254()
      const from = { x: Math.round((f0.l + f0.r) / 2), y: bandY }
      const to = { x: Math.round(f0.l + 380), y: Math.round((f0.t + f0.b) / 2) }
      mark('press'); await mouse('mousePressed', from.x, from.y); await sleep(30)
      for (let k = 1; k <= 12; k++) { await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / 12, from.y + ((to.y - from.y) * k) / 12, { buttons: 1 }); await pump(2) }
      mark('release'); await mouse('mouseReleased', to.x, to.y); await pump(30)
    })
  }
  // 7 从正文文字起手拖过图片
  {
    await record('7 正文起手拖过图', async ({ pump, mark }) => {
      await click(away.x, away.y, 260)
      const from = { x: Math.round(w0.l - 60), y: textY }
      const to = { x: Math.round(w1.r + 30), y: Math.round((w1.t + w1.b) / 2) }
      mark('press'); await mouse('mousePressed', from.x, from.y); await sleep(30)
      for (let k = 1; k <= 14; k++) { await mouse('mouseMoved', from.x + ((to.x - from.x) * k) / 14, from.y + ((to.y - from.y) * k) / 14, { buttons: 1 }); await pump(2) }
      mark('release'); await mouse('mouseReleased', to.x, to.y); await pump(30)
    })
  }
  // 8 单击图片后立刻再点同处
  {
    await record('8 连点图片两次(同处)', async ({ pump, mark }) => {
      await click(away.x, away.y, 300)
      const pt = await json(`(() => { const w = document.querySelector('.ProseMirror [data-img-widget][data-img-from="254"] img'); const r = w.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
      mark('click1'); await mouse('mousePressed', pt.x, pt.y); await pump(3); await mouse('mouseReleased', pt.x, pt.y); await pump(24)
      mark('click2'); await mouse('mousePressed', pt.x, pt.y); await pump(3); await mouse('mouseReleased', pt.x, pt.y); await pump(30)
    })
  }
  fs.writeFileSync(`tmp/audit113-${TAG}.json`, JSON.stringify(out, null, 1))
  for (const g of out.gestures) {
    console.log(`\n== ${g.name} frames=${g.frames} marks=${JSON.stringify(g.marks)} 回摆(可见)=${g.rbVis.length} 回摆(含选区)=${g.rbFull.length}`)
    console.log('   可见序列 ' + JSON.stringify(g.dedVis))
    if (g.rbVis.length) for (const h of g.rbVis) console.log('   RB ' + h)
    if (g.rbFull.length) for (const h of g.rbFull.slice(0, 6)) console.log('   RBF ' + h)
  }
  if (out.p1) console.log('\nP1 拖动中(未松手) imgSel=' + out.p1.midDrag.imgSel + ' [' + out.p1.midDrag.imgSelFrom + '] hl=' + out.p1.midDrag.hl + ' sel=' + out.p1.midDrag.from + '-' + out.p1.midDrag.to)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
