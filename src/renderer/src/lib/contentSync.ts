// ─── 编辑面 ⇄ 真源的单向数据流协议（Wave 3.2）────────────────────────────────
//
// 为什么要有这个文件：应用里有**三个能改正文的编辑面** ——
//   wysiwyg   Tiptap 所见即所得面板
//   source    源码 textarea（分屏右栏 / 全屏源码模式，同一个常驻元素）
//   codeblock 代码块里嵌的 CodeMirror（写回 Tiptap 节点 → 再序列化成 md）
// 加上「外部整篇替换」（打开文件 / 恢复草稿 / 重新解释编码 / 载入历史，统称 external），
// 一共四条能改 `files.current.content` 的路径。
//
// 收敛之前的写法是**每个编辑面各自发明一套「这次变化要不要应用」的判断**：
//   * Tiptap：比字符串（`syncedMd === content`）+ 世代号（`files.syncEpoch`）；
//   * 源码 textarea：`:value` 绑定 + 一个 200ms 的 setContent 定时器（第二条通道）；
//   * 代码块 CodeMirror：150ms 防抖 + 「节点文本快照相等就跳过」；
//   * 还有一处 `syncEditorContent()` 在切模式时自己再比一次字符串。
// 四套判断合起来出过一串「看着像玄学」的 bug：快速回车丢字、切回原编码后正文不刷新、
// 分屏里停顿后的更新被静默窗吞掉。根因不是某个判断写错了，而是**没有唯一的写入者身份**：
// 每个面都在猜「这次变化是不是我自己弄出来的」。
//
// 本协议只做一件事：给真源内容配一个**世代号 + 作者**。
//   * 谁改内容谁自增 `rev`（`write()`），并把自己的 id 记为 `author`；
//   * 需要**命令式回灌**的编辑面记下「我渲染到哪一代」（`applied`）；
//   * 该编辑面需要重渲染 ⇔ **它的 applied 落后于 rev**（`shouldApply()`），
//     渲染完 `markApplied()`。**不再比字符串、不再看时间窗。**
// 自己是作者的那次写入天然不会回灌给自己（`write()` 顺手把 author 的 applied 推到最新，
// 并把它嵌在里面的宿主编辑面一起推上去），所以回声回路在结构上不存在，
// 而不是靠启发式躲开。
//
// 为什么 `applied` 里没有 `source`：源码 textarea 的回灌是**声明式**的
// （模板上 `:value="files.current?.content"`，内核永远单向 store → DOM）。
// 而声明式回灌本身是收敛的：DOM 值已经等于新值时不写、光标不动
// （HTML 规范里 value setter 只在 API 值变化时才把光标挪到末尾），
// 所以「作者自己写入」这条路径不需要、也不该由代码再判断一次。
// 只有渲染动作是命令式代码（`setContent` / `setState`）的两个面才需要 `applied`。
//
// 纯函数 + 显式状态：不 import Vue/Pinia，`node --test` 直接跑（tests/contentSync.test.mjs）。

/** 需要命令式回灌的编辑面（渲染动作 = 调内核 API） */
export type DrivenSurface = 'wysiwyg' | 'codeblock'

/** 内容作者：两个命令式编辑面 + 声明式的源码 textarea + 外部整篇替换 */
export type Author = DrivenSurface | 'source' | 'external'

export interface SyncLedger {
  /** 真源内容的世代号：每一次内容变化 +1，只增不减 */
  rev: number
  /** 最近一次变化的作者 */
  author: Author
  /** 各命令式编辑面「已经渲染到」的世代 */
  applied: Record<DrivenSurface, number>
}

export const DRIVEN_SURFACES: readonly DrivenSurface[] = ['wysiwyg', 'codeblock']

/**
 * 嵌套关系：`codeblock` 是 `wysiwyg` 文档里的子编辑面。
 * 代码块里的 CodeMirror 改内容时，它先把文本写回 Tiptap 节点，再序列化成 md ——
 * 也就是说这一次写入之后 **Tiptap 文档本身就是最新的**，不该再把 md 灌回去
 * （灌回去会把光标从代码块里踢出来，正是「快速回车丢字」那类 bug 的形态）。
 */
const NESTED_IN: Record<DrivenSurface, DrivenSurface[]> = {
  wysiwyg: [],
  codeblock: ['wysiwyg']
}

export function createLedger(): SyncLedger {
  return { rev: 0, author: 'external', applied: { wysiwyg: 0, codeblock: 0 } }
}

/**
 * 真源内容被写入：世代 +1，记录作者。
 * 作者是需要回灌的编辑面时，顺手把它自己**以及它嵌套在里面的宿主编辑面**的
 * applied 推到新世代 —— 它们就是这次变化的发生地，不需要也不允许被回灌。
 * `external` 不动任何 applied：所有编辑面都落后，都要按新内容重渲染一次。
 * @returns 新的世代号
 */
export function write(ledger: SyncLedger, author: Author): number {
  ledger.rev += 1
  ledger.author = author
  if (author !== 'external' && author !== 'source') {
    ledger.applied[author] = ledger.rev
    for (const host of NESTED_IN[author]) ledger.applied[host] = ledger.rev
  }
  return ledger.rev
}

/** 该编辑面渲染完了当前世代的内容 */
export function markApplied(ledger: SyncLedger, surface: DrivenSurface): void {
  ledger.applied[surface] = ledger.rev
}

/** 该编辑面是否落后于真源（落后 ⇒ 必须用 store 的内容重渲染一次） */
export function shouldApply(ledger: SyncLedger, surface: DrivenSurface): boolean {
  return ledger.applied[surface] !== ledger.rev
}

/** 最近一次写入是不是这个编辑面干的（诊断/断言展示用；判断请用 shouldApply） */
export function isOwnWrite(ledger: SyncLedger, surface: Author): boolean {
  return ledger.author === surface
}

/** 落后于真源的编辑面（诊断用：内容已收敛时为空） */
export function staleSurfaces(ledger: SyncLedger): DrivenSurface[] {
  return DRIVEN_SURFACES.filter((s) => shouldApply(ledger, s))
}
