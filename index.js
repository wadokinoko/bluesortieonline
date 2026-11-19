/* BLUE SORTIE ONLINE - Cloudflare Worker (入口)
 *
 *   POST /api/rooms   { pid, name?, settings? } -> 200 { code }
 *   GET  /ws/:code    WebSocket Upgrade → ルームの Durable Object へ転送
 *   GET  /health      { ok, proto }
 *
 * 環境変数 ALLOWED_ORIGINS (カンマ区切り。例 "https://bso.vercel.app,http://localhost:3000") で
 * ブラウザからのアクセス元を制限する。未設定なら全許可(開発用)。 */
import { PROTO } from '../../shared/protocol.js';
import { genRoomCode, isRoomCode, sanitizeSettings, defaultSettings } from '../../shared/rules.js';
import { BsoRoom } from './room-do.js';

export { BsoRoom };

const MAX_BODY = 2048;
const PID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const CREATE_PER_MIN = 10;
const secureRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

/* ---- Origin 許可リスト ("*" 全許可 / "https://*.example.com" 形式のワイルドカード可) ---- */
function parseOrigins(v) {
  const list = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.includes('*')) return null;
  return list.map((o) => new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[A-Za-z0-9-]+') + '$'));
}
export function originAllowed(origin, env) {
  const rules = parseOrigins(env && env.ALLOWED_ORIGINS);
  if (!rules || !origin) return true; // Origin なし = ブラウザ以外(curl/テスト)。ブラウザは必ず付ける
  return rules.some((r) => r.test(origin));
}

const hdr = (origin, env) => (origin && originAllowed(origin, env)
  ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' }
  : { vary: 'Origin' });
const json = (o, status, origin, env) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...hdr(origin, env) } });

/* ---- 作成APIのレート制限 (この isolate 内の簡易版。本格運用は Cloudflare のレート制限ルールを併用) ---- */
const hits = new Map();
function limited(ip, now) {
  if (hits.size > 5000) hits.clear();
  const h = hits.get(ip);
  if (!h || now - h.t > 60000) { hits.set(ip, { t: now, n: 1 }); return false; }
  return ++h.n > CREATE_PER_MIN;
}

async function createRoom(request, env, origin) {
  if (!env.ROOMS) return json({ error: 'server_misconfigured' }, 500, origin, env);
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: 'too_large' }, 413, origin, env);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413, origin, env);
  let b; try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad_request' }, 400, origin, env); }
  if (!b || typeof b !== 'object' || typeof b.pid !== 'string' || !PID_RE.test(b.pid)) return json({ error: 'bad_request' }, 400, origin, env);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (limited(ip, Date.now())) return json({ error: 'rate_limited' }, 429, origin, env);
  if (env.CREATE_LIMITER && typeof env.CREATE_LIMITER.limit === 'function') { // 任意: Workers Rate Limiting バインディング
    const r = await env.CREATE_LIMITER.limit({ key: ip });
    if (r && r.success === false) return json({ error: 'rate_limited' }, 429, origin, env);
  }

  const settings = sanitizeSettings(b.settings, defaultSettings(), 0); // プレイヤー名は hello で受け取るため保存しない
  for (let i = 0; i < 6; i++) {
    const code = genRoomCode(secureRand);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, hostId: b.pid, settings }) });
    if (res.status === 200) return json({ code }, 200, origin, env);
    if (res.status !== 409) return json({ error: 'upstream' }, 502, origin, env);
  }
  return json({ error: 'busy' }, 503, origin, env);
}

async function route(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const path = url.pathname;

  if (path === '/health') return json({ ok: true, proto: PROTO }, 200, origin, env);

  if (path === '/api/rooms') {
    if (!originAllowed(origin, env)) return json({ error: 'forbidden_origin' }, 403, origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: hdr(origin, env) });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin, env);
    return createRoom(request, env, origin);
  }

  const m = /^\/ws\/([^/]+)$/.exec(path);
  if (m) {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, origin, env);
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'upgrade_required' }, 426, origin, env);
    if (!originAllowed(origin, env)) return json({ error: 'forbidden_origin' }, 403, origin, env);
    let code; try { code = decodeURIComponent(m[1]); } catch (e) { code = ''; }
    if (!isRoomCode(code)) return json({ error: 'bad_code' }, 400, origin, env);
    if (!env.ROOMS) return json({ error: 'server_misconfigured' }, 500, origin, env);
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  }
  return json({ error: 'not_found' }, 404, origin, env);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); } catch (e) {
      console.error('worker error', e && e.message); // スタックや入力内容は返さない
      return new Response(JSON.stringify({ error: 'internal' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  },
};
