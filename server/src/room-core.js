/* RoomCore - 1ルーム分のサーバー側ロジック。Cloudflare にも Node にも依存しない純粋なクラス。
 *
 * js/net/mock-server.js(LocalRoomServer) と「同じプロトコル」を話す本番実装:
 *   shared/protocol.js のメッセージ名・応答規約 (id → re) と shared/rules.js の検証関数をそのまま使う。
 * Durable Object (room-do.js) は WebSocket をこのクラスに渡すだけの薄いラッパー。
 * 時間関数は clock 経由で注入できるので、テストでは偽の時計で再現できる。
 *
 * ソケットの最小インターフェース: { send(string), close(code, reason) }
 * close コードは WebSocket 仕様上 1000 / 3000〜4999 のみ使う。
 *   4000 拒否 / 4001 キック / 4002 置換 / 4003 ルーム終了 / 4008 hello遅延 / 4009 巨大 / 4010 違反多発 / 4011 非テキスト */
import { PROTO, C2S, S2C, ERR, ERR_TEXT } from '../../shared/protocol.js';
import { defaultSettings, sanitizeSettings, sanitizeName, sanitizeLivery, unpackState } from '../../shared/rules.js';

export const LIMITS = Object.freeze({
  MAX_MSG_CHARS: 2048,        // 1メッセージの最大文字数 (超えたら切断)
  HELLO_TIMEOUT_MS: 5000,     // 接続後この時間内に hello が来なければ切断
  GRACE_MS: 15000,            // 切断後、再接続を待ってから退室扱いにするまで
  COUNTDOWN_MS: 3000,
  SNAP_MS: 50,                // snap 配信間隔 (20Hz)
  MATCH_END_SLACK_MS: 5000,   // 制限時間を過ぎてもクライアントが終了しない場合の保険
  CHAT_MAX: 120,
  STRIKE_WINDOW_MS: 10000,    // この時間内に STRIKE_MAX 回の違反で切断
  STRIKE_MAX: 40,
});

const PID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const TOK_RE = /^[A-Za-z0-9_-]{8,64}$/;

/* トークンバケット: 1秒あたり rate 回、瞬間最大 cap 回 */
class Bucket {
  constructor(cap, rate, now) { this.cap = cap; this.rate = rate; this.v = cap; this.t = now; }
  take(now) {
    this.v = Math.min(this.cap, this.v + ((now - this.t) / 1000) * this.rate); this.t = now;
    if (this.v < 1) return false;
    this.v -= 1; return true;
  }
}

/** state 配列の検証。数値の正常性・範囲・クォータニオン長を確認し、正しければ 10要素の新配列を返す。 */
export function validateState(a) {
  if (!Array.isArray(a) || a.length !== 10) return null;
  const s = unpackState(a);
  if (!s) return null;
  if (Math.abs(s.x) > 100000 || Math.abs(s.z) > 100000 || s.y < -1000 || s.y > 30000) return null;
  const n2 = s.qx * s.qx + s.qy * s.qy + s.qz * s.qz + s.qw * s.qw;
  if (n2 < 0.8 || n2 > 1.2) return null;
  if (s.speed < 0 || s.speed > 3000) return null;
  if (s.hp < -1 || s.hp > 5000) return null;
  if (!Number.isInteger(s.flags) || s.flags < 0 || s.flags > 255) return null;
  return a.slice(0, 10);
}

const defaultClock = () => ({
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h),
  setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h),
  random: () => Math.random(),
});

export class RoomCore {
  /** meta = { code, hostId, settings } / null なら存在しないルーム(hello に room_not_found を返す) */
  constructor({ meta, clock, hooks, limits } = {}) {
    const dc = defaultClock(); const ck = clock || {};
    this.clock = {}; // クラスのメソッドも使えるよう、関数を明示的に束縛して取り込む
    for (const k of Object.keys(dc)) this.clock[k] = typeof ck[k] === 'function' ? ck[k].bind(ck) : dc[k];
    this.hooks = hooks || {};
    this.L = { ...LIMITS, ...(limits || {}) };
    this.alive = !!meta;
    this.code = meta ? meta.code : null;
    this.hostId = meta ? meta.hostId : null;
    this.settings = meta ? sanitizeSettings(meta.settings, defaultSettings(), 0) : defaultSettings();
    this.status = 'lobby';        // lobby | countdown | inmatch
    this.rev = 1;
    this.startAt = null;
    this.players = [];            // 公開情報 {id,name,livery,ready,ping,connected,isBot}
    this.priv = new Map();        // pid -> { tok, grace }  (外部に出さない)
    this.conns = new Map();       // pid -> conn
    this.all = new Set();         // hello 前も含む全接続
    this.banned = new Set();
    this.states = {}; this.inMatch = new Set(); this.dirty = false;
    this.tick = 0; this.matchId = null; this.seed = 0; this.t0 = 0;
    this.snapTimer = null; this.startTimer = null; this.endTimer = null;
  }

  get connCount() { return this.all.size; }
  /** 外部(DOのアラーム等)からルームを閉じる */
  close() { this._destroy(); }

  /* ================= 接続の出入り ================= */
  accept(sock) {
    const now = this.clock.now();
    const conn = { sock, pid: null, joined: false, dead: false, strikes: 0, winT: now,
      bGen: new Bucket(40, 20, now), bState: new Bucket(30, 25, now), bChat: new Bucket(3, 0.5, now), helloTimer: null };
    this.all.add(conn);
    conn.helloTimer = this.clock.setTimeout(() => { if (!conn.joined) this._kill(conn, 4008, 'hello timeout'); }, this.L.HELLO_TIMEOUT_MS);
    return conn;
  }

  /** ソケットが閉じた(または壊れた)ときに呼ぶ。冪等。 */
  closed(conn) {
    if (conn.dead && !this.all.has(conn)) return;
    conn.dead = true; this.all.delete(conn);
    if (conn.helloTimer) { this.clock.clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    if (!conn.joined || this.conns.get(conn.pid) !== conn) return; // 置換済み・退室済みは何もしない
    this.conns.delete(conn.pid);
    const p = this._p(conn.pid); if (!p) return;
    p.connected = false;
    delete this.states[p.id];
    const pv = this.priv.get(p.id);
    if (pv) pv.grace = this.clock.setTimeout(() => this._removePlayer(p.id), this.L.GRACE_MS);
    this._bc();
  }

  _kill(conn, code, reason) {
    try { conn.sock.close(code, reason); } catch (e) { /* ignore */ }
    this.closed(conn);
  }

  /* ================= 受信 ================= */
  receive(conn, raw) {
    if (conn.dead) return;
    if (typeof raw !== 'string') return this._kill(conn, 4011, 'text only');
    if (raw.length > this.L.MAX_MSG_CHARS) return this._kill(conn, 4009, 'too big');
    let m; try { m = JSON.parse(raw); } catch (e) { return this._strike(conn); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return this._strike(conn);
    const now = this.clock.now();
    const bucket = m.t === C2S.STATE ? conn.bState : m.t === C2S.CHAT ? conn.bChat : conn.bGen;
    if (!bucket.take(now)) { if (m.t !== C2S.CHAT) this._strike(conn); return; }

    if (m.t === C2S.PING) {
      if (typeof m.ts !== 'number' || !isFinite(m.ts)) return this._strike(conn);
      return this._send(conn, { t: S2C.PONG, ts: m.ts });
    }
    if (m.t === C2S.HELLO) return this._hello(conn, m);
    if (!conn.joined || this.conns.get(conn.pid) !== conn || !this.alive) return this._strike(conn);
    const me = this._p(conn.pid); if (!me) return;
    const host = this.hostId === me.id;

    switch (m.t) {
      case C2S.READY:
        if (this.status !== 'lobby') break;
        me.ready = !!m.ready; this._bc(); break;
      case C2S.SETTINGS:
        if (!host) return this._err(conn, m, ERR.NOT_HOST);
        if (this.status !== 'lobby') break;
        if (!m.patch || typeof m.patch !== 'object' || Array.isArray(m.patch)) return this._strike(conn);
        this.settings = sanitizeSettings(m.patch, this.settings, this.players.length); this._bc(); break;
      case C2S.KICK: {
        if (!host) return this._err(conn, m, ERR.NOT_HOST);
        if (typeof m.pid !== 'string') return this._strike(conn);
        const t = this._p(m.pid);
        if (!t || t.id === me.id) break;
        this.banned.add(t.id);
        const tc = this.conns.get(t.id);
        if (tc) { this._send(tc, { t: S2C.KICK, reason: ERR_TEXT.kicked }); this._kill(tc, 4001, 'kicked'); }
        this._removePlayer(t.id); break;
      }
      case C2S.START:
        if (!host) return this._err(conn, m, ERR.NOT_HOST);
        if (this.status !== 'lobby') break;
        if (this.players.length < 2) return this._err(conn, m, ERR.NEED_PLAYERS);
        if (!this.players.every((p) => p.connected && (p.id === this.hostId || p.ready))) return this._err(conn, m, ERR.NOT_READY);
        this._startCountdown(); break;
      case C2S.MATCH_JOIN:
        if (this.status === 'inmatch') { this.inMatch.add(me.id); this._send(conn, this._startMsg()); }
        break;
      case C2S.MATCH_LEAVE:
        this.inMatch.delete(me.id); delete this.states[me.id]; this._checkMatchEnd(); break;
      case C2S.STATE: {
        if (this.status !== 'inmatch' || !this.inMatch.has(me.id)) break;
        const s = validateState(m.s);
        if (!s) return this._strike(conn);
        this.states[me.id] = s; this.dirty = true; break;
      }
      case C2S.CHAT: {
        if (typeof m.text !== 'string') return this._strike(conn);
        const text = m.text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, this.L.CHAT_MAX);
        if (text) this._each((c) => this._send(c, { t: S2C.CHAT, from: me.id, name: me.name, text }));
        break;
      }
      case C2S.LEAVE: this._removePlayer(me.id); this._kill(conn, 1000, 'leave'); break;
      default: this._strike(conn);
    }
  }

  _strike(conn) {
    const now = this.clock.now();
    if (now - conn.winT > this.L.STRIKE_WINDOW_MS) { conn.winT = now; conn.strikes = 0; }
    if (++conn.strikes >= this.L.STRIKE_MAX) this._kill(conn, 4010, 'policy');
  }

  /* ================= 入室 ================= */
  _hello(conn, m) {
    const fail = (code, msg) => { this._err(conn, m, code, msg); this._kill(conn, 4000, code); };
    if (conn.joined) return this._err(conn, m, ERR.BAD_REQUEST);
    if (m.v !== PROTO) return fail(ERR.VERSION);
    if (!this.alive) return fail(ERR.ROOM_NOT_FOUND);
    if (typeof m.pid !== 'string' || !PID_RE.test(m.pid)) return fail(ERR.BAD_REQUEST);
    const pid = m.pid;
    const tok = typeof m.tok === 'string' && TOK_RE.test(m.tok) ? m.tok : null;
    if (this.banned.has(pid)) return fail(ERR.KICKED);

    let p = this._p(pid);
    if (p) {
      const pv = this.priv.get(pid);
      if (!pv || pv.tok !== tok) return fail(ERR.BAD_REQUEST, 'このパイロットは別の接続で使用中です。しばらく待ってから再接続してください。');
      p.connected = true;
      p.name = sanitizeName(m.name) || p.name; p.livery = sanitizeLivery(m.livery);
      if (pv.grace) { this.clock.clearTimeout(pv.grace); pv.grace = null; }
    } else {
      if (this.status !== 'lobby') return fail(ERR.IN_PROGRESS);
      if (this.players.length >= this.settings.maxPlayers) return fail(ERR.ROOM_FULL);
      p = { id: pid, name: sanitizeName(m.name) || 'PILOT', livery: sanitizeLivery(m.livery), ready: false, ping: null, connected: true, isBot: false };
      this.players.push(p); this.priv.set(pid, { tok, grace: null });
    }
    const old = this.conns.get(pid);
    if (old && old !== conn) { this.conns.delete(pid); this._kill(old, 4002, 'replaced'); }
    if (conn.helloTimer) { this.clock.clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    conn.pid = pid; conn.joined = true; this.conns.set(pid, conn);
    if (!this._p(this.hostId)) this.hostId = pid;
    this.rev++;
    this._send(conn, { t: S2C.WELCOME, re: m.id, you: pid, room: this._snapshot(), serverTime: this.clock.now() });
    this._each((c) => { if (c !== conn) this._send(c, { t: S2C.ROOM, room: this._snapshot() }); });
    if (this.hooks.onActive) this.hooks.onActive();
  }

  /* ================= 退室・ホスト移譲 ================= */
  _removePlayer(pid) {
    const p = this._p(pid); if (!p) return;
    const pv = this.priv.get(pid); if (pv && pv.grace) this.clock.clearTimeout(pv.grace);
    this.priv.delete(pid);
    this.players = this.players.filter((x) => x.id !== pid);
    const c = this.conns.get(pid); this.conns.delete(pid);
    if (c) this._kill(c, 1000, 'removed');
    this.inMatch.delete(pid); delete this.states[pid];
    if (!this.players.length) return this._destroy();
    if (this.hostId === pid) {
      const next = this.players.find((x) => x.connected) || this.players[0];
      this.hostId = next.id;
    }
    if (this.status === 'countdown' && this.players.filter((x) => x.connected).length < 2) this._cancelCountdown();
    this._checkMatchEnd();
    this._bc();
  }

  _destroy() {
    if (!this.alive) return;
    this.alive = false;
    this._clearTimers();
    this.priv.forEach((pv) => { if (pv.grace) this.clock.clearTimeout(pv.grace); });
    this.priv.clear(); this.players = []; this.inMatch.clear(); this.states = {};
    [...this.all].forEach((c) => this._kill(c, 4003, 'room closed'));
    if (this.hooks.onEmpty) this.hooks.onEmpty();
  }

  /* ================= 対戦進行 ================= */
  _startMsg() {
    return { t: S2C.START, matchId: this.matchId, seed: this.seed, settings: this.settings, players: this.players.map((p) => p.id), serverTime: this.clock.now() };
  }
  _startCountdown() {
    this.status = 'countdown'; this.startAt = this.clock.now() + this.L.COUNTDOWN_MS; this._bc();
    this.startTimer = this.clock.setTimeout(() => this._beginMatch(), this.L.COUNTDOWN_MS);
  }
  _cancelCountdown() {
    this.clock.clearTimeout(this.startTimer); this.startTimer = null;
    this.status = 'lobby'; this.startAt = null;
    this.players.forEach((p) => { p.ready = false; });
  }
  _beginMatch() {
    this.startTimer = null;
    if (this.status !== 'countdown') return;
    const live = this.players.filter((p) => p.connected);
    if (live.length < 2) { this._cancelCountdown(); return this._bc(); }
    this.status = 'inmatch'; this.startAt = null; this.t0 = this.clock.now(); this.tick = 0; this.states = {}; this.dirty = false;
    this.matchId = 'm' + this.t0.toString(36) + Math.floor(this.clock.random() * 1296).toString(36);
    this.seed = Math.floor(this.clock.random() * 2 ** 31);
    this.inMatch = new Set(live.map((p) => p.id));
    this._bc();
    const msg = this._startMsg();
    this.inMatch.forEach((id) => { const c = this.conns.get(id); if (c) this._send(c, msg); });
    this.snapTimer = this.clock.setInterval(() => this._snapTick(), this.L.SNAP_MS);
    this.endTimer = this.clock.setTimeout(() => this._endMatch(), this.settings.timeLimit * 1000 + this.L.MATCH_END_SLACK_MS);
  }
  _snapTick() {
    if (this.status !== 'inmatch' || !this.dirty) return;
    this.dirty = false; this.tick++;
    const ts = this.clock.now();
    this.inMatch.forEach((id) => {
      const c = this.conns.get(id); if (!c) return;
      const players = {}; let n = 0;
      for (const k in this.states) if (k !== id) { players[k] = this.states[k]; n++; }
      if (n) this._send(c, { t: S2C.SNAP, tick: this.tick, ts, players });
    });
  }
  _checkMatchEnd() { if (this.status === 'inmatch' && this.inMatch.size === 0) this._endMatch(); }
  _endMatch() {
    if (this.status !== 'inmatch') return;
    this._clearTimers();
    this.status = 'lobby'; this.startAt = null; this.states = {}; this.inMatch.clear();
    this.players.forEach((p) => { p.ready = false; });
    this._bc();
    this._each((c) => this._send(c, { t: S2C.MATCH_END, results: [] }));
  }
  _clearTimers() {
    if (this.snapTimer) this.clock.clearInterval(this.snapTimer);
    if (this.startTimer) this.clock.clearTimeout(this.startTimer);
    if (this.endTimer) this.clock.clearTimeout(this.endTimer);
    this.snapTimer = this.startTimer = this.endTimer = null;
  }

  /* ================= ヘルパー ================= */
  _p(pid) { return this.players.find((p) => p.id === pid); }
  _snapshot() {
    return { code: this.code, hostId: this.hostId, status: this.status, rev: this.rev, startAt: this.startAt, settings: this.settings,
      players: this.players.map((p) => ({ ...p })) };
  }
  _bc() { this.rev++; const m = { t: S2C.ROOM, room: this._snapshot() }; this._each((c) => this._send(c, m)); }
  _each(fn) { this.conns.forEach((c) => fn(c)); }
  _send(conn, obj) { if (conn.dead) return; try { conn.sock.send(JSON.stringify(obj)); } catch (e) { /* 壊れたソケットは close イベントで掃除される */ } }
  _err(conn, m, code, msg) { this._send(conn, { t: S2C.ERROR, re: m && typeof m.id === 'number' ? m.id : undefined, code, msg: msg || ERR_TEXT[code] || code }); }
}
