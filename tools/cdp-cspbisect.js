// CSP 指令排查：测试哪种 CSP 配置会阻塞动态 import
async function main() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  const expr = `
(async () => {
  const out = {}
  const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  out.original = m ? m.content.slice(0, 120) : 'NO_META'
  const tryImport = async () => {
    try {
      await import('/node_modules/.vite/deps/pinia.js?v=x' + Math.random())
      return 'ok'
    } catch (e) {
      return 'fail'
    }
  }
  const cases = {
    noScriptSrc: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws:",
    inlineDefault: "default-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    onlyDefault: "default-src 'self'",
    scriptSelfEval: "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'",
    scriptSelfInline: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
  }
  for (const [name, csp] of Object.entries(cases)) {
    m.content = csp
    out[name] = await tryImport()
  }
  return JSON.stringify(out)
})()
`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) {
    console.log('EXC:', r.result.exceptionDetails.exception?.description?.slice(0, 300))
  } else {
    console.log(r.result?.result?.value)
  }
  ws.close()
  process.exit(0)
}
main().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
