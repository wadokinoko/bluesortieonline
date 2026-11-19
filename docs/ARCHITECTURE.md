# BLUE SORTIE ONLINE アーキテクチャ

## レイヤー構成

```
 UI (js/ui)  ──dispatch──▶  store (js/state)  ◀──dispatch──  NetClient (js/net/netclient.js)
   │ 操作                       ▲ subscribe                        │ Backend interface
   ▼                            │                                  ▼
 Session (js/game/session.js) ──┴── BSOCore (game-core.js)    MockBackend | CloudflareBackend
   │ snap → RemotePlayers                                          │ WebSocket (JSON)
   └ 自機状態 15Hz 送信 ───────────────────────────────────────────┘
```

| 層 | 役割 | 触ってよいもの |
|---|---|---|
| `shared/` | プロトコル・ルール。DOM/Three.js 非依存。**ブラウザと Workers の両方で import** | 純粋関数・定数のみ |
| `js/state` | 低頻度状態(画面・接続・ルーム・マッチ)。Redux 風の極小ストア | reducer / selector |
| `js/net` | WebSocket の唯一の窓口。再接続(指数バックオフ)・要求/応答・ping | Backend だけ差し替え |
| `js/game` | ゲームコアと対戦の橋渡し。高頻度の機体スナップショットは store に入れず `RemotePlayers` のバッファへ直接流す | |
| `js/ui` | 画面描画。通信は `net` 経由のみ。WebSocket を直接触らない | |

## 画面遷移

`title → menu → lobby → friend → room → game`  (`menu → settings / missions` は分岐)。
`missions`(ソロ訓練)は既存キャンペーン8ミッションをそのまま残した独立導線。

## プロトコル (shared/protocol.js, PROTO = 1)

WebSocket 上の JSON。`{ t, id?, re?, ...payload }`。`id` 付き要求にはサーバーが `re:<id>` で応答。
`state` / `snap` のような高頻度メッセージは `id` なし。`HELLO` の `v` が `PROTO` と異なれば `version_mismatch`。

- C→S: `hello`(`tok` は任意の追加フィールド) `room.leave` `room.ready` `room.settings` `room.kick` `room.start` `match.join` `match.leave` `state` `fire`(追加) `ping` `chat`
- S→C: `welcome` `room.state`(rev 単調増加) `room.start` `snap` `pong` `error` `kick` `chat` `match.end` `hit`(追加) `kill`(追加)
- 機体状態: `[x,y,z,qx,qy,qz,qw,speed,hp,flags]` (`packState` / `unpackState`)

## Cloudflare サーバー (実装済み・`server/`)

```
server/src/index.js      Worker 入口  POST /api/rooms, GET /ws/:code, GET /health, CORS/Origin 検証, 作成APIのレート制限
server/src/room-do.js    Durable Object (1ルーム=1DO)。WebSocket を RoomCore に渡す薄いラッパー。保存は {code, hostId, settings} のみ
server/src/room-core.js  ルームロジック本体(Cloudflare 非依存)。mock-server.js と同じプロトコルを話す
server/wrangler.jsonc    デプロイ設定。手順は docs/DEPLOY.md
```

- **作成**: Worker が `genRoomCode()`(`crypto.getRandomValues`)で採番 → `idFromName(code)` の DO に `/init`。衝突(409)なら最大6回やり直し。作成者の pid を `hostId` として予約。
- **入室**: `hello { v, pid, tok, name, livery }`。`pid` は `[A-Za-z0-9_-]{8,40}`、`v` が `PROTO` と違えば `version_mismatch`。
  - **`tok`(追加フィールド・任意)**: クライアントがページを開いている間だけ持つ秘密。`pid` は全員に配信されるため、再接続の本人確認はこの `tok` で行う(席の pid と tok が一致する接続のみ復帰可)。旧クライアント(tok なし)も接続できるが保護は受けない。
- **再接続**: 切断後 15 秒は席を保持(`connected:false`)。同じ pid+tok で戻れば同じ席に復帰。猶予切れで退室し、ホストなら次のプレイヤーへ移譲。対戦中に戻ったら `match.join` で復帰。
- **ホスト**: 作成者が最初に入室してホスト。退室/猶予切れで、接続中の次のプレイヤーへ移譲。
- **対戦進行**: `room.start` → 3秒カウントダウン → `room.start` メッセージ(matchId/seed/settings/players)。20Hz で `snap`(自分以外の最新状態。更新が無ければ送らない)。
  `timeLimit` + 5秒で自動的に `match.end`。全員が `match.leave` した場合も終了。途中参加は不可(既存メンバーの復帰のみ)。
- **検証・制限**: `state` は10要素・有限数・範囲・クォータニオン長を検証。メッセージは 2048文字まで(超過は切断)・テキストのみ。
  種別ごとのトークンバケット(state 25/s, chat 0.5/s など)。不正・過剰が 10秒で40回を超えると切断(4010)。`hello` が5秒以内に来なければ切断。
- **ping 欄**: `room.state` の `players[].ping` はサーバー側では計測しないため `null`(自分の ping はクライアントが `ping/pong` で計測し表示)。
- **close コード**: 1000 / 4000番台のみ(4000 拒否 / 4001 キック / 4002 置換 / 4003 ルーム終了 / 4008 hello遅延 / 4009 巨大 / 4010 違反多発 / 4011 非テキスト)。
- **命中判定(サーバー権威・`server/src/combat.js`)**: クライアントは `fire { k:'g'|'m', tgt?:pid }` で「撃った」ことだけを伝える。
  弾・ミサイルの位置と命中はサーバーが送信者の最新 `state` から計算(座標・威力は申告できない)。命中は `hit { to, by, k, dmg, hp }`、撃墜は `kill { to, by, k }` を対戦中の全員へ配信。
  `snap` に載る相手の `hp` / dead フラグはサーバー確定値で上書き(クライアント申告の hp は信用しない)。`match.end.results` は `[{id, name, kills, deaths}]`。
  暫定値(`COMBAT`): HP100、機銃3/発(連射上限25Hz)、ミサイル45/発・14発(8秒で1発回復)・誘導旋回2.6rad/s。弾は線分判定で高速でもすり抜けない。
  **簡略化**: 地形との衝突なし / ラグ補正なし / アップグレード(装甲・ミサイル数)は無視 / 自機の墜落(地面衝突)は state の dead フラグで自己申告(戦果にならない)。
- **ロックオン(クライアント)**: `RemotePlayers.targets()` が相手機をロック対象(`{remote, id, pos, aim, alive}`)として提供し、コアは `BSOHooks.remoteTargets()` 経由で参照する(対戦外は常に空=ソロ無影響)。
  `pos`=補間後の表示位置(ロック判定・HUD)、`aim`=最新の同期位置(ミサイル誘導)。退出・切断・撃墜(`alive=false`)で自動的にロック/誘導が外れる。

テスト: `npm test`(モック → ルームロジック → Worker/DO → 実クライアント結合)。偽の Cloudflare 環境で動くため、本物の workerd での検証は docs/DEPLOY.md の「未検証事項」を参照。

## モックサーバー

`js/net/mock-server.js` は上記プロトコルをブラウザ内で再現し、`tools/test-net.mjs` が同じ実装を Node で検証します。
本物の DO を作る際は、このテストの期待値をそのまま E2E の仕様として流用できます。
