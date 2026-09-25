'use strict'
// ─── 验收：**打包态**的快速组（审计 §6 P2「打包态代码路径缺乏常驻覆盖」）─────────────
//
// 审计的现场：默认矩阵（58 条）跑的都是**未打包**实例（`is.dev === true`），而真正只有打包态才会
// 走到的代码路径基本没人守 —— 那条 P2 点名了 CSP 头、`app.isPackaged`、asar 资源路径；
// §11 第 1 条还专门把「打包态 CSP 头是否生效、`lumin-file://` 图片是否被拦」列成**待实测**。
//
// 这条套件就是那个"快的一组"：**只对着 `dist/win-unpacked` 产物起一个实例**，6 条断言，
// 不重打包、不跑 NSIS、不抠 exe 图标（那些在 `_verify-packaging.js` 里，属发版前的慢组）。
// 它**不会自己构建**：没有产物就如实 SKIP 并提示先跑 `npm run build:unpack`
//（构建要几分钟，不该藏在一条套件的超时里）。
//
// 跑法：
//   npm run build:unpack                                  # 产物 dist/win-unpacked/Lumin.exe
//   node tools/run-suites.js --suite=_verify-packaging-fast.js
//
// 覆盖（每条都对着"只有打包态才成立"的事实）：
//   F1 产物在（否则整条 SKIP）
//   F2 asar 里的资源路径可用：渲染层起来了 + **动态 import 的设置面板**也能加载
//      （懒加载 chunk 若在 asar 里取不到，这一步会白屏 —— dev 态永远测不出来）
//   F3 `<meta>` 里的 CSP 逐字等于 `src/shared/csp.ts` 的 `PROD_CSP`（单一真相源）
//   F4 CSP 真的在拦：远程 `fetch` 触发 `securitypolicyviolation`（connect-src），并且请求被拒
//      ⚠️ 只断言"fetch 失败"是不够的 —— 这台机器没网也会失败；**违规事件**才是 CSP 的证据
//   F5 `lumin-file://` 本地图片能显示（`naturalWidth > 0`）：`img-src` 里那一条在打包态有效
//   F6 `app.isPackaged === true`：诊断文本里**没有**"开发态"标记（打包独有的分支真的走的是打包那支）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

const REPO = path.resolve(__dirname, '..')
const UNPACKED_EXE = path.join(REPO, 'dist', 'win-unpacked', 'Lumin.exe')
const ICON_PNG = path.join(REPO, 'resources', 'icon.png')
const USER_DATA = path.join(os.tmpdir(), 'lumin-pkgfast-userdata')
const PORT = 9225

/** 只杀**自己这个 profile** 的打包实例：绝不碰用户自己在跑的 Lumin */
function killOwnPackaged() {
  const marker = path.basename(USER_DATA)
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='Lumin.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ],
    { encoding: 'utf-8', timeout: 60000 }
  )
}

/** 造一个临时工作区：一篇引用本地图片的 markdown（走裸路径参数打开） */
function makeWorkspace() {
  const dir = path.join(os.tmpdir(), 'lumin-pkgfast-ws')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(ICON_PNG, path.join(dir, 'pic.png'))
  const doc = path.join(dir, 'doc.md')
  fs.writeFileSync(doc, '# 打包态\n\n![本地图片](./pic.png)\n', 'utf-8')
  return { dir, doc }
}

async function main() {
  const report = new Reporter('打包态快速组（CSP / lumin-file 图片 / asar 懒加载 / isPackaged）')
  if (!fs.existsSync(UNPACKED_EXE)) {
    report.skip(
      'F1 打包产物存在',
      `找不到 ${path.relative(REPO, UNPACKED_EXE)} —— 先跑 npm run build:unpack（构建要几分钟，不藏在套件里）`
    )
    return report.finish()
  }
  report.check('F1 打包产物存在', true, path.relative(REPO, UNPACKED_EXE))

  const { dir, doc } = makeWorkspace()
  killOwnPackaged()
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  await sleep(300)

  /**
   * 主进程的 stdout/stderr 落到文件：`lumin-file://` 被拒时主进程会打一行
   * `[protocol] refused lumin-file request: …`（ASCII），没有这行日志就只能靠猜
   *（这条套件的第一次运行就是这么发现图片加载失败的）。
   */
  const appLog = path.join(os.tmpdir(), 'lumin-pkgfast-app.log')
  fs.writeFileSync(appLog, '', 'utf-8')
  const logFd = fs.openSync(appLog, 'a')
  const appLogTail = (n = 6) => {
    try {
      return fs
        .readFileSync(appLog, 'utf-8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-n)
        .join(' ⏎ ')
    } catch {
      return '(no log)'
    }
  }

  const child = spawn(
    UNPACKED_EXE,
    [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`, doc],
    { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, LUMIN_DEBUG_PORT: String(PORT) } }
  )
  child.unref()

  let app = null
  try {
    // 打包实例首启比 dev 慢（asar 解压 + 单实例锁），给足时间轮询
    for (let i = 0; i < 40 && !app; i++) {
      await sleep(500)
      try {
        app = await connect({ port: PORT, timeoutMs: 4000, bringToFront: true })
      } catch {
        app = null
      }
    }
    if (!app) {
      report.check('F2 打包实例能连上 CDP', false, '连不上调试端口（产物启动失败？见 _verify-packaging.js 的排障说明）')
      return report.finish()
    }
    const { ev } = app
    if (!(await settle(ev))) {
      report.check('F2 打包实例进入就绪态', false, '窗口起来了但没注入 window.__L')
      return report.finish()
    }

    // ── F2 asar 资源路径：懒加载的设置面板（动态 import 的 chunk）必须能从 asar 里取到 ──
    const lazily = await ev(`(async () => {
      window.__L.ui().openSettings()
      for (let i = 0; i < 60 && !document.querySelector('[data-settings-page] .settings-nav'); i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      const page = document.querySelector('[data-settings-page]')
      const loaded = !!document.querySelector('[data-settings-page] .settings-nav')
      window.__L.ui().closeSettings()
      return JSON.stringify({ page: !!page, loaded })
    })()`)
    const lazy = JSON.parse(lazily)
    report.check(
      'F2 asar 里的懒加载 chunk 可用（动态 import 的设置面板真的渲染出来）',
      lazy.page === true && lazy.loaded === true,
      lazily
    )

    // ── F3/F4 CSP ──
    const csp = require('../src/shared/csp.ts')
    const cspProbe = JSON.parse(
      await ev(`(async () => {
        const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
        const violations = []
        const onViolation = (e) => violations.push({
          directive: e.effectiveDirective || e.violatedDirective || null,
          blocked: e.blockedURI || null
        })
        document.addEventListener('securitypolicyviolation', onViolation)
        let fetchOk = null
        try {
          await fetch('https://example.com/csp-probe')
          fetchOk = true
        } catch {
          fetchOk = false
        }
        await new Promise((r) => setTimeout(r, 200))
        document.removeEventListener('securitypolicyviolation', onViolation)
        return JSON.stringify({ meta: meta ? meta.getAttribute('content') : null, fetchOk, violations })
      })()`)
    )
    report.check(
      'F3 打包态 <meta> 的 CSP 逐字等于 shared/csp.ts 的 PROD_CSP（单一真相源）',
      cspProbe.meta === csp.PROD_CSP,
      JSON.stringify({ len: cspProbe.meta?.length ?? null, expected: csp.PROD_CSP.length })
    )
    const connViolation = (cspProbe.violations ?? []).find((v) => /connect-src/.test(v.directive ?? ''))
    report.check(
      'F4 CSP 真的在拦远程连接（securitypolicyviolation → connect-src，且 fetch 被拒）',
      !!connViolation && cspProbe.fetchOk === false,
      JSON.stringify(cspProbe.violations)
    )

    // ── F5 lumin-file:// 本地图片 ──
    const img = JSON.parse(
      await ev(`(async () => {
        for (let i = 0; i < 60; i++) {
          const el = document.querySelector('.ProseMirror img')
          if (el && el.complete && el.naturalWidth > 0) break
          await new Promise((r) => setTimeout(r, 150))
        }
        const el = document.querySelector('.ProseMirror img')
        // 第一条测量：**什么都不做**时它到底出来没有（这才是用户看到的那张图）
        const firstNaturalWidth = el ? el.naturalWidth : 0
        // 诊断用：直接把那个 src fetch 一次，看协议处理器给了什么（200/404/异常）
        let probe = null
        if (el) {
          try {
            const res = await fetch(el.getAttribute('src'))
            probe = 'status ' + res.status
          } catch (e) {
            probe = 'throw ' + String(e).slice(0, 60)
          }
        }
        /**
         * 第二条诊断：图片没出来的话，手动把「本窗口当前文档」补报一次主进程再重载图片。
         * 用来区分两种可能：① 协议白名单根本没放行（补报也没用）；② 白名单没拿到
         * "这篇文档开着" 这条信息（补报后立刻就好）—— 后者是启动流程里的真 bug。
         */
        let manualRetry = null
        if (el && el.naturalWidth === 0) {
          const p = window.__L.files().current?.path ?? null
          if (p) {
            window.luminAPI.app.reportWindowDoc(p)
            await new Promise((r) => setTimeout(r, 400))
            const src = el.getAttribute('src')
            el.setAttribute('src', '')
            await new Promise((r) => setTimeout(r, 120))
            el.setAttribute('src', src)
            for (let i = 0; i < 20 && el.naturalWidth === 0; i++) {
              await new Promise((r) => setTimeout(r, 150))
            }
            manualRetry = { reported: p, naturalWidth: el.naturalWidth }
          } else {
            manualRetry = { reported: null, naturalWidth: 0 }
          }
        }
        return JSON.stringify({
          present: !!el,
          src: el ? el.getAttribute('src') ?? null : null,
          naturalWidth: firstNaturalWidth,
          complete: el ? el.complete : false,
          probe,
          manualRetry
        })
      })()`)
    )
    report.check(
      'F5 lumin-file:// 本地图片在打包态能显示（naturalWidth > 0）',
      img.present === true && img.naturalWidth > 0,
      JSON.stringify(img) + ' | 主进程日志尾部：' + appLogTail()
    )

    // ── F6 app.isPackaged ──
    const diag = JSON.parse(
      await ev(`(async () => {
        const lang = window.__L.settings().language
        const text = String(await window.luminAPI.app.getDiagnostics())
        const version = await window.luminAPI.app.getVersion()
        // 诊断文本很长：**整篇**找版本行与"开发态"标记（只看头几行会漏，实测过）
        const versionLine = text.split('\\n').find((l) => l.includes('Lumin:')) ?? ''
        return JSON.stringify({ lang, version, versionLine, hasVersion: text.includes(version) })
      })()`)
    )
    const packs = {
      'zh-CN': '（开发态）',
      'en-US': ' (dev)',
      'ru-RU': ' (dev)'
    }
    const devMarker = packs[diag.lang] ?? packs['zh-CN']
    report.check(
      'F6 app.isPackaged === true（诊断文本的版本行里没有"开发态"标记）',
      diag.versionLine.includes(diag.version) && !diag.versionLine.includes(devMarker),
      JSON.stringify(diag)
    )

    app.close()
  } finally {
    killOwnPackaged()
    try {
      fs.closeSync(logFd)
    } catch {
      /* 已经关了就算了 */
    }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(USER_DATA, { recursive: true, force: true })
  }
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
