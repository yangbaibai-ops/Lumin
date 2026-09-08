// 读取 SQLite kv 中的 windowState（窗口位置/大小持久化），普通连接以正确读取 WAL
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const dbPath = path.join(process.env.APPDATA || '', 'lumin', 'lumin.db')
const db = new DatabaseSync(dbPath)
const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('windowState')
console.log(row ? row.value : 'NO windowState')
db.close()
