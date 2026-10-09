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
        /**
         * 路径在主进程那一侧是**不可见**的（只有渲染层的 webUtils 拿得到），而 `file:importImage`
         * 的 source 那一头要过授权闸（见 main/ipc.ts 里那条 handler 的说明：
         * "拖入时渲染层已申请过"）。所以这里必须先登记一次只读授权 ——
         * 少了这一句，**打包态**（没有 LUMIN_TRUSTED_PATHS 那层测试期信任）拖一张桌面上的图进来
         * 会以 `PATH_NOT_AUTHORIZED` 失败，只有测试环境里"看起来是好的"。
         */
        await window.luminAPI.file.authorizeUserPath(p)
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
            // 拖进来的如果是 .md（打开外部文件），交给窗口级的落点处理，这里只管图片
            const p = pathOfFile(file)
            if (p && !IMAGE_EXT_RE.test(p)) return false
            event.preventDefault()
            /**
             * ⚠️ `stopPropagation` 是这一步的**关键**，不是顺手加的：
             *
             * 窗口级还有一层「从系统拖入文件/文件夹 → 打开」的处理（App.vue 的 onWindowDrop）。
             * 这次拖放已经被内核认领（图片插进来了），必须让它**不再冒泡**上去，
             * 否则同一张 png 会被外层的「不支持的文件类型」白名单再判一次 ——
             * 用户看到的是"图片插进去了，同时弹一条不支持"。
             *
             * 这条链上曾经用 `event.defaultPrevented` 表达"内层已认领"，而外层是
             * `@drop.prevent`（Vue 的 `.prevent` 在**调用处理函数之前**就 preventDefault 了）
             * ⇒ 那个判据恒为 true，把「拖 .md 进窗口打开」整条功能一起关掉了（见 droppedPath.ts）。
             * 所以认领信号只认 stopPropagation：**这里改了就要连着 App.vue 一起想**。
             */
            event.stopPropagation()
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
