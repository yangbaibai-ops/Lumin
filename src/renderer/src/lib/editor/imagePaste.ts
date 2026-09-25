// ─── 编辑区里的图片：粘贴 / 拖入（Tiptap 插件）────────────────────────────────
//
// 只做"认出图片 → 交给 lib/insertImage 落盘并插入"这一件事：
// 落点规则、命名、相对路径、错误提示都在那边（粘贴/拖入/选文件三条入口共用一份实现）。
//
// 为什么用 ProseMirror 插件而不是 DOM 监听：
//   * `handlePaste` / `handleDrop` 能**先于**默认行为拿到事件，插完返回 true 就
//     不会被 Tiptap 再把同一张图当文本插一遍；
//   * 落点（`view.state.selection`）由 PM 给，不用自己算光标坐标。
//
// 注意：**只在有图片时才接管**，其余粘贴/拖放（markdown 文本、HTML、内部拖动）原样放行 ——
// 那些有自己的扩展（MarkdownPaste / NodeSelection 拖动）。
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { insertImageFromBytes, insertImageFromPath, IMAGE_EXT_RE } from '../insertImage'

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

/** 取文件在磁盘上的真实路径（Electron 的 webUtils；浏览器里拿不到则返回 null） */
export function pathOfFile(file: File): string | null {
  try {
    return window.luminAPI?.file?.getPathForFile?.(file) ?? null
  } catch {
    return null
  }
}

export const ImagePaste = Extension.create({
  name: 'luminImagePaste',

  addProseMirrorPlugins() {
    const editor = this.editor
    const insertSrc = (src: string): void => {
      editor.chain().focus().setImage({ src }).run()
    }
    const insert = async (file: File): Promise<void> => {
      // 拖入/粘贴的文件如果带着真实路径，就走「复制进工作区」（不把字节搬进渲染层）
      const p = pathOfFile(file)
      if (p) {
        await insertImageFromPath(insertSrc, p, file.name)
        return
      }
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
          },
          handleDrop(_view, event) {
            const file = pickImageFile(event.dataTransfer)
            if (!file) return false
            // 拖进来的如果是 .md（打开外部文件），交给 EditorView 的 onDrop，这里只管图片
            const p = pathOfFile(file)
            if (p && !IMAGE_EXT_RE.test(p)) return false
            event.preventDefault()
            void insert(file)
            return true
          }
        }
      })
    ]
  }
})
