// ─── 表格的剪贴板形态（第十四轮）：复制给 **Markdown**，粘 HTML 表格变 **Markdown 表格** ──
//
// 用户口径（两条一起报的，其实是同一条链的两端）：
//   「有时候从这个项目中复制（或者复制到）表格的内容是 html 格式，而非是 md 格式，
//     如果这是不对的，请优化下。」
//
// ── 复制端：实测结论（改前**大部分是对的**，但没有被钉住，且有夹缝）──────────────
// `Markdown.configure({ transformCopiedText: true })`（extensions.ts）已经把
// `clipboardTextSerializer` 换成了 markdown 序列化器，所以**整表选中**复制时
// `text/plain` 本来就是管道表（实测 `| 甲甲 | 乙乙 |\n| --- | --- |\n| 一一 | 二二 |\n`）。
// 夹缝有三个：
//   ① `clipboardSerializer`（`text/html` 那一路）没人接管 —— 实测
//      `someProp('clipboardSerializer')` 为 false，写进剪贴板的 HTML 是**浏览器按 DOM
//      序列化**的 `<table style="min-width: 50px;"><colgroup>…`，与本项目导出的 HTML 不是同一份。
//      它当富文本目标是够用的 ⇒ 本轮**保留**（取舍见下）；
//   ② `text/plain` 完全依赖 PM 在 `copy` 处理器里那个时机 —— 实测
//      `document.execCommand('copy')` 在 Electron 里返回 **false** 且 `clipboardData` 是空的
//      （真实复制由系统菜单 / Ctrl+C 触发）。所以**不能假设"PM 一定会写"**，
//      要自己保证 `text/plain` 是 Markdown；
//   ③ 选区只有一部分与表格相交时（例如从单元格中间拖出去），PM 给的是段落切片，
//      `text/plain` 会退化成**没有分隔行的残表**（实测 `| 甲甲 |\n| --- |\n`）。
// 本层做一件事：**只要选区与表格相交，就自己把 Markdown 写进 `text/plain`**。
// 序列化复用唯一出口 `tableMarkdown.serializeTable`（与落盘逐字节同源），
// 于是"复制出来的 Markdown"与"存到磁盘的 Markdown"不可能漂。
//
// 取舍：`text/html` **刻意保留浏览器那一路**（真的 `<table>`）：
//   * 粘到 Word / 网页富文本目标要的是"表格"，把 Markdown 塞进 `text/html` 更糟；
//   * 本项目**粘回自己**走 `text/plain`（Markdown 通道，实测往返逐字节一致），不依赖它。
//
// ── 粘贴端：真因（实测，这才是"表格内容变成 HTML 格式"的主因）────────────────────
// 从 Word / Excel / 网页复制一张**没有表头行**的表格（整表都是 `<td>`、没有 `<th>`）粘进来：
//   * ProseMirror **能**把它解析成真表格节点（实测 `table/tableRow/tableCell/paragraph`，
//     `htmlBlock` 计数 **0**）—— 所以"粘进来是 HTML 字面量"这个猜测**不成立**；
//   * 但写出去时 `tableMarkdown.ts:48` 的 `isSimpleTable` 判据是
//     `(cell.type.name === 'tableHeader') !== (rowIndex === 0)` —— **第 0 行必须是 `tableHeader`**。
//     无表头表的第 0 行是 `tableCell` ⇒ 判据恒假 ⇒ 整张表退回 `writeTableHtml`：
//     序列化结果就是 `<table style="min-width: 50px;"><colgroup>…`（实测原文）。
//     复制它 → `text/plain` 也是这段 HTML（**用户报的原实现象**）；落盘同理。
//   * 而 GFM 管道表语法**本来就要求有表头行** —— 没有表头，Markdown 没有写法。
//     所以正解是"把第一行当表头"（Typora / VS Code / GitHub 导入同一口径）。
//
// 于是粘贴端在 HTML 进 schema **之前**把无表头表的第一行 `td` 提升为 `th`。
// 为什么放在这一层而不是 markdown-it 渲染规则里：那一侧改的是 `renderer.rules.table_open`，
// 会连**打开已有 .md** 的路径一起改（无表头管道表在 Markdown 里无法表达，那个方向的取舍
// 与本轮无关）；粘贴层只影响剪贴板，代价最小。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'
import type { Selection, Transaction } from '@tiptap/pm/state'
import type { EditorView, EditorProps } from '@tiptap/pm/view'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { tableEditingKey } from '@tiptap/pm/tables'
import { TableFidelity } from './tableMarkdown'
// 外部任务清单 → 本模型 taskList/taskItem（同一个 transformPastedHTML 槽位，见下）
import { normalizeExternalTaskItems } from './listMarkers'

/** 这段选区里有没有表格（原地判定，不复制文档） */
export function sliceHasTable(doc: PMNode, from: number, to: number): boolean {
  let hit = false
  try {
    doc.nodesBetween(from, to, (node) => {
      if (node.type.name === 'table') {
        hit = true
        return false
      }
      return true
    })
  } catch {
    /* 位置失效（文档刚变过）⇒ 当没有表格，退回 PM 默认行为 */
  }
  return hit
}

/** 这段 Markdown 里有管道表吗（要**分隔行**才算，纯文本里的竖线不算） */
export function markdownHasPipeTable(md: string): boolean {
  return /^[^\n]*\|[^\n]*$/.test(md) && /^[^\n]*\|?[\s:|-]*-[\s:|-]*\|[^\n]*$/m.test(md)
}

/**
 * 无表头表 → 有表头表：把第一行的 `<td>` 提升为 `<th>`。
 *
 * 只改真的需要改的：
 *   * 表里**没有任何** `<th>`（有表头的表一个字节都不动）；
 *   * 第一行里真的有 `<td>`。
 * 就地换标签名即可 —— `<th>` 与 `<td>` 都是块级容器标签，里面的 `<p>` 保留：
 * schema 的 `tableHeader` 与 `tableCell` 内容表达式相同（`paragraph+`），解析结果一致
 * （实测粘出来的结构与手写管道表逐字段相同）。
 *
 * ── 本轮改法（真因：重复 promote / O(n²) 与"嵌套表误判"）───────────────────────
 * 旧实现是一个 `for guard < 500` 的循环：每轮 `querySelectorAll('table')` 再
 * `find(t => !SKIP && !t.querySelector('th'))`。两个问题：
 *   ① **每轮都重扫整棵 DOM**，而且 `t.querySelector('th')` 会**连嵌套子表的 th 一起算**
 *      —— 外层无表头表里嵌了一张有表头表时，外层被误判成"已有表头"、永远不提升
 *      （用户口径里"表格变 HTML 字面量"的另一条夹缝）；
 *   ② 收敛靠 `data-lumin-skip` 属性标记 + 500 轮上限，属于"打着补丁的循环"。
 *
 * 现在改为**单遍线性**：`querySelectorAll` 取一次快照，逐表只看**自己的行**
 * （`table.rows` / `row.cells` 天然不含嵌套表的行），判据是"本表没有任何 th"，
 * 处理完就前进 —— 没有循环、没有标记属性、天然幂等（第二遍跑 promoted 必为 0）。
 *
 * @returns `promoted` = 改过几张表（0 = 调用方**不该**认为"这次粘贴我处理了"）
 */
export function promoteHeaderlessTables(html: string): { html: string; promoted: number } {
  if (!html || !/<\s*table[\s>]/i.test(html)) return { html, promoted: 0 }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  } catch {
    return { html, promoted: 0 }
  }
  /** 本表（不含嵌套子表）有没有表头单元格：`table.rows` 只包含自己的行 */
  const hasOwnHeader = (table: HTMLTableElement): boolean => {
    const rows = table.rows
    for (let r = 0; r < rows.length; r += 1) {
      const cells = rows[r].cells
      for (let c = 0; c < cells.length; c += 1) {
        if (cells[c].tagName === 'TH') return true
      }
    }
    return false
  }
  let promoted = 0
  // 快照一次：后面只替换单元格标签，不会增删 `<table>` 节点，引用始终有效
  const tables = Array.from(doc.body.querySelectorAll('table')) as HTMLTableElement[]
  for (const table of tables) {
    if (hasOwnHeader(table)) continue
    const firstRow = table.tHead?.rows?.[0] ?? table.rows?.[0]
    if (!firstRow) continue
    const tds = (Array.from(firstRow.cells ?? []) as HTMLTableCellElement[]).filter(
      (c) => c.tagName === 'TD'
    )
    if (!tds.length) continue
    for (const td of tds) {
      const th = doc.createElement('th')
      for (const attr of Array.from(td.attributes)) th.setAttribute(attr.name, attr.value)
      while (td.firstChild) th.appendChild(td.firstChild)
      td.replaceWith(th)
    }
    promoted += 1
  }
  if (!promoted) return { html, promoted: 0 }
  return { html: doc.body.innerHTML, promoted }
}

/** `storage.markdown.serializer` 的最小形状（tiptap-markdown 的 MarkdownSerializer） */
interface MarkdownSerializerLike {
  serialize(content: Fragment): string
}

/**
 * 表格节点 → 管道表 Markdown。
 *
 * **复用 tiptap-markdown 的序列化器**（`storage.markdown.serializer`），不自己造一套：
 * 它的 `nodes` / `marks` 是从**编辑器实例**现取的，`renderInline` 里带着 `**` / 反引号 /
 * 链接的真实开合逻辑 —— 自己重写一份必然与落盘漂。
 *
 * 关键是**只喂它这一张表**：`serialize()` 的参数是 `Fragment`，所以
 * `serialize(Fragment.from(table))` 就是"只序列化这一张表"（实测输出与整篇文档里
 * 表格那几行逐字节相同：`| **粗** | \`码\` | 丙 |\n| :--- | :---: | ---: |\n| 一一 | … |`）。
 * 只复制表格一角，不该把整篇文章塞进剪贴板。
 *
 * 为什么不用 `serialize(table)`（直接给 Node）：实测那会走**浏览器的 DOM 序列化**，
 * 吐出来是一串 `<tr><th …>` HTML —— 这正是本轮要消灭的形态。
 *
 * 复杂表（合并单元格 / 单元格里有非段落块）由 `tableMarkdown.serializeTable` 退回 HTML：
 * 那种返回值里含 `<table`，调用方用 `markdownHasPipeTable` 判掉、不接管。
 */
export function tableToMarkdown(table: PMNode, serializer: unknown): string {
  const ser = serializer as MarkdownSerializerLike | undefined
  if (!ser || typeof ser.serialize !== 'function') return ''
  try {
    return ser.serialize(Fragment.from(table)).trim()
  } catch {
    return ''
  }
}

export const TableClipboard = Extension.create({
  name: 'luminTableClipboard',

  addProseMirrorPlugins() {
    /** tiptap-markdown 装在 `editor.storage.markdown.serializer` 上的序列化器（见 tableToMarkdown） */
    const serializer = (this.editor.storage as { markdown?: { serializer?: unknown } }).markdown
      ?.serializer

    return [
      new Plugin({
        key: new PluginKey('luminTableClipboard'),
        props: {
          /**
           * 复制：选区里有表格 ⇒ 自己把 **Markdown** 写进 `text/plain`。
           *
           * 为什么用 `handleDOMEvents.copy` 而不是 `clipboardTextSerializer`：后者只拿得到
           * PM 算好的 Slice，且 `text/html` 那一路仍然没人管；`copy` 事件是我们能改写剪贴板的
           * 第一个（也是最后一道，`preventDefault()` 之后浏览器不再补写）时机。
           *
           * ⚠️ **拿到 `clipboardData` 不一定写得进去**：实测 CDP 合成/非用户手势触发的
           * `copy` 事件里 `clipboardData` 是只读的（`setData` 抛异常，`getData` 返回空串）。
           * 所以整段包 try/catch：**写不进去时不要 preventDefault，也不要吃掉事件** ——
           * 让 PM 的原生复制照旧（至少 `text/html` 那一路还能用）。真实用户手势下写得进去。
           */
          handleDOMEvents: {
            copy(view: EditorView, event: Event): boolean {
              try {
                const dt = (event as ClipboardEvent).clipboardData
                if (!dt) return false
                const from = view.state.selection.from
                const to = view.state.selection.to
                if (!sliceHasTable(view.state.doc, from, to)) return false
                const md = selectionTableMarkdown(view, from, to, serializer)
                if (!md || !markdownHasPipeTable(md)) return false
                dt.setData('text/plain', md.endsWith('\n') ? md : `${md}\n`)
                event.preventDefault()
                return true
              } catch {
                return false
              }
            }
          }
        } as unknown as EditorProps
      }),
      /**
       * 粘贴：外部 HTML 表**无表头行**时，把第一行提升为表头。
       *
       * `handlePaste` 是 someProp 链，**先返回 true 的赢**。本插件只处理"HTML 里有表、
       * 且表是无表头的"这一种，其余一律 `return false`（不碰别人的粘贴）。
       *
       * 两条通道（按剪贴板里有什么决定，优先级写死在这里）：
       *   ① 有 `text/html` 且**确实改到了表** ⇒ 把重写后的 HTML 解析成 Slice 插入。
       *      **必须先提升表头再走 markdown 文本**：直接拿 `text/plain` 走 markdown 通道的话，
       *      无表头管道表在 GFM 里根本解析不出来（会把那几行当普通段落）。
       *   ② 没有可用的 HTML、或 HTML 里本来就有表头 ⇒ 交给 PM 默认路径（`text/plain`
       *      由 `markdownPaste` 的 `clipboardTextParser` 处理）。
       *
       * ⚠️ 顺序：本插件排在 `MathPaste` **之前**（extensions.ts），而 MathPaste 在没有数学时
       * 返回 false，两条互不抢；但顺序写清楚，免得以后有人挪动。
       * ⚠️ `transformPastedHTML` 只有**一个槽位**（PM 的 someProp 取首个非空结果），
       * 所以"粘贴 HTML 的预处理"必须都收敛到这一个函数里 —— 本轮加进来的
       * `normalizeExternalTaskItems`（外部任务清单 → 本模型 taskList/taskItem）也在下面。
       */
      new Plugin({
        key: new PluginKey('luminTableClipboardPaste'),
        props: {
          transformPastedHTML(html: string): string {
            let out = html
            try {
              const rewritten = promoteHeaderlessTables(out)
              if (rewritten.promoted) out = rewritten.html
            } catch {
              /* 表格提升失败：用原 HTML */
            }
            try {
              const tasks = normalizeExternalTaskItems(out)
              if (tasks.changed) out = tasks.html
            } catch {
              /* 任务清单归一化失败：用上一步的结果 */
            }
            return out
          }
        } as unknown as EditorProps
      })
    ]
  }
})

/**
 * 选区里的表格 Markdown（多格选区会有多个 range，逐个取、拼成一段）。
 *
 * 只序列化**相交的那些表格节点**（不是整篇文档）—— 复制表格一角不该把整篇文章塞进剪贴板。
 */
function selectionTableMarkdown(
  view: EditorView,
  from: number,
  to: number,
  serializer: unknown
): string {
  let out = ''
  try {
    view.state.doc.nodesBetween(from, to, (node) => {
      if (node.type.name !== 'table') return true
      const md = tableToMarkdown(node, serializer)
      if (md && markdownHasPipeTable(md)) out = out ? `${out}\n\n${md}` : md
      return false
    })
  } catch {
    return ''
  }
  if (out) return out
  /**
   * `CellSelection` 的 `from`/`to` 是**单元格内容坐标**（`$anchorCell.pos + 1`）——
   * `nodesBetween` 从内容起点开始遍历，表格节点本身落在区间外，于是上面那个循环什么也拿不到
   * （实测：整表 TextSelection 能拿到，多格选区拿不到）。这里补一条：从选区头往上找表格祖先。
   */
  for (const range of view.state.selection.ranges ?? []) {
    for (let depth = range.$from.depth; depth > 0; depth -= 1) {
      const node = range.$from.node(depth)
      if (node.type.name !== 'table') continue
      const md = tableToMarkdown(node, serializer)
      if (md && markdownHasPipeTable(md)) out = out ? `${out}\n\n${md}` : md
      break
    }
  }
  return out
}

/**
 * 这个文本选区是不是**跨了单元格**（`$from` 与 `$to` 不在同一个格子里）。
 *
 * 判据与 `prosemirror-tables` 的 `isTextSelectionAcrossCells` 前半段同源：沿祖先链找到
 * 最近的单元格，比较是不是同一个节点。按**节点身份**比而不是按位置区间比 ——
 * PM 的节点是不可变 + 结构共享的，两个不同的格子必然是两个不同的对象（上游也是这么判的）。
 * 单元格类型按**名字**认（`tableCell` / `tableHeader`）：这是本仓库既有的口径
 * （`tableColumnAlign.ts` 的 `collectColumnCells` 也这么判），不依赖 tiptap 写进
 * `spec.tableRole` 的具体取值。
 */
function spansTableCells($from: ResolvedPos, $to: ResolvedPos): boolean {
  const cellOf = ($p: ResolvedPos): PMNode | null => {
    for (let d = $p.depth; d > 0; d -= 1) {
      const node = $p.node(d)
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') return node
    }
    return null
  }
  const a = cellOf($from)
  const b = cellOf($to)
  return !!a && !!b && a !== b
}

/**
 * ─── 掐掉 `tableEditing` 的「跨格文本选区夹回一格」──────────────────────────────
 *
 * **本轮"松手回缩"的真因就在这一个分支里**（逐拍原始数据见报告）。`prosemirror-tables` 的
 * `normalizeSelection`（`node_modules/prosemirror-tables/dist/index.js:725`）有这么一条：
 * ```js
 * else if (sel instanceof TextSelection && isTextSelectionAcrossCells(sel))
 *     normalize = TextSelection.create(doc, sel.$from.start(), sel.$from.end())
 * ```
 * 即「**只要文本选区跨了单元格，就把它夹回起点所在的那一个段落**」，而它在 `tableEditing`
 * 的 `appendTransaction`（同文件 2580 行附近的 `appendTransaction(_, oldState, state) {
 * return normalizeSelection(state, fixTables(state, oldState), allowTableNodeSelection) }`）
 * 里**每次事务都会跑**。判据 `isTextSelectionAcrossCells`（同文件 707 行）末了还有一条苛刻的
 * `$to.parentOffset === 0` —— 只有**选区终点正好落在某个单元格段落的第 0 个字符处**才命中。
 * 这三件事因此全都对上了：
 *   * **时好时坏**：落点压在格子边界（`parentOffset === 0`）才触发；
 *   * **"仅在选择字数较多时"**：跨了格子才可能「起点格 ≠ 终点格」；
 *   * **拖拽中看着对、松手才少一截**：拖拽途中每一拍 mousemove 都会把正确的长选区重新写回去，
 *     松手之后再没有新的一拍来纠正它；而且夹取会**自我强化** —— 夹短后的选区被
 *     `selectionToDOM` 写回 DOM，我们下一拍读 DOM 拿到的就是被夹短的那份
 *     （实测逐拍：`max=242 [31,273]` → 松手前 `2 [29,31]` → 松手后仍 `2`）。
 *
 * 修法：把**这一条夹取**去掉，其余 normalize 行为一概保留。做法是在 `TableFidelity` 之上
 * 再 extend 一层，把 `tableEditing` 那个 plugin 的 `appendTransaction` **包一层**：
 * 「进来时是跨格文本选区、返回时被夹短」⇒ 返回 `null`（不改选区）。
 *
 * 为什么"包一层"而不是"整条禁用"：那个 `appendTransaction` 同时承担**修表结构**
 * （`fixTables`）与另外两类归一化（`NodeSelection` / 单元格边界）；只有"跨格文本选区"
 * 这一条是本产品明确不要的 —— 用户口径就是「按从上到下、从左到右连续选中文字」。
 */
export const TableNoCellClamp = TableFidelity.extend({
  addProseMirrorPlugins() {
    type RawAppend = (trs: unknown, oldState: unknown, newState: unknown) => Transaction | null
    type PluginLike = { key?: string; spec?: { appendTransaction?: RawAppend } }
    const plugins = (this.parent?.() ?? []) as unknown as PluginLike[]
    for (const p of plugins) {
      if (p.key !== 'selectingCells$' || !p.spec || typeof p.spec.appendTransaction !== 'function')
        continue
      const orig = p.spec.appendTransaction
      p.spec.appendTransaction = ((trs: unknown, oldState: unknown, newState: unknown) => {
        /**
         * 判据只用**公开数据**：
         *   * 进来时的选区取 `newState.selection` —— `normalizeSelection` 读的就是它
         *     （`(tr || state).selection`，`tr` 为空时就是 state）；
         *   * 返回值若 `docChanged` ⇒ 那是 `fixTables` 在修表结构，**必须放行**；
         *   * 若它把上面的选区**改短**了（只有跨格夹取会这么干）⇒ 丢掉这条修正。
         */
        const st = newState as { selection?: Selection } | undefined
        const intended = st?.selection as
          (Selection & { $from?: ResolvedPos; $to?: ResolvedPos }) | undefined
        const res = orig(trs, oldState, newState) as
          (Transaction & { selectionSet?: boolean }) | null
        if (!res) return res
        if (res.docChanged) return res
        if (!intended || typeof (intended as { forEachCell?: unknown }).forEachCell === 'function')
          return res
        if (!intended.$from || !intended.$to) return res
        if (!spansTableCells(intended.$from, intended.$to)) return res
        const after = res.selection
        if (after.to - after.from < intended.to - intended.from) return null
        return res
      }) as unknown as RawAppend
      break
    }
    return plugins as never
  }
})

/**
 * 当前编辑器 view（由本扩展的插件 `view()` 注入；插件外拿不到 view 时保持 null） */
let currentView: { posAtDOM(node: Node, offset: number): number } | null = null

/**
 * 当前浏览器 **DOM 选区** 对应的文档位置（取不到返回 null）。
 *
 * 这是"用户真正划到哪"的权威来源：`readDOMChange` 也是拿它算 `TextSelection` 的
 * （`node_modules/prosemirror-view/dist/index.js` 的 `selectionFromDOM`）。
 * 换算用 `view.posAtDOM(元素, 0)` —— 它按**视图**算，跨格/跨行都对；
 * 文本节点再加上节点内的字符偏移。
 */
function nativeSelectionRange(): { from: number; to: number } | null {
  const view = currentView
  if (!view) return null
  try {
    if (typeof window === 'undefined') return null
    const domSel = window.getSelection()
    if (!domSel || domSel.rangeCount === 0 || domSel.isCollapsed) return null
    const range = domSel.getRangeAt(0)
    const at = (node: Node, offset: number): number | null => {
      try {
        const el = node.nodeType === 3 ? node.parentNode : node
        if (!el || el.nodeType !== 1) return null
        const base = view.posAtDOM(el as Node, 0)
        return base + (node.nodeType === 3 ? offset : 0)
      } catch {
        return null
      }
    }
    const a = at(range.startContainer, range.startOffset)
    const b = at(range.endContainer, range.endOffset)
    if (a === null || b === null) return null
    const from = Math.min(a, b)
    const to = Math.max(a, b)
    return to > from ? { from, to } : null
  } catch {
    return null
  }
}

/**
 * 当前这次鼠标手势的**锚格文档位置**。
 *
 * 首选 `tableEditing` 的插件状态：它的 `handleMouseDown$1` 在 mousedown 时把
 * `$anchorCell.pos` 写进状态（`node_modules/prosemirror-tables/dist/index.js:2224`），
 * `mouseup` / `dragstart` 才清掉（第 2232 行）；**程序化**的 `setCellSelection` 命令
 * （`@tiptap/extension-table/dist/table/index.js:510`）从不写这个状态。
 * 为什么不看事务元数据（`tableEditingKey in tr.meta`）：那个字段在 prosemirror-state 的
 * d.ts 里是 **private**（`vue-tsc --noEmit` 报 TS2341）。
 *
 * ⚠️ 兜底那条是**必需的**，不是保险：我们自己在转换时会把状态清成 `-1`
 * （否则 `tableEditing` 下一帧又造一个 `CellSelection`），于是**从第二次 mousemove 起
 * 状态就是 null** —— 只认状态的话第一次之后的拖动就全漏过去了（实测：选区卡在第一个格子里）。
 * 所以状态为空时退回 `CellSelection` **自己带的** `$anchorCell.pos`（`prosemirror-tables`
 * 一直维护着它，实测可用）。代价：程序化 `setCellSelection` 也会被转成文本选择 ——
 * 而那条命令全仓无人调用（grep 0 命中），可以接受。
 */
function mouseAnchorCellPos(
  sel: { $anchorCell?: { pos?: number } },
  state: unknown
): number | null {
  try {
    const v = tableEditingKey.getState(state as never) as unknown
    if (typeof v === 'number' && v >= 0) return v
  } catch {
    /* 状态拿不到，走下面的兜底 */
  }
  const own = sel?.$anchorCell?.pos
  return typeof own === 'number' && own >= 0 ? own : null
}

// ─── 表格拖选口径（第十四轮）：普通拖选 = 按阅读顺序的**文本选择** ─────────────────
// 用户口径：「在表格中连续选中的时候，**不要选中一整个单元格**，而是**按照从上到下、
//            从左到右的顺序可以连续选中**。」
// 也就是：鼠标拖选要像 Typora 那样给**文本选择**，而**不是** prosemirror-tables 的
// `CellSelection`（整格高亮块选）。
//
// 真因（文件:行号，实测）：`tableEditing()` 插件自己造 `CellSelection`。它唯一的运行期
// 产生处是 `node_modules/prosemirror-tables/dist/index.js:2203` 的 `handleMouseDown$1`
// —— 它挂在 **`view.dom` 的 `mousedown` 冒泡监听**上（第 2610 行
// `handleDOMEvents: { mousedown: handleMouseDown$1 }` 由该插件返回给 prosemirror-view，
// 而 prosemirror-view 的 `editHandlers.mousedown` 是**原生 addEventListener**，
// 不是 `handleDOMEvents` 那条 `someProp` 链）。它内部：
//   * `move`（挂在 `view.root` 的 mousemove，第 2234–2244 行）⇒ **普通拖选**；
//   * `shiftKey` 分支（第 2212–2214 行）⇒ Shift+点击的"整格选"。
//
// 改法（两段，**第一段是主力**）：
//   ① **不让 `tableEditing` 认领这次 mousedown**：在 `handleDOMEvents.mousedown` 里
//      `stopPropagation()` —— 我们的插件排在 `TableFidelity` 之后，prosemirror-view 的
//      `someProp` 会先跑我们的（返回 false 继续），而原生监听在**同一个节点**的冒泡阶段，
//      被 `stopPropagation()` 挡下就再也不会执行。
//      ⚠️ **绝不能** `preventDefault()`：实测那样连浏览器自己的选区延伸一起废掉，
//      拖完只剩一个光标（`from:21,to:21`）。只挡 `tableEditing`，浏览器原生的
//      "按文档顺序连续选" 就正常接管 —— 这正是用户要的形态，而且是浏览器自己实现的，
//      行/列方向天然正确（实测 1 行 3 列的跨格拖选得到 `[11,31]`）。
//   ② `filterTransaction` 兜底：万一手势从格子**外面**起手、中途进入表格，`mousedown`
//      没被我们挡到，`CellSelection` 仍会被造出来 —— 那时把它换成等价的 `TextSelection`。
//
// 保留 / 去掉的产生入口：
//   * **保留** `Shift+左键` 的"整格选"（`assets/editor.css` 那条 `.selectedCell` 高亮仍有用途）；
//   * **去掉** 普通拖选里的 `CellSelection`（换成浏览器的文本选择）；
//   * 程序化 `setCellSelection` 命令全仓无人调用（grep 0 命中），不受影响。
export const TableDragSelect = Extension.create({
  name: 'luminTableDragSelect',

  addProseMirrorPlugins() {
    /** 本次鼠标手势是否按着 Shift（决定"整格选"还是"文本选择"） */
    let shiftGesture = false
    /**
     * 当前指针位置（文档位置，由 `mousemove` 用 `posAtCoords` 换算）。
     *
     * 第四十二轮补：**head 也要取自指针**，不能取 DOM 原生选区的远端 —— 浏览器会把表格里的选区
     * snap 到**单元格边界**，于是头端会越过用户实际划到的位置（用户报"加了头"）。锚点取按下点、
     * head 取当前指针 ⇒ 选区就是"用户从按下点划到当前指针"这一段，与手感一致。
     */
    let lastPointerPos: number | null = null
    /**
     * 本次手势是否**真的拖动过**（第四十三轮）。
     *
     * 表格里**单击**（不拖）也会产生一次 cell 选区事务；此前那段转换会把它当成"拖选"，
     * 于是用户在已有选中范围内单击时，范围会被**再造回来**（现象：闪一下但仍保持选中）。
     * 判据：指针相对按下点移动超过 3px 才算拖动；单击一律落成光标。
     */
    let dragMoved = false
    let pressX = 0
    let pressY = 0
    /** 按下点算出的文档位置（单击时就把光标落在这里） */
    let pressPos: number | null = null
    /** 最近一次**有效**的指针文档位置（head 用；指针一时取不到就沿用上一次，绝不用被 snap 的 DOM 端点） */
    let lastHeadPos: number | null = null

    return [
      new Plugin({
        key: new PluginKey('luminTableDragSelect'),
        view(editorView: EditorView) {
          // `nativeSelectionRange()` 要用 view 的 `posAtDOM` 换算 DOM 选区
          currentView = editorView as unknown as { posAtDOM(node: Node, offset: number): number }
          // 指针轨迹用 document 捕获监听：拖到编辑区外也能继续跟（PM 自己的 mousemove 只在编辑区内）
          const onMove = (e: Event): void => {
            const me = e as MouseEvent
            if (
              !dragMoved &&
              (Math.abs(me.clientX - pressX) > 10 || Math.abs(me.clientY - pressY) > 10)
            )
              dragMoved = true
            const at = editorView.posAtCoords?.({ left: me.clientX, top: me.clientY })
            lastPointerPos = at && Number.isFinite(at.pos) ? at.pos : lastPointerPos
            if (at && Number.isFinite(at.pos)) lastHeadPos = at.pos
            try {
              ;(window as unknown as Record<string, unknown>).__mdTableDrag = {
                dragMoved,
                press: pressPos,
                pointer: lastPointerPos,
                head: lastHeadPos
              }
            } catch {
              /* 诊断不影响功能 */
            }
          }
          document.addEventListener('mousemove', onMove, true)
          return {
            destroy() {
              document.removeEventListener('mousemove', onMove, true)
              currentView = null
              lastPointerPos = null
            }
          }
        },
        props: {
          handleDOMEvents: {
            mousedown(view: EditorView, event: Event): boolean {
              shiftGesture = (event as MouseEvent).shiftKey === true
              /**
               * **锚点取自"按下的那个点"**（第四十二轮加固）。
               *
               * 不能靠"按下时选区为空"来重置，也不能拿第一帧的 DOM 选区当锚点：用户经常在**已有选区**上
               * 再拖（实测日志里按下时选区就是 `647-869` 非空），那一刻 DOM 选区还停留在上一次的范围，
               * 用它当锚点会把尾端算到错误位置（尾端在 `1091 ↔ 1068` 之间横跳就是这么来的）。
               * 这里直接用按下坐标 → 文档位置，作为本次手势唯一的锚点；算不出来才退回 DOM 选区。
               */
              const dom = (currentView as unknown as { dom?: HTMLElement } | null)?.dom
              const me = event as MouseEvent
              const at = view.posAtCoords?.({ left: me.clientX, top: me.clientY })
              if (dom) {
                if (at && Number.isFinite(at.pos) && at.pos > 0)
                  dom.dataset.mdTableDragAnchor = String(at.pos)
                else delete dom.dataset.mdTableDragAnchor
              }
              // 新手势：head 也从"按下点"起步（免得沿用上一手势的指针位置）
              lastPointerPos = at && Number.isFinite(at.pos) ? at.pos : null
              lastHeadPos = at && Number.isFinite(at.pos) ? at.pos : null
              dragMoved = false
              pressX = me.clientX
              pressY = me.clientY
              pressPos = at && Number.isFinite(at.pos) ? at.pos : null
              // 只记录，不接管：让 `tableEditing` 与 PM 自己的 mousedown 照常跑
              return false
            },
            /**
             * **单击必落光标**（第四十五轮，收尾断言）。
             *
             * 用户报：在已有选中范围内单击，选区会**闪一下但依旧保持选中**。中途是谁把范围又造回来的
             * （表格的 cell 选区事务、PM 自己的 mouseup 处理、或某一帧的归一化）不必再猜 —— 这里在
             * `mouseup` 之后**再断言一次**：没拖动过的手势，最终状态必须是按下点处的空光标。
             * 双击/三击（`detail > 1`，词/行选择）与 Shift 手势不干预。
             */
            mouseup(view: EditorView, event: Event): boolean {
              const me = event as MouseEvent
              if (shiftGesture || me.detail > 1) return false
              const at = pressPos
              if (at === null) return false
              /**
               * **判"单击"用松手坐标 + 文档位置，不再只用途中的 3px 增量标志**（第四十五轮补）。
               *
               * 用户实测日志（`seq=72`）：那一"单击"里 `dragMoved` 从第 0 行就是 `true`（鼠标/触控板
               * 轻微位移就 >3px），于是"单击落光标"这条规则被整条跳过 ⇒ 闪一下后旧范围仍在。
               * 现在：位移 ≤10px，**或**指针下的文档位置与按下点相同 ⇒ 一律按单击处理，落成光标。
               */
              const movedFar =
                Math.abs(me.clientX - pressX) > 10 || Math.abs(me.clientY - pressY) > 10
              /**
               * 第九十四轮（用户报障：从后往前拖，松开后选区丢了）：
               * "是不是单击"**只由指针位移决定**（`movedFar`），不再叠加"文档位置是否变化"——
               * `posChanged` 是**间接信号**，在折行/源码处会误判（实测那次 `movedFar=true` 而
               * `posChanged` 也可能为 false）⇒ 一旦误判成单击，就把用户拖出来的选区收成光标。
               * 位移 >10px ⇒ 一律按"拖动"处理，直接放行（让 PM/浏览器保留选区）。
               */
              if (movedFar) return false
              setTimeout(() => {
                try {
                  const cur = view.state.selection
                  if (cur.empty && cur.from === at) return
                  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, at))
                  tr.setMeta('addToHistory', false)
                  // 顺手清掉表格的"选中单元格"标记，避免残留整格高亮
                  tr.setMeta(tableEditingKey, -1)
                  view.dispatch(tr)
                  const w = window as unknown as Record<string, unknown>
                  w.__mdTableDrag = {
                    ...((w.__mdTableDrag as Record<string, unknown>) || {}),
                    clickFix:
                      Number(
                        ((w.__mdTableDrag as Record<string, unknown>)?.clickFix as number) || 0
                      ) + 1
                  }
                } catch {
                  /* 文档已变/视图销毁：忽略 */
                }
              }, 0)
              return false
            }
          }
        },
        /**
         * 手势产生的 `CellSelection` → 等价的 `TextSelection`（**按浏览器自己的 DOM 选区**）。
         *
         * 见下面 `nativeSelectionRange()` 的注释：DOM 选区是"用户真正划到哪"的权威来源，
         * 从 `CellSelection` 反推会把跨格选区打回第一个格子（实测）。
         *
         * ⚠️ 这里**不需要**再兜"被夹短"那件事：真因（`tableEditing` 的跨格夹取）已经在
         * `TableNoCellClamp` 里从源头掐掉了（见上文）。刻意只留**一条**机制 ——
         * 两条机制抢同一个方向盘，日后出问题会很难判是谁改的。
         */
        filterTransaction(tr: Transaction, state): boolean {
          if (shiftGesture) return true
          const sel = tr.selection
          if (!sel || typeof (sel as { forEachCell?: unknown }).forEachCell !== 'function')
            return true
          if (
            mouseAnchorCellPos(sel as unknown as { $anchorCell?: { pos?: number } }, state) === null
          )
            return true
          /**
           * **单击 ≠ 拖选**（第四十三轮）：没移动过指针的手势一律落成光标。
           *
           * 表格里单击也会产生 cell 选区事务，若照下面的转换逻辑处理，用户"在已有选中范围内单击"
           * 时范围会被重新造出来（闪一下但依旧选中）。这里直接给出按下点的光标并吃掉这次事务。
           */
          if (!dragMoved) {
            if (pressPos !== null) {
              try {
                tr.setSelection(TextSelection.create(tr.doc, pressPos))
                tr.setMeta(tableEditingKey, -1)
              } catch {
                /* 位置失效：放行原事务，交给 PM 兜底 */
              }
            }
            return true
          }
          const native = nativeSelectionRange()
          if (native) {
            try {
              /**
               * **锚点守恒**（第四十二轮，真因由用户逐帧日志锁定）。
               *
               * 用户日志（`seq=13`，表格内跨格反向拖）：尾端在 `1091 ↔ 1068` 之间**横跳**（差 23 ≈ 一个
               * 单元格边界）⇒ 松手以最后一帧为准 ⇒ 少掉尾部，而横跳就是用户说的"闪烁"；且"只在表格内、
               * 跨单元格时出现"，四个时点反而一致（所以第四十一轮那条修复仍保留）。
               * 机理：这一行的锚点原本**每帧**从**浏览器 DOM 选区**（`nativeSelectionRange()`）取，
               * 而浏览器/表格逻辑会把 DOM 端点夹到单元格边界 ⇒ 锚点不守恒。
               * 修法：手势期间**只认第一次写下的锚点**（存在编辑区 DOM 的 `dataset` 上，不必新加模块变量；
               * 下一次手势以"按下时选区为空"自动重置），head 每帧用 DOM 现算 —— **只夹 head、绝不动锚点**。
               */
              const dom = (currentView as unknown as { dom?: HTMLElement } | null)?.dom
              const stored = Number(dom?.dataset.mdTableDragAnchor ?? '')
              const anchorPos =
                state.selection.empty || !Number.isFinite(stored) || stored === 0
                  ? native.from
                  : stored
              if (dom) dom.dataset.mdTableDragAnchor = String(anchorPos)
              /**
               * **head 取自当前指针**（第四十二轮补，用户报"加了头"）。
               *
               * 取 DOM 原生选区的远端时，浏览器会把表格选区 snap 到**单元格边界** ⇒ 头端越过用户实际
               * 划到的位置（多选一截）。锚点来自按下坐标、head 来自当前指针 ⇒ 选区恰好是"用户从按下点
               * 划到当前指针"这一段；指针位置暂时拿不到时才退回"离锚点更远的那个原生端点"。
               */
              const farEnd =
                Math.abs(native.to - anchorPos) >= Math.abs(native.from - anchorPos)
                  ? native.to
                  : native.from
              /**
               * 指针优先，但**允许原生端点比指针多 1 个字符**（收尾）。
               *
               * `posAtCoords` 落在字符边界时会比 DOM 选区差一格（实测：松手范围比拖拽最长少 1，
               * 表现就是"松手丢一个字"）；而原生端点若**远出很多**，那是被 snap 到单元格边界
               * （用户报的"加了头"）。所以：差值 ≤1 采信 DOM（它对行内精确位置更准），>1 一律以指针为准。
               */
              const dPointer =
                lastHeadPos === null ? Number.POSITIVE_INFINITY : Math.abs(lastHeadPos - anchorPos)
              const dNative = Math.abs(farEnd - anchorPos)
              /**
               * `lastHeadPos` 是"最近一次**有效**的指针位置"（第四十四轮）：指针一时取不到（`posAtCoords`
               * 返回 null，例如指针移出编辑区/表格下方）时**沿用上一次**，绝不再退回被 snap 到单元格边界的
               * DOM 端点 —— 那正是"偶发加了头"的来源（一退就是一整格）。
               */
              const headPos =
                lastHeadPos === null || (dNative > dPointer && dNative - dPointer <= 1)
                  ? farEnd
                  : lastHeadPos
              tr.setSelection(TextSelection.create(tr.doc, anchorPos, headPos))
              // 诊断：把这一帧的决策记下来（供 selTrace 复现时点名"谁改的"）
              try {
                const w = window as unknown as Record<string, unknown>
                w.__mdTableDrag = {
                  ...((w.__mdTableDrag as Record<string, unknown>) || {}),
                  dragMoved,
                  anchor: anchorPos,
                  headChosen: headPos,
                  farEnd,
                  dPointer,
                  dNative
                }
              } catch {
                /* 诊断不影响功能 */
              }
              // 抹掉 anchor，否则 `tableEditing` 的下一帧 mousemove 会再造一个 CellSelection
              tr.setMeta(tableEditingKey, -1)
            } catch {
              /* 落点失效：留给下面的兜底 */
            }
            return true
          }
          try {
            /**
             * 兜底（拿不到 DOM 选区时）：从 `CellSelection` 自己推一个等价区间。
             *
             * ⚠️ **方向**：`CellSelection` 的 `ranges[0]` 是**头**格，不是锚格 ——
             * `prosemirror-tables/dist/index.js:2216-2222` 先 `cells.unshift($headCell.pos)`
             * 再 `map(cellsInRect(rect))`，锚格混在中间（实测 `[[头 16,22],[锚 8,14]]`）。
             * 所以"谁锚谁头"要另找判据：**锚格的内容区间从它的节点位置开始**，
             * 头格的区间里不含那个位置。
             */
            const ranges = sel.ranges ?? []
            if (!ranges.length) return true
            const anchorCellPos = mouseAnchorCellPos(
              sel as unknown as { $anchorCell?: { pos?: number } },
              state
            )
            let anchorFrom = ranges[0].$from.pos
            if (anchorCellPos !== null) {
              const owner = ranges.find((r) => r.$from.pos >= anchorCellPos)
              if (owner) anchorFrom = owner.$from.pos
            }
            // 另一个边界 = 离锚最远的那个端点（矩形/多格时就是最后那个格子的末尾）
            let other = anchorFrom
            for (const r of ranges) {
              for (const pos of [r.$from.pos, r.$to.pos]) {
                if (Math.abs(pos - anchorFrom) > Math.abs(other - anchorFrom)) other = pos
              }
            }
            if (anchorFrom === other) return true
            const low = Math.min(anchorFrom, other)
            const high = Math.max(anchorFrom, other)
            const anchorAtLow = anchorFrom <= other
            tr.setSelection(
              TextSelection.between(
                tr.doc.resolve(anchorAtLow ? low : high),
                tr.doc.resolve(anchorAtLow ? high : low)
              )
            )
            // 抹掉 anchor，否则 `tableEditing` 的下一帧 mousemove 会再造一个 CellSelection
            tr.setMeta(tableEditingKey, -1)
          } catch {
            /* 位置失效就放行原事务（PM 兜底），不要让一次手势把编辑器卡住 */
          }
          return true
        }
      })
    ]
  }
})
