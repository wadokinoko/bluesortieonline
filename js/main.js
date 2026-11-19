/* BLUE SORTIE ONLINE エントリポイント: 依存オブジェクトを組み立てて配線するだけ。
 *   store(状態) ← NetClient(通信) ← Backend(Mock | Cloudflare)
 *   Session(対戦とゲームコアの橋渡し) ← BSOCore(Blue Sortie 4 由来のゲームコア)
 *   UI(画面) は上記すべてを受け取って描画する */
import { CONFIG } from './config.js';
import { loadProfile, loadSettings } from './profile.js';
import { createStore } from './state/store.js';
import { initialState, reducer } from './state/app-state.js';
import { NetClient } from './net/netclient.js';
import { MockBackend } from './net/backend-mock.js';
import { CloudflareBackend } from './net/backend-cloudflare.js';
import { Session } from './game/session.js';
import { initTouch } from './game/touch.js';
import { initUI } from './ui/ui.js';

function boot() {
  const core = window.BSOCore;
  if (!core) return; // Three.js / WebGL が使えない場合。メッセージは BSO_fatal が表示済み

  const store = createStore(reducer, initialState(loadProfile(), loadSettings(), CONFIG.USE_MOCK));
  const backend = CONFIG.USE_MOCK
    ? new MockBackend({ bots: CONFIG.MOCK_BOTS })
    : new CloudflareBackend({ apiBase: CONFIG.API_BASE, wsBase: CONFIG.WS_BASE });
  const net = new NetClient({ backend, store });
  const session = new Session({ core, store, net });
  session.attach();
  const touch = initTouch({ core, stage: document.getElementById('stage'), getSetting: () => store.get().settings.touch });
  initUI({ store, net, core, session, touch });

  if (CONFIG.DEBUG) window.BSO = { store, net, core, session, backend, CONFIG };
}
boot();
