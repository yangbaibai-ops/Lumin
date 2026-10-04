// 验收：去掉欢迎页、能力重排到「侧栏空态 / 工具栏打开按钮 / 文件菜单」
//
// 覆盖：
//  A. 无会话启动：落在编辑器 + 空白未命名缓冲区（不再有欢迎页路由）
//  B. 侧栏空态（未打开工作区）：logo、标题、三个入口按钮、快捷键提示
//  C. 工具栏「打开」分裂按钮：下拉打开、列出最近文档、固定/取消固定、移除、清除记录
//  D. 文件菜单：新建/打开文件/打开文件夹仍在，且补上了最近文档项
//  E. 路由：`/` 与未知路径都归到编辑器；`/about` 仍可用
//  F. 复原：设置（recentFiles/pinnedFiles）与临时窗口
const CDP = 'http://127.0.0.1:9222/json'
const fs = require('fs')
const path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws,
  id = 0
const pending = new Map()
function send(m, p) {
  return new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
}
async function ev(e) {
  const r = await send('Runtime.evaluate', {
    expression: e,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result && r.result.exceptionDetails)
    return 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240)
  return r.result?.result?.value
}
async function attach(page) {
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    sock.onopen = res
    sock.onerror = rej
  })
  let n = 0
  const waiters = new Map()
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m)
      waiters.delete(m.id)
    }
  }
  const s = (method, params) =>
    new Promise((r) => {
      const i = ++n
      waiters.set(i, r)
      sock.send(JSON.stringify({ id: i, method, params }))
    })
  const e = async (expr) => {
    const r = await s('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails)
      return 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200)
    return r.result?.result?.value
  }
  return { sock, send: s, ev: e }
}
const appPages = async () =>
  (await (await fetch(CDP)).json()).filter(
    // 认 dev server（5173）与构建产物（out/renderer/index.html）两种页面地址：
    // 别把地址写死成 5173，那样没 dev server 就整轮跑不了
    (t) => t.type === 'page' && /index\.html|5173/.test(t.url)
  )

/** 等一个不在 known 里的新窗口出现 */
async function waitNewWindow(known, ms = 9000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await sleep(300)
    const fresh = (await appPages()).find((p) => !known.includes(p.id))
    if (fresh) return fresh
  }
  return null
}

/** 读某窗口的文档 / 工作区（用于验证「新窗口打开」与「当前窗口不受影响」） */
async function windowState(page) {
  const o = await attach(page)
  for (let i = 0; i < 40; i++) {
    const ready = await o.ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)
    if (ready === 'y') break
    await sleep(300)
  }
  const raw = await o.ev(`(() => {
    const pinia = ${PINIA}
    if (!pinia) return 'null'
    const f = pinia._s.get('files')
    return JSON.stringify({ path: f.current?.path ?? null, root: f.root ?? null })
  })()`)
  o.sock.close()
  return raw === 'null' ? null : JSON.parse(raw)
}

async function closePage(page) {
  const o = await attach(page)
  await o.send('Page.close').catch(() => {})
  await sleep(500)
  o.sock.close()
}

/** 验收自己写入的种子路径前缀：复原时一律剔除，避免「上一轮崩溃留下的种子」
 *  被下一轮当成用户真实数据备份下来、从此再也清不掉（踩过一次）。 */
const SEED_RE = /lumin-verify-|lumin-link-verify/

/** 关掉任何打开的浮层：用真实 mousedown 触发各浮层的「点击外部关闭」
 *  （`element.click()` 不会冒泡 mousedown，所以之前那种写法关不掉菜单）。 */
async function closeAnyPopover(ev) {
  await ev(`(() => {
    const opts = { bubbles: true, cancelable: true }
    document.body.dispatchEvent(new MouseEvent('mousedown', opts))
    document.body.dispatchEvent(new MouseEvent('mouseup', opts))
    document.body.dispatchEvent(new MouseEvent('click', opts))
    return 'ok'
  })()`)
  await sleep(400)
}

/** 页面侧取 pinia：**别按 Symbol 名字找**（生产构建会把 symbol 描述压掉，那样只有 dev server
 *  的页面能命中）；以「provides 里持有 _s Map 的那个对象」为准，与其余套件同一口径 ——
 *  于是本套件对着 out/ 构建产物也能跑。 */
const PINIA = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return null
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  return vals.find((v) => v && typeof v === 'object' && v._s instanceof Map) ?? null
})()`

const INJECT = `(() => {
  const pinia = ${PINIA}
  if (!pinia) return 'NO_PINIA'
  window.__L = {
    files: () => pinia._s.get('files'),
    settings: () => pinia._s.get('settings'),
    ui: () => pinia._s.get('ui'),
    ed: () => pinia._s.get('editor')?.instance ?? null
  }
  return 'ok'
})()`

async function settle(e, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await e(`(() => {
      const pinia = ${PINIA}
      return !!pinia && pinia._s.get('ui').booting === false
    })()`)
    if (ok === true) {
      await e(INJECT)
      return true
    }
    await sleep(200)
  }
  return false
}

async function main() {
  const results = []
  const c = (n, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  /** 环境不具备时如实 SKIP —— **不要**用 `c(name, false, 'SKIP: …')` 写成 FAIL 行（见 G 段注释） */
  const skip = (n, why) => results.push('SKIP ' + n + (why ? ' | ' + why : ''))

  const pages = await appPages()
  if (!pages.length) {
    console.log('NO-APP-PAGE')
    return
  }
  // 另开窗口：不影响用户当前窗口的文档
  const opener = await attach(pages[0])
  // 等用户窗口就绪再读备份（启动瞬间 #app 可能还没挂载，读到就是 EXC/undefined）
  for (let i = 0; i < 40; i++) {
    const ready = await opener.ev(`document.querySelector('#app')?.__vue_app__ ? 'y' : 'n'`)
    if (ready === 'y') break
    await sleep(300)
  }
  const known = pages.map((p) => p.id)
  const backupRaw = await opener.ev(`(() => {
    const pinia = ${PINIA}
    if (!pinia) return 'null'
    const s = pinia._s.get('settings')
    return JSON.stringify({
      recentFiles: s.recentFiles,
      pinnedFiles: s.pinnedFiles,
      recentFolders: s.recentFolders ?? []
    })
  })()`)
  const backup =
    typeof backupRaw === 'string' && backupRaw.startsWith('{') ? JSON.parse(backupRaw) : null
  console.log(
    'BACKUP recents=' +
      (backup?.recentFiles.length ?? 'n/a') +
      ' pinned=' +
      (backup?.pinnedFiles.length ?? 'n/a')
  )
  await opener.send('Runtime.evaluate', {
    expression: '(window.luminAPI.app.newWindow(), "ok")',
    returnByValue: true
  })
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(400)
    page = (await appPages()).find((p) => !known.includes(p.id)) ?? null
  }
  opener.sock.close()
  if (!page) {
    console.log('SKIP: 第二个窗口未出现')
    return
  }
  console.log('（在第二个窗口里验收，用户窗口不受影响）')

  ws = new WebSocket(page.webSocketDebuggerUrl)
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
  await send('Page.enable')
  await send('Page.bringToFront')
  await settle(ev)

  // C 段要断言「工具栏里不再有『打开文件/最近文档』按钮」⇒ 必须先让工具栏**显示出来**：
  // 快捷工具栏出厂默认收起（清单 §1.E 选项②），工具栏不在 DOM 里时 `found === false`，
  // 那条断言会以「找不到工具栏」而不是「按钮确实没了」的形式失败（实测踩过）。
  await ev(`(() => { window.__L.settings().set('toolbarVisible', true); return 'ok' })()`)
  await sleep(400)

  // 关掉工作区以露出侧栏空态（跑完在 finally 里还原）。
  // hadRoot 必须声明在 try 之外：finally 里要用到。
  const hadRoot = await ev(
    `(async () => { const r = window.__L.files().root; if (r) await window.__L.files().setRoot(null); return r ?? null })()`
  )
  await sleep(900)

  try {
    // ── A. 无会话启动 → 编辑器 + 空白未命名缓冲区 ──────────────────────────
    const a = JSON.parse(
      await ev(`(() => {
      const f = window.__L.files()
      return JSON.stringify({
        hash: location.hash,
        path: f.current?.path ?? null,
        name: f.current?.name ?? null,
        dirty: !!f.dirty,
        size: window.__L.ed()?.state.doc.content.size ?? null,
        welcomeMounted: !!document.querySelector('.welcome, [data-view="welcome"]')
      })
    })()`)
    )
    console.log('A ' + JSON.stringify(a))
    c('startup-lands-on-editor', a.hash.includes('/editor'), a.hash)
    c(
      'startup-opens-untitled-buffer',
      a.path === null && /^Untitled/.test(String(a.name)),
      String(a.name)
    )
    c('editor-mounted-with-empty-doc', a.size !== null && a.size <= 4, 'size=' + a.size)
    c('no-welcome-view', a.welcomeMounted === false)

    // ── B. 侧栏空态：未打开工作区时**不再有任何入口按钮/提示**（用户口径）─────────
    // 历史：这里曾经是「三个图标入口 + 快捷键提示」，更早还有 hero 文案。
    // 现在整块删掉 —— 没打开文件夹时侧栏空着就是空着（入口在顶部「文件」菜单与快捷键里）。
    const b = JSON.parse(
      await ev(`(() => {
        const aside = document.querySelector('aside')
        return JSON.stringify({
          root: window.__L.files().root,
          hub: !!document.querySelector('aside .empty-hub'),
          asideText: (aside ? aside.innerText : '').replace(/\\s+/g, ' ').trim(),
          asideButtons: aside ? [...aside.querySelectorAll('button')].map((x) => (x.getAttribute('aria-label') || x.textContent || '').trim()) : []
        })
      })()`)
    )
    console.log('B ' + JSON.stringify(b))
    c('sidebar-empty-state-shown', b.root === null, 'root=' + b.root)
    c('empty-state-hub-removed', b.hub === false, 'aside .empty-hub 不该再存在')
    // 注意用**精确相等**（不是 includes）：头部那枚「打开文件夹」是可访问名里含「打开文件」的
    // 超串，`includes('打开文件')` 会把它误判成空态按钮（实测踩过）
    c(
      'empty-state-hub-buttons-removed',
      !b.asideButtons.some((x) => x === '新建文档' || x === '打开文件'),
      JSON.stringify(b.asideButtons)
    )
    // 用户口径（§4.84 起改口）：没有工作区时侧栏里**连那一枚「打开文件夹」也不留** ——
    // 前一轮"先删后恢复"的那条口径已被本轮推翻（用户要求侧栏在没开文件夹时完全空着）。
    // 入口仍在「文件」菜单（含最近文件夹）与 Ctrl+O 上。
    c(
      'sidebar-header-drops-open-folder-too',
      b.asideButtons.every((x) => !/打开文件夹/.test(x)),
      JSON.stringify(b.asideButtons)
    )
    c(
      'empty-state-has-no-hint-text',
      !/Ctrl\+O|Ctrl\+Shift\+P/.test(b.asideText),
      JSON.stringify(b.asideText.slice(0, 80))
    )

    // ── C. 工具栏「打开」分裂按钮 ────────────────────────────────────────────
    // 关键：**先播两条测试用的最近记录**（不碰用户真实列表；清空记录那步只清测试数据），
    // 否则「清除记录」会把用户自己的最近文档一并清掉 —— 这正是本套件第一版踩过的坑。
    const seeded = JSON.parse(
      await ev(`(() => {
      const s = window.__L.settings()
      const real = ${backup ? JSON.stringify(backup.recentFiles.filter((r) => !/lumin-verify-/.test(r.path))) : '[]'}
      // 播 12 条种子：既不动用户真实数据，又保证列表超过一屏（内部滚动用例需要）
      const seed = Array.from({ length: 12 }, (_, i) => ({
        path: 'lumin-verify-open/seed-' + i + '.md',
        title: 'seed-' + String(i).padStart(2, '0') + '.md',
        openedAt: Date.now() - i * 1000
      }))
      s.set('recentFiles', [...seed, ...real])
      s.set('pinnedFiles', [])
      return JSON.stringify({ total: s.recentFiles.length, seed: seed.length })
    })()`)
    )
    console.log('C-seed ' + JSON.stringify(seeded))
    await closeAnyPopover(ev)

    // 工具栏不应再有「打开」按钮（能力已移到侧栏与菜单，避免三处重复）
    // ⚠️ 定位方式本轮改成组件给的稳定钩子 `data-editor-toolbar`（Toolbar.vue 根节点上）：
    //    原来按类名链找（`h-11` + `overflow-x-auto`）——类名一被改动，这条断言就以
    //    「找不到工具栏」的形式红掉（实测：工作区里出现过一次未提交的高度类名改动，
    //    它一变这条就假红）。钩子与视觉类名解耦，以后调高度不会再影响它。
    const toolbar = JSON.parse(
      await ev(`(() => {
        const bar = document.querySelector('[data-editor-toolbar]')
        const titles = bar ? [...bar.querySelectorAll('button')].map((b) => b.title || '') : []
        return JSON.stringify({
          found: !!bar,
          hasOpen: titles.some((x) => x.startsWith('打开文件') || x === '最近文档'),
          count: titles.length
        })
      })()`)
    )
    console.log('C-toolbar ' + JSON.stringify({ found: toolbar.found, hasOpen: toolbar.hasOpen }))
    c(
      'toolbar-open-button-removed',
      toolbar.found === true && toolbar.hasOpen === false,
      JSON.stringify(toolbar)
    )

    // ── C. 侧栏「最近文档」按钮已删（§4.79）；它原来的行为搬到「文件 → 最近文档」二级菜单 ──
    // 改造前：侧栏头部有「最近文档」按钮（在「新建文件」左侧），点开是一个自带滚动条的
    // 下拉（固定 / 取消固定 / 移除 / 清除记录，且"内部滚动不关、外部滚动关"）。
    // 现在：侧栏头部**整行**去掉（文件夹成为目录树的顶层节点），最近文档只剩
    // 「文件 → 最近文档」二级菜单一处 —— 所以这一段改成两件事：
    //   ① 侧栏确实不再有那两枚按钮（新口径）；
    //   ② 原来挂在下拉上的**行为**（列出 / 固定 / 清除记录）改在二级菜单上验，
    //      不因为搬了家就把覆盖悄悄丢掉（RecentList.vue 是同一个组件）。
    // ⚠️ 「内部滚动不关、外部滚动关」两条**不在这里重验**：它们量的是 `lib/popoverClose`，
    //    而 TopMenuBar 从来没有滚动收起逻辑（它有自己的一套：外部点击 / Esc / 悬停离开）；
    //    那条规则仍由 `_verify-editor-menu.js` 的 C 段与工具栏导出弹层覆盖。
    const sidebarBtns = JSON.parse(
      await ev(`(() => {
        const aside = document.querySelector('aside')
        const titles = aside
          ? [...aside.querySelectorAll('button')].map((b) => b.title || b.getAttribute('aria-label') || '')
          : []
        return JSON.stringify({ titles })
      })()`)
    )
    console.log('C-sidebar ' + JSON.stringify(sidebarBtns))
    // 只断言「最近文档」那一枚不在了：没有工作区时侧栏里还有**首次引导块**（新建文件 /
    // 打开文件夹 / 插入示例），那是另一条既定口径（`shouldShowOnboarding`），不该被这里误判。
    // 「头部整行（含新建文件）不存在」由 `_verify-sidebar-root-and-outline-side.js` 在
    // **有工作区**的前提下钉住（那里才是它该在的场景）。
    c(
      'sidebar-recent-button-removed',
      !sidebarBtns.titles.includes('最近文档'),
      JSON.stringify(sidebarBtns.titles)
    )

    // 文件菜单（Alt+F）→ 悬停「最近文档」→ 二级菜单里做固定 / 清除
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      modifiers: 1 // Alt
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      modifiers: 1
    })
    await sleep(600)
    // 先确认菜单真的开了、并拿到「最近文档」那一行的几何（hoverSub 内部也会查一遍，
    // 这里多打一行日志是为了失败时能一眼看出是"菜单没开"还是"悬停没生效"）
    console.log(
      'C-menu ' +
        (await ev(`(() => {
          const p = document.querySelector('.topmenu-drop.fixed')
          if (!p) return 'null'
          const row = [...p.querySelectorAll('button')].find((b) => b.textContent.trim() === '最近文档')
          const r = row ? row.getBoundingClientRect() : null
          return JSON.stringify({
            items: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()).slice(0, 8),
            rowRect: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) } : null
          })
        })()`))
    )
    const cSub = await hoverSub('最近文档')
    console.log('C-sub ' + JSON.stringify(cSub.sub))
    c('recent-entry-lives-in-file-menu', cSub.sub !== null, JSON.stringify(cSub.sub))
    c(
      'moved-recent-submenu-lists-seeded-docs',
      cSub.sub !== null && cSub.sub.rows.some((x) => x.includes('seed-00')),
      JSON.stringify(cSub.sub?.rows)
    )
    const subWidth = await ev(`(() => {
      const s = document.querySelector('.topmenu-sub')
      return s ? Math.round(s.getBoundingClientRect().width) : null
    })()`)
    c('moved-recent-submenu-width-300', subWidth === 300, 'width=' + subWidth)

    // 固定第一条 → pinnedFiles 生效（原来在侧栏下拉上验，现在在同一个组件的二级菜单里验）
    const pinned = await ev(`(() => {
      const s = document.querySelector('.topmenu-sub')
      const row = s?.querySelector('.group')
      const target = row?.querySelector('button[title*="固定"]')
      if (!target) return 'no-pin-button'
      target.click()
      return JSON.stringify({
        pinned: window.__L.settings().pinnedFiles.length,
        recents: window.__L.settings().recentFiles.length
      })
    })()`)
    await sleep(500)
    console.log('C-pin ' + String(pinned))
    c('recent-pin-works', String(pinned).includes('"pinned":1'), String(pinned))
    // 清除记录：**只有拿到有效备份时才跑**（这一步会清空整个最近列表，
    // 万一后续崩溃又没走到 finally，用户的真实记录就没了 —— 第一版就栽在这）
    if (!backup) {
      c('recent-clear-works', false, 'SKIP: 未取得有效备份，跳过破坏性步骤')
    } else {
      const cleared = await ev(`(() => {
        const s = document.querySelector('.topmenu-sub')
        const btn = [...(s?.querySelectorAll('button') ?? [])].find((b) =>
          b.textContent.includes('清除记录')
        )
        if (!btn) return 'no-clear-button'
        btn.click()
        return 'clicked'
      })()`)
      // 「清除记录」是**不可逆**动作：RecentList 会先弹一个确认模态（`ui.confirm`）——
      // 必须点掉它才算真的清空（点最后一个按钮 = 主操作，`ModalHost` 的顺序是 取消 → 确认；
      // 按顺序而不是按文案找，换语言也不受影响）。
      await sleep(500)
      const confirmed = await ev(`(() => {
        const dlg = document.querySelector('[role="dialog"]')
        if (!dlg) return 'no-dialog'
        const btns = [...dlg.querySelectorAll('button')]
        if (!btns.length) return 'no-buttons'
        btns[btns.length - 1].click()
        return 'confirmed'
      })()`)
      await sleep(700)
      const afterClear = JSON.parse(
        await ev(
          `(() => JSON.stringify({ recents: window.__L.settings().recentFiles.length, pinned: window.__L.settings().pinnedFiles.length }))()`
        )
      )
      console.log('C-clear ' + JSON.stringify({ cleared, confirmed, afterClear }))
      c(
        'recent-clear-works',
        cleared === 'clicked' && confirmed === 'confirmed' && afterClear.recents === 0,
        JSON.stringify({ cleared, confirmed, afterClear })
      )
    }
    // 收尾：把「文件」菜单关掉（D 段接下来还要用 Alt+F 打开它 —— 开着的话那一下会把它**收起**）。
    // 用**真实鼠标点一下编辑区**：TopMenuBar 的「外部点击关闭」挂在 mousedown 上，
    // `document.body.click()` 只派发 click，关不掉（实测 C-menu-closed=false）。
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 700,
      y: 500,
      button: 'left',
      clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 700,
      y: 500,
      button: 'left',
      clickCount: 1
    })
    await sleep(500)
    const menuClosed = await ev(`!document.querySelector('.topmenu-drop')`)
    console.log('C-menu-closed ' + menuClosed)

    // ── D. 文件菜单（Alt+F）：新建/打开/最近 ─────────────────────────────────
    // 先补两条测试种子（C 的「清除记录」把列表清空了），菜单里应列出它们
    await ev(`(() => {
    const s = window.__L.settings()
    s.set('recentFiles', [
      { path: 'lumin-verify-open/seed-a.md', title: 'seed-a.md', openedAt: Date.now() },
      { path: 'lumin-verify-open/seed-b.md', title: 'seed-b.md', openedAt: Date.now() - 1000 }
    ])
    return 'ok'
  })()`)
    await sleep(600)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      modifiers: 1 // Alt
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      modifiers: 1
    })
    await sleep(600)
    const dRaw = await ev(`(() => {
      const p = document.querySelector('.topmenu-drop.fixed')
      if (!p) return 'null'
      const rows = [...p.querySelectorAll('button')].map((b) => ({
        text: b.textContent.trim(),
        caret: !!b.querySelector('svg + svg') || b.textContent.trim().length > 0
      }))
      return JSON.stringify({ items: rows.map((r) => r.text) })
    })()`)
    console.log('D-raw ' + String(dRaw).slice(0, 300))
    const d = JSON.parse(String(dRaw).startsWith('EXC') ? 'null' : dRaw)
    console.log('D ' + JSON.stringify(d))
    c(
      'file-menu-has-new',
      d !== null && d.items[0] === '新建' && !d.items.includes('新建文档'),
      JSON.stringify(d?.items)
    )
    c(
      'file-menu-has-open',
      d !== null &&
        d.items.some((x) => x.includes('打开') && x.includes('文件')) &&
        d.items.some((x) => x.includes('打开') && x.includes('文件夹')),
      JSON.stringify(d?.items)
    )
    c(
      'file-menu-has-two-submenus',
      d !== null && d.items.includes('最近文档') && d.items.includes('最近文件夹'),
      JSON.stringify(d?.items)
    )

    // ── D2. 一级项悬停 → 二级菜单（最近文档 / 最近文件夹）────────────────────
    // 先补回测试种子（D 之前被 C 清空了），让二级里有内容可断言
    await ev(`(() => {
      const s = window.__L.settings()
      s.set('recentFiles', [
        { path: 'lumin-verify-open/seed-a.md', title: 'seed-a.md', openedAt: Date.now() },
        { path: 'lumin-verify-open/seed-b.md', title: 'seed-b.md', openedAt: Date.now() - 1000 }
      ])
      s.set('recentFolders', [
        { path: 'lumin-verify-open/seed-folder', name: 'seed-folder', openedAt: Date.now() }
      ])
      return 'ok'
    })()`)
    await sleep(600)

    /** 悬停文件菜单里的某个一级项，返回二级浮层内容 */
    async function hoverSub(label) {
      const row = JSON.parse(
        await ev(`(() => {
          const p = document.querySelector('.topmenu-drop.fixed')
          const btn = [...(p?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
          if (!btn) return 'null'
          const r = btn.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
        })()`)
      )
      if (row === 'null' || row === null) return { row: null, sub: null }
      // 分两步移动（先靠近再落上），保证 mouseenter 触发；二级浮层是**动效之后**才在 DOM 里，
      // 所以拿不到就重发一次鼠标位置再等（实测：偶发一次 hover 没生效，
      // 表现为"菜单明明开着、二级却没出来"，重试后稳定）
      const readSub = async () => {
        const raw = await ev(`(() => {
          const s = document.querySelector('.topmenu-sub')
          if (!s) return 'null'
          const panel = document.querySelector('.topmenu-drop:not(.topmenu-sub)')
          const pr = panel?.getBoundingClientRect()
          const sr = s.getBoundingClientRect()
          return JSON.stringify({
            title: s.querySelector('p')?.textContent?.trim() ?? null,
            rows: [...s.querySelectorAll('.group')].map((r) => r.textContent.trim()),
            leftOfPanel: pr ? Math.round(pr.right) : null,
            subLeft: Math.round(sr.left),
            actions: [...s.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)
          })
        })()`)
        return raw === 'null' ? null : JSON.parse(raw)
      }
      let sub = null
      for (let i = 0; i < 4 && sub === null; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: i === 0 ? row.x - 6 : row.x,
          y: row.y,
          button: 'none',
          buttons: 0
        })
        await sleep(i === 0 ? 80 : 400)
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: row.x,
          y: row.y,
          button: 'none',
          buttons: 0
        })
        await sleep(500)
        sub = await readSub()
      }
      return { row, sub }
    }

    const filesSub = await hoverSub('最近文档')
    console.log('D2-files ' + JSON.stringify(filesSub.sub))
    c('submenu-recent-files-opens', filesSub.sub !== null, JSON.stringify(filesSub.sub))
    c(
      'submenu-recent-files-lists-docs',
      filesSub.sub !== null && filesSub.sub.rows.some((x) => x.includes('seed-a')),
      JSON.stringify(filesSub.sub?.rows)
    )
    c(
      'submenu-flush-right',
      filesSub.sub !== null && filesSub.sub.subLeft <= filesSub.sub.leftOfPanel + 1,
      JSON.stringify({ panelRight: filesSub.sub?.leftOfPanel, subLeft: filesSub.sub?.subLeft })
    )

    const foldersSub = await hoverSub('最近文件夹')
    console.log('D2-folders ' + JSON.stringify(foldersSub.sub))
    c('submenu-recent-folders-opens', foldersSub.sub !== null, JSON.stringify(foldersSub.sub))
    c(
      'submenu-recent-folders-lists-folders',
      foldersSub.sub !== null && foldersSub.sub.rows.some((x) => x.includes('seed-folder')),
      JSON.stringify(foldersSub.sub?.rows)
    )

    // 二级里「最近文件夹」的行必须有可点的按钮（真正的点击链路在 G 里验证：
    // 那会**新开一个窗口**，放在这里会多出一个需要清理的窗口）
    const folderRowReady = await ev(`(() => {
      const s = document.querySelector('.topmenu-sub')
      const btn = s?.querySelector('.group button')
      return btn ? JSON.stringify({ text: btn.textContent.trim() }) : 'no-row'
    })()`)
    console.log('D2-folder-row ' + String(folderRowReady))
    c('submenu-folder-row-clickable', String(folderRowReady) !== 'no-row', String(folderRowReady))

    await closeAnyPopover(ev)

    // ── E. 路由：`/` 与未知路径都归到编辑器；/about 仍可用 ──────────────────
    const routes = JSON.parse(
      await ev(`(async () => {
      const out = {}
      location.hash = '#/'
      await new Promise((r) => setTimeout(r, 700))
      out.root = location.hash
      location.hash = '#/does-not-exist'
      await new Promise((r) => setTimeout(r, 700))
      out.unknown = location.hash
      location.hash = '#/about'
      await new Promise((r) => setTimeout(r, 700))
      out.about = location.hash
      location.hash = '#/editor'
      await new Promise((r) => setTimeout(r, 700))
      out.back = location.hash
      return JSON.stringify(out)
    })()`)
    )
    console.log('E ' + JSON.stringify(routes))
    c('root-redirects-to-editor', routes.root.includes('/editor'), routes.root)
    c('unknown-redirects-to-editor', routes.unknown.includes('/editor'), routes.unknown)
    c('about-still-works', routes.about.includes('/about'), routes.about)

    // ── G. 最近文档 / 最近文件夹 → **新窗口**打开（当前窗口不受影响）──────────
    if (!hadRoot) {
      // ⚠️ 这里原来是 `c(..., false, 'SKIP: …')` —— 把「环境不具备」写成了 FAIL 行，
      // 运行器按「打印过 FAIL 行」判定，于是这个套件在自己的跳过路径上必然报红
      // （清单 §1.C 同一类问题：SKIP 不该算失败）。现在如实走 skip 通道。
      skip('recent-file-opens-in-new-window', '无工作区，无法放夹具')
      skip('recent-folder-opens-in-new-window', '无工作区，无法放夹具')
    } else {
      const fixDir = path.join(hadRoot, 'lumin-verify-open')
      const docA = path.join(fixDir, 'doc-a.md')
      fs.mkdirSync(fixDir, { recursive: true })
      fs.writeFileSync(docA, '# 新窗口验收 A\n', 'utf-8')
      console.log('G-fixture ' + docA)

      // 当前窗口侧状态 + 已知窗口，作为「不受影响」与「新窗口出现」的基线
      const beforeIds = (await appPages()).map((p) => p.id)
      const beforeSelf = JSON.parse(
        await ev(
          `(() => JSON.stringify({ path: window.__L.files().current?.path ?? null, root: window.__L.files().root }))()`
        )
      )

      // ① 最近文档：「文件 → 最近文档」二级菜单里点真实文件 → 新窗口打开该文档
      // （§4.79 起侧栏那枚按钮已删；二级菜单与它共用同一个 RecentList 组件与同一个处理器）
      // 先确保没有浮层残留（上一节的 .click() 不会冒泡 mousedown，菜单可能还开着，
      // 此时点按钮会变成「再点一次关掉」——上一版就因此误判为「菜单打不开」）
      await closeAnyPopover(ev)
      await ev(`(() => {
        const s = window.__L.settings()
        s.set('recentFiles', [{ path: ${JSON.stringify(docA)}, title: 'doc-a.md', openedAt: Date.now() }])
        return 'ok'
      })()`)
      await sleep(600)
      // 打开「文件 → 最近文档」二级菜单（§4.79 起侧栏那枚「最近文档」按钮已删，
      // 最近文档的入口只剩文件菜单这一处）
      await ev(`(() => {
        const b = document.querySelector('[data-topmenu-group="f"]')
        if (b) b.click()
        return 'ok'
      })()`)
      await sleep(600)
      await hoverSub('最近文档')
      const diagDoc = await ev(`(() => {
        const s = document.querySelector('.topmenu-sub')
        return JSON.stringify({
          panel: !!s,
          text: (s?.textContent ?? '').trim().slice(0, 60),
          groups: s ? s.querySelectorAll('.group').length : -1,
          recents: window.__L.settings().recentFiles.length
        })
      })()`)
      console.log('G-file-diag ' + diagDoc)
      const clickedDoc = await ev(`(() => {
        const s = document.querySelector('.topmenu-sub')
        const row = s?.querySelector('.group button')
        if (!row) return 'no-row'
        row.click()
        return 'clicked'
      })()`)
      const winDoc = await waitNewWindow(beforeIds)
      const stateDoc = winDoc ? await windowState(winDoc) : null
      const afterSelf = JSON.parse(
        await ev(
          `(() => JSON.stringify({ path: window.__L.files().current?.path ?? null, root: window.__L.files().root }))()`
        )
      )
      console.log(
        'G-file ' +
          JSON.stringify({ clickedDoc, newWin: winDoc?.id ?? null, stateDoc, self: afterSelf })
      )
      c(
        'recent-file-opens-in-new-window',
        clickedDoc === 'clicked' && stateDoc !== null && stateDoc.path === docA,
        JSON.stringify({ clickedDoc, stateDoc })
      )
      c(
        'current-window-untouched-by-recent-file',
        afterSelf.path === beforeSelf.path && afterSelf.root === beforeSelf.root,
        JSON.stringify({ before: beforeSelf, after: afterSelf })
      )
      if (winDoc) await closePage(winDoc)

      // ② 最近文件夹：文件菜单「最近文件夹」二级里点一项 → 新窗口以该文件夹为工作区
      await closeAnyPopover(ev)
      const idsBeforeFolder = (await appPages()).map((p) => p.id)
      await ev(`(() => {
        window.__L.settings().set('recentFolders', [
          { path: ${JSON.stringify(hadRoot)}, name: 'workspace', openedAt: Date.now() }
        ])
        return 'ok'
      })()`)
      await sleep(600)
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          key: 'f',
          code: 'KeyF',
          windowsVirtualKeyCode: 70,
          modifiers: 1
        })
      }
      await sleep(600)
      const folderSub = await hoverSub('最近文件夹')
      const clickedFolder = await ev(`(() => {
        const s = document.querySelector('.topmenu-sub')
        const row = s?.querySelector('.group button')
        if (!row) return 'no-row'
        row.click()
        return 'clicked'
      })()`)
      const winFolder = await waitNewWindow(idsBeforeFolder)
      const stateFolder = winFolder ? await windowState(winFolder) : null
      const rootAfterFolder = await ev(`window.__L.files().root`)
      console.log(
        'G-folder ' +
          JSON.stringify({
            sub: folderSub.sub?.rows,
            clickedFolder,
            newWin: winFolder?.id ?? null,
            stateFolder,
            selfRoot: rootAfterFolder
          })
      )
      c(
        'recent-folder-opens-in-new-window',
        clickedFolder === 'clicked' &&
          stateFolder !== null &&
          String(stateFolder.root).toLowerCase() === hadRoot.toLowerCase(),
        JSON.stringify({ clickedFolder, stateFolder })
      )
      c(
        'current-window-untouched-by-recent-folder',
        rootAfterFolder === beforeSelf.root,
        JSON.stringify({ before: beforeSelf.root, after: rootAfterFolder })
      )
      if (winFolder) await closePage(winFolder)
      fs.rmSync(fixDir, { recursive: true, force: true })
    }

    // ── F. 复原（放在 finally 里：即使中途断言抛错也一定复原。本套件第一版就是
    //          崩溃后没走到复原，把用户真实的 recentFiles/pinnedFiles 清掉了）────
  } catch (e) {
    console.log('ERROR-MID ' + (e && e.message ? e.message : String(e)))
  } finally {
    await ev(`(async () => {
      const s = window.__L.settings()
      const b = ${JSON.stringify(backup)}
      if (b) {
        // 剔除验收种子路径：绝不让自己的测试数据变成「用户数据」
        s.set('recentFiles', (b.recentFiles ?? []).filter((r) => !${SEED_RE}.test(r.path)))
        s.set('pinnedFiles', (b.pinnedFiles ?? []).filter((p) => !${SEED_RE}.test(p)))
        s.set('recentFolders', (b.recentFolders ?? []).filter((f) => !${SEED_RE}.test(f.path)))
      }
      return 'ok'
    })()`)
    await sleep(700)
    // 工作区单独恢复（子菜单点击可能改过它）
    await ev(
      `(async () => { const f = window.__L.files(); if (f.root !== ${JSON.stringify(hadRoot)}) await f.setRoot(${JSON.stringify(hadRoot)}) ; return 'ok' })()`
    )
    await sleep(900)
    const restored = JSON.parse(
      await ev(
        `(() => JSON.stringify({ recents: window.__L.settings().recentFiles.length, root: window.__L.files().root }))()`
      )
    )
    const wantRecents = backup ? backup.recentFiles.filter((r) => !SEED_RE.test(r.path)).length : 0
    console.log('F ' + JSON.stringify({ restored, wantRecents, hadRoot }))
    c('settings-restored', restored.recents === wantRecents, JSON.stringify(restored))
    c(
      'workspace-restored',
      hadRoot ? restored.root === hadRoot : restored.root === null,
      JSON.stringify(restored)
    )
    await send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
    await send('Page.close').catch(() => {})
    await sleep(400)
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`)
  ws.close()
  if (failed) process.exit(1)
}
main().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
