/* ブラウザ内で完結するモックバックエンド。通信サーバーが無くても UI・状態遷移・ゲーム接続を検証できる。 */
import { LocalRoomServer } from './mock-server.js';

export class MockBackend {
  constructor(opts = {}) { this.server = new LocalRoomServer(opts); }
  async createRoom(args) { await new Promise((r) => setTimeout(r, 120)); return this.server.createRoom(args); }
  openSocket(code) { return this.server.connect(code); }
}
