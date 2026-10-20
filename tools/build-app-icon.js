// 生成 Lumin 的应用图标：SVG 母版 → PNG（多档）→ ICO（多尺寸打包），并出一张候选对照图
//
// ── 设计：一条折起来的「光带 L」 ─────────────────────────────────────────────
// 上一版是「靛蓝方块 + 一个白字母」，问题在于它只是把字体字母摆在方块正中：没有结构、没有光、
// 比例也怯。这一版做了三件事：
//   1. **字形成结构**：L 不再是一笔字母，而是**一条折起来的光带**——竖面与横面在折角处由一条
//      45° 折痕分成受光面与背光面，两段明度差让它有「体积」而不是「字形」；三个外角收 2 单位
//      圆角、内侧折角保持尖锐，圆与锐的对比就是设计感的来源。
//   2. **字面放大到 59%**（x 8..26、y 7..25）：大气来自敢占位置，上一版的 47% 是怯的。
//   3. **底是有光的**：对角（135°）渐变定光向，中央一团同色系辉光垫在字后面，内圈一条渐隐描边
//      当玻璃边缘——扁平，但不呆板。
//
// ── 生成方式（零新依赖）──────────────────────────────────────────────────────
//   * 光栅化交给**项目自己的 Chromium**（canvas 图元 + Path2D，与 SVG 母版共用同一份路径字符串
//     与同一组常量，两边不可能走样）；
//   * Electron 不允许 CDP 建临时页面（Target.createTarget / PUT /json/new 都失败），所以就在已有
//     页面里画游离 canvas，画完立刻释放；也不用 data:/blob: 图片（应用页面 CSP 里没有 blob:）；
//   * ICO 自己打包（6 字节头 + 每张 16 字节目录项 + PNG 负载，Vista 起支持）；
//   * 写完**回读校验**，并按网格坐标**取像素**证明「画出来的就是设计的样子」（含折痕明暗差）。
//
// 用法：先跑 tools/start-isolated.ps1，再 node tools/build-app-icon.js
//
// ⚠️ 本脚本是**旧设计的母版生成器**，默认不再写进 resources/：
//    现行图标是**用户交付的位图**（`resources/icon.png` 1024×1024 + 由 `tools/pack-ico.js`
//    从它打出的七档 DIB `resources/icon.ico`）。本脚本画的是上一版「折带 L」，直接写盘会
//    把用户的设计覆盖掉，于是「开发态一个新图标、装完一个旧图标」重现。
//    * 默认：产物写到 %TEMP%\lumin-icon-redesign\，只做自检与观感对照，**不碰 resources/**；
//    * 真要重新生成旧设计：加 `--force`（确认过再敲，见 docs/wysiwyg-manual.md §4.36）。
//    换图标请改 `resources/icon.png` 后跑 `node tools/pack-ico.js`（保持单一来源）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const REPO = path.resolve(__dirname, '..')
const RES = path.join(REPO, 'resources')
/** 默认输出目录（隔离，不覆盖现行图标）；`--force` 时才 = resources/ */
const OUT = process.argv.includes('--force') ? RES : path.join(os.tmpdir(), 'lumin-icon-redesign')
const PORT = 9222

// ─── 几何（32 网格；改这里等于改图标）────────────────────────────────────────
const GRID = 32
const TILE_RADIUS = 8 // 25%：比方圆形再圆一点，现代感来自这个比例
/** 折带 L 外轮廓：x 8..26、y 7..25（占字面 59%），三个外角 r=2，内侧折角尖锐 */
const MARK_PATH = 'M10 7 H17 V16 H24 A2 2 0 0 1 26 18 V23 A2 2 0 0 1 24 25 H8 V9 A2 2 0 0 1 10 7 Z'
/** 小尺寸（16/24/32px）用方角版：像素网格上更锐利 */
const MARK_PATH_SMALL = 'M8 7 H17 V16 H26 V25 H8 Z'
/** 折痕：从内侧折角 (17,16) 斜下到左缘 (8,25)，把竖面切成受光/背光两块 */
const CREASE_PATH = 'M8 16 H17 L8 25 Z'

// ─── 三种底（字形完全相同，只换「光」的处理；装哪个由 INSTALL_VARIANT 决定）──
const VARIANTS = {
  // A：深色底 + 字自己发光 —— 最「高级」，也最不容易和一堆蓝色图标撞脸
  dark: {
    label: 'A 深色 · 字发光',
    tileA: '#262A42',
    tileB: '#12131F',
    rimA: 'rgba(255,255,255,0.20)',
    rimB: 'rgba(255,255,255,0)',
    glow: { color: 'rgba(99,102,241,0.55)', cx: 0.5, cy: 0.44, r: 0.66 },
    markA: '#FFFFFF',
    markB: '#A9B4FF',
    crease: 'rgba(14,16,36,0.34)',
    small: { tile: '#1A1C2C', mark: '#E8EBFF', crease: 'rgba(14,16,36,0.44)', glow: null }
  },
  // B：靛蓝斜向渐变 + 白字 —— 明亮饱和版，同构
  indigo: {
    label: 'B 靛蓝 · 白字',
    tileA: '#6E6BF8',
    tileB: '#4441D6',
    rimA: 'rgba(255,255,255,0.16)',
    rimB: 'rgba(255,255,255,0)',
    glow: { color: 'rgba(255,255,255,0.14)', cx: 0.28, cy: 0.22, r: 0.6 },
    markA: '#FFFFFF',
    markB: '#FFFFFF',
    crease: 'rgba(38,34,120,0.26)',
    small: { tile: '#5457E4', mark: '#FFFFFF', crease: 'rgba(38,34,120,0.32)', glow: null }
  },
  // C：纸感浅底 + 靛蓝字 —— 像一张被光照到的纸，与亮色主题最贴
  paper: {
    label: 'C 纸感 · 靛蓝字',
    tileA: '#FFFFFF',
    tileB: '#E9ECF6',
    rimA: 'rgba(20,22,45,0.10)',
    rimB: 'rgba(20,22,45,0.16)',
    glow: { color: 'rgba(99,102,241,0.10)', cx: 0.62, cy: 0.7, r: 0.7 },
    markA: '#5B5EF0',
    markB: '#3F3FBE',
    crease: 'rgba(10,12,50,0.22)',
    small: { tile: '#F7F8FC', mark: '#4F46E5', crease: 'rgba(10,12,50,0.3)', glow: null }
  }
}
/** 装进 resources/ 的那一套：换口味只改这一行，再跑一次脚本 */
const INSTALL_VARIANT = 'dark'

// ─── SVG 母版（与 canvas 共用同一份路径与常量）───────────────────────────────
/** 表格里为了方便 canvas 写的是 rgba()，但 SVG 1.1 的 stop-color / fill 不吃 rgba：
 *  转成 `#RRGGBB` + `*-opacity` 两个属性，Illustrator / Figma 打开才不会翻车。 */
function svgPaint(attr, color) {
  const m = /^rgba?\(([^)]+)\)$/.exec(String(color).trim())
  if (!m) return `${attr}="${color}"`
  const [r, g, b, a] = m[1].split(',').map((s) => Number(s.trim()))
  const hex =
    '#' +
    [r, g, b]
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  const alpha = a === undefined ? 1 : a
  // stop-color → stop-opacity；fill → fill-opacity（别写成 stop-color-opacity）
  const op = (attr.endsWith('-color') ? attr.slice(0, -'-color'.length) : attr) + '-opacity'
  return `${attr}="${hex}" ${op}="${alpha}"`
}

// small=true 出的是 16/24/32px 那一档：方角字形 + 平色底 + 无辉光/描边（小尺寸不糊）
function svgMaster(key, small = false) {
  const v = VARIANTS[key]
  const glow = v.glow ?? { cx: 0.5, cy: 0.5, r: 0.6, color: 'transparent' }
  const tileA = small ? v.small.tile : v.tileA
  const tileB = small ? v.small.tile : v.tileB
  const markA = small ? v.small.mark : v.markA
  const markB = small ? v.small.mark : v.markB
  const crease = small ? v.small.crease : v.crease
  const markPath = small ? MARK_PATH_SMALL : MARK_PATH
  const glowRect = small
    ? ''
    : `
  <rect width="${GRID}" height="${GRID}" rx="${TILE_RADIUS}" fill="url(#glow)"/>`
  const rimRect = small
    ? ''
    : `
  <rect x="0.5" y="0.5" width="${GRID - 1}" height="${GRID - 1}" rx="${TILE_RADIUS - 0.5}" fill="none" stroke="url(#rim)" stroke-width="1"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID * 32}" height="${GRID * 32}" viewBox="0 0 ${GRID} ${GRID}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" ${svgPaint('stop-color', tileA)}/>
      <stop offset="1" ${svgPaint('stop-color', tileB)}/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" ${svgPaint('stop-color', v.rimA)}/>
      <stop offset="1" ${svgPaint('stop-color', v.rimB)}/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" ${svgPaint('stop-color', markA)}/>
      <stop offset="1" ${svgPaint('stop-color', markB)}/>
    </linearGradient>
    <radialGradient id="glow" cx="${glow.cx}" cy="${glow.cy}" r="${glow.r}">
      <stop offset="0" ${svgPaint('stop-color', glow.color)}/>
      <stop offset="1" stop-color="transparent"/>
    </radialGradient>
  </defs>
  <rect width="${GRID}" height="${GRID}" rx="${TILE_RADIUS}" fill="url(#tile)"/>${glowRect}
  <path d="${markPath}" fill="url(#mark)"/>
  <path d="${CREASE_PATH}" ${svgPaint('fill', crease)}/>${rimRect}
</svg>
`
}

/** 页面里的绘制器：一份代码画三种底 × 两档尺寸档 */
const PAINTER = `(() => {
  const G = ${GRID}, R = ${TILE_RADIUS}
  const VARIANTS = ${JSON.stringify(VARIANTS)}
  const MARK = ${JSON.stringify(MARK_PATH)}
  const MARK_SMALL = ${JSON.stringify(MARK_PATH_SMALL)}
  const CREASE = ${JSON.stringify(CREASE_PATH)}

  const pathsFor = (size) => {
    const u = size / G
    const m = new DOMMatrix().scale(u, u)
    const mark = new Path2D()
    mark.addPath(new Path2D(size <= 32 ? MARK_SMALL : MARK), m)
    const crease = new Path2D()
    crease.addPath(new Path2D(CREASE), m)
    return { mark, crease }
  }

  const draw = (ctx, x0, y0, size, key) => {
    const v = VARIANTS[key]
    const u = size / G
    const small = size <= 32
    ctx.save()
    ctx.translate(x0, y0)

    const tile = new Path2D()
    tile.roundRect(0, 0, size, size, R * u)

    // 底：对角渐变定光向
    const g = ctx.createLinearGradient(0, 0, size, size)
    g.addColorStop(0, small ? v.small.tile : v.tileA)
    g.addColorStop(1, small ? v.small.tile : v.tileB)
    ctx.fillStyle = g
    ctx.fill(tile)

    // 中央辉光（小尺寸关掉：16px 下只会变脏）
    const glow = small ? v.small.glow : v.glow
    if (glow) {
      const cx = glow.cx * size, cy = glow.cy * size, r = glow.r * size
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      rg.addColorStop(0, glow.color)
      rg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.save(); ctx.clip(tile); ctx.fillStyle = rg; ctx.fillRect(0, 0, size, size); ctx.restore()
    }

    // 玻璃边缘：内圈一条渐隐描边
    if (!small) {
      ctx.save()
      ctx.clip(tile)
      const rim = ctx.createLinearGradient(0, 0, size, size)
      rim.addColorStop(0, v.rimA)
      rim.addColorStop(1, v.rimB)
      ctx.strokeStyle = rim
      ctx.lineWidth = Math.max(1, u)
      ctx.stroke(tile)
      ctx.restore()
    }

    // 折带 L：整体对角渐变，背光面（折痕靠左下那块）再压一层暗
    const { mark, crease } = pathsFor(size)
    const mg = ctx.createLinearGradient(0, 0, size, size)
    mg.addColorStop(0, small ? v.small.mark : v.markA)
    mg.addColorStop(1, small ? v.small.mark : v.markB)
    ctx.fillStyle = mg
    ctx.fill(mark)
    ctx.save()
    ctx.clip(mark)
    ctx.fillStyle = small ? v.small.crease : v.crease
    ctx.fill(crease)
    ctx.restore()

    ctx.restore()
  }

  window.__lmIcon = {
    draw,
    toPng(size, key) {
      const c = document.createElement('canvas')
      c.width = size; c.height = size
      draw(c.getContext('2d'), 0, 0, size, key)
      const out = c.toDataURL('image/png')
      c.width = c.height = 0
      return out
    },
    /** 按 32 网格坐标取像素：用来证明「画出来的就是设计的样子」 */
    probe(size, key, gridPoints) {
      const c = document.createElement('canvas')
      c.width = size; c.height = size
      const ctx = c.getContext('2d')
      draw(ctx, 0, 0, size, key)
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
    /** 候选对照图：三种底 × 各档尺寸，浅/深两条底各排一行 */
    sheet() {
      const keys = Object.keys(VARIANTS)
      const sizes = [16, 24, 32, 48, 64]
      const pad = 18
      const cellW = 300
      const big = 256
      const rowH = pad + big + 14 + 72 + pad
      const c = document.createElement('canvas')
      c.width = cellW * keys.length + pad
      c.height = rowH * 2 + 34
      const ctx = c.getContext('2d')
      ctx.textBaseline = 'top'
      const strip = (y0, bg, fg) => {
        ctx.fillStyle = bg
        ctx.fillRect(0, y0, c.width, rowH)
        keys.forEach((k, i) => {
          const x = pad + i * cellW
          draw(ctx, x, y0 + pad, big, k)
          let sx = x
          for (const s of sizes) {
            draw(ctx, sx, y0 + pad + big + 14, s, k)
            sx += s + 12
          }
          ctx.fillStyle = fg
          ctx.font = '600 15px Segoe UI, sans-serif'
          ctx.fillText(VARIANTS[k].label, x, y0 + rowH - pad - 22)
          ctx.font = '12px Segoe UI, sans-serif'
          ctx.fillText(sizes.join(' / ') + ' px', x, y0 + rowH - pad - 5)
        })
      }
      strip(34, '#F5F6F8', '#20242B')
      strip(rowH + 34, '#0F1116', '#E8EAEF')
      ctx.fillStyle = '#8A919E'
      ctx.font = '600 14px Segoe UI, sans-serif'
      ctx.fillText('上：浅色任务栏   下：深色任务栏   · 折带 L（大字面）三种底', pad, 10)
      const out = c.toDataURL('image/png')
      c.width = c.height = 0
      return out
    }
  }
  return 'ok'
})()`

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
    console.log('SKIP: 没有可用的 Chromium（先跑 tools/start-isolated.ps1 起隔离实例）')
    process.exit(2)
  }
  const browser = connect(version.webSocketDebuggerUrl)
  await browser.ready
  const list = (await get('/json/list')).filter((t) => t.type === 'page')
  if (!list.length) {
    console.log('SKIP: 没有可用的页面')
    process.exit(2)
  }
  const w = connect(list[0].webSocketDebuggerUrl)
  await w.ready
  if ((await w.ev(PAINTER)) !== 'ok') throw new Error('painter injection failed')

  const key = INSTALL_VARIANT
  const pngs = {}
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) pngs[s] = await raster(w, s, key)

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svgMaster(key), 'utf-8')
  fs.writeFileSync(path.join(OUT, 'icon-small.svg'), svgMaster(key, true), 'utf-8')
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[512])
  fs.writeFileSync(
    path.join(OUT, 'icon.ico'),
    packIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngs[size] })))
  )

  const sheetPath = path.join(os.tmpdir(), 'lumin-icon-sheet.png')
  fs.writeFileSync(
    sheetPath,
    Buffer.from((await w.ev('window.__lmIcon.sheet()')).split(',')[1], 'base64')
  )

  // ── 回读校验（读的是本次的产物目录 OUT，不是 resources/）──
  const png = fs.readFileSync(path.join(OUT, 'icon.png'))
  const pngInfo = pngSize(png)
  console.log(
    'ICON-PNG ' + JSON.stringify({ bytes: png.length, ...pngInfo, variant: key, out: OUT })
  )
  c(
    'icon.png-is-512-squared',
    !!pngInfo && pngInfo.w === 512 && pngInfo.h === 512,
    JSON.stringify(pngInfo)
  )
  const icoBuf = fs.readFileSync(path.join(OUT, 'icon.ico'))
  const dir = parseIco(icoBuf)
  console.log(
    'ICON-ICO ' + JSON.stringify({ bytes: icoBuf.length, entries: dir?.map((d) => d.size) })
  )
  c('icon.ico-has-7-entries', !!dir && dir.length === 7, String(dir?.length))
  c(
    'icon.ico-sizes-in-order',
    !!dir && dir.map((d) => d.size).join(',') === '16,24,32,48,64,128,256',
    dir?.map((d) => d.size).join(',')
  )
  c(
    'icon.ico-payloads-are-png',
    !!dir && dir.every((d) => d.pngOk && d.pngSize.w === d.size && d.pngSize.h === d.size),
    'ok'
  )
  c('icon.ico-no-overrun', !!dir && dir.every((d) => d.off + d.len <= icoBuf.length), 'ok')

  // ── 像素取样：证明「画出来的就是设计的样子」（坐标按 32 网格）──
  // 折面取三角形重心 (11,19)：16px 下一像素 = 2 网格，折痕那条 45° 边只有 1~2 px 宽，
  // 单点采样落不准，所以折痕的明暗差只在大尺寸上断言，小尺寸只断言「字在」。
  const points = [
    { k: 'corner', x: 0.25, y: 0.25 },
    { k: 'tileTL', x: 4, y: 4 },
    { k: 'tileBR', x: 27.5, y: 27.5 },
    { k: 'stemLit', x: 12, y: 10 },
    { k: 'foldFace', x: 11, y: 19 },
    { k: 'footLit', x: 22, y: 21 },
    { k: 'outsideLeft', x: 7, y: 16 },
    { k: 'outsideRight', x: 27, y: 21 }
  ]
  const P = JSON.parse(
    await w.ev(`window.__lmIcon.probe(256, ${JSON.stringify(key)}, ${JSON.stringify(points)})`)
  )
  const P16 = JSON.parse(
    await w.ev(`window.__lmIcon.probe(16, ${JSON.stringify(key)}, ${JSON.stringify(points)})`)
  )
  console.log('PROBE-256 ' + JSON.stringify(P))
  console.log('PROBE-16 ' + JSON.stringify(P16))
  const luma = (p) => p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114
  const same = (a, b) => a.slice(0, 3).join() === b.slice(0, 3).join()
  const near = (a, b, tol = 3) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol)
  c(
    'corner-transparent',
    P.corner[3] === 0 && P16.corner[3] === 0,
    JSON.stringify({ p: P.corner, p16: P16.corner })
  )
  c(
    'tile-has-light-direction',
    Math.abs(luma(P.tileTL) - luma(P.tileBR)) > 5,
    JSON.stringify({ tl: P.tileTL, br: P.tileBR })
  )
  c(
    'fold-reads-as-two-planes',
    luma(P.stemLit) - luma(P.foldFace) > 12 && luma(P.footLit) - luma(P.foldFace) > 12,
    JSON.stringify({ stemLit: P.stemLit, foldFace: P.foldFace, footLit: P.footLit })
  )
  c(
    'mark-is-bold-enough',
    !same(P.outsideLeft, P.stemLit) && !same(P.outsideRight, P.footLit),
    JSON.stringify({ left: P.outsideLeft, right: P.outsideRight })
  )
  c(
    'mark-visible-at-16px',
    P16.stemLit[3] === 255 &&
      luma(P16.stemLit) > 190 &&
      luma(P16.stemLit) - luma(P16.outsideRight) > 60,
    JSON.stringify({ mark: P16.stemLit, field: P16.outsideRight })
  )
  c(
    'small-is-flat-field',
    near(P16.tileTL, P16.tileBR) && P16.corner[3] === 0,
    JSON.stringify({ tl: P16.tileTL, br: P16.tileBR })
  )

  // ── 单一来源守卫：所有**运行时**引用必须指向同一个图标文件 ──
  // 背景：模板自带的 build/icon.{ico,png,icns} 曾是另一套（旧）设计，electron-builder 默认又会
  // 去读 build/icon.ico —— 这样同一个应用就会出现两种图标。这里把它钉死：
  //   1) src/ 下引用图标的地方只能出现 resources/icon.ico（PNG 仅限非 Windows 分支）；
  //   2) build/ 下不允许再出现 icon.* 旧产物。
  {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) return walk(p)
        return /\.(ts|vue|js)$/.test(e.name) ? [p] : []
      })
    const refs = []
    for (const f of walk(path.join(REPO, 'src'))) {
      const text = fs.readFileSync(f, 'utf-8')
      for (const m of text.matchAll(/resources\/icon[\w.-]*/g)) {
        refs.push({ file: path.relative(REPO, f), ref: m[0] })
      }
    }
    const unexpected = refs.filter(
      (r) => r.ref !== 'resources/icon.ico' && r.ref !== 'resources/icon.png'
    )
    console.log('ICON-REFS ' + JSON.stringify(refs))
    c('all-runtime-refs-are-canonical', unexpected.length === 0, JSON.stringify(unexpected))
    c(
      'only-one-icon-file-for-windows',
      refs.filter((r) => r.ref === 'resources/icon.ico').length >= 2,
      JSON.stringify(refs.filter((r) => r.ref === 'resources/icon.ico'))
    )
    const staleIcon = ['icon.ico', 'icon.png', 'icon.icns']
      .map((n) => path.join(REPO, 'build', n))
      .filter((p) => fs.existsSync(p))
    c('no-stale-build-icons', staleIcon.length === 0, JSON.stringify(staleIcon))
  }

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
