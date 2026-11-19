/* Session - 「ルームの対戦」と「ゲームコア」をつなぐ唯一のモジュール。
 *   ・match/start を受けてアリーナを開始 (開始位置は shared/spawnFor でスロットから決定)
 *   ・自機状態を SEND_HZ で送信 (NetClient.sendState)
 *   ・snap を RemotePlayers に流し込み、補間表示
 *   ・HUD に ROOM/残り時間/人数を描画
 * 命中判定・撃墜はサーバー権威(server/src/combat.js)。ここは発射の通知(onFire)と、hit/kill の反映だけを行う。 */
import { CONFIG } from '../config.js';
import { packState, spawnFor } from '../../shared/rules.js';
import { RemotePlayers } from './remote-players.js';
import { saveProfile } from '../profile.js';

const NONE = Object.freeze([]);
const fmt = (t) => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

export class Session {
  constructor({ core, store, net }) {
    this.core = core; this.store = store; this.net = net;
    this.remote = new RemotePlayers(core);
    this.active = false;
    this.sendAcc = 0;
    this.t0 = 0;
    this.settings = null;
  }

  attach() {
    const OH = window.BSOHooks;
    OH.onTick = (dt) => this._tick(dt);
    OH.onFrame = () => { if (this.active) this.remote.update(); };
    OH.onHud = (api) => this._hud(api);
    /* ロックオン・ミサイル誘導・発射通知。対戦中以外は空/無効なのでソロミッションには影響しない */
    OH.remoteTargets = () => (this.active ? this.remote.targets() : NONE);
    OH.remoteAlive = (t) => this.active && this.remote.isLive(t);
    OH.onFire = (k, t) => { if (this.active) this.net.fire(k, t && t.remote ? t.id : undefined); };
    this.net.on('hit', (m) => this._onHit(m));
    this.net.on('kill', (m) => this._onKill(m));
    this.net.on('snap', (m) => { if (this.active) this.remote.ingest(m); });
    this.store.subscribe((s, a) => {
      if (a.type === 'match/start') this._begin(s);
      else if (a.type === 'match/end') this._serverEnded();
      else if (a.type === 'room/clear') this._serverEnded();
      else if (a.type === 'room/set' && this.active) this._roster();
    });
  }

  _roster() {
    const s = this.store.get();
    if (s.room && s.match) this.remote.setRoster(s.room.players.filter((p) => s.match.players.includes(p.id)), s.profile.id);
  }

  _begin(s) {
    const m = s.match;
    if (!m) return;
    const slot = Math.max(0, m.players.indexOf(s.profile.id));
    this.active = true; this.sendAcc = 0; this.t0 = performance.now(); this.settings = m.settings;
    this.remote.clear(); this._roster();
    this.core.startArena({ bio: m.settings.map, tod: m.settings.tod, spawn: spawnFor(slot, m.players.length) });
    const stats = { ...s.profile.stats, sorties: (s.profile.stats.sorties || 0) + 1 };
    this.store.dispatch({ type: 'profile', patch: { stats } });
    saveProfile(this.store.get().profile);
  }

  /** プレイヤー自身が退出 (ポーズメニュー/結果画面)。冪等。 */
  exit() {
    if (!this.active) return;
    this.active = false; this.remote.clear();
    this.net.leaveMatch();
  }

  /** サーバー側の都合で対戦が終わった/ルームが消えた。プレイ中ならメニューへ戻す。 */
  _serverEnded() {
    if (!this.active) return;
    this.active = false; this.remote.clear();
    if (this.core.isPlaying()) this.core.leaveToMenu();
  }

  /** サーバーが確定した命中。自分なら HP を確定値に合わせ、他人なら着弾エフェクトを出す */
  _onHit(m) {
    if (!this.active || !m) return;
    const me = this.store.get().profile.id;
    if (m.to === me) return this.core.setPlayerHp(m.hp);
    const pos = this.remote.positionOf(m.to);
    if (pos) this.core.fx(pos, m.k === 'm' ? 'boom' : 'spark');
  }
  _onKill(m) {
    if (!this.active || !m) return;
    const me = this.store.get().profile.id, nm = (id) => (id === me ? 'YOU' : this.remote.nameOf(id) || '?');
    if (m.to === me) this.core.setPlayerHp(0);
    else { const pos = this.remote.positionOf(m.to); if (pos) this.core.fx(pos, 'big'); this.remote.markKilled(m.to); }
    this.core.notify(m.by === me ? '撃墜! ' + nm(m.to) : nm(m.by) + ' が ' + nm(m.to) + ' を撃墜');
  }

  _tick(dt) {
    if (!this.active) return;
    this.sendAcc += dt;
    const iv = 1 / CONFIG.SEND_HZ;
    if (this.sendAcc < iv) return;
    this.sendAcc %= iv;
    const p = this.core.getPlayer(); if (!p) return;
    this.net.sendState(packState({ ...p, flags: (p.dead ? 1 : 0) | (p.barrier ? 4 : 0) }));
  }

  _hud(api) {
    if (!this.active) return;
    this.remote.drawLabels(api);
    const { txt, W, H, U } = api, s = this.store.get(), ins = Math.max(14, 12 * U);
    const left = this.settings ? this.settings.timeLimit - (performance.now() - this.t0) / 1000 : 0;
    txt('ROOM ' + (s.room ? s.room.code : ''), ins, ins + 14 * U, 12, 'left', 'rgba(159,240,255,.45)');
    txt(fmt(left), ins, ins + 40 * U, 26, 'left', left <= 0 ? '#ff5a4d' : '#9ff0ff');
    txt('PILOTS ' + (this.remote.map.size + 1), ins, ins + 60 * U, 13, 'left', 'rgba(159,240,255,.45)');
    if (left <= 0) txt('TIME UP  Esc でメニュー', W / 2, H * 0.3, 22, 'center', '#ffb347');
  }
}
