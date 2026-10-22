// ─── 编辑区里的图片：粘贴（Tiptap 插件）────────────────────────────────────────
//
// 只做"认出图片 → 交给 lib/insertImage 落盘并插入"这一件事：
// 落点规则、命名、相对路径、错误提示都在那边（粘贴 / 选文件两条入口共用一份实现）。
//
// 为什么用 ProseMirror 插件而不是 DOM 监听：
//   * `handlePaste` 能**先于**默认行为拿到事件，插完返回 true 就不会被 Tiptap 再把同一张图
//     当文本插一遍；
//   * 落点（`view.state.selection`）由 PM 给，不用自己算光标坐标。
//
// ⚠️ 拖拽（drag & drop）已全禁用（`lib/dragGuard.ts`）：这里**没有** `handleDrop`，
//    从系统拖入图片不会再落盘/插入。**粘贴**图片仍然走 `handlePaste`（Ctrl+V 不受影响）。
//
// 注意：**只在有图片时才接管**，其余粘贴（markdown 文本、HTML）原样放行 ——
// 那些有自己的扩展（MarkdownPaste）。
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { insertImageFromBytes, IMAGE_EXT_RE } from '../insertImage'
import { ImagePicker } from './imagePicker'

/** 从 DataTransfer 里取出第一个图片文件（没有则 null） */
export function pickImageFile(dt: DataTransfer | null): File | null {
  if (!dt) return null
  const files = Array.from(dt.files ?? [])
  const byType = files.find((f) => f.type.startsWith('image/'))
  if (byType) return byType
  const byExt = files.find((f) => IMAGE_EXT_RE.test(f.name))
  if (byExt) return byExt
  // 有些来源（截图工具）只给 items 不给 files
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) return f
    }
  }
  return null
}

export const ImagePaste = Extension.create({
  name: 'luminImagePaste',

  addProseMirrorPlugins() {
    const editor = this.editor
    const insertSrc = (src: string): void => {
      editor.chain().focus().setImage({ src }).run()
    }
    const insert = async (file: File): Promise<void> => {
      /**
       * 一律把**字节**交给主进程落盘（`file:writeBinary`）。
       *
       * 以前这里走 `webUtils.getPathForFile(file)` 取真实路径 → 先调
       * `file:authorizeUserPath` 登记只读授权 → 再 `file:importImage` 复制。审计 P1-2
       * 删掉了那条"渲染层自行授权"的通道（否则任何注入都能把任意路径变成可读），
       * 于是改走字节：剪贴板图片本来就在内存里，几百 KB 的拷贝比留一个任意读文件口子便宜得多。
       */
      const bytes = new Uint8Array(await file.arrayBuffer())
      await insertImageFromBytes(insertSrc, bytes, file.name || 'image.png')
    }
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            const file = pickImageFile(event.clipboardData)
            if (!file) return false
            event.preventDefault()
            void insert(file)
            return true
          }
        }
      }),
      // 切片 A（第四十八/四十九轮）：`![]()` 的**纯渲染选图按钮**。
      // 挂在本扩展已有的数组里 ⇒ 不动 `extensions.ts` 的注册表，也不新造平行机制；
      // 原有插件项一个不改。按钮/stopEvent/ignoreSelection 的口径见 `./imagePicker.ts`。
      ...ImagePicker.addProseMirrorPlugins.call(this)
    ]
  }
})
