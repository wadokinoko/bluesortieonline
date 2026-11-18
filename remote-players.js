/* RemotePlayers - 他プレイヤー機の表示。サーバーからの snap を時系列バッファに積み、
 * 「INTERP_DELAY_MS だけ過去」の状態を補間して描く(ネットワークの揺らぎを吸収する標準手法)。
 * 機体モデルは Blue Sortie 4 の makeJet をそのまま使う。 */
import { CONFIG } from '../config.js';
import { unpackState, liveryOf } from '../../shared/rules.js';

const STALE_MS = 2500; // この時間スナップショットが来なければ機体を隠す

export class RemotePlayers {
  constructor(core) {
    this.core = core;
    this.T = core.THREE;
    this.map = new Map();
    this.qa = new this.T.Quaternion(); this.qb = new this.T.Quaternion();
  }

  setRoster(players, selfId) {
    const keep = new Set();
    for (const p of players) {
      if (p.id === selfId) continue;
      keep.add(p.id);
      const r = this.map.get(p.id);
      if (r) { r.name = p.name; r.team = p.team; } else this._add(p);
    }
    for (const id of [...this.map.keys()]) if (!keep.has(id)) this._remove(id);
  }

  _add(p) {
    const c = liveryOf(p.livery).c;
    const mesh = this.core.makeJet(c[0], c[1], c[2]);
    mesh.visible = false;
    this.core.scene.add(mesh);
    this.map.set(p.id, { id: p.id, name: p.name, mesh, buf: [], dead: false });
  }
  _remove(id) {
    const r = this.map.get(id); if (!r) return;
    this.core.scene.remove(r.mesh);
    r.mesh.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); if (o.material.dispose) o.material.dispose(); } });
    this.map.delete(id);
  }
  clear() { for (const id of [...this.map.keys()]) this._remove(id); }

  /** snap メッセージ { players:{pid: packState配列} } を取り込む */
  ingest(m) {
    const now = performance.now();
    for (const id in m.players) {
      const r = this.map.get(id); if (!r) continue;
      const s = unpackState(m.players[id]); if (!s) continue;
      r.buf.push({ t: now, s });
      if (r.buf.length > 30) r.buf.shift();
    }
  }

  update() {
    const now = performance.now(), rt = now - CONFIG.INTERP_DELAY_MS;
    for (const r of this.map.values()) {
      const b = r.buf;
      if (!b.length) continue;
      const last = b[b.length - 1];
      let a = b[0], c = b[0];
      if (rt >= last.t) { a = c = last; }
      else if (rt > b[0].t) { for (let i = 0; i < b.length - 1; i++) if (b[i].t <= rt && rt < b[i + 1].t) { a = b[i]; c = b[i + 1]; break; } }
      const k = a === c ? 0 : (rt - a.t) / (c.t - a.t), sa = a.s, sc = c.s;
      r.mesh.position.set(sa.x + (sc.x - sa.x) * k, sa.y + (sc.y - sa.y) * k, sa.z + (sc.z - sa.z) * k);
      this.qa.set(sa.qx, sa.qy, sa.qz, sa.qw); this.qb.set(sc.qx, sc.qy, sc.qz, sc.qw);
      r.mesh.quaternion.copy(this.qa).slerp(this.qb, k);
      r.dead = !!(sc.flags & 1);
      r.mesh.visible = !r.dead && now - last.t < STALE_MS;
      const f = r.mesh.userData.flame; if (f) f.scale.z = 0.8 + Math.random() * 0.4;
    }
  }

  /** onHud から呼ぶ: 機体の上にコールサインと距離を表示 */
  drawLabels(api) {
    const { hx, proj, txt, U, camera } = api;
    for (const r of this.map.values()) {
      if (!r.mesh.visible) continue;
      const p = proj(r.mesh.position); if (!p.ok) continue;
      const d = r.mesh.position.distanceTo(camera.position);
      const s = Math.max(9, Math.min(34, 20000 / d)) * U;
      hx.strokeStyle = '#8dff9f'; hx.lineWidth = Math.max(1, 1.4 * U);
      hx.strokeRect(p.x - s, p.y - s, s * 2, s * 2);
      txt(r.name, p.x, p.y - s - 8 * U, 13, 'center', '#8dff9f');
      txt((d / 1000).toFixed(1) + 'km', p.x, p.y + s + 14 * U, 11, 'center', 'rgba(141,255,159,.7)');
    }
  }
}
