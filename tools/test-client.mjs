/* クライアント側(ロックオン / ミサイル誘導 / HUD / 対戦セッション)の検証。
 * この環境では Three.js を読み込めないため、js/game/game-core.js の「実際のソース」から該当関数だけを取り出し、
 * 最小の Vector3 でその場で実行する。ソロの挙動不変は、元の bluesortie4.html から抜き出した無改変の関数と並べて比較する。
 * (描画そのもの = 実ブラウザでの見た目・音は、このテストでは確認できない) */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = { BSOHooks: {} }; globalThis.location = { search: '' };
globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); } };
let tNow = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => tNow }, configurable: true });

let fails = 0;
const ok = (c, m) => { console.log((c ? ' ok  ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

/* ---------- 最小の Vector3 / Quaternion ---------- */
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(o) { return this.set(o.x, o.y, o.z); } clone() { return new V3(this.x, this.y, this.z); }
  add(o) { return this.set(this.x + o.x, this.y + o.y, this.z + o.z); } sub(o) { return this.set(this.x - o.x, this.y - o.y, this.z - o.z); }
  multiplyScalar(k) { return this.set(this.x * k, this.y * k, this.z * k); }
  addScaledVector(o, k) { return this.set(this.x + o.x * k, this.y + o.y * k, this.z + o.z * k); }
  length() { return Math.hypot(this.x, this.y, this.z); } dot(o) { return this.x * o.x + this.y * o.y + this.z * o.z; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(o) { return this.clone().sub(o).length(); } distanceToSquared(o) { const d = this.clone().sub(o); return d.dot(d); }
  angleTo(o) { const d = this.length() * o.length(); return d === 0 ? Math.PI / 2 : Math.acos(Math.max(-1, Math.min(1, this.dot(o) / d))); }
  lerp(o, t) { return this.set(this.x + (o.x - this.x) * t, this.y + (o.y - this.y) * t, this.z + (o.z - this.z) * t); }
  applyQuaternion(q) {
    const { x, y, z } = this, tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
    return this.set(x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx));
  }
}
class Quat { constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; } set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } copy(o) { return this.set(o.x, o.y, o.z, o.w); } slerp() { return this; } }
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/* ---------- ソースから関数を取り出す ---------- */
const core = fs.readFileSync(path.join(root, 'js/game/game-core.js'), 'utf8');
const orig = fs.readFileSync(path.join(root, 'tools/fixtures/bs4-original-lock.js.txt'), 'utf8');
function fn(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('no function ' + name);
  let k = src.indexOf('{', i), d = 0;
  for (;; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) break; }
  return src.slice(i, k + 1);
}
const between = (src, tag) => { const a = src.indexOf('/*[BSO:' + tag + ']*/'), b = src.indexOf('/*[/BSO:' + tag + ']*/'); if (a < 0 || b < 0) throw new Error('marker ' + tag); return src.slice(a, b); };
const hooksLine = core.split('\n').find((l) => l.includes('[BSO:remote-hooks]'));
const build = (code, ret, env) => new Function('env', `with(env){ ${code}\n return {${ret}}; }`)(env);

/* ---------- 実行環境(ワールド)を作る ---------- */
function world({ patched, hooks, seed = 1 }) {
  const R = rng(seed), log = { beep: 0, explode: [], killed: [], dmgT: [], parts: 0 };
  const env = {
    V3, THREE: { Mesh: class { constructor() { this.position = new V3(); } lookAt() {} } }, missGeo: {}, missMat: {},
    scene: { add() {}, remove() {} }, OH: hooks || {}, lock: { cand: null, t: 0, locked: false, was: false },
    fwd: new V3(0, 0, -1), P: { pos: new V3(), q: new Quat(), speed: 200, msl: 14, mslT: 0, dead: false, side: 1 },
    S: { msgT: 5 }, enemies: [], tg: [], missiles: [],
    beep() { log.beep++; }, noise() {}, addPart() { log.parts++; }, explode(p, s) { log.explode.push([p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3), s]); },
    killEnemy(e) { log.killed.push(e.id); }, dmgT(t, n) { log.dmgT.push([t.id, n]); }, heightAt: () => -1e9,
  };
  const src = patched ? [hooksLine, fn(core, 'updateLock'), fn(core, 'updateMissiles'), fn(core, 'fireMissile')] : [fn(orig, 'updateLock'), fn(orig, 'updateMissiles'), fn(orig, 'fireMissile')];
  const api = build(src.join('\n'), 'updateLock,updateMissiles,fireMissile', env);
  return { env, log, api, R };
}

/* ================= 1. ソロ: 元の Blue Sortie 4 と挙動が同一 ================= */
console.log('--- 1. ソロミッションのロックオン/ミサイル(元の関数と比較) ---');
for (const seed of [1, 2, 3, 4, 5]) {
  const A = world({ patched: false, seed }), B = world({ patched: true, seed }); // B は対戦外(OH フック無し)
  for (const w of [A, B]) {
    const R = rng(seed * 77);
    for (let i = 0; i < 6; i++) w.env.enemies.push({ id: 'e' + i, pos: new V3((R() - .5) * 3000, (R() - .5) * 600, -300 - R() * 3500), hp: 100, v: new V3((R() - .5) * 60, 0, (R() - .5) * 60) });
    for (let i = 0; i < 4; i++) w.env.tg.push({ id: 't' + i, r: 30, def: { sup: false }, pos: new V3((R() - .5) * 4000, -200, -500 - R() * 3000), v: new V3(0, 0, 0) });
  }
  let same = true, firedA = 0, firedB = 0;
  for (let f = 0; f < 400; f++) {
    for (const w of [A, B]) { for (const e of w.env.enemies.concat(w.env.tg)) e.pos.addScaledVector(e.v, 1 / 60); w.api.updateLock(1 / 60); }
    const idx = (w) => w.env.enemies.concat(w.env.tg).indexOf(w.env.lock.cand);
    if (idx(A) !== idx(B) || !near(A.env.lock.t, B.env.lock.t) || A.env.lock.locked !== B.env.lock.locked || A.log.beep !== B.log.beep) same = false;
    if (f % 90 === 40 && A.env.lock.locked) { A.api.fireMissile(); B.api.fireMissile(); firedA++; firedB++; A.env.P.mslT = B.env.P.mslT = 0; }
    A.api.updateMissiles(1 / 60); B.api.updateMissiles(1 / 60);
    const pa = A.env.missiles.map((m) => m.pos), pb = B.env.missiles.map((m) => m.pos);
    if (pa.length !== pb.length || pa.some((p, i) => p.distanceTo(pb[i]) > 1e-9)) same = false;
    if (JSON.stringify(A.log.explode) !== JSON.stringify(B.log.explode) || A.log.killed.join() !== B.log.killed.join() || JSON.stringify(A.log.dmgT) !== JSON.stringify(B.log.dmgT)) same = false;
  }
  ok(same && firedA > 0, `seed ${seed}: ロック状態・ビープ音・ミサイル軌道・爆発/撃破/ダメージが元と完全一致 (ミサイル ${firedA} 発)`);
}
{ const w = world({ patched: true }); const e = { id: 'enemy', pos: new V3(0, 0, -2000), hp: 100 }; w.env.enemies.push(e);
  for (let i = 0; i < 70; i++) w.api.updateLock(1 / 60);
  ok(w.env.lock.cand === e && w.env.lock.locked && w.log.beep === 1, '1. ソロ: 敵AIを約0.9秒でロックし、ロック完了音は1回'); }

/* ================= 2〜4. オンライン相手のロックオン ================= */
console.log('--- 2-4. オンライン相手のロックオン ---');
const mkRemote = (id, x, y, z) => ({ remote: true, id, name: id, pos: new V3(x, y, z), aim: new V3(x, y, z), alive: true });
function online(list) {
  const hooks = { remoteTargets: () => list.filter((t) => t.alive), remoteAlive: (t) => list.includes(t) && t.alive };
  return { ...world({ patched: true, hooks }), list, hooks };
}
{
  const r1 = mkRemote('rival', 0, 0, -2000), W = online([r1]);
  W.api.updateLock(1 / 60); ok(W.env.lock.cand === r1, '2. 前方2kmの相手が最初のフレームでロック候補になる(自分自身ではない別プレイヤー)');
  W.api.updateLock(1 / 60); ok(W.env.lock.t > 0 && !W.env.lock.locked, '2. 次のフレームからロック進行(元の仕様どおり)');
  for (let i = 0; i < 60; i++) W.api.updateLock(1 / 60);
  ok(W.env.lock.locked && W.log.beep === 1, '2. 約0.9秒でロック完了。ロック完了音が1回鳴る');
  for (let i = 0; i < 30; i++) { r1.pos.x += 8; r1.pos.z -= 5; W.api.updateLock(1 / 60); }
  ok(W.env.lock.cand === r1 && W.env.lock.locked && W.log.beep === 1, '4. 相手が動いてもロックは外れず追跡を続ける(再ロック音もなし)');
  r1.pos.set(2500, 0, -500); W.api.updateLock(1 / 60);
  ok(W.env.lock.cand === null && !W.env.lock.locked && W.env.lock.t === 0, '2. 照準の外(約79°)へ出るとロック解除');
  r1.pos.set(0, 0, -3800); W.api.updateLock(1 / 60); ok(W.env.lock.cand === null, '2. 射程(3.6km)外は対象外');
  r1.pos.set(0, 0, 500); W.api.updateLock(1 / 60); ok(W.env.lock.cand === null, '2. 背後の相手は対象外');
}
{
  const a = mkRemote('a', 700, 0, -2000), b = mkRemote('b', 100, 0, -2500), enemy = { id: 'ai', pos: new V3(-900, 0, -2000), hp: 100 }, W = online([a, b]);
  W.env.enemies.push(enemy); W.api.updateLock(1 / 60);
  ok(W.env.lock.cand === b, '2. 複数候補(相手2人+AI)では最も照準に近い対象を優先');
  b.pos.set(2500, 0, -100); W.api.updateLock(1 / 60); ok(W.env.lock.cand === a, '2. 次に照準へ近い対象へ切り替わる(ロックはやり直し)');
  ok(W.env.lock.t === 0 && !W.env.lock.locked, '2. 切り替え時はロック時間が0から');
}
{ const r1 = mkRemote('rival', 0, 0, -2000), W = online([r1]);
  for (let i = 0; i < 70; i++) W.api.updateLock(1 / 60);
  r1.alive = false; W.api.updateLock(1 / 60);
  ok(W.env.lock.cand === null && !W.env.lock.locked && W.env.lock.t === 0, '5. 相手が撃墜/切断/退出(alive=false)した瞬間にロック解除');
  W.list.length = 0; r1.alive = true; W.api.updateLock(1 / 60); ok(W.env.lock.cand === null, '5. 一覧から消えた(退出)相手はロック対象にならない'); }
{ const w = world({ patched: true }); w.env.enemies.push({ id: 'ai', pos: new V3(0, 0, -1500) });
  w.env.OH.remoteTargets = () => [mkRemote('x', 0, 0, -1000)]; w.env.OH.remoteTargets = undefined; w.api.updateLock(1 / 60);
  ok(w.env.lock.cand && w.env.lock.cand.id === 'ai', '1. 対戦外(フック無効)ならオンライン対象は一切候補にならない'); }

/* ================= 3. HUD ================= */
console.log('--- 3. HUD(ロック枠・LOCK表示) ---');
function hud(targets, lock) {
  const calls = [], hx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push(['hx.' + String(k), ...a])), set: (t, k, v) => { t[k] = v; return true; } });
  const env = { RT: () => targets, P: { pos: new V3() }, lock, proj: (p) => (p.hidden ? { ok: false } : { ok: true, x: 100 + p.x / 10, y: 200 }), clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    U: 1, lw: 1, hx, bracket: (x, y, s, c) => calls.push(['bracket', x, y, s, c]), txt: (t, x, y, sz, al, c) => calls.push(['txt', t, c]), C_RED: 'RED', C_AMB: 'AMB' };
  new Function('env', 'with(env){' + between(core, 'remote-hud') + '}')(env); return calls;
}
{ const r = mkRemote('rival', 0, 0, -2000), o = mkRemote('other', 500, 0, -1500);
  let c = hud([r, o], { cand: r, t: 1, locked: true });
  ok(c.filter((x) => x[0] === 'bracket' && x[4] === 'RED').length === 2 && c.some((x) => x[0] === 'txt' && x[1] === 'LOCK' && x[2] === 'RED'), '3. ロック完了: 赤い二重ブラケット + "LOCK" 表示');
  ok(c.filter((x) => x[0] === 'bracket' && x[4] === '#8dff9f').length === 1, '3. ロック対象でない相手は緑のブラケットのみ');
  c = hud([r], { cand: r, t: 0.5, locked: false });
  ok(c.some((x) => x[0] === 'bracket' && x[4] === 'AMB') && c.some((x) => x[0] === 'hx.arc') && !c.some((x) => x[0] === 'txt' && x[1] === 'LOCK'), '3. ロック中: 琥珀色の枠 + 進行リング(LOCK文字はまだ出ない)');
  c = hud([{ ...r, pos: Object.assign(new V3(0, 0, -2000), { hidden: true }) }], { cand: null, t: 0, locked: false }); ok(c.length === 0, '3. 画面外(投影不可)の相手は描画しない');
  c = hud([], { cand: null, t: 0, locked: false }); ok(c.length === 0, '3. 対象なしなら何も描画しない(ソロ時のHUDに影響なし)'); }

/* ================= 6. ミサイル誘導 ================= */
console.log('--- 6. ミサイル誘導 ---');
{
  const r1 = mkRemote('rival', 900, 0, -2400), W = online([r1]); // 照準から約20.5°(ロック有効角 約24° の内側)
  for (let i = 0; i < 70; i++) W.api.updateLock(1 / 60);
  ok(W.env.lock.locked, '6. 前提: 相手をロック済み'); const fired = []; W.hooks.onFire = (k, t) => fired.push([k, t && t.id]);
  W.api.fireMissile();
  ok(W.env.missiles[0].target === r1 && fired.length === 1 && fired[0][0] === 'm' && fired[0][1] === 'rival', '6. ロック中に発射 → ミサイルが相手を目標に持ち、通信層へ (m, 相手のpid) を通知');
  const m = W.env.missiles[0]; const d0 = m.pos.distanceTo(r1.aim); let minD = d0;
  for (let i = 0; i < 360 && W.env.missiles.length; i++) { r1.aim.x += .3; r1.pos.copy(r1.aim); W.api.updateMissiles(1 / 60); minD = Math.min(minD, m.pos.distanceTo(r1.aim)); }
  ok(minD < 34, `6. 動く相手へ向けて旋回・追尾し、命中距離(34m)内まで接近 (最接近 ${minD.toFixed(1)}m)`);
  ok(W.log.explode.length === 1 && W.env.missiles.length === 0, '6. 到達時に爆発エフェクトを出してミサイルは消える(ダメージはサーバーの hit で確定)');
}
{
  const r1 = mkRemote('rival', 0, 0, -2500), W = online([r1]); for (let i = 0; i < 70; i++) W.api.updateLock(1 / 60);
  W.api.fireMissile(); const m = W.env.missiles[0]; for (let i = 0; i < 20; i++) W.api.updateMissiles(1 / 60);
  r1.alive = false; const dir0 = m.dir.clone(); let threw = false;
  try { for (let i = 0; i < 60; i++) W.api.updateMissiles(1 / 60); } catch (e) { threw = true; }
  ok(!threw && near(m.dir.x, dir0.x, 1e-9) && near(m.dir.z, dir0.z, 1e-9), '6. 追尾中に相手が撃墜/切断 → 例外なく追尾をやめて直進');
  W.list.length = 0; r1.alive = true; threw = false; try { for (let i = 0; i < 10; i++) W.api.updateMissiles(1 / 60); } catch (e) { threw = true; }
  ok(!threw, '6. 相手が一覧から消えた(退出)後も例外なし');
  const W2 = online([mkRemote('z', 0, 0, -2500)]); W2.env.missiles.push({ m: new W2.env.THREE.Mesh(), pos: new V3(), dir: new V3(0, 0, -1), speed: 200, target: { remote: true, id: 'ghost' }, life: 7, puff: 0 });
  threw = false; try { for (let i = 0; i < 30; i++) W2.api.updateMissiles(1 / 60); } catch (e) { threw = true; } ok(!threw, '6. 存在しない対象(ghost)を参照していても例外なし'); }

/* ================= 5/10. RemotePlayers ================= */
console.log('--- RemotePlayers / Session ---');
const { RemotePlayers } = await import('../js/game/remote-players.js');
const { Session } = await import('../js/game/session.js');
const { createStore } = await import('../js/state/store.js');
const { initialState, reducer } = await import('../js/state/app-state.js');
const { packState } = await import('../shared/rules.js');
const mkJet = () => ({ position: new V3(), quaternion: new Quat(), visible: true, userData: { flame: { scale: { z: 1 } } }, traverse() {} });
const stubCore = (extra = {}) => ({ THREE: { Quaternion: Quat, Vector3: V3 }, scene: { add() {}, remove() {} }, makeJet: mkJet, calls: [], ...extra });
const snap = (id, x, o = {}) => ({ players: { [id]: packState({ x, y: 2300, z: -500, qx: 0, qy: 0, qz: 0, qw: 1, speed: 200, hp: o.hp ?? 100, flags: o.flags ?? 0 }) } });
{
  const rp = new RemotePlayers(stubCore()); tNow = 1000;
  rp.setRoster([{ id: 'me', name: 'ME' }, { id: 'rival', name: 'RIVAL', livery: 'solaris' }], 'me');
  ok(rp.map.size === 1 && !rp.map.has('me'), '2. 自分自身は対象外(roster に自分は入らない)');
  ok(rp.targets().length === 0, '機体が未表示(スナップショット前)の相手は対象にならない');
  rp.ingest(snap('rival', 0)); tNow = 1200; rp.update(); const t1 = rp.targets()[0];
  ok(rp.targets().length === 1 && t1.remote && t1.id === 'rival' && t1.alive, '表示中の相手がロック対象として提供される');
  rp.ingest(snap('rival', 400)); tNow = 1210; rp.update(); ok(rp.targets()[0] === t1, '対象オブジェクトは更新されても同一参照(ロックが途切れない)');
  ok(near(t1.aim.x, 400) && t1.pos.x < 400, '誘導用の位置(aim)は最新の同期値、表示位置(pos)は補間遅延ぶん遅れる');
  ok(rp.isLive(t1), 'isLive: 有効な対象は true');
  tNow = 1210 + 3000; rp.update(); ok(rp.targets().length === 0 && !rp.isLive(t1), '5. スナップショットが途絶(切断)すると対象から外れる');
  tNow = 5000; rp.ingest(snap('rival', 0, { hp: 55 })); tNow = 5200; rp.update(); ok(rp.targets().length === 1 && rp.map.get('rival').hp === 55, '復帰すると再び対象。HP はサーバー確定値');
  rp.ingest(snap('rival', 0, { flags: 1 })); tNow = 5400; rp.update(); ok(rp.targets().length === 0, '5. 撃墜(dead フラグ)で対象から外れる');
  rp.setRoster([{ id: 'me', name: 'ME' }], 'me'); ok(rp.map.size === 0 && !rp.isLive(t1), '5. 退出(roster から消える)で対象から外れ、isLive も false');
  const rp2 = new RemotePlayers(stubCore()); rp2.setRoster([{ id: 'x', name: 'X' }], 'me'); tNow = 100; rp2.ingest(snap('x', 0)); tNow = 300; rp2.update();
  rp2.markKilled('x'); ok(rp2.targets().length === 0, '撃墜通知で、次のスナップショットを待たずに即ロック解除');
}
{ /* Session: 発射通知・hit/kill の反映・対戦外では無効 */
  const handlers = {}, net = { fired: [], on(t, f) { handlers[t] = f; }, fire(k, t) { this.fired.push([k, t]); return true; }, sendState() {}, leaveMatch() {} };
  const core = stubCore({ calls: [], setPlayerHp(h) { this.calls.push(['hp', h]); }, notify(t) { this.calls.push(['say', t]); }, fx(p, k) { this.calls.push(['fx', k]); }, startArena() {}, getPlayer: () => null, isPlaying: () => false, leaveToMenu() {} });
  window.BSOHooks = {}; const store = createStore(reducer, initialState({ id: 'me', name: 'ME', livery: 'solaris', stats: {} }, {}, false));
  const ses = new Session({ core, store, net }); ses.attach(); const OH = window.BSOHooks;
  ok(OH.remoteTargets().length === 0 && OH.remoteAlive({}) === false, '対戦外: remoteTargets は空・remoteAlive は false(ソロに影響しない)');
  OH.onFire('m', { remote: true, id: 'rival' }); ok(net.fired.length === 0, '対戦外: 発射は通信されない');
  const room = { code: 'ABCDEF', hostId: 'me', status: 'inmatch', rev: 1, settings: { map: 'isles', tod: 'day', timeLimit: 600, mode: 'dogfight', maxPlayers: 4 }, players: [{ id: 'me', name: 'ME', livery: 'solaris' }, { id: 'rival', name: 'RIVAL', livery: 'solaris' }] };
  store.dispatch({ type: 'room/set', room }); store.dispatch({ type: 'match/start', match: { matchId: 'm1', seed: 1, settings: room.settings, players: ['me', 'rival'], startedAt: 0 } });
  tNow = 100; ses.remote.ingest(snap('rival', 0)); tNow = 300; ses.remote.update();
  ok(OH.remoteTargets().length === 1, '対戦中: 相手が remoteTargets に入る'); const tg = OH.remoteTargets()[0];
  OH.onFire('m', tg); OH.onFire('g'); OH.onFire('m', { id: 'x' });
  ok(JSON.stringify(net.fired) === JSON.stringify([['m', 'rival'], ['g', undefined], ['m', undefined]]), '発射通知: ミサイルは相手のpid付き、機銃は種別のみ、遠隔でない目標のpidは送らない');
  handlers.hit({ to: 'me', by: 'rival', k: 'm', dmg: 45, hp: 55 }); ok(core.calls.some((c) => c[0] === 'hp' && c[1] === 55), '7. 自分が被弾: サーバー確定のHP(55)を自機へ反映');
  handlers.hit({ to: 'rival', by: 'me', k: 'm', dmg: 45, hp: 55 }); ok(core.calls.some((c) => c[0] === 'fx' && c[1] === 'boom'), '7. 相手が被弾: 画面上の相手機に着弾エフェクト');
  handlers.kill({ to: 'rival', by: 'me', k: 'm' });
  ok(!OH.remoteAlive(tg) && OH.remoteTargets().length === 0 && core.calls.some((c) => c[0] === 'say' && /撃墜! RIVAL/.test(c[1])), '7. 相手の撃墜: ロック対象から即除外 + 「撃墜! RIVAL」表示');
  handlers.kill({ to: 'me', by: 'rival', k: 'g' }); ok(core.calls.some((c) => c[0] === 'hp' && c[1] === 0), '7. 自分の撃墜通知: HP0 → 撃墜処理');
  ses.exit(); OH.onFire('m', tg); handlers.hit({ to: 'me', hp: 1 }); ok(net.fired.length === 3 && core.calls.filter((c) => c[0] === 'hp').length === 2, '退出後は発射通知も hit の反映も行わない');
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
