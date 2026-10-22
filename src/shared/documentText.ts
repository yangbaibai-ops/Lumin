/**
 * ─── 文档文本规则（纯函数，可单测）────────────────────────────────────────────
 *
 * 「编辑器里的一段内容」与「磁盘上的一份文档」不是一回事，两者之间有几条**成文规则**。
 * 这些规则以前散在渲染层各处（或者干脆没有），结果是「打开→保存」文件会变，
 * 用户看到的是「编辑器偷偷改了我的文件」。集中到这里，谁都能复用、也能被 tests/ 直接测。
 *
 * 规则 1：非空文档以**且仅以**一个换行结尾。
 *   * 为什么必须补：POSIX 文本文件约定、git 的 "\ No newline at end of file" 噪声、
 *     追加内容时的踩踏风险（`cat a b` 会把两行黏在一起）；
 *   * 为什么必须只有**一个**：文末连续空行是纯噪声，序列化器也不该产出 `\n\n\n`；
 *   * 空文档保持空（补一个换行会让「全选删除」后的空文档变成 1 字节文件，
 *     而空白新文档保存成 0 字节更符合直觉）。
 *
 * 规则 2：**整行只由标记字符组成**（`*` `~` `` ` `` `_`）时，逐字符转义
 *   （见 escapeMarkerOnlyLines）：否则重开时会被 CommonMark 当成分割线/代码围栏，
 *   字符被静默改写。
 */
export function withFinalNewline(text: string): string {
  if (!text) return text
  return text.replace(/\n+$/, '') + '\n'
}

/**
 * 脏判定用的**归一化**：行尾统一成 LF，并去掉末尾空行。
 *
 * 为什么脏判定不能用逐字节比较（用户报障「只切观看模式就出现未保存小圆点」）：
 *   * 打开一篇**结尾没有换行**的文件时，编辑器序列化会按规则 1 补一个 `\n`
 *     （`withFinalNewline`），内容与 `savedContent` 只差这一个字节；
 *   * 用户**什么都没改**，模式切换/自动落盘把这份序列化结果写回 store，逐字节比较
 *     立刻判成「已修改」，退出时还弹保存提示。
 * 归一化必须与保存口径一致：保存写盘前也会把行尾统一（`toLf`），文末连续空行本来
 * 就不保留（规则 1「有且仅有一个换行」），所以这两类差异都不该算"内容变了"。
 *
 * 注意：**中间**的空行、缩进、行内空格一律保留 —— 它们是真的内容差异。
 */
export function normalizeForDirtyCompare(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

/** 两份文档文本在"脏判定"口径下是否相同（见 normalizeForDirtyCompare） */
export function sameDocumentText(a: string, b: string): boolean {
  return normalizeForDirtyCompare(a) === normalizeForDirtyCompare(b)
}

/** 「整行只有标记字符」：`*` `~` `` ` `` `_`（四种都可能开启块级构造或强调语法） */
const MARKER_ONLY_LINE = /^[*~`_]+$/

/**
 * 规则 2：**整行只由标记字符组成**时逐字符转义（`*` → `\*`、`~` → `\~`、`` ` `` → `` \` ``、
 * `_` → `\_`）。
 *
 * 为什么必须转义：这些整行写法在 CommonMark 里**不是**普通文本 ——
 *   * `****`（四个及以上 `*`）= **分割线**；
 *   * `~~~~`（三个及以上 `~`）= **代码围栏**开头；
 *   * `___`（三个及以上 `_`）= 分割线。
 * 而编辑器里「空光标点工具栏加粗/删除线」得到的正文正好就是 `****` / `~~~~`
 * （标记字符是文档里的真实文本，光标要落在两个标记之间才好接着打字）。不转义的话，
 * 用户存盘再打开会看到：段落变成了分割线 / 内容变成空代码块 —— **字符被静默改写**，
 * 正是「标记文本即源码」模型要消灭的那类问题。
 *
 * 转义之后：文件里是 `\*\*\*\*`，重开仍是**字面文本** `****`（不会变分割线），
 * 而且跨编辑器一致（别的 Markdown 编辑器也渲染成字面星号）。代价是「文件字节」与
 * 「屏幕上那四个字符」差了几个反斜杠 —— 按「绝不静默改变语义」优先于「原始字节逐字
 * 相同」的口径，这个代价是划算的（产品口径见手册 §4.70）。
 *
 * 边界（都刻意排除，避免误伤）：
 *   * **代码围栏与其内部内容一律不动**：反引号围栏（` ``` `）和「整行标记」长得一模一样，
 *     围栏内的行是**代码内容**，改一个字节都不行 → 扫描时维护「是否在反引号围栏内」的状态。
 *     开启围栏可以带 info（```js），**闭合围栏后面只能是空白**（CommonMark 同款判定：
 *     代码块里出现「```js」这种行时不能把它当成闭合）。
 *     只认反引号围栏：本仓库的序列化器（CodeBlock / codeFenceFor）只写反引号围栏，
 *     波浪线整行只会出现在正文里（空段落点删除线得到的 `~~~~` 正是要转义的那种）；
 *   * `protect`：**原样写回的节点**（HTML 块 / 公式块 / front matter，`attrs.source`）
 *     里的行走这条通道跳过 —— 它们的内容是用户的原文，一个字节都不许动；
 *   * 有**前导空白**的行不动（缩进代码块/列表续行的内容按字面理解）；
 *   * 行尾空白保留（只有它前面的标记字符被转义）；
 *   * `-`/`>`/`#`/数字序号等不在集合里：分割线的 `---` 与列表/引用标记另有规则，
 *     且它们本来就是块级语法，不需要在这里处理（代价是「引用/列表里的空段落点加粗」
 *     这种带前缀的整行标记不会被转义，属已知边界，见手册 §4.70）。
 */
export function escapeMarkerOnlyLines(text: string, protect?: Iterable<string>): string {
  // 快速通道：整篇连一个标记字符都没有（绝大多数文档）→ 原样返回
  if (!text || !/[*~`_]/.test(text)) return text
  const guarded = new Set<string>()
  if (protect) {
    for (const line of protect) {
      guarded.add(line)
      guarded.add(line.trimEnd())
    }
  }
  let changed = false
  /** 当前反引号围栏的长度（0 = 不在围栏内） */
  let fence = 0
  const lines = text.split('\n').map((line) => {
    // 开启围栏：三个以上反引号，后面可以带 info（```js）
    const fenceOpen = /^\s{0,3}(`{3,})/.exec(line)
    // 闭合围栏：三个以上反引号**后面只有空白**（CommonMark：收尾围栏不能带 info，
    // 否则那行是内容 —— 代码块里出现「```js」这种行很常见，不能把它当成闭合）
    const fenceClose = /^\s{0,3}(`{3,})\s*$/.exec(line)
    if (fenceOpen) {
      if (fence === 0) fence = fenceOpen[1].length
      else if (fenceClose && fenceClose[1].length >= fence) fence = 0
      return line
    }
    if (fence !== 0) return line
    if (guarded.has(line)) return line
    // 前导空白 → 跳过（缩进行不是「整行标记」）
    if (line.length !== line.trimStart().length) return line
    const body = line.trimEnd()
    if (!body || !MARKER_ONLY_LINE.test(body)) return line
    changed = true
    return body.replace(/[*~`_]/g, (c) => '\\' + c) + line.slice(body.length)
  })
  return changed ? lines.join('\n') : text
}

/**
 * 代码围栏标记：内容里出现连续反引号时，围栏必须比它更长，否则围栏会被内容里的
 * ``` 提前闭合，后面的正文就被解析成代码（**内容损坏**，不是格式差异）。
 * CommonMark 的要求是围栏长度 ≥ 3 且不与内容里的连续反引号冲突。
 */
export function codeFenceFor(content: string): string {
  const runs = content.match(/`+/g)
  let longest = 0
  if (runs) for (const r of runs) longest = Math.max(longest, r.length)
  return '`'.repeat(Math.max(3, longest + 1))
}
