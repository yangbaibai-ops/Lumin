// ─── PDF 页眉/页脚模板（审计 §7 第 18 条）────────────────────────────────────
//
// Chromium 的 `headerTemplate` / `footerTemplate` 是**独立 HTML 片段**：
//   * 不继承页面样式，所以字号/颜色/字体必须写在行内；
//   * 只有 `.pageNumber` / `.totalPages` / `.title` / `.date` 这几个类会被替换成真值；
//   * 它们画在**页边距区**里，因此上下边距必须留够（见 main/export.ts 的 headerFooterGap）。
//
// 放 shared 是为了能被单测直接钉住"模板里确实带了页码占位符" —— 这是"PDF 有页眉页脚"
// 这条交付唯一的可自动验证证据（PDF 里文字是矢量绘制，解析断言不值得）。
import { escapeHtml } from './html.ts'

const STYLE =
  'width:100%;font-size:8px;color:#8a919e;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;'

/** 页眉：右对齐的文档标题（长标题会被 Chromium 截断，不做处理） */
export function pdfHeaderTemplate(title: string, marginInch: number): string {
  return `<div style="${STYLE}padding:0 ${marginInch}in;text-align:right;">${escapeHtml(title)}</div>`
}

/** 页脚：居中的「当前页 / 总页数」 */
export function pdfFooterTemplate(marginInch: number): string {
  return `<div style="${STYLE}padding:0 ${marginInch}in;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
}
