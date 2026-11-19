/* Cloudflare Workers + Durable Objects 用バックエンド (Worker/DO 側は server/ に実装済み。docs/DEPLOY.md 参照)。
 *
 * 想定する Worker のルート:
 *   POST {API_BASE}/api/rooms        body: { pid, name, settings } -> 200 { code }
 *                                     (Worker がコードを採番し、Durable Object を idFromName(code) で確保。
 *                                      作成者 pid をホストとして DO に登録)
 *   GET  {WS_BASE}/ws/{code}         Upgrade: websocket -> 該当コードの Durable Object へ転送
 *
 * DO 側は shared/protocol.js / shared/rules.js をそのまま import して検証すること。 */
import { NetError } from './errors.js';
import { ERR } from '../../shared/protocol.js';

export class CloudflareBackend {
  constructor({ apiBase, wsBase }) {
    this.apiBase = apiBase;
    this.wsBase = wsBase;
  }

  async createRoom({ pid, name, settings }) {
    let res;
    try {
      res = await fetch(this.apiBase + '/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid, name, settings }),
      });
    } catch (e) { throw new NetError(ERR.CONNECT_FAILED); }
    if (!res.ok) throw new NetError(ERR.CONNECT_FAILED, 'ルームを作成できませんでした (' + res.status + ')');
    const j = await res.json();
    if (!j || typeof j.code !== 'string') throw new NetError(ERR.BAD_REQUEST);
    return { code: j.code };
  }

  openSocket(code) {
    return new WebSocket(this.wsBase + '/ws/' + encodeURIComponent(code));
  }
}
