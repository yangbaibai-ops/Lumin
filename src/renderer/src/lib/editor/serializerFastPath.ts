// ─── Markdown 序列化的超线性热区：`atBlank()` ───────────────────────────────────
//
// 真因：`prosemirror-markdown` 的 `MarkdownSerializerState.atBlank()` 是
// ```js
// atBlank() { return /(^|\n)$/.test(this.out) }
// ```
// 而 `out` 是**逐次 `+=` 累积出来的 cons string**。对 cons string 跑正则（以及
// `charCodeAt` / `endsWith` 这类随机访问）都会强制 V8 把整串**拍平**；`write()` 每次
// 都经 `flushClose()` 调一次 `atBlank()` ⇒ 每写一小段就把"目前已写出的全文"复制一遍
// ⇒ O(节点数 × 总长度)。
//
// 实测（同一份 4 张内联 base64 的文档反复粘贴，只改这一个判据）：
//   3.4 MB → 25 ms；6.9 MB → 122 ms；10.3 MB → 345 ms；13.8 MB → 635 ms；
//   17.2 MB → 1077 ms；20.6 MB → 1589 ms —— 典型二次增长。
// CPU profile 里 `atBlank` 占 70% 以上，调用栈 `atBlank ← flushClose ← write ← text ← serialize`。
//
// ── 修法：把"是否以换行结尾"变成随写入记下来的**布尔值**（O(1)），永不读回 out ──
//
// ⚠️ **上一版这里写错了**（本轮复查发现：它是数据保真缺陷，不是性能问题）：
// 上一版记录"最后一个字符" `end`，并假设 `text()` 之后 out 一定以 `"\n"` 结尾。
// 上游 1.13 的实现并不是这样：
// ```js
// text(text, escape = true) {
//   let lines = text.split("\n")
//   for (let i = 0; i < lines.length; i++) {
//     this.write()                                       // 无参数
//     if (!escape && lines[i][0] == "[") this.out = this.out.slice(...) + "\\!"
//     this.out += escape ? this.esc(lines[i]) : lines[i]  // 直接追加；最后一行**没有**换行
//     if (i != lines.length - 1) this.ensureNewLine()
//   }
// }
// ```
// 于是"刚写完一段正文"时 out 其实**不以换行结尾**，旧补丁却回报 `atBlank() === true`
// ⇒ `flushClose()` / `ensureNewLine()` 都以为"已经在行首"⇒ **不写换行** ⇒
// 列表项粘成一行、引用块粘成 `> …>`、任务项连成 `- [ ] a- [ ] b`（实测原文，见本轮报告）。
// 这类输出再被打开/落盘就是结构损坏 —— 与本轮要修的"卡死"无关，但同样必须修。
//
// 现在按**每个方法的真实语义**推导"是否以换行结尾"（`blank`）：
//   * `flushClose` / `ensureNewLine`：追加的一定是 `"\n"`（或其前有 delimMin）⇒ blank=true；
//   * `write(content)`：追加顺序是 [flushClose 的换行][delim][content]；
//     有 content ⇒ blank = content 是否以 `"\n"` 结尾；无 content ⇒ blank = delim 是否以 `"\n"` 结尾
//     （都没有 ⇒ 长度不变，缓存不动，交给里层已经记好的值）；
//   * `text(s)`：最后一行是**原样追加**的（`esc()` 不会增删 `"\n"`）⇒ blank = s 是否以 `"\n"` 结尾；
//     `s === ''` 时长度只可能因里层的 `write()` 变化，那由里层负责，这里不覆盖。
// 语义与上游正则**逐字等价**（单测 `tests/serializerFastPath.test.mjs` 直接对比新旧实现
// 对同一批文档的**完整序列化输出**）。
//
// 这里是**替换一个纯判据**，输出字节完全不变；上游若改结构（方法不存在），自动放弃补丁、
// 退回原实现 —— 宁可慢，也不能坏。
import { MarkdownSerializerState } from 'prosemirror-markdown'

/** `out` 的"是否以换行结尾"状态：len 用于兜底校验（长度没变就复用，变了就重算一次） */
const blankByState = new WeakMap<object, { len: number; blank: boolean }>()

interface StateLike {
  out?: unknown
  delim?: unknown
}

type AnyFn = (...args: unknown[]) => unknown

/** 读一次（仅用于第一次或兜底；之后都走增量记录） */
function computeBlank(state: StateLike): boolean {
  const out = state.out
  if (typeof out !== 'string' || out.length === 0) return true
  return out.charCodeAt(out.length - 1) === 10
}

function remember(state: StateLike, blank: boolean): boolean {
  const len = typeof state.out === 'string' ? state.out.length : 0
  blankByState.set(state as object, { len, blank })
  return blank
}

function blankOf(state: StateLike): boolean {
  const cached = blankByState.get(state as object)
  const len = typeof state.out === 'string' ? state.out.length : 0
  // 长度没变 ⇒ 记下来的判定仍然有效（生产路径只有上游的 `+=`，长度单调增）；
  // 长度变了却没经过我们补丁的方法（外部直接改 `out`）⇒ 重算一次，保证判据不漂。
  if (cached && cached.len === len) return cached.blank
  return remember(state, computeBlank(state))
}

/** 空串 / 以换行结尾（与 `/(^|\n)$/.test(out)` 等价） */
export function fastAtBlank(out: string): boolean {
  if (out.length === 0) return true
  return out.charCodeAt(out.length - 1) === 10
}

/** 入参的"追加后是否以换行结尾"；`null` = 由入参推不出来（交给里层已经记好的值） */
function endsWithNewline(s: unknown): boolean | null {
  return typeof s === 'string' && s.length ? s.endsWith('\n') : null
}

let installed = false

/**
 * 给 `MarkdownSerializerState` 装上快路径（**幂等**）。
 *
 * 只在本模块被 import 时执行一次。任何前提不满足（上游改版 / 方法不在原型上）就
 * **什么都不做** —— 序列化退回原实现，功能不受影响。
 */
export function installFastMarkdownSerializer(): void {
  if (installed) return
  const proto = MarkdownSerializerState.prototype as unknown as Record<string, unknown>
  if (typeof proto.atBlank !== 'function') return
  const write = proto.write as AnyFn | undefined
  const flushClose = proto.flushClose as AnyFn | undefined
  const ensureNewLine = proto.ensureNewLine as AnyFn | undefined
  const text = proto.text as AnyFn | undefined
  if (!write || !flushClose || !ensureNewLine || !text) return
  installed = true

  const track = (
    name: 'write' | 'flushClose' | 'ensureNewLine' | 'text',
    nextBlank: (state: StateLike, args: unknown[]) => boolean | null
  ): void => {
    const orig = proto[name] as AnyFn
    proto[name] = function patched(this: StateLike, ...args: unknown[]): unknown {
      const before = typeof this.out === 'string' ? this.out.length : 0
      // 先保证缓存与当前 out 对齐（第一次调用时算一次，之后都是增量）
      blankOf(this)
      const res = orig.apply(this, args)
      const after = typeof this.out === 'string' ? this.out.length : 0
      if (after !== before) {
        const next = nextBlank(this, args)
        remember(this, next === null ? computeBlank(this) : next)
      }
      return res
    }
  }

  // flushClose / ensureNewLine：追加的一定以 "\n" 结尾
  track('flushClose', () => true)
  track('ensureNewLine', () => true)
  // text：最后一行原样追加（见文件头），只有"文本本身以 \n 结尾"才算行首
  track('text', (_state, args) => endsWithNewline(args[0]))
  // write：有 content ⇒ 看 content；否则看 delim（都没有 ⇒ 交给里层/兜底）
  track('write', (state, args) => {
    const fromContent = endsWithNewline(args[0])
    if (fromContent !== null) return fromContent
    return endsWithNewline(state.delim)
  })

  proto.atBlank = function atBlankFast(this: StateLike): boolean {
    return blankOf(this)
  }
}

/**
 * 序列化器在**别处直接改 `state.out`** 之后，把"是否以换行结尾"缓存对齐。
 *
 * 为什么需要：`atBlank()` 的快路径靠 `{len, blank}` 增量记录。一旦有代码绕过
 * `write/flushClose/text` 直接给 `out` 赋值（表格单元格就是），缓存的 `len` 就对不上，
 * 下一次 `atBlank()` 会走 `computeBlank()` —— 而它对 cons string 做 `charCodeAt`
 * 会强制 V8 **把整串拍平**（O(已写出的全文)）。每个单元格一次 ⇒ 单元格数 × 全长,
 * 这就是"含两张长表格的文档序列化仍然超线性"的最后一处。
 *
 * 调用约定：`state.out` 已经是新值，`appended` 是这次**追加**的那段文本
 * （空串 ⇒ 长度没变，缓存本来就有效，什么都不做）。
 */
export function noteSerializerAppend(state: unknown, appended: string): void {
  if (!appended.length) return
  const s = state as StateLike
  if (typeof s.out !== 'string') return
  remember(s, appended.endsWith('\n'))
}
