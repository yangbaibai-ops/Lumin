'use strict'
// ─── 验收：视觉尺度的**运行时**那一半（字号令牌 + 圆角档位真的落到计算样式上）──────
//
// 与 `tests/visualScale.test.mjs`（静态闭集）配套：静态检查能证明"源码里没有新档位"，
// 证明不了"写进模板的令牌类真的生成并生效"（Tailwind 的类名拼错时**静静不生成任何规则**，
// 元素会退回继承字号 —— 上一轮的 z-index 就是这么踩到 `auto` 的）。
//
// 覆盖：
//   V1 `:root` 上能读到 `--text-ui`(12.5px) / `--text-ui-sm`(12px)（Tailwind 的 @theme 会把它发成自定义属性）
//   V2 带 `text-ui` 的元素计算字号 = 12.5px
//   V3 带 `text-ui-sm` 的元素计算字号 = 12px
//   V4 设置页里**所有**元素的计算字号都落在文档化的界面档位里（继承/em 系的编辑器区不在这一页）
//   V5 设置页里所有元素的计算圆角都落在圆角档位里（含 Tailwind 命名档的展开值）
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')

/** 与 tests/visualScale.test.mjs 的档位表一致（+ Tailwind 命名档展开出来的值） */
const TEXT_TIERS = ['9.5px', '10.5px', '11px', '11.5px', '12px', '12.5px', '13px', '13.5px', '14px', '14.5px', '15px', '18px', '28px']
/**
 * 运行时还会看到 `16px`：那是**没有显式字号**的元素从 `body` 继承来的浏览器默认值（1rem），
 * 不是谁写下的档位 —— 所以它只出现在这份运行时清单里，不进源码档位表
 * （静态表要求"每一档都有人在用"，把继承默认值混进去会让那张表失去意义）。
 */
const TEXT_TIERS_RUNTIME = [...TEXT_TIERS, '16px']
const RADIUS_TIERS = [
  '0px',
  '2px',
  '3px',
  '4px',
  '5px',
  '6px',
  '7px',
  '8px',
  '9px',
  '10px',
  '12px',
  '16px',
  '22px',
  '50%',
  '999px',
  '9999px'
]

async function main() {
  const app = await connect()
  const { ev } = app
  if (!(await settle(ev))) throw new Error('实例未进入就绪状态')
  const report = new Reporter('视觉尺度：字号令牌与圆角档位（运行时）')

  const tokens = JSON.parse(
    await ev(`(() => {
      const cs = getComputedStyle(document.documentElement)
      return JSON.stringify({
        ui: cs.getPropertyValue('--text-ui').trim(),
        uiSm: cs.getPropertyValue('--text-ui-sm').trim()
      })
    })()`)
  )
  report.check(
    'V1 :root 上能读到 --text-ui(12.5px) / --text-ui-sm(12px)',
    tokens.ui === '12.5px' && tokens.uiSm === '12px',
    JSON.stringify(tokens)
  )

  // 打开设置页：整页都是界面尺度（没有正文排版那套 em），适合当"档位闭集"的样本
  const probe = JSON.parse(
    await ev(`(async () => {
    window.__L.ui().openSettings()
    for (let i = 0; i < 40 && !document.querySelector('[data-settings-page]'); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const page = document.querySelector('[data-settings-page]')
    /**
     * 令牌类的验证**在探测元素上做**，不依赖"页面上正好有这样用的元素"：
     * 新建一个 span、换类名、读计算字号 —— 这直接回答"这条工具类有没有生成、生效吗"。
     * （实测教训：套件刚起来时外壳还没挂载，用选择器找 .text-ui 会拿到 null，
     *  于是 V2/V3 假红成 undefined。）
     */
    const probeEl = document.createElement('span')
    document.body.appendChild(probeEl)
    probeEl.className = 'text-ui'
    const uiSize = getComputedStyle(probeEl).fontSize
    probeEl.className = 'text-ui-sm'
    const uiSmSize = getComputedStyle(probeEl).fontSize
    probeEl.remove()
    const fonts = {}
    const radii = {}
    for (const el of page ? page.querySelectorAll('*') : []) {
      const cs = getComputedStyle(el)
      fonts[cs.fontSize] = (fonts[cs.fontSize] ?? 0) + 1
      if (cs.borderTopLeftRadius !== '0px' || cs.borderRadius !== '0px') {
        const r = cs.borderTopLeftRadius
        radii[r] = (radii[r] ?? 0) + 1
      }
    }
    const out = {
      uiSize,
      uiSmSize,
      uiCount: document.querySelectorAll('.text-ui').length,
      uiSmCount: document.querySelectorAll('.text-ui-sm').length,
      fonts: Object.keys(fonts).sort(),
      radii: Object.keys(radii).sort(),
      who16: page
        ? [...page.querySelectorAll('*')]
            .filter((el) => getComputedStyle(el).fontSize === '16px')
            .slice(0, 4)
            .map((el) => el.tagName + ' [' + String(el.className).slice(0, 60) + ']')
        : []
    }
    window.__L.ui().closeSettings()
    return JSON.stringify(out)
  })()`)
  )
  report.note('probe ' + JSON.stringify(probe))
  report.check('V2 带 text-ui 的元素计算字号 = 12.5px', probe.uiSize === '12.5px', String(probe.uiSize))
  report.check('V3 带 text-ui-sm 的元素计算字号 = 12px', probe.uiSmSize === '12px', String(probe.uiSmSize))

  const badFonts = (probe.fonts ?? []).filter((v) => !TEXT_TIERS_RUNTIME.includes(v))
  report.check(
    'V4 设置页里所有计算字号都在文档化档位里',
    badFonts.length === 0,
    `档位外的值：${badFonts.join(', ')}（档位表见 tests/visualScale.test.mjs）`
  )

  const badRadii = (probe.radii ?? []).filter((v) => !RADIUS_TIERS.includes(v))
  report.check(
    'V5 设置页里所有计算圆角都在文档化档位里',
    badRadii.length === 0,
    `档位外的值：${badRadii.join(', ')}`
  )

  await sleep(200)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
