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
// 取值口径（改这里必须同步改 style.css 的 `--paper`、`index.html` 的 `--boot-paper`，
// 反之亦然 —— 三处由 tests/themeTokens.test.mjs 逐值钉住）：
//   light  **暖白纸**（#fbfaf6，**不是纯白**）：窗口在渲染层首帧之前露出的就是它，
//          必须与写作区同色；纯白会把启动前那几秒变成刺眼的白屏（用户报障）。
//   dark   中性灰的纸（比外壳 --app=#2b2e33 亮一档，否则侧栏与正文糊在一起）。
//          暗色从近黑（#0b0d12 / #12141a）改成浅灰，是用户口径：不要纯黑、像主流编辑器，
//          且**编辑区比侧栏更浅一点**。
//   sepia  暖纸
export const PAPER_BY_THEME = {
  light: '#fbfaf6',
  dark: '#35383d',
  sepia: '#faf4e4'
} as const

export type PaperTheme = keyof typeof PAPER_BY_THEME

/**
 * 当前该用哪个纸色（主进程建窗时的 `backgroundColor` 用它）。
 *
 * **为什么单独一条纯函数**：这段四分支映射此前写在 `main/index.ts` 的 `themeBackground()` 里，
 * 而它的错误表现很隐蔽 —— 启动瞬间先露出一块别的颜色再被写作区盖住（"闪白"），
 * 只在深色/羊皮纸主题下、且只在启动那一帧可见，人工点几乎抓不到。
 * 现在规则纯化：`theme` 与"系统是否偏好深色"都由调用方取好传进来，`node --test` 直接跑
 *（tests/themeTokens.test.mjs）。
 */
export function paperForTheme(
  theme: 'light' | 'dark' | 'sepia' | 'auto',
  systemPrefersDark: boolean
): string {
  if (theme === 'dark') return PAPER_BY_THEME.dark
  if (theme === 'sepia') return PAPER_BY_THEME.sepia
  if (theme === 'auto') return systemPrefersDark ? PAPER_BY_THEME.dark : PAPER_BY_THEME.light
  return PAPER_BY_THEME.light
}

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
    light: { shell: '#f4f3ee', paper: PAPER_BY_THEME.light, line: 'rgba(16, 24, 40, 0.16)' },
    dark: { shell: '#2b2e33', paper: PAPER_BY_THEME.dark, line: 'rgba(255, 255, 255, 0.24)' },
    sepia: { shell: '#f1e9d5', paper: PAPER_BY_THEME.sepia, line: 'rgba(90, 74, 48, 0.18)' }
  }
