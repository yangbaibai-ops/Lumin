'use strict'
// 验收：插入图片（审计 §7 第 16 条：此前只有"手打 URL"一条路）
//
// 判据（都在真实页面上做）：
//   1. **粘贴**剪贴板里的图片 → 落进 `<工作区>/assets/`，磁盘上真的有那个文件、
//      且是一个合法 PNG（读头 8 字节）；正文里插进的是**相对文档**的路径；
//   2. 图能**渲染出来**（`<img>` 的 naturalWidth > 0，走的是 lumin-file:// 协议）；
//   3. **同一张图粘两次**不互相覆盖（资源名带时间戳 / 主进程再编号）；
//   4. 没有工作区也没有文档路径时，给一句能照做的提示（而不是静默失败）。
//
// 为什么用合成 ClipboardEvent 而不是真按键：粘贴图片走的是 `handlePaste` 的
// `clipboardData.files`，这条路径在页面里可以**完整**构造（DataTransfer + File），
// 不需要系统剪贴板；比起"先往剪贴板塞一张图再 Ctrl+V"这种依赖外部工具的写法稳得多。
const { connect, settle, sleep, openDocWith, Reporter, fatal } = require('./lib/harness')
const os = require('os')
const path = require('path')
const fs = require('fs')

/** 1×1 的合法 PNG（最小可渲染图片） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const MD = '# 图片验收\n\n正文一段。\n'

/** 在页面里造一个 File 并派发 paste 事件（走 handlePaste 的 files 分支） */
const pasteImage = (base64, name) => `(async () => {
  const bin = atob(${JSON.stringify(base64)})
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  const file = new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const el = document.querySelector('.ProseMirror')
  if (!el) return 'no-editor'
  el.focus()
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  el.dispatchEvent(ev)
  return 'dispatched'
})()`

/** 正文里的图片 src 列表（从 markdown 源里取，避免依赖渲染结构） */
const SOURCES = `JSON.stringify((() => {
  const md = window.__L.files().current?.content ?? ''
  return [...md.matchAll(/!\\[[^\\]]*\\]\\(([^)]+)\\)/g)].map((m) => m[1])
})())`

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const report = new Reporter('插入图片：粘贴 / 落点 / 相对路径 / 渲染 / 不覆盖')
  const { ev } = app

  // 自己的工作区夹具（套件要自足：不赌上一条套件留下的状态）
  const ws = path.join(os.tmpdir(), 'lumin-image-ws')
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true })
  const doc = path.join(ws, 'notes', 'img.md')
  fs.writeFileSync(doc, MD, 'utf-8')
  await ev(
    `(async () => { await window.__L.files().setRoot(${JSON.stringify(ws)}); return 'ok' })()`
  )
  await sleep(700)
  await openDocWith(app, MD, 'img-fixture.md')
  await sleep(500)
  // 用工作区里的那份文档（这样"相对文档"的语义才有东西可验：文档在 notes/ 里）
  const opened = await ev(
    `(async () => { return await window.__L.files().openPath(${JSON.stringify(doc)}) })()`
  )
  await sleep(800)
  report.check('fixture-doc-opened', opened === true || opened === undefined, String(opened))

  // ── ① 粘贴 → 落盘 + 插入相对路径 ──────────────────────────────────────────
  const dispatched = await ev(pasteImage(PNG_BASE64, 'clipboard.png'))
  report.check('paste-dispatched', dispatched === 'dispatched', String(dispatched))
  await sleep(1200) // IPC 落盘 + 编辑器插入 + 序列化防抖

  const assets = fs.existsSync(path.join(ws, 'assets'))
    ? fs.readdirSync(path.join(ws, 'assets'))
    : []
  report.check(
    'asset-written-to-workspace',
    assets.length === 1 && /^clipboard-\d{8}-\d{6}\.png$/.test(assets[0]),
    JSON.stringify(assets)
  )
  const assetPath = assets.length ? path.join(ws, 'assets', assets[0]) : ''
  const head =
    assetPath && fs.existsSync(assetPath)
      ? fs.readFileSync(assetPath).subarray(0, 8)
      : Buffer.alloc(0)
  report.check(
    'asset-bytes-are-png',
    head.length === 8 && head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    head.toString('hex')
  )

  const sources = JSON.parse(await ev(SOURCES))
  report.check(
    'markdown-src-is-relative-to-doc',
    sources.length === 1 && sources[0] === `../assets/${assets[0]}`,
    JSON.stringify(sources)
  )

  // ── ② 渲染：<img> 真的加载出来了（lumin-file:// 协议 + 媒体白名单） ──────────
  /**
   * 这里**必须轮询**，不能睡固定时长（实测本套件在整轮矩阵里偶发 8/9：`image-renders` 红、
   * 单独重跑立刻绿）。原因是图片经 `lumin-file://` 走协议层 + 磁盘 IO，机器忙时 600ms 不一定够；
   * 而"等够 600ms"本身也没有语义 —— 有语义的是"最终会不会渲染出来"。
   */
  let rendered = { found: false }
  for (let i = 0; i < 24; i += 1) {
    rendered = JSON.parse(
      await ev(`JSON.stringify((() => {
        const img = document.querySelector('.ProseMirror img')
        if (!img) return { found: false }
        return { found: true, src: img.getAttribute('src') || '', w: img.naturalWidth, complete: img.complete }
      })())`)
    )
    if (rendered.found && rendered.complete && rendered.w > 0) break
    await sleep(250)
  }
  report.check(
    'image-renders',
    rendered.found === true && rendered.complete === true && rendered.w > 0,
    JSON.stringify(rendered)
  )

  // ── ③ 同一张图粘两次：两个文件、两条 src，谁都不覆盖 ────────────────────────
  await sleep(1100) // 让时间戳换一秒（资源名精确到秒）
  await ev(pasteImage(PNG_BASE64, 'clipboard.png'))
  await sleep(1200)
  const assets2 = fs.readdirSync(path.join(ws, 'assets'))
  const sources2 = JSON.parse(await ev(SOURCES))
  report.check(
    'second-paste-does-not-overwrite',
    assets2.length === 2 && sources2.length === 2 && new Set(sources2).size === 2,
    JSON.stringify({ assets: assets2, sources: sources2 })
  )

  // ── ④ 没有工作区也没有文档路径 → 明确提示，不静默、也不往歪处写 ──────────────
  const noWorkspace = await ev(`(async () => {
    const files = window.__L.files()
    await files.close()
    await files.setRoot(null)
    await files.openUntitled()
    await new Promise((r) => setTimeout(r, 400))
    return JSON.stringify({ root: files.root, path: files.current?.path ?? null })
  })()`)
  report.check(
    'untitled-no-workspace-state',
    JSON.parse(noWorkspace).root === null && JSON.parse(noWorkspace).path === null,
    noWorkspace
  )
  const before = await ev(`window.__L.files().current?.content ?? ''`)
  await ev(pasteImage(PNG_BASE64, 'clipboard.png'))
  await sleep(900)
  const after = await ev(`window.__L.files().current?.content ?? ''`)
  const warned = await ev(`(() => {
    const el = document.querySelector('[data-notification-center]')
    return el ? el.textContent.trim().slice(0, 120) : ''
  })()`)
  report.check(
    'untitled-without-workspace-warns-instead-of-writing',
    !String(after).includes('![') && String(after) === String(before) && String(warned).length > 0,
    JSON.stringify({ inserted: String(after).includes('!['), warned })
  )

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
