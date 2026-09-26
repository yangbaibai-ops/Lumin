// 工具链自检：这些坑一旦复发，整个验收体系给出的数字就是错的（而且看不出来）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const TOOLS = path.join(ROOT, 'tools')
const FIXTURES = path.join(TOOLS, 'fixtures', 'md')

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

test('PowerShell 脚本：含非 ASCII 就必须带 UTF-8 BOM', () => {
  // Windows PowerShell 5.1 读**无 BOM** 的 UTF-8 脚本时按 ANSI 解码：
  // 中文注释里的多字节序列会撞出引号 → 直接语法错误（实测：改一次注释，整套验收起不来实例）。
  const files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.ps1'))
  assert.ok(files.length > 0, 'tools 下应该有 .ps1')
  for (const f of files) {
    const buf = fs.readFileSync(path.join(TOOLS, f))
    const ascii = buf.every((b) => b < 0x80)
    if (ascii) continue
    assert.ok(
      buf.subarray(0, 3).equals(BOM),
      `${f} 含非 ASCII 但没有 UTF-8 BOM（PS 5.1 会按 ANSI 解码 → 语法错误）`
    )
  }
})

test('CDP 套件公共骨架导出约定 API', () => {
  const h = require(path.join(TOOLS, 'lib', 'harness.js'))
  for (const name of ['connect', 'settle', 'waitEditor', 'Reporter', 'clickSelector', 'pressKey']) {
    assert.equal(typeof h[name], 'function', `harness 缺少 ${name}`)
  }
  // 结果汇总格式必须机器可读（tools/run-suites.js 靠它出矩阵）
  const r = new h.Reporter()
  r.check('ok', true)
  r.check('bad', false)
  assert.equal(r.failed, 1)
})

test('前置条件不满足 → 如实 SKIP 的范式：骨架与运行器两侧口径一致', () => {
  /**
   * 清单 §10 P1「已知 flaky 的套件没有隔离」：靠**真实按键/帧**的套件在窗口拿不到前台时会偶发失败，
   * 看着像产品缺陷。范式是"拿不到前置条件就如实 SKIP"（`_verify-outline-nav.js` 早就在这么做，
   * 现在把它变成骨架里的公共能力 `preconditionSkip` + `fatal` 的结算口径）。
   * 这条守住两侧**字面一致**：骨架打印什么前缀、运行器就得认什么前缀 —— 不一致的后果是
   * 那条 SKIP 被算成 `NOASSERT`（0 断言 = 红），比直接失败还难查。
   */
  const h = require(path.join(TOOLS, 'lib', 'harness.js'))
  assert.equal(typeof h.preconditionSkip, 'function', 'harness 缺少 preconditionSkip')
  assert.equal(typeof h.PRECONDITION_SKIP_PREFIX, 'string', 'harness 缺少 PRECONDITION_SKIP_PREFIX')
  const err = h.preconditionSkip('测试用')
  assert.equal(
    err.preconditionSkip,
    true,
    'preconditionSkip 造的 error 必须带标记（fatal 靠它分派）'
  )
  const runner = fs.readFileSync(path.join(TOOLS, 'run-suites.js'), 'utf-8')
  assert.ok(
    runner.includes(`|${h.PRECONDITION_SKIP_PREFIX}`),
    `run-suites.js 的 skipped 判定里没有 ${h.PRECONDITION_SKIP_PREFIX}（SKIP 会被算成 NOASSERT）`
  )
  // 登记：这几条已知会等焦点的套件必须用这个范式（别退回 throw new Error → 硬失败）
  for (const f of ['_verify-inline-formats.js']) {
    const text = fs.readFileSync(path.join(TOOLS, f), 'utf-8')
    assert.ok(
      text.includes('preconditionSkip('),
      `${f} 没用 preconditionSkip（拿不到焦点会硬失败）`
    )
    assert.equal(
      /throw new Error\('编辑器没拿到焦点/.test(text),
      false,
      `${f} 里还有"拿不到焦点就 throw"的老写法`
    )
  }
})

test('套件定位浮层走语义锚点，不写死数字型 z-index 类名', () => {
  /**
   * 清单 §8 P2 把浮层层级收进 `--z-*` 令牌时，`ContextMenu.vue` 的类名从 `z-[160]` 变成
   * `z-[var(--z-critical)]`，于是两个用 `String(d.className).includes('z-[160]')` 找菜单的套件
   * （`_verify-rename.js`、`_verify-sidebar-refresh.js`）**静默变红**：0 断言，
   * 看起来像"环境抖动"，实际是把设计细节写进了选择器。
   *
   * 口径：`z-[160]` 这种数字型类名是随时会过期的实现细节（层级已经改为令牌），
   * 契约是语义锚点（`role="menu"` / `aria-label="submenu"` / `data-*`）。
   * 令牌型类名 `z-[var(--z-*)]` 由 `_verify-zorder.js` 专门断言 —— 那是它自己的被测对象，不在此列。
   */
  const offenders = []
  const files = fs
    .readdirSync(TOOLS, { recursive: true })
    .map((f) => String(f))
    .filter((f) => f.endsWith('.js'))
  // 注释先剥掉：这条陷阱本身就该写在套件里（上面那段），不能因为"注释里提了一句 z-[160]"而误报
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1')
  for (const f of files) {
    const text = strip(fs.readFileSync(path.join(TOOLS, f), 'utf-8'))
    for (const m of text.matchAll(/z-\[\d+\]/g)) offenders.push(`${f} → ${m[0]}`)
  }
  assert.deepEqual(offenders, [], `套件里还写死了数字型 z-index 类名：${offenders.join('；')}`)
})

test('注入真实按键的套件必须有前置守卫，或登记在**只减不增**的欠账名单里', () => {
  /**
   * 清单 §10 P1「已知 flaky 的套件没有隔离」。口径（两条都不许破）：
   *   ① 任何注入真实按键的套件，要么有守卫（`preconditionSkip` / `requireFocus` / `requireFrames` /
   *      `ensureFocus` / 窗口级 SKIP），要么在 `FOCUS_GUARD_BACKLOG` 里点名 —— 名单存在是为了
   *      **让欠账可见**，而不是"允许随便加"；
   *   ② 名单只能变小：一旦某条套件补上了守卫，它必须从名单里删掉（自清理），
   *      且名单长度不得超过当前实测欠账数（写死上限，防止有人往里塞新名字）。
   */
  const files = fs.readdirSync(TOOLS).filter((f) => /^_(verify|regress|repro)-.*\.js$/.test(f))
  const INJECT = /dispatchKeyEvent|pressKey\(|Input\.insertText/
  const GUARD =
    /preconditionSkip\(|requireFocus\(|requireFrames\(|ensureFocus\(|SKIP: 没有可用窗口|SKIP: 9222 上已有|INSTANCE-NOT-READY|NO-APP-PAGE/
  const injects = files.filter((f) => INJECT.test(fs.readFileSync(path.join(TOOLS, f), 'utf-8')))
  assert.ok(injects.length >= 20, `只找到 ${injects.length} 个注入按键的套件，扫描口径可能不对`)

  /**
   * 欠账名单（实测口径：`dispatchKeyEvent` / `pressKey(` / `Input.insertText` 命中，
   * 且不含上面任一守卫标记）。清点命令抄在 `tools/README.md` 规则 12 里，数字要一致。
   */
  const FOCUS_GUARD_BACKLOG = new Set([
    '_regress-layout.js',
    '_regress-source-roundtrip.js',
    '_repro-backspace-after-cb.js',
    '_repro-cb-delete.js',
    '_repro-cb-delete2.js',
    '_repro-paste.js',
    '_repro-sourcemode.js',
    '_repro-split.js',
    '_verify-alt-menu.js',
    '_verify-cb-no-active-line.js',
    '_verify-cb-virtualization.js',
    '_verify-find-replace.js',
    '_verify-input-rules.js',
    '_verify-mermaid-blur.js',
    '_verify-mermaid-cross-block.js',
    '_verify-round-perf.js',
    '_verify-sidebar-search.js',
    '_verify-table-fidelity.js',
    '_verify-wave3.js'
  ])

  const unguarded = injects.filter(
    (f) => !GUARD.test(fs.readFileSync(path.join(TOOLS, f), 'utf-8'))
  )
  const unlisted = unguarded.filter((f) => !FOCUS_GUARD_BACKLOG.has(f))
  assert.deepEqual(
    unlisted,
    [],
    `这些套件注入真实按键却没有前置守卫，也没登记在欠账名单里：${unlisted.join(', ')}`
  )
  const stale = [...FOCUS_GUARD_BACKLOG].filter((f) => !unguarded.includes(f))
  assert.deepEqual(
    stale,
    [],
    `欠账名单里这些已经补上守卫（或文件没了），请删掉：${stale.join(', ')}`
  )
  assert.ok(
    FOCUS_GUARD_BACKLOG.size <= 19,
    `欠账名单变长了（${FOCUS_GUARD_BACKLOG.size}）—— 名单只能缩短，别把新套件塞进来`
  )
  // 已收口的三个点名登记：它们是"迁移完成的样例"，回退了要红
  for (const f of [
    '_verify-inline-formats.js',
    '_verify-new-document.js',
    '_repro-rapidenter.js',
    '_verify-outline-nav.js'
  ]) {
    assert.ok(!FOCUS_GUARD_BACKLOG.has(f), `${f} 不该回到欠账名单里（它已经用上守卫了）`)
  }
})

test('判级器导出约定 API 与规则清单', () => {
  const m = require(path.join(TOOLS, 'lib', 'md-fidelity.js'))
  for (const name of [
    'classify',
    'normalizeMarkdown',
    'unifiedDiff',
    'worseThan',
    'LEVEL',
    'RULES'
  ]) {
    assert.ok(m[name], `md-fidelity 缺少 ${name}`)
  }
  assert.ok(m.RULES.length >= 15, '规则清单太短')
})

test('tsconfig 的增量缓存不许落在仓库根目录（审计 §6「仓库卫生」）', () => {
  /**
   * 症状：根目录躺着 `tsconfig.web.tsbuildinfo`（115KB）与 `.tscheck.log` / `dev-run.log`。
   * 它们被 `.gitignore` 挡住了，所以"没进仓库"，但每次 `typecheck` 都会在根目录刷一遍 ——
   * 一个"源码目录里会长出构建垃圾"的仓库，早晚有人把它当成源码的一部分。
   * 口径：`composite: true` 的工程必须显式把 `tsBuildInfoFile` 指进 node_modules/.cache。
   */
  const files = fs.readdirSync(ROOT).filter((f) => /^tsconfig(\..+)?\.json$/.test(f))
  assert.ok(files.length >= 3, `只找到 ${files.length} 个 tsconfig，路径可能不对`)
  const stripJsonc = (t) => t.replace(/^\s*\/\/.*$/gm, '')
  for (const f of files) {
    const cfg = JSON.parse(stripJsonc(fs.readFileSync(path.join(ROOT, f), 'utf-8')))
    const co = cfg.compilerOptions
    if (!co || co.composite !== true) continue
    assert.match(
      String(co.tsBuildInfoFile ?? ''),
      /^node_modules\/\.cache\//,
      `${f} 开了 composite 却没把 tsBuildInfoFile 指进 node_modules/.cache（会在根目录留 *.tsbuildinfo）`
    )
  }
})

test('夹具库与 EXPECT.json 必须一一对应', () => {
  const expect = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'EXPECT.json'), 'utf-8'))
  const fixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md'))
  assert.ok(fixtures.length >= 25, `夹具太少：${fixtures.length}`)
  for (const f of fixtures) {
    const e = expect[f]
    assert.ok(e, `夹具 ${f} 没有预期（EXPECT.json）`)
    assert.ok(['exact', 'normalized', 'lossy'].includes(e.class), `${f} 的 class 非法：${e.class}`)
    // lossy 必须写清为什么 + 修法：没有 why 的 lossy 等于把缺陷藏进预期里
    if (e.class !== 'exact') {
      assert.ok(typeof e.why === 'string' && e.why.length >= 8, `${f} 非 exact 却没有 why`)
    }
  }
  for (const key of Object.keys(expect)) {
    if (key.startsWith('$')) continue
    assert.ok(fixtures.includes(key), `EXPECT.json 里的 ${key} 没有对应夹具`)
  }
})

test('套件统一入口存在且默认清单里的套件都在', () => {
  const src = fs.readFileSync(path.join(TOOLS, 'run-suites.js'), 'utf-8')
  /**
   * 清单里的**任何**套件文件名都要被这条守到 —— 不只是 `_verify-*`。
   *
   * 原来正则写的是 `_verify[^']*`，于是默认清单里的 6 个 `_regress-*` 与 1 个 `_repro-*`
   * 落在覆盖之外：把它们改名/写错，`run-suites.js` 的 `filter(existsSync)` 会**静默丢弃**，
   * 矩阵照旧全绿而覆盖悄悄变少（与 NOASSERT 想解决的"绿灯什么都证明不了"是同一类问题）。
   */
  const listed = [...src.matchAll(/'(_(?:verify|regress|repro)-[^']*\.js)'/g)].map((m) => m[1])
  assert.ok(listed.length >= 20, `默认清单太少：${listed.length}`)
  const unique = [...new Set(listed)]
  for (const f of unique) {
    assert.ok(fs.existsSync(path.join(TOOLS, f)), `run-suites 清单里的 ${f} 不存在`)
  }
  // 清单里出现过的每一类前缀都要被上面那条正则覆盖到（防止以后又漏一类）
  const prefixes = new Set(unique.map((f) => f.split('-')[0]))
  for (const p of prefixes) {
    assert.match(p, /^_(verify|regress|repro)$/, `清单里出现了未被守护的套件前缀：${p}`)
  }
})

test('套件分档：每个套件恰好落在一档，且 needs-dev 与实测一致', () => {
  /**
   * 分档是"哪一档该在什么时候跑"的**数据**（清单 §10 建议 ③）：`--tier=fast` 靠它挑套件。
   * 这里守住三件事，否则档位会慢慢漂成一个没人信的标签：
   *   ① 每个套件文件都能得到一档（tierOf 有兜底，但档名必须是四个之一）；
   *   ② `TIER_DEV` 与 `needsDevServer()` 的实测**完全一致**（漏登记 = 那档跑不起来）；
   *   ③ `manual` 的两个套件不在 `--all` 的自动清单里（人工介入的不能混进自动矩阵）。
   */
  const m = require(path.join(TOOLS, 'run-suites.js'))
  const files = m.allSuites()
  assert.ok(files.length >= 60, `套件全集太少：${files.length}`)
  const TIERS = new Set(['fast', 'needs-build', 'needs-dev', 'manual'])
  for (const f of files) {
    assert.ok(TIERS.has(m.tierOf(f)), `${f} 落到了未知档位 ${m.tierOf(f)}`)
  }
  for (const f of fs.readdirSync(TOOLS).filter((x) => /^_(verify|regress|repro)-.*\.js$/.test(x))) {
    assert.equal(
      m.needsDevServer(f),
      m.TIER_DEV.has(f),
      `${f} 的 needs-dev 档与实测不符（实测 needsDevServer=${m.needsDevServer(f)}）`
    )
  }
  for (const f of m.MANUAL) {
    assert.ok(!files.includes(f), `manual 档的 ${f} 不该出现在自动矩阵里`)
    assert.equal(m.tierOf(f), 'manual', `${f} 应在 manual 档`)
  }
  // fast 档 = 默认矩阵（两者是同一件事的两面）
  for (const f of m.DEFAULT_SUITES) {
    assert.equal(m.tierOf(f), 'fast', `默认矩阵里的 ${f} 不在 fast 档`)
  }
})

test('探针脚本被点名登记（不判定，但必须可见）', () => {
  /**
   * 清单 §10 P1：约 15 个"0 断言探针"在冒充 PASS —— 运行器现在把 `total === 0` 记 NOASSERT，
   * 但 `_probe-*` **根本不在扫描范围内**，于是连 NOASSERT 都不会被记。
   * 这条守住"它们仍然存在且仍被登记"：名单是数据（probeSuites），每轮矩阵末尾打印出来，
   * `--probe` 可以显式跑（那时照常判定）。
   * （历史上这里还登记过一个 `verify-tiptap.js`；它守的覆盖迁进矩阵后已删除，见 run-suites 的注释。）
   */
  const m = require(path.join(TOOLS, 'run-suites.js'))
  const probes = m.probeSuites()
  assert.ok(probes.length >= 5, `探针名单太少：${probes.length}（是不是把 _probe-* 删光了？）`)
  for (const f of probes) {
    assert.ok(fs.existsSync(path.join(TOOLS, f)), `probeSuites 里的 ${f} 不存在`)
    assert.ok(!m.allSuites().includes(f), `${f} 不该同时出现在自动矩阵里（那会重复判定）`)
  }
  // 探针文件不能被顺手改名成 _verify-* 而不改这份名单
  const mismatched = fs
    .readdirSync(TOOLS)
    .filter((f) => /^_probe-.*\.js$/.test(f))
    .filter((f) => !probes.includes(f))
  assert.deepEqual(mismatched, [], `这些探针没被 probeSuites 收到：${mismatched.join(', ')}`)
})
