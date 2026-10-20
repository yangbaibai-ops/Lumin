// ─── 中文拼写检查：ProseMirror 插件 + Decoration（只在正文，不碰代码/公式）───
//
// 数据流：
//   ① 设置层（stores/settings.ts）把「总开关 && 语言含中文」推进零依赖桥
//      （lib/editor/zhSpellcheckBridge.ts），内核不认识 Pinia；
//   ② 本插件按**段落**拼接行内文本（这样「《**标题**》」这种被 mark 拆开的成对符号
//      不会误报），调用 shared/spellcheckZh.ts 的纯函数规则；
//   ③ 命中换算成 PM 文档位置 → Decoration.inline 波浪线；文档变化后 **500ms 防抖**
//      重算，期间旧装饰按 mapping 平移（不会整块闪掉）；
//   ④ 右键时 EditorView 用 `getZhIssueAt` 取命中项，交给现有菜单。
//
// 排除区域（沿用正文 `spellcheck=true` / 其它显式 false 的口径）：
//   * 整块跳过：codeBlock（含 mermaid 源码）、mathBlock、frontmatter、htmlBlock、footnoteDef；
//   * 行内跳过：行内代码、行内公式、行内 HTML 原文、Markdown 标记字符。
//   规则是"只扫 Textblock 里的普通文本"，因此图片源码（装饰出来的行内文本）也不会进来。

import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  checkChinese,
  ZH_MAX_ISSUES,
  ZH_RECOMPUTE_DEBOUNCE_MS,
  type ZhSpellIssue
} from '../../../../shared/spellcheckZh.ts'
import { onZhSpellcheckEnabledChange, zhSpellcheckEnabled } from './zhSpellcheckBridge.ts'
// 显式 .ts：本模块要被 tests/*.test.mjs 直接加载（Node 的 ESM 不做扩展名补全）
import { noteHeavyWorkDeferred, shouldDeferHeavyWork } from './workBudget.ts'

/**
 * **单段长度上限**（本轮新增的防线）。
 *
 * 为什么要有：规则本身是 O(段长)，但这条链是"**每个 Textblock 都跑一遍**"，
 * 而表格单元格里的长段落（本次复报的第二张表：8 行、每格 100–200 字，还夹着行内
 * 代码/粗体被拆成十几个文本片段）会把"段数 × 段长"抬起来；再叠加 500 ms 防抖在
 * 每次 docChanged 后重排，粘贴后那一秒里就全在算波浪线。
 *
 * 超过这个长度**跳过该段**（不扫、不画波浪线）—— 丢的只是"提示"，不是内容；
 * 统计里记 `skippedLongBlocks`，控制台只提示一次（可见、可查，不静默）。
 * 4000 字≈A4 两页，正常段落远达不到；真到了那个量级，波浪线本身也没有阅读价值。
 */
export const ZH_MAX_PARAGRAPH_CHARS = 4000

/** 冷却期内的重算延后间隔（ms）：让路给"粘贴后必须跑完的"内容/落盘链路 */
const ZH_DEFERRED_RECOMPUTE_MS = 1500

/** 命中项在**文档坐标**里的形态（菜单/装饰/性能统计都用它） */
export interface ZhDocIssue extends ZhSpellIssue {
  /** 文档坐标 */
  from: number
  to: number
  /** 命中原文 */
  text: string
  /** 忽略用的稳定指纹（同"上文 + 原文 + 下文"视为同一处） */
  fingerprint: string
}

interface ZhPluginState {
  decorations: DecorationSet
  issues: ZhDocIssue[]
}

const SKIP_BLOCKS = new Set(['codeBlock', 'mathBlock', 'frontmatter', 'htmlBlock', 'footnoteDef'])

/** 这些 mark 是"源码/公式/标记"，不是自然语言正文 */
const SKIP_MARKS = new Set([
  'code',
  'mdCodeLiteral',
  'mdMath',
  'mdHtml',
  'htmlTailLiteral',
  'mdMarker',
  'mdEscape'
])

interface Segment {
  start: number
  end: number
  docStart: number
}

/** 已忽略的命中（会话内；按指纹忽略，位置变化后同一处仍然忽略） */
const ignored = new Set<string>()

/** 当前所有打开的编辑器视图（开关变化时逐个重算） */
const views = new Set<EditorView>()

const timers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>()

export interface ZhSpellStats {
  enabled: boolean
  lastMs: number
  lastCount: number
  /**
   * 最近一次扫描的命中明细（诊断对象 `window.__LZHSPELL` 读它）。
   *
   * 为什么要有：以前这里只有条数，验收/排查时只能说"有 0 条"，说不出"哪一段、
   * 哪条规则"；而中文命中的 `from/to` 是相对**段落文本**的，光看 DOM 波浪线
   * 对不上规则。现在留最近 50 条（`from/to` 是**文档坐标**，`text` 是命中原文），
   * 既能证明"该区间无命中"，也能直接指名规则。
   */
  lastIssues: ZhSpellHit[]
  /** 最近 50 次重算耗时（ms），验收脚本读它算 P50/P95 */
  durations: number[]
  debounceMs: number
  maxIssues: number
  /** 因超过单段长度上限被跳过的段数（降级可见：不静默） */
  skippedLongBlocks: number
  /** 最近一次因"重活预算冷却"而被延后的次数 */
  deferredRuns: number
}

/** 诊断对象里的一条命中（文档坐标） */
export interface ZhSpellHit {
  from: number
  to: number
  kind: ZhSpellIssue['kind']
  message: string
  text: string
}

const stats: ZhSpellStats = {
  enabled: false,
  lastMs: 0,
  lastCount: 0,
  lastIssues: [],
  durations: [],
  debounceMs: ZH_RECOMPUTE_DEBOUNCE_MS,
  maxIssues: ZH_MAX_ISSUES,
  skippedLongBlocks: 0,
  deferredRuns: 0
}

/** 性能/验收用的只读统计（与 perfProbe 的 `window.__LPERF` 同一做法） */
try {
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __LZHSPELL?: ZhSpellStats }).__LZHSPELL = stats
  }
} catch {
  /* 非渲染环境（单测 import）：忽略 */
}

/** 只读统计出口（单测用；浏览器侧另有 `window.__LZHSPELL`） */
export function zhSpellStats(): Readonly<ZhSpellStats> {
  return stats
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 文本偏移 → 文档位置（from 侧：落在哪一段就从那一段起算） */
function mapFrom(segments: readonly Segment[], offset: number): number | null {
  for (const seg of segments) {
    if (offset < seg.end) return seg.docStart + Math.max(0, offset - seg.start)
  }
  return null
}

/** 文本偏移 → 文档位置（to 侧：落在哪一段就从那一段结束处收） */
function mapTo(segments: readonly Segment[], offset: number): number | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if (offset > seg.start) return seg.docStart + Math.min(seg.end - seg.start, offset - seg.start)
  }
  return null
}

function fingerprintOf(doc: PmNode, from: number, to: number, kind: string): string {
  const text = doc.textBetween(from, to, '')
  const before = from > 0 ? doc.textBetween(Math.max(0, from - 1), from, '') : ''
  const after =
    to < doc.content.size ? doc.textBetween(to, Math.min(doc.content.size, to + 1), '') : ''
  return `${kind}\u0000${before}\u0000${text}\u0000${after}`
}

/**
 * 扫描整个文档，返回**文档坐标**的命中项。
 * 纯函数（不建 Decoration），单测可以直接用一个最小 schema 的 doc 断言排除区域。
 */
export function scanZhDoc(doc: PmNode): ZhDocIssue[] {
  if (!zhSpellcheckEnabled()) {
    stats.lastIssues = []
    return []
  }
  const started = now()
  const out: ZhDocIssue[] = []
  doc.descendants((node, pos) => {
    // 命中上限后不再处理后续块（超大文档也不让扫描时间无上界）
    if (out.length >= ZH_MAX_ISSUES) return false
    if (SKIP_BLOCKS.has(node.type.name)) return false
    if (!node.isTextblock) return true
    const segments: Segment[] = []
    let text = ''
    node.forEach((child, offset) => {
      if (!child.isText || !child.text) return
      if (child.marks.some((mark) => SKIP_MARKS.has(mark.type.name))) return
      segments.push({
        start: text.length,
        end: text.length + child.text.length,
        docStart: pos + 1 + offset
      })
      text += child.text
    })
    if (!text) return false
    /**
     * 单段长度上限：超长段落直接跳过（只少提示，不丢内容）。
     * 计数器 + 一次性控制台提示，保证"降级"是可查的，而不是悄悄没有波浪线。
     */
    if (text.length > ZH_MAX_PARAGRAPH_CHARS) {
      stats.skippedLongBlocks += 1
      if (stats.skippedLongBlocks === 1) {
        try {
          // ASCII 诊断（控制台不是界面文案；界面提示走语言包）
          console.warn(
            `[lumin] zh-spellcheck: skip paragraph longer than ${ZH_MAX_PARAGRAPH_CHARS} chars (this one ${text.length}); hints only, content untouched`
          )
        } catch {
          /* 忽略 */
        }
      }
      return false
    }
    for (const issue of checkChinese(text)) {
      const from = mapFrom(segments, issue.from)
      const to = mapTo(segments, issue.to)
      if (from === null || to === null || to <= from) continue
      const fingerprint = fingerprintOf(doc, from, to, issue.kind)
      if (ignored.has(fingerprint)) continue
      out.push({
        ...issue,
        from,
        to,
        text: doc.textBetween(from, to, ''),
        fingerprint
      })
      if (out.length >= ZH_MAX_ISSUES) break
    }
    return false
  })
  stats.lastMs = Math.round((now() - started) * 100) / 100
  stats.lastCount = out.length
  stats.lastIssues = out.slice(0, 50).map((issue) => ({
    from: issue.from,
    to: issue.to,
    kind: issue.kind,
    message: issue.message,
    text: issue.text
  }))
  stats.durations.push(stats.lastMs)
  if (stats.durations.length > 50) stats.durations.shift()
  return out
}

/** 扫描 + 建装饰（导出给单测断言"只在正文"） */
export function buildZhDecorations(doc: PmNode): {
  issues: ZhDocIssue[]
  decorations: DecorationSet
} {
  const issues = scanZhDoc(doc)
  const decorations = DecorationSet.create(
    doc,
    issues.map((issue) =>
      Decoration.inline(issue.from, issue.to, {
        class: 'zh-spell-issue',
        'data-zh-spell': issue.kind,
        // title 给鼠标悬浮一个说明；右键菜单里还有完整 message
        title: issue.message
      })
    )
  )
  return { issues, decorations }
}

export const zhSpellcheckPluginKey = new PluginKey<ZhPluginState>('zhSpellcheck')

function emptyState(): ZhPluginState {
  return { decorations: DecorationSet.empty, issues: [] }
}

function computeState(doc: PmNode): ZhPluginState {
  if (!zhSpellcheckEnabled()) return emptyState()
  return buildZhDecorations(doc)
}

/**
 * 500ms 防抖重算；`immediate` 用于开关切换（尽快看到下划线，但仍然异步，避免卡输入）。
 *
 * 本轮新增：**重活预算冷却期内自动让路**（`shouldDeferHeavyWork`）。粘贴/大改之后
 * 那几秒里，主线程要跑 `getMarkdown` 与落盘；拼写重算是"可选装饰"，延后到
 * `ZH_DEFERRED_RECOMPUTE_MS` 再做 —— 延后不是丢弃：定时器照旧会跑一次，
 * 只是晚一点（并在 `stats.deferredRuns` 里记一笔，不静默）。
 */
function schedule(view: EditorView, immediate = false): void {
  if (!views.has(view)) return
  const pending = timers.get(view)
  if (pending) clearTimeout(pending)
  const defer = !immediate && shouldDeferHeavyWork()
  if (defer) {
    stats.deferredRuns += 1
    noteHeavyWorkDeferred()
  }
  const timer = setTimeout(
    () => {
      timers.delete(view)
      if (!views.has(view)) return
      try {
        view.dispatch(view.state.tr.setMeta(zhSpellcheckPluginKey, { recompute: true }))
      } catch {
        /* 视图已销毁/正在销毁：忽略 */
      }
    },
    immediate ? 60 : defer ? ZH_DEFERRED_RECOMPUTE_MS : ZH_RECOMPUTE_DEBOUNCE_MS
  )
  timers.set(view, timer)
}

/** 开关变化：所有视图立刻重算（关掉时 apply 会清空装饰） */
onZhSpellcheckEnabledChange(() => {
  stats.enabled = zhSpellcheckEnabled()
  for (const view of views) schedule(view, true)
})

// 模块加载时设置可能已经先于编辑器应用过（启动顺序不唯一）：把统计值对齐一次。
stats.enabled = zhSpellcheckEnabled()

/** 右键：取文档坐标 `pos` 处的命中项（pos 落在 from..to 两端都算命中） */
export function getZhIssueAt(state: EditorState, pos: number): ZhDocIssue | null {
  const pluginState = zhSpellcheckPluginKey.getState(state)
  if (!pluginState) return null
  let best: ZhDocIssue | null = null
  for (const issue of pluginState.issues) {
    if (pos < issue.from || pos > issue.to) continue
    if (!best || issue.to - issue.from < best.to - best.from) best = issue
  }
  return best
}

/** 「忽略本次」：记住指纹并让所有视图重算 */
export function ignoreZhIssue(issue: Pick<ZhDocIssue, 'fingerprint'>): void {
  if (!issue.fingerprint) return
  ignored.add(issue.fingerprint)
  for (const view of views) schedule(view, true)
}

/**
 * Tiptap 扩展：只加一个 ProseMirror 插件，没有命令/节点/键盘绑定，
 * 不影响既有编辑器契约（拖拽禁用、代码块折行等）。
 */
export const ZhSpellcheck = Extension.create({
  name: 'zhSpellcheck',
  addProseMirrorPlugins() {
    return [
      new Plugin<ZhPluginState>({
        key: zhSpellcheckPluginKey,
        state: {
          init: () => emptyState(),
          apply(tr, prev, _oldState, newState) {
            if (!zhSpellcheckEnabled()) return emptyState()
            if (tr.getMeta(zhSpellcheckPluginKey)) return computeState(newState.doc)
            if (tr.docChanged) {
              // 防抖期间先按 mapping 平移旧装饰：不闪、不指错位置。
              // 命中数据（右键用）先清空：位置可能已经变了，宁可等 500ms 重算，
              // 也不能拿旧 from/to 去改文档。
              return {
                decorations: prev.decorations.map(tr.mapping, tr.doc),
                issues: []
              }
            }
            return prev
          }
        },
        props: {
          decorations(state) {
            return zhSpellcheckPluginKey.getState(state)?.decorations ?? null
          }
        },
        view(view) {
          views.add(view)
          schedule(view, true)
          return {
            update(current, prevState) {
              if (current.state.doc !== prevState.doc) schedule(current)
            },
            destroy() {
              views.delete(view)
              const pending = timers.get(view)
              if (pending) clearTimeout(pending)
              timers.delete(view)
            }
          }
        }
      })
    ]
  }
})
