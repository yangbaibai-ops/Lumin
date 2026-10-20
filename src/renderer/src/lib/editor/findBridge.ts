// ─── 查找命中高亮 ⇄ 编辑器内核的**零依赖桥** ────────────────────────────────────
//
// 为什么单独一个模块（第二十五轮，轻量化）：`stores/find.ts` 只需要「让编辑器把命中范围
// 高亮一下」，原来它直接 `import { setFindHit } from './inlineMarks'` —— 而那个模块
// **静态** import 了 `@tiptap/core` 与 `@tiptap/pm/{state,model,view}`。
// `prosemirror-state` 的 deps 又链到 model + transform + **view**，于是「import 一个函数」
// 就把整份 ProseMirror（构建产物实测 ~412KB）钉进**首屏 entry chunk**。
// 而 `stores/find.ts` 挂在 `App.vue → useAppActions → stores/find` 这条**静态**依赖链上，
// 结果：连一份文档都没打开（欢迎页）时也要解析执行这 412KB。
//
// 桥的做法与 `ownView` 同一思路：**编辑器在 `onCreate` 时把实现注册进来**，
// 注册之前调用是 no-op（那时本来也没有编辑器可高亮）。依赖方向因此是
// 「编辑器内核 → 桥 ← store」，store 一侧不再认识 ProseMirror。
//
// 判据（改完必须复验）：构建产物 `out/renderer/assets/index-*.js` 里不再出现 ProseMirror
// 的特征串（如 `class Transform`）；`_verify-find-replace.js` / `_verify-round-24.js`
// 的查找高亮断言仍全绿。
//
// ── 契约（第二十六轮扩展）────────────────────────────────────────────────────
// 原来只能高亮**一处**（当前命中）。用户口径：命中的字符要**底色**、当前命中要**另一种颜色**
// —— 所以现在整批命中一起传过去，由内核层给「全部命中」画一层底色、给「当前命中」多一个类。
// 参数保持**纯数据**（`{from,to}[]` + 下标），不带任何 ProseMirror 类型，桥依然是零依赖。

/** 一处命中（文档位置） */
export interface FindHitRange {
  from: number
  to: number
}

/** 高亮实现：`hits = null` 表示清空；`current` 是当前命中在 `hits` 里的下标（-1 = 无） */
export type FindHitApplier = (hits: FindHitRange[] | null, current: number) => void

let apply: FindHitApplier | null = null

/** 由编辑器内核注册（`onCreate` 注册、`destroy` 注销） */
export function registerFindHit(fn: FindHitApplier | null): void {
  apply = fn
}

/** 请求高亮（无编辑器时静默忽略：还没得高亮） */
export function setFindHit(hits: FindHitRange[] | null, current: number): void {
  try {
    apply?.(hits, current)
  } catch {
    /* 视图正在重建时忽略：下一次跳转会补上 */
  }
}
