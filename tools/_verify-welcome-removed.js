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
  (await (await fetch(CDP)).json()).filter((t) => t.type === 'page' && t.url.includes('5173'))

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
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'null'
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const f = app._context.provides[sym]._s.get('files')
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

const INJECT = `(() => {  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'NO_APP'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
  const pinia = app._context.provides[sym]
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
      const app = document.querySelector('#app')?.__vue_app__
      if (!app) return false
      const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
      return app._context.provides[sym]._s.get('ui').booting === false
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
    const app = document.querySelector('#app')?.__vue_app__
    if (!app) return 'null'
    const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => String(s) === 'Symbol(pinia)')
    const s = app._context.provides[sym]._s.get('settings')
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

    // ── B. 侧栏空态：未打开工作区时的三个入口 ────────────────────────────────
    const b = JSON.parse(
      await ev(`(() => {
      const aside = document.querySelector('aside')
      if (!aside) return 'null'
      const texts = [...aside.querySelectorAll('button')].map((x) => x.textContent.trim())
      return JSON.stringify({
        root: window.__L.files().root,
        hasLogo: !!aside.querySelector('svg'),
        newDoc: texts.some((x) => x.includes('新建文档')),
        openFile: texts.some((x) => x.includes('打开文件')),
        openFolder: texts.some((x) => x.includes('打开文件夹')),
        hint: (aside.textContent || '').includes('Ctrl+O')
      })
    })()`)
    )
    console.log('B ' + JSON.stringify(b))
    c('sidebar-empty-state-shown', b.root === null, 'root=' + b.root)
    c('empty-state-has-three-entries', b.newDoc && b.openFile && b.openFolder, JSON.stringify(b))
    c('empty-state-has-shortcut-hint', b.hint === true)

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
    const toolbar = JSON.parse(
      await ev(`(() => {
        const bar = [...document.querySelectorAll('div')].find((d) => d.className?.toString?.().includes('h-11') && d.className?.toString?.().includes('overflow-x-auto'))
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

    // 侧栏头部：「最近文档」按钮必须在「新建文件」左侧
    const side = JSON.parse(
      await ev(`(() => {
        const aside = document.querySelector('aside')
        if (!aside) return 'null'
        const head = aside.firstElementChild
        const btns = [...head.querySelectorAll('button')].map((b) => ({
          title: b.title || '',
          x: Math.round(b.getBoundingClientRect().left)
        }))
        const recentBtn = btns.find((b) => b.title === '最近文档')
        const newBtn = btns.find((b) => b.title.startsWith('新建文件') || b.title === '新建文件' || b.title.includes('新建'))
        if (!recentBtn || !newBtn) return JSON.stringify({ btns, missing: true })
        const r = recentBtn.x
        const n = newBtn.x
        return JSON.stringify({ btns, recentLeft: r, newLeft: n, recentIsLeft: r < n })
      })()`)
    )
    console.log('C-sidebar ' + JSON.stringify(side))
    c(
      'sidebar-recent-button-left-of-new',
      side !== 'null' && side.recentIsLeft === true,
      JSON.stringify(side)
    )

    if (side !== 'null' && side.recentIsLeft) {
      const rect = JSON.parse(
        await ev(`(() => {
          const aside = document.querySelector('aside')
          const btn = [...aside.querySelectorAll('button')].find((b) => b.title === '最近文档')
          const r = btn.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
        })()`)
      )
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1
      })
      await sleep(50)
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1
      })
      await sleep(600)
      const panel = JSON.parse(
        await ev(`(() => {
          const p = document.querySelector('.topmenu-drop.fixed')
          if (!p) return 'null'
          const rows = [...p.querySelectorAll('.group')].map((r) => r.textContent.trim())
          const rect = p.getBoundingClientRect()
          return JSON.stringify({
            title: p.querySelector('p')?.textContent?.trim() ?? null,
            rows,
            rect: { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width) },
            hasClear: [...p.querySelectorAll('button')].some((b) => b.textContent.includes('清除记录'))
          })
        })()`)
      )
      console.log('C-panel ' + JSON.stringify(panel))
      c(
        'sidebar-recent-dropdown-lists',
        panel !== 'null' && panel.rows.length >= 1,
        JSON.stringify(panel?.rows)
      )
      c(
        'sidebar-recent-dropdown-anchored',
        panel !== 'null' && panel.rect.w === 300,
        JSON.stringify(panel?.rect)
      )

      // ── 菜单内滚动：列表自带滚动条时，滚它**不该**把菜单关掉（本次修复点）──
      // 菜单关闭的监听挂在 window 的捕获阶段，滚动列表同样会冒到 window；
      // 早期实现不区分「菜单内 / 菜单外」，于是菜单一滚就消失。
      const scrollState = JSON.parse(
        await ev(`(() => {
          const list = document.querySelector('.topmenu-drop.fixed .overflow-y-auto')
          if (!list) return JSON.stringify({ noList: true })
          return JSON.stringify({
            scrollable: list.scrollHeight > list.clientHeight,
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
            top: Math.round(list.scrollTop),
            rect: (() => { const r = list.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 20) } })()
          })
        })()`)
      )
      console.log('C-inner-scroll ' + JSON.stringify(scrollState))
      if (scrollState.scrollable && scrollState.rect) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: scrollState.rect.x,
          y: scrollState.rect.y,
          deltaX: 0,
          deltaY: 240,
          button: 'none',
          buttons: 0
        })
        await sleep(500)
        const after = JSON.parse(
          await ev(`(() => {
            const p = document.querySelector('.topmenu-drop.fixed')
            const list = p?.querySelector('.overflow-y-auto')
            return JSON.stringify({ open: !!p, top: list ? Math.round(list.scrollTop) : null })
          })()`)
        )
        console.log('C-inner-scroll-after ' + JSON.stringify(after))
        c(
          'inner-scroll-keeps-menu-open',
          after.open === true,
          JSON.stringify({ before: scrollState.top, after: after.top })
        )
        c(
          'inner-scroll-actually-scrolled',
          after.top !== null && after.top > scrollState.top,
          JSON.stringify(after)
        )
      } else {
        c('inner-scroll-keeps-menu-open', false, 'SKIP: 列表不足一屏，无法制造内部滚动')
        c('inner-scroll-actually-scrolled', false, 'SKIP')
      }

      // 反向对照：菜单**外部**滚动仍应关闭（原行为不能被这次的修复吃掉）。
      // 用合成 scroll 事件而非滚轮：此时文档是空白未命名缓冲区、没有可滚动内容，
      // 滚轮不会产生 scroll 事件。合成事件同样经过 window 捕获，判定路径一致。
      const outsideDispatch = await ev(`(() => {
        const el = document.querySelector('.editor-scroll') || document.querySelector('.ProseMirror')
        if (!el) return 'no-scroll-target'
        el.dispatchEvent(new Event('scroll'))
        return 'dispatched'
      })()`)
      await sleep(400)
      const afterOutside = await ev(`!!document.querySelector('.topmenu-drop.fixed')`)
      console.log('C-outside-scroll ' + JSON.stringify({ outsideDispatch, open: afterOutside }))
      c(
        'outside-scroll-still-closes',
        outsideDispatch === 'dispatched' && afterOutside === false,
        JSON.stringify({ outsideDispatch, open: afterOutside })
      )

      // 重新打开菜单，继续后面的固定/清除断言
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1
      })
      await sleep(50)
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: 1
      })
      await sleep(600)

      // 固定第一条 → pinnedFiles 生效
      const pinned = await ev(`(() => {
        const p = document.querySelector('.topmenu-drop.fixed')
        const row = p?.querySelector('.group')
        const target = p ? row?.querySelector('button[title*="固定"]') : null
        if (!target) return 'no-pin-button'
        target.click()
        return JSON.stringify({ pinned: window.__L.settings().pinnedFiles.length, recents: window.__L.settings().recentFiles.length })
      })()`)
      await sleep(500)
      console.log('C-pin ' + String(pinned))
      c('sidebar-recent-pin-works', String(pinned).includes('"pinned":1'), String(pinned))
      // 清除记录：**只有拿到有效备份时才跑**（这一步会清空整个最近列表，
      // 万一后续崩溃又没走到 finally，用户的真实记录就没了 —— 第一版就栽在这）
      if (!backup) {
        c('sidebar-recent-clear-works', false, 'SKIP: 未取得有效备份，跳过破坏性步骤')
      } else {
        const cleared = await ev(`(() => {
          const p = document.querySelector('.topmenu-drop.fixed')
          const btn = [...(p?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('清除记录'))
          if (!btn) return 'no-clear-button'
          btn.click()
          return 'clicked'
        })()`)
        await sleep(600)
        const afterClear = JSON.parse(
          await ev(
            `(() => JSON.stringify({ recents: window.__L.settings().recentFiles.length, pinned: window.__L.settings().pinnedFiles.length }))()`
          )
        )
        console.log('C-clear ' + JSON.stringify({ cleared, afterClear }))
        c(
          'sidebar-recent-clear-works',
          cleared === 'clicked' && afterClear.recents === 0,
          JSON.stringify(afterClear)
        )
      }
      await ev(`(() => { document.body.click(); return 'ok' })()`)
      await sleep(300)
    }

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
      d !== null && d.items.some((x) => x.includes('新建文档')),
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
      if (row === 'null') return { row: null, sub: null }
      // 分两步移动（先靠近再落上），保证 mouseenter 触发
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: row.x - 6,
        y: row.y,
        button: 'none',
        buttons: 0
      })
      await sleep(60)
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: row.x,
        y: row.y,
        button: 'none',
        buttons: 0
      })
      await sleep(600)
      const sub = JSON.parse(
        await ev(`(() => {
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
      )
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
      c('recent-file-opens-in-new-window', false, 'SKIP: 无工作区，无法放夹具')
      c('recent-folder-opens-in-new-window', false, 'SKIP')
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

      // ① 最近文档：侧栏下拉里点真实文件 → 新窗口打开该文档
      // 先确保没有浮层残留（上一节的 .click() 不会冒泡 mousedown，菜单可能还开着，
      // 此时点按钮会变成「再点一次关掉」——上一版就因此误判为「菜单打不开」）
      await closeAnyPopover(ev)
      await ev(`(() => {
        const s = window.__L.settings()
        s.set('recentFiles', [{ path: ${JSON.stringify(docA)}, title: 'doc-a.md', openedAt: Date.now() }])
        return 'ok'
      })()`)
      await sleep(600)
      const asideBtn = JSON.parse(
        await ev(`(() => {
          const aside = document.querySelector('aside')
          const btn = [...aside.querySelectorAll('button')].find((b) => b.title === '最近文档')
          const r = btn.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
        })()`)
      )
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: asideBtn.x,
          y: asideBtn.y,
          button: 'left',
          clickCount: 1
        })
        await sleep(50)
      }
      await sleep(500)
      const diagDoc = await ev(`(() => {
        const p = document.querySelector('.topmenu-drop.fixed')
        return JSON.stringify({
          panel: !!p,
          text: (p?.textContent ?? '').trim().slice(0, 60),
          groups: p ? p.querySelectorAll('.group').length : -1,
          recents: window.__L.settings().recentFiles.length
        })
      })()`)
      console.log('G-file-diag ' + diagDoc)
      const clickedDoc = await ev(`(() => {
        const p = document.querySelector('.topmenu-drop.fixed')
        const row = p?.querySelector('.group button')
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
