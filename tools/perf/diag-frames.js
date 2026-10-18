'use strict'
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const {
  connect,
  settle,
  waitEditor,
  sleep,
  launchStable,
  bringToFront,
  framesAlive,
  requireFrames
} = require(path.join(__dirname, '..', 'lib', 'harness'))
const { build } = require('./fixtures')
const { PROBE_SRC } = require('./probe')

;(async () => {
  const fx = build()
  const ud = path.join(os.tmpdir(), 'xw-perf-ud')
  const inst = await launchStable({
    tag: 'diag',
    userData: ud,
    ports: [9468, 9469],
    tries: 1,
    readyMs: 120000,
    rootDir: path.join(__dirname, '..', '..'),
    extraArgs: [`--lumin-open=${encodeURIComponent(fx.real.path)}`]
  })
  if (!inst.ok) {
    console.error(inst.attempts)
    process.exit(1)
  }
  const app = await connect({ port: inst.port })
  await settle(app.ev)
  await waitEditor(app.ev)
  await app.ev(PROBE_SRC)
  await sleep(800)
  const raise = () =>
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'raise-window.ps1'),
        '-Leaf',
        'xw-perf-ud'
      ],
      { encoding: 'utf8' }
    ).stdout.trim()
  console.log('raise', raise())
  await bringToFront(app)
  await sleep(300)
  console.log('idle', await app.ev(`(async()=>JSON.stringify(await window.__P.idle(600)))()`))
  console.log(
    'state',
    await app.ev(
      `JSON.stringify({vis:document.visibilityState,hidden:document.hidden,focus:document.hasFocus(),raf:window.__RAF})`
    )
  )
  await app.ev(
    `(() => { window.__RAF='pending'; window.__RAF2=0; requestAnimationFrame(()=>{window.__RAF='ok';window.__RAF2++}); return 'set' })()`
  )
  for (let i = 0; i < 10; i += 1) {
    console.log(
      'poll',
      i,
      await app.ev(
        `JSON.stringify({raf:window.__RAF,n:window.__RAF2,vis:document.visibilityState,focus:document.hasFocus()})`
      )
    )
    await sleep(100)
  }
  console.log('front', JSON.stringify(await app.send('Page.bringToFront')))
  await sleep(300)
  await app.ev(
    `(() => { window.__RAF='pending2'; requestAnimationFrame(()=>{window.__RAF='ok2'}); return 'set2' })()`
  )
  for (let i = 0; i < 5; i += 1) {
    console.log('poll2', i, await app.ev(`window.__RAF`))
    await sleep(100)
  }
  console.log('framesAlive', await framesAlive(app))
  try {
    await requireFrames(app, 'diag')
    console.log('requireFrames ok')
  } catch (e) {
    console.log('requireFrames fail', e.message)
  }
  app.close()
  inst.close()
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*xw-perf-ud*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ],
    { stdio: 'ignore' }
  )
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
