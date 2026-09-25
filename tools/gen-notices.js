'use strict'
// ─── 生成 THIRD-PARTY-NOTICES.md ───────────────────────────────────────────────
//
// 为什么需要：`electron-builder` 打出来的产物里，第三方库的版权声明**全被剥掉了**
// （Rollup 内联 + banner 剥离；实测 89 个 renderer chunk 对 `MIT License|Copyright (c)` 零命中），
// 而 MIT/BSD/Apache-2.0/ISC 都要求"分发时保留版权声明与许可文本"。仓库里也一直没有
// THIRD-PARTY-NOTICES / LICENSES 文件。
//
// 数据来源：`package-lock.json` 的 `packages` 映射（lockfileVersion 3）——
// 它列出了**实际安装**的每一个包及其路径，比"读 package.json 的 dependencies"准确得多
// （后者漏掉传递依赖、也可能含未安装的包）。逐个从 `node_modules/<path>/package.json`
// 读 `license` 与 `repository`，缺失时回退读包内的 LICENSE 文件首行。
//
// 用法：`npm run notices`（也可以 `node tools/gen-notices.js --check` 只校验是否最新）
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md')
const LOCK = path.join(ROOT, 'package-lock.json')

/** 读一个包目录的 package.json（读不到返回 null） */
function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
  } catch {
    return null
  }
}

/** 许可文本首行（有些包的 package.json 没有 license 字段，只能看文件） */
function licenseFromFiles(dir) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']) {
    try {
      const first = fs.readFileSync(path.join(dir, name), 'utf-8').split('\n')[0].trim()
      if (first) return `${first} (from ${name})`
    } catch {
      /* 试下一个 */
    }
  }
  return 'UNKNOWN'
}

/**
 * 收集**生产依赖闭包**（从 package.json 的 dependencies 出发，沿 lock 的依赖图做 BFS）。
 *
 * 为什么不是"把 lock 里所有非 dev 的都列上"：lock 的 `dev` 标记并不可靠
 * （审计实测 `vite`/`rollup`/`typescript` 的 `dev` 是 undefined），那样会列出 500+ 个包、
 * 其中一大半（eslint/electron-builder 那一族）根本不随产物分发 —— 而本文件的标题是
 * "随产物分发"的声明，写成 500 个就是**不实陈述**。BFS 出来的闭包才是事实。
 */
function collect() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf-8'))
  const packages = lock.packages || {}
  // 名字 → 候选路径（npm 会提升，优先顶层 `node_modules/<name>`，其次任意嵌套）
  const byName = new Map()
  for (const key of Object.keys(packages)) {
    if (!key.startsWith('node_modules/')) continue
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const list = byName.get(name) ?? []
    list.push(key)
    byName.set(name, list)
  }
  const resolvePath = (name) => {
    const list = byName.get(name)
    if (!list || !list.length) return null
    return list.find((p) => p === `node_modules/${name}`) ?? list[0]
  }

  const seen = new Set()
  const rows = []
  const queue = Object.keys(packages['']?.dependencies || {})
  while (queue.length) {
    const name = queue.shift()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const key = resolvePath(name)
    if (!key) continue
    const entry = packages[key] || {}
    const dir = path.join(ROOT, key)
    const pkg = readPkg(dir)
    const version = entry.version || pkg?.version || '?'
    const license = pkg?.license || pkg?.licenses?.[0]?.type || licenseFromFiles(dir)
    const repo =
      typeof pkg?.repository === 'string' ? pkg.repository : (pkg?.repository?.url ?? '') || ''
    rows.push({ name, version, license: String(license), repo: String(repo), path: key })
    for (const child of Object.keys(entry.dependencies || {})) queue.push(child)
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  return rows
}

/** 许可标识归一：`MIT OR CC0-1.0` 之类的表达式原样保留，只把大小写统一 */
function shortLicense(l) {
  return l.replace(/\s+/g, ' ').trim()
}

function render(rows) {
  const counts = new Map()
  for (const r of rows) counts.set(shortLicense(r.license), (counts.get(shortLicense(r.license)) || 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const lines = []
  lines.push('# 第三方开源许可声明（Third-Party Notices）')
  lines.push('')
  lines.push(
    `本文件由 \`npm run notices\`（\`tools/gen-notices.js\`）生成，数据来自 \`package-lock.json\` 与各包的 \`package.json\`。`
  )
  lines.push('')
  lines.push(
    `Lumin ${pkg.version} 以 **${pkg.license ?? 'UNKNOWN'}** 许可发布；按生产依赖闭包（从 \`dependencies\` 出发做 BFS，含传递依赖）` +
      `统计，随产物分发共 ${rows.length} 个第三方包，许可分布如下：`
  )
  lines.push('')
  lines.push('| 许可 | 包数量 |')
  lines.push('| --- | --- |')
  for (const [l, n] of sorted) lines.push(`| ${l} | ${n} |`)
  lines.push('')
  lines.push('## 包清单')
  lines.push('')
  lines.push('| 包 | 版本 | 许可 | 仓库 |')
  lines.push('| --- | --- | --- | --- |')
  for (const r of rows) {
    const repo = r.repo ? r.repo.replace(/^git\+/, '').replace(/\.git$/, '') : '—'
    lines.push(`| ${r.name} | ${r.version} | ${shortLicense(r.license)} | ${repo} |`)
  }
  lines.push('')
  lines.push(
    '各包的完整许可文本随包本身一同分发（`node_modules/<包名>/LICENSE*`）；MIT/BSD/Apache-2.0/ISC 均要求保留版权声明与许可文本，'
  )
  lines.push('本文件即该声明的汇总入口，并在应用「关于」页内可见。')
  lines.push('')
  return lines.join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const rows = collect()
  const text = render(rows)
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : ''
  if (check) {
    if (current !== text) {
      console.log('THIRD-PARTY-NOTICES.md 不是最新的：请跑 `npm run notices`')
      process.exit(1)
    }
    console.log(`notices up to date (${rows.length} packages)`)
    return
  }
  fs.writeFileSync(OUT, text, 'utf-8')
  console.log(`THIRD-PARTY-NOTICES.md written: ${rows.length} packages, ${text.length} bytes`)
}

main()
