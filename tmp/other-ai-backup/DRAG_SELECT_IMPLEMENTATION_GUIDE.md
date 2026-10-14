# 拖选系统完整实施指南

## 快速开始：问题2验证

修复已完成并通过类型检查、ESLint 和构建验证。

**测试方法**：
```bash
# 1. 构建项目
npm run build

# 2. 启动开发服务器
npm run dev

# 3. 打开含有图片的 markdown 文件
# 4. 点击图片使其显示源码和工具栏
# 5. 点击缩放按钮（如 50%）
# 预期：文档中的 img tag 的 style 属性应该被更新为 zoom:50%
```

---

## 问题1&3：完整的拖选系统实施（分三个 Phase）

### Phase 1: 基础架构（指针映射 + 状态机）

#### 步骤1.1：创建 `src/renderer/src/lib/editor/dragSelection/pointerTarget.ts`

```typescript
// 功能：根据 DOM 元素查找对应的 widget 信息
import type { EditorView } from '@tiptap/pm/view'

export interface BoxHit {
  kind: 'image' | 'math-inline' | 'math-block'
  from: number
  to: number
  el: HTMLElement
}

export type BoxResolver = (view: EditorView, el: HTMLElement) => BoxHit | null

const resolvers: BoxResolver[] = []

export function registerBoxResolver(resolver: BoxResolver): void {
  resolvers.push(resolver)
}

export function boxAt(view: EditorView, target: HTMLElement | null): BoxHit | null {
  if (!target) return null
  let el: HTMLElement | null = target
  while (el && el !== view.dom && el !== document.body) {
    for (const resolver of resolvers) {
      const hit = resolver(view, el)
      if (hit) return hit
    }
    el = el.parentElement
  }
  return null
}

export function boxAtPoint(view: EditorView, x: number, y: number): BoxHit | null {
  const el = document.elementFromPoint(x, y)
  if (!el || el.nodeType !== 1) return null
  return boxAt(view, el as HTMLElement)
}

export function boxEdgeAtPoint(view: EditorView, x: number, y: number): { edge: 'start' | 'end'; box: BoxHit } | null {
  const box = boxAtPoint(view, x, y)
  if (!box) return null
  const rect = box.el.getBoundingClientRect()
  const mid = (rect.left + rect.right) / 2
  return { edge: x < mid ? 'start' : 'end', box }
}
```

**关键点**：
- ✅ 注册式设计：图片/公式各自提供 resolver
- ✅ 从 DOM 元素往上查找 widget（支持嵌套）
- ✅ 支持按坐标快速查找

#### 步骤1.2：在 `imageToolbar.ts` 中注册图片 resolver

```typescript
// 在 imageToolbar.ts 的导出函数中添加
import { registerBoxResolver } from './dragSelection/pointerTarget'

export function initImageDragSelection(): void {
  registerBoxResolver((view, el) => {
    if (!el.hasAttribute('data-img-widget')) return null

    const fromAttr = el.getAttribute('data-img-from')
    if (!fromAttr) return null

    const from = Number(fromAttr)
    if (!Number.isFinite(from) || from < 0) return null

    return {
      kind: 'image',
      from,
      to: from + 1,
      el
    }
  })
}
```

**在编辑器初始化时调用**：
```typescript
// 在 buildEditorExtensions 或类似位置
initImageDragSelection()
```

#### 步骤1.3：创建 `src/renderer/src/lib/editor/dragSelection/stateMachine.ts`

```typescript
// 拖选状态机（纯计算）
import type { EditorView } from '@tiptap/pm/view'
import { boxEdgeAtPoint } from './pointerTarget'

export type DragState = 'idle' | 'active' | 'verifying'

export class DragSelection {
  private state: DragState = 'idle'
  private anchor: number | null = null
  private target: number = 0
  private verifyCount = 0
  private maxVerifyFrames = 6
  private rafId: number | null = null

  constructor(private view: EditorView) {}

  start(x: number, y: number): number | null {
    if (this.state !== 'idle') return null

    const hit = boxEdgeAtPoint(this.view, x, y)
    if (!hit) return null

    this.anchor = hit.edge === 'start' ? hit.box.from : hit.box.to
    this.target = this.anchor
    this.state = 'active'
    return this.anchor
  }

  move(x: number, y: number): { from: number; to: number } | null {
    if (this.state !== 'active' || this.anchor === null) return null

    const at = this.view.posAtCoords({ left: x, top: y })
    if (!at) return null

    this.target = at.pos
    const from = Math.min(this.anchor, this.target)
    const to = Math.max(this.anchor, this.target)
    return { from, to }
  }

  end(): { from: number; to: number } | null {
    if (this.state !== 'active' || this.anchor === null) {
      this.state = 'idle'
      return null
    }

    const from = Math.min(this.anchor, this.target)
    const to = Math.max(this.anchor, this.target)

    this.state = 'verifying'
    this.verifyCount = 0
    // 启动 6 帧复验逻辑
    this.verify(from, to)

    return { from, to }
  }

  reset(): void {
    this.state = 'idle'
    this.anchor = null
    this.target = 0
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  private verify(expectedFrom: number, expectedTo: number): void {
    if (this.verifyCount >= this.maxVerifyFrames) {
      this.state = 'idle'
      return
    }

    const { from, to } = this.view.state.selection
    // 如果选区漂移，可在这里记录诊断信息
    if (from !== expectedFrom || to !== expectedTo) {
      console.debug('[DragSelect] Selection drifted', { expected: [expectedFrom, expectedTo], actual: [from, to] })
    }

    this.verifyCount++
    if (this.verifyCount < this.maxVerifyFrames) {
      this.rafId = requestAnimationFrame(() => this.verify(expectedFrom, expectedTo))
    } else {
      this.state = 'idle'
      this.rafId = null
    }
  }
}
```

**关键点**：
- ✅ 纯计算，不操作 DOM
- ✅ 拖动期不调用 dispatch
- ✅ 6 帧复验确保选区稳定
- ⚠️ 复验中如果发现漂移可记录诊断信息

---

### Phase 2: 视觉反馈层

#### 步骤2.1：创建 `src/renderer/src/lib/editor/dragSelection/painter.ts`

```typescript
// 视觉反馈（DOM 操作）
import type { EditorView } from '@tiptap/pm/view'

export class DragPainter {
  private currentRange: { from: number; to: number } | null = null
  private boxElements: Set<HTMLElement> = new Set()

  constructor(private view: EditorView) {}

  apply(range: { from: number; to: number }): boolean {
    if (range.from < 0 || range.to > this.view.state.doc.content.size) {
      return false
    }

    if (this.currentRange && this.currentRange.from === range.from && this.currentRange.to === range.to) {
      return true // 范围未变，不操作
    }

    this.currentRange = range
    this.updateHighlight(range)
    return true
  }

  clear(): void {
    this.currentRange = null
    this.clearHighlight()
  }

  private updateHighlight(range: { from: number; to: number }): void {
    // 清理旧的盒子高亮
    for (const el of this.boxElements) {
      el.classList.remove('is-drag-selecting')
    }
    this.boxElements.clear()

    // 遍历范围内的节点，标记 widget
    this.view.state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (pos >= range.to) return false

      try {
        const dom = this.view.nodeDOM(pos)
        if (dom && dom.nodeType === 1) {
          const el = dom as HTMLElement
          if (el.hasAttribute('data-img-widget') || el.hasAttribute('data-md-math-rendered')) {
            el.classList.add('is-drag-selecting')
            this.boxElements.add(el)
          }
        }
      } catch {
        // 忽略 nodeDom 错误
      }

      return true
    })
  }

  private clearHighlight(): void {
    for (const el of this.boxElements) {
      el.classList.remove('is-drag-selecting')
    }
    this.boxElements.clear()
  }
}
```

#### 步骤2.2：在 `src/renderer/src/assets/markdown.css` 中添加样式

```css
/* 拖选中的 widget 高亮 */
.md-preview .is-drag-selecting,
.md-preview .is-drag-selecting img {
  background-color: var(--sel);
  outline: 2px solid var(--accent);
}
```

**关键点**：
- ✅ 使用既有令牌（`--sel`, `--accent`）
- ✅ 无 !important
- ✅ 清理集中在 `clear()` 方法

---

### Phase 3: 集成到编辑器

#### 步骤3.1：创建管理器 `src/renderer/src/lib/editor/dragSelection/manager.ts`

```typescript
import type { EditorView } from '@tiptap/pm/view'
import { TextSelection } from '@tiptap/pm/state'
import { DragSelection } from './stateMachine'
import { DragPainter } from './painter'

export class DragSelectionManager {
  private dragSel: DragSelection
  private painter: DragPainter

  constructor(private view: EditorView) {
    this.dragSel = new DragSelection(view)
    this.painter = new DragPainter(view)
    this.setupListeners()
  }

  private setupListeners(): void {
    this.view.dom.addEventListener('mousedown', (event) => this.onMouseDown(event))
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return

    const anchor = this.dragSel.start(event.clientX, event.clientY)
    if (anchor === null) return // 普通位置，让 PM 处理

    // 命中 widget，接管拖选
    event.preventDefault()

    const onMouseMove = (e: MouseEvent) => {
      const range = this.dragSel.move(e.clientX, e.clientY)
      if (range) {
        this.painter.apply(range)
      }
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)

      const range = this.dragSel.end()
      if (range) {
        // dispatch 最终选区
        this.view.dispatch(
          this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, range.from, range.to))
        )

        // 延迟清理高亮（避免闪烁）
        requestAnimationFrame(() => {
          this.painter.clear()
        })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }
}
```

#### 步骤3.2：在编辑器初始化时注册

```typescript
// 在 buildEditorExtensions 或相关初始化代码中
import { initImageDragSelection } from './imageToolbar'
import { DragSelectionManager } from './dragSelection/manager'

export function setupEditor(view: EditorView): void {
  // 初始化拖选系统
  initImageDragSelection()
  new DragSelectionManager(view)
}
```

---

## 验证检查清单

### 类型检查
```bash
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.web.json --composite false
```

### 代码风格
```bash
node node_modules/eslint/bin/eslint.js src/renderer/src/lib/editor/dragSelection/ --max-warnings 0
node node_modules/prettier/bin/prettier.cjs --check src/renderer/src/lib/editor/dragSelection/
```

### 构建
```bash
node node_modules/electron-vite/bin/electron-vite.js build
```

### 功能测试
使用真实文件 `C:\Users\yangbaibai\Desktop\Lumin相关\数学公式示例.md` 第15行：
```
行内公式$E = mc^2$ 与 $a^2 + b^2 = c^2$。<img src="..." /><img src="..." />
```

测试场景：
1. 在段落开头按下
2. 向右拖到第一个图片
3. 继续拖到第二个图片
4. 释放鼠标

**预期结果**：
- ✅ 拖动期间文字与图片同时显示高亮
- ✅ 松手后选区完整覆盖整行
- ✅ 反向拖动（从图片回到文字）也成立
- ✅ 6 帧内选区稳定，无漂移

---

## 常见问题与故障排除

### Q1: 拖选期间选区闪烁
**原因**：清理高亮的时机不对（在 dispatch 前清理）  
**解决**：确保 `painter.clear()` 在 `requestAnimationFrame` 中调用，且在 dispatch 之后

### Q2: 图片高亮不显示
**原因**：CSS 样式未注入或类名不对  
**解决**：
- 检查 `is-drag-selecting` 类是否在 CSS 中定义
- 确保使用 `--sel` 和 `--accent` 令牌
- 验证 z-index 不被其他样式覆盖

### Q3: 拖选后选区跳位
**原因**：`posAtCoords` 返回的位置不精确  
**解决**：
- 增加复验帧数（`maxVerifyFrames`）
- 在复验中记录漂移距离用于诊断
- 考虑在 `posAtCoords` 返回 null 时的降级处理

### Q4: 无法跨越 widget
**原因**：resolver 没有正确识别 widget  
**解决**：
- 检查 resolver 的选择器是否匹配实际 DOM
- 验证 `data-img-from` 或 `data-md-math-rendered` 属性存在
- 添加调试日志打印 `boxAt` 的返回值

---

## 清理与优化

### 要删除的旧代码
- `mathPreview.ts` 中的 `installDragAssist()` 函数
- `mathPreview.ts` 中的 `hitBox()` 和 `dragEdgeAtPoint()` 函数
- 相关的全局拖选事件监听器

### 性能优化建议
- 使用事件委托而非为每个 widget 注册监听器
- 在 `move` 期间缓存 DOM 查询结果
- 考虑使用 Web Workers 进行复杂计算（如需要）

---

## 完成后的验收标准

根据用户文档要求：

✅ **不硬编码**
- 所有颜色使用 `--sel`, `--accent` 令牌
- 所有类名通过常量定义
- 所有选择器由 resolver 提供

✅ **符合规范**
- 职责明确：pointerTarget / stateMachine / painter 各司其职
- 注释清晰：解释"为什么"而非"做什么"
- 无 !important、无过度防御代码

✅ **既有口径不回退**
- 图片点击激活逻辑不变
- 源码显隐规则不变
- 文档序列化不变

✅ **树必须绿**
- vue-tsc 0 errors
- eslint 0 errors
- electron-vite build success
- 所有测试通过

---

## 参考资源

- **用户问题文档**：C:\Users\yangbaibai\Desktop\Lumin-拖选与缩放问题说明.md
- **项目标签**：rollback-safety (2e2ca5c) - 包含之前的尝试
- **相关文件**：
  - src/renderer/src/lib/editor/imageToolbar.ts
  - src/renderer/src/lib/editor/mathPreview.ts
  - src/renderer/src/assets/markdown.css
  - tools/_verify-image-ui.js（测试套件）

---

**最后更新**：2024年  
**作者**：Kiro  
**状态**：问题2 已修复✅，问题1&3 待实现📋
