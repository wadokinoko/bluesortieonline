import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installCloudflareGlobals, FakeNamespace, makeWebSocketClass } from './fake-cf.mjs';
installCloudflareGlobals();
const { default: worker, originAllowed } = await import('../src/index.js');
const { isRoomCode } = await import('../../shared/rules.js');

const ORIGIN = 'https://bso.example.app';
const envs = [];
const mkEnv = (extra = {}) => { const env = { ALLOWED_ORIGINS: ORIGIN + ',http://localhost:3000', ...extra }; env.ROOMS = new FakeNamespace(env); envs.push(env); return env; };
after(() => envs.forEach((e) => e.ROOMS.objs.forEach((o) => o.inst.core.close()))); // 残タイマーを止めてプロセスを終了させる
let ipSeq = 0;
const post = (env, body, headers = {}) => worker.fetch(new Request('https://api.test/api/rooms', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.' + (++ipSeq), origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);
const wsFetch = (env, headers = {}) => (req) => worker.fetch(req, env);
const connect = (env, code, headers) => { const WS = makeWebSocketClass(wsFetch(env), headers); const ws = new WS('wss://api.test/ws/' + code); ws.inbox = []; ws.onmessage = (e) => ws.inbox.push(JSON.parse(e.data)); ws.opened = new Promise((r) => { ws.onopen = r; ws.onclose = () => { ws.closed = true; r(); }; }); return ws; };
const until = async (f, ms = 1000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout: ' + f); await new Promise((r) => setTimeout(r, 5)); } };
const hello = (ws, pid, extra = {}) => ws.send(JSON.stringify({ t: 'hello', id: 1, v: 1, pid, tok: 'tok-' + pid, name: 'N', livery: 'solaris', ...extra }));

test('POST /api/rooms: ルームコードを返し、DO にホスト・設定だけが保存される(名前は保存しない)', async () => {
  const env = mkEnv();
  const res = await post(env, { pid: 'host-0001', name: '<b>SECRET NAME</b>', settings: { map: 'desert', maxPlayers: 99, evil: 1 } });
  assert.equal(res.status, 200); const { code } = await res.json(); assert.ok(isRoomCode(code), code);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(res.headers.get('cache-control'), 'no-store');
  const meta = await env.ROOMS.storage(code).get('meta');
  assert.equal(meta.hostId, 'host-0001'); assert.equal(meta.settings.map, 'desert'); assert.equal(meta.settings.maxPlayers, 4); assert.ok(!('evil' in meta.settings));
  assert.ok(!JSON.stringify(meta).includes('SECRET'), '名前は保存されない');
  assert.ok(env.ROOMS.storage(code).alarm > Date.now(), '未使用ルームの破棄アラームが設定される');
});

test('作成者が最初に入室するとホストになる / ルームは作成者のIDで予約される', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001' })).json();
  const ws = connect(env, code); await ws.opened; hello(ws, 'host-0001'); await until(() => ws.inbox.some((m) => m.t === 'welcome'));
  assert.equal(ws.inbox.find((m) => m.t === 'welcome').room.hostId, 'host-0001');
  assert.equal(env.ROOMS.storage(code).alarm, null, '入室したので破棄アラームは解除');
});

test('POST /api/rooms: 不正リクエストは 400/405/413 で拒否される', async () => {
  const env = mkEnv();
  assert.equal((await post(env, '{bad json')).status, 400);
  assert.equal((await post(env, {})).status, 400);
  assert.equal((await post(env, { pid: 'short' })).status, 400);
  assert.equal((await post(env, { pid: 'bot:kite-0001' })).status, 400);
  assert.equal((await post(env, [1, 2])).status, 400);
  assert.equal((await post(env, { pid: 'host-0001', pad: 'x'.repeat(3000) })).status, 413);
  const get = await worker.fetch(new Request('https://api.test/api/rooms', { method: 'GET', headers: { origin: ORIGIN } }), env); assert.equal(get.status, 405);
  assert.equal((await worker.fetch(new Request('https://api.test/nope'), env)).status, 404);
  const h = await worker.fetch(new Request('https://api.test/health'), env); assert.deepEqual(await h.json(), { ok: true, proto: 1 });
});

test('CORS: 許可Originのみ。preflight に応答し、不許可は 403', async () => {
  const env = mkEnv();
  const pre = await worker.fetch(new Request('https://api.test/api/rooms', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN); assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  const evil = await post(env, { pid: 'host-0001' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await post(env, { pid: 'host-0001' }, { origin: 'http://localhost:3000' })).status, 200);
  const open = mkEnv({ ALLOWED_ORIGINS: '' }); assert.equal((await post(open, { pid: 'host-0001' }, { origin: 'https://anything.example' })).status, 200, '未設定なら全許可(開発用)');
  assert.equal(originAllowed('https://a-1.vercel.app', { ALLOWED_ORIGINS: 'https://*.vercel.app' }), true);
  assert.equal(originAllowed('https://evil.com/.vercel.app', { ALLOWED_ORIGINS: 'https://*.vercel.app' }), false);
  assert.equal(originAllowed('https://x.vercel.app.evil.com', { ALLOWED_ORIGINS: 'https://*.vercel.app' }), false);
});

test('作成APIのレート制限: 同一IPの連続作成は 429', async () => {
  const env = mkEnv(); const ip = { 'cf-connecting-ip': '203.0.113.77' }; const codes = [];
  for (let i = 0; i < 10; i++) { const r = await post(env, { pid: 'host-0001' }, ip); assert.equal(r.status, 200); codes.push((await r.json()).code); }
  assert.equal(new Set(codes).size, 10, 'コードは重複しない');
  assert.equal((await post(env, { pid: 'host-0001' }, ip)).status, 429);
  assert.equal((await post(env, { pid: 'host-0001' })).status, 200, '別IPは影響なし');
  const lim = mkEnv({ CREATE_LIMITER: { limit: async () => ({ success: false }) } }); assert.equal((await post(lim, { pid: 'host-0001' })).status, 429, 'Rate Limiting バインディング拒否');
});

test('コード衝突: 409 なら別コードで再試行、続けば 503 / DO異常は 502', async () => {
  const env = mkEnv(); let n = 0; env.ROOMS.initHook = () => (++n < 3 ? new Response('{}', { status: 409 }) : null);
  assert.equal((await post(env, { pid: 'host-0001' })).status, 200); assert.equal(n, 3);
  const env2 = mkEnv(); env2.ROOMS.initHook = () => new Response('{}', { status: 409 }); assert.equal((await post(env2, { pid: 'host-0001' })).status, 503);
  const env3 = mkEnv(); env3.ROOMS.initHook = () => new Response('x', { status: 500 }); assert.equal((await post(env3, { pid: 'host-0001' })).status, 502);
  const env4 = { ALLOWED_ORIGINS: '' }; assert.equal((await post(env4, { pid: 'host-0001' })).status, 500, 'バインディング未設定');
});

test('同じコードの二重 init は 409(既存ルームを上書きできない)', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001' })).json();
  const again = await env.ROOMS.get(code).fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, hostId: 'attacker-01', settings: {} }) });
  assert.equal(again.status, 409); assert.equal((await env.ROOMS.storage(code).get('meta')).hostId, 'host-0001');
});

test('GET /ws/:code: Upgrade 必須(426)・不正コード(400)・不許可Origin(403)・メソッド違い(405)', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001' })).json();
  const g = (path, headers = {}, method = 'GET') => worker.fetch(new Request('https://api.test' + path, { method, headers }), env);
  assert.equal((await g('/ws/' + code)).status, 426);
  for (const bad of ['abc', 'abcdef', 'ABCDE0', 'ABCDEFG', '%E0%A4%A']) assert.equal((await g('/ws/' + bad, { upgrade: 'websocket' })).status, 400, bad);
  assert.equal((await g('/ws/' + code, { upgrade: 'websocket', origin: 'https://evil.example' })).status, 403);
  assert.equal((await g('/ws/' + code, { upgrade: 'websocket' }, 'POST')).status, 405);
  assert.equal((await g('/ws/' + code + '/x', { upgrade: 'websocket' })).status, 404);
  const ok = await g('/ws/' + code, { upgrade: 'websocket', origin: ORIGIN }); assert.equal(ok.status, 101);
});

test('作成されていないコードに接続すると hello に room_not_found が返り切断される', async () => {
  const env = mkEnv(); const ws = connect(env, 'ZZZZZZ'); await ws.opened; hello(ws, 'pilot-0001');
  await until(() => ws.inbox.length && ws.closed); assert.equal(ws.inbox[0].code, 'room_not_found'); assert.equal(ws.inbox[0].re, 1);
  assert.equal(env.ROOMS.storage('ZZZZZZ').m.size, 0, '存在しないルームに何も保存しない');
});

test('2人入室 → 満員拒否 → 準備 → 開始通知 → 状態同期 → チャット (Worker+DO 経由)', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001', settings: { maxPlayers: 2 } })).json();
  const A = connect(env, code), B = connect(env, code), C = connect(env, code);
  await Promise.all([A.opened, B.opened, C.opened]);
  hello(A, 'host-0001'); await until(() => A.inbox.some((m) => m.t === 'welcome'));
  hello(B, 'pilot-0002'); await until(() => B.inbox.some((m) => m.t === 'welcome'));
  hello(C, 'pilot-0003'); await until(() => C.inbox.some((m) => m.t === 'error')); assert.equal(C.inbox.find((m) => m.t === 'error').code, 'room_full');
  B.send(JSON.stringify({ t: 'room.ready', ready: true })); A.send(JSON.stringify({ t: 'room.start' }));
  await until(() => A.inbox.some((m) => m.t === 'room.start') && B.inbox.some((m) => m.t === 'room.start'), 5000);
  const GOOD = [1, 2300, 3, 0, 0, 0, 1, 200, 100, 0];
  A.send(JSON.stringify({ t: 'state', s: GOOD })); B.send(JSON.stringify({ t: 'state', s: GOOD }));
  await until(() => A.inbox.some((m) => m.t === 'snap') && B.inbox.some((m) => m.t === 'snap'));
  assert.deepEqual(Object.keys(A.inbox.find((m) => m.t === 'snap').players), ['pilot-0002']);
  A.send(JSON.stringify({ t: 'chat', text: 'hi' })); await until(() => B.inbox.some((m) => m.t === 'chat'));
  assert.equal(B.inbox.find((m) => m.t === 'chat').text, 'hi');
  A.close(); B.close();
});

test('全員退出するとルームの保存データとアラームが消える。再接続は room_not_found', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001' })).json();
  const A = connect(env, code); await A.opened; hello(A, 'host-0001'); await until(() => A.inbox.some((m) => m.t === 'welcome'));
  A.send(JSON.stringify({ t: 'room.leave' })); await until(() => A.closed);
  await until(() => env.ROOMS.storage(code).m.size === 0); assert.equal(env.ROOMS.storage(code).alarm, null);
  const B = connect(env, code); await B.opened; hello(B, 'host-0001'); await until(() => B.inbox.length);
  assert.equal(B.inbox[0].code, 'room_not_found');
});

test('DO がメモリから落ちても storage から復元され、同じコードで入室できる', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001', settings: { map: 'arctic' } })).json();
  env.ROOMS.evict(code);
  const A = connect(env, code); await A.opened; hello(A, 'host-0001'); await until(() => A.inbox.some((m) => m.t === 'welcome'));
  assert.equal(A.inbox.find((m) => m.t === 'welcome').room.settings.map, 'arctic');
});

test('未使用ルームのアラーム: 誰もいなければ破棄、接続中なら残る', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001' })).json();
  await env.ROOMS.instance(code).alarm(); await until(() => env.ROOMS.storage(code).m.size === 0);
  const { code: c2 } = await (await post(env, { pid: 'host-0001' })).json();
  const A = connect(env, c2); await A.opened; hello(A, 'host-0001'); await until(() => A.inbox.some((m) => m.t === 'welcome'));
  await env.ROOMS.instance(c2).alarm(); assert.equal(env.ROOMS.storage(c2).m.size, 1, '接続中は破棄しない'); A.close();
});

test('1接続の処理で例外が出ても、その接続だけ閉じて他の接続・ルームは生き続ける', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001' })).json();
  const A = connect(env, code), B = connect(env, code); await Promise.all([A.opened, B.opened]);
  hello(A, 'host-0001'); hello(B, 'pilot-0002'); await until(() => B.inbox.some((m) => m.t === 'welcome'));
  const inst = env.ROOMS.instance(code); const orig = inst.core.receive.bind(inst.core); let thrown = 0;
  inst.core.receive = (conn, raw) => { if (String(raw).includes('boom')) { thrown++; throw new Error('boom'); } return orig(conn, raw); };
  const origErr = console.error; console.error = () => {}; try { B.send(JSON.stringify({ t: 'chat', text: 'boom' })); await until(() => B.closed); } finally { console.error = origErr; }
  assert.equal(thrown, 1); A.send(JSON.stringify({ t: 'ping', ts: 5 })); await until(() => A.inbox.some((m) => m.t === 'pong'));
  assert.equal(A.closed, undefined);
});

test('不正なWebSocketメッセージ(巨大・バイナリ)は接続を閉じる', async () => {
  const env = mkEnv(); const { code } = await (await post(env, { pid: 'host-0001' })).json();
  const A = connect(env, code); await A.opened; hello(A, 'host-0001'); await until(() => A.inbox.some((m) => m.t === 'welcome'));
  A.send('x'.repeat(5000)); await until(() => A.closed);
  const B = connect(env, code); await B.opened; hello(B, 'host-0001'); await until(() => B.inbox.length, 2000); // 猶予内の再入室(同tok)
  assert.equal(B.inbox[0].t, 'welcome');
});
