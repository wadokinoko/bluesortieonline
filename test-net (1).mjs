// NetClient + MockBackend の結合テスト (Node)。 `npm test`
globalThis.window = {}; globalThis.location = { search: '' };
const { CONFIG } = await import('../js/config.js');
const { createStore } = await import('../js/state/store.js');
const { initialState, reducer, canStart, isHost, slotOf } = await import('../js/state/app-state.js');
const { NetClient } = await import('../js/net/netclient.js');
const { MockBackend } = await import('../js/net/backend-mock.js');
const { DEMO_CODE } = await import('../js/net/mock-server.js');

let fails = 0;
const ok = (c, m) => { console.log((c ? ' ok  ' : 'FAIL ') + m); if (!c) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await wait(20); } return true; };

const backend = new MockBackend({ bots: true });
const mk = (id, name) => {
  const store = createStore(reducer, initialState({ id, name, livery: 'solaris' }, {}, true));
  return { store, net: new NetClient({ backend, store }) };
};

// 1) 不正コード
const a = mk('pAAAAAAAA1', 'ALICE');
try { await a.net.joinRoom('xx'); ok(false, 'bad code rejected'); } catch (e) { ok(e.code === 'bad_code', 'bad code rejected'); }
// 2) 存在しないルーム
try { await a.net.joinRoom('ZZZZZZ'); ok(false, 'unknown room'); } catch (e) { ok(e.code === 'room_not_found', 'unknown room -> room_not_found'); }
// 3) 作成 → 入室
await a.net.createRoom({ mode: 'dogfight', map: 'desert', tod: 'dusk', maxPlayers: 4, timeLimit: 300, evil: 1 });
let s = a.store.get();
ok(s.room && s.room.players.length === 1 && isHost(s), 'create room: self is host');
ok(s.room.settings.map === 'desert' && s.room.settings.tod === 'dusk' && !('evil' in s.room.settings), 'settings sanitized');
ok(s.conn.status === 'online', 'conn online');
// 4) ボット入室 → ping計測
ok(await until(() => a.store.get().room.players.length >= 2), 'bot joined room');
ok(await until(() => a.store.get().conn.ping != null), 'ping measured: ' + a.store.get().conn.ping + 'ms');
// 5) 別プレイヤー参加
const b = mk('pBBBBBBBB2', 'BOB');
await b.net.joinRoom(a.store.get().room.code);
ok(await until(() => a.store.get().room.players.some((p) => p.id === 'pBBBBBBBB2')), 'second human visible to host');
ok(slotOf(b.store.get()) >= 1, 'BOB slot index ' + slotOf(b.store.get()));
// 6) 設定変更: ホストのみ
b.net.updateSettings({ map: 'arctic' }); await wait(200);
ok(a.store.get().room.settings.map === 'desert', 'non-host cannot change settings');
a.net.updateSettings({ map: 'arctic', maxPlayers: 99 }); 
ok(await until(() => a.store.get().room.settings.map === 'arctic'), 'host changes settings');
ok(a.store.get().room.settings.maxPlayers === 4, 'invalid maxPlayers ignored');
// 7) Ready → 開始
ok(!canStart(a.store.get()).ok, 'cannot start before all ready');
b.net.setReady(true);
ok(await until(() => canStart(a.store.get()).ok, 10000), 'canStart after all ready');
const gotStart = new Promise((r) => b.net.on('room.start', r));
let snaps = 0; b.net.on('snap', (m) => { snaps++; if (snaps === 1) console.log('     first snap players:', Object.keys(m.players)); });
a.net.startMatch();
ok(await until(() => a.store.get().room.status === 'countdown'), 'countdown');
const st = await Promise.race([gotStart, wait(6000).then(() => null)]);
ok(!!st && st.players.length >= 3, 'room.start received, players=' + (st && st.players.length));
ok(await until(() => snaps >= 5, 4000), 'snapshots streaming (' + snaps + ')');
b.net.sendState([1, 2, 3, 0, 0, 0, 1, 200, 100, 0]);
let sawB = false; a.net.on('snap', (m) => { if (m.players['pBBBBBBBB2']) sawB = true; });
a.net.sendState([0, 0, 0, 0, 0, 0, 1, 200, 100, 0]);
ok(await until(() => sawB, 3000), 'host sees BOB state relayed');
// 8) 対戦退出 → ロビー復帰
a.net.leaveMatch(); b.net.leaveMatch();
ok(await until(() => a.store.get().room.status === 'lobby', 4000), 'match ended -> lobby');
// 9) キック
a.net.kick('pBBBBBBBB2');
ok(await until(() => b.store.get().room === null), 'kicked player removed');
// 10) デモルーム
const c = mk('pCCCCCCCC3', 'CAROL');
await c.net.joinRoom(DEMO_CODE);
ok(c.store.get().room.players.some((p) => p.isBot), 'demo room has bot friends');
ok(!isHost(c.store.get()), 'human is not host in demo room');
c.net.leaveRoom(); a.net.leaveRoom();
ok(c.store.get().room === null && c.store.get().conn.status === 'offline', 'leave clears state');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
