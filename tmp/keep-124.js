'use strict'
/** 第一百二十四轮 · 不破坏项最小探针：空白带单击/点别处/往返逐字节/带内拖动≡同列字形拖动 */
const PORT = process.argv[2] || '9351'
const TMP = process.env.TEMP || 'C:\\Windows\\Temp'
const FIXTURE = TMP + '\\xw-selband-fixture.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (t, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type: t, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 320) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  await ev(`(() => { if (window.__vt) return 1
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 1 })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); return 'ok' })()`)
  await ev(`window.__o = window.__vt.files().openPath(${JSON.stringify(FIXTURE)}).then(() => 'ok').catch((e) => 'err:' + e.message); 1`, false)
  for (let i = 0; i < 30; i++) { await sleep(300); if (await ev(`(window.__vt.files().content || '').length`)) break }
  for (let i = 0; i < 30; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(300) }
  await sleep(500)
  const geom = await json(`(() => { const R = (r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]; const p = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]')); const w = [...p.querySelectorAll('[data-img-widget]')]; const tn = [...p.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 3); const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, Math.min(4, tn.length)); return { para: R(p.getBoundingClientRect()), text: R(rg.getBoundingClientRect()), imgs: w.map((x) => R(x.getBoundingClientRect())) } })()`)
  const st = () => json(`(() => { const s = window.__vt.ed().state.selection; const el = document.querySelector('.ProseMirror [data-img-revealed]'); return { sel: s.from + '-' + s.to + (s.empty ? 'E' : ''), revealed: document.querySelectorAll('.ProseMirror [data-img-revealed]').length, editing: el ? String(el.className).includes('--editing') : null, open: document.querySelector('.ProseMirror').getAttribute('data-img-open') } })()`)
  const away = { x: 1200, y: 830 }
  // ① 空白带单击（图右侧空白）
  await click(away.x, away.y, 300)
  const w = geom.imgs[0]
  await click(Math.round(w[2] + 26), Math.round((w[1] + w[3]) / 2), 520)
  const blank = await st()
  log(`① 空白带单击: ${JSON.stringify(blank)}`)
  // ② 点真正别处 ⇒ revealed=0
  await click(away.x, away.y, 420)
  const awaySt = await st()
  log(`② 点别处: ${JSON.stringify(awaySt)}`)
  // ③ getMarkdown 往返逐字节
  const rt = await json(`(() => { const md = window.__vt.ed().storage.markdown.getMarkdown(); window.__rtMd = md; window.__vt.ed().commands.setContent(md); return { len: md.length } })()`)
  await sleep(700)
  const rt2 = await json(`(() => { const md = window.__vt.ed().storage.markdown.getMarkdown(); return { len: md.length, byteEqual: md === window.__rtMd } })()`)
  log(`③ 往返: ${JSON.stringify(rt)} → ${JSON.stringify(rt2)}`)
  // ④ 带内拖动 ≡ 同列字形拖动：同一"列"上分别从空白带 / 字形起手，拖到同一点
  const drag = async (x0, y0, x1, y1) => {
    await click(away.x, away.y, 300)
    await mouse('mousePressed', x0, y0); await sleep(30)
    for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8, { buttons: 1 }); await sleep(16) }
    await sleep(60)
    const mid = await st()
    await mouse('mouseReleased', x1, y1); await sleep(400)
    const post = await st()
    return { x0, y0, x1, y1, mid, post }
  }
  // 先让源码显形，再量：空白带列 = 图右侧的空白（x = w[2]+26），同列字形 = 源码字形上（x 同上但 y 取源码字形行）——用第 2 张图的源码行
  const g2 = geom.imgs[geom.imgs.length - 1]
  await click(Math.round(g2[2] + 26), Math.round((g2[1] + g2[3]) / 2), 520)
  const rev = await json(`(() => { const el = document.querySelector('.ProseMirror [data-img-revealed]'); if (!el) return null; const v = window.__vt.ed().view; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n = null, f = null, l = null; while ((n = w.nextNode())) { if (!n.length) continue; if (!f) f = n; l = n } let s = NaN, e = NaN; try { if (f) { s = v.posAtDOM(f, 0); e = v.posAtDOM(l, l.length) } } catch (err) {} return { from: s, to: e, rows: [...el.getClientRects()].map((r) => [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } })()`)
  log(`# 第2张图源码区间=${JSON.stringify(rev && [rev.from, rev.to])} 行=${JSON.stringify(rev && rev.rows)}`)
  if (rev && rev.rows.length) {
    const row = rev.rows[0]
    const y = Math.round((row[1] + row[3]) / 2)
    const xb = Math.round(row[0] + 10)
    const bandDrag = await drag(xb, y, Math.round(row[2] - 40), y)
    log(`④ 带内拖动(源码行内 x=${xb}..): mid=${JSON.stringify(bandDrag.mid)} post=${JSON.stringify(bandDrag.post)}`)
  }
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
