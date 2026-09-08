// 独立复现 printToPDF：隐藏窗口 + data URL + printToPDF，验证导出链路本身是否可用。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      width: 960,
      height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true }
    })
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff"),url(fonts/KaTeX_Main-Regular.ttf) format("truetype")}' +
      'body{font-size:14px;font-family:KaTeX_Main,sans-serif}' +
      '</style></head>' +
      '<body><h1>测试标题 H1</h1><p>hello world 中文内容 123</p><pre>code block</pre></body></html>'
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    console.log('url length:', url.length)
    await win.loadURL(url)
    await win.webContents.executeJavaScript(
      'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : Promise.resolve(true)'
    )
    await new Promise((r) => setTimeout(r, 250))
    const data = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      landscape: false,
      margins: { top: 0.94, bottom: 0.94, left: 0.94, right: 0.94 }
    })
    console.log('PDF bytes:', data.length)
    fs.writeFileSync('tools/_test.pdf', data)
    console.log('OK')
    app.exit(0)
  } catch (e) {
    console.error('ERROR:', e && e.message ? e.message : e)
    console.error('STACK:', e && e.stack ? e.stack : '')
    app.exit(1)
  }
})
