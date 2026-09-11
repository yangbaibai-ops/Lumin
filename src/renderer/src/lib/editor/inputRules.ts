// ─── 附加 InputRules ─────────────────────────────────────────────────────────
// 1) 任务列表：StarterKit 自带的 Heading / BulletList / Blockquote / CodeBlock
//    输入规则已覆盖 '# ' 标题与 '- ' 列表语法，这里补齐 Typora 的任务列表动态
//    语法：在无序列表项开头输入 '[ ] ' 或 '[x] '，把整个列表转换为任务列表。
// 2) Markdown 链接：[文字](网址) —— 敲下右括号即成形（Typora 同款）。
//    Tiptap 的 Link 只有 autolink（裸网址自动成链）与 linkOnPaste，没有这套
//    方括号语法，所以此前手工输入 [](), 只会remain 纯文本。
import { Extension, InputRule } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'

/** 光标前恰好是一个完整的 markdown 链接（label 内不允许方括号/换行，href 内不允许空白与圆括号） */
const MD_LINK_AT_CARET = /\[([^[\]\n]*)\]\(([^()\s]+)\)$/
/** 跨文本块时 textBetween 用的分隔符：正常文本里不会出现，借此避免跨块误匹配 */
const BLOCK_GUARD = '\uffff'

export const TyporaInputRules = Extension.create({
  name: 'typoraInputRules',

  addInputRules() {
    const schema = this.editor.schema
    const taskListType = schema.nodes.taskList
    const taskItemType = schema.nodes.taskItem
    const linkType = schema.marks.link

    const rules: InputRule[] = []

    // ── Markdown 链接：输入 ')' 即把 [label](url) 折叠成链接 ──
    // 不使用 core 的 markInputRule：它的约定是「最后一个捕获组即被标记的内容」，
    // 而链接语法的内容（label）夹在中间、href 在其后，套不上；这里直接改事务更直接。
    if (linkType) {
      rules.push(
        new InputRule({
          find: MD_LINK_AT_CARET,
          handler: ({ state, range, match }) => {
            const full = match[0]
            const label = match[1] ?? ''
            const href = (match[2] ?? '').trim()
            if (!href) return null
            // 空 label（形如 `[](url)`）：PM 的行内模型不允许空文本节点，
            // schema.text('') 会抛 RangeError: Empty text nodes are not allowed
            // （此前这里直接把输入规则打断，界面上既不生成链接、控制台还报错）。
            // 这类写法没有链接文字，保持字面不发散，等用户补上文字再成型。
            if (!label) return null
            const { tr } = state
            // 关键：input rule 在「刚输入的字符尚未落进文档」时触发（core 的 run 把
            // 末尾字符拼在 textBefore 里做匹配），所以文档里此刻只有 full 去掉末位
            // 的那一段。range.from 是 core 算好的模式起点，用它做定位并按长度校验。
            const typed = full.slice(-1)
            const inDoc = full.slice(0, full.length - typed.length)
            const start = range.from
            if (start < 0) return null
            if (state.doc.textBetween(start, start + inDoc.length, BLOCK_GUARD) !== inDoc)
              return null
            // 整段替换为「带 link mark 的文字」，光标落到链接之后（继续输入不再是链接）
            tr.replaceWith(
              start,
              start + inDoc.length,
              schema.text(label, [linkType.create({ href })])
            )
            // 必须清掉 storedMarks：光标停在带 mark 文本的右边界时，PM 会沿用该位置的
            // mark 作为 storedMarks，紧接着输入的字会被吞进链接里（实测「Lumin尾巴」
            // 整段变成链接文字）。清空后继续输入即普通文本。
            tr.setSelection(TextSelection.create(tr.doc, start + label.length))
            tr.setStoredMarks([])
            // 事务由 core 的 inputRulesPlugin 统一 dispatch，handler 无需返回值
            return
          }
        })
      )
    }

    if (!taskListType || !taskItemType) return rules

    rules.push(
      new InputRule({
        // 注意用字面空格而非 \s：core 会在 Enter 键按下时以 '\n' 重放输入规则，
        // \s 会匹配换行导致误触发（任务列表里按 Enter 时把 '[ ]' 误删）。
        find: /^\[([ xX]?)\] $/,
        handler: ({ state, match }) => {
          // 注意：不信任 core 传入的 range——Chromium 下 beforeinput 的 from
          // 可能落后 DOM 光标一位；改为从文档内容定位匹配文本。
          const docText = match[0].slice(0, -1) // 例如 '[ ]'（最后一位是刚输入的字符）
          const { doc, tr } = state as EditorState & { tr: Transaction }

          // 定位文档中的匹配文本节点（绝对位置 = descendants 内容坐标 + 1）
          let textPos = -1
          doc.descendants((n, cp) => {
            if (textPos < 0 && n.isText && n.text === docText) textPos = cp + 1
          })
          if (textPos < 0) return null
          const $from = doc.resolve(textPos)

          // 定位外层的 listItem 与其所属列表（只转换无序列表）
          let itemDepth = -1
          let list: PMNode | null = null
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth)
            if (node.type.name === 'listItem') {
              itemDepth = depth
              list = $from.node(depth - 1)
              break
            }
          }
          if (itemDepth < 0 || !list || list.type.name !== 'bulletList') return null

          // 匹配文本必须是该列表项第一个段落的开头
          if (textPos !== $from.start(itemDepth) + 2) return null

          const checked = (match[1] || '').toLowerCase() === 'x'
          const itemIndex = $from.index(itemDepth)

          // 重建顶层内容：把该 bulletList 替换为 taskList，
          // 目标项按语法设置勾选并剥掉开头的 '[ ]' 文本，其余项原样保留。
          // 本版 prosemirror 的局部替换原语（deleteRange/delete/replaceWith/
          // replaceRange/ReplaceAroundStep）都会做边界拟合或深度校验，
          // 对列表类型转换全部失效；整文档内容替换（0..content.size）走
          // fitsTrivially 的精确 ReplaceStep，是唯一可靠的路径。
          const children: PMNode[] = []
          const converted: PMNode[] = []
          let newListIndex = -1
          for (let i = 0; i < doc.content.childCount; i++) {
            const child = doc.content.child(i)
            if (child !== list) {
              children.push(child)
              continue
            }
            newListIndex = children.length
            child.forEach((c, _offset, index) => {
              let content = c.content
              if (index === itemIndex) {
                const first = c.firstChild
                if (first && first.isTextblock && first.textContent.startsWith(docText)) {
                  content = c.content.replaceChild(
                    0,
                    first.copy(first.content.cut(docText.length, first.content.size))
                  )
                }
              }
              const item = taskItemType.create(
                { checked: index === itemIndex ? checked : false },
                content,
                c.marks
              )
              converted.push(item)
            })
            children.push(taskListType.create(null, converted))
          }
          tr.replace(0, doc.content.size, new Slice(Fragment.fromArray(children), 0, 0))

          // 光标落在转换后目标项的段落内。
          // 注意：本版 prosemirror 顶层子节点间没有 +1 间隙（content.size = Σ nodeSize），
          // 位置按紧凑偏移累加；空段落的光标取段落自身位置（resolve 会落到该段落）。
          let caret = 1
          for (let i = 0; i < newListIndex; i++) caret += children[i].nodeSize
          caret += 1 // taskList 自身 → 第一个 taskItem
          for (let j = 0; j < itemIndex; j++) caret += converted[j].nodeSize
          caret += 1 // taskItem 自身 → 段落
          tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)))
          // 事务由 core 的 inputRulesPlugin 统一 dispatch，handler 本身无需返回值
          return
        }
      })
    )

    return rules
  }
})
