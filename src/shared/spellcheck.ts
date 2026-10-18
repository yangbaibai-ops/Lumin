// ─── 拼写检查：语言清单的**纯规则**（主进程 / 渲染层 / 单测共用）──────────────
//
// 为什么单独成文件：语言清单有两个来源，规则必须只有一份 ——
//   * **可选项**来自 Electron 的 `session.availableSpellCheckerLanguages`（不写死）；
//   * **常见语言优先**是纯排序规则（用户口径：英语/德语/法语…排前面，其余按字母序）；
//   * **持久化里存的语言**可能已经不可用（换机器、系统删了语言包），要能安全降级。
// 这些都不需要 Electron 就能判定，所以放 shared：`node --test` 直接跑，
// 主进程与设置界面读同一份实现，不会出现「界面顺序和真正生效的语言不一致」。
//
// 边界（有意不做的事）：**不自己判断某种语言有没有词典**。中文/日文在这里没有色儿，
// 是因为 Chromium 的 availableSpellCheckerLanguages 本来就不提供它们 —— 若某个平台
// 真的给了，那就该让它出现（"系统没给就自然没有"，而不是维护第二份语言名单）。

/**
 * 常见语言在界面里的优先级（用户点名的顺序，紧跟着每种语言的**基础代码**）。
 *
 * 为什么连 `de` / `fr` 这些基础代码也排在前面：Electron 在 Windows 上给出的
 * `availableSpellCheckerLanguages` 同时有 `de-DE` 与 `de`（实测），而 nl / pl / ru / uk
 * 往往**只有基础代码**。只把 `nl-NL` 写进优先表，会让荷兰语/波兰语/俄语掉到字母序里，
 * 与"常见语言排在前面"的用户口径不符。变体在基础代码之前（更具体的优先）。
 * 这只是**排序偏好**，不是可用性名单：不在 available 里的项会被自然跳过。
 */
export const COMMON_SPELLCHECK_LANGUAGES: readonly string[] = [
  'en-US',
  'en-GB',
  'en',
  'de-DE',
  'de',
  'fr-FR',
  'fr',
  'es-ES',
  'es',
  'pt-BR',
  'pt',
  'it-IT',
  'it',
  'nl-NL',
  'nl',
  'pl-PL',
  'pl',
  'ru-RU',
  'ru',
  'uk-UA',
  'uk'
]

/** 右键建议最多显示几条（Chromium 有时给一长串，菜单只放得下几条） */
export const MAX_SPELL_SUGGESTIONS = 5

/** 只保留非空字符串并去重（available 在极少数平台可能带重复/空项） */
function uniqueCodes(codes: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of codes) {
    if (typeof raw !== 'string') continue
    const code = raw.trim()
    if (!code || seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

/**
 * 界面里可选的拼写检查语言：**常见语言按用户点名的顺序在前，其余按字母序**。
 * 输入就是 `availableSpellCheckerLanguages` 的原值（不做任何"支持列表"的伪造）。
 */
export function sortSpellcheckLanguages(available: readonly string[]): string[] {
  const rank = new Map(COMMON_SPELLCHECK_LANGUAGES.map((code, index) => [code, index]))
  return uniqueCodes(available).sort((a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra !== undefined || rb !== undefined) {
      // 常见语言全部排在其它语言之前；两者都常见时按优先级
      if (ra === undefined) return 1
      if (rb === undefined) return -1
      return ra - rb
    }
    // 字母序用 en 做基准（语言代码是 ASCII，与运行环境 locale 无关，结果可复现）
    return a.localeCompare(b, 'en')
  })
}

/** 只留下当前系统真的可用的语言（保持调用方给的顺序、去重） */
export function sanitizeSpellcheckLanguages(
  requested: readonly string[],
  available: readonly string[]
): string[] {
  const allowed = new Set(uniqueCodes(available))
  return uniqueCodes(requested).filter((code) => allowed.has(code))
}

/**
 * 真正要交给 `session.setSpellCheckerLanguages` 的清单。
 *
 * 口径：
 *   1. 用户选过（非空）⇒ 只保留当前可用的那些；一个都不剩时按默认偏好降级
 *      （否则用户换机器后会得到"看起来开着、其实一个词典都没加载"的空转状态）；
 *   2. 没选过（空数组 = 自动）⇒ 按 `preferred`（调用方通常传界面语言与系统 locale）
 *      再按常见语言顺序挑**一个**可用项；
 *   3. `available` 为空（该平台没有拼写词典）⇒ 返回空数组，调用方据此如实说明不可用。
 */
export function resolveSpellcheckLanguages(
  requested: readonly string[],
  available: readonly string[],
  preferred: readonly string[] = []
): string[] {
  const usable = sortSpellcheckLanguages(available)
  if (usable.length === 0) return []
  const chosen = sanitizeSpellcheckLanguages(requested, usable)
  if (chosen.length > 0) return chosen
  for (const code of [...preferred, ...COMMON_SPELLCHECK_LANGUAGES, ...usable]) {
    if (usable.includes(code)) return [code]
  }
  return [usable[0]]
}
