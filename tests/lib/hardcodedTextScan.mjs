// 「界面文案是否硬编码中文」的扫描器（`tests/i18nHardcoded.test.mjs` 的判定内核）。
//
// 单独成模块的理由：同一个扫描器既被单测用（当门禁），也被人工排查用
// （想拿到一份完整的"还欠多少处"清单时，直接 import 它，而不是去解析测试输出）。
//
// ⚠️ 别用 `node --test … > file` 再把输出读回来做统计：Windows 上 PowerShell 的
// 重定向会按 UTF-16 落盘，读回来全是乱码（本仓库踩过一次）。要清单就调这里的函数。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** src 根目录 */
export const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

/** 中日韩统一表意文字 + 中文标点（界面文案、语言自称都在这些区间里） */
export const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * 白名单：`路径 → [ { match, why } ]`。`match` 是必须出现的子串。
 * 只放**确实不该翻译**的东西；能翻译却留在这儿的，就是在欠债。
 */
export const ALLOW = {
  'shared/types.ts': [{ match: 'zh-CN', why: '语言代码本身，不是文案' }],
  'main/i18n.ts': [{ match: 'zh-CN', why: '语言代码' }],
  'renderer/src/i18n/index.ts': [
    { match: '简体中文', why: '语言选择器里的语言自称（按母语显示，国际惯例不翻译）' },
    { match: '中文', why: '同上（短标签）' },
    { match: 'Русский', why: '同上' }
  ],
  'renderer/src/lib/tags.ts': [
    {
      match: '[,，;；、',
      why: '标签输入的**分隔符集合**（解析用，不是界面文案）：用户会用中英文逗号/分号/顿号分隔标签'
    }
  ]
}

const ALL_EXT = ['.ts', '.js', '.mjs', '.vue']

/** src 下的所有源码文件（扫描器与「真的覆盖到 src 了吗」的自检共用） */
export function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (ALL_EXT.some((e) => entry.name.endsWith(e))) out.push(p)
  }
  return out
}

/** `/` 前面是不是「可以有正则字面量」的位置（上一枚有意义的字符/关键字） */
const REGEX_PREFIX_CHARS = '([{,;=:!&|?+-*%^~<>'
const REGEX_PREFIX_WORDS =
  /(?:^|\b)(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)\s*$/

/** 依据"已扫过的代码尾部"判断下一个 `/` 能不能开正则 */
export function regexAllowed(tail) {
  const trimmed = tail.replace(/\s+$/, '')
  if (!trimmed) return true
  if (REGEX_PREFIX_WORDS.test(trimmed)) return true
  return REGEX_PREFIX_CHARS.includes(trimmed[trimmed.length - 1])
}

/**
 * 把源码切成 `code` / `string` / `regex` / `comment` 四种片段（带起始行号）。
 *
 * 为什么要自己写：注释、字符串、正则三者的定界符互相包含（`//` 在字符串里、
 * 引号在正则里、`/*` 在模板串里），只用正则表达式去"剥注释"必然翻车。
 * 这个 tokenizer 用一条主线扫过去，遇到什么就整段吃掉，因此不会串味。
 *
 * 两处必须按**已扫过的代码尾部**判，而不是看上一个字符：
 *   * `return /[*~]/` —— 只看上一个字符会把正则当除号，里面的反引号/引号会带偏整段；
 *   * `${...}` 里嵌套模板串 —— 靠 `eat()` 整段吃掉，不递归解析。
 */
export function tokenize(src) {
  const tokens = []
  let i = 0
  let line = 1
  let buf = ''
  let bufLine = 1
  /** 最近 32 个有意义字符（判断 `/` 是除号还是正则开头；必须留**词**） */
  let codeTail = ''

  const flushCode = () => {
    if (buf) tokens.push({ kind: 'code', text: buf, line: bufLine })
    buf = ''
  }
  const emit = (kind, text, atLine) => {
    flushCode()
    tokens.push({ kind, text, line: atLine })
    // 字符串/正则/注释之后接的是 `/` 时，那是除号而不是正则（留个值占位）
    if (kind !== 'code') codeTail = 'x'
  }
  const advance = (n) => {
    for (let k = 0; k < n; k += 1) if (src[i + k] === '\n') line += 1
    i += n
  }
  /** 吃掉一个带定界符的片段（字符串 / 模板串 / 正则） */
  const eat = (delim, { allowNewline = true, classAware = false } = {}) => {
    const at = line
    let text = delim
    advance(1)
    let inClass = false
    while (i < src.length) {
      const ch = src[i]
      if (ch === '\\') {
        text += ch + (src[i + 1] ?? '')
        advance(2)
        continue
      }
      if (ch === '\n') {
        if (!allowNewline) break
        text += ch
        advance(1)
        if (delim === '`') continue
        break
      }
      if (classAware) {
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
      }
      text += ch
      advance(1)
      if (!classAware && ch === delim) break
      if (classAware && ch === '/' && !inClass) break
    }
    return { text, at }
  }

  while (i < src.length) {
    const c = src[i]
    if (!buf) bufLine = line
    if (c === '/' && src[i + 1] === '/') {
      const at = line
      let text = ''
      while (i < src.length && src[i] !== '\n') {
        text += src[i]
        i += 1
      }
      emit('comment', text, at)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const at = line
      let text = ''
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        text += src[i]
        advance(1)
      }
      text += '*/'
      advance(2)
      emit('comment', text, at)
      continue
    }
    if (c === "'" || c === '"') {
      const { text, at } = eat(c, { allowNewline: false })
      emit('string', text, at)
      continue
    }
    if (c === '`') {
      const { text, at } = eat('`', { allowNewline: true })
      emit('string', text, at)
      continue
    }
    if (c === '/' && regexAllowed(codeTail)) {
      const { text, at } = eat('/', { allowNewline: false, classAware: true })
      if (text.length > 1 && text.endsWith('/')) {
        emit('regex', text, at)
        continue
      }
    }
    buf += c
    codeTail = (codeTail + c).slice(-32)
    // 必须走 advance：代码里的换行同样要计数（第一版直接 i += 1，
    // 于是第一个多行注释之后所有字面量的行号全错，十几处硬编码被报成同一行）
    advance(1)
  }
  flushCode()
  return tokens
}

/** 去掉注释后的源码（字符串字面量原样保留） */
export function codeOf(src) {
  return tokenize(src)
    .filter((t) => t.kind !== 'comment')
    .map((t) => t.text)
    .join('')
}

/** 字符串 / 正则字面量 */
export function stringsOf(src) {
  return tokenize(src).filter((t) => t.kind === 'string' || t.kind === 'regex')
}

/** 文件里到某个下标为止的行数（1 基）；用来把"片段内行号"换算成"文件行号" */
function lineAt(src, index) {
  let n = 1
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') n += 1
  return n
}

/**
 * `.vue` 的代码块清单：`[{ kind: 'script' | 'template', text, line }]`。
 * `line` 是该片段第一行在**文件**里的行号 —— 报错时必须给文件行号，
 * 否则拿到"脚本第 18 行"还得自己数（第一版就是这样，`SettingsDialog.vue` 的
 * 十几处硬编码全被报成同一行）。
 */
export function vueBlocks(src) {
  const blocks = []
  for (const m of src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = m.index + m[0].indexOf(m[1])
    blocks.push({ kind: 'script', text: m[1], line: lineAt(src, start) })
  }
  const tpl = src.match(/<template>([\s\S]*)<\/template>/)
  if (tpl) {
    const start = tpl.index + tpl[0].indexOf(tpl[1])
    blocks.push({ kind: 'template', text: tpl[1], line: lineAt(src, start) })
  }
  return blocks
}

/** 模板片段里的用户可见中文（行号相对片段起点，调用方自行加偏移） */
export function templateCjk(tpl) {
  const offenders = []
  const src = tpl.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  let i = 0
  let line = 1
  let textBuf = ''
  const flushText = () => {
    if (CJK.test(textBuf)) {
      offenders.push({ line, text: textBuf.trim().replace(/\s+/g, ' ').slice(0, 80) })
    }
    textBuf = ''
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      line += 1
      i += 1
      continue
    }
    if (c === '{' && src[i + 1] === '{') {
      flushText()
      const end = src.indexOf('}}', i + 2)
      const inner = src.slice(i + 2, end < 0 ? undefined : end)
      if (CJK.test(inner) && !/\$?t\s*\(/.test(inner)) {
        offenders.push({ line, text: '{{' + inner.trim().replace(/\s+/g, ' ').slice(0, 70) + '}}' })
      }
      // 跳过的片段里可能有换行（多行插值）：必须照样计数，否则后面所有行号全偏
      const next = end < 0 ? src.length : end + 2
      for (let k = i; k < next; k += 1) if (src[k] === '\n') line += 1
      i = next
      continue
    }
    if (c === '<') {
      flushText()
      const end = src.indexOf('>', i)
      const tag = src.slice(i, end < 0 ? undefined : end + 1)
      for (const attr of tag.matchAll(/([:@\w-]+)\s*=\s*"([^"]*)"/g)) {
        if (CJK.test(attr[2]) && !/\$?t\s*\(/.test(attr[2])) {
          offenders.push({ line, text: `${attr[1]}="${attr[2].slice(0, 70)}"` })
        }
      }
      // 同上：标签跨多行（长 class 列表）时也要把换行算进去
      const next = end < 0 ? src.length : end + 1
      for (let k = i; k < next; k += 1) if (src[k] === '\n') line += 1
      i = next
      continue
    }
    textBuf += c
    i += 1
  }
  flushText()
  return offenders
}

const isAllowed = (rel, text) => (ALLOW[rel] ?? []).some((a) => text.includes(a.match))

/**
 * 扫描整个 `src`：返回 `{ rel, line, kind, text }[]`（kind = string | template）。
 * `root` 可换（排查别的目录时用）。
 */
export function scanHardcodedText(root = SRC) {
  const offenders = []
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/')
    const raw = readFileSync(file, 'utf-8')
    const blocks = file.endsWith('.vue') ? vueBlocks(raw) : [{ kind: 'script', text: raw, line: 1 }]
    for (const block of blocks) {
      const offset = block.line - 1
      if (block.kind === 'script') {
        for (const lit of stringsOf(block.text)) {
          if (!CJK.test(lit.text)) continue
          if (isAllowed(rel, lit.text)) continue
          offenders.push({
            rel,
            line: lit.line + offset,
            kind: 'string',
            text: lit.text.trim().slice(0, 80)
          })
        }
      } else {
        for (const t of templateCjk(block.text)) {
          if (isAllowed(rel, t.text)) continue
          offenders.push({ rel, line: t.line + offset, kind: 'template', text: t.text })
        }
      }
    }
  }
  return offenders
}

/**
 * ─── 模板里**用户可见的英文硬编码**（报告 §5.4 P2-2）───────────────────────────
 *
 * 为什么单开一路：上面的 CJK 扫描器只能抓中文 —— 于是"本该走语言包的英文"整片漏网。
 * 报告实测的两处：`StatusBar.vue` 的状态栏标语（纯英文文本节点）与 `ContextMenu.vue:399`
 * 的 `aria-label="submenu"`（屏幕阅读器会读出来）。这一路只扫**用户会看到/听到**的地方：
 *   * 模板**文本节点**里 ≥3 个英文单词的句子（`Lumin — Write in Light.`）；
 *   * `aria-label` / `title` / `placeholder` / `alt` 这些**属性值**里的英文（未绑定的才查，
 *     `:title="t('…')"` 走语言包的一律放过）。
 * 刻意**不**扫 `class` / `id` / 事件名 / 变量名 —— 那些不是界面文案，扫了只会淹掉真信号。
 */
const VISIBLE_ATTRS = /(?<![:@\w-])(aria-label|title|placeholder|alt)\s*=\s*"([^"]*)"/g

/** 属性里的英文（未绑定、未走语言包、含 ≥1 个英文单词） */
export function templateEnglishAttrs(tpl) {
  const offenders = []
  for (const m of tpl.matchAll(VISIBLE_ATTRS)) {
    const raw = m[2]
    if (/\{\{|\$?t\s*\(/.test(raw)) continue
    if (!/[A-Za-z]{2,}/.test(raw)) continue
    offenders.push({ kind: 'attr', text: `${m[1]}="${raw.slice(0, 60)}"` })
  }
  return offenders
}

/**
 * 模板文本节点里的英文句子。
 *
 * ⚠️ 只认**同一行里真正夹在标签之间**的文本（`>文本<`）—— 第一版按"去掉标签后剩 ≥3 个单词"
 * 判定，结果多行标签的 class 续行也被当成文案，一次报出两百多条假阳性（真信号被淹掉）。
 * 现在的判据来自标签边界本身：`>…<` 之间、不含 `{{`/`t(`、≥3 个英文单词且长度 ≥12。
 */
export function templateEnglishText(tpl) {
  const offenders = []
  tpl.split('\n').forEach((raw, i) => {
    const line = raw.replace(/<!--[\s\S]*?-->/g, '')
    for (const m of line.matchAll(/>([^<>]+)</g)) {
      const text = m[1].replace(/\s+/g, ' ').trim()
      if (!text || /\{\{|\$?t\s*\(/.test(text)) continue
      const words = text.match(/[A-Za-z][A-Za-z'’.-]*/g) ?? []
      if (words.length >= 3 && text.length >= 12) {
        offenders.push({ line: i + 1, kind: 'text', text: text.slice(0, 70) })
      }
    }
  })
  return offenders
}

/** 扫整个 `src/**\/*.vue` 的模板，返回 `{ rel, line, kind, text }[]` */
export function scanHardcodedEnglish(root = SRC) {
  const offenders = []
  for (const file of walk(root)) {
    if (!file.endsWith('.vue')) continue
    const rel = relative(root, file).split(sep).join('/')
    for (const block of vueBlocks(readFileSync(file, 'utf-8'))) {
      if (block.kind !== 'template') continue
      const offset = block.line - 1
      for (const t of templateEnglishAttrs(block.text)) {
        offenders.push({ rel, line: t.line ?? offset + 1, kind: t.kind, text: t.text })
      }
      for (const t of templateEnglishText(block.text)) {
        offenders.push({ rel, line: t.line + offset, kind: t.kind, text: t.text })
      }
    }
  }
  return offenders
}
