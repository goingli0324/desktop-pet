import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TUNING, freshNeeds, decay, feed, pet, moodOf, createNeedsStore } from '../main/needs.js';

const HOUR = 3600;

test('人在時肚子與心情都扣，8 小時肚子從滿到空', () => {
  const n = decay({ ...freshNeeds(0), hunger: 100, affection: 100 }, 8 * HOUR, true);
  assert.equal(Math.round(n.hunger), 0);
  assert.equal(n.affection, 0);
  assert.equal(n.awaySeconds, 0);
});

test('人不在時心情不扣，肚子一次離開最多扣 12 小時', () => {
  const start = { ...freshNeeds(0), hunger: 100, affection: 50 };
  const n = decay(start, 3 * 24 * HOUR, false);
  assert.equal(n.affection, 50);
  assert.equal(n.hunger, TUNING.awayHungerFloor); // 人不在最低只到「餓」，不會回來就是生氣
  assert.equal(moodOf({ ...n, affection: 80 }, 1e12), 'hungry');
  assert.equal(decay({ ...start, hunger: 10 }, HOUR, false).hunger, 10); // 本來就更低的不會被拉高
  const half = decay({ ...start, hunger: 100 }, 4 * HOUR, false);
  assert.equal(Math.round(half.hunger), 50);
});

test('離開上限是累計的：分兩段離開也不超過 12 小時份', () => {
  let n = { ...freshNeeds(0), hunger: 100 };
  n = decay(n, 6 * HOUR, false);
  n = decay({ ...n, hunger: 100 }, 6 * HOUR, false);
  n = decay({ ...n, hunger: 100 }, 6 * HOUR, false); // 已累計 12 小時，這段不扣
  assert.equal(n.hunger, 100);
  n = decay(n, 1, true); // 人回來，累計歸零
  assert.equal(n.awaySeconds, 0);
});

test('餵食與摸摸加分且不超過 100', () => {
  const n = feed({ ...freshNeeds(0), hunger: 90, affection: 95 }, 5);
  assert.equal(n.hunger, 100);
  assert.equal(n.affection, 100);
  assert.equal(n.lastCareAt, 5);
  assert.equal(pet({ ...freshNeeds(0), affection: 10 }, 0).affection, 10 + TUNING.petAffection);
});

test('情緒判定順序：開心 > 生氣 > 餓 > 想你 > 普通', () => {
  const now = 1_000_000;
  const base = { ...freshNeeds(0), lastCareAt: 0 };
  assert.equal(moodOf({ ...base, hunger: 5, lastCareAt: now - 1000 }, now), 'happy');
  assert.equal(moodOf({ ...base, hunger: 5 }, now), 'angry');
  assert.equal(moodOf({ ...base, affection: 5 }, now), 'angry');
  assert.equal(moodOf({ ...base, hunger: 20 }, now), 'hungry');
  assert.equal(moodOf({ ...base, affection: 30 }, now), 'lonely');
  assert.equal(moodOf(base, now), 'content');
  assert.equal(moodOf(undefined, now), 'content');
});

test('存檔讀檔＋離線補扣只算桌面上有的種類', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-'));
  const file = path.join(dir, 'needs.json');
  let clock = 0;
  const a = createNeedsStore({ file, now: () => clock });
  a.get('builtin-cat');
  a.get('builtin-dog');
  a.save();

  clock = 4 * HOUR * 1000; // 關掉 4 小時
  const b = createNeedsStore({ file, now: () => clock });
  b.load();
  b.catchUp(['builtin-cat']);
  const snap = b.snapshot();
  assert.equal(Math.round(snap['builtin-cat'].hunger), 30); // 80 - 50
  assert.equal(snap['builtin-cat'].affection, 80);
  assert.equal(snap['builtin-dog'].hunger, 80); // 沒在桌面上不扣
  assert.equal(snap['builtin-dog'].updatedAt, clock);
});

test('壞掉的檔案與怪數值不會讓程式崩潰', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-'));
  const file = path.join(dir, 'needs.json');
  fs.writeFileSync(file, '{ not json');
  const s = createNeedsStore({ file, now: () => 0 });
  s.load();
  assert.deepEqual(s.snapshot(), {});
  fs.writeFileSync(file, JSON.stringify({ species: { x: { hunger: 'abc', affection: 999, updatedAt: 9e15 }, y: null } }));
  s.load();
  const snap = s.snapshot();
  assert.equal(snap.x.hunger, 80);
  assert.equal(snap.x.affection, 100);
  assert.equal(snap.x.updatedAt, 0); // 未來時間被夾回現在
  assert.equal(snap.y, undefined);
});
