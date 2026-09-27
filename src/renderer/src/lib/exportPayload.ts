// ─── 导出请求的**纯构造层** ───────────────────────────────────────────────────
//
// 为什么单独一层（自查报告 H1 的副产物）：原来这段构造写在 `composables/useExport.ts` 里，
// 而它唯一的"测试"是两个 GUI 套件（`_verify-export-fix.js` / `_verify-export-fix2.js`）——
// 那两个套件靠 monkey-patch `window.luminAPI.export.pdf` 来截获调用，而 `contextBridge`
// 暴露的对象是**只读**的，补丁从来就没生效过（一个长期红、一个 0 断言）。
//
// 真正的风险点其实是一条纯逻辑：**传给 IPC 的必须是普通对象**。
// Pinia 的 state 是响应式代理，`structuredClone(proxy)` 会抛
// `DataCloneError: #<Object> could not be cloned` —— 曾导致"导出 PDF 必失败"。
// 所以把"显式摊平成普通对象"这件事收口到本模块，用单测钉死
// （`tests/exportPayload.test.mjs`：给一个 Proxy 当设置，断言产物可 structuredClone）。
//
// 本模块**零依赖**（只 import type），可以在 node 里直接跑，不需要 Electron。
import type { AppSettings, EpubMeta, ExportFormat, ExportPayload } from '../../../shared/types'

// 复述一遍 shared 里的联合类型，调用方不必同时 import 两个模块
export type { ExportFormat }

/** 导出所需的设置切片（都是**标量**，从 Pinia state 里逐个取出来） */
export interface ExportOptionsSlice {
  pdfMargin: AppSettings['export']['pdf']['margin']
  pdfPageSize: AppSettings['export']['pdf']['pageSize']
  language: AppSettings['language']
  author: string
}

/** 导出请求：`options` 只有 pdf 用得上（对应 preload 的第二个参数） */
export interface ExportRequest {
  /** 单参数通道（html / word / epub）的载荷，或 pdf 的第一个参数 */
  args: ExportPayload | EpubMeta
  /** pdf 的第二个参数；其余通道为 null */
  options: AppSettings['export']['pdf'] | null
}

/**
 * 构造一次导出请求。
 *
 * ⚠️ 每个字段都**显式写出**，绝不把 `settings.export.pdf` 这类代理对象直接塞进去 ——
 * 这正是当年"导出 PDF 必失败"的根因，也是本函数存在的理由。
 */
export function exportRequest(
  format: ExportFormat,
  doc: { title: string; html: string; css: string },
  opts: ExportOptionsSlice
): ExportRequest {
  const payload: ExportPayload = { title: doc.title, html: doc.html, css: doc.css }
  if (format === 'pdf') {
    return {
      args: payload,
      options: { margin: opts.pdfMargin, pageSize: opts.pdfPageSize }
    }
  }
  if (format === 'epub') {
    const meta: EpubMeta = {
      title: doc.title,
      author: opts.author,
      lang: opts.language,
      html: doc.html,
      css: doc.css
    }
    return { args: meta, options: null }
  }
  return { args: payload, options: null }
}

/**
 * 构造一次**打印**请求（审计 §7 第 18 条：此前只有 PDF 导出，没有真打印机）。
 *
 * 打印不是导出格式（不落盘、没有输出路径），但它需要的载荷与选项与 PDF 导出**逐字相同**：
 * 同一份 HTML + CSS（排版只有一个来源），同一份页面尺寸/边距设置（打印没有独立设置，
 * 用户在系统打印对话框里还能临时改纸张）。所以这里直接复用 `exportRequest('pdf', …)`，
 * 而不是另写一份字段拼装 —— 少一处会漂的重复实现。
 */
export function printRequest(
  doc: { title: string; html: string; css: string },
  opts: ExportOptionsSlice
): ExportRequest {
  return exportRequest('pdf', doc, opts)
}
