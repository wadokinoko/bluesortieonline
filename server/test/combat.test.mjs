import test from 'node:test';
import assert from 'node:assert/strict';
import { Combat, COMBAT, forwardOf, segHitsSphere } from '../src/combat.js';
import { RoomCore, LIMITS } from '../src/room-core.js';
import { FakeClock, META, PID, makeClient } from './helpers.mjs';

const S = (x, y, z, o = {}) => [x, y, z, o.q?.[0] ?? 0, o.q?.[1] ?? 0, o.q?.[2] ?? 0, o.q?.[3] ?? 1, o.speed ?? 200, 100, o.flags ?? 0];
const run = (c, states, sec, dt = 0.05) => { const ev = []; for (let t = 0; t < sec; t += dt) ev.push(...c.step(dt, states)); return ev; };
const mkCombat = (ids = ['A', 'B']) => { const c = new Combat(); c.reset(ids); return c; };

/* ================= 単体: Combat ================= */
test('機首方向: 単位クォータニオンは -Z、Y軸90°回転で -X', () => {
  const f = forwardOf(0, 0, 0, 1); assert.deepEqual(f.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, -1]);
  const s = Math.SQRT1_2, g = forwardOf(0, s, 0, s); assert.ok(Math.abs(g[0] + 1) < 1e-9 && Math.abs(g[2]) < 1e-9);
});

test('線分と球: 高速でもすり抜けない / 届かなければ当たらない', () => {
  assert.equal(segHitsSphere([0, 0, 0], [0, 0, -90], [0, 0, -45], 5), true, '球の中を貫通する線分');
  assert.equal(segHitsSphere([0, 0, 0], [0, 0, -45], [0, 0, -100], 24), false);
  assert.equal(segHitsSphere([0, 0, 0], [0, 0, -45], [30, 0, -20], 24), false);
});

test('機銃: 正面の相手に当たり 3 ダメージ。弾道は送信者の state から決まる', () => {
  const c = mkCombat(), st = { A: S(0, 0, 0), B: S(0, 0, -600) };
  assert.equal(c.fire('A', 'g', undefined, st.A, 1000, 0), true);
  const ev = run(c, st, 1);
  assert.deepEqual(ev, [{ t: 'hit', to: 'B', by: 'A', k: 'g', dmg: 3, hp: 97 }]);
  assert.equal(c.bullets.length, 0, '命中した弾は消える');
});

test('機銃: 横にずれた相手・背後の相手には当たらない。寿命で消える', () => {
  const c = mkCombat(), st = { A: S(0, 0, 0), B: S(300, 0, -600) };
  c.fire('A', 'g', undefined, st.A, 1000, 0); assert.deepEqual(run(c, st, 3), []); assert.equal(c.bullets.length, 0);
  const behind = { A: S(0, 0, 0), B: S(0, 0, 600) }; c.fire('A', 'g', undefined, behind.A, 2000, 0); assert.deepEqual(run(c, behind, 3), []);
});

test('機銃: 大きな時間刻み(サーバーの遅延)でもすり抜けない', () => {
  const c = mkCombat(), st = { A: S(0, 0, 0, { speed: 300 }), B: S(0, 0, -700) };
  c.fire('A', 'g', undefined, st.A, 1000, 0); const ev = run(c, st, 2, 0.25); assert.equal(ev.length, 1);
});

test('ミサイル: 当たると 45 ダメージ。自分自身には当たらない', () => {
  const c = mkCombat(), st = { A: S(0, 0, 0), B: S(0, 0, -800) };
  c.fire('A', 'm', 'B', st.A, 1000, 0); const ev = run(c, st, 4);
  assert.deepEqual(ev, [{ t: 'hit', to: 'B', by: 'A', k: 'm', dmg: 45, hp: 55 }]); assert.equal(c.hp('A'), 100);
});

test('ミサイル誘導: 正面から25°ずれた相手にも、ロックしていれば当たる(ロック無しでは外れる)', () => {
  const ang = (25 * Math.PI) / 180, st = { A: S(0, 0, 0), B: S(Math.sin(ang) * 1500, 0, -Math.cos(ang) * 1500) };
  const guided = mkCombat(); guided.fire('A', 'm', 'B', st.A, 1000, 0);
  assert.equal(run(guided, st, 7).filter((e) => e.t === 'hit').length, 1, 'ロックあり=命中');
  const dumb = mkCombat(); dumb.fire('A', 'm', undefined, st.A, 1000, 0);
  assert.equal(run(dumb, st, 7).length, 0, 'ロックなし=外れる');
});

test('ミサイル誘導: 動く相手を追尾して命中する', () => {
  const c = mkCombat(), st = { A: S(0, 0, 0), B: S(300, 0, -1200) };
  c.fire('A', 'm', 'B', st.A, 1000, 0); let hit = false;
  for (let i = 0; i < 160 && !hit; i++) { st.B[0] += 0.05 * 90; st.B[2] -= 0.05 * 60; hit = c.step(0.05, st).some((e) => e.t === 'hit'); } // 横へ逃げる相手
  assert.equal(hit, true);
});

test('ミサイル: 対象が退出・撃墜されたら追尾をやめて直進(エラーにならない)', () => {
  const c = mkCombat(['A', 'B', 'C']), st = { A: S(0, 0, 0), B: S(400, 0, -1500), C: S(0, 0, 900) };
  c.fire('A', 'm', 'B', st.A, 1000, 0); run(c, st, 0.5);
  assert.equal(c.missiles[0].tgt, 'B'); c.remove('B'); delete st.B;
  assert.doesNotThrow(() => run(c, st, 2)); assert.equal(c.missiles[0] ? c.missiles[0].tgt : null, null);
  const d = mkCombat(); d.fire('A', 'm', 'B', S(0, 0, 0), 1000, 0); d.markDead('B');
  assert.doesNotThrow(() => run(d, { A: S(0, 0, 0), B: S(0, 0, -500) }, 3), '死亡済みの対象でも例外なし');
});

test('ミサイルは存在しない・死亡済み・自分自身を対象にできない(直進になる)', () => {
  const c = mkCombat(); c.markDead('B');
  for (const t of ['ZZ', 'A', 'B', 5, null, undefined, {}]) { const x = mkCombat(); x.markDead('B'); x.fire('A', 'm', t, S(0, 0, 0), 1000 + Math.random(), 0); assert.equal(x.missiles[0].tgt, null, String(t)); }
});

test('弾数・クールダウン: ミサイル14発まで・間隔制限・時間で1発回復', () => {
  const c = mkCombat(), a = S(0, 0, 0); let ok = 0, t = 0;
  for (let i = 0; i < 20; i++) { t += 400; c.step(0.4, {}); if (c.fire('A', 'm', undefined, a, t, 0)) ok++; c.missiles.length = 0; }
  assert.equal(ok, COMBAT.MSL_MAX + 0 + Math.floor((20 * 0.4) / COMBAT.MSL_REGEN_S), '14発+8秒ごとの回復');
  const d = mkCombat(); assert.equal(d.fire('A', 'm', undefined, a, 1000, 0), true); assert.equal(d.fire('A', 'm', undefined, a, 1100, 0), false, '0.35秒未満は不可');
  assert.equal(d.fire('A', 'g', undefined, a, 5000, 0), true); assert.equal(d.fire('A', 'g', undefined, a, 5010, 0), false, '機銃の連射上限');
});

test('不正な発射は拒否: 死亡中・state なし・state が古い・種別不明', () => {
  const c = mkCombat(), a = S(0, 0, 0);
  assert.equal(c.fire('A', 'x', undefined, a, 1000, 0), false); assert.equal(c.fire('A', 'm', undefined, null, 1000, 0), false);
  assert.equal(c.fire('A', 'm', undefined, a, 1000, COMBAT.MAX_STATE_AGE_MS + 1), false); assert.equal(c.fire('A', 'm', undefined, a, 1000, NaN), false);
  assert.equal(c.fire('NOBODY', 'm', undefined, a, 1000, 0), false); c.markDead('A'); assert.equal(c.fire('A', 'g', undefined, a, 9000, 0), false);
});

test('バリア中はダメージ 1/10。撃墜でクレジットが入り、死亡後は当たらない', () => {
  const c = mkCombat(), st = { A: S(0, 0, 0), B: S(0, 0, -800, { flags: 4 }) };
  c.fire('A', 'm', 'B', st.A, 1000, 0); assert.equal(run(c, st, 4)[0].dmg, 4.5);
  const d = mkCombat(), s2 = { A: S(0, 0, 0), B: S(0, 0, -800) }; let all = [], t = 1000;
  for (let i = 0; i < 3; i++) { d.fire('A', 'm', 'B', s2.A, t, 0); all.push(...run(d, s2, 4)); t += 4000; }
  assert.deepEqual(all.filter((e) => e.t === 'kill'), [{ t: 'kill', to: 'B', by: 'A', k: 'm' }]);
  assert.equal(d.isDead('B'), true); assert.equal(d.hp('B'), 0);
  d.fire('A', 'g', undefined, s2.A, t, 0); assert.deepEqual(run(d, s2, 2), [], '死亡済みには当たらない');
  const r = d.results((id) => id); assert.deepEqual(r.map((x) => [x.id, x.kills, x.deaths]), [['A', 1, 0], ['B', 0, 1]]);
});

test('自己申告の墜落は撃墜クレジットなし。相手が撃墜済みでも他の相手には当たる', () => {
  const c = mkCombat(['A', 'B', 'C']); c.markDead('B'); assert.deepEqual(c.results((x) => x).map((x) => x.kills), [0, 0, 0]);
  const st = { A: S(0, 0, 0), B: S(0, 0, -300), C: S(0, 0, -900) }; c.fire('A', 'g', undefined, st.A, 1000, 0);
  const ev = run(c, st, 2); assert.equal(ev[0].to, 'C', 'B(死亡)を貫通して C に当たる');
});

/* ================= 結合: RoomCore ================= */
const mkRoom = () => {
  const clock = new FakeClock(), core = new RoomCore({ meta: META(), clock });
  const a = makeClient(core, 'host-0001'), b = makeClient(core, PID(2));
  b.send({ t: 'room.ready', ready: true }); a.send({ t: 'room.start' }); clock.advance(LIMITS.COUNTDOWN_MS);
  return { core, clock, a, b };
};
const put = (c, x, y, z, hp = 100, flags = 0) => c.send({ t: 'state', s: [x, y, z, 0, 0, 0, 1, 200, hp, flags] });

test('結合: 機銃が当たると両方の画面に hit が届き、snap の HP はサーバー確定値(嘘の hp は無視)', () => {
  const r = mkRoom(); put(r.a, 0, 2300, 0); put(r.b, 0, 2300, -600, 100);
  r.a.send({ t: 'fire', k: 'g' }); r.clock.advance(1000);
  const hit = { t: 'hit', to: PID(2), by: 'host-0001', k: 'g', dmg: 3, hp: 97 };
  assert.deepEqual(r.a.of('hit'), [hit]); assert.deepEqual(r.b.of('hit'), [hit], '撃たれた側にも同じ通知');
  put(r.b, 0, 2300, -600, 100); put(r.a, 0, 2300, 0); r.clock.advance(LIMITS.SNAP_MS);
  assert.equal(r.a.last('snap').players[PID(2)][8], 97, 'B が hp=100 と申告しても snap は 97');
});

test('結合: ミサイル3発で撃墜 → kill 配信・snap に dead フラグ・match.end に戦績', () => {
  const r = mkRoom();
  for (let i = 0; i < 3; i++) { put(r.a, 0, 2300, 0); put(r.b, 0, 2300, -800); r.a.send({ t: 'fire', k: 'm', tgt: PID(2) }); r.clock.advance(4000); }
  assert.deepEqual(r.b.of('kill'), [{ t: 'kill', to: PID(2), by: 'host-0001', k: 'm' }]); assert.equal(r.a.of('kill').length, 1);
  assert.deepEqual(r.a.of('hit').map((h) => h.hp), [55, 10, 0]);
  put(r.b, 0, 2300, -800, 100); put(r.a, 0, 2300, 0); r.clock.advance(LIMITS.SNAP_MS);
  const snapB = r.a.last('snap').players[PID(2)]; assert.equal(snapB[8], 0); assert.equal(snapB[9] & 1, 1, 'dead フラグはサーバーが立てる');
  r.a.send({ t: 'match.leave' }); r.b.send({ t: 'match.leave' });
  const res = r.a.last('match.end').results; assert.deepEqual(res.map((x) => [x.name.length > 0, x.kills, x.deaths]), [[true, 1, 0], [true, 0, 1]]);
  assert.equal(res[0].id, 'host-0001');
});

test('結合: 不正な fire は無視/違反扱いで、サーバーは落ちない。ロビー中・対戦外は無視', () => {
  const lobby = new RoomCore({ meta: META(), clock: new FakeClock() }); const l = makeClient(lobby, 'host-0001');
  l.send({ t: 'fire', k: 'g' }); assert.equal(lobby.combat.bullets.length, 0);
  const r = mkRoom(); put(r.a, 0, 2300, 0);
  for (const bad of [{ k: 'x' }, { k: 5 }, { k: 'm', tgt: 5 }, { k: 'm', tgt: 'x'.repeat(50) }, {}]) assert.doesNotThrow(() => r.a.send({ t: 'fire', ...bad }));
  assert.equal(r.core.combat.bullets.length + r.core.combat.missiles.length, 0); assert.equal(r.core.alive, true);
  const c = makeClient(r.core, PID(3), { hello: false }); c.send({ t: 'fire', k: 'g' }); // 未入室
  assert.equal(r.core.combat.bullets.length, 0);
});

test('結合: 発射の連打(レート違反)は切断される / 通常の連射は通る', () => {
  const r = mkRoom(); put(r.a, 0, 2300, 0);
  for (let i = 0; i < 40; i++) { put(r.a, 0, 2300, 0); r.a.send({ t: 'fire', k: 'g' }); r.clock.advance(70); }
  assert.equal(r.a.closeCode, null, '14Hz の機銃は許容');
  for (let i = 0; i < 200; i++) r.b.send({ t: 'fire', k: 'g' });
  assert.equal(r.b.closeCode, 4010);
});

test('結合: 切断した相手へ向かうミサイルはエラーなく消え、再接続後も HP は保持される', () => {
  const r = mkRoom(); put(r.a, 0, 2300, 0); put(r.b, 0, 2300, -800);
  r.a.send({ t: 'fire', k: 'm', tgt: PID(2) }); r.clock.advance(500); r.b.drop();
  assert.doesNotThrow(() => r.clock.advance(5000)); assert.equal(r.a.of('hit').length, 0, '切断中(state なし)の相手には当たらない');
  const b2 = makeClient(r.core, PID(2)); b2.send({ t: 'match.join' }); put(b2, 0, 2300, -800);
  put(r.a, 0, 2300, 0); r.a.send({ t: 'fire', k: 'm', tgt: PID(2) }); r.clock.advance(5000); // 発射前に自機の state を更新(古い state の発射は拒否される)
  assert.equal(r.core.combat.hp(PID(2)), 55);
});

test('結合: 自機の墜落申告(dead フラグ)は撃墜クレジットなしで死亡扱い、以後は被弾しない', () => {
  const r = mkRoom(); put(r.b, 0, 2300, -300, 100, 1); put(r.a, 0, 2300, 0);
  assert.equal(r.core.combat.isDead(PID(2)), true); r.a.send({ t: 'fire', k: 'g' }); r.clock.advance(1500);
  assert.equal(r.a.of('hit').length, 0); assert.equal(r.core.combat.results((x) => x).find((x) => x.id === 'host-0001').kills, 0);
});
