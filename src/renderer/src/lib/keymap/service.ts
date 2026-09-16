import { parseKeybinding, matchesEvent, eventToSpec, normalizeSpec, type Keybinding } from './keys'

/**
 * ─── 命令 + 快捷键（keybinding）服务 ───────────────────────────────────────
 * 架构（与 VS Code / Atom 同一套思路，只是规模小得多）：
 *
 *   命令注册表（CommandRegistry）  ← 一处声明：id + i18n 标题 + 默认键 + 动作
 *            │
 *            ├── 默认键（代码里的 defaultKeys）
 *            └── 用户覆盖（settings.keybindings，SQLite 持久化，null = 明确解绑）
 *            ↓  解析（用户覆盖优先）
 *   一个全局 keydown 监听（捕获阶段） → 命中即 preventDefault + 执行命令
 *            ↓
 *   设置界面：列出全部命令 / 录制新键 / 冲突提示 / 单条与整体恢复默认
 *
 * 扩展方式：加一条命令 = 往命令表里加一项，设置界面与默认键自动生效；
 * 想换默认键 = 改 `defaultKeys`，用户已自定义过的不受影响（覆盖优先）。
 */

export interface KeymapCommand {
  /** 稳定 id（持久化用，不要改名） */
  id: string
  /** 标题 i18n 键（与菜单共用同一批键，保证文案一致） */
  titleKey: string
  /** 分组 i18n 键（文件 / 编辑 / 视图 / 窗口 / 帮助） */
  groupKey: string
  /** 默认键；null = 默认不绑定 */
  defaultKeys: string | null
  /**
   * 触发条件：
   *  - 'always'（默认）：任何焦点下都可触发；
   *  - 'notInInput'：焦点在输入框/文本域/可编辑区时不触发（避免抢输入）。
   */
  when?: 'always' | 'notInInput'
  run: () => void | Promise<void>
}

export interface ResolvedCommand extends KeymapCommand {
  /** 解析后的生效键（已规范化）；null = 未绑定 */
  keys: string | null
  /** 该键同时还被哪些命令占用（id 列表，含自己时长度 > 1 才是冲突） */
  conflictWith: string[]
  /** 是否被用户自定义过（设置界面用来显示「已修改」与「恢复默认」） */
  customized: boolean
}

export interface KeymapHandle {
  /** 当前全部命令的解析结果（设置界面据此渲染） */
  resolved: () => ResolvedCommand[]
  /** 按 id 查一条 */
  get: (id: string) => ResolvedCommand | undefined
  /** 生效键是否来自用户覆盖 */
  isCustomized: (id: string) => boolean
  /** 读取用户覆盖表（写库由调用方负责） */
  overrides: () => Record<string, string | null>
  dispose: () => void
}

/** 录制态：设置界面录制快捷键时置位，服务整体让行（否则录 Ctrl+N 会真的新建文档） */
let recording = false
export function setKeymapRecording(on: boolean): void {
  recording = on
}
export function isKeymapRecording(): boolean {
  return recording
}

/** 用户覆盖表：命令 id → 表达式（null = 明确解绑）；由 settings store 提供 */
export type KeybindingOverrides = Record<string, string | null>

/** 当前安装的服务（设置界面读取解析结果用） */
let current: KeymapHandle | null = null

/**
 * 文档自己的编辑面（源码 textarea / 渲染面 ProseMirror / 代码块里的 CodeMirror）。
 *
 * 它们虽然也是 input/contenteditable，但语义上**就是文档本身**：应用级快捷键
 * （Ctrl+F 查找、Ctrl+S 保存…）在这里必须照常生效。把它们当「表单输入框」挡掉，
 * 结果就是「源码模式下按 Ctrl+F 没反应」——用户会以为功能坏了（实测踩到）。
 */
function isDocumentSurface(el: HTMLElement): boolean {
  if (el.classList.contains('source-editor')) return true
  return typeof el.closest === 'function' && !!el.closest('.ProseMirror, .md-preview')
}

function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (isDocumentSurface(el)) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true
}

/** 解析一条命令的生效键：用户覆盖（含解绑）优先于默认键 */
function resolveKeys(cmd: KeymapCommand, overrides: KeybindingOverrides): string | null {
  const has = Object.prototype.hasOwnProperty.call(overrides, cmd.id)
  if (has) {
    const v = overrides[cmd.id]
    return v == null ? null : normalizeSpec(v)
  }
  return normalizeSpec(cmd.defaultKeys)
}

/** 计算全部命令的解析结果（含冲突信息） */
export function resolveCommands(
  commands: KeymapCommand[],
  overrides: KeybindingOverrides
): ResolvedCommand[] {
  const resolved = commands.map((cmd) => {
    const keys = resolveKeys(cmd, overrides)
    return {
      ...cmd,
      keys,
      conflictWith: [] as string[],
      customized: Object.prototype.hasOwnProperty.call(overrides, cmd.id)
    }
  })
  // 冲突：同一个生效键被多条命令占用
  const byKey = new Map<string, ResolvedCommand[]>()
  for (const r of resolved) {
    if (!r.keys) continue
    const list = byKey.get(r.keys) ?? []
    list.push(r)
    byKey.set(r.keys, list)
  }
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    for (const r of list) r.conflictWith = list.filter((x) => x !== r).map((x) => x.id)
  }
  return resolved
}

/**
 * 命中的命令：
 *  1) **用户自定义过的绑定优先于默认绑定**（用户显式设置的就是他想要的）；
 *  2) 同一档里按命令表**从后往前**取（后注册者覆盖先注册者，与 VS Code「later wins」一致），
 *     这样扩展时把新命令追加在末尾即可覆写旧默认。
 * 返回命中的命令与对应表达式。
 */
function findMatch(
  e: KeyboardEvent,
  resolved: ResolvedCommand[]
): { cmd: ResolvedCommand; binding: Keybinding } | null {
  const custom: { cmd: ResolvedCommand; binding: Keybinding }[] = []
  const def: { cmd: ResolvedCommand; binding: Keybinding }[] = []
  for (const r of resolved) {
    if (!r.keys) continue
    if (r.when === 'notInInput' && isTextEntry(e.target)) continue
    const binding = parseKeybinding(r.keys)
    if (!binding || !matchesEvent(e, binding)) continue
    ;(r.customized ? custom : def).push({ cmd: r, binding })
  }
  const pool = custom.length ? custom : def
  return pool.length ? pool[pool.length - 1] : null
}

/**
 * 安装服务：注册全局 keydown（捕获阶段，先于编辑器/菜单处理）。
 * 返回句柄；重复安装会先卸载上一份（HMR 友好）。
 */
export function installKeymap(
  commands: KeymapCommand[],
  getOverrides: () => KeybindingOverrides
): KeymapHandle {
  current?.dispose()
  const handler = (e: KeyboardEvent): void => {
    // 录制中（设置界面正在采集按键）→ 整体让行，交给录制器
    if (recording || e.defaultPrevented || e.isComposing) return
    // 只处理带修饰键的组合（纯字母键留给编辑器/输入框）
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return
    const hit = findMatch(e, resolveCommands(commands, getOverrides()))
    if (!hit) return
    e.preventDefault()
    e.stopPropagation()
    try {
      void hit.cmd.run()
    } catch {
      /* 命令内部自行提示错误 */
    }
  }
  window.addEventListener('keydown', handler, true)
  const handle: KeymapHandle = {
    resolved: () => resolveCommands(commands, getOverrides()),
    get: (id) => resolveCommands(commands, getOverrides()).find((r) => r.id === id),
    isCustomized: (id) => Object.prototype.hasOwnProperty.call(getOverrides(), id),
    overrides: () => ({ ...getOverrides() }),
    dispose: () => {
      window.removeEventListener('keydown', handler, true)
      if (current === handle) current = null
    }
  }
  current = handle
  return handle
}

/** 当前安装的服务（设置界面读取解析结果用；未安装时返回 null） */
export function currentKeymap(): KeymapHandle | null {
  return current
}

export { eventToSpec, normalizeSpec, parseKeybinding }
