/* UI - 画面遷移・描画・イベント配線。状態は store、通信は net、ゲームは core/session 経由でのみ触る。
 *
 *  画面: title → menu → lobby → friend → room → (game)    / menu → settings, missions, hangar
 *  ゲームコアの内部レイヤー(brief/pause/end/hangar)は BSOHooks.onLayers で連動する。 */
import { CONFIG } from '../config.js';
import { $, h, clear, copyText } from './dom.js';
import {
  MODES, MAPS, TODS, PLAYER_LIMITS, TIME_LIMITS, LIVERIES, liveryOf, defaultSettings, sanitizeName, normalizeCode, isRoomCode,
} from '../../shared/rules.js';
import { DEMO_CODE } from '../net/mock-server.js';
import { isHost, selfPlayer, canStart } from '../state/app-state.js';
import { saveProfile, saveSettings } from '../profile.js';

const SCREENS = ['title', 'menu', 'lobby', 'friend', 'room', 'settings', 'missions'];
const BACK = { friend: 'lobby', lobby: 'menu', settings: 'menu', missions: 'menu', menu: 'title' };
const CONN_LABEL = { offline: 'OFFLINE', connecting: 'CONNECTING…', online: 'ONLINE', reconnecting: 'RECONNECTING…', error: 'ERROR' };
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

export function initUI({ store, net, core, session, touch }) {
  const OH = window.BSOHooks;
  let cur = null, last = 'title', busy = false, bdKey = '', bdTimer = null, cdTimer = null, toastTimer = null, lastToast = 0;
  let lastRoom = null, lastMatch = false, deepDone = false;

  const jetIco = (c) => h('i', { class: 'jet-ico', style: `--c1:${hex(c[0])};--c2:${hex(c[1])};--c3:${hex(c[2])}` });
  const toast = (msg, kind) => store.dispatch({ type: 'toast', msg, kind });

  /* ================= ルーター ================= */
  function show(name) {
    last = name; cur = name;
    for (const s of SCREENS) $('scr-' + s).hidden = s !== name;
    store.dispatch({ type: 'nav', screen: name });
    touch.setVisible(false);
    if (name === 'settings') renderSettings();
    if (name === 'friend') { $('joinErr').textContent = ''; }
    applyBackdrop(name);
    lastRoom = null; render(store.get());
    const f = $('scr-' + name).querySelector('.mbtn,.mode:not([disabled]),.btn,input'); // キーボード/スクリーンリーダー用の初期フォーカス
    if (f && name !== 'title' && name !== 'friend') f.focus({ preventScroll: true });
  }
  function hideAll() {
    cur = null;
    for (const s of SCREENS) $('scr-' + s).hidden = true;
    clearInterval(cdTimer); cdTimer = null;
    store.dispatch({ type: 'nav', screen: 'game' });
  }

  /* 背景の3Dシーン: タイトル/メニューは夕景、ルームでは設定中のマップ・時間帯をプレビュー */
  function applyBackdrop(name) {
    if (name === 'missions') { bdKey = ''; return; }
    let o = { tod: 'dusk', bio: 'isles' };
    const r = store.get().room;
    if (name === 'room' && r) o = { tod: r.settings.tod, bio: r.settings.map };
    const key = o.tod + '/' + o.bio;
    if (key === bdKey) return;
    bdKey = key;
    clearTimeout(bdTimer);
    bdTimer = setTimeout(() => core.setBackdrop(o), name === 'room' ? 250 : 0);
  }

  /* ================= 描画 ================= */
  function render(s) {
    renderPcards(s); renderConn(s);
    if (cur === 'room') renderRoom(s);
    if (cur === 'lobby') renderNet(s);
    if (s.toast && s.toast.id !== lastToast) {
      lastToast = s.toast.id;
      const el = $('toast'); el.textContent = s.toast.msg; el.className = 'toast ' + s.toast.kind; el.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
    }
  }

  const prow = (label, val) => h('div', { class: 'pc-row' }, h('span', null, label), h('b', null, val));
  function renderPcards(s) {
    const p = s.profile, L = liveryOf(p.livery), cr = core.getHG().cr;
    const key = [p.name, p.livery, cr, p.stats.sorties, s.conn.status].join('|');
    document.querySelectorAll('[data-pcard]').forEach((el) => {
      if (el.dataset.k === key) return;
      el.dataset.k = key; clear(el);
      el.append(
        h('p', { class: 'tag' }, 'Pilot'),
        h('h3', null, p.name),
        prow('PILOT ID', '#' + p.id.slice(-6).toUpperCase()),
        h('div', { class: 'pc-row' }, h('span', null, '機体塗装'), h('div', { class: 'pc-livery' }, jetIco(L.c), h('b', null, L.nm))),
        prow('CREDITS', cr + ' CR'),
        prow('出撃回数', p.stats.sorties || 0),
        prow('ステータス', CONN_LABEL[s.conn.status]),
        h('button', { class: 'btn alt sm', type: 'button', onclick: () => show('settings') }, 'プロフィール編集'),
      );
    });
  }
  function renderConn(s) {
    const c = s.conn;
    document.querySelectorAll('[data-conn]').forEach((el) => {
      el.dataset.status = c.status; clear(el);
      el.append(CONN_LABEL[c.status] + (c.ping != null ? ' ' + c.ping + 'ms' : ''), c.mock ? h('em', null, 'MOCK') : null);
    });
  }
  function renderNet(s) {
    const dl = $('netInfo'); clear(dl);
    const rows = [
      ['SERVER', CONFIG.USE_MOCK ? 'LOCAL MOCK' : new URL(CONFIG.WS_BASE).host],
      ['STATUS', CONN_LABEL[s.conn.status]],
      ['PING', s.conn.ping != null ? s.conn.ping + ' ms' : '—'],
      ['VERSION', 'v' + CONFIG.VERSION],
    ];
    rows.forEach(([k, v]) => dl.append(h('dt', null, k), h('dd', null, v)));
    $('netNote').textContent = CONFIG.USE_MOCK
      ? '通信サーバー未接続のため、ブラウザ内のモックサーバーで動作しています。ルームの作成・参加・準備・出撃の流れを確認できます。'
      : '';
  }

  /* ----- ルーム ----- */
  function fieldset(box, onChange) {
    const defs = [
      ['mode', 'モード', MODES.map((m) => [m.id, m.nm])], ['map', 'マップ', MAPS.map((m) => [m.id, m.nm])], ['tod', '時間帯', TODS.map((m) => [m.id, m.nm])],
      ['maxPlayers', '最大人数', PLAYER_LIMITS.map((n) => [n, n + '人'])], ['timeLimit', '制限時間', TIME_LIMITS.map((t) => [t, t / 60 + '分'])],
    ];
    const sels = {};
    const get = () => ({ mode: sels.mode.value, map: sels.map.value, tod: sels.tod.value, maxPlayers: +sels.maxPlayers.value, timeLimit: +sels.timeLimit.value });
    for (const [k, label, opts] of defs) {
      const sel = h('select', { 'aria-label': label }, opts.map(([v, l]) => h('option', { value: String(v) }, l)));
      sel.addEventListener('change', () => onChange && onChange(get()));
      sels[k] = sel; box.append(h('label', { class: 'field' }, h('span', null, label), sel));
    }
    return {
      get,
      set(v) { for (const k in sels) if (v[k] != null && sels[k].value !== String(v[k])) sels[k].value = String(v[k]); },
      disable(b) { for (const k in sels) sels[k].disabled = b; },
    };
  }
  const createForm = fieldset($('createFields'));
  createForm.set(defaultSettings());
  const roomForm = fieldset($('roomFields'), (v) => { if (isHost(store.get())) net.updateSettings(v); });

  function updateCount() {
    const r = store.get().room;
    if (!r || r.status !== 'countdown' || !r.startAt) return;
    $('countNum').textContent = Math.max(0, Math.ceil((r.startAt - net.serverNow) / 1000));
  }
  function renderRoom(s) {
    const r = s.room;
    if (!r) { show('lobby'); return; }
    if (r === lastRoom && !!s.match === lastMatch) return; // ping更新などでは再描画しない
    lastRoom = r; lastMatch = !!s.match;
    const host = isHost(s), me = selfPlayer(s), st = canStart(s), tdm = r.settings.mode === 'tdm';
    $('roomCode').textContent = r.code;
    $('roomCount').textContent = r.players.length + ' / ' + r.settings.maxPlayers;
    const ul = $('slots'); clear(ul);
    for (let i = 0; i < r.settings.maxPlayers; i++) {
      const p = r.players[i];
      if (!p) { ul.append(h('li', { class: 'slot empty' }, 'WAITING FOR PILOT…')); continue; }
      const self = p.id === s.profile.id, isH = p.id === r.hostId;
      ul.append(h('li', { class: 'slot' + (self ? ' me' : '') + (p.connected === false ? ' off' : '') },
        jetIco(liveryOf(p.livery).c),
        h('div', { class: 'nm' }, p.name,
          isH && h('span', { class: 'chip host' }, 'HOST'), p.isBot && h('span', { class: 'chip bot' }, 'BOT'), self && h('span', { class: 'chip' }, 'YOU'),
          tdm && h('span', { class: 'chip team' + (i % 2) }, 'TEAM ' + (i % 2 ? 'B' : 'A')), p.connected === false && h('span', { class: 'chip' }, 'OFFLINE')),
        h('div', { class: 'st' },
          p.ping != null && h('span', null, p.ping + 'ms'),
          h('span', { class: 'rdy' + (isH || p.ready ? ' on' : '') }, isH ? 'HOST' : p.ready ? 'READY' : 'WAIT'),
          host && !self && h('button', { type: 'button', 'aria-label': p.name + ' を退出させる', onclick: () => net.kick(p.id) }, '✕')),
      ));
    }
    $('btnReady').hidden = host || r.status !== 'lobby';
    $('btnReady').textContent = me && me.ready ? '準備解除' : '準備完了';
    $('btnStart').hidden = !host || r.status !== 'lobby';
    $('btnStart').disabled = !st.ok;
    $('btnRejoin').hidden = !(r.status === 'inmatch' && !s.match);
    $('roomHint').textContent =
      r.status === 'countdown' ? 'まもなく出撃します…' :
      r.status === 'inmatch' ? '対戦進行中です。「対戦に戻る」で復帰できます。' :
      host ? (st.ok ? '全員の準備が完了しました。出撃できます。' : st.why) :
      me && me.ready ? 'ホストの開始を待っています…' : '準備ができたら「準備完了」を押してください。';
    roomForm.set(r.settings); roomForm.disable(!host || r.status !== 'lobby');
    $('hostNote').textContent = host ? 'あなたがホスト' : 'ホストのみ変更可';
    if (r.status === 'countdown') {
      $('countdown').hidden = false; updateCount();
      if (!cdTimer) cdTimer = setInterval(updateCount, 150);
    } else { $('countdown').hidden = true; clearInterval(cdTimer); cdTimer = null; }
    applyBackdrop('room');
  }

  /* ----- 設定 ----- */
  function renderSettings() {
    const s = store.get();
    $('setName').value = s.profile.name; $('nameErr').textContent = '';
    const g = $('liveryGrid'); clear(g);
    LIVERIES.forEach((l) => g.append(h('button', {
      class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(l.id === s.profile.livery),
      onclick: () => { commitProfile({ livery: l.id }); renderSettings(); },
    }, jetIco(l.c), l.nm)));
    $('setSound').textContent = 'サウンド: ' + (s.settings.sound ? 'ON' : 'OFF');
    $('setTouch').value = s.settings.touch;
  }
  function commitProfile(patch) { store.dispatch({ type: 'profile', patch }); saveProfile(store.get().profile); }
  function commitSettings(patch) { store.dispatch({ type: 'settings', patch }); saveSettings(store.get().settings); }

  /* ================= イベント配線 ================= */
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

  // タイトル
  $('verLine').textContent = CONFIG.NAME + '  v' + CONFIG.VERSION + (CONFIG.USE_MOCK ? '  ·  OFFLINE MOCK' : '');
  function start() {
    if (cur !== 'title') return;
    core.unlockAudio(); core.setMuted(!store.get().settings.sound);
    show('menu');
    if (!deepDone) {
      deepDone = true;
      const c = normalizeCode(new URLSearchParams(location.search).get('room') || '');
      if (isRoomCode(c)) { show('friend'); $('joinCode').value = c; setTimeout(() => doJoin(c), 300); }
    }
  }
  $('scr-title').addEventListener('click', start);
  addEventListener('keydown', (e) => {
    if (cur === 'title') { if (!e.metaKey && !e.ctrlKey && !e.altKey && e.code !== 'Tab') { e.preventDefault(); start(); } return; }
    if (e.code === 'Escape' && cur && BACK[cur]) show(BACK[cur]);
  });

  // フレンド対戦
  function setBusy(b) { busy = b; ['btnCreate', 'btnJoin', 'btnDemo'].forEach((id) => { $(id).disabled = b; }); }
  async function doCreate() {
    if (busy) return; setBusy(true);
    try { await net.createRoom(createForm.get()); show('room'); } catch (e) { $('joinErr').textContent = ''; toast(e.message, 'warn'); } finally { setBusy(false); }
  }
  async function doJoin(raw) {
    if (busy) return; setBusy(true); $('joinErr').textContent = '';
    try { await net.joinRoom(raw); show('room'); } catch (e) { $('joinErr').textContent = e.message; } finally { setBusy(false); }
  }
  $('btnCreate').addEventListener('click', doCreate);
  $('btnJoin').addEventListener('click', () => doJoin($('joinCode').value));
  $('joinCode').addEventListener('input', (e) => {
    const raw = e.target.value, n = normalizeCode(raw);
    e.target.value = n;
    $('joinErr').textContent = raw.replace(/\s/g, '').length > n.length ? 'ルームコードに 0・O・1・I は使われません' : '';
  });
  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin($('joinCode').value); });
  if (CONFIG.USE_MOCK) {
    $('btnDemo').hidden = false; $('demoNote').hidden = false;
    $('btnDemo').addEventListener('click', () => { $('joinCode').value = DEMO_CODE; doJoin(DEMO_CODE); });
  }

  // ルーム
  $('btnLeave').addEventListener('click', () => { net.leaveRoom(); show('friend'); });
  $('btnReady').addEventListener('click', () => { const me = selfPlayer(store.get()); net.setReady(!(me && me.ready)); });
  $('btnStart').addEventListener('click', () => net.startMatch());
  $('btnRejoin').addEventListener('click', () => net.joinMatch());
  const inviteUrl = (code) => location.origin + location.pathname + '?room=' + code;
  $('btnCopyCode').addEventListener('click', async () => {
    const r = store.get().room; if (!r) return;
    toast((await copyText(r.code)) ? 'ルームコードをコピーしました' : 'コピーできませんでした', 'ok');
  });
  $('btnShare').addEventListener('click', async () => {
    const r = store.get().room; if (!r) return;
    if (navigator.share) { try { await navigator.share({ title: 'BLUE SORTIE ONLINE', text: 'ルームコード ' + r.code, url: inviteUrl(r.code) }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    toast((await copyText(inviteUrl(r.code))) ? '招待リンクをコピーしました' : 'コピーできませんでした', 'ok');
  });
  net.on('lost', () => { if (cur === 'room') show('lobby'); });

  // 設定
  $('setName').addEventListener('change', (e) => {
    const v = sanitizeName(e.target.value);
    if (v.length < 2) { $('nameErr').textContent = '2文字以上で入力してください'; e.target.value = store.get().profile.name; return; }
    $('nameErr').textContent = ''; e.target.value = v; commitProfile({ name: v });
  });
  $('setSound').addEventListener('click', () => {
    const on = !store.get().settings.sound; commitSettings({ sound: on }); core.setMuted(!on); renderSettings();
  });
  $('setTouch').addEventListener('change', (e) => { commitSettings({ touch: e.target.value }); touch.refresh(); });

  // ポーズメニューの退出 (対戦: 対戦から退出 / ソロ: ミッション中断)
  $('leaveMatch').addEventListener('click', () => { session.exit(); core.leaveToMenu(); });

  /* ================= ゲームコア連動 ================= */
  OH.onLayers = (id) => {
    if (id === 'menu') {                       // ゲームコアが「メニューへ戻る」を要求
      session.exit(); bdKey = '';
      let t = last;
      if (t === 'room' && !store.get().room) t = 'lobby';
      if (!SCREENS.includes(t) || t === 'title') t = 'menu';
      show(t);
    } else {                                   // brief / pause / end / hangar / (null = プレイ開始)
      hideAll(); touch.setVisible(id == null);
      if (id == null) {
        $('leaveMatch').textContent = session.active ? '対戦から退出' : 'ミッションを中断';
        $('pauseNote').textContent = session.active ? '対戦は進行中です。機体はそのまま飛び続けます。' : '再開するとゲームが続きます。';
      }
    }
  };

  store.subscribe((s) => render(s));
  show('title');
}
