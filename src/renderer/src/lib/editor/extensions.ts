// ─── 编辑器扩展集组装（Tiptap v3）─────────────────────────────────────────
// 依据开发文档选型：StarterKit + Table + TaskList + Markdown(双向转换) +
// CodeMirror 代码块 NodeView + 光标感知标记符 Plugin + 附加 InputRules。
import StarterKit from '@tiptap/starter-kit'
import { HorizontalRule } from '@tiptap/extension-horizontal-rule'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import { Markdown } from 'tiptap-markdown'
import { TyporaMarkers } from './markers'
import { TyporaInputRules } from './inputRules'
import { TyporaKeymap } from './keymap'
import { CodeBlockCM } from './codeBlock'

/** 相对路径图片 → lumin-file:// 本地协议（dev/prod 通用，符合 CSP） */
function resolveLocalImageSrc(src: string): string {
  if (/^(https?|data|file|lumin-file):/i.test(src)) return src
  // 无文档目录上下文时保持原样（http 场景由浏览器解析）
  return src
}

export const editorExtensions = [
  StarterKit.configure({
    // 代码块由 CodeMirror NodeView 接管（开发文档步骤 3）
    codeBlock: false,
    // 分割线即时输入规则关闭：改为 '---'/'***' + Enter 确认（TyporaKeymap），
    // 以便正常输入 "---你好" 这类文本（Typora 同款行为）
    horizontalRule: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https'
    }
  }),
  // 独立注册 horizontalRule 节点（仅节点与渲染，输入规则置空）
  HorizontalRule.extend({
    addInputRules() {
      return []
    }
  }),
  Image.configure({
    inline: false,
    allowBase64: true
  }).extend({
    renderHTML({ HTMLAttributes }) {
      const src = resolveLocalImageSrc(String(HTMLAttributes.src ?? ''))
      return ['img', { ...HTMLAttributes, src, loading: 'lazy' }]
    }
  }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({
    placeholder: '在此开始写作…（输入 # 创建标题）'
  }),
  CodeBlockCM,
  TyporaInputRules,
  Markdown.configure({
    html: true,
    breaks: true,
    tightLists: true,
    bulletListMarker: '-',
    linkify: true,
    transformPastedText: true,
    transformCopiedText: true
  }),
  TyporaMarkers,
  // 键盘语义（分割线回车确认 / 标题行首退格降级）：priority 200，
  // 先于 core keymap 执行；置于末尾保证在同等优先级中注册最晚（最先执行）
  TyporaKeymap
]
