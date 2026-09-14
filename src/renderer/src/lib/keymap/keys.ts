// ─── 快捷键「按键表达式」的解析 / 格式化 / 匹配 ──────────────────────────────
// 表达式沿用业界通用写法（VS Code / Electron accelerator 都长这样）：
//   `Ctrl+Shift+P`、`Mod+S`、`Alt+F4`、`F12`、`Escape`、`,`（Mod+, 打开设置）
// 其中 `Mod` = 当前平台的主修饰键（Windows/Linux = Ctrl，macOS = Cmd），
// 因此默认值写 `Mod+...` 就能跨平台；用户设置里两种写法都接受。

export interface Keybinding {
  /** 规范化后的表达式，用于持久化与比较，如 `Ctrl+Shift+P` */
  spec: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** 规范化后的主键，如 `P` / `Tab` / `F12` / `,` */
  key: string
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** 修饰键别名 → 统一名 */
const MOD_ALIASES: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta' | 'mod'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmdorctrl: 'mod',
  commandorcontrol: 'mod',
  mod: 'mod',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  windows: 'meta'
}

/** 主键别名 → 规范化名（其余按键：单字符转大写、F1~F24、其余按原样） */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  plus: '+'
}

function normalizeKey(raw: string): string {
  const k = raw.trim()
  if (!k) return ''
  const alias = KEY_ALIASES[k.toLowerCase()]
  if (alias) return alias
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase()
  if (k.length === 1) return k.toUpperCase()
  // 多字符且没别名（如 `MediaPlayPause`）→ 首字母大写形式
  return k.charAt(0).toUpperCase() + k.slice(1)
}

/** 主键是否为「打印字符」（用于格式化与录制判断） */
function isPrintable(key: string): boolean {
  return key.length === 1
}

/**
 * 解析表达式。允许 `Mod`（平台主修饰键）与 `Ctrl`。无主键 / 有多余片段 → null。
 * 例：`Mod+Shift+P` → { ctrl: true, shift: true, key: 'P' }
 */
export function parseKeybinding(input: string): Keybinding | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const parts = raw.split('+').map((p) => p.trim())
  // `Mod++`（加号键）这种写法拆分后会多出空片段，这里先把空片段收掉但保留最后一个 '+'
  const cleaned: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i > 0 && i < parts.length - 1) cleaned.push('+')
    else if (parts[i] !== '') cleaned.push(parts[i])
  }
  let ctrl = false
  let shift = false
  let alt = false
  let meta = false
  let key = ''
  for (let i = 0; i < cleaned.length; i++) {
    const p = cleaned[i]
    const mod = MOD_ALIASES[p.toLowerCase()]
    const isLast = i === cleaned.length - 1
    if (mod && !isLast) {
      if (mod === 'mod') {
        if (IS_MAC) meta = true
        else ctrl = true
      } else if (mod === 'ctrl') ctrl = true
      else if (mod === 'shift') shift = true
      else if (mod === 'alt') alt = true
      else meta = true
      continue
    }
    if (key) return null // 已经有一个主键了 → 非法
    key = normalizeKey(p)
  }
  if (!key) return null
  return {
    spec: formatKeybinding({ spec: '', ctrl, shift, alt, meta, key }),
    ctrl,
    shift,
    alt,
    meta,
    key
  }
}

/** 规范化表达式的展示形式：`Ctrl+Shift+P`（修饰键顺序固定 Ctrl→Shift→Alt→Meta） */
export function formatKeybinding(b: Omit<Keybinding, 'spec'> & { spec?: string }): string {
  const out: string[] = []
  if (b.ctrl) out.push('Ctrl')
  if (b.shift) out.push('Shift')
  if (b.alt) out.push('Alt')
  if (b.meta) out.push(IS_MAC ? 'Cmd' : 'Win')
  out.push(b.key === 'Space' ? 'Space' : b.key)
  return out.join('+')
}

/** 规范化用户/默认表达式；非法返回 null */
export function normalizeSpec(input: string | null | undefined): string | null {
  if (input == null) return null
  const parsed = parseKeybinding(input)
  return parsed ? parsed.spec : null
}

/** 键盘事件 → 表达式（录制用）。只按修饰键返回 null；Esc 交给调用方处理，不录制 */
export function eventToSpec(e: KeyboardEvent): string | null {
  const key = eventKeyName(e)
  if (!key) return null
  if (key === 'Escape') return null
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null
  return formatKeybinding({
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
    key
  })
}

/** 从事件里取规范化主键名（字母统一大写；空格/方向键等走别名表） */
export function eventKeyName(e: KeyboardEvent): string {
  const k = e.key
  if (!k) return ''
  if (k === ' ' || k === 'Spacebar') return 'Space'
  return normalizeKey(k)
}

/**
 * 事件是否命中该表达式：修饰键**完全一致**（Ctrl+P 不会命中 Ctrl+Shift+P）。
 * 只比较修饰键与主键，不比较 `location`（左右 Ctrl 视作同一个键）。
 */
export function matchesEvent(e: KeyboardEvent, binding: Keybinding): boolean {
  if (e.ctrlKey !== binding.ctrl) return false
  if (e.shiftKey !== binding.shift) return false
  if (e.altKey !== binding.alt) return false
  if (e.metaKey !== binding.meta) return false
  return eventKeyName(e) === binding.key
}

/** 展示用：把表达式拆成一个个按键块（设置界面里逐块渲染成 <kbd>） */
export function specToChips(spec: string | null): string[] {
  if (!spec) return []
  return spec.split('+').filter(Boolean)
}

export { IS_MAC, isPrintable }
