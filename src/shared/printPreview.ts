// ─── 打印预览（纯函数 + 类型）：主进程与单测共用 ────────────────────────────────
//
// 为什么需要"打印预览"：`webContents.print()` 只弹**系统**打印对话框 —— Chromium 那套带缩略图
// 的打印预览 UI 是 Chrome 浏览器的功能，Electron 里没有。所以 Windows 的对话框会明说
// 「此应用不支持打印预览」（用户报障第十一轮的原话）。做法就是**自己做预览**：
// 先用与 PDF 导出**同一份**渲染/分页口径生成 PDF → 在应用内的预览窗口里显示 → 用户确认后再打印。
//
// 这个文件里的三件事都是纯的（无 Electron 依赖，单测直接 import）：
//   * `printPreviewDirName` —— 临时目录命名（前缀固定，验收脚本按它 glob/清理）；
//   * `countPdfPages`       —— 从 PDF 字节里数页数（预览要显示"共 N 页"，验收也要用它对齐）；
//   * `buildPrintPreviewHtml` —— 预览窗口那一页（工具栏 + `<embed>` 指向同目录的 preview.pdf）。
//
// ⚠️ 预览页**不许**引任何网络资源（用户口径 + 离线可用）：没有 CDN、没有外链字体、没有
//    `http(s)://`。它只引用同目录的 `./preview.pdf`，脚本只调 preload 暴露的两个 IPC。
//    `tests/printPreview.test.mjs` 会静态断言这一点。

/** 预览临时目录名的固定前缀（验收脚本按 `%TEMP%/lumin-print-preview-*` 找与清理） */
export const PRINT_PREVIEW_DIR_PREFIX = 'lumin-print-preview-'

/** 预览窗口加载的那一页的文件名 */
export const PRINT_PREVIEW_PAGE = 'index.html'

/** 预览用的 PDF 文件名（与页面同目录，页面里用相对路径引用） */
export const PRINT_PREVIEW_PDF = 'preview.pdf'

/** 预览页里那枚「打印」按钮的语义锚点（验收按它点，不按本地化文案找） */
export const PRINT_PREVIEW_ATTR = 'data-print-preview'

/**
 * 预览页的 CSP（我们**自己生成**的那一页）。
 *
 * 口径：这一页只干两件事 —— 显示几行文案（内联样式）与把**同目录**那份 PDF 交给内置查看器。
 * 所以严格到：默认什么都不许、不许联网、不许表单、不许 `<base>`，只放行内联样式与
 * 本地的 `file:`。
 *
 * ⚠️ **`frame-src file:` 是必须的，`object-src file:` 不够**：实测（本轮第一次跑套件时红）
 * Chromium 把 `<embed type="application/pdf">` 当**嵌套框架**管，于是读 `frame-src`；
 * 只写 `object-src` 时 `default-src 'none'` 兜上去，控制台报
 * `Framing 'file:///…/preview.pdf' violates … "default-src 'none'"`，PDF 根本不会被取。
 *
 * ⚠️ **不写 `frame-ancestors`**：它在 `<meta>` 里会被浏览器忽略（第九轮实测过），
 * 真正生效的那份由主进程的响应头统一下发（`shared/csp.ts` 的 `CSP_HEADER_ONLY`）。
 */
export const PRINT_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-src file:; object-src file:; img-src file:; base-uri 'none'; form-action 'none'"

/** 临时目录名：前缀 + 作业 id（id 由主进程生成，只含 `[a-z0-9]`） */
export function printPreviewDirName(id: string): string {
  const safe = String(id ?? '').replace(/[^a-z0-9]/gi, '')
  return `${PRINT_PREVIEW_DIR_PREFIX}${safe}`
}

/**
 * PDF 页数。
 *
 * 为什么不用 PDF 库：只为读一个数字引依赖不划算（仓库对依赖很克制），而 Chromium 生成的
 * PDF 结构稳定：页树里必有 `/Type /Pages` + `/Count N`（对象流压缩的是**内容**，页树本身
 * 不压缩）。这里先找 `/Count`，找不到再退回数 `/Type /Page` 出现次数；两者都没有时返回 0
 * （调用方按 0 处理成"不确定"，绝不编造一个数字）。
 *
 * 注意 `/Type /Page` 与 `/Type /Pages` 的前缀关系：用 `[^s]` 把页树节点排除掉。
 */
export function countPdfPages(data: Uint8Array | Buffer | string): number {
  const text = typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('latin1')
  const count = /\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/.exec(text)
  if (count) {
    const n = Number(count[1])
    if (Number.isFinite(n) && n > 0) return n
  }
  const pages = text.match(/\/Type\s*\/Page[^s]/g)
  return pages ? pages.length : 0
}

/** 预览页上要显示的一句句文案（由主进程按当前语言取好再传进来） */
export interface PrintPreviewLabels {
  /** 窗口/工具栏标题：「打印预览」 */
  title: string
  /** 「打印」 */
  print: string
  /** 「关闭」 */
  close: string
  /** 「正在打印…」 */
  printing: string
  /** 「已发送到打印机」 */
  sent: string
  /** 「已取消打印」 */
  cancelled: string
  /** 「打印失败」 */
  failed: string
  /** 预览生成失败时的提示（理论上到不了这一页） */
  unavailable: string
}

/**
 * 预览窗口的那一页：上面一条工具栏（标题 + 页数 + 「打印」「关闭」），下面整块是 PDF。
 *
 * **这一页里没有一行脚本**：交互由专用 preload（`src/preload/printPreview.ts`）接线 ——
 * 页面只提供语义锚点（`data-print-preview-*`）与文案 `data-*` 属性，逻辑在能被
 * eslint/tsc 检查的代码里，而不是拼在字符串里的内联 `<script>`。
 *
 * 结果也写回 DOM（`data-print-preview-result` / `data-print-preview-dry-run`）：
 * 验收脚本据此断言"点打印真的走了打印通路"，不必去猜系统对话框有没有弹。
 */
export function buildPrintPreviewHtml(opts: {
  labels: PrintPreviewLabels
  /** 页数（0 = 数不出来，不显示页码那格） */
  pages: number
  /** 已带页数的「共 N 页」整句（由调用方用当前语言 + 真实页数取好） */
  pagesText: string
  /** 作业 id（按钮回调要带回去） */
  jobId: string
}): string {
  const { labels, pages, pagesText, jobId } = opts
  const esc = (s: string): string =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${esc(PRINT_PREVIEW_CSP)}" />
<title>${esc(labels.title)}</title>
<style>
  :root { color-scheme: light dark }
  html, body { margin: 0; height: 100% }
  body {
    display: flex; flex-direction: column;
    font: 13px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
    background: #525659; color: #e8e8e8;
  }
  .bar {
    display: flex; align-items: center; gap: 10px;
    height: 40px; flex: none; padding: 0 12px;
    background: #323639; border-bottom: 1px solid #1f2224;
  }
  .bar .t { font-weight: 600 }
  .bar .p { opacity: .75 }
  .bar .s { margin-left: auto; opacity: .9 }
  button {
    font: inherit; padding: 5px 14px; border-radius: 6px;
    border: 1px solid #6b7073; background: #3c4144; color: #f2f2f2; cursor: pointer;
  }
  button:hover { background: #4a5054 }
  button.primary { background: #2f6fd0; border-color: #2f6fd0 }
  button.primary:hover { background: #3b7ee0 }
  embed { display: block; flex: 1 1 auto; width: 100%; border: 0 }
</style>
</head>
<body ${PRINT_PREVIEW_ATTR}="true" data-print-preview-job="${esc(jobId)}" data-print-preview-pages="${pages}"
      data-print-preview-msg-printing="${esc(labels.printing)}"
      data-print-preview-msg-sent="${esc(labels.sent)}"
      data-print-preview-msg-cancelled="${esc(labels.cancelled)}"
      data-print-preview-msg-failed="${esc(labels.failed)}">
  <div class="bar">
    <span class="t">${esc(labels.title)}</span>
    ${pages > 0 ? `<span class="p">${esc(pagesText)}</span>` : ''}
    <span class="s" data-print-preview-status></span>
    <button class="primary" data-print-preview-print>${esc(labels.print)}</button>
    <button data-print-preview-close>${esc(labels.close)}</button>
  </div>
  <embed type="application/pdf" src="./${PRINT_PREVIEW_PDF}" data-print-preview-pdf />
</body>
</html>
`
}
