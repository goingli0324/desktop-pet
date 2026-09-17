import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

// 只記錯誤與重要事件；正常運作安靜（見記憶 ui-quiet-unless-problem）。
export function logDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_LOG_BYTES = 1024 * 1024;

export function log(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}${extra ? ' ' + safeJson(extra) : ''}\n`;
  if (level === 'error') process.stderr.write(line);
  try {
    const file = path.join(logDir(), 'app.log');
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, line);
  } catch { /* 寫不進去就算了，不能因為 log 讓 app 掛 */ }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
