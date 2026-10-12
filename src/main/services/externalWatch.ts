/**
 * ─── 「当前打开的文档被其他应用改了」的监测（第一百零八轮）──────────────────────
 *
 * 用户口径：**实时监测当前打开的文档的内容是否被其他应用修改**，被改了弹「检测到内容已被
 * 修改，是否重新加载」。
 *
 * 机制（三条腿，缺一条就会漏报或误报）：
 *   ① `fs.watch` 监听**文件所在目录**（非递归）并按 basename 过滤。为什么不直接 watch 文件：
 *      Windows 上"原子写/替换"（很多编辑器与同步盘都这么写）会换掉文件本身，直接 watch 文件
 *      在替换后就再也收不到事件了 —— 目录监听才稳。
 *   ② **stat 兜底轮询**（2s，比对 `mtimeMs + size`）：覆盖网络盘、以及"替换后 mtime 没变"
 *      这类 `fs.watch` 说不清的场景。
 *   ③ `fs.watch` 一次改动常连发多次 ⇒ **300ms 去抖**后再判定。
 *
 * 两类必须压住的噪声：
 *   * **自写**（Ctrl+S / 自动保存 / 草稿落盘之外的正文写盘）：`noteSelfWrite(path, rev)` 记下
 *     我们自己写出来的那一版；观察到同一版就绝不提示。「我们自己写的」这件事主进程最清楚
 *     （`file:write` 的返回里就有 mtime），所以判定放在这里，而不是让渲染层再报一遍。
 *   * **同一版重复提示**：每个窗口记住"已经提示过的那一版修订"（`prompted`）。用户点「暂不」
 *     也记这一版 —— 否则下一个轮询周期会再弹一次，变成骚扰。
 *
 * 监测范围：**每个窗口当前那一篇**（多窗口各自一篇）。渲染层在打开/切换/关闭文档时申报
 * （`watchDocument`），窗口销毁时清掉。
 */
import { watch, statSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'

/** 一版内容的标识：mtime + size 足够区分"又写了一次" */
export interface DocRevision {
  mtimeMs: number
  size: number
}

interface WatchedWindow {
  path: string | null
  dir: FSWatcher | null
  /** 当前观察到的这一版（用来判断"变了没有"） */
  last: DocRevision | null
  /** 我们已经提示过的那一版（去重） */
  prompted: DocRevision | null
  debounce: ReturnType<typeof setTimeout> | null
  poll: ReturnType<typeof setInterval> | null
}

/** 去抖窗口（fs.watch 一次改动常连发多次） */
const DEBOUNCE_MS = 350
/** stat 兜底轮询周期 */
const POLL_MS = 2000
/** 自写抑制窗（即便 stat 拿到的 mtime 因文件系统精度而不同，这段时间内也不提示） */
const SELF_WRITE_GRACE_MS = 1500

const watched = new Map<number, WatchedWindow>()
/** 我们自己写出来的那一版，按路径记（多个窗口打开同一篇时共享） */
const selfWritten = new Map<string, DocRevision & { at: number }>()

/** 同一版修订？容差 1ms：个别文件系统两次 stat 会差一点点小数位 */
function sameRevision(a: DocRevision | null, b: DocRevision | null): boolean {
  if (!a || !b) return false
  return Math.abs(a.mtimeMs - b.mtimeMs) < 1 && a.size === b.size
}

function keyOf(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function snapshot(p: string): DocRevision | null {
  try {
    const st = statSync(p)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    // 文件被删/被替换到一半：这一轮不算变化，下一轮再看
    return null
  }
}

/**
 * 登记"这一版是我们自己写的"（由 `file:write` 成功后调用）。
 *
 * 顺带把**正在监测同一篇的那些窗口**的 `last` 对齐到这一版：省掉一次"看起来变了"的误判，
 * 也让紧接着的 stat 轮询不会因为 mtime 精度差异而弹提示。
 */
export function noteSelfWrite(filePath: string, rev: DocRevision): void {
  const k = keyOf(filePath)
  selfWritten.set(k, { ...rev, at: Date.now() })
  // 表无限增长没意义：只留最近 64 条
  if (selfWritten.size > 64) {
    const oldest = [...selfWritten.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) selfWritten.delete(oldest[0])
  }
  for (const w of watched.values()) {
    if (w.path && keyOf(w.path) === k) {
      w.last = rev
      // 注意**不**动 `prompted`：提示过的那一版仍是那一版
    }
  }
}

function isOurWrite(filePath: string, rev: DocRevision): boolean {
  const rec = selfWritten.get(keyOf(filePath))
  if (!rec) return false
  if (Date.now() - rec.at > SELF_WRITE_GRACE_MS && !sameRevision(rec, rev)) return false
  return sameRevision(rec, rev) || Date.now() - rec.at <= SELF_WRITE_GRACE_MS
}

/**
 * 判定并（必要时）通知这一版是外部改的。
 *
 * 为什么"记下 `prompted`"要发生在**发送之前**：渲染层的提示是异步的，而轮询可能在同一
 * 时刻再跑一轮 —— 先记再发，任何时序下都只会提示一次。
 */
function observe(win: BrowserWindow, w: WatchedWindow, why: 'watch' | 'poll'): void {
  if (!w.path || win.isDestroyed()) return
  const rev = snapshot(w.path)
  if (!rev) return
  if (sameRevision(rev, w.last)) return
  if (sameRevision(rev, w.prompted)) {
    w.last = rev
    return
  }
  if (isOurWrite(w.path, rev)) {
    w.last = rev
    return
  }
  w.last = rev
  w.prompted = rev
  try {
    win.webContents.send('doc:externalChange', {
      path: w.path,
      mtimeMs: rev.mtimeMs,
      size: rev.size,
      why
    })
  } catch {
    /* 窗口正在销毁：忽略 */
  }
}

function stopWindowWatch(id: number): void {
  const w = watched.get(id)
  if (!w) return
  w.dir?.close()
  w.dir = null
  if (w.debounce) clearTimeout(w.debounce)
  if (w.poll) clearInterval(w.poll)
  w.debounce = null
  w.poll = null
}

/** 停止某窗口的监测（窗口销毁时调用） */
export function stopExternalWatch(win: BrowserWindow): void {
  stopWindowWatch(win.id)
  watched.delete(win.id)
}

/** 全部停止（应用退出时调用；测试里也可用来清场） */
export function stopAllExternalWatch(): void {
  for (const id of [...watched.keys()]) stopWindowWatch(id)
  watched.clear()
}

/**
 * 把某窗口的监测目标设成 `filePath`（`null` = 这篇没有磁盘文件/已关闭，停掉监测）。
 *
 * `knownMtimeMs` 是渲染层手头那一版的 mtime：**起始基线**必须用它，否则"刚打开就报外部
 * 改动"（第一次 stat 与"没有基线"看起来就是一次变化）。
 */
export function watchDocument(
  win: BrowserWindow,
  filePath: string | null,
  knownMtimeMs?: number
): void {
  stopWindowWatch(win.id)
  if (!filePath) {
    watched.delete(win.id)
    return
  }
  const seeded = snapshot(filePath)
  const baseline: DocRevision | null =
    knownMtimeMs !== undefined && seeded ? { mtimeMs: knownMtimeMs, size: seeded.size } : seeded
  const w: WatchedWindow = {
    path: filePath,
    dir: null,
    last: baseline,
    prompted: null,
    debounce: null,
    poll: null
  }
  watched.set(win.id, w)
  try {
    w.dir = watch(path.dirname(filePath), { persistent: false }, (_event, changed) => {
      // 目录里任何条目的变化都可能与目标有关；`changed` 在部分平台为 null ⇒ 只有能确认不是
      // 目标文件时才跳过
      if (changed && keyOf(String(changed)) !== keyOf(path.basename(filePath))) return
      if (w.debounce) clearTimeout(w.debounce)
      w.debounce = setTimeout(() => {
        w.debounce = null
        observe(win, w, 'watch')
      }, DEBOUNCE_MS)
    })
  } catch {
    // 目录不可监听（网络盘/权限）：轮询那条腿仍然在
    w.dir = null
  }
  w.poll = setInterval(() => observe(win, w, 'poll'), POLL_MS)
  // 轮询不阻止进程退出
  w.poll.unref?.()
}

/** 测试钩子：当前有没有在监测（以及目标），套件用来确认申报生效 */
export function watchedPathOf(win: BrowserWindow): string | null {
  return watched.get(win.id)?.path ?? null
}
