'use strict'
// ─── 回归：代码块的核心修复（打字 / 回车 / 退格三类）─────────────────────────
//
// 这一组是「代码块里输入会丢字」那一类 bug 的守卫。它们此前写成一次性脚本
// （自己连 CDP、自己打印 PASS/FAIL），本轮迁到 `lib/harness.js` + `Reporter`，
// 于是能进矩阵、能被 `--- N/M PASS` 机器聚合。
//
// 跑法（对着隔离实例）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-isolated.ps1
//   node tools/_regress-cb.js

const {
  connect,
  settle,
  waitEditor,
  sleep,
  ensureFocus,
  Reporter,
  key,
  clickCenter,
  openDocWith,
  fatal
} = require('./lib/harness')

/** 代码块（CodeMirror）里的文本 */
const CODE_TEXT = `(() => {
  const ed = window.__L.ed()
  let c = ''
  ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c += '[' + n.textContent + ']' })
  return c
})()`

const CODE_BLOCKS = `(() => {
  const ed = window.__L.ed()
  let n = 0
  ed.state.doc.descendants((x) => { if (x.type.name === 'codeBlock') n++ })
  return n
})()`

/** 代码块里 CodeMirror 看到的文本（与节点文本区分：两者不一致就说明外部同步没生效） */
const CM_TEXT = `(() => {
  const el = document.querySelector('.cm-content')
  return el ? el.textContent : null
})()`

async function tapKey(app, name, vk) {
  await key(app.send, 'keyDown', name, name, vk)
  await key(app.send, 'keyUp', name, name, vk)
}

/**
 * 点进代码块并确认焦点**稳定**落在 CM 里。
 *
 * 为什么要确认两次：账本收敛会触发渲染面再 `setContent` 一次，CM 的 NodeView 随之
 * 重建 —— 我们在重建前点到的是**即将被换掉的那个** `.cm-content`（它当时还在 DOM 里、
 * 也能通过一次焦点检查），换掉之后焦点就丢了，退格键落不到 CM 上（实测：B 段
 * `focused=true` 却 `blocks=1`）。所以点完要隔一拍再确认一次仍然聚焦。
 */
async function focusCodeBlock(app) {
  const isFocused = `(() => {
    const el = document.querySelector('.cm-content')
    return !!el && el.isConnected && (document.activeElement === el || el.contains(document.activeElement))
  })()`
  for (let i = 0; i < 6; i++) {
    /**
     * 先点**静态态**那个 `<pre class="cb-static">`：代码块视图是虚拟化的
     * （`shouldMountCm`：视口附近 / 选区在内 / 刚点过 —— 见 lib/editor/codeBlockMountPolicy.ts），
     * 而"点一下激活"正是产品自身的交互路径（静态块的 mousedown → activateFromStatic → 下一拍挂 CM）。
     *
     * 不先激活的话，本套件的结果会取决于"窗口有没有真的在渲染"：实测用户自己的 Lumin
     * 窗口在前台时，被测窗口的 IntersectionObserver 拿不到 near，代码块停在静态态，
     * 于是 A/B 两段假红（`focused=false`、`.cm-content` 根本不存在）。
     */
    await clickCenter(app.send, app.ev, 'pre.cb-static')
    await sleep(150)
    await clickCenter(app.send, app.ev, '.cm-content')
    await sleep(220)
    if (await app.ev(isFocused)) {
      await sleep(160)
      if (await app.ev(isFocused)) return true
    }
  }
  return false
}

async function main() {
  const report = new Reporter('回归：代码块打字 / 回车 / 退格')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  await app.ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
  await sleep(400)
  await app.ev(
    `(async () => { if (!window.__L.files().current) await window.__L.files().openUntitled(); return 'ok' })()`
  )
  await waitEditor(app.ev)

  // A：代码块内输入 + 回车 + 继续输入（换行不能丢）
  await openDocWith(app, ['正文', '', '```js', 'const a = 1', '```'].join('\n'), 'cb-a.md')
  await sleep(400)
  console.log(
    'DBG-A0 ' +
      (await app.ev(`(() => {
        const f = window.__L.files()
        return JSON.stringify({ rev: f.contentRev, author: f.contentAuthor, applied: { ...f.sync.applied } })
      })()`))
  )
  const focused = await focusCodeBlock(app)
  console.log(
    'DBG-A1 ' +
      (await app.ev(`(() => {
        const f = window.__L.files()
        return JSON.stringify({ rev: f.contentRev, author: f.contentAuthor, applied: { ...f.sync.applied }, stale: f.contentIsStale('codeblock') })
      })()`))
  )
  await app.send('Input.insertText', { text: 'hello' })
  await sleep(150)
  console.log(
    'DBG-A2 ' +
      (await app.ev(`(() => {
        const f = window.__L.files()
        return JSON.stringify({ rev: f.contentRev, author: f.contentAuthor, applied: { ...f.sync.applied }, stale: f.contentIsStale('codeblock') })
      })()`))
  )
  await tapKey(app, 'Enter', 13)
  await sleep(150)
  await app.send('Input.insertText', { text: 'world' })
  await sleep(500)
  const codeA = await app.ev(CODE_TEXT)
  report.check(
    'A 代码块内输入 + 回车换行',
    focused === true &&
      typeof codeA === 'string' &&
      codeA.includes('hello') &&
      codeA.includes('world'),
    `focused=${focused} code=${JSON.stringify(codeA)}`
  )

  // B：空代码块按退格 → 整块删除（否则空块「卡住」删不掉）
  await openDocWith(app, ['正文', '', '```', '', '```', '', '尾部'].join('\n'), 'cb-b.md')
  await sleep(400)
  const focusedB = await focusCodeBlock(app)
  const cmTextB = await app.ev(CM_TEXT)
  await tapKey(app, 'Backspace', 8)
  await sleep(400)
  const blocksB = await app.ev(CODE_BLOCKS)
  report.check(
    'B 空代码块退格 → 整块删除',
    focusedB === true && blocksB === 0,
    `focused=${focusedB} blocks=${blocksB} cm=${JSON.stringify(cmTextB)}`
  )

  // C：代码块后段落行首退格 → 光标进入代码块末尾（而不是删掉内容）
  await openDocWith(app, ['正文', '', '```js', 'code line', '```', '', ''].join('\n'), 'cb-c.md')
  await sleep(400)
  await app.ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    ed.commands.focus()
    return 'ok'
  })()`)
  await sleep(150)
  await tapKey(app, 'Backspace', 8)
  await sleep(300)
  const infoC = JSON.parse(
    await app.ev(`(() => {
      const ed = window.__L.ed()
      let code = ''
      ed.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') code = n.textContent })
      return JSON.stringify({ from: ed.state.selection.from, code })
    })()`)
  )
  report.check(
    'C 代码块后空段落退格 → 光标落入块尾（内容不动）',
    typeof infoC.code === 'string' && infoC.code.endsWith('code line'),
    JSON.stringify(infoC)
  )

  // ── D. 外部整篇替换优先于代码块里的旧文本（审计 §3 P1）───────────────────
  // 方向判定在 CodeBlockView 里用的是"节点文本是不是我上次对齐的那一份"
  // （`alignedNodeText`）—— 账本的 applied 会因 250ms 防抖的作者牌而落后一代，
  // 拿它驱动会把用户输入整段吃掉（这条断言原来就是这么红的）。
  // 先在**无焦点**下验证"节点被外部改过 ⇒ CM 跟着真源重建"。
  await openDocWith(app, ['正文', '', '```js', 'OLD-CODE', '```'].join('\n'), 'cb-d.md')
  await sleep(600)
  const d1 = JSON.parse(
    await app.ev(`(async () => {
      const f = window.__L.files()
      const read = () => { let c = ''; window.__L.ed().state.doc.descendants((n) => { if (n.type.name === 'codeBlock') c = n.textContent }); return c }
      const before = { node: read(), cm: document.querySelector('.cm-content')?.textContent ?? null }
      f.setContent(['正文', '', '\`\`\`js', 'EXTERNAL-NEW', '\`\`\`'].join('\\n'), 'external')
      await new Promise((r) => setTimeout(r, 900))
      return JSON.stringify({
        before,
        nodeAfter: read(),
        cmAfter: document.querySelector('.cm-content')?.textContent ?? null
      })
    })()`)
  )
  report.note('D1 ' + JSON.stringify(d1))
  report.check(
    'D1 外部整篇替换后代码块跟着真源重建（旧文本不残留）',
    d1.before.node === 'OLD-CODE' &&
      d1.nodeAfter === 'EXTERNAL-NEW' &&
      d1.cmAfter === 'EXTERNAL-NEW',
    JSON.stringify(d1)
  )

  // D2 需要真实按键（外部替换后人在代码块里敲一下）——拿不到焦点就如实跳过
  if (!(await ensureFocus(app))) {
    report.skip('D2 外部替换后代码块按键不顶掉外部内容', '窗口拿不到焦点')
  } else {
    await openDocWith(app, ['正文', '', '```js', 'OLD-CODE', '```'].join('\n'), 'cb-e.md')
    await sleep(600)
    const focusedD = await focusCodeBlock(app)
    await app.ev(`(async () => {
      window.__L.files().setContent(['正文', '', '\`\`\`js', 'EXTERNAL-NEW', '\`\`\`'].join('\\n'), 'external')
      await new Promise((r) => setTimeout(r, 900))
      return 'ok'
    })()`)
    await app.send('Input.insertText', { text: 'X' })
    await sleep(600)
    const d2 = JSON.parse(
      await app.ev(`(() => {
        let node = ''
        window.__L.ed().state.doc.descendants((n) => { if (n.type.name === 'codeBlock') node = n.textContent })
        const cm = document.querySelector('.cm-content')
        return JSON.stringify({
          node,
          cmText: cm ? cm.textContent : null,
          stale: window.__L.files().contentIsStale('codeblock')
        })
      })()`)
    )
    report.note('D2 ' + JSON.stringify(d2))
    report.check(
      'D2 外部替换后代码块按键不顶掉外部内容',
      focusedD === true && d2.node.includes('EXTERNAL-NEW') && !d2.node.includes('OLD-CODE'),
      JSON.stringify(d2)
    )
    report.check(
      'D3 外部替换后代码块这一面与真源一致（没有残留旧文本）',
      !String(d2.cmText ?? '').includes('OLD-CODE'),
      JSON.stringify({ stale: d2.stale, cmText: d2.cmText })
    )
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
