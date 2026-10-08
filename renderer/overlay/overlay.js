// 桌面覆蓋層（drawer）：模擬在主程序，這裡只負責把主程序每幀送來的清單畫出來。
// 本視窗只罩「一個螢幕」；主程序送來的座標已是本螢幕的本地座標。

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let imgs = new Map(); // petId → { frameName: HTMLImageElement }

resize();
window.addEventListener('resize', resize);
await preloadImages(await window.pet.getActivePets());
window.pet.onPetsChanged(preloadImages);
window.pet.onDraw(draw);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

async function preloadImages(list) {
  if (!Array.isArray(list)) return;
  const next = new Map();
  await Promise.all(list.map((p) => new Promise((resolve) => {
    const frames = {};
    let pending = Object.keys(p.frames).length;
    if (!pending) { next.set(p.id, frames); return resolve(); }
    for (const [name, url] of Object.entries(p.frames)) {
      const img = new Image();
      img.onload = img.onerror = () => { frames[name] = img; if (--pending === 0) { next.set(p.id, frames); resolve(); } };
      img.src = url;
    }
  })));
  imgs = next;
}

function draw({ items, grab, foods = [] }) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  document.body.classList.toggle('grab', !!grab);
  for (const f of foods) drawFood(f);
  for (const it of items) {
    const frames = imgs.get(it.petId);
    const img = frames && (frames[it.frame] || frames.idle);
    if (!img || !img.naturalWidth) continue;
    ctx.save();
    ctx.translate(it.x, it.y - it.lift);
    ctx.rotate(it.rot * it.facing);
    ctx.scale(it.facing * it.sx, it.sy);
    if (it.lean) ctx.transform(1, 0, -it.lean, 1, 0, 0); // 腳不動、越高往前移越多（圖預設面向右，鏡像後一樣是往前）
    ctx.drawImage(img, -it.w / 2, -it.h, it.w, it.h);
    ctx.restore();
    if (it.sleeping) drawZzz(it.x + it.w * 0.35 * it.facing, it.y - it.h - 6, it.sleepT);
    if (it.bubble) drawBubble(it);
  }
}

// 食物：一口一口變小；剛咬下去時彈一下、冒三顆碎屑往外掉
const CRUMB_SECONDS = 0.45;
function drawFood(f) {
  const scale = f.scale ?? 1;
  if (scale <= 0) return;
  const age = f.biteAge;
  const fresh = age !== null && age !== undefined && age < CRUMB_SECONDS;
  const squish = fresh ? 1 - 0.18 * Math.sin((age / CRUMB_SECONDS) * Math.PI) : 1;
  const size = (f.size || 26) * scale;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(1 / squish, squish); // 被咬那一下壓扁再彈回
  drawEmoji(f.emoji, 0, 0, size, 1);
  ctx.restore();
  if (!fresh) return;
  const p = age / CRUMB_SECONDS;
  ctx.save();
  ctx.fillStyle = `rgba(150, 105, 55, ${1 - p})`;
  for (const [dx, up] of [[-1, 1], [0.3, 1.4], [1, 0.9]]) {
    const cx = f.x + dx * size * (0.45 + 0.6 * p);
    const cy = f.y - size * 0.95 - up * 14 * p + 34 * p * p; // 從食物上緣往外噴再落下，不疊在食物上
    ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// 表情泡泡（❤️ 💢 💭 食物）：頭頂斜上方，緩緩上飄，最後 30% 淡出
function drawBubble(it) {
  const p = it.bubbleT;
  const alpha = p < 0.7 ? 1 : Math.max(0, (1 - p) / 0.3);
  const pop = p < 0.08 ? 0.6 + 5 * p : 1; // 冒出來時小彈一下
  const size = Math.max(26, Math.min(44, it.h * 0.4)); // 跟體型走：鼠小、龍大
  drawEmoji(it.bubble, it.x + it.w * 0.3 * it.facing, it.y - it.lift - it.h + size * 0.15 - p * 14, size * pop, alpha);
}

function drawEmoji(emoji, x, y, size, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${Math.round(size)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(emoji, x, y);
  ctx.restore();
}

function drawZzz(x, y, t) {
  const phase = (t % 2) / 2;
  ctx.save();
  ctx.font = '20px sans-serif';
  ctx.fillStyle = `rgba(80,80,120,${0.9 - phase * 0.8})`;
  ctx.fillText('z', x + phase * 10, y - phase * 24);
  ctx.fillText('Z', x + 12 + phase * 10, y - 14 - phase * 24);
  ctx.restore();
}

// 滑鼠：只轉發按下／放開／右鍵給主程序（hover 與拖曳位置由主程序用全域游標算）
window.addEventListener('mousedown', (e) => { if (e.button === 0) window.pet.petMouse('down'); });
window.addEventListener('mouseup', () => window.pet.petMouse('up'));
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.pet.showPetMenu(); });
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault());
