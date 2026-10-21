import { useEditorMode } from './useEditorMode'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { EXPORT_FORMATS } from '../../../shared/exportFormats'
import type { CommandPaletteItem } from '../lib/commandPalette'
import type { useAppActions } from './useAppActions'

/**
 * ─── 命令面板的命令表（**只做接线，不造业务**）──────────────────────────────
 *
 * 为什么是"接线"而不是"实现"：这些动作各有唯一实现，散在 `useAppActions.handleMenu`
 * （原生菜单/快捷键都走它）、`stores/settings`（主题）、`useEditorMode`（编辑面切换）里。
 * 面板如果各写一遍，就会出现「菜单点一次的行为」和「面板选一次的行为」不一致 ——
 * 那正是审计里反复出现的"两套真相"。
 *
 * 因此每一条都指向**既有入口**：
 *   * 菜单动作 → `handleMenu(action)`（与 Ctrl+N / 原生菜单同一条路）；
 *   * 主题 → `settings.setTheme()`（与设置页/原生菜单主题项同一入口）；
 *   * 导出 → 从 `EXPORT_FORMATS` 清单派生（加一种格式不用回来补行）。
 *
 * 刻意**没有**收进来的（宁可少，不要假）：重载 / 开发者工具 —— 它们只有原生菜单的
 * electron role 入口，渲染层没有对应动作，面板里放一条"点了没反应"的项比没有更糟。
 */
export function buildPaletteCommands(
  actions: ReturnType<typeof useAppActions>
): CommandPaletteItem[] {
  const { handleMenu } = actions
  const ui = useUiStore()
  const settings = useSettingsStore()
  const { setMode } = useEditorMode()

  return [
    // ── 文件 ──
    {
      id: 'file.new',
      labelKey: 'menu.new',
      groupKey: 'keymap.groupFile',
      icon: 'file-plus',
      keywords: ['file.new', 'new document'],
      run: () => handleMenu('new')
    },
    {
      id: 'file.newWindow',
      labelKey: 'menu.newWindow',
      groupKey: 'keymap.groupFile',
      icon: 'copy',
      keywords: ['window'],
      run: () => handleMenu('new-window')
    },
    {
      id: 'file.open',
      labelKey: 'menu.openFile',
      groupKey: 'keymap.groupFile',
      icon: 'folder',
      keywords: ['open file'],
      run: () => handleMenu('open')
    },
    {
      id: 'file.openFolder',
      labelKey: 'menu.openFolder',
      groupKey: 'keymap.groupFile',
      icon: 'folder-plus',
      keywords: ['workspace', 'open folder'],
      run: () => handleMenu('open-folder')
    },
    {
      id: 'file.save',
      labelKey: 'menu.save',
      groupKey: 'keymap.groupFile',
      icon: 'save',
      keywords: ['write'],
      run: () => handleMenu('save')
    },
    {
      id: 'file.saveAs',
      labelKey: 'menu.saveAs',
      groupKey: 'keymap.groupFile',
      icon: 'copy',
      keywords: ['export file'],
      run: () => handleMenu('save-as')
    },
    // 导出四态从唯一清单派生（与菜单/快捷键同一份数据）
    ...EXPORT_FORMATS.map((f) => ({
      id: f.commandId,
      labelKey: f.labelKey,
      groupKey: 'keymap.groupExport',
      icon: f.icon,
      keywords: [f.brand],
      run: () => handleMenu(f.menuAction)
    })),

    // ── 编辑 ──
    {
      id: 'edit.find',
      labelKey: 'menu.findReplace',
      groupKey: 'keymap.groupEdit',
      icon: 'search',
      keywords: ['find', 'search in document'],
      run: () => handleMenu('find')
    },
    {
      id: 'edit.replace',
      labelKey: 'menu.replace',
      groupKey: 'keymap.groupEdit',
      icon: 'pencil',
      keywords: ['replace all'],
      run: () => handleMenu('replace')
    },
    {
      id: 'edit.globalSearch',
      labelKey: 'menu.globalSearch',
      groupKey: 'keymap.groupEdit',
      icon: 'list-checks',
      keywords: ['workspace search', 'fts'],
      run: () => handleMenu('global-search')
    },
    {
      id: 'ai.summarize',
      labelKey: 'menu.aiSummarize',
      groupKey: 'keymap.groupEdit',
      icon: 'sparkles',
      keywords: ['ai', 'summary', 'summarize'],
      run: () => handleMenu('ai-summarize')
    },
    {
      id: 'ai.rewrite',
      labelKey: 'menu.aiRewrite',
      groupKey: 'keymap.groupEdit',
      icon: 'pencil',
      keywords: ['ai', 'rewrite', 'polish'],
      run: () => handleMenu('ai-rewrite')
    },

    // ── 视图 ──
    {
      id: 'view.modeWysiwyg',
      labelKey: 'editor.wysiwyg',
      groupKey: 'keymap.groupView',
      icon: 'eye',
      keywords: ['wysiwyg', 'live preview'],
      run: () => setMode('wysiwyg')
    },
    {
      id: 'view.modeSource',
      labelKey: 'editor.source',
      groupKey: 'keymap.groupView',
      icon: 'source',
      keywords: ['markdown source'],
      run: () => setMode('source')
    },
    {
      id: 'view.modeSplit',
      labelKey: 'editor.split',
      groupKey: 'keymap.groupView',
      icon: 'columns',
      keywords: ['split'],
      run: () => setMode('split')
    },
    {
      id: 'view.toggleSidebar',
      labelKey: 'menu.toggleSidebar',
      groupKey: 'keymap.groupView',
      icon: 'panel-left',
      keywords: ['sidebar'],
      run: () => handleMenu('toggle-sidebar')
    },
    {
      // 大纲位置只有这一条（左栏 ⇄ 编辑区右侧是**同一个开关**）：文案跟状态走说的是下一步，
      // 与顶部菜单「视图」里那一项同一口径（见 useOutlineSide）。
      id: 'view.outlineSide',
      labelKey: settings.outlineOnRight ? 'outline.toLeft' : 'outline.toRight',
      groupKey: 'keymap.groupView',
      icon: 'outline-panel',
      keywords: ['outline', 'toc'],
      run: () => handleMenu('outline-side')
    },
    {
      id: 'view.focusMode',
      labelKey: 'menu.focus',
      groupKey: 'keymap.groupView',
      icon: 'focus',
      keywords: ['zen', 'distraction free'],
      run: () => handleMenu('toggle-focus')
    },

    // ── 主题（与设置页/原生菜单同一个写入口：settings.setTheme）──
    {
      id: 'theme.light',
      labelKey: 'menu.themeLight',
      groupKey: 'keymap.groupView',
      icon: 'sun',
      keywords: ['theme', 'light'],
      run: () => void settings.setTheme('light')
    },
    {
      id: 'theme.dark',
      labelKey: 'menu.themeDark',
      groupKey: 'keymap.groupView',
      icon: 'moon',
      keywords: ['theme', 'dark'],
      run: () => void settings.setTheme('dark')
    },
    {
      id: 'theme.sepia',
      labelKey: 'menu.themeSepia',
      groupKey: 'keymap.groupView',
      icon: 'book',
      keywords: ['theme', 'sepia'],
      run: () => void settings.setTheme('sepia')
    },
    {
      id: 'theme.auto',
      labelKey: 'menu.themeAuto',
      groupKey: 'keymap.groupView',
      icon: 'monitor',
      keywords: ['theme', 'system'],
      run: () => void settings.setTheme('auto')
    },

    // ── 帮助 ──
    {
      id: 'app.settings',
      labelKey: 'menu.settings',
      groupKey: 'keymap.groupEdit',
      icon: 'settings',
      keywords: ['preferences', 'options'],
      run: () => handleMenu('settings')
    },
    {
      // 与顶部菜单/快捷键表同一入口：设置面板的「快捷键」分区
      id: 'help.keymap',
      labelKey: 'keymap.openKeymapSettings',
      groupKey: 'keymap.groupHelp',
      icon: 'keyboard',
      keywords: ['shortcuts'],
      run: () => ui.openSettings('keymap')
    }
  ]
}
