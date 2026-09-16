// ─── 屏蔽 node:sqlite 的实验性警告 ──────────────────────────────────────
// Electron 内置的 Node 会把 `node:sqlite` 标记为实验特性，导入时向控制台打印
// "(node:xxx) ExperimentalWarning: SQLite is an experimental feature and might
// change at any time"。该模块功能正常、警告无实际影响；这里在「任何会导入
// node:sqlite 的模块之前」加载本文件，过滤掉这条噪音，保持 dev 控制台干净。
const originalEmitWarning = process.emitWarning.bind(process) as (
  warning: unknown,
  typeOrOptions?: unknown,
  code?: unknown
) => void

process.emitWarning = ((warning: unknown, typeOrOptions?: unknown, code?: unknown): void => {
  const message = typeof warning === 'string' ? warning : ((warning as Error)?.message ?? '')
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : ((typeOrOptions as { type?: string } | undefined)?.type ?? '')
  if (type === 'ExperimentalWarning' && String(message).includes('SQLite')) return
  originalEmitWarning(warning, typeOrOptions, code)
}) as typeof process.emitWarning
