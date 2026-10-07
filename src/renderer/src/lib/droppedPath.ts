// ─── 「用户把系统里的文件 / 文件夹拖进窗口」：**唯一一份**落点实现 ────────────────
//
// 为什么值得单独一个文件：这条链上有两个入口（整个窗口的拖入、编辑器内核自己的图片拖入），
// 而落点语义必须只有一份 —— 与「打开文件 / Ctrl+O」「打开文件夹」完全一致：
//
//   * **文件**（.md/.markdown/.mdown/.mkd/.txt）→ `openExternalFile`
//     （无工作区：本窗口打开并把侧栏切到它所在的文件夹；已有工作区：新窗口打开，
//      同一个文件只开一个窗口 —— 规则本身在 lib/openFile.ts，这里只调用）；
//   * **目录** → 与菜单「打开文件夹」同一条路：`files.setRoot(dir)`
//     （**不是**新窗口：拖放是"在这个窗口里打开"，与 Ctrl+O 走 in-app 规则同一个口径；
//      主进程的 launch-intent 那条"打开目录 → 新窗口"是**应用外**发起请求的规则，
//      见 main/openRequest.ts，两者故意不同）；
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
  /** 目录：设成了当前窗口的工作区根 */
  | 'workspace'
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
 * 把一次「拖进窗口」落到具体动作上。`onDragOver` 那一半在调用方（必须 preventDefault，
 * 否则浏览器根本不派发 drop：见 App.vue 的 onWindowDragOver）。
 */
export async function openDroppedPath(dropped: string): Promise<DroppedPathOutcome> {
  const files = useFilesStore()
  const ui = useUiStore()
  // 拖放的落点路径主进程看不到 → 先申请一次只读授权（目录同样适用：grantDroppedRead 只要求存在）
  if (!(await window.luminAPI.file.authorizeUserPath(dropped))) {
    ui.toast(i18n.global.t('toast.openFailed'), 'error')
    return 'unusable'
  }
  if (await window.luminAPI.file.isDirectory(dropped)) {
    // 目录 = 「打开文件夹」：换掉当前窗口的工作区根（与 useAppActions.openFolderDialog 同一口径）
    if (!(await confirmDiscardIfDirty(() => files.dirty))) return 'cancelled'
    await files.setRoot(dropped)
    return 'workspace'
  }
  if (!OPENABLE_EXT_RE.test(dropped)) {
    ui.toast(i18n.global.t('toast.unsupportedFile'), 'error')
    return 'unsupported'
  }
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
