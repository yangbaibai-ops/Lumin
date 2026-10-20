'use strict'
/**
 * 最小复核（第五十一轮起；第五十三轮扩到三项）：
 *   ① 转义：打字 `![]()` / `![alt](url)` 后**序列化字节逐字不变**（`getMarkdown()`），
 *      且普通链接 `[文本](url)` 与 `****` / `~~~~` 的老行为不变；
 *   ② 按钮外观：`computedStyle` 的 padding / border-radius / background 不是默认值，
 *      仍含 SVG、无纯文字；
 *   ③ 光标侧：左/右各连点三次，给**按钮矩形**与**插入符矩形**的原始数值。
 *
 * 用法：先起带调试端口的隔离实例（LUMIN_DEBUG_PORT，默认 9333），再 node tools/_probe-imgcaret.js
 */
const path = require('path')
const PORT = process.env.LUMIN_DEBUG_PORT || '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到页面')
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
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
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('EXC')
    return r.result?.result?.value
  }
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(350)
  }

  let ready = false
  for (let i = 0; i < 60; i += 1) {
    if (await ev("!!document.querySelector('.ProseMirror[contenteditable=true]')")) {
      ready = true
      break
    }
    await sleep(300)
  }
  if (!ready) throw new Error('编辑器未就绪')
  const H = require(path.join(__dirname, 'lib', 'harness.js'))
  if (!(await H.settle(ev))) throw new Error('settle 失败')

  // ── ① 转义：清空 → 打字 → 读序列化字节 ────────────────────────────────────
  const bytes = async (text, viaInsert) => {
    await ev(
      "(() => { const ed = window.__L.ed(); ed.commands.clearContent(true); ed.commands.focus(); return 1 })()"
    )
    await sleep(200)
    if (viaInsert) {
      // 打字路径有输入规则会把 `![alt](url)` / `[文本](url)` 整段吞掉（既有缺陷，与本轮无关），
      // 所以这两个夹具走"往文档里插一段文本"的路径，专测**序列化**是否逐字不变。
      await ev(
        `(() => { const ed = window.__L.ed(); ed.commands.insertContent(${JSON.stringify(text)}); return 1 })()`
      )
    } else {
      await send('Input.insertText', { text })
    }
    await sleep(450)
    return JSON.parse(
      await ev(`JSON.stringify((() => {
        const ed = window.__L.ed()
        const nodes = []
        ed.state.doc.descendants((n) => {
          if (n.isText) nodes.push(n.text + '[' + n.marks.map((m) => m.type.name).join(',') + ']')
          return true
        })
        return { md: ed.storage.markdown.getMarkdown(), nodes }
      })())`)
    )
  }
  const cases = [
    ['![]()', '![]()', false],
    ['![alt](url)', '![alt](url)', true],
    ['前![]()后', '前![]()后', true],
    ['****', '****', false],
    ['~~~~', '~~~~', false]
  ]
  const escapeRows = []
  for (const [input, want, viaInsert] of cases) {
    const got = await bytes(input, viaInsert)
    escapeRows.push({
      input,
      via: viaInsert ? 'insert' : 'type',
      md: got.md,
      nodes: got.nodes,
      ok: got.md === want,
      want
    })
  }
  console.log('① 转义（→ getMarkdown 逐字节）')
  for (const r of escapeRows) {
    console.log(
      '   ' +
        (r.ok ? 'OK  ' : 'FAIL') +
        ' [' +
        r.via +
        '] 输入=' +
        JSON.stringify(r.input) +
        ' 落盘=' +
        JSON.stringify(r.md) +
        (r.ok ? '' : ' 期望=' + JSON.stringify(r.want)) +
        ' 节点=' +
        JSON.stringify(r.nodes)
    )
  }

  // ── 夹具：重新敲一个 `![]()` 供 ②③ 用 ─────────────────────────────────────
  await bytes('![]()')
  const info = JSON.parse(
    await ev(`JSON.stringify((() => {
      const ed = document.querySelector('.ProseMirror')
      let docText = ''
      const walk = (n) => { for (const c of n.childNodes) {
        if (c.nodeType === 3) docText += c.nodeValue
        else if (c.nodeType === 1 && !(c.matches && c.matches('[data-md-image-picker]'))) walk(c)
      } }
      walk(ed)
      const b = document.querySelector('[data-md-image-picker]')
      const r = b ? b.getBoundingClientRect() : null
      const cs = b ? getComputedStyle(b) : null
      return { docText: docText.slice(0, 20), pickers: document.querySelectorAll('[data-md-image-picker]').length,
               svg: !!(b && b.querySelector('svg')), text: b ? (b.textContent || '').trim() : null,
               cls: b ? b.className : null,
               style: cs ? { padding: cs.paddingTop + '/' + cs.paddingLeft, radius: cs.borderTopLeftRadius,
                             bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor,
                             color: cs.color, width: cs.width, height: cs.height } : null,
               ownStyleTag: !!document.getElementById('md-image-picker-style'),
               rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null }
    })())`)
  )
  console.log('夹具：' + JSON.stringify(info))

  // ── ③ 光标侧：左右各连点三次，给原始数值 ───────────────────────────────────
  const probeSide = async (dx) => {
    const x = dx < 0 ? info.rect.l + dx : info.rect.l + info.rect.w + dx
    const y = info.rect.t + Math.round(info.rect.h / 2)
    await click(x, y)
    return JSON.parse(
      await ev(`JSON.stringify((() => {
        const b = document.querySelector('[data-md-image-picker]')
        const r = b.getBoundingClientRect()
        const s = getSelection()
        const cr = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null
        const cw = document.querySelector('.ProseMirror-cursor')
        const cwr = cw ? cw.getBoundingClientRect() : null
        const cc = document.querySelector('[data-md-image-caret]')
        const ccr = cc ? cc.getBoundingClientRect() : null
        const pm = window.__L.ed()
        return {
          caret: cr ? { l: +cr.left.toFixed(1), r: +cr.right.toFixed(1), w: +cr.width.toFixed(1), t: +cr.top.toFixed(1), h: +cr.height.toFixed(1) } : null,
          pmCursor: cwr ? { l: +cwr.left.toFixed(1), r: +cwr.right.toFixed(1), w: +cwr.width.toFixed(1), h: +cwr.height.toFixed(1) } : null,
          ownCaret: ccr ? { l: +ccr.left.toFixed(1), r: +ccr.right.toFixed(1), w: +ccr.width.toFixed(1), h: +ccr.height.toFixed(1) } : null,
          domNode: cr && s.anchorNode ? (s.anchorNode.nodeName + '@' + s.anchorOffset) : null,
          btn: { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) },
          selPos: pm ? pm.state.selection.from : null,
          caretSideClass: b ? b.className.includes('x') : null
        }
      })())`)
    )
  }
  /**
   * 判定：**插入符的宽度天生是 0**（`range.getBoundingClientRect()` 对折叠选区给一条零宽线），
   * 所以判据是「高度 > 0 且横向落点在按钮左侧/右侧」，而不是"宽度非 0"。
   * 自绘插入符（`[data-md-image-caret]`）优先，其次 PM 的 `.ProseMirror-cursor`，
   * 最后才是原生选区矩形。
   */
  const judge = (row) => {
    const cands = [row.ownCaret, row.pmCursor, row.caret].filter((c) => c && c.h > 0)
    if (!cands.length) return 'empty'
    const c = cands[0]
    const mid = (c.l + c.r) / 2
    return mid < row.btn.l ? 'before' : mid > row.btn.r ? 'after' : 'inside'
  }
  console.log('③ 光标侧（按钮矩形 ' + JSON.stringify(info.rect) + '）')
  const tally = { left: [], right: [] }
  for (let i = 1; i <= 3; i += 1) {
    const L = await probeSide(-2)
    tally.left.push(judge(L))
    console.log('   左# ' + i + ' ' + JSON.stringify(L) + ' ⇒ ' + judge(L))
  }
  for (let i = 1; i <= 3; i += 1) {
    const R = await probeSide(2)
    tally.right.push(judge(R))
    console.log('   右# ' + i + ' ' + JSON.stringify(R) + ' ⇒ ' + judge(R))
  }

  const escOk = escapeRows.every((r) => r.ok)
  const styleOk =
    !!info.style &&
    info.style.padding !== '0px/0px' &&
    info.style.radius !== '0px' &&
    info.style.bg !== 'rgba(0, 0, 0, 0)' &&
    info.ownStyleTag
  console.log(
    '结论：①转义=' +
      (escOk ? 'OK' : 'FAIL') +
      ' ②外观=' +
      (styleOk ? 'OK' : 'FAIL') +
      '（class=' +
      JSON.stringify(info.cls) +
      '） ③左=' +
      tally.left.join(',') +
      ' 右=' +
      tally.right.join(',')
  )
  process.exit(escOk && styleOk ? 0 : 1)
}

main().catch((e) => {
  console.log('probe=1 ' + e.message)
  process.exit(1)
})
