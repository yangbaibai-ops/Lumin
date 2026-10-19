// ─── 拼写建议分区：构建 / 定位 / 替换（纯逻辑，便于单测）─────────────────────
//
// 数据流（为什么这里不是"直接读 DOM"）：
//   Chromium 只在主进程的 `context-menu` 事件里给出 `misspelledWord` 与
//   `dictionarySuggestions`；渲染层拿到之后，把「词 + 建议 + 该词在 PM 文档里的位置」
//   交给本模块拼成一个菜单分区。菜单组件只认识 EditorMenuSection[]，不认识拼写检查。
//
// `findWordRange` 的取舍：右键点击给的是**文档位置**（posAtCoords），不是词的范围。
// 这里在文档里找 `word` 的出现处，取离点击位置最近的一处（优先边界完整的出现）。
// 不按 DOM Range 去量：正文里 Markdown 标记是真实文本、还带装饰层，DOM 文本与 PM 位置
// 不是一一对应；PM 文档坐标才是保存/替换的权威。
import type { Node as PmNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'
import type { EditorMenuAction, EditorMenuSection } from './types'
import { MAX_SPELL_SUGGESTIONS } from '../../../../../shared/spellcheck.ts'

export interface SpellRange {
  from: number
  to: number
}

/** 一次右键里与拼写检查有关的全部信息 */
export interface SpellMenuData {
  word: string
  suggestions: string[]
  /** 该词在 PM 文档里的范围；找不到时为 null（建议项会禁用，而不是静默无效） */
  range: SpellRange | null
  /**
   * 检查来源：
   *   * `'en'`（默认）= Chromium 内置拼写器；
   *   * `'zh'` = 我们的中文启发式层（没有词典，因此没有「添加到词典」）。
   */
  source?: 'en' | 'zh'
  /** 中文命中的说明（如「『的的』可能重复」）；英文为空 */
  message?: string
  /** 中文命中的稳定指纹（「忽略本次」用） */
  issueKey?: string
}

/** 建议被点击 / 「添加到词典」/「忽略」时的落地动作（由 store 注入） */
export interface SpellMenuHandlers {
  replace: (range: SpellRange, word: string) => void
  addToDictionary: (word: string) => void | Promise<void>
  ignore: (word: string) => void | Promise<void>
}

/** 词字符：字母 / 组合符 / 数字（用于边界判断；`don't` 这类由撇号连接的不强求） */
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{M}\p{N}]/u.test(ch)
}

/**
 * 在 PM 文档里找 `word` 的出现处，返回离 `pos` 最近的那一个。
 *
 * 为什么用"全文档找最近"而不是"解析光标所在文本节点"：右键位置可能落在词边界、
 * 也可能落在一个不可编辑的 widget 上，`posAtCoords` 给的位置未必在该词的文本节点内。
 * 最近匹配在正常文档里就是用户点的那个词；找不到时返回 null，菜单会把建议项禁用。
 */
export function findWordRange(doc: PmNode, pos: number, word: string): SpellRange | null {
  if (!word) return null
  interface Candidate extends SpellRange {
    distance: number
    exact: boolean
  }
  const candidates: Candidate[] = []
  doc.descendants((node, nodePos) => {
    if (!node.isText) return true
    const text = node.text ?? ''
    let index = text.indexOf(word)
    while (index >= 0) {
      const from = nodePos + index
      const to = from + word.length
      const before = index > 0 ? text[index - 1] : ''
      const after = index + word.length < text.length ? text[index + word.length] : ''
      const exact = !isWordChar(before) && !isWordChar(after)
      const distance = pos < from ? from - pos : pos > to ? pos - to : 0
      candidates.push({ from, to, distance, exact })
      index = text.indexOf(word, index + 1)
    }
    return true
  })
  if (candidates.length === 0) return null
  const exact = candidates.filter((c) => c.exact)
  const pool = exact.length > 0 ? exact : candidates
  pool.sort((a, b) => a.distance - b.distance)
  return { from: pool[0].from, to: pool[0].to }
}

/** 用建议词替换文档里的错词（一次 PM 事务，可撤销） */
export function replaceSpellWord(editor: Editor, range: SpellRange, word: string): boolean {
  if (!word) return false
  return editor.chain().focus().insertContentAt(range, word).run()
}

/**
 * 中文修正：直接 `tr.insertText`（一个事务、Ctrl+Z 一次还原）。
 * 为什么不用链式命令：中文修正只需要替换一段纯文本，不需要解析插入内容；
 * insertText 的语义最窄，也不会把「，」这类标点当成 Markdown 结构。
 */
export function replaceSpellRange(editor: Editor, range: SpellRange, text: string): boolean {
  if (!text) return false
  editor.view.dispatch(editor.state.tr.insertText(text, range.from, range.to).scrollIntoView())
  editor.view.focus()
  return true
}

/**
 * 拼出菜单顶部的「拼写建议」分区。
 * 无错词 ⇒ 返回 null（调用方据此保证"没有拼写错误时菜单行为完全不变"）。
 */
export function buildSpellSection(
  spell: SpellMenuData | null | undefined,
  handlers: SpellMenuHandlers
): EditorMenuSection | null {
  const word = spell?.word?.trim() ?? ''
  const message = spell?.message?.trim() ?? ''
  if (!word && !message) return null
  const isZh = spell?.source === 'zh'
  const seen = new Set<string>()
  const suggestions: string[] = []
  for (const raw of spell?.suggestions ?? []) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    suggestions.push(text)
    if (suggestions.length >= MAX_SPELL_SUGGESTIONS) break
  }

  const range = spell?.range ?? null
  const items: EditorMenuAction[] = suggestions.map((text, index) => ({
    id: `spell.suggest.${index}`,
    // Suggestion 的 label 是**用户数据**（词典给的词 / 中文修正目标），不是 i18n key：
    // 用 label 覆盖 t(labelKey)，菜单模板据此原样显示。
    labelKey: 'editorMenu.spellSuggestions',
    label: text,
    kind: 'suggestion',
    disabled: !range,
    run: () => {
      if (!range) return false
      handlers.replace(range, text)
      return true
    }
  }))

  if (isZh) {
    // 中文没有词典，不提供「添加到词典」；只有「忽略本次」（按指纹，不改文档）
    items.push({
      id: 'spell.ignore',
      labelKey: 'editorMenu.spellIgnoreOne',
      icon: 'x',
      kind: 'action',
      hintKey: 'editorMenu.zhSpellIgnoreHint',
      run: () => {
        void handlers.ignore(spell?.issueKey ?? word)
      }
    })
    return {
      id: 'spell',
      labelKey: 'editorMenu.zhSpell',
      variant: 'spell',
      word,
      message,
      items
    }
  }

  items.push(
    {
      id: 'spell.addToDictionary',
      labelKey: 'editorMenu.spellAddToDictionary',
      icon: 'book',
      kind: 'action',
      run: () => {
        void handlers.addToDictionary(word)
      }
    },
    {
      id: 'spell.ignore',
      labelKey: 'editorMenu.spellIgnore',
      icon: 'x',
      kind: 'action',
      // 讲清取舍：忽略只影响本会话的菜单，不消除系统下划线
      hintKey: 'editorMenu.spellIgnoreHint',
      run: () => {
        void handlers.ignore(word)
      }
    }
  )

  return {
    id: 'spell',
    labelKey: 'editorMenu.spellSuggestions',
    variant: 'spell',
    word,
    items
  }
}
