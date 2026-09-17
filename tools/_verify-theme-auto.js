'use strict'
// 验收：主题切换的 CSS 落地（显式三主题 + 跟随系统 auto）
//
// 这支套件原来是一支**0 断言探针**：只 console.log 状态、从不判定，跑完永远绿
// （run-suites 以退出码为准，所以它此前等于没跑）。现在改成真断言：
//
//   A. 三套显式主题各自把 `theme-*` 类落到 <html>，settings.resolveTheme() 与之一致
//   A2 深色主题同时带 `dark` 类（原生控件配色走它），浅色/sepia 不带
//   B. 「纸比外壳（chrome）亮一档」在**每个**主题下都成立（两段式不变量，见 lib/color.js）
//   B2 三套主题的纸互不相同 —— 切主题必须真的换纸，而不是只换原生标题栏
//   C1 auto：CSS 主题 = prefers-color-scheme 的答案（历史 bug 正是「只有标题栏跟着系统变」）
//   C2 实时跟随：**不写设置**、只改媒体特性，CSS 主题也要跟上（走 useAppActions 的监听）。
//      注意：本环境的 CDP 媒体模拟只改 matches、不派发 change 事件 ⇒ 这条会自动记 SKIP
//      （不当假绿，也不假装验证过）。
//   C2b 不依赖事件：媒体偏好变了以后显式 applyAll() 必须跟到新值 —— 这条守的是
//      「主题解析被 Pinia getter 缓存钉死」那个坑（缓存会让监听形同虚设）
//   C3 显式主题 → auto：切过去的那一刻就要跟对（历史 bug 的场景）
//   收尾：把调用者的主题设置还原
const { connect, settle, sleep, Reporter, fatal } = require('./lib/harness')
const { contrast, rgbText, rat } = require('./lib/color')

const PROBE = `(() => {
  const tok = (n) => {
    const p = document.createElement('span')
    p.style.color = 'var(' + n + ')'
    document.body.appendChild(p)
    const v = getComputedStyle(p).color
    p.remove()
    return v
  }
  const s = window.__L.settings()
  return JSON.stringify({
    theme: s.theme,
    effective: s.resolveTheme(),
    cls: [...document.documentElement.classList].find((c) => c.startsWith('theme-')) || null,
    darkFlag: document.documentElement.classList.contains('dark'),
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    paper: tok('--paper'),
    chrome: tok('--app')
  })
})()`

async function main() {
  const report = new Reporter('主题：显式三主题 + 跟随系统（auto）')
  const app = await connect()
  if (!(await settle(app.ev))) {
    report.skip('app-ready', '应用未就绪')
    return report.finish()
  }
  const read = async () => JSON.parse(await app.ev(PROBE))
  const setTheme = async (t) => {
    await app.ev(
      `(async () => { await window.__L.settings().setTheme(${JSON.stringify(t)}); return 'ok' })()`
    )
    await sleep(600)
  }
  const backup = (await read()).theme

  // ── A/B. 三套显式主题 ─────────────────────────────────────────────────────
  const seen = {}
  for (const th of ['light', 'dark', 'sepia']) {
    await setTheme(th)
    seen[th] = await read()
    report.note(
      `${th}: class=${seen[th].cls} effective=${seen[th].effective} ` +
        `paper=${rgbText(seen[th].paper)} chrome=${rgbText(seen[th].chrome)} ` +
        `纸/壳=${rat(contrast(seen[th].paper, seen[th].chrome))}:1`
    )
  }
  report.check(
    'A 显式主题落到 <html> 的类上，且 resolveTheme() 一致',
    Object.entries(seen).every(([th, s]) => s.cls === `theme-${th}` && s.effective === th),
    JSON.stringify(Object.entries(seen).map(([th, s]) => `${th}:${s.cls}/${s.effective}`))
  )
  report.check(
    'A2 只有深色主题带 dark 类（原生控件配色）',
    seen.dark.darkFlag === true && seen.light.darkFlag === false && seen.sepia.darkFlag === false,
    JSON.stringify({
      light: seen.light.darkFlag,
      dark: seen.dark.darkFlag,
      sepia: seen.sepia.darkFlag
    })
  )
  report.check(
    'B 纸比外壳（chrome）亮一档 —— 三主题都成立',
    Object.values(seen).every((s) => contrast(s.paper, s.chrome) >= 1.03),
    JSON.stringify(
      Object.entries(seen).map(([th, s]) => `${th}:${rat(contrast(s.paper, s.chrome))}:1`)
    )
  )
  report.check(
    'B2 三套主题的纸互不相同（切主题真的换了纸）',
    new Set(Object.values(seen).map((s) => rgbText(s.paper))).size === 3,
    JSON.stringify(Object.entries(seen).map(([th, s]) => `${th}:${rgbText(s.paper)}`))
  )

  // ── C. auto 跟随系统 ─────────────────────────────────────────────────────
  // 先切到 dark 再切 auto：历史 bug 的场景（auto 沿用上一个显式主题的 themeSource，
  // CSS 停在深色、只有原生标题栏变浅）。这里钉的是「CSS 主题 = 媒体查询的答案」。
  await setTheme('dark')
  await setTheme('auto')
  const autoReal = await read()
  report.check(
    'C1 auto：CSS 主题 = prefers-color-scheme 的答案（切主题后仍成立）',
    autoReal.prefersDark
      ? autoReal.cls === 'theme-dark' && autoReal.effective === 'dark'
      : autoReal.cls === 'theme-light' && autoReal.effective === 'light',
    JSON.stringify(autoReal)
  )

  const emulate = async (want) => {
    await app.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: want }]
    })
    await sleep(600)
  }

  // 探针 MQL：用来判断「本环境到底派不派发 change 事件」。
  // ⚠️ 实测（Electron 39 的 CDP）：`Emulation.setEmulatedMedia` 会让 `matchMedia().matches`
  //    立刻翻转，却**不派发** change 事件 —— 于是 useAppActions 里那条监听根本不会被触发。
  //    真机 OS 切换走的是派发路径，所以这里必须把「环境不派发」和「应用没跟上」分开记，
  //    否则这条断言会随环境随机红（实测同一份代码一次绿一次红）。
  await app.ev(`(() => {
    window.__mqEvents = 0
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => { window.__mqEvents += 1 })
    return 'ok'
  })()`)
  const mqEvents = () => app.ev('window.__mqEvents')

  // C2 实时跟随：只改媒体特性、**不写设置** —— 走的是 useAppActions 里对
  // prefers-color-scheme 的监听（它调 applyAll）。解析若被缓存钉死，这条必红。
  for (const want of ['dark', 'light']) {
    const expected = `theme-${want}`
    await emulate(want)
    const st = await read()
    if (st.prefersDark !== (want === 'dark')) {
      report.skip(
        `C2 实时跟随 ${want}（不写设置）`,
        `CDP 媒体模拟未生效（prefersDark=${st.prefersDark}）`
      )
      continue
    }
    const events = await mqEvents()
    if (st.cls === expected) {
      report.check(
        `C2 实时跟随：媒体特性切到 ${want}（不写设置）后 CSS 主题跟上`,
        true,
        JSON.stringify({ class: st.cls, events })
      )
    } else {
      // 环境不支持就如实 SKIP，不去赌一次随机绿：
      //   · events===0：CDP 只改 matches、不派发 change 事件（监听路径根本没被触发）；
      //   · events>0 ：事件派发了，但 CDP 的颜色方案覆盖与 matchMedia 的求值不同步 ——
      //     监听回调里现读的媒体值还是旧的（真机 OS 切换没有这个不同步）。
      // 真正守着「解析不再吃缓存」的是下一条 C2b（不依赖事件、不依赖同步时机）。
      report.skip(
        `C2 实时跟随 ${want}（不写设置）`,
        events === 0
          ? 'CDP 媒体模拟不派发 change 事件 ⇒ 监听路径无从验证（真机 OS 切换才派发）'
          : `CDP 媒体模拟的 change 事件与 matchMedia 求值不同步（events=${events}）⇒ 环境限制，见 C2b`
      )
    }
    // C2b 不依赖事件的那一半：媒体偏好变了以后，**显式** applyAll() 必须跟到新值。
    //     这条正是「主题解析被 Pinia getter 缓存钉死」那个坑的回归守卫（解析改成现算）。
    const applied = JSON.parse(
      await app.ev(`(() => {
        window.__L.settings().applyAll()
        return JSON.stringify({
          cls: [...document.documentElement.classList].find((c) => c.startsWith('theme-')) || null
        })
      })()`)
    )
    report.check(
      `C2b applyAll 现算：媒体偏好为 ${want} 时 applyAll() 跟到 ${expected}（不吃缓存）`,
      applied.cls === expected,
      JSON.stringify({ class: applied.cls, expected })
    )
  }

  // C3 显式主题 → auto：切换那一刻就要跟对（不是等下一次写设置）
  for (const want of ['dark', 'light']) {
    const expected = `theme-${want}`
    await emulate(want)
    await setTheme('dark') // 先落一个显式主题，制造「上一个 themeSource」的场景
    await setTheme('auto')
    const st = await read()
    if (st.prefersDark !== (want === 'dark')) {
      report.skip(
        `C3 显式 → auto 切到 ${want}`,
        `CDP 媒体模拟未生效（prefersDark=${st.prefersDark}）`
      )
      continue
    }
    report.check(
      `C3 显式主题 → auto 后跟到 ${want}`,
      st.cls === expected && st.effective === want,
      JSON.stringify({ class: st.cls, effective: st.effective })
    )
  }

  // ── 收尾：还原调用者的设置与媒体模拟 ─────────────────────────────────────
  await app.send('Emulation.setEmulatedMedia', { features: [] })
  await setTheme(backup)
  app.close()
  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
