/**
 * 选区取证（临时诊断，第三十八轮）：用来在"只有用户能复现"的环境里取证。
 *
 * 开关：localStorage['lumin.selTrace'] === '1'（默认关闭 ⇒ traceRow 立即 return，零开销）。
 * 输出：一次手势结束后，把整段以 `[lumin-sel-trace]` 开头的文本打到 DevTools 控制台（整段复制即可）；
 *      同时也挂在 window.__mdSelTrace（数组）上，便于自动化读取。
 * 只读状态、不改任何行为；定位完后可整体删除（删本文件 + typoraInlineMarks.ts 里的 import/traceAttach/traceRow 三处）。
 */
interface TraceView {
  state: {
    selection: { from: number; to: number; constructor: { name: string } }
    doc: { textBetween: (a: number, b: number, s?: string) => string }
  }
}

const KEY = 'lumin.selTrace'

let view: TraceView | null = null
let seq = 0
let rows: string[] = []
let maxTo = -1
let maxFrom = Number.MAX_SAFE_INTEGER

export function traceOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function traceAttach(v: unknown): void {
  view = v as TraceView
}

/** 表格拖选的内部决策（第四十四轮）：由 `tableClipboard` 写在 `window.__mdTableDrag` 上 */
function tableDragState(): unknown {
  try {
    return (window as unknown as Record<string, unknown>).__mdTableDrag ?? null
  } catch {
    return null
  }
}

function markerFontSizes(): string {
  try {
    const list = [...document.querySelectorAll('.md-marker')]
    return list
      .map((e) => getComputedStyle(e).fontSize.replace('px', ''))
      .join('/')
      .slice(0, 60)
  } catch {
    return '?'
  }
}

function snap(tag: string, extra?: Record<string, unknown>): void {
  if (!traceOn()) return
  try {
    const sel = view?.state.selection
    const from = sel ? sel.from : -1
    const to = sel ? sel.to : -1
    const type = sel ? sel.constructor.name : '?'
    if (to > maxTo) maxTo = to
    if (from < maxFrom) maxFrom = from
    const ed = document.querySelector('.ProseMirror')
    const rec: Record<string, unknown> = {
      i: rows.length,
      tag,
      sel: from + '-' + to,
      type,
      fs: markerFontSizes(),
      st: ed ? Math.round((ed as HTMLElement).scrollTop) : -1,
      act: document.activeElement ? document.activeElement.tagName : '?',
      td: tableDragState(),
      ...(extra || {})
    }
    const line = JSON.stringify(rec)
    rows.push(line)
    try {
      const w = window as unknown as { __mdSelTrace?: string[] }
      if (!w.__mdSelTrace) w.__mdSelTrace = []
      w.__mdSelTrace.push(line)
    } catch {
      /* 忽略 */
    }
  } catch {
    /* 诊断自身绝不抛 */
  }
}

/** 由手势代码调用：记录一行（tag 由调用点给），并把 onUp 的调用次数累计进去。 */
export function traceRow(tag: string, extra?: Record<string, unknown>): void {
  snap(tag, extra)
}

/** 一次手势结束后调用：重置序号、补三档延时采样、最后整段打印一次。 */
export function traceFlush(): void {
  if (!traceOn()) return
  seq += 1
  const my = seq
  const wrap = (tag: string): void => snap(tag)
  setTimeout(() => {
    if (my !== seq) return
    wrap('+1frame')
  }, 0)
  setTimeout(() => {
    if (my !== seq) return
    wrap('+50ms')
  }, 50)
  setTimeout(() => {
    if (my !== seq) return
    wrap('+170ms')
    try {
      const last = rows.length ? (JSON.parse(rows[rows.length - 1]) as { sel: string }) : null
      const tailTo = last ? Number(last.sel.split('-')[1]) : -1
      // 控制台诊断串一律 ASCII：这层只在排查时打开，且 `tests/i18nHardcoded.test.mjs`
      // 会把字符串字面量里的中文当成"绕过语言包的界面文案"（这里不是界面，但也别破规矩）
      const verdict =
        '[verdict] maxTo=' + maxTo + ' tailTo=' + tailTo + ' tailLost=' + String(tailTo < maxTo)
      const header =
        '[lumin-sel-trace] seq=' + my + ' rows=' + rows.length + ' ' + verdict + ' copy-all:'
      console.log(header + '\n' + rows.join('\n'))
      rows = []
      maxTo = -1
      maxFrom = Number.MAX_SAFE_INTEGER
    } catch {
      /* 忽略 */
    }
  }, 170)
}

/** 捕获阶段监听（只读、只在开关打开时记录）——装在 document 上，与业务监听互不干扰。 */
export function traceInstall(): void {
  const on = (t: string): void => {
    document.addEventListener(
      t,
      () => {
        if (!traceOn()) return
        snap('doc:' + t)
      },
      true
    )
  }
  for (const t of [
    'pointerdown',
    'mousedown',
    'mousemove',
    'pointerup',
    'mouseup',
    'pointercancel'
  ])
    on(t)
}
