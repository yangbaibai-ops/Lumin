// ─── 软换行的序列化规则（纯函数，可 `node --test`）─────────────────────────────
//
// 与 `softBreak.ts` 分开的原因：那边 import 了 Tiptap 扩展（会拖进 DOM 依赖），
// 而"soft 写 `\n`、硬换行写 `\\\n`、表格里写 `<br>`、末尾连续换行不写"这条规则
// 是保存行数不再骤减的**唯一判据** —— 它必须能被单测直接钉住（tests/softBreak.test.mjs）。

export interface BreakSerializerState {
  write: (s: string) => void
  inTable?: boolean
}

export interface BreakSerializerNode {
  attrs?: { soft?: boolean }
  type: unknown
}

export interface BreakSerializerParent {
  childCount: number
  child: (i: number) => { type: unknown }
}

/**
 * 写一个 hardBreak 节点（`soft=true` 表示它来自 Markdown 的段内软换行）。
 *
 * 末尾连续 hardBreak 不写：上游 tiptap-markdown 的同一规则（否则段落尾会多一个空行）。
 * 返回值 = 是否真的写了（单测用；调用方不依赖）。
 */
export function writeBreakNode(
  state: BreakSerializerState,
  node: BreakSerializerNode,
  parent: BreakSerializerParent,
  index: number
): boolean {
  for (let i = index + 1; i < parent.childCount; i += 1) {
    if (parent.child(i).type !== node.type) {
      if (state.inTable) state.write('<br>')
      else state.write(node.attrs?.soft ? '\n' : '\\\n')
      return true
    }
  }
  return false
}
