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
    window.__vt = { pinia, settings: () => pinia._s.get('settings') }
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

  // ── 断言（此前这里只 console.log 观察值、然后 exit 0，于是永远"通过"）──
  const results = []
  const c = (n, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''))
  c('menus-rendered', typeof en === 'string' && typeof zh === 'string' && en.includes('|') && zh.includes('|'), `en=${en} zh=${zh}`)
  c('menu-count-equal', String(en).split('|').length === String(zh).split('|').length, `${String(en).split('|').length} vs ${String(zh).split('|').length}`)
  c('language-switches-text', en !== zh, '两份文字必须不同')
  c('english-pack-applied', /^File\(F\)/.test(String(en)) && /Help/.test(String(en)), String(en).slice(0, 40))
  c('chinese-pack-applied', /^文件\(F\)/.test(String(zh)) && /帮助/.test(String(zh)), String(zh).slice(0, 40))

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(`--- ${results.length - failed}/${results.length} PASS`)

  ws.close()
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.log('FAIL', e.message); try { ws.close() } catch {} process.exit(1) })
