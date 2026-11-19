# BLUE SORTIE ONLINE

Blue Sortie 4 をベースにしたオンライン専用版。Blue Sortie 3 / 4 の元ファイルは一切変更していません。
(Blue Sortie 4 は 3 の上位互換: フレア・敵ミサイル・敵フレアが追加されている)

## 起動 (ローカル)

```bash
npm run dev          # = npx serve .   → http://localhost:3000
```

- 通信サーバー未接続の間は **モックサーバー**(ブラウザ内)で動作します。デモルーム `ALPHA2` に入り、準備完了で出撃まで確認できます。
- `?debug` を付けると `window.BSO` (store / net / core / session) をコンソールから触れます。
- `?bots=0` で仮想フレンドを無効化。
- `?room=ABC234` を付けて開くと、PRESS START 後に自動でそのルームへ参加します(招待リンク)。

## オンラインサーバー (Cloudflare Workers + Durable Objects)

`server/` に実装済み。ローカル起動・デプロイ手順・未検証事項は **`docs/DEPLOY.md`**、設計は `docs/ARCHITECTURE.md`。

```bash
cd server && npm install && npm run dev      # → http://localhost:8787
# フロント: http://localhost:3000/?api=http://localhost:8787&ws=ws://localhost:8787
```

## サーバーを接続するとき

`index.html` のコメントアウトされた `window.BSO_CONFIG = { API_BASE, WS_BASE }` を有効にする
(または `?api=https://...&ws=wss://...`)。`WS_BASE` が空でなくなった時点で自動的に
`CloudflareBackend` に切り替わります。Worker / Durable Object 側の仕様は `docs/ARCHITECTURE.md`。

## テスト

```bash
npm test             # モック通信 → ルームロジック → Worker/DO → 実クライアント結合 (すべて Node 上)
npm run test:mock    # 既存のモック通信テストのみ
npm run test:layout  # ファイル構成・import・wrangler 設定の整合性チェック
```

## GitHub への置き方(重要)

GitHub の Web 画面で「ファイルを選択してアップロード」すると**フォルダ構造が失われます**(全ファイルがルート直下に平置きされ、動かなくなる)。
**フォルダごと**ドラッグするか、`git push` で上げてください。`.gitignore` / `.vercelignore` はドット始まりのため、Web アップロードでは見落としやすいので注意。

## デプロイ

静的ファイルのみ。Vercel に GitHub リポジトリを接続するだけで公開できます (`vercel.json` 同梱)。
Three.js は CDN (cdnjs r128) から読み込みます。

## ゲームコアについて

`js/game/game-core.js` は Blue Sortie 4 の `<script>` を `tools/build-core.py` で切り出し、
最小限のパッチ(`/*[BSO]*/` で検索可)を当てたものです。以後は直接編集して構いません。
**`build-core.py` を再実行すると game-core.js は上書きされます。**
