/**
 * ─── 阅读时长 / 目标字数（纯函数，可单测）──────────────────────────────────────
 *
 * 审计清单「目标字数 / 阅读时长」：状态栏此前只有字数/行数/字符数，读一遍要多久与
 * 「写够了没有」都得用户自己心算。这里给出这两件事的**唯一口径**（速率是参考值，不是承诺）：
 *
 *   * 中文（CJK 统一表意文字 + 扩展 A）按 **400 字/分钟**；
 *   * 拉丁词按 **200 词/分钟**（连续 `[a-zA-Z0-9_]` 算一个词；`don't` 算一个，
 *     而连字符 `-` 按**既有**字数口径当分隔符，所以 `well-known` 算两个 —— 口径不变优先）；
 *   * 中英混排时**两种速率分别计时再相加**（不是「总字数 ÷ 一个速率」）——
 *     混排文档里字数与词数不可比，各自按自己的速度读才是"读一遍要多久"的体感，
 *     见 tests/readingTime.test.mjs 里那条能区分两种算法的断言；
 *   * 计数前先抹掉 Markdown 行内标记（`#` `*` `_` 引号/括号/竖线等），否则 `**加粗**`
 *     这样的标记会被当成正文——这一套字符类与状态栏的「字数」**同源**（见 measureText）。
 *   * 空文档 0 分钟；非空文档至少 1 分钟（40 个字的便签显示「0 分钟」是错的）。
 *
 * 字数目标是**全局的一项设置**（`AppSettings.wordGoal`，0 = 未设置），不按文档分别记：
 *   * 按文档记要引入「路径 → 目标」的持久化映射（kv 里一张表或 documents 加一列 =
 *     改数据库 schema），而绝大多数用法是「今天这篇写到 N 字」这种一次性的会话目标；
 *   * 全局一个数字最简、也最不容易出错（改一处、所有文档跟着走）；
 *   * 真需要按篇目标时再升级为文档级元数据，那时词表/表结构一次到位比现在猜要稳。
 * 状态栏只在 `wordGoal > 0` 时才多出那一格 —— 没设目标的人不该多看到一个 0。
 *
 * 纯函数：不碰 fs / DB / DOM，`node --test` 直接跑（tests/readingTime.test.mjs）。
 */

/** 中文阅读速率（字/分钟） */
export const CJK_CHARS_PER_MINUTE = 400
/** 拉丁词阅读速率（词/分钟） */
export const LATIN_WORDS_PER_MINUTE = 200

/**
 * 抹掉后当空白处理的 Markdown 行内标记。
 * `-` 放在类末尾：字符类末尾的连字符无需转义（与主进程/渲染层原来的写法逐字一致）。
 */
const MARKUP_CHARS = /[#>*`_~[\]()!|-]/g
/** CJK 统一表意文字（含扩展 A） */
const CJK_CHAR = /[\u4e00-\u9fff\u3400-\u4dbf]/g
/** 一个拉丁「词」：字母/数字/下划线串，允许内部的 `'` `’` 连接（don't）。
 *  连字符不在这里 —— 它已被上面的标记表抹成空白（沿用既有字数口径：`well-known` 算两个词）。 */
const LATIN_WORD = /[a-zA-Z0-9_]+(?:['’-][a-zA-Z0-9_]+)*/g

/** 一篇文本的量：中文按**字**、拉丁按**词**分开数（两者不可比，所以不合并成一个数就够用） */
export interface TextMeasure {
  cjkChars: number
  latinWords: number
  /** 状态栏显示的那个「字数」= cjkChars + latinWords */
  words: number
}

/**
 * 计数（字数统计的**唯一实现**）。
 *
 * 主进程的 `documents.word_count`、渲染层状态栏的字数、阅读时长都走这里，
 * 避免出现「状态栏 800 字、阅读时长按另一套算法算」这种自相矛盾的两份真值。
 */
export function measureText(content: string): TextMeasure {
  const text = content.replace(MARKUP_CHARS, ' ').trim()
  if (!text) return { cjkChars: 0, latinWords: 0, words: 0 }
  const cjkChars = (text.match(CJK_CHAR) || []).length
  const latinWords = (text.match(LATIN_WORD) || []).length
  return { cjkChars, latinWords, words: cjkChars + latinWords }
}

/**
 * 预计阅读时长（分钟，**向上取整**）。
 * 空文档（或只剩标记）返回 0；非空至少 1 —— 「不足一分钟」在界面上的正确说法就是「1 分钟」。
 *
 * 两种入口是**同一份算法**：`readingMinutesOf()` 吃已经数好的量，
 * `readingMinutes()` 只是"从原文数一遍再算"的便捷包装。渲染层走前者 ——
 * 状态栏每敲一个键就要重算，而字数的按内容缓存（stores/files.ts 的 countsOf）
 * 已经扫过一遍全文了，这里不该再扫第二遍（大文档下那是每键可感的成本）。
 */
export function readingMinutesOf(measure: TextMeasure): number {
  const { cjkChars, latinWords } = measure
  if (!cjkChars && !latinWords) return 0
  const minutes = cjkChars / CJK_CHARS_PER_MINUTE + latinWords / LATIN_WORDS_PER_MINUTE
  return Math.max(1, Math.ceil(minutes))
}

/** 从原文算阅读时长（自己数一遍；等价于 `readingMinutesOf(measureText(content))`） */
export function readingMinutes(content: string): number {
  return readingMinutesOf(measureText(content))
}

/**
 * 把分钟数拆成「几小时几分钟」。
 * 拆解是纯数字逻辑，**拼成哪国话由界面按 i18n 决定**（本模块不含任何文案）。
 */
export function splitReadingMinutes(total: number): { hours: number; minutes: number } {
  const t = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  return { hours: Math.floor(t / 60), minutes: t % 60 }
}

/** 目标字数进度：`goal <= 0` = 未设置（此时状态栏不显示这一格） */
export interface WordGoalProgress {
  set: boolean
  /**
   * 完成比例（current / goal）。**不钳到 1**：超额完成时「120%」是有用信息，
   * 钳掉之后 100% 与 300% 会看起来一样。
   */
  ratio: number
  reached: boolean
}

/** 目标字数进度（未设置时 `set: false`、`ratio: 0`、`reached: false`） */
export function wordGoalProgress(current: number, goal: number): WordGoalProgress {
  if (!(goal > 0)) return { set: false, ratio: 0, reached: false }
  return { set: true, ratio: current / goal, reached: current >= goal }
}
