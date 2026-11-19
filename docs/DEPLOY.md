# Cloudflare サーバーのデプロイ手順

構成: **Vercel**(静的フロントエンド) ⇄ **Cloudflare Worker**(`/api/rooms`, `/ws/:code`) ⇄ **Durable Object**(1ルーム = 1 DO)

## 1. 事前準備
- Cloudflare アカウント(無料プランで可。DO は SQLite バックエンドのクラスとして宣言済み)
- Node.js 18 以上

## 2. ローカルで動かす
```bash
cd server
npm install                 # wrangler を導入
npm run dev                 # http://localhost:8787 で Worker + DO が起動
```
別ターミナルでフロントを開く(ルートで `npm run dev` → http://localhost:3000):
```
http://localhost:3000/?api=http://localhost:8787&ws=ws://localhost:8787
```
`ws=` を付けるとモックではなく実サーバーに接続します(右上のピルから `MOCK` 表示が消えます)。

## 3. 本番デプロイ
1. `server/wrangler.jsonc` の `ALLOWED_ORIGINS` を自分のフロントのオリジンに書き換える
   (例 `"https://bluesortie-online.vercel.app"`。複数はカンマ区切り。Vercel のプレビューも許可するなら `https://*.vercel.app` 形式も可だが、他人の Vercel アプリも通ることに注意)
2. ログインしてデプロイ
   ```bash
   cd server
   npx wrangler login
   npx wrangler deploy
   ```
   出力される URL(例 `https://bso-api.<account>.workers.dev`)を控える。
3. 動作確認
   ```bash
   curl https://bso-api.<account>.workers.dev/health          # {"ok":true,"proto":1}
   curl -X POST https://bso-api.<account>.workers.dev/api/rooms \
        -H 'content-type: application/json' -d '{"pid":"pilot-test0001"}'   # {"code":"XXXXXX"}
   ```
4. フロントに接続先を設定: `index.html` のコメントアウトされた `window.BSO_CONFIG` を有効にして URL を入れる
   ```html
   <script>window.BSO_CONFIG={API_BASE:'https://bso-api.<account>.workers.dev',WS_BASE:'wss://bso-api.<account>.workers.dev'};</script>
   ```
5. GitHub に push → Vercel が自動で再デプロイ(`.vercelignore` で `server/` `tools/` `docs/` は配信対象外)。

## 4. 運用
- ログ: `cd server && npx wrangler tail`(プレイヤー名・IP・入力内容はログに出さない設計)
- 作成APIの本格的な濫用対策として、Cloudflare ダッシュボードの Rate limiting rules で `POST /api/rooms` に制限を併用するのを推奨
  (コード内の制限は isolate 単位の簡易版)。Workers Rate Limiting バインディングを `CREATE_LIMITER` として追加すれば自動で併用される。
- 無料枠には Workers / Durable Objects のリクエスト・実行時間の上限があります。最新の数値は Cloudflare のドキュメントで確認してください。
  対戦中の DO は WebSocket を保持し続けるため、接続時間ぶんの課金対象になります(Hibernation は使っていません)。

## 5. 設定値の一覧
| 項目 | 場所 | 既定 |
|---|---|---|
| 許可オリジン | `wrangler.jsonc` `vars.ALLOWED_ORIGINS` | localhost:3000 と YOUR-APP.vercel.app(**要変更**) |
| 切断後の復帰猶予 | `server/src/room-core.js` `LIMITS.GRACE_MS` | 15秒 |
| 1メッセージ最大 | 同 `MAX_MSG_CHARS` | 2048文字 |
| snap 配信間隔 | 同 `SNAP_MS` | 50ms (20Hz) |
| 未使用ルームの破棄 | `server/src/room-do.js` `IDLE_MS` | 10分 |
| 作成API制限 | `server/src/index.js` `CREATE_PER_MIN` | 1IPあたり10回/分(isolate内) |

## 6. 未検証事項(正直なメモ)
この環境はネットワークに出られず `wrangler` / `workerd` を導入できなかったため、**実際の Cloudflare 上では一度も動かしていません**。

検証済み(Node 上):
- ルームのロジック全般(`server/src/room-core.js`)を、偽の時計で 31 件のテスト
- Worker の入口と DO の接着部分(`index.js` / `room-do.js`)を、偽の Cloudflare 実行環境(`server/test/fake-cf.mjs`)で 15 件のテスト
- 実クライアント(`NetClient` + `CloudflareBackend`)から Worker + DO を通しで操作する結合テスト(`server/test/e2e-net.mjs`)

未検証(デプロイ後に確認してください):
- `wrangler.jsonc` が `wrangler` に受理されること、`compatibility_date`・マイグレーションの書式
- 本物の `workerd` 上での WebSocket(`WebSocketPair` / `accept()`)の挙動と、`close` コードの制約(4000番台のみ使用)
- 実インターネット越しの遅延・切断・複数ブラウザでの実プレイ
- ゲームコア(Three.js)とサーバーを組み合わせた実際の飛行同期(この環境では Three.js を読み込めず、UI までをスタブで確認)
- `CREATE_LIMITER`(Workers Rate Limiting バインディング)は任意機能で未検証
