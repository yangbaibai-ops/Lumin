// ─── 本窗口的会话槽位（可**延迟认领**）──────────────────────────────────────────
//
// 背景（启动重构）：为了让窗口先出来，主进程不再在「建窗口之前」读库算恢复计划，
// 于是启动窗口建出来时**还没有槽位**，只带一个 `--lumin-startup-head=1` 标记
// （见 main/index.ts 的 createWindow 与 preload 的 startupRestoreHead）。
//
// 口径：
//   * 普通窗口（新建窗口 / 在新窗口打开…）创建时就有槽位 —— 这里直接用它；
//   * 启动窗口在**第一次需要槽位时**（恢复会话 / 保存会话 / 认领未命名草稿）向主进程
//     认领一次（`app:claimStartupSlot`，主进程那边会等库就绪并按恢复计划分配）；
//   * 认领是幂等的：并发调用共用同一个 Promise，重复调用返回同一结果；
//   * 失败不缓存：下一次调用会重试（不让一次瞬时 IPC 失败把会话功能永久钉死）。
//
// 为什么单独一个模块：`lib/session.ts`（会话）与 `stores/files.ts`（草稿键）都要这个值，
// 而 files → session 直接互相 import 会成环。这里只依赖 preload 暴露的只读 API，是叶子模块。
let slot: number | null = window.luminAPI.app.sessionSlot
let claimed = slot !== null
let pending: Promise<number | null> | null = null

/** 当前已知槽位（未认领时为 null；同步、零 IPC） */
export function currentSessionSlot(): number | null {
  return slot
}

/** 确保槽位已就绪（懒认领；非启动窗口直接返回创建时给的值） */
export async function ensureSessionSlot(): Promise<number | null> {
  if (claimed) return slot
  if (!window.luminAPI.app.startupRestoreHead) {
    claimed = true
    return slot
  }
  if (!pending) {
    pending = window.luminAPI.app
      .claimStartupSlot()
      .then((n) => {
        if (n !== null) slot = n
        claimed = true
        pending = null
        return slot
      })
      .catch(() => {
        // 不置 claimed：下一次再试（恢复会话/写会话都会再调）
        pending = null
        return slot
      })
  }
  return pending
}
