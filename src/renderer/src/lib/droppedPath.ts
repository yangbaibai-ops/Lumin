// ─── 「用户把系统里的文件 / 文件夹拖进窗口」：**唯一一份**落点实现 ────────────────
//
// 为什么值得单独一个文件：这条链上有两个入口（整个窗口的拖入、编辑器内核自己的图片拖入），
// 而落点语义必须只有一份 —— 与「打开文件 / Ctrl+O」「打开文件夹」完全一致：
//
//   * **文件**（.md/.markdown/.mdown/.mkd/.txt）→ `openExternalFile`
//     （无工作区：本窗口打开并把侧栏切到它所在的文件夹；已有工作区：新窗口打开，
//      同一个文件只开一个窗口 —— 规则本身在 lib/openFile.ts，这里只调用）；
//   * **目录** → 三个分支（第六轮用户口径，见下面 openDroppedFolder 的注释）：
//       - 与当前工作区**是同一个** → 不新开窗口、不动工作区，给一条提示（明确的 no-op）；
//       - 与当前工作区**不同** → 走既有的"应用外请求打开目录"规则：
//         `app.openFolderInNewWindow`（主进程 `app:openFolderInNewWindow` → createWindow({openFolder})，
//         新窗口在启动时 `files.setRoot(它)`，见 renderer/src/main.ts 的 startupFolder 分支）；
//       - **本窗口还没有工作区** → 就用这个窗口成为它的工作区（理由见 openDroppedFolder）。
//   * 其它扩展名 → 明确提示「不支持的文件类型」（与改动前一致）。
//
// ⚠️⚠️ 千万不要用 `event.defaultPrevented` 判"内层是不是已经处理过这次拖放"。
//   `@drop.prevent="…"`（Vue 的 `.prevent` 修饰器）**先** `preventDefault()` 再调处理函数
//   （node_modules/@vue/runtime-dom 的 withModifiers：modifierGuards.prevent 在 fn 之前跑），
//   所以进了处理函数之后 `defaultPrevented` **恒为 true** —— 曾经用这个判据的人把
//   「拖文件进窗口打开」整条路静默关掉了（提交 d014773 引入、本文件修复的正式写在这里）。
//   内层认领的信号是 `stopPropagation`（见 lib/editor/imagePaste.ts）：事件根本不会冒泡到这里。
//
// 路径只有渲染层拿得到（`webUtils.getPathForFile`），所以这里的顺序是：
//   取路径 → 登记一次**只读**授权（services/pathGrants：不登记就打不开）→ 分流。
import i18n from '../i18n'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { confirmDiscardIfDirty } from './dialog'
import { openExternalFile } from './openFile'

/** 拖放被认领之后的结果（供套件/调用方断言，不参与界面） */
export type DroppedPathOutcome =
  /** 文件：走 openExternalFile 的落点规则打开了 */
  | 'opened'
  /** 目录：本窗口**没有工作区** ⇒ 就用这个窗口成为它的工作区 */
  | 'workspace-here'
  /** 目录：与当前工作区**是同一个** ⇒ 明确 no-op（不新开窗口、不动工作区）+ 一条提示 */
  | 'workspace-same'
  /** 目录：与当前工作区**不同** ⇒ 新窗口以它为工作区（既有规则） */
  | 'workspace-new-window'
  /** 扩展名不在白名单里（已提示用户） */
  | 'unsupported'
  /** 路径不存在 / 拿不到路径 / 授权被拒 */
  | 'unusable'
  /** 有未保存改动、用户在确认框里选了取消 */
  | 'cancelled'

/** 本应用认得的文档扩展名（与「打开文件」对话框的过滤器同一份口径） */
export const OPENABLE_EXT_RE = /\.(md|markdown|mdown|mkd|txt)$/i

/**
 * 从一次拖放事件里取出**第一个文件在磁盘上的真实路径**。
 * 拿不到（拖动的是应用内的文字 / 浏览器里没有 Electron 的 webUtils）返回 null。
 */
export function droppedPathOf(e: DragEvent): string | null {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return null
  try {
    return window.luminAPI?.file?.getPathForFile?.(file) ?? null
  } catch {
    return null
  }
}

/**
 * ─── 拖进来的是一个文件夹：三个分支（用户第六轮口径）────────────────────────────
 *
 *  ① **本窗口还没有工作区（空窗口）** ⇒ 就用这个窗口成为它的工作区。理由：
 *     * 这个窗口**没有东西可失去**：没有工作区树要换，正文缓冲区也不会被碰
 *       （`files.setRoot` 只换侧栏根 + 记一条最近文件夹，既不关文档也不重写它）；
 *     * 与**同一条链上的文件**规则一致：`openExternalFile` 的第 ③ 条就是"本窗口没有
 *       文件夹 → 就在本窗口打开"。一个字都还没打开的空窗口，再为它开一个窗口等于留下
 *       一个必须手动关掉的空壳（用户实际动作是"启动应用 → 把笔记文件夹拖进来"）。
 *     * 主进程 `openRequest.ts` 的"打开目录 → 新窗口"是**应用级/应用外**请求的规则
 *       （资源管理器双击、任务栏跳转列表、第二实例）—— 那些请求发生在"还没有承载它的窗口"
 *       的时候；而拖放是**投递给某一个具体窗口**的手势，所以此处按"这个窗口"判定。
 *  ② **与当前工作区是同一个文件夹** ⇒ 明确 no-op：**不新开窗口、不动工作区**，
 *     只给一条 info 提示。为什么不像别处那样干脆静默：上一轮用户报的正是"拖进来没反应"，
 *     静默会让人以为功能又坏了 —— "已经开着这个文件夹"必须说出来。
 *     判据由**主进程**给（`file:isSamePath` → 纯函数 `pathGuard.sameResolvedPath` +
 *     `fs.realpath`）：大小写、正反斜杠、尾分隔符、`.`/`..`、符号链接/junction、
 *     8.3 短名（资源管理器拖进来给的 `YANGBA~1`）都算同一个。渲染层不手搓字符串比较。
 *  ③ **与当前工作区不同** ⇒ 复用既有的"打开目录"那条路：`app.openFolderInNewWindow(dir)`
 *     （不是新造一套开窗逻辑；它也**不打扰当前窗口**，所以这里不问"未保存改动"——
 *     与 `handleOpenRequest` / 「最近文件夹」同一口径）。
 */
async function openDroppedFolder(dir: string): Promise<DroppedPathOutcome> {
  const files = useFilesStore()
  const ui = useUiStore()
  const root = files.root
  if (!root) {
    if (!(await confirmDiscardIfDirty(() => files.dirty))) return 'cancelled'
    await files.setRoot(dir)
    return 'workspace-here'
  }
  /**
   * 判"是不是同一个文件夹"这一步**问主进程**（`file:isSamePath`）。
   * 失败（IPC 抛了）时的兜底是"当成不同"：宁可多开一个窗口，也不能静默什么都不做 ——
   * "拖进来没反应"正是用户前两轮报的那类症状。正常流程下两侧都已授权，不会走到这里。
   */
  let same = false
  try {
    same = await window.luminAPI.file.isSamePath(root, dir)
  } catch {
    same = false
  }
  if (same) {
    const name = await window.luminAPI.file.basename(dir)
    ui.toast(i18n.global.t('toast.workspaceAlreadyOpen', { name }), 'info')
    return 'workspace-same'
  }
  window.luminAPI.app.openFolderInNewWindow(dir)
  return 'workspace-new-window'
}

/**
 * 把一次「拖进窗口」落到具体动作上。`onDragOver` 那一半在调用方（必须 preventDefault，
 * 否则浏览器根本不派发 drop：见 App.vue 的 onWindowDragOver）。
 */
export async function openDroppedPath(dropped: string): Promise<DroppedPathOutcome> {
  const ui = useUiStore()
  // 拖放的落点路径主进程看不到 → 先申请一次只读授权（目录同样适用：grantDroppedRead 只要求存在）
  if (!(await window.luminAPI.file.authorizeUserPath(dropped))) {
    ui.toast(i18n.global.t('toast.openFailed'), 'error')
    return 'unusable'
  }
  if (await window.luminAPI.file.isDirectory(dropped)) return openDroppedFolder(dropped)
  if (!OPENABLE_EXT_RE.test(dropped)) {
    ui.toast(i18n.global.t('toast.unsupportedFile'), 'error')
    return 'unsupported'
  }
  const files = useFilesStore()
  if (!(await confirmDiscardIfDirty(() => files.dirty))) return 'cancelled'
  await openExternalFile(dropped)
  return 'opened'
}

/**
 * 一次拖放事件的完整处理（取路径 → 分流）。返回 `null` = 这次拖放不是"从系统拖入的文件"
 * （应用内拖动文字 / 文件树条目 / 空拖放），调用方什么都不用做。
 */
export async function handleDroppedEvent(e: DragEvent): Promise<DroppedPathOutcome | null> {
  const path = droppedPathOf(e)
  if (!path) return null
  return openDroppedPath(path)
}
