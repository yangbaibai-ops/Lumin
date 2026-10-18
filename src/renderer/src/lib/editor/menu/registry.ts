import type {
  EditorMenuAction,
  EditorMenuContext,
  EditorMenuProvider,
  EditorMenuSection
} from './types'
import { createDefaultProviders } from './providers'

/**
 * ─── 提供者注册表 ────────────────────────────────────────────────────────────
 * 单一装配点：内置提供者 + 外部注册的提供者一起按 sortOrder 排序，拼装出
 * 「顶部横向常用行 + 下方列表分区」的最终结构。
 *
 * 外部扩展用「工厂」注册（而不是直接注册提供者实例）：提供者内部要按 id 取动作，
 * 而动作闭包绑定了具体的编辑器实例，工厂在每次构建时拿到当次的动作表，
 * 因此切换文档/重建编辑器后不会残留指向旧实例的闭包。
 *
 *   registerEditorMenuProvider((actions) => ({
 *     id: 'math', when: (ctx) => ctx.inMath, build: () => [ ... ]
 *   }))
 */
type ProviderFactory = (actions: Record<string, EditorMenuAction>) => EditorMenuProvider

const externalFactories: ProviderFactory[] = []

export function registerEditorMenuProvider(factory: ProviderFactory): void {
  externalFactories.push(factory)
}

/** 组装菜单结构：顶部工具栏分区 → 其余分区（顺序完全由静态定义决定） */
export function buildEditorMenuSections(
  ctx: EditorMenuContext,
  actions: Record<string, EditorMenuAction>
): EditorMenuSection[] {
  const providers = [
    ...createDefaultProviders(actions),
    ...externalFactories.map((f) => f(actions))
  ]
  return providers
    .filter((p) => p.when(ctx))
    .sort((a, b) => (a.sortOrder ?? 50) - (b.sortOrder ?? 50))
    .flatMap((p) => p.build(ctx))
    .filter((s) => s.items.length > 0)
}
