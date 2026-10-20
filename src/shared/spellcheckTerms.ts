// ─── 拼写检查：随应用发布的**术语表**（产品名 / 技术名 / 语言名）───────────────
//
// 为什么需要它：Chromium 的词典是通用英语词典，`Lumin` / `KaTeX` / `CodeMirror`
// 这类专有名词天然不在里面，正文里就会被画红波浪线。它们不是错词，不该由用户
// 手动「添加到词典」来消掉，所以应用自带一份术语表，拼写检查开启时注册给
// Chromium；关闭时只撤销**我们自己加进去的**词（用户原有的词不动，见
// `main/services/spellcheck.ts` 的 add/remove 记账）。
//
// 数据为什么放在 JSON：① 这些是"术语数据"，不是界面文案，三种界面语言共用；
// ② `tests/i18nHardcoded.test.mjs` 会把 .ts 字符串字面量里的中文当成"界面硬编码"
// 报错，而词表里必须出现「中文」「简体」「繁體」这些语言自称。
//
// 中文检查层也复用这里的语言名白名单：`简体中文` / `繁體中文` / `English` 等
// **精确出现**时不参与启发式规则（宁可漏报，也不把语言名标红）。

import data from './spellcheckTerms.json' with { type: 'json' }

/**
 * 随应用发布的术语表。
 *
 * 约束（见 `tests/spellcheckTerms.test.mjs`）：
 *   * 非空、无前后空格、无重复（大小写不敏感）；
 *   * 必须包含用户点名的产品名/技术名/语言名；
 *   * **不得**包含 `teh` / `recieve` 这类真错词 —— 否则回归对照会失效。
 */
export const SPELLCHECK_TERMS: readonly string[] = data.terms

/**
 * 中文启发式检查的**精确白名单**：这些词按出现区间整体豁免。
 * 只收语言名（含中文/英文自称），不放产品术语 —— 产品名一般不含重复字、
 * 半角标点等中文规则会误报的形状，放进来只会扩大漏报面。
 */
export const ZH_ALLOW_TERMS: readonly string[] = data.zhAllowTerms

/** 术语比较口径：去首尾空白 + 小写（Chromium 的自定义词典同样忽略大小写） */
export function normalizeTerm(word: string): string {
  return word.trim().toLocaleLowerCase('en-US')
}

const TERM_KEYS = new Set(SPELLCHECK_TERMS.map(normalizeTerm))

/** 是否恰好是术语表里的词（整词匹配；`Luminosity` 不算 `Lumin`） */
export function isSpellcheckTerm(word: string): boolean {
  return TERM_KEYS.has(normalizeTerm(word))
}

function isAsciiWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch)
}

/**
 * 某段文本里所有白名单词的出现区间（UTF-16 下标，`[from, to)`）。
 *
 * 拉丁词要求**词边界**（`Vue` 不能命中 `Vuex`）；中文词没有空格，只按子串找
 * （`简体中文版` 里的 `简体中文` 仍算语言名，这是有意的）。
 * 返回值可能重叠（`简体中文` 同时含 `简体` 与 `中文`），过滤时只看"是否被某一段覆盖"。
 */
export function findTermSpans(
  text: string,
  terms: readonly string[] = ZH_ALLOW_TERMS
): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  if (!text) return spans
  for (const term of terms) {
    if (!term) continue
    let at = text.indexOf(term)
    while (at >= 0) {
      const end = at + term.length
      const leftOk = !isAsciiWordChar(term[0]) || at === 0 || !isAsciiWordChar(text[at - 1])
      const rightOk =
        !isAsciiWordChar(term[term.length - 1]) ||
        end === text.length ||
        !isAsciiWordChar(text[end])
      if (leftOk && rightOk) spans.push([at, end])
      at = text.indexOf(term, at + 1)
    }
  }
  return spans
}
