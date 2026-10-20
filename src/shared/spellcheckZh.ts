// ─── 中文拼写检查：**启发式规则**（纯函数，主进程 / 渲染层 / 单测共用）─────────
//
// 先划清边界（不要把它说成"中文词典"）：
//   * Chromium 内置拼写器**没有中文词典**（实测 availableSpellCheckerLanguages
//     56 项，不含 zh / zh-CN / zh-Hans），所以中文只能由我们自己查；
//   * 这里做的是**低误报的启发式规则**，不是分词级错别字检测 —— 没有词典时按词
//     判错必然满屏误报，宁可不做。规则只有五类：
//       ① 虚词连续重复（的的 / 了了 / 是是…，限定小词表）；
//       ② 常见代词/连接词连续重复（我们我们…，闭集，排除正常叠动词）；
//       ③ 中文句里的半角标点 + 成对符号不配对/嵌套错位；
//       ④ 高置信易错词（小词表，见 confusableRules 的说明）；
//       ⑤ 中英之间缺空格（**只提示、不自动改**，默认关闭，advisory）；
//       ⑥ 术语 / 语言名白名单（精确区间豁免，见 spellcheckTerms.ts）。
//          语言名（简体中文 / 繁體中文 / English…）不是错词；规则再怎么演变，
//          也不该在它们身上画波浪线。豁免按"整条命中都落在词内"判定，不影响
//          词外的真错词。
//   * 偏移量 `from/to` 是**相对传入文本**的 UTF-16 下标，调用方换算成文档位置。
//
// 数据与引擎分离：词表 / 标点对 / 诊断文案都在同目录的 `spellcheckZhData.json`。
// 原因有二：① 它们本质是"中文语言学数据"，不是界面本地化文案（诊断对象就是中文，
// en/ru 界面启用中文检查时也应看到中文诊断）；② 放在 JSON 里不会让
// `tests/i18nHardcoded.test.mjs` 把每条词表都误判成"界面硬编码中文"。
//
// 为什么放 shared：主进程（必要时可做日志/诊断）、渲染层装饰、`node --test`
// 单测读同一份实现；规则改动只有一处。

import rules from './spellcheckZhData.json' with { type: 'json' }
import { findTermSpans, ZH_ALLOW_TERMS } from './spellcheckTerms.ts'
import { ZH_SPELLCHECK_LANGUAGE } from './spellcheck.ts'

export { ZH_SPELLCHECK_LANGUAGE }

/** 单次检查最多返回多少条（避免超大文档造出巨型 DecorationSet） */
export const ZH_MAX_ISSUES = 500

/** 文档变化后重算中文检查的防抖时间（用户口径 400–600ms，取中值） */
export const ZH_RECOMPUTE_DEBOUNCE_MS = 500

export type ZhSpellIssueKind =
  | 'repeat-char'
  | 'repeat-word'
  | 'halfwidth-punctuation'
  | 'unbalanced-pair'
  | 'confusable'
  | 'cjk-spacing'

export interface ZhSpellIssue {
  /** 相对传入文本的起点（含） */
  from: number
  /** 相对传入文本的终点（不含） */
  to: number
  kind: ZhSpellIssueKind
  /** 给右键菜单/读屏器看的说明（中文规则，界面语言无关：检查对象就是中文） */
  message: string
  /** 可一键应用的修正（没有安全修正时为空） */
  suggestions?: string[]
  /**
   * true = **只提示、不自动改**（当前只有"中英之间缺空格"）。
   * UI 可据此过滤；默认配置下这类不会返回（见 CheckChineseOptions.checkSpacing）。
   */
  advisory: boolean
}

export interface CheckChineseOptions {
  /**
   * 是否检查"中文与拉丁字母/数字之间缺空格"。
   * **默认 false**：有人偏好中英之间不加空格，这条只应作为可选提示，
   * 打开后返回的 issue 都带 `advisory: true`，且不带 suggestions。
   */
  checkSpacing?: boolean
  /**
   * 「其它 / 其他」的风格口径：
   *   * `'other'`（默认）⇒ 提示改用「其他」；
   *   * `'its'` ⇒ 认为「其它」是用户选择的风格，不提示。
   */
  otherStyle?: 'other' | 'its'
  /**
   * 术语 / 语言名白名单（精确区间豁免）。
   *
   * 默认取 `shared/spellcheckTerms.json` 的 `zhAllowTerms`；传 `[]` 可显式关闭，
   * 单测用它证明"豁免来自白名单、不是规则本身碰巧不命中"。
   */
  allowTerms?: readonly string[]
}

/**
 * 允许出现的"虚词叠用"短语（按**区间**排除，不是按字）：
 * 的的确确 / 了了分明 / 是是非非 / 和和美美 / 在在皆是 都是正常词或成语。
 * 只登记确实含"重复虚词"的固定说法，别把整本词典搬进来。
 */
const REPEAT_CHAR_ALLOW_PHRASES: readonly string[] = rules.repeatCharAllowPhrases

/**
 * 可以判定"连续重复一定是笔误"的虚词/代词小词表。
 *
 * 为什么只收这些：`人人` `常常` `渐渐` `爸爸` `星星` 都是正常叠词；
 * `研究研究` `商量商量` 是动词重叠。这里只放**不会正常叠用**的单字虚词/代词，
 * 宁缺勿滥。
 */
const REPEAT_FUNCTION_CHARS = rules.repeatFunctionChars

/**
 * 连续重复的常见词（闭集）。
 *
 * 为什么不做"任意 2–3 字词重复"的通用检测：中文动词重叠（研究研究 / 商量商量 /
 * 打扫打扫）与量词重叠（一个一个）都是合法表达，没有词性标注就无法区分；
 * 通用检测会把它们全标红。闭集只收"重复出现基本只能是手误"的代词与连接词。
 */
const REPEAT_WORDS: readonly string[] = rules.repeatWords

/** 连续重复的 3 字词（同样是闭集） */
const REPEAT_WORDS_3: readonly string[] = rules.repeatWords3

/** 半角 → 全角（只处理中文句子里常见的六个） */
const HALFWIDTH_TO_FULLWIDTH: Readonly<Record<string, string>> = rules.halfwidthToFullwidth

/** 成对符号（开 → 闭） */
const PAIRS: ReadonlyArray<readonly [string, string]> = rules.pairs.map(
  ([open, close]) => [open, close] as const
)

const OPEN_TO_CLOSE = new Map<string, string>(PAIRS)
const CLOSE_TO_OPEN = new Map<string, string>(PAIRS.map(([open, close]) => [close, open]))

/**
 * 高置信易错词小表 —— **只收高置信项，宁缺勿滥**。
 *
 * 为什么不收"做/作"的整套搭配：`做出` / `做好准备` / `作文章` / `作为` 都合法，
 * 没有词典时无法穷举；只收 `做为`（规范写法是「作为」）这一个固定错误。
 * `即使是` 是**正确**写法，不在表里（不要把它改成 `既使` 的规则反过来）。
 *
 * `skipNext`：后面跟着这些字时是正常词义，不报。例如「在次日」「在次年」是
 * "在 + 次日/次年"，不是「再次」的手误；「登陆舰」是军舰，不是"登录"。
 */
interface ConfusableRule {
  readonly from: string
  readonly to: string
  /** `false` = 风格偏好（可用 otherStyle 关掉） */
  readonly style?: boolean
  /** 后一个字落在这些字里 ⇒ 是正常搭配，跳过 */
  readonly skipNext?: string
  /** 只有后面紧跟账号语境词时才报（「登陆」→「登录」；避免误报台风登陆） */
  readonly loginContext?: boolean
  readonly message?: string
}

const CONFUSABLE_RULES: readonly ConfusableRule[] = rules.confusableRules

/** 「登陆」只有后面跟这些词时才算账号语境（避免把"台风登陆"标红） */
const LOGIN_CONTEXT: readonly string[] = rules.loginContext

/** 用命名占位符填诊断文案（`{text}` / `{open}` …） */
function fmt(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '')
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

function isCjkChar(ch: string | undefined): boolean {
  return !!ch && ch.length === 1 && isCjkCode(ch.charCodeAt(0))
}

function isAsciiAlnum(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch)
}

function isHalfwidthPunctuation(ch: string): boolean {
  return Object.prototype.hasOwnProperty.call(HALFWIDTH_TO_FULLWIDTH, ch)
}

/** 文本里是否含中文（成对符号/直引号规则的前置条件） */
function hasCjk(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isCjkCode(text.charCodeAt(i))) return true
  return false
}

/** 把「允许短语」换算成区间；规则 ① 命中落在区间内就不报 */
function phraseIntervals(text: string, phrases: readonly string[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const phrase of phrases) {
    let at = text.indexOf(phrase)
    while (at >= 0) {
      out.push([at, at + phrase.length])
      at = text.indexOf(phrase, at + 1)
    }
  }
  return out
}

/** ① 虚词连续重复（的的 / 了了 / 是是…） */
function checkRepeatChars(
  text: string,
  out: ZhSpellIssue[],
  allowed: Array<[number, number]>
): void {
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i]
    if (ch !== text[i + 1] || !REPEAT_FUNCTION_CHARS.includes(ch)) continue
    // 三个以上连续重复只报一次（"的的的"）
    if (i > 0 && text[i - 1] === ch) continue
    if (allowed.some(([start, end]) => i >= start && i + 2 <= end)) continue
    out.push({
      from: i,
      to: i + 2,
      kind: 'repeat-char',
      message: fmt(rules.messages.repeatChar, { text: ch + ch }),
      suggestions: [ch],
      advisory: false
    })
  }
}

/** ② 常见词连续重复（我们我们 / 为什么为什么） */
function checkRepeatWords(text: string, out: ZhSpellIssue[]): void {
  const scan = (words: readonly string[]): void => {
    for (const word of words) {
      const doubled = word + word
      let at = text.indexOf(doubled)
      while (at >= 0) {
        out.push({
          from: at,
          to: at + doubled.length,
          kind: 'repeat-word',
          message: fmt(rules.messages.repeatWord, { text: doubled }),
          suggestions: [word],
          advisory: false
        })
        at = text.indexOf(doubled, at + doubled.length)
      }
    }
  }
  scan(REPEAT_WORDS)
  scan(REPEAT_WORDS_3)
}

/** ③a 中文句里的半角标点 */
function checkHalfwidthPunctuation(text: string, out: ZhSpellIssue[]): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!isHalfwidthPunctuation(ch)) continue
    const prev = text[i - 1]
    const next = text[i + 1]
    // 数字/英文词内部的半角标点（3.14 / 1,000 / 文件.txt / example.com / http://）不是中文标点问题
    if (isAsciiAlnum(prev) || isAsciiAlnum(next)) continue
    if (!isCjkChar(prev) && !isCjkChar(next)) continue
    const full = HALFWIDTH_TO_FULLWIDTH[ch]
    out.push({
      from: i,
      to: i + 1,
      kind: 'halfwidth-punctuation',
      message: fmt(rules.messages.halfwidth, { full, half: ch }),
      suggestions: [full],
      advisory: false
    })
  }
}

/** ③b 成对符号：数量不平衡 / 嵌套错位（按整段文本扫描，调用方按段落传） */
function checkPairs(text: string, out: ZhSpellIssue[]): void {
  interface Open {
    open: string
    close: string
    index: number
  }
  const stack: Open[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const close = OPEN_TO_CLOSE.get(ch)
    if (close) {
      stack.push({ open: ch, close, index: i })
      continue
    }
    const open = CLOSE_TO_OPEN.get(ch)
    if (!open) continue
    const top = stack[stack.length - 1]
    if (!top) {
      out.push({
        from: i,
        to: i + 1,
        kind: 'unbalanced-pair',
        message: fmt(rules.messages.pairMissingOpen, { open, close: ch }),
        advisory: false
      })
      continue
    }
    if (top.close !== ch) {
      out.push({
        from: i,
        to: i + 1,
        kind: 'unbalanced-pair',
        message: fmt(rules.messages.pairNested, { open: top.open, close: ch }),
        advisory: false
      })
      // 不弹出：让末尾再报一次"『top.open』未闭合"，用户能看到两边
      continue
    }
    stack.pop()
  }
  for (const item of stack) {
    out.push({
      from: item.index,
      to: item.index + 1,
      kind: 'unbalanced-pair',
      message: fmt(rules.messages.pairMissingClose, { open: item.open, close: item.close }),
      advisory: false
    })
  }

  // 直引号 `"`：只在中文段落里、且数量为奇数时提示（6" 这类尺寸记号不在中文段落里）
  if (hasCjk(text) && (text.match(/"/g)?.length ?? 0) % 2 === 1) {
    const at = text.lastIndexOf('"')
    out.push({
      from: at,
      to: at + 1,
      kind: 'unbalanced-pair',
      message: rules.messages.straightQuote,
      advisory: false
    })
  }
}

/** ④ 高置信易错词 */
function checkConfusables(text: string, out: ZhSpellIssue[], options: CheckChineseOptions): void {
  for (const rule of CONFUSABLE_RULES) {
    if (rule.style && options.otherStyle === 'its') continue
    let at = text.indexOf(rule.from)
    while (at >= 0) {
      const next = text[at + rule.from.length]
      if (rule.loginContext) {
        // 账号语境才报：后面必须紧跟 LOGIN_CONTEXT 里的词
        const rest = text.slice(at + rule.from.length)
        if (!LOGIN_CONTEXT.some((word) => rest.startsWith(word))) {
          at = text.indexOf(rule.from, at + rule.from.length)
          continue
        }
      }
      if (rule.skipNext && next && rule.skipNext.includes(next)) {
        at = text.indexOf(rule.from, at + rule.from.length)
        continue
      }
      out.push({
        from: at,
        to: at + rule.from.length,
        kind: 'confusable',
        message: rule.message ?? fmt(rules.messages.confusable, { from: rule.from, to: rule.to }),
        suggestions: [rule.to],
        advisory: false
      })
      at = text.indexOf(rule.from, at + rule.from.length)
    }
  }
}

/** ⑤ 中英之间缺空格（只提示，默认可关闭） */
function checkCjkSpacing(text: string, out: ZhSpellIssue[]): void {
  for (let i = 0; i < text.length - 1; i++) {
    const left = text[i]
    const right = text[i + 1]
    const hit = (isCjkChar(left) && isAsciiAlnum(right)) || (isAsciiAlnum(left) && isCjkChar(right))
    if (!hit) continue
    out.push({
      from: i,
      to: i + 2,
      kind: 'cjk-spacing',
      message: rules.messages.spacing,
      advisory: true
    })
    i++ // 同一处边界只报一次（"中A中" 不重复报两个方向）
  }
}

/**
 * 检查一段中文文本。
 *
 * @param text 一段**完整**的自然语言文本（调用方按段落拼接后传入，
 *             这样成对符号不会因为行内样式被拆到两个文本节点而误报）；
 *             返回值里的 `from/to` 是**相对该文本**的偏移。
 */
export function checkChinese(text: string, options: CheckChineseOptions = {}): ZhSpellIssue[] {
  if (!text) return []
  const out: ZhSpellIssue[] = []
  checkRepeatChars(text, out, phraseIntervals(text, REPEAT_CHAR_ALLOW_PHRASES))
  checkRepeatWords(text, out)
  checkHalfwidthPunctuation(text, out)
  checkPairs(text, out)
  checkConfusables(text, out, options)
  if (options.checkSpacing === true) checkCjkSpacing(text, out)

  /**
   * ⑥ 白名单：**整条命中**都落在某个术语/语言名内部时丢掉。
   * 只丢"命中在词内"的项：`简体中文` 里的规则误报会被消掉，而紧挨着它的
   * `我们的的` 仍然是独立区间，照常报。
   */
  const termSpans = findTermSpans(text, options.allowTerms ?? ZH_ALLOW_TERMS)
  const kept =
    termSpans.length === 0
      ? out
      : out.filter(
          (issue) => !termSpans.some(([start, end]) => issue.from >= start && issue.to <= end)
        )

  // 按位置排序后截断：超大文档也不让 DecorationSet 无上界增长
  kept.sort((a, b) => a.from - b.from || a.to - b.to)
  return kept.length > ZH_MAX_ISSUES ? kept.slice(0, ZH_MAX_ISSUES) : kept
}
