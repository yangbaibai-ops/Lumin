// 验收：「新建」= 新窗口 + 工作区不变 + 未命名文档（Ctrl+S 时才问保存到哪）
//
// 入口与位置（§4.50 起）：「新建」是**文件菜单的第一项**，不再有顶部栏独立按钮、
// 也没有重复的「新建文档」那一项。这些入口必须是同一个动作：
//   ① 文件 → 新建（真实菜单点击，条目必须是第一项，且全菜单只有这一个「新建」）
//   ② Ctrl+N（真实按键，走渲染层命令表 file.new → handleMenu('new')）
//   ③ 再来一次文件 → 新建（确认可反复用）
//
// 每个入口都要满足：**多出一个窗口**、新窗口的工作区与当前窗口**同一个文件夹**（侧栏树照旧）、
// 文档是**未命名缓冲区**（path=null、名字 Untitled-N.md）、而且**磁盘上不产生任何文件**
// （旧行为是替用户在在工作区里造一个 `未命名.md`）。path=null ⇒ Ctrl+S（files.save()）天然走
// 「另存为」对话框 —— 原生对话框无法在自动化里作答，所以这里断言「文件未被创建 + 静态核对
// save()→saveAs()→chooseSaveFile 这条链」（与 _verify-save-as-workspace.js 同一口径）。
//
// 跑法：独立 userData 实例（tools/start-isolated.ps1），不碰用户数据。
// 可选 `LUMIN_DRAFTS_DIR=<userData>\drafts`：给了就顺手验一条「按 Ctrl+N 不该被上一次未保存的
// 内容打断」（§4.49）—— 直接往盘上种一份无主草稿，再看三个入口开的窗口都不该弹横幅。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const DRAFTS_DIR = process.env.LUMIN_DRAFTS_DIR || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

function connect(url) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
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
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const vals = Object.getOwnPropertySymbols(app._context.provides).map((s) => app._context.provides[s])
  const pinia = vals.find((v) => v && typeof v === 'object' && v._s instanceof Map)
  if (!pinia) return 'no-pinia'
  window.__N = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), app }
  return 'ok'
})()`

const SNAP = `JSON.stringify({
  slot: window.luminAPI.app.sessionSlot,
  root: window.__N.files().root ?? null,
  doc: window.__N.files().current?.path ?? null,
  name: window.__N.files().current?.name ?? null,
  dirty: !!window.__N.files().dirty,
  banner: !!document.querySelector('.draft-modal'),
  bannerText: document.querySelector('.draft-modal')?.textContent?.trim() ?? null,
  treeRows: document.querySelectorAll('aside [data-tree-row]').length
})`

async function pages() {
  return (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
}

async function attach(page) {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if ((await c.ev(SETUP).catch(() => 'err')) === 'ok') break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}

/** 真实 Ctrl+N（渲染层命令表 file.new）。注入按键前必须把目标窗口抬到前台，
 *  否则 CDP 的输入会落到当前前台窗口上（多窗口下踩过）。 */
async function pressCtrlN(w) {
  await w.send('Page.bringToFront').catch(() => {})
  await sleep(400)
  for (const type of ['rawKeyDown', 'keyUp']) {
    await w.send('Input.dispatchKeyEvent', {
      type,
      key: 'n',
      code: 'KeyN',
      windowsVirtualKeyCode: 78,
      modifiers: 2
    })
    await sleep(30)
  }
  await sleep(250)
}

/** Alt+F 打开文件菜单 → 点指定文案的条目（与 _verify-new-window-clean.js 同一路径） */
async function clickFileMenuItem(w, label) {
  await w.send('Page.bringToFront').catch(() => {})
  await sleep(400)
  for (const type of ['rawKeyDown', 'keyUp']) {
    await w.send('Input.dispatchKeyEvent', {
      type,
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      modifiers: 1
    })
  }
  await sleep(400)
  const pos = await w.ev(`(() => {
    const p = document.querySelector('.topmenu-drop.fixed')
    if (!p) return null
    const btn = [...p.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)})
    if (!btn) return JSON.stringify({ found: false, items: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()) })
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (!pos) throw new Error('文件菜单没有打开')
  const info = JSON.parse(pos)
  if (!info.found) throw new Error('菜单里找不到「' + label + '」: ' + JSON.stringify(info.items))
  await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y, button: 'none' })
  await sleep(60)
  await w.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await sleep(40)
  await w.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
}

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // ── 静态核对（原生另存为对话框没法自动作答，与 _verify-save-as-workspace.js 同口径）──
  const actionsSrc = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/composables/useAppActions.ts'),
    'utf8'
  )
  const newBlock = actionsSrc.slice(
    actionsSrc.indexOf('export async function newDocumentWindow'),
    actionsSrc.indexOf('export function useAppActions')
  )
  const filesSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/stores/files.ts'), 'utf8')
  const saveBlock = filesSrc.slice(filesSrc.indexOf('async save()'), filesSrc.indexOf('async saveAs'))
  const saveAsBlock = filesSrc.slice(filesSrc.indexOf('async saveAs'), filesSrc.indexOf('async reopenWithEncoding'))
  console.log('NEW-BLOCK ' + newBlock.replace(/\s+/g, ' ').slice(0, 220))
  c(
    'static-new-opens-window-same-folder',
    /openFolderInNewWindow\(root\)/.test(newBlock) && /app\.newWindow\(\)/.test(newBlock),
    'expect 有工作区→openFolderInNewWindow(root)，无工作区→newWindow()'
  )
  c(
    'static-new-does-not-create-file-in-workspace',
    !/newDocInWorkspace/.test(newBlock) && !/createFileAt/.test(newBlock),
    '「新建」不该再往工作区里造文件'
  )
  c(
    'static-save-without-path-goes-to-save-as',
    /if \(!this\.current\.path\) \{\s*return this\.saveAs\(\)/.test(saveBlock),
    saveBlock.replace(/\s+/g, ' ').slice(0, 160)
  )
  c(
    'static-save-as-asks-where',
    /chooseSaveFile/.test(saveAsBlock),
    '另存为必须弹「保存到哪」对话框'
  )
  // §4.48：对话框默认落在哪 —— 渲染层把「未命名→侧栏工作区 / 已有路径→它自己的文件夹」
  // 这个目录交给主进程，主进程再拼成 defaultPath（原生对话框没法自动作答，故分两半核对）
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'src/main/ipc.ts'), 'utf8')
  c(
    'static-save-as-passes-default-dir',
    /const dir = this\.current\.path \? this\.currentDir : this\.root/.test(saveAsBlock) &&
      /chooseSaveFile\(name, 'md', dir\)/.test(saveAsBlock),
    saveAsBlock.replace(/\s+/g, ' ').slice(0, 200)
  )
  c(
    'static-main-joins-dir-and-name',
    /defaultPath = dir && existsSync\(dir\) \? path\.join\(dir, name\) : name/.test(ipcSrc),
    '主进程要用 defaultPath = join(dir, name)，目录不存在时退回只给文件名'
  )

  // ── 夹具：一个工作区 + 一篇打开的文档 ──
  const WS = path.join(os.tmpdir(), 'lumin-newdoc-ws')
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  const A = path.join(WS, 'a.md')
  fs.writeFileSync(A, '# a\n\n已有文档\n', 'utf-8')

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const seen = new Set(all.map((p) => p.id))
  const w1 = await attach(all[0])
  const extras = []
  const freshWindow = async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const p = (await pages()).find((x) => !seen.has(x.id))
      if (p) {
        seen.add(p.id)
        const w = await attach(p)
        extras.push(w)
        await sleep(900)
        return w
      }
    }
    return null
  }

  try {
    // 种一份「无主草稿」（写它的窗口早就不在了）：三个入口开出来的窗口都不该被它打断（§4.49）
    const orphanFile = DRAFTS_DIR ? path.join(DRAFTS_DIR, 'untitled-orphan.json') : null
    if (orphanFile) {
      fs.mkdirSync(DRAFTS_DIR, { recursive: true })
      fs.writeFileSync(
        orphanFile,
        JSON.stringify({
          key: 'untitled-orphan',
          path: null,
          content: '上次没保存的内容',
          savedAt: Date.now(),
          ownerUid: 'a-window-that-is-long-gone'
        }),
        'utf-8'
      )
    } else {
      console.log('SKIP: 未提供 LUMIN_DRAFTS_DIR（跳过「无主草稿不打断新建窗口」那一节）')
    }

    await w1.ev(`(async () => { const f = window.__N.files(); await f.setRoot(${JSON.stringify(WS)}); await f.openPath(${JSON.stringify(A)}); return 'ok' })()`)
    await sleep(1200)
    const before = JSON.parse(await w1.ev(SNAP))
    c('prepared-window', before.root === WS && before.doc === A, JSON.stringify(before))

    // ── ① 顶部栏那个独立按钮已收回（§4.50），「新建」改到文件菜单第一项 ──
    const bar = await w1.ev(`(() => {
      const el = document.querySelector('[data-topbar-action="new"]')
      const barBtns = [...document.querySelectorAll('.topmenu-root > button')].map((b) => b.textContent.trim())
      return JSON.stringify({ staleButton: !!el, barBtns })
    })()`)
    console.log('TOPBAR ' + bar)
    c('topbar-button-removed', JSON.parse(bar).staleButton === false, bar)
    // 打开文件菜单，核对「新建」是第一项、且没有重复的「新建文档」
    const newLabel = await w1.ev(`window.__N.app.config.globalProperties.$t('menu.new')`)
    const items = await w1.ev(`(() => {
      const btns = [...document.querySelectorAll('.topmenu-root > button')]
      const f = btns.find((b) => (b.textContent || '').trim() === window.__N.app.config.globalProperties.$t('menu.file'))
      if (!f) return 'null'
      f.click()
      return 'ok'
    })()`)
    await sleep(400)
    const menuItems = JSON.parse(
      await w1.ev(
        `JSON.stringify([...document.querySelectorAll('.topmenu-drop:not(.topmenu-sub) button')].map((b) => (b.textContent || '').trim()))`
      )
    )
    await w1.ev(`(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'ok' })()`)
    await sleep(300)
    console.log('FILE-MENU ' + JSON.stringify(menuItems))
    c('file-menu-first-item-is-new', items === 'ok' && menuItems[0] === newLabel, JSON.stringify({ first: menuItems[0], newLabel }))
    c(
      'file-menu-has-single-new-entry',
      menuItems.filter((x) => x === newLabel).length === 1 && !menuItems.includes('新建文档'),
      JSON.stringify(menuItems)
    )

    // 真实点这条菜单项 → 新窗口
    await clickFileMenuItem(w1, newLabel)
    const n1 = await freshWindow()
    const s1 = n1 ? JSON.parse(await n1.ev(SNAP)) : null
    console.log('VIA-MENU-NEW ' + JSON.stringify(s1))
    c('menu-new-opens-new-window', !!n1 && s1.slot !== before.slot, JSON.stringify({ before: before.slot, after: s1?.slot }))
    c('menu-new-keeps-same-folder', s1?.root === WS && s1.treeRows > 0, JSON.stringify(s1))
    c('menu-new-doc-untitled', s1?.doc === null && /^Untitled-\d+\.md$/.test(String(s1?.name)), JSON.stringify(s1))

    // ── ② Ctrl+N ──
    await pressCtrlN(w1)
    const n2 = await freshWindow()
    const s2 = n2 ? JSON.parse(await n2.ev(SNAP)) : null
    console.log('VIA-CTRL-N ' + JSON.stringify(s2))
    c('ctrl-n-opens-new-window', !!n2 && s2.slot !== s1?.slot, JSON.stringify({ prev: s1?.slot, now: s2?.slot }))
    c('ctrl-n-same-folder', s2?.root === WS && s2.treeRows > 0, JSON.stringify(s2))
    c('ctrl-n-doc-untitled', s2?.doc === null && /^Untitled-\d+\.md$/.test(String(s2?.name)), JSON.stringify(s2))

    // ── ③ 再来一次文件 → 新建（确认入口可反复用；s3 供后续「另存为默认目录」一节使用）──
    await clickFileMenuItem(w1, newLabel)
    const n3 = await freshWindow()
    const s3 = n3 ? JSON.parse(await n3.ev(SNAP)) : null
    console.log('VIA-MENU-NEW-2 ' + JSON.stringify(s3))
    c('menu-new-works-repeatedly', !!n3 && s3.slot !== s2?.slot, JSON.stringify({ prev: s2?.slot, now: s3?.slot }))

    // ── ③b 每个入口开出来的窗口都不该被「上一次没保存的内容」打断（§4.49；用户报的 bug）──
    c(
      'no-new-window-shows-draft-banner',
      [s1, s2, s3].every((s) => s?.banner === false),
      JSON.stringify({
        firstMenu: s1?.banner,
        ctrlN: s2?.banner,
        secondMenu: s3?.banner,
        seededOrphan: !!orphanFile,
        text: s1?.bannerText ?? s2?.bannerText ?? s3?.bannerText ?? null
      })
    )

    // ── ④ 原窗口与磁盘都没被碰 ──
    const after = JSON.parse(await w1.ev(SNAP))
    c('current-window-untouched', after.doc === A && after.root === WS, JSON.stringify(after))
    const wsFiles = fs.readdirSync(WS).sort()
    console.log('WS-FILES ' + JSON.stringify(wsFiles))
    c('no-file-created-on-disk', JSON.stringify(wsFiles) === JSON.stringify(['a.md']), JSON.stringify(wsFiles))

    // ── ⑤ 未命名 ⇒ Ctrl+S 要问保存到哪（path=null 是前提；save()→saveAs()→chooseSaveFile 已静态核对）──
    const gate = JSON.parse(await n3.ev(`(() => {
      const f = window.__N.files()
      return JSON.stringify({ noPath: !f.current?.path, name: f.current?.name ?? null })
    })()`))
    console.log('SAVE-GATE ' + JSON.stringify(gate))
    c('untitled-save-goes-through-save-as', gate.noPath === true, JSON.stringify(gate))

    // ── ⑥ 对话框默认落在哪（§4.48）：未命名 → 侧栏工作区；已有路径 → 它自己的文件夹 ──
    // 断言的是渲染层**交给对话框的那个目录**（saveAs 里 `current.path ? currentDir : root`）；
    // 主进程把它拼成 defaultPath 的那一行已静态核对。
    const dirUntitled = await n3.ev(
      `(() => { const f = window.__N.files(); return f.current?.path ? f.currentDir : f.root })()`
    )
    c(
      'untitled-save-defaults-to-sidebar-folder',
      dirUntitled === WS,
      JSON.stringify({ dir: dirUntitled, root: s3?.root })
    )
    const SUB = path.join(WS, 'sub')
    fs.mkdirSync(SUB, { recursive: true })
    const C = path.join(SUB, 'c.md')
    fs.writeFileSync(C, '# c\n\n子目录里的文档\n', 'utf-8')
    await w1.ev(`(async () => { await window.__N.files().openPath(${JSON.stringify(C)}); return 'ok' })()`)
    await sleep(1000)
    const dirExisting = await w1.ev(
      `(() => { const f = window.__N.files(); return f.current?.path ? f.currentDir : f.root })()`
    )
    c(
      'existing-save-defaults-to-own-folder',
      dirExisting === SUB,
      JSON.stringify({ dir: dirExisting, want: SUB })
    )
  } finally {
    for (const w of extras) await w.send('Page.close').catch(() => {})
    await sleep(1200)
    await w1.ev(`(async () => { const f = window.__N.files(); f.close(); await f.setRoot(null); return 'ok' })()`).catch(() => {})
    // 收尾：本套件种下的无主草稿（以及 w1 自己那份）都清掉，别留给下一次运行
    await w1.ev(
      `(async () => { await window.luminAPI.drafts.remove('untitled-orphan'); await window.luminAPI.drafts.remove('untitled-' + (window.luminAPI.app.sessionSlot ?? 0)); return 'ok' })()`
    ).catch(() => {})
    await sleep(400)
    fs.rmSync(WS, { recursive: true, force: true })
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)
  w1.ws.close()
  if (failed) process.exit(1)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
