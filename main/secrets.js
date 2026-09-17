import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { log } from './log.js';

// Gemini 金鑰只存這裡：safeStorage 加密後寫 userData/gemini.key。
// 不進 settings.json、不進 log、不回傳明文給 renderer（只回「有沒有」與尾四碼）。
// 加密不可用時拒存（不寫明文）；檔案在但解不開時視同「沒有」，並記一筆 log 方便排錯。
const keyFile = () => path.join(app.getPath('userData'), 'gemini.key');

export function readKey() {
  if (!fs.existsSync(keyFile())) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch (err) {
    log('error', 'gemini.key 無法解密（換過簽章或 Keychain 拒絕？請重新貼一次金鑰）', { message: err.message });
    return null;
  }
}

export function hasKey() {
  return readKey() !== null;
}

export function keyHint() {
  const key = readKey();
  return key ? `…${key.slice(-4)}` : null;
}

export function writeKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('金鑰是空的');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('這台電腦目前無法加密儲存金鑰（Keychain／DPAPI 不可用），暫不儲存。');
  fs.writeFileSync(keyFile(), safeStorage.encryptString(trimmed), { mode: 0o600 });
}

export function clearKey() {
  try { fs.unlinkSync(keyFile()); } catch { /* 本來就沒有 */ }
}
