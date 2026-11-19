/* Session - 「ルームの対戦」と「ゲームコア」をつなぐ唯一のモジュール。
 *   ・match/start を受けてアリーナを開始 (開始位置は shared/spawnFor でスロットから決定)
 *   ・自機状態を SEND_HZ で送信 (NetClient.sendState)
 *   ・snap を RemotePlayers に流し込み、補間表示
 *   ・HUD に ROOM/残り時間/人数を描画
 * 対戦ルール(命中判定・撃墜・スコア)はサーバー権威にする設計で、次フェーズでここへ追加する。 */
import { CONFIG } from '../config.js';
import { packState, spawnFor } from '../../shared/rules.js';
import { RemotePlayers } from './remote-players.js';
import { saveProfile } from '../profile.js';

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
