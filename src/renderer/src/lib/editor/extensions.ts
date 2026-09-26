// ─── 编辑器扩展集组装（Tiptap v3）─────────────────────────────────────────
// 依据开发文档选型：StarterKit + Table + TaskList + Markdown(双向转换) +
// CodeMirror 代码块 NodeView + 光标感知标记符 Plugin + 附加 InputRules。
import StarterKit from '@tiptap/starter-kit'
import type { Extensions } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Code from '@tiptap/extension-code'
import { HorizontalRule } from '@tiptap/extension-horizontal-rule'
import { TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import { TableFidelity } from './tableMarkdown'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { imageSrcForDoc } from '../imageSrc'
import { needsRemotePermission } from '../remoteImages'
import type { RemoteImagePolicy } from '../remoteImages'
import i18n from '../../i18n'
import Image from '@tiptap/extension-image'
import { Markdown } from 'tiptap-markdown'
import { TyporaMarkers } from './markers'
import { TyporaInputRules } from './inputRules'
import { TyporaKeymap } from './keymap'
import { ImagePaste } from './imagePaste'
import { CodeBlockCM } from './codeBlock'
import { MarkdownPaste } from './markdownPaste'
import { TyporaInlineMarks, MdStyle, MdMarker, MdCodeLiteral, MdEscape } from './typoraInlineMarks'
import { Frontmatter } from './frontmatter'
import { HtmlBlock, MdHtml } from './htmlPassthrough'
import { FootnoteDef, MdFootnote } from './footnotePassthrough'
import { MathBlock, MdMath } from './mathMarkers'
import { MathPreview } from './mathPreview'
import { BulletListMarked, TaskListTight } from './listMarkers'
import { MarkdownParseLimits } from './parseLimits'
// CJK 强调定界符口径：`**「…」**` 这类中文写法必须能成对（见 cjkEmphasis.ts）
import { CjkEmphasis } from './cjkEmphasis'
import { TyporaPointer, LinkSource } from './pointer'
import { TableOfContents } from './tableOfContents'

// 行内样式 mark：保留节点类型（解析粘贴/加载内容需要），但输入规则、**粘贴规则**
// 与快捷键一律关闭——真实文本标记模型下，'**加粗**' 由派生归一化即时成样式，
// 核心输入规则会删掉用户手打的标记文本，与模型冲突。
//
// 粘贴规则（`addPasteRules`）是同一类缺陷的另一半，实测（本轮）：
// 剪贴板里是 `**2****2**` 时，markdown 粘贴解析产物是「一个 legacy bold 文本节点
// `2****2`」，紧接着 tiptap 的 bold 粘贴规则在 appendTransaction 里又把这批定界符
// **当语法消费掉**——落盘变成 `**2**2**`（**凭空少两个字符**）。它与输入规则同一个
// 理由：本模型的样式由**标记文本**派生，任何「把 `**` 吃掉换成 mark」的自动化都会
// 删掉用户的字符。粘贴内容的 Markdown 语义由 markdownPaste/clipboardTextParser +
// 派生归一化负责，不需要这层规则。
const QuietMark = {
  addInputRules: () => [],
  addPasteRules: () => [],
  addKeyboardShortcuts: () => ({})
}
const BoldQuiet = Bold.extend(QuietMark)
const ItalicQuiet = Italic.extend(QuietMark)
const StrikeQuiet = Strike.extend(QuietMark)
const CodeQuiet = Code.extend({
  ...QuietMark,
  // `excludes: '_'`（上游默认）会让行内代码**排斥其它所有 mark** —— 于是
  // `**粗体里的 `行内代码`**` 解析时那段代码上的粗体被丢掉，嵌套样式一开始就少一半。
  // 本模型里样式是「集合」（mdStyle.styles），行内代码当然可以同时在粗体里，
  // 所以放开互斥；换行/代码块那套「逐字」语义与 mark 互斥无关。
  excludes: ''
})

/**
 * 当前文档所在目录的提供者：图片相对路径要靠它解析（见 lib/imageSrc.ts）。
 * 宿主（TyporaEditor）注入；默认返回 null = 不解析（原样输出，与旧行为一致）。
 * 用「读的时候现取」而不是快照：切换文档后编辑器按 :key 重建，取值时机天然正确。
 */
let documentDirProvider: () => string | null = () => null

/**
 * 远程图片加载策略的提供者（自查报告 H2）：宿主注入 settings 里的 `remoteImages`；
 * 默认 `'click'` = 不自动加载远程图（隐私优先，与 Typora / VS Code 同口径）。
 * 同样是「读的时候现取」：用户在设置里改了开关，下一帧渲染就生效，不用重建编辑器。
 */
let remoteImageProvider: () => RemoteImagePolicy = () => 'click'

/** 编辑器扩展集组装入参（宿主可注入的少量应用级行为） */
export interface EditorExtensionOptions {
  /** Ctrl/Cmd+左键点链接时的打开逻辑（默认交系统默认浏览器） */
  onOpenLink?: (href: string) => void
  /** 当前文档所在目录（图片相对路径的解析基准）；返回 null = 不解析 */
  getDocumentDir?: () => string | null
  /** 远程图片加载策略（`click` 默认 / `always`）；见 lib/remoteImages.ts */
  getRemoteImagePolicy?: () => RemoteImagePolicy
}

/** 默认链接打开：只把网址交给系统默认浏览器（应用内由 lib/linkOpen.ts 覆盖） */
function defaultOpenLink(href: string): void {
  if (typeof window !== 'undefined' && window.luminAPI?.shell?.openExternal) {
    window.luminAPI.shell.openExternal(href)
  }
}

/**
 * 下划线基准扩展集：固定数组保持原样（顺序即注册顺序，优先级语义见文件末尾注释）。
 * 需要注入应用级行为时用下面的 buildEditorExtensions()，避免把 store/应用模块
 * 拖进编辑器内核。
 */
export const editorExtensions: Extensions = [
  StarterKit.configure({
    // 代码块由 CodeMirror NodeView 接管（开发文档步骤 3）
    codeBlock: false,
    // 无序列表用「保留源码标记」的版本（见 listMarkers.ts），这里关掉内置的
    bulletList: false,
    // 分割线即时输入规则关闭：改为 '---'/'***' + Enter 确认（TyporaKeymap），
    // 以便正常输入 "---你好" 这类文本（Typora 同款行为）
    horizontalRule: false,
    // 行内样式 mark 由外部注册的「安静版」提供（无输入规则/快捷键，
    // 见上），这里关闭 StarterKit 内置版本
    bold: false,
    italic: false,
    strike: false,
    code: false,
    // 下划线：第二十五轮**显式关闭**。它此前靠 StarterKit 默认注册而存在，但 Markdown
    // 没有下划线语法 —— 落盘是裸 HTML `<u>`，重开即退化成字面文本（屏幕上就是
    // `<u>abc</u>` 这几个字符），与 `**` 嵌套还会丢掉下划线（数据损坏类缺陷）。
    // 关掉后 `Ctrl+U` 不再被它吞掉，工具栏与右键菜单里的入口也已一并移除。
    // 将来若要恢复，正确做法是做成一等 mark（`escape:false`，同 MdHtml），而不是重开它。
    underline: false,
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
  // mdCodeLiteral 必须紧跟 mdStyle 之后注册（见该 mark 的说明：最内层 mark 才有 noEsc 效果）
  MdStyle,
  MdCodeLiteral,
  MdMarker,
  // 反斜杠转义（`\*` 原样往返）：放在最后 —— escape:false 只对「最内层 mark」生效
  MdEscape,
  // 行内 HTML 原文（`<kbd>`/`<br>`/注释）：同样靠 escape:false 逐字写回
  MdHtml,
  // 数学公式原文（`$…$`）：靠 escape:false 逐字写回；渲染由 MathPreview 的装饰负责
  MdMath,
  TyporaInlineMarks,
  // 独立注册 horizontalRule 节点（仅节点与渲染，输入规则置空）
  HorizontalRule.extend({
    addInputRules() {
      return []
    }
  }),
  Image.configure({
    // **行内节点**（本轮从块级改过来）：Markdown 的 `![alt](src)` 本来就是**行内**语法 ——
    // 它可以出现在段落中间（`图标 ![](a.png) 后面还有字`），也可以被链接包住
    // （`[![alt](a.png)](url)`）。做成块级节点时这两种写法都表达不出来：
    // 段落被拆成「文字 / 图片 / 文字」三段，外层链接因为块节点挂不了 mark 而整个丢掉。
    // 改成行内后，图片就是段落里的一个 inline 节点，两种写法都自然成立；
    // 「独立成段的图片」由 CSS 负责仍按块级显示（见 style.css 的 `p > img:only-child`），
    // 序列化仍然逐字节一致（段落里只有一个图片 → `![alt](src)` 一行）。
    inline: true,
    allowBase64: true
  }).extend({
    renderHTML({ HTMLAttributes }) {
      const src = imageSrcForDoc(String(HTMLAttributes.src ?? ''), documentDirProvider())
      // 远程图片默认**不加载**（隐私，见 lib/remoteImages.ts）：换成带 `data-src` 的占位元素，
      // 没有 `src` 属性浏览器就不会发请求。点击占位 → 放行并在 DOM 里就地换成真图。
      // 导出 / getHTML() 期间由 beginExportRender() 放行，导出的文档里图片照旧齐全。
      if (needsRemotePermission(src, remoteImageProvider())) {
        // 占位元素上不能带 `src`（带了浏览器就会去请求），原 src 放到 `data-src`
        const rest = { ...(HTMLAttributes as Record<string, unknown>) }
        delete rest.src
        return [
          'span',
          {
            ...rest,
            class: 'img-guard',
            'data-src': src,
            title: i18n.global.t('editor.imageRemoteHidden'),
            role: 'button',
            tabindex: '0'
          },
          ['span', { class: 'img-guard__label' }, String(HTMLAttributes.alt ?? src)]
        ]
      }
      return ['img', { ...HTMLAttributes, src, loading: 'lazy' }]
    }
    // markdown 序列化用 tiptap-markdown 的默认实现（prosemirror-markdown 的 image 规则：
    // alt 转义、src 里的括号转义、title 带引号）—— 行内写法不再需要 closeBlock
  }),
  // 表格：接管 markdown 序列化（列对齐 + 单元格转义竖线，见 tableMarkdown.ts）
  TableFidelity.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  // 无序列表：保留源码里的 -/*/+ 标记（见 listMarkers.ts）
  BulletListMarked,
  // 任务列表：补 tight 属性，否则每个任务项之间都被塞空行
  TaskListTight,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({
    // 传函数而不是字符串：扩展集是模块级常量，写死字符串的话切语言后占位符不会跟着变
    placeholder: () => i18n.global.t('editor.placeholder')
  }),
  CodeBlockCM,
  TyporaInputRules,
  // 图片：粘贴剪贴板 / 拖入文件 → 落进工作区 assets/ 并插入相对路径（见 lib/insertImage.ts）
  ImagePaste,
  // 粘贴修复：先注册 MarkdownPaste 接管 clipboardTextParser（someProp 取
  // 首个非 null），Markdown 自带的 inline-only 解析器被禁用
  MarkdownPaste,
  Markdown.configure({
    html: true,
    // breaks: **必须 false**。开启时 markdown-it 把段内单个换行渲染成 <br>，
    // 解析回来就是 hardBreak 节点，序列化再写成行尾 `\` —— 于是「打开一份手写
    // 折行的文档、随便改一个字、保存」，**每一行都被塞进一个反斜杠**：
    //   * 语义变了（软换行 ≡ 空格 → 强制换行，GitHub/VSCode 里渲染都不一样）；
    //   * 源码变脏（git diff 满屏 `\`）；
    //   * 用户会认为编辑器擅自改文件。实测见 tools/_verify-md-fidelity.js 的
    //     paragraph-breaks 用例。
    // 关闭后软换行按 CommonMark 语义处理（≡ 空格，段落被重新折成一行）：
    // 语义不变，只是源码不再按用户的换行位置断开。**真正的解法**是给软换行建一个
    // 能往返的节点（Wave 2 计划），在那之前「保义」优先于「保版式」。
    breaks: false,
    tightLists: true,
    bulletListMarker: '-',
    linkify: true,
    transformPastedText: false,
    transformCopiedText: true
  }),
  TyporaMarkers,
  // CJK 强调定界符（flanking）口径：全角/中文标点不参与定界符判定。
  // 必须与 Markdown 的 parser 同源 —— 它就是通过 parse.setup 改 markdown-it 的
  // emphasis 分词规则，所以「加载/刷新」与「实时重推」自动一致。
  CjkEmphasis,
  // 放宽 markdown-it 的嵌套上限（默认 100 → 1000）：默认值会让 50 层以上的列表/引用
  // **整段被丢掉**（解析器触到上限就跳过剩余行），见 parseLimits.ts
  MarkdownParseLimits,
  // 链接源码展开标记（普通点击链接时承载 [文字](网址)，序列化原样输出）
  LinkSource,
  // 目录（工具栏「目录」插入；序列化 [TOC]，点击条目跳转标题）
  TableOfContents,
  // YAML front matter（文档开头原样保留；见 lib/editor/frontmatter.ts）
  Frontmatter,
  // 块级 HTML 原文（`<div>`/`<!-- 注释 -->`/`<details>`）：Markdown 表达不了就整段原样留
  HtmlBlock,
  // 脚注：行内 `[^1]` 与块级 `[^1]: …` 都**原样透传**（见 footnotePassthrough.ts 的成因说明）
  MdFootnote,
  FootnoteDef,
  // 块级公式（`$$…$$`）：独占块的原子节点，屏幕上用 KaTeX 渲染（见 mathMarkers.ts）
  MathBlock,
  // 行内公式的 KaTeX 预览（光标不在公式上时用渲染结果替换原文）
  MathPreview,
  // 鼠标语义：Ctrl/Cmd+左键退化为普通点击（PM 内置会整选段落/节点，Typora 无此逻辑）；
  // 链接：普通左键原地展开源码、Ctrl/Cmd+左键交宿主注入的 onOpenLink（§4.14/§4.15）
  TyporaPointer,
  // 键盘语义（分割线回车确认 / 标题行首退格降级）：priority 200，
  // 先于 core keymap 执行；置于末尾保证在同等优先级中注册最晚（最先执行）
  TyporaKeymap
]

/**
 * 组装编辑器扩展集：把「打开链接」「文档目录」这类应用级行为注入内核，同时保持顺序不变
 * （顺序即注册顺序，不能改动）。宿主不传 onOpenLink 时退化为「只开浏览器」。
 */
export function buildEditorExtensions(options: EditorExtensionOptions = {}): Extensions {
  documentDirProvider = options.getDocumentDir ?? ((): string | null => null)
  remoteImageProvider = options.getRemoteImagePolicy ?? ((): RemoteImagePolicy => 'click')
  return editorExtensions.map((e) =>
    e.name === 'typoraPointer'
      ? e.configure({ onOpenLink: options.onOpenLink ?? defaultOpenLink })
      : e
  )
}
