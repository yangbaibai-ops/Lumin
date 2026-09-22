// ─── 源码/文档的编码门禁（自查报告 H4）────────────────────────────────────────
//
// 来源：2026-09-22 一次真实事故 —— 用 PowerShell 的 `Get-Content -Raw` / `Set-Content -Encoding UTF8`
// 往返改 `src/renderer/src/assets/style.css`，整份 UTF-8 中文注释被**双重编码成 mojibake**
// （另有 253 行末尾字符被吃掉）。当时 `eslint` / `vue-tsc` / `electron-vite build` **全绿**，
// 没有任何机制发现它；最后靠肉眼看出、从 git 对象里恢复。
//
// 写这份门禁的过程本身又踩了一次同一个坑（补"排除本文件"时用了 PowerShell 往返，
// 文件当场被改成 mojibake 并加上 BOM）—— 所以下面三条不是理论风险：
//   1. 任何被跟踪的文本文件里**不许出现 U+FFFD**（解码失败的替换字符）；
//   2. 正文里不许出现 GBK↔UTF-8 双重编码的特征串，但**跳过行内代码与引用块**，
//      并**豁免本文件**（规则要能豁免"记录规则的文档"）；
//   3. 文本文件**不许带 BOM**（PowerShell 5.1 的 `Set-Content -Encoding UTF8` 就会加，
//      而带 BOM 的 JSON 用 `JSON.parse` 直接抛错）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 要扫的目录（仓库内文本资产；不扫 node_modules / 构建产物 / 二进制） */
const SCAN_DIRS = ['src', 'tests', 'tools', 'docs', 'build', 'resources']
const TEXT_EXT = new Set([
  '.ts',
  '.vue',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.html',
  '.nsh',
  '.ps1',
  '.txt'
])

/**
 * GBK↔UTF-8 双重编码的典型特征（出现即说明被来回转过一次）。
 * 用**码点数组**而不是字符串字面量写：万一以后有人删了下面的豁免，本文件也不会自己命中自己。
 */
const MOJIBAKE_SIGNS = [
  [0x9239, 0x94ec],
  [0x9357],
  [0x92c2, 0x56e7],
  [0x942b, 0x6b9e],
  [0x942b, 0x7684],
  [0x6d93, 0x20ac],
  [0x8bc1, 0x5267],
  [0x6d60, 0x4e6c],
  [0x9a9e, 0x5e76],
  [0x93b4, 0x6210]
].map((cps) => String.fromCodePoint(...cps))

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'out' || name === 'dist' || name === '.git') continue
      yield* walk(p)
    } else if (TEXT_EXT.has(extname(name).toLowerCase())) {
      yield p
    }
  }
}

function collect() {
  const out = []
  for (const d of SCAN_DIRS) {
    try {
      if (statSync(join(ROOT, d)).isDirectory()) out.push(...walk(join(ROOT, d)))
    } catch {
      /* 目录不存在就跳过 */
    }
  }
  for (const f of ['README.md', 'CHANGELOG.md', 'package.json', 'electron-builder.yml']) {
    try {
      if (statSync(join(ROOT, f)).isFile()) out.push(join(ROOT, f))
    } catch {
      /* 缺就跳过 */
    }
  }
  return out
}

const ALL = collect()
/** 本文件自己**必须**定义特征串，所以扫描时豁免它 */
const SELF = join(ROOT, 'tests', 'encodingGuard.test.mjs')
const SCANNED = ALL.filter((f) => f !== SELF)

/** 去掉行内代码（`…`）、代码块（``` 围栏）与引用行，只留"正文散文" */
function proseOnly(text) {
  // ⚠️ 围栏必须按**行首**配对（允许缩进）：原来用的是 `/```[\s\S]*?```/g` —— 它会把正文里
  // 提到的 ```（例如「只要看到 ```mermaid 就加载」这种叙述）也当成围栏开端，于是**后面所有
  // 围栏的配对整体错位**，本该被剥掉的代码块内容漏进「散文」里，报出一堆假 mojibake
  // （实测踩过：CHANGELOG 里一句 ```mermaid 让 1700 行外的一段历史乱码引用变成「正文」）。
  const noFence = text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '')
  return noFence
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .map((l) => l.replace(/`[^`]*`/g, ''))
    .join('\n')
}

test('抽样自检：确实扫到了源文件（防止扫了个空目录还全绿）', () => {
  assert.ok(SCANNED.length > 100, '扫到的文本文件太少，SCAN_DIRS 可能写错了：' + SCANNED.length)
  assert.ok(
    SCANNED.every((f) => f !== SELF),
    '本文件必须被豁免'
  )
})

test('没有 U+FFFD（解码失败的替换字符）', () => {
  const bad = []
  for (const f of SCANNED) {
    const text = readFileSync(f, 'utf8')
    const i = text.indexOf('\uFFFD')
    if (i >= 0) bad.push(`${relative(ROOT, f)}:${text.slice(0, i).split('\n').length}`)
  }
  assert.deepEqual(bad, [], '出现 U+FFFD（多半是编码被转过一次）：\n' + bad.join('\n'))
})

test('正文里没有 GBK↔UTF-8 双重编码特征（引用/代码块/本文件除外）', () => {
  const bad = []
  for (const f of SCANNED) {
    const text = readFileSync(f, 'utf8')
    if (!/[\u4e00-\u9fff]/.test(text)) continue
    const prose = proseOnly(text)
    for (const sign of MOJIBAKE_SIGNS) {
      const i = prose.indexOf(sign)
      if (i >= 0) bad.push(`${relative(ROOT, f)}:${prose.slice(0, i).split('\n').length}`)
    }
  }
  assert.deepEqual(bad, [], '正文里出现 mojibake 特征串：\n' + bad.join('\n'))
})

test('文本文件不带 BOM（`.ps1` 例外：Windows PowerShell 5.1 读非 ASCII 脚本必须靠 BOM）', () => {
  const bad = []
  for (const f of SCANNED) {
    // `.ps1` 由 tests/tooling.test.mjs 反向要求：含非 ASCII 就**必须**带 BOM
    //（PowerShell 5.1 会把无 BOM 的非 ASCII 脚本按 ANSI 读 → 中文注释变乱码）。
    // 同理 `dev-app-update.yml` 之类由工具生成的文件不在扫描面里。
    if (extname(f).toLowerCase() === '.ps1') continue
    const buf = readFileSync(f)
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
      bad.push(relative(ROOT, f))
  }
  assert.deepEqual(
    bad,
    [],
    '带 BOM 的文件（PowerShell 5.1 的 Set-Content -Encoding UTF8 就会加）：\n' + bad.join('\n')
  )
})
