/* 実行時設定。サーバー未接続(WS_BASE が空)の間は MockBackend が使われる。
 * 接続先は次のいずれかで差し替え可能:
 *   1) index.html で window.BSO_CONFIG = { API_BASE, WS_BASE } を定義
 *   2) URL クエリ ?api=https://...&ws=wss://... (開発・検証用) */
const q = new URLSearchParams(location.search);
const G = window.BSO_CONFIG || {};
const WS_BASE = (q.get('ws') || G.WS_BASE || '').replace(/\/$/, '');
const API_BASE = (q.get('api') || G.API_BASE || '').replace(/\/$/, '');

export const CONFIG = Object.freeze({
  NAME: 'BLUE SORTIE ONLINE',
  VERSION: '0.1.0-alpha',
  API_BASE,
  WS_BASE,
  USE_MOCK: !WS_BASE,
  MOCK_BOTS: q.get('bots') !== '0',   // モックサーバーに仮想フレンドを出すか
  DEBUG: q.has('debug'),
  SEND_HZ: 15,          // 自機状態の送信頻度
  INTERP_DELAY_MS: 120, // 他機補間の表示遅延
  REQUEST_TIMEOUT_MS: 7000,
  STORAGE: { profile: 'bsOnlineProfile', settings: 'bsOnlineSettings' },
});
