// ─── 右键「AI」子菜单：预设清单 + prompt 组装（纯函数，主/渲染/单测共用）─────────
//
// 为什么要单独一层：
//   * 右键菜单的五个 AI 动作（优化 / 续写 / 美化 / 理解 / 总结）在**菜单**里只认
//     「id + 文案 + 图标」，真正发出去的 prompt 必须只有一份拼装规则 —— 否则菜单、
//     快捷键、以后可能的命令面板各拼一套，模型收到的指令迟早分叉；
//   * 这一层**不碰编辑器、不碰网络、不碰 Vue**：单测直接跑
//     `tests/aiMenu.test.mjs`，能逐字断言"点优化时请求里带的是哪句指令 + 哪段正文"。
//
// 用户口径：点击后**自动填入并发送**（不是只预填）。理由：右键是一步到位的动作，
// 用户已经在菜单里选了"优化"，再让他去右侧栏按一次「发送」是多余的一步；
// 结果仍然由用户决定「插入到文档 / 替换选区」，文档在点按钮之前一个字节都不动。
import type { AiMenuKind } from './ai'

export interface AiMenuPreset {
  /** 稳定动作 id 后缀（右键菜单动作 id = `ai.${kind}`） */
  kind: AiMenuKind
  /** 菜单项文案（三语） */
  labelKey: string
  /** 发给模型的固定指令（三语；正文由 buildAiMenuPrompt 追加） */
  instructionKey: string
  /** 展示用快捷键；只有**真的注册在命令表里**的才填（避免假提示） */
  shortcut?: string
  /** 菜单图标（见 components/Icon.vue） */
  icon: string
}

/**
 * 五个预设。顺序就是子菜单里的顺序：
 *   优化（改写得更清晰）→ 续写（接着写）→ 美化（润色文风）→
 *   理解（解释选中内容）→ 总结（概括）。
 *
 * 快捷键只给「优化」挂了一枚真实注册的 `Ctrl+Alt+O`（见 composables/useKeymap.ts）；
 * 其余四项不挂：`Ctrl+Alt+K` 已被「插入链接」（Mod+Alt+K）占用，`Ctrl+Alt+S/R/C`
 * 分别属于既有的摘要 / 改写 / 对话面板，不能在这里重复声明（同一键两条命令会互相抢）。
 */
export const AI_MENU_PRESETS: readonly AiMenuPreset[] = [
  {
    kind: 'optimize',
    labelKey: 'editorMenu.aiOptimize',
    instructionKey: 'editorMenu.aiPrompt.optimize',
    shortcut: 'Ctrl+Alt+O',
    icon: 'sparkles'
  },
  {
    kind: 'continue',
    labelKey: 'editorMenu.aiContinue',
    instructionKey: 'editorMenu.aiPrompt.continue',
    icon: 'sparkles'
  },
  {
    kind: 'polish',
    labelKey: 'editorMenu.aiPolish',
    instructionKey: 'editorMenu.aiPrompt.polish',
    icon: 'sparkles'
  },
  {
    kind: 'explain',
    labelKey: 'editorMenu.aiExplain',
    instructionKey: 'editorMenu.aiPrompt.explain',
    icon: 'sparkles'
  },
  {
    kind: 'summarize',
    labelKey: 'editorMenu.aiSummarize',
    instructionKey: 'editorMenu.aiPrompt.summarize',
    icon: 'sparkles'
  }
] as const

/** 按 kind 取预设；未知 kind 返回 null（调用方如实失败，不静默发一条空指令） */
export function aiMenuPreset(kind: string): AiMenuPreset | null {
  return AI_MENU_PRESETS.find((p) => p.kind === kind) ?? null
}

/**
 * 动作表里的形状（与 `lib/editor/menu/types.ts` 的 EditorMenuAction 结构兼容）。
 * 定义在这一层是为了单测能直接验证"五项 id / 文案 / 快捷键 / 回调 kind"，
 * 而不必把整个编辑器 store 依赖链拉进 `node --test`。
 */
/** 取文结果：正文 + 来源区间（替换时用）+ 来源层级 */
export interface AiMenuSource {
  text: string
  from: number
  to: number
  kind: 'selection' | 'paragraph' | 'document'
}

export interface AiMenuSourceInput {
  selectionText: string
  selectionRange: { from: number; to: number } | null
  paragraphText: string
  paragraphRange: { from: number; to: number }
  documentText: string
}

/**
 * 右键 AI 的取文口径（用户口径）：**选区 → 当前段落 → 全文**。
 * 三级都为空时返回全文（可能是空串，由调用方提示"没有可处理的内容"）。
 */
export function pickAiMenuSource(input: AiMenuSourceInput): AiMenuSource {
  if (input.selectionRange && input.selectionText.trim()) {
    return {
      text: input.selectionText.trim(),
      from: input.selectionRange.from,
      to: input.selectionRange.to,
      kind: 'selection'
    }
  }
  if (input.paragraphText.trim()) {
    return {
      text: input.paragraphText.trim(),
      from: input.paragraphRange.from,
      to: input.paragraphRange.to,
      kind: 'paragraph'
    }
  }
  return { text: input.documentText.trim(), from: 0, to: 0, kind: 'document' }
}

export interface AiMenuActionDefinition {
  id: string
  labelKey: string
  icon: string
  shortcut?: string
  run: () => boolean | Promise<boolean>
}

/** 由五个预设派生右键菜单动作；`runAi` 缺失时如实返回 false（不静默成功） */
export function buildAiMenuActions(
  runAi?: (kind: AiMenuKind) => boolean | Promise<boolean>
): Record<string, AiMenuActionDefinition> {
  return Object.fromEntries(
    AI_MENU_PRESETS.map((preset) => [
      `ai.${preset.kind}`,
      {
        id: `ai.${preset.kind}`,
        labelKey: preset.labelKey,
        icon: preset.icon,
        shortcut: preset.shortcut,
        run: () => (runAi ? runAi(preset.kind) : false)
      }
    ])
  )
}

/**
 * 组装发给模型的这一轮问题：**固定指令 + 空行 + 正文**。
 *
 * `translate` 由渲染层的 i18n 提供（这一层不 import i18n）；空正文返回空串，
 * 调用方据此提示"没有可处理的内容"，而不是把一条只有指令的请求发出去。
 */
export function buildAiMenuPrompt(
  kind: AiMenuKind,
  text: string,
  translate: (key: string) => string
): string {
  const preset = aiMenuPreset(kind)
  if (!preset) return ''
  const body = String(text ?? '').trim()
  if (!body) return ''
  return `${translate(preset.instructionKey)}\n\n${body}`
}
