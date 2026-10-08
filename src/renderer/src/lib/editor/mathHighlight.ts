// ─── 公式源码的分词高亮（**只切段、不改文本**）──────────────────────────────────
//
// 为什么需要这一层：`<textarea>` 内部文本的颜色由浏览器自己画，**没有 API 能只染一部分**
// （`color` 只能整块改）。所以高亮不是"给 textarea 上色"，而是：
//   * 真正接收输入的 textarea 把文字设成**透明**（`color: transparent`，
//     用 `caret-color` 把插入符单独救回来）——它只负责输入法与光标导航；
//   * 底下一层**绝对定位的装饰层**（`div[data-md-math-editor-hl]`，`white-space: pre`）
//     用同一份文本、按 token 上色 —— 它 `pointer-events:none` + `aria-hidden`，纯装饰。
//     用 `div` 而不是 `pre`：源码区在 `.md-preview` 里面，`.md-preview pre` 那类正文规则
//     会盖掉共享盒模型（实测两层错位 13px）。换行规则由 CSS 显式写 `white-space: pre`。
// 两层的字体 / 内边距 / 换行规则 / 宽度必须**逐像素一致**，对齐口径写在
// `assets/overlays.css` 的 `.md-math-editor__field` 一节（改一处就得同步另一处）。
//
// 为什么不用 contenteditable + 重写 span（另一条路）：每次输入后重排内部 DOM 会丢光标，
// 中文输入法组字期间重写节点更会把组字串打断 —— 用户口径「输入 / 删除 / IME 都要能用」
// 让那条路的成本高得多。镜像层对输入法**完全无侵入**（组字期间还会主动让位，见
// mathPreview.ts 的 compositionstart 处理）。
//
// 铁律：**分词只是把原文切段，拼回去必须逐字等于原文**。用户文件里仍然是 `\frac{a}{b}`，
// 高亮一个字符都不许增删（`tests/mathHighlight.test.mjs` 逐字钉住，套件里再按真实 DOM 复核）。
//
// 本模块**不依赖任何运行时**（没有 vue / i18n / tiptap）：它要能被 `node --test` 直接加载，
// 也只在浏览器里碰 DOM（`fillHighlight`）。

/** 分出来的"颜色类"：够区分「命令 / 花括号与参数 / 普通文本」三类，另加数字与注释 */
export type MathTokenClass = 'cmd' | 'brace' | 'num' | 'com' | 'plain'

/**
 * 颜色类 → CSS 类名。
 *
 * 颜色**一律由 CSS 里的既有令牌给**（`--code-key` / `--code-num` / `--code-str` /
 * `--code-com` / `--ink`，见 overlays.css）—— 所以这里只出类名，不碰色值。
 * 选 `--code-*` 那一族是因为它们本来就是**代码类文本**的语义色，而且
 * `tests/themeTokens.test.mjs` 已经逐主题钉住了"对 `--code-bg` ≥ 4.5:1"，
 * 而源码区的底色正是 `--code-bg`。
 */
export const MATH_TOKEN_CLASS: Record<MathTokenClass, string> = {
  /** LaTeX 命令：`\frac` / `\sqrt` / `\\` / `\,` */
  cmd: 'md-math-tok--cmd',
  /** 分组与定界：`{` `}` `[` `]` `(` `)` —— 参数就裹在里面 */
  brace: 'md-math-tok--brace',
  num: 'md-math-tok--num',
  /** `%` 到行尾（TeX 注释） */
  com: 'md-math-tok--com',
  /** 其余（字母、中文、运算符、空格） */
  plain: 'md-math-tok--plain'
}

export interface MathToken {
  cls: MathTokenClass
  text: string
}

/** 一个字符是不是"自成一段"的边界（花括号 / 数字 / 命令 / 注释的起点） */
function startsToken(ch: string): boolean {
  return (
    ch === '\\' ||
    ch === '%' ||
    ch === '{' ||
    ch === '}' ||
    ch === '[' ||
    ch === ']' ||
    ch === '(' ||
    ch === ')' ||
    (ch >= '0' && ch <= '9')
  )
}

/**
 * 把公式源码切成着色段。**相邻同类会合并**（少造 DOM 节点，也让断言数得清类）。
 *
 * 保证：`tokenizeTex(s).map((t) => t.text).join('') === s`（逐字，含所有空白）。
 */
export function tokenizeTex(tex: string): MathToken[] {
  const out: MathToken[] = []
  const push = (cls: MathTokenClass, text: string): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.cls === cls) last.text += text
    else out.push({ cls, text })
  }
  let i = 0
  while (i < tex.length) {
    const ch = tex[i]
    if (ch === '\\') {
      // 命令 = 反斜杠 + 连续的 ASCII 字母；`\\` / `\,` / `\{` 这类"反斜杠 + 单字符"也算命令
      // （它们在 TeX 里确实是命令）。行尾孤零零的反斜杠也要吃掉，否则会死循环。
      let j = i + 1
      if (j < tex.length && /[A-Za-z]/.test(tex[j])) {
        while (j < tex.length && /[A-Za-z]/.test(tex[j])) j += 1
      } else if (j < tex.length) {
        j += 1
      }
      push('cmd', tex.slice(i, j))
      i = j
      continue
    }
    if (ch === '%') {
      const nl = tex.indexOf('\n', i)
      const end = nl < 0 ? tex.length : nl
      push('com', tex.slice(i, end))
      i = end
      continue
    }
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '(' || ch === ')') {
      push('brace', ch)
      i += 1
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < tex.length && ((tex[j] >= '0' && tex[j] <= '9') || tex[j] === '.')) j += 1
      push('num', tex.slice(i, j))
      i = j
      continue
    }
    let j = i + 1
    while (j < tex.length && !startsToken(tex[j])) j += 1
    push('plain', tex.slice(i, j))
    i = j
  }
  return out
}

/**
 * 把高亮片段画进镜像层（**只改这个装饰层**，textarea 的 value 与文档都不动）。
 *
 * 为什么每次全量重画而不是做 diff：源码区一次最多几十个字符、几个 span，
 * 全量重画比 diff 更少出错（而且这一层没有光标/选区状态可丢，见模块头）。
 */
export function fillHighlight(host: HTMLElement, tex: string): void {
  const tokens = tokenizeTex(tex)
  const frag = document.createDocumentFragment()
  for (const t of tokens) {
    const span = document.createElement('span')
    span.className = MATH_TOKEN_CLASS[t.cls]
    span.setAttribute('data-md-math-tok', t.cls)
    span.textContent = t.text
    frag.append(span)
  }
  host.replaceChildren(frag)
}
