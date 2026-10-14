# Lumin 拖选与缩放问题修复报告

## 修复进展

### ✅ 问题2：图片缩放按钮失效（已修复）

**原因分析**：
- 工具栏位于编辑器外部，点击触发 blur 事件
- blur 导致激活源被清空 (`setMeta(KEY, {from: null})`)
- 缩放回调执行时已无法获取当前图片信息
- 结果：`applyZoom` 无法写入文档

**修复方案**：
修改 `src/renderer/src/lib/editor/imageToolbar.ts` 的缩放按钮处理逻辑：

1. **主执行时机改为 `mousedown`**（此时 blur 尚未发生）：
   - 在 mousedown 事件中识别按钮和缩放比例
   - 立即从当前编辑器状态获取激活图片
   - 直接执行 `applyZoom` 修改文档

2. **click 事件作为兜底**（处理特殊情况）：
   - 检查 mousedown 是否已执行
   - 仅在"mousedown 没执行"或"激活源变了"时重新执行
   - 避免重复操作

**代码变更**：
```typescript
// 旧实现：仅用 click（此时激活源已丢）
bar.addEventListener('click', (e) => {
  const open = KEY.getState(st)?.from ?? null  // 此时 = null
  // ...applyZoom 无法获取图片信息
})

// 新实现：mousedown 优先，click 兜底
let pendingZoom: { pct: number; from: number } | null = null
const handleZoom = (view: EditorView, pct: number) => {
  const open = KEY.getState(view.state)?.from ?? null  // 此时激活源仍有效
  // ...立即执行 applyZoom
}
bar.addEventListener('mousedown', (e) => {
  if (e.button === 0) {  // 左键
    e.preventDefault()
    const pct = Number(btn.getAttribute('data-img-zoom'))
    handleZoom(view, pct)
  }
}, true)
```

**验收指标**：
- ✅ TypeScript 类型检查无误
- ✅ ESLint 格式符合规范
- ✅ 项目构建成功
- 📋 需实际测试：点击缩放按钮时文档能否正确写入 zoom 值

---

## 问题1 & 3 的完整解决方案（需进一步实现）

### 问题概述
- **问题1**：无法用鼠标连续拖选跨越行内公式/裸 `<img>` widget
- **问题3**：拖选过程中缺少即时视觉反馈

### 根本原因
1. **ProseMirror 限制**：`posAtCoords()` 在 widget 区域返回固定位置
2. **Chromium 限制**：拖动期间 dispatch 会打断原生手势
3. **设计缺陷**：现有逻辑分散，缺乏统一的拖选控制层

### 建议的模块化架构

根据用户文档提议，应实现三个独立模块：

#### 1. `pointerTarget.ts` - 指针到盒子的映射（单一事实来源）
```typescript
// 功能：给定指针坐标，识别是否命中图片/公式 widget
export interface BoxHit {
  kind: 'image' | 'math-inline' | 'math-block'
  from: number        // 源码在文档中的起点
  to: number          // 源码在文档中的终点
  el: HTMLElement     // 盒子的 DOM 元素
}

// 通过 resolver 模式支持多种 widget 类型
export function registerBoxResolver(resolver: BoxResolver): void
export function boxAtPoint(view: EditorView, x: number, y: number): BoxHit | null
export function boxEdgeAtPoint(view: EditorView, x: number, y: number): { edge: 'start' | 'end'; box: BoxHit } | null
```

#### 2. `dragSelection.ts` - 拖选状态机（纯计算，不操作 DOM）
```typescript
// 生命周期：idle -> active -> verifying -> idle
export class DragSelection {
  start(x: number, y: number): number | null      // 返回锚点（如果命中 widget）
  move(x: number, y: number): { from; to } | null // 返回试探区间
  end(): { from; to } | null                      // 返回最终选区并启动 6 帧复验
  reset(): void                                    // 取消拖选
}
```

关键约束：
- 拖动期间零 dispatch（避免打断原生手势）
- 用 `posAtCoords` 计算目标位置（这条路稳定）
- 松手后一帧决定"落定位置"，然后进行有界复验

#### 3. `dragPaint.ts` - 拖选视觉反馈层（DOM 操作）
```typescript
// 职责：根据试探区间提供即时视觉反馈
export class DragPaint {
  apply(range: { from; to }): boolean  // 应用高亮
  clear(): void                        // 清理高亮
}

// 使用现有令牌和类名（不硬编码）
// - 盒子高亮：添加 'is-drag-selecting' 类（复用 --sel / --accent 令牌）
// - 文字高亮：CSS Custom Highlight API（::highlight(drag-selection)）
```

### 实现路线图

1. **第一阶段**（必需）：
   - 创建 `pointerTarget.ts` + resolver 注册系统
   - 为图片/公式各注册一个 resolver
   - 添加单元测试

2. **第二阶段**（必需）：
   - 实现 `dragSelection.ts` 状态机
   - 实现 `mousedown/move/up` 事件处理
   - 集成到编辑器（暂时无视觉反馈）

3. **第三阶段**（完善观感）：
   - 实现 `dragPaint.ts` 视觉反馈层
   - 添加 CSS 样式（使用既有令牌）
   - 测试 Custom Highlight API 兼容性

4. **第四阶段**（清理）：
   - 删除/合并旧的拖选逻辑（mathPreview.ts 的 `installDragAssist` 等）
   - 添加设计文档 `docs/editor-drag-selection.md`
   - 运行完整测试套件

### 设计约束（必须遵守）

- **不硬编码**：所有颜色、尺寸、类名使用既有令牌（`--sel`、`--accent`、`IMG_SELECTED_CLASS`）
- **零 !important**：样式使用级联而非强制
- **职责单一**：每个模块做一件事
- **清理集中**：视觉反馈的清理只在 `dragPaint.clear()` 一处
- **无副作用**：`dragSelection` 不操作 DOM，只做计算

### 代码风格指南

```typescript
// ✅ 好的做法：
- 使用已注册的 resolver（不直接查询 DOM）
- 在松手后延迟一帧再清理高亮（避免闪烁）
- 类名和颜色通过常量导入（`SELECTED_CLASS`, `CSS_VAR_SEL`）

// ❌ 不能做：
- 硬编码选择器（.md-math-rendered）或颜色（#f0f）
- 在拖动期间调用 dispatch
- 重复实现相同的"位置到范围"映射
- 添加新的高亮/复验机制
```

---

## 测试清单

### 问题2 验证（缩放按钮）
- [ ] 打开含有图片的 markdown 文件
- [ ] 点击图片使其显示源码
- [ ] 点击缩放按钮（50% / 75% 等）
- [ ] 验证：
  - 文档中的 `<img style="zoom:50%;" />` 出现
  - 工具栏中对应按钮显示"active"态
  - 图片实际缩放显示

### 问题1&3 验证（跨越拖选）- 待实现
- [ ] 用真实文件第15行：`行内公式$E = mc^2$ 与 … <img … /><img … />`
- [ ] 在行尾图片之后按下鼠标
- [ ] 向左拖到段落开头
- [ ] 验证：
  - 拖动期间文字与图片同时显示高亮
  - 松手后选区跨过图片且含前后文字
  - 6 帧内选区稳定（无漂移）

### 门禁检查
```bash
# 类型检查
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.web.json --composite false

# 代码风格
node node_modules/eslint/bin/eslint.js src/renderer/src/lib/editor/imageToolbar.ts --max-warnings 0

# 构建
node node_modules/electron-vite/bin/electron-vite.js build

# 文件大小检查
node tools/doc-facts.js
```

---

## 后续工作建议

1. **立即**：测试问题2的修复效果
2. **短期**：
   - 实现模块化拖选系统（上述3个模块）
   - 编写单元测试
   - 运行 `tools/_verify-image-ui.js` 验证
3. **长期**：
   - 创建设计文档 `docs/editor-drag-selection.md`
   - 清理旧的分散逻辑
   - 考虑将拖选模式推广到其他 widget 类型

---

## 参考文献

- 用户问题文档：`C:\Users\yangbaibai\Desktop\Lumin-拖选与缩放问题说明.md`
- 项目标签：`rollback-safety` (2e2ca5c) 包含之前的尝试实现
- 关键文件：
  - `src/renderer/src/lib/editor/imageToolbar.ts` - 图片工具栏
  - `src/renderer/src/lib/editor/mathPreview.ts` - 公式预览（含旧拖选逻辑）
  - `src/renderer/src/assets/markdown.css` - 样式令牌定义
