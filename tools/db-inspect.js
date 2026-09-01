// 直接检查 lumin.db：FTS 表结构 + 查询诊断
const { DatabaseSync } = require('node:sqlite')
const os = require('os')
const path = require('path')

const dbPath = path.join(process.env.APPDATA || '', 'lumin', 'lumin.db')
const db = new DatabaseSync(dbPath, { readOnly: true })

console.log('== fts schema ==')
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='documents_fts'").get().sql)
console.log('== fts count ==')
console.log(db.prepare('SELECT COUNT(*) c FROM documents_fts').get())
console.log('== fts rows (title) ==')
console.log(
  db.prepare('SELECT rowid, substr(title,1,20) t, length(content) len FROM documents_fts').all()
)
console.log('== documents ==')
console.log(db.prepare('SELECT id, path, word_count FROM documents').all())
const q = '"所见即所得"'
try {
  console.log('== trigram match', q, '==')
  console.log(db.prepare('SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?').all(q))
} catch (e) {
  console.log('MATCH error:', e.message)
}
try {
  console.log('== trigram match 所见 ==')
  console.log(db.prepare('SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?').all('"所见"'))
} catch (e) {
  console.log('MATCH2 error:', e.message)
}
console.log('== LIKE check ==')
console.log(
  db.prepare("SELECT id, path FROM documents WHERE content LIKE '%所见即所得%' OR title LIKE '%所见即所得%'").all()
)
console.log('== content slice ==')
const row = db.prepare('SELECT content FROM documents WHERE content LIKE ?').get('%所见即所得%')
console.log(row ? row.content.slice(0, 120) : 'NOT FOUND IN documents!')
db.close()
