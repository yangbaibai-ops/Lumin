import { useEditorStore } from '../stores/editor'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import type { EditorMode } from '../../../shared/types'

/**
 * ─── 编辑器模式切换（实时渲染 / 分屏对比 / 源码）───────────────────────────
 * 工具栏分段控件、应用菜单与快捷键共用的唯一入口：
 * - 离开含 Tiptap 实例的模式（wysiwyg / split）前，先把文档序列化回
 *   Markdown 刷入 files store（工具栏 root 有 @mousedown.prevent，点击切换
 *   按钮不会触发编辑器 blur，若不显式 flush，防抖窗口内的编辑会在卸载时丢失）；
 * - 写入的作者是 `wysiwyg`：账本据此把编辑器标记为「已跟上当前世代」，
 *   切到源码模式后 textarea 才是编辑面。
 */
export function useEditorMode(): {
  setMode: (mode: EditorMode) => void
  cycleMode: () => void
  flushWysiwyg: () => void
} {
  const ui = useUiStore()
  const files = useFilesStore()
  const editorStore = useEditorStore()

  const CYCLE: EditorMode[] = ['wysiwyg', 'split', 'source']

  /** 把当前 Tiptap 文档序列化为 Markdown 刷入文件槽（防抖编辑不丢失）。
      编辑器不脏时跳过——文件槽内容已与其一致（onUpdate emit 已同步），
      避免「只看视图不编辑」的切换也要整篇序列化（大文档的隐藏成本）。 */
  function flushWysiwyg(): void {
    const ed = editorStore.instance
    if (!ed || !editorStore.dirty) return
    try {
      const storage = ed.storage as { markdown?: { getMarkdown(): string } }
      const md = storage.markdown?.getMarkdown() ?? ''
      files.setContent(md, 'wysiwyg')
      editorStore.markFlushed()
    } catch {
      /* 序列化失败时保持文件槽现状 */
    }
  }

  function setMode(mode: EditorMode): void {
    if (ui.editorMode === mode) return
    if (ui.editorMode === 'wysiwyg' || ui.editorMode === 'split') flushWysiwyg()
    ui.editorMode = mode
  }

  /** Ctrl+/ 循环：实时渲染 → 分屏对比 → 源码 → 实时渲染 */
  function cycleMode(): void {
    const next = CYCLE[(CYCLE.indexOf(ui.editorMode) + 1) % CYCLE.length]
    setMode(next)
  }

  return { setMode, cycleMode, flushWysiwyg }
}
