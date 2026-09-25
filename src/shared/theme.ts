// ─── 三主题的「纸」色（写作区背景）────────────────────────────────────────────
//
// **唯一事实来源是 `src/renderer/src/assets/style.css` 里的 `--paper`**（按主题各一份）。
// 这里镜像一份只为一个消费方：主进程创建窗口时要给 `backgroundColor`（见 main/index.ts 的
// `themeBackground()`），而主进程读不到渲染层的 CSS。窗口底色若与纸色不一致，启动瞬间会先
// 露出一块别的颜色再被写作区盖住（就是「防闪白」要解决的那一下）。
//
// 两边各自漂移是这类镜像的典型死法，所以 `tests/themeTokens.test.mjs` 把本文件与 style.css
// 钉在一起（逐主题比对 + 三主题的表面不变量），任何一边改了纸色忘了另一边，`npm run ci` 就红。
//
// 取值口径（改这里必须同步改 style.css 的 `--paper`，反之亦然）：
//   light  **纯白**（用户口径：浅色主题下写作区要纯白；代价是与 --panel/--elevate 同色，
//          面板改由 1px 边框 + 投影立起来）
//   dark   中性灰的纸（比外壳 --app=#2b2e33 亮一档，否则侧栏与正文糊在一起）。
//          暗色从近黑（#0b0d12 / #12141a）改成浅灰，是用户口径：不要纯黑、像 Typora，
//          且**编辑区比侧栏更浅一点**。
//   sepia  暖纸
export const PAPER_BY_THEME = {
  light: '#ffffff',
  dark: '#35383d',
  sepia: '#faf4e4'
} as const

export type PaperTheme = keyof typeof PAPER_BY_THEME

// ─── 设置页「主题缩略图」的颜色（小样机）─────────────────────────────────────
//
// 那张缩略图以前把三套色**写死在组件里**，于是成了第二份真值，而且已经漂了：
// 深色样机画的是近黑（`#0f1116` / `#16181f`），而深色主题早就按用户口径改成中性灰
// （`--app #2b2e33` / `--paper #35383d`）—— 用户按缩略图选"深色"，选到的却是另一种深色。
// 现在 `paper` 直接引用 `PAPER_BY_THEME`，`shell` 与 CSS 的 `--app` 由
// `tests/themeTokens.test.mjs` 逐主题对账（单测穷举，组件里就不再出现字面色值）。
//
// `line` = 样机窗口里那两条"文字线"与边框：它压在**那个主题自己的纸上**，
// 所以深色要用白线、浅色/暖纸用黑线（单测按"线的合成色对纸 ≥ 1.1:1"守住"看得见"）。
export const PREVIEW_BY_THEME: Record<PaperTheme, { shell: string; paper: string; line: string }> =
  {
    light: { shell: '#fafafa', paper: PAPER_BY_THEME.light, line: 'rgba(16, 24, 40, 0.16)' },
    dark: { shell: '#2b2e33', paper: PAPER_BY_THEME.dark, line: 'rgba(255, 255, 255, 0.24)' },
    sepia: { shell: '#f1e9d5', paper: PAPER_BY_THEME.sepia, line: 'rgba(90, 74, 48, 0.18)' }
  }
