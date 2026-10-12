'use strict'
/**
 * 验收（第一百零八轮）：外部改动监测 → 提示「检测到内容已被修改，是否重新加载」。
 *
 * 覆盖：
 *   ① 外部写盘 ⇒ 提示在 N ms 内出现，文案**逐字**为 `检测到内容已被修改，是否重新加载`；
 *   ② 点「重新加载」⇒ store/编辑器内容 == 磁盘新内容；
 *   ③ 点「暂不」⇒ 内容不变，且**同一修订不再重复提示**；再改一次 ⇒ 再次提示；
 *   ④ 自己保存（Ctrl+S 的等价通道 `files.save()`）⇒ 提示计数 0（不误报）；
 *   ⑤ 连续快速写 3 次 ⇒ 只提示 1 次（去抖 + 按版去重）；
 *   ⑥ 顺带把提示框截到 `tmp/external-watch-prompt.png`（人工可看）。
 *
 * 端口取 `LUMIN_DEBUG_PORT`（run-suites 会设）→ `--port=` → 兜底 9334。
 * 夹具写在 `%TEMP%`：隔离实例把 `%TEMP%` 声明成信任范围（见 tools/start-isolated.ps1），
 * 所以能走**真实打开路径** `files.openPath()`（不是伪造 current）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, settle, Reporter, fatal, sleep } = require('./lib/harness')

const PORT =
  Number(
    process.env.LUMIN_DEBUG_PORT ||
      (process.argv.find((a) => a.startsWith('--port=')) || '').slice('--port='.length) ||
      9334
  )
const BODY_ZH = '检测到内容已被修改，是否重新加载'

async function main() {
  const report = new Reporter('外部改动监测 → 重新加载提示')
  const app = await connect({ port: PORT })
  try {
    if (!(await settle(app.ev))) throw new Error('编辑器未就绪（settle 失败）')
    const ev = app.ev

    // ── 夹具：真实文件 + 真实打开路径 ─────────────────────────────────────────
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-extwatch-'))
    const file = path.join(dir, 'watch.md')
    const V1 = '# 外部监测夹具\n\n第一版正文。\n'
    const V2 = '# 外部监测夹具\n\n第二版：被外部改过了。\n'
    const V3 = '# 外部监测夹具\n\n第三版：又改了一次。\n'
    const V4 = '# 外部监测夹具\n\n第四版：还在改。\n'
    fs.writeFileSync(file, V1, 'utf8')
    const opened = await ev(
      `(async () => { const f = window.__L.files(); if (f.current) await f.close(); return await f.openPath(${JSON.stringify(
        file
      )}) })()`
    )
    await sleep(900)
    report.check('fixture 夹具用真实路径打开', opened === true, file)

    const resetCounts = () =>
      ev(
        `(() => { const c = window.__luminExternalWatch; if (!c) return 'MISSING'; c.prompts = 0; c.reloads = 0; c.deferred = 0; c.lastBody = null; return 'ok' })()`
      )
    const counts = async () => JSON.parse(await ev('JSON.stringify(window.__luminExternalWatch || null)'))
    /** 等提示**新增**（返回耗时 ms；-1 = 超时）。`baseline` = 计数起点 —— 不能只等 `> 0`，
     *  否则"暂不之后再改一次"会被上一个用例留下的计数骗成"立刻出现"（实测踩过）。 */
    const waitPrompt = async (baseline = 0, timeoutMs = 9000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        const c = await counts()
        if (c && c.prompts > baseline) return Date.now() - t0
        await sleep(80)
      }
      return -1
    }
    const dialogText = async () =>
      JSON.parse(
        await ev(`JSON.stringify((() => {
          const c = document.querySelector('[data-triple-confirm]')
          if (!c) return null
          const host = c.closest('div[role="dialog"]') || c.ownerDocument
          const h3 = host.querySelector('h3')
          const p = host.querySelector('p')
          return {
            title: h3 ? h3.textContent.trim() : null,
            body: p ? p.textContent.trim() : null,
            confirm: c.textContent.trim(),
            alt: document.querySelector('[data-triple-alt]') ? document.querySelector('[data-triple-alt]').textContent.trim() : null
          }
        })())`)
      )
    const clickDialog = (sel) =>
      ev(`(() => { const b = document.querySelector('${sel}'); if (!b) return 'MISSING'; b.click(); return 'ok' })()`)
    const storeContent = () => ev('window.__L.files().current ? window.__L.files().current.content : null')
    const editorText = () => ev("document.querySelector('.ProseMirror') ? document.querySelector('.ProseMirror').textContent : ''")

    // ── ① 外部写盘 ⇒ 提示（时延 + 逐字文案）──────────────────────────────────
    report.check('外部监测已装上（计数载体在位）', (await resetCounts()) === 'ok')
    fs.writeFileSync(file, V2, 'utf8')
    const latency = await waitPrompt(0)
    const dlg = await dialogText()
    report.check('① 外部写盘后提示在窗口内出现', latency >= 0, `${latency}ms`)
    report.check(
      '① 提示文案逐字 == 检测到内容已被修改，是否重新加载',
      !!dlg && dlg.body === BODY_ZH,
      JSON.stringify(dlg)
    )

    // 截图（趁提示还开着）
    try {
      const shot = await app.send('Page.captureScreenshot', { format: 'png' })
      const data = shot && shot.result && shot.result.data
      const out = path.join(process.cwd(), 'tmp', 'external-watch-prompt.png')
      if (data) {
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, Buffer.from(data, 'base64'))
        report.check('⑥ 提示框截图已写出', fs.existsSync(out), out)
      } else {
        report.check('⑥ 提示框截图已写出', false, 'captureScreenshot 无数据')
      }
    } catch (e) {
      report.check('⑥ 提示框截图已写出', false, String(e.message))
    }

    // ── ② 重新加载 ⇒ 内容 == 磁盘 ────────────────────────────────────────────
    const beforeReload = await storeContent()
    await clickDialog('[data-triple-confirm]')
    await sleep(900)
    const afterReload = await storeContent()
    const textAfter = await editorText()
    const c2 = await counts()
    report.check('② 重新加载：store 内容 == 磁盘 V2（逐字节）', afterReload === V2, JSON.stringify({
      beforeHead: String(beforeReload).slice(0, 24),
      afterHead: String(afterReload).slice(0, 24)
    }))
    report.check('② 重新加载：编辑器里看到的是新一版', String(textAfter).includes('被外部改过了'), JSON.stringify({
      text: String(textAfter).slice(0, 40),
      reloads: c2 ? c2.reloads : null
    }))

    // ── ③ 暂不 ⇒ 内容不变 + 同一修订不再提示 ─────────────────────────────────
    await resetCounts()
    fs.writeFileSync(file, V3, 'utf8')
    const lat3 = await waitPrompt(0)
    await clickDialog('[data-triple-alt]')
    await sleep(600)
    const afterDefer = await storeContent()
    report.check('③ 暂不：内容保持原样（仍是 V2）', afterDefer === V2, `提示时延=${lat3}ms`)
    await sleep(4600) // 两个轮询周期
    const c3 = await counts()
    report.check('③ 同一修订不再重复提示（计数仍 1）', !!c3 && c3.prompts === 1, JSON.stringify(c3))
    fs.writeFileSync(file, V4, 'utf8')
    const lat4 = await waitPrompt(1)
    const c4 = await counts()
    report.check('③ 再改一次会再次提示（计数 2）', lat4 >= 0 && !!c4 && c4.prompts === 2, `时延=${lat4}ms ${JSON.stringify(c4)}`)
    await clickDialog('[data-triple-alt]')
    await sleep(500)

    // ── ④ 自己保存不误报 ─────────────────────────────────────────────────────
    await resetCounts()
    await ev(
      `(() => { const f = window.__L.files(); f.setContent(f.current.content + '\\n自己写的一行。\\n', 'wysiwyg'); return 'ok' })()`
    )
    await sleep(300)
    const saved = await ev('(async () => await window.__L.files().save())()')
    await sleep(4000)
    const c5 = await counts()
    report.check('④ 自己保存后提示计数为 0（Ctrl+S 不误报）', !!c5 && c5.prompts === 0, `save()=${saved} ${JSON.stringify(c5)}`)

    // ── ⑤ 连续快速写 3 次 ⇒ 只提示 1 次 ──────────────────────────────────────
    await resetCounts()
    fs.writeFileSync(file, '# 外部监测夹具\n\n快速一。\n', 'utf8')
    await sleep(120)
    fs.writeFileSync(file, '# 外部监测夹具\n\n快速二。\n', 'utf8')
    await sleep(120)
    fs.writeFileSync(file, '# 外部监测夹具\n\n快速三。\n', 'utf8')
    await waitPrompt(0)
    await sleep(3200)
    const c6 = await counts()
    report.check('⑤ 连续 3 次写盘只提示 1 次', !!c6 && c6.prompts === 1, JSON.stringify(c6))
    await clickDialog('[data-triple-alt]')
    await sleep(300)

    // 收尾
    await ev("(async () => { const f = window.__L.files(); if (f.current) await f.close(); return 'ok' })()")
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录：删不掉不影响结论 */
    }
  } finally {
    app.close()
  }
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
