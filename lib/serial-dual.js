'use strict';

const { str } = require('./util');
const { db } = require('./db-dual');

/** Generate a sequence inside the caller's transaction for SQLite/MySQL parity. */
async function nextSerial(tx, prefixKey, seqKey, prefixDef) {
  const lock = db.raw.getActive() === 'secondary' ? ' FOR UPDATE' : '';
  const prefixRow = await tx.prepare(`SELECT value FROM parameters WHERE \`key\`=?${lock}`).get(prefixKey);
  const seqRow = await tx.prepare(`SELECT value FROM parameters WHERE \`key\`=?${lock}`).get(seqKey);
  const prefix = prefixRow ? str(prefixRow.value) : prefixDef;
  const seq = Number(seqRow ? seqRow.value : 0) + 1;
  if (seqRow) {
    await tx.prepare("UPDATE parameters SET value=?, updated_at=datetime('now','localtime') WHERE `key`=?").run(String(seq), seqKey);
  } else {
    await tx.prepare('INSERT INTO parameters (`key`,value) VALUES (?,?)').run(seqKey, String(seq));
  }
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${prefix}${ym}${String(seq).padStart(4, '0')}`;
}

module.exports = { nextSerial };
