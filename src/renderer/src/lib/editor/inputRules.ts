// ─── 附加 InputRules ─────────────────────────────────────────────────────────
// 1) 任务列表：StarterKit 自带的 Heading / BulletList / Blockquote / CodeBlock
//    输入规则已覆盖 '# ' 标题与 '- ' 列表语法，这里补齐主流编辑器的任务列表动态
//    语法：在无序列表项开头输入 '[ ] ' 或 '[x] '，把整个列表转换为任务列表。
// 2) Markdown 链接：[文字](网址) —— 敲下右括号即成形（通用做法）。
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

export const WysiwygInputRules = Extension.create({
  name: 'wysiwygInputRules',

  addInputRules() {
    const schema = this.editor.schema
    const taskListType = schema.nodes.taskList
    const taskItemType = schema.nodes.taskItem
    const linkType = schema.marks.link

    const rules: InputRule[] = []

    // ── Markdown 链接 / 图片：输入 ')' 即把 [label](url) / ![alt](url) 折叠成节点 ──
    // 不使用 core 的 markInputRule：它的约定是「最后一个捕获组即被标记的内容」，
    // 而链接语法的内容（label）夹在中间、href 在其后，套不上；这里直接改事务更直接。
    //
    // ⚠️ 第五十四轮 P0（**数据丢失级**，实测复现）：
    //   旧实现拿 core 给的 `range.from` 当绝对位置，再用 `state.doc.textBetween(start,
    //   start + inDoc.length, …)` 去校验。两个坑：
    //     ① `range.from` 是「pattern 在**待输入文本**里的起点」，一次插入多个字符时
    //        （`Input.insertText('…')`、输入法/合成、以及任何批量输入）它会落在**段落末尾之外**，
    //        `textBetween` 越界 ⇒ `Fragment.nodesBetween` 抛
    //        `TypeError: Cannot read properties of undefined (reading 'nodeSize')`
    //        —— 异常从 `handleTextInput` 里抛出去，PM 就**整段不插入**：实测输入
    //        `[文本](url)` / `![alt](url)` 后段落仍是"原有文字"，一个字都没进来；
    //     ② 匹配可以落在待输入文本的第 2 个字符上（图片是 `!` + `[alt](url)`），
    //        `range.from` 于是比真实起点大 1，字符级输入时替换区间**错位**：
    //        实测最后一步是 `replace from:6 to:17 slice:"!alt"`，段落从 17 字缩到 10 字。
    //   现在的口径（三条例行护栏，缺一条就可能再吞字）：
    //     ① **只做逐字符打字这一档**（`typedLen === 1`）：批量输入/粘贴一律 `return null`
    //        （Tiptap 见 handler 返回 null 就不消费输入 ⇒ PM 照常把文字插进去，绝不丢字）；
    //     ② 位置一律用**段落相对偏移**算、再用 `$from.start()` 换算成绝对位置 ——
    //        天然在界内，不再可能越界抛错；
    //     ③ 整段包一层 try/catch：万一还有没想到的边界，也只当"这条规则不生效"，
    //        绝不让异常穿到 `handleTextInput` 外面（那里一抛就是丢字）。
    if (linkType) {
      rules.push(
        new InputRule({
          find: MD_LINK_AT_CARET,
          handler: ({ state, range, match }) => {
            try {
              const full = match[0]
              const label = match[1] ?? ''
              const href = (match[2] ?? '').trim()
              if (!href || !label) return null
              // typedLen = 这次 `handleTextInput` 一次插入了几个字符（core 的 range 定义见上）
              const typedLen = full.length - (range.to - range.from)
              if (typedLen !== 1) return null
              const $from = state.selection.$from
              if (!$from.parent.isTextblock) return null
              // 文档里此刻应当已有 full 去掉末位（刚敲下的那个字符还没落进文档）的那一段
              const before = full.slice(0, -1)
              const offset = $from.parentOffset
              const rel = offset - before.length
              if (rel < 0) return null
              // 段落内相对偏移取文本：位置保证在界内（越界正是旧实现的崩溃点）
              if ($from.parent.textBetween(rel, offset) !== before) return null
              const abs = $from.start() + rel
              const { tr } = state
              // 图片语法（前一个字符是 `!`）：标题与 `!` 一起吃掉，落成**图片节点**（与粘贴同形）
              const prevChar =
                rel > 0
                  ? $from.parent.textBetween(rel - 1, rel)
                  : abs > 0
                    ? state.doc.textBetween(abs - 1, abs, BLOCK_GUARD)
                    : ''
              if (prevChar === '!') {
                const imageType = schema.nodes.image
                if (!imageType) return null
                tr.replaceWith(
                  abs - 1,
                  abs + before.length,
                  imageType.create({ src: href, alt: label })
                )
                tr.setSelection(TextSelection.create(tr.doc, abs - 1 + 1))
                tr.setStoredMarks([])
                return
              }
              // 整段替换为「带 link mark 的文字」，光标落到链接之后（继续输入不再是链接）
              tr.replaceWith(
                abs,
                abs + before.length,
                schema.text(label, [linkType.create({ href })])
              )
              // 必须清掉 storedMarks：光标停在带 mark 文本的右边界时，PM 会沿用该位置的
              // mark 作为 storedMarks，紧接着输入的字会被吞进链接里。清空后继续输入即普通文本。
              tr.setSelection(TextSelection.create(tr.doc, abs + label.length))
              tr.setStoredMarks([])
              // 事务由 core 的 inputRulesPlugin 统一 dispatch，handler 无需返回值
              return
            } catch {
              // 任何意外都退化成"这条规则不生效"：Tiptap 不消费输入 ⇒ PM 正常插入文字
              return null
            }
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

          // 定位文档中**满足全部前置条件**的那一处匹配文本（绝对位置 = 内容坐标 + 1）
          //
          // 判据用 `startsWith` 而不是"文本全等"：用户在**已有内容的列表项**开头敲 `[x] `
          // 时，那一项段落的文本是 `[x] 第二条`（后面的正文还在同一个文本节点里），
          // 全等匹配会一个候选都找不到 ⇒ 规则静默失效（实测：真实编辑器里只留下被转义的
          // `\[x\] 第二条`）。`startsWith` 既能命中，又仍受下面两条护栏约束。
          //
          // ⚠️ 也不能"取第一个候选就完事"：前面的列表项如果本来就写着字面 `[ ]`，
          // 第一个候选并不是用户刚敲的那一处。所以：
          //   ① 每个候选都当场校验「前无序列表项首段开头」；
          //   ② 有多个候选时取**离当前光标最近**的那个（handler 拿得到真实选区，
          //      而 core 传进来的 `range.from` 在 Chromium 下可能落后一位 —— 见文件头说明）。
          let textPos = -1
          let itemDepth = -1
          let list: PMNode | null = null
          let bestDistance = Number.POSITIVE_INFINITY
          const cursor = state.selection.from
          doc.descendants((n, cp) => {
            if (!n.isText || !n.text || !n.text.startsWith(docText)) return
            const candidate = cp + 1
            const $at = doc.resolve(candidate)
            let depth = -1
            let owner: PMNode | null = null
            for (let d = $at.depth; d > 0; d--) {
              if ($at.node(d).type.name === 'listItem') {
                depth = d
                owner = $at.node(d - 1)
                break
              }
            }
            if (depth < 0 || !owner || owner.type.name !== 'bulletList') return
            // 匹配文本必须是该列表项第一个段落的开头（与改动前同一判据）
            if (candidate !== $at.start(depth) + 2) return
            const distance = Math.abs(candidate - cursor)
            if (distance < bestDistance) {
              bestDistance = distance
              textPos = candidate
              itemDepth = depth
              list = owner
            }
          })
          if (textPos < 0 || itemDepth < 0 || !list) return null
          const $from = doc.resolve(textPos)

          const checked = (match[1] || '').toLowerCase() === 'x'
          /**
           * 「第几个列表项」取的是 **`itemDepth - 1`** 那一层的下标（= bulletList 的第几个子节点）。
           *
           * 实测校准（prosemirror 的位置语义）：光标在**第二个** listItem 的段落里时
           * `index(itemDepth) === 0`（item 内第几个子节点 —— 段落），
           * 而 `index(itemDepth - 1) === 1`（第几个列表项）。
           * 改前用 `index(itemDepth)` ⇒ 恒为 0 ⇒ `[ ] ` 敲在非首项时：列表照转，
           * 但用户敲的那一项留着字面标记，**另一个项**被勾上（单元素列表碰巧正确，所以久未暴露）。
           * 回归由 `tests/inputRules.test.mjs` 与 `tools/_verify-input-rules.js` 两侧守着。
           */
          const itemIndex = $from.index(itemDepth - 1)

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
                  // 连同尾随空格一起剥掉：`[x] ` 的最后一个字符也是用户刚敲的
                  const cutLen = first.textContent.startsWith(match[0])
                    ? match[0].length
                    : docText.length
                  content = c.content.replaceChild(
                    0,
                    first.copy(first.content.cut(cutLen, first.content.size))
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
