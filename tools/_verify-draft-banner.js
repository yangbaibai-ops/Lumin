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
  banner: !!document.querySelector('.restore-bar'),
  bannerText: document.querySelector('.restore-bar')?.textContent?.trim() ?? null,
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
    await w1.ev(`(async () => { await window.__vt.files().applyDraftRestore(true); return 'ok' })()`)
    await sleep(300)
    const restored = await w1.ev(`window.__vt.files().current?.content`)
    const afterRestore = await snap(w1)
    c('restore-brings-content-back', restored === '# hello draft', JSON.stringify(restored))
    c(
      'restore-consumes-draft',
      afterRestore.banner === false && (await w1.ev(loadOwn)) === null,
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
      sameFile.banner === false && sameFile.draftContent === null,
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
        path.join(DRAFTS_DIR, `${ORPHAN_KEY}.json`),
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
        path.join(DRAFTS_DIR, `${foreignKey}.json`),
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
      const parked = JSON.parse(
        fs.readFileSync(path.join(DRAFTS_DIR, 'untitled-orphan.json'), 'utf-8')
      )
      const ownGone = !fs.existsSync(path.join(DRAFTS_DIR, `${foreignKey}.json`))
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
