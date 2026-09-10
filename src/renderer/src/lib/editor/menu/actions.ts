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
      // 扩展——Markdown 源码粘贴会被解析成块级结构，而不是一坨纯文本）
      run: async () => {
        try {
          const { html, text } = await readClipboard()
          if (html) editor.view.pasteHTML(html)
          else if (text) editor.view.pasteText(text)
          else return false
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
    'paragraph.h1': {
      id: 'paragraph.h1',
      labelKey: 'editorMenu.heading1',
      icon: 'heading',
      shortcut: 'Ctrl+1',
      run: () => {
        chain().toggleHeading({ level: 1 }).run()
      }
    },
    'paragraph.h2': {
      id: 'paragraph.h2',
      labelKey: 'editorMenu.heading2',
      icon: 'heading',
      shortcut: 'Ctrl+2',
      run: () => {
        chain().toggleHeading({ level: 2 }).run()
      }
    },
    'paragraph.h3': {
      id: 'paragraph.h3',
      labelKey: 'editorMenu.heading3',
      icon: 'heading',
      shortcut: 'Ctrl+3',
      run: () => {
        chain().toggleHeading({ level: 3 }).run()
      }
    },
    'paragraph.quote': {
      id: 'paragraph.quote',
      labelKey: 'editorMenu.quote',
      icon: 'quote',
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
    'format.underline': {
      id: 'format.underline',
      labelKey: 'editorMenu.underline',
      icon: 'underline',
      shortcut: 'Ctrl+U',
      run: () => {
        chain().toggleUnderline().run()
      }
    },
    'format.strike': {
      id: 'format.strike',
      labelKey: 'editorMenu.strike',
      icon: 'strike',
      run: () => {
        chain().toggleMdStrike().run()
      }
    },
    'format.inlineCode': {
      id: 'format.inlineCode',
      labelKey: 'editorMenu.inlineCode',
      icon: 'code',
      run: () => {
        chain().toggleMdCode().run()
      }
    },

    // ── 插入 ──────────────────────────────────────────────────────────────
    'insert.link': {
      id: 'insert.link',
      labelKey: 'editorMenu.link',
      icon: 'link',
      shortcut: 'Ctrl+K',
      // 对话框期间先收起菜单由 UI 负责；取消（null）视为未执行
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
