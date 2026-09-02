import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { exportCss, renderMermaidInHtml } from '../lib/export'

// ─── 导出（渲染层）：基于 Tiptap getHTML() 输出 ────────────────────────────
export function useExport(): { runExport: (format: 'pdf' | 'html' | 'word' | 'epub') => Promise<void> } {
  const files = useFilesStore()
  const ui = useUiStore()
  const settings = useSettingsStore()
  const editorStore = useEditorStore()

  async function buildExportHtml(): Promise<{ html: string; title: string } | null> {
    if (!files.current) return null
    const editor = editorStore.instance
    const raw = editor ? editor.getHTML() : `<p>${files.current.content.replace(/\n/g, '<br>')}</p>`
    const html = await renderMermaidInHtml(raw, settings.effectiveTheme)
    return { html, title: files.current.name.replace(/\.(md|markdown|txt)$/i, '') }
  }

  async function runExport(format: 'pdf' | 'html' | 'word' | 'epub'): Promise<void> {
    const payload = await buildExportHtml()
    if (!payload) return
    try {
      let path: string | null = null
      if (format === 'pdf') {
        path = await window.luminAPI.export.pdf(
          { title: payload.title, html: payload.html, css: exportCss },
          settings.export.pdf
        )
      } else if (format === 'html') {
        path = await window.luminAPI.export.html({ title: payload.title, html: payload.html, css: exportCss })
      } else if (format === 'word') {
        path = await window.luminAPI.export.word({ title: payload.title, html: payload.html, css: exportCss })
      } else {
        path = await window.luminAPI.export.epub({
          title: payload.title,
          author: 'Lumin',
          lang: settings.language,
          html: payload.html,
          css: exportCss
        })
      }
      if (path) ui.toast(`已导出到：${path}`, 'success', 4200)
    } catch {
      ui.toast('导出失败', 'error')
    }
  }

  return { runExport }
}
