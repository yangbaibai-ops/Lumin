// 验收：代码块 CodeMirror 虚拟化（清单 §2.F / 自查报告 O2）
//
// 要证明的三件事：
//   ① **不再每块一个 CM**：60 个代码块的文档里 `.cm-editor` 只有个位数（视口附近那几块）；
//   ② **不在视口附近的块仍然可编辑**：滚过去就挂上（选区落进去也挂）；
//   ③ **高度稳定**：静态 ↔ 挂载切换时块高变化很小（否则滚动会跳）。
//
// 已用 harness（改到谁迁谁，见 tools/README.md）。
'use strict'
const { connect, settle, sleep, openDocWith, waitEditor, Reporter, fatal } = require('./lib/harness')

const BLOCKS = 60
const CODE = 'function f() {\n  return 1\n}\n'

const md =
  Array.from({ length: BLOCKS }, (_, i) => `第 ${i + 1} 段正文。\n\n\`\`\`javascript\n${CODE}\`\`\``).join(
    '\n\n'
  ) + '\n'

/** 块级统计：每个代码块是「已挂载（有 .cm-editor）」还是「静态态（.cb-static）」 */
const SHAPE = `(() => {
  const blocks = [...document.querySelectorAll('.code-block-wrapper')]
  return JSON.stringify({
    blocks: blocks.length,
    mounted: blocks.filter((b) => b.querySelector('.cm-editor')).length,
    static: blocks.filter((b) => b.querySelector('.cb-static')).length,
    heights: blocks.map((b) => Math.round(b.getBoundingClientRect().height)),
    // 前 3 块与后 3 块的状态（诊断用）
    head: blocks.slice(0, 3).map((b) => (b.querySelector('.cm-editor') ? 'cm' : 'static')),
    tail: blocks.slice(-3).map((b) => (b.querySelector('.cm-editor') ? 'cm' : 'static'))
  })
})()`

/** 把第 i 个代码块滚进视野（1-based），返回滚动后它的高度 */
const scrollToBlock = (i) => `(async () => {
  const blocks = [...document.querySelectorAll('.code-block-wrapper')]
  const b = blocks[${i - 1}]
  if (!b) return 'null'
  const before = Math.round(b.getBoundingClientRect().height)
  b.scrollIntoView({ block: 'center' })
  return JSON.stringify({ before })
})()`

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  if (!(await waitEditor(ev))) throw new Error('编辑器未就绪')
  const report = new Reporter('代码块 CM 虚拟化：按需挂载 / 高度稳定 / 选区保护')

  await openDocWith(app, md, 'cb-virtual.md')
  await sleep(1500)

  const shape = JSON.parse(await ev(SHAPE))
  report.note('初始态 ' + JSON.stringify({ ...shape, heights: undefined }))
  report.check('doc-has-60-code-blocks', shape.blocks === BLOCKS, `blocks=${shape.blocks}`)
  report.check(
    'not-one-cm-per-block',
    shape.mounted > 0 && shape.mounted <= 12 && shape.static >= BLOCKS - 12,
    `mounted=${shape.mounted} static=${shape.static}（每块一个 CM 时会是 ${BLOCKS}）`
  )
  report.check(
    'viewport-blocks-are-mounted',
    shape.head.every((s) => s === 'cm'),
    `head=${JSON.stringify(shape.head)} tail=${JSON.stringify(shape.tail)}`
  )

  // ② 滚到远处（第 40 块）→ 它必须挂上，且高度变化很小（③）
  const before = JSON.parse(await ev(scrollToBlock(40)))
  await sleep(1200)
  const afterShape = JSON.parse(await ev(SHAPE))
  const afterHeights = afterShape.heights
  const h = afterHeights[39]
  const drift = Math.abs(h - before.before) / Math.max(1, before.before)
  report.note(
    '滚动后 ' + JSON.stringify({ ...afterShape, heights: undefined }) + ` 第40块高 ${before.before} → ${h}`
  )
  report.check(
    'scrolled-block-mounted',
    !!afterHeights[39] && (await ev(`!!document.querySelectorAll('.code-block-wrapper')[39]?.querySelector('.cm-editor')`)) === true,
    `第 40 块挂载=${await ev(`!!document.querySelectorAll('.code-block-wrapper')[39]?.querySelector('.cm-editor')`)}`
  )
  report.check(
    'static-to-mounted-height-stable',
    // 静态态与挂载态高度差应当很小（文本/排版一致 ⇒ 只差 gutter 与内边距的几 px）
    drift <= 0.2,
    `第 40 块 ${before.before} → ${h}（漂移 ${(drift * 100).toFixed(1)}%）`
  )
  report.check(
    'mounted-count-still-small',
    afterShape.mounted <= 16,
    `mounted=${afterShape.mounted}（滚到第 40 块后仍应是视口附近那几块）`
  )

  // ④ 选区保护：把 PM 选区放进**屏幕外**的第 55 块 → 它必须被强制挂载
  await ev(`(() => {
    const ed = window.__L.ed()
    let seen = 0
    let target = null
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') {
        seen += 1
        if (seen === 55) target = pos + 1
      }
      return true
    })
    if (target === null) return 'no-target'
    ed.commands.setTextSelection(target)
    return 'ok'
  })()`)
  let forced = false
  for (let i = 0; i < 40; i++) {
    await sleep(100)
    const ok = await ev(
      `!!document.querySelectorAll('.code-block-wrapper')[54]?.querySelector('.cm-editor')`
    )
    if (ok === true) {
      forced = true
      break
    }
  }
  report.check(
    'selection-inside-far-block-forces-mount',
    forced === true,
    '选区落进屏幕外的第 55 块 ⇒ 必须挂 CM（否则键盘路由/打字都会错）'
  )
  // ④b 强制挂载之后，**光标要真的交给那个 CM**（`mountCmForVirtualization` 里的
  //     `focusCmAtEnd()`）—— 否则用户按键还是打不进这个块。
  let caretInCm = false
  for (let i = 0; i < 25; i++) {
    caretInCm =
      (await ev(
        `(() => { const b = document.querySelectorAll('.code-block-wrapper')[54]; const cm = b && b.querySelector('.cm-editor'); return !!cm && cm.contains(document.activeElement) })()`
      )) === true
    if (caretInCm) break
    await sleep(120)
  }
  report.check(
    'forced-mount-takes-the-caret',
    caretInCm === true,
    '第 55 块强制挂载后焦点应在它的 .cm-editor 里'
  )

  // ⑥ 来回滚（挂/卸churn）之后，视口里的块仍然**可打字**：这条守 R2（卸载前先 syncToNode ⇒ 不丢字符）
  // 与 R5（hasFocus 守卫计数归零 ⇒ PM 不失聪）
  await ev(`(() => {
    const b = [...document.querySelectorAll('.code-block-wrapper')][0]
    if (b) b.scrollIntoView({ block: 'start' })
    return 'ok'
  })()`)
  await sleep(900)
  const spot = JSON.parse(
    await ev(`(() => {
      const b = document.querySelectorAll('.code-block-wrapper')[0]
      const cm = b && b.querySelector('.cm-editor')
      if (!cm) return JSON.stringify({ mounted: false })
      const r = cm.querySelector('.cm-content').getBoundingClientRect()
      return JSON.stringify({ mounted: true, x: Math.round(r.left + 8), y: Math.round(r.top + 8) })
    })()`)
  )
  if (spot.mounted) {
    await app.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: spot.x,
      y: spot.y,
      button: 'left',
      clickCount: 1
    })
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: spot.x,
      y: spot.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(250)
    await app.send('Input.insertText', { text: 'ZZ' })
    await sleep(500)
    // ⚠️ 判据要取**第一个代码块节点**的文本 —— 文档里块前面还有一段正文，
    // 所以 `doc.child(0)` 是段落而不是代码块（第一版断言就栽在这上面）。
    const firstCode = JSON.parse(
      await ev(`(() => {
        let first = null
        window.__L.ed().state.doc.descendants((n) => {
          if (first === null && n.type.name === 'codeBlock') first = n.textContent
          return true
        })
        return JSON.stringify({ first })
      })()`)
    )
    report.check(
      'first-block-still-typable-after-churn',
      typeof firstCode.first === 'string' && firstCode.first.includes('ZZ'),
      JSON.stringify(firstCode.first)
    )

    // ⑦ 重挂之后的 **CM 扩展**还在不在：括号自动配对（`closeBrackets()` + 它的 keymap）。
    //    审计 §F.3 点名「卸载/重挂必须保住括号补全的 keymap 注册」—— 这条就是守它的：
    //    重挂时若漏掉任何一条扩展（或 keymap 被替换），打 `(` 就只会写进一个 `(`。
    await app.send('Input.insertText', { text: '(' })
    await sleep(500)
    const bracketed = JSON.parse(
      await ev(`(() => {
        let first = null
        window.__L.ed().state.doc.descendants((n) => {
          if (first === null && n.type.name === 'codeBlock') first = n.textContent
          return true
        })
        return JSON.stringify({ first })
      })()`)
    )
    report.note('重挂后打 `(` → ' + JSON.stringify(bracketed.first))
    report.check(
      'bracket-autoclose-after-remount',
      typeof bracketed.first === 'string' && bracketed.first.includes('()'),
      JSON.stringify(bracketed.first)
    )
    // ⑧ 静态态**不是**只读：`mousedown` 一下就要挂 CM（P3「点开即挂」）。
    //    为什么用合成事件而不是真实点击：屏幕上能点到的块**必然**已经被观察器挂上了
    //    （观察器有 600px 提前量），真实点击只会点到已经挂载的块 —— 实测就是这样
    //    （第一版用 scrollIntoView 再点，结果 wasStatic=false）。
    //    `activated` 这条路的现实场景是「程序化跳转后立刻点」（观察器回调还没跑），
    //    这里直接派发同一个事件到静态块上，验证的是同一条处理链。
    const farStatic = JSON.parse(
      await ev(`(async () => {
        const blocks = [...document.querySelectorAll('.code-block-wrapper')]
        // 找最后一个仍是静态态的块（它必然离视口很远）
        let idx = -1
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].querySelector('.cb-static')) { idx = i; break }
        }
        if (idx < 0) return '{"err":"no-static-block"}'
        const pre = blocks[idx].querySelector('.cb-static')
        pre.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        return JSON.stringify({ idx, dispatched: true })
      })()`)
    )
    let activatedMount = false
    for (let i = 0; i < 25; i++) {
      await sleep(120)
      const ok = await ev(
        `(() => { const b = document.querySelectorAll('.code-block-wrapper')[${farStatic.idx ?? 0}]; return !!(b && b.querySelector('.cm-editor')) })()`
      )
      if (ok === true) {
        activatedMount = true
        break
      }
    }
    report.note('静态块 mousedown → 挂载 ' + JSON.stringify({ ...farStatic, activatedMount }))
    report.check(
      'static-block-activates-on-mousedown',
      farStatic.dispatched === true && activatedMount === true,
      JSON.stringify({ idx: farStatic.idx, mounted: activatedMount })
    )
  } else {
    report.check('first-block-still-typable-after-churn', false, '滚回顶部后第一块没挂上 CM')
    report.check('bracket-autoclose-after-remount', false, '滚回顶部后第一块没挂上 CM')
    report.check('static-block-activates-on-mousedown', false, '滚回顶部后第一块没挂上 CM')
  }

  // ⑤ 换文档：旧文档的块全部卸载，新文档照常工作
  await openDocWith(app, '# 另一份文档\n\n```python\nprint(1)\n```\n', 'cb-virtual-2.md')
  await sleep(1200)
  const after = JSON.parse(await ev(SHAPE))
  report.note('换文档后 ' + JSON.stringify({ ...after, heights: undefined }))
  report.check(
    'doc-switch-leaves-clean-state',
    after.blocks === 1 && after.mounted === 1 && after.static === 0,
    JSON.stringify({ blocks: after.blocks, mounted: after.mounted, static: after.static })
  )

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
