import fs from 'node:fs';
import path from 'node:path';

const required = [
  'index.html',
  'css/core.css',
  'css/online.css',
  'js/main.js',
  'js/config.js',
  'shared/protocol.js',
  'shared/rules.js',
  'server/wrangler.jsonc',
  'server/src/index.js',
  'server/src/room-core.js',
  'server/src/room-do.js'
];

let errors = 0;

for (const file of required) {
  if (fs.existsSync(file)) {
    console.log('OK  ', file);
  } else {
    console.log('NG  ', file);
    errors++;
  }
}

const config = fs.readFileSync('server/wrangler.jsonc', 'utf8');

for (const check of [
  '"main": "src/index.js"',
  '"name": "ROOMS"',
  '"class_name": "BsoRoom"',
  '"new_sqlite_classes": ["BsoRoom"]'
]) {
  if (config.includes(check)) {
    console.log('OK  Wrangler:', check);
  } else {
    console.log('NG  Wrangler:', check);
    errors++;
  }
}

console.log('\n' + (errors ? `${errors} 件の問題があります` : '構成チェック合格！'));
process.exit(errors ? 1 : 0);
