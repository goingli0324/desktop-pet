import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../main/simulation.js';

const DISPLAY = { id: 1, x: 0, y: 0, width: 1600, height: 1000 };
const SIZES = Object.fromEntries(['walk0', 'walk1', 'walk2', 'walk3', 'idle', 'crouch', 'air', 'land'].map((n) => [n, [100, 100]]));

function makeSim(opts = {}) {
  const calls = { pet: [], ate: [] };
  const sim = createSimulation({
    getDisplays: () => [DISPLAY],
    getScale: () => 1,
    isPaused: () => false,
    onPet: (id) => calls.pet.push(id),
    onAte: (id) => calls.ate.push(id),
    ...opts,
  });
  sim.setPets([{ id: opts.id || 'builtin-cat', count: 1, sizes: SIZES }]);
  return { sim, calls };
}

function actorOf(sim) {
  // 用游標找出唯一那隻：掃整個螢幕找 hoveredActor
  for (let y = 50; y < 1000; y += 40) for (let x = 20; x < 1600; x += 40) {
    sim.setCursor({ x, y });
    const a = sim.hoveredActor();
    if (a) return a;
  }
  throw new Error('找不到寵物');
}

function run(sim, seconds, step = 1 / 60) { for (let t = 0; t < seconds; t += step) sim.tick(step); }

test('右鍵餵食：食物出現、牠過去吃、吃完通知 onAte 且食物消失', () => {
  const { sim, calls } = makeSim();
  const a = actorOf(sim);
  sim.setCursor(null);
  assert.equal(sim.feed(a), true);
  assert.equal(sim.foodLists()[1].length, 1);
  assert.equal(sim.foodLists()[1][0].emoji, '🐟');
  run(sim, 8);
  assert.deepEqual(calls.ate, ['builtin-cat']);
  assert.equal(sim.foodLists()[1].length, 0);
});

test('摸摸：游標在身上來回移動夠多次觸發一次 onPet，冷卻內不重複', () => {
  const { sim, calls } = makeSim({ getMood: () => 'content' });
  const a = actorOf(sim);
  const cx = a.pos.x, cy = a.pos.y - 50;
  for (let i = 0; i < 40; i++) { sim.setCursor({ x: cx + (i % 2 ? 30 : -30), y: cy }); sim.tick(1 / 60); }
  assert.deepEqual(calls.pet, ['builtin-cat']);
  for (let i = 0; i < 40; i++) { sim.setCursor({ x: a.pos.x + (i % 2 ? 30 : -30), y: a.pos.y - 50 }); sim.tick(1 / 60); }
  assert.equal(calls.pet.length, 1); // 10 秒冷卻
});

test('游標只是停在身上不動，不算摸', () => {
  const { sim, calls } = makeSim();
  const a = actorOf(sim);
  sim.setCursor({ x: a.pos.x, y: a.pos.y - 50 });
  run(sim, 3);
  assert.equal(calls.pet.length, 0);
});

test('生氣時會跺腳或鬧彆扭，並冒 💢', () => {
  const { sim } = makeSim({ getMood: () => 'angry' });
  actorOf(sim);
  sim.setCursor({ x: 5, y: 5 });
  const seen = new Set();
  let angryBubble = false;
  for (let t = 0; t < 180; t += 1 / 30) { // 生氣時仍有 25% 照常散步，觀察久一點
    sim.tick(1 / 30);
    const it = sim.renderLists()[1][0];
    if (it) { seen.add(it.frame); if (it.bubble === '💢') angryBubble = true; }
  }
  assert.ok(angryBubble, '應該冒過 💢');
  assert.ok(seen.has('land'), '跺腳會用到 land 幀');
});

test('使用者離開就全部去睡，回來就醒', () => {
  let away = true;
  const { sim } = makeSim({ isAway: () => away });
  actorOf(sim);
  sim.setCursor(null);
  run(sim, 40, 1 / 30); // 正在走的會先走完（最長約 27 秒）才睡
  assert.equal(sim.renderLists()[1][0].sleeping, true);
  away = false;
  run(sim, 0.2, 1 / 30);
  assert.equal(sim.renderLists()[1][0].sleeping, false);
});

test('會飛的動物被餵也是飛過去吃，不用蹲下幀', () => {
  const { sim, calls } = makeSim({ id: 'builtin-zodiac-dragon' });
  const a = actorOf(sim);
  sim.setCursor(null);
  sim.feed(a);
  const frames = new Set();
  for (let t = 0; t < 8; t += 1 / 30) { sim.tick(1 / 30); const it = sim.renderLists()[1][0]; if (it) frames.add(it.frame); }
  assert.deepEqual(calls.ate, ['builtin-zodiac-dragon']);
  for (const f of ['crouch', 'air', 'land']) assert.ok(!frames.has(f), `飛行動物不該出現 ${f}`);
});

test('想你時會走到游標附近並冒 💭', () => {
  const { sim } = makeSim({ getMood: () => 'lonely' });
  const a = actorOf(sim);
  const target = { x: a.pos.x > 800 ? 300 : 1300, y: a.pos.y - 40 };
  let missed = false;
  let closest = Infinity;
  for (let t = 0; t < 90; t += 1 / 30) {
    sim.setCursor(target);
    sim.tick(1 / 30);
    const it = sim.renderLists()[1][0];
    if (it?.bubble === '💭') { missed = true; closest = Math.min(closest, Math.abs(a.pos.x - target.x)); }
  }
  assert.ok(missed, '應該冒過 💭');
  assert.ok(closest < 160, `冒 💭 時應在游標旁（實際水平距離 ${Math.round(closest)}px）`);
});
