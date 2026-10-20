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
import { normalizeTerm, SPELLCHECK_TERMS } from '../../shared/spellcheckTerms'
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
  /** 随应用发布的术语表（产品名/技术名/语言名；**不是**用户词典） */
  terms: string[]
  /** 本进程真正写进 Chromium 自定义词典的术语（关闭拼写检查时会从用户词典移除） */
  registeredTerms: string[]
}

/** 已附加右键监听的 webContents（避免同一窗口重复注册） */
const attached = new WeakSet<WebContents>()

/**
 * 本进程内的「忽略」表（小写）。只影响我们送给菜单的建议；
 * 不下发任何"忽略"给 Chromium —— 它没有这个 API。
 */
const ignoredWords = new Set<string>()

/**
 * 术语表记账（**避免污染用户词典**的关键）。
 *
 * Electron 只有 `addWordToSpellCheckerDictionary` / `removeWordFromSpellCheckerDictionary`，
 * 没有"临时词表"；加进去就会落到 `<userData>/Custom Dictionary.txt`（用户词典）。
 * 所以这里做两件事：
 *   ① 加之前先用 `listWordsInSpellCheckerDictionary()` 查重：用户本来就有的词
 *      **不碰**，也就不可能被我们误删；
 *   ② 只记"我们真的加进去的"（`ownDictionaryWords`），关闭拼写检查或退出应用时
 *      只撤销这一批（`removeWordFromSpellCheckerDictionary`）。
 * 兼容性降级：万一 `listWordsInSpellCheckerDictionary()` 不可用，我们仍会加词
 * （否则术语照旧被标红），但会按"自己加的"记账 —— 这点在日志里体现为
 * registered 数大于事先存在的数，不影响透明性。
 */
const ownDictionaryWords = new Map<string, string>()
/** 用户词典里原本就有、因而不归我们管的词（小写） */
const preexistingDictionaryWords = new Set<string>()
/** 注册任务的代次：关闭时 +1，作废在飞的注册（避免"关了又加回来"） */
let termsGeneration = 0
/** 已尝试同步过（避免每次保存设置都重复 list + add） */
let termsSynced = false
/** 在飞的注册任务（同一时刻只跑一个） */
let termsTask: Promise<void> | null = null
/** 退出清理期间**暂停注册**：否则 renderer 的 before-close `settings.flush()` 会在清理后又加回来（实测） */
let termsPausedForQuit = false
/** 退出被取消（关窗确认里点了取消）时，把注册恢复回来 */
let termsResumeTimer: ReturnType<typeof setTimeout> | null = null
/** 是否已挂 before-quit 清理（只挂一次） */
let quitCleanupInstalled = false

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
    available: availableLanguages(),
    terms: [...SPELLCHECK_TERMS],
    registeredTerms: [...ownDictionaryWords.values()]
  }
}

/**
 * 把内置术语表注册进 Chromium 的自定义词典（只加"用户词典里还没有的"）。
 * 失败/不可用时不抛：拼写检查是增强能力，术语注册失败不该拦住启动。
 */
async function registerBuiltinTerms(): Promise<void> {
  const gen = ++termsGeneration
  const ses = electronSession.defaultSession
  if (!ses.spellCheckerEnabled) return

  let existing: string[] = []
  try {
    existing = await ses.listWordsInSpellCheckerDictionary()
  } catch {
    // 该平台没有这个 API（或词典尚未加载）：退化为"全部按自己加的记账"
    existing = []
  }
  // 等待期间用户关了拼写检查 / 又触发了新一轮注册：这轮作废，别再往词典里写
  if (gen !== termsGeneration || !ses.spellCheckerEnabled) return

  const known = new Set(existing.map((word) => normalizeTerm(word)))
  let added = 0
  for (const term of SPELLCHECK_TERMS) {
    const key = normalizeTerm(term)
    if (!key || known.has(key)) {
      if (key) preexistingDictionaryWords.add(key)
      continue
    }
    try {
      if (ses.addWordToSpellCheckerDictionary(term)) {
        ownDictionaryWords.set(key, term)
        known.add(key)
        added += 1
      }
    } catch {
      /* 平台不支持自定义词典：跳过该词，继续加下一个 */
    }
  }
  termsSynced = true
  if (added > 0) {
    console.log(
      `[spell] terms added=${added} own=${ownDictionaryWords.size} preexisting=${preexistingDictionaryWords.size} total=${SPELLCHECK_TERMS.length}`
    )
  }
}

/**
 * 撤销**我们自己加过**的术语，用户原有的词一个不动。
 *
 * 调用时机只有两个：关闭拼写检查、应用退出。这样用户词典里不会长期留着
 * 一批"Lumin 塞进去的产品名"；下次开启时再按需注册。
 */
function unregisterBuiltinTerms(reason: 'disabled' | 'quit'): void {
  termsGeneration += 1
  termsSynced = false
  const ses = electronSession.defaultSession
  let removed = 0
  for (const [, word] of ownDictionaryWords) {
    try {
      if (ses.removeWordFromSpellCheckerDictionary(word)) removed += 1
    } catch {
      /* 平台不支持移除：保留（已在日志里如实说明），不影响本次关闭 */
    }
  }
  ownDictionaryWords.clear()
  if (removed > 0) console.log(`[spell] terms removed=${removed} reason=${reason}`)
}

/** 按开关同步术语：开启 → 注册（幂等）；关闭 → 撤销我们加的那批 */
function syncBuiltinTerms(enabled: boolean): void {
  if (!enabled) {
    unregisterBuiltinTerms('disabled')
    return
  }
  // 退出清理正在进行：renderer 的 settings.flush() 会在 before-close 里再发一次
  // `spellcheckEnabled:true`；此时绝不能再把词加回去（否则"退出后词典里没有我们的词"做
  // 不到，实测会重新加满 27 个）。
  if (termsPausedForQuit) return
  if (termsSynced || termsTask) return
  const task = registerBuiltinTerms()
  termsTask = task
  void task.finally(() => {
    if (termsTask === task) termsTask = null
  })
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

  // 术语表：开了就注册（幂等）；关了就把**我们自己加的那批**从用户词典撤掉
  syncBuiltinTerms(wantedEnabled)

  const state = getSpellcheckState()
  if (before.enabled !== state.enabled || languagesChanged) {
    console.log(
      `[spell] state enabled=${state.enabled} languages=${JSON.stringify(state.languages)} available=${state.available.length}`
    )
  }
  return state
}

/**
 * 退出前把术语从用户词典里撤掉。
 *
 * 为什么退出也要撤：Electron 没有"仅本会话生效"的自定义词典，`Custom Dictionary.txt`
 * 是持久化的；若不撤，用户词典里会一直留着 `Lumin` / `KaTeX` 这批产品名 ——
 * 用户在别处（其它应用/系统拼写设置）也会看到它们。
 *
 * ⚠️ 为什么不能"在 before-quit 里同步删完就放行"（实测）：`removeWordFromSpellCheckerDictionary`
 * 的落盘是异步的；主进程在 quit 阶段只来得及写回**一部分**（27 个词只删掉 13 个，
 * 文件里剩 14 个）。所以这里 `preventDefault()` 一次，删完后**轮询**
 * `listWordsInSpellCheckerDictionary()` 确认真的没了，再重新 `app.quit()`。
 * 代价是退出多等几十毫秒；换来的是"用户词典里不留我们的词"这条可验证的承诺。
 */
function ensureQuitCleanup(): void {
  if (quitCleanupInstalled) return
  quitCleanupInstalled = true
  let cleanupRunning = false
  app.on('before-quit', (event) => {
    if (cleanupRunning || ownDictionaryWords.size === 0) return
    event.preventDefault()
    cleanupRunning = true
    termsPausedForQuit = true
    if (termsResumeTimer) clearTimeout(termsResumeTimer)
    /**
     * 退出被取消时（关窗确认里点「取消」）把注册恢复回来；正常退出时进程在定时器
     * 到期前就结束了。5s 覆盖 before-quit → drain（最多 2.5s）→ quit 的正常路径。
     */
    termsResumeTimer = setTimeout(() => {
      termsResumeTimer = null
      termsPausedForQuit = false
      if (electronSession.defaultSession.spellCheckerEnabled) syncBuiltinTerms(true)
    }, 5000)
    const ses = electronSession.defaultSession
    const words = [...ownDictionaryWords.values()]
    unregisterBuiltinTerms('quit')
    const keys = new Set(words.map((word) => normalizeTerm(word)))
    const finish = (left: number): void => {
      if (left > 0)
        console.log(`[spell] terms leftover=${left} (dictionary API did not remove all)`)
      app.quit()
    }
    const poll = async (attempt: number): Promise<void> => {
      let left = 0
      try {
        const remaining = await ses.listWordsInSpellCheckerDictionary()
        left = remaining.filter((word) => keys.has(normalizeTerm(word))).length
      } catch {
        left = 0
      }
      if (left === 0 || attempt >= 20) {
        finish(left)
        return
      }
      setTimeout(() => void poll(attempt + 1), 50)
    }
    void poll(0)
  })
}

/**
 * 启动时调用一次（readSettings 已归一，缺键会回落默认值）。
 * 顺序要点：必须在窗口创建/加载之前 —— 页面首帧就可能带着正文，
 * 晚一步会让用户先看到一帧没有下划线的文档再"补上"，观感像闪了一下。
 *
 * 注：真正的调用点在首屏可交互之后（main/index.ts 的 runPostShowTasks），
 * 那时窗口已画出；术语注册会稍后几毫秒完成，验收以注册完成后的状态为准。
 */
export function initializeSpellcheck(): SpellcheckState {
  ensureQuitCleanup()
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
    if (ok) {
      // 用户主动加的词归用户：以后关闭拼写检查/退出时**不能**被我们顺手删掉。
      const key = normalizeTerm(trimmed)
      if (ownDictionaryWords.delete(key)) preexistingDictionaryWords.add(key)
    }
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
