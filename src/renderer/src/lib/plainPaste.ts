/**
 * ─── 「粘贴为纯文本」：唯一的实现（菜单 / 快捷键 / 粘贴护栏提示共用）────────────
 *
 * 用户要的是一条**永远不解析**的通道：粘贴大 HTML、复杂表格、公式、Markdown 源码时，
 * 不经过 DOMParser / PM Slice / markdown-it，只把剪贴板里的文字原样插进文档。
 *
 * 为什么不是 `view.pasteText()`：本项目给 ProseMirror 装了 `clipboardTextParser`
 * （MarkdownPaste），`pasteText` 仍会走那层解析 —— 对"我就是想要纯文本"的用户，
 * 那正是要绕开的东西。这里直接 `tr.insertText`，一个事务、无解析、可一次撤销。
 *
 * 源码模式（textarea）也支持：用户在源码面按 Ctrl+Shift+V 时同样不该被编辑器截走。
 */
import type { Editor } from '@tiptap/core'
import { useEditorStore } from '../stores/editor'
import { useNotificationsStore } from '../stores/notifications'
import i18n from '../i18n'
import { planPlainPaste } from './plainPasteCore'

export { planPlainPaste } from './plainPasteCore'
export type { PlainPastePlan } from './plainPasteCore'

/**
 * 读纯文本剪贴板；无权限/无内容 ⇒ ''（绝不抛给菜单）。
 *
 * 先试 Web Clipboard，失败再退到主进程的 `clipboard.readText()`：
 * 后者不要求 document 聚焦 —— 页面刚恢复、或用户从别的窗口点菜单时，前者会直接 reject。
 */
export async function readClipboardText(): Promise<string> {
  try {
    const clip = navigator.clipboard
    if (clip?.readText) {
      const text = await clip.readText()
      if (text) return text
    }
  } catch {
    /* 权限/焦点原因失败：退到主进程 */
  }
  try {
    return await window.luminAPI.freeze.clipboardText()
  } catch {
    return ''
  }
}

/**
 * 把纯文本插到**当前编辑面**（渲染面 ProseMirror 或源码 textarea）。
 * 返回是否真的插入了东西。
 */
export function insertPlainText(text: string): boolean {
  const plan = planPlainPaste(text)
  if (!plan.insert) return false

  // ① 源码模式：焦点在 textarea 上时按 textarea 处理（setRangeText 保持撤销栈）
  const active = typeof document !== 'undefined' ? document.activeElement : null
  const textarea = active as HTMLTextAreaElement | null
  if (textarea && textarea.tagName === 'TEXTAREA' && textarea.classList.contains('source-editor')) {
    try {
      const start = textarea.selectionStart ?? textarea.value.length
      const end = textarea.selectionEnd ?? start
      textarea.setRangeText(plan.text, start, end, 'end')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    } catch {
      return false
    }
  }

  // ② 渲染面：直接一个 insertText 事务（不经 paste 管线）
  const editor = useEditorStore().instance as Editor | null
  if (!editor || editor.isDestroyed) return false
  try {
    const { from, to } = editor.state.selection
    editor.view.dispatch(editor.state.tr.insertText(plan.text, from, to).scrollIntoView())
    editor.commands.focus()
    return true
  } catch {
    return false
  }
}

/**
 * 从剪贴板读文本并插入；失败/空剪贴板时给一条可见提示（不静默）。
 * 返回是否插入成功（菜单动作与通知按钮都复用它）。
 */
export async function pastePlainIntoEditor(): Promise<boolean> {
  const text = await readClipboardText()
  const ok = insertPlainText(text)
  if (!ok) {
    void useNotificationsStore().notify({
      level: 'info',
      title: i18n.global.t('editor.pastePlainEmpty'),
      mergeKey: 'paste-plain-empty'
    })
  }
  return ok
}
