/* LocalRoomServer: 本番の Durable Object と「同じプロトコル」を話すインメモリのモック。
 * → 後で書く Worker/DO はこのファイルのロジックをほぼそのまま移植できる (これが契約書の実装例)。
 *
 * デモ用: ルームコード ALPHA2 は常に存在し、仮想フレンド(ボット)が在室している。
 * 仮想フレンドは入室・Ready・自動開始・周回飛行を行う (?bots=0 で無効化)。 */
import { PROTO, C2S, S2C, ERR, ERR_TEXT } from '../../shared/protocol.js';
import { defaultSettings, sanitizeSettings, sanitizeName, sanitizeLivery, genRoomCode, packState } from '../../shared/rules.js';

const LAT = 45; // 片道遅延(ms)。固定値なので到着順は保たれる
const BOTS = [['KITE', 'phantom'], ['ELENA', 'crimson'], ['VICTOR', 'violet']];
export const DEMO_CODE = 'ALPHA2';

class MockSocket {
  constructor(server, code) {
    this.server = server; this.code = code; this.readyState = 0; this.pid = null;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen && this.onopen({}); } }, LAT);
  }
  send(data) {
    if (this.readyState !== 1) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    setTimeout(() => { if (this.readyState === 1) this.server._recv(this, m); }, LAT);
  }
  _push(obj) {
    const raw = JSON.stringify(obj);
    setTimeout(() => { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: raw }); }, LAT);
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3; this.server._drop(this);
    setTimeout(() => this.onclose && this.onclose({ code: 1000 }), 0);
  }
  _serverClose() {
    if (this.readyState >= 2) return;
    setTimeout(() => { this.readyState = 3; this.server._drop(this); this.onclose && this.onclose({ code: 4000 }); }, LAT);
  }
}

export class LocalRoomServer {
  constructor(opts = {}) {
    this.rooms = new Map();
    this.bots = opts.bots !== false;
    this._seedDemo();
  }

  createRoom({ pid, settings }) {
    let code; do { code = genRoomCode(); } while (this.rooms.has(code));
    this.rooms.set(code, this._newRoom(code, pid, sanitizeSettings(settings, defaultSettings(), 0)));
    return { code };
  }
  connect(code) { return new MockSocket(this, code); }

  /* ---- ルーム生成 ---- */
  _newRoom(code, hostId, settings) {
    return { code, hostId, status: 'lobby', rev: 1, startAt: null, settings, players: [], conns: new Map(), states: {}, inMatch: new Set(),
      tick: 0, timer: null, startTimer: null, matchId: null, t0: 0, demo: false, botsAdded: false };
  }
  _seedDemo() {
    const r = this._newRoom(DEMO_CODE, 'bot:kite', defaultSettings());
    r.demo = true;
    if (this.bots) { r.players.push(this._bot(0)); r.players[0].ready = true; }
    this.rooms.set(DEMO_CODE, r);
  }
  _bot(i) {
    const [name, livery] = BOTS[i % BOTS.length];
    return { id: 'bot:' + name.toLowerCase(), name, livery, ready: false, ping: 30 + Math.floor(Math.random() * 50), connected: true, isBot: true };
  }
  _snapshot(r) {
    return { code: r.code, hostId: r.hostId, status: r.status, rev: r.rev, startAt: r.startAt, settings: r.settings,
      players: r.players.map((p) => ({ ...p })) };
  }
  _bc(r) { r.rev++; const m = { t: S2C.ROOM, room: this._snapshot(r) }; r.conns.forEach((s) => s._push(m)); }
  _err(sock, m, code) { sock._push({ t: S2C.ERROR, re: m.id, code, msg: ERR_TEXT[code] || code }); }
  _humans(r) { return r.players.filter((p) => !p.isBot); }

  /* ---- ボット挙動 ---- */
  _fillBots(r) {
    if (!this.bots || r.botsAdded) return;
    r.botsAdded = true;
    const want = r.demo ? [1, 2] : [0, 1];
    want.forEach((bi, k) => setTimeout(() => {
      if (!this.rooms.has(r.code) || r.status !== 'lobby') return;
      if (r.players.length >= r.settings.maxPlayers || !this._humans(r).length) return;
      const b = this._bot(bi);
      if (r.players.some((p) => p.id === b.id)) return;
      r.players.push(b); this._bc(r);
      setTimeout(() => { const q = r.players.find((p) => p.id === b.id); if (q && r.status === 'lobby') { q.ready = true; this._bc(r); this._maybeBotStart(r); } }, 1500 + Math.random() * 2000);
    }, 1500 + k * 2200));
  }
  _maybeBotStart(r) {
    const host = r.players.find((p) => p.id === r.hostId);
    if (!host || !host.isBot || r.status !== 'lobby') return;
    const pl = r.players;
    if (pl.length >= 2 && pl.every((p) => p.ready)) setTimeout(() => { if (r.status === 'lobby') this._start(r); }, 1200);
  }

  /* ---- 受信処理 ---- */
  _recv(sock, m) {
    const r = this.rooms.get(sock.code);
    if (m.t === C2S.PING) { sock._push({ t: S2C.PONG, ts: m.ts }); return; }
    if (m.t === C2S.HELLO) return this._hello(sock, m, r);
    if (!r || !sock.pid) return;
    const me = r.players.find((p) => p.id === sock.pid);
    if (!me) return;
    const host = r.hostId === me.id;
    switch (m.t) {
      case C2S.READY:
        if (r.status !== 'lobby') break;
        me.ready = !!m.ready; this._bc(r); this._maybeBotStart(r); break;
      case C2S.SETTINGS:
        if (!host) return this._err(sock, m, ERR.NOT_HOST);
        if (r.status !== 'lobby') break;
        r.settings = sanitizeSettings(m.patch, r.settings, r.players.length); this._bc(r); break;
      case C2S.KICK: {
        if (!host) return this._err(sock, m, ERR.NOT_HOST);
        const t = r.players.find((p) => p.id === m.pid);
        if (!t || t.id === me.id) break;
        const ts = r.conns.get(t.id);
        if (ts) { ts._push({ t: S2C.KICK, reason: ERR_TEXT.kicked }); ts._serverClose(); }
        this._remove(r, t.id); break;
      }
      case C2S.START: {
        if (!host) return this._err(sock, m, ERR.NOT_HOST);
        if (r.status !== 'lobby') break;
        if (r.players.length < 2) return this._err(sock, m, ERR.NEED_PLAYERS);
        if (!r.players.every((p) => p.id === r.hostId || p.ready)) return this._err(sock, m, ERR.NOT_READY);
        this._start(r); break;
      }
      case C2S.MATCH_JOIN:
        if (r.status === 'inmatch') { r.inMatch.add(me.id); sock._push(this._startMsg(r)); } break;
      case C2S.MATCH_LEAVE:
        r.inMatch.delete(me.id); delete r.states[me.id]; this._checkMatchEnd(r); break;
      case C2S.STATE:
        if (r.status === 'inmatch' && r.inMatch.has(me.id) && Array.isArray(m.s) && m.s.length === 10) r.states[me.id] = m.s; break;
      case C2S.CHAT: {
        const text = String(m.text || '').slice(0, 120).replace(/[\u0000-\u001f]/g, '');
        if (text) r.conns.forEach((s) => s._push({ t: S2C.CHAT, from: me.id, name: me.name, text }));
        break;
      }
      case C2S.LEAVE: this._remove(r, me.id); sock.close(); break;
      default: break;
    }
  }

  _hello(sock, m, r) {
    if (!r) { this._err(sock, m, ERR.ROOM_NOT_FOUND); sock._serverClose(); return; }
    if (m.v !== PROTO) { this._err(sock, m, ERR.VERSION); sock._serverClose(); return; }
    const pid = String(m.pid || '').slice(0, 40);
    if (!pid) { this._err(sock, m, ERR.BAD_REQUEST); sock._serverClose(); return; }
    let p = r.players.find((x) => x.id === pid);
    if (!p) {
      if (r.status !== 'lobby') { this._err(sock, m, ERR.IN_PROGRESS); sock._serverClose(); return; }
      if (r.players.length >= r.settings.maxPlayers) { this._err(sock, m, ERR.ROOM_FULL); sock._serverClose(); return; }
      p = { id: pid, name: sanitizeName(m.name) || 'PILOT', livery: sanitizeLivery(m.livery), ready: false, ping: 45, connected: true, isBot: false };
      r.players.push(p);
    } else { p.connected = true; p.name = sanitizeName(m.name) || p.name; p.livery = sanitizeLivery(m.livery); }
    const old = r.conns.get(pid); if (old && old !== sock) { old._serverClose(); }
    sock.pid = pid; r.conns.set(pid, sock);
    const hostP = r.players.find((x) => x.id === r.hostId);
    if (!hostP || (!hostP.isBot && hostP.connected === false)) r.hostId = pid;
    r.rev++;
    sock._push({ t: S2C.WELCOME, re: m.id, you: pid, room: this._snapshot(r), serverTime: Date.now() });
    r.conns.forEach((s, id) => { if (id !== pid) s._push({ t: S2C.ROOM, room: this._snapshot(r) }); });
    this._fillBots(r);
  }

  /* ---- 切断・退室 ---- */
  _drop(sock) {
    const r = this.rooms.get(sock.code);
    if (!r || !sock.pid || r.conns.get(sock.pid) !== sock) return;
    r.conns.delete(sock.pid);
    const p = r.players.find((x) => x.id === sock.pid);
    if (!p) return;
    p.connected = false; this._bc(r);
    setTimeout(() => { const q = r.players.find((x) => x.id === p.id); if (q && q.connected === false && !r.conns.has(p.id)) this._remove(r, p.id); }, 10000);
  }
  _remove(r, pid) {
    r.players = r.players.filter((p) => p.id !== pid);
    r.conns.delete(pid); r.inMatch.delete(pid); delete r.states[pid];
    if (r.hostId === pid) {
      const next = r.players.find((p) => !p.isBot && p.connected !== false) || r.players[0];
      r.hostId = next ? next.id : null;
    }
    if (!this._humans(r).length) {
      clearInterval(r.timer); clearTimeout(r.startTimer);
      if (r.demo) { this.rooms.delete(r.code); this._seedDemo(); } else this.rooms.delete(r.code);
      return;
    }
    this._checkMatchEnd(r);
    this._bc(r);
  }

  /* ---- 対戦進行 (モックは仮想フレンドの周回飛行のみ配信) ---- */
  _startMsg(r) {
    return { t: S2C.START, matchId: r.matchId, seed: r.seed, settings: r.settings, players: r.players.map((p) => p.id), serverTime: Date.now() };
  }
  _start(r) {
    r.status = 'countdown'; r.startAt = Date.now() + 3000; this._bc(r);
    r.startTimer = setTimeout(() => {
      if (r.status !== 'countdown') return;
      r.status = 'inmatch'; r.startAt = null; r.t0 = Date.now(); r.tick = 0; r.states = {};
      r.matchId = 'm' + Date.now().toString(36); r.seed = (Math.random() * 2 ** 31) | 0;
      r.inMatch = new Set(r.players.filter((p) => !p.isBot && p.connected !== false).map((p) => p.id));
      this._bc(r);
      const msg = this._startMsg(r);
      r.inMatch.forEach((id) => { const s = r.conns.get(id); if (s) s._push(msg); });
      clearInterval(r.timer); r.timer = setInterval(() => this._tick(r), 50);
    }, 3000);
  }
  _tick(r) {
    r.tick++;
    const t = (Date.now() - r.t0) / 1000;
    const all = { ...r.states };
    r.players.forEach((p, i) => {
      if (!p.isBot) return;
      const a = t * 0.12 + i * 2.1, R = 1500 + i * 220, dx = -Math.sin(a), dz = Math.cos(a), th = Math.atan2(-dx, -dz);
      all[p.id] = packState({ x: Math.cos(a) * R, y: 2300 + Math.sin(t * 0.4 + i) * 90, z: Math.sin(a) * R,
        qx: 0, qy: Math.sin(th / 2), qz: 0, qw: Math.cos(th / 2), speed: 210, hp: 100, flags: 0 });
    });
    r.inMatch.forEach((id) => {
      const s = r.conns.get(id); if (!s) return;
      const players = {}; for (const k in all) if (k !== id) players[k] = all[k];
      s._push({ t: S2C.SNAP, tick: r.tick, ts: Date.now(), players });
    });
  }
  _checkMatchEnd(r) {
    if (r.status !== 'inmatch' && r.status !== 'countdown') return;
    if (r.status === 'countdown' && this._humans(r).length) return;
    if (r.inMatch.size) return;
    clearInterval(r.timer); clearTimeout(r.startTimer);
    r.status = 'lobby'; r.startAt = null; r.states = {};
    r.players.forEach((p) => { p.ready = !!p.isBot; });
    this._bc(r);
    r.conns.forEach((s) => s._push({ t: S2C.MATCH_END, results: [] }));
  }
}
