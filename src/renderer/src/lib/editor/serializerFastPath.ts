// ─── Markdown 序列化的超线性热区：`atBlank()` ───────────────────────────────────
//
// 真因（实测，见本轮报告 §profile）：
// `prosemirror-markdown` 的 `MarkdownSerializerState.atBlank()` 是这么写的：
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
// 修法：把"输出是否以换行结尾"变成**追加时顺带记下来的一个字符**（O(1)），
// `atBlank()` 只读这个记下来的值，**永远不碰已经累积的大字符串**。
// `out` 的追加点在上游只有四处（`flushClose` / `ensureNewLine` / `write` / `text`），
// 每处的结尾字符都可以由**入参**推出来（见下面各 `nextEnd` 的推导），所以不需要读 `out`：
//   * flushClose / ensureNewLine：只要长度变了，追加的一定是 `"\n"`；
//   * write：有 content ⇒ 结尾是 content 的最后一个字符；否则 delim 非空 ⇒ delim 的最后一个字符；否则 `"\n"`；
//   * text：每行都补一个 `"\n"`（最后一行也是）。
//
// 语义与正则逐字等价（单测 `tests/serializerFastPath.test.mjs` 用同一批输入对比新旧实现）。
// 这里是**替换一个纯判据**，输出字节完全不变；上游若改结构（方法不存在），自动放弃补丁、
// 退回原实现 —— 宁可慢，也不能坏。
import { MarkdownSerializerState } from 'prosemirror-markdown'

/** `out` 的"最后一步"状态：-1 = 空串，否则是最后一个 charCode；len 用于兜底校验 */
const endByState = new WeakMap<object, { len: number; end: number }>()

const FLAG_END = 10 // '\n'

interface StateLike {
  out?: unknown
  delim?: unknown
}

type AnyFn = (...args: unknown[]) => unknown

/** 读一次（仅用于第一次或兜底；之后都走增量记录） */
function computeEnd(state: StateLike): number {
  const out = state.out
  if (typeof out !== 'string' || out.length === 0) return -1
  return out.charCodeAt(out.length - 1)
}

function remember(state: StateLike, end: number): number {
  const len = typeof state.out === 'string' ? state.out.length : 0
  endByState.set(state as object, { len, end })
  return end
}

function endOf(state: StateLike): number {
  const cached = endByState.get(state as object)
  const len = typeof state.out === 'string' ? state.out.length : 0
  // 长度没变 ⇒ 记下来的字符仍然有效（生产路径只有上游的 `+=`，长度单调增）；
  // 长度变了却没经过我们补丁的方法（外部直接改 `out`）⇒ 重算一次，保证判据不漂。
  if (cached && cached.len === len) return cached.end
  return remember(state, computeEnd(state))
}

/** 空串 / 以换行结尾（与 `/(^|\n)$/.test(out)` 等价） */
export function fastAtBlank(out: string): boolean {
  if (out.length === 0) return true
  return out.charCodeAt(out.length - 1) === FLAG_END
}

function lastCode(s: unknown): number {
  return typeof s === 'string' && s.length ? s.charCodeAt(s.length - 1) : -1
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
    nextEnd: (state: StateLike, before: number, args: unknown[]) => number
  ): void => {
    const orig = proto[name] as AnyFn
    proto[name] = function patched(this: StateLike, ...args: unknown[]): unknown {
      const before = typeof this.out === 'string' ? this.out.length : 0
      // 先保证缓存与当前 out 对齐（第一次调用时算一次，之后都是增量）
      endOf(this)
      const res = orig.apply(this, args)
      const after = typeof this.out === 'string' ? this.out.length : 0
      if (after !== before) remember(this, nextEnd(this, before, args))
      return res
    }
  }

  track('flushClose', () => FLAG_END)
  track('ensureNewLine', () => FLAG_END)
  track('text', () => FLAG_END)
  track('write', (state, _before, args) => {
    const content = args[0]
    if (typeof content === 'string' && content.length) return lastCode(content)
    return typeof state.delim === 'string' && state.delim.length ? lastCode(state.delim) : FLAG_END
  })

  proto.atBlank = function atBlankFast(this: StateLike): boolean {
    const end = endOf(this)
    return end === -1 || end === FLAG_END
  }
}

/** 单测用：把"已安装"标记复位（原型上的补丁保留，重复安装是幂等的） */
export function resetFastMarkdownSerializerForTests(): void {
  installed = false
}
