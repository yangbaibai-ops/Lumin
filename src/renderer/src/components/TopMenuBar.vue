<script setup lang="ts">
// ─── 应用内顶部菜单栏（VS Code 式，确定性 Alt+F/E/V/H）─────────────────────
// 替代依赖系统的原生菜单助记键：位置由 DOM 布局精确摆放、Alt+字母必达；
// 菜单项与原生菜单同源动作（files/ui/settings/editor/export 组合）。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { useEditorStore } from '../stores/editor'
import { useFindStore } from '../stores/find'
import { useExport } from '../composables/useExport'
import { useEditorMode } from '../composables/useEditorMode'
import { useOutlineSide } from '../composables/useOutlineSide'
import { confirmIfDirty, newDocumentWindow } from '../composables/useAppActions'
import { openExternalFile, openInWindowOrFocus } from '../lib/openFile'
import { ENCODINGS } from '../../../shared/encodings'
import { EOL_OPTIONS } from '../../../shared/eol'
// 导出格式的唯一清单（应用内菜单的二级项从它派生）
import { EXPORT_FORMATS } from '../../../shared/exportFormats'
import { placeSubmenuX } from '../lib/menuPlacement'
import RecentList from './RecentList.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const router = useRouter()
const files = useFilesStore()
const ui = useUiStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
const { runExport, runPrint } = useExport()
const { setMode } = useEditorMode()
const { toggleOutlineSide } = useOutlineSide()

// labelKey = i18n 键；label = 直接文案（最近文档这类动态项用文件名，无键可查）
type Leaf = {
  labelKey?: string
  label?: string
  icon?: string
  danger?: boolean
  /** 当前项（如「选择编码重新打开」里当前生效的那个编码）：右侧打勾并高亮 */
  active?: boolean
  run: () => void | Promise<void>
}
/** 二级菜单项：悬停展开右侧浮层（最近文档 / 最近文件夹 / 自定义内容） */
type SubMenu = {
  labelKey: string
  icon?: string
  /** 固定内容（Leaf 列表）；与 slot 二选一 */
  children?: (Leaf | 'sep')[]
  /** 用插槽渲染自定义内容（如共用的 RecentList 组件） */
  slot?: 'recentFiles' | 'recentFolders'
}
type Group = {
  key: 'f' | 'e' | 'd' | 'v' | 'h'
  labelKey: string
  items: (Leaf | SubMenu | 'sep')[]
}

function isSub(it: Leaf | SubMenu | 'sep'): it is SubMenu {
  return typeof it === 'object' && ('children' in it || 'slot' in it)
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
/** 提升标题级别（H2 → H1 等，向更高层级走；非标题无操作） */
function raiseHeadingLevel(): void {
  const ed = editorStore.instance
  if (!ed) return
  if (!ed.isActive('heading')) return
  const level = (ed.getAttributes('heading') as { level?: number }).level ?? 1
  if (level > 1)
    ed.chain()
      .focus()
      .setHeading({ level: (level - 1) as HeadingLevel })
      .run()
}
/** 降低标题级别（H1 → H2 等，向更低层级走；非标题无操作） */
function lowerHeadingLevel(): void {
  const ed = editorStore.instance
  if (!ed) return
  if (!ed.isActive('heading')) return
  const level = (ed.getAttributes('heading') as { level?: number }).level ?? 6
  if (level < 6)
    ed.chain()
      .focus()
      .setHeading({ level: (level + 1) as HeadingLevel })
      .run()
}

/** 二级菜单里的「最近文档」：已开着就聚焦那个窗口，否则新窗口打开（不打扰当前窗口）；
 *  「最近文件夹」始终在新窗口把该文件夹作为工作区打开 */
function openRecentFile(path: string): void {
  close()
  void openInWindowOrFocus(path)
}
function openRecentFolder(path: string): void {
  close()
  window.luminAPI.app.openFolderInNewWindow(path)
}

/**
 * 「选择编码重新打开」的二级项：自动检测 + 全部编码。
 * 当前生效的那个编码打勾（`active`）——文档的 encoding 一定是具体编码，
 * 所以「自动检测」这一项本身不打勾，它只是「回到自动判定」的动作。
 */
function reopenEncodingItems(): (Leaf | 'sep')[] {
  const cur = files.current
  const items: (Leaf | 'sep')[] = [
    {
      labelKey: 'encoding.auto',
      icon: 'refresh',
      run: async () => {
        await files.reopenWithEncoding('auto')
      }
    },
    'sep'
  ]
  for (const e of ENCODINGS) {
    items.push({
      label: e.label,
      active: cur?.encoding === e.id,
      run: async () => {
        await files.reopenWithEncoding(e.id)
      }
    })
  }
  return items
}

/**
 * 「行尾」二级项：LF / CRLF，当前生效的打勾。
 * 语义是「按该行尾保存」（不是只切个显示）—— 内存里文本永远是 LF，行尾是文档属性，
 * 所以切换后要立刻落盘，否则用户以为改了、文件其实还没变（见 stores/files.setEol）。
 */
function eolItems(): (Leaf | 'sep')[] {
  const cur = files.current
  return EOL_OPTIONS.map((eol) => ({
    labelKey: eol === 'crlf' ? 'menu.eolCrlf' : 'menu.eolLf',
    active: cur?.eol === eol,
    run: async () => {
      await files.setEol(eol, { save: true })
    }
  }))
}

/**
 * 「以编码保存」的二级项：把文档编码改成指定值并立即写回。
 * 与「选择编码重新打开」的区别：那个是重新解释磁盘上的字节（不动文件），
 * 这个是改变**写盘**编码（会真的改写文件）。
 */
function saveEncodingItems(): (Leaf | 'sep')[] {
  const cur = files.current
  const items: (Leaf | 'sep')[] = [
    // 当前编码直接保存（最常用的那项）；具体编码在下面
    {
      labelKey: 'menu.saveWithEncoding',
      run: async () => {
        await files.save()
      }
    },
    'sep'
  ]
  for (const e of ENCODINGS) {
    items.push({
      label: e.label,
      active: cur?.encoding === e.id,
      run: async () => {
        await files.saveWithEncoding(e.id)
      }
    })
  }
  return items
}

/** 菜单结构用 computed：文件菜单里的「最近文档/最近文件夹」需要随使用记录实时更新 */
const GROUPS = computed<Group[]>(() => [
  {
    key: 'f',
    labelKey: 'menu.file',
    items: [
      {
        // 「新建」是文件菜单第一项（与 Ctrl+N 同一动作）：新窗口 + 工作区不变 + 未命名文档
        // （保存位置等 Ctrl+S 时再问，见 newDocumentWindow）。§4.50 起不再有单独的「新建文档」项 ——
        // 同一件事不留两个入口；顶部栏那个独立按钮也收回到这里。
        labelKey: 'menu.new',
        icon: 'file-plus',
        run: () => newDocumentWindow()
      },
      { labelKey: 'menu.newWindow', icon: 'copy', run: () => window.luminAPI.app.newWindow() },
      {
        labelKey: 'menu.openFile',
        icon: 'folder-open',
        run: async () => {
          if (await confirmIfDirty()) {
            const p = await window.luminAPI.file.chooseOpenFile()
            if (p) {
              // 落点规则（无工作区 → 本窗口 + 侧栏切到该文件的文件夹；有工作区 → 新窗口）
              // 统一在 lib/openFile.ts
              await openExternalFile(p)
              await router.push('/editor')
            }
          }
        }
      },
      { labelKey: 'menu.openFolder', icon: 'folderOpen', run: () => files.openFolder() },
      'sep',
      // 一级项 + 悬停二级：最近文档 / 最近文件夹（二级里用共用的 RecentList 组件）
      { labelKey: 'open.recent', icon: 'clock', slot: 'recentFiles' },
      { labelKey: 'open.recentFolders', icon: 'folder', slot: 'recentFolders' },
      'sep',
      {
        labelKey: 'menu.save',
        icon: 'save',
        // 保存成功不发通知（脏标记/状态栏就是反馈）；失败本身由 files.save() 内部报错
        run: async () => {
          await files.save()
        }
      },
      {
        labelKey: 'menu.saveAs',
        icon: 'copy',
        run: async () => {
          await files.saveAs()
        }
      },
      'sep',
      // 一级「导出」+ 悬停二级：具体格式收进二级菜单，一级菜单保持短（children 列表）。
      // 二级项从**唯一清单**派生（审计 §6 P2）：加一种格式不用再回来补一行
      {
        labelKey: 'menu.export',
        icon: 'download',
        children: EXPORT_FORMATS.map((f) => ({
          labelKey: f.labelKey,
          icon: f.icon,
          run: () => runExport(f.id)
        }))
      },
      // 「打印」紧挨着导出，但它**不来自** EXPORT_FORMATS：那份清单是「导出格式的唯一清单」，
      // 而打印不落盘、没有输出文件（审计 §7 第 18 条：此前只有 PDF 导出）。Ctrl+P 同一动作。
      { labelKey: 'menu.print', icon: 'printer', run: () => runPrint() },
      // 本地历史（Wave 2）：保存前的快照可查看/载入（未落盘文档没有历史）
      {
        labelKey: 'menu.localHistory',
        icon: 'clock',
        run: async () => {
          await files.openHistory()
        }
      },
      // 一级「行尾」+ 悬停二级：以 LF / CRLF 保存（当前行尾打勾）
      {
        labelKey: 'menu.saveWithEol',
        icon: 'hr',
        children: eolItems()
      },
      // 一级「以编码保存」+ 悬停二级：按指定编码改写文件（当前编码打勾）
      {
        labelKey: 'menu.saveWithEncoding',
        icon: 'save',
        children: saveEncodingItems()
      },
      // 一级「选择编码重新打开」+ 悬停二级：按指定编码重读当前文档（当前生效的那个打勾）
      {
        labelKey: 'menu.reopenWithEncoding',
        icon: 'globe',
        children: reopenEncodingItems()
      }
    ]
  },
  {
    key: 'e',
    labelKey: 'menu.edit',
    items: [
      { labelKey: 'menu.undo', icon: 'undo', run: () => editorStore.instance?.commands.undo() },
      { labelKey: 'menu.redo', icon: 'redo', run: () => editorStore.instance?.commands.redo() },
      'sep',
      {
        labelKey: 'menu.findReplace',
        icon: 'search',
        run: () => useFindStore().show()
      },
      { labelKey: 'menu.replace', icon: 'pencil', run: () => useFindStore().showReplace() },
      { labelKey: 'menu.globalSearch', icon: 'list-checks', run: () => ui.openGlobalSearch() }
    ]
  },
  {
    key: 'd',
    labelKey: 'menu.paragraph',
    items: [
      {
        labelKey: 'editor.codeBlock',
        icon: 'braces',
        run: () => editorStore.instance?.chain().focus().toggleCodeBlock().run()
      },
      {
        labelKey: 'editor.quote',
        icon: 'quote',
        run: () => editorStore.instance?.chain().focus().toggleBlockquote().run()
      },
      'sep',
      {
        labelKey: 'editor.ul',
        icon: 'list',
        run: () => editorStore.instance?.chain().focus().toggleBulletList().run()
      },
      {
        labelKey: 'editor.ol',
        icon: 'list-ordered',
        run: () => editorStore.instance?.chain().focus().toggleOrderedList().run()
      },
      {
        labelKey: 'editor.task',
        icon: 'list-checks',
        run: () => editorStore.instance?.chain().focus().toggleTaskList().run()
      },
      'sep',
      {
        labelKey: 'editor.hr',
        icon: 'hr',
        run: () => editorStore.instance?.chain().focus().setHorizontalRule().run()
      },
      'sep',
      { labelKey: 'editor.raiseHeading', icon: 'chevron-up', run: raiseHeadingLevel },
      { labelKey: 'editor.lowerHeading', icon: 'chevron-down', run: lowerHeadingLevel }
    ]
  },
  {
    key: 'v',
    labelKey: 'menu.view',
    items: [
      {
        labelKey: 'menu.toggleSidebar',
        icon: 'panel-left',
        run: () => {
          ui.sidebarVisible = !ui.sidebarVisible
          settings.set('sidebarVisible', ui.sidebarVisible)
        }
      },
      {
        // 关掉工具栏后唯一的「开关型」入口（右键菜单那条路已被隐藏，看不出可点）；
        // 项目排序/显隐仍在设置 → 编辑器 → 快捷工具栏里
        labelKey: 'menu.toggleToolbar',
        icon: 'settings',
        run: () => settings.set('toolbarVisible', !settings.toolbarVisible)
      },
      {
        // 大纲位置（左栏 ⇄ 编辑区右侧）：与工具栏那枚开关、设置面板同一实现（useOutlineSide）。
        // 文案跟着状态走（说的是**下一步**），右侧打勾 = 现在大纲在编辑区右侧。
        label: settings.outlineOnRight ? t('outline.toLeft') : t('outline.toRight'),
        icon: 'outline-panel',
        active: settings.outlineOnRight,
        run: toggleOutlineSide
      },
      'sep',
      { labelKey: 'menu.wysiwyg', icon: 'eye', run: () => setMode('wysiwyg') },
      { labelKey: 'menu.split', icon: 'columns', run: () => setMode('split') },
      { labelKey: 'menu.source', icon: 'source', run: () => setMode('source') },
      'sep',
      {
        labelKey: 'menu.focus',
        icon: 'focus',
        run: () => {
          ui.focusMode = !ui.focusMode
        }
      }
    ]
  },
  {
    key: 'h',
    labelKey: 'menu.help',
    items: [
      { labelKey: 'menu.settings', icon: 'settings', run: () => ui.openSettings() },
      { labelKey: 'menu.about', icon: 'info', run: () => router.push('/about') },
      // 与上面两条（设置 / 关于）之间画一条分隔线：下面是**开发者向**的入口
      'sep',
      // 「打开开发者工具」放在**帮助**里（用户口径第五轮原话：「并不是在编辑快捷工具栏中，
      // 而是在应用的顶部栏中的'帮助'里添加」；那枚工具栏按钮已随之移除）。
      // 走的是既有 IPC `app:openDevTools`（主进程 `mode: 'detach'` 独立窗口）——
      // 键盘入口（F12 / Ctrl+Shift+I/J/C）在第四轮已全部拦掉，这里与原生菜单的
      // `role: 'toggleDevTools'` 是仅有的两条入口。
      // 失败要说出来（`runLeaf` 会静默吞异常）：正常情况下不该走到 toast 这条分支。
      // 成功之后**把焦点要回编辑器**（DevTools 的窗口激活会把焦点抢到顶部栏「文件」，见
      // `guardFocusWhileOpeningDevTools` 的说明）。装保护要在 await **之前**：一进入 await
      // 窗口就可能已经开始失活，那时再装就晚了（`focusin` 已经派发完了）。
      {
        labelKey: 'menu.openDevTools',
        icon: 'monitor',
        run: async () => {
          guardFocusWhileOpeningDevTools()
          try {
            const res = await window.luminAPI.app.openDevTools()
            if (!res?.ok) {
              ui.toast(`${t('menu.openDevTools')}: ${res?.error ?? 'unknown'}`, 'error')
            }
          } catch (e) {
            ui.toast(
              `${t('menu.openDevTools')}: ${e instanceof Error ? e.message : String(e)}`,
              'error'
            )
          }
        }
      }
    ]
  }
])

const active = ref<Group | null>(null)
const panelStyle = reactive({ left: '0px', top: '0px' })
const btnRefs: Record<string, HTMLElement | null> = { f: null, e: null, d: null, v: null, h: null }

function setBtnRef(key: string, el: Element | null): void {
  btnRefs[key] = (el as HTMLElement) || null
}

function openGroup(g: Group): void {
  active.value = g
  closeSub()
  const el = btnRefs[g.key]
  if (el) {
    const r = el.getBoundingClientRect()
    panelStyle.left = `${Math.round(r.left)}px`
    panelStyle.top = `${Math.round(r.bottom + 4)}px`
  }
}

function close(): void {
  closeSub()
  active.value = null
}

/**
 * 悬停一级菜单：**已经有菜单展开时**跟随鼠标切到另一个一级菜单（原生菜单栏的行为）。
 *
 * 用户口径：打开「文件」并保持展开，鼠标移到「编辑」时「编辑」也要展开。
 * 刻意加了 `if (!active.value) return` 这个前提 —— 没有展开时悬停不该弹出菜单，
 * 否则鼠标从工具栏划过就会一路弹出好几层（那是另一种毛病，不是原生行为）。
 */
function onGroupHover(g: Group): void {
  if (!active.value || active.value.key === g.key) return
  openGroup(g)
}

async function runLeaf(leaf: Leaf): Promise<void> {
  close()
  try {
    await leaf.run()
  } catch {
    /* 动作内部自行提示 */
  }
}

/**
 * 「打开开发者工具」的**焦点保护**（用户报障：打开 DevTools 时焦点会"闪"一下到顶部栏「文件」）。
 *
 * 因果链（CDP 实测，见 `tools/_verify-devtools.js` 的 focus 段与 §4.88）：
 *   ① 点菜单项 → `runLeaf` 先 `close()` 掉下拉 → 被聚焦的按钮从 DOM 消失 → 焦点落到 `body`；
 *   ② `mode: 'detach'` 的 DevTools 抢激活 → 主窗口 blur；
 *   ③ 主窗口**重新激活**时 Blink 跑 `SetInitialFocus`：**把焦点给文档里第一个可聚焦元素** ——
 *      正是顶部栏第一个分组按钮「文件」。实证：`window focus` 事件里 `activeElement` 已经是它，
 *      而**应用侧 `focus()` 调用次数 = 0**（不是应用挪的，是浏览器激活流程挪的）。
 *      实测三种"事前避免"**都无效**：给编辑面加 `autofocus`、失活前把焦点放回编辑面、
 *      给 `body` 加 `tabindex=-1` 再 focus —— 焦点照样落「文件」。
 *      所以"焦点会被挪走"这件事拦不住（在浏览器进程里发生）；**能**保证的是
 *      "不画出来"：`focusin` 是**同步派发**的，在它的处理器里立刻把焦点挪回编辑面，
 *      **同一个任务内**就完成，下一帧绘制读到的已经是编辑面 —— 那一帧不会画焦点环。
 *      ⚠️ 上一版只监听 `window focus`，纠正晚了一帧（实测有 1 帧把焦点环画在了顶部栏），
 *      这正是用户看到的"闪"。
 *
 * 为什么这不是"抢焦点"（不伤可达性）：
 *   * 监听只在**这次动作**之后 2.5s 内存在，到点自动摘掉；
 *   * 而且只在"窗口刚从失活恢复"的那一小段里纠正（blur 之后、下一次 focus 后 300ms 内）——
 *     用户自己用键盘/鼠标点顶部栏时窗口是聚焦状态、早过了这段，不会被抢；
 *   * 不改 `tabindex`、不改 DOM 顺序、不装常驻钩子：顶部栏的 `Alt+F/E/D/V/H`、Tab 序、
 *     菜单里的方向键/Enter/Esc 全部照旧；
 *   * 失活**前**先把焦点交给编辑面（稳定元素），让"该还给谁"有个合理答案。
 */
function focusEditorSurface(): void {
  const ed = editorStore.instance
  if (ed?.view?.dom) {
    /**
     * ⚠️ 这里必须**同步**聚焦，不能用 `ed.commands.focus()`：Tiptap 的 focus 命令内部走
     * `requestAnimationFrame`，那样纠正会晚**一整帧**（实测：t=200 被浏览器抢到「文件」、
     * t=214 才回到编辑面 —— 那一帧正是用户看到的焦点环闪烁）。
     * 直接聚焦编辑面的 DOM（PM 的选区还在，聚焦后由 PM 自己的 focus 处理同步上去），
     * 于是"抢→还"发生在**同一个任务**里，绘制读到的就是编辑面。
     */
    ;(ed.view.dom as HTMLElement).focus({ preventScroll: true })
    return
  }
  // 源码模式（没有 ProseMirror 实例）：textarea
  document.querySelector<HTMLTextAreaElement>('textarea.source-editor')?.focus()
}

function guardFocusWhileOpeningDevTools(): void {
  const isInTopMenu = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null
    return !!(el && el.closest && el.closest('.topmenu-root'))
  }
  /** 只有"窗口刚失活/刚恢复"的这一小段才纠正（见函数头说明） */
  let armed = false
  let disarmTimer: ReturnType<typeof setTimeout> | null = null

  const onFocusIn = (e: Event): void => {
    if (!armed || !isInTopMenu(e.target)) return
    // 同一任务内挪回编辑面 → 这一帧不会画出顶部栏的焦点环
    focusEditorSurface()
  }
  const onBlur = (): void => {
    armed = true
  }
  const onFocus = (): void => {
    if (!isInTopMenu(document.activeElement)) {
      // 焦点已经不在顶部栏（多数情况：浏览器根本没抢，或抢完已被纠正）——不必再纠正
      if (disarmTimer) clearTimeout(disarmTimer)
      disarmTimer = setTimeout(() => {
        armed = false
      }, 300)
    }
  }

  // 失活之前先把焦点放到编辑面（稳定元素）
  focusEditorSurface()
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  document.addEventListener('focusin', onFocusIn, true)
  // 兜底：万一某次纠正没赶上（DevTools 冷启动特别慢），到点也要把焦点要回编辑面
  window.setTimeout(() => {
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('focusin', onFocusIn, true)
    if (disarmTimer) clearTimeout(disarmTimer)
    const el = document.activeElement as HTMLElement | null
    const stolen = !el || el === document.body || el === document.documentElement || isInTopMenu(el)
    if (stolen) focusEditorSurface()
  }, 2500)
}

// ─── 二级菜单（悬停展开）：与编辑器右键菜单同一套「悬停意图」思路 ─────────────
// 一级行与二级浮层是两个独立元素，指针跨越时若立即收起，就会出现「怎么都移不到
// 二级上」；因此：定位贴死（重叠 1px，见 placeSub）、离开后用 160ms 宽限收起、
// 指针进入二级即撤销。
const subOpen = ref<SubMenu | null>(null)
const subStyle = reactive({ left: '0px', top: '0px', maxHeight: '70vh' })
let closeTimer: ReturnType<typeof setTimeout> | null = null

function cancelSubClose(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}
function scheduleSubClose(): void {
  cancelSubClose()
  closeTimer = setTimeout(() => {
    closeTimer = null
    subOpen.value = null
  }, 160)
}
function closeSub(): void {
  cancelSubClose()
  subOpen.value = null
}

/** 二级浮层定位：贴在一级面板右侧，右侧放不下则翻到左侧 */
function placeSub(rowEl: HTMLElement, sub: SubMenu): void {
  cancelSubClose()
  subOpen.value = sub
  requestAnimationFrame(() => {
    const row = rowEl.getBoundingClientRect()
    const panel = document.querySelector('.topmenu-drop')?.getBoundingClientRect()
    // 二级内容宽度按最宽项估算：RecentList 面板固定 300，children 菜单 220
    const w = sub.slot ? 300 : 220
    const base = panel ?? row
    // 横向落点与两个右键菜单**共用同一条规则**（lib/menuPlacement）：贴死父面板、右侧放不下翻左侧。
    // 纵向这里不同：不量二级高度，而是钳 top + 按"到窗口底部还剩多少"给 maxHeight（见下）。
    const x = placeSubmenuX({
      parentLeft: base.left,
      parentRight: base.right,
      width: w,
      viewportWidth: window.innerWidth
    })
    subStyle.left = `${Math.round(x.left)}px`
    const top = Math.round(Math.max(8, Math.min(row.top - 6, window.innerHeight - 120)))
    subStyle.top = `${top}px`
    // 高度必须按「到窗口底部还剩多少」钳制并允许内部滚动：编码那类二级有 14 项（≈480px），
    // 只钳 top 会让最后几行渲染到窗口外面 —— 用户点不到，自动化点不到（实测：菜单项变多后
    // 「选择编码重新打开 → Windows-1252」整行掉出视口，套件点击静默失效）
    subStyle.maxHeight = `${Math.max(160, window.innerHeight - top - 8)}px`
  })
}

function onSubRowLeave(e: MouseEvent): void {
  const related = e.relatedTarget as Node | null
  // 指针进入二级浮层 → 保持；其余情况给 160ms 宽限
  const panel = document.querySelector('.topmenu-sub')
  if (related && panel?.contains(related)) {
    cancelSubClose()
    return
  }
  scheduleSubClose()
}

function onKeydown(e: KeyboardEvent): void {
  // Esc：先收二级，再收一级菜单
  if (e.key === 'Escape' && active.value) {
    if (subOpen.value) closeSub()
    else close()
    return
  }
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const ch = e.key.toLowerCase()
  const g = GROUPS.value.find((x) => x.key === ch)
  if (!g) return
  e.preventDefault()
  e.stopPropagation()
  if (active.value?.key === g.key) close()
  else openGroup(g)
}

function onDocDown(e: MouseEvent): void {
  const el = e.target as HTMLElement
  // 下拉弹层经 Teleport 挂到 body，需一并视为菜单内部，避免点击项前被提前关闭
  if (!el.closest('.topmenu-root') && !el.closest('.topmenu-drop')) close()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('mousedown', onDocDown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onDocDown, true)
})
</script>

<template>
  <!-- 底色 = **纸**（`bg-paper`，与编辑区同一个颜色；用户口径，见 §4.82）。
       原来用外壳色 `bg-app`：浅色主题下它是 #fafafa，与白纸之间有一条看得出来的分界，
       整条菜单栏读起来像"压在页面上方的一条 chrome"。改成纸色之后，
       菜单栏 / 快捷工具栏 / 写作区在浅色主题下就是同一块白；
       深色与羊皮纸主题各自跟随 `--paper`，所以口径是"与编辑区同色"而不是写死 #fff。 -->
  <div
    class="topmenu-root flex h-8 shrink-0 items-center gap-0.5 border-b border-edge bg-paper px-2 text-ui text-ink-2 select-none"
  >
    <template v-for="g in GROUPS" :key="g.key">
      <button
        :ref="(el) => setBtnRef(g.key, el as Element | null)"
        class="rounded-md px-2 py-0.5 transition-colors"
        :class="active?.key === g.key ? 'bg-panel-2 text-ink' : 'hover:bg-panel-2 hover:text-ink'"
        :data-topmenu-group="g.key"
        @mouseenter="onGroupHover(g)"
        @click="active?.key === g.key ? close() : openGroup(g)"
      >
        {{ t(g.labelKey) }}
      </button>
    </template>

    <Teleport to="body">
      <div
        v-if="active"
        class="topmenu-drop fixed z-[var(--z-modal)] w-[248px] overflow-hidden rounded-xl border border-edge bg-elevate p-1.5 shadow-2xl"
        :style="{ left: panelStyle.left, top: panelStyle.top, boxShadow: 'var(--shadow-2)' }"
      >
        <template v-for="(it, i) in active.items" :key="i">
          <div v-if="it === 'sep'" class="my-1 h-px bg-edge" />
          <!-- 二级：悬停展开右侧浮层（最近文档 / 最近文件夹） -->
          <button
            v-else-if="isSub(it)"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui text-ink transition-colors duration-100"
            :class="subOpen?.labelKey === it.labelKey ? 'bg-panel-2' : 'hover:bg-panel-2'"
            @mouseenter="(e) => placeSub(e.currentTarget as HTMLElement, it)"
            @mouseleave="onSubRowLeave"
            @click="(e) => placeSub(e.currentTarget as HTMLElement, it)"
          >
            <span class="flex h-4 w-4 items-center justify-center text-ink-2b">
              <Icon v-if="it.icon" :name="it.icon" :size="13" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ t(it.labelKey) }}</span>
            <Icon name="chevron-right" :size="12" class="flex-none text-ink-3" />
          </button>
          <!-- 一级项（叶子）：`data-menu-item` = 该项目的 i18n 键（动态项退回文案），
               给验收脚本一个**语言无关的语义锚点**（`tools/_verify-devtools.js` 靠它点
               「帮助 → 打开开发者工具」，不按本地化文字找） -->
          <button
            v-else
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
            :class="it.danger ? 'text-danger-ink hover:bg-danger/10' : 'text-ink hover:bg-panel-2'"
            :data-menu-item="it.labelKey ?? it.label ?? ''"
            @mouseenter="closeSub"
            @click="runLeaf(it)"
          >
            <span class="flex h-4 w-4 items-center justify-center text-ink-2b">
              <Icon v-if="it.icon" :name="it.icon" :size="13" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ it.label ?? t(it.labelKey ?? '') }}</span>
          </button>
        </template>
      </div>

      <!-- 二级浮层：与一级面板贴死（重叠 1px），指针可直接平移过来 -->
      <Transition name="pop">
        <div
          v-if="active && subOpen"
          class="topmenu-drop topmenu-sub fixed z-[var(--z-modal-sub)] overflow-y-auto overscroll-contain rounded-xl border border-edge bg-elevate p-1.5"
          :style="{
            boxShadow: 'var(--shadow-2)',
            width: subOpen.slot ? '300px' : '220px',
            left: subStyle.left,
            top: subStyle.top,
            maxHeight: subStyle.maxHeight
          }"
          @mouseenter="cancelSubClose"
          @mouseleave="scheduleSubClose"
        >
          <p
            class="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2b"
          >
            {{ t(subOpen.labelKey) }}
          </p>
          <RecentList
            v-if="subOpen.slot === 'recentFiles'"
            kind="files"
            :max="8"
            dense
            @select="openRecentFile"
          />
          <RecentList
            v-else-if="subOpen.slot === 'recentFolders'"
            kind="folders"
            :max="8"
            dense
            @select="openRecentFolder"
          />
          <!-- children 列表（如「导出」下的四种格式、「选择编码重新打开」下的编码表）：
               与一级菜单项同样的行样式；active 的项右侧打勾 -->
          <template v-else-if="subOpen.children">
            <template v-for="(child, ci) in subOpen.children" :key="ci">
              <div v-if="child === 'sep'" class="my-1 h-px bg-edge" />
              <button
                v-else
                class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
                :class="
                  child.danger
                    ? 'text-danger-ink hover:bg-danger/10'
                    : child.active
                      ? 'bg-accent-soft text-accent-ink'
                      : 'text-ink hover:bg-panel-2'
                "
                :data-encoding-item="child.label ?? child.labelKey ?? ''"
                @click="runLeaf(child)"
              >
                <span class="flex h-4 w-4 items-center justify-center text-ink-2b">
                  <Icon v-if="child.icon" :name="child.icon" :size="13" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{
                  child.label ?? t(child.labelKey ?? '')
                }}</span>
                <Icon v-if="child.active" name="check" :size="13" class="flex-none" />
              </button>
            </template>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
