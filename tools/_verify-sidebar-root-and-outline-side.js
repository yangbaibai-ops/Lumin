'use strict'
// 验收：侧栏「顶层文件夹」改造 + 「大纲位置」的工具栏/视图菜单入口 + 底部工具带的悬停动效
//
// 三件事写在一支套件里，因为它们量的是**同一块界面**（侧栏头部 + 树顶 + 底部工具带 +
// 视图区），夹具与前置状态完全一样 —— 拆成三支只会让运行器多起两次隔离实例。
//
// 用户口径（本轮）：
//   ① 侧栏上方显示文件夹名称的那块区域：「最近打开的文档」「新建文档」取消、
//      文件夹名显示也取消，改为**目录树结构的顶层文件夹**（极简式）；
//   ② 大纲放在编辑器左侧/右侧，也要出现在顶部工具栏的视图工具里；
//   ③ 侧栏下方的搜索与视图切换，鼠标放上去/拿开时要有出现与消失的动效。
//
// 断言口径（为什么这么挑）：
//   * ① 不能只验"头部那行没了" —— 那用一个空白 div 顶掉也能过。要点在**文件夹成了树的一行**：
//     `data-tree-root-row` 那一行的 path = 工作区根、depth 0 / aria-level 1、默认展开，
//     它的子级整体下沉一级（depth 1 / aria-level 2 / data-tree-parent = 根路径）；
//     并且这一行**不能**出现重命名/删除/拖动（删掉它 = 删掉整个工作区）。
//   * ② 两个入口都验：工具栏那枚开关（鼠标路径）与「视图」菜单里同名的那一项
//     （菜单项文案与开关 title 是同一个 i18n 键，因此用"文案相等"来找它，不写死中文）；
//     再验"点完界面真的换了地方"（右侧大纲面板出现/消失 + 左栏页签跟着走）。
//   * ③ 动效的**要害是"消失"也有过渡**：旧实现里 `visibility` 立刻翻成 hidden，
//     淡出被掐掉（进去柔和、出来生硬）。所以既验过渡属性的时长/延迟，也验真实悬停
//     与移开后的可见性，两条一起才说明"出现与消失都有动效"。
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  connect,
  settle,
  sleep,
  openDocWith,
  waitEditor,
  showToolbar,
  bringToFront,
  clickSelector,
  centerOf,
  framesAlive,
  Reporter,
  fatal
} = require('./lib/harness')

/** 底部工具带的状态 + 它的过渡参数（隐藏态与显示态都要读） */
const STRIP = `(() => {
  const el = document.querySelector('[data-sidebar-filetools]')
  if (!el) return JSON.stringify({ found: false })
  const cs = getComputedStyle(el)
  const aside = document.querySelector('aside')
  const active = document.activeElement
  return JSON.stringify({
    found: true,
    opacity: cs.opacity,
    visibility: cs.visibility,
    transform: cs.transform,
    props: cs.transitionProperty,
    durations: cs.transitionDuration,
    delays: cs.transitionDelay,
    hasSearch: !!el.querySelector('[data-sidebar-search]'),
    hasViewSwitch: !!el.querySelector('.seg'),
    hasRefresh: !!el.querySelector('[data-sidebar-refresh]'),
    pinned: el.classList.contains('filetools--pinned'),
    asideHover: !!aside && aside.matches(':hover'),
    focusInAside: !!active && !!aside && aside.contains(active),
    activeTag: active ? active.tagName : null
  })
})()`

/** 把鼠标移到某个选择器的中心（真实输入事件：:hover 才会生效） */
async function hoverSelector(app, sel) {
  const box = await centerOf(app.ev, sel)
  if (!box) return false
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
    button: 'none'
  })
  return true
}

/** 侧栏头部与树顶那一行的快照 */
const SIDEBAR = `(() => {
  const aside = document.querySelector('aside')
  const rootRow = document.querySelector('[data-tree-row][data-tree-root-row="true"]')
  const label = rootRow ? rootRow.querySelector('.tree-label') : null
  const rows = [...document.querySelectorAll('[data-tree-row]')]
  const kids = rows.filter((r) => r !== rootRow && r.getAttribute('data-tree-parent') === (rootRow ? rootRow.getAttribute('data-tree-path') : null))
  return JSON.stringify({
    hasAside: !!aside,
    headerWorkspaceBtn: !!document.querySelector('[data-sidebar-workspace]'),
    headerOpenFolderBtn: !!document.querySelector('[data-sidebar-open-folder]'),
    // 头部那一行整体没了 ⇒ 侧栏里**第一个可点的东西**就是页签按钮
    firstButtonIsTab: !!aside && !!aside.querySelector('button')?.hasAttribute('data-sidebar-tab'),
    rootFound: !!rootRow,
    rootPath: rootRow ? rootRow.getAttribute('data-tree-path') : null,
    rootLabel: label ? label.textContent.trim() : null,
    rootDepth: rootRow ? rootRow.getAttribute('data-depth') : null,
    rootLevel: rootRow ? rootRow.getAttribute('aria-level') : null,
    rootType: rootRow ? rootRow.getAttribute('data-tree-type') : null,
    rootExpanded: rootRow ? rootRow.getAttribute('aria-expanded') : null,
    rootDraggable: rootRow ? rootRow.getAttribute('draggable') : null,
    rootIsCurrent: rootRow ? rootRow.getAttribute('data-tree-current') : null,
    rootIsFirstRow: rows[0] === rootRow,
    childCount: kids.length,
    childDepths: kids.map((r) => r.getAttribute('data-depth')),
    childLevels: kids.map((r) => r.getAttribute('aria-level'))
  })
})()`

async function main() {
  const app = await connect()
  const { ev, send } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('侧栏顶层文件夹 / 大纲位置入口 / 底部工具带动效')

  // ── 夹具：一个真实工作区（两个文件 + 一个子目录），根名固定便于断言 ──
  const root = path.join(os.tmpdir(), 'lumin-sidebar-root-ws')
  const rootName = path.basename(root)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'alpha.md'), '# alpha\n\n正文\n', 'utf-8')
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide\n\n正文\n', 'utf-8')

  try {
    await ev(`(async () => {
      const f = window.__L.files()
      await f.setRoot(${JSON.stringify(root)})
      const ui = window.__L.ui()
      ui.sidebarVisible = true
      ui.sidebarTab = 'files'
      ui.sidebarFilesView = 'tree'
      window.__L.settings().set('outlineOnRight', false)
      return 'ok'
    })()`)
    await openDocWith(app, '# 标题\n\n正文\n', 'sidebar-root.md')
    if (!(await waitEditor(ev))) throw new Error('编辑器未就绪')
    await showToolbar(app)
    await sleep(1200)

    // ── ① 侧栏头部：文件夹名 / 最近文档 / 新建文件整行消失 ────────────────
    const head = JSON.parse(await ev(SIDEBAR))
    report.note('sidebar ' + JSON.stringify(head))
    report.check(
      'no-workspace-name-row-in-sidebar',
      head.hasAside === true && head.headerWorkspaceBtn === false,
      `[data-sidebar-workspace] 还在吗 = ${head.headerWorkspaceBtn}（用户口径：文件夹名不再占头部一行）`
    )
    report.check(
      'sidebar-starts-at-the-tab-row',
      head.firstButtonIsTab === true,
      `侧栏里第一个按钮就是页签 = ${head.firstButtonIsTab}（头部那一行「文件夹名 + 最近 + 新建」已整行不存在）`
    )
    report.check(
      'no-open-folder-entry-while-workspace-open',
      head.headerOpenFolderBtn === false,
      `有工作区时头部「打开文件夹」= ${head.headerOpenFolderBtn}（§4.84 起这一枚在整个侧栏里都不存在了）`
    )

    // ── ① 文件夹成了树的顶层节点（极简式）─────────────────────────────
    report.check(
      'root-folder-is-first-tree-row',
      head.rootFound === true && head.rootIsFirstRow === true,
      `顶层行在第一行 = ${head.rootIsFirstRow}`
    )
    report.check(
      'root-row-is-the-workspace-folder',
      head.rootPath === root && head.rootLabel === rootName && head.rootType === 'directory',
      `path=${head.rootPath} / label=${head.rootLabel} / type=${head.rootType}（期望路径 ${root}、名字 ${rootName}）`
    )
    report.check(
      'root-row-expanded-by-default',
      head.rootDepth === '0' && head.rootLevel === '1' && head.rootExpanded === 'true',
      `depth=${head.rootDepth} / aria-level=${head.rootLevel} / aria-expanded=${head.rootExpanded}（首屏不该是一棵空树）`
    )
    report.check(
      'children-sink-one-level-under-root',
      head.childCount === 2 &&
        head.childDepths.every((d) => d === '1') &&
        head.childLevels.every((l) => l === '2'),
      `子行数=${head.childCount} / depths=${JSON.stringify(head.childDepths)} / levels=${JSON.stringify(head.childLevels)}`
    )
    report.check(
      'root-row-is-not-a-normal-entry',
      head.rootDraggable === 'false' && head.rootIsCurrent === null,
      `draggable=${head.rootDraggable} / data-tree-current=${head.rootIsCurrent}（不可拖动、也不是"当前文档"那一行）`
    )

    // 根那一行的右键菜单：只有「根菜单」，没有重命名/删除（删掉它=删掉整个工作区）
    await ev(`(() => {
      const r = document.querySelector('[data-tree-row][data-tree-root-row="true"]')
      const b = r.getBoundingClientRect()
      r.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(b.left + 40), clientY: Math.round(b.top + b.height / 2)
      }))
      return 'ok'
    })()`)
    await sleep(450)
    const rootMenu = JSON.parse(
      await ev(`(() => {
        const panel = document.querySelector('[role="menu"]:not([data-context-submenu])')
        if (!panel) return JSON.stringify({ open: false })
        return JSON.stringify({
          open: true,
          items: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim()),
          aria: panel.getAttribute('aria-label') || ''
        })
      })()`)
    )
    report.note('root menu ' + JSON.stringify(rootMenu))
    report.check(
      'root-row-menu-offers-create-and-refresh',
      rootMenu.open === true && rootMenu.items.length === 4,
      `菜单项=${JSON.stringify(rootMenu.items)}（期望 新建文件 / 新建文件夹 / 刷新 / 关闭工作区）`
    )
    report.check(
      'root-row-menu-has-no-destructive-entry',
      rootMenu.open === true &&
        !rootMenu.items.some((s) => /重命名|删除|Rename|Delete|Переименовать|Удалить/.test(s)),
      `菜单项=${JSON.stringify(rootMenu.items)}（顶层文件夹不能被改名/删除）`
    )
    report.check(
      'root-row-menu-named-by-path',
      typeof rootMenu.aria === 'string' && rootMenu.aria.includes(rootName),
      `aria-label=${rootMenu.aria}`
    )
    await ev(`(() => { window.__L.ui().closeContextMenu(); return 'ok' })()`)
    await sleep(400)
    // 这里**不注入真实按键**（不用 Esc 去关那个右键菜单）：窗口被遮挡时 Vue 的离场过渡等不到
    // transitionend，菜单元素可能留在 DOM 里（"不出帧"的环境现象，与产品无关）——那不构成失败，
    // 后面的断言一律用 `.topmenu-drop` 精确选择，不受它影响。于是本套件不需要焦点守卫。
    report.note(
      'menus in DOM after close: ' +
        (await ev(`(() => document.querySelectorAll('[role="menu"]').length)()`))
    )

    // ── ③ 底部工具带：内容 + 悬停动效 ────────────────────────────────────
    await bringToFront(app)
    const editorBox = await centerOf(ev, '.ProseMirror')
    if (editorBox) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: editorBox.x,
        y: editorBox.y,
        button: 'none'
      })
    }
    await sleep(600)
    const idle = JSON.parse(await ev(STRIP))
    report.note('strip idle ' + JSON.stringify(idle))
    report.check(
      'toolstrip-is-hidden-when-mouse-away',
      idle.found === true && idle.opacity === '0' && idle.visibility === 'hidden',
      `opacity=${idle.opacity} / visibility=${idle.visibility}`
    )
    report.check(
      'toolstrip-carries-search-and-view-switch',
      idle.hasSearch === true && idle.hasViewSwitch === true,
      `搜索=${idle.hasSearch} / 视图切换=${idle.hasViewSwitch}`
    )
    // 「消失也有动效」的关键：visibility 必须**延迟**翻，否则淡出会被掐掉
    const dur = (s) => s.split(',').map((x) => parseFloat(x) || 0)
    const props = idle.props.split(',').map((s) => s.trim())
    const visIdx = props.indexOf('visibility')
    report.check(
      'toolstrip-transitions-opacity-and-transform',
      props.includes('opacity') &&
        props.includes('transform') &&
        dur(idle.durations).some((d) => d > 0),
      `property=${idle.props} / duration=${idle.durations}`
    )
    report.check(
      'toolstrip-visibility-delayed-so-fade-out-plays',
      visIdx >= 0 && parseFloat(idle.delays.split(',')[visIdx] || '0') >= 0.1,
      `transition-delay=${idle.delays}（visibility 的那一段必须 > 0，否则"拿开鼠标"是瞬间消失）`
    )

    const hovered = await hoverSelector(app, 'aside [data-tree-row]')
    await sleep(500)
    const shown = JSON.parse(await ev(STRIP))
    report.note('strip hover ' + JSON.stringify(shown))
    report.check(
      'toolstrip-appears-on-sidebar-hover',
      hovered === true && shown.opacity === '1' && shown.visibility === 'visible',
      `hover=${hovered} / opacity=${shown.opacity} / visibility=${shown.visibility}`
    )
    report.check(
      'toolstrip-slides-to-rest-position',
      shown.transform === 'none' || shown.transform === 'matrix(1, 0, 0, 1, 0, 0)',
      `transform=${shown.transform}（出现后应回到静止位，位移只在过渡中出现）`
    )

    // 列表视图才有「刷新」（它跟着从侧栏头部搬到了这条工具带）
    await ev(`(() => { window.__L.ui().sidebarFilesView = 'list'; return 'ok' })()`)
    await sleep(500)
    const inList = JSON.parse(await ev(STRIP))
    report.check(
      'refresh-button-lives-in-toolstrip-list-view-only',
      inList.hasRefresh === true,
      `列表视图下工具带里有刷新 = ${inList.hasRefresh}`
    )
    await ev(`(() => { window.__L.ui().sidebarFilesView = 'tree'; return 'ok' })()`)
    await sleep(400)
    const inTree = JSON.parse(await ev(STRIP))
    report.check(
      'refresh-button-hidden-in-tree-view',
      inTree.hasRefresh === false,
      `树视图下刷新 = ${inTree.hasRefresh}（树由 fs.watch 自更新，不需要它）`
    )

    // 移开鼠标：先到窗口右下角（一定在侧栏之外），再到编辑区中心 —— 只发一次
    // mouseMoved 在"上一次落点恰好也在侧栏里"时偶尔不翻转 :hover，两步走更稳。
    report.note('editorBox ' + JSON.stringify(editorBox))
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8,
      button: 'none'
    })
    if (editorBox) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: editorBox.x,
        y: editorBox.y,
        button: 'none'
      })
    }
    // 淡出本身要 0.18s（+ visibility 延迟 0.18s），这里给足时间并轮询
    let away = JSON.parse(await ev(STRIP))
    for (let i = 0; i < 12 && !(away.opacity === '0' && away.visibility === 'hidden'); i++) {
      await sleep(120)
      away = JSON.parse(await ev(STRIP))
    }
    report.note('strip away ' + JSON.stringify(away))
    report.check(
      'toolstrip-hides-again-when-mouse-leaves',
      away.opacity === '0' && away.visibility === 'hidden',
      `opacity=${away.opacity} / visibility=${away.visibility} / asideHover=${away.asideHover}`
    )

    // ── ② 大纲位置：工具栏视图区那一枚开关 ───────────────────────────────
    const sideBtn = JSON.parse(
      await ev(`(() => {
        const b = document.querySelector('[data-outline-side]')
        if (!b) return JSON.stringify({ found: false })
        const toolbar = document.querySelector('[data-editor-toolbar]')
        return JSON.stringify({
          found: true,
          inToolbar: !!toolbar && toolbar.contains(b),
          pressed: b.getAttribute('aria-pressed'),
          title: b.title || '',
          label: b.getAttribute('aria-label') || ''
        })
      })()`)
    )
    report.note('outline-side button ' + JSON.stringify(sideBtn))
    report.check(
      'outline-side-toggle-sits-in-toolbar',
      sideBtn.found === true && sideBtn.inToolbar === true,
      `找到=${sideBtn.found} / 在快捷工具栏里=${sideBtn.inToolbar}`
    )
    report.check(
      'outline-side-toggle-starts-pressed-false',
      sideBtn.pressed === 'false' && sideBtn.title.length > 0 && sideBtn.title === sideBtn.label,
      `aria-pressed=${sideBtn.pressed} / title=${sideBtn.title} / aria-label=${sideBtn.label}`
    )

    const clicked = await clickSelector(send, ev, '[data-outline-side]')
    await sleep(900)
    const onRight = JSON.parse(
      await ev(`(() => {
        const b = document.querySelector('[data-outline-side]')
        return JSON.stringify({
          setting: window.__L.settings().outlineOnRight,
          expanded: window.__L.settings().outlineRightExpanded,
          panel: !!document.querySelector('[data-outline-panel]'),
          tab: window.__L.ui().sidebarTab,
          pressed: b ? b.getAttribute('aria-pressed') : null,
          title: b ? b.title : null
        })
      })()`)
    )
    report.note('after click ' + JSON.stringify(onRight))
    report.check(
      'toolbar-toggle-moves-outline-to-the-right',
      clicked === true &&
        onRight.setting === true &&
        onRight.panel === true &&
        onRight.expanded === true,
      `点到按钮=${clicked} / outlineOnRight=${onRight.setting} / 右侧面板=${onRight.panel} / 展开=${onRight.expanded}`
    )
    report.check(
      'toolbar-toggle-keeps-sidebar-on-files-tab',
      onRight.tab === 'files',
      `左栏页签=${onRight.tab}（三栏模式下左栏只承担文件树）`
    )
    report.check(
      'toolbar-toggle-flips-pressed-and-title',
      onRight.pressed === 'true' && onRight.title !== sideBtn.title,
      `aria-pressed=${onRight.pressed} / title=${onRight.title}（文案说的是**下一步**）`
    )

    // 关掉：大纲回左栏，左栏页签**恢复成打开前那一页**（第十轮用户口径）。
    // 这一段开始前页签是「文件」（本套件一开始就设成 files），所以搬回来之后仍应是「文件」。
    await clickSelector(send, ev, '[data-outline-side]')
    await sleep(900)
    const backLeft = JSON.parse(
      await ev(`(() => JSON.stringify({
        setting: window.__L.settings().outlineOnRight,
        panel: !!document.querySelector('[data-outline-panel]'),
        tab: window.__L.ui().sidebarTab,
        remember: window.__L.ui().sidebarTabBeforeOutlineRight,
        outlineRows: document.querySelectorAll('[data-outline-item]').length
      }))()`)
    )
    report.note('after second click ' + JSON.stringify(backLeft))
    report.check(
      'toggle-back-restores-the-files-tab',
      backLeft.setting === false && backLeft.panel === false && backLeft.tab === 'files',
      `outlineOnRight=${backLeft.setting} / 右侧面板=${backLeft.panel} / 左栏页签=${backLeft.tab}（打开前是「文件」⇒ 搬回来还是「文件」）`
    )
    report.check(
      'toggle-back-consumes-the-remembered-tab',
      backLeft.remember === null,
      `记忆用掉即清空（还留着的话下一次"打开前"的判断会被上一次污染）：${JSON.stringify(backLeft.remember)}`
    )

    // 另一个方向：打开前停在「大纲」⇒ 搬回来仍是「大纲」
    await ev(`(() => { window.__L.ui().sidebarTab = 'outline'; return 'ok' })()`)
    await sleep(400)
    await clickSelector(send, ev, '[data-outline-side]')
    await sleep(900)
    const remembered = await ev(`window.__L.ui().sidebarTabBeforeOutlineRight`)
    await clickSelector(send, ev, '[data-outline-side]')
    await sleep(900)
    const backOutline = JSON.parse(
      await ev(`(() => JSON.stringify({
        setting: window.__L.settings().outlineOnRight,
        tab: window.__L.ui().sidebarTab,
        remember: window.__L.ui().sidebarTabBeforeOutlineRight,
        outlineRows: document.querySelectorAll('[data-outline-item]').length
      }))()`)
    )
    report.note('outline-tab round ' + JSON.stringify({ remembered, ...backOutline }))
    report.check(
      'toggle-back-restores-the-outline-tab',
      remembered === 'outline' && backOutline.setting === false && backOutline.tab === 'outline',
      `打开时记下=${remembered} / 搬回来=${backOutline.tab}（打开前是「大纲」⇒ 搬回来还是「大纲」）`
    )

    // ── ② 同一个开关也在「视图」菜单里（文案与开关 title 同源，用相等来找它）──
    await ev(`(() => { window.__L.ui().sidebarTab = 'files'; return 'ok' })()`)
    await sleep(300)
    const menuLabel = await ev(
      `(() => { const b = document.querySelector('[data-outline-side]'); return b ? b.title : null })()`
    )
    const menuClicked = await ev(`(() => {
      const btn = document.querySelector('[data-topmenu-group="v"]')
      if (!btn) return 'no-menu-button'
      btn.click()
      return 'ok'
    })()`)
    await sleep(500)
    const menuHit = JSON.parse(
      await ev(`(() => {
        const panel = document.querySelector('.topmenu-drop:not(.topmenu-sub)')
        if (!panel) return JSON.stringify({ found: false, panels: [] })
        const items = [...panel.querySelectorAll('button')]
        const hit = items.find((el) => el.textContent.trim() === ${JSON.stringify(menuLabel)})
        if (!hit) {
          return JSON.stringify({ found: false, labels: items.map((el) => el.textContent.trim()) })
        }
        hit.click()
        return JSON.stringify({ found: true })
      })()`)
    )
    await sleep(900)
    const menuResult = JSON.parse(
      await ev(`(() => JSON.stringify({
        setting: window.__L.settings().outlineOnRight,
        panel: !!document.querySelector('[data-outline-panel]')
      }))()`)
    )
    report.note(
      'view menu ' +
        menuClicked +
        ' ' +
        JSON.stringify(menuHit) +
        ' → ' +
        JSON.stringify(menuResult)
    )
    report.check(
      'view-menu-carries-the-same-outline-entry',
      menuClicked === 'ok' && menuHit.found === true,
      `菜单里找到文案为「${menuLabel}」的那一项 = ${menuHit.found}${menuHit.found ? '' : ' / 实际项：' + JSON.stringify(menuHit.labels)}`
    )
    report.check(
      'view-menu-entry-does-the-same-thing',
      menuResult.setting === true && menuResult.panel === true,
      `outlineOnRight=${menuResult.setting} / 右侧面板=${menuResult.panel}`
    )

    // ── ④ 搜索时顶层节点自动展开（顶层可收起是新增状态，别让搜索"一行都没有"）──
    // 先把 docs 也展开：这样筛选生效时能同时验「命中的留下」与「不命中的（guide.md）消失」
    await ev(`(async () => {
      const f = window.__L.files()
      if (!f.expanded.has(${JSON.stringify(path.join(root, 'docs'))})) {
        await f.toggleDir(${JSON.stringify(path.join(root, 'docs'))})
      }
      return 'ok'
    })()`)
    await sleep(700)
    const beforeFilter = await ev(`document.querySelectorAll('[data-tree-row]').length`)
    await ev(`(() => {
      const f = window.__L.files()
      f.expanded.delete(f.root)   // 手动收起工作区顶层节点
      window.__L.ui().sidebarTab = 'files'
      window.__L.ui().sidebarFilesView = 'tree'
      return 'ok'
    })()`)
    await sleep(600)
    // 出帧与否决定"子行会不会立刻从 DOM 里消失"（见下面那条断言的说明）
    const framesAliveNow = await framesAlive(app)
    const collapsed = JSON.parse(
      await ev(`(() => {
        const r = document.querySelector('[data-tree-row][data-tree-root-row="true"]')
        return JSON.stringify({
          expanded: r ? r.getAttribute('aria-expanded') : null,
          rows: document.querySelectorAll('[data-tree-row]').length
        })
      })()`)
    )
    report.check(
      'root-row-can-collapse',
      // ⚠️ 子行是包在 `<Transition name="tree">` 里的：窗口被遮挡时 Chromium 不出帧，
      // 离场过渡走不完 ⇒ 子行会**留在 DOM 里**（行数不回到 1）。那是环境现象（工具 README 里的
      // "被遮挡时不出帧"），不是产品缺陷 —— 所以语义判据（store + aria-expanded）必须成立，
      // 行数只在**确实在出帧**时才要求回到 1。
      beforeFilter >= 3 &&
        collapsed.expanded === 'false' &&
        (collapsed.rows === 1 || !framesAliveNow),
      `展开时行数=${beforeFilter} / 收起后 aria-expanded=${collapsed.expanded}、行数=${collapsed.rows}` +
        `（出帧=${framesAliveNow}；不出帧时离场过渡可能没走完）`
    )

    // 打开侧栏搜索并写入筛选词（合成 input 事件：控制台里改值 + 派发，不注入真实按键）
    await ev(`(() => { window.__L.ui().requestSidebarSearch(); return 'ok' })()`)
    await sleep(700)
    const typed = await ev(`(() => {
      const input = document.querySelector('.file-search__input')
      if (!input) return 'no-input'
      input.value = 'alpha'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    await sleep(700)
    const filtering = JSON.parse(
      await ev(`(() => {
        const r = document.querySelector('[data-tree-row][data-tree-root-row="true"]')
        const paths = [...document.querySelectorAll('[data-tree-row]')].map((x) => x.getAttribute('data-tree-path'))
        return JSON.stringify({
          expanded: r ? r.getAttribute('aria-expanded') : null,
          paths
        })
      })()`)
    )
    report.note('filter ' + typed + ' ' + JSON.stringify(filtering))
    report.check(
      'search-re-expands-the-collapsed-root',
      typed === 'ok' && filtering.expanded === 'true',
      `输入筛选词后顶层 aria-expanded=${filtering.expanded}（收起状态下搜索必须自动展开，否则看着像"什么都没搜到"）`
    )
    report.check(
      'search-results-are-visible-again',
      filtering.paths.some((p) => String(p).endsWith('alpha.md')) &&
        !filtering.paths.some((p) => String(p).endsWith('guide.md')),
      JSON.stringify(filtering.paths)
    )
    await ev(`(() => {
      const input = document.querySelector('.file-search__input')
      if (input) {
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.blur()
      }
      return 'ok'
    })()`)
    await sleep(500)

    // ── ⑩ 没有工作区时：侧栏里**一个按钮、一句提示都没有**（用户口径 §4.84）──────────
    // 两批东西先后下线：① 空态那三枚图标按钮 + `open.hint` 提示；
    // ② 侧栏头部「打开文件夹」那一小行（只在没有工作区时出现）；
    // ③ 首次引导块（标题 + 说明 + 新建文件 / 打开文件夹 / 插入示例 + 示例说明）。
    // 现在剩下的只有「文件 / 大纲」页签 —— 空着就是空着。
    await ev(`(async () => {
      const ui = window.__L.ui()
      ui.sidebarVisible = true
      ui.sidebarTab = 'files'
      window.__L.settings().set('outlineOnRight', false)
      await window.__L.files().setRoot(null)
      return 'ok'
    })()`)
    await sleep(800)
    const emptySidebar = JSON.parse(
      await ev(`(() => {
        const aside = document.querySelector('aside')
        const files = document.querySelector('[data-sidebar-files]')
        const btns = aside ? [...aside.querySelectorAll('button')] : []
        // 只数**真的看得见**的按钮：大纲面板是 v-show 常驻 DOM 的（切页签不卸载），
        // 它藏在下面时里面的按钮照样在 DOM 里 —— 那不是"侧栏上显示了一个按钮"。
        // （这段在模板字符串里，注释中不能出现反引号。）
        const visible = btns.filter((b) => b.getClientRects().length > 0)
        const tabBtns = visible.filter((b) => b.hasAttribute('data-sidebar-tab'))
        const otherBtns = visible.filter((b) => !b.hasAttribute('data-sidebar-tab'))
        // 「文件区」= 侧栏里页签以下的整块（FileTree 的根容器）
        const filesText = files ? (files.innerText || '').replace(/\\s+/g, ' ').trim() : ''
        const filesBtns = files ? files.querySelectorAll('button').length : -1
        return JSON.stringify({
          openFolderEntry: !!document.querySelector('[data-sidebar-open-folder]'),
          tabCount: tabBtns.length,
          otherButtonCount: otherBtns.length,
          otherButtons: otherBtns.map((b) => (b.title || b.textContent || '').trim().slice(0, 24)),
          filesText,
          filesBtns
        })
      })()`)
    )
    report.note('empty sidebar ' + JSON.stringify(emptySidebar))
    report.check(
      'no-open-folder-row-when-no-workspace',
      emptySidebar.openFolderEntry === false,
      `没有工作区时侧栏顶部不再有「打开文件夹」那一行（入口仍在「文件」菜单 / Ctrl+O）`
    )
    report.check(
      'no-workspace-sidebar-has-only-tabs',
      emptySidebar.tabCount === 2 && emptySidebar.otherButtonCount === 0,
      `页签 ${emptySidebar.tabCount} 个 / 其它按钮 ${emptySidebar.otherButtonCount} 个 ${JSON.stringify(emptySidebar.otherButtons)}`
    )
    report.check(
      'no-workspace-file-area-is-empty',
      emptySidebar.filesBtns === 0 && emptySidebar.filesText === '',
      `文件区按钮 ${emptySidebar.filesBtns} 个、文字 ${JSON.stringify(emptySidebar.filesText)}（首次引导块也已下线）`
    )

    // 收尾：把位置与视图恢复原样（隔离实例的下一个套件会复用进程）
    await ev(`(() => {
      window.__L.settings().set('outlineOnRight', false)
      window.__L.ui().sidebarTab = 'files'
      window.__L.ui().sidebarFilesView = 'tree'
      window.__L.ui().closeContextMenu()
      return 'ok'
    })()`)
    await sleep(400)
  } finally {
    await ev(
      `(async () => { await window.__L.files().close(); await window.__L.files().setRoot(null); return 'ok' })()`
    ).catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }

  app.close()
  process.exit(report.finish())
}

main().catch((e) => fatal(e))
