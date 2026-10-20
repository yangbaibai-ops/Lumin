// ─── 原子写的**唯一实现**（报告 §6.2「IO 层没有单测」的落地）─────────────────────
//
// 为什么把它从 `fileOps.ts` 抽出来：写作工具最不能出错的一段就是落盘 —— "同目录临时文件 →
// fsync → rename" 这套纪律此前在 `fileOps.ts` 里**手抄了三遍**（文本写 / 二进制写 / 备份复制），
// 而那个文件 import 了 `electron`（回收站要用 `shell`）、`services/database`、`services/encoding`，
// 于是这段最该被单测钉死的代码在 `node --test` 里**根本 import 不进来**。
// 抽出来之后：本模块只依赖 node 内置（`fs/promises` + `path` + `crypto`），
// `tests/atomicWrite.test.mjs` 直接用临时目录跑 IO 断言（8 条）。
//
// 纪律（三条都不能少，报告 §4.1 的"数据安全"就靠它们）：
//   1. 临时文件与目标**同目录** —— 跨盘 rename 不是原子操作；
//   2. 先 `fsync` 再 rename —— 保证 rename 生效时数据已经落盘，而不是只改了目录项；
//      断电时不会出现"文件在、内容是空的"；
//   3. 临时文件名带**随机后缀** —— 两个写入者（两个窗口/两个进程）各写各的临时文件，
//      最后 rename 的是**完整**的一份，而不是"A 的头 + B 的尾"。
//
// ⚠️ 行为口径（与抽出前逐条一致，改这里等于改产品行为）：
//   * `requireParent: true`（默认，文本写）：父目录必须已存在，**绝不 mkdir -p** ——
//     目录被别处删掉后继续编辑并保存，旧行为会把目录凭空重建、文件以旧名复活，
//     用户以为删掉的东西又回来了且没有任何提示。抛 `PARENT_MISSING` 交给渲染层说人话。
//   * `requireParent: false`（二进制/备份/导出）：这些路径的语义本来就是"往一个新目录里放东西"。
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { beginAtomicWrite, endAtomicWrite } from './writeDrain.ts'

/** 临时文件后缀（与 `shared/tempName.ts` 的 `TEMP_SUFFIX_RE` 同源，测试会对照） */
export const TMP_SUFFIX = '.lumin-tmp'

/** 父目录不存在时抛的错误码（渲染层 `lib/errors.ts` 据此给一句本地化提示） */
export const PARENT_MISSING = 'PARENT_MISSING'

/** 给 `filePath` 生成一个同目录的临时路径（8 位随机后缀，防两个写入者互相覆盖） */
export function tempPathFor(filePath: string): string {
  return `${filePath}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`
}

export interface AtomicWriteOptions {
  /** 父目录必须已存在（默认 true）；false 时改为 `mkdir -p` */
  requireParent?: boolean
}

/**
 * 原子地把一份内容写到 `filePath`，返回**写完后**的真实 mtimeMs。
 *
 * `write` 负责把内容写到给定的临时路径（默认是 `fs.writeFile`；也可以传 `fs.copyFile`
 * 那种"内核搬字节"的实现）。fsync 与 rename 由本函数统一做 —— 这正是抽出来的意义：
 * 三个调用点不可能各自漏掉其中一步。
 *
 * 失败时清理临时文件并**原样抛出**（调用方负责把原因告诉用户）。
 */
export async function atomicWrite(
  filePath: string,
  write: (tmpPath: string) => Promise<void>,
  opts: AtomicWriteOptions = {}
): Promise<number> {
  const requireParent = opts.requireParent !== false
  const dir = path.dirname(filePath)
  if (requireParent) {
    const parent = await fs.stat(dir).catch(() => null)
    if (!parent?.isDirectory()) throw new Error(PARENT_MISSING)
  } else {
    await fs.mkdir(dir, { recursive: true })
  }

  const tmp = tempPathFor(filePath)
  /**
   * 清理必须放在 `finally` 里，而不是只放在 `catch` 里（用户报障：D 盘出现
   * `数学公式示例.md.be9947e7.lumin-tmp` 一直留到下次启动）。
   *
   * 只 catch 的话有两条漏法：
   *   1. **进程在 fsync/rename 途中退出**（关窗/退出不等待保存）——`catch` 根本没机会跑；
   *   2. `write` / `fsync` / `rename` 之外的异常（例如调用方在写入后自己抛）同样会绕过。
   * `finally` 保证"只要这个函数拿到了控制权回来"就一定收拾临时文件；rename 成功后临时名
   * 已经不存在，`fs.rm(force)` 是 no-op。错误仍然原样冒泡给调用方（不静默）。
   *
   * 注意：**同步退出**（`app.exit` / 被 taskkill）连 finally 也跑不到 —— 那一路由主进程退出前
   * 等待在飞的原子写（services/writeDrain.ts）+ 启动清扫兜底。
   */
  beginAtomicWrite()
  try {
    await write(tmp)
    await fsyncPath(tmp)
    await fs.rename(tmp, filePath)
  } finally {
    await fs.rm(tmp, { force: true }).catch((err: NodeJS.ErrnoException) => {
      // 清理失败不能污染成功结果，但也不能完全静默（否则又回到"用户看见残留、日志里没有"）
      if (err?.code !== 'ENOENT') {
        console.log(`[atomicWrite] cleanup failed: ${err?.code || err?.message || 'unknown'}`)
      }
    })
    endAtomicWrite()
  }
  // rename 之后再 stat：此刻磁盘上的就是刚写进去的那一份
  const st = await fs.stat(filePath)
  return st.mtimeMs
}

/** 打开并 fsync（`r+` 而不是 `r`：Windows 上只读句柄不允许 Sync） */
async function fsyncPath(file: string): Promise<void> {
  const handle = await fs.open(file, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 字节写（二进制通道：粘贴进来的图片等）。不碰编码与行尾。 */
export async function atomicWriteBytes(
  filePath: string,
  bytes: Uint8Array,
  opts: AtomicWriteOptions = {}
): Promise<number> {
  return atomicWrite(filePath, (tmp) => fs.writeFile(tmp, bytes), opts)
}

/**
 * 文本写：先编码成字节再走同一条原子路径。
 * `encode` 由调用方注入（`services/encoding.ts` 的 `encodeText`）——
 * 本模块不认识编码表，只保证"这些字节要么整份落盘、要么完全没动过"。
 */
export async function atomicWriteEncoded(
  filePath: string,
  encode: () => Buffer,
  opts: AtomicWriteOptions = {}
): Promise<number> {
  return atomicWrite(filePath, (tmp) => fs.writeFile(tmp, encode()), opts)
}

/** 原子复制（备份库文件：让内核搬字节，不把几百 MB 读进内存） */
export async function copyFileAtomic(source: string, destination: string): Promise<void> {
  await atomicWrite(destination, (tmp) => fs.copyFile(source, tmp), { requireParent: false })
}
