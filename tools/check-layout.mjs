/* リポジトリ構成の検査: 参照先ファイルの欠落・フォルダ構造の崩れ・重複ファイル・wrangler 設定の整合性を確認する。
 * 使い方: node tools/check-layout.mjs [ルートディレクトリ]  (既定はこのスクリプトの親) */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const problems = []; const rel = (p) => path.relative(root, p) || '.';
const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === 'node_modules' || e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
const files = walk(root);

// 1) 「name (1).ext」型の重複(ブラウザのダウンロード/アップロード由来)
for (const f of files) if (/ \(\d+\)\.[^.]+$/.test(f)) problems.push('重複ファイル: ' + rel(f));

// 2) index.html の相対参照 (コメント内は除外)
const indexP = path.join(root, 'index.html');
if (!fs.existsSync(indexP)) problems.push('index.html がありません');
else {
  const html = fs.readFileSync(indexP, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/\b(?:src|href)="([^"#?]+)[^"]*"/g)) {
    if (/^(https?:|data:|\/\/|mailto:)/.test(m[1])) continue;
    if (!fs.existsSync(path.join(root, m[1]))) problems.push(`index.html が参照する ${m[1]} がありません`);
  }
}

// 3) JS の相対 import
for (const f of files.filter((x) => /\.(m?js)$/.test(x))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) problems.push(`${rel(f)} の import "${m[1]}" が解決できません`);
  }
}

// 4) wrangler 設定の整合性 (server/wrangler.jsonc または ./wrangler.jsonc)
const wr = [path.join(root, 'server/wrangler.jsonc'), path.join(root, 'wrangler.jsonc')].find((p) => fs.existsSync(p));
if (!wr) problems.push('wrangler.jsonc がありません');
else {
  const txt = fs.readFileSync(wr, 'utf8'); const j = JSON.parse(txt.replace(/^\s*\/\/.*$/gm, ''));
  const main = path.resolve(path.dirname(wr), j.main || '');
  if (!j.main || !fs.existsSync(main)) problems.push(`${rel(wr)} の main "${j.main}" が存在しません`);
  else {
    const code = fs.readFileSync(main, 'utf8');
    for (const b of (j.durable_objects && j.durable_objects.bindings) || []) {
      if (!new RegExp('export\\s*\\{[^}]*\\b' + b.class_name + '\\b').test(code) && !new RegExp('export\\s+class\\s+' + b.class_name + '\\b').test(code)) problems.push(`main が DO クラス ${b.class_name} を export していません`);
      const migrated = (j.migrations || []).some((m) => [...(m.new_classes || []), ...(m.new_sqlite_classes || [])].includes(b.class_name));
      if (!migrated) problems.push(`DO クラス ${b.class_name} のマイグレーションがありません`);
    }
    if (!(j.durable_objects && j.durable_objects.bindings && j.durable_objects.bindings.some((b) => b.name === 'ROOMS'))) problems.push('ROOMS バインディングがありません');
  }
  if (/YOUR-APP/.test(txt)) console.log('注意: ALLOWED_ORIGINS がまだ仮の値(YOUR-APP.vercel.app)です。デプロイ前に書き換えてください。');
}

if (problems.length) { console.log('NG (' + problems.length + ' 件)'); problems.slice(0, 40).forEach((p) => console.log(' - ' + p)); if (problems.length > 40) console.log(' ...ほか ' + (problems.length - 40) + ' 件'); process.exit(1); }
console.log('OK: 構成に問題はありません (' + files.length + ' ファイル)');
