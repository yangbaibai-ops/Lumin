// ─── 导出格式的**唯一清单**（审计 §6 P2「新增功能的改动面分散：格式清单存在 5 处」）──
//
// 审计的原话：加一种导出格式要动 8~10 个文件，而"格式清单"本身在 5 处各写了一遍
// （原生菜单 / 快捷键注册表 / 设置页那张表 / 命令分发 / IPC 发送）。任何一处漏改的表现都是
// **静默少一个入口**：菜单里有、快捷键列表里没有，或者设置页说支持、点了没反应。
//
// 这个文件是那份清单的**唯一数据源**（`src/shared` 主进程与渲染层都能 import）：
//   菜单文案 key、设置页说明 key、品牌名、图标、渲染层命令 id、默认键位、菜单动作名。
// 四处渲染全部从它派生；`tests/exportFormats.test.mjs` 还会守住
// 「每个格式在 preload 与 ipc 里都真的有通道」这条静态一致性。
//
// 仍然要**手写两处**（数据共享不到函数）：主进程 `ipc.ts` 的 handler 与 `main/export.ts`
// 的实现；渲染层 `useExport.ts` 的发送表。但它们都由 `Record<ExportFormat, …>` 约束 ——
// 少一个键 TypeScript 当场报错，而不是运行时静默失败。
import type { ExportFormat } from './types'

export interface ExportFormatSpec {
  /** 格式 id，与 `shared/types` 的 `ExportFormat` 一致 */
  id: ExportFormat
  /** 语言包里的名字（原生菜单 / 应用内菜单 / 快捷键列表共用同一个 key） */
  labelKey: string
  /** 设置页那张"支持的格式"表里的实现说明 */
  descKey: string
  /** 设置页表格里显示的品牌名（不翻译：PDF / HTML / Word (.doc) / EPUB） */
  brand: string
  /** 图标名（见 components/Icon.vue 的注册表） */
  icon: string
  /** 渲染层命令注册表里的 id（同时是快捷键绑定的 key） */
  commandId: string
  /** 菜单动作名：主进程原生菜单 send 的、`useAppActions` 收到的那个字符串 */
  menuAction: string
  /** 默认键位（null = 出厂不绑；见 lib/keymap/commands） */
  defaultKeys: string | null
}

/** 顺序 = 各处的显示顺序（设置页那张表、原生菜单子项、快捷键列表都照它排） */
export const EXPORT_FORMATS: readonly ExportFormatSpec[] = [
  {
    id: 'pdf',
    labelKey: 'menu.exportPdf',
    descKey: 'settings.exportPdfDesc',
    brand: 'PDF',
    icon: 'file',
    commandId: 'file.exportPdf',
    menuAction: 'export-pdf',
    defaultKeys: 'Mod+Shift+E'
  },
  {
    id: 'html',
    labelKey: 'menu.exportHtml',
    descKey: 'settings.exportHtmlDesc',
    brand: 'HTML',
    icon: 'code',
    commandId: 'file.exportHtml',
    menuAction: 'export-html',
    defaultKeys: null
  },
  {
    id: 'word',
    labelKey: 'menu.exportWord',
    descKey: 'settings.exportWordDesc',
    brand: 'Word (HTML)',
    icon: 'file',
    commandId: 'file.exportWord',
    menuAction: 'export-word',
    defaultKeys: null
  },
  {
    id: 'epub',
    labelKey: 'menu.exportEpub',
    descKey: 'settings.exportEpubDesc',
    brand: 'EPUB',
    icon: 'book',
    commandId: 'file.exportEpub',
    menuAction: 'export-epub',
    defaultKeys: null
  }
]

/** 菜单动作名 → 格式（`useAppActions` 收到动作时按它路由；找不到就是非导出命令） */
export function exportFormatByAction(action: string): ExportFormatSpec | null {
  return EXPORT_FORMATS.find((f) => f.menuAction === action) ?? null
}
