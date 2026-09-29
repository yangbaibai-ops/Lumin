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
- ⚠️ **"二值位置/状态"类开关不要用分段控件**：工具栏里的「大纲位置」（左栏 ⇄ 编辑区右侧）刻意是
  一枚 `icon-btn` 状态开关（`active` 高亮 = 当前在右侧，提示文案说下一步），理由是工具栏里已经有
  一枚三段控件，再摆一枚两段的会互相抢视觉；且"分段控件恰好两处"是 `_verify-segmented-control.js`
  的既有口径（第三枚会让那条断言变三处）。判据：**"选一个模式"用分段控件，"翻一个开关"用状态按钮**。
- ⚠️ 仍欠账（审计 §8 P1「同一个分段控件有 2 种实现」）：设置页里还有 **6 处内联按钮组** ——
  `SettingsDialog.vue` 的语言、编辑模式、远程图片、正文字体、PDF 页面尺寸、链接创建。
  **可访问性那一半已经补上**（六组统一 `role="group"` + `aria-label` + 每个按钮 `aria-pressed`，
  读屏器读得出"当前选的是哪一个"）；剩下的是**视觉统一**：换成 `SegmentedControl` 的 quiet 变体。
  组件目前要求每段带 `icon`（`SegmentItem.icon` 必填），而这六组是纯文字分组 ——
  先把 icon 变成可选，再逐组迁移，迁移时记得让 `tests/a11ySemantics.test.mjs` 与
  `_verify-settings-layout.js` 保持绿。

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
- **悬停弹层**（工具栏上的按钮 → 弹出一小块面板）：唯一实现是
  `src/renderer/src/composables/useHoverPopover.ts`（开合时序 300ms 打开 / 180ms 关闭宽限，
  落点纯函数 `planPopoverPos`）。**不要再在组件里自己写计时器与定位** —— 两个工具栏按钮此前
  各写一份逐字相同的实现，改一处忘一处就会让手感分叉；`tests/hoverPopover.test.mjs`
  有去重守卫。弹层里若要键盘路径，用 `openNow()`（立刻打开，不该等 300ms 的悬停延迟）。
- 守卫：`tests/a11ySemantics.test.mjs`（以 mermaid 预览按钮为样例）、`tests/hoverPopover.test.mjs`。

## 9.7 文件树内的「移动到文件夹」

- ✅ 唯一实现：`src/renderer/src/lib/treeMove.ts` 的 `planMove`（纯函数，`tests/treeMove.test.mjs` 守着）
  + `src/renderer/src/stores/files.ts` 的 `moveNode`（走既有的 `file.rename` 通道，目标已存在时拒绝）。
- ✅ 两个入口共用同一条实现：拖行到**文件夹行**（或树里的空白区 = 工作区根），
  以及行右键菜单里的「移动到…」子菜单（`Shift+F10` / 菜单键 → `↓` → `→` → `Enter`，全程键盘）。
- ⚠️ 仍欠账：键盘那条路的候选目录只列**工作区根 + 该项的祖先 + 已经展开过（`dirCache` 里有缓存）的目录** ——
  没点开过的深层目录要先在树里展开一次才能成为候选；跨工作区移动、以及「文件树内任意排序」都不支持
  （排序没有可持久化的位置，一次外部改动 / 重新读盘就打回原形，收益与承诺都不成立）。

## 9.8 新增控件时的检查清单

1. 先在上面找到**已有实现**；找不到再新建，并**在本文件登记**（这一章就是"组件清单"本身）。
2. 交互语义三件套：键盘可达（Tab 顺序 + Enter/Space/方向键）→ 焦点可见（`:focus-visible`）
   → 状态可读（`aria-checked` / `aria-selected` / `aria-pressed` / `aria-expanded`）。
3. 颜色/字号/圆角/层级一律走令牌（`docs/design-tokens.md`），不要写死值。
4. 加了新形态就顺手加一条守卫（`tests/a11ySemantics.test.mjs` / `tests/focusVisibility.test.mjs`），
   否则下一次重构会静默退化 —— 这一章的每一条都是这么攒起来的。
