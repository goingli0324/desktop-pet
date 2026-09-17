import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { sliceSheet } from '../renderer/shared/sprite-slicer.js';

const fixture = (name) => {
  const png = PNG.sync.read(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name)));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
};

for (const name of ['sheet-spaced.png', 'sheet-tight.png']) {
  test(`${name}：切出 8 格，每格都有內容且邊緣透明`, () => {
    const { frames, background } = sliceSheet(fixture(name), { cols: 4, rows: 2 });
    assert.equal(frames.length, 8);
    assert.ok(frames.every(Boolean), `有空格：${frames.map((f, i) => (f ? '' : i)).filter((v) => v !== '').join(',')}`);
    assert.ok(background[0] > 200 && background[1] < 60 && background[2] > 200, `背景應為洋紅，實得 ${background}`);
    for (const f of frames) {
      assert.ok(f.width > 100 && f.height > 100, `幀太小 ${f.width}x${f.height}`);
      assert.equal(f.data[3], 0, '左上角應透明');
      let opaque = 0;
      for (let i = 3; i < f.data.length; i += 4) if (f.data[i] === 255) opaque++;
      assert.ok(opaque > f.width * f.height * 0.25, '不透明像素太少，角色可能被挖穿');
    }
  });
}

test('sheet-tight.png：黏連的第 7、8 格被格界切開，沒有任何一格寬度超過 1.2 格', () => {
  const img = fixture('sheet-tight.png');
  const { frames } = sliceSheet(img);
  const cellWidth = img.width / 4;
  for (const [i, f] of frames.entries()) {
    assert.ok(f.width <= 1.2 * cellWidth, `第 ${i + 1} 格寬 ${f.width} 超過 1.2 格（${cellWidth}）`);
  }
});

test('sheet-tight.png：AI 表模式（keyEnclosed）切出的幀不該殘留洋紅色暈與封閉口袋', () => {
  const { frames } = sliceSheet(fixture('sheet-tight.png'), { keyEnclosed: true });
  for (const [i, f] of frames.entries()) {
    let magenta = 0, opaque = 0;
    for (let p = 0; p < f.data.length; p += 4) {
      if (f.data[p + 3] < 200) continue;
      opaque++;
      const r = f.data[p], g = f.data[p + 1], b = f.data[p + 2];
      if (r > g + 70 && b > g + 70 && r > 140 && b > 140) magenta++;
    }
    assert.ok(magenta / opaque < 0.001, `第 ${i + 1} 格有 ${magenta} 個洋紅像素（${(magenta / opaque * 100).toFixed(2)}%）`);
  }
});
