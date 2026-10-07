// 重設 demo 實例 admin 密碼
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'trade.sqlite'), { timeout: 10000 });
const { hashPassword } = require(path.join(__dirname, 'dist-server', 'lib', 'auth'));
const h = hashPassword('admin123');
const r = db.prepare('UPDATE users SET password_hash=? WHERE emp_id=?').run(h, 'admin');
console.log('updated rows:', r.changes);
db.close();
