import type { Editor } from '@tiptap/core'
import { escapeMarkerOnlyLines, withFinalNewline } from '../../../../shared/documentText'
// 序列化器热区快路径（`atBlank` 的 O(n²)）：只在本模块被加载时装一次，输出字节不变。
// 为什么挂在这里：`getMarkdown()` 是"编辑器内容 → 文档文本"的唯一出口，
// 所有落盘/同步都会经过它，装在这里就不会漏掉任何一条调用链（见该文件的长注释）。
import { installFastMarkdownSerializer } from './serializerFastPath'
import { runBudgeted } from './workBudget'

installFastMarkdownSerializer()

/**
 * 真源锚：`doc` 的**对象身份** + 序列化结果。
 *
 * 为什么可以按 doc 身份缓存：`getMarkdown` 是纯函数（只读 `ed.state.doc`），
 * ProseMirror 的文档是持久化结构 —— 内容没变就是**同一个对象**。而"粘贴之后"的连锁里
 * 同一次 docChanged 会触发多次 `getMarkdown`（防抖 flush、失焦 flush、外部同步比较、
 * 导出预览），旧实现每次都整篇重排。命中缓存时直接返回上次的字符串，
 * 摊掉重复成本，**输出逐字节不变**。
 */
let memoDoc: unknown = null
let memoMd = ''

/**
 * 超预算时的**可见告知**出口（宿主注入；内核不直接弹通知）。
 * 与粘贴护栏同一口径，见 pasteGuard.ts 的 `PasteNotice`。
 */
let budgetNotice: ((name: string, ms: number) => void) | null = null

/** 宿主接线：序列化超预算时把提示交给通知中心（节流由宿主做） */
export function setMarkdownBudgetNotice(fn: ((name: string, ms: number) => void) | null): void {
  budgetNotice = fn
}

/**
 * **原样写回的节点**（HTML 块 / 公式块 / front matter，都是 `attrs.source`）里的每一行：
 * 它们是用户的原文，整行转义规则必须绕开（否则 `****` 这样的一行会被加上反斜杠，
 * 把用户写的内容改掉）。代码块不用管 —— 它的内容在反引号围栏里，转义规则自己会跳过。
 */
function verbatimSourceLines(ed: Editor): string[] {
  const lines: string[] = []
  try {
    ed.state.doc.descendants((n) => {
      const src = n.attrs && typeof n.attrs.source === 'string' ? n.attrs.source : null
      if (src) lines.push(...src.split('\n'))
      return true
    })
  } catch {
    /* 取不到就不保护（上层还有 try/catch 兜底） */
  }
  return lines
}

/**
 * 取编辑器内容的 Markdown 表示。
 *
 * **这是「编辑器内容 → 文档文本」的唯一出口**：WysiwygEditor 的落盘（flushSync）、
 * 外部同步比较、源码模式切换都从这里取，所以文档级的收尾规则也放这里 ——
 * 否则「谁先谁后」不一致会直接变成 setContent 回滚（光标重置、快速输入丢字，见 §4.11）。
 *
 * 规则见 shared/documentText.ts（整行标记字符逐字符转义 + 非空文档以且仅以一个换行结尾）。
 *
 * 性能（本轮）：① 按 `doc` 身份缓存（同一次文档变更只序列化一遍）；
 * ② 外面的 `flushSync` 用 `runBudgeted` 记账（超预算 ⇒ 延后可选重活 + 可见告知）。
 */
export function getMarkdown(ed: Editor): string {
  try {
    const doc = ed.state.doc
    if (doc === memoDoc) return memoMd
    const storage = ed.storage as unknown as { markdown?: { getMarkdown(): string } }
    const raw = runBudgeted('getMarkdown', () => storage.markdown?.getMarkdown() ?? '', {
      onOver: (name, ms) => {
        const fn = budgetNotice
        if (fn) {
          try {
            fn(name, ms)
          } catch {
            /* 提示失败不影响序列化 */
          }
        }
      }
    })
    const md = withFinalNewline(escapeMarkerOnlyLines(raw, verbatimSourceLines(ed)))
    memoDoc = doc
    memoMd = md
    return md
  } catch {
    return ''
  }
}
