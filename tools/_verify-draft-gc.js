'use strict'
// 验收：草稿目录的垃圾回收（审计 §2 P1「草稿写盘非原子、无 GC、键名可能相撞」的 GC 那一半）
//
// 判据（全部**在磁盘上**核对，不看界面）：
//   ① 崩溃残留的写盘临时文件（`*.tmp`）**不论多新**都被清掉 —— 它根本不是草稿，
//      `listDrafts` 也读不到它，只会在 `%APPDATA%` 里烂着；
//   ② 有磁盘正本的 `file-*` 草稿超过保留期才清（文档一保存它就被删，躺 30 天说明早没用了）；
//   ③ 连 JSON 都解不开的旧文件才清（现在草稿是原子写的，不会再产生截断文件）；
//   ④ 不认识的键、非 `.json` 文件、**任何 `untitled*` 键**一律不碰。
//
// 为什么自管实例：GC 跑在**启动路径**上，夹具必须在实例起来之前就躺在 `--user-data-dir` 里
// （端口 9235，避开运行器的 9222 与备份/导出的 9233/9234）。
//
// ⚠️ 未命名草稿（`untitled-*`）那一条**只由单测钉住**（tests/drafts.test.mjs 的 planDraftGc）：
//    启动窗口在开机时会按 `takeUntitledDraft` 认领/挪走/清空草稿，磁盘上分不出
//    "这份未命名草稿是被 GC 删的还是被应用正常消费掉的"。这里只验应用**从不碰**的那些条目。
const os = require('os')
const path = require('path')
const fs = require('fs')
const { createHash } = require('crypto')
const {
  connect,
  settle,
  sleep,
  startIsolated,
  spawnApp,
  Reporter,
  fatal
} = require('./lib/harness')

const PORT = 9235
const UD = path.join(os.tmpdir(), 'lumin-draftgc-ud')
const DRAFTS = path.join(UD, 'drafts')

const DAY = 24 * 60 * 60 * 1000
const OLD = Date.now() - 400 * DAY
const FRESH = Date.now() - 60 * 1000

/** 与 main/drafts.ts 的 keyToFile 同一套规则：sha1(键) 前 16 位 + `.json` */
const fileNameFor = (key) => createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json'
const fileKey = (p) => 'file-' + encodeURIComponent(p.toLowerCase())

const KEY_STALE = fileKey('D:\\ws\\old.md')
const KEY_FRESH = fileKey('D:\\ws\\new.md')
const NAME_STALE = fileNameFor(KEY_STALE)
const NAME_FRESH = fileNameFor(KEY_FRESH)

/** 写一个草稿夹具并设定 mtime（mtime 是 GC 的时间判据，必须可控） */
function seed(name, body, mtimeMs) {
  const p = path.join(DRAFTS, name)
  fs.writeFileSync(p, body, 'utf-8')
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
}

/** 夹具文件名 → 期望（'gone' = GC 该删，'kept' = 必须留着） */
const EXPECT = {
  // ① 写盘临时文件：崩溃在 writeFile 与 rename 之间留下的，**多新都删**
  'aaaaaaaaaaaaaaaa.json.deadbeef.tmp': 'gone',
  // ② 有磁盘正本的草稿：过期删、新鲜留（文件名用真哈希，方便顺手验证"留下的还读得出来"）
  [NAME_STALE]: 'gone', // 400 天
  [NAME_FRESH]: 'kept', // 1 分钟
  // ③ 解不开的旧文件：过期删、新鲜留
  'dddddddddddddddd.json': 'gone', // 坏 JSON + 400 天
  'eeeeeeeeeeeeeeee.json': 'kept', // 坏 JSON + 1 分钟
  // ④ 不认识的键 / 非 json：一律不碰
  'ffffffffffffffff.json': 'kept', // key = some-other-key + 400 天
  'notes.txt': 'kept',
  noext: 'kept'
}

function makeFixtures() {
  fs.rmSync(UD, { recursive: true, force: true })
  fs.mkdirSync(DRAFTS, { recursive: true })
  // ①
  seed('aaaaaaaaaaaaaaaa.json.deadbeef.tmp', '{"key":"x"}', FRESH)
  // ②
  seed(NAME_STALE, JSON.stringify({ key: KEY_STALE, content: '旧草稿', savedAt: OLD }), OLD)
  seed(NAME_FRESH, JSON.stringify({ key: KEY_FRESH, content: '新草稿', savedAt: FRESH }), FRESH)
  // ③
  seed('dddddddddddddddd.json', '{"key":"file-d_3a_5cbroken.md"', OLD) // 故意截断
  seed('eeeeeeeeeeeeeeee.json', '{"key":"file-d_3a_5cbroken.md"', FRESH)
  // ④
  seed('ffffffffffffffff.json', JSON.stringify({ key: 'some-other-key', content: '别的东西' }), OLD)
  seed('notes.txt', 'not a draft\n', OLD)
  seed('noext', 'not a draft\n', OLD)
}

/** 现在盘上还剩哪些夹具 */
function remaining() {
  const out = {}
  for (const name of Object.keys(EXPECT)) {
    const p = path.join(DRAFTS, name)
    out[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null
  }
  return out
}

async function main() {
  const report = new Reporter('草稿目录 GC：临时残留 / 过期 file- 草稿 / 坏文件')
  // 夹具必须在实例起来之前就位，而 `start-isolated.ps1` 会先删 user-data-dir ——
  // 所以这里先只清理（杀掉上一轮残留 + 删目录），种完夹具再**直接起**实例。
  startIsolated({ userData: UD, port: PORT, cleanupOnly: true })
  makeFixtures()
  const proc = spawnApp({ userData: UD, port: PORT })

  let app = null
  try {
    app = await connect({ port: PORT, timeoutMs: 60000 })
    if (!(await settle(app.ev))) {
      report.skip('草稿 GC', '页面没就绪')
      return report.finish()
    }
    // GC 在 whenReady 里 `void gcDrafts()`：页面就绪基本已经跑完，但仍轮询一下（最多 10s）
    let left = remaining()
    const pending = () =>
      Object.keys(EXPECT).filter((n) => (left[n] === null ? 'gone' : 'kept') !== EXPECT[n])
    for (let i = 0; i < 25 && pending().length; i += 1) {
      await sleep(400)
      left = remaining()
    }

    const wrong = pending()
    report.check('draft-gc-matches-expectation', wrong.length === 0, JSON.stringify({ wrong }))
    report.check(
      'draft-gc-removes-crash-temp-file',
      left['aaaaaaaaaaaaaaaa.json.deadbeef.tmp'] === null,
      JSON.stringify({ stillThere: left['aaaaaaaaaaaaaaaa.json.deadbeef.tmp'] })
    )
    report.check(
      'draft-gc-removes-stale-file-draft-only',
      left[NAME_STALE] === null && left[NAME_FRESH] !== null,
      JSON.stringify({ staleGone: left[NAME_STALE] === null, freshKept: left[NAME_FRESH] !== null })
    )
    report.check(
      'draft-gc-removes-broken-old-file-only',
      left['dddddddddddddddd.json'] === null && left['eeeeeeeeeeeeeeee.json'] !== null,
      JSON.stringify({
        brokenGone: left['dddddddddddddddd.json'] === null,
        brokenFreshKept: left['eeeeeeeeeeeeeeee.json'] !== null
      })
    )
    report.check(
      'draft-gc-keeps-unknown-and-non-json',
      left['ffffffffffffffff.json'] !== null &&
        left['notes.txt'] !== null &&
        left['noext'] !== null,
      JSON.stringify({
        unknown: left['ffffffffffffffff.json'] !== null,
        txt: left['notes.txt'] !== null,
        noext: left['noext'] !== null
      })
    ) // 留下的草稿仍然**读得出来**（GC 不能把草稿文件改坏，也不能把名字改错）
    const loaded = JSON.parse(
      String(
        await app.ev(
          `(async () => JSON.stringify(await window.luminAPI.drafts.load(${JSON.stringify(KEY_FRESH)})))()`
        )
      )
    )
    report.check(
      'surviving-draft-still-loadable',
      !!loaded && loaded.content === '新草稿',
      JSON.stringify(loaded)
    )
  } finally {
    try {
      if (app) app.close()
    } catch {
      /* ignore */
    }
    // cmd.exe 是壳，杀它不保证 Electron 跟着走 —— 用 ps1 按 user-data-dir 精确收尾
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    startIsolated({ userData: UD, port: PORT, cleanupOnly: true })
  }

  return report.finish()
}

main()
  .then((c) => process.exit(c))
  .catch(fatal)
