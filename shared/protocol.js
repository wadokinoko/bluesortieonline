/* BLUE SORTIE ONLINE - 通信プロトコル定義 (純粋なES module / ブラウザ・Workers共用)
 *
 * 形式: WebSocket 上の JSON テキスト。 { t: 種別, id?: 要求ID, re?: 応答先要求ID, ...payload }
 *   - クライアント→サーバーで id を付けた要求には、サーバーは re:<同じid> を付けて応答する。
 *   - 高頻度メッセージ(state / snap)は id を付けない。
 * 詳細は docs/ARCHITECTURE.md を参照。 */

export const PROTO = 1;

export const C2S = Object.freeze({
  HELLO: 'hello',            // 入室要求 { v, pid, name, livery }  → welcome | error
  LEAVE: 'room.leave',       // 退室
  READY: 'room.ready',       // { ready:boolean }
  SETTINGS: 'room.settings', // { patch } ホストのみ
  KICK: 'room.kick',         // { pid } ホストのみ
  START: 'room.start',       // ホストのみ。全員Readyで開始カウントダウン
  MATCH_JOIN: 'match.join',  // 進行中の対戦へ(再)参加
  MATCH_LEAVE: 'match.leave',// 対戦から退出(ルームには残る)
  STATE: 'state',            // { s: packState配列 } 自機状態 (約15Hz)
  FIRE: 'fire',              // { k:'g'|'m', tgt?:pid } 発射の通知(追加)。弾道・命中はサーバーが計算する
  PING: 'ping',              // { ts }
  CHAT: 'chat',              // { text }
});

export const S2C = Object.freeze({
  WELCOME: 'welcome',        // { you, room, serverTime }
  ROOM: 'room.state',        // ルーム全状態 (rev単調増加)
  START: 'room.start',       // { matchId, seed, settings, players:[pid...], serverTime }
  SNAP: 'snap',              // { tick, ts, players:{ pid: packState配列 } } (約20Hz)
  PONG: 'pong',              // { ts }
  ERROR: 'error',            // { code, msg }
  KICK: 'kick',              // { reason }
  CHAT: 'chat',              // { from, name, text }
  MATCH_END: 'match.end',    // { results }
  HIT: 'hit',                // { to, by, k:'g'|'m', dmg, hp } 命中(追加)。hp はサーバーが確定した残りHP
  KILL: 'kill',              // { to, by, k } 撃墜(追加)
});

export const ERR = Object.freeze({
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_FULL: 'room_full',
  IN_PROGRESS: 'in_progress',
  VERSION: 'version_mismatch',
  BAD_CODE: 'bad_code',
  NOT_HOST: 'not_host',
  NOT_READY: 'not_ready',
  NEED_PLAYERS: 'need_players',
  TIMEOUT: 'timeout',
  CONNECT_FAILED: 'connect_failed',
  KICKED: 'kicked',
  BAD_REQUEST: 'bad_request',
});

export const ERR_TEXT = Object.freeze({
  room_not_found: 'ルームが見つかりません。コードを確認してください。',
  room_full: 'ルームが満員です。',
  in_progress: 'このルームは対戦中です。',
  version_mismatch: 'ゲームのバージョンが異なります。ページを再読み込みしてください。',
  bad_code: 'ルームコードは6文字の英数字です。',
  not_host: 'ホストのみが実行できます。',
  not_ready: '全員の準備が完了していません。',
  need_players: '開始には2人以上必要です。',
  timeout: 'サーバーの応答がありません。',
  connect_failed: 'サーバーに接続できません。',
  kicked: 'ホストによってルームから退出させられました。',
  bad_request: '不正なリクエストです。',
});
