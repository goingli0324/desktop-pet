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

function draw({ items, grab }) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  document.body.classList.toggle('grab', !!grab);
  for (const it of items) {
    const frames = imgs.get(it.petId);
    const img = frames && (frames[it.frame] || frames.idle);
    if (!img || !img.naturalWidth) continue;
    ctx.save();
    ctx.translate(it.x, it.y - it.lift);
    ctx.rotate(it.rot * it.facing);
    ctx.scale(it.facing * it.sx, it.sy);
    ctx.drawImage(img, -it.w / 2, -it.h, it.w, it.h);
    ctx.restore();
    if (it.sleeping) drawZzz(it.x + it.w * 0.35 * it.facing, it.y - it.h - 6, it.sleepT);
  }
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
