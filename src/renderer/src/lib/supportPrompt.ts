// ─── 一次性「感谢 / 支持」提示（渲染层调度器）──────────────────────────────────
//
// 分工：判定是纯函数（shared/supportPrompt.ts），原生框在主进程（dialog:support），
// 这里只负责**什么时候问**以及**问完之后记账**：
//   * 首屏可交互之后延迟 `SUPPORT_PROMPT_DELAY_MS`（~1.5s）再问，绝不占启动路径；
//   * 窗口不可见 / 不在前台 → 等（不后台弹、不抢焦点）；
//   * 用户正在输入（最近有键入 / 输入法组合中）→ 等空闲（不打断打字）；
//   * 用户关掉（任一按钮，含 Esc / 关窗）→ 写 `supportPromptShown=true` 并**立刻落库**；
//   * 帮助菜单的手动入口：永远可弹，**不读写** `supportPromptShown`。
//
// 为什么记账要等主进程回结果、而不是"调用前先写 true"：窗口不可见时主进程会回
// `deferred`（这次没弹）。提前写 flag 会让"下次可见时再弹"永远不发生 —— 那等于丢功能。
import {
  decideSupportPrompt,
  SUPPORT_PROMPT_DELAY_MS,
  SUPPORT_PROMPT_IDLE_MS,
  type SupportPromptResult
} from '../../../shared/supportPrompt'
import type { useSettingsStore } from '../stores/settings'

type SettingsStore = ReturnType<typeof useSettingsStore>

/** 等待条件满足时的轮询间隔：只在"该弹但还不能弹"的窗口里跑，开销可忽略 */
const RETRY_MS = 1000

let typingTrackerInstalled = false
/** 最近一次键入（含输入法组合）的时刻：判「正在输入」只用它，不看焦点在不在编辑器 */
let lastTypingAt = 0
let composing = false

let autoArmed = false
let autoTimer: ReturnType<typeof setTimeout> | null = null
let manualInFlight = false

function installTypingTracker(): void {
  if (typingTrackerInstalled || typeof window === 'undefined') return
  typingTrackerInstalled = true
  window.addEventListener(
    'keydown',
    () => {
      lastTypingAt = Date.now()
    },
    true
  )
  window.addEventListener(
    'compositionstart',
    () => {
      composing = true
      lastTypingAt = Date.now()
    },
    true
  )
  window.addEventListener(
    'compositionend',
    () => {
      composing = false
      lastTypingAt = Date.now()
    },
    true
  )
}

/** 窗口可见且在前台才算「可以弹」：切到别的应用 / 最小化时都不打断用户 */
function visibleNow(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus()
}

function typingNow(): boolean {
  return composing || Date.now() - lastTypingAt < SUPPORT_PROMPT_IDLE_MS
}

function clearAutoTimer(): void {
  if (autoTimer) {
    clearTimeout(autoTimer)
    autoTimer = null
  }
}

/**
 * 自动提示的调度起点：在**首屏可交互之后**调用（main.ts 的 bootstrap 末尾）。
 * 幂等；`supportPromptShown` 已经是 true 时直接不排程。
 */
export function armSupportPrompt(settings: SettingsStore): void {
  installTypingTracker()
  if (autoArmed) return
  autoArmed = true
  if (settings.supportPromptShown) return
  const attempt = (): void => {
    autoTimer = null
    // 用户可能在等待期间已经手动看过并关掉（或别处已写 flag）—— 以持久化值为准
    if (settings.supportPromptShown) return
    const decision = decideSupportPrompt({
      manual: false,
      shown: settings.supportPromptShown,
      visible: visibleNow(),
      typing: typingNow()
    })
    if (decision === 'never') return
    if (decision !== 'show') {
      autoTimer = setTimeout(attempt, RETRY_MS)
      return
    }
    void runSupportPrompt(settings, false, attempt)
  }
  autoTimer = setTimeout(attempt, SUPPORT_PROMPT_DELAY_MS)
}

/**
 * 帮助菜单入口：立刻弹出同一个原生框。
 * 与自动入口的唯一区别是 `manual=true` —— 不受「已弹过」与「正在输入」限制，
 * 也永远不写 `supportPromptShown`（用户口径：手动查看不改变自动弹的状态）。
 */
export async function showSupportPromptManually(settings: SettingsStore): Promise<void> {
  installTypingTracker()
  if (manualInFlight) return
  manualInFlight = true
  try {
    await runSupportPrompt(settings, true, null)
  } finally {
    manualInFlight = false
  }
}

async function runSupportPrompt(
  settings: SettingsStore,
  manual: boolean,
  retry: (() => void) | null
): Promise<void> {
  let result: SupportPromptResult
  try {
    result = await window.luminAPI.dialog.supportPrompt({ manual })
  } catch {
    // IPC 失败（窗口正在销毁等）：不记账，自动入口下次条件满足时再试
    if (!manual && retry) autoTimer = setTimeout(retry, RETRY_MS)
    return
  }
  if (result.status === 'deferred') {
    if (!manual && retry) autoTimer = setTimeout(retry, RETRY_MS)
    return
  }
  // `skipped` = 本次运行已经由别的窗口自动弹过：不写 flag、不再重试
  if (result.status === 'skipped') return
  /**
   * 只有**自动入口真的弹出并关闭**才写 flag。
   * `result.manual` 是主进程实际处理的那个请求的标记：自动调用若与正在打开的手动框
   * 合并（onceNativeDialog），它拿到的 `manual=true`，这里就不会误写 flag。
   */
  if (!manual && !result.manual) {
    clearAutoTimer()
    settings.set('supportPromptShown', true)
    // 立刻落库（不是 250ms 节流）：用户关掉提示后可能随手就退出应用
    await settings.flush()
  }
}
