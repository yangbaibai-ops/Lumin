'use strict'
// ─── 回归：分屏分隔条（拖拽改比例 + 双击复位）───────────────────────────────
//
// 迁到 `lib/harness.js` 后新增的价值：模式切换改成按 **序号** 点分段控件
// （老写法按中文按钮文字找 `.mode-seg-btn`，换语言或改类名就整轮发红）。
//
// 跑法：node tools/_regress-divider.js（先起隔离实例）

const { connect, settle, waitEditor, showToolbar, sleep, Reporter, clickMode, waitRestored, clickAt, fatal } =
  require('./lib/harness')

/** 左栏（渲染面板）占内核容器的比例 */
const RATIO = `(() => {
  const host = document.querySelector('.wysiwyg-container')?.parentElement
  if (!host) return -1
  const parent = host.parentElement
  if (!parent) return -1
  return Math.round((host.getBoundingClientRect().width / parent.getBoundingClientRect().width) * 1000) / 1000
})()`

async function main() {
  const report = new Reporter('回归：分屏分隔条拖拽与复位')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const backup = JSON.parse(
    await app.ev(`JSON.stringify({ mode: window.__L.ui().editorMode, ratio: window.__L.settings().splitRatio })`)
  )
  await app.ev(`(async () => { if (!window.__L.files().current) await window.__L.files().openUntitled(); return 'ok' })()`)
    // 工具栏出厂默认收起（清单 §1.E）⇒ 用 clickMode 切面的套件必须显式打开它
  await showToolbar(app)
  await app.ev(`(() => {
    const md = ['# 标题', '正文段落。', '', '\`\`\`js', 'x', '\`\`\`'].join('\\n')
    window.__L.files().setContent(md, 'external')
    window.__L.ed().commands.setContent(md, { emitUpdate: false })
    return 'ok'
  })()`)
  await sleep(800)

  const switched = await clickMode(app, 1) // 分屏
  await waitRestored(app.ev)
  report.check('M1 切到分屏', switched === true && (await app.ev(`window.__L.ui().editorMode`)) === 'split')

  const box = JSON.parse(
    await app.ev(`(() => {
      const d = document.querySelector('.split-divider')
      if (!d) return 'null'
      const r = d.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
  )
  if (box === 'null') {
    report.skip('D1 拖拽改变左栏宽度', '没有 .split-divider（不在分屏模式）')
  } else {
    const before = await app.ev(RATIO)
    // 向左拖 120px：左栏应变窄
    const target = box.x - 120
    await app.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1
    })
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target,
      y: box.y,
      button: 'left',
      buttons: 1
    })
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: target,
      y: box.y,
      button: 'left',
      clickCount: 1,
      buttons: 0
    })
    await sleep(400)
    const after = await app.ev(RATIO)
    report.check(
      'D1 向左拖 → 左栏变窄',
      typeof after === 'number' && typeof before === 'number' && after < before - 0.02,
      `ratio ${before} → ${after}`
    )
    report.check(
      'D2 拖拽结束把比例写进设置（跨会话保留）',
      Math.abs(Number(await app.ev(`window.__L.settings().splitRatio`)) - after) < 0.03,
      `settings=${await app.ev(`window.__L.settings().splitRatio`)} ratio=${after}`
    )

    // 双击复位到 1:1
    const mid = JSON.parse(
      await app.ev(`(() => {
        const d = document.querySelector('.split-divider')
        const r = d.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`)
    )
    await app.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: mid.x,
      y: mid.y,
      button: 'left',
      clickCount: 2
    })
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: mid.x,
      y: mid.y,
      button: 'left',
      clickCount: 2
    })
    await sleep(350)
    const reset = await app.ev(RATIO)
    report.check('D3 双击复位到 1:1', Math.abs(reset - 0.5) < 0.05, `ratio=${reset}`)
  }

  // 收尾：还原模式与比例
  await app.ev(`(() => {
    window.__L.ui().editorMode = ${JSON.stringify(backup.mode)}
    window.__L.settings().set('splitRatio', ${JSON.stringify(backup.ratio)})
    return 'ok'
  })()`)
  await sleep(200)
  void clickAt
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
