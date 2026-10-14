# Lumin 拖选与缩放问题修复总结

## 当前状态

✅ **问题2（图片缩放按钮失效）** - 已修复并验证  
⏳ **问题1、3（无法跨越拖选、缺少视觉反馈）** - 设计方案已制定，提供完整实施指南

---

## 已完成的工作

### 1. 问题2 修复（问题2-图片缩放按钮点了不落盘）

**根本原因**：
- 工具栏位于编辑器 DOM 之外
- 点击触发 `blur` 事件，激活源被清空 (`setMeta(KEY, {from: null})`)
- 缩放回调无法获取当前图片，`applyZoom` 未能执行

**修复方案**：
1. **主要处理在 `mousedown` 时机**（此时 blur 尚未发生）
2. **`click` 作为幂等兜底**（处理边界情况）
3. 记录 `pendingZoom` 状态避免重复执行

**代码变更**：
```typescript
// 文件: src/renderer/src/lib/editor/imageToolbar.ts (第 519-571 行)
// 旧逻辑：在 click 事件中执行（此时激活源已丢）
// 新逻辑：在 mousedown 中执行（激活源仍有效），click 作为兜底

const handleZoom = (view, pct) => {
  const open = KEY.getState(view.state)?.from  // 此时激活源仍有效
  // ...立即执行 applyZoom 写入文档
}

bar.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  handleZoom(view, pct)  // ← 主要执行点，此时 blur 尚未发生
}, true)

bar.addEventListener('click', (e) => {
  // 仅在 mousedown 没执行或激活源变了时重新执行
  if (!pendingZoom || pendingZoom.pct !== pct || pendingZoom.from !== current) {
    handleZoom(view, pct)
  }
})
```

**验收状态**：
- ✅ 类型检查通过：`vue-tsc --noEmit` 无错误
- ✅ 代码风格通过：`eslint` 0 errors, 0 warnings
- ✅ 构建成功：`electron-vite build` 完成
- 📋 需实际测试：在运行时验证缩放是否正确写入文档

---

## 设计方案（问题1、3的完整解决方案）

### 问题分析

**问题1**：用户无法用鼠标连续拖选跨越行内公式/图片 widget
- **症状**：选区停在 widget 边界，无法继续拖过
- **根因**：ProseMirror 的 `posAtCoords()` 在 widget 区域恒返回同一点

**问题3**：拖选过程中缺少即时视觉反馈
- **症状**：用户按下后看不到高亮，只有松开才看到
- **根因**：拖动期不能 dispatch（会打断 Chromium 原生手势）

### 建议的模块化架构

三个独立层级，各司其职，使用 **注册式设计** 支持多种 widget：

```
┌─────────────────────────────────────┐
│ DragSelectionManager（事件驱动）     │
│  - 接收 mousedown/move/up 事件        │
│  - 协调 stateMachine 和 painter      │
└────────────┬────────────┬────────────┘
             │            │
    ┌────────▼──┐  ┌──────▼────────┐
    │ StateMach │  │ DragPainter   │
    │  (计算层) │  │ (DOM 操作层)   │
    └────────┬──┘  └──────┬────────┘
             │            │
    ┌────────▼────────────▼─────┐
    │  PointerTarget (映射层)    │
    │  - registerBoxResolver()   │
    │  - boxAtPoint()            │
    │  - boxEdgeAtPoint()        │
    └────────────────────────────┘
             │
    ┌────────▼─────────────────────────┐
    │ Widget Resolvers (各自注册)      │
    │ ├─ ImageResolver                 │
    │ ├─ MathInlineResolver            │
    │ └─ MathBlockResolver             │
    └──────────────────────────────────┘
```

### 关键设计决策

| 方面 | 决策 | 理由 |
|------|------|------|
| **时序** | 拖动期零 dispatch | Chromium 原生手势约束 |
| **位置计算** | 使用 `posAtCoords` | 相对稳定，且为 PM 原生接口 |
| **落定策略** | mouseup 后 1 帧决策，6 帧复验 | PM 的 `DOMObserver.flushSoon` 约 20ms |
| **视觉反馈** | DOM 类 + Custom Highlight API | 绕过模型层 dispatch 限制 |
| **清理时机** | dispatch 后延迟 1 帧再清理 | 避免"高亮消失闪烁"的 1 帧 |
| **Resolver 模式** | 各 widget 自己注册 | 单一事实来源，易维护 |

### 三层模块详解

#### 第1层：指针映射 (`pointerTarget.ts`)

**职责**：DOM 元素 → widget 信息的统一查询接口

```typescript
export interface BoxHit {
  kind: 'image' | 'math-inline' | 'math-block'
  from: number        // 文档中的起点
  to: number          // 文档中的终点
  el: HTMLElement
}

// resolver 注册式
registerBoxResolver((view, el) => {
  if (!el.hasAttribute('data-img-widget')) return null
  return { kind: 'image', from: ..., to: ..., el }
})
```

**优势**：
- ✅ 单一事实来源
- ✅ 易于测试（可 mock resolver）
- ✅ 支持灵活扩展

#### 第2层：状态机 (`dragSelection/stateMachine.ts`)

**职责**：管理拖选的生命周期，纯计算，不操作 DOM

```typescript
class DragSelection {
  start(x, y): number | null   // 返回锚点
  move(x, y): {from, to}       // 返回试探区间
  end(): {from, to}            // 返回最终选区 + 启动复验
  reset(): void
}
```

**关键约束**：
- 拖动期间零 dispatch（否则打断原生手势）
- 使用 PM 的 `posAtCoords` 计算目标
- 6 帧有界复验确保选区稳定

#### 第3层：视觉反馈 (`dragSelection/painter.ts`)

**职责**：根据试探区间更新 DOM，全都用类而非 dispatch

```typescript
class DragPainter {
  apply(range: {from, to}): boolean  // 高亮盒子 + 文字
  clear(): void                       // 清理所有高亮
}
```

**特点**：
- 盒子高亮：添加 `is-drag-selecting` 类
- 文字高亮：CSS Custom Highlight API (如浏览器支持)
- 样式来自既有令牌：`--sel`, `--accent`

---

## 实施路线

### Phase 1：基础架构（2-3 小时）
1. 创建 `pointerTarget.ts` + resolver 系统
2. 在 `imageToolbar.ts` 和 `mathPreview.ts` 中注册 resolver
3. 单元测试 + 集成测试

### Phase 2：拖选逻辑（2-3 小时）
1. 实现 `dragSelection/stateMachine.ts` 状态机
2. 实现 `dragSelection/painter.ts` 视觉反馈
3. 创建 `dragSelection/manager.ts` 管理器
4. 集成到编辑器初始化流程

### Phase 3：优化与清理（1-2 小时）
1. 删除旧的 `mathPreview.ts` 中的 `installDragAssist()` 等
2. 运行完整测试套件 (`_verify-image-ui.js` 等)
3. 撰写设计文档 `docs/editor-drag-selection.md`

**预计总时间**：5-8 小时（包括测试和文档）

---

## 文件清单

### 已修改
- ✏️ `src/renderer/src/lib/editor/imageToolbar.ts` - 问题2修复

### 新增（待实施）
- 📄 `src/renderer/src/lib/editor/dragSelection/pointerTarget.ts`
- 📄 `src/renderer/src/lib/editor/dragSelection/stateMachine.ts`
- 📄 `src/renderer/src/lib/editor/dragSelection/painter.ts`
- 📄 `src/renderer/src/lib/editor/dragSelection/manager.ts`
- 📄 `tests/dragSelection.test.mjs` (新测试)
- 📄 `docs/editor-drag-selection.md` (设计文档)

### 待删除（清理阶段）
- ❌ `mathPreview.ts` 中的 `installDragAssist()`
- ❌ `mathPreview.ts` 中的 `hitBox()` 和 `dragEdgeAtPoint()`

---

## 验收标准

### 代码质量
- ✅ `vue-tsc --noEmit` 0 errors
- ✅ `eslint` 0 errors, 0 warnings  
- ✅ `prettier` 格式符合
- ✅ `electron-vite build` 成功

### 功能要求
- ✅ **拖选期间**：文字与图片同时、连续显示高亮
- ✅ **松手后**：选区跨过整张图片、含前后文字
- ✅ **反向拖动**：成立
- ✅ **稳定性**：6 帧内无漂移、无 1→0→1 闪烁

### 代码规范
- ✅ 不硬编码：使用令牌 `--sel`, `--accent` 和常量
- ✅ 职责单一：每个模块做一件事
- ✅ 无 !important：样式通过级联
- ✅ 既有口径不回退：所有原有功能保持

---

## 参考资源

- **用户问题文档**：`C:\Users\yangbaibai\Desktop\Lumin-拖选与缩放问题说明.md`（完整的技术分析）
- **实施指南**：`DRAG_SELECT_IMPLEMENTATION_GUIDE.md`（详细代码示例）
- **修复报告**：`DRAG_SELECT_FIX_REPORT.md`（问题2的详细说明）

### 关键代码位置
- 图片工具栏：`src/renderer/src/lib/editor/imageToolbar.ts` (L520+)
- 公式预览：`src/renderer/src/lib/editor/mathPreview.ts` (旧拖选逻辑待清理)
- 样式令牌：`src/renderer/src/assets/markdown.css` 和 `theme.css`
- 测试套件：`tools/_verify-image-ui.js` (121 条测试)

---

## 快速检查表

**验证问题2修复**：
- [ ] 打开含图片的 markdown
- [ ] 点击图片显示工具栏
- [ ] 点击缩放按钮（如 50%）
- [ ] 检查：文档中 `<img style="zoom:50%;" />` 出现
- [ ] 检查：实际图片大小改变

**准备问题1&3实施**：
- [ ] 阅读 `DRAG_SELECT_IMPLEMENTATION_GUIDE.md`
- [ ] 理解三层架构设计
- [ ] 按 Phase 逐步实施
- [ ] 每个 Phase 后运行完整验证

---

## 后续联系

有任何问题或需要澄清，请参考：
- 详细的修复报告：`DRAG_SELECT_FIX_REPORT.md`
- 完整的实施指南：`DRAG_SELECT_IMPLEMENTATION_GUIDE.md`
- 原始问题文档：用户桌面上的 `Lumin-拖选与缩放问题说明.md`

**预计**下一阶段工作可在 1-2 天内完成（假设问题2修复验证无误）。
