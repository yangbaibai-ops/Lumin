import { computed } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { currentKeymap } from './service'

/**
 * ─── 可见快捷键文案的唯一来源：命令注册表（`lib/keymap`）─────────────────────
 *
 * 背景（审计 P2「改绑后 tooltip/右键菜单仍写死旧键」）：设置页改绑后立刻生效，
 * 但工具栏 tooltip、文件树搜索框、编辑器右键菜单都各自写死了 `Ctrl+...` ——
 * 用户改完看到的仍是旧键。根因不是"忘了更新某一处"，而是这些位置**有第二份键位真相**。
 *
 * 这个 composable 只做一件事：给定命令 id，返回**当前生效**的规范化键位
 * （用户覆盖优先，默认键兜底；null = 未绑定）。调用方只负责拼进 title/菜单项。
 *
 * 响应性：`currentKeymap()` 本身不是响应式的，所以这里读一次
 * `settings.keybindings` 的 ownKeys + 值（与 service.ts 的 `resolveKeys` 同源）。
 * `Object.keys` 走 Proxy 的 ownKeys 陷阱 —— 新增/删除一条覆盖也会触发重算；
 * 只读 `hasOwnProperty` 或只读已知键会漏掉「第一次改绑」（见 service.ts 的注释）。
 */
export function useShortcutLabel(): (commandId: string | null | undefined) => string | null {
  const settings = useSettingsStore()
  const revision = computed(() => {
    const map = settings.keybindings ?? {}
    return Object.keys(map)
      .sort()
      .map((id) => `${id}=${map[id] ?? ''}`)
      .join('|')
  })
  return (commandId) => {
    // 读一下 revision：把「键位表变了」变成这次渲染的依赖
    void revision.value
    if (!commandId) return null
    return currentKeymap()?.get(commandId)?.keys ?? null
  }
}
