import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { analyzeDoc, renderFull, renderMermaidInHtml } from '../lib/markdown'
import { exportCss } from '../lib/exportCss'

export function useExport(): { runExport: (format: 'pdf' | 'html' | 'word' | 'epub') => Promise<void> } {
  const files = useFilesStore()
  const ui = useUiStore()
  const settings = useSettingsStore()

  async function buildExportHtml(): Promise<{ html: string; title: string } | null> {
    if (!files.current) return null
    const analysis = analyzeDoc(files.current.content)
    let baseDir: string | null = null
    if (files.current.path) {
      baseDir = await window.luminAPI.file.dirname(files.current.path)
    } else {
      baseDir = files.root
    }
    const html = renderFull(files.current.content, {
      slugCursor: analysis.slugCursor,
      headings: analysis.headings,
      baseDir
    })
    const final = await renderMermaidInHtml(html, settings.effectiveTheme)
    return { html: final, title: files.current.name.replace(/\.(md|markdown|txt)$/i, '') }
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
      if (path) ui.toast(`已导出到：${path}`, 'success', 4200)
    } catch {
      ui.toast('导出失败', 'error')
    }
  }

  return { runExport }
}
