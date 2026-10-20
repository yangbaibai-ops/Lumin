// ─── 原子写的临时文件命名（**唯一实现**）────────────────────────────────────
//
// 写盘走「同目录临时文件 → fsync → rename」（见 `main/fileOps.ts`），临时文件名是
// `<目标名>.<8位十六进制随机>.lumin-tmp`。这个名字有两处**必须一致**的读者：
//   1. `fileOps.cleanStaleTempFiles`：启动时扫掉崩溃残留（里面是用户全文的副本）；
//   2. `shared/backup.ts`：导出工作区快照时跳过它们（半写状态的文件不该进归档）。
//
// 所以把模式抽在这里，而不是在两个模块里各写一份正则 —— 审计 §10「重复实现」点名的
// 正是这种「两份实现迟早会漂」的地方。
export const TEMP_SUFFIX_RE = /\.[0-9a-f]{8}\.lumin-tmp$/i

/** 这个文件名是不是写盘临时文件（`note.md.a1b2c3d4.lumin-tmp`） */
export function isTempFileName(name: string): boolean {
  return TEMP_SUFFIX_RE.test(name)
}

/**
 * 从临时文件名反推它对应的目标文件名（`note.md.a1b2c3d4.lumin-tmp` → `note.md`）。
 *
 * 启动清扫只删"同目录确实还有目标文件"的残留（用户报障的修复要求之一）：
 * 没有目标的孤儿临时文件可能属于别人的工作流（或者目标已经被用户有意删掉），
 * 不能由我们顺手清理 —— 判据就是这里解析出来的名字在不在。
 *
 * 形状不对（没有 8 位十六进制后缀 / 后缀前没有名字）→ `null`。
 */
export function tempTargetName(name: string): string | null {
  const m = /^(.+)\.[0-9a-f]{8}\.lumin-tmp$/i.exec(name)
  return m ? m[1] : null
}
