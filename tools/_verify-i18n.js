// 验证 i18n：切换语言后顶部菜单文字随之变化。
const CDP = 'http://127.0.0.1:9222/json'
let ws
let id = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function send(method, params) { return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }) }
async function ev(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }

const getMenus = `(() => [...document.querySelectorAll('.topmenu-root > button')].map(b => b.textContent.trim()).join('|'))()`

async function main() {
  const targets = await (await fetch(CDP)).json()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await send('Page.enable')
  await send('Page.bringToFront')

  await ev(`(() => {
    const app = document.querySelector('#app')?.__vue_app__
    const prov = app?._context.provides
    const sym = Object.getOwnPropertySymbols(prov).find((s) => { const p = prov[s]; return !!p && typeof p === 'object' && p._s instanceof Map })
    const pinia = (sym ? prov[sym] : null)
    window.__vt = { pinia, settings: () => pinia._s.get('settings'), ui: () => pinia._s.get('ui') }
    return 'OK'
  })()`)

  await ev(`(() => { window.__vt.settings().setLanguage('en-US'); return 'ok' })()`)
  await sleep(600)
  const en = await ev(getMenus)
  console.log('menu EN:', en)

  await ev(`(() => { window.__vt.settings().setLanguage('zh-CN'); return 'ok' })()`)
  await sleep(600)
  const zh = await ev(getMenus)
  console.log('menu ZH:', zh)

  // ── 设置页整页无残留中文（审计 §10 的实际症状：en/ru 用户打开设置页看到整页中文）──
  // 语言选择器里那三枚按钮显示的是**语言自称**（简体中文 / English / Русский），
  // 按母语显示是国际惯例，所以按文本白名单跳过；其余任何可见中文都算漏接线。
  const scanSettings = `(() => {
    const page = document.querySelector('[data-settings-page]')
    if (!page) return JSON.stringify({ error: 'no-settings-page' })
    const skip = new Set(['简体中文', 'English', 'Русский', '中文', 'EN', 'RU'])
    const bad = []
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || '').trim()
      if (!text || skip.has(text)) continue
      const el = node.parentElement
      // 不可见的不算：折叠块（details）里没展开的、以及别的页签，本来就不在屏幕上
      if (!el || el.getClientRects().length === 0) continue
      if (/[\\u3400-\\u4dbf\\u4e00-\\u9fff]/.test(text)) bad.push(text.slice(0, 40))
    }
    return JSON.stringify({ bad, count: bad.length })
  })()`
  const TABS = ['general', 'editor', 'appearance', 'export', 'links', 'keymap']
  const scanAllTabs = async (lang) => {
    await ev(`window.__vt.settings().setLanguage('${lang}')`)
    await sleep(800)
    const perTab = {}
    for (const tab of TABS) {
      await ev(`window.__vt.ui().openSettings('${tab}')`)
      await sleep(450)
      perTab[tab] = JSON.parse(await ev(scanSettings))
    }
    return perTab
  }
  const enScan = await scanAllTabs('en-US')
  const ruScan = await scanAllTabs('ru-RU')
  await ev(`(() => { window.__vt.ui().closeSettings(); return 'ok' })()`)
  await sleep(300)
  await ev(`(() => { window.__vt.settings().setLanguage('zh-CN'); return 'ok' })()`)
  await sleep(500)

  const badList = (scan) =>
    Object.entries(scan).flatMap(([tab, r]) => (r.bad ?? []).map((t) => `${tab}: ${t}`))
  const enBad = badList(enScan)
  const ruBad = badList(ruScan)
  const pageMissing = TABS.some((t) => enScan[t].error || ruScan[t].error)

  // ── 断言（此前这里只 console.log 观察值、然后 exit 0，于是永远"通过"）──
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  c('menus-rendered', typeof en === 'string' && typeof zh === 'string' && en.includes('|') && zh.includes('|'), `en=${en} zh=${zh}`)
  c('menu-count-equal', String(en).split('|').length === String(zh).split('|').length, `${String(en).split('|').length} vs ${String(zh).split('|').length}`)
  c('language-switches-text', en !== zh, '两份文字必须不同')
  c('english-pack-applied', /^File\(F\)/.test(String(en)) && /Help/.test(String(en)), String(en).slice(0, 40))
  c('chinese-pack-applied', /^文件\(F\)/.test(String(zh)) && /帮助/.test(String(zh)), String(zh).slice(0, 40))
  c('settings-page-opened', pageMissing === false, JSON.stringify({ en: enScan.general, ru: ruScan.general }).slice(0, 120))
  c('settings-en-has-no-cjk', enBad.length === 0, JSON.stringify(enBad.slice(0, 8)))
  c('settings-ru-has-no-cjk', ruBad.length === 0, JSON.stringify(ruBad.slice(0, 8)))
  // 每个页签都要量到东西：全空（比如 data-settings-page 选择器写错）不能算通过
  const seenText = Object.values(enScan).every((r) => r.error === undefined)
  c('settings-tabs-rendered', seenText, JSON.stringify(Object.keys(enScan)))

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)

  ws.close()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
