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
//   light  近白但**不是纯白**（#fcfcfb：减眩，纯白留给浮在纸上的 --panel / --elevate）
//   dark   深色纸（比外壳 --app=#0b0d12 亮一档，否则侧栏与正文糊在一起）
//   sepia  暖纸
export const PAPER_BY_THEME = {
  light: '#fcfcfb',
  dark: '#12141a',
  sepia: '#faf4e4'
} as const

export type PaperTheme = keyof typeof PAPER_BY_THEME
