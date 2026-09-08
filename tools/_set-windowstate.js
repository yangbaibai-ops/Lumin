// 写入测试用的 windowState（验证启动恢复逻辑）
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const dbPath = path.join(process.env.APPDATA || '', 'lumin', 'lumin.db')
const db = new DatabaseSync(dbPath)
db.prepare(
  `INSERT INTO kv (key, value, updated_at) VALUES ('windowState', ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
).run(JSON.stringify({ x: 120, y: 80, width: 1050, height: 720, isMaximized: false }), Date.now())
console.log('set windowState')
db.close()
