// ─── 主进程的文案（语言包与渲染层**同一份文件**）─────────────────────────────
//
// 为什么单独成模块：主进程有三处需要给用户看文案 —— 原生菜单、原生对话框
// （打开/保存的过滤器名）、Windows 跳转列表（任务名/分类），外加导出产物里的
// `<title>目录</title>`。此前各写各的：`menu.ts` 自己读一份语言包，`taskbar.ts`
// 里挂着三份手抄的三语字典，`ipc.ts` 直接写死中文，导出模板把 `目录` 写死在 HTML 里
// （审计 §10：i18n 键对齐被守住了，但"界面有没有绕过键"是空的）。
//
// 这里收成一个入口：`mainT('ns.key')` 取词、`mainLanguage()` 取当前语言。
// 缺键按「当前语言 → 中文包 → key 本身」回退，绝不显示 undefined。
import zhCN from '../shared/i18n/zh-CN.json'
import enUS from '../shared/i18n/en-US.json'
import ruRU from '../shared/i18n/ru-RU.json'
import { db } from './services/database'
import { defaultSettings } from '../shared/defaults'
import type { AppSettings, Language } from '../shared/types'

const PACKS: Record<Language, unknown> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ru-RU': ruRU
}

/** 当前语言：以持久化设置里的为准（与渲染层同一个 kv 键；缺省中文） */
export function mainLanguage(): Language {
  const settings = db.kvGet<AppSettings>('settings', defaultSettings)
  const lang = settings?.language
  return lang && lang in PACKS ? (lang as Language) : 'zh-CN'
}

/** 按 `a.b.c` 取嵌套值；取不到返回 undefined */
function lookup(pack: unknown, key: string): unknown {
  let cur: unknown = pack
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * 主进程取词。`params` 用 `{name}` 占位符替换（与渲染层 vue-i18n 的写法一致）。
 * 缺键回退顺序：当前语言 → 中文包 → key（这样漏翻译时至少能看到键名，而不是空白）。
 */
export function mainT(key: string, params?: Record<string, string | number>): string {
  const lang = mainLanguage()
  const raw = lookup(PACKS[lang], key) ?? lookup(PACKS['zh-CN'], key)
  let text = typeof raw === 'string' ? raw : key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
  }
  return text
}
