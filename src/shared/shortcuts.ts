// ─── 快捷键策略：谁被 Lumin 显式接管 / 显式屏蔽 ────────────────────────────────
//
// 为什么单独一个模块（而且是**纯函数**）：`before-input-event` 里那一堆
// `input.control && input.shift && input.key === 'i'` 写在主进程里既测不到（要起窗口），
// 也容易在"顺手加一条"时把某条**屏蔽**改回**允许** —— 而这一轮的改动恰恰是
// 「F12 不再打开开发者工具」，是**安全/可用性口径**，不该只靠一次 CDP 套件守着。
//
// 口径（与 main/index.ts 里的接线一一对应）：
//   * `devShortcuts()` —— 开发态**保留**的便利：重新加载（Ctrl+R / F5）与全屏（F11）。
//     打包态一条都不留（原 `@electron-toolkit/utils` 的 `watchWindowShortcuts` 在打包态
//     也是只屏蔽不提供）。
//   * `blockedShortcut()` —— **任何构建下都屏蔽**的键：F12 与 Ctrl+Shift+I。
//     这两条是 DevTools 的"隐式入口"；本项目的口径是 DevTools 只从
//     「顶部工具栏 → 打开开发者工具」与原生菜单的 `toggleDevTools` 进，
//     键盘不再有第二条路（用户要求：取消 F12 出现开发者工具）。
//     打包态尤其要屏蔽 Ctrl+Shift+I：Chromium 默认会开 DevTools，
//     而 `@electron-toolkit/utils` 以前只屏蔽 `Control+Shift`（漏了 macOS 的 `Alt+Meta`）。
//
// ⚠️ 改这里之前先想清楚：写成"允许"就等于给 DevTools 留了一条键盘后门。
//
// 与 `src/renderer/src/lib/keymap`（用户可自定义的**文档/界面命令**）不是一回事：
// 那边是应用命令表，这里是浏览器级键的接管与屏蔽，两者互不覆盖。

/** 主进程 `before-input-event` 给的按键信息（只取用得上的字段，便于纯函数测试） */
export interface KeyInput {
  /** `keyDown` / `keyUp` / `char` …（只处理 keyDown） */
  type: string
  /** 归一化后的键名（'r' / 'F5' / 'F12' …）；大小写不敏感 */
  key: string
  control?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
}

/** 开发态保留的动作：重新加载 / 全屏（其余键一律交还系统默认行为） */
export type DevShortcutAction = 'reload' | 'fullscreen'

/**
 * 开发态保留的键 → 动作。
 * 刻意**短**：只留与 DevTools 无关、开发时真的天天用的两条。
 * 返回 null = 这条键不由我们接管（走系统默认 / 渲染层命令表）。
 */
export function devShortcut(input: KeyInput): DevShortcutAction | null {
  if (input.type !== 'keyDown') return null
  const key = input.key.toLowerCase()
  // Ctrl+R / Cmd+R：重新加载
  if (key === 'r' && (input.control || input.meta)) return 'reload'
  // F5：同一条动作（编辑器式应用的常见手感）
  if (key === 'f5') return 'reload'
  // F11：全屏
  if (key === 'f11') return 'fullscreen'
  return null
}

/**
 * **任何构建下都要屏蔽**的键（`preventDefault`）：
 *   * `F12` —— 用户要求取消的那条；
 *   * `Ctrl+Shift+I`（Windows/Linux）与 `Cmd+Alt+I`（macOS）—— Chromium 的另一条 DevTools 快捷键。
 *     一并屏蔽的理由：只去掉 F12 会留下"看起来还有一条隐式路径能开 DevTools"的模糊状态，
 *     而验收要证明的正是「DevTools 不再有键盘入口」。
 */
export function blockedShortcut(input: KeyInput): boolean {
  if (input.type !== 'keyDown') return false
  const key = input.key.toLowerCase()
  if (key === 'f12') return true
  // Ctrl+Shift+I：注意要用 shift 一起判 —— 只按 Ctrl+I 是「插入/斜体」之类的编辑器命令，
  // 不能连它一起吃掉
  if (key === 'i' && input.control && input.shift) return true
  // macOS：Chromium 的 DevTools 快捷键是 Cmd+Alt+I
  if (key === 'i' && input.meta && input.alt) return true
  return false
}
