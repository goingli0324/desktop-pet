import { sliceSheet, FRAME_NAMES } from '../shared/sprite-slicer.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024; // 超過就先縮，避免解壓炸彈把 renderer 撐爆
const KEY_SHAPE = /^AIza[0-9A-Za-z_-]{30,}$/; // 只用來提示，不拒絕（Google 可能換格式）
const FRAME_TARGET_HEIGHT = 220; // 與內建貓一致：最高的一格縮到 220px
const FAILURE_NEXT_STEP = { NO_KEY: '', AUTH: '', QUOTA: '　或先改用單張圖模式。' };
const FRAME_LABELS = { walk0: '走 1', walk1: '走 2', walk2: '走 3', walk3: '走 4', idle: '站立', crouch: '蹲下', air: '跳起', land: '落地' };
const $ = (id) => document.getElementById(id);

let source = null;      // { dataUrl, mimeType, base64, image }
let candidate = null;   // { frames: {name: dataUrl}, source: 'ai'|'static', procedural }

// ---- 寵物清單：每張卡片一個數量步進器，總數上限由 main 給 ----
async function renderPets() {
  const { pets, counts, maxTotal } = await window.pet.listPets();
  const list = $('pet-list');
  list.innerHTML = '';
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  $('pet-total').textContent = `桌面上共 ${total} 隻（上限 ${maxTotal}）`;
  if (!pets.length) { list.innerHTML = '<div class="empty">還沒有小動物——往下用「匯入新動物」加一隻</div>'; return; }
  for (const p of pets) {
    const n = counts[p.id] || 0;
    const card = document.createElement('div');
    card.className = 'pet-card' + (n > 0 ? ' current' : '');
    card.innerHTML = `${n > 0 ? `<span class="badge">${n} 隻</span>` : ''}<img alt=""><div class="name"></div>
      <div class="stepper" role="group"><button class="minus" aria-label="少一隻">−</button><input class="count" type="number" min="0" max="${maxTotal}" inputmode="numeric" aria-label="數量"><button class="plus" aria-label="多一隻">＋</button></div>`;
    card.querySelector('img').src = p.thumbnail || '';
    card.querySelector('.name').textContent = p.name;
    card.title = p.name;
    const input = card.querySelector('.count');
    input.value = n;
    const setCount = (v) => window.pet.setPetCount(p.id, v).then(renderPets).catch(showError);
    card.querySelector('.minus').addEventListener('click', () => setCount(n - 1));
    card.querySelector('.plus').addEventListener('click', () => setCount(n + 1));
    input.addEventListener('change', () => setCount(Number(input.value)));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    card.querySelector('img').addEventListener('click', () => setCount(n > 0 ? 0 : 1)); // 點圖：有→無、無→1
    if (p.source !== 'builtin') {
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '✕'; del.title = '刪除'; del.setAttribute('aria-label', `刪除 ${p.name}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`要刪除「${p.name}」嗎？刪掉就找不回來${n > 0 ? '，桌面上的這種會消失' : ''}。`)) window.pet.deletePet(p.id).then(renderPets).catch(showError);
      });
      card.appendChild(del);
    }
    list.appendChild(card);
  }
}

// ---- 匯入 ----
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) return setProgress('圖片超過 10 MB，請換小一點的', 'error');
  try {
    const dataUrl = await readAsDataUrl(file);
    const image = downscaleIfHuge(await loadImage(dataUrl));
    const finalDataUrl = image instanceof HTMLCanvasElement ? image.toDataURL('image/png') : dataUrl;
    source = { dataUrl: finalDataUrl, mimeType: image instanceof HTMLCanvasElement ? 'image/png' : (file.type || 'image/png'), base64: finalDataUrl.split(',')[1], image };
    $('source-img').src = source.dataUrl;
    $('import-preview').classList.remove('hidden');
    $('result').classList.add('hidden');
    if (!$('pet-name').value) $('pet-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 30);
    setProgress('');
  } catch (err) {
    setProgress(`讀不了這張圖：${err.message}`, 'error');
  }
});

$('btn-generate').addEventListener('click', generate);
$('btn-retry').addEventListener('click', generate);
$('btn-static').addEventListener('click', buildStatic);
$('btn-adopt').addEventListener('click', adopt);

async function generate() {
  if (!source) return;
  const { hasKey } = await window.pet.getKeyStatus();
  if (!hasKey) return setProgress('還沒設定 Gemini 金鑰。往下捲到「Gemini 金鑰」貼上金鑰，或改用單張圖模式。', 'error');
  setBusy(true);
  let waited = 0;
  setProgress('正在請 Gemini 畫動作表…（通常 10–30 秒，最多 90 秒）', 'busy');
  const timer = setInterval(() => { waited++; setProgress(`正在請 Gemini 畫動作表… 已等 ${waited} 秒（通常 10–30 秒，最多 90 秒）`, 'busy'); }, 1000);
  try {
    const res = await window.pet.generateSheet({ mimeType: source.mimeType, base64: source.base64 });
    if (!res.ok) return setProgress(`生成失敗：${res.message}${FAILURE_NEXT_STEP[res.code] ?? '　可以再試一次，或改用單張圖模式。'}`, 'error');
    setProgress('切割動作中…');
    const sheet = await loadImage(`data:${res.mimeType};base64,${res.base64}`);
    const { frames, blobCount } = sliceSheet(imageDataOf(sheet), { cols: 4, rows: 2, keyEnclosed: true });
    const filled = frames.filter(Boolean).length;
    if (filled < 6) return setProgress(`動作表切不出來（只找到 ${filled} 個動作）。再生成一次通常就好；或改用單張圖模式。`, 'error');
    candidate = { source: 'ai', procedural: false, frames: normalizeFrames(frames) };
    showResult();
    setProgress(filled === 8 ? '生成完成' : `生成完成（有 ${8 - filled} 格缺漏，已用站立姿勢補上）`, 'ok');
  } catch (err) {
    console.error(err);
    setProgress('處理這張圖時出了問題，可以再試一次或換一張圖。', 'error');
  } finally {
    clearInterval(timer);
    setBusy(false);
  }
}

function buildStatic() {
  if (!source) return;
  try {
    const raw = imageDataOf(source.image);
    let frame;
    if (hasTransparency(raw)) frame = cropToAlpha(raw);          // 已經是去背 PNG，只裁邊
    else if ($('strip-bg').checked) frame = sliceSheet(raw, { cols: 1, rows: 1 }).frames[0];
    if (!frame) frame = raw;
    const dataUrl = toPng(frame, FRAME_TARGET_HEIGHT / frame.height);
    const frames = Object.fromEntries(FRAME_NAMES.map((n) => [n, dataUrl]));
    candidate = { source: 'static', procedural: true, frames };
    showResult();
    setProgress('單張圖模式：走路會上下擺動、跳躍會壓扁拉伸，但四肢不會真的動。', 'ok');
  } catch (err) {
    console.error(err);
    setProgress('處理這張圖時出了問題，可以再試一次或換一張圖。', 'error');
  }
}

function normalizeFrames(frames) {
  const maxH = Math.max(...frames.filter(Boolean).map((f) => f.height));
  const s = FRAME_TARGET_HEIGHT / maxH;
  const out = {};
  FRAME_NAMES.forEach((name, i) => { if (frames[i]) out[name] = toPng(frames[i], s); });
  for (const name of FRAME_NAMES) out[name] ??= out.idle ?? out.walk0;
  return out;
}

function showResult() {
  const box = $('frames');
  box.innerHTML = '';
  for (const name of FRAME_NAMES) {
    const fig = document.createElement('figure');
    fig.innerHTML = '<img alt=""><figcaption></figcaption>';
    fig.querySelector('img').src = candidate.frames[name];
    fig.querySelector('figcaption').textContent = FRAME_LABELS[name];
    box.appendChild(fig);
  }
  $('result').classList.remove('hidden');
  $('btn-retry').classList.toggle('hidden', candidate.source !== 'ai');
}

async function adopt() {
  if (!candidate) return;
  setBusy(true);
  try {
    await window.pet.savePet({ name: $('pet-name').value, source: candidate.source, procedural: candidate.procedural, frames: candidate.frames });
    candidate = null; source = null;
    $('import-preview').classList.add('hidden');
    $('result').classList.add('hidden');
    $('pet-name').value = '';
    setProgress('已加入並切換到新的小動物', 'ok');
    await renderPets();
  } catch (err) {
    setProgress(`儲存失敗：${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

// ---- 金鑰 ----
async function renderKey() {
  const { hasKey, hint } = await window.pet.getKeyStatus();
  const el = $('key-status');
  el.textContent = hasKey ? `已設定金鑰（${hint}）。第一次生成時才會驗證金鑰是否有效。` : '尚未設定金鑰——沒有金鑰仍可用「單張圖」模式';
  el.className = 'status ' + (hasKey ? 'ok' : '');
}
$('btn-key-save').addEventListener('click', async () => {
  const key = $('key-input').value.trim();
  if (!key) return setKeyMsg('請先貼上金鑰');
  if (!KEY_SHAPE.test(key) && !confirm('這串看起來不像 Gemini 金鑰（通常以 AIza 開頭）。仍要儲存嗎？')) return;
  try { await window.pet.setKey(key); $('key-input').value = ''; await renderKey(); } catch (err) { setKeyMsg(err.message); }
});
$('btn-key-clear').addEventListener('click', async () => { await window.pet.clearKey(); await renderKey(); });
$('key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-key-save').click(); });
$('link-key').addEventListener('click', (e) => { e.preventDefault(); window.pet.openExternal('https://aistudio.google.com/apikey'); });
$('link-logs').addEventListener('click', (e) => { e.preventDefault(); window.pet.openLogs(); });
function setKeyMsg(msg) { const el = $('key-status'); el.textContent = msg; el.className = 'status error'; }

// ---- 顯示 ----
async function renderState(s) {
  s ??= await window.pet.getState();
  $('scale').value = s.scale;
  $('scale-val').textContent = `${Math.round(s.scale * 100)}%`;
  $('paused').checked = !!s.paused;
}
$('scale').addEventListener('input', () => { $('scale-val').textContent = `${Math.round($('scale').value * 100)}%`; });
$('scale').addEventListener('change', () => window.pet.setScale(Number($('scale').value)));
$('paused').addEventListener('change', () => window.pet.setPaused($('paused').checked));
window.pet.onStateChanged(renderState);
window.pet.onPetsChanged(renderPets);

// ---- 工具 ----
function setProgress(msg, kind = '') {
  const el = $('progress');
  el.textContent = msg;
  el.className = 'status ' + kind + (msg ? '' : ' hidden');
}
function showError(err) { setProgress(err.message || String(err), 'error'); }
function setBusy(busy) {
  for (const id of ['btn-generate', 'btn-static', 'btn-adopt', 'btn-retry', 'file', 'pet-name', 'strip-bg', 'btn-key-save', 'btn-key-clear']) $(id).disabled = busy;
  document.querySelector('main').toggleAttribute('aria-busy', busy);
}
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('讀檔失敗')); r.readAsDataURL(file); });
}
function loadImage(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('不是可用的圖片')); img.src = src; });
}
/** 超過 MAX_PIXELS 的圖先縮成 canvas 回傳；否則原圖回傳。 */
function downscaleIfHuge(img) {
  const px = img.naturalWidth * img.naturalHeight;
  if (px <= MAX_PIXELS) return img;
  const s = Math.sqrt(MAX_PIXELS / px);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function imageDataOf(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth ?? img.width; c.height = img.naturalHeight ?? img.height;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  return cx.getImageData(0, 0, c.width, c.height);
}
function hasTransparency({ data }) {
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) return true;
  return false;
}
function cropToAlpha({ width, height, data }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}
/** 把 {width,height,data} 以比例 s 縮放後輸出 PNG data URL。 */
function toPng(frame, s) {
  const src = document.createElement('canvas');
  src.width = frame.width; src.height = frame.height;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(frame.width * s)); out.height = Math.max(1, Math.round(frame.height * s));
  const cx = out.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// 拖檔案進視窗不可導覽成該檔（安全審查 M1）
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault());

renderPets(); renderKey(); renderState();
