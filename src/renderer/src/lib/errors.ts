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
// 语言包：错误码 → 用户看得懂的一句话（唯一实现见下面的 CODE_MESSAGES）
import i18n from '../i18n'
/**
 * 我们自己抛出的**稳定错误码** → 一句本地化的话。
 *
 * 为什么要有：主进程有些失败不是"系统错误"，而是我们的规则在拦（例如
 * `PARENT_MISSING` = 目标目录已经不在了，见 main/fileOps.writeFile 的说明）。
 * 直接把码丢给用户（"保存失败：PARENT_MISSING"）等于让他去猜。
 * 文案仍然走语言包（三语同步由 tests/i18nKeys.test.mjs 守）。
 */
const CODE_MESSAGES: Record<string, () => string> = {
  PARENT_MISSING: () => i18n.global.t('toast.saveParentMissing')
}

export function errorReason(err: unknown, max = 120): string {
  const raw = err instanceof Error ? err.message : String(err)
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|TypeError|RangeError):\s*/, '')
    .trim()
  const mapped = CODE_MESSAGES[cleaned]
  if (mapped) return mapped()
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}
