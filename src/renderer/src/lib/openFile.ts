import { watch } from 'vue'
import { useFilesStore } from '../stores/files'
import { isInside, samePath } from './pathUtils'

// 判据统一放在 lib/pathUtils（主进程与渲染层同一套语义：大小写不敏感 + 分隔符归一 + 目录边界）；
// 这里再转出去，调用方（如 renderer/src/main.ts）可以就近从 openFile 引用。
export { isInside, samePath }

/**
 * ─── 打开「窗口外的文件」（Ctrl+O / 打开文件 / 拖文件进窗口）────────────────
 * 统一落点规则（侧栏 = 工作区，必须能看见刚打开的文件；同一个文件只有一个窗口）：
 *
 *  1. **这个文件已经在本窗口打开** → 什么都不做：不重复打开，也不新建窗口；
 *  2. **该文件已开在别的窗口** → 把那个窗口唤到前面（必要时从最小化还原），不新建窗口。
 *     这一条要排在第 3 条之前：否则「本窗口没有文件夹」时会把一个已经在别处开着的
 *     文件又在本窗口开一份，同一个文件就同时占两个窗口了；
 *  3. **本窗口没有打开任何文件夹** → 就在本窗口打开，并把侧栏切到文件所在文件夹；
 *  4. **本窗口已打开文件夹**（且没人开着这个文件）→ 在新窗口打开，并让**新窗口**的
 *     侧栏对准该文件的文件夹（新窗口里若文件本来就在继承来的工作区内，就保持原工作区，
 *     不做无谓的缩小）。
 *
 * 只负责「外部打开」这一条语义：侧栏树里点文件（同一工作区内切换）、右键
 * 「在新窗口打开」（用户显式要求新窗口）、文档内链接点击都有各自既定行为。
 *
 * @returns 'already-open' | 'focused-existing' | 'opened-here' | 'opened-in-new-window'
 */
export async function openExternalFile(
  path: string
): Promise<'already-open' | 'focused-existing' | 'opened-here' | 'opened-in-new-window'> {
  const files = useFilesStore()

  // ① 已经在本窗口打开 → 不重复打开、不新建窗口
  if (samePath(files.current?.path, path)) return 'already-open'

  // ② 已开在别的窗口 → 聚焦那个窗口（必须早于「本窗口直接打开」的判断）
  const focused = await window.luminAPI.app.focusWindowByDoc(path).catch(() => 'not-open')
  if (focused === 'focused') return 'focused-existing'

  // ③ 本窗口没有工作区 → 在本窗口打开，并把侧栏切到文件所在文件夹
  if (!files.root) {
    const ok = await files.openPath(path)
    if (ok) {
      await files.setRoot(await window.luminAPI.file.dirname(path))
    }
    return ok ? 'opened-here' : 'already-open'
  }

  // ④ 已有工作区且没人开着 → 新窗口打开（新窗口自己把侧栏对准该文件的文件夹）
  window.luminAPI.app.openInNewWindow(path)
  return 'opened-in-new-window'
}

/**
 * 「在新窗口打开一个文件」的统一入口：先问主进程这个文件是不是已经开在某个窗口里，
 * 是就把那个窗口唤到前面（本窗口开着则原样不动），否则才真的新建窗口。
 * 最近文档 / 侧栏最近文档下拉都走这里，保证「一个文件只开一个窗口」。
 *
 * 例外：侧栏树的右键「在新窗口打开」是**显式**要求新窗口，直接走 openInNewWindow。
 */
export async function openInWindowOrFocus(
  path: string
): Promise<'focused-existing' | 'opened-in-new-window'> {
  const focused = await window.luminAPI.app.focusWindowByDoc(path).catch(() => 'not-open')
  if (focused === 'focused') return 'focused-existing'
  window.luminAPI.app.openInNewWindow(path)
  return 'opened-in-new-window'
}

/**
 * 安装「本窗口当前文档」上报（应用启动时调一次）：文档切换时告诉主进程，
 * 供「一个文件只开一个窗口」判断用。用 watch 而非散落在各处调用，避免漏报。
 */
export function installOpenDocTracking(): void {
  const files = useFilesStore()
  watch(
    () => files.current?.path ?? null,
    (p) => window.luminAPI.app.reportWindowDoc(p),
    { immediate: true }
  )
}
