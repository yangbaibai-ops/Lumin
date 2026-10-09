'use strict'
/**
 * 独立探针（第三十三轮交付物）：**用户自己跑**，用来复现/定位"反向拖过表格丢尾巴"。
 *
 * 用法（不要改任何文件；只在内存里做手势）：
 *   1) 让应用带调试端口起来（见报告里给的确切命令 / 或已有的 dev:debug 脚本）；
 *   2) 在应用里打开出现问题的文档；
 *   3) PowerShell：  Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
 *                    node tools/_probe-sel-tail.js
 * 输出：视口/DPR/zoom、表格与起点块几何、逐拍 from/to+posAtCoords+scrollTop、标记字号、
 *       pointerup/mouseup 捕获与冒泡两侧的选区（顺序表）、以及"丢尾巴=true/false"的结论。
 * 本脚本不写文件、不改文档、不动设置。
 */
const PORT = process.env.LUMIN_DEBUG_PORT || '9222'
const CDP = 'http://127.0.0.1:' + PORT + '/json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
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
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result && r.result.exceptionDetails)
      throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description || ''))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const S = `JSON.stringify((() => { const ed = window.__L.ed(); const s = ed.state.selection; const m = [...document.querySelectorAll('.md-marker')]; return { from: s.from, to: s.to, type: s.constructor.name, fs: m.map((x) => getComputedStyle(x).fontSize).join('/').slice(0, 30), text: ed.state.doc.textBetween(s.from, s.to, '/').slice(-30), st: Math.round(document.querySelector('.ProseMirror').scrollTop) } })())`
const PT = (w) =>
  `(() => { for (const p of [...document.querySelectorAll('.ProseMirror p, .ProseMirror td')]) { const it = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); while (it.nextNode()) { if (it.currentNode.textContent.includes(${JSON.stringify(w)})) { const n = it.currentNode; const i = n.textContent.indexOf(${JSON.stringify(w)}); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const b = r.getBoundingClientRect(); return { found: true, x: b.left + b.width / 2, y: b.top + b.height / 2, inView: b.top >= 0 && b.bottom <= innerHeight } } } } return { found: false } })()`
const START = `JSON.stringify((() => { const t = document.querySelector('.ProseMirror table'); if (!t) return { found: false, why: 'no-table' }; let n = t.closest('.tableWrapper') ? t.closest('.tableWrapper').nextElementSibling : t.parentElement.nextElementSibling; let hops = 0; while (n) { const it = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); let txt = null; while (it.nextNode()) { if (it.currentNode.textContent.trim()) { txt = it.currentNode; break } } if (txt) { const r = document.createRange(); r.setStart(txt, 0); r.setEnd(txt, 1); const b = r.getBoundingClientRect(); if (b.top >= 0 && b.bottom <= innerHeight) return { found: true, x: b.left + b.width / 2, y: b.top + b.height / 2, tag: n.tagName, hops, sample: txt.textContent.slice(0, 18) } } n = n.nextElementSibling; hops += 1 } return { found: false, why: 'exhausted' } })())`
const AT = (x, y) =>
  `(() => { const a = window.__L.ed().view.posAtCoords({ left: ${Math.round(x)}, top: ${Math.round(y)} }); return a ? a.pos : -1 })()`
const LOGGER = `(() => { window.__log = []; const snap = (tag) => { const s = window.__L.ed().state.selection; const m = [...document.querySelectorAll('.md-marker')]; window.__log.push(tag + ' ' + s.from + '-' + s.to + ' fs=' + m.map((x) => getComputedStyle(x).fontSize).join('/').slice(0, 20)) }; for (const e of ['pointerup', 'mouseup']) { document.addEventListener(e, () => snap('CAP:' + e), true); document.addEventListener(e, () => snap('BUB:' + e), false) } return 'ok' })()`

async function main() {
  let targets
  try {
    targets = await (await fetch(CDP)).json()
  } catch (e) {
    console.log('连不上调试端口 ' + PORT + '：' + e.message)
    return 1
  }
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) {
    console.log('找不到可调试页面')
    return 1
  }
  const app = connect(page.webSocketDebuggerUrl)
  await app.ready
  const { ev, send } = app
  // 等待渲染进程把编辑器桥挂上来（否则下面的环境判定/载文档都会误判为“不是编辑器”）
  let bridged = false
  for (let i = 0; i < 80; i += 1) {
    try {
      if (await ev('!!(window.__L && window.__L.ed && window.__L.ed())')) {
        bridged = true
        break
      }
    } catch {
      // 页面还在导航/热更中，继续等
    }
    await sleep(150)
  }
  if (!bridged) console.log('警告：等了 12s 仍未见 window.__L.ed()，下面可能报“不是编辑器”')
  // 可选：覆盖视口（LUMIN_PROBE_VIEWPORT=2560x1440）。不设就用应用窗口自身的尺寸。
  const vp = process.env.LUMIN_PROBE_VIEWPORT || ''
  if (vp) {
    const m = /^(\d+)x(\d+)$/.exec(vp)
    if (m) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: Number(m[1]),
        height: Number(m[2]),
        deviceScaleFactor: 0,
        mobile: false
      })
      await sleep(400)
      console.log('已覆盖视口=' + vp)
    } else {
      console.log('LUMIN_PROBE_VIEWPORT 格式应为 宽x高，已忽略：' + vp)
    }
  }
  const env = await ev(
    `JSON.stringify({ innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio, bodyZoom: getComputedStyle(document.body).zoom, hasL: !!window.__L, hasEd: !!(window.__L && window.__L.ed && window.__L.ed()) })`
  )
  console.log('环境=' + env)
  const docPath = process.env.LUMIN_DOC || ''
  if (docPath) {
    try {
      const md = require('fs').readFileSync(docPath, 'utf8')
      await ev(
        '(() => { const f = window.__L.files(); f.current = { path: ' +
          JSON.stringify(docPath) +
          ', name: ' +
          JSON.stringify(docPath.split(/[\\/]/).pop()) +
          ', content: ' +
          JSON.stringify(md) +
          ', mtimeMs: Date.now(), savedContent: ' +
          JSON.stringify(md) +
          ' }; return "ok" })()'
      )
      for (let i = 0; i < 60; i += 1) {
        if (await ev("window.__L.ed().state.doc.textContent.includes('修掉 4 处真实漂移')")) break
        await sleep(120)
      }
      console.log(
        '已载入文档=' +
          docPath +
          ' 命中锚点=' +
          (await ev("window.__L.ed().state.doc.textContent.includes('修掉 4 处真实漂移')"))
      )
    } catch (e) {
      console.log('载入文档失败: ' + e.message)
    }
  }
  if (!(await ev('!!(window.__L && window.__L.ed && window.__L.ed())'))) {
    console.log('这个页面不是编辑器（请对准应用窗口的 page 目标）')
    return 1
  }
  await ev(
    `(() => { const t = document.querySelector('.ProseMirror table'); if (t) t.scrollIntoView({ block: 'center' }); return 'ok' })()`
  )
  await sleep(600)
  console.log(
    '表格=' +
      (await ev(
        `(() => { const t = document.querySelector('.ProseMirror table'); if (!t) return 'NO-TABLE'; const r = t.getBoundingClientRect(); return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }) })()`
      ))
  )
  const start = JSON.parse(await ev(START))
  const target = await ev(PT('远程图片'))
  console.log('起点块=' + JSON.stringify(start))
  console.log('终点(远程图片)=' + JSON.stringify(target))
  if (!start.found || !target.found || !target.inView) {
    console.log('⛔ 几何核验失败：请把文档滚到"整张表 + 表格下方那一块"都能看见，然后重跑')
    return 1
  }
  const mouse = (t, x, y, b) =>
    send('Input.dispatchMouseEvent', {
      type: t,
      x: Math.round(x),
      y: Math.round(y),
      button: t === 'mouseMoved' && !b ? 'none' : 'left',
      buttons: b,
      clickCount: 1
    })
  await ev(LOGGER)
  await mouse('mouseMoved', start.x, start.y, 0)
  await mouse('mousePressed', start.x, start.y, 1)
  await sleep(120)
  const seq = []
  for (let i = 1; i <= 6; i += 1) {
    const x = start.x + ((target.x - start.x) * i) / 6
    const y = start.y + ((target.y - start.y) * i) / 6
    await mouse('mouseMoved', x, y, 1)
    await sleep(80)
    seq.push({ at: await ev(AT(x, y)), ...JSON.parse(await ev(S)) })
  }
  await mouse('mouseReleased', target.x, target.y, 0)
  const t0 = JSON.parse(await ev(S))
  await sleep(16)
  const t1 = JSON.parse(await ev(S))
  await sleep(34)
  const t2 = JSON.parse(await ev(S))
  await sleep(120)
  const t3 = JSON.parse(await ev(S))
  const maxTo = Math.max(...seq.map((s) => s.to))
  const minFrom = Math.min(...seq.map((s) => s.from))
  console.log(
    '逐拍 ' +
      JSON.stringify(seq.map((s) => s.from + '-' + s.to + '(at' + s.at + ',st' + s.st + ')'))
  )
  console.log(
    '四时点 ' +
      JSON.stringify([t0, t1, t2, t3].map((s) => s.from + '-' + s.to)) +
      ' 一致=' +
      (new Set([t0, t1, t2, t3].map((s) => s.from + '-' + s.to)).size === 1)
  )
  console.log(
    '最长=[' +
      minFrom +
      ',' +
      maxTo +
      '] 松手=[' +
      t3.from +
      ',' +
      t3.to +
      '] ==最长=' +
      (t3.from === minFrom && t3.to === maxTo) +
      '  丢尾巴=' +
      (t3.to < maxTo)
  )
  console.log(
    '松手尾巴=[' +
      t3.text +
      ']  标记字号=' +
      t3.fs +
      '  scrollTop轨迹=' +
      JSON.stringify(seq.map((s) => s.st).concat([t0.st, t1.st, t2.st, t3.st]))
  )
  console.log('顺序表 ' + JSON.stringify(await ev('window.__log')))
  console.log('把以上全部输出原样贴回即可。')
  app.ws.close()
  return 0
}
main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
