# 设计令牌（Design tokens）

本文件里的令牌表**由脚本生成**，不要手改：改令牌请改
`src/renderer/src/assets/theme.css`（或 `sidebar.css`），然后跑

```powershell
npm run docs:tokens:write
```

- 令牌是**颜色与层级唯一的真相**：组件里写 `var(--name)`，不要写死色值。
- 三个主题（light / dark / sepia）各自的取值都能在下面看到；
  对比度门禁见 `tests/colorRelations.test.mjs` 与 §8 的对比度表。
- `npm run docs:tokens:check` 在 CI 里守着"表与 CSS 一致"。
- **叠放层级（`--z-*`）是主题无关的**，所以它们在 `theme.css` 单独那段 `:root` 里（不参与三个主题块的
  集合比对）。顺序就是规格：`--z-grip(20) < --z-chip(30) < --z-dialog(70) < --z-tooltip(90)
  < --z-popover(100) < --z-page(120) < --z-search(140) < --z-modal(150) < --z-modal-sub(151)
  < --z-critical(160) < --z-critical-sub(161) < --z-editor-menu(170) < --z-editor-menu-sub(171)
  < --z-tooltip-global(9999)`。两条门禁守着它：
  `tests/zIndexStack.test.mjs`（不许再有数字字面量、顺序严格递增、令牌都有出处）与
  `tools/_verify-zorder.js`（真实浮层的**计算样式**确实是这些数字，顺序也在运行时成立）。
  容器内部的局部叠放仍可用 Tailwind 自己的 `z-10/z-50`（作用域只有那个容器）。
- **界面字号**：主力两档已收成 Tailwind 令牌 `text-ui`（12.5px，原 `text-[12.5px]` 40 处）与
  `text-ui-sm`（12px，原 28 处）—— 共 **68 处**任意值类变成语义类（px 一个都没改）。
  其余各档仍是字面量，但**档位是闭集**：`tests/visualScale.test.mjs` 守着"源码里不许出现表外字号 /
  表内不许有没人用的档"与"任意值类总数只减不增（本轮 220 → 152）"；
  `tools/_verify-visual-scale.js` 守运行时那一半（令牌类真的生成、计算字号与圆角都落在档位表里，
  设置页整页抽检）。正文排版那一套是 em（相对 `--editor-size`），不属于界面档位。

<!-- tokens:begin（由 tools/doc-tokens.js 生成，勿手改）-->

| 口径 | 值 |
|---|---|
| 定义令牌的文件 | `src/renderer/src/assets/theme.css` / `src/renderer/src/assets/sidebar.css` |
| 声明块 | 7 个 |
| 令牌总数 | 194 |
| 重复定义（同一声明块内） | 0 |

> 这张表由 `node tools/doc-tokens.js --write` 生成，`npm run docs:tokens:check` 校验；
> 消费令牌的写法是 `var(--name)`，**不要在组件里写死颜色**（§8「token 未覆盖的硬编码色」）。

### src/renderer/src/assets/theme.css

**:root, .theme-light**（第 6 行起，48 个）

| 令牌 | 值 |
|---|---|
| `--app` | `#f4f3ee` |
| `--paper` | `#fbfaf6` |
| `--panel` | `#ffffff` |
| `--panel-2` | `#e9e8e2` |
| `--elevate` | `#ffffff` |
| `--edge` | `#e3e2dc` |
| `--edge-strong` | `#d2d1ca` |
| `--ink` | `#20242b` |
| `--ink-2` | `#4e5766` |
| `--ink-3` | `#7d8595` |
| `--ink-2b` | `#606977` |
| `--code-str` | `#166534` |
| `--code-num` | `#92400e` |
| `--code-com` | `#626a76` |
| `--code-invalid` | `#b91c1c` |
| `--accent` | `#6b7280` |
| `--accent-2` | `#4b5563` |
| `--accent-soft` | `rgba(17, 24, 39, 0.07)` |
| `--accent-ink` | `#374151` |
| `--link` | `#1f57dd` |
| `--toc-link` | `var(--link)` |
| `--marker` | `#a4aab4` |
| `--danger` | `#dc2626` |
| `--warning` | `#d97706` |
| `--ok` | `#16a34a` |
| `--danger-ink` | `#b91c1c` |
| `--warning-ink` | `#92400e` |
| `--ok-ink` | `#166534` |
| `--glow` | `rgba(17, 24, 39, 0.12)` |
| `--code-bg` | `#f1f0ea` |
| `--sel` | `rgba(17, 24, 39, 0.11)` |
| `--block-hover` | `rgba(17, 24, 39, 0.04)` |
| `--find-hit-bg` | `#fdecd5` |
| `--find-hit-ink` | `inherit` |
| `--find-current-bg` | `#ffcf8f` |
| `--find-current-ink` | `inherit` |
| `--find-current-edge` | `rgb(214 154 74 / 55%)` |
| `--btn-solid` | `#4b5563` |
| `--btn-solid-2` | `#374151` |
| `--btn-ink` | `#ffffff` |
| `--control-on` | `#6b7280` |
| `--control-ink` | `#ffffff` |
| `--scrim` | `rgba(16, 24, 40, 0.32)` |
| `--code-key` | `#3f6592` |
| `--code-key-2` | `#2b6f8f` |
| `--shadow-1` | `0 1px 2px rgba(16, 24, 40, 0.06)` |
| `--shadow-2` | `0 8px 28px rgba(16, 24, 40, 0.1)` |
| `--img-selected-filter` | `brightness(0.88) saturate(0.65)` |

**.theme-dark**（第 73 行起，48 个）

| 令牌 | 值 |
|---|---|
| `--app` | `#2b2e33` |
| `--paper` | `#35383d` |
| `--panel` | `#3a3d43` |
| `--panel-2` | `#44484f` |
| `--elevate` | `#454a51` |
| `--edge` | `#4a4d54` |
| `--edge-strong` | `#5b606a` |
| `--ink` | `#e6e8ec` |
| `--ink-2` | `#b6bbc3` |
| `--ink-3` | `#949aa6` |
| `--ink-2b` | `#b6bbc3` |
| `--code-str` | `#4ade80` |
| `--code-num` | `#fbbf24` |
| `--code-com` | `#9aa3ad` |
| `--code-invalid` | `#f87171` |
| `--accent` | `#9aa0aa` |
| `--accent-2` | `#7d838d` |
| `--accent-soft` | `rgba(255, 255, 255, 0.09)` |
| `--accent-ink` | `#e2e5ea` |
| `--link` | `#84c1f9` |
| `--toc-link` | `var(--link)` |
| `--marker` | `#6e747d` |
| `--danger` | `#f87171` |
| `--warning` | `#fbbf24` |
| `--ok` | `#4ade80` |
| `--danger-ink` | `#fca5a5` |
| `--warning-ink` | `#fcd34d` |
| `--ok-ink` | `#86efac` |
| `--glow` | `rgba(255, 255, 255, 0.1)` |
| `--code-bg` | `#303338` |
| `--sel` | `rgba(255, 255, 255, 0.18)` |
| `--block-hover` | `rgba(255, 255, 255, 0.06)` |
| `--find-hit-bg` | `rgb(102 175 233 / 32%)` |
| `--find-hit-ink` | `#eef2f8` |
| `--find-current-bg` | `#3576b0` |
| `--find-current-ink` | `#ffffff` |
| `--find-current-edge` | `rgb(120 190 240 / 60%)` |
| `--btn-solid` | `#5a616d` |
| `--btn-solid-2` | `#464d58` |
| `--btn-ink` | `#f3f4f6` |
| `--control-on` | `#6b7280` |
| `--control-ink` | `#e6e8ec` |
| `--scrim` | `rgba(0, 0, 0, 0.45)` |
| `--code-key` | `#8ab4e8` |
| `--code-key-2` | `#7fc4e0` |
| `--shadow-1` | `0 1px 2px rgba(0, 0, 0, 0.35)` |
| `--shadow-2` | `0 10px 32px rgba(0, 0, 0, 0.5)` |
| `--img-selected-filter` | `brightness(0.92) saturate(0.65)` |

**.theme-sepia**（第 134 行起，48 个）

| 令牌 | 值 |
|---|---|
| `--app` | `#f1e9d5` |
| `--paper` | `#faf4e4` |
| `--panel` | `#fdf8ec` |
| `--panel-2` | `#e9dfc4` |
| `--elevate` | `#fdf8ec` |
| `--edge` | `#e5d8ba` |
| `--edge-strong` | `#d6c6a0` |
| `--ink` | `#4a3b2a` |
| `--ink-2` | `#6b5b40` |
| `--ink-3` | `#8a7a61` |
| `--ink-2b` | `#6f5f45` |
| `--code-str` | `#166534` |
| `--code-num` | `#92400e` |
| `--code-com` | `#6b5b40` |
| `--code-invalid` | `#b91c1c` |
| `--accent` | `#857a66` |
| `--accent-2` | `#6f6555` |
| `--accent-soft` | `rgba(90, 74, 48, 0.09)` |
| `--accent-ink` | `#5c5140` |
| `--link` | `#1d4ed8` |
| `--toc-link` | `var(--link)` |
| `--marker` | `#b3a894` |
| `--danger` | `#b91c1c` |
| `--warning` | `#b45309` |
| `--ok` | `#15803d` |
| `--danger-ink` | `#991b1b` |
| `--warning-ink` | `#92400e` |
| `--ok-ink` | `#166534` |
| `--glow` | `rgba(90, 74, 48, 0.12)` |
| `--code-bg` | `#efe4c9` |
| `--sel` | `rgba(90, 74, 48, 0.14)` |
| `--block-hover` | `rgba(90, 74, 48, 0.05)` |
| `--find-hit-bg` | `#f3dfae` |
| `--find-hit-ink` | `inherit` |
| `--find-current-bg` | `#e9b96a` |
| `--find-current-ink` | `inherit` |
| `--find-current-edge` | `rgb(160 112 40 / 55%)` |
| `--btn-solid` | `#6b5c46` |
| `--btn-solid-2` | `#57492f` |
| `--btn-ink` | `#fdf8ec` |
| `--control-on` | `#8a7f6b` |
| `--control-ink` | `#fdf8ec` |
| `--scrim` | `rgba(74, 59, 42, 0.34)` |
| `--code-key` | `#456088` |
| `--code-key-2` | `#266480` |
| `--shadow-1` | `0 1px 2px rgba(97, 74, 32, 0.08)` |
| `--shadow-2` | `0 8px 28px rgba(97, 74, 32, 0.14)` |
| `--img-selected-filter` | `brightness(0.9) saturate(0.72)` |

**:root**（第 197 行起，15 个）

| 令牌 | 值 |
|---|---|
| `--z-raise` | `1` |
| `--z-grip` | `20` |
| `--z-chip` | `30` |
| `--z-dialog` | `70` |
| `--z-tooltip` | `90` |
| `--z-popover` | `100` |
| `--z-page` | `120` |
| `--z-search` | `140` |
| `--z-modal` | `150` |
| `--z-modal-sub` | `151` |
| `--z-critical` | `160` |
| `--z-critical-sub` | `161` |
| `--z-editor-menu` | `170` |
| `--z-editor-menu-sub` | `171` |
| `--z-tooltip-global` | `9999` |

**@theme**（第 226 行起，4 个）

| 令牌 | 值 |
|---|---|
| `--font-sans` | `'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif` |
| `--font-mono` | `'JetBrains Mono', ui-monospace, 'Cascadia Code', 'SF Mono', Consolas, Menlo, monospace` |
| `--text-ui` | `12.5px` |
| `--text-ui-sm` | `12px` |

**@theme inline**（第 237 行起，24 个）

| 令牌 | 值 |
|---|---|
| `--color-app` | `var(--app)` |
| `--color-paper` | `var(--paper)` |
| `--color-panel` | `var(--panel)` |
| `--color-panel-2` | `var(--panel-2)` |
| `--color-elevate` | `var(--elevate)` |
| `--color-edge` | `var(--edge)` |
| `--color-edge-strong` | `var(--edge-strong)` |
| `--color-ink` | `var(--ink)` |
| `--color-ink-2` | `var(--ink-2)` |
| `--color-ink-2b` | `var(--ink-2b)` |
| `--color-ink-3` | `var(--ink-3)` |
| `--color-accent` | `var(--accent)` |
| `--color-accent-2` | `var(--accent-2)` |
| `--color-accent-soft` | `var(--accent-soft)` |
| `--color-accent-ink` | `var(--accent-ink)` |
| `--color-danger` | `var(--danger)` |
| `--color-warning` | `var(--warning)` |
| `--color-ok` | `var(--ok)` |
| `--color-danger-ink` | `var(--danger-ink)` |
| `--color-warning-ink` | `var(--warning-ink)` |
| `--color-ok-ink` | `var(--ok-ink)` |
| `--color-scrim` | `var(--scrim)` |
| `--color-control-on` | `var(--control-on)` |
| `--color-control-ink` | `var(--control-ink)` |


### src/renderer/src/assets/sidebar.css

**[data-tree-root]**（第 4 行起，7 个）

| 令牌 | 值 |
|---|---|
| `--tree-pad` | `4px` |
| `--tree-indent` | `16px` |
| `--tree-slot` | `14px` |
| `--tree-slot-pull` | `2px` |
| `--tree-gap` | `6px` |
| `--tree-icon` | `15px` |
| `--tree-rail` | `color-mix(in srgb, var(--ink-3) 38%, transparent)` |

<!-- tokens:end -->
