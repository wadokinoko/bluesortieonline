/* 実クライアント(NetClient + CloudflareBackend)から Worker + DO(偽の Cloudflare 実行環境)を通しで操作する結合テスト。
 * 本物の workerd ではなく fake-cf.mjs 上で動く点に注意 (docs/DEPLOY.md 参照)。 */
globalThis.window = {}; globalThis.location = { search: '' };
import { installCloudflareGlobals, FakeNamespace, makeWebSocketClass } from './fake-cf.mjs';
installCloudflareGlobals();
const { default: worker } = await import('../src/index.js');
const { createStore } = await import('../../js/state/store.js');
const { initialState, reducer, canStart, isHost, slotOf } = await import('../../js/state/app-state.js');
const { NetClient } = await import('../../js/net/netclient.js');
const { CloudflareBackend } = await import('../../js/net/backend-cloudflare.js');
const { isRoomCode } = await import('../../shared/rules.js');

let fails = 0;
const ok = (c, m) => { console.log((c ? ' ok  ' : 'FAIL ') + m); if (!c) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await wait(15); } return true; };

const env = { ALLOWED_ORIGINS: '' }; env.ROOMS = new FakeNamespace(env);
globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
globalThis.WebSocket = makeWebSocketClass((req) => worker.fetch(req, env));
const backend = new CloudflareBackend({ apiBase: 'https://bso.test', wsBase: 'wss://bso.test' });
const mk = (id, name) => { const store = createStore(reducer, initialState({ id, name, livery: 'solaris' }, {}, false)); return { store, net: new NetClient({ backend, store }) }; };
const room = (p) => p.store.get().room;

console.log('--- ルーム作成・入室 ---');
const A = mk('pAAAAAAAA1', 'ALICE'), B = mk('pBBBBBBBB2', 'BOB'), C = mk('pCCCCCCCC3', 'CAROL');
await A.net.createRoom({ mode: 'dogfight', map: 'desert', tod: 'dusk', maxPlayers: 2, timeLimit: 300, evil: 1 });
const code = room(A).code;
ok(isRoomCode(code), 'create: valid room code ' + code);
ok(isHost(A.store.get()) && room(A).players.length === 1, 'create: creator is host');
ok(room(A).settings.map === 'desert' && room(A).settings.maxPlayers === 2 && !('evil' in room(A).settings), 'create: settings sanitized by server');
ok(A.store.get().conn.status === 'online', 'conn online');
ok(await until(() => A.store.get().conn.ping != null), 'ping measured via server pong');
await B.net.joinRoom(code.toLowerCase());
ok(room(B).players.length === 2 && !isHost(B.store.get()), 'join (lowercase code ok): guest is not host');
ok(await until(() => room(A).players.length === 2), 'host sees guest');
ok(slotOf(B.store.get()) === 1, 'guest slot = 1');
try { await C.net.joinRoom(code); ok(false, 'full room rejected'); } catch (e) { ok(e.code === 'room_full', 'full room rejected: ' + e.code); }
try { await C.net.joinRoom('QQQQQQ'); ok(false, 'unknown room'); } catch (e) { ok(e.code === 'room_not_found', 'unknown room -> ' + e.code); }
try { await C.net.joinRoom('abc'); ok(false, 'bad code'); } catch (e) { ok(e.code === 'bad_code', 'bad code (client side) -> ' + e.code); }

console.log('--- 設定・準備・開始 ---');
B.net.updateSettings({ map: 'arctic' }); await wait(120);
ok(room(A).settings.map === 'desert', 'non-host cannot change settings');
A.net.updateSettings({ tod: 'night', maxPlayers: 99 });
ok(await until(() => room(B).settings.tod === 'night'), 'host settings change reaches guest');
ok(room(A).settings.maxPlayers === 2, 'invalid maxPlayers ignored');
ok(!canStart(A.store.get()).ok, 'cannot start before ready');
A.net.startMatch(); await wait(120); ok(room(A).status === 'lobby', 'server refuses start (not ready)');
B.net.setReady(true);
ok(await until(() => canStart(A.store.get()).ok), 'ready reaches host');
let startA = null, startB = null; A.net.on('room.start', (m) => { startA = m; }); B.net.on('room.start', (m) => { startB = m; });
A.net.startMatch();
ok(await until(() => room(B).status === 'countdown'), 'countdown broadcast');
ok(await until(() => startA && startB, 6000), 'room.start delivered to both');
ok(startA.matchId === startB.matchId && startA.players.join() === 'pAAAAAAAA1,pBBBBBBBB2', 'same match, slot order = join order');
ok(A.store.get().match && B.store.get().match, 'match state set in both stores');

console.log('--- 状態同期・チャット ---');
let sawB = null, sawA = null; A.net.on('snap', (m) => { if (m.players.pBBBBBBBB2) sawB = m.players.pBBBBBBBB2; }); B.net.on('snap', (m) => { if (m.players.pAAAAAAAA1) sawA = m.players.pAAAAAAAA1; });
const si = setInterval(() => { A.net.sendState([10, 2300, 20, 0, 0, 0, 1, 210, 100, 0]); B.net.sendState([-5, 2310, 7, 0, 0, 0, 1, 190, 80, 1]); }, 66);
ok(await until(() => sawA && sawB), 'both receive the other player state');
ok(sawA[0] === 10 && sawB[9] === 1, 'state values relayed unchanged');
B.net.sendState([NaN, 0, 0, 0, 0, 0, 1, 1, 1, 0]); B.net.sendState('garbage'); await wait(150);
ok(room(B) && B.store.get().conn.status === 'online', 'invalid states do not break the connection');
let chat = null; B.net.on('chat', (m) => { chat = m; }); A.net.chat('こんにちは');
ok(await until(() => chat && chat.text === 'こんにちは' && chat.from === 'pAAAAAAAA1'), 'chat delivered');
ok(await until(() => { const r = room(A); return r.players.every((p) => p.connected); }), 'players connected');

console.log('--- 切断・再接続・なりすまし ---');
const states = []; A.store.subscribe((s) => states.push(s.conn.status));
A.net.sock.ep.peer.close(4000, 'test: network drop'); // サーバー側からソケットを切る
ok(await until(() => room(B).players.find((p) => p.id === 'pAAAAAAAA1').connected === false, 3000), 'peer sees OFFLINE during drop');
ok(await until(() => A.store.get().conn.status === 'online' && room(B).players.find((p) => p.id === 'pAAAAAAAA1').connected === true, 8000), 'auto-reconnect restores the same seat');
ok(states.includes('reconnecting'), 'client passed through "reconnecting"');
ok(isHost(A.store.get()) && room(A).players.length === 2, 'host and roster preserved after reconnect');
startA = null; A.net.joinMatch(); ok(await until(() => startA && startA.matchId === startB.matchId), 'match.join after reconnect resumes the same match');
sawB = null; ok(await until(() => sawB), 'snapshots resume after reconnect');
const thief = mk('pBBBBBBBB2', 'MALLORY'); // BOB の pid を知っていても別 tok
try { await thief.net.joinRoom(code); ok(false, 'impersonation rejected'); } catch (e) { ok(e.code === 'bad_request', 'impersonation of BOB rejected: ' + e.code); }
ok(room(B).players.find((p) => p.id === 'pBBBBBBBB2').connected && room(B).players.find((p) => p.id === 'pBBBBBBBB2').name === 'BOB', 'BOB seat untouched');
ok(!(await new Promise((r) => { let n = 0; for (const p of room(B).players) if (p.name === 'MALLORY') n++; r(n); })), 'no MALLORY in roster');
try { await C.net.joinRoom(code); ok(false, 'mid-match join rejected'); } catch (e) { ok(e.code === 'room_full' || e.code === 'in_progress', 'mid-match newcomer rejected: ' + e.code); }
B.net.sock.send('{{ not json'); B.net.sock.send(JSON.stringify({ t: 'room.kick', pid: { x: 1 } })); await wait(150);
ok(B.store.get().conn.status === 'online', 'garbage messages ignored by server');
clearInterval(si);

console.log('--- 対戦終了・キック ---');
A.net.leaveMatch(); B.net.leaveMatch();
ok(await until(() => room(A).status === 'lobby' && room(B).status === 'lobby', 4000), 'all left match -> lobby');
ok(room(A).players.every((p) => !p.ready), 'ready flags reset');
A.net.kick('pBBBBBBBB2');
ok(await until(() => B.store.get().room === null), 'kicked player removed from room');
ok(room(A).players.length === 1, 'roster updated for host');
try { await B.net.joinRoom(code); ok(false, 'kicked cannot rejoin'); } catch (e) { ok(e.code === 'kicked', 'kicked player cannot rejoin: ' + e.code); }

console.log('--- ホスト移譲・空ルーム破棄 ---');
const H = mk('pHHHHHHHH4', 'HOST'), G = mk('pGGGGGGGG5', 'GUEST');
await H.net.createRoom({}); const code2 = room(H).code; await G.net.joinRoom(code2);
ok(await until(() => room(H).players.length === 2), 'second room: 2 players');
H.net.leaveRoom();
ok(await until(() => isHost(G.store.get()) && room(G).players.length === 1), 'host leaves -> guest becomes host');
G.net.leaveRoom();
ok(await until(() => env.ROOMS.storage(code2).m.size === 0), 'empty room storage deleted');
const R = mk('pRRRRRRRR6', 'RETRY'); try { await R.net.joinRoom(code2); ok(false, 'dead room'); } catch (e) { ok(e.code === 'room_not_found', 'dead room -> room_not_found'); }

A.net.leaveRoom(); env.ROOMS.objs.forEach((o) => o.inst.core.close());
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
