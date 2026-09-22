'use strict'
// ─── 「不要产出未验证的平台包」闸门（自查报告 S5）──────────────────────────────
//
// 背景：`package.json` 里一直留着 `build:mac` / `build:linux`，README 也写明
// 「mac/linux 未做过运行验证、跨平台打磨明确暂缓」。但脚本本身是**能跑**的 ——
// 谁顺手执行一次，就会得到一个看起来正常、实际没人验证过的安装包，
// 比"没有脚本"更危险（会有人把它发出去）。
//
// 所以把这两个脚本改成**直接失败并指向文档**：要真的做跨平台，先把验证流程补上，
// 再把 electron-builder 调用接回来。
const target = process.argv[2] ?? '(unknown)'

console.error(
  [
    `✖ 不构建 ${target} 包：本项目的 ${target} 目标**未做过运行验证**。`,
    '',
    '原因（README「平台现状」与 docs/optimization-program.md 的「明确不建议做的」）：',
    '  * 已实测可交付的是 Windows；任务栏 / 快捷方式 / 安装器体验也都按 Windows 做；',
    '  * electron-builder.yml 里 mac/linux 段存在，但从未跑过完整验证；',
    '  * 产出一个"看起来能用"的包会让人误以为它被验证过。',
    '',
    `如果你确实要做 ${target}：先按 docs/optimization-program.md 补一套验证流程，`,
    '然后把 package.json 里的 build:mac / build:linux 改回',
    `  "build:${target}": "npm run build && electron-builder --${target}"`,
    '并在 README 的「平台现状」里更新结论。'
  ].join('\n')
)
process.exit(1)
