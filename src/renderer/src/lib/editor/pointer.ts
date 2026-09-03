// ─── 鼠标语义：Ctrl/Cmd + 左键 = 普通点击（Typora 同款，无「节点整选」）─────
// prosemirror-view 内置 selectNodeModifier（Win: ctrlKey / Mac: metaKey）：
// 按住修饰键左键点击时会把光标所在的最小可选中块（段落、标题等文本块）做成
// NodeSelection 整选，DOM 上给整块套 `.ProseMirror-selectednode`（主题色
// outline 全选框）——Typora 没有这套逻辑，编辑器不应在 Ctrl+点击时整段选中。
//
// 修复：在 mousedown 阶段（而非 mouseup/handleClick）拦截——PM 的 selectNode
// 状态在 mousedown 时即被捕获，若用户在松开鼠标前先松开 Ctrl，mouseup 时
// 判断修饰键会漏网，mousedown 拦截才是确定的。拦截后 preventDefault 掉浏览器
// 默认行为，退化为普通点击：把光标放到点击处（posAtCoords → TextSelection.near）。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'

const pluginKey = new PluginKey('typora-pointer-plain-click')

export const TyporaPointer = Extension.create({
  name: 'typoraPointer',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              // 仅拦截「Ctrl/Cmd + 左键」；其余点击（含图片等节点的普通单击
              // 选中）一律放行给 PM 原有逻辑
              if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false
              event.preventDefault()
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
              if (pos) {
                const sel = TextSelection.near(view.state.doc.resolve(pos.pos))
                if (!view.state.selection.eq(sel)) {
                  view.dispatch(view.state.tr.setSelection(sel))
                }
              }
              view.focus()
              return true
            }
          }
        }
      })
    ]
  }
})
