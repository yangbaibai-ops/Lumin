// ─── 禁掉「拖动选中的文字去改位置」（用户报障）────────────────────────────────
//
// 用户口径：一段 `ABCDEF`，选中 `DE`，用鼠标把它拖到 `A` 与 `B` 之间 ——
// 改前文档会变成别的样子（PM 的默认 drop 行为：删掉选区 + 在落点插入 slice，
// 实测 `ABCDEF` → `DEABCF` 且 markdown 还多出一个空行），**这个手势要取消**。
//
// 口径（写死在这里，套件按它断言）：
//   * 文档**逐字不变**（一个字符都不许动）；
//   * 拖动前的选区**原样保留**（`DE` 仍然选中）—— 不能出现"选区被清掉 / 光标跑丢"；
//   * 只拦"文档内部、非节点的选区拖动"。**保留**的拖动语义：
//       - 从系统拖入文件 / 文件夹（`moved === false`，走 App.vue 的窗口级落点）；
//       - 编辑器里拖入图片/文件（`lib/editor/imagePaste.ts` 的 handleDrop，先于本扩展认领）；
//       - 拖动**节点**（图片、表格等 NodeView 的 `draggable`）：`view.dragging.node` 非空
//         ⇒ 那是"搬一个节点"，不是"搬一段文字"，一律放行（本次不动它们的语义）；
//         **例外（第九轮）**：节点是 `mathBlock` 时**要拦** —— PM 会给"选中后的叶子节点"
//         补 `draggable=true`，于是公式也被当成节点拖动搬走了（实测会真的换位置）；
//         判据见 `dragRules.blocksMathDrag`，只认 `mathBlock`，图片/表格一动不动；
//       - Ctrl/Cmd + 拖动 = **复制**（PM 的 `dragMoves` 在这一刻给出 `moved === false`）：
//         用户报的是"移动位置"，复制是另一件事，按 PM 原语义放行（要一起禁是另一轮口径）。
//   * 代码块**内部**（CodeMirror 自己处理 drop，不经过 PM 的 handleDrop）不在本次范围内，
//     见 tools/_verify-no-text-drag.js 末尾的如实边界。
//
// 为什么用 `handleDrop` 而不是"把编辑器设成不可拖 / 动 NodeView 的 draggable"：
//   * `handleDrop(view, event, slice, moved)` 是 ProseMirror 官方钩子，`moved === true`
//     正是"这次落下会把内容**搬走**"的唯一权威判据（PM 自己也是靠它决定 move 还是 copy）；
//   * 关掉 `draggable` 会连"把图片/文件拖进来"和"把节点拖出去"一起废掉，属于粗暴开关。
//
// ⚠️ 这里**不能**用 `event.defaultPrevented` 之外的花样去判"是不是内部拖动"：
//   `moved` 由 PM 在 `editHandlers.drop` 里算好传进来（`!!(view.dragging && dragMoves(view, event))`），
//   而 `view.dragging` 只在 PM 自己的 dragstart 里被赋值 —— 也就是说
//   "拖动源在本文档内"这件事只有这一个可靠信号。外部拖入（系统文件、别的程序里的文字）
//   没有 `view.dragging` ⇒ `moved === false` ⇒ 一律放行。
import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { blocksInternalTextDrag, blocksMathDrag } from './dragRules'

/**
 * `view.dragging.node`：prosemirror-view 的运行时对象里有这个字段（它的内部 `Dragging` 类
 * `new Dragging(slice, move, node)`），但**公开的 d.ts 里只声明了 `{slice, move}`**。
 * 所以这里收窄成一个只读探针，并写明"上游若删掉该字段，节点拖动会被一并禁掉"这唯一的后果。
 */
function draggedNode(view: EditorView): unknown {
  const dragging = view.dragging as null | { node?: unknown }
  return dragging ? dragging.node : null
}

/**
 * 这次拖动搬的是不是**数学节点**（第九轮新增的判据，见 `dragRules.blocksMathDrag`）。
 *
 * 两条来源，缺一不可：
 *   1. `view.dragging.node`（NodeSelection）的节点类型 —— "选中后再拖"走的就是它，
 *      实测 `node.node.type.name === 'mathBlock'`。
 *   2. **兜底看 `slice`**：PM 的 `dragstart` 里有一个空分支（选区正好覆盖落点时
 *      `node` 保持 undefined），那种情况下拖动仍然会搬走 slice 里的内容 ——
 *      只要被拖的整块内容**就是一条 mathBlock**，同样按数学节点处理。
 * 只认 `mathBlock`：图片/表格的 `node.type.name` 是别的名字 ⇒ 这条判据为假，
 * 它们的节点拖动语义一个字都没动（由 `blocksInternalTextDrag` 那半条继续放行）。
 */
function draggedMath(view: EditorView): boolean {
  const dragging = view.dragging as null | {
    node?: { node?: { type?: { name?: string } } } | null
    slice?: Slice
  }
  const name = dragging?.node?.node?.type?.name
  if (name) return name === 'mathBlock'
  const first = dragging?.slice?.content.firstChild
  return !!first && first.type.name === 'mathBlock'
}

export const NoTextDrag = Extension.create({
  name: 'luminNoTextDrag',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          /**
           * 拦下"把选中的文字搬走"，以及"把数学节点搬走"（第九轮）。
           * 返回 true = 这次 drop 我处理了，PM 不会再动文档
           * （PM 会自己 `preventDefault()`，见 prosemirror-view 的 `handleDrop`）。
           */
          handleDrop(view: EditorView, event: DragEvent, _slice: Slice, moved: boolean) {
            const nodeDrag = !!draggedNode(view)
            // 两条判据正交：文字拖动（含选中后拖 mathBlock 那种"空分支"）与**数学节点**拖动
            // 要拦；图片/表格的节点拖动（nodeDrag=true、mathDrag=false）继续放行。
            if (
              !blocksInternalTextDrag(moved, nodeDrag) &&
              !blocksMathDrag(moved, draggedMath(view))
            ) {
              return false
            }
            const keep = view.state.selection
            event.preventDefault()
            /**
             * 浏览器在这次拖动里已经把 DOM 选区挪到落点了（默认行为被拦下，但选区已经被改）。
             * 用户口径是"一个字都不能变，也不许把选区弄丢" ⇒ 下一帧检查一次、真的变了就还原。
             *
             * 为什么放在微/宏任务里而不是当场 `dispatch`：`handleDrop` 还在 PM 的事件栈里，
             * 当场改选区会被紧随其后的默认处理覆盖掉（实测：当场设回去仍然是折叠的光标）。
             */
            setTimeout(() => {
              try {
                const cur = view.state.selection
                if (cur.from === keep.from && cur.to === keep.to) return
                const next = TextSelection.create(view.state.doc, keep.from, keep.to)
                view.dispatch(view.state.tr.setSelection(next))
              } catch {
                /* 视图已销毁 / 位置已失效：拖动本身已经被拦下（文档没变），这里不值得报错 */
              }
            }, 0)
            return true
          }
        }
      })
    ]
  }
})
