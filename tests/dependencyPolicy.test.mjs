// 依赖策略守卫（审计 §5：registry 隐式指向第三方镜像 / Node 版本三处不一致 /
// 生产链路里的已弃用包）。
//
// 为什么值得一条独立测试：这三件事都属于"没人看就会漂"的类别 ——
//   * lock 里 904 个 tarball 的 `resolved` 指向哪里，只有出供应链问题时才会有人翻；
//   * `engines.node` 写 `>=22` 时，本机跑 Node 26 也"符合声明"，但构建产物并不保证能跑；
//   * 已弃用包会随着依赖树慢慢长出来，而 `npm outdated` 不会把它标红。
// 口径：**只能收紧**。registry 要与 `.npmrc` 一致；engines 必须有上界且 CI 的 Node 落在里面；
// 已弃用包只能从名单里减少（新增一个就红，逼着人当场决定"能不能换掉/顶掉"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))

test('依赖源：`.npmrc` 显式声明 registry，且 lock 里每个 tarball 都来自它', () => {
  assert.ok(fs.existsSync(path.join(ROOT, '.npmrc')), '.npmrc 必须存在（显式声明 registry）')
  const npmrc = read('.npmrc')
  const m = npmrc.match(/^\s*registry\s*=\s*(\S+)/m)
  assert.ok(m, '.npmrc 里必须有一行 registry=…')
  const registry = m[1].replace(/\/+$/, '')
  const host = new URL(registry).host
  const resolved = Object.entries(lock.packages ?? {})
    .map(([name, meta]) => [name, meta && meta.resolved])
    .filter(([, url]) => typeof url === 'string' && /^https?:/.test(url))
  assert.ok(resolved.length > 500, `只扫到 ${resolved.length} 个 resolved，解析口径可能不对`)
  const foreign = resolved.filter(([, url]) => new URL(url).host !== host)
  assert.deepEqual(
    foreign.slice(0, 5),
    [],
    `这些 tarball 不来自 .npmrc 声明的 registry：${foreign
      .slice(0, 5)
      .map(([n, u]) => `${n} → ${u}`)
      .join('；')}`
  )
  // 镜像可以换，但**完整性校验**不能少：换源时 hash 会把不一致挡在安装前
  const noIntegrity = resolved.filter(([, url]) => {
    const entry = Object.entries(lock.packages).find(([, meta]) => meta?.resolved === url)
    return entry && !entry[1].integrity
  })
  assert.equal(noIntegrity.length, 0, `这些条目没有 integrity 哈希：${noIntegrity.length} 个`)
})

test('Node 版本：engines 有上界，且 CI 用的版本落在里面（三处口径一致）', () => {
  const engines = pkg.engines?.node
  assert.ok(typeof engines === 'string', 'package.json 必须有 engines.node')
  const m = /^>=\s*(\d+)(?:\.\d+)*\s*<\s*(\d+)$/.exec(engines.trim())
  assert.ok(m, `engines.node 必须是有界范围（形如 ">=22 <25"），现在是「${engines}」`)
  const lo = Number(m[1])
  const hi = Number(m[2])
  assert.ok(hi > lo, `engines.node 的上下界反了：${engines}`)
  // CI / 打包 job 里写的 node-version 必须落在区间内
  const workflows = fs
    .readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter((f) => f.endsWith('.yml'))
  let seen = 0
  for (const wf of workflows) {
    const text = read(path.join('.github', 'workflows', wf))
    for (const mm of text.matchAll(/node-version:\s*'?(\d+)'?/g)) {
      const major = Number(mm[1])
      seen += 1
      assert.ok(
        major >= lo && major < hi,
        `${wf} 用 Node ${major}，不在 engines.node「${engines}」区间内`
      )
    }
  }
  assert.ok(seen > 0, '没有任何 workflow 指定 node-version —— 那这条对账就是空的')
})

test('已弃用包只能减少：名单自清理，新增一个就红', () => {
  /**
   * 出处：`package-lock.json` 里包条目的 `deprecated` 字段（npm 会写进去）。
   * 名单里的每一条都必须写明"为什么现在还留着 / 什么时候能去掉"。
   */
  const ALLOW = new Map([
    ['node_modules/boolean', 'app-builder-lib（打包期）的生产依赖，上游未换；不出现在运行时路径'],
    [
      'node_modules/lodash.isequal',
      'electron-updater 的生产依赖，作者标注"用 node:util.isDeepStrictEqual"但未发新版'
    ],
    ['node_modules/glob', '仅 dev 链路（旧打包工具）用到 glob@7；上游换 v9 前无法顶掉'],
    ['node_modules/inflight', 'glob@7 的依赖，随 glob 一起消失'],
    ['node_modules/rimraf', '仅 dev 链路用到 rimraf@2；上游换 v4+ 前无法顶掉']
  ])
  const deprecated = Object.entries(lock.packages ?? {})
    .filter(([, meta]) => meta && meta.deprecated)
    .map(([name]) => name)
  const unknown = deprecated.filter((n) => !ALLOW.has(n))
  assert.deepEqual(
    unknown,
    [],
    `这些包被标记为已弃用，但没登记原因（能换就换，换不掉再写进 ALLOW）：${unknown.join(', ')}`
  )
  const stale = [...ALLOW.keys()].filter((n) => !deprecated.includes(n))
  assert.deepEqual(stale, [], `ALLOW 里这些已经不再弃用（或已移除），请删掉：${stale.join(', ')}`)
})
