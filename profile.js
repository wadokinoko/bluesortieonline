/* プレイヤープロフィール(端末ローカル保存)。将来アカウント認証を入れる場合も pid をキーに拡張できる。 */
import { CONFIG } from './config.js';
import { sanitizeName, sanitizeLivery } from '../shared/rules.js';

const rid = () => {
  try { if (crypto.randomUUID) return 'p' + crypto.randomUUID().replace(/-/g, '').slice(0, 14); } catch (e) { /* fallthrough */ }
  return 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
};

export function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(CONFIG.STORAGE.profile) || '{}') || {}; } catch (e) { p = {}; }
  const prof = {
    id: typeof p.id === 'string' && p.id.length >= 8 ? p.id : rid(),
    name: sanitizeName(p.name) || 'PILOT-' + String(Math.floor(1000 + Math.random() * 9000)),
    livery: sanitizeLivery(p.livery),
    stats: { sorties: 0, arenaSec: 0, ...(p.stats || {}) },
  };
  saveProfile(prof);
  return prof;
}
export function saveProfile(p) {
  try { localStorage.setItem(CONFIG.STORAGE.profile, JSON.stringify(p)); } catch (e) { /* private mode 等 */ }
}

const DEF_SETTINGS = { touch: 'auto', sound: true };
export function loadSettings() {
  try { return { ...DEF_SETTINGS, ...(JSON.parse(localStorage.getItem(CONFIG.STORAGE.settings) || '{}') || {}) }; } catch (e) { return { ...DEF_SETTINGS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(CONFIG.STORAGE.settings, JSON.stringify(s)); } catch (e) { /* ignore */ }
}
