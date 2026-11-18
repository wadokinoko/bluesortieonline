/* タッチ操作パッド (スマートフォン用)。ゲームコアのキー入力 BSOCore.setKey / act に変換するだけ。
 * 左: 仮想スティック (ピッチ/ロール)  右: 機関砲・ミサイル・フレア・加減速・メニュー */
export function initTouch({ core, stage, getSetting }) {
  const root = document.createElement('div');
  root.id = 'touch'; root.hidden = true;
  root.innerHTML = `
    <div class="pad" aria-label="操縦スティック"><div class="knob"></div></div>
    <div class="btns">
      <button class="tb" type="button" data-act="flare">FLR</button>
      <button class="tb" type="button" data-act="missile">MSL</button>
      <button class="tb fire" type="button" data-key="Space">GUN</button>
      <button class="tb" type="button" data-act="bomb">BMB</button>
      <button class="tb" type="button" data-key="ShiftLeft">▲</button>
      <button class="tb" type="button" data-key="KeyC">▼</button>
    </div>
    <button class="tb top" type="button" data-act="pause" style="width:48px;height:48px;pointer-events:auto">❚❚</button>`;
  stage.appendChild(root);

  /* --- スティック: dead zone 0.28 --- */
  const pad = root.querySelector('.pad'), knob = root.querySelector('.knob');
  let pid = null;
  const keysOf = { l: 'KeyA', r: 'KeyD', u: 'KeyW', d: 'KeyS' };
  const setStick = (dx, dy) => {
    const z = 0.28;
    core.setKey(keysOf.l, dx < -z); core.setKey(keysOf.r, dx > z);
    core.setKey(keysOf.u, dy < -z); core.setKey(keysOf.d, dy > z); // 下へ引く = 機首上げ(S)
  };
  const move = (e) => {
    const b = pad.getBoundingClientRect(), R = b.width / 2;
    let dx = (e.clientX - (b.left + R)) / R, dy = (e.clientY - (b.top + R)) / R;
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    knob.style.transform = `translate(${dx * R * 0.6}px,${dy * R * 0.6}px)`;
    setStick(dx, dy);
  };
  const release = () => { pid = null; knob.style.transform = ''; setStick(0, 0); };
  pad.addEventListener('pointerdown', (e) => { pid = e.pointerId; pad.setPointerCapture(pid); move(e); e.preventDefault(); });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e); });
  pad.addEventListener('pointerup', (e) => { if (e.pointerId === pid) release(); });
  pad.addEventListener('pointercancel', release);

  /* --- ボタン --- */
  root.querySelectorAll('.tb').forEach((b) => {
    const key = b.dataset.key, act = b.dataset.act;
    if (key) {
      const on = (e) => { core.setKey(key, true); b.classList.add('on'); e.preventDefault(); };
      const off = () => { core.setKey(key, false); b.classList.remove('on'); };
      b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
    } else if (act) {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); const f = core.act[act]; if (f) f(); });
    }
  });

  const wanted = () => {
    const m = getSetting();
    return m === 'on' || (m === 'auto' && matchMedia('(pointer:coarse)').matches);
  };
  let vis = false;
  const apply = () => { root.hidden = !(vis && wanted()); if (root.hidden) release(); };
  return { setVisible(v) { vis = !!v; apply(); }, refresh: apply };
}
