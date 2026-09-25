// ─── 会话恢复（渲染层）──────────────────────────────────────────────────────
// 目标：重启应用后回到上次的文档，并把光标与滚动位置放回原处；多窗口时每个窗口
// 各自恢复自己的那一份（主进程按窗口分配会话槽位，见 services/session.ts）。
//
// 分工：
//  - 主进程：槽位归属 + kv 读写（`session:get` / `session:save`），单独关窗时清槽位；
//  - 本模块：读槽位 → 打开文档 → 落光标/滚动；并把当前状态节流写回槽位。
//
// 位置记录沿用 EditorView 视图位置记忆的同一思路：PM 位置 + 记录时长度 + 滚动比例。
// 存比例而非 scrollTop，是为了窗口大小/字体/主题变化后仍能落在同一「进度」上。
import { watch } from 'vue'
import i18n from '../i18n'
import { useEditorStore } from '../stores/editor'
import { useFilesStore } from '../stores/files'
import { useNotificationsStore } from '../stores/notifications'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import type { SessionSlot } from '../../../shared/types'

/** 光标/滚动写库节流：光标每动一次都写 SQLite 会太碎 */
const SAVE_DELAY = 800

const t = (key: string): string => i18n.global.t(key)

/** 本窗口的会话槽位；null = 不参与会话恢复（如显式打开文件的窗口） */
const slotIndex = window.luminAPI.app.sessionSlot

let saveTimer: ReturnType<typeof setTimeout> | null = null
let installed = false

/** 编辑器视图内的滚动容器（.editor-scroll 由 TyporaEditor 提供） */
function scrollEl(): HTMLElement | null {
  const dom = useEditorStore().instance?.view?.dom as HTMLElement | undefined
  return dom ? (dom.closest('.editor-scroll') as HTMLElement | null) : null
}

/**
 * 源码模式的编辑面（分屏右栏 / 全屏源码模式，同一个常驻 textarea）。
 *
 * 为什么会话快照要专门看它：源码模式下 `applyActive()` 会把 `editorStore.instance`
 * **置为 null**（见 stores/editor.ts），于是老实现只能存下 `pos=1, len=0` ——
 * "重启回到原处"这个承诺在源码模式下根本不成立（审计 §3 P1）。
 * 长度口径与 Tiptap 的 `doc.content.size` 不同（这里是字符数），但**两端自洽**：
 * 存的时候读它、还原的时候也读它，比例换算因此仍然正确。
 */
function sourceTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('textarea.source-editor')
}

function scrollRatioOf(el: HTMLElement | null): number {
  if (!el) return 0
  const max = el.scrollHeight - el.clientHeight
  return max > 0 ? el.scrollTop / max : 0
}

function applyScrollRatio(el: HTMLElement | null, ratio: number): void {
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  if (max > 0) el.scrollTop = Math.min(1, Math.max(0, ratio)) * max
}

/** 采集当前会话快照（不含文档内容的读操作，开销可忽略）。
 *  注意：没有文档时也会写回（path=null，但带上工作区文件夹）——这是主流语义：
 *  会话记录的是「当前状态」。关掉恢复、应用停在空白未命名缓冲区时，该窗口的会话
 *  就随之变成「无文档」；只开着文件夹的窗口则靠 folder 字段恢复。 */
function snapshot(): SessionSlot | null {
  const files = useFilesStore()
  const doc = files.current
  const folder = files.root
  if (!doc && !folder) return null
  const ed = useEditorStore().instance
  let size = ed ? ed.state.doc.content.size : 0
  let pos = ed ? Math.min(Math.max(1, ed.state.selection.from), Math.max(1, size)) : 1
  if (!ed) {
    // 源码模式（或编辑器尚未挂载）：光标只能从 textarea 读。
    // `selectionStart` 是 0 基，会话槽位统一 1 基（与 PM 的 from 一致）。
    const ta = sourceTextarea()
    if (ta) {
      size = ta.value.length
      pos = Math.min(Math.max(1, ta.selectionStart + 1), Math.max(1, size))
    }
  }
  return {
    path: doc?.path ?? null, // null = 未命名缓冲区（下次启动按空文档处理，草稿另有保护）
    folder,
    pos,
    len: size,
    scrollRatio: scrollRatioOf(ed ? scrollEl() : sourceTextarea()),
    savedAt: Date.now()
  }
}

/** 立即写回槽位（关闭窗口前调用） */
export async function flushSession(): Promise<void> {
  if (slotIndex === null) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    await window.luminAPI.session.save(slotIndex, snapshot())
  } catch {
    /* 会话保存失败不影响使用 */
  }
}

/** 节流写回（光标移动、滚动、切换文档时调用） */
function scheduleSessionSave(): void {
  if (slotIndex === null) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSession()
  }, SAVE_DELAY)
}

/**
 * 安装会话跟踪（应用启动时调一次）：文档变化 / 光标移动 / 滚动 → 节流写回。
 * 滚动监听挂在 window 捕获阶段：滚动容器会随文档重建，挂在 window 上无需反复绑定。
 */
export function installSessionTracking(): void {
  if (installed || slotIndex === null) return
  installed = true
  const files = useFilesStore()
  const ui = useUiStore()

  // 文档路径 + 光标行列（ui.cursor 由编辑器在选区变化时更新）
  watch(
    () => [files.current?.path ?? null, ui.cursor.line, ui.cursor.col] as const,
    () => scheduleSessionSave()
  )
  window.addEventListener('scroll', scheduleSessionSave, true)
  // 关窗/退到后台前补一次，避免丢掉最后一小段位置变化
  window.addEventListener('pagehide', () => void flushSession())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSession()
  })
}

/** 等待编辑器装载「正确的文档」：新文档刚打开时 TyporaEditor 会按 :key 重建，
 *  只判实例存在会拿到旧的（还是未命名缓冲区），故用文档长度做锚。
 *
 *  **源码模式要在这里放行**：那时编辑面是 textarea，Tiptap 实例永远不会出现
 *  （`applyActive()` 会清空它），不认这一点的话源码模式下每次恢复都要白等满 4 秒。
 *  判据必须是 `ui.editorMode === 'source'`，**不能**只看"textarea 里有没有内容" ——
 *  textarea 在实时渲染模式下也**常驻 DOM**（只是被隐藏），拿它当锚会让这里提前返回，
 *  此时 Tiptap 还没挂上，位置就落空了（实测：B 段的光标/滚动恢复直接变 1/0）。 */
async function waitEditorForDoc(lenHint: number, timeout = 4000): Promise<void> {
  const t0 = Date.now()
  const sourceMode = (): boolean => useUiStore().editorMode === 'source'
  for (;;) {
    const ed = useEditorStore().instance
    if (ed && ed.view?.dom?.isConnected) {
      const size = ed.state.doc.content.size
      const near = lenHint <= 0 || Math.abs(size - lenHint) <= Math.max(64, lenHint * 0.5)
      if (near) return
    } else if (sourceMode()) {
      const ta = sourceTextarea()
      if (ta && ta.value.length > 0) {
        const near =
          lenHint <= 0 || Math.abs(ta.value.length - lenHint) <= Math.max(64, lenHint * 0.5)
        if (near) return
      }
    }
    if (Date.now() - t0 > timeout) return
    await new Promise((r) => setTimeout(r, 16))
  }
}

/** 把记录的光标与滚动落回编辑器 */
async function applyPosition(slot: SessionSlot): Promise<void> {
  await waitEditorForDoc(slot.len)
  const ed = useEditorStore().instance
  if (!ed) {
    // 源码模式：编辑面是 textarea（Tiptap 实例为 null）。同样按比例回退、同样 clamp。
    // 只在**确实处于源码模式**时走这条路：实时渲染下实例还没挂上时什么都不该做
    // （那时 textarea 是隐藏的常驻元素，往里写光标等于什么都没恢复）。
    if (useUiStore().editorMode !== 'source') return
    const ta = sourceTextarea()
    if (!ta) return
    const size = ta.value.length
    const ratio = slot.len > 0 ? slot.pos / slot.len : 0
    const at = slot.pos > 0 && slot.pos <= size ? slot.pos : Math.round(ratio * size)
    const caret = Math.max(0, Math.min(at - 1, size))
    try {
      ta.setSelectionRange(caret, caret)
    } catch {
      /* 位置非法时保持浏览器默认 */
    }
    applyScrollRatio(ta, slot.scrollRatio)
    requestAnimationFrame(() => applyScrollRatio(ta, slot.scrollRatio))
    setTimeout(() => applyScrollRatio(ta, slot.scrollRatio), 120)
    return
  }
  const size = ed.state.doc.content.size
  // 文档内容变了（外部编辑/长度不同）→ 按比例回退，避免越界
  const ratio = slot.len > 0 ? slot.pos / slot.len : 0
  let pos = slot.pos > 0 && slot.pos <= size ? slot.pos : Math.round(ratio * size)
  pos = Math.max(1, Math.min(pos, Math.max(1, size)))
  // 落点可能正好在块边界（表格单元格、列表项等 inline content 之外），
  // TextSelection 会直接拒绝并告警 —— 与 EditorView.placePmCursor 同样先 near 修正
  try {
    // 动态 import：顶层静态 import 会把整份 ProseMirror（~412KB）钉进首屏 entry chunk，
    // 而本文件在 `App.vue → useAppActions` 的静态依赖链上。真正需要它时编辑器已经存在
    // （`waitEditorForDoc` 等过），模块缓存必然已命中，所以这里不会多一次网络/解析。
    const { TextSelection } = await import('@tiptap/pm/state')
    const $pos = ed.state.doc.resolve(pos)
    if (!$pos.parent.isTextblock) pos = TextSelection.near($pos, 1)?.from ?? pos
  } catch {
    /* 位置非法时保持原值（下面的 setTextSelection 会兜底） */
  }
  try {
    ed.commands.setTextSelection(pos)
  } catch {
    /* 位置非法时保持编辑器默认光标 */
  }
  const el = scrollEl()
  applyScrollRatio(el, slot.scrollRatio)
  requestAnimationFrame(() => applyScrollRatio(el, slot.scrollRatio))
  setTimeout(() => applyScrollRatio(el, slot.scrollRatio), 120)
}

/**
 * 打开上次这个窗口的文档 / 工作区文件夹（不落位置：此时编辑器还没挂载）。
 * 注意顺序——必须先 openPath，再由调用方 push('/editor')，最后 applySessionPosition，
 * 否则编辑器实例还不存在，位置无从落起。
 *
 * @returns 需要落位的会话快照（仅文档窗口）；null = 无需落位
 *          （无槽位 / 已有关闭恢复 / 槽位为空 / 文件打不开 / 只恢复了文件夹）
 */
export async function restoreSession(): Promise<SessionSlot | null> {
  if (slotIndex === null) return null
  const settings = useSettingsStore()
  if (!settings.restoreSession) return null
  const files = useFilesStore()
  // 已经有「真实文档」或有未保存内容 → 绝不覆盖。
  // 但空白的未命名缓冲区不算：reload/热重载会保留 #/editor 路由，编辑器抢先在
  // bootstrap 之前挂载并开了未命名缓冲区，此时仍应恢复会话里的文档。
  const current = files.current
  if (current && (current.path || current.content.trim() !== '')) return null

  let slot: SessionSlot | null = null
  try {
    const state = await window.luminAPI.session.get()
    slot = state.slots[slotIndex] ?? null
  } catch {
    return null
  }
  if (!slot || (!slot.path && !slot.folder)) return null // 空槽：交给草稿恢复

  // 只开着文件夹的窗口（「最近文件夹 → 新窗口」）：恢复工作区即可，无光标可落
  if (!slot.path) {
    if (slot.folder) await files.setRoot(slot.folder)
    return null
  }

  const ok = await files.openPath(slot.path)
  if (!ok) {
    // 文件已被删除/移动：告知用户，但不阻断启动
    void useNotificationsStore().notify({
      level: 'warning',
      title: t('session.restoreFailed'),
      body: slot.path,
      mergeKey: 'session:restore-failed'
    })
    return null
  }
  return slot
}

/** 把恢复出来的光标与滚动位置落回编辑器（须在编辑器挂载之后调用） */
export async function applySessionPosition(slot: SessionSlot): Promise<void> {
  await applyPosition(slot)
}
