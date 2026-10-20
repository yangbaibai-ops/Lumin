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
import { useEditorMenuStore } from '../stores/editorMenu'
import { useExport } from '../composables/useExport'
import { currentKeymap } from '../lib/keymap/service'
import { normalizeSpec } from '../lib/keymap/keys'
import { useEditorMode } from '../composables/useEditorMode'
import { useOutlineSide } from '../composables/useOutlineSide'
import { confirmIfDirty, newDocumentWindow } from '../composables/useAppActions'
import { openExternalFile, openInWindowOrFocus } from '../lib/openFile'
// 反馈渠道清单（**URL 只在这一份配置里**，模板不写死；加 Gitee = 加一条数据）
import { FEEDBACK_CHANNELS } from '../../../shared/feedback'
import { APP_DOCS_URL } from '../../../shared/appLinks'
import { defaultSettings } from '../../../shared/defaults'
import { ENCODINGS } from '../../../shared/encodings'
import { EOL_OPTIONS } from '../../../shared/eol'
// 导出格式的唯一清单（应用内菜单的二级项从它派生）
import { EXPORT_FORMATS } from '../../../shared/exportFormats'
import { placeSubmenuX } from '../lib/menuPlacement'
// 「导出启动诊断」的唯一实现（设置页/状态栏/帮助菜单共用）
import { exportStartupDiagnostics } from '../lib/startupDiagnostics'
import RecentList from './RecentList.vue'
import Icon from './Icon.vue'

const { t } = useI18n()
const router = useRouter()
const files = useFilesStore()
const ui = useUiStore()
const settings = useSettingsStore()
const editorStore = useEditorStore()
const editorMenu = useEditorMenuStore()
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
  /** 与快捷键注册表同源的命令 id：右侧加速键由它实时解析（用户改绑后跟着变） */
  commandId?: string
  /** 没有注册表命令时显示的标准键（如剪贴板 role；按平台规范化） */
  shortcut?: string
  /** 禁用态（如没有文档时「保存」） */
  disabled?: boolean
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

/** 至少打开了一篇文档（无文档时保存/导出/打印/编辑类菜单必须禁用） */
const hasDoc = computed(() => !!files.current)
/** 有编辑器实例（源码模式也仍持有 Tiptap 实例；未打开文档时为 null） */
const hasEditor = computed(() => !!editorStore.instance)

/** 字号即「缩放」的范围：与设置面板同一区间（13–26px） */
const ZOOM_MIN = 13
const ZOOM_MAX = 26
function zoomBy(delta: number): void {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, settings.fontSize + delta))
  if (next !== settings.fontSize) settings.set('fontSize', next)
}
function resetZoom(): void {
  settings.set('fontSize', defaultSettings.fontSize)
}

/**
 * 加速键显示的唯一来源：命令注册表的**生效键**（默认 + 用户覆盖）。
 * `void settings.keybindings` 保留响应式依赖：用户改绑后菜单里的组合键立刻跟着变，
 * 与设置页看到的是同一份数据（绝不在这里抄第二张键位表）。
 */
const keyLabels = computed<Record<string, string>>(() => {
  void settings.keybindings
  const out: Record<string, string> = {}
  for (const c of currentKeymap()?.resolved() ?? []) {
    if (c.keys) out[c.id] = c.keys
  }
  return out
})

/** 菜单项右侧的加速键文案（没有就返回空串，不占位） */
function shortcutOf(it: Leaf): string {
  if (it.commandId) return keyLabels.value[it.commandId] ?? ''
  return it.shortcut ? (normalizeSpec(it.shortcut) ?? '') : ''
}

/** 「大纲」：切到左栏的大纲页签（不是"左右位置"，那是下一项） */
function showOutline(): void {
  ui.sidebarVisible = true
  ui.sidebarTab = 'outline'
  settings.set('sidebarVisible', true)
}

/** 「帮助 → 检查更新」：开发态没有更新渠道，如实提示而不是假装在检查 */
async function checkForUpdate(): Promise<void> {
  const res = await window.luminAPI.app.checkUpdate()
  if (!res?.ok) ui.toast(t('menu.updateUnavailable'), 'info')
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
        commandId: 'file.new',
        run: () => newDocumentWindow()
      },
      {
        labelKey: 'menu.newWindow',
        icon: 'copy',
        commandId: 'file.newWindow',
        run: () => window.luminAPI.app.newWindow()
      },
      {
        labelKey: 'menu.openFile',
        icon: 'folder-open',
        commandId: 'file.open',
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
      {
        labelKey: 'menu.openFolder',
        icon: 'folderOpen',
        commandId: 'file.openFolder',
        run: () => files.openFolder()
      },
      'sep',
      // 一级项 + 悬停二级：最近文档 / 最近文件夹（二级里用共用的 RecentList 组件）
      { labelKey: 'open.recent', icon: 'clock', slot: 'recentFiles' },
      { labelKey: 'open.recentFolders', icon: 'folder', slot: 'recentFolders' },
      'sep',
      {
        labelKey: 'menu.save',
        icon: 'save',
        commandId: 'file.save',
        // 没有文档时保存没有意义（用户口径：无文档时「保存」禁用）
        disabled: !hasDoc.value,
        // 保存成功不发通知（脏标记/状态栏就是反馈）；失败本身由 files.save() 内部报错
        run: async () => {
          await files.save()
        }
      },
      {
        labelKey: 'menu.saveAs',
        icon: 'copy',
        commandId: 'file.saveAs',
        disabled: !hasDoc.value,
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
          commandId: f.commandId,
          disabled: !hasDoc.value,
          run: () => runExport(f.id)
        }))
      },
      // 「打印」紧挨着导出，但它**不来自** EXPORT_FORMATS：那份清单是「导出格式的唯一清单」，
      // 而打印不落盘、没有输出文件（审计 §7 第 18 条：此前只有 PDF 导出）。Ctrl+P 同一动作。
      {
        labelKey: 'menu.print',
        icon: 'printer',
        commandId: 'file.print',
        disabled: !hasDoc.value,
        run: () => runPrint()
      },
      // 本地历史（Wave 2）：保存前的快照可查看/载入（未落盘文档没有历史）
      {
        labelKey: 'menu.localHistory',
        icon: 'clock',
        disabled: !files.current?.path,
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
      },
      'sep',
      {
        labelKey: 'menu.closeWindow',
        icon: 'x',
        commandId: 'file.closeWindow',
        run: () => window.luminAPI.app.close()
      },
      {
        // 退出没有注册表命令（它不属于"文档命令"）：不显示假加速键。
        // 实际退出走主进程 app.quit() → 每个窗口的关窗守卫照常询问保存。
        labelKey: 'menu.quit',
        icon: 'x',
        run: () => window.luminAPI.app.quit()
      }
    ]
  },
  {
    key: 'e',
    labelKey: 'menu.edit',
    items: [
      {
        labelKey: 'menu.undo',
        icon: 'undo',
        shortcut: 'Mod+Z',
        disabled: !hasEditor.value,
        run: () => editorStore.instance?.commands.undo()
      },
      {
        labelKey: 'menu.redo',
        icon: 'redo',
        shortcut: 'Mod+Shift+Z',
        disabled: !hasEditor.value,
        run: () => editorStore.instance?.commands.redo()
      },
      'sep',
      // 剪贴板四项走编辑器动作目录的既有实现（与右键菜单/工具栏同一份）：
      // cut/copy 走 execCommand，paste 走 PM 的粘贴管线（含 Markdown 解析）。
      {
        labelKey: 'menu.cut',
        icon: 'scissors',
        shortcut: 'Mod+X',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('clipboard.cut')
      },
      {
        labelKey: 'menu.copy',
        icon: 'copy',
        shortcut: 'Mod+C',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('clipboard.copy')
      },
      {
        labelKey: 'menu.paste',
        icon: 'clipboard',
        shortcut: 'Mod+V',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('clipboard.paste')
      },
      {
        labelKey: 'menu.pastePlain',
        icon: 'clipboard',
        commandId: 'edit.pastePlain',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('clipboard.pastePlain')
      },
      {
        labelKey: 'menu.selectAll',
        icon: 'list-checks',
        shortcut: 'Mod+A',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('clipboard.selectAll')
      },
      'sep',
      {
        labelKey: 'menu.findReplace',
        icon: 'search',
        commandId: 'edit.findReplace',
        run: () => useFindStore().show()
      },
      {
        labelKey: 'menu.replace',
        icon: 'pencil',
        commandId: 'edit.replace',
        run: () => useFindStore().showReplace()
      },
      {
        labelKey: 'menu.globalSearch',
        icon: 'list-checks',
        commandId: 'edit.globalSearch',
        run: () => ui.openGlobalSearch()
      }
    ]
  },
  {
    key: 'd',
    labelKey: 'menu.paragraph',
    items: [
      {
        labelKey: 'editor.codeBlock',
        icon: 'braces',
        commandId: 'insert.codeBlock',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('paragraph.codeBlock')
      },
      {
        labelKey: 'editor.quote',
        icon: 'quote',
        disabled: !hasEditor.value,
        run: () => editorStore.instance?.chain().focus().toggleBlockquote().run()
      },
      'sep',
      {
        labelKey: 'editor.ul',
        icon: 'list',
        disabled: !hasEditor.value,
        run: () => editorStore.instance?.chain().focus().toggleBulletList().run()
      },
      {
        labelKey: 'editor.ol',
        icon: 'list-ordered',
        disabled: !hasEditor.value,
        run: () => editorStore.instance?.chain().focus().toggleOrderedList().run()
      },
      {
        labelKey: 'editor.task',
        icon: 'list-checks',
        disabled: !hasEditor.value,
        run: () => editorStore.instance?.chain().focus().toggleTaskList().run()
      },
      'sep',
      {
        labelKey: 'editor.hr',
        icon: 'hr',
        commandId: 'insert.hr',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.hr')
      },
      'sep',
      // 插入类：与快捷键注册表、编辑器右键菜单共用同一批动作 id（见 useKeymap 的 insert.*）。
      {
        labelKey: 'editorMenu.table',
        icon: 'table',
        commandId: 'insert.table',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.table')
      },
      {
        labelKey: 'editorMenu.image',
        icon: 'image',
        commandId: 'insert.image',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.image')
      },
      {
        labelKey: 'editorMenu.link',
        icon: 'link',
        commandId: 'insert.link',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.link')
      },
      {
        labelKey: 'editorMenu.math',
        icon: 'sigma',
        commandId: 'insert.math',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.math')
      },
      {
        labelKey: 'editorMenu.mermaid',
        icon: 'braces',
        commandId: 'insert.mermaid',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.mermaid')
      },
      'sep',
      {
        labelKey: 'editorMenu.paragraphAbove',
        icon: 'chevron-up',
        commandId: 'insert.paragraphAbove',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.paragraphAbove')
      },
      {
        labelKey: 'editorMenu.paragraphBelow',
        icon: 'chevron-down',
        commandId: 'insert.paragraphBelow',
        disabled: !hasEditor.value,
        run: () => void editorMenu.runById('insert.paragraphBelow')
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
        commandId: 'view.toggleSidebar',
        run: () => {
          ui.sidebarVisible = !ui.sidebarVisible
          settings.set('sidebarVisible', ui.sidebarVisible)
        }
      },
      {
        // 「大纲」：直接切到左栏的大纲页签（不是"左右位置"，那是下一项）。
        labelKey: 'menu.outline',
        icon: 'outline-panel',
        disabled: !hasDoc.value,
        run: showOutline
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
        commandId: 'view.outlineSide',
        run: toggleOutlineSide
      },
      'sep',
      {
        labelKey: 'menu.wysiwyg',
        icon: 'eye',
        commandId: 'view.modeWysiwyg',
        run: () => setMode('wysiwyg')
      },
      {
        labelKey: 'menu.split',
        icon: 'columns',
        commandId: 'view.modeSplit',
        run: () => setMode('split')
      },
      {
        labelKey: 'menu.source',
        icon: 'source',
        commandId: 'view.modeSource',
        run: () => setMode('source')
      },
      'sep',
      {
        labelKey: 'menu.focus',
        icon: 'focus',
        commandId: 'view.focusMode',
        run: () => {
          ui.focusMode = !ui.focusMode
        }
      },
      'sep',
      // 缩放 = 正文字号（应用自己有字号设置，Chromium 整页缩放会弄坏版式）；
      // 上下界与设置面板一致，到界后对应项禁用。
      {
        labelKey: 'menu.zoomIn',
        icon: 'plus',
        disabled: settings.fontSize >= ZOOM_MAX,
        run: () => zoomBy(1)
      },
      {
        labelKey: 'menu.zoomOut',
        icon: 'minus',
        disabled: settings.fontSize <= ZOOM_MIN,
        run: () => zoomBy(-1)
      },
      {
        labelKey: 'menu.zoomReset',
        icon: 'refresh',
        run: resetZoom
      },
      'sep',
      // 主题切换：与原生菜单同一组取值（直接写设置，主进程广播后全局生效）
      {
        labelKey: 'menu.theme',
        icon: 'sun',
        children: [
          {
            labelKey: 'menu.themeAuto',
            active: settings.theme === 'auto',
            run: () => settings.set('theme', 'auto')
          },
          {
            labelKey: 'menu.themeLight',
            active: settings.theme === 'light',
            run: () => settings.set('theme', 'light')
          },
          {
            labelKey: 'menu.themeDark',
            active: settings.theme === 'dark',
            run: () => settings.set('theme', 'dark')
          },
          {
            labelKey: 'menu.themeSepia',
            active: settings.theme === 'sepia',
            run: () => settings.set('theme', 'sepia')
          }
        ]
      }
    ]
  },
  {
    key: 'h',
    labelKey: 'menu.help',
    items: [
      { labelKey: 'menu.settings', icon: 'settings', run: () => ui.openSettings() },
      {
        // 快捷键一览：直接打开设置里的「快捷键」页签（与 Ctrl+, 后切页签同一目的地）
        labelKey: 'menu.keymap',
        icon: 'keyboard',
        commandId: 'help.keymap',
        run: () => ui.openSettings('keymap')
      },
      {
        // 使用文档：README（URL 在 shared/appLinks.ts，打开走既有外链白名单）
        labelKey: 'menu.docs',
        icon: 'book',
        run: () => window.luminAPI.shell.openExternal(APP_DOCS_URL)
      },
      { labelKey: 'menu.about', icon: 'info', run: () => router.push('/about') },
      { labelKey: 'menu.checkUpdate', icon: 'refresh', run: checkForUpdate },
      // 「导出启动诊断」：用户报「启动慢/闪退」时，一键把脱敏的 startup.log（最近 5 次）
      // 与环境摘要写成一份文件发给开发者。实现与设置页那颗按钮**共用同一份**
      // （lib/startupDiagnostics.ts），不在这里另写 toast/失败处理。
      {
        labelKey: 'menu.exportStartupDiagnostics',
        icon: 'download',
        run: () => void exportStartupDiagnostics()
      },
      // 与上面几条（设置 / 快捷键 / 文档 / 关于 / 更新）之间画一条分隔线：
      // 下面是**开发者向**的入口
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
      },
      // 「意见或 bug 反馈」：**子菜单**列出全部反馈渠道（用户口径「可能有多个：github、gitee 等」）。
      // 为什么用子菜单而不是弹对话框：顶部栏本来就有二级浮层这套机制（悬停意图/贴边翻转/
      // 键盘可达都由既有代码负责），加渠道只是给 `FEEDBACK_CHANNELS` 加一条数据；弹对话框
      // 要新造一个模态 + 焦点陷阱 + 无障碍语义，为一个"选一个链接"的动作不划算。
      // 渠道的 URL 只存在于 `shared/feedback.ts`，模板里一个 URL 都没有。
      {
        labelKey: 'menu.feedback',
        icon: 'globe',
        children: FEEDBACK_CHANNELS.map((channel) => ({
          labelKey: channel.labelKey,
          run: () => openFeedbackChannel(channel.url)
        }))
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
  if (leaf.disabled) return
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

/**
 * 打开一个反馈渠道的外链（「帮助 → 意见或 bug 反馈 → …」的每一个子项都走这里）。
 *
 * 两条口径：
 *   * **走既有通路**：`window.luminAPI.shell.openExternal`（主进程 `shell:openExternal` →
 *     `services/links.ts` 的 `safeExternalUrl` 白名单：只放 http/https/mailto，
 *     `javascript:`/`file:` 这类一律拒）。这里**不再造一套**校验，也不自己拼 URL。
 *   * **焦点交回编辑面**：点了子项之后菜单会关掉、被点的那个按钮从 DOM 里消失 → 焦点落到
 *     `body`；不处理的话用户接着打字会"没反应"。这与「打开开发者工具」那条的口径一致
 *     （动作结束后焦点不在顶部栏里）。
 */
function openFeedbackChannel(url: string): void {
  window.luminAPI.shell.openExternal(url)
  focusEditorSurface()
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
          <!-- 二级：悬停展开右侧浮层（最近文档 / 最近文件夹 / 反馈渠道）。
               `data-menu-item` 与叶子项同一套约定（值 = i18n 键）—— 子菜单行也要有个
               语言无关的锚点，否则验收只能按本地化文案找它。 -->
          <button
            v-else-if="isSub(it)"
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui text-ink transition-colors duration-100"
            :class="subOpen?.labelKey === it.labelKey ? 'bg-panel-2' : 'hover:bg-panel-2'"
            :data-menu-item="it.labelKey"
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
            :class="[
              it.danger ? 'text-danger-ink hover:bg-danger/10' : 'text-ink hover:bg-panel-2',
              it.disabled ? 'cursor-not-allowed opacity-40' : ''
            ]"
            :disabled="it.disabled"
            :aria-disabled="it.disabled ? 'true' : undefined"
            :data-menu-item="it.labelKey ?? it.label ?? ''"
            :data-command-id="it.commandId"
            :data-shortcut="shortcutOf(it)"
            @mouseenter="closeSub"
            @click="runLeaf(it)"
          >
            <span class="flex h-4 w-4 items-center justify-center text-ink-2b">
              <Icon v-if="it.icon" :name="it.icon" :size="13" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ it.label ?? t(it.labelKey ?? '') }}</span>
            <!-- 加速键：来自命令注册表的生效键（用户改绑后实时变化），不是另一张表 -->
            <span
              v-if="shortcutOf(it)"
              class="ml-1 flex-none font-mono text-ui-sm tracking-tight text-ink-3"
            >
              {{ shortcutOf(it) }}
            </span>
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
          <!-- children 列表（如「导出」下的四种格式、「选择编码重新打开」下的编码表、
               「意见或 bug 反馈」下的各渠道）：与一级菜单项同样的行样式；active 的项右侧打勾。
               `data-encoding-item` 是历史锚点（编码/导出那两个子菜单的套件在用，**不许改名**）；
               `data-menu-item` 是通用的语言无关锚点（值 = i18n 键），新的子项一律靠它定位。 -->
          <template v-else-if="subOpen.children">
            <template v-for="(child, ci) in subOpen.children" :key="ci">
              <div v-if="child === 'sep'" class="my-1 h-px bg-edge" />
              <button
                v-else
                class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui transition-colors duration-100"
                :class="[
                  child.danger
                    ? 'text-danger-ink hover:bg-danger/10'
                    : child.active
                      ? 'bg-accent-soft text-accent-ink'
                      : 'text-ink hover:bg-panel-2',
                  child.disabled ? 'cursor-not-allowed opacity-40' : ''
                ]"
                :disabled="child.disabled"
                :aria-disabled="child.disabled ? 'true' : undefined"
                :data-encoding-item="child.label ?? child.labelKey ?? ''"
                :data-menu-item="child.labelKey ?? child.label ?? ''"
                :data-command-id="child.commandId"
                :data-shortcut="shortcutOf(child)"
                @click="runLeaf(child)"
              >
                <span class="flex h-4 w-4 items-center justify-center text-ink-2b">
                  <Icon v-if="child.icon" :name="child.icon" :size="13" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{
                  child.label ?? t(child.labelKey ?? '')
                }}</span>
                <span
                  v-if="shortcutOf(child)"
                  class="ml-1 flex-none font-mono text-ui-sm tracking-tight text-ink-3"
                >
                  {{ shortcutOf(child) }}
                </span>
                <Icon v-if="child.active" name="check" :size="13" class="flex-none" />
              </button>
            </template>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
