// 桌面覆蓋層：狀態機 + 繪圖 + 點擊穿透切換。
// 座標系：寵物的 (x, y) 是「腳底中心」的邏輯像素位置，畫面座標 = 視窗座標。

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

// ---- 可調參數（集中在這裡，改行為改這裡）----
const ACTION_WEIGHTS = { walk: 5, run: 2, hop: 4, sleep: 1 };
const WALK_SPEED = [60, 110];   // px/s
const RUN_SPEED = [180, 260];
const WALK_FPS = 7;
const RUN_FPS = 13;
const IDLE_SECONDS = [2, 6];
const SLEEP_SECONDS = [8, 15];
const HOP = { crouch: 0.14, air: 0.42, land: 0.16, height: [40, 90], distance: [0, 140], drift: [-120, 120], count: [1, 3] }; // drift：每跳的垂直位移
const WALK_MAX_ANGLE = 20 * Math.PI / 180; // 走／跑只走接近水平的路線；側面圖直上直下會像滑行，垂直移動交給跳躍
const WALK_BOB_PX = 3;                      // 所有寵物走路時的小起伏，讓腳步讀得出來
const MIN_TRAVEL = 120;         // 隨機目標點與現位至少相距這麼遠
const MAX_DT = 0.1;             // 失焦 / 休眠回來時避免瞬移
const PROCEDURAL = { bobPx: 6, tiltRad: 0.10, squash: 0.12 }; // 單張圖降級動畫的幅度（取代 WALK_BOB_PX）

// ---- 狀態 ----
let pet = null;          // { id, frames: {name: HTMLImageElement}, procedural }
let scale = 0.55;
let paused = false;
let facing = 1;          // 1 右、-1 左
let pos = { x: 300, y: 300 };
let state = { name: 'idle', t: 0, dur: 3 };
let hover = false;
let ignoringMouse = true;
let drag = null;         // { dx, dy }
let cursor = null;       // 最後已知游標位置；寵物走開時也要重算 hover
let last = performance.now();

// ---- 初始化 ----
resize();
window.addEventListener('resize', resize);
loadPet(await window.pet.getCurrentPet());
applyState(await window.pet.getState());
window.pet.onPetChanged(loadPet);
window.pet.onStateChanged(applyState);
requestAnimationFrame(tick);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clampToScreen();
}

function applyState(s) {
  if (!s) return;
  scale = s.scale ?? scale;
  paused = !!s.paused;
}

async function loadPet(data) {
  if (!data) return;
  const frames = {};
  await Promise.all(Object.entries(data.frames).map(([name, url]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { frames[name] = img; resolve(); };
    img.onerror = () => resolve(); // 缺幀就用 idle 補（見 frame()）
    img.src = url;
  })));
  if (!frames.idle) return;
  pet = { id: data.id, frames, procedural: !!data.procedural };
  pos = { x: rand(200, window.innerWidth - 200), y: rand(200, window.innerHeight - 100) };
  clampToScreen();
  enter('idle');
}

// ---- 狀態機 ----
function enter(name, extra = {}) {
  state = { name, t: 0, ...extra };
  if (name === 'idle') state.dur = rand(...IDLE_SECONDS);
  if (name === 'sleep') state.dur = rand(...SLEEP_SECONDS);
}

function pickNextAction() {
  const total = Object.values(ACTION_WEIGHTS).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [name, w] of Object.entries(ACTION_WEIGHTS)) { r -= w; if (r <= 0) return name; }
  return 'walk';
}

function startAction(name) {
  if (name === 'walk' || name === 'run') {
    const target = randomTarget();
    const speed = name === 'walk' ? rand(...WALK_SPEED) : rand(...RUN_SPEED);
    facing = target.x >= pos.x ? 1 : -1;
    enter(name, { target, speed });
  } else if (name === 'hop') {
    const count = Math.round(rand(...HOP.count));
    const dir = Math.random() < 0.5 ? -1 : 1;
    facing = dir;
    enter('hop', { phase: 'crouch', hopsLeft: count, height: rand(...HOP.height), dist: rand(...HOP.distance) * dir, drift: rand(...HOP.drift), from: { ...pos } });
  } else {
    enter('sleep');
  }
}

function randomTarget() {
  const { w, h } = petSize();
  const xMin = w / 2, xMax = window.innerWidth - w / 2, yMin = h, yMax = window.innerHeight;
  for (let i = 0; i < 30; i++) {
    const x = rand(xMin, xMax);
    const dx = x - pos.x;
    if (Math.abs(dx) < MIN_TRAVEL) continue;
    const y = pos.y + Math.abs(dx) * Math.tan(rand(-WALK_MAX_ANGLE, WALK_MAX_ANGLE));
    if (y >= yMin && y <= yMax) return { x, y };
  }
  return { x: pos.x < (xMin + xMax) / 2 ? xMax : xMin, y: pos.y }; // 抽不到就往遠的那一側水平走
}

function update(dt) {
  state.t += dt;
  switch (state.name) {
    case 'idle':
    case 'sleep':
      if (state.t >= state.dur) startAction(pickNextAction());
      break;
    case 'walk':
    case 'run': {
      const dx = state.target.x - pos.x, dy = state.target.y - pos.y;
      const d = Math.hypot(dx, dy);
      const step = state.speed * dt;
      if (d <= step) { pos = { ...state.target }; enter('idle'); break; }
      pos.x += (dx / d) * step; pos.y += (dy / d) * step;
      break;
    }
    case 'hop': {
      const phase = HOP[state.phase];
      if (state.phase === 'air') {
        const p = Math.min(1, state.t / HOP.air);
        pos = { x: state.from.x + state.dist * p, y: state.from.y + state.drift * p };
        clampToScreen();
      }
      if (state.t < phase) break;
      state.t = 0;
      if (state.phase === 'crouch') { state.phase = 'air'; state.from = { ...pos }; }
      else if (state.phase === 'air') state.phase = 'land';
      else if (--state.hopsLeft > 0) { state.phase = 'crouch'; state.dist = rand(...HOP.distance) * facing; state.drift = rand(...HOP.drift); }
      else enter('idle');
      break;
    }
    case 'land':
      if (state.t >= HOP.land) enter('idle');
      break;
    case 'dragged':
      break;
  }
}

// ---- 繪圖 ----
function currentFrame() {
  const f = pet.frames;
  const pick = (name) => f[name] || f.idle;
  switch (state.name) {
    case 'walk': return pick(`walk${Math.floor(state.t * WALK_FPS) % 4}`);
    case 'run': return pick(`walk${Math.floor(state.t * RUN_FPS) % 4}`);
    case 'hop': return pick(state.phase === 'air' ? 'air' : state.phase === 'crouch' ? 'crouch' : 'land');
    case 'land': return pick('land');
    case 'dragged': return pick('air');
    default: return pick('idle');
  }
}

/** 畫面上的額外位移／變形：跳躍高度、呼吸、單張圖降級的擺動。 */
function poseTransform() {
  let lift = 0, sx = 1, sy = 1, rot = 0;
  if (state.name === 'hop') {
    if (state.phase === 'air') { const p = state.t / HOP.air; lift = state.height * 4 * p * (1 - p); }
    if (state.phase === 'crouch' || state.phase === 'land') { sy = 1 - PROCEDURAL.squash; sx = 1 + PROCEDURAL.squash; }
    if (state.phase === 'air' && pet.procedural) { sy = 1 + PROCEDURAL.squash; sx = 1 - PROCEDURAL.squash; }
  }
  if (state.name === 'idle') { sy += 0.02 * Math.sin(state.t * Math.PI); }
  if (state.name === 'sleep') { sy += 0.03 * Math.sin(state.t * Math.PI * 0.6); }
  if (state.name === 'walk' || state.name === 'run') {
    const hz = state.name === 'walk' ? 3 : 6;
    lift = Math.abs(Math.sin(state.t * Math.PI * hz)) * (pet.procedural ? PROCEDURAL.bobPx : WALK_BOB_PX);
    if (pet.procedural) rot = Math.sin(state.t * Math.PI * hz) * PROCEDURAL.tiltRad;
  }
  if (state.name === 'dragged') rot = Math.sin(state.t * 6) * 0.08;
  return { lift, sx, sy, rot };
}

function petSize() {
  const img = pet ? currentFrame() : null;
  return img ? { w: img.naturalWidth * scale, h: img.naturalHeight * scale } : { w: 100, h: 100 };
}

function petBounds() {
  const { w, h } = petSize();
  const { lift } = poseTransform();
  return { x0: pos.x - w / 2, y0: pos.y - h - lift, x1: pos.x + w / 2, y1: pos.y - lift };
}

function draw() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (!pet) return;
  const img = currentFrame();
  const { w, h } = petSize();
  const { lift, sx, sy, rot } = poseTransform();
  ctx.save();
  ctx.translate(pos.x, pos.y - lift);
  ctx.rotate(rot * facing);
  ctx.scale(facing * sx, sy);
  ctx.drawImage(img, -w / 2, -h, w, h);
  ctx.restore();
  if (state.name === 'sleep') drawZzz(pos.x + w * 0.35 * facing, pos.y - h - 6);
}

function drawZzz(x, y) {
  const phase = (state.t % 2) / 2;
  ctx.save();
  ctx.font = `${Math.round(14 + 10 * scale)}px sans-serif`;
  ctx.fillStyle = `rgba(80,80,120,${0.9 - phase * 0.8})`;
  ctx.fillText('z', x + phase * 10, y - phase * 24);
  ctx.fillText('Z', x + 12 + phase * 10, y - 14 - phase * 24);
  ctx.restore();
}

function tick(now) {
  const dt = Math.min(MAX_DT, (now - last) / 1000);
  last = now;
  if (pet && !paused && state.name !== 'dragged') update(dt);
  else if (pet) state.t += dt;
  refreshHover();           // 游標沒動、寵物自己走開時也要恢復穿透
  draw();
  requestAnimationFrame(tick);
}

function clampToScreen() {
  if (!pet) return;
  const { w, h } = petSize();
  pos.x = Math.min(Math.max(pos.x, w / 2), Math.max(w / 2, window.innerWidth - w / 2));
  pos.y = Math.min(Math.max(pos.y, h), Math.max(h, window.innerHeight));
}

// ---- 滑鼠：穿透切換與拖拉 ----
function inside(p, b) { return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1; }

function setIgnore(ignore) {
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  window.pet.setIgnoreMouse(ignore);
}

function refreshHover() {
  if (!pet || drag || !cursor) return;
  const h = inside(cursor, petBounds());
  if (h === hover) return;
  hover = h;
  document.body.classList.toggle('grab', hover);
  setIgnore(!hover);
}

window.addEventListener('mousemove', (e) => {
  cursor = { x: e.clientX, y: e.clientY };
  if (!pet) return;
  if (drag) {
    pos = { x: e.clientX + drag.dx, y: e.clientY + drag.dy };
    clampToScreen();
    return;
  }
  refreshHover();
});

window.addEventListener('mousedown', (e) => {
  if (!pet || e.button !== 0 || !inside({ x: e.clientX, y: e.clientY }, petBounds())) return;
  drag = { dx: pos.x - e.clientX, dy: pos.y - e.clientY };
  document.body.classList.add('grabbing');
  enter('dragged');
});

function endDrag() {
  if (!drag) return;
  drag = null;
  document.body.classList.remove('grabbing');
  enter('land');            // 放開：落地一拍，再回 idle 重新抽動作
  facing = Math.random() < 0.5 ? -1 : 1;
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);
window.addEventListener('mouseleave', () => { endDrag(); cursor = null; hover = false; document.body.classList.remove('grab'); setIgnore(true); });
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault()); // 拖檔案到寵物上不可導覽

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (pet && inside({ x: e.clientX, y: e.clientY }, petBounds())) window.pet.showPetMenu();
});

function rand(a, b) { return a + Math.random() * (b - a); }

// 唯讀除錯把手：給自動化驗證與回報問題用（npm start 後可用 DevTools 讀）。
window.__petDebug = () => ({ petId: pet?.id, procedural: pet?.procedural, state: { ...state }, pos: { ...pos }, facing, scale, paused, hover, ignoringMouse, dragging: !!drag, frames: pet ? Object.keys(pet.frames) : [] });
