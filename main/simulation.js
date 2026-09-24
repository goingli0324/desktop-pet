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

const rand = (a, b) => a + Math.random() * (b - a);

export function createSimulation({ getDisplays, getScale, isPaused }) {
  let defs = new Map();   // petId → { procedural, sizes:{name:[w,h]} }
  let actors = [];        // { def, pos, facing, state, dragging }
  let cursor = null;      // 全域游標 {x,y} 或 null
  let dragActor = null;

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
      nextDefs.set(p.id, { id: p.id, procedural: !!p.procedural, sizes: p.sizes });
    }
    defs = nextDefs;
    for (const p of list) {
      const def = defs.get(p.id);
      const existing = actors.filter((a) => a.def.id === p.id);
      for (let i = 0; i < p.count; i++) next.push(existing[i] || spawn(def));
    }
    actors = next;
    if (dragActor && !actors.includes(dragActor)) dragActor = null;
  }

  function frameSize(a, name) { return a.def.sizes[name] || a.def.sizes.idle || [100, 100]; }

  function spawn(def) {
    const u = unionArea();
    const a = { def, pos: { x: rand(u.x0 + 100, u.x1 - 100), y: rand(u.y0 + 100, u.y1 - 60) }, facing: Math.random() < 0.5 ? -1 : 1, state: null, dragging: false };
    enter(a, 'idle');
    a.state.t = rand(0, a.state.dur);
    clampToScreens(a);
    return a;
  }

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
    } else enter(a, 'sleep');
  }

  // 目標點：全域聯集內、接近水平（±20°）、且落在某個實體螢幕上（跳過螢幕間空隙）
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
        if (!displayAt(a.pos.x, a.pos.y)) { clampToScreens(a); enter(a, 'idle'); } // 走進空隙就停
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
      case 'dragged': return 'air';
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
      }
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
      enter(a, 'land');
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
          });
        }
      }
      return out;
    },
  };
}
