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

// 原本隨機生成＋90 秒內等牠自己抽到 seek（每次 45%），約 0.3% 會連續抽不中、或太晚抽中還走在半路而假紅。
// 改成固定位置、下一幀就決策，且只在那一幀把 Math.random 固定在 0.2（< 0.45 一定選 seek）；之後照常隨機。
test('想你時會走到游標附近並冒 💭', () => {
  const { sim } = makeSim({ getMood: () => 'lonely' });
  const a = actorOf(sim);
  a.pos = { x: 1300, y: 600 };
  a.state = { name: 'idle', t: 0, dur: 0 };
  const target = { x: 300, y: a.pos.y - 40 }; // 隔約 1000px，確認是真的走過去
  sim.setCursor(target);
  const realRandom = Math.random;
  Math.random = () => 0.2;
  try { sim.tick(1 / 30); } finally { Math.random = realRandom; }
  assert.equal(a.state.then, 'miss', 'lonely 的那次決策應該選 seek（走向游標）');
  let missed = false;
  let closest = Infinity;
  for (let t = 0; t < 30; t += 1 / 30) { // 最慢 60px/s 走約 900px ≈ 15 秒
    sim.setCursor(target);
    sim.tick(1 / 30);
    const it = sim.renderLists()[1][0];
    if (it?.bubble === '💭') { missed = true; closest = Math.min(closest, Math.abs(a.pos.x - target.x)); }
  }
  assert.ok(missed, '應該冒過 💭');
  assert.ok(closest < 160, `冒 💭 時應在游標旁（實際水平距離 ${Math.round(closest)}px）`);
});

// 回歸：0.4.0 實機摸不出愛心。舊測試每幀游標跳 60px（人手做不到）所以假綠；這裡用真實貓圖尺寸＋縮放 0.35＋人手速度。
const CAT_SIZES = { walk0: [141, 132], walk1: [142, 133], walk2: [139, 132], walk3: [146, 133], idle: [147, 136], crouch: [154, 123], air: [140, 143], land: [167, 121] };
function smallCatSim() {
  const calls = { pet: 0 };
  const sim = createSimulation({ getDisplays: () => [DISPLAY], getScale: () => 0.35, isPaused: () => false, onPet: () => calls.pet++ });
  sim.setPets([{ id: 'builtin-cat', count: 1, sizes: CAT_SIZES }]);
  const a = actorOf(sim);
  a.state = { name: 'idle', t: 0, dur: 999 }; // 固定站著，結果每次一樣
  return { sim, a, calls };
}

for (const [amp, hz] of [[20, 2], [40, 2], [60, 3]]) {
  test(`真人摸法（小貓，游標 ±${amp}px ${hz}Hz 來回 3 秒）會觸發摸摸`, () => {
    const { sim, a, calls } = smallCatSim();
    const cx = a.pos.x, cy = a.pos.y - 24;
    for (let i = 0; i < 180; i++) { sim.setCursor({ x: cx + amp * Math.sin(2 * Math.PI * hz * i / 60), y: cy }); sim.tick(1 / 60); }
    assert.ok(calls.pet >= 1, '應該觸發摸摸');
  });
}

test('游標只是橫越經過一次，不算摸', () => {
  const { sim, a, calls } = smallCatSim();
  const cy = a.pos.y - 24;
  for (let i = 0; i <= 60; i++) { sim.setCursor({ x: a.pos.x - 300 + i * 10, y: cy }); sim.tick(1 / 60); }
  run(sim, 2);
  assert.equal(calls.pet, 0);
});
