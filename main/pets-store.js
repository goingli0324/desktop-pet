import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { FRAME_NAMES } from '../renderer/shared/sprite-slicer.js';
import { log } from './log.js';

// 寵物與設定都是純檔案：
//   userData/pets/<id>/pet.json + <frame>.png
//   userData/settings.json  { counts: { <petId>: n }, scale, paused }   ← 舊版 currentPetId 讀取時自動轉成 counts
// pet.json schema： { id, name, source: 'builtin'|'ai'|'static', procedural: boolean, frames: { walk0..land: '<file>.png' }, createdAt }
// 所有幀都可指向同一個檔（static 來源就是這樣）。

const BUILTIN_ID = 'builtin-cat';
const DEFAULT_SETTINGS = { counts: { [BUILTIN_ID]: 1 }, scale: 0.55, paused: false };
export const MAX_TOTAL_PETS = 99;

const petsDir = () => path.join(app.getPath('userData'), 'pets');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const builtinRoot = () => path.join(app.getAppPath(), 'assets', 'builtin');

/** 清掉 userData 裡「已不再隨 app 出貨」的內建寵物（例如舊版收斂/改名的），並從 counts 移除。只動 builtin-*，不碰使用者匯入的 pet-*。 */
function pruneRemovedBuiltins() {
  if (!fs.existsSync(petsDir())) return;
  const shipped = new Set(fs.readdirSync(builtinRoot())
    .filter((a) => fs.existsSync(path.join(builtinRoot(), a, 'pet.json')))
    .map((a) => JSON.parse(fs.readFileSync(path.join(builtinRoot(), a, 'pet.json'), 'utf8')).id));
  let counts = null;
  for (const id of fs.readdirSync(petsDir())) {
    if (!id.startsWith('builtin-') || shipped.has(id)) continue;
    const dir = path.join(petsDir(), id);
    if (path.dirname(dir) !== petsDir()) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    counts = counts || { ...readSettings().counts };
    delete counts[id];
  }
  if (counts) { if (!Object.keys(counts).length) counts[BUILTIN_ID] = 1; updateSettings({ counts }); }
}

/** 把 assets/builtin/<animal>/ 全部複製進 userData（已存在的不覆蓋，使用者可能改過名）。 */
export function ensureBuiltinPets() {
  pruneRemovedBuiltins();
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
  let s;
  try { s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { s = { ...DEFAULT_SETTINGS }; }
  if (!s.counts || typeof s.counts !== 'object') s.counts = { [s.currentPetId || BUILTIN_ID]: 1 }; // 舊版設定轉換
  delete s.currentPetId;
  return s;
}

/** 設定某隻的數量；總數超過 MAX_TOTAL_PETS 會被夾住。全部歸零時退回內建貓 1 隻。 */
export function setPetCount(id, n) {
  const s = readSettings();
  if (!readPetMeta(id)) throw new Error('找不到這隻寵物');
  const others = Object.entries(s.counts).filter(([k]) => k !== id).reduce((sum, [, v]) => sum + v, 0);
  const next = Math.max(0, Math.min(Math.floor(Number(n) || 0), MAX_TOTAL_PETS - others));
  const counts = { ...s.counts };
  if (next > 0) counts[id] = next; else delete counts[id];
  if (!Object.keys(counts).length) counts[BUILTIN_ID] = 1;
  return updateSettings({ counts });
}

/** 給 overlay 用：所有數量 > 0 的寵物，含幀與數量。 */
export function loadActivePets() {
  const { counts } = readSettings();
  const active = [];
  for (const [id, count] of Object.entries(counts)) {
    const pet = loadPet(id);
    if (pet && count > 0) active.push({ ...pet, count });
  }
  if (!active.length) { const cat = loadPet(BUILTIN_ID); if (cat) active.push({ ...cat, count: 1 }); }
  return active;
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

/** 整隻寵物含所有幀的 data URL。 */
export function loadPet(id) {
  const meta = readPetMeta(id);
  if (!meta) return null;
  const frames = {};
  const sizes = {};
  for (const name of FRAME_NAMES) {
    const file = meta.frames[name] || meta.frames.idle;
    frames[name] = frameDataUrl(meta.id, file);
    sizes[name] = pngSize(meta.id, file);
  }
  return { id: meta.id, name: meta.name, source: meta.source, procedural: !!meta.procedural, frames, sizes };
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
  const counts = { ...readSettings().counts };
  delete counts[id];
  if (!Object.keys(counts).length) counts[BUILTIN_ID] = 1;
  updateSettings({ counts });
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

function pngSize(id, file) {
  try {
    const fd = fs.openSync(path.join(petsDir(), id, path.basename(file)), 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  } catch { return [100, 100]; }
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
