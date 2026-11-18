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

- C→S: `hello` `room.leave` `room.ready` `room.settings` `room.kick` `room.start` `match.join` `match.leave` `state` `ping` `chat`
- S→C: `welcome` `room.state`(rev 単調増加) `room.start` `snap` `pong` `error` `kick` `chat` `match.end`
- 機体状態: `[x,y,z,qx,qy,qz,qw,speed,hp,flags]` (`packState` / `unpackState`)

## Cloudflare 側の想定 (次フェーズ)

```
POST {API_BASE}/api/rooms   { pid, name, settings } → { code }
   Worker が genRoomCode() で採番し、env.ROOM.idFromName(code) の DO を確保。作成者 pid をホストとして登録。
GET  {WS_BASE}/ws/{code}    Upgrade: websocket → 同コードの DO へ転送
```

Durable Object (1ルーム = 1 DO) の責務:

1. `hello` 検証(`sanitizeName` / `sanitizeLivery` / バージョン / 満員 / 対戦中)
2. ルーム状態 `RoomState { code, rev, hostId, status:'lobby'|'countdown'|'inmatch', settings, players[] }` の保持と `rev++` での配信
3. 設定変更は **必ず `sanitizeSettings` を通す**(ホストのみ)。開始条件はクライアントの `canStart` と同じ判定をサーバーでも行う
4. `state` を `unpackState` で検証し、約20Hzで `snap` として束ねて配信(WebSocket Hibernation を使う場合は `serializeAttachment` に pid を保存)
5. 切断時は猶予時間つきで `connected:false`、ホスト不在なら委譲
6. 全員退出で DO のストレージを破棄

対戦ルール(命中・撃墜・スコア)は **サーバー権威**にする前提。現状の Session は位置同期のみで、
判定追加の入口は `Session._tick`(送信)と `NetClient.on('snap')`(受信)。

## モックサーバー

`js/net/mock-server.js` は上記プロトコルをブラウザ内で再現し、`tools/test-net.mjs` が同じ実装を Node で検証します。
本物の DO を作る際は、このテストの期待値をそのまま E2E の仕様として流用できます。
