// 清除 demo 實例 admin 鎖定
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'trade.sqlite'), { timeout: 10000 });

// 找與鎖定相關的欄位/表
const cols = db.prepare('PRAGMA table_info(users)').all();
console.log('users 欄位:', cols.map(c => c.name).join(', '));

// 嘗試常見鎖定欄位
for (const col of ['failed_attempts', 'login_attempts', 'locked_until', 'lock_until', 'failed_login_count']) {
  if (cols.some(c => c.name === col)) {
    const r = db.prepare(`UPDATE users SET ${col} = 0 WHERE emp_id = 'admin'`).run();
    console.log(`已清 ${col}:`, r.changes);
  }
}

// login_attempts 表
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
if (tables.includes('login_attempts')) {
  const r = db.prepare("DELETE FROM login_attempts WHERE emp_id='admin' OR username='admin'").run();
  console.log('已清 login_attempts:', r.changes);
} else if (tables.includes('auth_attempts')) {
  const r = db.prepare("DELETE FROM auth_attempts").run();
  console.log('已清 auth_attempts:', r.changes);
}
db.close();
