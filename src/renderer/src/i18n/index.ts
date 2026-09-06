import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'
import ruRU from './locales/ru-RU.json'
import type { Language } from '../../../shared/types'

// 语言目录是纯数据（JSON），新增语言 = 新增一个 {locale}.json + 在 Language 联合
// 类型与下方 messages 中登记，UI 语言选择器自动枚举（settings.language 持久化）
const messages = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ru-RU': ruRU
} as const

export const LANGUAGE_OPTIONS: { value: Language; label: string; short: string }[] = [
  { value: 'zh-CN', label: '简体中文', short: '中文' },
  { value: 'en-US', label: 'English', short: 'EN' },
  { value: 'ru-RU', label: 'Русский', short: 'RU' }
]

export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages
})

export function setLanguage(lang: Language): void {
  i18n.global.locale.value = lang
  document.documentElement.lang = lang
}

/** 循环切换下一种语言（状态栏快捷按钮用） */
export function nextLanguage(lang: Language): Language {
  const idx = LANGUAGE_OPTIONS.findIndex((o) => o.value === lang)
  return LANGUAGE_OPTIONS[(idx + 1) % LANGUAGE_OPTIONS.length].value
}

export default i18n
