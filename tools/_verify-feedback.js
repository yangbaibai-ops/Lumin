'use strict'
// 验收：顶部栏「帮助 → 意见或 bug 反馈」（用户口径：渠道**可能有多个**，GitHub issue 地址给定）
//
// 为什么这个套件**自管实例**（端口 9236，避开运行器的 9222 与备份套件的 9234）：
//   ① 要断言"点了渠道 → IPC 的参数**就是配置里那个 URL**"，而真开一次会把用户默认浏览器
//      拉到前台（还会干扰焦点断言）——所以实例必须带 `LUMIN_OPEN_EXTERNAL_DRY_RUN=1`
//      （**仅开发态**生效：`!app.isPackaged` 才认这个变量，见 src/main/ipc.ts；
//      与 `src/main/testPaths.ts` 的 `LUMIN_EXPORT_DIR` 是同一套口径）；
//   ② 环境变量必须在**实例启动前**给到（跑起来之后再设没用）。
//
// 断言分组：
//   A 帮助里**存在**「意见或 bug 反馈」（子菜单行锚点 `data-menu-item="menu.feedback"`），三语文案非空（静态）
//   B 点它 → **出现渠道列表**（二级浮层），渠道与 `src/shared/feedback.ts` 的清单**逐条对账**
//     （少一条/多一条都红），模板里**没有**硬编码 URL
//   C 点「GitHub Issues」→ 主进程日志出现 `[links] openExternal dry-run <该 URL>`，
//     参数与配置里的 URL **逐字相同**，且因为 dry-run **真的没有**打开浏览器
//   D 协议白名单负例：`javascript:` / `file:` 走同一条通路必须被拒（`[links] refused … scheme=…`），
//     且**没有**对应的成功行
//   E 焦点：点完渠道后焦点**回到编辑面**（不在顶部栏），并且点击期间**没有一帧**画在顶部栏
const os = require('os')
const path = require('path')
const fs = require('fs')
const { connect, settle, sleep, startIsolated, Reporter, fatal, instanceLog } = require('./lib/harness')
/**
 * 渠道清单（唯一配置源）。**防御式 require**：这个套件会被拿去对"改前"的构建跑取证，
 * 那时 `src/shared/feedback.ts` 还不存在 —— 直接 require 会让"断言红"变成"套件崩"，
 * 那样就拿不到两份可比的红/绿输出。
 */
let FEEDBACK_CHANNELS = []
try {
  FEEDBACK_CHANNELS = require('../src/shared/feedback.ts').FEEDBACK_CHANNELS ?? []
} catch {
  FEEDBACK_CHANNELS = []
}

const PORT = 9236
const ROOT = path.resolve(__dirname, '..')
const UD = path.join(os.tmpdir(), 'lumin-feedback-ud')

/** 自管隔离实例：把 dry-run 变量在**启动前**交给 powershell（再经 Start-Process 传给 Electron） */
function isolated(cleanupOnly = false) {
  return startIsolated({
    userData: UD,
    port: PORT,
    env: { LUMIN_OPEN_EXTERNAL_DRY_RUN: '1' },
    cleanupOnly
  })
}

/** 读主进程日志（stdout；`instanceLog(userData)` 按 ps1 的同一条规则算路径） */
function readLog() {
  const p = instanceLog(UD)
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

async function click(app, x, y) {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** 元素中心点（不存在返回 null）；`scope` 可限定在某一层浮层里查（避免一二级同名锚点串味） */
async function centerOf(ev, selector, scope) {
  const raw = await ev(`(() => {
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'}
    if (!root) return null
    const el = root.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: (el.textContent || '').trim()
    })
  })()`)
  return raw ? JSON.parse(raw) : null
}

const FIRST_PANEL = '.topmenu-drop:not(.topmenu-sub)'
const SUB_PANEL = '.topmenu-sub'

/**
 * 点完渠道之后的两条焦点判据（与 `_verify-devtools.js` 的口径一致）：
 *   结束态：焦点**不在顶部栏**、且**回到编辑面**；
 *   逐帧：从点这一项起采样 `document.activeElement`，**没有任何一帧**落在顶部栏
 *        —— rAF 回调在绘制前跑，所以"某帧采样到顶部栏"≈"那一帧会画出焦点环"。
 */
async function checkFocusAfterClick(report, ev) {
  const focusNow = await ev(`(() => {
    const el = document.activeElement
    return JSON.stringify({
      tag: el ? el.tagName : null,
      inTopBar: !!(el && el.closest && el.closest('.topmenu-root')),
      group: el && el.getAttribute ? el.getAttribute('data-topmenu-group') : null,
      inEditor: !!(el && el.closest && el.closest('.ProseMirror'))
    })
  })()`).then(JSON.parse)
  const frames = await ev(`JSON.stringify(window.__fbframes || [])`).then(JSON.parse)
  const topFrames = frames.filter((f) => f.top).length
  console.log('E-FOCUS ' + JSON.stringify({ focusNow, frames: frames.length, topFrames }))
  report.check(
    'focus-not-in-topbar-after-feedback',
    focusNow.inTopBar === false && focusNow.group === null,
    '点完渠道后焦点落在顶部栏：' + JSON.stringify(focusNow)
  )
  report.check(
    'focus-returns-to-editor-after-feedback',
    focusNow.inEditor === true,
    '点完渠道后焦点应回编辑面：' + JSON.stringify(focusNow)
  )
  /**
   * 逐帧那条：`requestAnimationFrame` 只在**窗口真在渲染**时回调（被遮挡/最小化时一帧都没有）。
   * 一帧都没采到 ⇒ 这条判据没有对象，**如实 SKIP**（别把"窗口没在渲染"报成"焦点闪烁"）。
   * 采到帧时才是硬判据：任何一帧落在顶部栏都算"用户会看到焦点环闪一下"。
   */
  if (frames.length === 0) {
    report.skip(
      'no-painted-frame-with-topbar-focus',
      '这一轮一帧都没采到（窗口没在渲染：被遮挡/最小化），逐帧判据无对象'
    )
  } else {
    report.check(
      'no-painted-frame-with-topbar-focus',
      topFrames === 0,
      '点击期间有 ' + topFrames + ' 帧的焦点在顶部栏（共 ' + frames.length + ' 帧）'
    )
  }
}

async function main() {
  const report = new Reporter('反馈渠道：帮助 → 意见或 bug 反馈（配置一处、白名单、焦点）')

  // ── 静态：三语文案非空（渠道名是品牌名，三语同形是刻意的）────────────────────
  const keys = ['menu.feedback', ...FEEDBACK_CHANNELS.map((c) => c.labelKey)]
  const langValues = {}
  for (const lang of ['zh-CN', 'en-US', 'ru-RU']) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'i18n', `${lang}.json`), 'utf-8'))
    for (const key of keys) {
      const value = key.split('.').reduce((a, k) => (a == null ? a : a[k]), pack)
      langValues[`${lang}:${key}`] = typeof value === 'string' ? value : null
    }
  }
  console.log('A-I18N ' + JSON.stringify(langValues))
  report.check(
    'i18n-three-languages-non-empty',
    keys.every((k) => ['zh-CN', 'en-US', 'ru-RU'].every((l) => (langValues[`${l}:${k}`] || '').length > 0)),
    JSON.stringify(langValues)
  )
  // 模板里不许有 URL：渠道地址只放 shared/feedback.ts
  const menuBarSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'components', 'TopMenuBar.vue'),
    'utf-8'
  )
  report.check(
    'channels-come-from-shared-config',
    menuBarSrc.includes('FEEDBACK_CHANNELS') && !/https?:\/\//.test(menuBarSrc),
    'TopMenuBar.vue 必须从 shared/feedback.ts 取渠道（模板里不许出现 URL）'
  )
  report.check(
    'github-issues-url-is-the-one-user-gave',
    FEEDBACK_CHANNELS.some((c) => c.url === 'https://github.com/yangbaibai-ops/Lumin/issues'),
    '配置里的 GitHub 地址与用户给的不一致：' + JSON.stringify(FEEDBACK_CHANNELS.map((c) => c.url))
  )

  // ── 起实例 ────────────────────────────────────────────────────────────────
  isolated(true)
  const code = isolated(false)
  if (code !== 0) {
    report.skip('帮助里有「意见或 bug 反馈」', `隔离实例没起来（start-isolated.ps1 exit=${code}）`)
    return report.finish()
  }
  const app = await connect({ port: PORT })
  try {
    if (!(await settle(app.ev))) {
      report.skip('帮助里有「意见或 bug 反馈」', '页面没就绪')
      return report.finish()
    }
    const { ev } = app

    // ── A/B. 打开「帮助」→ 点「意见或 bug 反馈」→ 浮层里列出渠道 ──────────────
    const help = await centerOf(ev, '[data-topmenu-group="h"]')
    report.check('topmenu-has-help-group', !!help)
    if (help) await click(app, help.x, help.y)
    await sleep(350)

    const row = await centerOf(ev, '[data-menu-item="menu.feedback"]', FIRST_PANEL)
    console.log('A-FEEDBACK-ROW ' + JSON.stringify(row))
    report.check('help-menu-has-feedback-entry', !!row && row.text.length > 0, JSON.stringify(row))
    if (row) await click(app, row.x, row.y)
    await sleep(400)

    const listed = await ev(`(() => {
      const panel = document.querySelector(${JSON.stringify(SUB_PANEL)})
      if (!panel) return JSON.stringify({ open: false, items: [] })
      return JSON.stringify({
        open: true,
        header: (panel.querySelector('p') || { textContent: '' }).textContent.trim(),
        items: [...panel.querySelectorAll('[data-menu-item]')].map((x) => x.getAttribute('data-menu-item'))
      })
    })()`).then(JSON.parse)
    console.log('B-SUBMENU ' + JSON.stringify(listed))
    report.check('feedback-opens-channel-list', listed.open === true, JSON.stringify(listed))
    // 与配置**逐条对账**：清单里的渠道 = 浮层里的项（少一条/多一条都红）
    report.check(
      'channel-list-matches-shared-config',
      JSON.stringify(listed.items) === JSON.stringify(FEEDBACK_CHANNELS.map((c) => c.labelKey)),
      '浮层里的项与 shared/feedback.ts 不一致：' + JSON.stringify({ ui: listed.items, config: FEEDBACK_CHANNELS.map((c) => c.labelKey) })
    )

    // ── C. 点「GitHub Issues」→ dry-run 的 openExternal，参数逐字相同 ───────────
    const logBefore = readLog().length
    // 焦点逐帧采样：从点这一项开始（点「帮助」那一帧是用户自己点的菜单触发器，不算）
    // 先把窗口提到最前：`requestAnimationFrame` 只在窗口**真在渲染**时回调，被别的窗口盖住时
    // 一帧都不来（同机并发跑别的套件/应用时很容易发生），那样这条判据就没对象了。
    try {
      await app.send('Page.bringToFront')
      await sleep(200)
    } catch {
      /* 拿不到就算了：下面按"采到几帧"决定是硬判还是如实 SKIP */
    }
    await ev(`(() => {
      window.__fbframes = []
      const d = (el) => ({ top: !!(el && el.closest && el.closest('.topmenu-root')), ed: !!(el && el.closest && el.closest('.ProseMirror')), text: el ? String(el.textContent || '').trim().slice(0, 10) : '' })
      const tick = () => { window.__fbframes.push(d(document.activeElement)); window.__fbRaf = requestAnimationFrame(tick) }
      window.__fbRaf = requestAnimationFrame(tick)
      return 'ok'
    })()`)
    /**
     * ⚠️ 防御：`FEEDBACK_CHANNELS` 在"改前"的构建里是空的（配置还不存在）。
     * 那时后面的"点渠道"前提不成立 —— 如实 SKIP，别让套件崩（崩了就只剩一句 ERROR，
     * 拿不到可比的红/绿输出）。
     */
    const firstChannel = FEEDBACK_CHANNELS[0] ?? null
    if (!firstChannel) {
      report.skip('channel-item-clickable', '配置里没有渠道（改前的构建就是这样）')
      for (const name of [
        'github-issues-calls-open-external-with-exact-url',
        'dry-run-means-no-browser-was-opened',
        'focus-not-in-topbar-after-feedback',
        'focus-returns-to-editor-after-feedback',
        'no-painted-frame-with-topbar-focus'
      ]) {
        report.skip(name, '配置里没有渠道')
      }
    } else {
      const item = await centerOf(ev, `[data-menu-item="${firstChannel.labelKey}"]`, SUB_PANEL)
      report.check('channel-item-clickable', !!item, JSON.stringify(item))
      if (item) await click(app, item.x, item.y)
      await sleep(800)

      const logTail = readLog().slice(logBefore)
      const openedLines = logTail
        .split('\n')
        .filter((l) => l.includes('[links] openExternal'))
        .map((l) => l.trim())
      console.log(
        'C-OPEN-EXTERNAL ' + JSON.stringify({ lines: openedLines, expected: firstChannel.url })
      )
      report.check(
        'github-issues-calls-open-external-with-exact-url',
        openedLines.some((l) => l.endsWith(firstChannel.url)),
        '日志里没有"参数就是那个 URL"的行：' + JSON.stringify(openedLines)
      )
      report.check(
        'dry-run-means-no-browser-was-opened',
        openedLines.length > 0 && openedLines.every((l) => l.includes('dry-run')),
        '这一轮应当全是 dry-run（不真的开浏览器）：' + JSON.stringify(openedLines)
      )
      await checkFocusAfterClick(report, ev)
    }

    // ── D. 协议白名单负例：走同一条通路，`javascript:` / `file:` 必须被拒 ────────
    const beforeBad = readLog().length
    await ev(`(() => { window.luminAPI.shell.openExternal('javascript:alert(1)'); return 'sent1' })()`)
    await ev(`(() => { window.luminAPI.shell.openExternal('file:///C:/Windows/System32/calc.exe'); return 'sent2' })()`)
    await sleep(600)
    const badTail = readLog().slice(beforeBad)
    const refused = badTail
      .split('\n')
      .filter((l) => l.includes('[links] refused openExternal'))
      .map((l) => l.trim())
    const badOpened = badTail.split('\n').filter((l) => l.includes('[links] openExternal'))
    console.log('D-WHITELIST ' + JSON.stringify({ refused, opened: badOpened }))
    report.check(
      'whitelist-refuses-javascript',
      refused.some((l) => l.includes('scheme=javascript:')),
      JSON.stringify(refused)
    )
    report.check(
      'whitelist-refuses-file',
      refused.some((l) => l.includes('scheme=file:')),
      JSON.stringify(refused)
    )
    report.check(
      'refused-urls-are-never-passed-to-shell',
      badOpened.length === 0,
      '被拒的 URL 竟然也走了 openExternal 成功分支：' + JSON.stringify(badOpened)
    )
  } finally {
    app.close()
    isolated(true)
  }
  return report.finish()
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch(fatal)
