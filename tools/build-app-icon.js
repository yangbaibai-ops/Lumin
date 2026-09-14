// 生成 Lumin 的应用图标：SVG 母版 → PNG（多档）→ ICO（多尺寸打包）
//
// 为什么用这套办法（而不是引入 sharp / png-to-ico 之类的依赖）：
//  1. 光栅化交给**项目自己的 Chromium**（Electron 已运行，CDP 里开一个临时 about:blank 页面，
//     把 SVG 画进 canvas 再 toDataURL）——零新依赖，且拿到的就是 Chromium 的抗锯齿效果；
//  2. ICO 只是「6 字节头 + 每张 16 字节目录项 + PNG 负载」的容器（Vista 起支持 PNG 负载），
//    自己打包比装一个依赖更可控；
//  3. 产物写完立刻**回读校验**（PNG 的 IHDR、ICO 的目录项与偏移），不靠肉眼看。
//
// 用法：先跑 tools/_isolated-instance.ps1（提供 9222），再 node tools/build-app-icon.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const REPO = path.resolve(__dirname, '..')
const RES = path.join(REPO, 'resources')
const PORT = 9222

// ─── 设计参数（32 网格；改这里就等于改图标）───────────────────────────────────
// 概念：靛蓝圆角方块 + 一束光写下的 L（等宽圆头笔画，与界面里的线性图标同源）
const GRID = 32
const TILE_RADIUS = 7 // 22% ≈ Win11 那种方圆形
const STROKE = 6 // 16px 下正好 3px：最小档也不会糊
const V_X = 13 // 竖画中心线
const V_TOP = 10 // 竖画起点（圆头端点会让它看上去从 7 开始）
const CORNER_Y = 22 // 折角所在高度
const H_END = 22 // 横画终点（圆头会让它看上去到 25）
const ACCENT_TOP = '#6366F1' // 与 --accent 一致
const ACCENT_BOTTOM = '#4F46E5'
const FLAT = '#5A5CE8' // 小尺寸用的平色（去掉渐变，避免 16px 下变脏）

/** 大尺寸档（≥48px）：渐变底板 + 左上柔光 + 圆头笔画 */
function svgLarge() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID * 32}" height="${GRID * 32}" viewBox="0 0 ${GRID} ${GRID}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${ACCENT_TOP}"/>
      <stop offset="1" stop-color="${ACCENT_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.22" r="0.62">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${GRID}" height="${GRID}" rx="${TILE_RADIUS}" fill="url(#tile)"/>
  <rect width="${GRID}" height="${GRID}" rx="${TILE_RADIUS}" fill="url(#glow)"/>
  <path d="M${V_X} ${V_TOP} V${CORNER_Y} H${H_END}" fill="none" stroke="#FFFFFF" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`
}

/**
 * 小尺寸档（16/24/32px）：平色底板 + **方头**笔画。
 * 端点由圆改方，所以几何要往外补 STROKE/2，才能让字形外框与圆头版完全一致
 * （x 10..25、y 7..25）；16px 下方头对齐像素网格更锐利。
 */
function svgSmall() {
  const half = STROKE / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID * 32}" height="${GRID * 32}" viewBox="0 0 ${GRID} ${GRID}">
  <rect width="${GRID}" height="${GRID}" rx="${TILE_RADIUS}" fill="${FLAT}"/>
  <path d="M${V_X} ${V_TOP - half} V${CORNER_Y} H${H_END + half}" fill="none" stroke="#FFFFFF" stroke-width="${STROKE}" stroke-linecap="butt" stroke-linejoin="miter"/>
</svg>
`
}

// ─── CDP 小工具 ──────────────────────────────────────────────────────────────
function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

function connect(url, timeoutMs = 6000) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('connect timeout')), timeoutMs)
    ws.onopen = () => {
      clearTimeout(t)
      res()
    }
    ws.onerror = (e) => {
      clearTimeout(t)
      rej(e instanceof Error ? e : new Error('ws error'))
    }
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params, timeoutMs2 = 20000) =>
    new Promise((res) => {
      const i = ++id
      const t = setTimeout(() => {
        pending.delete(i)
        res({ timedOut: true })
      }, timeoutMs2)
      pending.set(i, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.timedOut) throw new Error('evaluate timeout')
    if (r.result?.exceptionDetails)
      throw new Error(
        'EXC ' +
          JSON.stringify(
            r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text
          ).slice(0, 240)
      )
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

/** 页面里注入的绘制器：**用 canvas 图元直接画**，不走 <img> + data:/blob: URL。
 *  两个原因：Electron 不允许 CDP 建临时页面（Target.createTarget / /json/new 都失败），
 *  只能在已有页面里画；而应用页面的 CSP 里没有 blob:，用 data: 图片又可能被策略拦。
 *  这里的图元与上面 SVG 母版是同一组常量，所以两边不会走样。 */
const PAINTER = `(() => {
  const G = ${GRID}, R = ${TILE_RADIUS}, SW = ${STROKE}
  const VX = ${V_X}, VT = ${V_TOP}, CY = ${CORNER_Y}, HE = ${H_END}
  const TOP = ${JSON.stringify(ACCENT_TOP)}, BOTTOM = ${JSON.stringify(ACCENT_BOTTOM)}, FLAT = ${JSON.stringify(FLAT)}
  const draw = (ctx, x0, y0, size, variant) => {
    const u = size / G
    ctx.save()
    ctx.translate(x0, y0)
    ctx.beginPath()
    ctx.roundRect(0, 0, size, size, R * u)
    if (variant === 'large') {
      const g = ctx.createLinearGradient(0, 0, 0, size)
      g.addColorStop(0, TOP); g.addColorStop(1, BOTTOM)
      ctx.fillStyle = g; ctx.fill()
      const rg = ctx.createRadialGradient(0.3 * size, 0.22 * size, 0, 0.3 * size, 0.22 * size, 0.62 * size)
      rg.addColorStop(0, 'rgba(255,255,255,0.16)'); rg.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = rg; ctx.fill()
    } else {
      ctx.fillStyle = FLAT; ctx.fill()
    }
    const round = variant === 'large'
    ctx.strokeStyle = '#FFFFFF'
    ctx.lineWidth = SW * u
    ctx.lineCap = round ? 'round' : 'butt'
    ctx.lineJoin = round ? 'round' : 'miter'
    ctx.beginPath()
    ctx.moveTo(VX * u, (round ? VT : VT - SW / 2) * u)
    ctx.lineTo(VX * u, CY * u)
    ctx.lineTo((round ? HE : HE + SW / 2) * u, CY * u)
    ctx.stroke()
    ctx.restore()
  }
  window.__lmIcon = {
    draw,
    toPng(size, variant) {
      const c = document.createElement('canvas')
      c.width = size; c.height = size
      const ctx = c.getContext('2d')
      draw(ctx, 0, 0, size, variant)
      const out = c.toDataURL('image/png')
      c.width = c.height = 0
      return out
    },
    /** 按 32 网格坐标取像素：用来证明「画出来的就是设计的样子」 */
    probe(size, variant, gridPoints) {
      const c = document.createElement('canvas')
      c.width = size; c.height = size
      const ctx = c.getContext('2d')
      draw(ctx, 0, 0, size, variant)
      const u = size / G
      const img = ctx.getImageData(0, 0, size, size).data
      const at = (gx, gy) => {
        const px = Math.min(size - 1, Math.max(0, Math.round(gx * u)))
        const py = Math.min(size - 1, Math.max(0, Math.round(gy * u)))
        const i = (py * size + px) * 4
        return [img[i], img[i + 1], img[i + 2], img[i + 3]]
      }
      const out = {}
      for (const p of gridPoints) out[p.k] = at(p.x, p.y)
      c.width = c.height = 0
      return JSON.stringify(out)
    },
    sheet(items, pad) {
      const rowH = 256 + pad * 2 + 264
      const width = items.reduce((a, it) => a + Math.max(it.size, 24) + pad, pad)
      const c = document.createElement('canvas')
      c.width = width; c.height = rowH * 2
      const ctx = c.getContext('2d')
      const row = (y, bg) => {
        ctx.fillStyle = bg; ctx.fillRect(0, y, width, rowH)
        let x = pad
        for (const it of items) {
          draw(ctx, x, y + pad, it.size, it.variant)
          x += Math.max(it.size, 24) + pad
        }
      }
      row(0, '#F5F6F8')
      row(rowH, '#0F1116')
      const out = c.toDataURL('image/png')
      c.width = c.height = 0
      return out
    }
  }
  return 'ok'
})()`

/** 把一段 SVG 光栅化成 size×size 的 PNG 缓冲（透明背景） */
async function raster(w, size, variant) {
  const dataUrl = await w.ev(`window.__lmIcon.toPng(${size}, ${JSON.stringify(variant)})`)
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,'))
    throw new Error('raster failed at ' + size)
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

/** 拼一张对照图（浅色 / 深色两条 + 各档原尺寸，供人工看观感） */
async function contactSheet(w, items, pad = 16) {
  const dataUrl = await w.ev(`window.__lmIcon.sheet(${JSON.stringify(items)}, ${pad})`)
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

// ─── ICO 打包（PNG 负载，Vista+）──────────────────────────────────────────────
function packIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o) // 0 表示 256
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1)
    dir.writeUInt8(0, o + 2) // 调色板色数（PNG 负载不用）
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // 位深
    dir.writeUInt32LE(e.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// ─── 回读校验 ────────────────────────────────────────────────────────────────
const isPng = (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47
function pngSize(b) {
  if (!isPng(b)) return null
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}
function parseIco(b) {
  if (b.length < 6 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null
  const count = b.readUInt16LE(4)
  const out = []
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    const size = b.readUInt8(o) === 0 ? 256 : b.readUInt8(o)
    const len = b.readUInt32LE(o + 8)
    const off = b.readUInt32LE(o + 12)
    const payload = b.subarray(off, off + len)
    out.push({ size, len, off, pngOk: isPng(payload), pngSize: pngSize(payload) })
  }
  return out
}

;(async () => {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  let version
  try {
    version = await get('/json/version')
  } catch {
    console.log('SKIP: 没有可用的 Chromium（先跑 tools/_isolated-instance.ps1 起隔离实例）')
    process.exit(2)
  }
  const browser = connect(version.webSocketDebuggerUrl)
  await browser.ready

  // Electron 不允许 CDP 建临时页面（Target.createTarget 与 PUT /json/new 都会失败），
  // 所以就在**已有页面**里画：只创建游离的 canvas、画完立刻释放，不碰应用的 DOM。
  const list = (await get('/json/list')).filter((t) => t.type === 'page')
  if (!list.length) {
    console.log('SKIP: 没有可用的页面')
    process.exit(2)
  }
  const w = connect(list[0].webSocketDebuggerUrl)
  await w.ready
  const ok = await w.ev(PAINTER)
  if (ok !== 'ok') throw new Error('painter injection failed')

  const largeSvg = svgLarge()
  const smallSvg = svgSmall()
  const variantOf = (size) => (size <= 32 ? 'small' : 'large')
  const pngs = {}
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024])
    pngs[s] = await raster(w, s, variantOf(s))

  // ── 产物 1：母版 SVG（给设计/其他平台用）──
  fs.writeFileSync(path.join(RES, 'icon.svg'), largeSvg, 'utf-8')
  // 小尺寸那版也留一份：方头/平色是刻意的，不要被当成手误
  fs.writeFileSync(path.join(RES, 'icon-small.svg'), smallSvg, 'utf-8')

  // ── 产物 2：icon.png（512，窗口图标用；比 1024 省一半解码内存，够高 DPI 用）──
  fs.writeFileSync(path.join(RES, 'icon.png'), pngs[512])

  // ── 产物 3：icon.ico（Windows：任务栏/窗口/快捷方式都读它）──
  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const ico = packIco(icoSizes.map((size) => ({ size, png: pngs[size] })))
  fs.writeFileSync(path.join(RES, 'icon.ico'), ico)

  // ── 对照图（人工看各档观感；我这边看不了图，交给你眼看一下）──
  const sheet = await contactSheet(
    w,
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, variant: variantOf(size) }))
  )
  const sheetPath = path.join(os.tmpdir(), 'lumin-icon-sheet.png')
  fs.writeFileSync(sheetPath, sheet)
  // 注意：CDP 连接要留到像素校验之后才能关（校验要在页面里取样）

  // ── 回读校验 ──
  const png = fs.readFileSync(path.join(RES, 'icon.png'))
  const pngInfo = pngSize(png)
  console.log('ICON-PNG ' + JSON.stringify({ bytes: png.length, ...pngInfo }))
  c(
    'icon.png-is-512-squared',
    !!pngInfo && pngInfo.w === 512 && pngInfo.h === 512,
    JSON.stringify(pngInfo)
  )

  // ── 像素级校验：证明画出来的就是设计的样子（按 32 网格坐标取样）──
  const points = [
    // 0.25 网格 ≈ 最角上的那个像素：16px 下圆角半径就有 3.5px，(1,1) 其实还在圆角以内
    { k: 'outsideCorner', x: 0.25, y: 0.25 }, // 圆角之外 → 必须完全透明
    { k: 'tileTop', x: 28, y: 6 }, // 底板右上（渐变浅端）
    { k: 'tileBottom', x: 28, y: 27 }, // 底板右下（渐变深端）
    { k: 'strokeV', x: 13, y: 14 }, // 竖画正中 → 白
    { k: 'strokeH', x: 20, y: 22 }, // 横画右段 → 白
    { k: 'insideBend', x: 20, y: 14 } // 折角内侧空白 → 底板色（证明是 L 不是实心块）
  ]
  const probeLarge = JSON.parse(
    await w.ev(`window.__lmIcon.probe(256, 'large', ${JSON.stringify(points)})`)
  )
  const probeSmall = JSON.parse(
    await w.ev(`window.__lmIcon.probe(16, 'small', ${JSON.stringify(points)})`)
  )
  console.log('PROBE-LARGE ' + JSON.stringify(probeLarge))
  console.log('PROBE-16 ' + JSON.stringify(probeSmall))
  const white = (p) => p[0] > 235 && p[1] > 235 && p[2] > 235
  const luma = (p) => p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114
  c(
    'corner-transparent',
    probeLarge.outsideCorner[3] === 0 && probeSmall.outsideCorner[3] === 0,
    JSON.stringify({ large: probeLarge.outsideCorner, small: probeSmall.outsideCorner })
  )
  c(
    'stroke-is-white',
    white(probeLarge.strokeV) &&
      white(probeLarge.strokeH) &&
      white(probeSmall.strokeV) &&
      white(probeSmall.strokeH),
    JSON.stringify({ v: probeLarge.strokeV, h: probeLarge.strokeH })
  )
  c(
    'shape-is-an-L-not-a-block',
    !white(probeLarge.insideBend) && !white(probeSmall.insideBend),
    JSON.stringify({ large: probeLarge.insideBend, small: probeSmall.insideBend })
  )
  c(
    'large-has-gradient',
    luma(probeLarge.tileTop) - luma(probeLarge.tileBottom) > 8,
    JSON.stringify({ top: probeLarge.tileTop, bottom: probeLarge.tileBottom })
  )
  c(
    'small-is-flat-color',
    probeSmall.tileTop.join() === probeSmall.tileBottom.join() &&
      probeSmall.tileTop[0] === 0x5a &&
      probeSmall.tileTop[1] === 0x5c &&
      probeSmall.tileTop[2] === 0xe8,
    JSON.stringify({ top: probeSmall.tileTop, bottom: probeSmall.tileBottom })
  )

  const icoBuf = fs.readFileSync(path.join(RES, 'icon.ico'))
  const dir = parseIco(icoBuf)
  console.log('ICON-ICO ' + JSON.stringify({ bytes: icoBuf.length, entries: dir }))
  c('icon.ico-has-7-entries', !!dir && dir.length === 7, String(dir?.length))
  c(
    'icon.ico-sizes-in-order',
    !!dir && dir.map((d) => d.size).join(',') === '16,24,32,48,64,128,256',
    dir?.map((d) => d.size).join(',')
  )
  c(
    'icon.ico-payloads-are-png',
    !!dir && dir.every((d) => d.pngOk),
    JSON.stringify(dir?.map((d) => d.pngOk))
  )
  c(
    'icon.ico-payload-dimensions-match',
    !!dir && dir.every((d) => d.pngSize && d.pngSize.w === d.size && d.pngSize.h === d.size),
    JSON.stringify(dir?.map((d) => d.pngSize))
  )
  c('icon.ico-no-overrun', !!dir && dir.every((d) => d.off + d.len <= icoBuf.length), 'ok')
  c('master-svg-written', fs.existsSync(path.join(RES, 'icon.svg')), path.join(RES, 'icon.svg'))
  c(
    'small-svg-written',
    fs.existsSync(path.join(RES, 'icon-small.svg')),
    path.join(RES, 'icon-small.svg')
  )
  c('contact-sheet-written', fs.existsSync(sheetPath), sheetPath)

  console.log('SHEET ' + sheetPath)
  browser.ws.close()
  w.ws.close()
  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
