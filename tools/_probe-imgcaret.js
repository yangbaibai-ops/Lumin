'use strict'
/**
 * 最小复核（第五十一轮）：`![]()` 的图标按钮 + 光标画在点击的那一侧。
 * 判据：文档纯文本逐字节仍是 `![]()`；按钮含 SVG；点击按钮左/右 ⇒ 插入符矩形在按钮左/右。
 * 用法：先起带调试端口的隔离实例（LUMIN_DEBUG_PORT，默认 9333），再 node tools/_probe-imgcaret.js
 */
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
  await ev("document.querySelector('.ProseMirror').focus()")
  await ev(
    "(() => { const ed=document.querySelector('.ProseMirror'); const r=document.createRange(); r.selectNodeContents(ed); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, ''); return 1 })()"
  )
  await send('Input.insertText', { text: '![]()' })
  await sleep(450)

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
      return { docText: docText.slice(0, 20), pickers: document.querySelectorAll('[data-md-image-picker]').length,
               svg: !!(b && b.querySelector('svg')), text: b ? (b.textContent || '').trim() : null,
               rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null }
    })())`)
  )
  console.log('夹具：', JSON.stringify(info))

  const sideAt = async (dx) => {
    const x = dx < 0 ? info.rect.l + dx : info.rect.l + info.rect.w + dx
    const y = info.rect.t + Math.round(info.rect.h / 2)
    await click(x, y)
    return JSON.parse(
      await ev(`JSON.stringify((() => {
        const b = document.querySelector('[data-md-image-picker]')
        const r = b.getBoundingClientRect()
        const s = getSelection()
        const cr = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null
        const cx = cr ? cr.left + cr.width / 2 : -1
        return { caretX: Math.round(cx), btnL: Math.round(r.left), btnR: Math.round(r.right),
                 side: cx < r.left ? 'before' : cx > r.right ? 'after' : 'inside' }
      })())`)
    )
  }
  const left = await sideAt(-2)
  const right = await sideAt(2)
  console.log('点左侧 ⇒', JSON.stringify(left))
  console.log('点右侧 ⇒', JSON.stringify(right))
  console.log(
    '结论：文档未变=' + (info.docText === '![]()' ? 'OK' : 'FAIL') +
      ' 有SVG=' + (info.svg ? 'OK' : 'FAIL') +
      ' 无纯文字=' + (!info.text ? 'OK' : 'FAIL(' + info.text + ')') +
      ' 左点击画在左=' + (left.side === 'before' ? 'OK' : 'FAIL') +
      ' 右点击画在右=' + (right.side === 'after' ? 'OK' : 'FAIL')
  )
  process.exit(0)
}

main().catch((e) => {
  console.log('probe=1 ' + e.message)
  process.exit(1)
})
