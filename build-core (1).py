#!/usr/bin/env python3
"""bluesortie4.html の <script> 本体を js/game/game-core.js として切り出し、ONLINE 用の最小パッチを当てる。

 * 元ファイルは読み取りのみ(絶対に書き換えない)。
 * 各パッチは「期待する元文字列が正確に N 回出現する」ことを assert する。元コードが想定と違えば即失敗。
 * 初回移植用。生成後は game-core.js を直接編集してよい(パッチ箇所は /*[BSO]*/ で検索できる)。
   再実行すると game-core.js は上書きされる点に注意。

使い方: python3 tools/build-core.py [bluesortie4.html のパス]
"""
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads/bluesortie4.html")
DST = Path(__file__).resolve().parent.parent / "js" / "game" / "game-core.js"

html = SRC.read_text(encoding="utf-8")
m = re.search(r"<script>\n(.*?)\n</script>", html, re.S)
assert m, "script block not found"
js = m.group(1)


def rep(old, new, count=1):
    global js
    n = js.count(old)
    assert n == count, f"patch target found {n}x (expected {count}): {old[:70]!r}"
    js = js.replace(old, new)


# 1) メニューDOMが無くても落ちない致命エラー表示 (index.html の BSO_fatal)
js, n = re.subn(r"\$\('menu'\)\.querySelector\('\.brief'\)\.textContent=('[^']*');",
                r"(window.BSO_fatal||alert)(\1);/*[BSO]*/", js)
assert n == 2, f"fatal patch {n}"

# 2) 保存キーを分離 (Blue Sortie 4 本体のセーブと衝突させない)
assert js.count("blueSortie4") >= 8
js = js.replace("blueSortie4", "bsOnline")

# 3) 外部連携フック
rep("const $=id=>document.getElementById(id);",
    "const $=id=>document.getElementById(id);\n"
    "const OH=window.BSOHooks=window.BSOHooks||{}; /*[BSO] 外部(UI/通信)フック。onTick/onFrame/onHud/onLayers*/")

# 4) layers(): オンライン画面は外部UIが管理する。'menu' = オンラインメニューへ戻る
rep("function layers(id){ for(const l of['menu','brief','pause','end','hangar'])$(l).hidden=l!==id; }",
    "function layers(id){ for(const l of['brief','pause','end','hangar']){const el=$(l); if(el)el.hidden=l!==id;} if(OH.onLayers)OH.onLayers(id||null); } /*[BSO]*/")

# 5) 入力欄でのタイピングをゲームのキー操作として扱わない
rep("addEventListener('keydown',e=>{\n",
    "addEventListener('keydown',e=>{\n"
    "  { const t=e.target; if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable))return; } /*[BSO]*/\n")

# 6) ポーズ: アリーナ(オンライン)では世界を止めず、メニュー表示のみトグル
rep("function pauseGame(){ if(phase!=='play')return; phase='pause';",
    "function pauseGame(force){ if(phase!=='play')return; if(M.arena){ $('pause').hidden=force?false:!$('pause').hidden; return; } /*[BSO]*/ phase='pause';")
rep("function resumeGame(){ if(phase!=='pause')return;",
    "function resumeGame(){ if(M.arena){ $('pause').hidden=true; return; } /*[BSO]*/ if(phase!=='pause')return;")
rep("if(phase==='play'&&!S.result)pauseGame(); });", "if(phase==='play'&&!S.result)pauseGame(true); });")

# 7) 毎フレームのフック
rep("S.time+=dt; S.hitT=Math.max(0,S.hitT-dt); if(M.todTo)todUpdate(dt);",
    "S.time+=dt; S.hitT=Math.max(0,S.hitT-dt); if(M.todTo)todUpdate(dt); if(OH.onTick)OH.onTick(dt,P,S,fwd); /*[BSO]*/")
rep("  renderer.render(scene,camera);\n  if(phase==='cine')drawCine(); else if(phase==='ending')drawEnding(); else drawHud();",
    "  if(OH.onFrame)OH.onFrame(dt,phase); /*[BSO]*/\n  renderer.render(scene,camera);\n"
    "  if(phase==='cine')drawCine(); else if(phase==='ending')drawEnding(); else { drawHud(); if(OH.onHud&&phase==='play')OH.onHud({hx,W,H,U,proj,txt,line,camera,P,S}); } /*[BSO]*/")

# 8) startGame: アリーナの開始位置を適用
rep("function startGame(){\n  initAudio(); reset(); phase='play';",
    "function startGame(){\n  initAudio(); reset(); applySpawn(); phase='play'; /*[BSO]*/")

# 9) 公開API (window.BSOCore)。ゲームループ開始の直前に差し込む
API = r"""
/* ---------- [BSO] BLUE SORTIE ONLINE: 外部公開API ---------- */
/* アリーナ = 敵AI・目標なしのフリーフライト空間。オンライン対戦の舞台(プレイヤー同期の土台)。 */
const ARENA={n:'ARENA',sub:'Online Arena',ch:'',tod:'day',bio:'isles',fac:'g',tot:0,conc:0,spd:[200,220],hp:100,msl:14,alt:2300,rad:[],obj:'',story:'',arena:1,spawn:null};
function applySpawn(){
  wmesh.visible=!M.arena; const sp=M.spawn; if(!sp)return;
  P.pos.set(sp.x,sp.y,sp.z); P.q.setFromAxisAngle(UP,sp.yaw||0); fwd.set(0,0,-1).applyQuaternion(P.q); S.pf0.copy(fwd);
  playerMesh.position.copy(P.pos); playerMesh.quaternion.copy(P.q); updateCamera(0,true);
}
window.BSOCore={
  version:'bs4-base',
  get phase(){return phase;},
  isPlaying:()=>phase==='play',
  scene, camera, THREE,
  makeJet, facJet,
  missions:MS.map(m=>({n:m.n,sub:m.sub,ch:m.ch})),
  biomes:Object.keys(BIO), tods:Object.keys(TOD),
  unlockAudio:()=>initAudio(),
  setMuted(v){ muted=!!v; if(muted)engineSound(0,false); },
  get muted(){return muted;},
  /* 入力 (タッチ・将来のゲームパッド用)。キー名は KeyboardEvent.code と同じ */
  setKey(code,v){ keys[code]=!!v; },
  act:{ missile:()=>{if(phase==='play'&&!S.result)fireMissile();}, flare:()=>{if(phase==='play')dropFlare();}, bomb:()=>{if(phase==='play')dropBomb();}, special:()=>{if(phase==='play')fireSpecial();}, pause:()=>pauseGame() },
  /* 画面背景: メニュー上で機体が周回する3Dシーン。マップ/時間帯を指定可能 */
  setBackdrop(o){ if(phase==='play'||phase==='cine'||phase==='ending')return; M=Object.assign({},ARENA,o||{},{spawn:null}); mi=0; reset(); phase='menu'; },
  /* オンライン対戦: o={bio,tod,spawn:{x,y,z,yaw}} */
  startArena(o){ M=Object.assign({},ARENA,o||{}); mi=0; startGame(); },
  quickMission(i){ if(!MS[i])return; mi=i; M=MS[i]; startGame(); },
  leaveToMenu(){ toMenu(); },
  toggleGFX,
  getHG:()=>HG,
  /* 自機の同期用スナップショット */
  getPlayer(){ if(!P)return null; const q=P.q; return {x:P.pos.x,y:P.pos.y,z:P.pos.z,qx:q.x,qy:q.y,qz:q.z,qw:q.w,speed:P.speed,hp:P.hp,thr:P.thr,dead:!!P.dead,barrier:P.sh>0}; }
};
"""
rep("toMenu();\nrequestAnimationFrame(loop);", API + "toMenu();\nrequestAnimationFrame(loop);")

banner = """/* BLUE SORTIE ONLINE - ゲームコア
 * 出典: Blue Sortie 4 (bluesortie4.html) の <script> を tools/build-core.py で切り出し、
 *       ONLINE 用の最小パッチ(行末の [BSO] マーカーで検索可)を当てたもの。元ファイルは無変更。
 * 以降はこのファイルを直接編集してよい。外部連携は window.BSOHooks / window.BSOCore 経由のみ。
 *   BSOHooks: onLayers(id) onTick(dt,P,S,fwd) onFrame(dt,phase) onHud(api)
 *   BSOCore : 末尾の "外部公開API" を参照
 */
"""
DST.parent.mkdir(parents=True, exist_ok=True)
DST.write_text(banner + js + "\n", encoding="utf-8")
print(f"wrote {DST} ({len(js.splitlines())} lines)")

# ゲームコアが前提とする共通スタイル(.layer/.card/.btn/.hg など)をそのまま継承
cm = re.search(r"<style>\n(.*?)\n</style>", html, re.S)
assert cm, "style block not found"
CSS = DST.parent.parent.parent / "css" / "core.css"
CSS.parent.mkdir(parents=True, exist_ok=True)
CSS.write_text("/* Blue Sortie 4 のスタイルを継承 (tools/build-core.py で抽出)。ONLINE 固有の見た目は online.css */\n" + cm.group(1) + "\n", encoding="utf-8")
print(f"wrote {CSS}")
