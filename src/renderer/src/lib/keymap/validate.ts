// ─── 快捷键校验（纯函数）─────────────────────────────────────────────────────
//
// 为什么单独一层：录制器（SettingsKeymap）、历史数据审计（启动时）与单测必须
// 用**同一套规则**。规则写进组件里，单测就只能测"组件长得像不像"，而"f 能不能
// 存进去"这种数据契约会随着一次顺手改动漂掉。
//
// 四条规则（与用户口径一一对应）：
//   1) 字母/数字/标点这类**打印字符**必须带 Ctrl/Cmd 或 Alt；
//      Shift 单独不算 —— `Shift+F` 仍然是"按住 Shift 打一个大写 F"，会拦截输入。
//   2) 允许单独使用：F1–F24、Escape、Shift+Tab（焦点回退是标准行为）。
//      其余无名键（Tab / Enter / 方向键…）一律要求 Ctrl/Cmd 或 Alt。
//   3) 系统保留组合（刷新/DevTools/缩放/退出/关窗…）不能绑定 —— 表在下面，
//      与 `src/shared/shortcuts.ts` 的拦截表保持同一口径。
//   4) 同一组合已经绑给别的命令时拒绝保存，并尽量给一个可用的替代键。
//
// ⚠️ `Mod` = Windows/Linux 的 Ctrl、macOS 的 Cmd（解析在 keys.ts）。
// 本模块不读 DOM/store，Node 单测可直接 import（见 tests/keymapValidation.test.mjs）。

import { formatKeybinding, parseKeybinding, type Keybinding } from './keys.ts'

/** 校验结果分类：ok 以外都是"拒绝保存"的理由 */
export type KeymapValidationCode = 'ok' | 'syntax' | 'modifier-required' | 'reserved' | 'conflict'

/** 一条被校验的绑定（生效键已规范化；null = 未绑定） */
export interface KeymapBindingLike {
  id: string
  keys: string | null
  /** 仅用于提示/调试；冲突展示由调用方按 id 查标题 */
  titleKey?: string
}

export interface KeymapValidationOptions {
  /** 正在改的是哪条命令：它自己当前的键不算冲突 */
  selfId?: string
  /** 其他命令的生效键（用于重复绑定检测） */
  bindings?: readonly KeymapBindingLike[]
}

export interface KeymapValidationResult {
  ok: boolean
  code: KeymapValidationCode
  /** 规范化后的表达式（语法错误时为原始输入） */
  spec: string
  /** 可直接交给 i18n 的提示键 */
  messageKey: string
  /** code = conflict：占用该键的命令 id */
  conflictWith: string[]
  /** 建议的替代键（没有可用替代时为 null） */
  suggestion: string | null
  /** code = reserved：命中的保留表条目 */
  reserved?: ReservedShortcut
}

/**
 * 系统保留组合表。
 *
 * 与 `src/shared/shortcuts.ts` 的 `blockedShortcut()` **同源**：那边在主进程
 * `before-input-event` 里拦，这里在"用户想绑它"的时候提前拒绝 —— 否则用户会得到
 * 一条"设置里显示成功、按下去毫无反应"的假绑定。
 *
 * `Mod+W` 也在表里：它确实是 Electron 的关窗键，而本应用的「关闭窗口」出厂就绑了
 * 它。默认键不经过这里（见 auditKeybindings），所以不会把既有默认键判成非法；
 * 但用户想**把别的命令**改到 Ctrl+W 时会被拒绝。
 */
export interface ReservedShortcut {
  /** 规范化前的写法（展示与单测用） */
  combo: string
  /** 归类（与主进程 BlockedReason 对齐；多一个 app-quit） */
  reason:
    | 'reload'
    | 'devtools'
    | 'view-source'
    | 'zoom'
    | 'caret-browsing'
    | 'fullscreen'
    | 'app-quit'
    | 'window-close'
}

export const RESERVED_SHORTCUTS: readonly ReservedShortcut[] = [
  { combo: 'Mod+R', reason: 'reload' },
  { combo: 'Mod+Shift+R', reason: 'reload' },
  { combo: 'F5', reason: 'reload' },
  { combo: 'Mod+F5', reason: 'reload' },
  { combo: 'F12', reason: 'devtools' },
  { combo: 'Mod+Shift+I', reason: 'devtools' },
  { combo: 'Mod+Shift+J', reason: 'devtools' },
  { combo: 'Mod+Shift+C', reason: 'devtools' },
  { combo: 'Mod+U', reason: 'view-source' },
  { combo: 'Mod+=', reason: 'zoom' },
  { combo: 'Mod++', reason: 'zoom' },
  { combo: 'Mod+-', reason: 'zoom' },
  { combo: 'Mod+0', reason: 'zoom' },
  { combo: 'F7', reason: 'caret-browsing' },
  { combo: 'F11', reason: 'fullscreen' },
  { combo: 'Mod+Q', reason: 'app-quit' },
  { combo: 'Mod+W', reason: 'window-close' },
  { combo: 'Alt+F4', reason: 'window-close' }
]

/** 保留表的规范化集合（`Mod` 按当前平台展开） */
const RESERVED_SPECS = (): Map<string, ReservedShortcut> => {
  const map = new Map<string, ReservedShortcut>()
  for (const r of RESERVED_SHORTCUTS) {
    const parsed = parseKeybinding(r.combo)
    if (parsed) map.set(parsed.spec, r)
  }
  return map
}

/** 单字符 = 打印字符（字母/数字/标点）；`F1`/`Tab`/`Escape` 不是 */
export function isPrintableKey(key: string): boolean {
  return key.length === 1
}

/**
 * 结构校验（语法 + 修饰键 + 保留键）。不查重复绑定 —— 重复是"相对其他命令"的，
 * 单独拆出来便于给替代键做"这个键本身合不合法"的检查。
 */
export function validateStructure(spec: string): KeymapValidationResult {
  const parsed = parseKeybinding(spec)
  if (!parsed) {
    return fail('syntax', String(spec ?? ''), 'keymap.errSyntax')
  }
  const hasPrimaryModifier = parsed.ctrl || parsed.meta || parsed.alt
  const key = parsed.key
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
  const isEscape = key === 'Escape'
  const isShiftTab = parsed.shift && !parsed.ctrl && !parsed.meta && !parsed.alt && key === 'Tab'

  /**
   * 打印字符必须带 Ctrl/Cmd/Alt（规则 1）。`Shift+F` 不能放行：它仍然会拦截输入。
   * 其余无名键（Tab / Enter / 方向键…）同样要求主修饰键（规则 2）——
   * 只放行明确列出的 F1–F24 / Escape / Shift+Tab。
   */
  if (!hasPrimaryModifier && !isFunctionKey && !isEscape && !isShiftTab) {
    return fail('modifier-required', parsed.spec, 'keymap.errModifierRequired')
  }

  const reserved = RESERVED_SPECS().get(parsed.spec)
  if (reserved) {
    return {
      ...fail('reserved', parsed.spec, 'keymap.errReserved'),
      reserved
    }
  }
  return {
    ok: true,
    code: 'ok',
    spec: parsed.spec,
    messageKey: '',
    conflictWith: [],
    suggestion: null
  }
}

function fail(
  code: Exclude<KeymapValidationCode, 'ok'>,
  spec: string,
  messageKey: string
): KeymapValidationResult {
  return {
    ok: false,
    code,
    spec,
    messageKey,
    conflictWith: [],
    suggestion: null
  }
}

/** 把规范化表达式转成可比较的键（解析失败返回 null） */
function canonical(spec: string | null): string | null {
  if (!spec) return null
  const parsed = parseKeybinding(spec)
  return parsed ? parsed.spec : null
}

/** 候选键是否已被其他命令占用（返回占用的 id 列表） */
export function conflictsWith(
  spec: string,
  bindings: readonly KeymapBindingLike[],
  selfId?: string
): string[] {
  const target = canonical(spec)
  if (!target) return []
  const out: string[] = []
  for (const b of bindings) {
    if (b.id === selfId) continue
    if (canonical(b.keys) === target) out.push(b.id)
  }
  return out
}

/** 在候选键的基础上找一个既合法又没被占用的替代键 */
function findSuggestion(
  parsed: Keybinding,
  bindings: readonly KeymapBindingLike[],
  selfId?: string
): string | null {
  const variants: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }[] = [
    { ctrl: parsed.ctrl, shift: true, alt: parsed.alt, meta: parsed.meta },
    { ctrl: parsed.ctrl, shift: parsed.shift, alt: true, meta: parsed.meta },
    { ctrl: true, shift: parsed.shift, alt: parsed.alt, meta: false },
    { ctrl: parsed.ctrl, shift: true, alt: true, meta: parsed.meta }
  ]
  const seen = new Set<string>([parsed.spec])
  for (const v of variants) {
    const spec = formatKeybinding({ ...v, key: parsed.key })
    if (spec === parsed.spec || seen.has(spec)) continue
    seen.add(spec)
    const structure = validateStructure(spec)
    if (!structure.ok) continue
    if (conflictsWith(spec, bindings, selfId).length) continue
    return spec
  }
  return null
}

/**
 * 用户输入/保存时的统一校验（规则 1–4）。
 * 返回的 `spec` 已规范化；录制器应把它写进 settings，而不是原始输入。
 */
export function validateKeybinding(
  input: string,
  options: KeymapValidationOptions = {}
): KeymapValidationResult {
  const structure = validateStructure(input)
  if (!structure.ok) return structure
  const bindings = options.bindings ?? []
  const occupied = conflictsWith(structure.spec, bindings, options.selfId)
  if (occupied.length) {
    const parsed = parseKeybinding(structure.spec)
    return {
      ...fail('conflict', structure.spec, 'keymap.errConflict'),
      conflictWith: occupied,
      suggestion: parsed ? findSuggestion(parsed, bindings, options.selfId) : null
    }
  }
  return structure
}

/** 可审计的命令（ResolvedCommand 的子集；`customized` = 用户覆盖过） */
export interface AuditableCommand {
  id: string
  keys: string | null
  customized: boolean
  titleKey?: string
}

/**
 * 历史数据审计：**只标记、不删除**。
 *
 * 启动时把设置里已存在的非法绑定（如 `f`）标成"无效"，UI 显示「无效 + 恢复默认」——
 * 静默删掉会让用户以为"我的设置丢了"，而且下次他还会再填一次同样的值。
 *
 * 默认键只查语法/修饰键（不查保留表）：`Mod+W`（关闭窗口）这类出厂键是产品决定，
 * 不能因为它在保留表里就把默认配置判红；用户**覆盖**过的值才走完整规则。
 */
export function auditKeybindings(
  commands: readonly AuditableCommand[]
): Record<string, KeymapValidationResult> {
  const bindings = commands.map((c) => ({ id: c.id, keys: c.keys, titleKey: c.titleKey }))
  const out: Record<string, KeymapValidationResult> = {}
  for (const cmd of commands) {
    if (!cmd.keys) continue
    const structure = validateStructure(cmd.keys)
    if (!structure.ok) {
      // 默认键遇到保留项不算错（见上面的口径）；其余错误照样标出来
      if (!cmd.customized && structure.code === 'reserved') continue
      out[cmd.id] = structure
      continue
    }
    const occupied = conflictsWith(cmd.keys, bindings, cmd.id)
    if (occupied.length) {
      out[cmd.id] = {
        ...fail('conflict', structure.spec, 'keymap.errConflict'),
        conflictWith: occupied
      }
    }
  }
  return out
}

/** 展示用：把一条失败结果落成短文案需要的参数（i18n 由调用方做） */
export function validationSuggestion(result: KeymapValidationResult): string | null {
  return result.suggestion
}
