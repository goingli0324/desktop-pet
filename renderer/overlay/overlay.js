// 桌面覆蓋層：多隻寵物各跑各的狀態機 + 繪圖 + 點擊穿透切換。
// 座標系：每隻的 (x, y) 是「腳底中心」的邏輯像素位置，畫面座標 = 視窗座標。

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
let defs = new Map();    // petId → { id, frames: {name: HTMLImageElement}, procedural }
let actors = [];         // 每隻一個：{ def, pos, facing, state, drag }
let scale = 0.55;
let paused = false;
let hoverActor = null;
let ignoringMouse = true;
let cursor = null;       // 最後已知游標位置；寵物走開時也要重算 hover
let last = performance.now();

// ---- 初始化 ----
resize();
window.addEventListener('resize', resize);
applyState(await window.pet.getState());
await loadPets(await window.pet.getActivePets());
window.pet.onPetsChanged(loadPets);
window.pet.onStateChanged(applyState);
requestAnimationFrame(tick);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const a of actors) clampToScreen(a);
}

function applyState(s) {
  if (!s) return;
  scale = s.scale ?? scale;
  paused = !!s.paused;
}

/** 依 main 給的清單（每隻含 count）重建演員：已在畫面上的同種寵物盡量保留位置，只增減數量。 */
async function loadPets(list) {
  if (!Array.isArray(list)) return;
  const nextDefs = new Map();
  await Promise.all(list.map(async (data) => {
    const cached = defs.get(data.id);
    nextDefs.set(data.id, cached || await loadDef(data));
  }));
  defs = nextDefs;
  const next = [];
  for (const data of list) {
    const def = defs.get(data.id);
    if (!def) continue;
    const existing = actors.filter((a) => a.def.id === data.id);
    for (let i = 0; i < data.count; i++) next.push(existing[i] || spawn(def));
  }
  actors = next;
  if (hoverActor && !actors.includes(hoverActor)) { hoverActor = null; setIgnore(true); }
}

async function loadDef(data) {
  const frames = {};
  await Promise.all(Object.entries(data.frames).map(([name, url]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { frames[name] = img; resolve(); };
    img.onerror = () => resolve(); // 缺幀就用 idle 補（見 currentFrame）
    img.src = url;
  })));
  if (!frames.idle) return null;
  return { id: data.id, frames, procedural: !!data.procedural };
}

function spawn(def) {
  const a = { def, pos: { x: rand(200, window.innerWidth - 200), y: rand(200, window.innerHeight - 100) }, facing: Math.random() < 0.5 ? -1 : 1, state: null, drag: null };
  enter(a, 'idle');                 // 先有 state，clampToScreen 要靠它取目前幀的尺寸
  a.state.t = rand(0, a.state.dur); // 錯開起手時間，避免一群同時動
  clampToScreen(a);
  return a;
}

// ---- 狀態機（每隻獨立）----
function enter(a, name, extra = {}) {
  a.state = { name, t: 0, ...extra };
  if (name === 'idle') a.state.dur = rand(...IDLE_SECONDS);
  if (name === 'sleep') a.state.dur = rand(...SLEEP_SECONDS);
}

function pickNextAction() {
  const total = Object.values(ACTION_WEIGHTS).reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (const [name, w] of Object.entries(ACTION_WEIGHTS)) { r -= w; if (r <= 0) return name; }
  return 'walk';
}

function startAction(a, name) {
  if (name === 'walk' || name === 'run') {
    const target = randomTarget(a);
    const speed = name === 'walk' ? rand(...WALK_SPEED) : rand(...RUN_SPEED);
    a.facing = target.x >= a.pos.x ? 1 : -1;
    enter(a, name, { target, speed });
  } else if (name === 'hop') {
    const count = Math.round(rand(...HOP.count));
    const dir = Math.random() < 0.5 ? -1 : 1;
    a.facing = dir;
    enter(a, 'hop', { phase: 'crouch', hopsLeft: count, height: rand(...HOP.height), dist: rand(...HOP.distance) * dir, drift: rand(...HOP.drift), from: { ...a.pos } });
  } else {
    enter(a, 'sleep');
  }
}

function randomTarget(a) {
  const { w, h } = actorSize(a);
  const xMin = w / 2, xMax = window.innerWidth - w / 2, yMin = h, yMax = window.innerHeight;
  for (let i = 0; i < 30; i++) {
    const x = rand(xMin, xMax);
    const dx = x - a.pos.x;
    if (Math.abs(dx) < MIN_TRAVEL) continue;
    const y = a.pos.y + Math.abs(dx) * Math.tan(rand(-WALK_MAX_ANGLE, WALK_MAX_ANGLE));
    if (y >= yMin && y <= yMax) return { x, y };
  }
  return { x: a.pos.x < (xMin + xMax) / 2 ? xMax : xMin, y: a.pos.y }; // 抽不到就往遠的那一側水平走
}

function update(a, dt) {
  const s = a.state;
  s.t += dt;
  switch (s.name) {
    case 'idle':
    case 'sleep':
      if (s.t >= s.dur) startAction(a, pickNextAction());
      break;
    case 'walk':
    case 'run': {
      const dx = s.target.x - a.pos.x, dy = s.target.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      const step = s.speed * dt;
      if (d <= step) { a.pos = { ...s.target }; enter(a, 'idle'); break; }
      a.pos.x += (dx / d) * step; a.pos.y += (dy / d) * step;
      break;
    }
    case 'hop': {
      const phase = HOP[s.phase];
      if (s.phase === 'air') {
        const p = Math.min(1, s.t / HOP.air);
        a.pos = { x: s.from.x + s.dist * p, y: s.from.y + s.drift * p };
        clampToScreen(a);
      }
      if (s.t < phase) break;
      s.t = 0;
      if (s.phase === 'crouch') { s.phase = 'air'; s.from = { ...a.pos }; }
      else if (s.phase === 'air') s.phase = 'land';
      else if (--s.hopsLeft > 0) { s.phase = 'crouch'; s.dist = rand(...HOP.distance) * a.facing; s.drift = rand(...HOP.drift); }
      else enter(a, 'idle');
      break;
    }
    case 'land':
      if (s.t >= HOP.land) enter(a, 'idle');
      break;
    case 'dragged':
      break;
  }
}

// ---- 繪圖 ----
function currentFrame(a) {
  const f = a.def.frames;
  const pick = (name) => f[name] || f.idle;
  const s = a.state;
  switch (s.name) {
    case 'walk': return pick(`walk${Math.floor(s.t * WALK_FPS) % 4}`);
    case 'run': return pick(`walk${Math.floor(s.t * RUN_FPS) % 4}`);
    case 'hop': return pick(s.phase === 'air' ? 'air' : s.phase === 'crouch' ? 'crouch' : 'land');
    case 'land': return pick('land');
    case 'dragged': return pick('air');
    default: return pick('idle');
  }
}

/** 畫面上的額外位移／變形：跳躍高度、呼吸、走路起伏、單張圖降級的擺動。 */
function poseTransform(a) {
  const s = a.state;
  let lift = 0, sx = 1, sy = 1, rot = 0;
  if (s.name === 'hop') {
    if (s.phase === 'air') { const p = s.t / HOP.air; lift = s.height * 4 * p * (1 - p); }
    if (s.phase === 'crouch' || s.phase === 'land') { sy = 1 - PROCEDURAL.squash; sx = 1 + PROCEDURAL.squash; }
    if (s.phase === 'air' && a.def.procedural) { sy = 1 + PROCEDURAL.squash; sx = 1 - PROCEDURAL.squash; }
  }
  if (s.name === 'idle') { sy += 0.02 * Math.sin(s.t * Math.PI); }
  if (s.name === 'sleep') { sy += 0.03 * Math.sin(s.t * Math.PI * 0.6); }
  if (s.name === 'walk' || s.name === 'run') {
    const hz = s.name === 'walk' ? 3 : 6;
    lift = Math.abs(Math.sin(s.t * Math.PI * hz)) * (a.def.procedural ? PROCEDURAL.bobPx : WALK_BOB_PX);
    if (a.def.procedural) rot = Math.sin(s.t * Math.PI * hz) * PROCEDURAL.tiltRad;
  }
  if (s.name === 'dragged') rot = Math.sin(s.t * 6) * 0.08;
  return { lift, sx, sy, rot };
}

function actorSize(a) {
  const img = currentFrame(a);
  return img ? { w: img.naturalWidth * scale, h: img.naturalHeight * scale } : { w: 100, h: 100 };
}

function actorBounds(a) {
  const { w, h } = actorSize(a);
  const { lift } = poseTransform(a);
  return { x0: a.pos.x - w / 2, y0: a.pos.y - h - lift, x1: a.pos.x + w / 2, y1: a.pos.y - lift };
}

function draw() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  // 腳底越低的畫越前面，重疊時有前後感；拖著的那隻永遠最上面
  const order = [...actors].sort((p, q) => (p.drag ? 1 : q.drag ? -1 : p.pos.y - q.pos.y));
  for (const a of order) {
    const img = currentFrame(a);
    const { w, h } = actorSize(a);
    const { lift, sx, sy, rot } = poseTransform(a);
    ctx.save();
    ctx.translate(a.pos.x, a.pos.y - lift);
    ctx.rotate(rot * a.facing);
    ctx.scale(a.facing * sx, sy);
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
    if (a.state.name === 'sleep') drawZzz(a, a.pos.x + w * 0.35 * a.facing, a.pos.y - h - 6);
  }
}

function drawZzz(a, x, y) {
  const phase = (a.state.t % 2) / 2;
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
  for (const a of actors) {
    if (!paused && a.state.name !== 'dragged') update(a, dt);
    else a.state.t += dt;
  }
  refreshHover();           // 游標沒動、寵物自己走開時也要恢復穿透
  draw();
  requestAnimationFrame(tick);
}

function clampToScreen(a) {
  const { w, h } = actorSize(a);
  a.pos.x = Math.min(Math.max(a.pos.x, w / 2), Math.max(w / 2, window.innerWidth - w / 2));
  a.pos.y = Math.min(Math.max(a.pos.y, h), Math.max(h, window.innerHeight));
}

// ---- 滑鼠：穿透切換與拖拉 ----
function inside(p, b) { return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1; }

/** 游標下最前面的那隻（畫在最後的最前面）。 */
function actorAt(p) {
  const order = [...actors].sort((a, b) => a.pos.y - b.pos.y);
  for (let i = order.length - 1; i >= 0; i--) if (inside(p, actorBounds(order[i]))) return order[i];
  return null;
}

function setIgnore(ignore) {
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  window.pet.setIgnoreMouse(ignore);
}

function refreshHover() {
  if (!cursor || actors.some((a) => a.drag)) return;
  const h = actorAt(cursor);
  if (h === hoverActor) return;
  hoverActor = h;
  document.body.classList.toggle('grab', !!h);
  setIgnore(!h);
}

window.addEventListener('mousemove', (e) => {
  cursor = { x: e.clientX, y: e.clientY };
  const dragging = actors.find((a) => a.drag);
  if (dragging) {
    dragging.pos = { x: e.clientX + dragging.drag.dx, y: e.clientY + dragging.drag.dy };
    clampToScreen(dragging);
    return;
  }
  refreshHover();
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const a = actorAt({ x: e.clientX, y: e.clientY });
  if (!a) return;
  a.drag = { dx: a.pos.x - e.clientX, dy: a.pos.y - e.clientY };
  document.body.classList.add('grabbing');
  enter(a, 'dragged');
});

function endDrag() {
  const a = actors.find((x) => x.drag);
  if (!a) return;
  a.drag = null;
  document.body.classList.remove('grabbing');
  enter(a, 'land');            // 放開：落地一拍，再回 idle 重新抽動作
  a.facing = Math.random() < 0.5 ? -1 : 1;
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);
window.addEventListener('mouseleave', () => { endDrag(); cursor = null; hoverActor = null; document.body.classList.remove('grab'); setIgnore(true); });
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault()); // 拖檔案到寵物上不可導覽

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (actorAt({ x: e.clientX, y: e.clientY })) window.pet.showPetMenu();
});

function rand(a, b) { return a + Math.random() * (b - a); }

// 唯讀除錯把手：給自動化驗證與回報問題用。
window.__petDebug = () => ({
  count: actors.length, scale, paused, ignoringMouse, hover: hoverActor ? hoverActor.def.id : null,
  actors: actors.map((a) => ({ petId: a.def.id, state: a.state.name, phase: a.state.phase, pos: { x: Math.round(a.pos.x), y: Math.round(a.pos.y) }, facing: a.facing, dragging: !!a.drag })),
});
