// ─── 附加 InputRules：任务列表 - [ ] ──────────────────────────────────────────
// StarterKit 自带的 Heading / BulletList / Blockquote / CodeBlock 输入规则
// 已覆盖 '# ' 标题与 '- ' 列表语法，这里补齐 Typora 的任务列表动态语法：
// 在无序列表项开头输入 '[ ] ' 或 '[x] '，把整个列表转换为任务列表。
import { Extension, InputRule } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'

export const TyporaInputRules = Extension.create({
  name: 'typoraInputRules',

  addInputRules() {
    const schema = this.editor.schema
    const taskListType = schema.nodes.taskList
    const taskItemType = schema.nodes.taskItem
    if (!taskListType || !taskItemType) return []

    return [
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
    ]
  }
})
