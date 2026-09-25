// ─── HTML 转义（跨进程共用）───────────────────────────────────────────────────
//
// 审计 §10「重复实现」：`escapeHtml` 在 `main/export.ts` 与 `renderer/lib/utils/html.ts`
// 各有一份。两份的差别是致命的：导出那份少转一个字符，用户在正文里打出的
// `<script>` 就会原样进 HTML —— 而导出件是要被浏览器打开的。
// 收成一份（这里），两侧都用它。

/**
 * 转义 HTML 文本与属性值都能用的五个字符。
 *
 * 为什么连引号一起转：导出模板里这个值会出现在 `<title>`、`<dc:title>` 与（EPUB 的）
 * 属性位置上，只转 `&<>` 时属性里的 `"` 能直接闭合标签。
 */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
