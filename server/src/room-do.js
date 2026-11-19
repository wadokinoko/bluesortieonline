/* BsoRoom - 1ルーム = 1 Durable Object。ロジックは RoomCore に任せ、ここは Cloudflare との接着だけを行う。
 *
 *   POST https://room/init   (Worker からのみ。ルームを確保する。既に存在すれば 409)
 *   GET  /ws/:code           WebSocket Upgrade → RoomCore.accept()
 *
 * 保存するのは { code, hostId(ランダムID), settings, createdAt } のみ。プレイヤー名・IP等は保存しない。
 * 対戦中の状態(位置・ready等)はメモリのみで、DO が終了すれば消える。
 * Hibernation API は使わない(対戦中は 20Hz の snap と永続的なタイマーが必要なため)。 */
import { RoomCore } from './room-core.js';
import { isRoomCode, defaultSettings, sanitizeSettings } from '../../shared/rules.js';

const IDLE_MS = 10 * 60 * 1000; // 作成されたまま誰も入室しない場合に破棄するまで
const PID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export class BsoRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.core = new RoomCore({ meta: null });
    this.alarmSet = false;
    ctx.blockConcurrencyWhile(async () => {
      const meta = await ctx.storage.get('meta');
      this._boot(meta || null);
      this.alarmSet = !!meta;
    });
  }

  _boot(meta) {
    this.core = new RoomCore({
      meta,
      hooks: { onEmpty: () => this._onEmpty(), onActive: () => this._onActive() },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') return this._init(request);
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') return this._upgrade();
    return new Response('Not found', { status: 404 });
  }

  async _init(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (this.core.alive) return json({ error: 'exists' }, 409);
    let b; try { b = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
    if (!b || !isRoomCode(b.code) || typeof b.hostId !== 'string' || !PID_RE.test(b.hostId)) return json({ error: 'bad_request' }, 400);
    const meta = { code: b.code, hostId: b.hostId, settings: sanitizeSettings(b.settings, defaultSettings(), 0), createdAt: Date.now() };
    await this.ctx.storage.put('meta', meta);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    this.alarmSet = true;
    this._boot(meta);
    return json({ ok: true });
  }

  _upgrade() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const conn = this.core.accept({
      send: (s) => server.send(s),
      close: (c, r) => { try { server.close(c, r); } catch (e) { /* 既に閉じている */ } },
    });
    const guard = (fn) => (ev) => {
      try { fn(ev); } catch (e) { // 1接続の不具合でルーム(DO)全体を巻き込まない
        console.error('room handler error', e && e.message);
        try { server.close(4000, 'internal'); } catch (e2) { /* ignore */ }
        try { this.core.closed(conn); } catch (e3) { /* ignore */ }
      }
    };
    server.addEventListener('message', guard((ev) => this.core.receive(conn, ev.data)));
    server.addEventListener('close', guard(() => this.core.closed(conn)));
    server.addEventListener('error', guard(() => this.core.closed(conn)));
    return new Response(null, { status: 101, webSocket: client });
  }

  _onActive() {
    if (!this.alarmSet) return;
    this.alarmSet = false;
    this.ctx.storage.deleteAlarm().catch(() => {});
  }
  _onEmpty() {
    this.alarmSet = false;
    this.ctx.storage.deleteAlarm().catch(() => {});
    this.ctx.storage.deleteAll().catch(() => {});
  }
  /** 誰も入室しないまま放置されたルームを破棄 */
  async alarm() {
    if (this.core.alive && this.core.connCount === 0) this.core.close();
  }
}
