import { createI18n } from 'vue-i18n'
// 语言包放在 src/shared/i18n：**主进程的原生菜单也要用**（菜单三语化），
// 一处维护、两个进程共用（跨进程的东西放 shared —— README 的开发约定）
import zhCN from '../../../shared/i18n/zh-CN.json'
import type { Language } from '../../../shared/types'

// 语言目录是纯数据（JSON），新增语言 = 新增一个 {locale}.json + 在 Language 联合
// 类型与下方 messages 中登记，UI 语言选择器自动枚举（settings.language 持久化）
//
// ── 为什么只有首个语言包是**静态**导入的（第二十五轮轻量化）────────────────────
// 三份包合起来约 250KB 源码，而 `i18n/index.ts` 在 `main.ts` 的静态依赖链上 ⇒
// 无论用户选哪种语言都要解析三份。现在静态只留**默认语言 zh-CN**（首屏骨架用的就是它），
// 其余语言在**真正切过去之前**用 `ensureLanguage()` 动态拉取并 `setLocaleMessage` 装进 i18n。
// 主进程那一侧不受影响：它自己 import 需要的那一份（原生菜单）。
const messages = {
  'zh-CN': zhCN
} as const

/** 语言包的结构类型（三份 JSON 键完全一致，由单测 `i18nAndIpc.test.mjs` 守着） */
type MessageSchema = typeof zhCN

/** 语言包加载器（zh-CN 是静态的，这里只登记其余语言） */
const loaders: Partial<Record<Language, () => Promise<{ default: MessageSchema }>>> = {
  'en-US': () => import('../../../shared/i18n/en-US.json'),
  'ru-RU': () => import('../../../shared/i18n/ru-RU.json')
}
const loaded = new Set<Language>(['zh-CN'])

export const LANGUAGE_OPTIONS: { value: Language; label: string; short: string }[] = [
  { value: 'zh-CN', label: '简体中文', short: '中文' },
  { value: 'en-US', label: 'English', short: 'EN' },
  { value: 'ru-RU', label: 'Русский', short: 'RU' }
]

export const i18n = createI18n({
  legacy: false,
  // 显式标成 Language：否则 TS 会把 locale 收窄成字面量 'zh-CN'，切语言时赋值报错
  locale: 'zh-CN' as Language,
  // 回退语言也用静态那一份：回退是**兜底**，不能依赖「另一个包刚好加载过」
  fallbackLocale: 'zh-CN' as Language,
  messages
})

/**
 * 确保某个语言的包已装进 i18n（幂等；zh-CN 天然已装）。
 * 动态 import 的失败不该让整个应用挂掉：调用方 `setLanguage` 会退回当前语言。
 */
export async function ensureLanguage(lang: Language): Promise<void> {
  if (loaded.has(lang)) return
  const load = loaders[lang]
  if (!load) return
  const mod = await load()
  i18n.global.setLocaleMessage(lang, mod.default)
  loaded.add(lang)
}

/**
 * 切换语言。**先加载包、再切 locale**：反过来的话会有一帧显示原始 key
 * （`i18n.global.locale` 指向一个还没装消息的语言）。
 */
export async function setLanguage(lang: Language): Promise<void> {
  try {
    await ensureLanguage(lang)
  } catch {
    /* 包拉不下来（理论上不会：本地 chunk）→ 保持当前语言 */
    return
  }
  // vue-i18n 把 `locale` 的静态类型收窄成「`messages` 里登记过的 key」，而其余语言是**运行时**
  // 装进去的（ensureLanguage / setLocaleMessage），静态类型天然追不上 —— 这里显式放宽一次。
  ;(i18n.global.locale as unknown as { value: Language }).value = lang
  document.documentElement.lang = lang
}

/** 循环切换下一种语言（状态栏快捷按钮用） */
export function nextLanguage(lang: Language): Language {
  const idx = LANGUAGE_OPTIONS.findIndex((o) => o.value === lang)
  return LANGUAGE_OPTIONS[(idx + 1) % LANGUAGE_OPTIONS.length].value
}

export default i18n
