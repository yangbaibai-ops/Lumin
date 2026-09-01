// 输入语义行为矩阵验证（Typora 标准）
// 覆盖：列表 Enter×4 / Backspace×3 / Delete×2、块边界×2、段落回归×2
async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const logs = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200))
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.slice(0, 200)
    return r.result?.result?.value
  }
  const key = (type, params) => send('Input.dispatchKeyEvent', { type, ...params })
  const pressEnter = async () => {
    await key('keyDown', { key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  const pressBackspace = async () => {
    await key('rawKeyDown', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await key('keyUp', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  const pressDelete = async () => {
    await key('rawKeyDown', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 })
    await key('keyUp', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  }
  const typeText = async (text) => {
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      await key('keyDown', { key: ch, code: 'Key' + ch.toUpperCase(), text: ch, unmodifiedText: ch, windowsVirtualKeyCode: code })
      await key('keyUp', { key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: code })
    }
  }
  await send('Runtime.enable', {})
  await send('Page.enable', {})

  const FILE = 'D:\\\\code_workspace\\\\Lumin-test-workspace\\\\matrix.md'
  const HELPERS = `
    function firstText(el) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) return n }
      return null
    }
    function lastText(el) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let last = null
      let n
      while ((n = w.nextNode())) { if (!n.parentElement?.classList.contains('md-meta')) last = n }
      return last
    }
    function caretIn(el, offset, atEnd) {
      const node = atEnd ? lastText(el) : firstText(el)
      const block = el.closest('.md-block-inner')
      block.focus()
      const r = document.createRange()
      if (node) {
        r.setStart(node, atEnd ? node.textContent.length : offset)
      } else {
        // 空元素（空列表项等）：光标直接放在元素上
        r.selectNodeContents(el)
        r.collapse(false)
      }
      r.collapse(true)
      const s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
    }
    async function snapshot() {
      const mod = await import('/src/lib/mdSerializer.ts')
      if (document.activeElement?.blur) document.activeElement.blur()
      document.body.focus()
      await new Promise(r => setTimeout(r, 500))
      const parts = Array.from(document.querySelectorAll('.md-block-inner'))
        .filter(b => !b.closest('.md-block-virtual'))
        .map(b => mod.serializeBlock(b))
        .filter(md => md.trim() !== '')
      return parts.join('\\n\\n')
    }
  `

  // 每个用例：写入全新文档 → 重载 → 打开 → 实时模式
  let caseNo = 0
  async function fresh(doc) {
    caseNo++
    await evalJs(`(async () => {
      await window.luminAPI.workspace.setRoot('D:\\\\code_workspace\\\\Lumin-test-workspace')
      await window.luminAPI.file.write('${FILE}', ${JSON.stringify(doc)})
      return 'ok'
    })()`)
    await send('Page.reload', { ignoreCache: true })
    await new Promise((r) => setTimeout(r, 2600))
    await evalJs(`(async () => {
      const item = Array.from(document.querySelectorAll('aside span.truncate')).find(n => n.textContent === 'matrix.md')
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 1500))
      const liveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时渲染'))
      liveBtn?.click()
      await new Promise(r => setTimeout(r, 900))
      return 'ok'
    })()`)
  }

  // 1. 列表项末尾回车 → 新空项，继续输入落在新行
  await fresh('- 项目甲\n- 项目乙\n')
  await evalJs(`(() => { ${HELPERS} const li = Array.from(document.querySelectorAll('.md-preview li'))[0]; caretIn(li, 0, true); return 'ok' })()`)
  await pressEnter()
  await typeText('项目丙')
  await new Promise((r) => setTimeout(r, 600))
  console.log('[1] enter@item-end + type:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 2. 空项回车 → 圆点消失退出列表，光标到新段落，随后回车正常
  await fresh('- 项目甲\n- \n')
  await evalJs(`(() => { ${HELPERS} const li = Array.from(document.querySelectorAll('.md-preview li'))[1]; caretIn(li, 0, true); return 'ok' })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 600))
  await typeText('新段落')
  await new Promise((r) => setTimeout(r, 500))
  console.log('[2] enter@empty-item:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 3. 列表项中间回车 → 拆分为两项
  await fresh('- 项目甲乙\n')
  await evalJs(`(() => { ${HELPERS} const li = document.querySelector('.md-preview li'); const t = firstText(li); const block = li.closest('.md-block-inner'); block.focus(); const r = document.createRange(); r.setStart(t, 3); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 'ok' })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[3] enter@item-middle:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 4. 列表项开头回车 → 上方新增空项
  await fresh('- 项目甲\n')
  await evalJs(`(() => { ${HELPERS} const li = document.querySelector('.md-preview li'); caretIn(li, 0, false); return 'ok' })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[4] enter@item-start:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 5. 第二项起点退格 → 合并到上一项
  await fresh('- 项目甲\n- 项目乙\n')
  await evalJs(`(() => { ${HELPERS} const li = Array.from(document.querySelectorAll('.md-preview li'))[1]; caretIn(li, 0, false); return 'ok' })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[5] backspace@2nd-item:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 6. 首项起点退格 → 去列表（该项变普通段落）
  await fresh('- 项目甲\n- 项目乙\n')
  await evalJs(`(() => { ${HELPERS} const li = Array.from(document.querySelectorAll('.md-preview li'))[0]; caretIn(li, 0, false); return 'ok' })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[6] backspace@1st-item:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 7. 空项退格 → 删除该项
  await fresh('- 项目甲\n- \n')
  await evalJs(`(() => { ${HELPERS} const li = Array.from(document.querySelectorAll('.md-preview li'))[1]; caretIn(li, 0, true); return 'ok' })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[7] backspace@empty-item:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 8. 项目末尾 Delete → 合并下一项
  await fresh('- 项目甲\n- 项目乙\n')
  await evalJs(`(() => { ${HELPERS} const li = Array.from(document.querySelectorAll('.md-preview li'))[0]; caretIn(li, 0, true); return 'ok' })()`)
  await pressDelete()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[8] delete@item-end:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 9. 列表块末 Delete → 不合并，光标移到下一块起点
  await fresh('- 项目甲\n- 项目乙\n\n尾段\n')
  await evalJs(`(() => { ${HELPERS} const li = Array.from(document.querySelectorAll('.md-preview li'))[1]; caretIn(li, 0, true); return 'ok' })()`)
  await pressDelete()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[9] delete@list-end:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 10. 列表后段落起点退格 → 不合并，光标移到列表末尾
  await fresh('- 项目甲\n\n尾段\n')
  await evalJs(`(() => { ${HELPERS} const p = document.querySelector('.md-preview p'); if (!p) return 'NO_P'; caretIn(p, 0, false); return 'ok' })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[10] backspace@para-after-list:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 11. 段落末尾回车 → 空段落（回归）
  await fresh('段落甲\n\n段落乙\n')
  await evalJs(`(() => { ${HELPERS} const p = Array.from(document.querySelectorAll('.md-preview p'))[0]; caretIn(p, 0, true); return 'ok' })()`)
  await pressEnter()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[11] enter@para-end:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  // 12. 段落起点退格 → 与上一段落合并（回归）
  await fresh('段落甲\n\n段落乙\n')
  await evalJs(`(() => { ${HELPERS} const p = Array.from(document.querySelectorAll('.md-preview p'))[1]; caretIn(p, 0, false); return 'ok' })()`)
  await pressBackspace()
  await new Promise((r) => setTimeout(r, 600))
  console.log('[12] backspace@para-start:', await evalJs(`(async () => { ${HELPERS} return await snapshot() })()`))

  console.log('[exceptions]', logs.slice(0, 8))
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
