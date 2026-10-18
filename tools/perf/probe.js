'use strict'
// ─── 页面侧性能探针（生产构建里也跑得动；不发 CDP 事件，只读 DOM / PM 状态）────────
//
// 所有采样都由**页面内的 rAF**计时，不从 Node 侧夹时间戳：
//   * 按键：捕获阶段 `input` 事件 t0 → 两次 rAF（第一帧画完）→ t1；
//   * 拖选：捕获阶段 `mousemove`（buttons===1）t0 → 两次 rAF → t1；
//   * 滚动：独立 rAF 循环记录帧间隔。
// 每一步同时拍一张状态快照：模型选区 / `.sel-band` 子节点数 / CSS.highlights 条数 /
// `data-sel-own` / 探针计数器（paintSelBands、collectImgSources 等，见 perfProbe.ts）。
function installProbe() {
  const P = (window.__P = window.__P || {})
  if (P.installed) {
    P.rebind()
    return 'ok'
  }
  P.installed = true
  P.typing = []
  P.drag = []
  P.work = []
  P.dispatch = []
  P.frames = []
  P.lt = []
  P.ltMark = 0
  P.mode = null
  P.rec = false
  P.c = { mousemove: 0, input: 0, transactions: 0, selectionUpdates: 0, posAtCoords: 0 }
  P.dispatchWork = []

  const pct = (arr, p) => {
    if (!arr.length) return null
    const a = [...arr].sort((x, y) => x - y)
    const i = (a.length - 1) * p
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo)
  }

  P.counts = () => {
    const l = window.__LPERF
    return l && l.counts ? Object.assign({}, l.counts) : {}
  }

  P.snap = () => {
    const out = {
      from: -1,
      to: -1,
      empty: null,
      bands: 0,
      bandBox: false,
      own: null,
      live: 0,
      miss: null,
      hl: null,
      imgSel: 0,
      counts: P.counts()
    }
    try {
      const ed = window.__L && window.__L.ed && window.__L.ed()
      if (ed) {
        const s = ed.state.selection
        out.from = s.from
        out.to = s.to
        out.empty = s.empty
        const dom = ed.view.dom
        out.own = dom.getAttribute('data-sel-own')
        out.miss = dom.getAttribute('data-sel-band-miss')
        out.live = (dom.getAttribute('data-sel-band-live') || '').split(';').filter(Boolean).length
        out.imgSel = dom.querySelectorAll('.img-selected').length
      }
      const box = document.querySelector('.sel-band')
      out.bandBox = !!box
      out.bands = box ? box.childElementCount : 0
      const h = window.CSS && CSS.highlights
      out.hl = h ? h.size : null
    } catch (e) {
      out.err = String(e && e.message)
    }
    return out
  }

  P.begin = (name) => {
    P.mode = name
    P.frames = []
    if (name === 'typing') {
      P.typing = []
      P.work = []
      P.dispatch = []
    }
    if (name === 'drag') P.drag = []
    P.ltMark = P.lt.length
    return P.snap()
  }
  P.end = () => {
    P.mode = null
    return 'ok'
  }
  P.samples = () => ({ typing: P.typing, drag: P.drag })
  P.summary = () => {
    const lt = P.lt.slice(P.ltMark)
    return {
      longtasks: {
        n: lt.length,
        totalMs: +lt.reduce((s, e) => s + e.dur, 0).toFixed(2),
        maxMs: +lt.reduce((m, e) => Math.max(m, e.dur), 0).toFixed(2)
      }
    }
  }
  P.pct = pct

  P.startFrames = () => {
    P.frames = []
    P.rec = true
    let last = null
    const loop = (t) => {
      if (!P.rec) return
      if (last != null) P.frames.push(t - last)
      last = t
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }
  P.stopFrames = () => {
    P.rec = false
    const a = P.frames
    const dropped = a.filter((d) => d > 25).length
    return {
      n: a.length,
      p50: +pct(a, 0.5).toFixed(2),
      p95: +pct(a, 0.95).toFixed(2),
      max: +Math.max(0, ...a).toFixed(2),
      dropped,
      raw: a.map((d) => +d.toFixed(2))
    }
  }

  P.idle = (ms) =>
    new Promise((res) => {
      const a = []
      let last = null
      let done = false
      const end = performance.now() + (ms || 500)
      const finish = (timedOut) => {
        if (done) return
        done = true
        clearTimeout(hard)
        const med = pct(a, 0.5) || 16.7
        res({
          n: a.length,
          p50: +med.toFixed(2),
          max: +Math.max(0, ...a).toFixed(2),
          hz: +(1000 / med).toFixed(1),
          timedOut: !!timedOut
        })
      }
      // 窗口被遮挡时 rAF 会彻底停摆：必须有硬超时，否则整个 Node 侧挂在 await 上
      const hard = setTimeout(() => finish(true), (ms || 500) + 3000)
      const loop = (t) => {
        if (done) return
        if (last != null) a.push(t - last)
        last = t
        if (performance.now() < end) requestAnimationFrame(loop)
        else finish(false)
      }
      requestAnimationFrame(loop)
    })

  P.longTaskMark = () => {
    P.ltMark = P.lt.length
    return P.ltMark
  }

  P.installObserver = () => {
    try {
      if (!P.ltObs) {
        P.ltObs = new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            P.lt.push({ start: e.startTime, dur: e.duration, name: e.name })
        })
        P.ltObs.observe({ entryTypes: ['longtask'] })
      }
    } catch (e) {
      /* 环境没有 longtask：留空数组 */
    }
  }
  P.installObserver()
  /**
   * 归因辅助：包一层 `getClientRects`，按调用栈聚合次数（只在测量实例里手动打开）。
   * 生产代码里没有这个钩子；它只是回答"到底是谁在每键调 getClientRects"。
   */
  P.traceRects = (on) => {
    if (!P._rt) {
      P._rt = { on: false, n: 0, stacks: {} }
      const wrap = (proto, name) => {
        const orig = proto[name]
        if (!orig || orig.__wrapped) return
        const fn = function (...a) {
          if (P._rt.on) {
            P._rt.n += 1
            const st = (new Error().stack || '')
              .split('\n')
              .slice(2, 7)
              .map((s) => s.trim())
              .join(' <- ')
            P._rt.stacks[st] = (P._rt.stacks[st] || 0) + 1
          }
          return orig.apply(this, a)
        }
        fn.__wrapped = true
        proto[name] = fn
      }
      wrap(Range.prototype, 'getClientRects')
      wrap(Element.prototype, 'getClientRects')
      wrap(Element.prototype, 'getBoundingClientRect')
      wrap(Range.prototype, 'getBoundingClientRect')
    }
    P._rt.on = !!on
    if (on) {
      P._rt.n = 0
      P._rt.stacks = {}
    }
    return P._rt
  }

  /** 找一个视口内、有足够正文文本的段落；返回首行字符几何（不写死坐标） */
  P.pickText = (yMin, minLen) => {
    const v = window.__L.ed().view
    const vh = window.innerHeight
    const blocks = Array.from(v.dom.querySelectorAll('p,li,td,th,blockquote'))
    for (const b of blocks) {
      if (b.querySelector('img,[data-img-widget],[data-md-math-block]')) continue
      const txt = (b.textContent || '').trim()
      if (txt.length < (minLen || 30)) continue
      const br = b.getBoundingClientRect()
      if (br.top < (yMin || 120) || br.bottom > vh - 60) continue
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const t = walker.currentNode
        if (!t.data || !t.data.trim()) continue
        const r = document.createRange()
        r.selectNodeContents(t)
        for (const cr of Array.from(r.getClientRects())) {
          if (cr.width < 8 || cr.height < 6) continue
          if (cr.top < (yMin || 120) || cr.bottom > vh - 40) continue
          return {
            x: Math.round(cr.left + Math.min(6, cr.width / 3)),
            x2: Math.round(cr.right - 2),
            y: Math.round((cr.top + cr.bottom) / 2),
            top: Math.round(cr.top),
            bottom: Math.round(cr.bottom),
            w: Math.round(cr.width),
            text: txt.slice(0, 40)
          }
        }
      }
    }
    return null
  }

  /** 编辑当前视口里可见的第一块/最后一块正文的屏幕范围，给“整块拖选”用 */
  P.pickBlock = (yMin) => {
    const v = window.__L.ed().view
    const vh = window.innerHeight
    let best = null
    for (const b of Array.from(v.dom.querySelectorAll('p,li,td,th,blockquote'))) {
      const br = b.getBoundingClientRect()
      if (br.top < (yMin || 120) || br.bottom > vh - 60) continue
      if ((b.textContent || '').trim().length < 10) continue
      if (!best) best = { x: Math.round(br.left + 12), y: Math.round(br.top + 6) }
    }
    return best
  }

  P.rebind = () => {
    try {
      const ed = window.__L && window.__L.ed && window.__L.ed()
      if (!ed) return 'no-editor'
      if (!ed.__perfHooked) {
        ed.__perfHooked = true
        ed.on('transaction', () => {
          P.c.transactions += 1
        })
        ed.on('selectionUpdate', () => {
          P.c.selectionUpdates += 1
        })
      }
      const v = ed.view
      if (v && !v.__perfHooked) {
        v.__perfHooked = true
        const orig = v.posAtCoords.bind(v)
        v.posAtCoords = (...a) => {
          P.c.posAtCoords += 1
          return orig(...a)
        }
        const origDispatch = v.dispatch.bind(v)
        v.dispatch = (tr) => {
          const t0 = performance.now()
          const r = origDispatch(tr)
          if (P.mode === 'typing') P.dispatch.push(+(performance.now() - t0).toFixed(2))
          return r
        }
      }
      return 'ok'
    } catch (e) {
      return 'ERR ' + String(e && e.message)
    }
  }

  /**
   * 事件 → 下一帧 → 再下一帧。返回 `{ first, second, timedOut }`：
   *   * `first`  = 第一次 rAF（下一帧开始；这一帧就会把按键的改动画出来）
   *   * `second` = 第二次 rAF（再下一帧开始；比"画完"保守一帧）
   * rAF 被遮挡/省电策略停摆时**必须有硬超时**：否则样本会变成几秒，污染 P95。
   */
  const afterPaint = (fn) => {
    let done = false
    const start = performance.now()
    const hard = setTimeout(() => {
      if (done) return
      done = true
      fn({ timedOut: true, start })
    }, 350)
    requestAnimationFrame(() => {
      if (done) return
      const first = performance.now()
      requestAnimationFrame(() => {
        if (done) return
        done = true
        clearTimeout(hard)
        fn({ timedOut: false, start, first, second: performance.now() })
      })
    })
  }

  window.addEventListener(
    'input',
    (e) => {
      P.c.input += 1
      if (P.mode !== 'typing') return
      const before = P.counts()
      // 同一轮任务里 PM 的 DOMObserver 处理在微任务里；setTimeout(0) 能等到它们全跑完，
      // 从而把"每键同步 JS 工作量"与"等下一帧"分开量（帧等待不该算到应用头上）。
      const tWork = performance.now()
      setTimeout(() => {
        if (P.mode === 'typing' || P.mode === 'typing-done')
          P.work.push(+(performance.now() - tWork).toFixed(2))
      }, 0)
      afterPaint((t) => {
        P.typing.push({
          i: P.typing.length,
          dt1: t.timedOut ? null : +(t.first - t.start).toFixed(2),
          dt: t.timedOut ? null : +(t.second - t.start).toFixed(2),
          timedOut: !!t.timedOut,
          inputType: e.inputType || '',
          snap: P.snap(),
          before
        })
      })
    },
    true
  )

  window.addEventListener(
    'mousemove',
    (e) => {
      P.c.mousemove += 1
      if (P.mode !== 'drag' || e.buttons !== 1) return
      const before = P.counts()
      const xy = { x: Math.round(e.clientX), y: Math.round(e.clientY) }
      afterPaint((t) => {
        P.drag.push({
          i: P.drag.length,
          dt1: t.timedOut ? null : +(t.first - t.start).toFixed(2),
          dt: t.timedOut ? null : +(t.second - t.start).toFixed(2),
          timedOut: !!t.timedOut,
          xy,
          snap: P.snap(),
          before
        })
      })
    },
    true
  )

  P.rebind()
  return 'ok'
}

module.exports = { PROBE_SRC: `(${installProbe.toString()})()` }
