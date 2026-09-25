import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useEditorStore } from '../stores/editor'
import { useNotificationsStore } from '../stores/notifications'
import { getExportCss, renderMermaidInHtml } from '../lib/export'
import { exportRequest } from '../lib/exportPayload'
import type { ExportFormat } from '../lib/exportPayload'
import { beginExportRender, endExportRender } from '../lib/remoteImages'
import i18n from '../i18n'

// ─── 导出（渲染层）：基于 Tiptap getHTML() 输出 ────────────────────────────
export function useExport(): {
  runExport: (format: ExportFormat) => Promise<void>
} {
  const files = useFilesStore()
  const ui = useUiStore()
  const settings = useSettingsStore()
  const editorStore = useEditorStore()
  const notifications = useNotificationsStore()

  async function buildExportHtml(): Promise<{ html: string; title: string } | null> {
    if (!files.current) return null
    const editor = editorStore.instance
    // 远程图片的隐私闸门在浏览时把 `<img src>` 换成了占位；导出要的是**真实 HTML**，
    // 所以在这段同步窗口里放行（见 lib/remoteImages.ts 的 beginExportRender）。
    let raw: string
    beginExportRender()
    try {
      raw = editor ? editor.getHTML() : `<p>${files.current.content.replace(/\n/g, '<br>')}</p>`
    } finally {
      endExportRender()
    }
    const html = await renderMermaidInHtml(raw, settings.resolveTheme())
    return { html, title: files.current.name.replace(/\.(md|markdown|txt)$/i, '') }
  }

  async function runExport(format: ExportFormat): Promise<void> {
    const payload = await buildExportHtml()
    if (!payload) return
    try {
      // CSS（含 KaTeX 那份）按需取：只在真的要导出时才加载（见 lib/export.ts）。
      // 放在 try 里面：拉取失败也要变成一条可见的失败通知，而不是静默什么都不发生。
      const exportCss = await getExportCss()
      // 请求载荷的构造收口在 lib/exportPayload.ts（纯函数、有单测）：它把 Pinia 代理
      // **逐个字段摊平成普通对象** —— 代理过不了 IPC 的结构化克隆（"could not be cloned"），
      // 这是当年「导出 PDF 必失败」的根因。
      const req = exportRequest(
        format,
        { title: payload.title, html: payload.html, css: exportCss },
        {
          pdfMargin: settings.export.pdf.margin,
          pdfPageSize: settings.export.pdf.pageSize,
          language: settings.language,
          author: 'Lumin'
        }
      )
      /**
       * 发送表：`Record<ExportFormat, …>` —— **少一个格式 TypeScript 当场报错**，
       * 不再靠 if/else 链的最后一个 else 兜底（原先 epub 是 else 分支，
       * 将来加一种格式忘了改这里，它会静默走成 epub）。
       */
      const senders: Record<
        ExportFormat,
        (req: ReturnType<typeof exportRequest>) => Promise<string | null>
      > = {
        pdf: (r) =>
          window.luminAPI.export.pdf(
            r.args as Parameters<typeof window.luminAPI.export.pdf>[0],
            r.options as Parameters<typeof window.luminAPI.export.pdf>[1]
          ),
        html: (r) =>
          window.luminAPI.export.html(r.args as Parameters<typeof window.luminAPI.export.html>[0]),
        word: (r) =>
          window.luminAPI.export.word(r.args as Parameters<typeof window.luminAPI.export.word>[0]),
        epub: (r) =>
          window.luminAPI.export.epub(r.args as Parameters<typeof window.luminAPI.export.epub>[0])
      }
      const path = await senders[format](req)
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
