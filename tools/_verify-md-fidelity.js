'use strict'
// ─── 验收：Markdown 往返保真（Wave 1）─────────────────────────────────────────
//
// 要回答的问题（写作工具的信誉底线）：
//   **用户打开一份 .md，动一下再保存，文件会不会变？内容会不会被吃掉？**
//
// 三个层次，从「用户看到的结果」往「实现细节」逐层收窄：
//
//   A. 文档级（**主断言**）：把夹具内容装进真实编辑器 → 触发应用自己的落盘管线
//      （WysiwygEditor 的 flushSync，用 window 的 beforeunload 事件同步触发，见 onWindowBeforeUnload）
//      → 读 files.current.content（= **文档文本**，已经过 markdownStorage.getMarkdown 的
//      收尾规则）→ 用 tools/lib/md-fidelity.js 判 exact / normalized / lossy，
//      与 fixtures/md/EXPECT.json 写明的预期比对：**实际比预期差就是 FAIL**。
//   B. 幂等：把 A 的产出再装回去走一遍，文档文本必须**一字不差**（否则每次保存都漂移，
//      git diff 全是噪声，用户会认为编辑器在改他的文件）。
//   C. 字节级：真开真存（临时目录里的副本），逐项验证
//        · 打开后不改就保存 → 磁盘字节完全不变（含 CRLF / UTF-8 BOM / GB18030 / 文末无换行）
//        · 走一次落盘管线再保存 → 对「本来就是干净 Markdown」的内容字节不变
//      已知未达标项在用例里标了 known，会显示 SKIP 而不是偷偷算通过（修好那天自动变 PASS）。
//
// 为什么文档级断言要绕道 beforeunload：Tiptap 只在 **docChanged** 时发 onUpdate（且还有
// 250ms 防抖），而 onWindowBeforeUnload 里的 flushSync 是同步的、正是「关窗时把最后一段
// 输入落盘」的真实路径 —— 用它当测试入口既确定又不改产品代码。
//
// 跑法（**对着隔离实例**；套件会自己开一个临时窗口，跑完关掉）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-isolated.ps1
//   node tools/_verify-md-fidelity.js
// 诊断：LUMIN_FIDELITY_VERBOSE=1 打印逐行差异；逐份原文/产出落 %TEMP%\lumin-md-fidelity-report.json

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  connect,
  settle,
  waitEditor,
  appPages,
  attach,
  sleep,
  Reporter,
  fatal
} = require('./lib/harness')
const { classify, RULES, worseThan, unifiedDiff } = require('./lib/md-fidelity')

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'md')
const EXPECT = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'EXPECT.json'), 'utf-8'))
const TMP = path.join(os.tmpdir(), 'lumin-md-fidelity')
const DUMP =
  process.env.LUMIN_FIDELITY_DUMP || path.join(os.tmpdir(), 'lumin-md-fidelity-report.json')
const VERBOSE = process.env.LUMIN_FIDELITY_VERBOSE === '1'

/** 触发应用自己的落盘管线（同步），返回文档文本 */
const FLUSH = `(() => {
  window.dispatchEvent(new Event('beforeunload'))
  return window.__L.files().current?.content ?? null
})()`

/** 页面侧：把 markdown 装进编辑器（不惊动 store，便于单独看序列化器产出） */
const loadInto = (md) => `(() => {
  const ed = window.__L.ed()
  if (!ed) return null
  ed.commands.setContent(${JSON.stringify(md)}, { emitUpdate: false })
  return 'ok'
})()`

/** 页面侧：直接取序列化器产出（诊断用，未经文档收尾规则） */
const RAW = `(() => window.__L.ed()?.storage.markdown.getMarkdown() ?? null)()`

/** 字节级用例：真开真存时磁盘字节应当怎么变 */
const BYTE_CASES = [
  {
    name: 'plain-lf',
    file: 'plain-lf.md',
    bytes: Buffer.from('# 标题\n\n正文段落。\n', 'utf-8'),
    noEdit: 'exact',
    edit: 'exact'
  },
  {
    name: 'utf8-bom',
    file: 'bom.md',
    bytes: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# BOM 标题\n\n正文段落。\n', 'utf-8')
    ]),
    noEdit: 'exact',
    edit: 'exact'
  },
  {
    name: 'crlf',
    file: 'crlf.md',
    bytes: Buffer.from('# CRLF 标题\r\n\r\n正文段落。\r\n', 'utf-8'),
    noEdit: 'exact',
    // Wave 2 起行尾是文档级元数据：打开时判定 + 内存归一为 LF + 落盘时展开回去
    edit: 'exact'
  },
  {
    name: 'gb18030',
    file: 'gb18030.md',
    encoding: 'gb18030',
    // 必须**真的**用 GB18030 编码（早先版本拿 UTF-8 字节冒充，套件反过来报了假失败）
    bytes: require('iconv-lite').encode(
      '# 中文标题\n\n这是一段中文正文，用 GB18030 编码保存。\n',
      'gb18030'
    ),
    noEdit: 'exact',
    edit: 'exact'
  },
  {
    name: 'no-final-newline',
    file: 'no-final-newline.md',
    bytes: Buffer.from('# 标题\n\n正文没有文末换行', 'utf-8'),
    noEdit: 'exact',
    // 文档收尾规则统一补文末换行（与主流编辑器/VS Code 同款，属保义改写）
    edit: 'known',
    why: '保存时补一个文末换行（保义，规则 18）'
  }
]

/** 等编辑器把文档装进来（content.size 到位） */
async function waitDocLoaded(ev, minSize = 1, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const size = await ev(
      `(() => { const ed = window.__L.ed(); return ed ? ed.state.doc.content.size : -1 })()`
    )
    if (typeof size === 'number' && size >= minSize) return true
    await sleep(100)
  }
  return false
}

/** 在别人的实例上另开一个临时窗口来跑，跑完关掉，绝不碰用户正在编辑的文档 */
async function openScratchWindow(app) {
  const before = (await appPages()).map((p) => p.id)
  await app.ev('(window.luminAPI.app.newWindow(), "ok")')
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    const page = (await appPages()).find((p) => !before.includes(p.id))
    if (page) return page
  }
  return null
}

async function main() {
  const report = new Reporter('Markdown 往返保真（Wave 1）')
  const app = await connect()
  const inPlace = process.env.LUMIN_FIDELITY_INPLACE === '1'

  let scratchPage = null
  let win = app
  if (!inPlace) {
    scratchPage = await openScratchWindow(app)
    if (!scratchPage) {
      report.skip('scratch-window', '没能新开窗口（用 LUMIN_FIDELITY_INPLACE=1 可在当前窗口跑）')
    } else {
      win = await attach(scratchPage)
    }
  }
  if (!(await settle(win.ev))) {
    report.skip('app-ready', '应用未就绪（ui.booting 一直为 true）')
    return report.finish()
  }
  if (!(await waitEditor(win.ev))) {
    report.skip('editor-ready', '编辑器未就绪')
    return report.finish()
  }

  const opened = await win.ev('window.__L.files().current?.path ?? null')
  report.note(
    `跑在${scratchPage ? '新开的临时窗口' : '当前窗口'}；当前文档=${opened ?? '未命名缓冲区'}`
  )
  report.note(`判级规则 ${RULES.length} 条（tools/lib/md-fidelity.js 的 RULES）`)

  // ── 现场备份（这是别人机器上的真实应用，跑完要还原）──
  const backup = JSON.parse(
    await win.ev(`JSON.stringify({
      recentFiles: window.__L.settings().recentFiles,
      autoSave: window.__L.settings().autoSave,
      defaultEncoding: window.__L.settings().defaultEncoding
    })`)
  )
  await win.ev(`(() => { window.__L.settings().set('autoSave', false); return 'ok' })()`)
  await sleep(200)

  // ── A/B. 文档级往返矩阵 + 幂等 ────────────────────────────────────────────
  const fixtures = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
  const tally = { exact: 0, normalized: 0, lossy: 0 }
  const tighten = []
  const dump = { generatedAt: new Date().toISOString(), rules: RULES, fixtures: [], bytes: [] }

  for (const name of fixtures) {
    const src = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8')
    await win.ev(loadInto(src))
    const raw = await win.ev(RAW)
    const docText = await win.ev(FLUSH)
    if (docText === null || raw === null) {
      report.skip(name, '编辑器未就绪')
      continue
    }

    const doc = classify(src, docText)
    const rawLevel = classify(src, raw)
    tally[doc.level] += 1
    const exp = EXPECT[name] ?? { class: 'exact' }

    // 幂等：文档文本再走一遍，必须一字不差
    await win.ev(loadInto(docText))
    const docText2 = await win.ev(FLUSH)
    const idem = docText2 === docText

    dump.fixtures.push({
      name,
      expect: exp.class,
      why: exp.why ?? null,
      level: doc.level,
      detail: doc.detail,
      rawLevel: rawLevel.level,
      rawDetail: rawLevel.detail,
      idempotent: idem,
      idempotentDetail: idem ? null : classify(docText, docText2).detail,
      source: src,
      documentText: docText,
      secondPass: docText2,
      serializerOutput: raw
    })

    if (exp.class === 'lossy') {
      if (doc.level === 'lossy') {
        report.skip(name, `已知缺口（${exp.why ?? '见 EXPECT.json'}）`)
        // 已知缺口内的幂等不检查：内容本来就在被改写，输出不稳定是缺口的一部分，
        // 报 FAIL 只会掩盖真正的回归（缺口修好了会自动回到检查）
        report.skip(`幂等 ${name}`, '已知缺口内不检查幂等')
        continue
      }
      report.check(name, true, `缺口已修复（实际 ${doc.level}）→ 请更新 EXPECT.json 收紧预期`)
    } else {
      report.check(
        name,
        !worseThan(doc.level, exp.class),
        `实际=${doc.level} 预期=${exp.class}${
          doc.level === rawLevel.level ? '' : `（序列化器级=${rawLevel.level}）`
        }${doc.detail ? ' | ' + doc.detail : ''}`
      )
      if (!worseThan(exp.class, doc.level) && doc.level !== exp.class) tighten.push(name)
    }
    report.check(`幂等 ${name}`, idem, idem ? '' : classify(docText, docText2).detail)
    if (VERBOSE && doc.level !== 'exact') {
      report.note(`差异 ${name}（文档级）：\n` + unifiedDiff(src, docText))
    }
  }

  report.note(
    `矩阵统计：exact ${tally.exact} / normalized ${tally.normalized} / lossy ${tally.lossy}（共 ${fixtures.length} 份夹具）`
  )
  if (tighten.length) report.note(`可收紧预期（实际比预期好）：${tighten.join(', ')}`)

  // ── C. 字节级：真开真存 ───────────────────────────────────────────────────
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  const touched = []

  for (const c of BYTE_CASES) {
    const p = path.join(TMP, c.file)
    fs.writeFileSync(p, c.bytes)
    touched.push(p)
    if (c.encoding) {
      await win.ev(
        `(() => { window.__L.settings().set('defaultEncoding', ${JSON.stringify(c.encoding)}); return 'ok' })()`
      )
      await sleep(150)
    }
    await win.ev(
      `(async () => { await window.__L.files().openPath(${JSON.stringify(p)}); return 'ok' })()`
    )
    await waitDocLoaded(win.ev)
    await sleep(250)
    const before = fs.readFileSync(p)

    // C1：打开后**不动**就保存 → 磁盘字节必须完全不变（打开不得改写文件）
    await win.ev(`(async () => { await window.__L.files().save(); return 'ok' })()`)
    await sleep(200)
    const afterNoEdit = fs.readFileSync(p)
    const okNoEdit = afterNoEdit.equals(before)
    if (c.noEdit === 'exact') {
      report.check(
        `字节 打开即保存不改字节 ${c.name}`,
        okNoEdit,
        okNoEdit
          ? ''
          : `长度 ${before.length}→${afterNoEdit.length}；${firstByteDiff(before, afterNoEdit)}`
      )
    } else {
      report.skip(`字节 打开即保存不改字节 ${c.name}`, c.why ?? 'known')
    }

    // C2：走一次落盘管线（等价于「动一下再撤销」）再保存
    await win.ev(FLUSH)
    await sleep(150)
    await win.ev(`(async () => { await window.__L.files().save(); return 'ok' })()`)
    await sleep(250)
    const afterEdit = fs.readFileSync(p)
    const okEdit = afterEdit.equals(before)
    if (c.edit === 'exact') {
      report.check(
        `字节 落盘后保存不改字节 ${c.name}`,
        okEdit,
        okEdit
          ? ''
          : `长度 ${before.length}→${afterEdit.length}；${firstByteDiff(before, afterEdit)}`
      )
    } else {
      report.skip(`字节 落盘后保存不改字节 ${c.name}`, c.why ?? 'known')
    }

    if (c.encoding) {
      await win.ev(
        `(() => { window.__L.settings().set('defaultEncoding', ${JSON.stringify(backup.defaultEncoding)}); return 'ok' })()`
      )
    }
    dump.bytes.push({
      name: c.name,
      noEdit: {
        expect: c.noEdit,
        ok: okNoEdit,
        beforeLen: before.length,
        afterLen: afterNoEdit.length
      },
      edit: { expect: c.edit, ok: okEdit, beforeLen: before.length, afterLen: afterEdit.length },
      beforeHex: before.toString('hex'),
      afterEditHex: afterEdit.toString('hex')
    })
  }

  // ── D. 行尾元数据（Wave 2）：判定 / 内存约定 / 切换 / 设置默认 ────────────────
  const eolCase = path.join(TMP, 'eol-check.md')
  fs.writeFileSync(eolCase, Buffer.from('第一行\r\n第二行\r\n', 'utf-8'))
  await win.ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(eolCase)}); return 'ok' })()`
  )
  await waitDocLoaded(win.ev)
  await sleep(250)
  const openedEol = JSON.parse(
    await win.ev(`JSON.stringify({
      eol: window.__L.files().current?.eol ?? null,
      hasCr: /\\r/.test(window.__L.files().current?.content ?? ''),
      encoding: window.__L.files().current?.encoding ?? null
    })`)
  )
  report.check(
    '行尾 打开 CRLF 文件 → 判定为 crlf',
    openedEol.eol === 'crlf',
    JSON.stringify(openedEol)
  )
  report.check(
    '行尾 内存文本归一为 LF（不含 CR）',
    openedEol.hasCr === false,
    `hasCr=${openedEol.hasCr}`
  )

  await win.ev(
    `(async () => { await window.__L.files().setEol('lf', { save: true }); return 'ok' })()`
  )
  await sleep(250)
  const lfBytes = fs.readFileSync(eolCase)
  report.check(
    '行尾 切到 LF 后落盘为 LF',
    !lfBytes.includes(0x0d) && lfBytes.toString('utf-8') === '第一行\n第二行\n',
    JSON.stringify(lfBytes.toString('utf-8'))
  )

  await win.ev(
    `(async () => { await window.__L.files().setEol('crlf', { save: true }); return 'ok' })()`
  )
  await sleep(250)
  const crlfBytes = fs.readFileSync(eolCase)
  report.check(
    '行尾 切回 CRLF 后落盘为 CRLF',
    crlfBytes.toString('utf-8') === '第一行\r\n第二行\r\n',
    JSON.stringify(crlfBytes.toString('utf-8'))
  )
  const metaAfter = JSON.parse(
    await win.ev(
      `(async () => JSON.stringify(await window.luminAPI.db.getDocument(${JSON.stringify(eolCase)})))()`
    )
  )
  report.check(
    '行尾 元数据落库（documents.eol）',
    metaAfter?.eol === 'crlf' && metaAfter?.encoding === 'utf-8',
    JSON.stringify({ eol: metaAfter?.eol, encoding: metaAfter?.encoding })
  )

  // 设置里的默认行尾：只影响新建/未命名文档（已有文件按自己原本的行尾）
  await win.ev(`(() => { window.__L.settings().set('defaultEol', 'crlf'); return 'ok' })()`)
  await sleep(200)
  await win.ev(`(async () => { await window.__L.files().openUntitled(); return 'ok' })()`)
  await sleep(250)
  const untitledEol = await win.ev('window.__L.files().current?.eol ?? null')
  report.check('行尾 未命名文档用设置里的默认值', untitledEol === 'crlf', `eol=${untitledEol}`)
  await win.ev(`(() => { window.__L.settings().set('defaultEol', 'lf'); return 'ok' })()`)
  await win.ev(`(async () => { await window.__L.files().close(); return 'ok' })()`)
  await win.ev(
    `(async () => { try { await window.luminAPI.db.deleteDocument(${JSON.stringify(eolCase)}) } catch {} return 'ok' })()`
  )
  fs.rmSync(eolCase, { force: true })

  // ── E. 本地历史（Wave 2 数据安全）：保存前留快照 / 可载入 / 可清空 ────────────
  const histFile = path.join(TMP, 'history-check.md')
  fs.writeFileSync(histFile, Buffer.from('# 第一版\n\n原文。\n', 'utf-8'))
  await win.ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(histFile)}); return 'ok' })()`
  )
  await waitDocLoaded(win.ev)
  await sleep(250)
  // 改内容 → 保存两次（历史里应出现「第一版」与「第二版」两份将被覆盖的内容）
  await win.ev(`(async () => {
    const ed = window.__L.ed(); const f = window.__L.files()
    ed.commands.setContent('# 第二版\\n\\n改过一次。\\n', { emitUpdate: false })
    f.setContent('# 第二版\\n\\n改过一次。\\n')
    await f.save()
    ed.commands.setContent('# 第三版\\n\\n又改一次。\\n', { emitUpdate: false })
    f.setContent('# 第三版\\n\\n又改一次。\\n')
    await f.save()
    return 'ok'
  })()`)
  await sleep(300)
  const hist = JSON.parse(
    await win.ev(
      `(async () => JSON.stringify(await window.luminAPI.history.list(${JSON.stringify(histFile)}, 10)))()`
    )
  )
  report.check(
    '历史 保存前留快照（3 版内容 → 至少 2 条历史）',
    Array.isArray(hist) && hist.length >= 2,
    `entries=${Array.isArray(hist) ? hist.length : 'n/a'}`
  )
  report.check(
    '历史 最新一条是「即将被覆盖」的那一版',
    Array.isArray(hist) && hist[0]?.preview?.includes('第二版'),
    JSON.stringify(hist?.[0] ?? null)
  )
  const firstEntry =
    Array.isArray(hist) && hist.length
      ? await win.ev(
          `(async () => JSON.stringify(await window.luminAPI.history.get(${hist[hist.length - 1].id})))()`
        )
      : null
  const firstParsed = firstEntry ? JSON.parse(firstEntry) : null
  report.check(
    '历史 最早一条是打开时的原文',
    !!firstParsed && firstParsed.content.includes('第一版'),
    JSON.stringify(firstParsed?.content ?? null).slice(0, 60)
  )

  // 载入历史版本：只改编辑器缓冲，不写盘（磁盘仍是第三版）
  await win.ev(`(async () => {
    const entry = await window.luminAPI.history.get(${hist[hist.length - 1].id})
    await window.__L.files().restoreHistory(entry)
    return 'ok'
  })()`)
  await sleep(300)
  const afterRestore = JSON.parse(
    await win.ev(`JSON.stringify({
      buffer: window.__L.files().current?.content ?? '',
      disk: null,
      dirty: !!window.__L.files().dirty
    })`)
  )
  const diskNow = fs.readFileSync(histFile, 'utf-8')
  report.check(
    '历史 载入历史版本改的是缓冲（磁盘未变）',
    afterRestore.buffer.includes('第一版') && diskNow.includes('第三版'),
    JSON.stringify({ buffer: afterRestore.buffer.slice(0, 24), disk: diskNow.slice(0, 24) })
  )
  report.check(
    '历史 载入后标记为未保存',
    afterRestore.dirty === true,
    `dirty=${afterRestore.dirty}`
  )

  const cleared = await win.ev(
    `(async () => await window.luminAPI.history.clear(${JSON.stringify(histFile)}))()`
  )
  const afterClear = JSON.parse(
    await win.ev(
      `(async () => JSON.stringify(await window.luminAPI.history.list(${JSON.stringify(histFile)}, 10)))()`
    )
  )
  report.check(
    '历史 可清空',
    Number(cleared) >= 1 && Array.isArray(afterClear) && afterClear.length === 0,
    `cleared=${cleared} left=${Array.isArray(afterClear) ? afterClear.length : 'n/a'}`
  )
  await win.ev(`(async () => { await window.__L.files().close(); return 'ok' })()`)
  await win.ev(
    `(async () => { try { await window.luminAPI.db.deleteDocument(${JSON.stringify(histFile)}) } catch {} return 'ok' })()`
  )
  fs.rmSync(histFile, { force: true })

  // ── F. 多窗口元数据一致性（Wave 2 尾巴）：打开时以库记录为准 ────────────────
  const metaFile = path.join(TMP, 'meta-window.md')
  fs.writeFileSync(
    metaFile,
    require('iconv-lite').encode('# 中文元数据\n\nGBK 正文。\n', 'gb18030')
  )

  // 窗口 A：auto 打开（判定出 gb18030 并落库），再把行尾改成 CRLF 保存
  await win.ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(metaFile)}); return 'ok' })()`
  )
  await waitDocLoaded(win.ev)
  await sleep(300)
  const metaA = JSON.parse(
    await win.ev(`JSON.stringify({
      encoding: window.__L.files().current?.encoding ?? null,
      eol: window.__L.files().current?.eol ?? null
    })`)
  )
  await win.ev(
    `(async () => { await window.__L.files().setEol('crlf', { save: true }); return 'ok' })()`
  )
  await sleep(300)

  // 第二个窗口（同实例、同库）打开同一文件：编码与行尾都必须跟库记录一致
  const scratch2 = await openScratchWindow(app)
  let metaB = null
  if (scratch2) {
    const win2 = await attach(scratch2)
    if (await settle(win2.ev)) {
      await win2.ev(
        `(async () => { await window.__L.files().openPath(${JSON.stringify(metaFile)}); return 'ok' })()`
      )
      await waitDocLoaded(win2.ev)
      await sleep(400)
      metaB = JSON.parse(
        await win2.ev(`JSON.stringify({
          encoding: window.__L.files().current?.encoding ?? null,
          eol: window.__L.files().current?.eol ?? null,
          head: (window.__L.files().current?.content ?? '').slice(0, 12)
        })`)
      )
      // 把「设置里的默认编码」改成 windows-1252 后重新打开：库里的每文件记录仍须优先，
      // 否则同一个文件在两个窗口会解出不同内容（这正是「多窗口一致」的含义）
      await win2.ev(
        `(() => { window.__L.settings().set('defaultEncoding', 'windows-1252'); return 'ok' })()`
      )
      await sleep(200)
      await win2.ev(
        `(async () => { await window.__L.files().openPath(${JSON.stringify(metaFile)}); return 'ok' })()`
      )
      await sleep(500)
      metaB.withDefault = JSON.parse(
        await win2.ev(`JSON.stringify({
          encoding: window.__L.files().current?.encoding ?? null,
          head: (window.__L.files().current?.content ?? '').slice(0, 12)
        })`)
      )
      await win2.ev(
        `(() => { window.__L.settings().set('defaultEncoding', 'auto'); return 'ok' })()`
      )
    }
    await win2.send('Page.close').catch(() => {})
    win2.close()
  }
  report.check(
    '元数据 窗口 A 打开 GBK 文件：判定并落库',
    metaA.encoding === 'gb18030',
    JSON.stringify(metaA)
  )
  if (metaB) {
    report.check(
      '元数据 窗口 B 打开同一文件：编码与库记录一致',
      metaB.encoding === 'gb18030' && String(metaB.head).includes('中文元数据'),
      JSON.stringify(metaB)
    )
    report.check(
      '元数据 窗口 B 行尾与库记录一致（CRLF）',
      metaB.eol === 'crlf',
      JSON.stringify(metaB)
    )
    report.check(
      '元数据 每文件记录优先于全局默认编码',
      metaB.withDefault?.encoding === 'gb18030' &&
        String(metaB.withDefault?.head).includes('中文元数据'),
      JSON.stringify(metaB.withDefault ?? null)
    )
  } else {
    report.skip('元数据 窗口 B 一致性', '没能开第二个窗口')
  }
  await win.ev(`(async () => { await window.__L.files().close(); return 'ok' })()`)
  await win.ev(
    `(async () => { try { await window.luminAPI.db.deleteDocument(${JSON.stringify(metaFile)}) } catch {} return 'ok' })()`
  )
  fs.rmSync(metaFile, { force: true })

  // ── G. 本地历史的保留策略可配（Wave 2 尾巴）───────────────────────────────
  const hist2 = path.join(TMP, 'history-policy.md')
  fs.writeFileSync(hist2, Buffer.from('# v0\n', 'utf-8'))
  await win.ev(
    `(async () => { await window.__L.files().openPath(${JSON.stringify(hist2)}); return 'ok' })()`
  )
  await waitDocLoaded(win.ev)
  await sleep(250)

  // 关掉历史：连存几次都不该留新快照
  await win.ev(`(() => { window.__L.settings().set('historyEnabled', false); return 'ok' })()`)
  await sleep(300)
  /**
   * ⚠️ 先把"设置真的落库了吗"单独断言一次（波次 2 补）。
   *
   * 原来看的只有"历史里有没有新快照"，于是**设置没落库**这条真因会被一句 `entries=2` 掩盖
   * （现场就是这么查了半天）：渲染层的落库是 250ms 节流的，主进程 `recordHistoryBeforeOverwrite`
   * 读的是 kv —— 两边没对齐时，快的那个（保存）先跑、慢的那个（设置）后到。
   * 拆成两条之后，红的时候一眼知道是"设置没到"还是"历史没关"。
   */
  const landed = JSON.parse(
    await win.ev(`(async () => JSON.stringify(await window.luminAPI.settings.getAll()))()`)
  )
  report.check(
    '历史 关闭设置真的落库了',
    landed?.historyEnabled === false,
    `主进程读到的 historyEnabled=${landed?.historyEnabled}（false 才能验后面的"不再写快照"）`
  )
  await win.ev(`(async () => {
    const f = window.__L.files()
    for (const v of ['# v1\\n', '# v2\\n']) { f.setContent(v); await f.save() }
    return 'ok'
  })()`)
  await sleep(400)
  const offEntries = JSON.parse(
    await win.ev(
      `(async () => JSON.stringify(await window.luminAPI.history.list(${JSON.stringify(hist2)}, 20)))()`
    )
  )
  report.check(
    '历史 关闭后不再写快照',
    Array.isArray(offEntries) && offEntries.length === 0,
    `entries=${offEntries?.length}`
  )

  // 打开历史 + 每文件最多 2 条：连存 4 次后应恰好剩 2 条（抽稀按设置生效）
  await win.ev(
    `(() => { window.__L.settings().set('historyEnabled', true); window.__L.settings().set('historyLimitPerFile', 2); return 'ok' })()`
  )
  await sleep(300)
  await win.ev(`(async () => {
    const f = window.__L.files()
    for (const v of ['# v3\\n', '# v4\\n', '# v5\\n', '# v6\\n']) { f.setContent(v); await f.save() }
    return 'ok'
  })()`)
  await sleep(600)
  const onEntries = JSON.parse(
    await win.ev(
      `(async () => JSON.stringify(await window.luminAPI.history.list(${JSON.stringify(hist2)}, 20)))()`
    )
  )
  report.check(
    '历史 保留条数按设置抽稀（上限 2）',
    Array.isArray(onEntries) && onEntries.length === 2,
    `entries=${onEntries?.length} previews=${JSON.stringify(onEntries?.map((e) => e.preview))}`
  )
  await win.ev(`(() => { window.__L.settings().set('historyLimitPerFile', 30); return 'ok' })()`)
  await win.ev(
    `(async () => { await window.luminAPI.history.clear(${JSON.stringify(hist2)}); return 'ok' })()`
  )
  await win.ev(`(async () => { await window.__L.files().close(); return 'ok' })()`)
  await win.ev(
    `(async () => { try { await window.luminAPI.db.deleteDocument(${JSON.stringify(hist2)}) } catch {} return 'ok' })()`
  )
  fs.rmSync(hist2, { force: true })

  // ── H. YAML front matter（Wave 1 剩余缺口）：渲染 / 编辑正文不动它 / 不误吃分割线 ──
  // 注意：E/G 段收尾时把文档 close() 掉了，store 处于「无文档」状态。本段要验的是
  // 「文档文本 = 序列化结果」这条真实管线，所以先开一份未命名缓冲，再把夹具装进编辑器。
  await win.ev(`(async () => { await window.__L.files().openUntitled(); return 'ok' })()`)
  await sleep(500)
  const FM_SRC = fs.readFileSync(path.join(FIXTURE_DIR, 'frontmatter.md'), 'utf-8')
  await win.ev(loadInto(FM_SRC))
  await sleep(300)
  const h1 = JSON.parse(
    await win.ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return 'null'
      const first = ed.state.doc.firstChild
      const dom = document.querySelector('.md-preview pre[data-md-frontmatter]')
      return JSON.stringify({
        nodeName: first ? first.type.name : null,
        source: first ? (first.attrs.source ?? null) : null,
        dom: dom ? dom.textContent : null,
        docSize: ed.state.doc.content.size
      })
    })()`)
  )
  report.check(
    'H1 front matter 成为文档首个节点且 WYSIWYG 可见同样内容',
    h1 !== 'null' &&
      h1.nodeName === 'frontmatter' &&
      h1.source === '---\ntitle: 测试文档\ntags: [a, b]\ndate: 2024-01-01\n---' &&
      h1.dom === h1.source,
    JSON.stringify(h1).slice(0, 220)
  )

  // 在正文末尾敲字（不改 YAML）→ 落盘后 YAML 必须逐字不变
  const h2 = await win.ev(`(() => {
    const ed = window.__L.ed()
    ed.commands.focus('end')
    ed.commands.insertContent('追加一句。')
    window.dispatchEvent(new Event('beforeunload'))
    return window.__L.files().current?.content ?? null
  })()`)
  report.check(
    'H2 编辑正文后 YAML 逐字不变（且仍在开头）',
    typeof h2 === 'string' &&
      h2.startsWith(FM_SRC.trimEnd().slice(0, FM_SRC.indexOf('\n---') + 4)) &&
      h2.includes('追加一句。'),
    JSON.stringify(h2).slice(0, 200)
  )

  // 源码模式看得见 YAML（改它的入口）：store 文本 = textarea 的内容
  const h3 = JSON.parse(
    await win.ev(`(async () => {
      window.__L.ui().editorMode = 'source'
      await new Promise((r) => setTimeout(r, 400))
      const ta = document.querySelector('textarea.source-editor')
      const v = ta ? ta.value : null
      const diag = { hash: location.hash, areas: document.querySelectorAll('textarea').length, hasEd: !!window.__L.ed() }
      window.__L.ui().editorMode = 'wysiwyg'
      await new Promise((r) => setTimeout(r, 250))
      return JSON.stringify({ head: v ? v.slice(0, 12) : null, hasYaml: !!v && v.includes('title: 测试文档'), diag })
    })()`)
  )
  report.check(
    'H3 源码模式里 YAML 就是正文开头（改它的入口通）',
    typeof h3.head === 'string' && h3.head.startsWith('---\ntitle:') && h3.hasYaml === true,
    JSON.stringify(h3).slice(0, 200)
  )

  // 回归：CommonMark 里合法的「分割线 + 文字 + 分割线」不能被误吃成 YAML
  const NOT_FM = '---\n就一段文字\n---\n\n后面\n'
  await win.ev(loadInto(NOT_FM))
  await sleep(250)
  const h4 = JSON.parse(
    await win.ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return 'null'
      const names = []
      ed.state.doc.forEach((n) => names.push(n.type.name))
      return JSON.stringify({ names, text: ed.storage.markdown.getMarkdown() })
    })()`)
  )
  report.check(
    'H4 分割线夹文字不误判成 front matter（节点序列仍是 hr/段落）',
    h4 !== 'null' && !h4.names.includes('frontmatter') && h4.names.includes('horizontalRule'),
    JSON.stringify(h4).slice(0, 200)
  )

  // ── T. 表格（Wave 1 缺口）：列对齐与「单元格里的竖线」都要活着 ──
  const TABLE_SRC = fs.readFileSync(path.join(FIXTURE_DIR, 'table.md'), 'utf-8')
  await win.ev(loadInto(TABLE_SRC))
  await sleep(300)
  const t1 = JSON.parse(
    await win.ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return 'null'
      const tables = []
      ed.state.doc.descendants((n) => {
        if (n.type.name !== 'table') return
        const rows = []
        n.forEach((row) => {
          const cells = []
          row.forEach((cell) => cells.push({ align: cell.attrs.align ?? null, text: cell.textContent }))
          rows.push(cells)
        })
        tables.push(rows)
      })
      return JSON.stringify({ tables })
    })()`)
  )
  const firstTable = t1 !== 'null' ? t1.tables[0] : null
  report.check(
    'T1 表格解析：列对齐落在单元格属性上、转义竖线留在同一格里',
    !!firstTable &&
      firstTable.length >= 4 &&
      firstTable.every((r) => r.length === 3) &&
      firstTable[0][1].align === 'left' &&
      firstTable[0][2].align === 'right' &&
      firstTable[3][0].text === '转义 | 竖线',
    JSON.stringify(firstTable).slice(0, 240)
  )
  const t2 = await win.ev(FLUSH)
  report.check(
    'T2 表格写回：对齐标记与转义竖线都还在，列数没被拆多',
    typeof t2 === 'string' &&
      t2.includes('| --- | :--- | ---: |') &&
      t2.includes('转义 \\| 竖线') &&
      !t2.includes('转义 | 竖线 |'),
    JSON.stringify(t2).slice(0, 240)
  )

  // ── I. 行内 / 块级 HTML（Wave 1 缺口）：原文不许被吃掉 ──
  const HTML_SRC = fs.readFileSync(path.join(FIXTURE_DIR, 'html-inline.md'), 'utf-8')
  await win.ev(loadInto(HTML_SRC))
  await sleep(300)
  const i1 = JSON.parse(
    await win.ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return 'null'
      const raws = []
      const blocks = []
      ed.state.doc.descendants((n) => {
        if (n.isText && n.marks.some((m) => m.type.name === 'mdHtml')) raws.push(n.text)
        if (n.type.name === 'htmlBlock') blocks.push(n.attrs.source)
      })
      return JSON.stringify({ raws, blocks })
    })()`)
  )
  report.check(
    'I1 行内 HTML 以原文存活（<kbd>/<br>/注释都还在）',
    i1 !== 'null' && i1.raws.includes('<kbd>') && i1.raws.includes('<br>'),
    JSON.stringify(i1).slice(0, 200)
  )
  report.check(
    'I2 块级 HTML 成为 htmlBlock 节点且原文逐字保留',
    i1 !== 'null' &&
      i1.blocks.some((b) => b.includes('<div class="block">') && b.includes('</div>')) &&
      i1.blocks.some((b) => b.includes('<!--') && b.includes('-->')),
    JSON.stringify(i1.blocks).slice(0, 220)
  )
  // 回归守卫：任务列表的复选框是解析器**生成**的，绝不能被当「用户写的行内 HTML」留下来
  await win.ev(loadInto(fs.readFileSync(path.join(FIXTURE_DIR, 'task-lists.md'), 'utf-8')))
  await sleep(300)
  const i3 = await win.ev(`(() => {
    const ed = window.__L.ed()
    if (!ed) return 'null'
    return ed.state.doc.textContent.includes('task-list-item-checkbox') ? 'leaked' : 'clean'
  })()`)
  report.check('I3 任务列表复选框没被当行内 HTML 留下来', i3 === 'clean', String(i3))

  // ── M. 图片（Wave 1 最后的缺口）：行内形态要真的「行内」 ──
  await win.ev(loadInto(fs.readFileSync(path.join(FIXTURE_DIR, 'images-inline.md'), 'utf-8')))
  await sleep(300)
  const m1 = JSON.parse(
    await win.ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return 'null'
      const blocks = []
      ed.state.doc.forEach((n) => {
        const imgs = []
        n.descendants((c) => {
          if (c.type.name === 'image') imgs.push(c.attrs.src)
        })
        blocks.push({ type: n.type.name, text: n.textContent, imgs })
      })
      return JSON.stringify({ blocks })
    })()`)
  )
  report.check(
    'M1 段落中间的图片不拆段（文字与图片同一个段落）',
    m1 !== 'null' &&
      m1.blocks.length === 2 &&
      m1.blocks[0].type === 'paragraph' &&
      m1.blocks[0].text.includes('行内图片') &&
      m1.blocks[0].text.includes('后面还有文字') &&
      m1.blocks[0].imgs.length === 1,
    JSON.stringify(m1).slice(0, 240)
  )
  await win.ev(loadInto(fs.readFileSync(path.join(FIXTURE_DIR, 'images-linked.md'), 'utf-8')))
  await sleep(300)
  const m2 = JSON.parse(
    await win.ev(`(() => {
      const ed = window.__L.ed()
      if (!ed) return 'null'
      let linked = 0
      ed.state.doc.descendants((n) => {
        if (n.type.name !== 'image') return
        if (n.marks.some((mk) => mk.type.name === 'link')) linked += 1
      })
      return JSON.stringify({ linked })
    })()`)
  )
  report.check(
    'M2 链接包住的图片保留外层链接 mark',
    m2 !== 'null' && m2.linked === 2,
    JSON.stringify(m2)
  )

  // ── N. 嵌套样式的**渲染**：粗体里的行内代码要靠属性选择器补齐外观 ──
  // 为什么要有这条：`mdStyle` 只渲染**一个**元素（`<strong data-md-styles="bold code">`），
  // 集合里其余样式的外观全靠 CSS 的 `[data-md-styles~=…]` 规则。CSS 一旦漏掉，
  // 序列化仍然「保真」（往返字节不变），但用户看到的那段代码**不再像代码** ——
  // 保真套件管不到观感，所以在这里补一条计算样式断言。
  await win.ev(loadInto(fs.readFileSync(path.join(FIXTURE_DIR, 'nested-styles.md'), 'utf-8')))
  await sleep(300)
  const n1 = JSON.parse(
    await win.ev(`(() => {
      const el = document.querySelector('.md-preview [data-md-styles~="code"]')
      if (!el) return 'null'
      const cs = getComputedStyle(el)
      return JSON.stringify({
        tag: el.tagName.toLowerCase(),
        dataStyles: el.getAttribute('data-md-styles'),
        weight: cs.fontWeight,
        mono: /mono|Consolas|Menlo|Courier/i.test(cs.fontFamily),
        bg: cs.backgroundColor
      })
    })()`)
  )
  report.check(
    'N1 粗体里的行内代码：一个元素同时拿到粗体与代码外观',
    n1 !== 'null' &&
      n1.tag === 'strong' &&
      n1.dataStyles === 'bold code' &&
      Number(n1.weight) >= 700 &&
      n1.mono === true,
    JSON.stringify(n1)
  )

  // ── 复原（设置 / 最近文档 / 索引 / 临时文件）──────────────────────────────
  await win.ev(`(() => {
    window.__L.settings().set('autoSave', ${JSON.stringify(backup.autoSave)})
    window.__L.settings().set('recentFiles', ${JSON.stringify(backup.recentFiles ?? [])})
    return 'ok'
  })()`)
  await sleep(200)
  for (const p of touched) {
    await win.ev(
      `(async () => { try { await window.luminAPI.db.deleteDocument(${JSON.stringify(p)}) } catch {} return 'ok' })()`
    )
  }
  fs.rmSync(TMP, { recursive: true, force: true })
  if (scratchPage) {
    await win.send('Page.close').catch(() => {})
    await sleep(500)
    win.close()
  }
  fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2), 'utf-8')
  report.note('已还原 autoSave / recentFiles，清理临时文件与索引条目')
  report.note(`逐份往返结果（原文/产出/判级）已写入 ${DUMP}`)

  return report.finish()
}

/** 首个不同字节的下标（诊断用） */
function firstByteDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `${i}: ${hex(a, i)} vs ${hex(b, i)}`
  return a.length === b.length ? '无' : `长度不同（${a.length} vs ${b.length}）`
}
function hex(buf, i) {
  return buf
    .slice(i, i + 12)
    .toString('hex')
    .replace(/(..)/g, '$1 ')
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
