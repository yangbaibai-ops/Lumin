// ─── 让 Node 的 ESM 解析器认出「无扩展名的相对 import」───────────────────────────
//
// 背景：`src` 里两种写法混用 —— 一部分模块写 `import … from './tableAlign.ts'`，
// 另一部分写 `'./tableAlign'`。后者在 electron-vite / tsc 下没问题，但 `node --test`
// 走的是 Node 原生 ESM 解析：**相对说明符必须带扩展名**，于是那些模块在单测里根本
// import 不进来（`Cannot find module … imported from …`）。这是它们长期零引用的
// 原因之一 —— 不是"不值得测"，而是"测不动"。
//
// 这里装一个 resolve 钩子（Node 24 的 `module.registerHooks`，同步版本）：只把
// 「以 `.` 开头、自己没写 `.ts/.js` 扩展名、而同级确实存在同名 `.ts` 文件」的说明符补成
// `.ts`，其余一律交回默认解析。**不动 src**，只在测试进程里生效，也不改命令行。
//
// ⚠️ 钩子必须在**链接目标模块之前**装好；而 ESM 的静态 `import` 在任何语句执行前就完成
// 链接，所以用到它的测试要写：
//
//     import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'
//     installTsExtensionResolve()
//     const mod = await import('../src/main/services/launchIntent.ts')
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 已经写了扩展名（.ts/.js/.mjs/.cjs/.mts/.cts）的说明符不用管 */
const HAS_EXT_RE = /\.[cm]?[jt]s$/

export function installTsExtensionResolve() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && !HAS_EXT_RE.test(specifier)) {
        try {
          const candidate = new URL(`${specifier}.ts`, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, shortCircuit: true }
          }
        } catch {
          /* 解析不出来就落回默认路径 */
        }
      }
      return nextResolve(specifier, context)
    }
  })
}
