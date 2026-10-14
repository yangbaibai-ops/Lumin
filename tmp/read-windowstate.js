'use strict'
// 读用户真实实例的 windowState（窗口尺寸/最大化），用于复现用户看到的排版
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const dbPath = path.join(process.env.APPDATA || '', 'Lumin', 'lumin.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE '%window%'").all()
for (const r of rows) console.log(r.key, '=', r.value)
db.close()
