// ─── 插入图片：粘贴 / 拖入 / 「选择文件…」三条入口的**唯一实现** ──────────────
//
// 之前只有一条路：工具栏弹个输入框让你手打 URL（`Toolbar.vue` 的 addImage）。
// 剪贴板里的截图、拖进来的 png 都无处可去 —— 而这是写作时最常用的一条路径。
//
// 落点规则（与「文档里的相对路径是相对文档解析」对齐，见 lib/imageSrc.ts）：
//   * 有工作区 → 图片落在 `<工作区>/assets/`；
//   * 没有工作区但文档已保存 → 落在 `<文档目录>/assets/`；
//   * 两者都没有（未命名且无工作区）→ 明确告诉用户先保存/开工作区
//     （写进系统临时目录再引用绝对路径会让文档换台机器就裂，所以不做）。
//
// src 一律写成**相对当前文档目录**的形式（`relativeDocPath`）：文档在 `notes/` 里时是
// `../assets/x.png`，与 `imageSrcForDoc` 的解析规则严丝合缝。
//
// 这里**不认识 Tiptap**：插入动作是一个 `insert(src)` 回调（工具栏传
// `ed.chain().focus().setImage(...)`，编辑器插件传同一句）。这样这个模块不依赖编辑器类型，
// 单测可以直接塞一个"把 src 记下来"的假函数。
import i18n from '../i18n'
import { relativeDocPath } from './imageSrc'
import { assetDirFor, assetNameFor, dirOf, joinPath } from './imageAsset'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'

/** 插入动作：把算好的 src 交给编辑器（三条入口共用同一个签名） */
export type InsertImageSrc = (src: string) => void

/** 允许插入的图片扩展名（与主进程对话框过滤器保持一致） */
export { IMAGE_EXT_RE } from './imageAsset'

/** 插入图片前算好资源目录；拿不到就提示用户先保存/开工作区 */
function assetDirOrWarn(): string | null {
  const files = useFilesStore()
  const dir = assetDirFor(files.root, files.current?.path ?? null)
  if (!dir) {
    useUiStore().toast(i18n.global.t('toast.imageNeedsWorkspace'), 'warning')
    return null
  }
  return dir
}

/** 把资源目录里的绝对路径换算成「相对当前文档」的 src 并插入 */
function insertAt(insert: InsertImageSrc, assetPath: string): void {
  const files = useFilesStore()
  const docPath = files.current?.path ?? null
  insert(docPath ? relativeDocPath(dirOf(docPath), assetPath) : assetPath)
}

function reportFailure(err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err)
  useUiStore().toast(i18n.global.t('toast.imageInsertFailed', { reason }), 'error')
}

/** 把**外部文件**（拖入 / 「选择文件…」拿到的绝对路径）复制进资源目录并插入 */
export async function insertImageFromPath(
  insert: InsertImageSrc,
  sourcePath: string,
  displayName?: string
): Promise<boolean> {
  const dir = assetDirOrWarn()
  if (!dir) return false
  try {
    const target = await window.luminAPI.file.importImage(
      sourcePath,
      dir,
      assetNameFor(displayName ?? sourcePath)
    )
    insertAt(insert, target)
    return true
  } catch (err) {
    reportFailure(err)
    return false
  }
}

/** 把**内存里的字节**（剪贴板粘贴）写进资源目录并插入 */
export async function insertImageFromBytes(
  insert: InsertImageSrc,
  bytes: Uint8Array,
  displayName = 'clipboard.png'
): Promise<boolean> {
  const dir = assetDirOrWarn()
  if (!dir) return false
  try {
    const target = joinPath(dir, assetNameFor(displayName))
    await window.luminAPI.file.writeBinary(target, bytes)
    insertAt(insert, target)
    return true
  } catch (err) {
    reportFailure(err)
    return false
  }
}

/** 插入一张**远程/内联**图片（工具栏那条"输入 URL"的老路径） */
export function insertImageFromUrl(insert: InsertImageSrc, src: string): boolean {
  const url = src.trim()
  if (!url) return false
  insert(url)
  return true
}
