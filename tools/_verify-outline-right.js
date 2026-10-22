// 验收：三栏模式 —— 大纲放在编辑区右侧（左文件树 | 中编辑区 | 右大纲，可折叠/展开）
//
// 用户口径：**默认不动**（沿用左栏「文件 / 大纲」页签），设置里显式打开后：
//   * 左栏只保留文件目录（页签行整行隐藏）；
//   * 大纲固定显示在编辑区右侧，于是目录与大纲能同时看到；
//   * 大纲面板可折叠 / 展开（折叠 = 面板整块隐藏、dock 仍在，展开 220px）。
//
// ⚠️ 本套件随「主分支移除 AI + dock 只留大纲」更新过断言：
//   * dock 上**只有 1 个按钮**（outline），不再有第 2 个 AI 按钮；
//   * 折叠/展开走 dock 上的同一个按钮（`[data-right-dock-button]`），
//     旧的 `[data-sidebar-hide]` / `[data-sidebar-show]` 窄轨按钮已随实现删除。
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
  const dock = document.querySelector('[data-right-dock]')
  const aside = document.querySelector('aside')
  const kernel = document.querySelector('[data-editor-kernel]')
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) } }
  // 当前实现（主分支移除 AI 后）：dock 上只有「大纲」一个按钮，按钮是独立动作不是页签。
  // 折叠/展开也由这同一个按钮承担（旧窄轨里的 data-sidebar-show 已删除）。
  const buttons = dock ? [...dock.querySelectorAll('[data-right-dock-button]')].map((b) => ({
    tab: b.dataset.panel,
    pressed: b.getAttribute('aria-pressed'),
    label: b.getAttribute('aria-label')
  })) : []
  return JSON.stringify({
    panel: rect(panel),
    panelDisplayed: panel ? getComputedStyle(panel).display !== 'none' : false,
    panelText: panel ? panel.textContent.replace(/\\s+/g, ' ').trim() : null,
    dock: rect(dock),
    dockVisible: !!dock,
    kernel: rect(kernel),
    viewportWidth: window.innerWidth,
    sidebarTabs: aside ? [...aside.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((x) => x === '文件' || x === '大纲') : [],
    buttons,
    hasTablist: !!dock && !!dock.querySelector('[role="tablist"], [role="tab"], [aria-selected]'),
    resizeHandle: !!document.querySelector('[data-outline-resize]'),
    setting: window.__L.settings().outlineOnRight,
    expanded: window.__L.settings().outlineRightExpanded,
    width: window.__L.settings().outlineRightWidth
  })
})()`

/** 从左缘手柄往 targetX 拖（中间插几步 mousemove，真实拖拽才不会只触发一次） */
async function dragHandle(app, fromX, y, targetX) {
  // 用 DOM MouseEvent 走组件真正的 @mousedown + document mousemove/mouseup 路径。
  // 不走 CDP 指针：这台机器/这个窗口尺寸下坐标点击会偶发打不中（同一坐标 elementFromPoint
  // 正确、事件却不生效），那是套件环境问题，不是拖拽实现的问题。
  await app.ev(`(async () => {
    const el = document.querySelector('[data-outline-resize]')
    if (!el) return 'no handle'
    const y = ${JSON.stringify(y)}
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ${JSON.stringify(fromX)}, clientY: y, button: 0 }))
    await new Promise((r) => setTimeout(r, 60))
    for (let i = 1; i <= 6; i++) {
      const x = Math.round(${JSON.stringify(fromX)} + ((${JSON.stringify(targetX)} - ${JSON.stringify(fromX)}) * i) / 6)
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 }))
      await new Promise((r) => setTimeout(r, 40))
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${JSON.stringify(targetX)}, clientY: y, button: 0 }))
    return 'ok'
  })()`)
  await sleep(400)
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
  report.check('off-has-no-right-panel', off.panel === null && off.panelDisplayed === false, JSON.stringify(off.panel))
  // 大纲在左栏 = dock 上没有可用按钮 ⇒ 整组（面板 + dock）不挂载（见 lib/sidebarPanels.ts）
  report.check('off-has-no-right-dock', off.dock === null && off.dockVisible === false, JSON.stringify({ dock: off.dock, visible: off.dockVisible }))

  // ② 真实 UI 路径：设置面板里那个开关存在且能打开
  await ev(`(() => { window.__L.ui().openSettings('general'); return 'ok' })()`)
  await sleep(700)
  const switchSel = '[aria-label="大纲放在编辑区右侧"]'
  const hasSwitch = await ev(`!!document.querySelector(${JSON.stringify(switchSel)})`)
  report.check('settings-switch-exists', hasSwitch === true, 'settings → 一般 → 大纲放在编辑区右侧')
  // 这里只需要验证「设置里那个开关 → setOutlineSide」这条路径，不验指针命中；
  // 设置页在 1784 宽的窗口里位置会随滚动变化，坐标点击偶发打不中（套件环境敏感），
  // 所以对这一个开关用 DOM click（与 SettingSwitch 的 @click 同一入口）。
  if (hasSwitch) {
    await ev(`(() => { document.querySelector(${JSON.stringify(switchSel)})?.click(); return 'ok' })()`)
    await sleep(450)
  }
  await ev(`(() => { window.__L.ui().closeSettings(); return 'ok' })()`)
  await sleep(700)

  const on = JSON.parse(await ev(SHAPE))
  report.note('开启态 ' + JSON.stringify({ ...on, panelText: undefined }))
  report.check('setting-turned-on-by-switch', on.setting === true && on.expanded === true, JSON.stringify({ s: on.setting, e: on.expanded }))
  report.check('on-hides-sidebar-tabs', on.sidebarTabs.length === 0, JSON.stringify(on.sidebarTabs))
  report.check('on-shows-right-panel-220', !!on.panel && on.panelDisplayed && on.panel.width === 220, JSON.stringify(on.panel))
  report.check('on-shows-right-dock-40', !!on.dock && on.dock.width === 40, JSON.stringify(on.dock))
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
  // 布局是「左栏 + 内核 + 右栏 + dock」：内核宽度 = 视口 - 左栏宽 - 右栏宽 - dock 宽
  report.check(
    'kernel-sits-between-sidebars',
    !!on.kernel &&
      !!on.panel &&
      on.kernel.left >= 200 &&
      on.kernel.left <= 420 &&
      Math.abs(on.kernel.right - on.panel.left) <= 1 &&
      Math.abs(on.kernel.width - (on.viewportWidth - on.panel.width - (on.dock ? on.dock.width : 0) - on.kernel.left)) <= 2,
    JSON.stringify({ kernel: on.kernel, panel: on.panel, dock: on.dock, viewportWidth: on.viewportWidth })
  )

  // 主分支移除 AI 后：dock 上**只有一个「大纲」按钮**（没有第 2 个 AI 按钮），也没有页签语义
  report.check(
    'has-one-outline-button-and-no-ai',
    on.buttons.length === 1 &&
      on.buttons[0].tab === 'outline' &&
      on.buttons[0].pressed === 'true' &&
      on.buttons.every((b) => b.tab !== 'ai'),
    JSON.stringify(on.buttons)
  )
  report.check('no-tab-semantics', on.hasTablist === false, '不再有 tablist / role=tab / aria-selected')

  // ③ 折叠 / 展开：点 dock 上同一个按钮 = 收起面板（dock 仍常驻）；再点 = 展开 220
  await ev(`(() => { document.querySelector('[data-right-dock-button]')?.click(); return 'ok' })()`)
  await sleep(450)
  const collapsed = JSON.parse(await ev(SHAPE))
  report.note('收起态 ' + JSON.stringify({ ...collapsed, panelText: undefined }))
  report.check(
    'dock-button-collapses-panel',
    collapsed.expanded === false && collapsed.panelDisplayed === false,
    JSON.stringify({ expanded: collapsed.expanded, displayed: collapsed.panelDisplayed })
  )
  // 收起只收起面板：dock 本体必须还在（用户点得到展开入口），按钮 pressed 变 false
  report.check(
    'collapsed-keeps-dock',
    collapsed.dockVisible === true && collapsed.buttons.length === 1 && collapsed.buttons[0].pressed === 'false',
    JSON.stringify({ dock: collapsed.dock, buttons: collapsed.buttons })
  )
  // 收起态：面板整块不显示（v-show），但 DOM 保留（滚动位置不丢）；宽度应为 0
  report.check(
    'collapsed-panel-is-not-displayed',
    collapsed.panelDisplayed === false && (!collapsed.panel || collapsed.panel.width === 0),
    JSON.stringify({ displayed: collapsed.panelDisplayed, panel: collapsed.panel })
  )
  report.check('collapsed-has-no-resize-handle', collapsed.resizeHandle === false, '收起态没有拖拽手柄')
  // 再点同一个按钮展开
  await ev(`(() => { document.querySelector('[data-right-dock-button]')?.click(); return 'ok' })()`)
  await sleep(450)
  const expanded = JSON.parse(await ev(SHAPE))
  report.check(
    'dock-button-expands-back-to-220',
    !!expanded.panel && expanded.panelDisplayed && expanded.panel.width === 220 && expanded.expanded === true,
    JSON.stringify({ panel: expanded.panel, expanded: expanded.expanded })
  )
  report.check(
    'expanded-button-reports-pressed',
    expanded.buttons.length === 1 && expanded.buttons[0].pressed === 'true',
    JSON.stringify(expanded.buttons)
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
  // 下限：面板宽 = innerWidth - clientX，要 160 就拖到 innerWidth - 160（不能写死 1290，
  // 那只在 1280 宽窗口成立；这台机器窗口 1784 宽）
  const minX = maxed.viewportWidth - 160
  await dragHandle(app, maxed.panel.left, 300, minX)
  const minned = JSON.parse(await ev(SHAPE))
  report.check('drag-clamps-at-min', minned.panel.width === 160, JSON.stringify(minned.panel))

  // ③d 切文档时大纲**不能再有进出场动画**（用户报障：右侧大纲切文档会闪、动画很乱）。
  //     机理：TransitionGroup 下所有行一起换 key ⇒ 旧行全离场、新行全入场，而 `.list-leave-active`
  //     没有脱离文档流 ⇒ 0.25s 内新旧两批同时占位（高度翻倍、互相撞），看起来就是闪+乱。
  //     判据取两条：① 切文档过程中**从不出现** `list-enter/leave` 类；② 行数**从不超过**新文档的标题数
  //     （有动画时旧行还在，行数会短暂超过）。
  const shapeA = ['# 甲一', '', '## 甲二', '', '### 甲三', ''].join('\n')
  const shapeB = ['# 乙一', '', '## 乙二', '', '### 乙三', '', '#### 乙四', '', '##### 乙五', ''].join('\n')
  await openDocWith(app, shapeA, 'outline-switch-a.md')
  await sleep(800)
  // 只数**右侧面板**里的行：左栏那份大纲在三栏模式下已不挂载，但选择器仍要限定作用域，
  // 否则以后再加一处大纲就会把这条断言带偏（实测第一版就是这么错的：数到了两套行）
  const panelItems = `[...document.querySelectorAll('[data-outline-panel] [data-outline-item]')]`
  const countA = await ev(`${panelItems}.length`)
  await ev(`(() => { window.__L.files().setContent(${JSON.stringify(shapeB)}, 'external'); return 'ok' })()`)
  // 切文档过程中高频采样：类名与行数
  const samples = JSON.parse(
    await ev(`(async () => {
      const out = []
      const t0 = performance.now()
      while (performance.now() - t0 < 600) {
        const items = ${panelItems}
        const anim = items.filter((el) => /list-(enter|leave)/.test(el.className)).length
        out.push({ n: items.length, anim })
        await new Promise((r) => requestAnimationFrame(r))
      }
      return JSON.stringify(out)
    })()`)
  )
  const maxN = Math.max(...samples.map((s) => s.n))
  const animSeen = samples.filter((s) => s.anim > 0).length
  report.note(
    `切文档采样 ${samples.length} 帧：甲=${countA} 行，最多 ${maxN} 行，带进出场类的帧 ${animSeen}`
  )
  report.check('doc-switch-has-no-enter-leave-class', animSeen === 0, `animSeen=${animSeen}`)
  report.check('doc-switch-never-overlaps-rows', maxN <= 5, `max=${maxN}（有动画时旧行会残留 ⇒ >5）`)

  // ③e 大纲里**不该出现语法标记**（用户报障：`### 林一鸣（**男主，21岁**）` 在目录里带着 `**`）。
  //     本编辑器的标记符是真实文本，所以行文字要按 mark 过滤（见 lib/editor/outlineText.ts）。
  const md = ['### 林一鸣（**男主，21岁，大四或刚毕业待业**）', '', '## 带 `code` 的标题', ''].join('\n')
  await openDocWith(app, md, 'outline-marker.md')
  await sleep(900)
  const labels = JSON.parse(
    await ev(`JSON.stringify([...document.querySelectorAll('[data-outline-panel] [data-outline-item]')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()))`)
  )
  report.note('带标记的标题 → ' + JSON.stringify(labels))
  report.check(
    'outline-strips-syntax-markers',
    labels.length === 2 && labels.every((x) => !x.includes('*') && !x.includes('`')),
    JSON.stringify(labels)
  )
  report.check(
    'outline-keeps-heading-text',
    labels[0] === '林一鸣（男主，21岁，大四或刚毕业待业）' && labels[1] === '带 code 的标题',
    JSON.stringify(labels)
  )

  // ④ 关掉设置 → 回到默认结构（页签回来、右侧面板消失）
  await ev(`(() => { window.__L.settings().set('outlineOnRight', false); return 'ok' })()`)
  await sleep(600)
  const back = JSON.parse(await ev(SHAPE))
  report.check(
    'turning-off-restores-tabs',
    back.sidebarTabs.join('/') === '文件/大纲' && back.panel === null && back.dockVisible === false,
    JSON.stringify({ tabs: back.sidebarTabs, panel: back.panel, dock: back.dockVisible })
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
