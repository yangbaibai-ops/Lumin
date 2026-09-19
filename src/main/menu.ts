// ─── 主进程：应用菜单（三语）───────────────────────────────────────────────
//
// 为什么之前是硬编码中文：菜单栏默认被隐藏（autoHideMenuBar=false + 自绘顶栏），
// 只有系统级可访问性（Alt 唤出、屏幕阅读器、Windows 的菜单键）才用到它，于是被当成"没人看"。
// 但**非中文用户按 Alt 看到一整屏中文**是实打实的可用性问题，而且语言切换后菜单不跟着变。
//
// 做法：
//   * 语言包与渲染层**共用同一份**（`src/shared/i18n/*.json`）—— 一处维护，两个进程一致；
//   * 语言取持久化设置（SQLite kv 的 settings.language）；
//   * `settings:update` 里语言变了就重建菜单（见 ipc.ts），不然要重启才生效。
//
// 注意：这里**故意不设 accelerator**。应用级快捷键由渲染层的命令注册表统一接管
// （renderer/src/lib/keymap/），用户可以在「设置 → 快捷键」里改；若原生菜单也绑一份，
// 就会出现「用户改了键但原生那份照旧触发」的两套真相 + 重复触发。
import { app, BrowserWindow, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { settingsStore } from './store'
import { db } from './services/database'
import { defaultSettings } from '../shared/defaults'
import type { AppSettings, Language } from '../shared/types'
import zhCN from '../shared/i18n/zh-CN.json'
import enUS from '../shared/i18n/en-US.json'
import ruRU from '../shared/i18n/ru-RU.json'

function send(action: string): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win) win.webContents.send('menu:action', action)
}

/** 语言包（与渲染层同一份文件）；新增语言 = 在这里登记一行 */
const LOCALES: Record<Language, { menu: Record<string, string> }> = {
  'zh-CN': zhCN as { menu: Record<string, string> },
  'en-US': enUS as { menu: Record<string, string> },
  'ru-RU': ruRU as { menu: Record<string, string> }
}

/** 当前语言：以持久化设置里的为准（缺省中文） */
function currentLanguage(): Language {
  const settings = db.kvGet<AppSettings>('settings', defaultSettings)
  const lang = settings?.language
  return lang && lang in LOCALES ? lang : 'zh-CN'
}

/** 取菜单文案；缺键时回退中文包，再缺就回退 key（绝不显示 undefined） */
function t(key: string): string {
  const pack = LOCALES[currentLanguage()]
  return pack.menu[key] ?? LOCALES['zh-CN'].menu[key] ?? key
}

export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const T = t

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: T('about') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, label: T('hide') },
              { role: 'unhide' as const, label: T('unhide') },
              { type: 'separator' as const },
              { role: 'quit' as const, label: T('quit') }
            ]
          }
        ]
      : []),
    {
      label: T('file'),
      submenu: [
        { label: T('new'), click: () => send('new') },
        { label: T('openFile'), click: () => send('open') },
        { label: T('openFolder'), click: () => send('open-folder') },
        { type: 'separator' },
        { label: T('save'), click: () => send('save') },
        { label: T('saveAs'), click: () => send('save-as') },
        { type: 'separator' },
        {
          label: T('export'),
          submenu: [
            { label: T('exportPdf'), click: () => send('export-pdf') },
            { label: T('exportHtml'), click: () => send('export-html') },
            { label: T('exportWord'), click: () => send('export-word') },
            { label: T('exportEpub'), click: () => send('export-epub') }
          ]
        },
        { type: 'separator' },
        isMac
          ? { role: 'close' as const, label: T('closeWindow') }
          : { role: 'quit' as const, label: T('quit') }
      ]
    },
    {
      label: T('edit'),
      submenu: [
        { role: 'undo', label: T('undo') },
        { role: 'redo', label: T('redo') },
        { type: 'separator' },
        { role: 'cut', label: T('cut') },
        { role: 'copy', label: T('copy') },
        { role: 'paste', label: T('paste') },
        { role: 'selectAll', label: T('selectAll') },
        { type: 'separator' },
        { label: T('findReplace'), click: () => send('find') },
        { label: T('replace'), click: () => send('replace') },
        { label: T('globalSearch'), click: () => send('global-search') }
      ]
    },
    {
      label: T('view'),
      submenu: [
        { label: T('toggleSidebar'), click: () => send('toggle-sidebar') },
        { label: T('toggleToolbar'), click: () => send('toggle-toolbar') },
        { type: 'separator' },
        {
          label: T('editorMode'),
          submenu: [
            { label: T('wysiwyg'), click: () => send('mode-wysiwyg') },
            { label: T('split'), click: () => send('mode-split') },
            { label: T('source'), click: () => send('mode-source') }
          ]
        },
        { label: T('focus'), click: () => send('toggle-focus') },
        { label: T('typewriter'), click: () => send('toggle-typewriter') },
        { type: 'separator' },
        {
          label: T('theme'),
          submenu: [
            {
              label: T('themeAuto'),
              click: () => {
                settingsStore.set('theme', 'auto')
                send('theme-changed')
              }
            },
            {
              label: T('themeLight'),
              click: () => {
                settingsStore.set('theme', 'light')
                send('theme-changed')
              }
            },
            {
              label: T('themeDark'),
              click: () => {
                settingsStore.set('theme', 'dark')
                send('theme-changed')
              }
            },
            {
              label: T('themeSepia'),
              click: () => {
                settingsStore.set('theme', 'sepia')
                send('theme-changed')
              }
            }
          ]
        },
        { type: 'separator' },
        { role: 'reload', label: T('reload') },
        { role: 'toggleDevTools', label: T('devtools') }
      ]
    },
    {
      label: T('help'),
      submenu: [
        { label: T('settings'), click: () => send('settings') },
        { label: T('about'), click: () => send('about') },
        { label: T('homepage'), click: () => shell.openExternal('https://github.com') }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // 自检日志（**ASCII**，便于脚本 grep）：验收脚本读实例 stdout 就能确认
  // 「原生菜单确实按新语言重建了」—— 菜单栏默认隐藏，页面侧看不到它，这是唯一可自动验证的观察点。
  console.log(`[menu] rebuilt lang=${currentLanguage()} top=${template.length}`)
}
