import { Extension } from '@tiptap/core'
import type { MarkdownItLike } from './markdownTypes'

/**
 * ─── 放宽 markdown-it 的嵌套上限（默认 100 → 1000）───────────────────────────
 *
 * ### 为什么必须改：默认值会**静默丢内容**
 * markdown-it 的块解析器里有这么一段（`ParserBlock.prototype.tokenize`）：
 * ```js
 * if (state.level >= maxNesting) { state.line = endLine; break }
 * ```
 * 也就是说：一旦嵌套层级触到上限，**剩下的行直接被跳过** —— 不是降级成段落文本，
 * 而是整段消失。而每个列表层级要吃掉 **2** 级（`bullet_list` + `list_item`），
 * 所以默认 `maxNesting: 100` 的实际上限是**约 50 层列表**。
 *
 * 实测（`tools/_verify-surface-stress.js` 的 `deep-list-100`）：
 * 100 层缩进列表保存后只剩 49 层，第 50 层往后的内容**一个字符都不剩**，
 * 而且判级器只会说「规范化后不一致」——用户看到的是「我的列表没了」。
 *
 * ### 为什么是 1000
 * 1000 已经远超任何真实文档（= 500 层列表 / 1000 层引用），同时仍是一个**有界**值：
 * markdown-it 加这个上限本意是防栈溢出，我们只是把它抬到「不会误伤真实文档」的量级。
 * 深度压测（100 层列表 / 40 层引用）在这一档上完全通过。
 *
 * 实现方式沿用仓库既有手法：`markdown-it` 实例由 tiptap-markdown 建好后交给各扩展的
 * `parse.setup` 钩子，这里顺手改 `md.options`（`listMarkers.ts` 也用同一个钩子打补丁）。
 */
export const MarkdownParseLimits = Extension.create({
  name: 'markdownParseLimits',
  addStorage() {
    return {
      markdown: {
        parse: {
          setup: (md: MarkdownItLike): void => {
            const options = (md as MarkdownItLike & { options?: Record<string, unknown> }).options
            if (options && Number(options.maxNesting ?? 0) < 1000) options.maxNesting = 1000
          }
        }
      }
    }
  }
})
