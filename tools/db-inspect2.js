// 深入检查 features.md 的 documents.content
const { DatabaseSync } = require('node:sqlite')
const path = require('path')

const dbPath = path.join(process.env.APPDATA || '', 'lumin', 'lumin.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
const row = db.prepare('SELECT content FROM documents WHERE id = 1').get()
const c = row.content
console.log('content length:', c.length)
console.log('first 300 chars:', JSON.stringify(c.slice(0, 300)))
console.log('contains 所见即所得:', c.includes('所见即所得'))
console.log('contains 所见:', c.includes('所见'))
console.log('contains 表格:', c.includes('表格'))
// 十六进制片段
const idx = c.indexOf('所见')
console.log('hex at 所见:', idx, Buffer.from(c.slice(idx, idx + 12)).toString('hex'))
// LIKE 查询复现
console.log('LIKE:', db.prepare("SELECT id FROM documents WHERE content LIKE '%所%'").all())
console.log('LIKE 见:', db.prepare("SELECT id FROM documents WHERE content LIKE '%见%'").all())
db.close()
