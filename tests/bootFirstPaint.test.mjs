// ─── 首帧不许再有「启动遮罩 / 骨架屏」────────────────────────────────────────
//
// 背景：用户报障「打开应用依然有启动遮罩层和骨架图」。查下来有两层：
//   1. Vue 的 `SkeletonScreen`（`ui.booting` 期间盖一层，已在 App.vue 里删掉）；
//   2. **`index.html` 里那段纯 HTML/CSS 首帧骨架屏**（`.lm-boot`：假顶栏 + 假侧栏 + 假正文 +
//      居中的「LUMIN」呼吸字，`@keyframes lm-breathe`）—— 它在 window 第一帧就可见，
//      直到 Vue 挂载才被替换。用 CDP 抓启动帧实测：`+561ms` 时整窗就是它（`fullCovers: ["lm-boot"]`）。
//
// 这条单测守的就是第 2 层：`index.html` 里不许再出现骨架屏标记或它的呼吸动画。
// 为什么用单测守而不是 CDP：Vue 挂载后那棵子树已被替换，DOM 断言**抓不到它**；
// 真正能钉住的是「文件里根本不写」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8')

test('首帧 index.html 不含启动骨架屏/遮罩（打开应用直接是正常界面）', () => {
  // 注释里可以提到历史，所以只查**真正的标记与样式**
  assert.equal(/class="lm-boot/.test(HTML), false, 'index.html 里不该再有 .lm-boot 骨架标记')
  assert.equal(/@keyframes\s+lm-breathe/.test(HTML), false, '呼吸动画 keyframes 应一并删除')
  assert.equal(/<style[\s>]/.test(HTML), false, 'index.html 不该再内联首帧样式（骨架屏那套已移除）')
  assert.ok(/<div id="app"><\/div>/.test(HTML), '#app 应当是个空容器，由 Vue 填充')
})
