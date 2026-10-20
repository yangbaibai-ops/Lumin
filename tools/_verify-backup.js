'use strict'
// 验收：备份与快照（审计 §2 P1「没有任何自动备份 / 工作区级导出」）
//
// 要证的四件事：
//   ① **库备份真的落盘且是能打开的库**：读前 16 字节必须是 `SQLite format 3\0` ——
//      只断言"文件存在"是不够的，一个 0 字节文件也能"存在"；
//   ② **轮换只保留 7 份、只删自己命名的那些**：预置 7 份假备份 + 一次真备份 = 8 → 必须剩 7，
//      且用户自己丢在备份目录里的文件一个都不能动；
//   ③ **工作区快照是标准 zip**：这一步用 **Windows 自带的 `Expand-Archive`** 解压，
//      再检查解出来的目录树。只用自己的代码读自己的 zip 是"自证"，证明不了别的工具能打开它；
//   ④ 跳过的东西**如实报告**：隐藏目录（.git）、node_modules、写盘临时文件都不该进归档，
//      且数量要对得上（用户得知道快照少了什么）。
//
// 为什么自管实例：工作区快照会弹原生「另存为」对话框，自动化取消不了，必须用**仅开发态**的
// 旁路 `LUMIN_EXPORT_DIR`（见 src/main/testPaths.ts）。环境变量必须在**实例启动前**给到，
// 所以这个套件自己起实例（端口 9234，避开运行器的 9222 与导出套件的 9233）。
const os = require('os')
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { connect, settle, sleep, startIsolated, Reporter, fatal } = require('./lib/harness')

const PORT = 9234
const ROOT = path.resolve(__dirname, '..')
const WS = path.join(os.tmpdir(), 'lumin-backup-ws')
const OUT = path.join(os.tmpdir(), 'lumin-backup-out')
const UD = path.join(os.tmpdir(), 'lumin-backup-ud')
const DIR_B = path.join(os.tmpdir(), 'lumin-backup-target')
const DIR_C = path.join(os.tmpdir(), 'lumin-backup-target2')
const EXTRACT = path.join(os.tmpdir(), 'lumin-backup-extract')

/** 1×1 PNG：验证图片**逐字节**穿过 zip（不是"解出来有个文件"就算数） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** 走项目标准的隔离实例入口（起/杀都按 --user-data-dir 精确匹配，不碰用户自己的 profile）。
 *  LUMIN_EXPORT_DIR 由 powershell 继承 → Start-Process 再传给 Electron（见 lib/harness.startIsolated） */
function isolated(userData, port, cleanupOnly = false) {
  return startIsolated({ userData, port, env: { LUMIN_EXPORT_DIR: OUT }, cleanupOnly })
}

function makeFixtures() {
  for (const d of [WS, OUT, UD, DIR_B, DIR_C, EXTRACT]) {
    fs.rmSync(d, { recursive: true, force: true })
  }
  fs.mkdirSync(path.join(WS, 'sub'), { recursive: true })
  fs.mkdirSync(path.join(WS, 'img'), { recursive: true })
  fs.mkdirSync(path.join(WS, '.git'), { recursive: true })
  fs.mkdirSync(path.join(WS, 'node_modules', 'x'), { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(DIR_B, { recursive: true })
  fs.mkdirSync(DIR_C, { recursive: true })
  fs.writeFileSync(path.join(WS, 'a.md'), '# 甲\n\n正文 A\n', 'utf-8')
  fs.writeFileSync(path.join(WS, 'sub', 'b.md'), '# 乙\n\n正文 B\n', 'utf-8')
  fs.writeFileSync(path.join(WS, 'img', 'pic.png'), PNG)
  fs.writeFileSync(path.join(WS, '.git', 'secret.md'), '不该进归档\n', 'utf-8')
  fs.writeFileSync(path.join(WS, 'node_modules', 'x', 'y.js'), 'module.exports = 1\n', 'utf-8')
  fs.writeFileSync(path.join(WS, 'stale.md.deadbeef.lumin-tmp'), '半写状态的副本\n', 'utf-8')
}

/** 预置 7 份"旧备份"（名字是我们的形状、时间在 2020 年）+ 1 个用户自己的文件 */
function seedOldBackups() {
  fs.writeFileSync(path.join(DIR_B, 'notes.txt'), 'user file\n', 'utf-8')
  for (let i = 1; i <= 7; i += 1) {
    const day = String(i).padStart(2, '0')
    fs.writeFileSync(path.join(DIR_B, `lumin-202001${day}-0000.db`), 'fake\n', 'utf-8')
  }
}

/** 列出解压后的相对路径（正斜杠） */
function tree(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) tree(p, base, out)
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out.sort()
}

async function main() {
  const report = new Reporter('备份与快照：库备份落盘/轮换 + 工作区快照 zip')
  makeFixtures()

  const code = isolated(UD, PORT)
  if (code !== 0) {
    report.skip('备份与快照', `隔离实例没起来（start-isolated.ps1 exit=${code}）`)
    return report.finish()
  }

  let app = null
  try {
    app = await connect({ port: PORT })
    if (!(await settle(app.ev))) {
      report.skip('备份与快照', '页面没就绪')
      return report.finish()
    }
    const ev = app.ev
    const call = async (expr) =>
      JSON.parse(String(await ev(`(async () => JSON.stringify(${expr}))()`)))

    // ── ① 默认口径 ──────────────────────────────────────────────────────────
    // 先关掉自动备份：主进程有个"启动后 20 秒补一次"的定时器（startAutoBackup），
    // 不关掉的话下面"目录是空的"这条断言会随机器忙闲而随机变红 —— 套件要测的是
    // 我们显式触发的行为，别让后台定时器插进来。
    await ev(
      `(async () => { await window.luminAPI.settings.update({ backupAuto: false }); return 'ok' })()`
    )
    const st0 = await call('await window.luminAPI.backup.status()')
    report.check(
      'status-default-dir-and-keep',
      st0.keep === 7 &&
        typeof st0.dir === 'string' &&
        st0.dir.length > 0 &&
        st0.isDefaultDir === true,
      JSON.stringify({ dir: st0.dir, keep: st0.keep, isDefault: st0.isDefaultDir })
    )
    report.check(
      'status-before-any-backup-is-empty',
      Array.isArray(st0.files) && st0.files.length === 0 && st0.lastMs === null,
      JSON.stringify({ files: st0.files.length, lastMs: st0.lastMs })
    )

    // ── ② 设置键能读写（新键落在既有 kv 里，不靠重启）────────────────────────
    await ev(
      `(async () => { await window.luminAPI.settings.update({ backupAuto: true, backupDir: ${JSON.stringify(DIR_B)} }); return 'ok' })()`
    )
    const s1 = await call('await window.luminAPI.settings.getAll()')
    report.check(
      'settings-persist-backup-keys',
      s1.backupAuto === true && s1.backupDir === DIR_B,
      JSON.stringify({ backupAuto: s1.backupAuto, backupDir: s1.backupDir })
    )

    // ── ③ 换目录 → 立刻补第一份（不是"等到明天"）────────────────────────────
    // 触发点在 settings:update 的 backupAuto/backupDir 分支（ipc.ts）。
    // ⚠️ 这一步必须在**空目录**上做：`lastBackupMs` 会拿目录里已有备份的时间当判据，
    //    预置的假备份会把"该备"判成"还没到点"（第一版就是这么红的 —— 那其实是**正确行为**，
    //    是夹具顺序错了：先验"空目录立刻补一份"，再灌旧备份去验轮换）。
    let first = null
    for (let i = 0; i < 25 && !first; i += 1) {
      await sleep(400)
      first = fs.readdirSync(DIR_B).find((f) => /^lumin-\d{8}-\d{4}\.db$/.test(f))
    }
    const header = first
      ? fs.readFileSync(path.join(DIR_B, first)).subarray(0, 16).toString('latin1')
      : ''
    report.check(
      'changing-dir-writes-first-backup-immediately',
      !!first && header === 'SQLite format 3\0',
      JSON.stringify({
        first,
        header,
        bytes: first ? fs.statSync(path.join(DIR_B, first)).size : 0
      })
    )

    // ── ④ 手动备份：真的写出了一个能打开的库 ────────────────────────────────
    seedOldBackups() // 7 份旧备份 + 1 个用户文件：下一步验轮换用
    await ev(
      `(async () => { await window.luminAPI.settings.update({ backupAuto: false }); return 'ok' })()`
    )
    const run = await call('await window.luminAPI.backup.run()')
    const runBytes = run.path && fs.existsSync(run.path) ? fs.statSync(run.path).size : 0
    const runHeader = run.path ? fs.readFileSync(run.path).subarray(0, 16).toString('latin1') : ''
    report.check(
      'manual-run-writes-valid-sqlite',
      run.ok === true && run.kind === 'manual' && runBytes > 0 && runHeader === 'SQLite format 3\0',
      JSON.stringify({ ok: run.ok, kind: run.kind, bytes: runBytes, header: runHeader })
    )

    // ── ⑤ 轮换：8 份（7 假 + 1 真）→ 只留 7，且不碰用户的文件 ────────────────
    const left = fs.readdirSync(DIR_B)
    const backups = left.filter((f) => /^lumin-\d{8}-\d{4}\.db$/.test(f))
    report.check(
      'rotation-keeps-seven-and-deletes-oldest',
      backups.length === 7 && !left.includes('lumin-20200101-0000.db'),
      JSON.stringify({
        count: backups.length,
        oldestStillThere: left.includes('lumin-20200101-0000.db')
      })
    )
    report.check(
      'rotation-leaves-foreign-files-alone',
      left.includes('notes.txt') && run.removed >= 1,
      JSON.stringify({ notes: left.includes('notes.txt'), removed: run.removed })
    )

    // ── ⑥ 状态回头反映现状（目录 / 份数 / 上次时间）─────────────────────────
    const st1 = await call('await window.luminAPI.backup.status()')
    report.check(
      'status-reports-count-and-last-time',
      st1.dir === DIR_B &&
        st1.isDefaultDir === false &&
        st1.files.length === 7 &&
        st1.lastMs > 0 &&
        st1.files.every((f) => f.size > 0 && f.mtimeMs > 0),
      JSON.stringify({ dir: st1.dir, count: st1.files.length, lastMs: st1.lastMs })
    )

    // ── ⑦ 设置界面改目录后，**渲染层 store 也要跟着变** ──────────────────────
    // 这是个真实踩过的坑：`backup:chooseDir` / `backup:useDefaultDir` 直接写 kv，
    // 而 settings store 的 `persist()` 会把**整份** AppSettings 回写 —— store 里的
    // `backupDir` 还停在旧值，于是"选完目录再动任何一个设置开关"就把目录悄悄打回默认
    // （用户视角：选了别的盘，重启后变回默认目录）。
    // 所以这里先在 store 里放一个"别的盘"，再点界面上的「用默认目录」，
    // 最后**故意改一个无关设置**触发整块回写 —— 目录必须仍然是"默认"。
    const sync = JSON.parse(
      String(
        await ev(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms))
          window.__L.settings().$patch({ backupDir: ${JSON.stringify(DIR_C)}, backupAuto: true })
          await wait(700) // 等 store 的节流 persist 落库
          window.__L.ui().openSettings('general')
          let btn = null
          for (let i = 0; i < 25 && !btn; i++) {
            await wait(150)
            btn = document.querySelector('[data-backup-default-dir]')
          }
          if (!btn) return JSON.stringify({ found: false })
          btn.click()
          await wait(700)
          const afterClick = window.__L.settings().backupDir
          // 再动一个**无关**设置：store 会把整份设置回写
          window.__L.settings().set('lineHeight', 1.8)
          await wait(900)
          window.__L.ui().closeSettings()
          return JSON.stringify({ found: true, afterClick, storeAfterPersist: window.__L.settings().backupDir })
        })()`)
      )
    )
    const s3 = await call('await window.luminAPI.settings.getAll()')
    report.check(
      'store-follows-dir-change-from-ui',
      sync.found === true && sync.afterClick === null,
      JSON.stringify(sync)
    )
    report.check(
      'store-persist-does-not-resurrect-old-backup-dir',
      s3.backupDir === null,
      JSON.stringify({ kvBackupDir: s3.backupDir, store: sync.storeAfterPersist })
    )
    // 收尾：把备份目录换回 DIR_B，后面的快照段不依赖它，但保持口径清楚
    await ev(
      `(async () => { await window.luminAPI.settings.update({ backupDir: ${JSON.stringify(DIR_B)} }); return 'ok' })()`
    )

    // ── ⑧ 设置界面真的有入口（不能只做 IPC）─────────────────────────────────
    const ui = JSON.parse(
      String(
        await ev(`(async () => {
          window.__L.ui().openSettings('general')
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 150))
            if (document.querySelector('[data-backup-run]')) break
          }
          const ids = ['block', 'dir', 'count', 'choose-dir', 'run', 'snapshot', 'open-dir']
          const found = ids.filter((id) => !!document.querySelector('[data-backup-' + id + ']'))
          window.__L.ui().closeSettings()
          return JSON.stringify({ found })
        })()`)
      )
    )
    report.check('settings-has-backup-entries', ui.found.length === 7, JSON.stringify(ui))

    // ── ⑨ API 表面完整（漏一个方法渲染层就是句 TypeError）──────────────────
    const surface = await call(
      `Object.fromEntries(['status','run','chooseDir','useDefaultDir','revealDir','snapshotWorkspace']
         .map((k) => [k, typeof window.luminAPI.backup[k]]))`
    )
    report.check(
      'backup-api-surface-complete',
      Object.values(surface).every((t) => t === 'function'),
      JSON.stringify(surface)
    )

    // ── ⑩ 打开工作区的第一件事：清掉崩溃残留的写盘临时文件（审计 §2 P2）─────
    // 夹具里那个 `stale.md.deadbeef.lumin-tmp` 是**故意**放的：它模拟崩溃后残留的
    // 全文副本（隐私 + 磁盘占用），`workspace:setRoot` 会扫掉它。
    //
    // ⚠️ 清扫口径已收紧（用户报障：保存在退出时残留 `.lumin-tmp` 之后）：只删
    // 「本应用命名 + 年龄 > 10 分钟 + 同目录有对应目标文件」。所以这里要把夹具做成
    // **真的陈旧且目标还在**，否则它按新口径不该被删（而"不删"正是我们要保住的行为）。
    // 目标在断言完成后立刻移走，避免影响下面快照的条数（快照会收录 `stale.md`）。
    const TMP = path.join(WS, 'stale.md.deadbeef.lumin-tmp')
    const STALE_TARGET = path.join(WS, 'stale.md')
    fs.writeFileSync(STALE_TARGET, '目标文件\n', 'utf-8')
    const oldTime = new Date(Date.now() - 20 * 60 * 1000)
    fs.utimesSync(TMP, oldTime, oldTime)
    await ev(
      `(async () => { await window.luminAPI.workspace.setRoot(${JSON.stringify(WS)}); return 'ok' })()`
    )
    let swept = false
    for (let i = 0; i < 25 && !swept; i += 1) {
      await sleep(200)
      swept = !fs.existsSync(TMP)
    }
    report.check(
      'opening-workspace-sweeps-stale-temp-files',
      swept,
      `残留在 ${path.relative(WS, TMP)} 里 = ${!swept}`
    )
    report.check(
      'sweep-keeps-the-target-file',
      fs.existsSync(STALE_TARGET),
      '清扫只许删临时文件，目标文件必须原样在'
    )
    fs.rmSync(STALE_TARGET, { force: true })

    // ── ⑪ 工作区快照：条数 / 跳过的统计 ──────────────────────────────────────
    // 重新放一个临时文件：要验的是"快照会跳过它"，而扫除已经在上一步把旧的清掉了
    fs.writeFileSync(TMP, '半写状态的副本\n', 'utf-8')
    const snap = await call('await window.luminAPI.backup.snapshotWorkspace()')
    const zipBytes = snap && snap.path ? fs.statSync(snap.path).size : 0
    report.check(
      'snapshot-writes-zip-and-reports-counts',
      !!snap &&
        snap.files === 3 &&
        snap.zipBytes === zipBytes &&
        zipBytes > 0 &&
        snap.bytes >= PNG.length &&
        snap.skipped.hidden >= 2 &&
        snap.skipped.temp === 1,
      JSON.stringify({ snap, zipBytes })
    )

    // ── ⑬ 主进程侧写设置 → 渲染层 store 必须被动同步（`settings:changed` 回播）──────
    // 报告 §3.2 P0-1 的收口：主进程（原生菜单主题、备份目录选择）改设置时，渲染层不再是
    // "等下次拉取"，而是被广播就地 patch。这条用**备份目录**验：渲染层先放一个假值并落库，
    // 再调主进程的 `useDefaultDir()`（它直接写 kv + 广播），断言 store 里的值被改回来了
    // —— 没有广播的话 store 会一直停在假值上（那正是报告里"界面显示旧值到重启"的症状）。
    const broadcast = JSON.parse(
      await ev(`(async () => {
        const s = window.__L.settings()
        s.set('backupDir', 'D:\\\\lumin-nowhere\\\\fake-backup-dir')
        await new Promise((r) => setTimeout(r, 600))   // 等渲染层的 250ms 节流落库
        const before = s.backupDir
        await window.luminAPI.backup.useDefaultDir()    // 主进程侧写入 → 广播
        await new Promise((r) => setTimeout(r, 400))
        return JSON.stringify({ before, after: s.backupDir })
      })()`)
    )
    report.check(
      'main-side-settings-write-syncs-renderer-store',
      broadcast.before === 'D:\\lumin-nowhere\\fake-backup-dir' && broadcast.after === null,
      JSON.stringify(broadcast) +
        '（after 应回到 null：主进程写了并广播；若仍是假值说明 settings:changed 没到）'
    )

    // ── ⑫ 用 **Windows 自带工具**解压：证明这是个标准的 zip ──────────────────
    fs.mkdirSync(EXTRACT, { recursive: true })
    const unzip = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(snap.path)} -DestinationPath ${JSON.stringify(EXTRACT)} -Force`
      ],
      { stdio: 'ignore' }
    )
    const files = tree(EXTRACT)
    report.check(
      'snapshot-zip-extracts-with-windows-tool',
      unzip.status === 0 && files.includes('a.md') && files.includes('sub/b.md'),
      JSON.stringify({ exit: unzip.status, files })
    )

    // ── ⑬ 图片逐字节穿过 zip（中继任何一端坏掉都会在这里现形）───────────────
    const pic = path.join(EXTRACT, 'img', 'pic.png')
    report.check(
      'snapshot-keeps-image-bytes',
      fs.existsSync(pic) && Buffer.compare(fs.readFileSync(pic), PNG) === 0,
      JSON.stringify({
        exists: fs.existsSync(pic),
        bytes: fs.existsSync(pic) ? fs.statSync(pic).size : 0
      })
    )

    // ── ⑭ 该跳的都跳了（隐藏目录 / node_modules / 写盘临时文件）─────────────
    const bad = files.filter(
      (f) =>
        f.startsWith('.git/') ||
        f.startsWith('node_modules/') ||
        /\.lumin-tmp$/.test(f) ||
        f === 'stale.md.deadbeef.lumin-tmp'
    )
    report.check(
      'snapshot-excludes-hidden-temp-and-modules',
      bad.length === 0 && files.length === 3,
      JSON.stringify({ files, bad })
    )

    // ── ⑮ 没有工作区时必须明说（而不是导出一个空 zip 让人以为成功了）────────
    await ev(`(async () => { await window.luminAPI.workspace.setRoot(null); return 'ok' })()`)
    const noWs = String(
      await ev(`(async () => {
        try { await window.luminAPI.backup.snapshotWorkspace(); return 'no-throw' }
        catch (e) { return String((e && e.message) || e) }
      })()`)
    )
    report.check(
      'snapshot-requires-open-workspace',
      /WORKSPACE_NOT_OPEN/.test(noWs),
      noWs.slice(0, 120)
    )
  } finally {
    try {
      if (app) app.close()
    } catch {
      /* ignore */
    }
    isolated(UD, PORT, true) // 按 user-data-dir 精确收尾（连子进程一起）
  }

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
