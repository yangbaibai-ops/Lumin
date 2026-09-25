// 验收：草稿横幅只在该出现的时候出现（「检测到未保存的草稿」假阳性回归）
//
// 背景：旧实现 ① 无条件写草稿（干净/空的未命名缓冲区也写盘）② 未命名草稿全应用共用一个
// 'untitled' 键。于是「每次新开窗口 / 打开空白文档」都会冒出一条内容为空的草稿横幅。
//
// 断言：
//   ① 干净的空白缓冲区：不写草稿、不弹横幅；
//   ② 旧版遗留的空 untitled 草稿：不弹横幅，并被清掉；
//   ③ 真有未保存内容：写草稿 → 重开空白缓冲区 → 横幅出现（未命名文案）→ 恢复可取回正文；
//   ④ 干净文件不留草稿；「内容与磁盘相同」的草稿（旧版留下的）也不弹横幅；
//   ⑤ 确实比磁盘新的文件草稿 → 弹横幅，用「文件」文案；
//   ⑥ 多窗口：A 窗口有未保存的未命名正文时，新建窗口的空白缓冲区不得冒出来（草稿按窗口隔离）；
//   ⑦ 无主草稿（别的窗口/上次运行留下）仍能被空白缓冲区认领 —— 数据安全不回退；
//   ⑧ 重启（reload）后：干净的空白缓冲区不再冒横幅；真有未保存正文时横幅照旧出现且可取回。
//
// 跑法：用**独立 userData** 起实例（不碰用户正在用的窗口/数据）：
//   $env:LUMIN_DEBUG_PORT='9222'; $env:LUMIN_DRAFTS_DIR="$env:TEMP\lumin-draft-userdata\drafts"
//   npx electron . --user-data-dir=$env:TEMP\lumin-draft-userdata
// LUMIN_DRAFTS_DIR 可选：给了就能直接核对盘上的草稿文件（停放行为），不给则跳过那一节。
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

const DRAFTS_DIR = process.env.LUMIN_DRAFTS_DIR || ''

/**
 * 草稿键 → 盘上的文件名。
 *
 * ⚠️ 这里**故意重复**主进程的命名规则（`src/main/drafts.ts` 的 `keyToFile`）：
 * 本套件要断言的是"盘上真的出现了/真的没有那份文件"，所以必须知道文件叫什么。
 * 规则本身也是本轮改动的一部分：文件名从"把键里非字母数字折叠成 `_`"改成
 * **sha1(键) 前 16 位** —— 旧的折叠写法会让 `a b.md` 与 `a_20b.md` 撞成同一个文件，
 * 后写的草稿覆盖先写的（两份文档的未保存内容互相顶掉）。改规则本身有断言守着，见本文件 ⑧。
 */
const draftFile = (key) =>
  path.join(DRAFTS_DIR, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`)

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
    if (r.result && r.result.exceptionDetails)
      throw new Error('EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const sym = Object.getOwnPropertySymbols(app._context.provides).find((s) => { const p = app._context.provides[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = app._context.provides[sym]
  window.__vt = { files: () => pinia._s.get('files'), ui: () => pinia._s.get('ui'), app }
  return 'ok'
})()`

const SNAP = `JSON.stringify({
  slot: window.luminAPI.app.sessionSlot,
  docName: window.__vt.files().current?.name ?? null,
  banner: !!document.querySelector('.draft-modal'),
  bannerText: document.querySelector('.draft-modal')?.textContent?.trim() ?? null,
  draftContent: window.__vt.files().draftRestore?.content ?? null
})`

async function pages() {
  return (await get('/json/list')).filter((t) => t.type === 'page' && /index\.html|5173/.test(t.url))
}

async function attach(page) {
  const c = connect(page.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  for (let j = 0; j < 80; j++) {
    await sleep(250)
    if (
      (await c.ev(SETUP)) === 'ok' &&
      (await c.ev(`window.__vt.ui().booting ? 'booting' : 'ready'`)) === 'ready'
    )
      break
  }
  await c.ev(SETUP)
  c.id = page.id
  return c
}

const snap = async (w) => JSON.parse(await w.ev(SNAP))

/**
 * 等「草稿弹窗从 DOM 里消失」。
 *
 * 为什么不能只 sleep 后直接断言：弹窗外层包着 `<Transition name="fade">`，
 * `v-if` 变假之后节点要等**离场过渡结束**（transitionend）才被移除，而离场过渡挂在**帧**上 ——
 * 窗口被别的窗口挡住时 Chromium 会暂停出帧，transitionend 永远不来，节点就一直留在 DOM 里
 * （实测：本套件 ③④ 与「booting 抑制弹窗」三条会因此假红，`draftRestore` 早已是 null）。
 * 这里用两件事压掉它：**强制一帧**（截屏会让渲染器无条件出一帧）＋ 轮询。
 */
async function waitModalGone(w, ms = 2500) {
  const end = Date.now() + ms
  for (;;) {
    await w.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 }).catch(() => {})
    const gone = !(await w.ev(`!!document.querySelector('.draft-modal')`))
    if (gone) return true
    if (Date.now() > end) return false
    await sleep(120)
  }
}

/** 本窗口的未命名草稿键（与 store 的规则一致） */
const ownKey = `'untitled-' + (window.luminAPI.app.sessionSlot ?? 0)`
/** 让空白缓冲区重走一遍「打开未命名文档」的路径（等价于新开一个空白窗口/重新启动） */
const reopenBlank = `(async () => { await window.__vt.files().openUntitled(); return 'ok' })()`
const loadOwn = `window.luminAPI.drafts.load(${ownKey})`
/** 造一份草稿（filePath 给了才是一份「文件草稿」，未命名草稿传 null） */
const saveDraft = (keyExpr, content, filePath = null) =>
  `window.luminAPI.drafts.save(${keyExpr}, ${JSON.stringify(content)}, ${
    filePath === null ? 'null' : filePath
  })`

;(async () => {
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))

  // 一次性工作区（不碰用户数据）
  const WS = path.join(os.tmpdir(), 'lumin-draft-ws')
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  const FILE = path.join(WS, 'note.md')
  const FILE_BODY = '# note\n\nhello\n'
  fs.writeFileSync(FILE, FILE_BODY)
  // 磁盘时间戳压到 1 分钟前：⑤ 里「草稿比磁盘新」才是个确定的结论（不受套件快慢影响）
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(FILE, past, past)
  const FILE_KEY = `'file-' + encodeURIComponent(${JSON.stringify(FILE)}.toLowerCase())`

  const all = await pages()
  if (!all.length) {
    console.log('SKIP: 没有可用窗口')
    return
  }
  const seen = new Set(all.map((p) => p.id))
  const w1 = await attach(all[0])
  let w2 = null

  try {
    // 复位：本套件可以被反复跑（清掉自己窗口的未命名草稿，重新开一个空白缓冲区）
    await w1.ev(
      `(async () => { const f = window.__vt.files(); await f.close(); await window.luminAPI.drafts.remove(${ownKey}); await window.luminAPI.drafts.remove('untitled'); await f.openUntitled(); return 'ok' })()`
    )
    await sleep(300)

    // ① 干净的空白缓冲区：不写草稿、不弹横幅
    await w1.ev(reopenBlank)
    await w1.ev(`(async () => { await window.__vt.files().writeDraft(); return 'ok' })()`)
    await sleep(300)
    const clean = await snap(w1)
    const cleanDraft = await w1.ev(loadOwn)
    c(
      'clean-blank-no-banner',
      clean.banner === false && clean.draftContent === null,
      JSON.stringify(clean)
    )
    c('clean-blank-writes-no-draft', cleanDraft === null, JSON.stringify(cleanDraft))

    // ② 旧版遗留的空 untitled 草稿（用户实际盘上那份）：不弹横幅，且被清掉
    await w1.ev(saveDraft(`'untitled'`, ''))
    await w1.ev(reopenBlank)
    await sleep(300)
    const legacy = await snap(w1)
    const legacyLeft = await w1.ev(`window.luminAPI.drafts.load('untitled')`)
    c(
      'empty-legacy-draft-no-banner',
      legacy.banner === false && legacy.draftContent === null,
      JSON.stringify(legacy)
    )
    c('empty-legacy-draft-cleaned', legacyLeft === null, JSON.stringify(legacyLeft))

    // ③ 真有未保存内容：写草稿 → 重开空白缓冲区 → 横幅（未命名文案）→ 恢复可取回
    await w1.ev(`window.__vt.files().setContent('# hello draft')`)
    await w1.ev(`(async () => { await window.__vt.files().writeDraft(); return 'ok' })()`)
    const wroteDraft = await w1.ev(loadOwn)
    c('dirty-blank-writes-draft', wroteDraft?.content === '# hello draft', JSON.stringify(wroteDraft))
    await w1.ev(reopenBlank)
    await sleep(400)
    const pending = await snap(w1)
    const untitledLabel = await w1.ev(
      `window.__vt.app.config.globalProperties.$t('editor.restoreDraftUntitled')`
    )
    c('dirty-blank-shows-banner', pending.banner === true, JSON.stringify(pending))
    c(
      'untitled-banner-uses-untitled-wording',
      !!pending.bannerText && pending.bannerText.includes(untitledLabel),
      JSON.stringify({ text: pending.bannerText, label: untitledLabel })
    )
    // ★ 本轮新口径：提示改成**独立弹窗**且是强制的 —— 不选就不能继续编辑这个文档。
    //   这里真的往编辑器里打字（先聚焦渲染面/源码面），文档内容必须一个字都没变；
    //   Esc 也不能把弹窗关掉（必须明确选恢复或丢弃）。
    const beforeType = await w1.ev(`window.__vt.files().current?.content`)
    await w1.ev(`(() => {
      const el = document.querySelector('.ProseMirror') || document.querySelector('textarea.source-editor')
      if (el) el.focus()
      return 'ok'
    })()`)
    await w1.send('Input.insertText', { text: 'BLOCKED' })
    await w1.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', text: 'x' })
    await w1.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x' })
    await sleep(250)
    await w1.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await w1.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await sleep(250)
    const afterType = await w1.ev(`window.__vt.files().current?.content`)
    c(
      'modal-blocks-editing-until-chosen',
      afterType === beforeType,
      JSON.stringify({ beforeType, afterType })
    )
    c('modal-esc-does-not-close', (await snap(w1)).banner === true, 'Esc 不该关掉它')

    await w1.ev(`(async () => { await window.__vt.files().applyDraftRestore(true); return 'ok' })()`)
    await sleep(300)
    const restored = await w1.ev(`window.__vt.files().current?.content`)
    const afterRestore = await snap(w1)
    // 判据按语义比：序列化会把 markdown 规整成「结尾带换行」（`# hello draft` → `# hello draft\n`），
    // 这不是丢/多内容。原来用全等，本轮在恢复前多插了一段「尝试打字」的等待，时序一变就撞上规整后的值。
    c(
      'restore-brings-content-back',
      typeof restored === 'string' && restored.replace(/\s+$/, '') === '# hello draft',
      JSON.stringify(restored)
    )
    c(
      'restore-consumes-draft',
      (await waitModalGone(w1)) && (await w1.ev(loadOwn)) === null,
      JSON.stringify(afterRestore)
    )

    // ④ 干净文件不留草稿；「内容与磁盘相同」的草稿也不弹横幅
    await w1.ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(FILE)}); return 'ok' })()`)
    await w1.ev(`(async () => { await window.__vt.files().writeDraft(); return 'ok' })()`)
    const cleanFileDraft = await w1.ev(`window.luminAPI.drafts.load(${FILE_KEY})`)
    c('clean-file-writes-no-draft', cleanFileDraft === null, JSON.stringify(cleanFileDraft))
    // 模拟旧版「关窗时无条件写一份与磁盘相同的草稿」
    await w1.ev(saveDraft(FILE_KEY, FILE_BODY, JSON.stringify(FILE)))
    await w1.ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(FILE)}); return 'ok' })()`)
    await sleep(300)
    const sameFile = await snap(w1)
    c(
      'same-content-file-draft-no-banner',
      sameFile.draftContent === null && (await waitModalGone(w1, 800)),
      JSON.stringify(sameFile)
    )

    // ⑤ 确实比磁盘新的文件草稿 → 弹横幅（文件文案）
    await w1.ev(saveDraft(FILE_KEY, FILE_BODY + '<!-- draft edit -->', JSON.stringify(FILE)))
    await w1.ev(`(async () => { await window.__vt.files().openPath(${JSON.stringify(FILE)}); return 'ok' })()`)
    await sleep(300)
    const filePending = await snap(w1)
    const fileLabel = await w1.ev(
      `window.__vt.app.config.globalProperties.$t('editor.restoreDraft')`
    )
    c('newer-file-draft-shows-banner', filePending.banner === true, JSON.stringify(filePending))
    c(
      'file-banner-uses-file-wording',
      !!filePending.bannerText && filePending.bannerText.includes(fileLabel),
      JSON.stringify({ text: filePending.bannerText, label: fileLabel })
    )
    await w1.ev(`(async () => { await window.__vt.files().applyDraftRestore(false); return 'ok' })()`)
    const discarded = await w1.ev(`window.luminAPI.drafts.load(${FILE_KEY})`)
    c('discard-removes-draft', discarded === null, JSON.stringify(discarded))

    // ⑥ 多窗口：A 有未保存的未命名正文 → 新建窗口的空白缓冲区不得冒出来
    await w1.ev(reopenBlank)
    await w1.ev(`window.__vt.files().setContent('sibling secret')`)
    await w1.ev(`(async () => { await window.__vt.files().writeDraft(); return 'ok' })()`)
    const aKey = await w1.ev(`'untitled-' + window.luminAPI.app.sessionSlot`)
    await w1.ev(`(window.luminAPI.app.newWindow(), 'ok')`)
    for (let i = 0; i < 80; i++) {
      await sleep(300)
      const fresh = (await pages()).find((p) => !seen.has(p.id))
      if (fresh) {
        w2 = await attach(fresh)
        break
      }
    }
    if (!w2) throw new Error('新窗口没有出现')
    seen.add(w2.id)
    await sleep(1000)
    const b = await snap(w2)
    const aDraft = await w1.ev(`window.luminAPI.drafts.load(${JSON.stringify(aKey)})`)
    c('sibling-window-has-no-banner', b.banner === false && b.draftContent === null, JSON.stringify(b))
    c(
      'sibling-draft-untouched',
      aDraft?.content === 'sibling secret',
      JSON.stringify({ key: aKey, draft: aDraft })
    )

    // ⑦ 无主草稿：**新建窗口不能认领，启动窗口才能**（用户报的 bug 就是这条）
    //    语义（§4.49）：草稿要么是「我自己上次写的」（uid 相同，reload 不丢内容），
    //    要么是「无主的」（**写它的窗口已经不在了** / 上一次运行留下的）—— 后者只有**本次运行的
    //    启动窗口**认领。Ctrl+N / 新建窗口是用户明确要一篇空白，冒出「检测到上次未保存的内容」是错的。
    //
    //    构造「无主」状态必须**直接写盘**：经 IPC 种下去的草稿会带上发送窗口的 uid，
    //    而那个窗口还活着 —— 那就不是无主（那条路径由 sibling-draft-untouched 覆盖）。
    const ORPHAN_KEY = 'untitled-9'
    if (!DRAFTS_DIR) {
      console.log('SKIP ⑦: 未提供 LUMIN_DRAFTS_DIR（无法构造「写它的窗口已经不在了」的草稿）')
    } else {
      fs.writeFileSync(
        draftFile(ORPHAN_KEY),
        JSON.stringify({
          key: ORPHAN_KEY,
          path: null,
          content: 'orphan text',
          savedAt: Date.now(),
          ownerUid: 'a-window-that-is-long-gone'
        }),
        'utf-8'
      )
      // (a) 新开的窗口（= Ctrl+N 那条路径）：不该认领，也不该把它吃掉
      await w2.ev(reopenBlank)
      await sleep(500)
      const freshWin = await snap(w2)
      const orphanStill = await w2.ev(`window.luminAPI.drafts.load(${JSON.stringify(ORPHAN_KEY)})`)
      c(
        'new-window-does-not-claim-orphan',
        freshWin.banner === false && freshWin.draftContent === null,
        JSON.stringify(freshWin)
      )
      c(
        'orphan-left-for-startup-window',
        orphanStill?.content === 'orphan text',
        JSON.stringify(orphanStill)
      )
      // (b) 启动窗口（w1）来认领：横幅出现、内容正确、草稿被搬走
      //     先把 w1 自己那份（步骤 ⑥ 写的 'sibling secret'）清掉，回到「启动窗口 + 空白缓冲区」
      await w1.ev(
        `(async () => { const f = window.__vt.files(); await f.close(); await window.luminAPI.drafts.remove(${ownKey}); return 'ok' })()`
      )
      await sleep(300)
      await w1.ev(reopenBlank)
      await sleep(500)
      const claimed = await snap(w1)
      const orphanLeft = await w1.ev(`window.luminAPI.drafts.load(${JSON.stringify(ORPHAN_KEY)})`)
      const w1Own = await w1.ev(loadOwn)
      c(
        'startup-window-claims-orphan',
        claimed.banner === true && claimed.draftContent === 'orphan text',
        JSON.stringify(claimed)
      )
      c(
        'orphan-draft-moved',
        orphanLeft === null && w1Own?.content === 'orphan text',
        JSON.stringify({ orphanLeft, w1Own })
      )
      await w1.ev(`(async () => { await window.__vt.files().applyDraftRestore(false); return 'ok' })()`)
    }

    // ⑦b 槽位复用：自己这一格留着**别人**的正文（uuid 不是我的）→ 不弹横幅、也绝不覆盖它，
    //     先挪到停放键等着被启动窗口认领
    if (DRAFTS_DIR) {
      const w2Slot = await w2.ev(`window.luminAPI.app.sessionSlot`)
      const foreignKey = `untitled-${w2Slot}`
      fs.writeFileSync(
        draftFile(foreignKey),
        JSON.stringify({
          key: foreignKey,
          path: null,
          content: 'previous owner text',
          savedAt: Date.now(),
          ownerUid: 'someone-else'
        }),
        'utf-8'
      )
      await w2.ev(reopenBlank)
      await sleep(500)
      const foreign = await snap(w2)
      const parked = JSON.parse(fs.readFileSync(draftFile('untitled-orphan'), 'utf-8'))
      const ownGone = !fs.existsSync(draftFile(foreignKey))
      c(
        'foreign-draft-not-shown',
        foreign.banner === false && foreign.draftContent === null,
        JSON.stringify(foreign)
      )
      c(
        'foreign-draft-parked-not-overwritten',
        ownGone && parked.content === 'previous owner text',
        JSON.stringify({ ownGone, parked: parked.content })
      )
    } else {
      console.log('SKIP ⑦b: 未提供 LUMIN_DRAFTS_DIR（无法直接核对停放行为）')
    }

    // ⑧ 重启（reload = 渲染进程重跑启动流程，与会话套件同一口径）：
    //    用户报的就是「每次重启/新开窗口都冒出来」，所以这里走真实的关窗落盘 + 重启路径。
    const reload = async (w) => {
      await w.send('Page.reload')
      await sleep(1800)
      await w.ev(SETUP)
      await sleep(600)
    }
    // (a) 干净的空白缓冲区：关窗落盘不写草稿 → 重启后无横幅（旧实现正是在这里每次都写一份空草稿）
    //     顺手把前面几节留下的草稿（自己的 / 停放的 / 历史的）清干净，才叫「干净缓冲区」
    await w1.ev(
      `(async () => { const f = window.__vt.files(); await f.close(); await window.luminAPI.drafts.remove(${ownKey}); await window.luminAPI.drafts.remove('untitled-orphan'); await window.luminAPI.drafts.remove('untitled'); await f.openUntitled(); await f.flushAll(); return 'ok' })()`
    )
    await reload(w1)
    const restartClean = await snap(w1)
    const restartCleanDraft = await w1.ev(loadOwn)
    c(
      'clean-blank-survives-restart-without-banner',
      restartClean.banner === false && restartCleanDraft === null,
      JSON.stringify({ snap: restartClean, draft: restartCleanDraft })
    )
    // (b) 真有未保存的未命名正文：关窗落盘写草稿 → 重启后仍能恢复（数据安全不回退）
    await w1.ev(`window.__vt.files().setContent('close-guard draft')`)
    await w1.ev(`(async () => { await window.__vt.files().flushAll(); return 'ok' })()`)
    await reload(w1)
    const restartDirty = await snap(w1)
    c(
      'dirty-blank-survives-restart-with-banner',
      restartDirty.banner === true && restartDirty.draftContent === 'close-guard draft',
      JSON.stringify(restartDirty)
    )
    await w1.ev(`(async () => { await window.__vt.files().applyDraftRestore(true); return 'ok' })()`)
    c(
      'restart-restore-brings-content-back',
      (await w1.ev(`window.__vt.files().current?.content`)) === 'close-guard draft',
      JSON.stringify(await w1.ev(`window.__vt.files().current?.content`))
    )

    // ★ 启动期间**绝不渲染**草稿弹窗（用户报障：打开应用有概率闪一下草稿提示，<0.5s 就消失）。
    //   现场是两条径抢时序：占位/会话恢复某一条先把 draftRestore 置上，紧接着 openPath 又把它清掉。
    //   现在不赌先后：`ui.booting` 期间弹窗不渲染；booting 落下后草稿若仍在，才出现。
    //   这条直接钉住契约本身，不需要复现那个竞态。
    //
    //   ⚠️ 两次测量之间都要**强制出一帧**（截屏）：弹窗外面那层 `<Transition name="fade">` 的
    //   离场节点要等 transitionend 才被移除，而窗口被遮挡时 Chromium 暂停出帧 —— 不强制就会量到
    //   "上一个状态的残留节点"，把契约本身判红（实测踩过）。
    const frame = () => w1.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
    await w1.ev(`(() => {
      const f = window.__vt.files()
      window.__bootBackup = f.draftRestore
      f.draftRestore = { key: 'boot-gate-probe', path: null, content: 'x', mtimeMs: Date.now() }
      window.__vt.ui().booting = true
      return 'ok'
    })()`)
    await frame()
    await sleep(200)
    const duringBoot = await w1.ev(`!!document.querySelector('.draft-modal')`)
    await w1.ev(`(() => { window.__vt.ui().booting = false; return 'ok' })()`)
    await frame()
    await sleep(200)
    const afterBoot = await w1.ev(`!!document.querySelector('.draft-modal')`)
    await w1.ev(`(() => { window.__vt.files().draftRestore = window.__bootBackup; return 'ok' })()`)
    c(
      'booting-suppresses-draft-modal',
      duringBoot === false && afterBoot === true,
      JSON.stringify({ duringBoot, afterBoot })
    )

    // ⑧ 草稿文件名 = sha1(键)：**两个"折叠后会撞名"的键必须落在不同文件上**
    //    旧规则把键里非 `[A-Za-z0-9_-]` 全折叠成 `_`，于是下面两个键算出来是同一个文件名
    //    （`file-c_3A_2Ftmp_2Fa_20b_md`）—— 两份文档的草稿互相覆盖，丢的是用户没保存过的正文。
    if (DRAFTS_DIR) {
      const k1 = 'file-' + encodeURIComponent('c:/tmp/a b.md')
      const k2 = 'file-' + encodeURIComponent('c:/tmp/a_20b.md')
      await w1.ev(`(async () => {
        await window.luminAPI.drafts.save(${JSON.stringify(k1)}, 'first', null)
        await window.luminAPI.drafts.save(${JSON.stringify(k2)}, 'second', null)
        return 'ok'
      })()`)
      const d1 = JSON.parse(fs.readFileSync(draftFile(k1), 'utf-8'))
      const d2 = JSON.parse(fs.readFileSync(draftFile(k2), 'utf-8'))
      c(
        'draft-file-names-do-not-collide',
        draftFile(k1) !== draftFile(k2) && d1.content === 'first' && d2.content === 'second',
        JSON.stringify({
          same: draftFile(k1) === draftFile(k2),
          first: d1.content,
          second: d2.content
        })
      )
      await w1.ev(`(async () => {
        await window.luminAPI.drafts.remove(${JSON.stringify(k1)})
        await window.luminAPI.drafts.remove(${JSON.stringify(k2)})
        return 'ok'
      })()`)
    }

    // 收尾：把本套件动过的草稿清干净（不碰用户数据之外的东西）
    await w1.ev(`(async () => { await window.luminAPI.drafts.remove(${FILE_KEY}); return 'ok' })()`)
    await w1.ev(
      `(async () => { const f = window.__vt.files(); await f.close(); await window.luminAPI.drafts.remove(${ownKey}); await f.openUntitled(); return 'ok' })()`
    )
    await w2.ev(`(async () => { await window.luminAPI.drafts.remove('untitled-' + (window.luminAPI.app.sessionSlot ?? 0)); return 'ok' })()`)
  } finally {
    if (w2 && w2.ws.readyState === 1) await w2.send('Page.close').catch(() => {})
    await sleep(700)
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
