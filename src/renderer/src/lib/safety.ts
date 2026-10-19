/**
 * ─── 「自救入口」共用的通知 kind（渲染层）──────────────────────────────────────
 *
 * 通知卡片会持久化到 SQLite，点击时按 `payload.kind` 找处理器（lib/notificationActions）。
 * kind 是跨模块契约：粘贴护栏/安全模式发出通知的地方与注册处理器的地方必须用同一份
 * 字面量，所以集中在这里，绝不各写各的字符串。
 */

/** 粘贴护栏提示上的「改用纯文本粘贴」按钮 */
export const PASTE_PLAIN_KIND = 'paste-plain-notice'

/** 连续两次崩溃/无响应后，下次默认源码模式的提示（按钮：仍然以富文本打开） */
export const DOC_SAFE_MODE_KIND = 'doc-safe-mode'
