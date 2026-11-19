/* Combat - 対戦中の命中判定・ダメージ・撃墜をサーバーで確定する(サーバー権威)。
 *
 * クライアントは「撃った」(fire) ことだけを伝える。弾・ミサイルの位置と命中はここでシミュレートし、
 * 結果は hit / kill イベントとして全員へ配信される。発射位置・向きは、送信者の最新の state から
 * サーバーが決める(クライアントが座標や威力を申告することはできない)。
 * Cloudflare にも Node にも依存しない純粋なクラス。数値(COMBAT)は調整可能な暫定値。
 *
 * 既知の簡略化:
 *   ・地形(山・海面)との衝突は見ない。弾は寿命、ミサイルは寿命(7秒)で消える。
 *   ・命中は相手の「最新の state」の位置で判定する(ラグ補正なし)。
 *   ・クライアント側のアップグレード(装甲・ミサイル数)は反映しない。全員同条件(HP100・ミサイル14発)。 */

export const COMBAT = Object.freeze({
  HP: 100,
  GUN_DMG: 3, MSL_DMG: 45,
  GUN_CD: 0.04, GUN_SPEED_ADD: 1000, GUN_LIFE: 1.5, GUN_R: 24, MAX_BULLETS: 80,
  MSL_CD: 0.35, MSL_MAX: 14, MSL_REGEN_S: 8, MSL_R: 34, MSL_LIFE: 7, MSL_ACC: 380, MSL_VMAX: 560, MSL_TURN: 2.6, MAX_MISSILES: 6,
  BARRIER_MUL: 0.1,        // state の flags bit2 (バリア) が立っている間のダメージ倍率
  MAX_STATE_AGE_MS: 1500,  // 発射者の state がこれより古ければ発射を受け付けない
});

const FLAG_DEAD = 1, FLAG_BARRIER = 4;
const r1 = (v) => Math.round(v * 10) / 10;

/** クォータニオン (x,y,z,w) で (0,0,-1) を回した機首方向 */
export function forwardOf(qx, qy, qz, qw) {
  const vx = 0, vy = 0, vz = -1;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** 線分 a→b と球(中心 c, 半径 r)が交わるか。高速な弾のすり抜け(トンネリング)を防ぐ。 */
export function segHitsSphere(a, b, c, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy + (c[2] - a[2]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + dx * t - c[0], py = a[1] + dy * t - c[1], pz = a[2] + dz * t - c[2];
  return px * px + py * py + pz * pz <= r * r;
}

export class Combat {
  constructor() { this.p = new Map(); this.bullets = []; this.missiles = []; }

  reset(ids) { this.p.clear(); this.bullets = []; this.missiles = []; ids.forEach((id) => this.add(id)); }
  add(id) { if (!this.p.has(id)) this.p.set(id, { hp: COMBAT.HP, dead: false, kills: 0, deaths: 0, msl: COMBAT.MSL_MAX, rg: 0, gT: -1e12, mT: -1e12 }); }
  remove(id) {
    this.p.delete(id);
    this.bullets = this.bullets.filter((b) => b.by !== id);
    this.missiles = this.missiles.filter((m) => m.by !== id);
    this.missiles.forEach((m) => { if (m.tgt === id) m.tgt = null; });
  }
  has(id) { return this.p.has(id); }
  hp(id) { const p = this.p.get(id); return p ? p.hp : COMBAT.HP; }
  isDead(id) { const p = this.p.get(id); return !!p && p.dead; }
  /** クライアントが自分の墜落(地面衝突など)を申告した。誰の戦果にもならない。 */
  markDead(id) { const p = this.p.get(id); if (p && !p.dead) { p.dead = true; p.hp = 0; p.deaths++; } }

  /** 発射を受け付けたら true。st = 発射者の最新 state 配列、age = その経過ミリ秒 */
  fire(id, k, tgt, st, now, age) {
    const p = this.p.get(id);
    if (!p || p.dead || !st || !(age <= COMBAT.MAX_STATE_AGE_MS)) return false;
    const f = forwardOf(st[3], st[4], st[5], st[6]), pos = [st[0], st[1], st[2]];
    if (k === 'g') {
      if (now - p.gT < COMBAT.GUN_CD * 1000 || this.bullets.length >= COMBAT.MAX_BULLETS) return false;
      p.gT = now;
      const v = st[7] + COMBAT.GUN_SPEED_ADD;
      this.bullets.push({ by: id, pos, vel: [f[0] * v, f[1] * v, f[2] * v], life: COMBAT.GUN_LIFE });
      return true;
    }
    if (k === 'm') {
      if (now - p.mT < COMBAT.MSL_CD * 1000 || p.msl < 1) return false;
      if (this.missiles.filter((m) => m.by === id).length >= COMBAT.MAX_MISSILES) return false;
      p.mT = now; p.msl--;
      const t = typeof tgt === 'string' && tgt !== id && this.p.has(tgt) && !this.p.get(tgt).dead ? tgt : null;
      this.missiles.push({ by: id, pos: [pos[0] + f[0] * 8, pos[1] + f[1] * 8, pos[2] + f[2] * 8], dir: f, speed: st[7], life: COMBAT.MSL_LIFE, tgt: t });
      return true;
    }
    return false;
  }

  /** dt 秒だけ進める。states = { pid: state配列 }。戻り値は配信すべきイベント [{t:'hit'|'kill', ...}] */
  step(dt, states) {
    const hits = new Map(), kills = [];
    for (const p of this.p.values()) {
      if (p.dead) continue;
      p.rg += dt;
      if (p.rg >= COMBAT.MSL_REGEN_S) { p.rg = 0; if (p.msl < COMBAT.MSL_MAX) p.msl++; }
    }
    const victims = (by) => { const out = []; for (const [id, p] of this.p) if (id !== by && !p.dead && states[id]) out.push(id); return out; };
    const apply = (by, to, k, dmg) => {
      const p = this.p.get(to), st = states[to]; if (!p || p.dead) return;
      if (st && (st[9] & FLAG_BARRIER)) dmg *= COMBAT.BARRIER_MUL;
      p.hp = Math.max(0, p.hp - dmg);
      const key = to + '|' + by + '|' + k, h = hits.get(key) || { to, by, k, dmg: 0 };
      h.dmg += dmg; hits.set(key, h);
      if (p.hp <= 0) {
        p.dead = true; p.deaths++;
        const b = this.p.get(by); if (b && by !== to) b.kills++;
        kills.push({ t: 'kill', to, by, k });
      }
    };

    this.bullets = this.bullets.filter((b) => {
      b.life -= dt;
      const a = b.pos, nb = [a[0] + b.vel[0] * dt, a[1] + b.vel[1] * dt, a[2] + b.vel[2] * dt];
      for (const id of victims(b.by)) {
        const s = states[id];
        if (segHitsSphere(a, nb, [s[0], s[1], s[2]], COMBAT.GUN_R)) { apply(b.by, id, 'g', COMBAT.GUN_DMG); return false; }
      }
      b.pos = nb; return b.life > 0;
    });

    this.missiles = this.missiles.filter((m) => {
      m.life -= dt; m.speed = Math.min(COMBAT.MSL_VMAX, m.speed + COMBAT.MSL_ACC * dt);
      const ts = m.tgt && !this.isDead(m.tgt) ? states[m.tgt] : null;
      if (ts) {
        const des = norm([ts[0] - m.pos[0], ts[1] - m.pos[1], ts[2] - m.pos[2]]);
        const dot = Math.max(-1, Math.min(1, m.dir[0] * des[0] + m.dir[1] * des[1] + m.dir[2] * des[2]));
        const k = Math.min(1, (COMBAT.MSL_TURN * dt) / Math.max(Math.acos(dot), 1e-4));
        m.dir = norm([m.dir[0] + (des[0] - m.dir[0]) * k, m.dir[1] + (des[1] - m.dir[1]) * k, m.dir[2] + (des[2] - m.dir[2]) * k]);
      } else if (m.tgt) m.tgt = null; // 対象が撃墜・退出した: 追尾をやめて直進
      const a = m.pos, nb = [a[0] + m.dir[0] * m.speed * dt, a[1] + m.dir[1] * m.speed * dt, a[2] + m.dir[2] * m.speed * dt];
      for (const id of victims(m.by)) {
        const s = states[id];
        if (segHitsSphere(a, nb, [s[0], s[1], s[2]], COMBAT.MSL_R)) { apply(m.by, id, 'm', COMBAT.MSL_DMG); return false; }
      }
      m.pos = nb; return m.life > 0;
    });

    const ev = [];
    for (const h of hits.values()) ev.push({ t: 'hit', to: h.to, by: h.by, k: h.k, dmg: r1(h.dmg), hp: r1(this.hp(h.to)) });
    return ev.concat(kills);
  }

  results(nameOf) {
    return [...this.p].map(([id, p]) => ({ id, name: nameOf(id), kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }
}
export { FLAG_DEAD };
