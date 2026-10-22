#!/usr/bin/env node
// ─── YAML 重复键扫描（零依赖）───────────────────────────────────────────────
//
// 为什么需要它：`cdp.yml` 同时写了两个顶层 `name:`（第 12/14 行）。YAML 规范里
// 重复键是**非法**的，但不同实现宽容度不同：`js-yaml` 4 直接抛错，另一些实现
// 静默"后者覆盖前者"——工作流的名字/语义于是变成一个实现细节，没人能保证。
//
// 本脚本做两件事：
//   ① 用**自带的缩进感知扫描器**找重复键（零依赖，CI/离线也能跑）；
//   ② 若 `js-yaml` 可解析（本仓库 `node_modules` 里有），再整体 parse 一遍做严格校验。
//      两条都只是"检查"，不修改文件。
//
// 用法：
//   node tools/check-yaml-duplicate-keys.mjs                 # 扫描默认目标
//   node tools/check-yaml-duplicate-keys.mjs a.yml b.yml     # 扫描指定文件
//
// 退出码：0 = 干净；1 = 发现重复键/解析失败；2 = 目标文件不存在。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** 默认扫描口径：全部 workflow + 打包配置（与审计报告点名的范围一致） */
export const DEFAULT_TARGETS = [
  ...fs
    .readdirSync(path.join(REPO, '.github', 'workflows'))
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => path.join('.github', 'workflows', f)),
  'electron-builder.yml'
]

/** 行首缩进（空格数；Tab 按 1 列算，仅用于比较层级） */
function indentOf(line) {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0].replace(/\t/g, ' ').length : 0
}

/**
 * 一行是不是 `key:` / `- key:` / `-` 形态。
 * 返回 `{ rest, key, value }`；不是映射键行则 null。
 *
 * 键的写法只用本仓库会出现的两种：裸键（`name`、`on`、`build`）与引号键
 * （`"build:win"`）。值里出现的 `${{ … }}` 不参与判断（我们只切第一个冒号）。
 */
function parseKeyLine(text) {
  const m =
    /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#:'"[\],{}&*!|>%@`-][^:#]*?))\s*:(?:\s|$)/.exec(
      text
    )
  if (!m) return null
  const raw = m[1] ?? m[2] ?? m[3] ?? ''
  const key = m[2] !== undefined ? raw.replace(/''/g, "'") : raw
  return { key, value: text.slice(m[0].length).trim() }
}

/** 值是不是块标量（`|`、`>`，可带 `-`/`+` 与缩进指示符），后面只允许注释 */
function isBlockScalarValue(value) {
  return /^[|>][+-]?(?:[1-9])?(?:\s+#.*)?$/.test(value)
}

/**
 * 找出 YAML 里的重复键（同一缩进层级 = 同一 mapping）。
 *
 * 规则：
 *   * 缩进变浅 ⇒ 弹掉更深的 scope；同层同名键再次出现 ⇒ 重复；
 *   * 块标量（`|` / `>`）的内容原样跳过 —— 里面的 `name:` 是文本，不是键；
 *   * `- key: value` 的序列项按 `dash 之后的有效缩进` 建 scope，
 *     下一个 `-` 回到同层时弹掉上一个 item 的 scope（兄弟项不算重复）；
 *   * 行内注释与引号里的冒号不参与切分；flow mapping（`{…}`/`[…]`）整行跳过。
 *
 * @param {string} text
 * @returns {{key:string,line:number,firstLine:number,indent:number}[]}
 */
export function findDuplicateKeys(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  /** @type {{indent:number, keys:Map<string,number>}[]} */
  const stack = []
  const dupes = []
  // 块标量正文的基准缩进；null = 不在块标量里
  let blockIndent = null

  const popDeeperThan = (indent) => {
    while (stack.length && stack[stack.length - 1].indent > indent) stack.pop()
  }
  const scopeAt = (indent) => {
    let top = stack[stack.length - 1]
    if (!top || top.indent < indent) {
      top = { indent, keys: new Map() }
      stack.push(top)
    }
    return top
  }
  const addKey = (key, lineNo, indent) => {
    const scope = scopeAt(indent)
    const first = scope.keys.get(key)
    if (first !== undefined) {
      dupes.push({ key, line: lineNo, firstLine: first, indent })
    } else {
      scope.keys.set(key, lineNo)
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const lineNo = i + 1

    // ── 块标量正文：比基准缩进更深的行（含空行）都是文本 ──
    if (blockIndent !== null) {
      if (trimmed === '' || indentOf(raw) > blockIndent) continue
      blockIndent = null
      // 缩进回到基准或更浅 ⇒ 块标量结束，当前行照常处理
    }

    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === '---' || trimmed === '...') {
      stack.length = 0
      continue
    }
    // flow 集合/文档标记/锚点行长什么样都不影响我们的判断，跳过更安全
    if (/^[[{]/.test(trimmed)) continue

    const indent = indentOf(raw)
    let textPart = trimmed

    // ── 序列项：`- key: value` / `- value` ──
    if (/^-(?:\s|$)/.test(textPart)) {
      // 新 item 与上一个 item 同层：弹掉上一个 item 的映射 scope
      popDeeperThan(indent)
      const rest = textPart.slice(1).trim()
      if (!rest || rest.startsWith('#')) {
        stack.push({ indent: indent + 2, keys: new Map() })
        continue
      }
      // `- key: value`：这个键的有效缩进是 dash 之后（dash + 至少一个空格）
      const dashOffset = /^-\s*/.exec(textPart)[0].length
      const kv = parseKeyLine(rest)
      if (!kv) {
        // `- |` 块标量序列项：同样要跳过正文
        if (isBlockScalarValue(rest)) blockIndent = indent
        continue
      }
      addKey(kv.key, lineNo, indent + dashOffset)
      if (isBlockScalarValue(kv.value)) blockIndent = indent + dashOffset
      continue
    }

    // ── 普通映射键 ──
    const kv = parseKeyLine(textPart)
    if (!kv) continue
    popDeeperThan(indent)
    addKey(kv.key, lineNo, indent)
    if (isBlockScalarValue(kv.value)) blockIndent = indent
  }

  return dupes
}

/** 严格解析：js-yaml 在重复键上会抛 `duplicated mapping key` */
async function strictParse(file) {
  let yaml
  try {
    yaml = await import('js-yaml')
  } catch {
    return { skipped: true }
  }
  const text = fs.readFileSync(file, 'utf8')
  try {
    ;(yaml.default ?? yaml).load(text)
    return { skipped: false, error: null }
  } catch (err) {
    return { skipped: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function run(targets = DEFAULT_TARGETS, { cwd = REPO } = {}) {
  const results = []
  let failed = false
  for (const rel of targets) {
    const file = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
    if (!fs.existsSync(file)) {
      results.push({ file: rel, missing: true })
      failed = true
      continue
    }
    const text = fs.readFileSync(file, 'utf8')
    const dupes = findDuplicateKeys(text)
    const strict = await strictParse(file)
    if (dupes.length || strict.error) failed = true
    results.push({ file: rel, dupes, strict })
  }
  return { ok: !failed, results }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const targets = process.argv.slice(2)
  const { ok, results } = await run(targets.length ? targets : DEFAULT_TARGETS)
  for (const r of results) {
    if (r.missing) {
      console.error(`FAIL  ${r.file}: 文件不存在`)
      continue
    }
    const d = r.dupes
    const strictNote = r.strict.skipped
      ? '（js-yaml 不可用，跳过严格解析）'
      : r.strict.error
        ? `；js-yaml: ${r.strict.error.split('\n')[0]}`
        : '；js-yaml 解析通过'
    if (d.length) {
      for (const x of d) {
        console.error(
          `FAIL  ${r.file}:${x.line} 重复键 "${x.key}"（首次出现于第 ${x.firstLine} 行，缩进 ${x.indent}）${strictNote}`
        )
      }
    } else if (r.strict.error) {
      console.error(`FAIL  ${r.file}: YAML 解析失败${strictNote}`)
    } else {
      console.log(`OK    ${r.file}${strictNote}`)
    }
  }
  console.log(ok ? '\n全部通过：没有重复键。' : '\n发现重复键/解析失败。')
  process.exit(ok ? 0 : 1)
}
