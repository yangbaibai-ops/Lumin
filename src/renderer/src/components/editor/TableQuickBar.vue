<script setup lang="ts">
// ─── 表格快捷操作条（光标进入表格时贴在表格上方）──────────────────────────────
//
// 用户口径：「当聚焦在表格中时，该表格的头部显示几个快捷操作的按钮」——列对齐 /
// 调整列宽（见下）/ 删除表格 / 更多菜单（上下列、左右列）。
//
// ── 为什么是「绝对定位在随内容滚动的容器里」而不是 fixed ──────────────────────
// 宿主 `TyporaEditor.vue` 把本组件放在正文列那个 `relative` 的包裹层里，落点用
// `offsetIn()` 沿 `offsetParent` 链现算（表格的 `offsetParent` 是 `.tableWrapper`，
// `table.offsetTop` 恒为 0，不能直接用）。于是**坐标全部是内容坐标**，滚动时表格与
// 工具条一起走，不需要任何 scroll 监听 —— 也就不可能出现"滚完条子还停在屏幕原位"。
// 任务书禁止的"固定像素硬编码视口坐标"在这里天然不成立：坐标每次现算。
//
// ── 为什么"调整列宽/行高"落成"三种布局"而不是列宽数字 ─────────────────────────
// **标准 Markdown 表格无法表达列宽与行高**。本项目里 width 唯一的落点是
// `@tiptap/extension-table` 的 `colwidth` 属性（只在 `resizable: true` 的
// `columnResizing` 插件里产生），而 `tableMarkdown.ts` 的管道序列化**不写它** ——
// 也就是说：做出"拖列宽 → 存盘 → 重开"的假象，实际会**静默丢失**（比不做更坏）。
// 也不许往 Markdown 里塞私有语法。所以这里只做**派生（视图层、不落盘）**的三种
// 列宽分布，并在 UI 上如实标注"仅视图"：
//   * auto    —— 现状：`table-layout: auto` + `width: 100%`，按内容分配；
//   * even    —— `table-layout: fixed` + 等宽：列数与内容无关，一片整齐；
//   * content —— 整表按内容收窄（不撑满写作区）。
// 三者都**不改任何节点/属性/序列化**，Markdown 逐字节不变（套件里钉住了这一点）。
// 「行高」在 Markdown 表格里同样没有写法，且没有可复用机制，因此**不做**（报告里说明）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import { useI18n } from 'vue-i18n'
import { useEditorStore } from '../../stores/editor'
import {
  applyTableColumnAlign,
  tableColumnAlign,
  tableColumnIndex
} from '../../lib/editor/tableColumnAlign'
import type { AlignValue } from '../../lib/editor/tableAlign'
import Icon from '../Icon.vue'

const { t } = useI18n()
const editorStore = useEditorStore()

/** 工具条与表格之间的间隙（px，纯几何，不是视觉档位） */
const GAP = 6
/** 首帧（元素还没量到尺寸时）用的高度估值，只为算出一个大致落点，下一帧就换成实测值 */
const BAR_HEIGHT_GUESS = 30

/**
 * 宿主正文列包裹层（`relative`，见 TyporaEditor.vue）：本组件的绝对定位包含块。
 * 选它而不是 `.editor-scroll`：它俩只差滚动容器的上内边距，滚动时表格与工具条
 * 一起走这件事一样成立，而它的高度**恰好是内容高度** —— 于是"上方还有没有空间"可以直接
 * 用内容坐标判断，不会被滚动容器的 `padding` 骗到（实测踩过：表格在文档最前面时
 * 算出的落点是负数，工具条被误翻到表格下方）。
 */
const props = defineProps<{ host: HTMLElement | null }>()

const barEl = ref<HTMLElement | null>(null)
const menuOpen = ref(false)
/** 工具条落点（相对宿主的**内容坐标**）；null = 不显示 */
const pos = ref<{ left: number; top: number } | null>(null)
/** 上方放不下时改为贴表格下方 */
const below = ref(false)
/** 三种列宽布局（视图层，见文件头注释） */
type WidthMode = 'auto' | 'even' | 'content'
const widthMode = ref<WidthMode>('auto')

/** 编辑器实例（`markRaw` 的同一个对象；类型在 store 里被 Pinia 展平，这里补回来） */
function activeEditor(): Editor | null {
  void editorStore.tick
  const ed = editorStore.instance
  return ed ? (ed as unknown as Editor) : null
}

/** 光标所在单元格在文档里的位置（不在表格里返回 null）——对齐/列的公共锚点 */
function anchorCellPos(editor: Editor): number | null {
  const sel = editor.state.selection
  const $from = sel.$from
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'tableCell' || name === 'tableHeader') return $from.before(depth)
  }
  return null
}

/** 当前聚焦的表格 DOM（`.tableWrapper`）——多表格时只认光标那一张 */
function currentTableWrapper(): HTMLElement | null {
  const editor = activeEditor()
  if (!editor) return null
  const cellPos = anchorCellPos(editor)
  if (cellPos === null) return null
  try {
    const dom = editor.view.nodeDOM(cellPos)
    if (!(dom instanceof HTMLElement)) return null
    return (dom.closest('.tableWrapper') as HTMLElement | null) ?? null
  } catch {
    return null
  }
}

const inTable = computed(() => {
  void editorStore.tick
  const editor = activeEditor()
  if (!editor) return false
  try {
    return !!editor.isActive('table') && anchorCellPos(editor) !== null
  } catch {
    return false
  }
})

/** 当前列序号（复用唯一入口，见 lib/editor/tableColumnAlign.ts） */
const colIndex = computed<number | null>(() => {
  void editorStore.tick
  const editor = activeEditor()
  if (!editor) return null
  return tableColumnIndex(editor)
})

const currentAlign = computed<AlignValue>(() => {
  const editor = activeEditor()
  const idx = colIndex.value
  if (!editor || idx === null) return null
  return tableColumnAlign(editor, idx)
})

/**
 * 元素相对宿主的**真实布局偏移**。
 *
 * ⚠️ 不能用 `el.offsetTop`：它只给到 `offsetParent` 的距离，而表格的 `offsetParent`
 * 是 `.tableWrapper`（Tiptap 的 `TableView` 造的那个 div，不是定位元素）—— 于是
 * `table.offsetTop` 恒为 0，工具条会贴到宿主顶端（实测）。这里沿 `offsetParent`
 * 链累加，得到的是相对宿主的坐标，与"谁刷新了 offsetParent"无关。
 *
 * 为什么不用 `getBoundingClientRect()` 相减：那个差里含滚动量，要把 `scrollTop` 加回去
 * 才是内容坐标 —— 多一次换算就多一处能错的地方；`offsetParent` 链天然是内容坐标。
 */
function offsetIn(el: HTMLElement, host: HTMLElement): { left: number; top: number } {
  let left = 0
  let top = 0
  let cur: HTMLElement | null = el
  while (cur && cur !== host) {
    left += cur.offsetLeft
    top += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return { left, top }
}

/** 宿主的滚动容器（`.editor-scroll`）：判断"上方还有没有可见空间"要用它 */
function scrollContainerOf(host: HTMLElement): HTMLElement | null {
  return host.closest('.editor-scroll') as HTMLElement | null
}

/**
 * 计算落点。坐标全部是**内容坐标**（相对宿主），所以工具条与表格始终一起滚动，
 * 不需要任何 scroll 监听；只有"上方到底还有没有空间"这一条要问滚动容器（否则表格在
 * 文档最前面时，工具条会被排到 contentTop 为负的位置而**被滚动容器裁掉**）。
 */
function reposition(): void {
  const host = props.host
  const wrapper = currentTableWrapper()
  if (!host || !wrapper) {
    /**
     * 找不到表格（或几何暂时量不到）时**不要立刻收起来**：用户可能正把焦点放在工具条上
     * （开着「更多」菜单、或者 Tab 已经走进来），这一刻收掉会连菜单一起抽走、焦点丢回 body
     * —— 实测踩到过一次：点「更多」→ 菜单刚开，一次重算把工具条卸了，紧接着那次点击落空。
     * 所以只要有焦点在工具条内部就**保住现状**；焦点不在里面才收（正常情况：光标移出表格）。
     */
    if (barEl.value && barEl.value.contains(document.activeElement)) return
    pos.value = null
    return
  }
  const table = (wrapper.querySelector('table') as HTMLElement | null) ?? wrapper
  const h = barEl.value?.offsetHeight || BAR_HEIGHT_GUESS
  const w = barEl.value?.offsetWidth || 0
  const at = offsetIn(table, host)
  const scroller = scrollContainerOf(host)
  const hostTop = host.getBoundingClientRect().top
  // 宿主上缘在滚动视口里的位置（内容坐标 0 对应它）
  const viewTop = scroller ? hostTop - scroller.getBoundingClientRect().top : 0
  /**
   * 优先落在表格的**上外边距**里（表格前面那段内容与表格之间那点空隙，见图）：贴近表格、
   * 少压到上一段正文。上边距不够放整条工具条时才退到更上面（仍不碰表格首行），
   * 上方连这点空间都没有（表格在文档最前面）才翻到表格下方。
   */
  const wrapperAt = offsetIn(wrapper, host)
  const gapAbove = Math.max(0, at.top - wrapperAt.top)
  const atMargin = at.top - Math.min(h, gapAbove) - GAP
  const aboveTop = gapAbove >= h + GAP ? atMargin : at.top - h - GAP
  const placeAbove = aboveTop >= -viewTop
  below.value = !placeAbove
  const top = placeAbove ? aboveTop : at.top + table.offsetHeight + GAP
  // 横向贴表格左缘；越界（表格比宿主还宽）时夹回宿主内
  const left = Math.max(0, Math.min(at.left, Math.max(0, host.clientWidth - w)))
  pos.value = { left: Math.round(left), top: Math.round(top) }
}

/** 表格 DOM 上的「列宽布局」类名（视图层；不碰节点、不碰序列化） */
function applyWidthMode(): void {
  const wrapper = currentTableWrapper()
  if (!wrapper) return
  wrapper.classList.toggle('lumin-table-even', widthMode.value === 'even')
  wrapper.classList.toggle('lumin-table-content', widthMode.value === 'content')
}

function clearWidthMode(): void {
  for (const el of document.querySelectorAll('.lumin-table-even, .lumin-table-content')) {
    el.classList.remove('lumin-table-even', 'lumin-table-content')
  }
}

watch(
  () => [editorStore.tick, inTable.value, props.host] as const,
  async () => {
    if (!inTable.value) {
      pos.value = null
      menuOpen.value = false
      return
    }
    await nextTick()
    reposition()
    applyWidthMode()
  },
  { immediate: true }
)

// 结构变化（增删行列 / 改宽）后表格几何会变：下一帧补一次定位
watch(
  () => editorStore.tick,
  () => {
    if (!inTable.value) return
    void nextTick(() => reposition())
  }
)

function onResize(): void {
  if (inTable.value) reposition()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  document.addEventListener('pointerdown', onDocPointerDown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  clearWidthMode()
})

// ─── 动作 ────────────────────────────────────────────────────────────────────
/** 动作执行后光标可能仍在表格里（增删行列），几何变了：重算一次 */
function afterAction(): void {
  menuOpen.value = false
  void nextTick(() => {
    reposition()
    applyWidthMode()
  })
}

function run(table: 'rows' | 'cols', action: string): void {
  const editor = activeEditor()
  if (!editor) return
  const chain = editor.chain().focus()
  switch (`${table}.${action}`) {
    case 'rows.above':
      chain.addRowBefore().run()
      break
    case 'rows.below':
      chain.addRowAfter().run()
      break
    case 'rows.delete':
      chain.deleteRow().run()
      break
    case 'cols.before':
      chain.addColumnBefore().run()
      break
    case 'cols.after':
      chain.addColumnAfter().run()
      break
    case 'cols.delete':
      chain.deleteColumn().run()
      break
    default:
      return
  }
  afterAction()
}

function align(value: AlignValue): void {
  const editor = activeEditor()
  if (!editor || !inTable.value) return
  applyTableColumnAlign(editor, value)
  afterAction()
}

function removeTable(): void {
  const editor = activeEditor()
  if (!editor) return
  editor.chain().focus().deleteTable().run()
  afterAction()
}

function setWidthMode(mode: WidthMode): void {
  widthMode.value = mode
  applyWidthMode()
  afterAction()
}

/** 列对齐三项（顺序固定：左 / 中 / 右，与工具栏弹层一致，肌肉记忆成立） */
const alignChoices: { value: AlignValue; icon: string; labelKey: string }[] = [
  { value: 'left', icon: 'align-left', labelKey: 'editorMenu.tableAlign.left' },
  { value: 'center', icon: 'align-center', labelKey: 'editorMenu.tableAlign.center' },
  { value: 'right', icon: 'align-right', labelKey: 'editorMenu.tableAlign.right' }
]

/**
 * 「更多」菜单：按**行 / 列**分组（Typora 的表格菜单也是这个分组），
 * 组内顺序 = 文档顺序（上 → 下、左 → 右），破坏性的删除放组尾。
 */
interface MenuGroup {
  id: string
  labelKey: string
  items: { id: string; labelKey: string; icon: string }[]
}

const moreGroups: MenuGroup[] = [
  {
    id: 'rows',
    labelKey: 'tableBar.groupRows',
    items: [
      { id: 'above', labelKey: 'editorMenu.rowAbove', icon: 'row-above' },
      { id: 'below', labelKey: 'editorMenu.rowBelow', icon: 'row-below' },
      { id: 'delete', labelKey: 'editorMenu.deleteRow', icon: 'row-delete' }
    ]
  },
  {
    id: 'cols',
    labelKey: 'tableBar.groupCols',
    items: [
      { id: 'before', labelKey: 'editorMenu.colBefore', icon: 'col-before' },
      { id: 'after', labelKey: 'editorMenu.colAfter', icon: 'col-after' },
      { id: 'delete', labelKey: 'editorMenu.deleteCol', icon: 'col-delete' }
    ]
  }
]

const widthChoices: { value: WidthMode; labelKey: string }[] = [
  { value: 'auto', labelKey: 'tableBar.widthAuto' },
  { value: 'even', labelKey: 'tableBar.widthEven' },
  { value: 'content', labelKey: 'tableBar.widthContent' }
]

/**
 * 键盘可达（任务书要求 Tab 能进 / Esc 退出）：
 *   * 工具条本身 `role="toolbar"`，内部按钮是原生 `<button>` ⇒ Tab 按 DOM 顺序走；
 *   * Esc：先收「更多」菜单，再退出工具条回到编辑器（不吞掉第一次 Esc）。
 */
function onBarKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  if (menuOpen.value) {
    menuOpen.value = false
    const trigger = barEl.value?.querySelector<HTMLElement>('[data-table-bar-more]')
    trigger?.focus()
    return
  }
  activeEditor()?.commands.focus()
}

/** 点工具条不能把光标从表格里踢出去（点在按钮上时 mousedown 会移走焦点） */
function keepCursor(e: MouseEvent): void {
  e.preventDefault()
}

/** 点工具条之外收起「更多」菜单（不碰选区） */
function onDocPointerDown(e: Event): void {
  if (!menuOpen.value) return
  const el = barEl.value
  if (el && e.target instanceof Node && el.contains(e.target)) return
  menuOpen.value = false
}
</script>

<template>
  <div
    v-if="pos"
    ref="barEl"
    data-table-bar
    role="toolbar"
    :aria-label="t('tableBar.label')"
    class="table-bar absolute flex items-center gap-0.5 rounded-lg border border-edge bg-elevate px-1 py-0.5 text-ui"
    :style="{ boxShadow: 'var(--shadow-2)', left: pos.left + 'px', top: pos.top + 'px' }"
    :data-table-bar-below="below ? 'true' : 'false'"
    @keydown="onBarKeydown"
    @mousedown="keepCursor"
  >
    <!-- 列对齐（作用于光标所在列；Markdown 的分隔行 `:---` / `:---:` / `---:`） -->
    <button
      v-for="c in alignChoices"
      :key="c.labelKey"
      :data-align="c.value ?? 'none'"
      class="icon-btn icon-btn-sm"
      :class="{ active: currentAlign === c.value }"
      :title="t(c.labelKey)"
      :aria-label="t(c.labelKey)"
      :aria-pressed="currentAlign === c.value"
      @click="align(c.value)"
    >
      <Icon :name="c.icon" :size="14" />
    </button>

    <span class="table-bar__sep" aria-hidden="true" />

    <!-- 删除表格 -->
    <button
      data-table-bar-delete
      class="icon-btn icon-btn-sm"
      :title="t('editorMenu.deleteTable')"
      :aria-label="t('editorMenu.deleteTable')"
      @click="removeTable"
    >
      <Icon name="trash" :size="14" />
    </button>

    <!-- 更多：上下列 / 左右列 / 列宽布局 -->
    <div class="relative">
      <button
        data-table-bar-more
        class="icon-btn icon-btn-sm"
        :class="{ active: menuOpen }"
        :title="t('tableBar.more')"
        :aria-label="t('tableBar.more')"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <Icon name="more" :size="14" />
      </button>

      <div
        v-if="menuOpen"
        data-table-bar-menu
        role="menu"
        :aria-label="t('tableBar.more')"
        class="table-bar__menu absolute right-0 rounded-lg border border-edge bg-elevate py-1 text-ui"
        :style="{ boxShadow: 'var(--shadow-2)' }"
      >
        <template v-for="g in moreGroups" :key="g.id">
          <div class="table-bar__group" role="presentation">{{ t(g.labelKey) }}</div>
          <button
            v-for="it in g.items"
            :key="g.id + it.id"
            data-table-bar-menu-item
            :data-table-action="g.id + '.' + it.id"
            role="menuitem"
            class="table-bar__item"
            @click="run(g.id === 'rows' ? 'rows' : 'cols', it.id)"
          >
            <Icon :name="it.icon" :size="14" />
            <span>{{ t(it.labelKey) }}</span>
          </button>
        </template>

        <div class="table-bar__group" role="presentation">{{ t('tableBar.width') }}</div>
        <button
          v-for="w in widthChoices"
          :key="w.value"
          :data-width="w.value"
          role="menuitemradio"
          :aria-checked="widthMode === w.value"
          class="table-bar__item"
          :class="{ 'is-on': widthMode === w.value }"
          @click="setWidthMode(w.value)"
        >
          <Icon name="check" :size="13" :class="widthMode === w.value ? '' : 'invisible'" />
          <span>{{ t(w.labelKey) }}</span>
        </button>
        <p class="table-bar__note">{{ t('tableBar.widthNote') }}</p>
      </div>
    </div>
  </div>
</template>
