// ─── 打印预览窗口的**专用 preload**（只暴露它需要的两个动作）─────────────────────
//
// 为什么单独一份 preload，而不是复用应用主 preload：
//   * 这个窗口渲染的是**主进程生成的临时页面**（工具栏 + PDF 嵌入），它只需要
//     「打印」与「关闭」两个动作；把应用全套 API（草稿/备份/剪贴板/设置…）暴露进
//     一个"只是看 PDF"的窗口没有理由（最小权限）；
//   * 而且它要的接线逻辑（点按钮 → IPC → 把结果写回 DOM）放在能被 eslint/tsc 检查的
//     代码里，而不是拼进 `buildPrintPreviewHtml` 的字符串里。
//
// 页面本身**没有**内联脚本：这里在 DOMContentLoaded 时挂监听（preload 先于页面脚本执行）。
import { contextBridge, ipcRenderer } from 'electron'

export interface PrintPreviewResult {
  status: 'ok' | 'cancelled' | 'failed'
  /** 验收旁路：这一轮没有真的把任务交给系统打印（见 main/testPaths.ts 的 printDryRun） */
  dryRun?: boolean
  failureReason?: string
}

const api = {
  /** 用户在预览里点了「打印」→ 主进程走系统打印对话框（dry-run 时只记账） */
  print: (jobId: string) =>
    ipcRenderer.invoke('print:preview-print', jobId) as Promise<PrintPreviewResult>,
  /** 「关闭」→ 主进程销毁预览窗口并删掉临时目录 */
  close: (jobId: string) =>
    ipcRenderer.invoke('print:preview-close', jobId) as Promise<{ ok: boolean }>
}

contextBridge.exposeInMainWorld('luminPrintPreview', api)

declare global {
  interface Window {
    luminPrintPreview: typeof api
  }
}

/** 工具栏右侧那格状态文案 */
function setStatus(text: string): void {
  const el = document.querySelector('[data-print-preview-status]')
  if (el) el.textContent = text
}

/**
 * 把结果写回 `<body>` 的 data 属性：验收脚本据此断言"点打印真的走了打印通路"
 * （系统打印对话框没法在自动化里关掉，所以判据落在"主进程被调用且返回了什么"上）。
 */
function markResult(result: string, dryRun: boolean): void {
  const body = document.body
  if (!body) return
  body.setAttribute('data-print-preview-result', result)
  if (dryRun) body.setAttribute('data-print-preview-dry-run', 'true')
}

function msg(name: string): string {
  return document.body?.getAttribute(`data-print-preview-msg-${name}`) ?? ''
}

function wire(): void {
  const jobId = document.body?.getAttribute('data-print-preview-job') ?? ''
  const printBtn = document.querySelector('[data-print-preview-print]')
  const closeBtn = document.querySelector('[data-print-preview-close]')

  printBtn?.addEventListener('click', () => {
    setStatus(msg('printing'))
    void (async () => {
      try {
        const res = await api.print(jobId)
        if (res?.status === 'ok') {
          markResult('ok', !!res.dryRun)
          setStatus(msg('sent'))
        } else if (res?.status === 'cancelled') {
          markResult('cancelled', !!res.dryRun)
          setStatus(msg('cancelled'))
        } else {
          markResult('failed', !!res.dryRun)
          setStatus(msg('failed'))
        }
      } catch {
        markResult('failed', false)
        setStatus(msg('failed'))
      }
    })()
  })

  closeBtn?.addEventListener('click', () => {
    void api.close(jobId)
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire)
} else {
  wire()
}
