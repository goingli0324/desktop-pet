// 肚子／心情數值（按種類共用：同一種動物不管出現幾隻，共用一組）。
// 不碰 Electron，主程序注入檔案路徑與時鐘，單元測試可直接用。
//
// needs.json schema： { version: 1, species: { <petId>: { hunger, affection, lastCareAt, awaySeconds, updatedAt } } }
//   hunger／affection：0–100，越高越好。lastCareAt：最後一次餵或摸（ms）。
//   awaySeconds：使用者連續不在（閒置或程式關著）累積秒數，用來限制肚子最多扣 12 小時。
//   updatedAt：最後一次結算時間（ms），重開程式時用它補算離線時間。
// 獨立於 settings.json：每分鐘存一次，不跟設定頁的寫入互相蓋掉。

import fs from 'node:fs';
import path from 'node:path';

export const TUNING = {
  hungerPerHour: 100 / 8,     // 約 8 小時從滿到空
  affectionPerHour: 100 / 3,  // 人在電腦前、約 3 小時沒理就從滿到空
  feedHunger: 40,
  feedAffection: 10,
  petAffection: 15,
  awayHungerCapSeconds: 12 * 3600, // 一次離開最多扣 12 小時份的肚子
  awayHungerFloor: 20,              // 人不在時肚子最低只扣到這裡：回來是「餓」不是「生氣」
  happySeconds: 30,
  hungry: 30,
  lonely: 40,
  angry: 15,
};

const clamp = (v) => Math.max(0, Math.min(100, v));

export function freshNeeds(now) {
  return { hunger: 80, affection: 80, lastCareAt: 0, awaySeconds: 0, updatedAt: now };
}

/** 經過 seconds 秒後的數值。present＝使用者在電腦前：心情只在人在時扣，人不在時肚子最多扣到上限。 */
export function decay(needs, seconds, present) {
  if (!(seconds > 0)) return needs;
  let hungerSeconds = seconds;
  let awaySeconds = 0;
  if (!present) {
    const already = needs.awaySeconds || 0;
    hungerSeconds = Math.max(0, Math.min(seconds, TUNING.awayHungerCapSeconds - already));
    awaySeconds = already + seconds;
  }
  let hunger = clamp(needs.hunger - (TUNING.hungerPerHour * hungerSeconds) / 3600);
  if (!present) hunger = Math.max(hunger, Math.min(needs.hunger, TUNING.awayHungerFloor));
  return {
    ...needs,
    hunger,
    affection: present ? clamp(needs.affection - (TUNING.affectionPerHour * seconds) / 3600) : needs.affection,
    awaySeconds,
  };
}

export function feed(needs, now) {
  return { ...needs, hunger: clamp(needs.hunger + TUNING.feedHunger), affection: clamp(needs.affection + TUNING.feedAffection), lastCareAt: now };
}

export function pet(needs, now) {
  return { ...needs, affection: clamp(needs.affection + TUNING.petAffection), lastCareAt: now };
}

/** 由數值推出情緒。剛被照顧過優先顯示開心。 */
export function moodOf(needs, now) {
  if (!needs) return 'content';
  if (now - (needs.lastCareAt || 0) < TUNING.happySeconds * 1000) return 'happy';
  if (needs.affection < TUNING.angry || needs.hunger < TUNING.angry) return 'angry';
  if (needs.hunger < TUNING.hungry) return 'hungry';
  if (needs.affection < TUNING.lonely) return 'lonely';
  return 'content';
}

function sanitize(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    hunger: clamp(num(raw.hunger, 80)),
    affection: clamp(num(raw.affection, 80)),
    lastCareAt: Math.min(num(raw.lastCareAt, 0), now),
    awaySeconds: Math.max(0, num(raw.awaySeconds, 0)),
    updatedAt: Math.min(num(raw.updatedAt, now), now), // 時鐘被調回去時不倒扣
  };
}

/**
 * 數值存放與結算。
 * @param {{ file: string, now?: () => number, timeScale?: number }} opts timeScale 只給開發驗證用（加速時間）
 */
export function createNeedsStore({ file, now = Date.now, timeScale = 1 }) {
  let species = {};

  function load() {
    species = {};
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
    const t = now();
    for (const [id, raw] of Object.entries(data?.species || {})) {
      const n = sanitize(raw, t);
      if (n) species[id] = n;
    }
  }

  /** 讀檔後呼叫一次：程式關著的時間當作人不在，只補扣桌面上有的種類（肚子有上限，心情不扣）。 */
  function catchUp(activeIds) {
    const t = now();
    const active = new Set(activeIds);
    for (const [id, n] of Object.entries(species)) {
      species[id] = active.has(id) ? { ...decay(n, ((t - n.updatedAt) / 1000) * timeScale, false), updatedAt: t } : { ...n, updatedAt: t };
    }
  }

  function save() {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, species }, null, 2));
    fs.renameSync(tmp, file);
  }

  function get(id) {
    if (!species[id]) species[id] = freshNeeds(now());
    return species[id];
  }

  return {
    load,
    catchUp,
    save,
    get,
    /** 主程序每幀呼叫：只結算桌面上有出現的種類。 */
    tick(seconds, present, activeIds) {
      const t = now();
      for (const id of activeIds) species[id] = { ...decay(get(id), seconds * timeScale, present), updatedAt: t };
    },
    /** 沒在桌面上的種類，updatedAt 也要往前推，免得之後被當成離線補扣。 */
    touchInactive(activeIds) {
      const t = now();
      const active = new Set(activeIds);
      for (const id of Object.keys(species)) if (!active.has(id)) species[id] = { ...species[id], updatedAt: t };
    },
    feed(id) { species[id] = feed(get(id), now()); },
    pet(id) { species[id] = pet(get(id), now()); },
    mood(id) { return moodOf(species[id], now()); },
    remove(id) { delete species[id]; },
    snapshot() { return JSON.parse(JSON.stringify(species)); },
  };
}
