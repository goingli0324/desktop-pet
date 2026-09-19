// 用正式的切格器從 assets/sheets/<animal>.png 產出內建動物素材到 assets/builtin/<animal>/。
// 用法：node scripts/build-builtin.mjs            （全部）
//       node scripts/build-builtin.mjs dog hamster-jump  （指定）
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { sliceSheet, FRAME_NAMES } from '../renderer/shared/sprite-slicer.js';

const ANIMALS = {
  // 原有
  cat: '橘貓', dog: '柴犬', mouse: '小灰鼠', duck: '可爾鴨', hamster: '倉鼠',
  // 十二生肖
  'zodiac-rat': '生肖鼠', 'zodiac-ox': '生肖牛', 'zodiac-tiger': '生肖虎', 'zodiac-rabbit': '生肖兔',
  'zodiac-dragon': '生肖龍', 'zodiac-snake': '生肖蛇', 'zodiac-horse': '生肖馬', 'zodiac-goat': '生肖羊',
  'zodiac-monkey': '生肖猴', 'zodiac-rooster': '生肖雞', 'zodiac-dog': '生肖狗', 'zodiac-pig': '生肖豬',
  // 台灣特有種
  'tw-leopardcat': '石虎', 'tw-bluemagpie': '台灣藍鵲', 'tw-blackbear': '台灣黑熊', 'tw-macaque': '台灣獼猴',
  'tw-pheasant': '帝雉', 'tw-sikadeer': '梅花鹿', 'tw-muntjac': '山羌', 'tw-formosandog': '台灣犬', 'tw-pangolin': '穿山甲',
}
const TARGET_H = 220;
const root = path.join(import.meta.dirname, '..');
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ANIMALS);

for (const animal of wanted) {
  if (!ANIMALS[animal]) throw new Error(`未知動物 ${animal}，可用：${Object.keys(ANIMALS).join(', ')}`);
  const png = PNG.sync.read(fs.readFileSync(path.join(root, 'assets', 'sheets', `${animal}.png`)));
  const { frames, blobCount } = sliceSheet({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) }, { keyEnclosed: true });
  if (!frames.every(Boolean)) throw new Error(`${animal}：切格不完整（${frames.filter(Boolean).length}/8，${blobCount} 個色塊）`);
  const scale = TARGET_H / Math.max(...frames.map((f) => f.height));
  const out = path.join(root, 'assets', 'builtin', animal);
  fs.mkdirSync(out, { recursive: true });
  const meta = { id: `builtin-${animal}`, name: `${ANIMALS[animal]}（內建）`, source: 'builtin', procedural: false, frames: {} };
  FRAME_NAMES.forEach((name, i) => {
    const resized = resize(frames[i], scale);
    const p = new PNG({ width: resized.width, height: resized.height });
    p.data = Buffer.from(resized.data.buffer, resized.data.byteOffset, resized.data.length);
    fs.writeFileSync(path.join(out, `${name}.png`), PNG.sync.write(p));
    meta.frames[name] = `${name}.png`;
  });
  fs.writeFileSync(path.join(out, 'pet.json'), JSON.stringify(meta, null, 2));
  console.log(`${animal}: 8 格，${blobCount} 個色塊，最大幀 ${Math.max(...frames.map((f) => f.width))}x${Math.max(...frames.map((f) => f.height))} → 縮放 ${scale.toFixed(2)}`);
}

/** 雙線性縮小（premultiplied，避免透明邊緣染黑）。 */
function resize(src, s) {
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  const dst = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = (x + 0.5) / s - 0.5, sy = (y + 0.5) / s - 0.5;
    const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
    const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
    const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
    const acc = [0, 0, 0, 0];
    for (const [px, py, wgt] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
      const i = (py * src.width + px) * 4, a = src.data[i + 3] / 255;
      acc[0] += src.data[i] * a * wgt; acc[1] += src.data[i + 1] * a * wgt; acc[2] += src.data[i + 2] * a * wgt; acc[3] += a * wgt;
    }
    const o = (y * w + x) * 4;
    if (acc[3] > 0) { dst[o] = acc[0] / acc[3]; dst[o + 1] = acc[1] / acc[3]; dst[o + 2] = acc[2] / acc[3]; dst[o + 3] = acc[3] * 255; }
  }
  return { width: w, height: h, data: dst };
}
