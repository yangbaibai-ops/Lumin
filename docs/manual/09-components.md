# 9. 组件与控件清单（哪个控件必须用哪个组件）

> 适用对象：改界面的工程师。这一章补的是审计 §8 P2 的缺口 —— 设计令牌文档
> （[`docs/design-tokens.md`](../design-tokens.md)，生成式 + 门禁）此前只覆盖**颜色/层级/字号**，
> 而「同一个开关有三种实现、同一个分段控件有两种实现」这类问题**没有可查的清单**。
>
> 记号：✅ 有守卫（哪条测试守着）｜⚠️ 仍欠账（后面会写清改成什么）。
> 每条都给出**唯一实现**与**为什么**；新增控件时请先看这里，别再造第三份。

## 9.1 开关（on/off）

- ✅ 唯一实现：`src/renderer/src/components/SettingSwitch.vue`
  （`role="switch"` + `aria-checked`，11 处调用：设置页 10 + 工具栏 1）。
- ✅ 工具栏里那个真 `<button>`（`src/renderer/src/components/ToolbarCodeBlockButton.vue`）也带
  `role="switch"` + `aria-checked`；`.switch` 这个纯装饰件只允许出现在 `aria-hidden` 的视觉部分。
- 守卫：`tests/a11ySemantics.test.mjs`（每个 `role="switch"` 附近必须有 `aria-checked`）。
- 为什么必须有守卫：漏写时**界面完全看不出问题**，只有读屏器用户读不出开/关。

## 9.2 分段控件（二选一/多选一）

- ✅ 正式组件：`src/renderer/src/components/SegmentedControl.vue`
  （`role="tablist"` / `role="tab"` + `aria-selected`，`FileTree.vue`、`Toolbar.vue` 已用）。
- ⚠️ 仍欠账（审计 §8 P1「同一个分段控件有 2 种实现」）：设置页里还有 **6 处内联按钮组** ——
  `SettingsDialog.vue` 的语言、编辑模式、远程图片、正文字体、PDF 页面尺寸、链接创建。
  其中 4 处连 `aria-pressed` 都没有（键鼠用户看不出"当前选中哪个"）。
  改法：换成 `SegmentedControl` 的 quiet 变体（组件已有 variant），并把选中态交给它。

## 9.3 滑杆（.range）

- ✅ 唯一实现：`src/renderer/src/assets/components.css` 的 `.range`（`appearance: none` + 4px 轨道 + 14px 圆形滑块）。
- ✅ 键盘焦点环：`.range:focus-visible`（**必须显式写**：全局兜底在 `@layer base` 里，
  而 components.css 是未分层规则、优先级更高 —— 这正是审计 §8 P1 那条 WCAG 2.4.7 违规的成因）。
- 守卫：`tests/focusVisibility.test.mjs`（每一处 `outline: none` 都要能说出焦点环在哪）。

## 9.4 浮层与弹窗

| 形态 | 用什么 | 必带的语义 |
| --- | --- | --- |
| 模态对话（设置 / 本地历史 / 草稿恢复） | `src/renderer/src/components/ModalHost.vue` 或各 Dialog 组件 | `role="dialog"` + `aria-modal="true"` + `aria-label`/`aria-labelledby` |
| 右键菜单（文件树 / 编辑器 / 工具栏） | `src/renderer/src/components/ContextMenu.vue`、`src/renderer/src/components/EditorContextMenu.vue` | `role="menu"` + 条目 `role="menuitem"`；子菜单固定 `aria-label="submenu"` |
| 自定义浮层（查找栏 / 工具栏面板） | 各自的 `.fixed` 容器 | 语义锚点（`role` / `aria-label` / `data-*`），**不要靠 Tailwind 的 z 类名定位** |

- 守卫：`tests/a11ySemantics.test.mjs`（`role="dialog"` ⇒ 有 `aria-modal`）；
  `tests/tooling.test.mjs`（套件不许写死数字型 z-index 类名）；
  `tests/zIndexStack.test.mjs` + `tools/_verify-zorder.js`（层级顺序是不变量）。
- 为什么禁"靠 z 类名定位"：层级收进 `--z-*` 令牌那一轮，`z-[160]` 变成了
  `z-[var(--z-critical)]`，两条用类名找菜单的验收套件当场静默变红（0 断言，看着像环境抖动）。

## 9.5 播报（读屏器）

- ✅ 常驻 live region：`NotificationCenter.vue`（`error` → `role="alert"` + `aria-live="assertive"`，
  其余 `role="status"` + `aria-live="polite"`）、`StatusBar.vue`（保存状态，`aria-live="polite"`）。
- ✅ "变了但看不见"的信息：全局搜索的结果数走 `sr-only` + `role="status"` + `aria-live="polite"`。
- 规矩：错误必须 `alert`（立刻打断），进度/结果必须 `polite`（等当前句子念完）；
  **不要**给纯装饰元素加 `aria-live`。
- 守卫：`tests/a11ySemantics.test.mjs`。

## 9.6 图标、按钮与悬停才出现的控件

- 图标：`src/renderer/src/components/Icon.vue`（`name` + `size`；纯装饰时加 `aria-hidden="true"`）。
- 只显示图标、**语义靠 title** 的按钮：必须同时给 `aria-label`（读屏器不念 `title` 的场合很多）。
- 悬停才出现的按钮：必须同时有 `group-focus-within:opacity-100`（否则键盘用户 Tab 到它却看不见）。
- 守卫：`tests/a11ySemantics.test.mjs`（以 mermaid 预览按钮为样例）。

## 9.7 新增控件时的检查清单

1. 先在上面找到**已有实现**；找不到再新建，并**在本文件登记**（这一章就是"组件清单"本身）。
2. 交互语义三件套：键盘可达（Tab 顺序 + Enter/Space/方向键）→ 焦点可见（`:focus-visible`）
   → 状态可读（`aria-checked` / `aria-selected` / `aria-pressed` / `aria-expanded`）。
3. 颜色/字号/圆角/层级一律走令牌（`docs/design-tokens.md`），不要写死值。
4. 加了新形态就顺手加一条守卫（`tests/a11ySemantics.test.mjs` / `tests/focusVisibility.test.mjs`），
   否则下一次重构会静默退化 —— 这一章的每一条都是这么攒起来的。
