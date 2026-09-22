import type { Editor } from '@tiptap/core'
import type { EditorMenuAction } from './types'

/**
 * ─── 动作目录 ────────────────────────────────────────────────────────────────
 * 每个动作 = 稳定 id + i18n 标签 + 图标 + 执行逻辑。与 store / 组件解耦：
 * 依赖只有 editor 与两个回调（prompt 对话框、失败提示），因此可单独测试，
 * 也可被工具栏、命令面板等复用（后续把 Toolbar 迁到这里即可消除重复）。
 * id 会写入 SQLite menu_usage，务必保持稳定（重命名＝丢失历史）。
 */
export interface EditorMenuActionDeps {
  editor: Editor
  /** 输入型动作（链接/图片）用的对话框；返回 null 表示取消 */
  prompt: (opts: {
    titleKey: string
    placeholderKey: string
    value?: string
  }) => Promise<string | null>
  /** 失败提示（如剪贴板不可读）→ 交给全局通知中心 */
  notifyError: (titleKey: string, body?: string) => void
}

/** 读取剪贴板：优先富文本 HTML，其次纯文本；失败抛错由调用方转成通知 */
async function readClipboard(): Promise<{ html?: string; text?: string }> {
  const clip = navigator.clipboard
  if (clip?.read) {
    try {
      const items = await clip.read()
      for (const item of items) {
        const html = item.types.includes('text/html')
          ? await (await item.getType('text/html')).text()
          : ''
        const text = item.types.includes('text/plain')
          ? await (await item.getType('text/plain')).text()
          : ''
        if (html || text) return { html: html || undefined, text: text || undefined }
      }
    } catch {
      /* 权限/焦点原因失败 → 退回 readText */
    }
  }
  const text = await clip.readText()
  return { text }
}

/** 取 tiptap-markdown 的解析器（MarkdownPaste 扩展用的是同一份 storage） */
function markdownParser(editor: Editor): { parse(text: string): string } | null {
  const storage = editor.storage as { markdown?: { parser?: { parse(text: string): string } } }
  return storage.markdown?.parser ?? null
}

/** 看起来像 markdown 源码的纯文本（链接/标题/列表/引用/围栏） */
function looksLikeMarkdown(text: string): boolean {
  return /\]\(|^#{1,6}\s|^\s*([-*+]|\d{1,9}[.)])\s|^```|^>\s?/m.test(text)
}

export function buildEditorMenuActions(
  deps: EditorMenuActionDeps
): Record<string, EditorMenuAction> {
  const { editor, prompt, notifyError } = deps
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  return {
    // ── 剪贴板（顶部横向常用行）────────────────────────────────────────────
    'clipboard.copy': {
      id: 'clipboard.copy',
      labelKey: 'editorMenu.copy',
      icon: 'copy',
      shortcut: 'Ctrl+C',
      // 仍是浏览器唯一能带上富文本风味的同步复制路径（ProseMirror 的 copy 处理挂在
      // 真实 copy 事件上，execCommand 会触发它，从而写入 text/html + text/plain）
      run: () => document.execCommand('copy')
    },
    'clipboard.cut': {
      id: 'clipboard.cut',
      labelKey: 'editorMenu.cut',
      icon: 'scissors',
      shortcut: 'Ctrl+X',
      run: () => document.execCommand('cut')
    },
    'clipboard.paste': {
      id: 'clipboard.paste',
      labelKey: 'editorMenu.paste',
      icon: 'clipboard',
      shortcut: 'Ctrl+V',
      // 走 view.pasteHTML/pasteText：复用 PM 的粘贴管线（含本项目的 MarkdownPaste
      // 扩展——Markdown 源码粘贴会被解析成块级结构，而不是一坨纯文本）。
      // 注意：pasteText 是「纯文本粘贴」通道，不经过 clipboardTextParser，遇到
      // `[a](url)` 这类 markdown 源码会原样插入（还会被 link 的 pasteRule 把网址
      // 单独链化，留下 `[a](` 明文）。因此纯文本分支先看是否像 markdown：像就自己
      // 用同一份 markdown 解析器转成 HTML 再走 pasteHTML，与 Ctrl+V 行为一致。
      run: async () => {
        try {
          const { html, text } = await readClipboard()
          if (html) {
            editor.view.pasteHTML(html)
            return true
          }
          if (!text) return false
          const parser = markdownParser(editor)
          if (parser && looksLikeMarkdown(text)) {
            editor.view.pasteHTML(parser.parse(text))
          } else {
            editor.view.pasteText(text)
          }
          return true
        } catch (e) {
          notifyError('editorMenu.pasteFailed', e instanceof Error ? e.message : String(e))
          return false
        }
      }
    },
    'clipboard.selectAll': {
      id: 'clipboard.selectAll',
      labelKey: 'editorMenu.selectAll',
      icon: 'list-checks',
      shortcut: 'Ctrl+A',
      run: () => {
        chain().selectAll().run()
      }
    },

    // ── 段落 ──────────────────────────────────────────────────────────────
    'paragraph.text': {
      id: 'paragraph.text',
      labelKey: 'editorMenu.paragraph',
      icon: 'align-center',
      run: () => {
        chain().setParagraph().run()
      }
    },
    // 标题 1/2/3 此前标着 Ctrl+1/2/3，但全仓**没有任何绑定**（grep `Mod-1` = 0）——
    // 「照着提示按键什么也不会发生」是比不显示更糟的缺陷，所以把假提示去掉。
    'paragraph.h1': {
      id: 'paragraph.h1',
      labelKey: 'editorMenu.heading1',
      icon: 'heading',
      run: () => {
        chain().toggleHeading({ level: 1 }).run()
      }
    },
    'paragraph.h2': {
      id: 'paragraph.h2',
      labelKey: 'editorMenu.heading2',
      icon: 'heading',
      run: () => {
        chain().toggleHeading({ level: 2 }).run()
      }
    },
    'paragraph.h3': {
      id: 'paragraph.h3',
      labelKey: 'editorMenu.heading3',
      icon: 'heading',
      run: () => {
        chain().toggleHeading({ level: 3 }).run()
      }
    },
    'paragraph.quote': {
      id: 'paragraph.quote',
      labelKey: 'editorMenu.quote',
      icon: 'quote',
      // 真实绑定 `Mod-Shift-q`（lib/editor/keymap.ts 的 TyporaKeymap）：Tiptap 自带的
      // `Mod-Shift-b` 被「切换侧栏」占用，按不出来 —— 所以这里写的是我们补的那条键
      shortcut: 'Ctrl+Shift+Q',
      run: () => {
        chain().toggleBlockquote().run()
      }
    },
    'paragraph.bulletList': {
      id: 'paragraph.bulletList',
      labelKey: 'editorMenu.bulletList',
      icon: 'list',
      run: () => {
        chain().toggleBulletList().run()
      }
    },
    'paragraph.orderedList': {
      id: 'paragraph.orderedList',
      labelKey: 'editorMenu.orderedList',
      icon: 'list-ordered',
      run: () => {
        chain().toggleOrderedList().run()
      }
    },
    'paragraph.taskList': {
      id: 'paragraph.taskList',
      labelKey: 'editorMenu.taskList',
      icon: 'list-checks',
      run: () => {
        chain().toggleTaskList().run()
      }
    },
    'paragraph.codeBlock': {
      id: 'paragraph.codeBlock',
      labelKey: 'editorMenu.codeBlock',
      icon: 'code',
      run: () => {
        chain().toggleCodeBlock().run()
      }
    },

    // ── 格式 ──────────────────────────────────────────────────────────────
    'format.bold': {
      id: 'format.bold',
      labelKey: 'editorMenu.bold',
      icon: 'bold',
      shortcut: 'Ctrl+B',
      run: () => {
        chain().toggleMdBold().run()
      }
    },
    'format.italic': {
      id: 'format.italic',
      labelKey: 'editorMenu.italic',
      icon: 'italic',
      shortcut: 'Ctrl+I',
      run: () => {
        chain().toggleMdItalic().run()
      }
    },
    // 『format.underline』已在第二十五轮**删除**：它唯一能落盘的形式是裸 HTML `<u>`，
    // 重开文档即退化成字面文本（见 shared/toolbarItems.ts 的说明）。
    'format.strike': {
      id: 'format.strike',
      labelKey: 'editorMenu.strike',
      icon: 'strike',
      // 快捷键提示要跟**真实绑定**一致：`Mod-Shift-x`（typoraInlineMarks 的 addKeyboardShortcuts）
      shortcut: 'Ctrl+Shift+X',
      run: () => {
        chain().toggleMdStrike().run()
      }
    },
    'format.inlineCode': {
      id: 'format.inlineCode',
      labelKey: 'editorMenu.inlineCode',
      icon: 'code',
      // 真实绑定是 `Mod-e`（typoraInlineMarks），此前菜单里不显示 —— 有键就写出来
      shortcut: 'Ctrl+E',
      run: () => {
        chain().toggleMdCode().run()
      }
    },

    // ── 插入 ──────────────────────────────────────────────────────────────
    'insert.link': {
      id: 'insert.link',
      labelKey: 'editorMenu.link',
      icon: 'link',
      // 这里原先标 `Ctrl+K`，但 Ctrl+K 实际绑的是「打开快捷键设置」（lib/keymap 的
      // help.keymap），链接压根没有快捷键 —— 提示键必须跟着真实绑定走，宁可不写。
      run: async () => {
        const href = await prompt({
          titleKey: 'editorMenu.linkPrompt',
          placeholderKey: 'editorMenu.linkPlaceholder',
          value: 'https://'
        })
        if (href === null) return false
        if (!href.trim()) {
          editor.chain().focus().unsetLink().run()
          return true
        }
        editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
        return true
      }
    },
    'insert.image': {
      id: 'insert.image',
      labelKey: 'editorMenu.image',
      icon: 'image',
      run: async () => {
        const src = await prompt({
          titleKey: 'editorMenu.imagePrompt',
          placeholderKey: 'editorMenu.imagePlaceholder'
        })
        if (!src?.trim()) return false
        editor.chain().focus().setImage({ src: src.trim() }).run()
        return true
      }
    },
    'insert.table': {
      id: 'insert.table',
      labelKey: 'editorMenu.table',
      icon: 'table',
      run: () => {
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
      }
    },
    'insert.hr': {
      id: 'insert.hr',
      labelKey: 'editorMenu.hr',
      icon: 'hr',
      run: () => {
        editor.chain().focus().setHorizontalRule().run()
      }
    },
    'insert.toc': {
      id: 'insert.toc',
      labelKey: 'editorMenu.toc',
      icon: 'book',
      run: () => {
        editor.chain().focus().insertTableOfContents().run()
      }
    },

    // ── 表格（仅在表格内出现）─────────────────────────────────────────────
    'table.rowAbove': {
      id: 'table.rowAbove',
      labelKey: 'editorMenu.rowAbove',
      icon: 'table',
      run: () => {
        editor.chain().focus().addRowBefore().run()
      }
    },
    'table.rowBelow': {
      id: 'table.rowBelow',
      labelKey: 'editorMenu.rowBelow',
      icon: 'table',
      run: () => {
        editor.chain().focus().addRowAfter().run()
      }
    },
    'table.colBefore': {
      id: 'table.colBefore',
      labelKey: 'editorMenu.colBefore',
      icon: 'columns',
      run: () => {
        editor.chain().focus().addColumnBefore().run()
      }
    },
    'table.colAfter': {
      id: 'table.colAfter',
      labelKey: 'editorMenu.colAfter',
      icon: 'columns',
      run: () => {
        editor.chain().focus().addColumnAfter().run()
      }
    },
    'table.toggleHeader': {
      id: 'table.toggleHeader',
      labelKey: 'editorMenu.toggleHeader',
      icon: 'table',
      run: () => {
        editor.chain().focus().toggleHeaderRow().run()
      }
    },
    'table.deleteRow': {
      id: 'table.deleteRow',
      labelKey: 'editorMenu.deleteRow',
      icon: 'trash',
      danger: true,
      run: () => {
        editor.chain().focus().deleteRow().run()
      }
    },
    'table.deleteCol': {
      id: 'table.deleteCol',
      labelKey: 'editorMenu.deleteCol',
      icon: 'trash',
      danger: true,
      run: () => {
        editor.chain().focus().deleteColumn().run()
      }
    },
    'table.delete': {
      id: 'table.delete',
      labelKey: 'editorMenu.deleteTable',
      icon: 'trash',
      danger: true,
      run: () => {
        editor.chain().focus().deleteTable().run()
      }
    }
  }
}
