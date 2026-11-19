import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore, LIMITS, validateState } from '../src/room-core.js';
import { FakeClock, META, PID, makeClient } from './helpers.mjs';

const GOOD = [100, 2300, -50, 0, 0, 0, 1, 200, 100, 0];
const mk = (meta = META(), opts = {}) => {
  const clock = new FakeClock(); const events = { empty: 0, active: 0 };
  const core = new RoomCore({ meta, clock, hooks: { onEmpty: () => events.empty++, onActive: () => events.active++ }, ...opts });
  return { core, clock, events };
};
const lobby2 = (meta) => { // host + guest が入室済みのルーム
  const r = mk(meta); const a = makeClient(r.core, 'host-0001'); const b = makeClient(r.core, PID(2));
  return { ...r, a, b };
};
const startMatch = (r) => { r.b.send({ t: 'room.ready', ready: true }); r.a.send({ t: 'room.start' }); r.clock.advance(LIMITS.COUNTDOWN_MS); };

test('入室: welcome に自分のID・ルーム状態・serverTime が入り、作成者がホストになる', () => {
  const { core, a } = (() => { const r = mk(); return { ...r, a: makeClient(r.core, 'host-0001') }; })();
  const w = a.last('welcome');
  assert.equal(w.you, 'host-0001'); assert.equal(w.re, 1);
  assert.equal(w.room.code, 'ABCDEF'); assert.equal(w.room.hostId, 'host-0001'); assert.equal(w.room.players.length, 1);
  assert.equal(typeof w.serverTime, 'number'); assert.equal(core.players[0].connected, true);
});

test('2人入室: 既存メンバーに room.state が配信され、ゲストはホストではない', () => {
  const { a, b } = lobby2();
  assert.equal(b.last('welcome').room.players.length, 2);
  assert.equal(a.last('room.state').room.players.length, 2);
  assert.equal(a.last('room.state').room.hostId, 'host-0001');
});

test('room.state の rev は単調増加し、公開情報に tok が含まれない', () => {
  const { a, b } = lobby2(); b.send({ t: 'room.ready', ready: true });
  const revs = a.of('room.state').map((m) => m.room.rev);
  assert.ok(revs.length >= 2 && revs.every((v, i) => i === 0 || v > revs[i - 1]), 'rev increases: ' + revs);
  assert.ok(!JSON.stringify(a.msgs).includes('tok-'), 'tok never leaves the server');
});

test('満員: maxPlayers を超える参加は room_full で拒否され切断される', () => {
  const r = mk(META({ settings: { maxPlayers: 2 } }));
  makeClient(r.core, 'host-0001'); makeClient(r.core, PID(2));
  const c = makeClient(r.core, PID(3));
  assert.equal(c.last('error').code, 'room_full'); assert.equal(c.closeCode, 4000); assert.equal(r.core.players.length, 2);
});

test('存在しないルーム / バージョン不一致 / 不正pid は拒否', () => {
  const dead = new RoomCore({ meta: null, clock: new FakeClock() });
  assert.equal(makeClient(dead, PID(1)).last('error').code, 'room_not_found');
  const r = mk();
  assert.equal(makeClient(r.core, PID(1), { v: 99 }).last('error').code, 'version_mismatch');
  for (const bad of ['short', 'has space 12345', 'bot:kite-0001', 'x'.repeat(41), '日本語のパイロット']) {
    assert.equal(makeClient(r.core, bad).last('error').code, 'bad_request', 'pid ' + bad);
  }
  assert.equal(r.core.players.length, 0);
});

test('プレイヤー名はサニタイズされる', () => {
  const r = mk(); makeClient(r.core, 'host-0001', { name: '<script>alert(1)</script>\u0007ABCDEFGHIJKLMNOP' });
  assert.ok(!/[<>&"'`]/.test(r.core.players[0].name)); assert.ok(r.core.players[0].name.length <= 12);
  const c = makeClient(r.core, PID(2), { name: '   ' }); assert.equal(r.core.players[1].name, 'PILOT'); assert.ok(c.last('welcome'));
});

test('準備完了: ホスト以外が切り替える。対戦中は変更できない', () => {
  const r = lobby2();
  r.b.send({ t: 'room.ready', ready: true }); assert.equal(r.core.players[1].ready, true);
  r.b.send({ t: 'room.ready', ready: false }); assert.equal(r.core.players[1].ready, false);
});

test('設定変更: ホストのみ。不正値は無視される', () => {
  const r = lobby2();
  r.b.req({ t: 'room.settings', patch: { map: 'desert' } });
  assert.equal(r.b.last('error').code, 'not_host'); assert.equal(r.core.settings.map, 'isles');
  r.a.send({ t: 'room.settings', patch: { map: 'desert', tod: 'night', maxPlayers: 99, timeLimit: 1, evil: 1 } });
  assert.equal(r.core.settings.map, 'desert'); assert.equal(r.core.settings.tod, 'night');
  assert.equal(r.core.settings.maxPlayers, 4); assert.equal(r.core.settings.timeLimit, 600); assert.ok(!('evil' in r.core.settings));
  const before = r.core.settings; r.a.send({ t: 'room.settings', patch: [1, 2] }); assert.deepEqual(r.core.settings, before);
});

test('開始条件: ホストのみ・2人以上・全員準備完了', () => {
  const solo = mk(); const s = makeClient(solo.core, 'host-0001');
  s.req({ t: 'room.start' }); assert.equal(s.last('error').code, 'need_players');
  const r = lobby2();
  r.b.req({ t: 'room.start' }); assert.equal(r.b.last('error').code, 'not_host');
  r.a.req({ t: 'room.start' }); assert.equal(r.a.last('error').code, 'not_ready'); assert.equal(r.core.status, 'lobby');
});

test('ゲーム開始通知: countdown → room.start(matchId/seed/settings/players) が参加者全員へ届く', () => {
  const r = lobby2(); r.b.send({ t: 'room.ready', ready: true }); r.a.send({ t: 'room.start' });
  assert.equal(r.core.status, 'countdown'); assert.ok(r.a.last('room.state').room.startAt > r.clock.now());
  assert.equal(r.a.of('room.start').length, 0);
  r.clock.advance(LIMITS.COUNTDOWN_MS);
  assert.equal(r.core.status, 'inmatch');
  for (const c of [r.a, r.b]) {
    const m = c.last('room.start'); assert.ok(m, 'start sent');
    assert.deepEqual(m.players, ['host-0001', PID(2)]); assert.match(m.matchId, /^m/); assert.equal(typeof m.seed, 'number'); assert.equal(m.settings.mode, 'dogfight');
  }
});

test('状態同期: 自分以外の状態だけが snap で届く / 不正な状態は拒否される', () => {
  const r = lobby2(); startMatch(r);
  r.a.send({ t: 'state', s: GOOD }); r.b.send({ t: 'state', s: [1, 2300, 3, 0, 0, 0, 1, 210, 90, 1] });
  r.clock.advance(LIMITS.SNAP_MS);
  const sa = r.a.last('snap'), sb = r.b.last('snap');
  assert.deepEqual(Object.keys(sa.players), [PID(2)]); assert.deepEqual(Object.keys(sb.players), ['host-0001']);
  assert.deepEqual(sb.players['host-0001'], GOOD); assert.equal(typeof sa.tick, 'number'); assert.equal(typeof sa.ts, 'number');
  const n = r.a.of('snap').length; r.clock.advance(LIMITS.SNAP_MS * 3); assert.equal(r.a.of('snap').length, n, '更新が無ければ送らない');
  const bad = [null, 'x', [], GOOD.slice(0, 9), [...GOOD, 1], [NaN, ...GOOD.slice(1)], [Infinity, ...GOOD.slice(1)], ['1', ...GOOD.slice(1)],
    [1e9, ...GOOD.slice(1)], [0, 1e6, ...GOOD.slice(2)], [0, 0, 0, 5, 5, 5, 5, 200, 100, 0], [0, 0, 0, 0, 0, 0, 0, 200, 100, 0],
    [0, 0, 0, 0, 0, 0, 1, -5, 100, 0], [0, 0, 0, 0, 0, 0, 1, 200, 1e9, 0], [0, 0, 0, 0, 0, 0, 1, 200, 100, 1.5], [0, 0, 0, 0, 0, 0, 1, 200, 100, 999]];
  for (const s of bad) assert.equal(validateState(s), null, JSON.stringify(s));
  const keep = r.core.states['host-0001'];
  r.a.send({ t: 'state', s: [9e9, ...GOOD.slice(1)] }); assert.equal(r.core.states['host-0001'], keep, '不正状態は保存されない');
});

test('ロビー中・対戦外の state は無視される', () => {
  const r = lobby2(); r.a.send({ t: 'state', s: GOOD }); assert.deepEqual(r.core.states, {});
});

test('チャット: 全員に配信。制御文字除去・120文字制限・空は無視・連投はレート制限', () => {
  const r = lobby2();
  r.a.send({ t: 'chat', text: '  hello\u0000\u0007 world  ' });
  assert.deepEqual(r.b.last('chat'), { t: 'chat', from: 'host-0001', name: r.core.players[0].name, text: 'hello world' });
  r.clock.advance(5000); r.a.send({ t: 'chat', text: 'x'.repeat(500) }); assert.equal(r.b.last('chat').text.length, 120);
  r.clock.advance(5000); const n = r.b.of('chat').length; r.a.send({ t: 'chat', text: '   ' }); assert.equal(r.b.of('chat').length, n);
  r.clock.advance(5000); for (let i = 0; i < 10; i++) r.a.send({ t: 'chat', text: 'spam' + i });
  assert.ok(r.b.of('chat').length - n <= 4, 'burst limited: ' + (r.b.of('chat').length - n));
});

test('退出(room.leave): 残りに通知され、本人は切断される', () => {
  const r = lobby2(); r.b.send({ t: 'room.leave' });
  assert.equal(r.core.players.length, 1); assert.equal(r.b.closeCode, 1000); assert.equal(r.a.last('room.state').room.players.length, 1);
});

test('ホスト移譲: ホストが退出すると次のプレイヤーがホストになる / 切断は猶予後に移譲', () => {
  const r = lobby2(); r.a.send({ t: 'room.leave' });
  assert.equal(r.core.hostId, PID(2)); assert.equal(r.b.last('room.state').room.hostId, PID(2));
  const r2 = lobby2(); r2.a.drop(); // 切断
  assert.equal(r2.core.hostId, 'host-0001', '猶予中は移譲しない'); assert.equal(r2.b.last('room.state').room.players[0].connected, false);
  r2.clock.advance(LIMITS.GRACE_MS);
  assert.equal(r2.core.players.length, 1); assert.equal(r2.core.hostId, PID(2));
});

test('再接続: 猶予内に同じ pid + tok で戻ると同じ席に復帰する。別tokのなりすましは拒否', () => {
  const r = lobby2(); r.b.send({ t: 'room.ready', ready: true }); r.b.drop();
  assert.equal(r.core.players[1].connected, false);
  const thief = makeClient(r.core, PID(2), { tok: 'attacker-token-1' });
  assert.equal(thief.last('error').code, 'bad_request'); assert.equal(r.core.players[1].connected, false, 'なりすましで席が奪われない');
  r.clock.advance(5000);
  const back = makeClient(r.core, PID(2)); // 正しい tok
  assert.equal(back.last('welcome').you, PID(2)); assert.equal(r.core.players.length, 2);
  assert.equal(r.core.players[1].connected, true); assert.equal(r.core.players[1].ready, true, '準備状態も保持');
  r.clock.advance(LIMITS.GRACE_MS * 2); assert.equal(r.core.players.length, 2, '復帰後は退室扱いにならない');
});

test('再接続: 接続中の席に同じ tok で別接続が来ると古い接続が置き換えられる', () => {
  const r = lobby2(); const b2 = makeClient(r.core, PID(2));
  assert.equal(r.b.closeCode, 4002); assert.ok(b2.last('welcome')); assert.equal(r.core.players[1].connected, true);
  r.b.drop(); assert.equal(r.core.players[1].connected, true, '置換された古い接続の close は無視される');
});

test('猶予切れ: 戻らなければ退室、全員いなくなるとルームは破棄される', () => {
  const r = lobby2(); r.a.drop(); r.b.drop(); r.clock.advance(LIMITS.GRACE_MS);
  assert.equal(r.core.alive, false); assert.equal(r.events.empty, 1);
  assert.equal(makeClient(r.core, PID(9)).last('error').code, 'room_not_found');
});

test('対戦中の入室制御: 新規は in_progress、既存メンバーは再接続→match.join で復帰', () => {
  const r = lobby2(); startMatch(r);
  assert.equal(makeClient(r.core, PID(3)).last('error').code, 'in_progress');
  r.b.drop(); r.clock.advance(3000);
  const b2 = makeClient(r.core, PID(2)); assert.ok(b2.last('welcome'));
  b2.send({ t: 'match.join' }); assert.equal(b2.last('room.start').matchId, r.a.last('room.start').matchId);
  r.a.send({ t: 'state', s: GOOD }); r.clock.advance(LIMITS.SNAP_MS); assert.ok(b2.last('snap'), '復帰後に snap を受け取る');
});

test('切断したプレイヤーの状態は snap から消える', () => {
  const r = lobby2(); startMatch(r);
  r.b.send({ t: 'state', s: GOOD }); r.a.send({ t: 'state', s: GOOD }); r.clock.advance(LIMITS.SNAP_MS);
  assert.ok(PID(2) in r.a.last('snap').players);
  const before = r.a.of('snap').length;
  r.b.drop(); r.a.send({ t: 'state', s: GOOD }); r.clock.advance(LIMITS.SNAP_MS * 2);
  assert.ok(r.a.of('snap').slice(before).every((m) => !(PID(2) in m.players)), '切断後の snap に残らない');
  assert.ok(!(PID(2) in r.core.states));
});

test('キック: ホストのみ。対象に kick が届き退室、同じ pid は再入室できない', () => {
  const r = lobby2();
  r.b.req({ t: 'room.kick', pid: 'host-0001' }); assert.equal(r.b.last('error').code, 'not_host');
  r.a.send({ t: 'room.kick', pid: PID(2) });
  assert.ok(r.b.last('kick')); assert.equal(r.b.closeCode, 4001); assert.equal(r.core.players.length, 1);
  assert.equal(makeClient(r.core, PID(2)).last('error').code, 'kicked');
  r.a.send({ t: 'room.kick', pid: 'host-0001' }); assert.equal(r.core.players.length, 1, '自分自身はキックできない');
});

test('対戦終了: 全員が match.leave するとロビーに戻り match.end と ready リセット', () => {
  const r = lobby2(); startMatch(r); r.a.send({ t: 'match.leave' });
  assert.equal(r.core.status, 'inmatch'); r.b.send({ t: 'match.leave' });
  assert.equal(r.core.status, 'lobby'); assert.ok(r.a.last('match.end')); assert.equal(r.core.players[1].ready, false);
});

test('対戦終了: 制限時間(+猶予)を過ぎるとサーバーが match.end を送る', () => {
  const r = lobby2(META({ settings: { maxPlayers: 4, timeLimit: 300 } })); startMatch(r);
  r.clock.advance(300 * 1000); assert.equal(r.core.status, 'inmatch');
  r.clock.advance(LIMITS.MATCH_END_SLACK_MS); assert.equal(r.core.status, 'lobby'); assert.ok(r.b.last('match.end'));
});

test('カウントダウン中に人数が足りなくなると中止してロビーへ戻る', () => {
  const r = lobby2(); r.b.send({ t: 'room.ready', ready: true }); r.a.send({ t: 'room.start' });
  r.b.send({ t: 'room.leave' }); assert.equal(r.core.status, 'lobby'); r.clock.advance(LIMITS.COUNTDOWN_MS);
  assert.equal(r.core.status, 'lobby'); assert.equal(r.a.of('room.start').length, 0);
});

test('ping → pong。ts が数値でなければ無視', () => {
  const r = mk(); const a = makeClient(r.core, 'host-0001');
  a.send({ t: 'ping', ts: 123.5 }); assert.deepEqual(a.last('pong'), { t: 'pong', ts: 123.5 });
  a.send({ t: 'ping', ts: 'x' }); assert.equal(a.of('pong').length, 1);
});

test('不正メッセージ: 壊れたJSON・型違い・未知の種別は無視され、サーバーは落ちない', () => {
  const r = lobby2(); const bad = ['{{{', '[]', '"str"', 'null', '123', '{"t":5}', '{"nope":1}', '{"t":"unknown"}', '{"t":"room.kick","pid":{"a":1}}', '{"t":"chat","text":{"x":1}}', '{"t":"state","s":"abc"}'];
  for (const raw of bad) assert.doesNotThrow(() => r.a.send(raw), raw);
  assert.equal(r.core.alive, true); assert.equal(r.core.players.length, 2); assert.equal(r.a.closeCode, null);
});

test('不正メッセージが続くと切断される(違反上限)', () => {
  const r = lobby2(); for (let i = 0; i < LIMITS.STRIKE_MAX + 2; i++) r.a.send('garbage');
  assert.equal(r.a.closeCode, 4010); assert.equal(r.core.players[0].connected, false);
});

test('大きすぎるメッセージ・バイナリは即切断', () => {
  const r = lobby2(); r.a.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(LIMITS.MAX_MSG_CHARS) })); assert.equal(r.a.closeCode, 4009);
  const c = makeClient(r.core, PID(3)); r.core.receive(c.conn, new ArrayBuffer(8)); assert.equal(c.closeCode, 4011);
});

test('レート制限: 状態を過剰送信すると切断される(通常の15Hzは通る)', () => {
  const r = lobby2(); startMatch(r);
  for (let i = 0; i < 45; i++) { r.a.send({ t: 'state', s: GOOD }); r.clock.advance(1000 / 15); }
  assert.equal(r.a.closeCode, null, '15Hz は許容される');
  for (let i = 0; i < 200; i++) r.b.send({ t: 'state', s: GOOD });
  assert.equal(r.b.closeCode, 4010, '同時刻に大量送信すると切断される');
});

test('hello を送らない接続は一定時間で切断される。hello 前の操作は無視', () => {
  const r = mk(); const c = makeClient(r.core, PID(1), { hello: false });
  c.send({ t: 'room.ready', ready: true }); assert.equal(r.core.players.length, 0);
  r.clock.advance(LIMITS.HELLO_TIMEOUT_MS); assert.equal(c.closeCode, 4008); assert.equal(r.core.connCount, 0);
});

test('hello の二重送信は拒否(席は増えない)', () => {
  const r = mk(); const a = makeClient(r.core, 'host-0001'); a.hello({ pid: PID(5) });
  assert.equal(a.last('error').code, 'bad_request'); assert.equal(r.core.players.length, 1);
});
