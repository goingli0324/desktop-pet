// 全域座標的寵物模擬（從 renderer/overlay/overlay.js 移植過來，改成主程序跑、無 DOM）。
// 座標系：actor.pos 是「腳底中心」的全域螢幕座標（DIP，與 screen.workArea 同一套）。
// 主程序每幀 tick()，再由 index.js 依各螢幕範圍把 actor 轉本地座標送給對應視窗畫。

const ACTION_WEIGHTS = { walk: 5, run: 2, hop: 4, sleep: 1 };
const WALK_SPEED = [60, 110];
const RUN_SPEED = [180, 260];
const WALK_FPS = 7;
const RUN_FPS = 13;
const IDLE_SECONDS = [2, 6];
const SLEEP_SECONDS = [8, 15];
const HOP = { crouch: 0.14, air: 0.42, land: 0.16, height: [40, 90], distance: [0, 140], drift: [-120, 120], count: [1, 3] };
const WALK_MAX_ANGLE = 20 * Math.PI / 180;
const WALK_BOB_PX = 3;
const MIN_TRAVEL = 120;
const PROCEDURAL = { bobPx: 6, tiltRad: 0.10, squash: 0.12 };
const FRAME_NAMES = ['walk0', 'walk1', 'walk2', 'walk3', 'idle', 'crouch', 'air', 'land'];
// 會飛的動物：自由飄移、上下浮動、不落地（辰龍、台灣藍鵲、帝雉）
const FLYERS = new Set(['zodiac-dragon', 'tw-bluemagpie', 'tw-pheasant']);
const FLY_SPEED = [70, 130];
const FLY_FPS = 6;
const HOVER_SECONDS = [1.5, 4];
const FLY_BOB = { hz: 2.2, px: 10 };
const FLY_TILT = 0.06;
// 互動養成（數值在 main/needs.js，這裡只負責「看起來」）
const EAT_SECONDS = 2.2;
const STOMP_SECONDS = 1.6;
const SULK_SECONDS = [4, 8];
const AWAY_SLEEP_SECONDS = [30, 60];
const BUBBLE_SECONDS = 2.5;
const PET_RUB_PX = 900;          // 游標在身上來回累積這麼多距離算摸一次
const PET_RUB_DECAY = 300;       // 每秒消退（停手就歸零）
const PET_STOP_PX = 150;         // 摸到這個程度牠就停下來
const PET_COOLDOWN = 10;
const FOOD_TTL = 25;             // 沒吃到的食物多久後消失
const MOOD_SPEED = { hungry: 0.7, angry: 0.8 };
const SEEK_MAX_ANGLE = 35 * Math.PI / 180;
const FOOD_EMOJI = {
  cat: '🐟', 'cat-calico': '🐟', 'tw-leopardcat': '🐟',
  hamster: '🌻', 'hamster-snow': '🌻', 'zodiac-rat': '🌻', 'zodiac-rabbit': '🥕',
  'zodiac-ox': '🌿', 'zodiac-horse': '🌿', 'zodiac-goat': '🌿', 'tw-sikadeer': '🌿', 'tw-muntjac': '🌿',
  'zodiac-monkey': '🍌', 'tw-macaque': '🍌', 'tw-blackbear': '🍯', 'tw-pangolin': '🐜',
  duck: '🌽', 'zodiac-rooster': '🌽', 'tw-bluemagpie': '🍓', 'tw-pheasant': '🌽',
};
const DEFAULT_FOOD = '🍖';

const rand = (a, b) => a + Math.random() * (b - a);

const noop = () => {};

/**
 * @param {object} o
 * @param {(petId:string)=>string} [o.getMood] 'happy'|'angry'|'hungry'|'lonely'|'content'
 * @param {(petId:string)=>void} [o.onPet] 被摸了一次
 * @param {(petId:string)=>void} [o.onAte] 吃完一份食物
 * @param {()=>boolean} [o.isAway] 使用者不在電腦前 → 全部去睡
 */
export function createSimulation({ getDisplays, getScale, isPaused, getMood = () => 'content', onPet = noop, onAte = noop, isAway = () => false }) {
  let defs = new Map();   // petId → { procedural, sizes:{name:[w,h]} }
  let actors = [];        // { def, pos, facing, state, dragging, bubble, rub, petCooldown }
  let cursor = null;      // 全域游標 {x,y} 或 null
  let lastCursor = null;
  let dragActor = null;
  let foods = [];         // { x, y, emoji, ttl, actor }

  function unionArea() {
    const ds = getDisplays();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of ds) { x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y); x1 = Math.max(x1, d.x + d.width); y1 = Math.max(y1, d.y + d.height); }
    return { x0, y0, x1, y1 };
  }
  function displayAt(x, y) {
    for (const d of getDisplays()) if (x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height) return d;
    return null;
  }

  // 依 main 給的 active 清單（每隻含 count、sizes）重建 actors，盡量保留現有位置
  function setPets(list) {
    const next = [];
    const nextDefs = new Map();
    for (const p of list) {
      const animal = p.id.replace(/^builtin-/, '');
      nextDefs.set(p.id, { id: p.id, procedural: !!p.procedural, sizes: p.sizes, flying: FLYERS.has(animal), food: FOOD_EMOJI[animal] || DEFAULT_FOOD });
    }
    defs = nextDefs;
    for (const p of list) {
      const def = defs.get(p.id);
      const existing = actors.filter((a) => a.def.id === p.id);
      for (let i = 0; i < p.count; i++) next.push(existing[i] || spawn(def));
    }
    actors = next;
    if (dragActor && !actors.includes(dragActor)) dragActor = null;
    foods = foods.filter((f) => actors.includes(f.actor));
  }

  function frameSize(a, name) { return a.def.sizes[name] || a.def.sizes.idle || [100, 100]; }

  function spawn(def) {
    const u = unionArea();
    const a = { def, pos: { x: rand(u.x0 + 100, u.x1 - 100), y: rand(u.y0 + 100, u.y1 - 60) }, facing: Math.random() < 0.5 ? -1 : 1, state: null, dragging: false, bubble: null, rub: 0, petCooldown: 0 };
    enter(a, def.flying ? 'hover' : 'idle');
    a.state.t = rand(0, a.state.dur);
    clampToScreens(a);
    return a;
  }

  function enter(a, name, extra = {}) {
    a.state = { name, t: 0, ...extra };
    if (extra.dur !== undefined) return;
    if (name === 'idle') a.state.dur = rand(...IDLE_SECONDS);
    if (name === 'sleep') a.state.dur = rand(...SLEEP_SECONDS);
    if (name === 'hover') a.state.dur = rand(...HOVER_SECONDS);
    if (name === 'eat') a.state.dur = EAT_SECONDS;
    if (name === 'stomp') a.state.dur = STOMP_SECONDS;
  }

  const restState = (a) => (a.def.flying ? 'hover' : 'idle');
  function say(a, emoji, dur = BUBBLE_SECONDS) { a.bubble = { emoji, t: 0, dur }; }
  function faceCursor(a, away = false) { if (cursor) a.facing = (cursor.x >= a.pos.x) !== away ? 1 : -1; }

  // 情緒會先決定要不要做「情緒動作」，沒有才走原本的隨機動作
  function pickNextAction(a) {
    if (isAway()) return 'awaySleep';
    const mood = getMood(a.def.id);
    const roll = Math.random();
    if (mood === 'angry') { if (roll < 0.4) return 'stomp'; if (roll < 0.75) return 'sulk'; }
    if (mood === 'lonely' && cursor && roll < 0.45) return 'seek';
    if (mood === 'hungry' && roll < 0.3) return 'beg';
    if (mood === 'happy' && roll < 0.35) return a.def.flying ? 'fly' : 'hop';
    if (a.def.flying) return Math.random() < 0.78 ? 'fly' : 'hover';
    const total = Object.values(ACTION_WEIGHTS).reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (const [name, w] of Object.entries(ACTION_WEIGHTS)) { r -= w; if (r <= 0) return name; }
    return 'walk';
  }

  function moveTo(a, target, speed, extra = {}) {
    a.facing = target.x >= a.pos.x ? 1 : -1;
    enter(a, a.def.flying ? 'fly' : 'walk', { target, speed: speed * (MOOD_SPEED[getMood(a.def.id)] || 1), ...extra });
  }

  function startAction(a, name) {
    if (name === 'awaySleep') { enter(a, 'sleep', { dur: rand(...AWAY_SLEEP_SECONDS), away: true }); return; }
    if (name === 'stomp') { faceCursor(a, true); enter(a, 'stomp'); say(a, '💢', STOMP_SECONDS + 0.5); return; }
    if (name === 'sulk') { faceCursor(a, true); enter(a, restState(a), { dur: rand(...SULK_SECONDS) }); say(a, '💢', 2); return; }
    if (name === 'beg') { faceCursor(a); enter(a, restState(a)); say(a, a.def.food); return; }
    if (name === 'seek') {
      const side = cursor.x >= a.pos.x ? -1 : 1; // 停在游標靠自己這一側
      const target = { x: cursor.x + side * rand(70, 130), y: a.def.flying ? cursor.y : cursor.y + rand(20, 60) };
      if (!a.def.flying) { // 地上走的坡度有限，太陡看起來像整張圖在滑
        const maxDy = Math.abs(target.x - a.pos.x) * Math.tan(SEEK_MAX_ANGLE);
        target.y = a.pos.y + Math.max(-maxDy, Math.min(maxDy, target.y - a.pos.y));
      }
      if (!displayAt(target.x, target.y)) { enter(a, restState(a)); return; }
      moveTo(a, target, a.def.flying ? rand(...FLY_SPEED) : rand(...WALK_SPEED), { then: 'miss' });
      return;
    }
    if (name === 'fly') {
      const target = randomTargetFly(a);
      a.facing = target.x >= a.pos.x ? 1 : -1;
      enter(a, 'fly', { target, speed: rand(...FLY_SPEED) * (MOOD_SPEED[getMood(a.def.id)] || 1) });
      return;
    }
    if (name === 'hover') { enter(a, 'hover'); return; }
    if (name === 'walk' || name === 'run') {
      const target = randomTarget(a);
      const speed = (name === 'walk' ? rand(...WALK_SPEED) : rand(...RUN_SPEED)) * (MOOD_SPEED[getMood(a.def.id)] || 1);
      a.facing = target.x >= a.pos.x ? 1 : -1;
      enter(a, name, { target, speed });
    } else if (name === 'hop') {
      const count = Math.round(rand(...HOP.count));
      const dir = Math.random() < 0.5 ? -1 : 1;
      a.facing = dir;
      enter(a, 'hop', { phase: 'crouch', hopsLeft: count, height: rand(...HOP.height), dist: rand(...HOP.distance) * dir, drift: rand(...HOP.drift), from: { ...a.pos } });
    } else enter(a, 'sleep');
  }

  // 目標點：全域聯集內、接近水平（±20°）、且落在某個實體螢幕上（跳過螢幕間空隙）
  function randomTargetFly(a) {
    const u = unionArea();
    for (let i = 0; i < 40; i++) {
      const x = rand(u.x0, u.x1), y = rand(u.y0, u.y1);
      if (Math.hypot(x - a.pos.x, y - a.pos.y) >= MIN_TRAVEL && displayAt(x, y)) return { x, y };
    }
    const d = getDisplays()[0];
    return { x: d.x + d.width / 2, y: d.y + d.height / 2 };
  }
  function randomTarget(a) {
    const u = unionArea();
    for (let i = 0; i < 40; i++) {
      const x = rand(u.x0, u.x1);
      const dx = x - a.pos.x;
      if (Math.abs(dx) < MIN_TRAVEL) continue;
      const y = a.pos.y + Math.abs(dx) * Math.tan(rand(-WALK_MAX_ANGLE, WALK_MAX_ANGLE));
      if (displayAt(x, y)) return { x, y };
    }
    const d = getDisplays()[0];
    return { x: d.x + d.width / 2, y: d.y + d.height / 2 };
  }

  // 走／飛到目的地之後：吃東西、在游標旁等你、或一般休息
  function arrive(a) {
    const then = a.state.then;
    if (then === 'eat') { const food = a.state.food; if (food) a.facing = food.x >= a.pos.x ? 1 : -1; enter(a, 'eat', { food }); return; }
    if (then === 'miss') { faceCursor(a); enter(a, restState(a), { dur: rand(...SULK_SECONDS) }); say(a, '💭', 3); return; }
    enter(a, restState(a));
  }

  function update(a, dt) {
    const s = a.state;
    s.t += dt;
    switch (s.name) {
      case 'sleep':
        if (s.away && !isAway()) { enter(a, restState(a), { dur: rand(0.8, 2) }); break; } // 人回來就醒，先發呆一下
        if (s.t >= s.dur) startAction(a, pickNextAction(a));
        break;
      case 'idle':
      case 'hover':
      case 'stomp':
        if (s.t >= s.dur) startAction(a, pickNextAction(a));
        break;
      case 'eat':
        if (s.t >= s.dur) {
          foods = foods.filter((f) => f !== s.food);
          onAte(a.def.id);
          say(a, '❤️');
          enter(a, restState(a));
        }
        break;
      case 'fly': {
        const dx = s.target.x - a.pos.x, dy = s.target.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        const step = s.speed * dt;
        if (d <= step) { a.pos = { ...s.target }; arrive(a); break; }
        a.pos.x += (dx / d) * step; a.pos.y += (dy / d) * step;
        if (!displayAt(a.pos.x, a.pos.y)) { clampToScreens(a); arrive(a); }
        break;
      }
      case 'walk':
      case 'run': {
        const dx = s.target.x - a.pos.x, dy = s.target.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        const step = s.speed * dt;
        if (d <= step) { a.pos = { ...s.target }; arrive(a); break; }
        a.pos.x += (dx / d) * step; a.pos.y += (dy / d) * step;
        if (!displayAt(a.pos.x, a.pos.y)) { clampToScreens(a); arrive(a); } // 走進空隙就停
        break;
      }
      case 'hop': {
        const phase = HOP[s.phase];
        if (s.phase === 'air') {
          const p = Math.min(1, s.t / HOP.air);
          a.pos = { x: s.from.x + s.dist * p, y: s.from.y + s.drift * p };
          if (!displayAt(a.pos.x, a.pos.y)) clampToScreens(a);
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

  function currentFrameName(a) {
    const s = a.state;
    switch (s.name) {
      case 'walk': return `walk${Math.floor(s.t * WALK_FPS) % 4}`;
      case 'run': return `walk${Math.floor(s.t * RUN_FPS) % 4}`;
      case 'hop': return s.phase === 'air' ? 'air' : s.phase === 'crouch' ? 'crouch' : 'land';
      case 'land': return 'land';
      case 'fly': return `walk${Math.floor(s.t * FLY_FPS) % 4}`;
      case 'dragged': return 'air';
      case 'eat': return a.def.flying ? 'idle' : (Math.floor(s.t * 3) % 2 ? 'crouch' : 'idle');
      case 'stomp': return a.def.flying ? 'idle' : (Math.floor(s.t * 6) % 2 ? 'land' : 'idle');
      default: return 'idle';
    }
  }

  function poseTransform(a) {
    const s = a.state;
    let lift = 0, sx = 1, sy = 1, rot = 0;
    if (s.name === 'hop') {
      if (s.phase === 'air') { const p = s.t / HOP.air; lift = s.height * 4 * p * (1 - p); }
      if (s.phase === 'crouch' || s.phase === 'land') { sy = 1 - PROCEDURAL.squash; sx = 1 + PROCEDURAL.squash; }
      if (s.phase === 'air' && a.def.procedural) { sy = 1 + PROCEDURAL.squash; sx = 1 - PROCEDURAL.squash; }
    }
    if (s.name === 'idle') sy += 0.02 * Math.sin(s.t * Math.PI);
    if (s.name === 'sleep') sy += 0.03 * Math.sin(s.t * Math.PI * 0.6);
    if (s.name === 'walk' || s.name === 'run') {
      const hz = s.name === 'walk' ? 3 : 6;
      lift = Math.abs(Math.sin(s.t * Math.PI * hz)) * (a.def.procedural ? PROCEDURAL.bobPx : WALK_BOB_PX);
      if (a.def.procedural) rot = Math.sin(s.t * Math.PI * hz) * PROCEDURAL.tiltRad;
    }
    if (a.def.flying && (s.name === 'fly' || s.name === 'hover')) {
      lift += FLY_BOB.px * Math.sin(s.t * FLY_BOB.hz);
      rot += FLY_TILT * Math.sin(s.t * FLY_BOB.hz * 0.5);
    }
    if (s.name === 'eat') rot = Math.sin(s.t * Math.PI * 6) * 0.06;
    if (s.name === 'stomp') {
      const k = Math.abs(Math.sin(s.t * Math.PI * 6));
      sy = 1 - 0.1 * k; sx = 1 + 0.1 * k;
      rot = Math.sin(s.t * Math.PI * 12) * 0.05;
    }
    if (a.def.flying && (s.name === 'eat' || s.name === 'stomp')) lift += FLY_BOB.px * Math.sin(s.t * FLY_BOB.hz);
    if (s.name === 'dragged') rot = Math.sin(s.t * 6) * 0.08;
    return { lift, sx, sy, rot };
  }

  function actorSize(a) {
    const [w, h] = frameSize(a, currentFrameName(a));
    const sc = getScale();
    return { w: w * sc, h: h * sc };
  }

  function actorBounds(a) {
    const { w, h } = actorSize(a);
    const { lift } = poseTransform(a);
    return { x0: a.pos.x - w / 2, y0: a.pos.y - h - lift, x1: a.pos.x + w / 2, y1: a.pos.y - lift };
  }

  function clampToScreens(a) {
    // 夾回「離目前位置最近的螢幕」的範圍內
    const { w, h } = actorSize(a);
    let best = displayAt(a.pos.x, a.pos.y);
    if (!best) {
      let bd = Infinity;
      for (const d of getDisplays()) {
        const cx = Math.max(d.x, Math.min(a.pos.x, d.x + d.width));
        const cy = Math.max(d.y, Math.min(a.pos.y, d.y + d.height));
        const dist = Math.hypot(a.pos.x - cx, a.pos.y - cy);
        if (dist < bd) { bd = dist; best = d; }
      }
    }
    if (!best) return;
    a.pos.x = Math.min(Math.max(a.pos.x, best.x + w / 2), best.x + best.width - w / 2);
    a.pos.y = Math.min(Math.max(a.pos.y, best.y + h), best.y + best.height);
  }

  function inside(p, b) { return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1; }

  // 摸摸：游標在牠身上來回移動（不用按鍵）累積距離，夠了就算一次；睡著的不吵、拖曳中不算
  function detectPetting() {
    const prev = lastCursor;
    lastCursor = cursor; // 位移只算一次：游標沒動就是 0
    if (!cursor || !prev || dragActor) return;
    const a = actorAtCursor();
    if (!a || a.state.name === 'sleep' || a.petCooldown > 0) return;
    a.rub += Math.hypot(cursor.x - prev.x, cursor.y - prev.y);
    // 開始被摸就停下來讓你摸（跑走的話游標追不上）
    if (a.rub > PET_STOP_PX && ['walk', 'run', 'fly'].includes(a.state.name)) { faceCursor(a); enter(a, restState(a), { dur: 3 }); }
    if (a.rub < PET_RUB_PX) return;
    a.rub = 0;
    a.petCooldown = PET_COOLDOWN;
    onPet(a.def.id);
    say(a, '❤️');
    if (a.state.name === 'walk' || a.state.name === 'run' || a.state.name === 'stomp') { faceCursor(a); enter(a, restState(a)); }
  }

  function actorAtCursor() {
    if (!cursor) return null;
    const ordered = [...actors].sort((a, b) => a.pos.y - b.pos.y);
    for (let i = ordered.length - 1; i >= 0; i--) if (inside(cursor, actorBounds(ordered[i]))) return ordered[i];
    return null;
  }

  // ---- 對外 API ----
  return {
    setPets,
    setCursor(pt) { cursor = pt; },
    tick(dt) {
      const paused = isPaused();
      if (dragActor && cursor) { dragActor.pos = { x: cursor.x + dragActor.dragDX, y: cursor.y + dragActor.dragDY }; clampToScreens(dragActor); }
      for (const a of actors) {
        if (a === dragActor) { a.state.t += dt; continue; }
        if (!paused && a.state.name !== 'dragged') update(a, dt);
        else a.state.t += dt;
        if (a.bubble && (a.bubble.t += dt) >= a.bubble.dur) a.bubble = null;
        a.rub = Math.max(0, a.rub - PET_RUB_DECAY * dt);
        a.petCooldown = Math.max(0, a.petCooldown - dt);
      }
      if (!paused) detectPetting();
      for (const f of foods) f.ttl -= dt;
      foods = foods.filter((f) => f.ttl > 0 || (f.actor.state.name === 'eat' && f.actor.state.food === f));
    },
    /** 右鍵「餵食」：食物掉在牠面前，牠走（飛）過去吃。 */
    feed(a) {
      if (!a || !actors.includes(a) || a === dragActor) return false;
      foods = foods.filter((f) => f.actor !== a);
      const d = displayAt(a.pos.x, a.pos.y) || getDisplays()[0];
      let dir = a.facing;
      let x = a.pos.x + dir * rand(70, 120);
      if (x < d.x + 30 || x > d.x + d.width - 30) { dir = -dir; x = a.pos.x + dir * rand(70, 120); }
      const food = { x, y: a.pos.y, emoji: a.def.food, ttl: FOOD_TTL, actor: a };
      foods.push(food);
      const { w } = actorSize(a);
      moveTo(a, { x: x - dir * w * 0.35, y: food.y }, a.def.flying ? rand(...FLY_SPEED) : rand(...WALK_SPEED) * 1.3, { then: 'eat', food });
      return true;
    },
    /** 每個螢幕要畫的食物（本地座標）。 */
    foodLists() {
      const out = {};
      for (const d of getDisplays()) out[d.id] = [];
      for (const f of foods) {
        const d = displayAt(f.x, f.y);
        if (d) out[d.id].push({ x: f.x - d.x, y: f.y - d.y, emoji: f.emoji });
      }
      return out;
    },
    hoveredActor() { return dragActor || actorAtCursor(); },
    startDrag() {
      const a = actorAtCursor();
      if (!a || !cursor) return false;
      dragActor = a;
      a.dragDX = a.pos.x - cursor.x; a.dragDY = a.pos.y - cursor.y;
      enter(a, 'dragged');
      return true;
    },
    endDrag() {
      if (!dragActor) return;
      const a = dragActor; dragActor = null;
      enter(a, a.def.flying ? 'hover' : 'land');
      a.facing = Math.random() < 0.5 ? -1 : 1;
    },
    isDragging() { return !!dragActor; },
    // 產生「每個螢幕要畫的清單」：{ [displayId]: [items(本地座標)] }
    renderLists() {
      const ds = getDisplays();
      const out = {};
      for (const d of ds) out[d.id] = [];
      const hov = dragActor || actorAtCursor();
      const ordered = [...actors].sort((p, q) => (p === dragActor ? 1 : q === dragActor ? -1 : p.pos.y - q.pos.y));
      for (const a of ordered) {
        const { w, h } = actorSize(a);
        const { lift, sx, sy, rot } = poseTransform(a);
        const b = { x0: a.pos.x - w / 2, y0: a.pos.y - h - lift, x1: a.pos.x + w / 2, y1: a.pos.y - lift };
        for (const d of ds) {
          if (b.x1 < d.x || b.x0 > d.x + d.width || b.y1 < d.y || b.y0 > d.y + d.height) continue; // 不相交
          out[d.id].push({
            petId: a.def.id, frame: currentFrameName(a), facing: a.facing,
            x: a.pos.x - d.x, y: a.pos.y - d.y, w, h, lift, sx, sy, rot,
            sleeping: a.state.name === 'sleep', sleepT: a.state.t, grabTarget: a === hov,
            bubble: a.bubble ? a.bubble.emoji : null, bubbleT: a.bubble ? a.bubble.t / a.bubble.dur : 0,
          });
        }
      }
      return out;
    },
  };
}
