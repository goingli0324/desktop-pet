import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { FRAME_NAMES } from '../renderer/shared/sprite-slicer.js';
import { log } from './log.js';

// 寵物與設定都是純檔案：
//   userData/pets/<id>/pet.json + <frame>.png
//   userData/settings.json  { currentPetId, scale, paused }
// pet.json schema： { id, name, source: 'builtin'|'ai'|'static', procedural: boolean, frames: { walk0..land: '<file>.png' }, createdAt }
// 所有幀都可指向同一個檔（static 來源就是這樣）。

const BUILTIN_ID = 'builtin-cat';
const DEFAULT_SETTINGS = { currentPetId: BUILTIN_ID, scale: 0.55, paused: false };

const petsDir = () => path.join(app.getPath('userData'), 'pets');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const builtinRoot = () => path.join(app.getAppPath(), 'assets', 'builtin');

/** 把 assets/builtin/<animal>/ 全部複製進 userData（已存在的不覆蓋，使用者可能改過名）。 */
export function ensureBuiltinPets() {
  for (const animal of fs.readdirSync(builtinRoot())) {
    const src = path.join(builtinRoot(), animal);
    if (!fs.existsSync(path.join(src, 'pet.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(src, 'pet.json'), 'utf8'));
    const dest = path.join(petsDir(), meta.id);
    if (fs.existsSync(path.join(dest, 'pet.json'))) continue;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, f));
    writeJson(path.join(dest, 'pet.json'), { procedural: false, createdAt: new Date().toISOString(), ...meta });
  }
}

export function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; }
}

export function updateSettings(patch) {
  const next = { ...readSettings(), ...patch };
  writeJson(settingsFile(), next);
  return next;
}

export function listPets() {
  if (!fs.existsSync(petsDir())) return [];
  const pets = [];
  for (const id of fs.readdirSync(petsDir())) {
    if (!fs.statSync(path.join(petsDir(), id)).isDirectory()) continue; // 略過 .DS_Store 之類
    const meta = readPetMeta(id);
    if (meta) pets.push({ id: meta.id, name: meta.name, source: meta.source, createdAt: meta.createdAt, thumbnail: frameDataUrl(id, meta.frames.idle) });
  }
  const rank = (p) => (p.source === 'builtin' ? 0 : 1);
  return pets.sort((a, b) => rank(a) - rank(b) || (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/** 給 overlay 用：整隻寵物含所有幀的 data URL。 */
export function loadPet(id) {
  const meta = readPetMeta(id) || readPetMeta(BUILTIN_ID);
  if (!meta) return null;
  const frames = {};
  for (const name of FRAME_NAMES) frames[name] = frameDataUrl(meta.id, meta.frames[name] || meta.frames.idle);
  return { id: meta.id, name: meta.name, source: meta.source, procedural: !!meta.procedural, frames };
}

/**
 * @param {{ name: string, source: 'ai'|'static', procedural: boolean, frames: Record<string, string> }} pet frames 值是 PNG data URL
 */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = 0x89504e47;

export function savePet(pet) {
  if (!['ai', 'static'].includes(pet?.source)) throw new Error('source 只能是 ai 或 static');
  if (!pet.frames || typeof pet.frames !== 'object') throw new Error('frames 格式錯誤');
  const id = `pet-${Date.now().toString(36)}`;
  const dir = path.join(petsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const frames = {};
  for (const name of FRAME_NAMES) {
    const dataUrl = pet.frames[name] || pet.frames.idle;
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new Error(`幀 ${name} 不是 PNG data URL`);
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 8 || buf.length > MAX_FRAME_BYTES || buf.readUInt32BE(0) !== PNG_MAGIC) throw new Error(`幀 ${name} 不是有效 PNG 或超過 2 MB`);
    fs.writeFileSync(path.join(dir, `${name}.png`), buf);
    frames[name] = `${name}.png`;
  }
  const meta = { id, name: sanitizeName(pet.name), source: pet.source, procedural: !!pet.procedural, frames, createdAt: new Date().toISOString() };
  writeJson(path.join(dir, 'pet.json'), meta);
  return meta;
}

export function deletePet(id) {
  if (readPetMeta(id)?.source === 'builtin') throw new Error('內建寵物不能刪');
  const dir = path.join(petsDir(), id);
  if (path.dirname(dir) !== petsDir()) throw new Error('非法 id');
  fs.rmSync(dir, { recursive: true, force: true });
  if (readSettings().currentPetId === id) updateSettings({ currentPetId: BUILTIN_ID });
}

function readPetMeta(id) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(petsDir(), id, 'pet.json'), 'utf8'));
    if (!meta.frames?.idle) return null;
    return meta;
  } catch (err) {
    if (err.code !== 'ENOENT') log('error', 'pet.json 壞掉', { id, message: err.message });
    return null;
  }
}

function frameDataUrl(id, file) {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(petsDir(), id, path.basename(file))).toString('base64')}`;
  } catch {
    return null;
  }
}

function sanitizeName(name) {
  const n = String(name || '').replace(/\p{C}/gu, '').trim().slice(0, 30);
  return n || '未命名小動物';
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
