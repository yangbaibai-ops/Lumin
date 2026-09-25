// 验收：文件编码（判定链 / 每文件记忆 / 重新打开 / 按编码保存 / 设置与菜单入口）
//
// 覆盖：
//  A. 解码：UTF-8、UTF-8 BOM、UTF-16LE(BOM)、GBK、Shift_JIS、Windows-1251
//  B. 重新打开：先用 windows-1252 打开 GBK 文件（乱码）→ reopenWithEncoding('gbk') 恢复且文档干净
//  B2. 乱码缓冲区**不许落盘**（用户报障「切回原编码内容变了」的数据损坏路径）：
//      重新解释后自动保存跳过 + 提醒一次；手动保存先弹确认，取消不写、确定才写
//  C. 保存回写：GBK 文件保存后字节仍是 GBK；UTF-8 BOM 文件保存后 BOM 还在
//  D. 设置生效：同一串字节（C4 E3 BA C3）在 gbk / windows-1252 下解出不同文本；设置确实落库
//  E. 菜单：一级「选择编码重新打开」+ 二级全编码列表 + 当前编码被标记 + 真实点击切换
//  F. i18n：三个语言文件里 key 齐全；切到 en-US 菜单标题跟着变
//  G. 状态栏显示当前编码
//
// 用法：先跑 tools/start-isolated.ps1；本套件不 import /src/...，两种都行
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const iconv = require('iconv-lite')

const PORT = 9222
const REPO = path.resolve(__dirname, '..')
const USER_DATA =
  process.env.LUMIN_ISOLATED_USERDATA || path.join(os.tmpdir(), 'lumin-keymap-userdata')
const DB_PATH = process.env.LUMIN_DB || path.join(USER_DATA, 'lumin.db')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等一个选择器出现（默认 4s）。
 *
 * 为什么必须有：本套件多处是"点一下 → sleep(500) → 查 DOM"，而顶部菜单/二级浮层的渲染
 * 在机器忙时会慢过这个固定等待 —— 表现是 `document.querySelector('.topmenu-sub')` 为 null，
 * 紧接着 `.querySelectorAll` 抛异常，整条套件以 **0/0** 收场（实测 1/3 概率，看起来像代码坏了）。
 * 固定 sleep 永远压不住这类抖动，"等条件"才可以。
 */
async function waitForSelector(w, sel, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const ok = await w.ev(`!!document.querySelector(${JSON.stringify(sel)})`).catch(() => false)
    if (ok) return true
    if (Date.now() > end) return false
    await sleep(120)
  }
}

// ─── 夹具文本（各语言都放一点，确保不是 ASCII 蒙对）──────────────────────────
const T_UTF8 = '# 你好，UTF-8\n\n正文 content 一行。\n'
const T_GBK = '# 中文 GBK 测试\n\n这是 GBK 编码的正文，含标点：你好，世界。\n'
const T_UTF16 = '# UTF-16LE 文本\n\n这段是 UTF-16LE（带 BOM）保存的。\n'
const T_SJIS = '# 日本語テスト\n\nこれは Shift_JIS の本文です。\n'
const T_1251 = '# Русский тест\n\nЭто текст в кодировке Windows-1251.\n'
/** 同一串字节：GBK 解出「你好」，Windows-1252 解出「ÃãºÃ」 */
const AMBIG_BYTES = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
const AMBIG_GBK = '你好'
const AMBIG_1252 = 'ÄãºÃ'
/** 「点错编码」看到的样子：把 GBK 字节按 windows-1252 解 —— B2 段要用它做缓冲区内容 */
const T_GBK_MOJIBAKE = iconv.decode(iconv.encode(T_GBK, 'gbk'), 'windows-1252')

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

function connect(url, timeoutMs = 6000) {
  let id = 0
  const pending = new Map()
  const ws = new WebSocket(url)
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('connect timeout')), timeoutMs)
    ws.onopen = () => {
      clearTimeout(t)
      res()
    }
    ws.onerror = (e) => {
      clearTimeout(t)
      rej(e instanceof Error ? e : new Error('ws error'))
    }
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params, timeoutMs2 = 20000) =>
    new Promise((res) => {
      const i = ++id
      const t = setTimeout(() => {
        pending.delete(i)
        res({ timedOut: true })
      }, timeoutMs2)
      pending.set(i, (m) => {
        clearTimeout(t)
        res(m)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.timedOut) throw new Error('evaluate timeout')
    if (r.result?.exceptionDetails)
      throw new Error(
        'EXC ' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 200)
      )
    return r.result?.result?.value
  }
  return { ws, ready, send, ev }
}

/** 页面里的桥：pinia 用鸭子类型找（生产构建里 Symbol(pinia) 没有描述） */
const SETUP = `(() => {
  const app = document.querySelector('#app')?.__vue_app__
  if (!app) return 'no-app'
  const prov = app._context.provides
  const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
  const pinia = (sym ? prov[sym] : null) ?? Object.getOwnPropertySymbols(prov).map((s) => prov[s]).find((v) => v && typeof v === 'object' && v._s instanceof Map)
  if (!pinia) return 'no-pinia'
  window.__E = {
    files: () => pinia._s.get('files'),
    settings: () => pinia._s.get('settings'),
    ui: () => pinia._s.get('ui')
  }
  return 'ok'
})()`

;(async () => {
  const results = []
  /**
   * 记一条结果。`extra` 以 `SKIP` 开头 = 这项在当前构建下**测不了**而不是失败：
   * 典型情况是「生产构建里拿不到组件 setupState 的内部状态」——同一行为都有 DOM 断言
   * （`dom-*` 项）覆盖，把它们算成 FAIL 会让矩阵长期红着、真回归反而被淹没。
   */
  const c = (n, cond, extra) => {
    const skipped = typeof extra === 'string' && extra.startsWith('SKIP')
    results.push(
      (skipped ? 'SKIP' : cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : '')
    )
  }

  const pages = (await get('/json/list')).filter((t) => t.type === 'page')
  if (!pages.length) {
    console.log('SKIP: 没有可用窗口（先跑 tools/start-isolated.ps1）')
    process.exit(2)
  }
  const w = connect(pages[0].webSocketDebuggerUrl)
  await w.ready
  await w.send('Page.enable')
  await w.send('Page.bringToFront')
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (
      (await w.ev(SETUP)) === 'ok' &&
      (await w.ev(`window.__E.ui().booting ? 'booting' : 'ready'`)) === 'ready'
    )
      break
  }
  if ((await w.ev(SETUP)) !== 'ok') throw new Error('pinia bridge not available')

  // ── 夹具：直接用 Node 按各编码写盘 ──
  const dir = path.join(os.tmpdir(), 'lumin-encoding-ws')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const F = {
    utf8: path.join(dir, 'plain-utf8.md'),
    utf8bom: path.join(dir, 'bom-utf8.md'),
    gbk: path.join(dir, 'gbk.md'),
    utf16: path.join(dir, 'utf16le.md'),
    sjis: path.join(dir, 'sjis.md'),
    win1251: path.join(dir, 'win1251.md'),
    ambig: path.join(dir, 'ambiguous.md')
  }
  fs.writeFileSync(F.utf8, Buffer.from(T_UTF8, 'utf-8'))
  fs.writeFileSync(
    F.utf8bom,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(T_UTF8, 'utf-8')])
  )
  fs.writeFileSync(F.gbk, iconv.encode(T_GBK, 'gbk'))
  fs.writeFileSync(
    F.utf16,
    Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(T_UTF16, 'utf16le')])
  )
  fs.writeFileSync(F.sjis, iconv.encode(T_SJIS, 'shift_jis'))
  fs.writeFileSync(F.win1251, iconv.encode(T_1251, 'windows-1251'))
  fs.writeFileSync(F.ambig, AMBIG_BYTES)

  /**
   * 套件里没人能点对话框：默认把 `ui.confirm` 换成固定回答 —— 与本套件无关的保存路径
   * 一旦弹确认框就会把整轮挂死（`await` 永远不返回）。B2 段要测**真**对话框时临时还原，测完换回来。
   */
  const stubConfirm = (answer) =>
    w.ev(
      `(() => { const ui = window.__E.ui(); if (!window.__REAL_CONFIRM) window.__REAL_CONFIRM = ui.confirm; ui.confirm = async () => ${answer ? 'true' : 'false'}; return 'ok' })()`
    )
  const useRealConfirm = () =>
    w.ev(
      `(() => { const ui = window.__E.ui(); if (window.__REAL_CONFIRM) ui.confirm = window.__REAL_CONFIRM; return 'ok' })()`
    )
  /** 通知是落库的：用前后差集看「这次动作新发了哪条」，历史通知不会干扰断言 */
  const NOTIF_SNAP = `(async () => JSON.stringify((await window.luminAPI.notifications.list({ includeClosed: true })).map((n) => n.level + '|' + n.title)))()`
  const ZH = JSON.parse(fs.readFileSync(path.join(REPO, 'src/shared/i18n/zh-CN.json'), 'utf-8'))

  try {
    // 工作区设到夹具目录（侧栏树/编码无关，但 openPath 走文件 API，不需要工作区）
    await w.ev(
      `(async () => { await window.__E.files().openUntitled(); await window.__E.files().setRoot(${JSON.stringify(dir)}); return 'ok' })()`
    )
    await sleep(900)
    await stubConfirm(true)

    /** 打开文件并把编码一起读出来 */
    const open = async (p) => {
      const ok = await w.ev(
        `(async () => await window.__E.files().openPath(${JSON.stringify(p)}))()`
      )
      await sleep(500)
      const info = JSON.parse(
        await w.ev(
          `(() => { const cur = window.__E.files().current; return JSON.stringify(cur ? { content: cur.content, encoding: cur.encoding, hadBom: cur.hadBom } : null) })()`
        )
      )
      return { ok, ...(info ?? {}) }
    }
    /** 指定编码直接读（走 file:read 的显式分支） */
    const readAs = async (p, enc) =>
      JSON.parse(
        await w.ev(
          `(async () => { const r = await window.luminAPI.file.read(${JSON.stringify(p)}, ${JSON.stringify(enc)}); return JSON.stringify({ content: r.content, encoding: r.encoding, hadBom: r.hadBom }) })()`
        )
      )

    // ── A. 解码 ──
    const a1 = await open(F.utf8)
    console.log(
      'A-utf8 ' + JSON.stringify({ enc: a1.encoding, hadBom: a1.hadBom, ok: a1.content === T_UTF8 })
    )
    c(
      'auto-utf8-plain',
      a1.content === T_UTF8 && a1.encoding === 'utf-8',
      JSON.stringify({ enc: a1.encoding })
    )

    const a2 = await open(F.utf8bom)
    console.log(
      'A-utf8bom ' +
        JSON.stringify({ enc: a2.encoding, hadBom: a2.hadBom, ok: a2.content === T_UTF8 })
    )
    c(
      'auto-utf8-bom',
      a2.content === T_UTF8 && a2.encoding === 'utf-8-bom' && a2.hadBom === true,
      JSON.stringify({ enc: a2.encoding, hadBom: a2.hadBom })
    )

    const a3 = await open(F.utf16)
    console.log(
      'A-utf16le ' +
        JSON.stringify({ enc: a3.encoding, hadBom: a3.hadBom, ok: a3.content === T_UTF16 })
    )
    c(
      'auto-utf16le-bom',
      a3.content === T_UTF16 && a3.encoding === 'utf-16le' && a3.hadBom === true,
      JSON.stringify({ enc: a3.encoding })
    )

    // GBK：中文系统下允许自动判成 gb18030（GBK 的超集），但正文必须正确
    const a4 = await open(F.gbk)
    console.log('A-gbk ' + JSON.stringify({ enc: a4.encoding, ok: a4.content === T_GBK }))
    c(
      'auto-gbk-text-correct',
      a4.content === T_GBK,
      JSON.stringify({ enc: a4.encoding, got: a4.content.slice(0, 12) })
    )
    c(
      'auto-gbk-encoding-superset-ok',
      a4.encoding === 'gbk' || a4.encoding === 'gb18030',
      String(a4.encoding)
    )

    // Shift_JIS / Windows-1251：没有 BOM 也不是合法 UTF-8 时，自动判定不可能猜准（见报告），
    // 所以这里用显式编码打开 —— 这正是「选择编码重新打开」存在的意义
    const a5 = await readAs(F.sjis, 'shift_jis')
    console.log('A-sjis ' + JSON.stringify({ enc: a5.encoding, ok: a5.content === T_SJIS }))
    c(
      'explicit-shift_jis',
      a5.content === T_SJIS && a5.encoding === 'shift_jis',
      JSON.stringify({ enc: a5.encoding })
    )
    const a6 = await readAs(F.win1251, 'windows-1251')
    console.log('A-win1251 ' + JSON.stringify({ enc: a6.encoding, ok: a6.content === T_1251 }))
    c(
      'explicit-windows-1251',
      a6.content === T_1251 && a6.encoding === 'windows-1251',
      JSON.stringify({ enc: a6.encoding })
    )

    // ── A2. 显式选择必须压过 BOM ──
    // 否则对带 BOM 的文件，「选择编码重新打开」点了等于没反应（看着像坏了）。
    const x1 = await readAs(F.utf8bom, 'windows-1252')
    console.log(
      'A2-explicit-over-bom ' +
        JSON.stringify({ enc: x1.encoding, hadBom: x1.hadBom, unchanged: x1.content === T_UTF8 })
    )
    c(
      'explicit-choice-beats-bom',
      x1.encoding === 'windows-1252' && x1.hadBom === false && x1.content !== T_UTF8,
      JSON.stringify({ enc: x1.encoding, hadBom: x1.hadBom })
    )

    // 显式选「UTF-8」= 顺手去掉 BOM（正文里不能留 U+FEFF，保存后文件头也不该再有 BOM）
    await w.ev(
      `(async () => { await window.__E.files().openPath(${JSON.stringify(F.utf8bom)}); return 'ok' })()`
    )
    await sleep(500)
    const x2 = await w.ev(
      `(async () => { const ok = await window.__E.files().reopenWithEncoding('utf-8'); const cur = window.__E.files().current; return JSON.stringify({ ok, content: cur.content, encoding: cur.encoding, hadBom: cur.hadBom, dirty: window.__E.files().dirty }) })()`
    ).then(JSON.parse)
    console.log(
      'A2-reopen-utf8 ' +
        JSON.stringify({ enc: x2.encoding, hadBom: x2.hadBom, dirty: x2.dirty, bait: x2.content.charCodeAt(0) })
    )
    c(
      'explicit-utf8-strips-bom',
      x2.ok === true &&
        x2.content === T_UTF8 &&
        x2.encoding === 'utf-8' &&
        x2.hadBom === false &&
        x2.content.charCodeAt(0) !== 0xfeff,
      JSON.stringify({ enc: x2.encoding, hadBom: x2.hadBom, first: x2.content.charCodeAt(0) })
    )
    await w.ev(`(async () => { return await window.__E.files().save() })()`)
    await sleep(900)
    const noBom = fs.readFileSync(F.utf8bom)
    console.log('A2-save-no-bom ' + JSON.stringify({ first3: [...noBom.subarray(0, 3)] }))
    c(
      'save-after-explicit-utf8-drops-bom',
      !(noBom[0] === 0xef && noBom[1] === 0xbb && noBom[2] === 0xbf) &&
        noBom.toString('utf-8') === T_UTF8,
      JSON.stringify({ first3: [...noBom.subarray(0, 3)] })
    )
    // 把夹具还原成「带 BOM」原样：后面 C 段还要验「保存保留 BOM」
    fs.writeFileSync(F.utf8bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(T_UTF8, 'utf-8')]))
    // 记录也要一起还原：上面两次**显式**试读（windows-1252 / utf-8）会把每文件编码记录改掉，
    // 而 Wave 2 尾巴之后「该文件的记录 > 设置里的默认编码」——C 段依赖它被当成 BOM 文件打开
    await w.ev(
      `(async () => { await window.luminAPI.file.rememberEncoding(${JSON.stringify(F.utf8bom)}, 'utf-8-bom'); return 'ok' })()`
    )
    await sleep(200)

    // ── B. 重新打开（乱码 → 正确，且文档保持干净）──
    const b1 = await open(F.gbk) // 先自动打开（正确）
    const b2 = await readAs(F.gbk, 'windows-1252') // 显式按 1252 解 → 乱码
    await w.ev(
      `(async () => { await window.__E.files().openPath(${JSON.stringify(F.gbk)}); return 'ok' })()`
    )
    await sleep(400)
    // 让它按 1252 重新打开（模拟用户点错编码）
    await w.ev(
      `(async () => { await window.__E.files().reopenWithEncoding('windows-1252'); return 'ok' })()`
    )
    await sleep(600)
    const garbled = JSON.parse(
      await w.ev(
        `(() => { const cur = window.__E.files().current; return JSON.stringify({ content: cur.content, encoding: cur.encoding, dirty: window.__E.files().dirty }) })()`
      )
    )
    console.log(
      'B-garbled ' +
        JSON.stringify({
          enc: garbled.encoding,
          isGarbage: garbled.content !== T_GBK,
          head: garbled.content.slice(0, 8)
        })
    )
    c(
      'reopen-wrong-encoding-looks-garbled',
      garbled.content !== T_GBK && garbled.encoding === 'windows-1252',
      JSON.stringify({ enc: garbled.encoding })
    )

    const fixed = await w.ev(`(async () => await window.__E.files().reopenWithEncoding('gbk'))()`)
    await sleep(600)
    const after = JSON.parse(
      await w.ev(
        `(() => { const cur = window.__E.files().current; return JSON.stringify({ content: cur.content, encoding: cur.encoding, dirty: window.__E.files().dirty, saved: cur.savedContent === cur.content }) })()`
      )
    )
    console.log(
      'B-fixed ' +
        JSON.stringify({
          returned: fixed,
          enc: after.encoding,
          ok: after.content === T_GBK,
          dirty: after.dirty
        })
    )
    c(
      'reopen-with-gbk-restores-text',
      after.content === T_GBK && after.encoding === 'gbk',
      JSON.stringify({ enc: after.encoding })
    )
    c(
      'reopen-leaves-document-clean',
      after.dirty === false && after.saved === true,
      JSON.stringify({ dirty: after.dirty, saved: after.saved })
    )

    // ── B3. 重新打开**不发通知**（用户口径：以其他编码打开时不要弹提示）──
    // 重新解释的结果**当场可见**（正文变了、状态栏那个编码格变了、菜单里当前编码打了勾），
    // 与 `stores/ui.ts` 里「动作结果在界面上已经可见的常规成功一律不发通知」是同一条口径。
    // 这里用通知库的前后差集证明「确实一条都没发」—— 而不是「我没看见有弹窗」。
    const notifBeforeReopen = JSON.parse(await w.ev(NOTIF_SNAP))
    await w.ev(
      `(async () => { await window.__E.files().reopenWithEncoding('windows-1252'); return 'ok' })()`
    )
    await sleep(700)
    const freshReopenNotifs = JSON.parse(await w.ev(NOTIF_SNAP)).filter(
      (x) => !notifBeforeReopen.includes(x)
    )
    console.log('B3-reopen-notify ' + JSON.stringify(freshReopenNotifs))
    c(
      'reopen-with-encoding-emits-no-notification',
      freshReopenNotifs.length === 0,
      JSON.stringify(freshReopenNotifs)
    )

    // ── B2. 「重新解释过的缓冲区」不许自动落盘（用户报障的数据损坏路径）──
    // 用户口径：切到 GBK 内容确实变了，但再切回 UTF-8 时显示的**不是**原来那份文字。
    // 实测：来回切本身是无损的（B 段已证），丢掉内容的是**中间有一次写盘** ——
    // 乱码缓冲区被自动保存（或顺手 Ctrl+S）盖回磁盘，之后再切回原编码读到的就是这份坏数据。
    // 所以这里就测那条写盘路径：假设用户点错编码（1252）看到乱码 → 继续编辑 → 落盘必须被拦住。
    await w.ev(`(() => { window.__E.settings().set('language', 'zh-CN'); return 'ok' })()`)
    await sleep(300)
    const autoSaveWas = await w.ev(`window.__E.settings().autoSave`)
    const autoSaveIntervalWas = await w.ev(`window.__E.settings().autoSaveInterval`)
    const pristinGbk = iconv.encode(T_GBK, 'gbk')
    const EDITED_GARBAGE = T_GBK_MOJIBAKE + '\n乱码期间又敲了一行。\n'

    // 点错编码：1252 解 GBK 字节 → 乱码（文档自身仍然「干净」，磁盘也还没被动过）
    await w.ev(
      `(async () => { await window.__E.files().reopenWithEncoding('windows-1252'); return 'ok' })()`
    )
    await sleep(600)
    const wrongEnc = JSON.parse(
      await w.ev(
        `(() => { const f = window.__E.files(); return JSON.stringify({ enc: f.current.encoding, content: f.current.content, garbled: f.current.content !== ${JSON.stringify(T_GBK)}, flag: f.reopenedWithEncoding === true }) })()`
      )
    )
    console.log('B2-wrong-encoding ' + JSON.stringify(wrongEnc))
    c(
      'reopen-remembers-it-was-reinterpreted',
      wrongEnc.enc === 'windows-1252' && wrongEnc.garbled === true && wrongEnc.flag === true,
      JSON.stringify({ enc: wrongEnc.enc, garbled: wrongEnc.garbled, flag: wrongEnc.flag })
    )
    c(
      'wrong-encoding-decode-matches-1252-bytes',
      wrongEnc.content === T_GBK_MOJIBAKE,
      JSON.stringify({ head: wrongEnc.content.slice(0, 10) })
    )

    // ① 乱码 + 继续编辑 + 自动保存开着 → 一个字节都不许写盘，并提醒用户一次
    await w.ev(
      `(() => { window.__E.settings().set('autoSave', true); window.__E.settings().set('autoSaveInterval', 1); return 'ok' })()`
    )
    await sleep(300)
    const notifBefore = JSON.parse(await w.ev(NOTIF_SNAP))
    await w.ev(
      `(() => { window.__E.files().setContent(${JSON.stringify(EDITED_GARBAGE)}); return 'ok' })()`
    )
    await sleep(2000)
    const afterAuto = JSON.parse(
      await w.ev(
        `(() => { const f = window.__E.files(); return JSON.stringify({ dirty: f.dirty, flag: f.reopenedWithEncoding === true, enc: f.current.encoding }) })()`
      )
    )
    const autoBytes = fs.readFileSync(F.gbk)
    // 提醒里写的是**当前这份缓冲区是按哪个编码解出来的**（此刻就是用户点错的那个）
    const warnTitle = ZH.toast.encodingReopenAutoSaveSkipped.replace('{enc}', 'Windows-1252')
    const newNotifs = JSON.parse(await w.ev(NOTIF_SNAP)).filter((x) => !notifBefore.includes(x))
    console.log(
      'B2-autosave ' +
        JSON.stringify({ ...afterAuto, bytesIntact: autoBytes.equals(pristinGbk), newNotifs })
    )
    c(
      'auto-save-skipped-after-encoding-reopen',
      autoBytes.equals(pristinGbk),
      JSON.stringify({ bytes: autoBytes.length, intact: autoBytes.equals(pristinGbk) })
    )
    c(
      'auto-save-skip-warns-user',
      newNotifs.includes('warning|' + warnTitle),
      JSON.stringify(newNotifs)
    )
    c(
      'unsaved-edit-still-pending-after-skip',
      afterAuto.dirty === true && afterAuto.flag === true,
      JSON.stringify(afterAuto)
    )

    // 提醒只发一次：再敲一次仍然不写盘，但不再刷屏
    await w.ev(
      `(() => { window.__E.files().setContent(${JSON.stringify(EDITED_GARBAGE + '再敲一下。\n')}); return 'ok' })()`
    )
    await sleep(2000)
    const warnedTwice = JSON.parse(await w.ev(NOTIF_SNAP)).filter((x) => x === 'warning|' + warnTitle)
    console.log('B2-warn-once ' + JSON.stringify({ warnCount: warnedTwice.length }))
    c('auto-save-skip-warns-once', warnedTwice.length === 1, String(warnedTwice.length))
    c(
      'auto-save-still-skipped-on-second-edit',
      fs.readFileSync(F.gbk).equals(pristinGbk),
      'ok'
    )
    await w.ev(
      `(() => { window.__E.settings().set('autoSave', ${JSON.stringify(autoSaveWas)}); window.__E.settings().set('autoSaveInterval', ${JSON.stringify(autoSaveIntervalWas)}); return 'ok' })()`
    )
    await sleep(300)

    // ② 手动保存：必须先问一次；**取消就一个字节都不写**（flag 仍然武装着）
    await useRealConfirm()
    await w.ev(
      `(() => { window.__SAVE = 'pending'; void window.__E.files().save().then((v) => { window.__SAVE = v }); return 'started' })()`
    )
    let dlg = null
    for (let i = 0; i < 30 && !dlg; i++) {
      await sleep(120)
      dlg = JSON.parse(
        await w.ev(
          `(() => { const s = window.__E.ui().confirmState; if (!s) return 'null'; const hs = [...document.querySelectorAll('h3')].map((h) => (h.textContent || '').trim()); return JSON.stringify({ title: s.title, body: s.body, danger: !!s.danger, domTitles: hs, pending: window.__SAVE }) })()`
        )
      )
    }
    console.log('B2-confirm-cancel ' + JSON.stringify(dlg))
    c(
      'manual-save-after-reopen-asks-first',
      !!dlg &&
        dlg.danger === true &&
        dlg.title === ZH.editor.saveAfterReopenTitle &&
        dlg.domTitles.includes(ZH.editor.saveAfterReopenTitle) &&
        dlg.body.includes('Windows-1252'),
      JSON.stringify({
        title: dlg?.title,
        danger: dlg?.danger,
        hasEnc: dlg?.body?.includes('Windows-1252')
      })
    )
    c(
      'save-waits-for-user-answer',
      !!dlg && dlg.pending === 'pending',
      JSON.stringify(dlg && { pending: dlg.pending })
    )
    await w.ev(`(() => { window.__E.ui().resolveConfirm(false); return 'ok' })()`)
    let saveResult = null
    for (let i = 0; i < 20 && saveResult === null; i++) {
      await sleep(120)
      saveResult = await w.ev(`window.__SAVE`)
    }
    const afterCancel = JSON.parse(
      await w.ev(
        `(() => { const f = window.__E.files(); return JSON.stringify({ dirty: f.dirty, flag: f.reopenedWithEncoding === true }) })()`
      )
    )
    console.log('B2-cancel ' + JSON.stringify({ saveResult, ...afterCancel }))
    c('cancel-save-does-not-write', saveResult === false && fs.readFileSync(F.gbk).equals(pristinGbk), JSON.stringify({ saveResult }))
    c(
      'cancel-keeps-guard-armed',
      afterCancel.dirty === true && afterCancel.flag === true,
      JSON.stringify(afterCancel)
    )

    // ③ 用户改回正确编码、确认要写：这时才允许落盘，且写下去的必须**就是用户看到的那份文字**
    //    （注意：写盘用的是**当前编码**。上一步的乱码缓冲区若真被写下去，盘上会变回原始字节 ——
    //     「看着变了、切回来却对得上」正是这个原因的一体两面，所以这里必须切回 gbk 再验。）
    //    切编码本身对**脏**文档还会先问一次「放弃未保存的修改」—— 那一步先自动同意。
    await stubConfirm(true)
    await w.ev(
      `(async () => { await window.__E.files().reopenWithEncoding('gbk'); return 'ok' })()`
    )
    await sleep(600)
    await w.ev(
      `(() => { window.__E.files().setContent(${JSON.stringify(T_GBK + '\n确认后保存的一行。\n')}); return 'ok' })()`
    )
    await sleep(700)
    await useRealConfirm()
    const preWrite = await w.ev(`window.__E.files().current.content`)
    await w.ev(
      `(() => { window.__SAVE = 'pending'; void window.__E.files().save().then((v) => { window.__SAVE = v }); return 'started' })()`
    )
    let dlg2 = null
    for (let i = 0; i < 30 && !dlg2; i++) {
      await sleep(120)
      dlg2 = JSON.parse(
        await w.ev(
          `(() => { const s = window.__E.ui().confirmState; return JSON.stringify(s ? { title: s.title, body: s.body } : null) })()`
        )
      )
    }
    if (dlg2) await w.ev(`(() => { window.__E.ui().resolveConfirm(true); return 'ok' })()`)
    let confirmed = null
    for (let i = 0; i < 40 && confirmed === null; i++) {
      await sleep(120)
      confirmed = await w.ev(`window.__SAVE`)
    }
    await sleep(400)
    const wroteBytes = fs.readFileSync(F.gbk)
    // 当前编码是 gbk → 盘上的字节要按 gbk 解回「屏幕上那份文字」
    const wroteText = iconv.decode(wroteBytes, 'gbk')
    const afterConfirm = JSON.parse(
      await w.ev(
        `(() => { const f = window.__E.files(); return JSON.stringify({ dirty: f.dirty, flag: f.reopenedWithEncoding === true, enc: f.current.encoding }) })()`
      )
    )
    console.log(
      'B2-confirm ' +
        JSON.stringify({
          asked: !!dlg2,
          confirmed,
          wroteHead: wroteText.slice(0, 12),
          sameAsBuffer: wroteText === preWrite,
          overWrotePristine: !wroteBytes.equals(pristinGbk),
          ...afterConfirm
        })
    )
    c(
      'confirm-dialog-names-current-encoding',
      !!dlg2 && dlg2.body.includes('GBK'),
      JSON.stringify({ body: dlg2?.body?.slice(0, 40) })
    )
    c(
      'confirm-save-writes-what-user-sees',
      !!dlg2 &&
        confirmed === true &&
        wroteText === preWrite &&
        wroteText.includes('确认后保存的一行。') &&
        !wroteBytes.equals(pristinGbk),
      JSON.stringify({ asked: !!dlg2, confirmed, sameAsBuffer: wroteText === preWrite })
    )
    c(
      'confirm-clears-guard',
      afterConfirm.flag === false && afterConfirm.dirty === false,
      JSON.stringify(afterConfirm)
    )

    // ④ 确认过一次之后不该再问（只在「刚重新解释过」之后问一次）
    await w.ev(
      `(() => { window.__SAVE = 'pending'; void window.__E.files().save().then((v) => { window.__SAVE = v }); return 'started' })()`
    )
    await sleep(900)
    const secondSave = JSON.parse(
      await w.ev(
        `(() => JSON.stringify({ result: window.__SAVE, asking: !!window.__E.ui().confirmState }))()`
      )
    )
    console.log('B2-second-save ' + JSON.stringify(secondSave))
    c(
      'second-save-does-not-ask-again',
      secondSave.result === true && secondSave.asking === false,
      JSON.stringify(secondSave)
    )
    // 后面的段落（C/D/E）照旧：确认框换成自动同意，避免任何一处把整轮挂死
    await stubConfirm(true)

    // ── C. 保存回写 ──
    const newGbkText = T_GBK + '\n追加一行 new line。\n'
    await w.ev(
      `(async () => { const f = window.__E.files(); f.current.content = ${JSON.stringify(newGbkText)}; const ok = await f.save(); return ok })()`
    )
    await sleep(900)
    const gbkBytes = fs.readFileSync(F.gbk)
    const gbkRound = iconv.decode(gbkBytes, 'gbk')
    console.log(
      'C-gbk-save ' +
        JSON.stringify({
          bytes: gbkBytes.length,
          roundTrip: gbkRound === newGbkText,
          isUtf8: gbkBytes.equals(Buffer.from(newGbkText, 'utf-8'))
        })
    )
    c(
      'save-keeps-gbk-bytes',
      gbkRound === newGbkText && !gbkBytes.equals(Buffer.from(newGbkText, 'utf-8')),
      JSON.stringify({ bytes: gbkBytes.length })
    )
    c('save-gbk-roundtrip-equal', iconv.decode(gbkBytes, 'gbk') === newGbkText, 'ok')

    // UTF-8 BOM：改一下再存，BOM 必须还在
    const newBomText = T_UTF8 + '\n再补一行。\n'
    await w.ev(
      `(async () => { await window.__E.files().openPath(${JSON.stringify(F.utf8bom)}); return 'ok' })()`
    )
    await sleep(500)
    await w.ev(
      `(async () => { const f = window.__E.files(); f.current.content = ${JSON.stringify(newBomText)}; const ok = await f.save(); return ok })()`
    )
    await sleep(900)
    const bomBytes = fs.readFileSync(F.utf8bom)
    const hasBom = bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf
    console.log(
      'C-bom-save ' +
        JSON.stringify({ hasBom, textOk: bomBytes.subarray(3).toString('utf-8') === newBomText })
    )
    c(
      'save-keeps-utf8-bom',
      hasBom && bomBytes.subarray(3).toString('utf-8') === newBomText,
      JSON.stringify({ hasBom })
    )

    // ── D. 设置生效：同一串字节在两种编码下解出不同文本 ──
    await w.ev(`(() => { window.__E.settings().set('defaultEncoding', 'gbk'); return 'ok' })()`)
    await sleep(700)
    const d1 = await open(F.ambig)
    console.log('D-gbk ' + JSON.stringify({ enc: d1.encoding, content: d1.content }))
    c(
      'default-encoding-gbk-applies',
      d1.content === AMBIG_GBK && d1.encoding === 'gbk',
      JSON.stringify({ content: d1.content })
    )

    await w.ev(
      `(() => { window.__E.settings().set('defaultEncoding', 'windows-1252'); return 'ok' })()`
    )
    await sleep(700)
    // 上一行已经把这个文件的编码「记」下来了（gbk）。Wave 2 尾巴之后的优先级是：
    //   **显式指定 > 该文件的记录（对"软默认"生效） > 自动判定链**
    // 所以这里先证明「记录优先」——同一份字节在默认编码改成 1252 后仍然按 gbk 解出来；
    // 再清掉记录，证明「没有记录时，设置里的默认编码确实生效」。
    const d2 = await open(F.ambig)
    console.log('D-1252 ' + JSON.stringify({ enc: d2.encoding, content: d2.content }))
    c(
      'per-file-record-beats-default-setting',
      d2.encoding === 'gbk' && d2.content === d1.content,
      JSON.stringify({ enc: d2.encoding, content: d2.content })
    )

    await w.ev(`(async () => { await window.luminAPI.db.deleteDocument(${JSON.stringify(F.ambig)}) ; return 'ok' })()`)
    await sleep(300)
    const d3 = await open(F.ambig)
    console.log('D-1252-fresh ' + JSON.stringify({ enc: d3.encoding, content: d3.content }))
    c(
      'default-encoding-1252-applies',
      d3.content === AMBIG_1252 && d3.encoding === 'windows-1252' && d3.content !== d1.content,
      JSON.stringify({ enc: d3.encoding, content: d3.content })
    )

    // 设置与每文件记忆都要真的落库（node:sqlite 直读隔离实例的 DB）
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const kv = (k) => {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(k)
      return row ? row.value : null
    }
    const stored = JSON.parse(kv('settings') ?? '{}')
    // Wave 2 起「每文件编码记忆」的**权威来源是 documents 表**（跟着文件走、跨窗口一致），
    // kv 的 fileEncodings 只留作「文件还没进索引」时兜底。所以两条都要查。
    const kvMemory = JSON.parse(kv('fileEncodings') ?? '{}')
    const docEncodings = db.prepare('SELECT path, encoding FROM documents').all()
    db.close()
    const memoryKeys = [
      ...Object.keys(kvMemory),
      ...docEncodings.map((r) => String(r.path).toLowerCase())
    ]
    console.log(
      'D-db ' +
        JSON.stringify({
          defaultEncoding: stored.defaultEncoding,
          kvMemoryKeys: Object.keys(kvMemory).length,
          docEncodings: docEncodings.length
        })
    )
    c(
      'setting-persisted-in-sqlite',
      stored.defaultEncoding === 'windows-1252',
      String(stored.defaultEncoding)
    )
    c(
      'per-file-memory-recorded',
      memoryKeys.some((k) => k.endsWith('ambiguous.md')) ||
        memoryKeys.some((k) => k.endsWith('gbk.md')),
      JSON.stringify(memoryKeys.slice(0, 6))
    )

    // ── E. 菜单结构 + 真实点击 ──
    // 回到 auto，并打开 GBK 文件（后面验证「当前编码被标记」用它）
    await w.ev(`(() => { window.__E.settings().set('defaultEncoding', 'auto'); return 'ok' })()`)
    await sleep(600)
    await w.ev(
      `(async () => { await window.__E.files().reopenWithEncoding('gbk'); return 'ok' })()`
    )
    await sleep(600)

    const menuProbe = `(() => {
      const btns = [...document.querySelectorAll('button')]
      const fileBtn = btns.find((b) => /文件\\(F\\)|File\\(F\\)/.test(b.textContent || ''))
      if (!fileBtn) return JSON.stringify({ err: 'no-file-button' })
      let inst = fileBtn.__vueParentComponent
      let groups = null
      for (let i = 0; inst && i < 8 && !groups; i++) {
        if (inst.setupState?.GROUPS) groups = inst.setupState.GROUPS
        inst = inst.parent
      }
      if (!groups) return JSON.stringify({ err: 'GROUPS not reachable' })
      const g = (groups.value ?? groups).find((x) => x.key === 'f')
      const sub = g.items.find((it) => it && it.labelKey === 'menu.reopenWithEncoding')
      if (!sub) return JSON.stringify({ err: 'no-encoding-submenu', labels: g.items.map((i) => (i && (i.labelKey || i.label)) || i) })
      const kids = sub.children.filter((k) => k !== 'sep')
      return JSON.stringify({
        ok: true,
        count: kids.length,
        labels: kids.map((k) => k.label || k.labelKey),
        active: kids.filter((k) => k.active).map((k) => k.label || k.labelKey)
      })
    })()`
    const menu = JSON.parse(await w.ev(menuProbe))
    console.log('E-menu ' + JSON.stringify(menu))
    // 注意：`<script setup>` 的绑定只在**开发构建**里挂到 setupState 上（Vue 生产构建不暴露），
    // 所以 setupState 拿不到时退回 DOM 证据（下面 E-submenu 那组行就是同一件事的实测）。
    if (menu.ok === true) {
      c('menu-has-reopen-with-encoding', true, 'via setupState')
      c('menu-lists-all-encodings', menu.count === 14, JSON.stringify({ count: menu.count }))
      c(
        'menu-marks-current-encoding',
        menu.active?.length === 1 && menu.active[0] === 'GBK',
        JSON.stringify(menu.active)
      )
    } else {
      c(
        'menu-has-reopen-with-encoding',
        false,
        'SKIP setupState: ' + JSON.stringify(menu) + '（改用 DOM 断言，见下方 dom-* 项）'
      )
      c('menu-lists-all-encodings', false, 'SKIP setupState')
      c('menu-marks-current-encoding', false, 'SKIP setupState')
    }

    // 真实打开菜单 → 悬停二级 → 点一个编码
    const rectOf = async (selector) =>
      JSON.parse(
        await w.ev(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`
        )
      )
    const fileBtnRect = JSON.parse(
      await w.ev(
        `(() => { const b = [...document.querySelectorAll('button')].find((x) => /文件\\(F\\)|File\\(F\\)/.test(x.textContent || '')); const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`
      )
    )
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fileBtnRect.x,
      y: fileBtnRect.y
    })
    await w.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: fileBtnRect.x,
      y: fileBtnRect.y,
      button: 'left',
      clickCount: 1
    })
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: fileBtnRect.x,
      y: fileBtnRect.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(500)
    // 一级行：按 data 找不到，就用「导出」同款结构里的文本找
    const openSub = await w.ev(`(() => {
      const rows = [...document.querySelectorAll('.topmenu-drop button')]
      const row = rows.find((b) => /选择编码重新打开|Reopen with Encoding/.test(b.textContent || ''))
      if (!row) return 'no-row'
      const r = row.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
    let subItems = []
    if (openSub !== 'no-row') {
      const r = JSON.parse(openSub)
      await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
      await sleep(600)
      subItems = JSON.parse(
        await w.ev(
          `(() => { const sub = document.querySelector('.topmenu-sub'); if (!sub) return 'null'; return JSON.stringify([...sub.querySelectorAll('button')].map((b) => ({ text: (b.textContent || '').trim(), active: b.className.includes('bg-accent-soft'), hasCheck: !!b.querySelector('svg') }))) })()`
        )
      )
    }
    console.log('E-submenu ' + JSON.stringify(subItems))
    const domRows = Array.isArray(subItems) ? subItems.length : 0
    const domActive = Array.isArray(subItems)
      ? subItems.filter((x) => x.active).map((x) => x.text)
      : []
    // DOM 侧断言：与 setupState 那三条问的是同一件事，这里是真实渲染出来的结果
    c('dom-submenu-has-reopen-encoding', domRows > 0, JSON.stringify({ rows: domRows }))
    c('dom-submenu-lists-all-encodings', domRows === 14, JSON.stringify({ rows: domRows }))
    c(
      'dom-submenu-highlights-current',
      domActive.length === 1 && domActive[0] === 'GBK',
      JSON.stringify(domActive)
    )
    c(
      'dom-submenu-marks-with-check',
      Array.isArray(subItems) && subItems.filter((x) => x.active && x.hasCheck).length === 1,
      JSON.stringify(
        subItems?.filter((x) => x.active)?.map((x) => ({ t: x.text, check: x.hasCheck }))
      )
    )

    // 二级浮层必须被**视口内可达**：14 项 ≈ 480px，文件菜单又在上面 —— 只钳 top 会让最后几行
    // 渲染到窗口外面（用户点不到、自动化点不到）。修法是钳高度 + 内部滚动（TopMenuBar.placeSub）。
    const clamped = await w.ev(
      `(() => { const s = document.querySelector('.topmenu-sub'); if (!s) return 'null'; const r = s.getBoundingClientRect(); return JSON.stringify({ bottom: Math.round(r.bottom), inner: window.innerHeight, scrollable: s.scrollHeight > s.clientHeight + 1 }) })()`
    )
    console.log('E-clamp ' + clamped)
    c('submenu-clamped-to-viewport', clamped !== 'null' && JSON.parse(clamped).bottom <= JSON.parse(clamped).inner, clamped)

    // 真实点击「Windows-1252」那一行 → 文档编码应随之变化
    // （先 scrollIntoView：二级可能被钳成可滚动面板，目标行不一定在首屏）
    // ⚠️ 这里原先直接 `sub.querySelectorAll`：二级浮层没渲染出来时 `sub` 为 null，
    // 整条套件会以 `TypeError: ... reading 'querySelectorAll'` 崩掉、报 0/0（机器忙时实测 1/3 概率）。
    // 固定 sleep 等渲染永远不够稳，改成"先等元素 + 显式返回原因"。
    await waitForSelector(w, '.topmenu-sub', 4000)
    const clickTarget = JSON.parse(
      await w.ev(
        `(() => { const sub = document.querySelector('.topmenu-sub'); if (!sub) return '{"err":"no-submenu"}'; const b = [...sub.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Windows-1252')); if (!b) return '{"err":"no-item"}'; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), visible: r.top >= 0 && r.bottom <= window.innerHeight }) })()`
      )
    )
    console.log('E-target ' + JSON.stringify(clickTarget))
    c('submenu-item-clickable', clickTarget.visible === true, JSON.stringify(clickTarget))
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: clickTarget.x,
      y: clickTarget.y
    })
    await sleep(150)
    await w.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: clickTarget.x,
      y: clickTarget.y,
      button: 'left',
      clickCount: 1
    })
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: clickTarget.x,
      y: clickTarget.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(1000)
    const afterClick = JSON.parse(
      await w.ev(
        `(() => { const cur = window.__E.files().current; return JSON.stringify({ enc: cur.encoding, isGarbage: cur.content !== ${JSON.stringify(T_GBK)} }) })()`
      )
    )
    console.log('E-click ' + JSON.stringify(afterClick))
    c(
      'submenu-click-switches-encoding',
      afterClick.enc === 'windows-1252' && afterClick.isGarbage === true,
      JSON.stringify(afterClick)
    )

    // 收尾：把文档调回正确的 GBK，别留个乱码文档
    await w.ev(
      `(async () => { await window.__E.files().reopenWithEncoding('gbk'); return 'ok' })()`
    )
    await sleep(500)

    // ── F. i18n ──
    // 注意：这里**不再**列 `toast.reopenedWithEncoding` —— 用户口径「以其他编码打开不弹提示」
    // 之后那条文案连同 key 一起删了（三个语言包同时删，保持平齐；B3 段断言确实一条通知都不发）。
    const KEYS = [
      ['encoding', 'auto'],
      ['menu', 'reopenWithEncoding'],
      ['settings', 'encodingHint'],
      ['settings', 'defaultEncoding'],
      ['toast', 'encodingReopenAutoSaveSkipped'],
      // 「按 xx 编码重新打开失败」改成带 {reason} 占位符的那条（拼接中文全角冒号在
      // en/ru 里是错的）；「还没落盘」是另一种失败，另有编码（toast.encodingNotSaved）。
      // 原来的 settings.encoding / toast.encodingFailed 已随 i18n 死键清理删除。
      ['toast', 'encodingFailedDetail'],
      ['toast', 'encodingNotSaved'],
      ['statusbar', 'encodingTooltip']
    ]
    for (const loc of ['zh-CN', 'en-US', 'ru-RU']) {
      const json = JSON.parse(
        fs.readFileSync(path.join(REPO, 'src/shared/i18n', loc + '.json'), 'utf-8')
      )
      const missing = KEYS.filter(([g, k]) => !json[g] || json[g][k] === undefined).map(
        ([g, k]) => `${g}.${k}`
      )
      c(`i18n-${loc}-has-all-keys`, missing.length === 0, missing.join(',') || 'ok')
    }
    // 切到英文，菜单标题应随之变化（重新点开菜单再读 DOM —— 点完编码后菜单已收起）
    await w.ev(`(() => { window.__E.settings().set('language', 'en-US'); return 'ok' })()`)
    await sleep(900)
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fileBtnRect.x,
      y: fileBtnRect.y
    })
    await w.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: fileBtnRect.x,
      y: fileBtnRect.y,
      button: 'left',
      clickCount: 1
    })
    await w.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: fileBtnRect.x,
      y: fileBtnRect.y,
      button: 'left',
      clickCount: 1
    })
    await sleep(500)
    const enRows = JSON.parse(
      await w.ev(
        `(() => { const rows = [...document.querySelectorAll('.topmenu-drop button')]; return JSON.stringify(rows.map((b) => (b.textContent || '').trim())) })()`
      )
    )
    console.log('F-en-rows ' + JSON.stringify(enRows))
    c(
      'i18n-menu-title-follows-language',
      enRows.some((x) => /Reopen with Encoding/.test(x)),
      JSON.stringify(enRows.filter((x) => /Reopen|Encoding/.test(x)))
    )
    // 关掉菜单，切回中文
    await w.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await w.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await w.ev(`(() => { window.__E.settings().set('language', 'zh-CN'); return 'ok' })()`)
    await sleep(700)

    // ── G. 状态栏显示当前编码 ──
    const statusEnc = await w.ev(
      `(() => { const el = document.querySelector('[data-status-encoding]'); return el ? (el.textContent || '').trim() + '|' + (el.getAttribute('title') || '') : 'missing' })()`
    )
    console.log('G-status ' + JSON.stringify(statusEnc))
    c(
      'statusbar-shows-encoding',
      typeof statusEnc === 'string' && statusEnc.includes('GBK'),
      String(statusEnc)
    )
    c(
      'statusbar-has-tooltip',
      typeof statusEnc === 'string' &&
        statusEnc.includes('|') &&
        statusEnc.split('|')[1].length > 4,
      String(statusEnc).split('|')[1] ?? ''
    )
  } finally {
    // 隔离实例里的东西清掉：关闭当前文档，避免影响后续套件
    await w.ev(`(async () => { await window.__E.files().close(); return 'ok' })()`).catch(() => {})
    await sleep(200)
  }

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  const skipped = results.filter((r) => r.startsWith('SKIP')).length
  const considered = results.length - skipped
  console.log(`TOTAL ${results.length} PASS ${considered - failed} FAIL ${failed} SKIP ${skipped}`)
  console.log(`--- ${considered - failed}/${considered} PASS`)
  w.ws.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('ERROR', e.message)
  process.exit(1)
})
