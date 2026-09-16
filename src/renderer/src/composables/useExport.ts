import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useNotificationsStore } from '../stores/notifications'
import { exportCss, renderMermaidInHtml } from '../lib/export'
import i18n from '../i18n'

// ─── 导出（渲染层）：基于 Tiptap getHTML() 输出 ────────────────────────────
export function useExport(): {
  runExport: (format: 'pdf' | 'html' | 'word' | 'epub') => Promise<void>
} {
  const files = useFilesStore()
  const ui = useUiStore()
  const settings = useSettingsStore()
  const editorStore = useEditorStore()
  const notifications = useNotificationsStore()

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
        // Pinia 响应式代理无法通过 IPC 结构化克隆（"could not be cloned"），
        // 必须展开为普通对象后再传，否则导出 PDF 必失败
        path = await window.luminAPI.export.pdf(
          { title: payload.title, html: payload.html, css: exportCss },
          { margin: settings.export.pdf.margin, pageSize: settings.export.pdf.pageSize }
        )
      } else if (format === 'html') {
        path = await window.luminAPI.export.html({
          title: payload.title,
          html: payload.html,
          css: exportCss
        })
      } else if (format === 'word') {
        path = await window.luminAPI.export.word({
          title: payload.title,
          html: payload.html,
          css: exportCss
        })
      } else {
        path = await window.luminAPI.export.epub({
          title: payload.title,
          author: 'Lumin',
          lang: settings.language,
          html: payload.html,
          css: exportCss
        })
      }
      if (path) ui.toast(i18n.global.t('toast.exportedTo', { path }), 'success')
    } catch (e) {
      // 失败原因作为「详情」展示：标题保持一行可扫读，细节不丢（同类失败自动合并为一条）
      void notifications.notify({
        level: 'error',
        title: i18n.global.t('toast.exportFailed'),
        body: e instanceof Error ? e.message : String(e)
      })
    }
  }

  return { runExport }
}
