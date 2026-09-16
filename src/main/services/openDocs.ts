import { BrowserWindow } from 'electron'

/**
 * ─── 「哪个窗口开着哪个文档」注册表 ────────────────────────────────────────
 * 用途：避免同一个文件被两个窗口重复打开——打开一个已经开在别处的文件时，
 * 应该把那个窗口唤到前面，而不是再开一个（主流编辑器都是这个行为）。
 *
 * 数据来源：渲染层在文档切换时通过 `window:docPath` 上报（**精确**，不依赖会话
 * 槽位那套 800ms 节流写库），窗口关闭时自动清掉，不存在过期条目。
 */
const docOfWindow = new Map<number, string>()

/** 路径归一：Windows 大小写不敏感 + 分隔符统一（与渲染层 lib/openFile.ts 的判据一致） */
function norm(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 渲染层上报：本窗口当前打开的文档（null = 未打开文档 / 回到未命名缓冲区） */
export function setWindowDoc(win: BrowserWindow, docPath: string | null): void {
  if (docPath) docOfWindow.set(win.id, docPath)
  else docOfWindow.delete(win.id)
}

/** 窗口关闭时清账（避免把已销毁窗口留在表里） */
export function forgetWindow(winId: number): void {
  docOfWindow.delete(winId)
}

/**
 * 当前所有窗口打开着的文档路径（去重）。
 * 用途：`lumin-file://` 协议的访问白名单 —— 只放行「工作区之内」或「某个已打开文档所在目录之内」
 * 的媒体文件（见 main/index.ts 的 protocol.handle）。
 */
export function listOpenDocs(): string[] {
  const out = new Set<string>()
  for (const [id, p] of docOfWindow) {
    const win = BrowserWindow.fromId(id)
    if (!win || win.isDestroyed()) {
      docOfWindow.delete(id)
      continue
    }
    out.add(p)
  }
  return [...out]
}

/**
 * 找出正开着这个文件的窗口。
 * 先排除调用方自己的窗口（「同一个文件在本窗口已打开」由渲染层先判掉，这里做兜底：
 * 若唯一命中就是调用方，就返回它，调用方据此返回「已聚焦」而不是再开一个窗口）。
 */
export function findWindowWithDoc(docPath: string, excludeWinId?: number): BrowserWindow | null {
  const want = norm(docPath)
  const alive = (): { id: number; win: BrowserWindow }[] => {
    const out: { id: number; win: BrowserWindow }[] = []
    for (const [id, p] of docOfWindow) {
      if (norm(p) !== want) continue
      const win = BrowserWindow.fromId(id)
      if (!win || win.isDestroyed()) {
        docOfWindow.delete(id)
        continue
      }
      out.push({ id, win })
    }
    return out
  }
  const hits = alive()
  const other = hits.find((h) => h.id !== excludeWinId)
  return (other ?? hits[0])?.win ?? null
}

/**
 * 把窗口唤到前面：必要时先从最小化还原，再显示 + 聚焦（Windows 任务栏随之激活）。
 *
 * 注意不能只用 `isMinimized()` 判断：窗口在应用处于后台时被最小化，Electron 可能报
 * `isMinimized() === false`，只调 `focus()` 会得到「焦点给了它、但它还最小化着」的怪状态
 * （实测：`document.hasFocus() === true` 且 `visibilityState === 'hidden'`）。
 * 因此以「不可见」为准一起判断，`restore()` 对非最小化窗口本就是 no-op。
 */
export function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized() || !win.isVisible()) {
    win.restore()
    win.show()
  }
  win.focus()
}
