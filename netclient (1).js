/* NetClient - 通信層の唯一の窓口。UI・ゲームは WebSocket を直接触らない。
 *
 * Backend インターフェース (Cloudflare版 / モック版を差し替え可能):
 *   createRoom({ pid, name, settings }) -> Promise<{ code }>
 *   openSocket(code)                    -> WebSocket互換 { onopen,onmessage,onclose,onerror,send,close,readyState }
 */
import { CONFIG } from '../config.js';
import { PROTO, C2S, S2C, ERR } from '../../shared/protocol.js';
import { normalizeCode, isRoomCode, sanitizeName } from '../../shared/rules.js';
import { NetError } from './errors.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000];

function makeTok() {
  try { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); } catch (e) { /* 古い環境 */ }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class NetClient {
  constructor({ backend, store }) {
    this.backend = backend;
    this.store = store;
    this.sock = null;
    this.code = null;
    this.joined = false;
    this.closing = false;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.pingTimer = null;
    this.rtt = null;
    this.retry = 0;
    this.serverOffset = 0; // serverTime - localTime (ms)
    this.tok = makeTok(); // 再接続の本人確認用の秘密(ページを開いている間だけ有効・保存しない)。pid は他プレイヤーにも見えるため
  }

  /* ---- イベント: サーバーからのメッセージ種別 + 'lost' (切断確定) ---- */
  on(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev).add(fn);
    return () => this.listeners.get(ev).delete(fn);
  }
  _emit(ev, data) { const l = this.listeners.get(ev); if (l) l.forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); }

  get serverNow() { return Date.now() + this.serverOffset; }
  get profile() { return this.store.get().profile; }

  /* ---- 公開API ---- */
  async createRoom(settings) {
    this._conn('connecting');
    try {
      const p = this.profile;
      const { code } = await this.backend.createRoom({ pid: p.id, name: p.name, settings });
      return await this.joinRoom(code);
    } catch (e) { this._fail(e); throw e; }
  }

  async joinRoom(rawCode) {
    const code = normalizeCode(rawCode);
    if (!isRoomCode(code)) throw new NetError(ERR.BAD_CODE);
    this._conn('connecting');
    try {
      await this._connect(code);
      this._conn('online');
      this._startPing();
      return this.store.get().room;
    } catch (e) { this._teardown(); this._fail(e); throw e; }
  }

  leaveRoom() {
    if (this.sock && this.joined) this._send({ t: C2S.LEAVE });
    this._teardown();
    this.store.dispatch({ type: 'room/clear' });
    this._conn('offline');
  }

  setReady(ready) { this._send({ t: C2S.READY, ready: !!ready }); }
  updateSettings(patch) { this._send({ t: C2S.SETTINGS, patch }); }
  kick(pid) { this._send({ t: C2S.KICK, pid }); }
  startMatch() { this._send({ t: C2S.START }); }
  joinMatch() { this._send({ t: C2S.MATCH_JOIN }); }
  leaveMatch() { this._send({ t: C2S.MATCH_LEAVE }); this.store.dispatch({ type: 'match/end' }); }
  sendState(arr) { this._send({ t: C2S.STATE, s: arr }); }
  chat(text) { this._send({ t: C2S.CHAT, text: String(text).slice(0, 120) }); }

  /* ---- 内部: 接続 ---- */
  async _connect(code) {
    this._closeSock();
    this.closing = false;
    const sock = this.backend.openSocket(code);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new NetError(ERR.TIMEOUT)), CONFIG.REQUEST_TIMEOUT_MS);
      sock.onopen = () => { clearTimeout(t); res(); };
      sock.onerror = () => { clearTimeout(t); rej(new NetError(ERR.CONNECT_FAILED)); };
      sock.onclose = () => { clearTimeout(t); rej(new NetError(ERR.CONNECT_FAILED)); };
    });
    sock.onmessage = (ev) => this._onRaw(ev.data);
    sock.onclose = () => this._onClose(sock);
    sock.onerror = () => {};
    this.sock = sock;
    this.code = code;
    const p = this.profile;
    const t0 = Date.now();
    const w = await this._request({ t: C2S.HELLO, v: PROTO, pid: p.id, tok: this.tok, name: sanitizeName(p.name), livery: p.livery });
    this.serverOffset = (w.serverTime || t0) - (t0 + Date.now()) / 2;
    this.joined = true;
    this.retry = 0;
    this.store.dispatch({ type: 'room/set', room: w.room });
  }

  _request(msg, timeout = CONFIG.REQUEST_TIMEOUT_MS) {
    const id = ++this.seq;
    msg.id = id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new NetError(ERR.TIMEOUT)); }, timeout);
      this.pending.set(id, { res, rej, timer });
      this._send(msg);
    });
  }

  _send(obj) {
    const s = this.sock;
    if (!s || s.readyState !== 1) return false;
    try { s.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  _onRaw(raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.re != null && this.pending.has(m.re)) {
      const p = this.pending.get(m.re); this.pending.delete(m.re); clearTimeout(p.timer);
      if (m.t === S2C.ERROR) p.rej(new NetError(m.code, m.msg)); else p.res(m);
      return;
    }
    switch (m.t) {
      case S2C.PONG: {
        const r = Math.max(0, performance.now() - m.ts);
        this.rtt = this.rtt == null ? r : this.rtt * 0.7 + r * 0.3;
        this.store.dispatch({ type: 'conn', patch: { ping: Math.round(this.rtt) } });
        break;
      }
      case S2C.ROOM: this.store.dispatch({ type: 'room/set', room: m.room }); break;
      case S2C.START:
        this.store.dispatch({ type: 'match/start', match: { matchId: m.matchId, seed: m.seed, settings: m.settings, players: m.players, startedAt: m.serverTime } });
        break;
      case S2C.MATCH_END: this.store.dispatch({ type: 'match/end' }); break;
      case S2C.KICK:
        this._teardown();
        this.store.dispatch({ type: 'room/clear' });
        this._conn('offline');
        this.store.dispatch({ type: 'toast', msg: m.reason || 'ルームから退出しました', kind: 'warn' });
        this._emit('lost', { reason: m.reason || ERR.KICKED });
        return;
      case S2C.ERROR: this.store.dispatch({ type: 'toast', msg: m.msg || m.code, kind: 'warn' }); break;
      default: break;
    }
    this._emit(m.t, m);
  }

  /* ---- 切断・再接続 ---- */
  _onClose(sock) {
    if (sock !== this.sock) return;
    this.sock = null;
    this._stopPing();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.rej(new NetError(ERR.CONNECT_FAILED)); }
    this.pending.clear();
    if (this.closing || !this.joined) return;
    this._reconnect();
  }

  async _reconnect() {
    const code = this.code;
    this._conn('reconnecting');
    while (this.retry < BACKOFF.length && !this.closing) {
      await new Promise((r) => setTimeout(r, BACKOFF[this.retry++]));
      if (this.closing) return;
      try {
        await this._connect(code);
        this._conn('online'); this._startPing();
        this.store.dispatch({ type: 'toast', msg: '再接続しました', kind: 'ok' });
        return;
      } catch (e) {
        if (e.code === ERR.ROOM_NOT_FOUND || e.code === ERR.ROOM_FULL || e.code === ERR.IN_PROGRESS) break;
      }
    }
    this._teardown();
    this.store.dispatch({ type: 'room/clear' });
    this._conn('error', 'サーバーとの接続が切れました');
    this._emit('lost', { reason: ERR.CONNECT_FAILED });
  }

  _startPing() {
    this._stopPing();
    const tick = () => this._send({ t: C2S.PING, ts: performance.now() });
    tick();
    this.pingTimer = setInterval(tick, 2000);
  }
  _stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  _closeSock() {
    const s = this.sock;
    this.sock = null;
    if (s) { s.onmessage = s.onclose = s.onerror = null; try { s.close(); } catch (e) { /* ignore */ } }
  }
  _teardown() {
    this.closing = true; this.joined = false; this.code = null; this.rtt = null;
    this._stopPing(); this._closeSock();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.rej(new NetError(ERR.CONNECT_FAILED)); }
    this.pending.clear();
  }

  _conn(status, error = null) {
    this.store.dispatch({ type: 'conn', patch: { status, error, ...(status === 'offline' || status === 'error' ? { ping: null } : {}) } });
  }
  _fail(e) { this._conn('error', e && e.message ? e.message : String(e)); }
}
