// ─── 启动清扫：只清"确定是我们留下的、已经没用的"写盘临时文件 ─────────────────────
//
// 用户报障（D 盘 `数学公式示例.md.be9947e7.lumin-tmp` 一直留到下次启动）之后，清扫不能再
// 拿来当"保存路径漏清理"的挡箭牌；它只该处理**崩溃/断电**这种 finally 跑不到的残留。
// 同时它必须**选择性地**删 —— 以前的实现是"目录树里看到 `*.lumin-tmp` 就删"，这会误伤：
//   * 用户自己的文件恰好叫 `x.12345678.lumin-tmp`（或者别的工具用同一命名约定）；
//   * 目标文件已经被用户删掉/移走的孤儿临时文件（我们无从判断它还有没有价值）；
//   * **刚刚**才写出来的临时文件（另一个窗口/进程正在写，删掉等于破坏一次保存）。
//
// 现在的三条判据（缺一不可）：
//   1. **是本应用创建的**：文件名严格匹配 `<目标>.<8位十六进制>.lumin-tmp`
//      （唯一实现见 `shared/tempName.ts`；随机后缀在 `atomicWrite.tempPathFor` 里生成）；
//   2. **年龄 > 10 分钟**：正常的 `atomicWrite` 生命周期是毫秒级；超过 10 分钟还没 rename/清理，
//      只可能是崩溃残留。近期文件一律不碰（可能是别的进程正在写）；
//   3. **同目录还有对应目标文件**：`tempTargetName` 解析出的名字必须存在且是文件。
//      没有目标的孤儿不归我们清理（我们无法证明它是我们的、也无法证明它没用）。
//
// 不 import electron：`node --test` 可以用临时目录直接钉住选择性与"不误伤"。
import fs from 'fs/promises'
import path from 'path'
import { tempTargetName } from '../../shared/tempName.ts'

/** 判定"陈旧"的最小年龄（毫秒）：10 分钟 */
export const STALE_TEMP_MIN_AGE_MS = 10 * 60 * 1000

export interface CleanStaleTempOptions {
  /** 注入"现在"（测试用；默认 Date.now()） */
  now?: number
  /** 注入最小年龄（测试用；默认 10 分钟） */
  minAgeMs?: number
}

/**
 * 扫掉 `root` 目录树里**陈旧且确定是我们留下的**写盘临时文件，返回删除数量。
 *
 * 隐藏目录与 `node_modules` 跳过（与旧实现一致：那里不该有我们的临时文件，也不该被慢扫）。
 * 单个文件删除失败只跳过它，不打断整次清扫（启动路径不该因此失败）。
 */
export async function cleanStaleTempFiles(
  root: string,
  opts: CleanStaleTempOptions = {}
): Promise<number> {
  const now = opts.now ?? Date.now()
  const minAgeMs = opts.minAgeMs ?? STALE_TEMP_MIN_AGE_MS
  let removed = 0

  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        await walk(p)
        continue
      }
      const target = tempTargetName(e.name)
      if (!target) continue
      // 目标必须还在、而且是个文件（目录同名的"目标"不算）
      const targetStat = await fs.stat(path.join(dir, target)).catch(() => null)
      if (!targetStat?.isFile()) continue
      const st = await fs.stat(p).catch(() => null)
      if (!st?.isFile()) continue
      // 未来的 mtime（时钟回拨/同步盘）不当陈旧；必须**超过**最小年龄
      if (now - st.mtimeMs < minAgeMs) continue
      try {
        await fs.rm(p, { force: true })
        removed += 1
      } catch {
        /* 被占用/权限不足：跳过这一个，下次启动再试 */
      }
    }
  }

  await walk(root)
  return removed
}
