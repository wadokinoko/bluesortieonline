/* テスト用: 偽の時計と偽ソケット */
export class FakeClock {
  constructor() { this.t = 1_700_000_000_000; this.q = []; this.id = 0; }
  now() { return this.t; }
  setTimeout(f, ms) { const h = ++this.id; this.q.push({ h, at: this.t + ms, f, iv: 0 }); return h; }
  setInterval(f, ms) { const h = ++this.id; this.q.push({ h, at: this.t + ms, f, iv: ms }); return h; }
  clearTimeout(h) { this.q = this.q.filter((x) => x.h !== h); }
  clearInterval(h) { this.clearTimeout(h); }
  random() { return 0.37; }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const next = this.q.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.h - b.h)[0];
      if (!next) break;
      this.t = next.at;
      if (next.iv) next.at += next.iv; else this.q = this.q.filter((x) => x !== next);
      next.f();
    }
    this.t = end;
  }
}

export const META = (over = {}) => ({ code: 'ABCDEF', hostId: 'host-0001', settings: { maxPlayers: 4 }, ...over });
export const PID = (n) => 'pilot-' + String(n).padStart(4, '0'); // 10文字

/* コアに接続する偽クライアント */
export function makeClient(core, pid, { tok = 'tok-' + pid, name = 'P' + pid.slice(-4), v = 1, hello = true } = {}) {
  const c = { pid, tok, msgs: [], closeCode: null, conn: null, nextId: 0 };
  const sock = { send: (s) => c.msgs.push(JSON.parse(s)), close: (code) => { if (c.closeCode == null) c.closeCode = code; } };
  c.conn = core.accept(sock);
  c.send = (o) => core.receive(c.conn, typeof o === 'string' ? o : JSON.stringify(o));
  c.req = (o) => { const id = ++c.nextId; c.send({ ...o, id }); return id; };
  c.of = (t) => c.msgs.filter((m) => m.t === t);
  c.last = (t) => c.of(t).at(-1);
  c.drop = () => core.closed(c.conn);
  c.hello = (extra = {}) => c.req({ t: 'hello', v, pid, tok, name, livery: 'solaris', ...extra });
  if (hello) c.hello();
  return c;
}
