/* BLUE SORTIE ONLINE - 共有ルール (純粋なES module)
 * ブラウザと Cloudflare Workers / Durable Objects の両方から import できるよう、
 * DOM・window・Three.js には一切依存しない。 */

export const CODE_LEN = 6;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O/1/I を除外
export const MAX_NAME = 12;

export const MODES = [
  { id: 'dogfight', nm: 'ドッグファイト', ds: '個人戦。撃墜数を競う' },
  { id: 'tdm', nm: 'チームデスマッチ', ds: '2チーム対抗戦' },
  { id: 'coop', nm: '協力ミッション', ds: '全員でファントムに挑む' },
];
export const MAPS = [
  { id: 'isles', nm: '島嶼海域' }, { id: 'desert', nm: '砂漠' }, { id: 'arctic', nm: '氷海' },
  { id: 'canyon', nm: '峡谷' }, { id: 'volcano', nm: '火山島' },
];
export const TODS = [
  { id: 'day', nm: '昼' }, { id: 'dusk', nm: '夕暮れ' }, { id: 'dawn', nm: '夜明け' },
  { id: 'storm', nm: '嵐' }, { id: 'night', nm: '夜' },
];
export const PLAYER_LIMITS = [2, 4, 6, 8];
export const TIME_LIMITS = [300, 600, 900];

/* c = [機体色, アクセント, トリム] (Blue Sortie 4 の FAC 配色を継承) */
export const LIVERIES = [
  { id: 'solaris', nm: 'ソラリス', c: [0xdfe8f0, 0x2f6fb5, 0xffb347] },
  { id: 'phantom', nm: 'ファントム', c: [0x15181d, 0x23423f, 0x3affc8] },
  { id: 'crimson', nm: 'クリムゾン', c: [0x4a5240, 0x8a2a24, 0xd9c46a] },
  { id: 'violet', nm: 'ヴァイオレット', c: [0x2c3548, 0x6a2f86, 0xd8d8e0] },
  { id: 'hollow', nm: 'ホロウ', c: [0x0c0d10, 0xe0e6ee, 0xff3a4a] },
];
export const liveryOf = (id) => LIVERIES.find((l) => l.id === id) || LIVERIES[0];

export const defaultSettings = () => ({ mode: 'dogfight', map: 'isles', tod: 'day', maxPlayers: 4, timeLimit: 600 });

const has = (list, id) => list.some((x) => x.id === id);

/** 設定パッチを検証して新しい設定オブジェクトを返す(不正値は無視)。サーバー側でも必ず通すこと。 */
export function sanitizeSettings(patch, base = defaultSettings(), playerCount = 0) {
  const s = { ...base };
  const p = patch || {};
  if (has(MODES, p.mode)) s.mode = p.mode;
  if (has(MAPS, p.map)) s.map = p.map;
  if (has(TODS, p.tod)) s.tod = p.tod;
  if (PLAYER_LIMITS.includes(p.maxPlayers) && p.maxPlayers >= playerCount) s.maxPlayers = p.maxPlayers;
  if (TIME_LIMITS.includes(p.timeLimit)) s.timeLimit = p.timeLimit;
  return s;
}

export function sanitizeName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}
export const sanitizeLivery = (id) => (has(LIVERIES, id) ? id : LIVERIES[0].id);

export function genRoomCode(rand = Math.random) {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return c;
}
export function normalizeCode(s) {
  return String(s == null ? '' : s).toUpperCase().split('').filter((c) => CODE_ALPHABET.includes(c)).join('').slice(0, CODE_LEN);
}
export const isRoomCode = (s) => typeof s === 'string' && s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c));

/* ---- 機体状態スナップショット (1機 = 数値配列。JSONでも将来バイナリ化でも扱える) ----
 * [x, y, z, qx, qy, qz, qw, speed, hp, flags]   flags: bit0=dead, bit1=flare, bit2=barrier */
const r1 = (v) => Math.round(v * 10) / 10;
const r4 = (v) => Math.round(v * 10000) / 10000;
export function packState(p) {
  return [r1(p.x), r1(p.y), r1(p.z), r4(p.qx), r4(p.qy), r4(p.qz), r4(p.qw), Math.round(p.speed), Math.round(p.hp), p.flags | 0];
}
export function unpackState(a) {
  if (!Array.isArray(a) || a.length < 10 || a.some((v) => typeof v !== 'number' || !isFinite(v))) return null;
  return { x: a[0], y: a[1], z: a[2], qx: a[3], qy: a[4], qz: a[5], qw: a[6], speed: a[7], hp: a[8], flags: a[9] };
}

/* ---- 開始位置: スロット番号から円周上に等間隔で配置し、中心を向く(クライアント・サーバー共通) ---- */
export function spawnFor(slot, count, alt = 2300, radius = 1400) {
  const a = (slot / Math.max(1, count)) * Math.PI * 2;
  return { x: Math.cos(a) * radius, y: alt, z: Math.sin(a) * radius, yaw: Math.atan2(Math.cos(a), Math.sin(a)) };
}
