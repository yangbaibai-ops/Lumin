// ─── 粘贴防卡死护栏（规模判定 + 降级 + 超时回滚）────────────────────────────────
//
// 真因与阈值依据见 `pasteGuardCore.ts` 的文件头。这里只做"接线"：
//   1. 在 `handlePaste` 链里**排在 MathPaste / TableClipboard 之前**（someProp 首个返回
//      true 的赢）—— 超预算的 HTML 根本不进它们的两遍 DOM 解析；
//   2. 未超预算 ⇒ `return false`，**既有粘贴管线一个字节都不变**（正常粘贴不变差）；
//   3. 超软预算 ⇒ 省略超大的内联图片（换成可见占位）后照常插入，并提示；
//   4. 结构/体积超硬预算 ⇒ 降级成纯文本；
//   5. data URI 超硬上限 ⇒ 整次拒绝（文档不动）+ 提示；
//   6. 另外给"放行"的粘贴挂一个**下一拍**的看门狗：同步处理超过 1.5~2 s ⇒
//      把文档回滚到粘贴前并提示（文档必须保持原样）。
//
// 为什么看门狗放在"下一拍"而不是同步：粘贴处理本身是同步的（ProseMirror 的 paste
// 事件），同步期间主线程本来就没法执行任何回调；能做的只有"事后判定 + 回滚"。
// 真正**避免**卡顿的是前四条（在解析之前就把规模压下去）。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Selection, Transaction } from '@tiptap/pm/state'
import { DOMParser as PMDOMParser, Slice } from '@tiptap/pm/model'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView, EditorProps } from '@tiptap/pm/view'
import i18n from '../../i18n'
import { deferAfterPmEvent } from './defer'
import {
  PASTE_HARD_SINGLE_IMAGE_BYTES,
  PASTE_HARD_TOTAL_IMAGE_BYTES,
  PASTE_WATCHDOG_MS,
  decidePaste,
  shouldRollback
} from './pasteGuardCore'

/** 提示出口（宿主注入；内核不认识通知中心，见 extensions.ts 的选项说明） */
export interface PasteNotice {
  level: 'info' | 'warning' | 'error'
  title: string
  body?: string
  /**
   * 这次提示要不要配一个「改用纯文本粘贴」按钮（用户自救入口）。
   * 只在剪贴板里确实有纯文本时置位 —— 按了却没东西可插比没有按钮更糟。
   */
  plainPaste?: boolean
}

export interface PasteGuardOptions {
  /** 把一条可见提示交给宿主（默认丢弃：纯内核单测/无宿主环境） */
  onNotice: (notice: PasteNotice) => void
}

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? i18n.global.t(key, params) : i18n.global.t(key)

/** 占位文案（省略的图片） */
function labels(): { omittedImage: (mb: string) => string } {
  return { omittedImage: (mb: string) => t('editor.pasteImageOmitted', { mb }) }
}

/**
 * 看门狗预算：默认 1.5 s。
 * 允许测试通过 `window.__LUMIN_PASTE_WATCHDOG_MS` 覆盖（与 perfProbe 同一手法：
 * 只在测量实例里设，生产路径没有这个键）。非法值一律回落默认，绝不让它把护栏关掉。
 */
function watchdogBudget(): number {
  try {
    const raw = (window as unknown as { __LUMIN_PASTE_WATCHDOG_MS?: unknown })
      .__LUMIN_PASTE_WATCHDOG_MS
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  } catch {
    /* 非浏览器环境（单测 import）：用默认值 */
  }
  return PASTE_WATCHDOG_MS
}

/** 把 HTML 解析成闭合 Slice（与 markdownPaste 的 transformPasted 同一条口径） */
function htmlSlice(view: EditorView, html: string): Slice {
  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  const parsed = PMDOMParser.fromSchema(view.state.schema).parseSlice(dom, {
    preserveWhitespace: true,
    context: view.state.selection.$from
  } as unknown as Parameters<PMDOMParser['parseSlice']>[1])
  return new Slice(parsed.content, 0, 0)
}

/**
 * 回滚到粘贴前的文档（**只用公开 API**：一个替换整篇内容的普通事务）。
 *
 * 为什么不走 history 的 undo：粘贴可能被其它插件的 `appendTransaction` 拆成多步，
 * undo 一次不一定回到起点；而"整篇内容换回快照"在语义上就是用户要的
 * "这次粘贴没发生"（撤销栈里也不会多出一条 —— `addToHistory: false`）。
 */
export function rollbackPasteTr(state: EditorState, before: PMNode, sel: Selection): Transaction {
  const tr = state.tr
  tr.replaceWith(0, tr.doc.content.size, before.content)
  const max = tr.doc.content.size
  const at = Math.max(0, Math.min(sel.from, max))
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(at)))
  } catch {
    /* 位置失效：保留原选区（文档本身已经回滚） */
  }
  tr.setMeta('addToHistory', false)
  return tr
}

export const PasteFreezeGuard = Extension.create<PasteGuardOptions>({
  name: 'pasteFreezeGuard',

  addOptions() {
    return { onNotice: () => {} }
  },

  addProseMirrorPlugins() {
    const notify = (notice: PasteNotice): void => {
      try {
        this.options.onNotice(notice)
      } catch {
        /* 提示失败不影响粘贴 */
      }
    }

    /** 插入一段"已降级"的内容（失败则什么都不做 → 文档保持原样） */
    const insertDegraded = (view: EditorView, html: string): boolean => {
      try {
        const slice = htmlSlice(view, html)
        if (!slice.content.size) return false
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
        return true
      } catch {
        return false
      }
    }

    /**
     * 下一拍看门狗：同步粘贴超过预算且文档变了 ⇒ 回滚 + 提示。
     * 只对"放行给既有管线"的粘贴挂（降级/拒绝路径本身已经是同步可控的短路径）。
     */
    const armWatchdog = (view: EditorView, plainPaste: boolean): void => {
      const before = view.state.doc
      const sel = view.state.selection
      const t0 = performance.now()
      deferAfterPmEvent(() => {
        if (view.isDestroyed) return
        const elapsed = performance.now() - t0
        if (!shouldRollback(elapsed, view.state.doc !== before, watchdogBudget())) return
        try {
          view.dispatch(rollbackPasteTr(view.state, before, sel))
        } catch {
          return
        }
        notify({
          level: 'warning',
          title: t('editor.pasteRollbackTitle'),
          body: t('editor.pasteRollbackBody', {
            ms: Math.round(elapsed),
            budget: watchdogBudget()
          }),
          plainPaste
        })
      })
    }

    /** 只处理"富文本"粘贴；纯文本与图片文件仍旧交给既有通道 */
    const handlePaste = (view: EditorView, event: ClipboardEvent): boolean => {
      const dt = event.clipboardData
      if (!dt) return false
      // 图片文件（截图工具 / 资源管理器）由 ImagePaste 认领（它排在前面）
      if (dt.files && dt.files.length) return false
      const html = dt.getData('text/html')
      if (!html) return false
      const text = dt.getData('text/plain') ?? ''
      const decision = decidePaste({ html, text }, labels())
      // 诊断（与 tableClipboard 的 `__mdTableDrag` 同一手法）：e2e 用它断言"走的是哪条路"。
      // 只记判定结果与规模，不记内容（大 base64 绝不进这个对象）。
      try {
        ;(window as unknown as Record<string, unknown>).__luminPasteGuard = {
          kind: decision.kind,
          chars: decision.scan.chars,
          elements: decision.scan.elements,
          depth: decision.scan.maxDepth,
          images: decision.scan.images.length,
          imageBytes: decision.scan.imageBytes
        }
      } catch {
        /* 非浏览器环境：忽略 */
      }

      if (decision.kind === 'allow') {
        armWatchdog(view, !!text)
        return false
      }

      // 以下都是"我们自己接管这次粘贴"：先挡掉浏览器/PM 的默认行为
      try {
        event.preventDefault()
      } catch {
        /* 合成事件可能没有 preventDefault：不影响返回值语义 */
      }

      if (decision.kind === 'reject') {
        notify({
          level: 'warning',
          title: t('editor.pasteRejectedTitle'),
          body: t('editor.pasteRejectedBody', {
            mb: (decision.scan.imageBytes / 1024 / 1024).toFixed(1),
            single: Math.round(PASTE_HARD_SINGLE_IMAGE_BYTES / 1024 / 1024),
            total: Math.round(PASTE_HARD_TOTAL_IMAGE_BYTES / 1024 / 1024)
          }),
          plainPaste: !!text
        })
        return true
      }

      if (decision.kind === 'fallback-text') {
        if (!decision.text) {
          notify({ level: 'warning', title: t('editor.pasteRejectedTitle') })
          return true
        }
        view.dispatch(view.state.tr.insertText(decision.text).scrollIntoView())
        notify({
          level: 'warning',
          title: t('editor.pasteFallbackTitle'),
          body: t('editor.pasteFallbackBody', {
            elements: decision.scan.elements,
            depth: decision.scan.maxDepth,
            truncated: decision.truncated ? t('editor.pasteTruncatedSuffix') : ''
          }),
          // 即使已降级成纯文本，也保留入口：fallback 可能因长度上限被截断
          // （PASTE_FALLBACK_TEXT_CHARS），用户可以用它把**完整**剪贴板文本再插一次。
          plainPaste: true
        })
        return true
      }

      // degrade：省略超预算的内联图片后照常插入
      const ok = insertDegraded(view, decision.html)
      if (!ok) {
        notify({ level: 'error', title: t('editor.pasteRejectedTitle') })
        return true
      }
      notify({
        level: 'warning',
        title: t('editor.pasteDegradedTitle'),
        body: t('editor.pasteDegradedBody', {
          n: decision.omittedImages,
          mb: (decision.omittedBytes / 1024 / 1024).toFixed(1)
        }),
        plainPaste: !!text
      })
      return true
    }

    return [
      new Plugin({
        key: new PluginKey('luminPasteFreezeGuard'),
        props: {
          handlePaste
        } as unknown as EditorProps
      })
    ]
  }
})
