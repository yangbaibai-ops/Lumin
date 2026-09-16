// ─── 行内公式的预览（KaTeX 组件 + 原文折叠）──────────────────────────────────
//
// 为什么用**装饰**而不是自定义节点：模型里公式的原文必须留在文档里（`$E = mc^2$` 就是一个
// 带 `MdMath` mark 的文本节点），序列化才能逐字写回。渲染成公式是**视图**的事 ——
// 正好是 ProseMirror 装饰的适用场景。
//
// 这套 prosemirror-view（1.42）的 `Decoration` 只提供 `widget` / `inline` / `node`
// （**没有** `replace`，也没有导出 `WidgetType`），所以「替换掉那段文本」用两步拼出来：
//   1. `Decoration.widget(from, …)` 在公式起点插入 KaTeX 渲染结果；
//   2. `Decoration.inline(from, to, { class: 'md-math-source' })` 给原文加个类，
//      CSS 把它折叠掉（`font-size: 0`）—— 与行内标记（`.md-marker`）同一套手法：
//      不用 `display: none`，因为那会破坏浏览器的光标导航。
//
// 交互与行内标记显隐同一套语义（手册 §4.14）：光标不在公式上 → 只看得到渲染后的公式；
// 光标落进去/选中 → 装饰消失，露出 `$…$` 原文，可以照常编辑。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorState } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { renderMath } from './mathMarkers'

const mathPreviewKey = new PluginKey('lumin-math-preview')

/** 收集文档里所有「整段带 MdMath mark」的文本区间（相邻文本节点合并成一段） */
function collectMathRanges(doc: PMNode): { from: number; to: number; source: string }[] {
  const out: { from: number; to: number; source: string }[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    if (!node.marks.some((m) => m.type.name === 'mdMath')) return true
    const last = out[out.length - 1]
    if (last && last.to === pos) {
      last.to = pos + node.nodeSize
      last.source += node.text
      return true
    }
    out.push({ from: pos, to: pos + node.nodeSize, source: node.text })
    return true
  })
  return out
}

/** 一段公式的 KaTeX 渲染节点（去掉 `$` 定界符后交给 KaTeX） */
function mathDom(source: string): HTMLElement {
  const inner = source.replace(/^\$/, '').replace(/\$$/, '')
  const span = document.createElement('span')
  span.className = 'md-math-rendered'
  span.setAttribute('data-md-math-source', inner)
  span.innerHTML = renderMath(inner, false)
  return span
}

/** 按选区构造装饰集：与选区相交的公式**不加装饰**（露出原文可编辑） */
function buildMathDecorations(state: EditorState): DecorationSet {
  const { from, to } = state.selection
  const decos: Decoration[] = []
  for (const r of collectMathRanges(state.doc)) {
    if (from <= r.to && to >= r.from) continue
    decos.push(Decoration.widget(r.from, () => mathDom(r.source), { side: -1 }))
    decos.push(Decoration.inline(r.from, r.to, { class: 'md-math-source' }))
  }
  return DecorationSet.create(state.doc, decos)
}

export const MathPreview = Extension.create({
  name: 'mathPreview',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mathPreviewKey,
        state: {
          init: (_config, state) => buildMathDecorations(state),
          apply: (tr, old, _oldState, newState) =>
            tr.docChanged || tr.selectionSet ? buildMathDecorations(newState) : old
        },
        props: {
          decorations(state) {
            return mathPreviewKey.getState(state) as DecorationSet | undefined
          }
        }
      })
    ]
  }
})
