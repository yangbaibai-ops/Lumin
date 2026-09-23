// ─── Typora 式键盘语义 ───────────────────────────────────────────────────────
// 1) 分割线：'---' / '***' 独立成行后按 Enter 才转换（Typora 同款）。
//    即时转换（输入规则）被禁用，因此 "---你好" 这类文本可以正常输入；
// 2) 标题降级：光标位于标题第一个字前按 Backspace → 取消标题格式
//    （整行降级为段落，内容保留），而不是并入上一行 / 影响上一行层级。
// 3) 行内语法标记内回车：光标落在 `**`/`*` 等标记字符中间（如 `**s*|*`）
//    时，先把光标移到整个样式构造之后再切段——避免把标记文本切成两半
//    （派生归一化会把截断误判为「删星改样式」，甚至抛出异常）。
//
// 优先级说明：本扩展 priority 200，高于 Tiptap core keymap（默认 100），
// 保证 Enter/Backspace 的拦截先于 splitBlock / joinBackward 执行；
// 条件不匹配时 handler 返回 false，交还后续 keymap 处理。
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { canJoin } from '@tiptap/pm/transform'
import { findCodeBlockHandle } from './codeBlockViews'

/** 段间 join（Backspace/Delete 用）：把光标前后的两个同型段落合并。
    dir 'backward'：光标在段首/段间边界 → 并入上一段；
    dir 'forward' ：光标在段尾/段间边界 → 并入下一段。
    覆盖两类光标位置：① 落在文本块内部首/尾字符处；② 落在块间边界
    （depth 0，Enter 与归一化常把光标留在此）。成功后事务的选区映射会把
    光标停在拼接处。 */
function joinTextblockAtBoundary(editor: Editor, dir: 'backward' | 'forward'): boolean {
  const { state } = editor
  const doc = state.doc
  const sel = state.selection
  if (!sel.empty) return false
  const $from = sel.$from
  const caretPos = sel.from

  // 确定“边界位置”：backward 取当前/下一块起点；forward 取当前块终点
  let boundary = -1
  if ($from.parent.type.name === 'paragraph') {
    if (dir === 'backward' && $from.parentOffset === 0) boundary = $from.before()
    if (dir === 'forward' && $from.parentOffset === $from.parent.content.size)
      boundary = $from.after()
  }
  if (boundary < 0 && $from.depth === 0 && caretPos > 0 && caretPos < doc.content.size) {
    // 块间边界光标：可能正好在某块起点或终点
    boundary = caretPos
  }
  if (boundary <= 0 || boundary >= doc.content.size) return false

  const before = doc.childBefore(boundary).node
  const after = doc.childAfter(boundary).node
  if (!before || !after) return false
  if (before.type.name !== 'paragraph' || after.type.name !== 'paragraph') return false
  if (!canJoin(doc, boundary)) return false
  const tr = state.tr
  tr.join(boundary)
  // 光标停在两段拼接缝：合并后文本块从 (boundary - before.nodeSize) 开始，
  // 其内容 = before.content + after.content，缝 = 起点 + 1 + before.content.size
  const mergedStart = boundary - before.nodeSize
  const seam = mergedStart + 1 + before.content.size
  const merged = tr.doc.nodeAt(mergedStart)
  const max = mergedStart + 1 + (merged ? merged.content.size : 0)
  try {
    tr.setSelection(TextSelection.create(tr.doc, Math.min(Math.max(seam, mergedStart + 1), max)))
  } catch {
    /* 保持事务映射结果 */
  }
  editor.view.dispatch(tr)
  return true
}

/** 代码块后段首退格 → 光标进入代码块内容末尾。
    场景：光标位于「紧邻代码块之后的段落」行首——可能是按 Enter 退出代码块
    后留下的空占位段，也可能是有正文的段。PM 默认的 joinBackward 会把整个
    后续段落并入代码块（正文变代码，S2 复现的「吞文」）；这里改为不合并文本，
    而是把光标移到代码块内容末尾并聚焦其 CodeMirror：空占位段顺手删除，
    有正文的段保留、光标仍进入代码块（Typora 语义：代码块是编辑岛，行首
    退格 = 回到代码块内继续输入）。
    另覆盖一个点击残留态：先在代码块内点过（PM 选区停在代码块内容末尾），
    随后点击代码块下方预留空行——DOM 光标已进空段，但 PM 选区仍滞留在代码
    块文本末尾，行首退格判定不生效，退格无反应（本编辑器代码块文本由 CM
    独占，PM 也无法直接删除）；此时同样视为「回到代码块末尾继续输入」。 */
function backspaceIntoCodeBlock(editor: Editor): boolean {
  const { state } = editor
  const { $from, empty, from } = state.selection
  if (!empty) return false
  const doc = state.doc

  // 残留态：PM 光标停在代码块内容末尾、且其后紧跟空段落（代码块后的预留空行）
  if ($from.parent.type.name === 'codeBlock') {
    const code = $from.parent
    // 必须位于代码块文本末尾（而不是中间/开头——那些不是点击空行后的残留）
    if ($from.parentOffset !== code.content.size) return false
    // 空代码块的退格删除由 CM / CodeBlockCM 处理，这里不接管
    if (code.content.size === 0) return false
    if ($from.depth !== 1) return false
    if ((code.attrs.language || '') === 'mermaid') return false
    const codeStart = $from.before()
    if (codeStart < 0) return false
    const after = codeStart + code.nodeSize
    const next = doc.childAfter(after)
    // 仅当紧随其后的顶层节点是空段落（预留空行）才接管；有正文的段说明光标
    // 本就不该回代码块，放行走默认逻辑
    if (!next.node || next.node.type.name !== 'paragraph' || next.node.content.size !== 0) {
      return false
    }
    // 光标已处于代码块内容末尾：无需移动选区，把焦点与 DOM 光标移交 CM 即可
    // （与「空段行首退格」路径的终态一致：焦点在 CM、后续输入进代码）
    //
    // ⚠️ **找不到句柄时必须 return false（交回 PM），不能吞掉按键**（F 项 P0 / 风险 R1）：
    // 代码块虚拟化之后「屏幕外的块没有 CM、也就没有句柄」会成为常态，若这里仍 `return true`，
    // 用户会遇到「按退格没反应」——按键被吃掉而什么都没发生。
    const handle = findCodeBlockHandle(codeStart)
    if (!handle) return false
    handle.focusCmAtEnd()
    return true
  }
  let codePos = -1
  let codeSize = 0
  let codeLang = ''
  let followPos = -1
  let followSize = 0

  if ($from.depth > 0) {
    // 光标在段落行首：该段落必须是文档顶层（depth 1）、且紧邻代码块之后
    // （prev sibling = codeBlock）。嵌套于列表/引用里的段落不能用
    // doc.childBefore 判断，直接放行走默认逻辑
    if ($from.depth !== 1) return false
    if ($from.parent.type.name !== 'paragraph' || $from.parentOffset !== 0) return false
    const start = $from.before()
    if (start <= 0) return false
    const prev = doc.childBefore(start)
    if (!prev.node || prev.node.type.name !== 'codeBlock') return false
    codePos = prev.offset
    codeSize = prev.node.nodeSize
    codeLang = prev.node.attrs.language || ''
    followPos = start
    if ($from.parent.content.size === 0) followSize = $from.parent.nodeSize
  } else {
    // 光标落在块间边界 / 文档末尾（depth 0，Enter 与归一化常把光标留在此）：
    // 位置必须恰好是代码块终点（其后是段落起点，或文档在此结束）
    if (from < 0 || from > doc.content.size) return false
    const prev = doc.childBefore(from)
    if (!prev.node || prev.node.type.name !== 'codeBlock') return false
    if (prev.offset + prev.node.nodeSize !== from) return false
    codePos = prev.offset
    codeSize = prev.node.nodeSize
    codeLang = prev.node.attrs.language || ''
    const next = doc.childAfter(from)
    if (next.node) {
      // 仅当紧随其后的是顶层段落才接管；标题/列表等放行走默认逻辑
      if (next.node.type.name !== 'paragraph') return false
      followPos = from
      if (next.node.content.size === 0) followSize = next.node.nodeSize
    }
    // next.node 为空 = 光标在文档末尾代码块之后，直接进入代码块末尾
  }
  if (codePos < 0 || codeLang === 'mermaid') return false

  const tr = state.tr
  if (followSize > 0 && followPos >= 0) {
    // 删除紧随代码块的空占位段落（行首退格 = 收回按 Enter 退出的空行）。
    // 注意不能用 nodeAt(followPos)——节点起点边界解析到的是父容器而非段落本身，
    // 因此直接用捕获到的段落 nodeSize 计算删除区间
    tr.delete(followPos, followPos + followSize)
  }
  // 代码块内容末尾 = 节点起点 + nodeSize − 1（nodeSize 含首尾边界，内容
  // 实际占 [pos+1, pos+size−1)，末尾光标 = pos+size−1）
  const contentEnd = codePos + codeSize - 1
  const selPos = Math.min(Math.max(0, contentEnd), tr.doc.content.size)
  try {
    tr.setSelection(TextSelection.create(tr.doc, selPos))
  } catch {
    return false
  }
  editor.view.dispatch(tr)

  // 把焦点移交给该代码块的 CodeMirror（光标落在内容末尾）；找不到实例
  // （mermaid 预览等无 CM 场景）则退回 PM 光标停留在代码块末尾
  const handle = findCodeBlockHandle(codePos)
  if (!handle || !handle.focusCmAtEnd()) editor.commands.focus()
  return true
}

export const TyporaKeymap = Extension.create({
  name: 'typoraKeymap',
  priority: 200,

  addKeyboardShortcuts() {
    const schema = this.editor.schema
    const hrType = schema.nodes.horizontalRule
    const pType = schema.nodes.paragraph

    return {
      Enter: ({ editor }) => {
        // ★ 表格单元格里回车 = **跳到下一格**（最后一格时补一行），与 Tab 完全同语义。
        //
        // 为什么不是「切段落」：GFM 管道表的单元格里没有「多段」这个写法，切出新段落后
        // 表格序列化器会把整张表判成「复杂表格」⇒ **退化成 HTML**，落盘后 markdown-it 只当
        // HTML 块解析 —— **表格结构损坏**（用户报障的正是这条路径，见 tableMarkdown.ts 的长注释）。
        //
        // 为什么也不是「插入硬换行 `<br>`」（试过，退回来了）：本编辑器的标记符是**真实文本**
        // （§4.13 的模型），光标停在「**实测痛点**」这种已被样式包住的文字末尾时，硬换行会被插在
        // 内容与**闭合标记符之间**，序列化出来是 `| **实测痛点**<br>** |` —— 尾巴上多一个没有内容的
        // `**`（重新解析就是两个字面星号，等于污染正文）。跳到下一格则完全不动单元格内容，
        // 没有任何往返风险。
        // 光标所在段为空时交给默认逻辑（空单元格里回车 = 切一个空段落，序列化器会丢掉它）。
        {
          const { state } = editor
          const inCell = editor.isActive('tableCell') || editor.isActive('tableHeader')
          if (inCell && state.selection.empty) {
            if (editor.commands.goToNextCell()) return true
            if (!editor.can().addRowAfter()) return false
            return editor.chain().addRowAfter().goToNextCell().run()
          }
        }

        // 注意：光标落在语法标记字符内部（如 '**5*|*'）时按回车 = 普通
        // 文本切段（`**5*` / `*`）。派生归一化对不成对构造按字面量处理，
        // 不再自动改写样式，也不会崩溃（详见 typoraInlineMarks.ts）。
        if (!hrType || !pType) return false
        const { state } = editor
        const { $from, empty } = state.selection
        if (!empty) return false
        const parent = $from.parent
        // 只处理纯文本段落：整段内容为 ---/***（可带尾随空格）且光标在段尾
        if (parent.type !== pType) return false
        const text = parent.textContent
        if ($from.parentOffset !== text.length) return false
        if (!/^(-{3,}|\*{3,})\s*$/.test(text)) return false

        // 显式事务：整段替换为 [分割线, 新空段落]，光标落新段落。
        // 替换目标是同层合法结构（叶子 + 空段落），replaceWith 走
        // ReplaceStep 的常规路径（与列表类型互转的深度不匹配场景不同）。
        const { tr } = state
        const pos = $from.before()
        const hr = hrType.create()
        const p = pType.create()
        tr.replaceWith(pos, pos + parent.nodeSize, Fragment.fromArray([hr, p]))
        tr.setSelection(TextSelection.create(tr.doc, pos + hr.nodeSize + 1))
        editor.view.dispatch(tr)
        return true
      },

      Backspace: ({ editor }) => {
        const { state } = editor
        const { $from, empty } = state.selection
        if (!empty) return false

        // 标题行首退格 → 降级为段落（既有语义，不并入上一行）
        if ($from.parent.type.name === 'heading') {
          if ($from.parentOffset !== 0) return false
          return editor.chain().focus().setParagraph().run()
        }

        // 代码块后段落行首退格 → 光标进入代码块末尾（不吞正文），见上
        if (backspaceIntoCodeBlock(editor)) return true

        // 段落行首 / 段间边界退格 = 与上一段合并（Typora 行为）。
        // 本版 prosemirror-commands 的 joinBackward 要求光标真正落在文本块
        // 内部（$cursor 非空）；而本编辑器的 Enter/归一化常把光标留在「块
        // 边界」位置（depth 0，解析不进任何段落），joinBackward 直接失效并
        // 落到 selectNodeBackward → 上一段变成 NodeSelection（紫色框整选）。
        // 这里显式 join 相邻同型文本块，光标经事务映射停在拼接处，再由派生
        // 归一化（字面量配对重提升）即时还原成样式，且永不出现段级整选。
        if (joinTextblockAtBoundary(editor, 'backward')) return true
        return false
      },
      Delete: ({ editor }) => {
        // 对称：段落行尾 / 段间边界前删 = 与下一段合并（同样绕过 PM 的
        // selectNodeForward 段级整选路径）
        if (!editor.state.selection.empty) return false
        return joinTextblockAtBoundary(editor, 'forward')
      },

      /**
       * 引用（blockquote）：**补一条真能按出来的键**。
       *
       * Tiptap 的 Blockquote 自带 `Mod-Shift-b`，而 `Mod+Shift+B` 被本应用的「切换侧栏」
       * （`view.toggleSidebar`，全局捕获阶段监听 window）占用 —— 于是内建那条**永远按不出来**，
       * 而右键菜单里这条动作也没有任何快捷键提示（编辑 › 段落 › 引用）。
       * 这里补 `Mod-Shift-q`：与 Typora 的引用快捷键一致，且与现有 27 条应用级默认键无冲突
       * （实测：`_verify-keymap.js` 的「无重复默认键」不受影响，因为它是**编辑器级**绑定）。
       * 提示写在 `lib/editor/menu/actions.ts` 的 `paragraph.quote` 上，两边必须一致。
       */
      'Mod-Shift-q': ({ editor }) => editor.commands.toggleBlockquote()
    }
  }
})
