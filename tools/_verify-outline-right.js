// 验收：三栏模式 —— 大纲放在编辑区右侧（左文件树 | 中编辑区 | 右大纲，可折叠/展开）
//
// 用户口径：**默认不动**（沿用左栏「文件 / 大纲」页签），设置里显式打开后：
//   * 左栏只保留文件目录（页签行整行隐藏）；
//   * 大纲固定显示在编辑区右侧，于是目录与大纲能同时看到；
//   * 右侧大纲支持折叠 / 展开（折叠是 34px 窄轨，展开 220px）。
//
// 套件自己**收拾并还原现场**：先在设置面板里点真实开关验一遍 UI 路径，再用 store 做几何断言，
// 最后把设置恢复成进入时的值（否则会污染后续套件 —— 默认值本身由 tests/ 的单测守着）。
//
// 已用 harness（改到谁迁谁，见 tools/README.md）。
'use strict'
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')

const MD = ['# 一级标题', '', '正文。', '', '## 二级标题', '', '- 项', '', '### 三级标题', '', ''].join('\n')

const SHAPE = `(() => {
  const panel = document.querySelector('[data-outline-panel]')
  const aside = document.querySelector('aside')
  const kernel = document.querySelector('[data-editor-kernel]')
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) } }
  const toggle = panel ? panel.querySelector('[data-outline-toggle]') : null
  const iconPath = toggle ? toggle.querySelector('path') : null
  return JSON.stringify({
    panel: rect(panel),
    panelText: panel ? panel.textContent.replace(/\\s+/g, ' ').trim() : null,
    kernel: rect(kernel),
    sidebarTabs: aside ? [...aside.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((x) => x === '文件' || x === '大纲') : [],
    toggleAria: toggle ? toggle.getAttribute('aria-label') : null,
    toggleExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
    toggleIcon: iconPath ? iconPath.getAttribute('d') : null,
    resizeHandle: !!document.querySelector('[data-outline-resize]'),
    setting: window.__L.settings().outlineOnRight,
    expanded: window.__L.settings().outlineRightExpanded,
    width: window.__L.settings().outlineRightWidth
  })
})()`

/** 从左缘手柄往 targetX 拖（中间插几步 mousemove，真实拖拽才不会只触发一次） */
async function dragHandle(app, fromX, y, targetX) {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y, button: 'none', buttons: 0 })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', clickCount: 1 })
  await sleep(60)
  for (let i = 1; i <= 6; i++) {
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(fromX + ((targetX - fromX) * i) / 6),
      y,
      button: 'left',
      buttons: 1
    })
    await sleep(50)
  }
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y, button: 'left', clickCount: 1 })
  await sleep(400)
}

async function click(app, sel) {
  const raw = await app.ev(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`
  )
  if (!raw) throw new Error('找不到元素: ' + sel)
  const p = JSON.parse(raw)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
  }
  await sleep(450)
}

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('三栏模式：大纲放在编辑区右侧（可折叠/展开）')

  const original = await ev(`window.__L.settings().outlineOnRight`)
  const originalWidth = await ev(`window.__L.settings().outlineRightWidth`)
  await ev(`(() => {
    const s = window.__L.settings()
    s.set('outlineOnRight', false)
    s.set('outlineRightWidth', 220)
    return 'ok'
  })()`)
  await sleep(500)
  await openDocWith(app, MD, 'outline-right.md')
  await sleep(900)

  // ① 默认结构：左栏有「文件 / 大纲」两个页签、右侧没有大纲面板
  const off = JSON.parse(await ev(SHAPE))
  report.note('关闭态 ' + JSON.stringify({ ...off, panelText: undefined }))
  report.check('off-keeps-sidebar-tabs', off.sidebarTabs.join('/') === '文件/大纲', JSON.stringify(off.sidebarTabs))
  report.check('off-has-no-right-panel', off.panel === null, JSON.stringify(off.panel))

  // ② 真实 UI 路径：设置面板里那个开关存在且能打开
  await ev(`(() => { window.__L.ui().openSettings('general'); return 'ok' })()`)
  await sleep(700)
  const switchSel = '[aria-label="大纲放在编辑区右侧"]'
  const hasSwitch = await ev(`!!document.querySelector(${JSON.stringify(switchSel)})`)
  report.check('settings-switch-exists', hasSwitch === true, 'settings → 一般 → 大纲放在编辑区右侧')
  if (hasSwitch) await click(app, switchSel)
  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)
  await sleep(700)

  const on = JSON.parse(await ev(SHAPE))
  report.note('开启态 ' + JSON.stringify({ ...on, panelText: undefined }))
  report.check('setting-turned-on-by-switch', on.setting === true && on.expanded === true, JSON.stringify({ s: on.setting, e: on.expanded }))
  report.check('on-hides-sidebar-tabs', on.sidebarTabs.length === 0, JSON.stringify(on.sidebarTabs))
  report.check('on-shows-right-panel-220', !!on.panel && on.panel.width === 220, JSON.stringify(on.panel))
  report.check(
    'right-panel-lists-headings',
    !!on.panelText && on.panelText.includes('一级标题') && on.panelText.includes('三级标题'),
    JSON.stringify(on.panelText)
  )
  report.check(
    'panel-sits-right-of-kernel',
    !!on.panel && !!on.kernel && on.panel.left >= on.kernel.right - 1,
    JSON.stringify({ kernelRight: on.kernel && on.kernel.right, panelLeft: on.panel && on.panel.left })
  )
  report.check(
    'kernel-left-of-panel-and-narrower',
    !!on.kernel && on.kernel.left === 264 && on.kernel.width < 1040,
    JSON.stringify(on.kernel)
  )

  // ③ 折叠 / 展开（含**箭头方向**：这条守的是 Icon.vue 的 `name` 必须响应式 ——
  //     曾经那里 `parts()` 只在 setup 里算一次，宽度与 aria 都跟着变了、只有箭头永远是同一个）
  await click(app, '[data-outline-toggle]')
  const collapsed = JSON.parse(await ev(SHAPE))
  report.note('折叠态 ' + JSON.stringify({ ...collapsed, panelText: undefined }))
  report.check(
    'collapses-to-narrow-rail',
    !!collapsed.panel && collapsed.panel.width === 34 && collapsed.expanded === false,
    JSON.stringify(collapsed.panel)
  )
  // 折叠后只剩那条窄轨 + 一个展开箭头：面板里不该再有任何标题文字
  // （标题行的「大纲」二字在折叠态也一起收起来，所以这里期望空串）
  report.check('collapsed-hides-list', collapsed.panelText === '', JSON.stringify(collapsed.panelText))
  report.check(
    'collapsed-toggle-offers-expand',
    collapsed.toggleAria === '展开大纲' && collapsed.toggleExpanded === 'false',
    JSON.stringify({ aria: collapsed.toggleAria, expanded: collapsed.toggleExpanded })
  )
  report.check(
    'collapsed-icon-points-left',
    collapsed.toggleIcon === 'm15 18-6-6 6-6',
    JSON.stringify(collapsed.toggleIcon)
  )
  report.check('collapsed-has-no-resize-handle', collapsed.resizeHandle === false, '折叠态是窄轨，没有拖拽手柄')
  await click(app, '[data-outline-toggle]')
  const expanded = JSON.parse(await ev(SHAPE))
  report.check(
    'expands-back-to-220',
    !!expanded.panel && expanded.panel.width === 220 && expanded.expanded === true,
    JSON.stringify(expanded.panel)
  )
  report.check(
    'expanded-toggle-offers-collapse',
    expanded.toggleAria === '收起大纲' && expanded.toggleExpanded === 'true',
    JSON.stringify({ aria: expanded.toggleAria, expanded: expanded.toggleExpanded })
  )
  report.check(
    'expanded-icon-points-right',
    expanded.toggleIcon === 'm9 18 6-6-6-6',
    JSON.stringify(expanded.toggleIcon)
  )

  // ③b 宽度可拖：抓左缘手柄往左拖 60px ⇒ 面板变宽 60px，并写回设置（重启保持）
  const before = JSON.parse(await ev(SHAPE))
  await dragHandle(app, before.panel.left, before.panel.left > 0 ? 300 : 300, before.panel.left - 60)
  const resized = JSON.parse(await ev(SHAPE))
  report.note('拖宽后 ' + JSON.stringify({ panel: resized.panel, settingWidth: resized.width }))
  report.check(
    'drag-left-edge-widens-panel',
    Math.abs(resized.panel.width - (before.panel.width + 60)) <= 4,
    JSON.stringify({ before: before.panel.width, after: resized.panel.width })
  )
  report.check('drag-persists-width', resized.width === resized.panel.width, JSON.stringify({ s: resized.width, w: resized.panel.width }))

  // ③c 钳位：拖到最左 = 420 上限，拖回最右 = 160 下限
  await dragHandle(app, resized.panel.left, 300, 40)
  const maxed = JSON.parse(await ev(SHAPE))
  report.check('drag-clamps-at-max', maxed.panel.width === 420, JSON.stringify(maxed.panel))
  await dragHandle(app, maxed.panel.left, 300, 1290)
  const minned = JSON.parse(await ev(SHAPE))
  report.check('drag-clamps-at-min', minned.panel.width === 160, JSON.stringify(minned.panel))

  // ④ 关掉设置 → 回到默认结构（页签回来、右侧面板消失）
  await ev(`(() => { window.__L.settings().set('outlineOnRight', false); return 'ok' })()`)
  await sleep(600)
  const back = JSON.parse(await ev(SHAPE))
  report.check(
    'turning-off-restores-tabs',
    back.sidebarTabs.join('/') === '文件/大纲' && back.panel === null,
    JSON.stringify({ tabs: back.sidebarTabs, panel: back.panel })
  )

  // 还原进入时的值（不污染后续套件）
  await ev(`(() => {
    const s = window.__L.settings()
    s.set('outlineOnRight', ${JSON.stringify(original)})
    s.set('outlineRightWidth', ${JSON.stringify(originalWidth)})
    return 'ok'
  })()`)
  await sleep(300)

  app.close()
  process.exit(report.finish())
}
main().catch(fatal)
