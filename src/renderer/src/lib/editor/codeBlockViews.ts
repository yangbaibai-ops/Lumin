// ─── CodeBlockView 实例注册表 ───────────────────────────────────────────────
// PM 层的键盘拦截（如「代码块后段落行首 Backspace → 光标进入代码块末尾」）
// 需要把焦点/光标移交给具体某个 CodeBlockView 里的 CodeMirror 实例。NodeView
// 自身是 Vue 组件，PM 扩展无法直接引用；这里用一个轻量注册表按节点位置
// （getPos 动态求值）查找对应实例，避免反向依赖与循环 import。
export interface CodeBlockHandle {
  /** 当前节点在文档中的起始位置（动态求值，随编辑移动） */
  getPos: () => number | undefined
  /** 把焦点与光标移入本代码块 CodeMirror 的末尾；无 CM（mermaid 等）返回 false */
  focusCmAtEnd: () => boolean
  /** 请求 CM 重新测量（面板从隐藏转可见后尺寸恢复时调用） */
  requestMeasure?: () => void
}

const handles = new Set<CodeBlockHandle>()

export function registerCodeBlockHandle(handle: CodeBlockHandle): void {
  handles.add(handle)
}

export function unregisterCodeBlockHandle(handle: CodeBlockHandle): void {
  handles.delete(handle)
}

/** 按文档位置找到对应代码块的 CM 句柄（找不到返回 undefined） */
export function findCodeBlockHandle(pos: number): CodeBlockHandle | undefined {
  for (const h of handles) {
    if (h.getPos() === pos) return h
  }
  return undefined
}

/** 请求所有已注册代码块重新测量（如隐藏的编辑器面板重新显示后） */
export function measureAllCodeBlocks(): void {
  for (const h of handles) {
    h.requestMeasure?.()
  }
}
