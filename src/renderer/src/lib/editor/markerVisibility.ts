// ─── 「是否显示行内标记字符」⇄ 编辑器内核的**零依赖桥** ───────────────────────────
//
// 用户口径（第二十八轮，原话）：「设置内容是是否显示例如加粗 `**` 这样的字符，默认开启
// （按钮显示关闭），用户开启后不展示这样类似的字符。」
//
// 措辞判断（为什么落成「隐藏」开关 + 默认关闭）：
//   * 用户描述**结果**的那半句是无歧义的 ——「用户开启后不展示这样类似的字符」，即开关打开 ⇒
//     不再显示 `**`；而「默认开启（按钮显示关闭）」只能理解成「**默认仍然显示这些字符**
//     （= 现状一个字都不变）」，因为那句话自己就说了按钮显示为关闭。把「默认开启」读成
//     「默认就隐藏」会与同一句里的「按钮显示关闭」以及产品现状（光标进构造才显形）直接冲突，
//     还会让所有老用户升级后突然看不到标记。
//   * 所以设置项的**名字**取「隐藏行内标记字符」（`hideInlineMarkers`，boolean，默认 `false`
//     = 不隐藏），语义与实现都只有一条：**打开 ⇒ 所见即所得里任何情况下都不再显形成对标记**。
//   * 默认 `false` 还意味着老 profile 里缺这个键时走默认值 ⇒ 升级后行为与升级前完全一致
//     （见 `shared/settingsSchema.ts`：只"新增带默认值的键"不需要动 schema 版本）。
//
// 为什么单独一个模块（与 `findBridge.ts` 同一取舍）：这个开关由**设置 store** 推给内核，
// 而 `stores/settings.ts` 挂在首屏静态依赖链上（`App.vue → useAppActions → stores/settings`）。
// 如果它直接 `import { … } from './inlineMarks'`，那个模块静态 import 了
// `@tiptap/core` 与 `@tiptap/pm/*`，整份 ProseMirror（构建产物实测 ~412KB）就会被钉进首屏
// entry chunk —— 这正是 `findBridge.ts` 当初存在的理由。依赖方向因此是
// 「编辑器内核 → 本桥 ← 设置 store」，store 一侧不认识 ProseMirror。
//
// 「改设置立刻生效」怎么做到（不用重开文档）：
//   * 真值放在本模块（零依赖），内核**每次算显隐装饰前**读一次（`inlineMarkersHidden()`）——
//     所以启动顺序（设置先加载 / 编辑器先建）两边都成立，不存在两份状态打架；
//   * 设置变化时 `setInlineMarkersHidden()` 通知内核注册的回调，内核 dispatch 一个带元数据的
//     空事务让显隐装饰**立刻重算**（与「按住/松开」「查找命中」那两条触发条件同一套机制）。

/** 当前是否隐藏行内标记字符（真值；默认 false = 照常按光标显形） */
let hidden = false

/** 内核注册的「设置变了 ⇒ 重算显隐装饰」回调（onCreate 注册、destroy 注销） */
let listener: (() => void) | null = null

/**
 * 由设置层调用（`stores/settings.ts` 的 `applyAll`，覆盖启动/本地改/主进程改/导入/重置五条路径）。
 * 值没变时直接返回 —— `applyAll` 会因为**任何**设置项的改动被调用，这里不能每次都惊动内核。
 */
export function setInlineMarkersHidden(value: boolean): void {
  const next = value === true
  if (next === hidden) return
  hidden = next
  try {
    listener?.()
  } catch {
    /* 视图正在重建时忽略：下一次显隐装饰重算（选区变化/文档变更）自然带上新值 */
  }
}

/** 内核读它决定「成对标记要不要按光标显形」（true ⇒ 永不显形） */
export function inlineMarkersHidden(): boolean {
  return hidden
}

/** 内核注册/注销变化通知（`null` = 注销） */
export function onInlineMarkersHiddenChange(fn: (() => void) | null): void {
  listener = fn
}
