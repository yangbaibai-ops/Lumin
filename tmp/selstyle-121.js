'use strict'
/**
 * 第一百二十一轮验收探针：拖动期（未松手） vs 松手后的**选中样式**逐项数值。
 *
 * 量法（不靠 rAF —— 窗口被遮挡时它会停摆）：
 *   * 几何：Node 侧 ~11ms 轮询 `Runtime.evaluate` 读：
 *       - 原生选区每行 x 范围（`Selection.getRangeAt(0).getClientRects()` 按行归并）
 *       - 我们**实画**的矩形（`.sel-band > div` 的 `getBoundingClientRect()` + CSS Highlight 各
 *         Range 的 `getClientRects()` + `img-selected` 元素矩形）
 *     ⇒ 逐帧判「原生覆盖 ⊇ 我们的绘制覆盖」，统计漏画行/片段数。
 *   * 观感：CDP 截图（拖动中一张、松手后一张），在本进程里解 PNG 逐像素量：
 *       每一列上「非纸面像素」的连续游程 = 那条带子的 top/bottom/height + 颜色；
 *       再在行中心扫一行，量带的连续段（缝隙）。
 *
 * 用法：node tmp/selstyle-121.js <port> <tag>
 */
const fs = require('fs')
const path = require('path')
const { decodePng, columnRun, rowRuns, paperColor, DIFF } = require('./png-util.js')

const PORT = process.argv[2] || '9351'
const TAG = process.argv[3] || 'a'
const FIXTURE = (process.env.TEMP || 'C:\\Windows\\Temp') + '\\xw-selband-fixture.md'
const OUTDIR = path.join(__dirname, 'shots-121')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(' ') + '\n')
const f2 = (n) => Number(n).toFixed(2)

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true })
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
    return r.result?.result?.value
  }
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`))
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
  const click = async (x, y, s = 300) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(s) }
  const dismiss = async () => { for (let i = 0; i < 8; i++) { const h = await ev(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^丢弃$|^放弃$|^确认$/.test((x.textContent||'').trim()))[0]; if (!b) return 0; b.click(); return 1 })()`); if (!h) break; await sleep(600) } }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(r.result.data, 'base64')
    fs.writeFileSync(path.join(OUTDIR, `${TAG}-${name}.png`), buf)
    return decodePng(buf)
  }
  const sel = () => ev(`(() => { const s = window.__vt.ed().state.selection; return s.from + '-' + s.to + (s.empty ? 'E' : '') })()`)

  // ── 引导：store 句柄 + wysiwyg + 打开夹具（与 tools/start-isolated.ps1 的 LUMIN_TRUSTED_PATHS=%TEMP% 配套）
  await ev(`(() => { if (window.__vt) return 'OK'
    const app = document.querySelector('#app')?.__vue_app__
    const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
    const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
    window.__vt = { files: () => pinia._s.get('files'), ed: () => pinia._s.get('editor')?.instance ?? null, ui: () => pinia._s.get('ui'), settings: () => pinia._s.get('settings') }
    return 'OK' })()`)
  await ev(`(async () => { try { window.__vt.settings().set('remoteImages', 'always') } catch (e) {} return 'ok' })()`)
  await ev(`(() => { window.__vt.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(300); await dismiss()
  await ev(`window.__open = window.__vt.files().openPath(${JSON.stringify(FIXTURE)}).then(() => 'ok').catch((e) => 'err:' + e.message); 'started'`, false)
  for (let i = 0; i < 24; i++) { await sleep(400); await dismiss(); if (await ev(`(window.__vt.files().content || '').length`)) break }
  await sleep(900); await dismiss()
  await send('Page.bringToFront').catch(() => null)
  await ev(`(() => { window.resizeTo(1440, 955); document.querySelector('.ProseMirror').focus(); return 'ok' })()`)
  await sleep(800)
  for (let i = 0; i < 40; i++) { if (await ev(`[...document.querySelectorAll('.ProseMirror img')].every((im) => im.complete && im.naturalWidth > 0)`)) break; await sleep(400) }

  // ── 页面侧探针（一次性安装）：原生矩形 / 我们实画的矩形 / 逐帧漏画判定
  await ev(`(() => {
    const R = (rg) => { const o = []; for (const r of rg.getClientRects()) { if (r.width > 0.5 || r.height > 0.5) o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return o }
    window.__P = {
      rects: R,
      native() { const s = window.getSelection(); if (!s || s.isCollapsed || !s.rangeCount) return { empty: true, rects: [] }; return { empty: false, rects: R(s.getRangeAt(0)) } },
      hl() { const h = window.CSS && CSS.highlights && CSS.highlights.get('lumin-img-drag'); if (!h) return []; const o = []; for (const rg of h) o.push(...R(rg)); return o },
      bands() { const o = []; for (const d of document.querySelectorAll('.sel-band > div')) { const r = d.getBoundingClientRect(); o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return o },
      imgSel() { const o = []; for (const w of document.querySelectorAll('.ProseMirror .img-selected')) { const r = w.getBoundingClientRect(); o.push([+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)]) } return o },
      lines(rects) {
        const L = []
        for (const r of rects) {
          let hit = L.find((x) => Math.min(x.b, r[3]) - Math.max(x.t, r[1]) > 0)
          if (!hit) { hit = { l: r[0], t: r[1], r: r[2], b: r[3] }; L.push(hit) }
          else { hit.l = Math.min(hit.l, r[0]); hit.r = Math.max(hit.r, r[2]); hit.t = Math.min(hit.t, r[1]); hit.b = Math.max(hit.b, r[3]) }
        }
        return L
      },
      frame() {
        const n = this.native(); const painted = [...this.bands(), ...this.hl()]
        const lines = this.lines(n.rects)
        let missFrags = 0, missLines = 0; const detail = []
        for (const r of n.rects) {
          const ok = painted.some((p) => Math.min(p[3], r[3]) - Math.max(p[1], r[1]) > -0.5 && p[0] <= r[0] + 0.5 && p[2] >= r[2] - 0.5)
          if (!ok) { missFrags++; if (detail.length < 3) detail.push(['frag', r]) }
        }
        for (const L of lines) {
          const ok = painted.some((p) => Math.min(p[3], L.b) - Math.max(p[1], L.t) > 0 && p[0] <= L.l + 0.5 && p[2] >= L.r - 0.5)
          if (!ok) { missLines++; if (detail.length < 3) detail.push(['line', [L.l, L.t, L.r, L.b]]) }
        }
        return { empty: n.empty, nRects: n.rects.length, nLines: lines.length, painted: painted.length,
          bands: this.bands().length, hl: this.hl().length, imgs: this.imgSel().length,
          missLines, missFrags, detail,
          nativeLines: lines.map((x) => [+x.l.toFixed(1), +x.t.toFixed(1), +x.r.toFixed(1), +x.b.toFixed(1)]) }
      },
      diag() {
        const d = document.querySelector('.ProseMirror')
        return { live: d.getAttribute('data-img-drag-live'), why: d.getAttribute('data-sel-band-why'), liveBand: d.getAttribute('data-sel-band-live'), settledBand: d.getAttribute('data-sel-band-settled'), fallback: d.getAttribute('data-img-settle-fallback') }
      },
      /* 目标行发现：含行内公式的行（公式在行首/行中/行尾）+ 块级公式 + 图片行 */
      targets() {
        const RR = (x) => [+x.left.toFixed(2), +x.top.toFixed(2), +x.right.toFixed(2), +x.bottom.toFixed(2)]
        const out = []
        const textRectsOf = (b) => {
          const acc = []; const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n
          while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) acc.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height }) }
          return acc
        }
        for (const b of [...document.querySelectorAll('.ProseMirror p, .ProseMirror li')]) {
          const maths = [...b.querySelectorAll('[data-md-math-rendered]')]
          if (!maths.length) continue
          const rects = textRectsOf(b)
          if (!rects.length) continue
          for (const m of maths) {
            const mr = RR(m.getBoundingClientRect())
            const row = rects.filter((r) => (mr[1] + mr[3]) / 2 >= r.t - 2 && (mr[1] + mr[3]) / 2 <= r.b + 2)
            if (!row.length) continue
            const L = Math.min(...row.map((r) => r.l)), Rt = Math.max(...row.map((r) => r.r))
            const T = Math.min(...row.map((r) => r.t)), B = Math.max(...row.map((r) => r.b))
            const rel = (mr[0] - L) / Math.max(1, Rt - L)
            const left = row.filter((r) => r.r <= mr[0] + 1), right = row.filter((r) => r.l >= mr[2] - 1)
            out.push({ kind: 'inline', pos: rel < 0.2 ? 'start' : rel > 0.7 ? 'end' : 'mid', blk: b.tagName + '.' + (b.className || ''), line: [L, T, Rt, B], formula: mr, lh: parseFloat(getComputedStyle(b).lineHeight), textH: row.map((r) => +r.h.toFixed(1)),
              bodyLeft: left.length ? [Math.min(...left.map((r) => r.l)), Math.min(...left.map((r) => r.t)), Math.max(...left.map((r) => r.r)), Math.max(...left.map((r) => r.b))] : null,
              bodyRight: right.length ? [Math.min(...right.map((r) => r.l)), Math.min(...right.map((r) => r.t)), Math.max(...right.map((r) => r.r)), Math.max(...right.map((r) => r.b))] : null })
          }
        }
        const bm = document.querySelector('.ProseMirror [data-md-math-block]')
        if (bm) {
          const r = RR(bm.getBoundingClientRect())
          const texts = []
          const w = document.createTreeWalker(bm, NodeFilter.SHOW_TEXT); let n
          while ((n = w.nextNode())) { if (!n.length) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const q of rg.getClientRects()) if (q.width > 0.5) texts.push([q.left, q.top, q.right, q.bottom]) }
          out.push({ kind: 'block', pos: 'block', line: r, formula: r, lh: parseFloat(getComputedStyle(bm.parentElement).lineHeight), textH: texts.map((t) => +(t[3] - t[1]).toFixed(1)), bodyLeft: null, bodyRight: null, katexTexts: texts.map((t) => t.map((v) => +v.toFixed(1))) })
        }
        const pi = [...document.querySelectorAll('.ProseMirror p')].find((x) => x.querySelector('[data-img-widget]'))
        if (pi) out.push({ kind: 'image', pos: 'img', line: RR(pi.getBoundingClientRect()), formula: null, lh: parseFloat(getComputedStyle(pi).lineHeight), textH: [], bodyLeft: null, bodyRight: null, widgets: [...pi.querySelectorAll('[data-img-widget]')].map((w) => RR(w.getBoundingClientRect())) })
        return out
      },
      awayPoint() {
        const q = [...document.querySelectorAll('.ProseMirror p')].find((x) => !x.querySelector('[data-md-math-rendered],[data-md-math-block],[data-img-widget]') && x.getBoundingClientRect().height > 10)
        if (!q) return { x: 40, y: 300 }
        const r = q.getBoundingClientRect()
        return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }
      }
    }
    return 'ok'
  })()`)

  const away = await json(`window.__P.awayPoint()`)
  const targets = await json(`window.__P.targets()`)
  log(`# 夹具 ${FIXTURE}  目标 ${targets.length} 个`)
  for (const T of targets) log(`#   ${T.kind}/${T.pos} line=${JSON.stringify(T.line)} lh=${T.lh} textH=${JSON.stringify(T.textH)} formula=${JSON.stringify(T.formula)}`)

  const out = { tag: TAG, targets: [], cases: [] }

  /** 一次「按住不放」的单行拖动：逐帧几何 + 两张截图 */
  const runCase = async (label, T, opts) => {
    const [L, Tp, R, B] = T.line
    const y = Math.round((Tp + B) / 2)
    let pressX, endX
    if (opts.reverse) { pressX = Math.round(Math.min(R - 2, (T.formula ? T.formula[2] : R) + 6)); endX = Math.round(L + 2) }
    else { pressX = Math.round(L + 2); endX = T.formula ? Math.round(T.formula[2] + 4) : Math.round(R - 2) }
    await click(away.x, away.y, 320)
    await mouse('mousePressed', pressX, y)
    await sleep(40)
    const steps = 14
    for (let k = 1; k <= steps; k++) {
      await mouse('mouseMoved', pressX + ((endX - pressX) * k) / steps, y, { buttons: 1 })
      await sleep(16)
    }
    await sleep(60)
    // ── 逐帧取证（Node 侧 11ms 轮询）
    const frames = []
    for (let i = 0; i < 26; i++) {
      const f = await json(`window.__P.frame()`)
      const d = await json(`window.__P.diag()`)
      f.sel = await sel()
      f.t = i
      f.live = d.live
      f.why = d.why
      frames.push(f)
      await sleep(11)
    }
    const dragShot = await shot(`${label.replace(/[^\w.-]/g, '_')}-drag`)
    const midSel = await sel()
    const midDiag = await json(`window.__P.diag()`)
    const midFrame = await json(`window.__P.frame()`)
    await mouse('mouseReleased', endX, y)
    await sleep(520)
    const settledShot = await shot(`${label.replace(/[^\w.-]/g, '_')}-settled`)
    const settledSel = await sel()
    const settledDiag = await json(`window.__P.diag()`)
    const settledFrame = await json(`window.__P.frame()`)
    const leak = await json(`({ bandKids: document.querySelectorAll('.sel-band > div').length, band: document.querySelectorAll('.sel-band').length, imgSel: document.querySelectorAll('.ProseMirror .img-selected').length })`)
    await click(away.x, away.y, 250)

    // ── 像素量：列游程（拖动中 vs 松手后）
    const paperD = paperColor(dragShot)
    const paperS = paperColor(settledShot)
    const cols = {}
    const addCol = (name, x) => {
      const x0 = Math.round(x)
      cols[name] = { x: x0, drag: columnRun(dragShot, x0, Tp - 30, B + 30, paperD), settled: columnRun(settledShot, x0, Tp - 30, B + 30, paperS) }
    }
    if (T.formula) addCol('formula', (T.formula[0] + T.formula[2]) / 2)
    if (T.bodyLeft) addCol('bodyL', (T.bodyLeft[0] + Math.min(T.bodyLeft[2], T.formula ? T.formula[0] - 2 : T.bodyLeft[2])) / 2)
    if (T.bodyRight) addCol('bodyR', (Math.max(T.bodyRight[0], T.formula ? T.formula[2] + 2 : T.bodyRight[0]) + T.bodyRight[2]) / 2)
    if (T.formula && T.bodyRight) addCol('gapR', T.formula[2] + 3)
    if (T.formula && T.bodyLeft) addCol('gapL', T.formula[0] - 3)
    const rowY = y
    const runsDrag = rowRuns(dragShot, rowY, Math.round(L) - 4, Math.round(R) + 8, paperD)
    const runsSettled = rowRuns(settledShot, rowY, Math.round(L) - 4, Math.round(R) + 8, paperS)
    const cmp = (a, b) => (!a || !b ? null : { dt: Math.abs(a.top - b.top), db: Math.abs(a.bottom - b.bottom), dh: Math.abs(a.height - b.height), dcolor: DIFF(a.edge, b.edge) })
    const rows = {}
    for (const [k, v] of Object.entries(cols)) {
      rows[k] = {
        x: v.x,
        drag: v.drag && { top: v.drag.top, bottom: v.drag.bottom, h: v.drag.height, edge: v.drag.edge },
        settled: v.settled && { top: v.settled.top, bottom: v.settled.bottom, h: v.settled.height, edge: v.settled.edge },
        delta: cmp(v.drag, v.settled)
      }
    }
    const rec = {
      label, kind: T.kind, pos: T.pos, y, pressX, endX, lh: T.lh, textH: T.textH, line: T.line, formula: T.formula,
      midSel, settledSel,
      midDiag: { live: midDiag.live, why: midDiag.why, fallback: midDiag.fallback, liveBand: midDiag.liveBand, settledBand: midDiag.settledBand },
      leak,
      frameStats: {
        n: frames.length,
        missLinesMax: Math.max(...frames.map((f) => f.missLines)),
        missFragsMax: Math.max(...frames.map((f) => f.missFrags)),
        missSum: frames.reduce((a, f) => a + f.missLines + f.missFrags, 0),
        noBandFrames: frames.filter((f) => f.nativeLines.length > 0 && f.painted === 0).length,
        noBandFramesWithBandAttr: frames.filter((f) => f.nativeLines.length > 0 && f.painted === 0 && (f.live || '')).length,
        emptyNativeFrames: frames.filter((f) => f.empty).length,
        paintedMin: Math.min(...frames.map((f) => f.painted)),
        frames: frames.map((f) => `${f.t}:n${f.nRects}/L${f.nLines}/p${f.painted}(b${f.bands}+h${f.hl})/miss${f.missLines}/${f.missFrags} sel${f.sel}`)
      },
      midFrame: { nRects: midFrame.nRects, nLines: midFrame.nLines, painted: midFrame.painted, bands: midFrame.bands, hl: midFrame.hl, imgs: midFrame.imgs, missLines: midFrame.missLines, missFrags: midFrame.missFrags, nativeLines: midFrame.nativeLines, detail: midFrame.detail },
      settledFrame: { nRects: settledFrame.nRects, nLines: settledFrame.nLines, missLines: settledFrame.missLines, missFrags: settledFrame.missFrags },
      paper: { drag: paperD, settled: paperS },
      cols: rows,
      runsDrag, runsSettled
    }
    out.cases.push(rec)
    // ── 打印
    log(`\n=== ${label} (${T.kind}/${T.pos}) y=${y} press=${pressX}→${endX} lh=${T.lh} 文字盒高=${JSON.stringify(T.textH)}`)
    log(`    sel 拖动中=${midSel} 松手后=${settledSel}  fallback=${midDiag.fallback}`)
    log(`    漏画统计(逐帧): missLinesMax=${rec.frameStats.missLinesMax} missFragsMax=${rec.frameStats.missFragsMax} 空原生帧=${rec.frameStats.emptyNativeFrames}/${rec.frameStats.n} paintedMin=${rec.frameStats.paintedMin}`)
    log(`    拖动中帧: nRects=${midFrame.nRects} nLines=${midFrame.nLines} painted=${midFrame.painted}(带${midFrame.bands}+高亮${midFrame.hl}) 漏行=${midFrame.missLines} 漏片=${midFrame.missFrags}`)
    log(`    泄漏: ${JSON.stringify(leak)}`)
    for (const [k, v] of Object.entries(rows)) {
      const d = v.delta
      log(`    列 ${k.padEnd(8)} x=${String(v.x).padStart(4)}  拖动中=${v.drag ? `t${v.drag.top} b${v.drag.bottom} h${v.drag.h} rgb${v.drag.edge}` : 'null'}  松手后=${v.settled ? `t${v.settled.top} b${v.settled.bottom} h${v.settled.h} rgb${v.settled.edge}` : 'null'}  Δ=${d ? `t${d.dt} b${d.db} h${d.dh} 色${d.dcolor}` : 'n/a'}`)
    }
    log(`    行中心连续段 拖动中=${JSON.stringify(runsDrag)} 松手后=${JSON.stringify(runsSettled)}`)
    return rec
  }

  // ── 逐个目标（同一行内拖动，避免跨行带相连影响逐列测量）
  const pick = (kind, pos) => targets.filter((T) => T.kind === kind && (!pos || T.pos === pos))
  const plan = []
  for (const T of pick('inline', 'start')) { plan.push([`S1-行首`, T, {}]); break }
  for (const T of pick('inline', 'mid')) { plan.push([`S1-行中`, T, {}]); break }
  for (const T of pick('inline', 'end')) { plan.push([`S1-行尾`, T, {}]); break }
  for (const T of pick('block', 'block')) { plan.push([`S2-块级公式`, T, {}]); break }
  for (const T of pick('inline', 'mid').slice(1)) { plan.push([`S2-行内公式`, T, {}]); break }
  for (const T of pick('image', 'img')) { plan.push([`S2-图片行`, T, { reverse: false }]); break }
  for (const [label, T, o] of plan) await runCase(label, T, o)

  // ── 跨行拖动（从图片后往左 / 起手拖过图）：逐帧漏画 + 无回摆序列
  const imgT = pick('image', 'img')[0]
  if (imgT && imgT.widgets && imgT.widgets.length >= 2) {
    const w2 = imgT.widgets[1]
    const start = { x: Math.round(w2[2] + 30), y: Math.round((w2[1] + w2[3]) / 2) }
    const dest = targets.find((T) => T.kind === 'block') || targets[0]
    const dy = Math.round((dest.line[1] + dest.line[3]) / 2)
    const dx = Math.round(dest.line[0] + 30)
    const frames = []
    const cover = []
    await click(away.x, away.y, 300)
    await mouse('mousePressed', start.x, start.y)
    await sleep(40)
    for (let k = 1; k <= 18; k++) {
      await mouse('mouseMoved', start.x + ((dx - start.x) * k) / 18, start.y + ((dy - start.y) * k) / 18, { buttons: 1 })
      await sleep(16)
      const f = await json(`window.__P.frame()`)
      f.sel = await sel()
      frames.push(f)
      await sleep(9)
      const f2 = await json(`window.__P.frame()`)
      f2.sel = await sel()
      frames.push(f2)
    }
    const dragShot = await shot('crossdrag-drag')
    const midSel = await sel()
    await mouse('mouseReleased', dx, dy)
    await sleep(520)
    const settledShot = await shot('crossdrag-settled')
    const settledSel = await sel()
    const leak = await json(`({ bandKids: document.querySelectorAll('.sel-band > div').length, band: document.querySelectorAll('.sel-band').length, imgSel: document.querySelectorAll('.ProseMirror .img-selected').length })`)
    // 可见覆盖（去重序列）：原生矩形并集的 x 与面积
    const xset = frames.map((f) => (f.nativeLines.length ? [Math.round(Math.min(...f.nativeLines.map((l) => l[0]))), Math.round(Math.max(...f.nativeLines.map((l) => l[2])))] : null))
    const seq = frames.map((f) => `${f.empty ? 'E' : f.nRects}@${f.nativeLines.length ? Math.round(f.nativeLines[0][0]) + '-' + Math.round(f.nativeLines[f.nativeLines.length - 1][2]) : '-'}/p${f.painted}/m${f.missLines}.${f.missFrags}`)
    const uniq = seq.filter((s, i) => i === 0 || s !== seq[i - 1])
    const paperD = paperColor(dragShot)
    const paperS = paperColor(settledShot)
    const cross = { label: '跨行-图片后往左', start, dest: { dx, dy }, midSel, settledSel, leak, frames: seq, uniq,
      missLinesMax: Math.max(...frames.map((f) => f.missLines)), missFragsMax: Math.max(...frames.map((f) => f.missFrags)),
      emptyFrames: frames.filter((f) => f.empty).length,
      noBandFrames: frames.filter((f) => !f.empty && f.painted === 0).length,
      paper: { drag: paperD, settled: paperS } }
    out.cross = cross
    log(`\n=== 跨行拖动（图片后 ${start.x},${start.y} → 块级公式行 ${dx},${dy}）`)
    log(`    sel 拖动中=${midSel} 松手后=${settledSel} 漏行Max=${cross.missLinesMax} 漏片Max=${cross.missFragsMax} 空原生帧=${cross.emptyFrames}/${frames.length} 无绘制帧=${cross.noBandFrames}`)
    log(`    去重序列(${uniq.length}/${seq.length})=${JSON.stringify(uniq)}`)
    log(`    泄漏: ${JSON.stringify(leak)}`)
  }

  fs.writeFileSync(path.join(OUTDIR, `selstyle121-${TAG}.json`), JSON.stringify(out, null, 1))
  log(`\n# 证据 JSON: tmp/shots-121/selstyle121-${TAG}.json`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1) })
