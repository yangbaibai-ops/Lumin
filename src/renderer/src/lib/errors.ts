/**
 * ─── 错误 → 一句能放进提示的「原因」──────────────────────────────────────────
 * 为什么需要它：以前失败一律 toast 一句「保存失败」/「无法按该编码重新打开」，用户和后来的我们
 * 都只能看到「失败了」，排查要多绕一轮（编码那次踩过，注释里写着「真出问题时这条日志就是线索」）。
 *
 * 两个处理：
 *  1. 削掉 Electron IPC 的前缀 —— 主进程抛错经 `ipcRenderer.invoke` 回来后是
 *     `Error invoking remote method 'file:write': Error: EPERM: operation not permitted, rename …`，
 *     对用户有意义的只有后面那段；
 *  2. 截断（默认 120 字符），避免把整段堆栈糊到 toast 上。
 */
export function errorReason(err: unknown, max = 120): string {
  const raw = err instanceof Error ? err.message : String(err)
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|TypeError|RangeError):\s*/, '')
    .trim()
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}
