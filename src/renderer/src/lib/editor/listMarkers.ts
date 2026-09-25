import BulletList from '@tiptap/extension-bullet-list'
import TaskList from '@tiptap/extension-task-list'
import type {
  MarkdownItLike,
  MarkdownItRendererRule,
  MarkdownSerializerStateLike,
  PatchedRule
} from './markdownTypes'

/**
 * ─── 列表的 Markdown 保真（标记字符 + 紧/松 + 任务列表）────────────────────────
 *
 * 三个都是「打开→保存文件就变了」级别的坑，而且都是上游默认行为造成的：
 *
 * 1. **无序列表标记被抹平**：`bulletListMarker: '-'` 让序列化器永远写 `-`，
 *    于是源码里的 `*`/`+` 一旦保存就没了。更糟的是：`* 甲` 与 `+ 乙` 本来是**两个**
 *    列表（CommonMark 里标记不同即分开），保存后都成了 `-` 列表，再解析就并成
 *    一个「松散列表」—— 项间多出空行、渲染间距都变了，每次保存都在漂。
 *    → 解析时把标记记进 `bullet` 属性，序列化写回原标记。
 *
 * 2. **相邻同类列表被插空行**：prosemirror-markdown 的 renderList 遇到
 *    「刚关闭的块是同类型」会 flushClose(3)（两个空行）来避免两列表并成一个。
 *    标记已经不同了就不需要它 —— 而且插进去的正是把紧列表变松散的那一刀。
 *    → 标记不同就清掉 closed，不插空行。
 *
 * 3. **任务列表永远是松散的**：任务列表的序列化器复用无序列表那份，它会读
 *    `node.attrs.tight`；而 `tight` 属性只挂在 bulletList/orderedList 上，
 *    taskList 上没有这个属性 → `undefined` → 每个任务项之间都被塞空行。
 *    → 给 taskList 也挂上同样的 `tight` 属性。
 */

/** markdown-it 的渲染器规则会被反复包装：同一个函数只补一次（导出给单测直接调） */
export function patchBulletListOpen(md: MarkdownItLike): void {
  const original = md.renderer.rules.bullet_list_open as MarkdownItRendererRule | undefined
  if (original && (original as MarkdownItRendererRule & PatchedRule).__luminPatched) return
  const wrapped: MarkdownItRendererRule = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    // markdown-it 把 `-`/`*`/`+` 记在 token.markup 上
    if (token && token.markup) token.attrSet('data-bullet', token.markup)
    return original
      ? original(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }
  ;(wrapped as MarkdownItRendererRule & PatchedRule).__luminPatched = true
  md.renderer.rules.bullet_list_open = wrapped
}

/**
 * 无序列表：保留源码里的 `-`/`*`/`+`。
 * `parse.setup(md)` 是 tiptap-markdown 给扩展的官方钩子（每次 parse 前调用），
 * 用它给 `<ul>` 打上 `data-bullet`，再由属性 parseHTML 读回节点。
 */
export const BulletListMarked = BulletList.extend({
  addGlobalAttributes() {
    return [
      {
        types: ['bulletList'],
        attributes: {
          bullet: {
            default: '-',
            parseHTML: (element: HTMLElement) => element.getAttribute('data-bullet') || '-',
            // 落进 DOM：PM 的 DOMObserver 回读时才能保持一致（否则属性会被打回默认值）
            renderHTML: (attributes: Record<string, unknown>) => ({
              'data-bullet': String(attributes.bullet ?? '-')
            })
          }
        }
      }
    ]
  },
  addStorage() {
    return {
      markdown: {
        parse: {
          setup: (md: MarkdownItLike) => patchBulletListOpen(md)
        },
        serialize(state: MarkdownSerializerStateLike, node: { attrs: Record<string, unknown> }) {
          const bullet = String(node.attrs.bullet ?? '-')
          // 相邻同类型列表：标记不同就不需要空行分隔（见文件头第 2 条）。
          // 用 flushClose(1) 而不是直接把 closed 置空：前者只补一个换行（块之间的
          // 正常分隔），置空会让两个列表的首尾粘在同一行（实测 `- 第三项* 星号标记`）。
          if (
            state.closed &&
            state.closed.type === (node as { type?: unknown }).type &&
            String(state.closed.attrs?.bullet ?? '-') !== bullet
          ) {
            state.flushClose(1)
          }
          state.renderList(node, '  ', () => bullet + ' ')
        }
      }
    }
  }
})

/**
 * 任务列表：补上 `tight` 属性，避免每个任务项之间被塞空行（见文件头第 3 条），
 * 并让**有序任务列表**（`1. [ ] x`，markdown-it 渲染成 `<ol class="contains-task-list">`）
 * 也能进模型 —— 上游只认 `ul[data-type="taskList"]`，于是 `1. [ ] x` 会变成
 * 「一个空的 1. 项 + 一个无序任务列表」（实测就是这种破输出）。
 *
 * `ordered` 属性（本轮补）：解析时按标签记住它是 `<ol>` 还是 `<ul>`，序列化时有序的写
 * `1. `/`2. `，无序的写 `- `。上游的任务列表序列化器直接复用无序列表那份，永远是 `- `，
 * 于是 `1. [ ] 有序任务列表` 保存后变成 `- [ ] 有序任务列表` —— **列表类型从有序变无序**，
 * 渲染从数字变成圆点，是实打实的内容结构变化。
 */
export const TaskListTight = TaskList.extend({
  parseHTML() {
    return [
      { tag: 'ol[data-type="taskList"]', priority: 52 },
      { tag: 'ul[data-type="taskList"]', priority: 51 }
    ]
  },
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
            renderHTML: (attributes: Record<string, unknown>) => ({
              'data-tight': attributes.tight === false ? null : 'true'
            })
          },
          ordered: {
            default: false,
            parseHTML: (element: HTMLElement) => element.tagName.toLowerCase() === 'ol',
            // 落进 DOM：PM 的 DOMObserver 回读时才能保持一致
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.ordered === true ? { 'data-ordered': 'true' } : {}
          }
        }
      }
    ]
  },
  addStorage() {
    return {
      markdown: {
        // 只覆盖 serialize：tiptap-markdown 的默认 spec（parse.setup 注册任务列表插件 +
        // updateDOM 认领复选框）会与这里合并保留
        serialize(
          state: MarkdownSerializerStateLike,
          node: { attrs: Record<string, unknown> }
        ): void {
          const ordered = node.attrs.ordered === true
          state.renderList(node as never, '  ', (index: number) =>
            ordered ? `${index + 1}. ` : '- '
          )
        }
      }
    }
  }
})
