// ─── 中文拼写检查开关 ⇄ 编辑器内核的**零依赖桥** ─────────────────────────────
//
// 与 `markerVisibility.ts` 同一取舍：这个开关由设置 store 推给内核，而
// `stores/settings.ts` 挂在首屏静态依赖链上。如果 store 直接 import 检查插件，
// 插件静态 import 的 `@tiptap/pm/*` 就会被钉进首屏 entry chunk。所以依赖方向是
// 「编辑器内核 → 本桥 ← 设置 store」，store 一侧不认识 ProseMirror。
//
// 判定只有一条（与 shared/spellcheck.ts 的 isChineseSpellcheckEnabled 同源）：
//   拼写检查总开关打开 **且** 语言里包含中文（zh / zh-CN…）。
// 内核每次重算前读一次；设置变化时通知内核立刻重算（不用重开文档）。

let enabled = false

/** 内核注册的「开关变了 ⇒ 重算中文装饰」回调 */
let listener: (() => void) | null = null

/** 由设置层调用（`stores/settings.ts` 的 applyAll，覆盖启动/改动/导入/重置五条路径） */
export function setZhSpellcheckEnabled(value: boolean): void {
  const next = value === true
  if (next === enabled) return
  enabled = next
  try {
    listener?.()
  } catch {
    /* 视图正在重建时忽略：下一次文档变更/开关变化会自然带上新值 */
  }
}

/** 内核读它决定要不要建中文装饰 */
export function zhSpellcheckEnabled(): boolean {
  return enabled
}

/** 内核注册/注销变化通知（`null` = 注销） */
export function onZhSpellcheckEnabledChange(fn: (() => void) | null): void {
  listener = fn
}
