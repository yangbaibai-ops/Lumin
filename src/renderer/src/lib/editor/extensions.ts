// ─── 编辑器扩展集组装（Tiptap v3）─────────────────────────────────────────
// 依据开发文档选型：StarterKit + Table + TaskList + Markdown(双向转换) +
// CodeMirror 代码块 NodeView + 光标感知标记符 Plugin + 附加 InputRules。
import StarterKit from '@tiptap/starter-kit'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Code from '@tiptap/extension-code'
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
import { MarkdownPaste } from './markdownPaste'
import { TyporaInlineMarks, MdStyle, MdMarker } from './typoraInlineMarks'
import { TyporaPointer, LinkSource } from './pointer'

// 行内样式 mark：保留节点类型（解析粘贴/加载内容需要），但输入规则与
// 快捷键关闭——真实文本标记模型下，'**加粗**' 由派生归一化即时成样式，
// 核心输入规则会删掉用户手打的标记文本，与模型冲突
const BoldQuiet = Bold.extend({ addInputRules: () => [], addKeyboardShortcuts: () => ({}) })
const ItalicQuiet = Italic.extend({ addInputRules: () => [], addKeyboardShortcuts: () => ({}) })
const StrikeQuiet = Strike.extend({ addInputRules: () => [], addKeyboardShortcuts: () => ({}) })
const CodeQuiet = Code.extend({ addInputRules: () => [], addKeyboardShortcuts: () => ({}) })

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
    // 行内样式 mark 由外部注册的「安静版」提供（无输入规则/快捷键，
    // 见上），这里关闭 StarterKit 内置版本
    bold: false,
    italic: false,
    strike: false,
    code: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https'
    }
  }),
  // 安静版 mark（仅节点类型 + 渲染，供解析与派生归一化使用）
  BoldQuiet,
  ItalicQuiet,
  StrikeQuiet,
  CodeQuiet,
  // 真实文本标记模型：mdStyle（样式正文）+ mdMarker（语法标记文本）+ 派生归一化
  MdStyle,
  MdMarker,
  TyporaInlineMarks,
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
  // 粘贴修复：先注册 MarkdownPaste 接管 clipboardTextParser（someProp 取
  // 首个非 null），Markdown 自带的 inline-only 解析器被禁用
  MarkdownPaste,
  Markdown.configure({
    html: true,
    breaks: true,
    tightLists: true,
    bulletListMarker: '-',
    linkify: true,
    transformPastedText: false,
    transformCopiedText: true
  }),
  TyporaMarkers,
  // 链接源码展开标记（普通点击链接时承载 [文字](网址)，序列化原样输出）
  LinkSource,
  // 鼠标语义：Ctrl/Cmd+左键退化为普通点击（PM 内置会整选段落/节点，Typora 无此逻辑）；
  // 链接：普通左键原地展开源码、Ctrl/Cmd+左键用系统浏览器打开（§4.14/§4.15）
  TyporaPointer,
  // 键盘语义（分割线回车确认 / 标题行首退格降级）：priority 200，
  // 先于 core keymap 执行；置于末尾保证在同等优先级中注册最晚（最先执行）
  TyporaKeymap
]
