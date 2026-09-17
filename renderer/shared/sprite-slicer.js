// 把「單色背景的 sprite sheet」切成獨立透明幀。
// 純函式，只吃 { width, height, data: Uint8ClampedArray(RGBA) }，
// 瀏覽器傳 ImageData、Node 測試傳 pngjs 解出的 buffer 都可以。
//
// 演算法（與 plans/2026-09-17 研究結論 4、5 一致）：
// 1. 背景色 = 四角平均。
// 2. 從四邊往內泛洪，只有「連得到邊界」的背景像素才變透明——角色肚子的淺色不會被挖穿。
// 3. 邊緣像素依「與背景色的距離」給半透明，並反混色去掉色暈（JPEG 輸出必有）。
// 3a. keyEnclosed=true 時，連不到邊界但幾乎純背景色的封閉口袋也去掉（AI 表用）。
// 3b. 緊鄰透明區、帶背景色調的像素逐圈剝除（JPEG 色暈）。
// 4. 前景連通塊依質心歸入 rows×cols 的格子；同格多塊取 bbox 聯集（鬍鬚脫離）；
//    一塊橫跨超過 1.4 格寬視為黏連，以格界切開。

const ALPHA_LOW = 40;   // 與背景距離 <= LOW → 全透明
const ALPHA_HIGH = 120; // 距離 >= HIGH → 全不透明
const MIN_BLOB_PIXELS = 50;
const MERGED_CELL_RATIO = 1.4;
const FRINGE_PASSES = 4;
const TINT_MARGIN = 70;  // 「偏背景色」判定：像素在背景的兩個主色道上都明顯高於第三色道

export function sliceSheet(image, { cols = 4, rows = 2, keyEnclosed = false } = {}) {
  const { width: W, height: H, data } = image;
  const bg = sampleCornerColor(image);
  const dist = (i) => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);

  // --- 2. 邊緣連通泛洪 ---
  const reachable = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    const p = y * W + x;
    if (!reachable[p] && dist(p * 4) < ALPHA_HIGH) { reachable[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }

  // --- 3. alpha 與去色暈 ---
  const out = new Uint8ClampedArray(data.length);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (!reachable[p]) { out[i] = data[i]; out[i + 1] = data[i + 1]; out[i + 2] = data[i + 2]; out[i + 3] = 255; continue; }
    const d = dist(i);
    const a = d <= ALPHA_LOW ? 0 : Math.min(1, (d - ALPHA_LOW) / (ALPHA_HIGH - ALPHA_LOW));
    if (a <= 0) continue; // 已是 0
    for (let c = 0; c < 3; c++) out[i + c] = (data[i + c] - (1 - a) * bg[c]) / a;
    out[i + 3] = Math.round(a * 255);
  }

  // --- 3a. 封閉口袋（keyEnclosed 才做）：連不到邊界、但幾乎就是背景色的區域（例如兩腳之間圍起來的小塊）。
  // 只在背景是我們指定的鍵色（AI 生成表）時開啟；使用者自傳的單張圖背景不可控，保持只刪邊緣連通。
  if (keyEnclosed) {
    for (let p = 0; p < W * H; p++) {
      if (reachable[p] || dist(p * 4) > ALPHA_LOW) continue;
      const i = p * 4; out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
    }
  }

  // --- 3b. 剝除色暈環：JPEG 邊緣會留下一圈偏洋紅的「不透明」像素（與背景距離已超過 HIGH）。
  // 只處理緊鄰透明區的像素，逐圈往內最多 FRINGE_PASSES 圈；角色內部的粉紅／紫色不受影響。
  for (let pass = 0; pass < FRINGE_PASSES; pass++) {
    const peel = [];
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      if (out[i + 3] < 128 || !isBackgroundTinted(out, i, bg)) continue;
      const x = p % W, y = (p - x) / W;
      if ((x > 0 && out[i - 4 + 3] < 255) || (x < W - 1 && out[i + 4 + 3] < 255) || (y > 0 && out[(p - W) * 4 + 3] < 255) || (y < H - 1 && out[(p + W) * 4 + 3] < 255)) peel.push(i);
    }
    if (!peel.length) break;
    for (const i of peel) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; }
  }

  // --- 4. 連通塊 ---
  const label = new Int32Array(W * H);
  const blobs = [];
  for (let p = 0; p < W * H; p++) {
    if (out[p * 4 + 3] === 0 || label[p]) continue;
    const id = blobs.length + 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, count = 0;
    label[p] = id; stack.push(p);
    while (stack.length) {
      const q = stack.pop(); count++;
      const x = q % W, y = (q - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const tryPush = (n) => { if (out[n * 4 + 3] !== 0 && !label[n]) { label[n] = id; stack.push(n); } };
      if (x > 0) tryPush(q - 1);
      if (x < W - 1) tryPush(q + 1);
      if (y > 0) tryPush(q - W);
      if (y < H - 1) tryPush(q + W);
    }
    if (count >= MIN_BLOB_PIXELS) blobs.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, count });
  }

  // --- 5. 歸格 ---
  const cw = W / cols, ch = H / rows;
  const cells = new Array(cols * rows).fill(null);
  const merge = (idx, b) => {
    const c = cells[idx];
    cells[idx] = c ? { x0: Math.min(c.x0, b.x0), y0: Math.min(c.y0, b.y0), x1: Math.max(c.x1, b.x1), y1: Math.max(c.y1, b.y1) } : { ...b };
  };
  for (const b of blobs) {
    const row = Math.min(rows - 1, Math.floor(((b.y0 + b.y1) / 2) / ch));
    if (b.x1 - b.x0 > MERGED_CELL_RATIO * cw) {
      const c0 = Math.floor(b.x0 / cw), c1 = Math.min(cols - 1, Math.floor((b.x1 - 1) / cw));
      for (let c = c0; c <= c1; c++) {
        merge(row * cols + c, { x0: Math.max(b.x0, Math.floor(c * cw)), y0: b.y0, x1: Math.min(b.x1, Math.floor((c + 1) * cw)), y1: b.y1 });
      }
    } else {
      const col = Math.min(cols - 1, Math.floor(((b.x0 + b.x1) / 2) / cw));
      merge(row * cols + col, b);
    }
  }

  const frames = cells.map((c) => (c ? crop({ width: W, height: H, data: out }, c) : null));
  return { frames, background: bg, blobCount: blobs.length };
}

/** 像素是否帶著背景色的色調（以背景色最弱的色道為基準，其餘兩個色道都高出 TINT_MARGIN）。 */
function isBackgroundTinted(data, i, bg) {
  const weak = bg.indexOf(Math.min(...bg));
  for (let c = 0; c < 3; c++) if (c !== weak && data[i + c] < data[i + weak] + TINT_MARGIN) return false;
  return true;
}

export function sampleCornerColor({ width: W, height: H, data }) {
  const idx = [0, (W - 1) * 4, (H - 1) * W * 4, ((H - 1) * W + W - 1) * 4];
  return [0, 1, 2].map((c) => Math.round(idx.reduce((s, i) => s + data[i + c], 0) / 4));
}

export function crop({ width: W, data }, { x0, y0, x1, y1 }) {
  const w = x1 - x0, h = y1 - y0;
  const outData = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * W + x0) * 4;
    outData.set(data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: outData, x0, y0, x1, y1 };
}

// 幀名固定順序：第一列走路四格，第二列 idle / 蹲 / 空中 / 落地。gemini.js 的提示詞照這個順序寫。
export const FRAME_NAMES = ['walk0', 'walk1', 'walk2', 'walk3', 'idle', 'crouch', 'air', 'land'];
