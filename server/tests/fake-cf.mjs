/* Cloudflare 実行環境の偽物 (workerd がこの環境では使えないため)。
 * 再現しているのは Worker/DO が使う最小限: WebSocketPair / status 101 の Response / DO の storage・alarm / 名前空間 stub。
 * 本物の workerd との差異は docs/DEPLOY.md の「未検証事項」を参照。 */
import { BsoRoom } from '../src/room-do.js';

export class Endpoint {
  constructor() { this.peer = null; this.readyState = 1; this.ls = { message: [], close: [], error: [] }; this.onopen = this.onmessage = this.onclose = this.onerror = null; }
  accept() {}
  addEventListener(t, f) { (this.ls[t] || (this.ls[t] = [])).push(f); }
  send(data) { if (this.readyState !== 1) throw new Error('WebSocket is closed'); const p = this.peer; setTimeout(() => p._deliver('message', { data }), 0); }
  close(code = 1000, reason = '') {
    if (!(code === 1000 || (code >= 3000 && code <= 4999))) throw new Error('Invalid close code ' + code); // 本物と同じ制約
    if (this.readyState >= 2) return; this.readyState = 3; const p = this.peer;
    setTimeout(() => { this._deliver('close', { code, reason }); p.readyState = 3; p._deliver('close', { code, reason }); }, 0);
  }
  _deliver(type, ev) { if (this.readyState === 3 && type === 'message') return; (this.ls[type] || []).forEach((f) => f(ev)); const h = this['on' + type]; if (h) h(ev); }
}

export function installCloudflareGlobals() {
  globalThis.WebSocketPair = class { constructor() { const a = new Endpoint(), b = new Endpoint(); a.peer = b; b.peer = a; this[0] = a; this[1] = b; } };
  const Real = globalThis.Response;
  if (!Real.__bsoPatched) {
    function Patched(body, init) {
      if (init && init.status === 101) return { status: 101, ok: false, headers: new Headers(), webSocket: init.webSocket }; // Node の Response は 101 を作れない
      return new Real(body, init);
    }
    Patched.prototype = Real.prototype; Patched.__bsoPatched = true;
    globalThis.Response = Patched;
  }
}

export class FakeStorage {
  constructor() { this.m = new Map(); this.alarm = null; }
  async get(k) { return this.m.get(k); }
  async put(k, v) { this.m.set(k, JSON.parse(JSON.stringify(v))); }
  async delete(k) { return this.m.delete(k); }
  async deleteAll() { this.m.clear(); }
  async setAlarm(t) { this.alarm = t; }
  async deleteAlarm() { this.alarm = null; }
  async getAlarm() { return this.alarm; }
}

/** DO 名前空間の偽物。evict(name) で「DO がメモリから落ちた」状態(storage は残る)を再現できる。 */
export class FakeNamespace {
  constructor(env = {}) { this.env = env; this.objs = new Map(); this.stores = new Map(); this.initHook = null; }
  idFromName(n) { return n; }
  _obj(name) {
    let o = this.objs.get(name);
    if (!o) {
      if (!this.stores.has(name)) this.stores.set(name, new FakeStorage());
      const ctx = { storage: this.stores.get(name), blockConcurrencyWhile: (fn) => (ctx.ready = fn()) };
      o = { ctx, inst: new BsoRoom(ctx, this.env) }; this.objs.set(name, o);
    }
    return o;
  }
  get(id) {
    return { fetch: async (req, init) => {
      const request = typeof req === 'string' ? new Request(req, init) : req;
      if (this.initHook && new URL(request.url).pathname === '/init') { const r = this.initHook(id, request); if (r) return r; }
      const o = this._obj(id); await o.ctx.ready; return o.inst.fetch(request);
    } };
  }
  evict(name) { this.objs.delete(name); }
  storage(name) { return this.stores.get(name); }
  instance(name) { return this._obj(name).inst; }
}

/** ブラウザの WebSocket 互換: Worker の fetch に Upgrade を投げて、返ってきた webSocket に接続する */
export function makeWebSocketClass(workerFetch, headers = {}) {
  return class FakeWebSocket {
    constructor(url) {
      this.readyState = 0; this.onopen = this.onmessage = this.onclose = this.onerror = null; this.url = url;
      const u = url.replace(/^ws/, 'http');
      Promise.resolve(workerFetch(new Request(u, { headers: { upgrade: 'websocket', ...headers } }))).then((res) => {
        if (res.status !== 101 || !res.webSocket) { this.readyState = 3; this.onerror && this.onerror({}); this.onclose && this.onclose({ code: 1006 }); return; }
        const ep = (this.ep = res.webSocket);
        ep.onmessage = (e) => this.onmessage && this.onmessage(e);
        ep.onclose = (e) => { this.readyState = 3; this.onclose && this.onclose(e); };
        this.readyState = 1; this.onopen && this.onopen({});
      }, () => { this.readyState = 3; this.onerror && this.onerror({}); this.onclose && this.onclose({ code: 1006 }); });
    }
    send(d) { if (this.readyState !== 1) throw new Error('not open'); this.ep.send(d); }
    close(c = 1000) { if (this.ep) this.ep.close(c); this.readyState = 3; }
  };
}
