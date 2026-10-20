// ─── 浏览器级快捷键策略：哪些 Electron/Chromium 自带的键被 Lumin 拦下 ──────────────
//
// 为什么单独一个模块（而且是**纯函数**）：`before-input-event` 里那一堆
// `input.control && input.shift && input.key === 'i'` 写在主进程里既测不到（要起窗口），
// 也容易在"顺手加一条"时把某条**拦**改回**放行** —— 而这一轮的口径是
// 「取消 Electron/Chromium 自带但本项目不需要的功能（★ 点名 Ctrl+R 刷新）」，属于
// **数据安全**（刷新会丢未保存内容）而不是外观，不该只靠一次 CDP 套件守着。
//
// ⚠️ **两条铁律**（改这里之前先读一遍）：
//   1. `before-input-event` 里 `preventDefault()` 会**同时**吃掉渲染层的 keydown 与菜单加速键
//      （Electron 文档原话：prevent the page keydown/keyup events and the menu shortcuts）。
//      所以"拦"就等于"这个组合键在应用里彻底失效" —— 绝不能拦应用自己绑过的组合。
//   2. 应用自己拥有的组合由 `APP_OWNED_COMBOS` 兜底：`blockedShortcut()` 对它们**恒返回 null**
//      （即使有人往规则里加了冲突项，也是应用赢）。新增拦截规则前，先在这份清单里核对。
//
// 与 `src/renderer/src/lib/keymap`（用户可自定义的**应用命令**表）不是一回事：
// 那边是应用命令表，这里是浏览器级键的接管，两者互不覆盖 —— 但也正因如此，
// 用户如果把某个应用命令**改绑**到下面被拦的键上，那个绑定不会生效（见模块末的说明）。

/** 主进程 `before-input-event` 给的按键信息（只取用得上的字段，便于纯函数测试） */
export interface KeyInput {
  /** `keyDown` / `keyUp` / `char` …（只处理 keyDown） */
  type: string
  /** 归一化后的键名（'r' / 'F5' / 'F12' / '=' / '-' / '0' …）；大小写不敏感 */
  key: string
  control?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
}

/**
 * 被拦下的**理由分类**（`blockedShortcut` 的返回值；非 null = 拦下）。
 * 分类而不是布尔：主进程那行取证日志要能说清"按了什么、按哪条规则被拦"，
 * 单测也能逐条钉住"这个键落在哪个桶里"，而不是只知道"被拦了"。
 */
export type BlockedReason =
  /** 刷新族：Ctrl/Cmd+R、Ctrl+Shift+R、F5、Ctrl+F5 …（会丢未保存内容） */
  | 'reload'
  /** DevTools 族：F12、Ctrl+Shift+I/J/C、Cmd+Alt+I/J/C（改用工具栏那一项） */
  | 'devtools'
  /** Chromium 的「查看网页源代码」：Ctrl/Cmd+U */
  | 'view-source'
  /** 整页缩放：Ctrl/Cmd + `=`/`+`/`-`/`_`/`0`（应用自己有字号设置，缩放会弄坏版式） */
  | 'zoom'
  /** F7：Caret Browsing（插入符号浏览） */
  | 'caret-browsing'
  /** F11：浏览器/系统全屏（应用自己的「专注模式」是 Mod+Shift+F，不受影响） */
  | 'fullscreen'

/**
 * 应用**自己**拥有的组合（`Mod+…` = Windows/Linux 的 Ctrl、macOS 的 Cmd）。
 * 来源（逐个核对，2026-10/第四轮）：
 *   * `src/renderer/src/composables/useKeymap.ts` —— 应用级命令表（默认键）；
 *   * `src/shared/exportFormats.ts` —— 导出格式的唯一清单（defaultKeys）；
 *   * `src/renderer/src/lib/editor/typoraInlineMarks.ts` 与 `lib/editor/keymap.ts` —— 编辑器级；
 *   * 代码块里的 CodeMirror keymap（见 `CodeBlockView.vue` 的 `buildCmExtensions`）。
 *
 * ⚠️ 这份清单是**应用赢**的兜底，不是"待办"：往里加 = 声明"这条键属于应用，永远别拦"。
 * 值得单独点名的几条（很容易想当然地去拦）：
 *   * `Mod+P`（打印）：**应用自己绑的**（`file.print` → 「打印…」）。Chromium 那套浏览器 UI
 *     在 Electron 里不存在，所以没有"浏览器打印对话框"要拦；拦了只会把应用自己的打印打死。
 *   * `Mod+F` / `Mod+H` / `Mod+K` / `Mod+/` / `Mod+=`? —— 前四条是应用的查找/替换/快捷键设置/
 *     循环模式；`Mod+=` **没人用**（所以它进了拦截表，见下）。
 *   * `Mod+D`（代码块多光标加选）、`Mod+E`（行内代码）、`Mod+U`（**仅代码块**，见 KNOWN_COLLISIONS）。
 *   * `Mod+B` / `Mod+I`：行内加粗/斜体（`typoraInlineMarks`）。**注意与 DevTools 的
 *     `Ctrl+Shift+I` 区分**：判据必须带 shift，否则会把斜体一起吃掉。
 *   * `Mod+Shift+B`（侧栏）、`Mod+Shift+F`（专注模式）、`Mod+Shift+E`（导出 PDF）、
 *     `Mod+Shift+X`（删除线）、`Mod+Shift+Q`（引用）、`Mod+Shift+P`（命令面板）。
 */
export const APP_OWNED_COMBOS: readonly string[] = [
  // ── 应用级命令（useKeymap.ts）──
  'Mod+N',
  'Mod+Shift+N',
  'Mod+O',
  'Mod+Shift+O',
  'Mod+S',
  'Mod+Shift+S',
  'Mod+Shift+E', // 导出 PDF（exportFormats.ts）
  'Mod+P', // 打印…（★ 见上面的说明：故意不拦）
  'Mod+W', // 关闭窗口
  'Mod+F', // 查找
  'Mod+H', // 替换
  'Mod+Shift+P', // 命令面板
  'Mod+,', // 设置
  'Mod+Shift+B', // 切换侧栏
  'Mod+Shift+F', // 专注模式（★ F11 才是浏览器全屏，这条不受影响）
  'Mod+/', // 循环编辑模式
  'Mod+Tab', // 应用内切换窗口
  'Mod+Shift+Tab',
  'Mod+K', // 快捷键设置
  // 插入类（useKeymap.ts）：Mod+Alt+T/H/K/M/G 与段落上/下；图片/代码块是 Shift 变体
  'Mod+Alt+T', // 插入表格
  'Mod+Alt+H', // 插入分割线
  // 「插入图片 / 代码块」加 Shift：macOS 的 Cmd+Alt+I / Cmd+Alt+C 是 Chromium DevTools，
  // 不能占（见 tests/shortcuts.test.mjs 的既有契约），Shift 变体避开。
  'Mod+Shift+Alt+I', // 插入图片
  'Mod+Alt+K', // 插入链接
  'Mod+Shift+Alt+C', // 插入代码块
  'Mod+Alt+M', // 插入块级公式
  'Mod+Alt+G', // 插入 Mermaid
  'Mod+Alt+ArrowUp', // 上方插入段落（原有登记，快捷键表首次真正使用）
  'Mod+Alt+ArrowDown', // 下方插入段落
  // ── 编辑器级（typoraInlineMarks / lib/editor/keymap）──
  'Mod+B',
  'Mod+I',
  'Mod+Shift+X',
  'Mod+E',
  'Mod+Shift+Q',
  // ── 编辑器内核（ProseMirror/CodeMirror 默认，实际生效的那些）──
  'Mod+Z',
  'Mod+Y',
  'Mod+Shift+Z',
  'Mod+A',
  // 剪贴板/全选：走原生菜单 role（`menu.ts` 的 cut/copy/paste/selectAll），是应用功能不是浏览器功能
  'Mod+C',
  'Mod+X',
  'Mod+V',
  'Mod+Backspace',
  'Mod+Delete',
  'Mod+Enter',
  'Mod+[',
  'Mod+]',
  'Mod+Alt+\\',
  'Mod+ArrowLeft',
  'Mod+ArrowRight',
  'Mod+ArrowUp',
  'Mod+ArrowDown',
  'Mod+Home',
  'Mod+End',
  'Mod+D', // 代码块多光标：加选下一个相同的词（CodeBlockView 显式绑定）
  // CodeMirror 的补全键（`Ctrl-Space`：CM 的表达式里 `Ctrl` 是**字面 Control**，
  // 这里按本模块的归一化口径记成 `Mod+Space`；拦不拦都不影响它，见下）
  'Mod+Space',
  'Alt+U' // 代码块：redoSelection（historyKeymap）
]

/**
 * **已知的第三方默认键冲突**（只登记、不放进 `APP_OWNED_COMBOS`）。
 *
 * `Mod+U`：代码块里 CodeMirror 的 `historyKeymap` 把 `Mod-u` 绑给了 `undoSelection`
 * （`node_modules/@codemirror/commands/dist/index.js` 的 `{ key: "Mod-u", run: undoSelection }`）。
 * 但用户这一轮明确要求拦掉 Chromium 的「查看源代码」`Ctrl+U`，而且**应用自己没有**绑它
 * （`extensions.ts` 显式关掉了 StarterKit 的 underline："关掉后 `Ctrl+U` 不再被它吞掉"）。
 * 取舍：拦 `Ctrl+U`（浏览器功能优先取消），代价是代码块里"撤销选区内的改动"这条
 * 第三方默认键失效（整篇撤销 `Mod+Z` 仍在，是应用里真正需要的那个）。
 *
 * 同一条规则的 mac 变体：`historyKeymap` 在 macOS 上把 `redoSelection` 绑给 `Mod-Shift-u`，
 * 而我们的判据是"Ctrl/Cmd+U 不看 shift"（不给 view-source 留缝），所以 mac 上它同样失效 ——
 * 应用自己的重做是 `Mod+Shift+Z` / `Mod+Y`（在 `APP_OWNED_COMBOS` 里），不受影响。
 * 将来若要还回来：把 `historyKeymap` 里的这两条换键，或从拦截表里摘掉 `view-source`。
 *
 * ⚠️ `note` 必须是**英文/ASCII**：这是给开发者看的元数据，不是界面文案 ——
 * 而且 `tests/i18nHardcoded` 会把 src 里的中文字符串字面量当成"绕过语言包"的界面文案拦下来
 * （中文说明写在注释里，扫描器会剥掉注释）。
 */
export const KNOWN_THIRD_PARTY_COLLISIONS: readonly { combo: string; note: string }[] = [
  {
    combo: 'Mod+U',
    note: 'CodeMirror historyKeymap binds Mod-u to undoSelection inside code blocks; Ctrl+U is blocked this round (view-source), so it no longer fires there'
  },
  {
    combo: 'Mod+Shift+U',
    note: 'Same rule on macOS: historyKeymap binds Cmd-Shift-u to redoSelection there, and the Ctrl/Cmd+U block ignores Shift, so it no longer fires inside code blocks'
  }
]

/** 修饰键 + 键名 → 规范化组合串（`Mod`/`Shift`/`Alt` + 键名），键名统一大写 */
function comboOf(input: KeyInput, mod: 'Mod' | 'Ctrl'): string | null {
  const key = normalizeKeyName(input.key)
  if (!key) return null
  const parts: string[] = []
  // ⚠️ 顺序与 `lib/keymap/keys.ts` 的展示顺序一致（Ctrl→Shift→Alt→Meta），
  // 这样清单里的字符串与设置界面里看到的写法是同一套
  if (input.control || input.meta) parts.push(mod)
  if (input.shift) parts.push('Shift')
  if (input.alt) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

/**
 * 有名字的键：**统一成应用 keymap 的写法**（`Tab` / `Enter` / `ArrowLeft`…）。
 * 为什么要这张表：`before-input-event` 给的是 DOM 的 `key`（大小写不定、别名不一），
 * 而清单里写的是应用自己的表达式 —— 不做归一化就会出现"清单里有 `Mod+Tab`、
 * 但比对时算出 `Mod+TAB`"这种**看起来对、其实永远匹配不上**的假防护。
 */
const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown'
}

/**
 * 键名归一化（`before-input-event` 给的是 DOM 的 `key`）：
 * 单字符统一大写（'b' → 'B'，空格 → 'Space'）、功能键统一大写（'f5' → 'F5'）、
 * 其余有名字的键查上面的表。返回 null = 认不出的键名（调用方当作"不拦"）。
 */
function normalizeKeyName(raw: string): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (raw.length === 1) return raw === ' ' ? 'Space' : raw.toUpperCase()
  const lower = raw.toLowerCase()
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase() // f5 → F5 / f12 → F12
  return NAMED_KEYS[lower] ?? raw.toUpperCase()
}

/**
 * 这条键属于**应用自己**吗（`Mod` 归一化后与 `APP_OWNED_COMBOS` 比对）。
 * `Mod` = Windows/Linux 的 Ctrl、macOS 的 Cmd —— 主进程两种都映射到同一个 `Mod`，
 * 所以同一份清单在三个平台上语义一致。
 */
export function isAppOwnedCombo(input: KeyInput): boolean {
  const combo = comboOf(input, 'Mod')
  return combo !== null && APP_OWNED_COMBOS.includes(combo)
}

/**
 * 主进程取证日志里用的可打印组合串（**ASCII**）：`Mod` 一律写成 `Ctrl`
 * （Windows 控制台按代码页解读字节，中文/`⌘` 会乱码，见 main/index.ts 的说明）。
 */
export function comboLabel(input: KeyInput): string {
  return comboOf(input, 'Ctrl') ?? `Key(${input.key})`
}

/**
 * 是否拦下这条键；返回 `null` = 放行（交给渲染层命令表 / 编辑器 keymap / 系统）。
 *
 * 拦截表（**任何构建下**都拦，含开发态 —— 理由见每条注释）：
 *   1. **刷新族** `Ctrl/Cmd+R`、`Ctrl+Shift+R`、`F5`、`Ctrl+F5`、`Shift+F5`：
 *      这不是浏览器，刷新只会丢未保存内容；开发态也不再需要它
 *      （`electron-vite dev --watch` 改文件会自动重建/重启）。
 *   2. **DevTools 族** `F12`、`Ctrl+Shift+I/J/C`、`Cmd+Alt+I/J/C`：
 *      DevTools 只从「顶部工具栏 → 打开开发者工具」与原生菜单的 `toggleDevTools` 进。
 *   3. **查看源代码** `Ctrl/Cmd+U`（详见 `KNOWN_THIRD_PARTY_COLLISIONS` 的取舍）。
 *   4. **整页缩放** `Ctrl/Cmd + = + - _ 0`：应用自己有字号设置，Chromium 的整页缩放会把
 *      版式/度量搞坏（另有一道 `setVisualZoomLevelLimits` + `zoom-changed` 管鼠标）。
 *   5. **F7**（Caret Browsing）与 **F11**（浏览器全屏）：都是 Chromium 的浏览行为。
 *      ⚠️ 应用自己的「专注模式」是 `Mod+Shift+F`（`view.focusMode`），不在这条路上。
 *
 * 另外**故意不拦**的（都属于应用自己，见 `APP_OWNED_COMBOS`）：`Mod+P` 打印、
 * `Mod+F/H` 查找替换、`Mod+Shift+F` 专注模式、`Mod+B/I` 加粗斜体、`Mod+/`、`Mod+,`、
 * `Mod+Z/Y`、`Mod+D`、`Ctrl+Space` … —— 每一条都在那份清单里有出处。
 */
export function blockedShortcut(input: KeyInput): BlockedReason | null {
  if (input.type !== 'keyDown') return null
  // 铁律 2：应用自己的组合永远放行（兜底 —— 规则写错也不会把应用功能吃掉）
  if (isAppOwnedCombo(input)) return null
  const key = input.key.toLowerCase()
  const mod = input.control || input.meta

  // ── 1) 刷新族 ──
  // 不带 shift 判据：Ctrl+Shift+R（硬刷新）与 Ctrl+R 一样要拦
  if (key === 'r' && mod) return 'reload'
  // F5 一律拦（含 Ctrl+F5 / Shift+F5 这类"强制刷新"）
  if (key === 'f5') return 'reload'

  // ── 2) DevTools 族 ──
  if (key === 'f12') return 'devtools'
  // Windows/Linux：Ctrl+Shift+I（DevTools）/ J（控制台）/ C（检查元素）
  if ((key === 'i' || key === 'j' || key === 'c') && input.control && input.shift) return 'devtools'
  // macOS：Cmd+Alt+I / J / C（Chromium 在 mac 上的同一组键）
  if ((key === 'i' || key === 'j' || key === 'c') && input.meta && input.alt) return 'devtools'

  // ── 3) 查看源代码（Ctrl/Cmd+U；见 KNOWN_THIRD_PARTY_COLLISIONS）──
  if (key === 'u' && mod) return 'view-source'

  // ── 4) 整页缩放（含 Ctrl+Shift+= 与数字键盘）──
  if (mod && (key === '=' || key === '+' || key === '-' || key === '_' || key === '0'))
    return 'zoom'

  // ── 5) F7 / F11 ──
  if (key === 'f7') return 'caret-browsing'
  if (key === 'f11') return 'fullscreen'

  return null
}
