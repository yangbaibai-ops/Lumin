// ─── 按目标路径串行化的写盘队列（审计 §2 P1：「同一文件可被两个窗口打开并各自保存」）───
//
// 渲染层的 `savePromise` 只能管住**同一个 store**（= 同一个窗口 / 同一份 Pinia）。
// 两个窗口是两个 store，各自 `await` 自己的写盘 —— 于是两次写会**并发**提交到主进程。
// 临时文件名已经带随机后缀（不会再出现"A 的头 + B 的尾"那种混写），但落盘顺序仍不确定，
// 而"谁最后落盘"决定了磁盘上是哪一份。
//
// 这里给主进程加一道按路径的队列：同一个目标的写依次进行（不同目标互不阻塞）。
// 配合 `file:write` 里的 mtime 冲突检测，后到的那次要么拿到冲突（不写、交给用户），
// 要么写出完整的一份 —— 不会再有两个窗口互相覆盖却谁也不知情的情况。
//
// 不 import electron：纯 Promise 编排，`node --test` 直接跑（tests/writeQueue.test.mjs）。

/** 路径归一（Windows 大小写不敏感 + 分隔符统一），保证同一个文件只用一条链 */
function normKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

const chains = new Map<string, Promise<unknown>>()

/**
 * 把 `run` 排到该路径的队尾。
 * * 前一次失败**不阻断**后一次（各自的错误由各自的调用方接住）；
 * * 链尾稳定后把条目从 Map 里删掉 —— 否则长期运行会为每个写过的文件留一个条目。
 */
export function serializeWrite<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const key = normKey(filePath)
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(run)
  // 队尾存"吞掉错误的版本"：它只用于排序，不影响本次调用的结果
  const tail = next.catch(() => {}) as Promise<unknown>
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return next
}

/** 当前队列长度（诊断/测试用） */
export function pendingWriteCount(): number {
  return chains.size
}
