// ─── 打印预览：纯函数 + 静态守卫（第十一轮）─────────────────────────────────────
//
// 用户报障原话：「点击 `Ctrl+P` 打印的时候，出现的 Windows 打印窗口提示：**此应用不支持打印
// 预览**，可以优化使其**支持打印预览**吗。」
//
// 真因是平台限制：`webContents.print()` 只有系统对话框，Chromium 那套预览 UI 不在 Electron 里。
// 做法是自己做预览：先用**与 PDF 导出同一段流水**生成 PDF（`main/export.ts` 的 `buildPdfBytes`），
// 再在应用内的预览窗口里用内置查看器显示。这个文件钉住其中**可纯函数化**的部分与几条
// "不许走回头路"的静态约束（真正的端到端判定在 `tools/_verify-print-preview.js`）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PRINT_PREVIEW_ATTR,
  PRINT_PREVIEW_CSP,
  PRINT_PREVIEW_DIR_PREFIX,
  PRINT_PREVIEW_PDF,
  buildPrintPreviewHtml,
  countPdfPages,
  printPreviewDirName
} from '../src/shared/printPreview.ts'
import { blockedShortcut } from '../src/shared/shortcuts.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const LABELS = {
  title: '打印预览',
  print: '打印',
  close: '关闭',
  printing: '正在打印…',
  sent: '已发送到打印机',
  cancelled: '已取消打印',
  failed: '打印失败',
  unavailable: '预览生成失败'
}

test('PDF 页数：优先读页树的 /Count，退回数 /Type /Page，垃圾输入返回 0', () => {
  // 真实 Chromium PDF 的形状（对象流会压缩内容，但页树不压缩）
  const three =
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >>\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\n3 0 obj << /Type /Page /Parent 2 0 R >>\n4 0 obj << /Type /Page >>\n5 0 obj << /Type /Page >>\n%%EOF'
  assert.equal(countPdfPages(three), 3)
  // 没有 /Count：退回数单个页对象（注意 `/Type /Pages` 不算一页）
  const noCount = '<< /Type /Pages /Kids [] >> << /Type /Page >> << /Type /Page >>'
  assert.equal(countPdfPages(noCount), 2)
  // 数不出来时返回 0（调用方按"不确定"处理，绝不编造一个数字）
  for (const junk of ['', 'not a pdf', '%PDF-1.4\n<< /Type /Catalog >>']) {
    assert.equal(countPdfPages(junk), 0, JSON.stringify(junk))
  }
  // 也接受 Buffer / Uint8Array（主进程拿到的是 Buffer）
  assert.equal(countPdfPages(Buffer.from(three, 'latin1')), 3)
  assert.equal(countPdfPages(new Uint8Array(Buffer.from(three, 'latin1'))), 3)
})

test('临时目录名：固定前缀 + id 只留字母数字（不许带路径分隔符）', () => {
  assert.equal(printPreviewDirName('abc123'), PRINT_PREVIEW_DIR_PREFIX + 'abc123')
  // id 由主进程生成（`[a-z0-9]`），但这里仍要把危险字符清掉：目录名是要拼进路径的
  assert.equal(printPreviewDirName('../../etc/passwd'), PRINT_PREVIEW_DIR_PREFIX + 'etcpasswd')
  assert.equal(printPreviewDirName('a b/c\\d:e'), PRINT_PREVIEW_DIR_PREFIX + 'abcde')
  assert.ok(printPreviewDirName('x').startsWith(PRINT_PREVIEW_DIR_PREFIX))
})

test('预览页：严格 CSP（frame-src file: 是关键）、本地 PDF、零网络、零内联脚本', () => {
  const html = buildPrintPreviewHtml({
    labels: LABELS,
    pages: 4,
    pagesText: '共 4 页',
    jobId: 'job42'
  })
  // 严格 CSP：默认什么都不许
  assert.match(html, new RegExp(PRINT_PREVIEW_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(html, /default-src 'none'/)
  /**
   * ⚠️ `frame-src file:` 这条是**实测踩出来的**：Chromium 把 `<embed type="application/pdf">`
   * 当嵌套框架管，读的是 `frame-src`；只写 `object-src` 时 `default-src 'none'` 兜上去，
   * PDF 根本不会被取（第一版套件因此红：`Framing 'file:///…/preview.pdf' violates …`）。
   */
  assert.match(html, /frame-src file:/, 'PDF 嵌入走 frame-src，缺了它预览就是一片空白')
  assert.match(html, /object-src file:/)
  // 不许有 frame-ancestors：它在 <meta> 里被忽略（第九轮实测），生效的那份由响应头下发
  assert.doesNotMatch(html, /frame-ancestors/, '<meta> 里的 frame-ancestors 等于没写')
  // 本地 PDF + 零网络
  assert.match(
    html,
    new RegExp(`<embed[^>]+type="application/pdf"[^>]+src="\\./${PRINT_PREVIEW_PDF}"`)
  )
  assert.doesNotMatch(html, /https?:\/\//, '预览页不许引用任何网络资源（离线可用是硬要求）')
  assert.doesNotMatch(html, /\/\//, '连协议相对 URL 也不许')
  // 逻辑不写在字符串里：页面没有内联 <script>，接线在 src/preload/printPreview.ts
  assert.doesNotMatch(html, /<script/i, '预览页不许有内联脚本（逻辑在专用 preload 里）')
  // 语义锚点（套件按它们定位，不按本地化文案）
  for (const attr of [
    PRINT_PREVIEW_ATTR,
    'data-print-preview-print',
    'data-print-preview-close',
    'data-print-preview-pdf',
    'data-print-preview-status',
    'data-print-preview-job',
    'data-print-preview-pages',
    'data-print-preview-msg-printing',
    'data-print-preview-msg-sent',
    'data-print-preview-msg-cancelled',
    'data-print-preview-msg-failed'
  ]) {
    assert.ok(html.includes(attr), '缺锚点：' + attr)
  }
  // 文案真的进了页面（页数用调用方取好的整句）
  for (const s of ['打印预览', '打印', '关闭', '共 4 页'])
    assert.ok(html.includes(s), '缺文案：' + s)
  assert.match(html, /data-print-preview-pages="4"/)
  assert.match(html, /data-print-preview-job="job42"/)
})

test('预览页：页数为 0 时不显示页码那格；文案里的 HTML 被转义', () => {
  const noPages = buildPrintPreviewHtml({
    labels: LABELS,
    pages: 0,
    pagesText: '共 0 页',
    jobId: 'x'
  })
  assert.doesNotMatch(noPages, /共 0 页/)
  const evil = buildPrintPreviewHtml({
    labels: { ...LABELS, title: '<img src=x onerror=alert(1)>', print: '"quoted"' },
    pages: 1,
    pagesText: '共 1 页',
    jobId: 'x'
  })
  assert.doesNotMatch(evil, /<img/)
  assert.match(evil, /&lt;img/)
  assert.match(evil, /&quot;quoted&quot;/)
})

test('三语都备好预览文案，且都非空', () => {
  const keys = [
    'title',
    'print',
    'close',
    'pages',
    'printing',
    'sent',
    'cancelled',
    'failed',
    'unavailable'
  ]
  for (const lang of ['zh-CN', 'en-US', 'ru-RU']) {
    const pack = JSON.parse(read(`src/shared/i18n/${lang}.json`))
    for (const k of keys) {
      const v = pack?.printPreview?.[k]
      assert.equal(
        typeof v === 'string' && v.trim().length > 0,
        true,
        `${lang} 缺 printPreview.${k}`
      )
    }
  }
  const zh = JSON.parse(read('src/shared/i18n/zh-CN.json')).printPreview
  const en = JSON.parse(read('src/shared/i18n/en-US.json')).printPreview
  assert.notEqual(zh.title, en.title, '英文标题不该与中文一模一样')
  assert.match(zh.pages, /\{n\}/, '「共 N 页」必须带 {n} 占位符（页数由调用方填）')
})

test('Ctrl+P 仍是应用自己的键（不许被浏览器级拦截吃掉），命令仍绑在 Mod+P', () => {
  const key = (name, mods = {}) => ({
    key: name,
    code: '',
    alt: false,
    shift: false,
    meta: false,
    control: false,
    ...mods
  })
  assert.equal(blockedShortcut(key('p', { control: true })), null, 'Mod+P 必须放行给应用（打印）')
  assert.equal(blockedShortcut(key('P', { meta: true })), null)
  const km = read('src/renderer/src/composables/useKeymap.ts')
  assert.match(km, /id:\s*'file\.print'/, 'file.print 命令还在')
  assert.match(km, /defaultKeys:\s*'Mod\+P'/, 'file.print 仍默认绑 Mod+P')
})

test('打印与 PDF 导出共用同一段流水（不许出现第二份排版/分页实现）', () => {
  const exp = read('src/main/export.ts')
  // 唯一实现：buildPdfBytes 里调 printToPDF；exportPdf 与预览都调 buildPdfBytes
  assert.match(exp, /export async function buildPdfBytes/)
  assert.match(
    exp,
    /export async function exportPdf[\s\S]*?await buildPdfBytes\(/,
    '导出 PDF 必须用这段'
  )
  const preview = read('src/main/printPreview.ts')
  assert.match(preview, /buildPdfBytes\(payload, settings\)/, '预览必须复用导出的那段')
  assert.match(
    preview,
    /printDocument\(job\.payload, job\.settings\)/,
    '预览里的打印要走既有打印通路'
  )
  // 只允许一处真的调 printToPDF（两份实现迟早漂）；`webContents.printToPDF(` 之外的提及
  // 都是注释（说明口径），所以按"带点的调用"计数
  const calls = [...exp.matchAll(/\.printToPDF\(/g)].length
  assert.equal(calls, 1, `export.ts 里 printToPDF 调用只该有一处，实测 ${calls}`)
})

test('预览窗口：专用 preload + 沙箱；打印旁路只在未打包实例生效', () => {
  const preview = read('src/main/printPreview.ts')
  const exp = read('src/main/export.ts')
  assert.match(
    preview,
    /preload:\s*path\.join\(__dirname, '\.\.\/preload\/printPreview\.js'\)/,
    '预览窗口要用专用 preload'
  )
  assert.match(preview, /sandbox:\s*true/)
  assert.match(preview, /contextIsolation:\s*true/)
  assert.match(preview, /nodeIntegration:\s*false/)
  // 临时目录必须在 app.getPath('temp') 下（不许往工作区/用户文档目录写）
  assert.match(preview, /app\.getPath\('temp'\)/)
  // 三条出路都要清目录：窗口关闭 / 关闭按钮 / 退出兜底
  assert.match(preview, /win\.on\('closed'/)
  assert.match(preview, /export function cleanupPrintPreviews/)
  // 旁路变量仅在非打包实例生效（与 LUMIN_EXPORT_DIR / LUMIN_OPEN_EXTERNAL_DRY_RUN 同一口径）
  const testPaths = read('src/main/testPaths.ts')
  assert.match(testPaths, /export function printDryRun\(\)[\s\S]{0,200}?!app\.isPackaged/)
  assert.match(exp, /printDryRun\(\)/, '打印通路要用这个旁路（自动化里不弹原生对话框）')
  assert.match(exp, /dryRun:\s*true/, 'dry-run 的结果要带上标记，验收据此断言"走了打印通路"')
})
