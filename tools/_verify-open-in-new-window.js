'use strict'
// 验收：「在新窗口打开」的重复打开去重（审计 §2 P1「同一文件可被两个窗口打开并各自保存」）
//
// 背景：常规打开路径一直有"一个文件只开一个窗口"的闸（services/openDocs），
// 但 **`app:openInNewWindow` 以前直接建窗** —— 侧栏右键「在新窗口打开」与文档内链接都走它。
// 两个窗口各持一份缓冲区、各自保存，正文会互相覆盖（现在还有外部改动检测兜底，
// 但那是"报冲突"，不如一开始就不让它发生）。
//
// 判据：
//   1. 对**已经开在某个窗口里**的文件调用「在新窗口打开」→ **不多出窗口**，
//      并且给那个窗口留一张说明性的通知；
//   2. 对**没开**的文件调用 → 照常开新窗口（这条是防止把功能改坏的反向断言）。
const path = require('path')
const os = require('os')
const fs = require('fs')
const { connect, settle, sleep, appPages, Reporter, fatal } = require('./lib/harness')

const WS = path.join(os.tmpdir(), 'lumin-open-newwin-ws')
const OPENED = path.join(WS, 'opened.md')
const FRESH = path.join(WS, 'fresh.md')

async function main() {
  const report = new Reporter('「在新窗口打开」：已打开的文件不重复开窗')
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }

  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  fs.writeFileSync(OPENED, '# opened\n', 'utf-8')
  fs.writeFileSync(FRESH, '# fresh\n', 'utf-8')

  try {
    await ev(`(async () => {
      const f = window.__L.files()
      await f.setRoot(${JSON.stringify(WS)})
      await f.openPath(${JSON.stringify(OPENED)})
      return 'ok'
    })()`)
    await sleep(1000)
    const before = (await appPages()).length

    // ── ① 已经打开的文件：不许开出第二个窗口 ────────────────────────────────
    await ev(`window.luminAPI.app.openInNewWindow(${JSON.stringify(OPENED)})`)
    await sleep(2500)
    const after = (await appPages()).length
    report.check(
      'already-open-file-does-not-open-second-window',
      before === after && before >= 1,
      `窗口数 ${before} → ${after}（应当不变）`
    )
    const notified = JSON.parse(
      await ev(`(async () => {
        const list = await window.luminAPI.notifications.list({ includeClosed: true })
        const hit = list.find((n) => String(n.body).includes('opened.md'))
        return JSON.stringify({ count: list.length, hit: hit ? { level: hit.level, title: hit.title } : null })
      })()`)
    )
    report.check(
      'already-open-file-explains-why',
      !!notified.hit && notified.hit.level === 'info',
      JSON.stringify(notified.hit ?? notified)
    )

    // ── ② 没打开的文件：照常开新窗口（反向断言，防止改坏功能）────────────────
    await ev(`window.luminAPI.app.openInNewWindow(${JSON.stringify(FRESH)})`)
    let grew = false
    for (let i = 0; i < 30 && !grew; i += 1) {
      await sleep(400)
      grew = (await appPages()).length > after
    }
    report.check(
      'closed-file-still-opens-a-new-window',
      grew === true,
      `窗口数 ${after} → ${(await appPages()).length}`
    )
  } finally {
    await ev(`(async () => {
      await window.luminAPI.notifications.closeAll()
      await window.__L.files().setRoot(null)
      return 'ok'
    })()`).catch(() => {})
    fs.rmSync(WS, { recursive: true, force: true })
  }

  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
