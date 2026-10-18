// ─── 拼写检查（Electron / Chromium 内置检查器）──────────────────────────────
//
// 能力边界（先说清楚，避免把"系统没给"说成"我们做了"）：
//   * 词典与下划线**全部由 Chromium 负责**。我们只做三件事：
//       ① 开关：`session.setSpellCheckerEnabled`
//       ② 语言：`session.setSpellCheckerLanguages`（清单只取 availableSpellCheckerLanguages）
//       ③ 把右键参数（misspelledWord / dictionarySuggestions）转给渲染层自绘菜单
//   * **没有** "ignore word" 的公开 API（Electron 只给了 add/remove dictionary）。
//     所以"忽略"是本进程内的一份临时表：忽略后不再把该词的建议送进菜单，
//     但**下划线仍由 Chromium 绘制** —— 要连下划线一起消掉只能"添加到词典"。
//     这个取舍写在菜单项的 title 里，不假装忽略等于永久修正。
//   * `availableSpellCheckerLanguages` 在某些平台可能为空（没有可用词典）。此时如实返回，
//     界面提示"该平台没有可用词典"，绝不伪造一份语言清单。
import { app, session as electronSession, type WebContents } from 'electron'
import type { AppSettings } from '../../shared/types'
import { resolveSpellcheckLanguages, MAX_SPELL_SUGGESTIONS } from '../../shared/spellcheck'
import { readSettings } from './appSettings'

/** 转给渲染层的右键参数（`spell:context` 的负载） */
export interface SpellContextPayload {
  x: number
  y: number
  /** 被判定拼错的词；空串 = 这里没有拼写错误（关闭/非自然语言区域/已加入词典） */
  word: string
  /** 最多 MAX_SPELL_SUGGESTIONS 条建议（原值见主进程日志） */
  suggestions: string[]
  /** 当前总开关状态（渲染层只用于诊断，不据此改变菜单结构） */
  enabled: boolean
}

/** 对外暴露的检查器状态（设置界面与验收脚本读它） */
export interface SpellcheckState {
  enabled: boolean
  /** 当前**真正生效**的语言（来自 session） */
  languages: string[]
  /** 系统实际提供的全部语言（原值，不排序、不过滤；空 = 该平台没有词典） */
  available: string[]
}

/** 已附加右键监听的 webContents（避免同一窗口重复注册） */
const attached = new WeakSet<WebContents>()

/**
 * 本进程内的「忽略」表（小写）。只影响我们送给菜单的建议；
 * 不下发任何"忽略"给 Chromium —— 它没有这个 API。
 */
const ignoredWords = new Set<string>()

/** 本平台可用的词典语言（每次现取：语言包可能被系统更新） */
function availableLanguages(): string[] {
  try {
    const list = electronSession.defaultSession.availableSpellCheckerLanguages
    return Array.isArray(list) ? [...list] : []
  } catch {
    return []
  }
}

/** 当前生效状态（直接问 session，不维护第二份真相） */
export function getSpellcheckState(): SpellcheckState {
  const ses = electronSession.defaultSession
  return {
    enabled: ses.spellCheckerEnabled,
    languages: ses.getSpellCheckerLanguages(),
    available: availableLanguages()
  }
}

/**
 * 按设置落地到当前 session。**改完立即生效**（不需要重启）：
 * 设置界面每次改动都会经 `settings:update` 调到这里。
 */
export function applySpellcheckSettings(settings: AppSettings): SpellcheckState {
  const ses = electronSession.defaultSession
  const available = availableLanguages()
  const languages = resolveSpellcheckLanguages(settings.spellcheckLanguages, available, [
    app.getLocale(),
    'en-US',
    'en'
  ])
  const wantedEnabled = !!settings.spellcheckEnabled
  const before = getSpellcheckState()
  /**
   * 只在真的变了的时候才调用 Electron：
   * `settings:update` 送的是**整份状态**（store 的落库方式），每次保存都会走到这里；
   * 无条件 `setSpellCheckerLanguages` 会让 Chromium 重载词典，正文的下划线短暂消失。
   */
  const languagesChanged =
    wantedEnabled &&
    (before.languages.length !== languages.length ||
      before.languages.some((code, index) => code !== languages[index]))
  try {
    if (before.enabled !== wantedEnabled) ses.setSpellCheckerEnabled(wantedEnabled)
    if (languagesChanged) {
      try {
        if (languages.length > 0) ses.setSpellCheckerLanguages(languages)
      } catch (err) {
        // 语言包被系统移除 / 平台不认这个代码：退回"不指定"，让 Chromium 用默认语言。
        // 主进程 console 一律 ASCII（见 tests/mainConsoleAscii.test.mjs）。
        console.log(
          `[spell] set-languages failed: ${err instanceof Error ? err.message : String(err)}`
        )
        try {
          ses.setSpellCheckerLanguages([])
        } catch {
          /* 连清空都失败：保持 Chromium 的默认语言，不拦住启动 */
        }
      }
    }
  } catch (err) {
    // 平台没有拼写检查实现时也不该让"保存设置"失败
    console.log(`[spell] apply failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const state = getSpellcheckState()
  if (before.enabled !== state.enabled || languagesChanged) {
    console.log(
      `[spell] state enabled=${state.enabled} languages=${JSON.stringify(state.languages)} available=${state.available.length}`
    )
  }
  return state
}

/**
 * 启动时调用一次（readSettings 已归一，缺键会回落默认值）。
 * 顺序要点：必须在窗口创建/加载之前 —— 页面首帧就可能带着正文，
 * 晚一步会让用户先看到一帧没有下划线的文档再"补上"，观感像闪了一下。
 */
export function initializeSpellcheck(): SpellcheckState {
  const available = availableLanguages()
  // 原值写进日志：验收要求"可用语言清单原值"，也便于排查"系统到底给了什么"。
  console.log(`[spell] available=${JSON.stringify(available)}`)
  let state: SpellcheckState
  try {
    state = applySpellcheckSettings(readSettings())
  } catch (err) {
    // 拼写检查是增强能力：初始化失败不该拦住应用启动
    console.log(`[spell] init failed: ${err instanceof Error ? err.message : String(err)}`)
    state = getSpellcheckState()
  }
  // 启动时的最终状态（重启后持久化是否生效，就看这一行）
  console.log(`[spell] init enabled=${state.enabled} languages=${JSON.stringify(state.languages)}`)
  return state
}

/**
 * 给一个窗口挂右键监听。
 *
 * ⚠️ 关键前提：渲染层**不能**在正文区域 `preventDefault()` 掉 DOM 的 contextmenu ——
 * Chromium 只有在页面没有拦截时才会把这次右键交给主进程（实测：拦截后
 * `webContents.on('context-menu')` 完全不触发，`params.misspelledWord` 也就永远拿不到）。
 * 所以正文右键改为：DOM 事件只记坐标 → 主进程带着拼写参数回发 → 渲染层再开自绘菜单。
 * 其它区域（文件树、输入框…）仍按原样 preventDefault，主进程收不到事件，行为不变。
 */
export function attachSpellcheckContextMenu(webContents: WebContents): void {
  if (attached.has(webContents)) return
  attached.add(webContents)
  webContents.on('context-menu', (_event, params) => {
    if (webContents.isDestroyed()) return
    const enabled = electronSession.defaultSession.spellCheckerEnabled
    const rawWord =
      enabled && typeof params.misspelledWord === 'string' ? params.misspelledWord : ''
    const ignored = rawWord.length > 0 && ignoredWords.has(rawWord.toLowerCase())
    const word = ignored ? '' : rawWord
    const rawSuggestions = Array.isArray(params.dictionarySuggestions)
      ? params.dictionarySuggestions.filter(
          (s): s is string => typeof s === 'string' && s.length > 0
        )
      : []
    const suggestions = word ? rawSuggestions.slice(0, MAX_SPELL_SUGGESTIONS) : []

    const payload: SpellContextPayload = {
      x: params.x,
      y: params.y,
      word,
      suggestions,
      enabled
    }
    webContents.send('spell:context', payload)

    // 取证日志：docx 里拿不到主进程参数，这行就是 `params.misspelledWord` 的原值。
    // 只在可编辑区域打（正文/代码块/mermaid 源码框），免得每次右键侧栏都刷一行。
    if (params.isEditable) {
      if (rawWord) {
        console.log(
          `[spell] context misspelled=${JSON.stringify(rawWord)} suggestions=${JSON.stringify(rawSuggestions)}${ignored ? ' ignored=1' : ''}`
        )
      } else {
        console.log(`[spell] context misspelled="" enabled=${enabled}`)
      }
    }
  })
}

/** 「添加到词典」：写进 Chromium 的用户词典（持久化，重启后仍有效） */
export function addWordToDictionary(word: string): boolean {
  const trimmed = word.trim()
  if (!trimmed) return false
  try {
    const ok = electronSession.defaultSession.addWordToSpellCheckerDictionary(trimmed)
    console.log(`[spell] add-word ok=${ok}`)
    return ok
  } catch (err) {
    // 该平台不支持自定义词典：如实返回 false，不假装成功
    console.log(`[spell] add-word failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * 「忽略」：只在本进程内生效（见文件头的能力边界）。
 * 返回是否记录成功；空词返回 false。
 */
export function ignoreWord(word: string): boolean {
  const trimmed = word.trim()
  if (!trimmed) return false
  ignoredWords.add(trimmed.toLowerCase())
  console.log('[spell] ignore-word (session scope)')
  return true
}
