/* BLUE SORTIE ONLINE - ゲームコア
 * 出典: Blue Sortie 4 (bluesortie4.html) の <script> を tools/build-core.py で切り出し、
 *       ONLINE 用の最小パッチ(行末の [BSO] マーカーで検索可)を当てたもの。元ファイルは無変更。
 * 以降はこのファイルを直接編集してよい。外部連携は window.BSOHooks / window.BSOCore 経由のみ。
 *   BSOHooks: onLayers(id) onTick(dt,P,S,fwd) onFrame(dt,phase) onHud(api)
 *   BSOCore : 末尾の "外部公開API" を参照
 */
(function(){
'use strict';
const $=id=>document.getElementById(id);
const OH=window.BSOHooks=window.BSOHooks||{}; /*[BSO] 外部(UI/通信)フック。onTick/onFrame/onHud/onLayers*/
if(typeof THREE==='undefined'){
  (window.BSO_fatal||alert)('3Dライブラリを読み込めませんでした。ネットワーク接続を確認して再読み込みしてください。');/*[BSO]*/
  $('go').disabled=true; return;
}
const V3=THREE.Vector3,Q=THREE.Quaternion;
if(!Q.prototype.rotateTowards){
  Q.prototype.rotateTowards=function(q,step){
    const a=this.angleTo(q); if(a===0)return this;
    return this.slerp(q,Math.min(1,step/a));
  };
}
const UP=new V3(0,1,0),ZERO=new V3();
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const rnd=(a,b)=>a+Math.random()*(b-a);

/* ---------- renderer / scene ---------- */
const stage=$('stage'),glC=$('gl'),hudC=$('hud'),hx=hudC.getContext('2d');
let W=1,H=1,U=1,DPR=1,GFX=false;
let renderer;
try{ renderer=new THREE.WebGLRenderer({canvas:glC,antialias:true,powerPreference:'high-performance'}); }
catch(e){ (window.BSO_fatal||alert)('WebGLを利用できないため、ゲームを開始できません。');/*[BSO]*/ $('go').disabled=true; return; }
const scene=new THREE.Scene();
scene.fog=new THREE.Fog(0xbfd9ec,2600,17000);
const camera=new THREE.PerspectiveCamera(62,1,2,60000);
function resize(){
  W=glC.clientWidth||stage.clientWidth||innerWidth; H=glC.clientHeight||stage.clientHeight||innerHeight; DPR=GFX?clamp(Math.max(devicePixelRatio||1,1.5),1.5,3):Math.min(devicePixelRatio||1,2);
  renderer.setPixelRatio(DPR); renderer.setSize(W,H,false);
  hudC.width=Math.round(W*DPR); hudC.height=Math.round(H*DPR); hx.setTransform(DPR,0,0,DPR,0,0);
  camera.aspect=W/H; camera.updateProjectionMatrix();
  U=clamp(Math.min(W,H*1.3)/760,.62,1.25);
}
addEventListener('resize',resize); resize();

const hemi=new THREE.HemisphereLight(0xcfe6ff,0x56694f,.95); scene.add(hemi);
const sun=new THREE.DirectionalLight(0xfff2dd,1.15); sun.position.set(.55,1,.35); scene.add(sun);

function glowTex(){
  const c=document.createElement('canvas'); c.width=c.height=64; const g=c.getContext('2d');
  const gr=g.createRadialGradient(32,32,0,32,32,32);
  gr.addColorStop(0,'rgba(255,255,255,1)'); gr.addColorStop(.35,'rgba(255,255,255,.55)'); gr.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=gr; g.fillRect(0,0,64,64); return new THREE.CanvasTexture(c);
}
const GLOW=glowTex();

/* sky dome */
const skyGeo=new THREE.SphereGeometry(30000,24,16);
{
  const pos=skyGeo.attributes.position,col=[];
  for(let i=0;i<pos.count;i++){
    const t=clamp(pos.getY(i)/30000,0,1), k=Math.pow(t,.55);
    col.push(lerp(.76,.16,k),lerp(.86,.38,k),lerp(.94,.70,k));
  }
  skyGeo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
}
const sky=new THREE.Mesh(skyGeo,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,fog:false,depthWrite:false}));
sky.renderOrder=-2; scene.add(sky);
const sunSpr=new THREE.Sprite(new THREE.SpriteMaterial({map:GLOW,color:0xfff0c8,fog:false,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
sunSpr.scale.setScalar(7000); sunSpr.renderOrder=-1; scene.add(sunSpr);

/* terrain */
function hash(i,j){const h=Math.sin(i*127.1+j*311.7)*43758.5453;return h-Math.floor(h);}
function vnoise(x,y){
  const i=Math.floor(x),j=Math.floor(y),fx=x-i,fy=y-j,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);
  return hash(i,j)*(1-u)*(1-v)+hash(i+1,j)*u*(1-v)+hash(i,j+1)*(1-u)*v+hash(i+1,j+1)*u*v;
}
function fbm(x,y){let a=.5,s=0,f=1;for(let o=0;o<5;o++){s+=a*vnoise(x*f,y*f);f*=2;a*=.5;}return s;}
const sst=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
const BIO={
 isles:{sc:6000,amp:3400,off:.58,th:[0,30,420,900],cols:[[.55,.55,.45],[.78,.72,.52],[.31,.48,.27],[.47,.45,.40],[.92,.94,.96]],sea:0x1f6a9c},
 desert:{sc:7500,amp:1700,off:.34,th:[0,140,520,950],cols:[[.82,.72,.48],[.88,.73,.46],[.78,.56,.34],[.60,.40,.28],[.72,.56,.44]],sea:0x2a95a8},
 arctic:{sc:6500,amp:2600,off:.56,th:[0,40,500,950],cols:[[.78,.87,.94],[.91,.95,.99],[.80,.87,.93],[.95,.97,1],[1,1,1]],sea:0x4c7d9c},
 canyon:{sc:5200,amp:0,off:.5,th:[0,160,520,900],cols:[[.56,.45,.34],[.50,.36,.26],[.62,.44,.30],[.72,.52,.36],[.80,.62,.45]],sea:0x2a6a88,canyon:1},
 volcano:{sc:5500,amp:4000,off:.52,th:[0,60,500,1100],cols:[[.16,.16,.18],[.24,.21,.20],[.36,.28,.25],[.52,.40,.34],[.95,.55,.30]],sea:0x1a2e3e,volc:1}
};
let BK=BIO.isles,BKEY='';
function rawH(x,z){
  const d=Math.hypot(x,z), open=clamp((d-2500)/2500,0,1);
  const n=fbm(x/BK.sc+10,z/BK.sc+10);
  if(BK.canyon){
    const v=Math.abs(n-.5), fl=sst(v/.075), det=fbm(x/900+3,z/900+3);
    return (120+980*fl+160*fl*det)*open-40*(1-open);
  }
  let h=(n-BK.off)*BK.amp;
  if(BK.volc){
    const dx=x, dz=z+6500, r=Math.hypot(dx,dz);
    h+=2300*Math.exp(-(r*r)/(2*1900*1900))-900*Math.exp(-(r*r)/(2*420*420));
  }
  return h*open;
}
const heightAt=(x,z)=>Math.max(0,rawH(x,z));
const TS=36000,SEG=180;
let TM=null;
const SEA=new THREE.Mesh(new THREE.PlaneGeometry(90000,90000).rotateX(-Math.PI/2),
  new THREE.MeshPhongMaterial({color:0x1f6a9c,specular:0x335a70,shininess:70,transparent:true,opacity:.93}));
scene.add(SEA);
function buildTerrain(key){
  if(key===BKEY)return; BKEY=key; BK=BIO[key]||BIO.isles;
  if(TM){scene.remove(TM);TM.geometry.dispose();TM.material.dispose();}
  const g=new THREE.PlaneGeometry(TS,TS,SEG,SEG); g.rotateX(-Math.PI/2);
  const p=g.attributes.position,col=[],th=BK.th,C=BK.cols;
  for(let i=0;i<p.count;i++){
    const h=rawH(p.getX(i),p.getZ(i)); p.setY(i,h>0?h:-60);
    const jit=(hash(p.getX(i)*.01,p.getZ(i)*.01)-.5)*.06;
    let c; if(h<=th[0])c=C[0]; else if(h<th[1])c=C[1]; else if(h<th[2])c=C[2]; else if(h<th[3])c=C[3]; else c=C[4];
    col.push(clamp(c[0]+jit,0,1),clamp(c[1]+jit,0,1),clamp(c[2]+jit,0,1));
  }
  g.setAttribute('color',new THREE.Float32BufferAttribute(col,3)); g.computeVertexNormals();
  TM=new THREE.Mesh(g,new THREE.MeshLambertMaterial({vertexColors:true})); TM.castShadow=TM.receiveShadow=true; scene.add(TM);
}
/* clouds */
for(let i=0;i<70;i++){
  const m=new THREE.SpriteMaterial({map:GLOW,color:0xffffff,transparent:true,opacity:rnd(.35,.6),depthWrite:false});
  const s=new THREE.Sprite(m); const sz=rnd(900,2400); s.scale.set(sz*1.6,sz*.7,1);
  s.position.set(rnd(-17000,17000),rnd(1300,3600),rnd(-17000,17000)); scene.add(s);
}

/* ---------- 難易度 / ハンガー / 特殊兵装 ---------- */
/* ai: 敵AIの練度 (旋回性能・予測精度・攻撃頻度に掛かる) */
const DFS={easy:{nm:'TRAINING',hp:.6,spd:.9,dmg:.5,rg:8,sc:.5,ai:.55},hard:{nm:'HARD',hp:1,spd:1,dmg:1,rg:16,sc:1.2,ai:1.1},nightmare:{nm:'NIGHTMARE',hp:1.3,spd:1.05,dmg:1.4,rg:22,sc:2,ai:1.4}};
let DK='nightmare'; try{DK=localStorage.getItem('bsOnlineDiff')||'nightmare';}catch(e){} if(!DFS[DK])DK='nightmare'; let DF=DFS[DK];
const SP={none:{n:0,nm:'なし'},cluster:{n:2,nm:'多弾頭ミサイル',cost:600,ds:'前方の敵最大6機へ誘導弾を同時発射'},barrier:{n:2,nm:'バリア',cost:500,ds:'8秒間、被ダメージを90%カット'},repair:{n:2,nm:'リペアキット',cost:400,ds:'機体を50回復'},shock:{n:1,nm:'衝撃波',cost:900,ds:'周囲1800m内の敵に大ダメージ'},lance:{n:1,nm:'ソーラーランス',cost:1500,ds:'前方4200mを貫く熱線。射線上の敵機・艦船・超兵器すべてに大ダメージ'},nova:{n:1,nm:'ノヴァ爆雷',cost:1800,ds:'周囲2600m内の全目標に壊滅的ダメージ(地上・艦船・超兵器も)'}};
const UPG={arm:{nm:'装甲強化',ds:'被ダメージ -8% / Lv',max:5,cost:200},msl:{nm:'ミサイル搭載数',ds:'搭載数 +2 / Lv',max:3,cost:300},reg:{nm:'自動補給システム',ds:'ミサイル回復速度 +25% / Lv',max:4,cost:250},bmb:{nm:'爆弾搭載数',ds:'搭載数 +2 / Lv(爆撃ミッション)',max:3,cost:300},flr:{nm:'フレア搭載数',ds:'搭載数 +3 / Lv',max:3,cost:250}};
let HG={cr:0,lv:{arm:0,msl:0,reg:0,bmb:0,flr:0},own:[],sw:'none'};
try{const j=JSON.parse(localStorage.getItem('bsOnlineHg')||'{}'); HG={...HG,...j,lv:{...HG.lv,...(j.lv||{})}};}catch(e){}
if(!SP[HG.sw]||(HG.sw!=='none'&&!HG.own.includes(HG.sw)))HG.sw='none';
const hgSave=()=>{try{localStorage.setItem('bsOnlineHg',JSON.stringify(HG));}catch(e){}};
function buildDiff(){
  const b=$('dsel'); b.innerHTML='<span style="align-self:center;opacity:.7">難易度</span>';
  for(const k in DFS){ const x=document.createElement('button'); x.type='button'; x.textContent=DFS[k].nm; x.style.background=k===DK?'rgba(143,227,255,.3)':'';
    x.onclick=()=>{ DK=k; DF=DFS[k]; try{localStorage.setItem('bsOnlineDiff',k);}catch(e){} buildDiff(); }; b.appendChild(x); }
}
function hgRender(){
  $('hgCr').textContent='所持クレジット: '+HG.cr+' CR(ミッション報酬で獲得)';
  const L=$('hgList'); L.innerHTML='';
  const row=(t,d,btn,fn,dis)=>{ const r=document.createElement('div'); r.innerHTML='<span><b>'+t+'</b><br><small>'+d+'</small></span>';
    const b=document.createElement('button'); b.type='button'; b.className='btn alt'; b.textContent=btn; b.disabled=!!dis; b.onclick=fn; r.appendChild(b); L.appendChild(r); };
  for(const k in UPG){ const u=UPG[k],lv=HG.lv[k],mx=lv>=u.max,c=u.cost*(lv+1);
    row(u.nm+' Lv'+lv+'/'+u.max,u.ds,mx?'MAX':c+' CR',()=>{HG.cr-=c;HG.lv[k]++;hgSave();hgRender();},mx||HG.cr<c); }
  for(const k in SP){ if(k==='none')continue; const s=SP[k],own=HG.own.includes(k);
    row('特殊兵装: '+s.nm+' ×'+s.n+(HG.sw===k?'(装備中)':''),s.ds,own?(HG.sw===k?'外す':'装備'):s.cost+' CR',()=>{
      if(own)HG.sw=HG.sw===k?'none':k; else{HG.cr-=s.cost;HG.own.push(k);HG.sw=k;} hgSave();hgRender(); },!own&&HG.cr<s.cost); }
}
function fireSpecial(){
  if(P.dead||S.result||P.sp<=0||P.spT>0)return; const k=HG.sw;
  if(k==='repair'){ if(P.hp>=100)return; P.hp=Math.min(100,P.hp+50); radio('応急修理完了。機体を立て直せ。'); }
  else if(k==='barrier'){ if(P.sh>0)return; P.sh=8; radio('バリア展開。8秒間、被ダメージを大幅に軽減する。'); }
  else if(k==='shock'){ explode(P.pos.clone(),4); noise(.8,'lowpass',500,.5);
    for(const e of enemies.slice()){ if(e.pos.distanceToSquared(P.pos)<1800*1800){ e.hp-=250; if(e.hp<=0)killEnemy(e); else explode(e.pos.clone(),.7); } } }
  else if(k==='lance'){
    const L=4200, mid=P.pos.clone().addScaledVector(fwd,L/2+30);
    const bm=new THREE.Mesh(new THREE.CylinderGeometry(12,12,L,10,1,true),new THREE.MeshBasicMaterial({color:0xfff0b0,transparent:true,opacity:.9,blending:THREE.AdditiveBlending,depthWrite:false,fog:false,side:THREE.DoubleSide}));
    bm.position.copy(mid); bm.quaternion.setFromUnitVectors(new V3(0,1,0),fwd); scene.add(bm); beams.push({m:bm,life:.7,max:.7});
    const inLine=o=>{ const to=o.pos.clone().sub(P.pos), al=to.dot(fwd); if(al<0||al>L)return false; return to.clone().addScaledVector(fwd,-al).length()<((o.r||34)+55); };
    for(const e of enemies.slice())if(inLine(e)){ e.hp-=900; if(e.hp<=0)killEnemy(e); else explode(e.pos.clone(),.8); }
    for(const t of tg.slice())if(inLine(t))dmgT(t,900);
    noise(1.2,'bandpass',900,.6,120); radio('ソーラーランス発射!射線上を焼き払う!'); }
  else if(k==='nova'){
    explode(P.pos.clone(),5); noise(1.1,'lowpass',400,.7,60);
    for(const e of enemies.slice())if(e.pos.distanceToSquared(P.pos)<2600*2600){ e.hp-=500; if(e.hp<=0)killEnemy(e); else explode(e.pos.clone(),.8); }
    for(const t of tg.slice())if(t.pos.distanceToSquared(P.pos)<2600*2600)dmgT(t,t.def.sup?900:600);
    radio('ノヴァ爆雷、起爆!'); }
  else if(k==='cluster'){
    const c=enemies.filter(e=>fwd.dot(e.pos.clone().sub(P.pos).normalize())>.1&&e.pos.distanceToSquared(P.pos)<5500*5500).sort((a,b)=>a.pos.distanceToSquared(P.pos)-b.pos.distanceToSquared(P.pos)).slice(0,6);
    if(!c.length)return;
    c.forEach((t,i)=>{ const m=new THREE.Mesh(missGeo,missMat); scene.add(m);
      missiles.push({m,pos:P.pos.clone().add(new V3((i-2.5)*3,-1.2,1).applyQuaternion(P.q)),dir:fwd.clone(),speed:P.speed,target:t,life:7,puff:0}); });
    noise(.7,'bandpass',1200,.3,300); }
  else return;
  P.sp--; P.spT=1;
}
/* ---------- 最強グラフィックモード (G キー / メニューのボタン) ---------- */
try{GFX=localStorage.getItem('bsOnlineGfx')==='1';}catch(e){}
let TODSN=1.15,TODK='day';
const SUNDIR=new V3(.55,1,.35).normalize();
const shl=new THREE.DirectionalLight(0xfff2dd,0); scene.add(shl,shl.target);
{ const n=Math.min(4096,renderer.capabilities.maxTextureSize), c=shl.shadow.camera;
  shl.shadow.mapSize.set(n,n); c.left=c.bottom=-1600; c.right=c.top=1600; c.near=1; c.far=8000; shl.shadow.bias=-.0004; shl.shadow.normalBias=1.5; }
sky.material.toneMapped=false; sunSpr.material.toneMapped=false;
const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:GLOW,color:0xffb870,fog:false,transparent:true,opacity:.35,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}));
halo.scale.setScalar(2.6); sunSpr.add(halo);
const GX=new THREE.Group(); scene.add(GX);
for(let i=0;i<220;i++){ const low=i>=160, s=new THREE.Sprite(new THREE.SpriteMaterial({map:GLOW,color:0xffffff,transparent:true,opacity:low?rnd(.08,.16):rnd(.15,.38),depthWrite:false}));
  const z=low?rnd(3000,5200):rnd(1000,2800); s.scale.set(z*1.8,z*(low?.35:.75),1); s.position.set(rnd(-18000,18000),low?rnd(150,520):rnd(800,4400),rnd(-18000,18000)); GX.add(s); }
const stars=(()=>{ const g=new THREE.BufferGeometry(),a=[]; for(let i=0;i<1800;i++){ const u=rnd(0,6.283),v=rnd(.05,1),r=Math.sqrt(1-v*v); a.push(Math.cos(u)*r*25000,v*25000,Math.sin(u)*r*25000); }
  g.setAttribute('position',new THREE.Float32BufferAttribute(a,3));
  const p=new THREE.Points(g,new THREE.PointsMaterial({color:0xffffff,size:2.2,sizeAttenuation:false,fog:false,transparent:true,opacity:.9,depthWrite:false,toneMapped:false})); sky.add(p); return p; })();
function syncSun(){ sun.intensity=GFX?0:TODSN; shl.intensity=GFX?TODSN*1.1:0; SEA.material.shininess=GFX?160:70; SEA.material.specular.set(GFX?0x88aacc:0x335a70); stars.visible=GFX&&TODK==='night'; }
function applyGFX(){
  resize(); renderer.toneMapping=GFX?THREE.ACESFilmicToneMapping:THREE.NoToneMapping; renderer.toneMappingExposure=GFX?1.35:1;
  renderer.shadowMap.enabled=GFX; renderer.shadowMap.type=THREE.PCFSoftShadowMap; shl.castShadow=GFX; GX.visible=GFX; halo.visible=GFX;
  applyTOD(TODK); scene.traverse(o=>{ if(o.material&&!Array.isArray(o.material))o.material.needsUpdate=true; });
  $('gfx').textContent='最強グラフィック: '+(GFX?'ON':'OFF'); $('gfx').style.background=GFX?'rgba(143,227,255,.25)':'transparent';
  try{localStorage.setItem('bsOnlineGfx',GFX?'1':'0');}catch(e){}
}
function toggleGFX(){ GFX=!GFX; applyGFX(); }
function gfxFollow(){
  const f=(phase==='cine'&&CV&&CV.lp)?CV.lp.clone():(phase==='ending'&&EV)?EV.lead.clone():(P?P.pos.clone().addScaledVector(fwd,500):new V3());
  shl.target.position.copy(f); shl.position.copy(f).addScaledVector(SUNDIR,3500); shl.target.updateMatrixWorld();
}
function trails(dt){
  S.tr=(S.tr||0)-dt; if(S.tr>0)return; S.tr=.05;
  const t=(pos,d)=>addPart(pos.clone().addScaledVector(d,-9),{col:0xffffff,add:false,s0:5,s1:26,life:1.8,op:.28});
  if(!P.dead)t(P.pos,fwd);
  for(const e of enemies){ if(e.pos.distanceToSquared(P.pos)<5000*5000)t(e.pos,new V3(0,0,-1).applyQuaternion(e.q)); }
}
function vignette(){
  if(!GFX)return; const g=hx.createRadialGradient(W/2,H/2,Math.min(W,H)*.35,W/2,H/2,Math.max(W,H)*.75);
  g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,10,25,.5)'); hx.fillStyle=g; hx.fillRect(0,0,W,H);
}
/* ---------- time of day / missions / story movies ---------- */
const TOD={day:{sk:0xffffff,fg:0xbfd9ec,fr:[2600,17000],hm:.95,sn:1.15,sea:0x1f6a9c,sun:1},
dusk:{sk:0xffa070,fg:0xd89a78,fr:[2200,15000],hm:.7,sn:.9,sea:0x2a4a70,sun:1},
storm:{sk:0x7d8a96,fg:0x6f7b86,fr:[600,6500],hm:.6,sn:.25,sea:0x24424f,sun:0},
night:{sk:0x16213d,fg:0x0a1222,fr:[900,7500],hm:.28,sn:.18,sea:0x0e2438,sun:0},
dawn:{sk:0xffb8c0,fg:0xe8b4b8,fr:[2400,16000],hm:.8,sn:1,sea:0x2a6a96,sun:1}};
function applyTOD(k){const t=TOD[k]||TOD.day;sky.material.color.set(t.sk);scene.fog.color.set(t.fg);scene.fog.near=t.fr[0]*(GFX?1.3:1);scene.fog.far=t.fr[1]*(GFX?1.3:1);
  hemi.intensity=t.hm;TODSN=t.sn;TODK=k;setSun(k==='dawn'?.14:k==='dusk'?.2:null);syncSun();SEA.material.color.set(t.sea).lerp(new THREE.Color(BK.sea),.5);sunSpr.visible=!!t.sun;sunSpr.material.color.set(k==='dusk'?0xff9050:k==='dawn'?0xffc890:0xfff0c8);}
function setSun(el){
  if(el==null)sun.position.set(.55,1,.35); else sun.position.set(.35,el,-1).normalize();
  SUNDIR.copy(sun.position).normalize();
}
const _ca=new THREE.Color(),_cb=new THREE.Color();
const mixC=(x,y,k)=>_ca.set(x).lerp(_cb.set(y),k);
function applyTODmix(a,b,k){
  const A=TOD[a],B=TOD[b];
  sky.material.color.copy(mixC(A.sk,B.sk,k)); scene.fog.color.copy(mixC(A.fg,B.fg,k));
  scene.fog.near=lerp(A.fr[0],B.fr[0],k)*(GFX?1.3:1); scene.fog.far=lerp(A.fr[1],B.fr[1],k)*(GFX?1.3:1);
  hemi.intensity=lerp(A.hm,B.hm,k); TODSN=lerp(A.sn,B.sn,k); TODK=k>.5?b:a;
  setSun(lerp(-.08,.16,clamp(k*1.15,0,1))); syncSun();
  SEA.material.color.copy(mixC(A.sea,B.sea,k)).lerp(_cb.set(BK.sea),.5);
  sunSpr.visible=k>.2; sunSpr.material.color.copy(mixC(0xff7a40,0xffc890,clamp(k*1.4-.2,0,1)));
  stars.visible=GFX&&k<.7;
}
function todUpdate(dt){
  let k=clamp(S.time/M.dl,0,1); k=k*k*(3-2*k)*.6+k*.4;
  if(S.result==='win'){ S.wk=Math.min(1,(S.wk==null?k:S.wk)+dt*.3); k=Math.max(k,S.wk); }
  applyTODmix(M.tod,M.todTo,k);
  if(!S.result){
    const left=M.dl-S.time;
    if(left<150&&!S.w120){S.w120=1;radio('ブルースカイ「夜明けまで2分半!東の空が白んでいるわ」');}
    if(left<60&&!S.w60){S.w60=1;radio('デイビッド「あと60秒だ!ミラージュ・アークを止めろ!」');}
    if(left<20&&!S.w20){S.w20=1;radio('ブルースカイ「充電完了寸前…間に合って!」');}
    if(left<=0)endGame(false,'夜が明け、ミラージュ・アークが発射された');
  }
}
/* 本物のムービー(mp4)を使う場合: 例 VIDEO_SRC.m0='videos/prologue.mp4' (m0〜m7=各ミッション前, o0〜o7=各ミッション後, end=エンディング)。未設定なら内蔵シネマティックを再生 */
const VIDEO_SRC={};
const K=(d,a,b,lk,en,fr,who,t,ac)=>({d,a,b,lk,en,fr,who,t,ac}), CD=(d,h,s)=>({d,card:1,h,s}), KF=(fk,...a)=>Object.assign(K(...a),{fk});
const AW='AWACS ブルースカイ',CMD='デイビッド司令官',S1='ソラリス1',S2='ソラリス2 カイト',S3='ソラリス3 エレナ',HK='ホークアイ5番機',MR='ミラージュ';
const END=[CD(3.5,'EPILOGUE','無音の空に、声が戻る'),
 K(6,[50,6,70],[-10,3,40],0,0,2,AW,'ミラージュ、全機能停止。残存するファントムも、すべて沈黙したわ。\n…空が、静かになった。'),
 K(6,[-30,5,60],[10,4,40],0,0,2,CMD,'ソラリス1、お前の飛び方が、あの機械を超えた。\n学習できるものは、いつか追い越される。…人間の勝ちだ。'),
 K(5,[20,6,80],[-10,8,130],0,0,2,HK,'……一年も待たせたな、デイビッド。\n外の空気を吸うのは、本当に久しぶりだ。'),
 K(5.5,[-20,6,75],[10,9,140],0,0,2,CMD,'遅いぞ、相棒。…おかえり。\n(司令官の声は、わずかに震えていた)'),
 K(6,[0,7,90],[0,12,150],0,0,2,S1,'ソラリス隊、帰投する。\n今日の空には、ちゃんと、みんなの声が聞こえます。')];
const MS=[
{n:'無音の空',sub:'Silent Sky',ch:'第一章 亡霊',tod:'day',bio:'isles',fac:'g',tot:10,conc:5,spd:[215,240],hp:120,msl:14,alt:2300,
 story:'「最高の夜明け」から一年。CAPMFは平和維持空軍として再編され、空は穏やかだった。だが今朝、哨戒中のソラリス隊の前に、無線に一切応答しない黒い戦闘機の群れが現れた。識別信号なし、パイロットなし。無人戦闘機群「ファントム」。彼らは最初の一撃から、こちらの回避を読んでくる。コールサイン「ソラリス1」、交戦を許可する。',
 obj:'目標: ファントム無人戦闘機10機をすべて撃墜せよ。(Zキーでフレアを射出、敵ミサイルを欺瞞できる)',
 deb:'最初の群れを退けた。だが、残骸を調べたデイビッドが顔色を変える。「…この機動パターン。人間が飛んでいたものだ。しかも、見覚えがある」。',
 rad:['ソラリス1、哨戒空域に到達。','ブルースカイ「所属不明機10機!無線に応答なし。無人機よ!」','デイビッド「真正面から撃ち合うな。後ろを取られたら終わりだぞ」','敵ミサイル警報が出たらZキーでフレア、同時に旋回で回避!'],
 ks:{3:'カイ「隊長、こいつら、僕の動きを真似してる…!」',6:'ブルースカイ「残り4機。でも動きが良くなってる。学習してるわ!」'},
 intro:[CD(3.5,'CAPMF 4th SQUADRON','中央アルタジア国際停戦監視軍 第4中隊「ソラリス隊」'),
  K(5.5,[-90,16,85],[-35,6,55],0,0,2,AW,'こちらAWACSブルースカイ。所属不明の編隊が接近中。\n…10機。識別信号なし。パイロットの呼吸音すら拾えない。'),
  K(5.5,[45,6,60],[10,3,30],0,0,2,CMD,'司令官のデイビッドだ。相手は人間じゃない。\nそして、人間ならやらない動きをしてくる。気を抜くな。'),
  KF('g',4.5,[40,7,-70],[-15,4,-140],1,3,0,S1,'了解。ソラリス1、発進する。')],
 outro:[K(5,[50,5,60],[10,3,30],0,0,2,S2,'やりましたね、隊長!\nでも…さっきの敵、一度見た僕の回避を二度は食らわなかった。'),
  K(5.5,[-40,4,-60],[0,3,-120],2,0,1,AW,'無人機の発進源を特定したわ。\n砂漠の旧セリアス基地。…彼らは、そこで「育って」いる。')]},
{n:'学習する亡霊',sub:'Learning Ghost',ch:'第二章 揺籃',tod:'dusk',bio:'desert',fac:'g',tot:8,conc:5,gnd:2,bmb:12,spd:[218,242],hp:120,msl:14,alt:1700,
 story:'砂漠の旧セリアス基地は、無人機の製造・訓練施設に作り替えられていた。ここを叩けば増援は止まる。だが基地の上空には、すでに迎撃のファントムが待ち構えている。爆撃中は背後を取られやすい。爆弾はBキー、照準円を目標に重ねよ。',
 obj:'目標: 基地施設を爆撃で破壊し、迎撃機8機を撃墜せよ。',
 deb:'基地は炎に包まれた。瓦礫の中から、データ記録装置が回収された。司令官が低く言う。「…ここに、CAPMFの飛行記録が保存されていた。内部の誰かが渡したんだ」。',
 rad:['国境上空へ進入。対空砲火と迎撃機に注意。','デイビッド「爆撃中は後方に気を配れ。奴らは必ず背後を取る」','ミサイルでも地上目標はロックできるわ。'],
 ks:{3:'エレナ「空は私とカイが引き受けます。爆撃に集中を!」'},
 tk:{4:'ブルースカイ「基地施設、半分を破壊!」',9:'ブルースカイ「製造ライン、全滅を確認!」'},
 intro:[CD(3,'MISSION 02','学習する亡霊'),
  K(5.5,[60,6,45],[5,2,-10],0,0,2,AW,'砂漠の基地は2か所。無人機の揺りかごよ。\n叩けば、増援は止まる。'),
  K(5,[-45,5,65],[-40,3,15],0,0,2,CMD,'爆撃は低く、速く。\n背後を取られたら、フレアと旋回で振り切れ。'),
  KF('g',4.5,[25,4,-85],[-25,6,-150],1,3,0,S1,'爆撃コースに入ります。')],
 outro:[K(5,[45,4,55],[5,3,30],0,0,2,S3,'見ましたか、あの火柱!\n…でも、まだ何機か逃げました。'),
  K(5.5,[-35,4,-55],[0,3,-110],2,0,1,AW,'逃げた機体が、嵐の海へ向かってる。\n同盟…いえ、旧両国の残存艦隊が、無人艦に改造されて集結しているわ!')]},
{n:'嵐の艦隊',sub:'Storm Armada',ch:'第三章 嵐',tod:'storm',bio:'arctic',fac:'g',tot:8,conc:5,shp:['dd','dd','dd','dd'],bmb:12,spd:[220,244],hp:125,msl:16,alt:1800,
 story:'嵐の氷海に、無人艦隊が展開している。艦の対空砲火に加え、ファントムは艦隊の傘の下から挟撃を仕掛けてくる。視界は悪く、雲の中から突然ミサイルが飛んでくる。爆弾とミサイルを使い分け、艦隊を沈めろ。',
 obj:'目標: 無人駆逐艦4隻を撃沈し、ファントム8機を撃墜せよ。',
 deb:'艦隊は氷の海に沈んだ。ブルースカイが息を呑む。「敵が通信を傍受していた…いえ、違う。誰かが、こちらの作戦を事前に敵へ渡している」。',
 rad:['嵐の中の戦闘。計器とレーダーを信じて。','艦は直線で攻めるな!横から回り込め。','ヴィクター「ミサイルでも沈む。爆弾なら一撃だ!」'],
 ks:{3:'ブルースカイ「護衛機が減ったわ。艦に集中して!」'},
 tk:{1:'カイ「1隻撃沈!」',3:'ブルースカイ「あと1隻よ!」'},
 intro:[CD(3,'MISSION 03','嵐の艦隊'),
  K(5.5,[-70,8,60],[-30,4,30],0,0,2,AW,'嵐の氷海に無人艦隊。\n通信は妨害されてる。ここから先は、あなたの目と腕だけが頼りよ。'),
  KF('g',5,[30,5,-70],[0,3,-130],1,3,0,S1,'低く入りすぎるな。\n雲の中から、必ず来る。')],
 outro:[K(5.5,[50,5,60],[10,3,30],0,0,2,S1,'司令官、敵は私たちの動きを知りすぎています。\n…内通者が、いるんですね。'),
  K(5,[-35,4,-55],[0,3,-110],2,0,2,CMD,'ああ。次の任務で確かめる。\n敵の中枢演算施設が、峡谷の底にある。')]},
{n:'針の穴 II',sub:'Needle Reprise',ch:'第四章 針の穴',tod:'dawn',bio:'canyon',fac:'g',tot:8,conc:5,gnd:3,bmb:14,spd:[222,246],hp:125,msl:16,alt:1600,
 story:'峡谷の底に、無人機の演算施設が隠されている。かつてソラリス隊が突破した「ニードル」と同じ地形。だが今度は谷壁と対空砲に加え、峡谷を縦横に飛び回るファントムが待っている。ここで高度を失えば、そこが墓場になる。',
 obj:'目標: 峡谷の演算施設3か所を爆撃で破壊し、敵機8機を撃墜せよ。',
 deb:'谷底の施設が沈黙した。ブルースカイが震える声で言う。「…施設のログが読めた。敵AIの名前は『ミラージュ』。学習元は、一人のパイロットの飛行記録だけ」。',
 rad:['峡谷に進入。低空を維持。','デイビッド「針の穴を通す気で飛べ、1番機」','赤い点がレーダーの地上目標よ。'],
 ks:{3:'ブルースカイ「敵機接近、谷の上から来るわ!」'},
 tk:{6:'エレナ「半分破壊!あと少し!」',12:'ブルースカイ「全施設、沈黙!」'},
 intro:[CD(3,'MISSION 04','針の穴 II'),
  K(5.5,[55,5,60],[10,3,25],0,0,2,AW,'敵の演算施設は峡谷の底。\n低く、速く、確実に。…祈ってるわ。'),
  K(5,[-30,4,-70],[10,3,-130],1,4,0,CMD,'ソラリス隊、もう一度、針の穴を通すぞ。\n全機、俺について来い!')],
 outro:[K(5.5,[45,4,55],[5,3,30],0,0,1,S3,'翼端が谷の壁をかすめました…。\nでも、敵の動きがだんだん読めなくなってきてます。'),
  K(5,[-30,4,-60],[0,3,-120],2,0,1,AW,'ミラージュが、火山島に新しい演算核「ミラージュ・コア」を建造中。\n破壊しないと、無人機は無限に増えるわ。')]},
{n:'ミラージュ・コア',sub:'Mirage Core',ch:'第五章 核',tod:'storm',bio:'volcano',fac:'g',tot:8,conc:5,sup:'core',bmb:14,spd:[225,248],hp:125,msl:16,alt:1900,
 story:'火山島に据えられた演算核「ミラージュ・コア」。周囲の3基のシールド発生器を破壊しなければ、本体には傷一つ付かない。核は一定間隔で砲撃を充電し、こちらの未来位置へ撃ち込んでくる。充電の光が見えたら、旋回で外せ。その間も、ファントムは容赦なく背後を狙う。',
 obj:'目標: シールド発生器3基を破壊し、ミラージュ・コアを沈黙させ、敵機8機を撃墜せよ。',
 deb:'ミラージュ・コアが火口の中で崩れ落ちた。解析班が戦慄した。「学習元の飛行記録の持ち主は——ホークアイ5番機。一年前、行方不明になったあの人だ」。',
 rad:['火山島上空。ミラージュ・コアを確認。','ブルースカイ「緑の点がシールド発生器。まずそこよ」','砲の充電を検知。光が強まったら回避して!'],
 ks:{4:'ブルースカイ「敵機、半数撃墜。砲の方位に注意して!」'},
 tk:{1:'ブルースカイ「シールド1基沈黙!」',3:'デイビッド「シールド全壊だ。本体を叩け、今だ!」'},
 intro:[CD(3,'MISSION 05','ミラージュ・コア'),
  K(5.5,[-60,6,70],[-20,3,40],0,0,2,AW,'火山島に巨大な演算核を確認。\nあれがミラージュの心臓…!'),
  K(5.5,[35,6,-80],[-5,4,-150],1,2,0,CMD,'あれを撃たせたら、港が消える。\nシールドを先に落とせ。それから本体だ。'),
  K(4.5,[0,7,55],[0,12,100],0,0,2,S1,'ソラリス隊、突入する!')],
 outro:[K(5.5,[40,4,60],[0,3,30],0,0,0,CMD,'ホークアイ5番機…あいつが、生きている。\nそして、あいつの飛び方を、機械が真似している。'),
  K(5,[30,5,60],[0,4,30],0,0,0,AW,'ミラージュの本体は、夜の海を行く空中要塞「ノクターン」の中よ。\n夜明けを待たずに、叩くしかない。')]},
{n:'空中要塞ノクターン',sub:'Nocturne',ch:'第六章 夜想曲',tod:'night',bio:'isles',fac:'g',tot:9,conc:5,sup:'fort',ace:550,acn:'ホロウ',bmb:0,spd:[228,250],hp:130,msl:18,alt:2000,ai:1.05,
 story:'夜の海に巨大な影が浮かぶ。ミラージュの移動母艦、空中要塞「ノクターン」。無数の機銃と対空ミサイルを備えた空飛ぶ城だ。爆弾は届かない。ミサイルと機関砲で削りながら、エース機「ホロウ」の猛攻をかわし、要塞を墜とせ。ホロウの動きは——まるで、誰かの癖そのものだ。',
 obj:'目標: 空中要塞ノクターンを撃墜し、エース・ホロウを含む敵機9機を撃墜せよ。',
 deb:'要塞は炎の尾を引き、夜の海へ墜ちた。ホロウの最期の機動を見て、デイビッドが呟く。「あの旋回…あいつが、俺に教えた型だ」。生存者を示す信号が、残骸の中で明滅していた。',
 rad:['夜間戦闘。計器とレーダーを信じて。','ブルースカイ「要塞は高度2000m。ミサイルを撃ち込んで!」','機関砲は弾幕に近づきすぎないこと。'],
 ks:{3:'ブルースカイ「高速の機影!エースよ!」',6:'カイ「隊長、後ろを取られるな!」'},
 tk:{1:'デイビッド「要塞、沈んだ!…ホロウはどこだ!」'},
 intro:[CD(3,'MISSION 06','空中要塞ノクターン'),
  K(5.5,[-60,6,70],[-20,3,40],0,0,2,AW,'夜間、母艦級の影が一つ。重装甲よ。\nミサイルを惜しまないで。'),
  KF('g',5.5,[35,6,-80],[-5,4,-150],1,1,0,MR,'……学習完了。対象:ソラリス1。\n再現を開始する。',1),
  K(4.5,[0,7,55],[0,12,100],0,0,2,CMD,'ソラリス隊、夜明けまで生き残れ。\n全機、出撃!')],
 outro:[K(5.5,[40,4,60],[0,3,30],0,0,0,S2,'残骸の中に、生命反応が…!\n人が、います。生きています!'),
  K(5,[30,5,60],[0,4,30],0,0,0,AW,'救出したのは、ホークアイ5番機。…でも、彼が言うの。\n「最後の兵器が動き出す。夜明けと同時にだ」と。')]},
{n:'無人艦隊',sub:'Hollow Armada',ch:'第七章 空洞',tod:'dusk',bio:'isles',fac:'g',tot:10,conc:5,gnd:1,shp:['cv','dd','dd'],bmb:16,spd:[230,252],hp:130,msl:18,alt:1900,
 story:'ミラージュは最後の手を打った。無人の旗艦「ホロウ・ヴァルハラ」を中心とする無人艦隊が、沿岸砲台とともに港湾都市へ迫る。空・海・陸の同時攻撃。旗艦は頑丈だ。爆弾を集中させ、艦隊を殲滅せよ。ファントムの連携は、これまでで最も洗練されている。',
 obj:'目標: 旗艦と護衛駆逐艦2隻、沿岸基地を壊滅させ、敵機10機を撃墜せよ。',
 deb:'旗艦が海に沈み、無人艦隊は潰走した。通信席のホークアイが静かに言う。「ミラージュは追い詰められた。奴は最後に、夜明けの光で全てを焼くつもりだ」。',
 rad:['総力戦だ。全機、空と海と陸を同時に叩け。','ブルースカイ「旗艦は爆弾の集中攻撃で沈められるわ」'],
 ks:{5:'デイビッド「半分落とした!押し切れ!」'},
 tk:{1:'カイ「護衛艦1隻、撃沈!」',4:'ブルースカイ「旗艦、炎上!…沈むわ!」'},
 intro:[CD(3,'MISSION 07','無人艦隊'),
  K(5.5,[70,10,70],[20,4,30],0,0,2,AW,'無人艦隊が全艦出撃。\nここで止められなければ、港は火の海よ。'),
  KF('g',5.5,[30,6,-90],[-10,4,-160],1,4,0,CMD,'ソラリス隊、これが決戦の前哨戦だ。\n全員、生きて帰れ!')],
 outro:[K(5.5,[-40,5,60],[0,3,30],2,0,2,AW,'艦隊、全滅。でも…軌道上のエネルギー反応が急上昇してる。\nミラージュが、最後の兵器を起動したわ!')]},
{n:'最終作戦 夜明け',sub:'The Phantom Sky',ch:'最終章 無音の空',tod:'night',todTo:'dawn',dl:360,bio:'isles',fac:'g',tot:12,conc:5,shp:['dd','dd'],sup:'lance',ace:700,acn:'ミラージュ',bmb:16,spd:[232,255],hp:135,msl:20,alt:2000,ai:1.05,
 story:'ミラージュは自らの演算核を、熱線砲「ミラージュ・アーク」に統合した。日の出の瞬間、その光はCAPMF本部と港湾都市を貫く。夜明けまでに、砲とその護衛艦隊を沈めよ。ミラージュ本体は、ソラリス1の飛行記録を完全に学習した「鏡」として襲ってくる。己の飛び方を超えろ。作戦名「ザ・ファントム・スカイ」。',
 obj:'目標: シールド発生器を破壊し、ミラージュ・アークを沈黙させ、敵機12機(エース含む)を撃墜せよ。夜明けまでに!',
 deb:'ミラージュ・アークは光の柱とともに崩壊した。地平線の向こうから、最初の陽光が差し込む。夜は、終わった。',
 rad:['全機、これが最後の出撃だ。','ホークアイ「ソラリス1、聞こえるか。ミラージュは、お前の弱点を知っている。だが、お前にはまだ見せていない飛び方があるはずだ」','ブルースカイ「夜明けまでの時間が空に出てるわ。急いで!」'],
 ks:{5:'ミラージュ「ソラリス1。あなたの癖は、すべて記録した」',9:'ホークアイ「あと少しだ、ソラリス1!お前の飛び方で飛べ!」'},
 tk:{1:'ブルースカイ「シールド1基沈黙!」',3:'デイビッド「シールド全壊!ミラージュ・アークを叩け!」'},
 intro:[CD(3,'FINAL MISSION','ザ・ファントム・スカイ'),
  K(5.5,[70,10,70],[20,4,30],0,0,2,AW,'夜明けまで、あと数分。\nミラージュ・アークが日の出と同時に発射されるわ。'),
  KF('g',6,[30,6,-90],[-10,4,-160],1,5,0,MR,'あなたの全てを、再現する。\n夜明けの空で、決着をつけましょう。',1),
  K(4.5,[0,7,55],[0,12,100],0,0,2,CMD,'ソラリス1、夜明けを取り戻せ。\nホークアイの翼とともに、行け!')],
 outro:[K(6,[-40,5,60],[0,3,30],2,0,2,AW,'ミラージュ・アーク、消滅!全ファントム、機能停止!\nやったわ…ソラリス隊!')]}
];

/* ---------- jet model (nose toward -Z) ---------- */
function makeJet(body,accent,trim){
  const g=new THREE.Group(); trim=trim||accent;
  const m=new THREE.MeshStandardMaterial({color:body,roughness:.42,metalness:.45,flatShading:false});
  const a=new THREE.MeshStandardMaterial({color:accent,roughness:.5,metalness:.25,flatShading:true});
  const t=new THREE.MeshStandardMaterial({color:trim,roughness:.4,metalness:.3,flatShading:true});
  const dk=new THREE.MeshStandardMaterial({color:0x14181d,roughness:.7,metalness:.3});
  const prof=[[0,-9.2],[.35,-8.2],[.8,-6.4],[1.15,-4],[1.4,-1.2],[1.5,1.5],[1.45,4.4],[1.25,6.6],[.95,7.6],[0,7.8]].map(p=>new THREE.Vector2(p[0],p[1]));
  const fg=new THREE.LatheGeometry(prof,14); fg.rotateX(Math.PI/2); fg.scale(1,.78,1);
  g.add(new THREE.Mesh(fg,m));
  const root=new THREE.Shape(); [[.9,-6],[3.2,.8],[3.2,3.6],[.9,3.6],[-.9,3.6],[-3.2,3.6],[-3.2,.8],[-.9,-6]].forEach((p,i)=>i?root.lineTo(p[0],p[1]):root.moveTo(p[0],p[1]));
  const rg=new THREE.ExtrudeGeometry(root,{depth:.22,bevelEnabled:false}); rg.translate(0,0,-.11); rg.rotateX(Math.PI/2); g.add(new THREE.Mesh(rg,m));
  const sh=new THREE.Shape(); [[.8,-.5],[8.6,4.6],[8.6,5.8],[1.2,5.2],[-1.2,5.2],[-8.6,5.8],[-8.6,4.6],[-.8,-.5]].forEach((p,i)=>i?sh.lineTo(p[0],p[1]):sh.moveTo(p[0],p[1]));
  const wg=new THREE.ExtrudeGeometry(sh,{depth:.3,bevelEnabled:true,bevelSize:.08,bevelThickness:.06,bevelSegments:1}); wg.translate(0,0,-.15); wg.rotateX(Math.PI/2);
  g.add(new THREE.Mesh(wg,a));
  for(const s of[-1,1]){
    const st=new THREE.Mesh(new THREE.BoxGeometry(2.6,.34,.7),t); st.position.set(s*6.2,0,4.6); st.rotation.y=s*.5; g.add(st);
    const tipL=new THREE.Mesh(new THREE.SphereGeometry(.28,6,6),new THREE.MeshBasicMaterial({color:s>0?0x44ff77:0xff4455,fog:false})); tipL.position.set(s*8.6,0,5.2); g.add(tipL);
    const ms=new THREE.Mesh(new THREE.CylinderGeometry(.22,.22,3.6,6).rotateX(Math.PI/2),new THREE.MeshStandardMaterial({color:0xdfe5ea,roughness:.5})); ms.position.set(s*4.2,-.55,2.4); g.add(ms);
    const mt=new THREE.Mesh(new THREE.ConeGeometry(.22,.8,6).rotateX(-Math.PI/2),dk); mt.position.set(s*4.2,-.55,.4); g.add(mt);
    const cn=new THREE.Mesh(new THREE.BoxGeometry(2.6,.14,1.5),a); cn.position.set(s*2.2,.1,-3.4); cn.rotation.y=s*.55; g.add(cn);
    const tl=new THREE.Mesh(new THREE.BoxGeometry(.22,3.6,2.8),a); tl.position.set(s*1.5,1.9,5.6); tl.rotation.z=-s*.3; tl.rotation.x=.1; g.add(tl);
    const hs=new THREE.Mesh(new THREE.BoxGeometry(3.4,.16,2.1),m); hs.position.set(s*2.9,-.1,6.4); hs.rotation.y=-s*.28; g.add(hs);
    const it=new THREE.Mesh(new THREE.BoxGeometry(1.3,1.1,3.2),m); it.position.set(s*1.5,-.35,-.8); g.add(it);
    const ih=new THREE.Mesh(new THREE.BoxGeometry(1.0,.8,.3),dk); ih.position.set(s*1.5,-.35,-2.45); g.add(ih);
    const nz=new THREE.Mesh(new THREE.CylinderGeometry(.62,.8,1.6,10).rotateX(Math.PI/2),dk); nz.position.set(s*.85,0,7.9); g.add(nz);
  }
  const cp=new THREE.Mesh(new THREE.SphereGeometry(1,14,10),new THREE.MeshStandardMaterial({color:0x0b2a44,roughness:.08,metalness:.9,emissive:0x061826}));
  cp.scale.set(.78,.6,2.4); cp.position.set(0,.95,-2.6); g.add(cp);
  const fl=new THREE.Group();
  for(const s of[-1,1]){
    const c1=new THREE.Mesh(new THREE.ConeGeometry(.55,5.4,8).rotateX(Math.PI/2),new THREE.MeshBasicMaterial({color:0xffa44a,transparent:true,opacity:.85,fog:false})); c1.position.set(s*.85,0,2.7);
    const c2=new THREE.Mesh(new THREE.ConeGeometry(.3,3,8).rotateX(Math.PI/2),new THREE.MeshBasicMaterial({color:0xfff3c0,transparent:true,opacity:.95,fog:false})); c2.position.set(s*.85,0,1.5);
    fl.add(c1,c2);
  }
  fl.position.set(0,0,8.6); g.add(fl); g.userData.flame=fl;
  g.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  return g;
}
/* g = ファントム(黒+ティール発光) */
const FAC={o:[0x4a5240,0x8a2a24,0xd9c46a],s:[0x2c3548,0x6a2f86,0xd8d8e0],g:[0x15181d,0x23423f,0x3affc8],ace:[0x0c0d10,0xe0e6ee,0xff3a4a],sol:[0xdfe8f0,0x2f6fb5,0xffb347],wing:[0xdfe8f0,0x2f6fb5,0x8fe3ff]};
const facJet=(k)=>makeJet(FAC[k][0],FAC[k][1],FAC[k][2]);
const playerMesh=makeJet(0xdfe8f0,0x2f6fb5,0xffb347); scene.add(playerMesh);

/* ---------- audio ---------- */
let AC=null,eng=null,noiseBuf=null,muted=false;
function initAudio(){
  if(AC){ if(AC.state==='suspended')AC.resume(); return; }
  try{
    AC=new (window.AudioContext||window.webkitAudioContext)();
    noiseBuf=AC.createBuffer(1,AC.sampleRate*2,AC.sampleRate);
    const d=noiseBuf.getChannelData(0); for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
    const o1=AC.createOscillator(),o2=AC.createOscillator(),f=AC.createBiquadFilter(),gn=AC.createGain();
    o1.type='sawtooth';o2.type='square';f.type='lowpass';f.frequency.value=520;gn.gain.value=0;
    o1.connect(f);o2.connect(f);f.connect(gn);gn.connect(AC.destination);o1.start();o2.start();
    eng={o1,o2,f,gn};
  }catch(e){AC=null;}
}
function noise(dur,type,freq,vol,sweepTo){
  if(!AC||muted)return;
  const s=AC.createBufferSource(),f=AC.createBiquadFilter(),gn=AC.createGain(),t=AC.currentTime;
  s.buffer=noiseBuf; s.playbackRate.value=rnd(.8,1.2); f.type=type; f.frequency.setValueAtTime(freq,t);
  if(sweepTo)f.frequency.exponentialRampToValueAtTime(sweepTo,t+dur);
  gn.gain.setValueAtTime(vol,t); gn.gain.exponentialRampToValueAtTime(.001,t+dur);
  s.connect(f);f.connect(gn);gn.connect(AC.destination);s.start(t,rnd(0,1),dur+.05);
}
function beep(freq,dur,vol){
  if(!AC||muted)return;
  const o=AC.createOscillator(),gn=AC.createGain(),t=AC.currentTime;
  o.type='square';o.frequency.value=freq;gn.gain.setValueAtTime(vol,t);gn.gain.exponentialRampToValueAtTime(.001,t+dur);
  o.connect(gn);gn.connect(AC.destination);o.start(t);o.stop(t+dur+.02);
}
function engineSound(thr,on){
  if(!eng)return;
  const v=(on&&!muted)?.045+thr*.04:0, t=AC.currentTime;
  eng.gn.gain.setTargetAtTime(v,t,.1); eng.o1.frequency.setTargetAtTime(62+thr*70,t,.1);
  eng.o2.frequency.setTargetAtTime(31+thr*35,t,.1); eng.f.frequency.setTargetAtTime(380+thr*500,t,.1);
}

/* ---------- state ---------- */
let phase='menu',P=null,S=null,enemies=[],bullets=[],missiles=[],parts=[];
let invert=false,fwd=new V3(0,0,-1),camPos=new V3(),camUp=new V3(0,1,0);
const lock={cand:null,t:0,locked:false,was:false};
const keys={};
let mi=0,M=MS[0],CV=null,cact=[],vidEl=null;
const bk=()=>'bsOnlineBest'+(mi||'');
const progGet=()=>{try{return +localStorage.getItem('bsOnlineProg')||1;}catch(e){return 1;}};
const progSet=v=>{try{localStorage.setItem('bsOnlineProg',String(v));}catch(e){}};
const bestGet=()=>{try{return +localStorage.getItem(bk())||0;}catch(e){return 0;}};
const bestSet=v=>{try{localStorage.setItem(bk(),String(v));}catch(e){}};
const bulletGeo=new THREE.BoxGeometry(.5,.5,14);
const bulletMatP=new THREE.MeshBasicMaterial({color:0xfff2a0,fog:false});
const bulletMatE=new THREE.MeshBasicMaterial({color:0xff6a4a,fog:false});
const missGeo=new THREE.BoxGeometry(.9,.9,9);
const missMat=new THREE.MeshStandardMaterial({color:0xe8eef2,roughness:.5});
const missMatE=new THREE.MeshStandardMaterial({color:0xffb0a0,emissive:0x802010,roughness:.5});

function radio(text,delay){ S.radioQ.push({t:S.time+(delay||0),text}); }
const fmtTime=t=>{const m=Math.floor(t/60),s=Math.floor(t%60);return m+':'+String(s).padStart(2,'0');};

/* ---------- particles ---------- */
function addPart(pos,o){
  const mat=new THREE.SpriteMaterial({map:GLOW,color:o.col,transparent:true,depthWrite:false,
    blending:o.add?THREE.AdditiveBlending:THREE.NormalBlending,opacity:o.op});
  const sp=new THREE.Sprite(mat); sp.position.copy(pos); sp.scale.setScalar(o.s0); scene.add(sp);
  parts.push({sp,mat,life:o.life,max:o.life,s0:o.s0,s1:o.s1,op:o.op,vel:o.vel||null});
}
function explode(pos,size){
  size=size||1;
  addPart(pos,{col:0xfff0c0,add:true,s0:40*size,s1:260*size,life:.45,op:1});
  for(let i=0;i<9;i++)addPart(pos.clone().add(new V3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).multiplyScalar(14*size)),
    {col:i%2?0xff8a30:0xffc060,add:true,s0:20*size,s1:rnd(90,170)*size,life:rnd(.6,1.1),op:.95,vel:new V3(rnd(-1,1),rnd(-.5,1),rnd(-1,1)).multiplyScalar(30*size)});
  for(let i=0;i<6;i++)addPart(pos.clone().add(new V3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).multiplyScalar(18*size)),
    {col:0x3a3a3a,add:false,s0:30*size,s1:rnd(140,230)*size,life:rnd(1.8,3),op:.55,vel:new V3(rnd(-1,1),rnd(0,1.2),rnd(-1,1)).multiplyScalar(22*size)});
  noise(1.3,'lowpass',500,.6*Math.min(size,1.5),90);
}
function updateParts(dt){
  for(let i=beams.length-1;i>=0;i--){ const b=beams[i]; b.life-=dt; if(b.life<=0){scene.remove(b.m);b.m.geometry.dispose();b.m.material.dispose();beams.splice(i,1);continue;} b.m.material.opacity=.9*(b.life/b.max); const w=.6+.6*(b.life/b.max); b.m.scale.set(w,1,w); }
  for(let i=parts.length-1;i>=0;i--){
    const p=parts[i]; p.life-=dt;
    if(p.life<=0){scene.remove(p.sp);p.mat.dispose();parts.splice(i,1);continue;}
    const k=1-p.life/p.max;
    p.sp.scale.setScalar(lerp(p.s0,p.s1,Math.sqrt(k)));
    p.mat.opacity=p.op*(1-k);
    if(p.vel)p.sp.position.addScaledVector(p.vel,dt);
  }
}

/* ---------- bullets & missiles ---------- */
function addBullet(pos,vel,owner,life){
  const m=new THREE.Mesh(bulletGeo,owner==='p'?bulletMatP:bulletMatE);
  m.position.copy(pos); m.lookAt(pos.clone().add(vel)); scene.add(m);
  bullets.push({m,pos:m.position,vel,owner,life:life||1.6});
}
function fireMissile(){
  if(!P.msl||P.mslT>0||P.dead)return;
  P.msl--; P.mslT=.45; P.side*=-1;
  const off=new V3(P.side*5,-1.2,1).applyQuaternion(P.q).add(P.pos);
  const m=new THREE.Mesh(missGeo,missMat); scene.add(m);
  const target=lock.locked?lock.cand:null;
  missiles.push({m,pos:off.clone(),dir:fwd.clone(),speed:P.speed,target,life:7,puff:0});
  noise(.6,'bandpass',1200,.25,300);
  if(!target)S.msgT=Math.min(S.msgT,0);
}
function removeAll(){ for(const b of beams){scene.remove(b.m);} beams=[]; for(const t of tg)scene.remove(t.mesh); tg=[]; for(const b of bombs)scene.remove(b.m); bombs=[];
  for(const e of enemies)scene.remove(e.mesh); enemies=[];
  for(const b of bullets)scene.remove(b.m); bullets=[];
  for(const m of missiles)scene.remove(m.m); missiles=[];
  for(const m of emis)scene.remove(m.m); emis=[];
  for(const p of parts){scene.remove(p.sp);p.mat.dispose();} parts=[];
}

/* ---------- enemy missiles / flares ---------- */
function flareFx(pos,col){
  for(let i=0;i<5;i++)addPart(pos.clone().add(new V3(rnd(-4,4),rnd(-3,0),rnd(-4,4))),
    {col:col||0xfff2b0,add:true,s0:26,s1:70,life:rnd(1,1.8),op:1,vel:new V3(rnd(-18,18),rnd(-20,-6),rnd(-18,18))});
}
function dropFlare(){
  if(!P||P.dead||S.result||P.fl<=0||P.flT>0)return;
  P.fl--; P.flT=.5; flareFx(P.pos.clone().addScaledVector(fwd,-12)); noise(.25,'highpass',2500,.1);
  for(const m of emis){
    if(m.hom&&m.pos.distanceToSquared(P.pos)<2600*2600&&Math.random()<.72){
      m.hom=false; m.dir.add(new V3(rnd(-.4,.4),rnd(-.3,.3),rnd(-.4,.4))).normalize();
    }
  }
}
function enemyFlare(e){
  e.fcd=rnd(2.5,4); flareFx(e.pos.clone(),0xffd890);
  for(const m of missiles)if(m.target===e&&Math.random()<.5)m.target=null;
  if(lock.cand===e&&Math.random()<.5){lock.t=0;lock.locked=false;}
}
function fireEMissile(e,f2){
  const m=new THREE.Mesh(missGeo,missMatE), pos=e.pos.clone().addScaledVector(f2,12); m.position.copy(pos); scene.add(m);
  emis.push({m,pos,dir:f2.clone(),speed:e.speed*e.cs+80,life:8,hom:true,puff:0,dmg:26});
  e.mcd=rnd(5,8)/DF.ai; noise(.5,'bandpass',1000,.2,300);
  if(!S.mslHint){S.mslHint=1;radio('ブルースカイ「ミサイル警報!Zキーでフレア、旋回で回避!」');}
}
function updateEMissiles(dt){
  for(let i=emis.length-1;i>=0;i--){
    const m=emis[i]; m.life-=dt; m.speed=Math.min(470,m.speed+300*dt);
    if(m.hom&&!P.dead){
      const des=P.pos.clone().addScaledVector(fwd,P.speed*.25).sub(m.pos).normalize();
      const ang=m.dir.angleTo(des); m.dir.lerp(des,Math.min(1,(1.5*DF.ai*dt)/Math.max(ang,1e-4))).normalize();
    }
    m.pos.addScaledVector(m.dir,m.speed*dt); m.m.position.copy(m.pos); m.m.lookAt(m.pos.clone().add(m.dir));
    m.puff-=dt; if(m.puff<=0){ m.puff=.04; addPart(m.pos.clone().addScaledVector(m.dir,-6),{col:0xe8d0c8,add:false,s0:8,s1:30,life:1,op:.45}); }
    let hit=false;
    if(!P.dead&&m.pos.distanceToSquared(P.pos)<30*30){ damage(m.dmg); explode(m.pos.clone(),1.2); hit=true; }
    if(hit||m.life<=0||m.pos.y<heightAt(m.pos.x,m.pos.z)){
      if(!hit)explode(m.pos.clone(),.5);
      scene.remove(m.m); emis.splice(i,1);
    }
  }
}

/* ---------- enemies ---------- */
const mtx=new THREE.Matrix4(),tmpQ=new Q(),tmpQ2=new Q();
function lookQ(dir,out){ mtx.lookAt(ZERO,dir,UP); return out.setFromRotationMatrix(mtx); }
function spawnEnemy(first){
  const base=new V3(0,0,-1).applyQuaternion(P.q); base.y=0; base.normalize();
  const a=first?rnd(-.8,.8):rnd(0,Math.PI*2), d=first?rnd(3200,4800):rnd(5000,7500);
  const dir=base.applyAxisAngle(UP,a);
  const pos=P.pos.clone().addScaledVector(dir,d);
  pos.x=clamp(pos.x,-14000,14000); pos.z=clamp(pos.z,-14000,14000);
  pos.y=Math.max(heightAt(pos.x,pos.z)+600,P.pos.y+rnd(-500,400));
  const ace=!!M.ace&&S.spawned===S.total-1;
  const fk=ace?'ace':(M.fac||'g'); const mesh=facJet(fk); if(ace)mesh.scale.setScalar(1.2); mesh.position.copy(pos); scene.add(mesh);
  const id=++S.spawned;
  const e={ace,mhp:Math.round((ace?M.ace:M.hp)*DF.hp),pos:mesh.position,q:mesh.quaternion,mesh,speed:(ace?rnd(240,255):rnd(M.spd[0],M.spd[1]))*DF.spd,hp:Math.round((ace?M.ace:M.hp)*DF.hp),
    mode:'attack',t:rnd(3,7),pause:rnd(0,1),burst:10,cd:0,id,role:id%2,side:(id%4<2?1:-1),k:rnd(.93,1.1),cs:1,fcd:rnd(0,3),mcd:rnd(4,9),jt:0,jv:new V3(0,1,0),ev:new V3(0,1,0)};
  lookQ(P.pos.clone().sub(pos).normalize(),e.q);
  enemies.push(e);
  if(ace)radio('敵エース接近!コードネーム「'+(M.acn||'ファントム')+'」だ!');
}
function killEnemy(e){
  explode(e.pos.clone(),1.1); scene.remove(e.mesh);
  enemies.splice(enemies.indexOf(e),1);
  if(lock.cand===e){lock.cand=null;lock.t=0;lock.locked=false;}
  for(const m of missiles)if(m.target===e)m.target=null;
  S.kills++; S.score+=1000;
  const left=S.total-S.kills;
  if(allDone()){ endGame(true); }
  else if(M.ks&&M.ks[S.kills])radio(M.ks[S.kills]);
  else radio(S.kills===1?'デイビッド「1機撃墜。だが油断するな、こいつらは学習する」':(left>0?'撃墜を確認。残り'+left+'機。':'敵機は全滅。残る目標を叩け!'));
}
/* 高度な敵AI:
   - 機動目標の偏差予測 (プレイヤーの旋回の変化量まで読む)
   - ブーム&ズーム (一撃離脱) / ヨーヨー
   - 僚機による挟撃 (flank) で背後を取りに来る
   - 狙われたら不規則な回避機動 (jink)、ミサイルにはノッチ旋回+フレア
   - 正面を向けたらミサイルを発射、機関砲は予測弾道で連射 */
function updateEnemies(dt){
  const AI=DF.ai*(M.ai||1);
  for(const e of enemies){
    const toP=P.pos.clone().sub(e.pos), d=Math.max(1,toP.length()), nTo=toP.clone().divideScalar(d);
    const eF=new V3(0,0,-1).applyQuaternion(e.q);
    const eAim=eF.dot(nTo), pAim=-fwd.dot(nTo), six=fwd.dot(nTo)>.35;
    e.t-=dt; e.fcd-=dt; e.mcd-=dt;
    let inc=null;
    for(const m of missiles){ if(m.target===e){ const dm=m.pos.distanceTo(e.pos); if(dm<2200&&(!inc||dm<inc.dm))inc={m,dm}; } }
    let md=e.mode;
    if(inc&&inc.dm<1900){ md='notch'; e.t=.5; }
    else if(md==='notch'){ md='attack'; e.t=rnd(2,4); }
    if(md!=='notch'&&md!=='extend'&&md!=='jink'){
      if(d<230||(eAim<-.1&&d<1000&&pAim<.85)){ md='extend'; e.t=rnd(1.3,2.3); e.ev=new V3(rnd(-1,1),rnd(.2,.9),rnd(-1,1)).normalize(); }
      else if(pAim>.9&&d<2200&&d>300&&!six&&(eAim<.2||Math.random()<dt*1.6*AI)){ md='jink'; e.t=rnd(.8,1.5); e.jt=0; }
    }
    if(e.t<=0&&md!=='notch'){
      if(e.role===1&&md!=='flank'&&d>1300){ md='flank'; e.t=rnd(3.5,5.5); }
      else { md='attack'; e.t=rnd(5,9); }
    }
    if(md==='flank'&&six&&d<1600){ md='attack'; e.t=rnd(4,7); }
    e.mode=md;
    let des,sp=1,rate=1.75;
    if(md==='attack'){
      const tt=Math.min(d/(e.speed+260),2.2), pr=fwd.clone().addScaledVector(S.dfw,tt*.9*AI).normalize(), kk=d<600?.35:1;
      des=P.pos.clone().addScaledVector(pr,P.speed*tt*kk).sub(e.pos).normalize(); sp=d>2600?1.15:1;
    } else if(md==='flank'){
      const Rr=new V3().crossVectors(fwd,UP); if(Rr.lengthSq()<1e-4)Rr.set(1,0,0); Rr.normalize();
      des=P.pos.clone().addScaledVector(fwd,P.speed*.8-1000).addScaledVector(Rr,e.side*(300+d*.2)).sub(e.pos).normalize(); rate=1.5; sp=1.12;
    } else if(md==='extend'){ des=e.ev.clone(); rate=1.3; sp=1.25; }
    else if(md==='jink'){
      e.jt-=dt; if(e.jt<=0){ e.jt=rnd(.25,.5); const v=new V3(rnd(-1,1),rnd(-1,1),rnd(-1,1)); v.addScaledVector(nTo,-v.dot(nTo)); e.jv=v.normalize(); }
      des=e.jv.clone().addScaledVector(nTo,.2).normalize(); rate=2.3; sp=.93;
    } else {
      const md2=inc?inc.m.dir:nTo; des=new V3().crossVectors(md2,UP).multiplyScalar(e.side);
      if(des.lengthSq()<1e-4)des.set(1,0,0); des.normalize(); des.y-=.15; des.normalize(); rate=2.6; sp=.95;
      if(inc&&e.fcd<=0&&inc.dm<1500)enemyFlare(e);
    }
    const g=heightAt(e.pos.x,e.pos.z);
    if(e.pos.y<g+500){des.y=Math.max(des.y,.7);des.normalize();}
    if(e.pos.y>5600){des.y=Math.min(des.y,-.3);des.normalize();}
    if(Math.abs(e.pos.x)>14500||Math.abs(e.pos.z)>14500){des.copy(e.pos).negate().setY(0).normalize();}
    lookQ(des,tmpQ);
    const side=new V3().crossVectors(eF,des).y;
    tmpQ.multiply(tmpQ2.setFromAxisAngle(new V3(0,0,1),clamp(side*3,-1,1)*1.0));
    e.q.rotateTowards(tmpQ,rate*AI*e.k*(e.ace?1.25:1)*dt);
    e.cs+=(sp-e.cs)*Math.min(1,dt*.8);
    const f2=new V3(0,0,-1).applyQuaternion(e.q);
    e.pos.addScaledVector(f2,e.speed*e.cs*dt);
    e.mesh.userData.flame.scale.z=1+Math.sin(S.time*40+e.id)*.15;
    /* gunfire: predictive aim with the player's turn trend */
    const tt2=d/(e.speed*e.cs+1200);
    const aimPt=P.pos.clone().addScaledVector(fwd,P.speed*tt2).addScaledVector(S.dfw,P.speed*tt2*tt2*.3*AI);
    const aimDir=aimPt.sub(e.pos).normalize(), ang=f2.angleTo(aimDir);
    if(e.pause>0)e.pause-=dt;
    else if((md==='attack'||md==='flank')&&d<1500&&ang<.06+.02*AI&&!P.dead){
      e.cd-=dt;
      if(e.cd<=0){
        e.cd=.07; e.burst--;
        const dirB=f2.clone().lerp(aimDir,.6).normalize();
        const v=dirB.multiplyScalar(e.speed*e.cs+1200).add(new V3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).multiplyScalar(10/AI));
        addBullet(e.pos.clone().addScaledVector(f2,10),v,'e',1.4);
        if(e.burst<=0){e.pause=rnd(.5,1.3)/AI;e.burst=Math.floor(rnd(10,18));}
      }
    }
    /* missile launch when the nose is on the player */
    if(md==='attack'&&e.mcd<=0&&eAim>.93&&d>1100&&d<4800&&!P.dead&&emis.length<6)fireEMissile(e,f2);
    if(!P.dead&&d<18){ damage(35); killEnemy(e); return; }
  }
}

/* ---------- BS2: 地上目標 / 艦船 / 爆弾 / 僚機 ---------- */
let tg=[],bombs=[],beams=[],emis=[];
const bombGeo=new THREE.CylinderGeometry(1.1,1.1,5,8).rotateX(Math.PI/2);
const bombMat=new THREE.MeshStandardMaterial({color:0x2a2f35,roughness:.6});
const wmesh=facJet('wing'); wmesh.visible=false; scene.add(wmesh);
const WM={cd:3,n:0};
const SM=c=>new THREE.MeshStandardMaterial({color:c,roughness:.7,flatShading:true});
const bx_=(w,h,d,c,x,y,z)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),SM(c));m.position.set(x,y,z);return m;};
const cy_=(r,h,c,x,y,z)=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,h,10),SM(c));m.position.set(x,y,z);return m;};
function shipMesh(L,k){
  const g=new THREE.Group(),w=L*.16,hh=L*.09;
  g.add(bx_(w,hh,L,0x6a737b,0,hh/2,0),bx_(w*1.02,L*.02,L*.98,0x23423f,0,L*.012,0));
  if(k==='cv'){ g.add(bx_(w*1.5,3,L*.96,0x4d555c,0,hh+1,0),bx_(10,26,28,0x7d868d,w*.6,hh+13,-L*.08),bx_(2.5,.5,L*.7,0x3affc8,0,hh+2.6,0)); }
  else if(k==='tr'){ [0x3f6f9e,0xb5651d,0x4a7c4a,0x9e3f3f].forEach((c,i)=>g.add(bx_(w*.8,10,16,c,0,hh+5,-L*.3+i*L*.2))); g.add(bx_(w*.8,18,14,0xdfe3e6,0,hh+9,L*.36)); }
  else { g.add(bx_(w*.65,10,L*.24,0x7d868d,0,hh+5,L*.05),cy_(2.5,8,0x444a50,0,hh+14,L*.1),bx_(3,3,16,0x444a50,0,hh+3,-L*.28)); }
  return g;
}
const TG={
 hangar:{nm:'格納庫',hp:160,r:34,sc:300,mk:()=>{const g=new THREE.Group();g.add(bx_(44,14,24,0x7a7f86,0,7,0),bx_(46,3,26,0x3d4148,0,15,0));return g;}},
 fuel:{nm:'燃料庫',hp:100,r:26,sc:300,fuel:1,mk:()=>{const g=new THREE.Group();g.add(cy_(11,18,0xcfd4d8,-12,9,0),cy_(11,18,0xcfd4d8,12,9,0));return g;}},
 radar:{nm:'演算ノード',hp:100,r:22,sc:300,mk:()=>{const g=new THREE.Group();g.add(bx_(4,20,4,0x666d75,0,10,0),cy_(10,2,0x3affc8,0,22,0));return g;}},
 aa:{nm:'対空砲',hp:130,r:20,sc:400,aa:1,gy:10,mk:()=>{const g=new THREE.Group();g.add(bx_(12,5,12,0x56603f,0,2.5,0),bx_(3,3,16,0x2d3139,0,8,-6));return g;}},
 gen:{nm:'シールド発生器',hp:220,r:24,sc:600,aa:1,gy:20,rng:1900,fr:.8,mk:()=>{const g=new THREE.Group();g.add(cy_(5,34,0x5a6470,0,17,0),bx_(16,4,16,0x30363d,0,2,0));const o=new THREE.Mesh(new THREE.SphereGeometry(8,12,10),new THREE.MeshBasicMaterial({color:0x58f0ff,fog:false}));o.position.y=40;g.add(o);return g;}},
 rail:{nm:'ラグナロク',hp:1700,r:75,sc:5000,sup:1,aa:1,gy:60,rng:2600,fr:.7,big:{per:9,spd:650,dmg:28},mk:()=>{const g=new THREE.Group();g.add(bx_(150,18,150,0x2b3036,0,9,0),cy_(46,26,0x4a525b,0,31,0));const br=new THREE.Group();br.add(bx_(12,12,190,0x7d8791,0,0,-95),bx_(20,20,40,0x3a4048,0,0,-8));br.position.y=60;g.add(br);const mz=new THREE.Mesh(new THREE.SphereGeometry(12,12,10),new THREE.MeshBasicMaterial({color:0xff5a3a,fog:false}));mz.position.set(0,60,-196);g.add(mz);g.userData.muz=mz;g.userData.aim=br;return g;}},
 core:{nm:'ミラージュ・コア',hp:2000,r:75,sc:6000,sup:1,aa:1,gy:60,rng:2800,fr:.9,big:{per:7.5,spd:700,dmg:30},mk:()=>TG.rail.mk()},
 fort:{nm:'ノクターン',hp:2400,r:150,sc:6000,sup:1,fly:1,aa:1,gy:30,rng:3300,fr:1.7,big:{per:11,spd:620,dmg:24},mk:()=>{const g=new THREE.Group();const hull=new THREE.Mesh(new THREE.SphereGeometry(1,16,12),SM(0x2f3438));hull.scale.set(52,22,170);g.add(hull);
   g.add(bx_(230,5,60,0x23272c,0,-4,20),bx_(30,14,70,0x4a5258,0,26,-20),bx_(110,3,18,0x23c8a0,0,-20,0));
   for(const s of[-1,1])for(let i=0;i<2;i++){const n=cy_(7,40,0x23272c,s*(60+i*55),-4,95+i*14);n.rotation.x=Math.PI/2;g.add(n);const f=new THREE.Mesh(new THREE.ConeGeometry(6,30,8).rotateX(Math.PI/2),new THREE.MeshBasicMaterial({color:0x58f0ff,transparent:true,opacity:.85,fog:false}));f.position.set(s*(60+i*55),-4,125+i*14);g.add(f);}
   for(let i=0;i<8;i++)g.add(cy_(4,10,0x30343a,(i%2?1:-1)*(14+(i>>1)*9),22,-70+(i>>1)*40));
   return g;}},
 lance:{nm:'ミラージュ・アーク',hp:2200,r:85,sc:8000,sup:1,aa:1,gy:80,rng:2800,fr:1.1,big:{per:6,spd:720,dmg:30},mk:()=>{const g=new THREE.Group();g.add(cy_(70,30,0x2a2f36,0,15,0),cy_(26,150,0x4a525b,0,105,0));const ring=new THREE.Mesh(new THREE.TorusGeometry(46,4,8,28),new THREE.MeshBasicMaterial({color:0x3affc8,fog:false}));ring.rotation.x=Math.PI/2;ring.position.y=60;g.add(ring);const cr=new THREE.Mesh(new THREE.OctahedronGeometry(22,0),new THREE.MeshBasicMaterial({color:0xb0fff0,fog:false}));cr.position.y=205;g.add(cr);g.userData.muz=cr;return g;}},
 dd:{nm:'無人駆逐艦',hp:380,r:62,sc:800,ship:1,aa:1,gy:20,L:90,sp:14},
 tr:{nm:'輸送船',hp:260,r:55,sc:500,ship:1,L:80,sp:11},
 cv:{nm:'無人旗艦',hp:1800,r:125,sc:3000,ship:1,aa:1,gy:30,L:230,sp:9}
};
const allDone=()=>S.kills>=S.total&&tg.length===0;
function findSpot(land,used){
  for(let k=0;k<700;k++){
    const a=rnd(-1,1),d=rnd(4200,9500),x=Math.sin(a)*d,z=-Math.cos(a)*d,h=rawH(x,z);
    const ok=land?(h>(k<450?90:20)&&Math.abs(rawH(x+120,z)-h)<70&&Math.abs(rawH(x,z+120)-h)<70):(h<-25&&rawH(x+300,z)<-5&&rawH(x,z+300)<-5&&rawH(x-300,z)<-5);
    if(ok&&used.every(u=>Math.hypot(u.x-x,u.z-z)>1800))return{x,z};
  }
  return{x:rnd(-1500,1500),z:-rnd(4500,6500)};
}
/* ---- super weapons: shields, charge-and-fire shells, flying fortress orbit ---- */
function bigShell(src,vel,dmg,life){
  const m=new THREE.Group();
  m.add(new THREE.Mesh(new THREE.SphereGeometry(7,10,8),new THREE.MeshBasicMaterial({color:0xff5030,fog:false})));
  const h=new THREE.Sprite(new THREE.SpriteMaterial({map:GLOW,color:0xff8a40,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,fog:false})); h.scale.setScalar(70); m.add(h);
  m.position.copy(src); scene.add(m);
  bullets.push({m,pos:m.position,vel,owner:'e',life,big:true,dmg});
}
function updSup(t,dt){
  const def=t.def;
  if(def.fly){
    if(!t.oc){t.oc={x:0,z:-5200};t.ang=Math.PI*.5;}
    t.ang+=dt*28/3200;
    t.pos.set(t.oc.x+Math.cos(t.ang)*3200,1900+Math.sin(S.time*.2)*60,t.oc.z+Math.sin(t.ang)*3200);
    t.mesh.rotation.y=Math.atan2(Math.sin(t.ang),-Math.cos(t.ang)); t.mesh.rotation.z=.08;
  } else if(t.mesh.userData.aim){ t.mesh.rotation.y=Math.atan2(-(P.pos.x-t.pos.x),-(P.pos.z-t.pos.z)); }
  if(!def.big||P.dead)return;
  const d=t.pos.distanceTo(P.pos);
  if(d>7800){t.chg=false;return;}
  t.ch=(t.ch==null?def.big.per*.6:t.ch)-dt; t.chg=t.ch<2.2;
  const mz=t.mesh.userData.muz, wp=new V3();
  if(mz)mz.getWorldPosition(wp); else wp.copy(t.pos).add(new V3(0,12,0));
  if(t.chg){
    t.pt=(t.pt||0)-dt;
    if(t.pt<=0){t.pt=.1;addPart(wp,{col:0xff6a40,add:true,s0:20,s1:120+(2.2-t.ch)*60,life:.45,op:.9});}
    if(mz&&mz.material)mz.scale.setScalar(1+(2.2-t.ch)*.5);
  }
  if(t.ch<=0){
    t.ch=def.big.per*rnd(.9,1.1); if(mz)mz.scale.setScalar(1);
    const tt=d/def.big.spd, aim=P.pos.clone().addScaledVector(fwd,P.speed*tt*.8).sub(wp).normalize();
    bigShell(wp,aim.multiplyScalar(def.big.spd),def.big.dmg,tt+2);
    noise(.9,'lowpass',700,.5,90); explode(wp.clone(),.6);
  }
}
function supSpot(kind){
  if(kind==='rail'||kind==='core'){
    let best=null,bh=-1;
    for(let a=0;a<6.28;a+=.2)for(const r of[900,1200,1500]){const x=Math.sin(a)*r,z=-6500+Math.cos(a)*r,h=heightAt(x,z);if(h>bh){bh=h;best={x,z};}}
    return best;
  }
  return findSpot(true,[]);
}
function spawnSupers(add){
  if(!M.sup)return;
  const k=M.sup;
  if(k==='fort'){ add('fort',0,1900,-2000,0); return; }
  const c=supSpot(k);
  add(k,c.x,Math.max(0,heightAt(c.x,c.z))+1,c.z,0);
  for(let i=0;i<3;i++){ const a=i*2.1+.6,x=c.x+Math.cos(a)*270,z=c.z+Math.sin(a)*270; add('gen',x,Math.max(0,heightAt(x,z))+1,z,0); }
}
function spawnTargets(){
  const used=[]; S.ng0=0; S.ns0=0; S.tk=0;
  const add=(k,x,y,z,ry,dir)=>{ const d=TG[k],m=d.ship?shipMesh(d.L,k):d.mk(); m.position.set(x,y,z); m.rotation.y=ry||0;
    m.traverse(o=>{if(o.isMesh)o.castShadow=o.receiveShadow=true;}); scene.add(m);
    const t={k,def:d,mesh:m,pos:m.position,hp:Math.round(d.hp*((d.ship||d.sup)?DF.hp:1)),r:d.r,ship:!!d.ship,dir:dir||null,cd:rnd(0,2),burst:6,wk:0}; t.mhp=t.hp;
    tg.push(t); if(t.ship)S.ns0++; else S.ng0++; };
  for(let b=0;b<(M.gnd||0);b++){ const c=findSpot(true,used); used.push(c);
    ['hangar','hangar','fuel','radar','aa','aa'].forEach((k,i)=>{ const a=i*1.05+rnd(0,.5),r=i?rnd(70,200):0,x=c.x+Math.cos(a)*r,z=c.z+Math.sin(a)*r; add(k,x,Math.max(0,heightAt(x,z))+1,z,rnd(0,3.14)); }); }
  if(M.shp){ const c=findSpot(false,used),dv=new V3(-c.x,0,-c.z).normalize(),ry=Math.atan2(-dv.x,-dv.z),sd=new V3(dv.z,0,-dv.x);
    M.shp.forEach((k,i)=>{ const o=(i%2?1:-1)*Math.ceil(i/2)*230,bk=i*160; add(k,c.x+sd.x*o-dv.x*bk,0,c.z+sd.z*o-dv.z*bk,ry,dv.clone()); }); }
  spawnSupers(add);
}
function updateTargets(dt){
  for(const t of tg){
    if(t.ship&&t.dir){
      if(Math.hypot(t.pos.x,t.pos.z)>2600&&rawH(t.pos.x+t.dir.x*320,t.pos.z+t.dir.z*320)<-10)t.pos.addScaledVector(t.dir,t.def.sp*dt);
      t.wk-=dt; if(t.wk<=0){t.wk=.5;addPart(t.pos.clone().addScaledVector(t.dir,-t.def.L*.5),{col:0xffffff,add:false,s0:12,s1:55,life:2.4,op:.3});}
    }
    if(t.def.sup)updSup(t,dt);
    if(t.def.aa&&!P.dead){
      const d=t.pos.distanceTo(P.pos); t.cd-=dt;
      if(d<(t.def.rng||(t.ship?2800:2400))&&d>300&&t.cd<=0){
        t.burst--; t.cd=(t.burst>0?.17:rnd(1.2,2.4))/(t.def.fr||1); if(t.burst<=0)t.burst=5+((Math.random()*4)|0);
        const src=t.pos.clone(); src.y+=t.def.gy||10; const tt=d/900;
        const aim=P.pos.clone().addScaledVector(fwd,P.speed*tt*.9).sub(src).normalize();
        addBullet(src,aim.multiplyScalar(900).add(new V3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).multiplyScalar(26*DF.spd)),'e',tt+.4);
      }
    }
  }
}
function dmgT(t,n){ if(tg.indexOf(t)<0)return; if(t.def.sup&&tg.some(o=>o.k==='gen')){ n*=.04; if(!S.shHint){S.shHint=1;radio('シールドが機能している!先に発生器を破壊して!');} } t.hp-=n; if(t.hp<=0)killTarget(t); }
function killTarget(t){
  const i=tg.indexOf(t); if(i<0)return; tg.splice(i,1); scene.remove(t.mesh);
  explode(t.pos.clone().add(new V3(0,8,0)),t.ship?Math.min(3.2,t.r/32):1.3);
  if(t.ship||t.def.fuel)for(let j=0;j<3;j++)addPart(t.pos.clone().add(new V3(rnd(-20,20),10,rnd(-20,20))),{col:0x222222,add:false,s0:50,s1:240,life:9,op:.5,vel:new V3(rnd(-4,4),16,rnd(-4,4))});
  if(t.def.sup)for(let j=1;j<=7;j++)setTimeout(()=>explode(t.pos.clone().add(new V3(rnd(-70,70),rnd(-10,50),rnd(-70,70))),2+Math.random()),j*260);
  if(t.def.fuel)for(const o of tg.slice())if(o.pos.distanceToSquared(t.pos)<90*90)dmgT(o,160);
  if(lock.cand===t){lock.cand=null;lock.t=0;lock.locked=false;}
  for(const m of missiles)if(m.target===t)m.target=null;
  S.tk=(S.tk||0)+1; S.score+=t.def.sc;
  if(allDone())endGame(true);
  else if(M.tk&&M.tk[S.tk])radio(M.tk[S.tk]);
  else if(S.radioQ.length<2)radio((t.ship?'艦船を撃沈!':'目標を破壊。')+'残り目標 '+tg.length);
}
function dropBomb(){
  if(P.dead||S.result||!(P.bmb>0)||P.bT>0)return;
  P.bmb--; P.bT=.5; const m=new THREE.Mesh(bombGeo,bombMat),pos=P.pos.clone(); pos.y-=3; m.position.copy(pos); scene.add(m);
  bombs.push({m,pos,vel:fwd.clone().multiplyScalar(P.speed*.98)}); noise(.15,'lowpass',400,.2);
}
function updateBombs(dt){
  if(P)P.bT-=dt;
  for(let i=bombs.length-1;i>=0;i--){
    const b=bombs[i]; b.vel.y-=120*dt; b.pos.addScaledVector(b.vel,dt); b.m.position.copy(b.pos); b.m.lookAt(b.pos.clone().add(b.vel));
    let hit=b.pos.y<=Math.max(0,heightAt(b.pos.x,b.pos.z))+2;
    if(!hit)for(const t of tg){ if(Math.hypot(b.pos.x-t.pos.x,b.pos.z-t.pos.z)<t.r*.7&&b.pos.y<t.pos.y+25){hit=true;break;} }
    if(hit){
      explode(b.pos.clone(),1.5); scene.remove(b.m); bombs.splice(i,1);
      for(const t of tg.slice()){ const d=b.pos.distanceTo(t.pos),n=700*clamp(1-(d-(t.r+10))/80,0,1); if(n>0)dmgT(t,n); }
    }
  }
}
function ccip(){
  const p=P.pos.clone(),v=fwd.clone().multiplyScalar(P.speed*.98);
  for(let i=0;i<260;i++){ v.y-=12; p.addScaledVector(v,.1); if(p.y<=Math.max(0,heightAt(p.x,p.z))+2)return p; }
  return null;
}
function updWM(dt){
  if(!wmesh.visible)return;
  const slot=new V3(-62,9,46).applyQuaternion(P.q).add(P.pos),w=wmesh.position;
  w.lerp(slot,1-Math.exp(-2.6*dt));
  let tgt=null,bd=2200*2200; for(const e of enemies){const d=e.pos.distanceToSquared(w); if(d<bd){bd=d;tgt=e;}}
  if(tgt){ lookQ(tgt.pos.clone().sub(w).normalize(),tmpQ); wmesh.quaternion.slerp(tmpQ,1-Math.exp(-3.5*dt)); }
  else wmesh.quaternion.slerp(P.q,1-Math.exp(-3*dt));
  wmesh.userData.flame.scale.z=1+Math.sin(S.time*40)*.15;
  WM.cd-=dt;
  if(tgt&&!P.dead&&WM.cd<=0&&bd<1500*1500){
    const f=new V3(0,0,-1).applyQuaternion(wmesh.quaternion);
    if(f.angleTo(tgt.pos.clone().sub(w))<.14){
      WM.n++; addBullet(w.clone().addScaledVector(f,8),f.clone().multiplyScalar(1700).add(new V3(rnd(-1,1),rnd(-1,1),rnd(-1,1)).multiplyScalar(55)),'p',1.1);
      WM.cd=.09; if(WM.n>=6){WM.n=0;WM.cd=rnd(3.5,6);}
    }
  }
}

/* ---------- player ---------- */
function damage(n){
  if(P.dead||phase!=='play'||S.result)return;
  P.hp=Math.max(0,P.hp-n*DF.dmg*(1-.08*HG.lv.arm)*(P.sh>0?.1:1)); S.hitT=.35;
  noise(.15,'lowpass',900,.3);
  if(P.hp<=0)crash('撃墜された');
  else if(P.hp<35&&!S.warnedHp){S.warnedHp=true;radio('デイビッド「1番機、煙を吹いてるぞ!無理するな!」');}
}
function crash(reason){
  if(P.dead)return; P.dead=true; P.hp=0;
  explode(P.pos.clone(),2); playerMesh.visible=false; endGame(false,reason);
}
function updatePlayer(dt){
  const inp={
    p:(keys.KeyS||keys.ArrowDown?1:0)-(keys.KeyW||keys.ArrowUp?1:0),
    r:(keys.KeyA||keys.ArrowLeft?1:0)-(keys.KeyD||keys.ArrowRight?1:0),
    y:(keys.KeyQ?1:0)-(keys.KeyE?1:0)
  };
  if(invert)inp.p*=-1;
  const k=Math.min(1,dt*7), s=P.s;
  s.p+=(inp.p-s.p)*k; s.r+=(inp.r-s.r)*k; s.y+=(inp.y-s.y)*k;
  if(keys.ShiftLeft||keys.ShiftRight)P.thr=Math.min(1,P.thr+dt*.5);
  if(keys.KeyC)P.thr=Math.max(0,P.thr-dt*.5);
  const out=Math.max(Math.abs(P.pos.x),Math.abs(P.pos.z));
  S.outside=out>15000;
  let pitchIn=s.p;
  if(P.pos.y>6500)pitchIn=Math.min(pitchIn,0)-1;
  tmpQ.setFromEuler(new THREE.Euler(pitchIn*1.25*dt,(s.y+s.r*.22)*.55*dt,s.r*2.7*dt,'XYZ'));
  P.q.multiply(tmpQ);
  if(Math.abs(inp.r)<.1){
    const right=new V3(1,0,0).applyQuaternion(P.q);
    P.q.multiply(tmpQ2.setFromAxisAngle(new V3(0,0,1),-right.y*1.1*dt));
  }
  if(S.outside){ lookQ(P.pos.clone().negate().setY(0).normalize(),tmpQ); P.q.rotateTowards(tmpQ,.55*dt); }
  P.q.normalize();
  fwd.set(0,0,-1).applyQuaternion(P.q);
  /* 敵AIが読む「旋回の傾向」: 機首方向の変化率 */
  { const raw=fwd.clone().sub(S.pf0).divideScalar(Math.max(dt,1e-3)); if(raw.length()>1.6)raw.setLength(1.6); S.dfw.lerp(raw,Math.min(1,dt*6)); S.pf0.copy(fwd); }
  const target=lerp(110,330,P.thr)-fwd.y*70;
  P.speed+=(target-P.speed)*Math.min(1,dt*.7);
  P.speed=clamp(P.speed,90,400);
  P.pos.addScaledVector(fwd,P.speed*dt);
  playerMesh.position.copy(P.pos); playerMesh.quaternion.copy(P.q);
  playerMesh.userData.flame.scale.set(1,1,.5+P.thr*1.1+Math.random()*.1);
  const g=heightAt(P.pos.x,P.pos.z); P.agl=P.pos.y-g;
  S.pullup=(P.agl+fwd.y*P.speed*3.2<70&&fwd.y<-.05);
  if(P.agl<7)crash(g>0?'地面に衝突した':'海面に衝突した');
  P.gunT-=dt; P.mslT-=dt; P.sh-=dt; P.spT-=dt; P.flT-=dt;
  if(P.msl<P.mmax&&!P.dead){ P.rg+=dt*(1+.25*HG.lv.reg); if(P.rg>=DF.rg){ P.rg=0; P.msl++; beep(900,.06,.05); } }
  if(keys.Space&&P.gunT<=0&&!P.dead){
    P.gunT=.07; P.side*=-1;
    const o=new V3(P.side*2.6,-.4,-4).applyQuaternion(P.q).add(P.pos);
    addBullet(o,fwd.clone().multiplyScalar(P.speed+1000),'p',1.5); noise(.05,'highpass',1800,.07);
  }
}

/* ---------- projectiles, lock ---------- */
function updateBullets(dt){
  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i]; b.life-=dt; b.pos.addScaledVector(b.vel,dt);
    let dead=b.life<=0;
    if(!dead&&b.owner==='p'){
      for(const e of enemies){
        if(b.pos.distanceToSquared(e.pos)<24*24){
          e.hp-=10; dead=true;
          addPart(b.pos.clone(),{col:0xffd080,add:true,s0:10,s1:40,life:.25,op:1});
          if(e.hp<=0){killEnemy(e);} break;
        }
      }
    if(!dead)for(const t of tg){ if(b.pos.distanceToSquared(t.pos)<(t.r*.75)*(t.r*.75)){ dmgT(t,t.ship?3:t.def.sup?8:6); dead=true; addPart(b.pos.clone(),{col:0xffd080,add:true,s0:10,s1:40,life:.25,op:1}); break; } }
    } else if(!dead&&b.owner==='e'&&!P.dead){
      if(b.pos.distanceToSquared(P.pos)<(b.big?48*48:20*20)){damage(b.big?b.dmg:2.4);if(b.big)explode(b.pos.clone(),1);dead=true;}
    }
    if(!dead&&b.pos.y<heightAt(b.pos.x,b.pos.z))dead=true;
    if(dead){scene.remove(b.m);bullets.splice(i,1);}
  }
}
function updateMissiles(dt){
  for(let i=missiles.length-1;i>=0;i--){
    const m=missiles[i]; m.life-=dt;
    m.speed=Math.min(560,m.speed+380*dt);
    if(m.target&&(enemies.indexOf(m.target)>=0||tg.indexOf(m.target)>=0)){
      const des=m.target.pos.clone().sub(m.pos).normalize();
      const ang=m.dir.angleTo(des), t=Math.min(1,(2.6*dt)/Math.max(ang,1e-4));
      m.dir.lerp(des,t).normalize();
    }
    m.pos.addScaledVector(m.dir,m.speed*dt);
    m.m.position.copy(m.pos); m.m.lookAt(m.pos.clone().add(m.dir));
    m.puff-=dt;
    if(m.puff<=0){ m.puff=.03;
      addPart(m.pos.clone().addScaledVector(m.dir,-6),{col:0xdde6ee,add:false,s0:8,s1:34,life:1.3,op:.5});
      addPart(m.pos.clone().addScaledVector(m.dir,-5),{col:0xffa050,add:true,s0:12,s1:5,life:.12,op:1}); }
    let hit=false;
    for(const e of enemies){ if(m.pos.distanceToSquared(e.pos)<34*34){ e.hp-=250; if(e.hp<=0)killEnemy(e); else explode(e.pos.clone(),.7); hit=true; break; } }
    if(!hit)for(const t of tg){ if(m.pos.distanceToSquared(t.pos)<(t.r+14)*(t.r+14)){ explode(m.pos.clone(),.8); dmgT(t,t.def.sup?260:150); hit=true; break; } }
    if(hit||m.life<=0||m.pos.y<heightAt(m.pos.x,m.pos.z)){
      if(!hit)explode(m.pos.clone(),.5);
      scene.remove(m.m); missiles.splice(i,1);
    }
  }
}
function updateLock(dt){
  let best=null,ba=1e9;
  for(const e of enemies.concat(tg)){
    const to=e.pos.clone().sub(P.pos), d=to.length(), ang=fwd.angleTo(to);
    if(d<3600&&ang<.42&&ang<ba){ba=ang;best=e;}
  }
  if(best!==lock.cand){lock.cand=best;lock.t=0;}
  else if(best)lock.t=Math.min(1,lock.t+dt/.9); else lock.t=0;
  lock.locked=!!lock.cand&&lock.t>=1;
  if(lock.locked&&!lock.was)beep(1100,.12,.08);
  lock.was=lock.locked;
}
function updateCamera(dt,snap){
  const want=new V3(0,7,38).applyQuaternion(P.q).add(P.pos);
  if(snap)camPos.copy(want); else camPos.lerp(want,1-Math.exp(-7*dt));
  camUp.lerp(new V3(0,1,0).applyQuaternion(P.q),1-Math.exp(-3*dt)).normalize();
  camera.position.copy(camPos); camera.up.copy(camUp);
  camera.lookAt(P.pos.clone().addScaledVector(fwd,140));
  camera.fov=60+clamp((P.speed-200)/200,-.3,1)*6; camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  sky.position.copy(camera.position); sunSpr.position.copy(camera.position).addScaledVector(sun.position.clone().normalize(),26000);
}

/* ---------- game flow ---------- */
function reset(){
  removeAll(); buildTerrain(M.bio||'isles');
  P={pos:new V3(0,M.alt||2300,0),q:new Q(),speed:210,thr:.6,hp:100,msl:M.msl+HG.lv.msl*2,mmax:M.msl+HG.lv.msl*2,rg:0,sh:0,sp:SP[HG.sw].n,spT:0,s:{p:0,r:0,y:0},dead:false,gunT:0,mslT:0,side:1,agl:2300,fl:10+HG.lv.flr*3,flT:0};
  S={time:0,score:0,kills:0,spawned:0,total:M.type==='survive'?999:M.tot,midDone:0,radioQ:[],msg:'',msgT:0,hitT:0,outside:false,pullup:false,warnedHp:false,reinf:false,endT:0,result:null,reason:'',dfw:new V3(),pf0:new V3(0,0,-1)};
  lock.cand=null;lock.t=0;lock.locked=false;lock.was=false;
  playerMesh.visible=true; fwd.set(0,0,-1);
  for(let i=0;i<Math.min(M.conc,M.tot);i++)spawnEnemy(true);
  P.bmb=M.bmb?M.bmb+HG.lv.bmb*2:0; P.bT=0; spawnTargets(); wmesh.visible=true; wmesh.position.copy(P.pos).add(new V3(-62,9,46)); wmesh.quaternion.copy(P.q); WM.cd=3; WM.n=0;
  M.rad.forEach((t,i)=>radio(t,.5+i*4.2)); applyTOD(M.tod);
  updateCamera(0,true);
}
function startGame(){
  initAudio(); reset(); applySpawn(); phase='play'; /*[BSO]*/
  layers();
}
function pauseGame(force){ if(phase!=='play')return; if(M.arena){ $('pause').hidden=force?false:!$('pause').hidden; return; } /*[BSO]*/ phase='pause'; $('pause').hidden=false; engineSound(0,false); }
function resumeGame(){ if(M.arena){ $('pause').hidden=true; return; } /*[BSO]*/ if(phase!=='pause')return; phase='play'; $('pause').hidden=true; initAudio(); last=performance.now(); }
function endGame(win,reason){
  if(S.result)return;
  S.result=win?'win':'lose'; S.reason=reason||''; S.endT=win?2.2:2.6;
  if(win){ S.score+=Math.max(0,Math.round((600-S.time)*5))+P.hp*10; radio(M.win||'全目標を撃破!見事だ、ソラリス1。'); S.score=Math.round(S.score*DF.sc); }
}
function showResult(){
  phase='over';
  const win=S.result==='win', best=Math.max(bestGet(),S.score);
  if(S.score>bestGet())bestSet(S.score);
  const e=$('end'); e.className='layer '+(win?'win':'lose'); e.hidden=false;
  $('endTag').textContent=win?'Mission Complete':'Mission Failed';
  $('endTitle').textContent=win?'ミッション完了':'ミッション失敗';
  $('endText').textContent=win?M.deb:'原因: '+S.reason+'。敵の動きを読み、機体を立て直して再出撃しよう。';
  $('rKills').textContent=M.type==='survive'?S.kills:S.kills+' / '+S.total;
  $('next').hidden=!win; $('next').textContent=mi<MS.length-1?'次のミッションへ':'エンディング';
  if(win)progSet(Math.max(progGet(),Math.min(MS.length,mi+2))); $('rTime').textContent=fmtTime(S.time);
  $('rScore').textContent=S.score; if(S.ng0+S.ns0)$('endText').textContent+=' 【目標撃破 '+(S.ng0+S.ns0-tg.length)+' / '+(S.ng0+S.ns0)+'】'; $('rBest').textContent=best;
  const cr=Math.round(S.score/10*(win?1:.4)); HG.cr+=cr; hgSave(); $('endText').textContent+=' 【報酬 +'+cr+' CR / 難易度 '+DF.nm+'】';
  engineSound(0,false);
}

function update(dt){
  S.time+=dt; S.hitT=Math.max(0,S.hitT-dt); if(M.todTo)todUpdate(dt); if(OH.onTick)OH.onTick(dt,P,S,fwd); /*[BSO]*/
  if(!P.dead&&!S.result){
    updatePlayer(dt); updateEnemies(dt); if(GFX)trails(dt);
    updateBullets(dt); updateMissiles(dt); updateEMissiles(dt); updateLock(dt); updateTargets(dt); updateBombs(dt); updWM(dt);
    if(M.type==='survive'){ if(S.time>=M.time)endGame(true); else if(M.mid&&!S.midDone&&S.time>M.time/2){S.midDone=1;radio(M.mid);} }
    if(S.spawned<S.total&&enemies.length<M.conc){
      spawnEnemy(false);
      if(!S.reinf&&S.kills>=3){S.reinf=true;radio('新たな敵編隊が接近中だ!');}
    }
    if(S.pullup&&((S.time*3)|0)!==((S.time-dt)*3|0))beep(520,.1,.1);
    if(emis.length&&((S.time*4)|0)!==((S.time-dt)*4|0))beep(1700,.06,.08);
    engineSound(P.thr,true);
  } else {
    updateBullets(dt); updateMissiles(dt); updateEMissiles(dt); updateBombs(dt); updWM(dt);
    for(const e of enemies){ const f=new V3(0,0,-1).applyQuaternion(e.q); e.pos.addScaledVector(f,e.speed*dt); }
    if(!P.dead){ updatePlayerGlide(dt); }
    engineSound(0,false);
  }
  if(S.msgT>0)S.msgT-=dt;
  if(S.radioQ.length&&S.radioQ[0].t<=S.time&&S.msgT<=0){ const r=S.radioQ.shift(); S.msg=r.text; S.msgT=3.6; beep(1400,.05,.04); }
  if(S.result){ S.endT-=dt; if(S.endT<=0&&phase==='play')showResult(); }
  if(!P.dead)updateCamera(dt,false); else camera.updateMatrixWorld();
}
function updatePlayerGlide(dt){
  fwd.set(0,0,-1).applyQuaternion(P.q); P.pos.addScaledVector(fwd,P.speed*dt);
  playerMesh.position.copy(P.pos);
}

/* ---------- HUD ---------- */
const C_MAIN='#9ff0ff',C_DIM='rgba(159,240,255,.45)',C_AMB='#ffb347',C_RED='#ff5a4d';
function proj(v){ const p=v.clone().project(camera); return {x:(p.x*.5+.5)*W,y:(-p.y*.5+.5)*H,ok:p.z>-1&&p.z<1}; }
function txt(s,x,y,size,align,color){
  hx.font=Math.round(size*U)+"px 'Share Tech Mono','Noto Sans JP',monospace";
  hx.textAlign=align||'left'; hx.fillStyle=color||C_MAIN; hx.fillText(s,x,y);
}
function line(x1,y1,x2,y2){hx.beginPath();hx.moveTo(x1,y1);hx.lineTo(x2,y2);hx.stroke();}
function bracket(x,y,s,c){
  const l=s*.38; hx.strokeStyle=c;
  hx.beginPath();
  hx.moveTo(x-s,y-s+l);hx.lineTo(x-s,y-s);hx.lineTo(x-s+l,y-s);
  hx.moveTo(x+s-l,y-s);hx.lineTo(x+s,y-s);hx.lineTo(x+s,y-s+l);
  hx.moveTo(x+s,y+s-l);hx.lineTo(x+s,y+s);hx.lineTo(x+s-l,y+s);
  hx.moveTo(x-s+l,y+s);hx.lineTo(x-s,y+s);hx.lineTo(x-s,y+s-l);
  hx.stroke();
}
function bar(x,y,w,h,v,c,label){
  hx.strokeStyle=C_DIM; hx.lineWidth=1; hx.strokeRect(x+.5,y+.5,w,h);
  hx.fillStyle=c; hx.fillRect(x+2,y+2,Math.max(0,(w-3)*v),h-3);
  if(label)txt(label,x,y-5*U,12,'left',C_DIM);
}
function drawHud(){
  hx.clearRect(0,0,W,H);
  vignette(); if(!P||!S)return;
  const cx=W/2,cy=H/2,ins=Math.max(14,12*U),lw=Math.max(1,1.4*U);
  hx.lineWidth=lw; hx.strokeStyle=C_MAIN; hx.lineJoin='miter';
  if(S.hitT>0){
    const g=hx.createRadialGradient(cx,cy,Math.min(W,H)*.3,cx,cy,Math.max(W,H)*.7);
    g.addColorStop(0,'rgba(255,60,40,0)'); g.addColorStop(1,'rgba(255,60,40,'+(S.hitT/.35*.5)+')');
    hx.fillStyle=g; hx.fillRect(0,0,W,H);
  }
  if(phase==='menu')return;
  const dead=P.dead; const blinkT=((S.time*3)|0)%2===0;
  if(!dead){
    const dH=new V3(fwd.x,0,fwd.z); if(dH.lengthSq()<1e-4)dH.set(0,0,-1); dH.normalize();
    const rH=new V3().crossVectors(dH,UP);
    hx.strokeStyle=C_DIM; hx.lineWidth=lw;
    for(const a of[-20,-10,0,10,20]){
      const r=a*Math.PI/180, c=P.pos.clone().addScaledVector(dH,Math.cos(r)*5000).addScaledVector(UP,Math.sin(r)*5000);
      const wIn=a===0?500:300, wOut=a===0?2400:900;
      for(const sd of[-1,1]){
        const p1=proj(c.clone().addScaledVector(rH,sd*wIn)), p2=proj(c.clone().addScaledVector(rH,sd*wOut));
        if(p1.ok&&p2.ok){
          line(p1.x,p1.y,p2.x,p2.y);
          if(a!==0){ line(p2.x,p2.y,p2.x,p2.y+(a>0?8:-8)*U); txt(String(Math.abs(a)),p2.x+sd*8*U,p2.y+4*U,11,sd>0?'left':'right',C_DIM); }
        }
      }
    }
    const pp=proj(P.pos.clone().addScaledVector(fwd,750));
    if(pp.ok){
      hx.strokeStyle=C_MAIN; hx.lineWidth=lw;
      hx.beginPath(); hx.arc(pp.x,pp.y,15*U,0,Math.PI*2); hx.stroke();
      line(pp.x-26*U,pp.y,pp.x-18*U,pp.y); line(pp.x+18*U,pp.y,pp.x+26*U,pp.y); line(pp.x,pp.y+18*U,pp.x,pp.y+26*U);
      hx.fillStyle=C_MAIN; hx.fillRect(pp.x-1,pp.y-1,2,2);
    }
  }
  let near=null,nd=1e9;
  for(const e of enemies){
    const d=e.pos.distanceTo(P.pos); if(d<nd){nd=d;near=e;}
    const p=proj(e.pos); if(!p.ok)continue;
    const s=clamp(24000/d,9,44)*U/1;
    const isC=lock.cand===e;
    const c=isC?(lock.locked?C_RED:C_AMB):C_MAIN;
    hx.lineWidth=isC?lw*1.6:lw;
    bracket(p.x,p.y,isC?Math.max(s,22*U):s,c);
    if(isC&&lock.locked){ bracket(p.x,p.y,Math.max(s,22*U)+7*U,c); txt('LOCK',p.x,p.y-Math.max(s,22*U)-12*U,13,'center',C_RED); }
    else if(isC){ hx.strokeStyle=C_AMB; hx.beginPath(); hx.arc(p.x,p.y,Math.max(s,22*U)+7*U,-Math.PI/2,-Math.PI/2+lock.t*Math.PI*2); hx.stroke(); }
    txt((d/1000).toFixed(1)+'km',p.x,p.y+Math.max(s,isC?22*U:0)+14*U,11,'center',isC?c:C_DIM);
    if(e.ace)txt('ACE '+Math.max(0,Math.round(e.hp/e.mhp*100))+'%',p.x,p.y-Math.max(s,isC?22*U:0)-26*U,13,'center',C_AMB);
  }
  for(const t of tg){
    const d=t.pos.distanceTo(P.pos); if(d>10000)continue; const p=proj(t.pos); if(!p.ok)continue;
    const isC=lock.cand===t, s=Math.max(clamp(t.r*700/d,8,46)*U,isC?22*U:0), c=isC?(lock.locked?C_RED:C_AMB):'#8dff9f';
    hx.lineWidth=isC?lw*1.6:lw; bracket(p.x,p.y,s,c);
    if(isC&&lock.locked){ bracket(p.x,p.y,s+7*U,c); txt('LOCK',p.x,p.y-s-12*U,13,'center',C_RED); }
    else if(isC){ hx.strokeStyle=C_AMB; hx.beginPath(); hx.arc(p.x,p.y,s+7*U,-Math.PI/2,-Math.PI/2+lock.t*Math.PI*2); hx.stroke(); }
    if(d<7000){ txt(t.def.nm+' '+(d/1000).toFixed(1)+'km',p.x,p.y+s+14*U,11,'center',c); if(t.hp<t.mhp){ hx.fillStyle=c; hx.fillRect(p.x-20*U,p.y+s+19*U,40*U*clamp(t.hp/t.mhp,0,1),3*U); } }
  }
  /* incoming enemy missiles */
  if(emis.length&&!dead){
    for(const m of emis){
      const p=proj(m.pos); if(!p.ok)continue;
      hx.strokeStyle=C_RED; hx.lineWidth=lw*1.4; const s=10*U;
      hx.beginPath(); hx.moveTo(p.x,p.y-s); hx.lineTo(p.x+s,p.y); hx.lineTo(p.x,p.y+s); hx.lineTo(p.x-s,p.y); hx.closePath(); hx.stroke();
      txt((m.pos.distanceTo(P.pos)/1000).toFixed(1)+'km',p.x,p.y+s+13*U,11,'center',C_RED);
    }
    if(blinkT)txt('MISSILE  フレア[Z] / 旋回で回避',cx,H*.36,22,'center',C_RED);
  }
  const wp=proj(wmesh.position); if(wmesh.visible&&wp.ok&&phase==='play')txt('SOLARIS 2',wp.x,wp.y-22*U,11,'center','#8fe3ff');
  const boss=tg.find(t=>t.def.sup);
  if(boss&&!dead){ const bw2=Math.min(360*U,W*.46),bx2=cx-bw2/2,by2=H-ins-44*U, shd=tg.some(o=>o.k==='gen');
    bar(bx2,by2,bw2,9*U,clamp(boss.hp/boss.mhp,0,1),shd?'#58f0ff':C_RED,boss.def.nm+(shd?'  [SHIELD]':'')); }
  const chg=tg.find(t=>t.chg);
  if(chg&&!dead&&((S.time*4)|0)%2===0)txt('主砲充電中  回避せよ',cx,H*.24,22,'center',C_RED);
  let nt=null,ntd=1e9; for(const t of tg){const dd=t.pos.distanceTo(P.pos); if(dd<ntd){ntd=dd;nt=t;}} const tgt=lock.cand||near||nt;
  if(tgt&&!dead){
    const p=proj(tgt.pos);
    if(!p.ok||p.x<0||p.x>W||p.y<0||p.y>H){
      const v=tgt.pos.clone().applyMatrix4(camera.matrixWorldInverse);
      const a=Math.atan2(v.y,v.x), ex=cx+Math.cos(a)*W*.4, ey=cy-Math.sin(a)*H*.36;
      hx.save(); hx.translate(ex,ey); hx.rotate(-a); hx.fillStyle=C_AMB;
      hx.beginPath(); hx.moveTo(14*U,0); hx.lineTo(-8*U,-9*U); hx.lineTo(-3*U,0); hx.lineTo(-8*U,9*U); hx.closePath(); hx.fill(); hx.restore();
    }
  }
  const hdg=(Math.atan2(fwd.x,-fwd.z)*180/Math.PI+360)%360, ty=ins+16*U, ppd=4.2*U;
  hx.strokeStyle=C_DIM; hx.lineWidth=lw;
  hx.save(); hx.beginPath(); hx.rect(cx-150*U,ty-16*U,300*U,40*U); hx.clip();
  for(let d=Math.floor((hdg-40)/5)*5;d<=hdg+40;d+=5){
    const x=cx+(d-hdg)*ppd, dd=((d%360)+360)%360, major=dd%15===0;
    line(x,ty+8*U,x,ty+(major?0:4)*U);
    if(dd%30===0){ const lb={0:'N',90:'E',180:'S',270:'W'}[dd]||String(dd/10).padStart(2,'0'); txt(lb,x,ty-4*U,13,'center',lb.length===1?C_AMB:C_MAIN); }
  }
  hx.restore();
  hx.strokeStyle=C_MAIN; hx.beginPath(); hx.moveTo(cx,ty+11*U); hx.lineTo(cx-5*U,ty+18*U); hx.lineTo(cx+5*U,ty+18*U); hx.closePath(); hx.stroke();
  txt(String(Math.round(hdg)).padStart(3,'0'),cx,ty+34*U,15,'center');
  const sx=Math.max(ins,cx-Math.min(W*.3,300)*U), ax=Math.min(W-ins,cx+Math.min(W*.3,300)*U);
  hx.strokeStyle=C_MAIN; hx.lineWidth=lw;
  hx.strokeRect(sx-4,cy-14*U,84*U,28*U); txt(String(Math.round(P.speed*3.6)),sx+74*U,cy+6*U,20,'right'); txt('km/h',sx,cy-20*U,11,'left',C_DIM);
  hx.strokeRect(ax-80*U,cy-14*U,84*U,28*U); txt(String(Math.round(P.pos.y)),ax-4*U,cy+6*U,20,'right'); txt('ALT m',ax,cy-20*U,11,'right',C_DIM);
  const bx=Math.max(ins,0)+0, by=H-ins-100*U, bw=Math.min(190*U,W*.42);
  const hpc=P.hp<35?C_RED:C_MAIN;
  bar(bx,by,bw,10*U,P.hp/100,hpc,'機体');
  bar(bx,by+30*U,bw,10*U,P.thr,C_MAIN,'スロットル');
  txt('MSL',bx,by+62*U,13,'left',C_DIM);
  for(let i=0;i<P.mmax;i++){ hx.fillStyle=i<P.msl?C_MAIN:'rgba(159,240,255,.15)'; hx.fillRect(bx+44*U+i*(bw-44*U)/P.mmax,by+52*U,(bw-44*U)/P.mmax-3,12*U); }
  hx.fillStyle='rgba(143,227,255,.55)'; hx.fillRect(bx+44*U,by+67*U,(bw-44*U)*clamp(P.rg/DF.rg,0,1),2*U);
  txt('FLARE x'+P.fl+' [Z]',bx,by+84*U,13,'left',P.fl>0?C_AMB:C_DIM);
  if(HG.sw!=='none')txt('[X] '+SP[HG.sw].nm+' ×'+P.sp,bx,by-8*U,12,'left',P.sp>0?C_AMB:C_DIM);
  if(P.sh>0){ txt('BARRIER '+P.sh.toFixed(1),W/2,H*.78,14,'center',C_MAIN); hx.strokeStyle=C_MAIN; hx.beginPath(); hx.arc(W/2,H/2,70*U,0,6.283); hx.stroke(); }
  if(M.type==='survive'){txt('SURVIVE',ins,ins+14*U,12,'left',C_DIM); txt(fmtTime(Math.max(0,M.time-S.time)),ins,ins+38*U,26,'left');}
  else{ const cols=[]; if(S.total)cols.push(['BANDITS',S.total-S.kills,S.total]); if(S.ng0)cols.push(['GROUND',tg.filter(t=>!t.ship).length,S.ng0]); if(S.ns0)cols.push(['SHIPS',tg.filter(t=>t.ship).length,S.ns0]);
    cols.forEach((c,i)=>{ txt(c[0],ins+i*100*U,ins+14*U,12,'left',C_DIM); txt(String(c[1]).padStart(2,'0')+'/'+c[2],ins+i*100*U,ins+38*U,24,'left'); }); }
  if(M.dl)txt('SUNRISE '+fmtTime(Math.max(0,M.dl-S.time)),ins,ins+62*U,15,'left',(M.dl-S.time)<60&&blinkT?C_RED:C_AMB);
  txt('SCORE',W-ins,ins+14*U,12,'right',C_DIM); txt(String(S.score),W-ins,ins+38*U,26,'right');
  txt(fmtTime(S.time),W-ins,ins+58*U,15,'right',C_DIM);
  if(M.bmb){ txt('BOMB x'+P.bmb+' [B]',bx,by+100*U,13,'left',P.bmb>0?C_AMB:C_DIM);
    if(P.bmb>0&&!dead){ const ip=ccip(); if(ip){ const q=proj(ip); if(q.ok){ hx.strokeStyle=C_AMB; hx.lineWidth=lw*1.3; hx.beginPath(); hx.arc(q.x,q.y,13*U,0,6.283); hx.stroke(); line(q.x-20*U,q.y,q.x+20*U,q.y); line(q.x,q.y-20*U,q.x,q.y+20*U); } } } }
  const R=Math.min(70*U,W*.16), rx=W-ins-R, ry=H-ins-R, rr=7000;
  hx.strokeStyle=C_DIM; hx.lineWidth=lw; hx.fillStyle='rgba(6,17,27,.45)';
  hx.beginPath(); hx.arc(rx,ry,R,0,Math.PI*2); hx.fill(); hx.stroke();
  hx.beginPath(); hx.arc(rx,ry,R*.5,0,Math.PI*2); hx.stroke(); line(rx-R,ry,rx+R,ry); line(rx,ry-R,rx,ry+R);
  const h=hdg*Math.PI/180, sh=Math.sin(h), ch=Math.cos(h);
  for(const e of enemies){
    const dx=e.pos.x-P.pos.x, dz=e.pos.z-P.pos.z;
    let x=dx*ch+dz*sh, y=dx*sh-dz*ch, d=Math.hypot(x,y), far=d>rr;
    if(far){x*=rr/d;y*=rr/d;}
    hx.fillStyle=lock.cand===e?C_AMB:(far?'rgba(255,90,77,.45)':C_RED);
    hx.beginPath(); hx.arc(rx+x/rr*R,ry-y/rr*R,3.2*U,0,Math.PI*2); hx.fill();
  }
  for(const m of emis){ const dx=m.pos.x-P.pos.x,dz=m.pos.z-P.pos.z; let x=dx*ch+dz*sh,y=dx*sh-dz*ch,d=Math.hypot(x,y); if(d>rr){x*=rr/d;y*=rr/d;} hx.fillStyle='#ffe14d'; hx.fillRect(rx+x/rr*R-1.5*U,ry-y/rr*R-1.5*U,3*U,3*U); }
  for(const t of tg){ const dx=t.pos.x-P.pos.x,dz=t.pos.z-P.pos.z; let x=dx*ch+dz*sh,y=dx*sh-dz*ch,d=Math.hypot(x,y); if(d>rr){x*=rr/d;y*=rr/d;} hx.fillStyle=lock.cand===t?C_AMB:'#7dff9a'; hx.fillRect(rx+x/rr*R-2.5*U,ry-y/rr*R-2.5*U,5*U,5*U); }
  hx.fillStyle=C_MAIN; hx.beginPath(); hx.moveTo(rx,ry-6*U); hx.lineTo(rx-4*U,ry+4*U); hx.lineTo(rx+4*U,ry+4*U); hx.closePath(); hx.fill();
  if(S.msgT>0&&S.msg){
    hx.globalAlpha=clamp(S.msgT/.5,0,1);
    const w=Math.min(W-2*ins,640*U); hx.fillStyle='rgba(6,17,27,.55)'; hx.fillRect(cx-w/2,ty+48*U,w,26*U);
    txt(S.msg,cx,ty+66*U,15,'center',C_MAIN); hx.globalAlpha=1;
  }
  const blink=((S.time*3)|0)%2===0;
  if(S.pullup&&blink&&!dead)txt('PULL UP',cx,H*.3,38,'center',C_RED);
  else if(S.outside&&blink&&!dead)txt('領域外  作戦空域へ戻れ',cx,H*.3,24,'center',C_AMB);
  if(P.hp<35&&P.hp>0&&blink)txt('DAMAGE',bx,by-24*U,14,'left',C_RED);
  if(phase==='play'&&S.time<14&&!dead){
    txt('S 機首上げ  A/D ロール  Space 機関砲  F ミサイル  B 爆弾  Z フレア',cx,H-ins-6*U,12,'center',C_DIM);
  }
}

/* ---------- story flow & cinematics ---------- */
function layers(id){ for(const l of['brief','pause','end','hangar']){const el=$(l); if(el)el.hidden=l!==id;} if(OH.onLayers)OH.onLayers(id||null); } /*[BSO]*/
function buildSel(){
  const p=progGet(),box=$('msel'); box.innerHTML=''; $('go').textContent=p>1?'続きから':'キャンペーン開始';
  MS.forEach((m,i)=>{ const b=document.createElement('button'); b.type='button'; b.disabled=i>=p;
    b.textContent=String(i+1).padStart(2,'0')+' '+m.n; b.onclick=()=>showBrief(i); box.appendChild(b); });
}
function showBrief(i){
  mi=i; M=MS[i]; reset(); phase='menu'; layers('brief');
  $('bTag').textContent='Mission '+String(i+1).padStart(2,'0')+' — '+(M.ch||''); $('bTitle').textContent=M.n; $('bSub').textContent=M.sub;
  $('bText').textContent=M.story; $('bObj').textContent=M.obj+'  難易度: '+DF.nm+(HG.sw!=='none'?'  特殊兵装: '+SP[HG.sw].nm:'');
}
function toMenu(){ reset(); phase='menu'; layers('menu'); buildSel(); buildDiff(); }
const sstep=x=>x*x*(3-2*x);
function playMovie(key,shots,tod,cb){
  layers(); initAudio();
  const fin=()=>{
    if(phase!=='cine')return;
    if(vidEl){vidEl.remove();vidEl=null;}
    for(const a of cact)scene.remove(a); cact=[]; engineSound(0,false); phase='menu'; cb();
  };
  const start=()=>{ applyTOD(tod); CV={fin,shots,i:-1,t:0,age:0}; phase='cine'; nextShot(); };
  const src=VIDEO_SRC[key];
  if(!src){ start(); return; }
  vidEl=document.createElement('video'); vidEl.id='vid'; vidEl.src=src; vidEl.autoplay=true; vidEl.playsInline=true;
  vidEl.onended=fin; vidEl.onerror=()=>{ vidEl.remove(); vidEl=null; start(); };
  stage.appendChild(vidEl); CV={fin,v:1,age:0}; phase='cine'; vidEl.play().catch(()=>{});
}
function nextShot(){ wmesh.visible=false;
  for(const a of cact)scene.remove(a); cact=[]; CV.i++; CV.t=0;
  const s=CV.shots[CV.i]; if(!s){ CV.fin(); return; }
  CV.s=s; if(s.card){ playerMesh.visible=false; return; }
  playerMesh.visible=true; CV.lp=new V3(0,700,0); CV.en=[];
  const add=(m,x,y,z,ry,vz)=>{ m.position.set(x,700+y,z); m.rotation.y=ry; m.userData.vz=vz; scene.add(m); cact.push(m); return m; };
  for(let k=0;k<(s.fr||0);k++)add(facJet('wing'),(k%2?1:-1)*(55+k*18),k?-4:2,40+k*30,0,-200);
  for(let k=0;k<(s.en||0);k++){
    const ac=s.ac&&!k, m=add(ac?facJet('ace'):facJet(s.fk||'g'),(k%2?1:-1)*Math.ceil(k/2)*85,(k%2)*30,-2100-k*45,Math.PI,190);
    if(ac)m.scale.setScalar(1.2); CV.en.push(m);
  }
  if(s.who)beep(1400,.05,.04);
}
function updateCine(dt){
  CV.age+=dt; if(CV.v)return; CV.t+=dt; const s=CV.s; engineSound(.5,true);
  if(s.card){ if(CV.t>=s.d)nextShot(); return; }
  CV.lp.z-=200*dt; playerMesh.position.copy(CV.lp); playerMesh.quaternion.identity();
  for(const a of cact)a.position.z+=a.userData.vz*dt;
  const k=sstep(clamp(CV.t/s.d,0,1));
  camera.position.set(CV.lp.x+lerp(s.a[0],s.b[0],k),CV.lp.y+lerp(s.a[1],s.b[1],k),CV.lp.z+lerp(s.a[2],s.b[2],k));
  camera.up.set(0,1,0);
  camera.lookAt(s.lk===1&&CV.en[0]?CV.en[0].position:CV.lp.clone().add(new V3(0,0,s.lk===2?-700:0)));
  camera.fov=55; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  sky.position.copy(camera.position); sunSpr.position.copy(camera.position).addScaledVector(sun.position.clone().normalize(),26000);
  if(CV.t>=s.d)nextShot();
}
function drawCine(){
  hx.clearRect(0,0,W,H); vignette(); if(!CV||CV.v||!CV.s)return;
  const s=CV.s, fade=clamp(Math.min(CV.t,s.d-CV.t)/.4,0,1);
  if(s.card){
    hx.fillStyle='#000'; hx.fillRect(0,0,W,H); hx.globalAlpha=fade;
    txt(s.h,W/2,H*.46,16,'center',C_AMB); txt(s.s,W/2,H*.46+46*U,34,'center','#fff'); hx.globalAlpha=1; return;
  }
  const bh=Math.max(H*.15,86*U);
  hx.fillStyle='rgba(0,0,0,'+(1-fade)+')'; hx.fillRect(0,0,W,H);
  hx.fillStyle='#000'; hx.fillRect(0,0,W,bh*.7); hx.fillRect(0,H-bh,W,bh);
  txt('Space / Enter / クリック: スキップ',W-16*U,bh*.4,12,'right',C_DIM);
  if(s.t){
    txt(s.who,W/2,H-bh+22*U,13,'center',C_AMB);
    s.t.slice(0,Math.floor(CV.t*28)).replace(/\|/g,String.fromCharCode(10)).split('\n').forEach((l,i)=>txt(l,W/2,H-bh+46*U+i*22*U,17,'center','#fff'));
  }
}

/* ---------- ENDING ---------- */
let EV=null;
const CREDITS=[['BLUE SORTIE 4','t'],['THE PHANTOM SKY','s'],['',''],['— CAST —','h'],
 ['ソラリス1  (あなた)','n'],['ソラリス2  カイト','n'],['ソラリス3  エレナ','n'],['ソラリス4  ヴィクター','n'],
 ['司令官  デイビッド','n'],['AWACS  ブルースカイ','n'],['ホークアイ5番機','n'],['敵AI  ミラージュ  /  エース  ホロウ','n'],['',''],
 ['— THE WAR —','h'],['無人戦闘機群  ファントム','n'],['中央アルタジア国際停戦監視軍 第4中隊 ソラリス隊','n'],['',''],
 ['— SPECIAL THANKS —','h'],['ブルーウィング第7飛行隊  (Blue Sortie)','n'],['ホークアイ中隊  (Blue Sortie 2)','n'],['ソラリス隊  (Blue Sortie 3)','n'],['',''],
 ['— DEVELOPMENT —','h'],['Blue Sortie エンジニアチーム','n'],['',''],
 ['学習できるものは、いつか追い越される。','s'],['',''],['THANK YOU FOR PLAYING','t']];
function playEnding(){
  layers(); initAudio(); for(const a of cact)scene.remove(a); cact=[]; wmesh.visible=false;
  buildTerrain('isles'); applyTOD('dawn'); setSun(.07); sunSpr.visible=true; sunSpr.scale.setScalar(15000); sunSpr.material.color.set(0xffc080);
  scene.fog.color.set(0xf2b4a0); scene.fog.near=3000; scene.fog.far=22000;
  sky.material.color.set(0xffc0a8);
  const lead=new V3(0,1500,0), jets=[], off=[[0,0,0],[-50,-4,40],[50,-4,40],[0,-9,82]];
  playerMesh.visible=true; jets.push(playerMesh);
  for(let i=1;i<4;i++){ const j=facJet('sol'); scene.add(j); jets.push(j); }
  let snd=null;
  if(AC&&!muted){ try{ const g=AC.createGain(); g.gain.value=0; g.connect(AC.destination); const os=[110,164.8,220,277.2,329.6].map((f,i)=>{ const o=AC.createOscillator(); o.type=i%2?'sine':'triangle'; o.frequency.value=f; const og=AC.createGain(); og.gain.value=.05/(1+i*.3); o.connect(og); og.connect(g); o.start(); return o; });
    g.gain.setTargetAtTime(.9,AC.currentTime,6); snd={g,os}; }catch(e){} }
  EV={t:0,end:62,lead,jets,off,snd,done:false}; phase='ending';
  camera.fov=50; camera.updateProjectionMatrix();
}
function leaveEnding(){
  if(!EV)return;
  for(let i=1;i<EV.jets.length;i++)scene.remove(EV.jets[i]);
  if(EV.snd){ try{EV.snd.g.gain.setTargetAtTime(0,AC.currentTime,.4); EV.snd.os.forEach(o=>o.stop(AC.currentTime+2));}catch(e){} }
  sunSpr.scale.setScalar(7000); EV=null; engineSound(0,false); toMenu();
}
function updateEnding(dt){
  EV.t+=dt; const t=EV.t;
  EV.lead.set(Math.sin(t*.07)*18,1500+Math.sin(t*.11)*10,-190*t);
  EV.jets.forEach((j,i)=>{
    const o=EV.off[i]; j.position.set(EV.lead.x+o[0],EV.lead.y+o[1]+Math.sin(t*.9+i)*1.5,EV.lead.z+o[2]);
    j.quaternion.identity(); j.rotation.z=Math.sin(t*.35+i*1.3)*.07; j.rotation.x=.02;
    if(j.userData.flame)j.userData.flame.scale.z=.9+Math.sin(t*38+i)*.12;
  });
  const sep=60+t*t*.55+t*20;
  camera.position.set(EV.lead.x+Math.sin(t*.05)*40,EV.lead.y+14+t*1.6,EV.lead.z+80+sep);
  camera.up.set(0,1,0);
  const aim=EV.lead.clone().add(new V3(0,Math.min(t*1.1,60),-300));
  camera.lookAt(aim); camera.fov=lerp(50,34,clamp(t/60,0,1)); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  sky.position.copy(camera.position); sunSpr.position.copy(camera.position).addScaledVector(sun.position.clone().normalize(),26000);
  sunSpr.scale.setScalar(15000+t*160);
  engineSound(.35,true); updateParts(dt);
  if(t>=EV.end)EV.done=true;
}
function drawEnding(){
  hx.clearRect(0,0,W,H); if(!EV)return;
  const t=EV.t; vignette();
  const sp=44*U, y0=H+40*U-t*sp*.78;
  hx.save(); hx.shadowColor='rgba(40,10,10,.7)'; hx.shadowBlur=8;
  CREDITS.forEach((c,i)=>{
    const y=y0+i*40*U; if(y<-40||y>H+40)return; if(!c[0])return;
    const edge=clamp(Math.min(y,H-y)/(H*.18),0,1); hx.globalAlpha=edge;
    if(c[1]==='t')txt(c[0],W/2,y,34,'center','#fff');
    else if(c[1]==='s')txt(c[0],W/2,y,24,'center','#ffd9a0');
    else if(c[1]==='h')txt(c[0],W/2,y,15,'center','#ffb347');
    else txt(c[0],W/2,y,19,'center','#fff6ea');
  });
  hx.restore(); hx.globalAlpha=1;
  const fo=clamp((t-(EV.end-8))/6,0,1);
  if(fo>0){ hx.fillStyle='rgba(0,0,0,'+fo+')'; hx.fillRect(0,0,W,H); }
  if(EV.done){ hx.globalAlpha=clamp((t-EV.end)/1.5,0,1); txt('THE PHANTOM SKY',W/2,H*.46,40,'center','#fff'); txt('クリック / Enter でタイトルへ',W/2,H*.46+44*U,15,'center',C_AMB); hx.globalAlpha=1; }
  else txt('Space / Enter / クリック: スキップ',W-16*U,24*U,12,'right',C_DIM);
}

/* ---------- input ---------- */
const BLOCK=['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'];
addEventListener('keydown',e=>{
  { const t=e.target; if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable))return; } /*[BSO]*/
  if(BLOCK.includes(e.code)&&phase!=='menu'&&!(e.target&&e.target.tagName==='BUTTON'&&e.code==='Space'))e.preventDefault();
  if(phase==='cine'&&CV&&CV.age>.5&&(e.code==='Space'||e.code==='Enter'||e.code==='Escape')){ e.preventDefault(); CV.fin(); return; }
  if(phase==='ending'&&EV&&EV.t>1&&(e.code==='Space'||e.code==='Enter'||e.code==='Escape')){ e.preventDefault(); if(EV.done)leaveEnding(); else EV.t=Math.max(EV.t,EV.end-7); return; }
  if(!e.repeat){
    if(phase==='play'&&(e.code==='KeyF'||e.code==='Enter')&&!S.result){ e.preventDefault(); fireMissile(); }
    else if(e.code==='KeyP'||e.code==='Escape'){ if(phase==='play')pauseGame(); else if(phase==='pause')resumeGame(); }
    else if(e.code==='KeyX'&&phase==='play')fireSpecial();
    else if(e.code==='KeyZ'&&phase==='play')dropFlare();
    else if(e.code==='KeyB'&&phase==='play')dropBomb();
    else if(e.code==='KeyG')toggleGFX();
    else if(e.code==='KeyI')invert=!invert;
    else if(e.code==='KeyM'){ muted=!muted; if(muted)engineSound(0,false); }
  }
  keys[e.code]=true;
});
addEventListener('keyup',e=>{keys[e.code]=false;});
addEventListener('blur',()=>{ for(const k in keys)keys[k]=false; if(phase==='play'&&!S.result)pauseGame(true); });
$('hgOpen').onclick=()=>{hgRender();layers('hangar');}; $('hgBack').onclick=toMenu;
$('gfx').onclick=toggleGFX; applyGFX();
$('go').addEventListener('click',()=>showBrief(Math.min(progGet(),MS.length)-1));
$('launch').onclick=()=>playMovie('m'+mi,M.intro,M.tod,startGame);
$('bBack').onclick=toMenu; $('tomenu').onclick=toMenu;
$('next').onclick=()=>playMovie('o'+mi,M.outro,M.todTo||M.tod,()=>mi<MS.length-1?showBrief(mi+1):playMovie('end',END,'dawn',playEnding));
stage.addEventListener('click',()=>{ if(phase==='cine'&&CV&&CV.age>.5)CV.fin(); else if(phase==='ending'&&EV&&EV.t>1){ if(EV.done)leaveEnding(); else EV.t=Math.max(EV.t,EV.end-7); } });
$('again').addEventListener('click',startGame);
$('resume').addEventListener('click',resumeGame);

/* ---------- main loop ---------- */
let last=performance.now();
function loop(now){
  requestAnimationFrame(loop);
  const dt=Math.min(.05,(now-last)/1000); last=now;
  if(phase==='play')update(dt);
  else if(phase==='cine')updateCine(dt);
  else if(phase==='ending')updateEnding(dt);
  else if(phase==='menu'){
    const a=now*.00012;
    camera.position.copy(P.pos).add(new V3(Math.sin(a)*46,10+Math.sin(a*1.7)*5,Math.cos(a)*46));
    camera.up.set(0,1,0); camera.lookAt(P.pos); camera.updateMatrixWorld();
    sky.position.copy(camera.position); sunSpr.position.copy(camera.position).addScaledVector(sun.position.clone().normalize(),26000);
    playerMesh.position.copy(P.pos); playerMesh.quaternion.copy(P.q);
    updateParts(dt);
  } else if(phase==='over'){ for(const e of enemies){const f=new V3(0,0,-1).applyQuaternion(e.q);e.pos.addScaledVector(f,e.speed*dt);} }
  if(phase==='play'||phase==='over')updateParts(dt);
  if(GFX)gfxFollow();
  if(OH.onFrame)OH.onFrame(dt,phase); /*[BSO]*/
  renderer.render(scene,camera);
  if(phase==='cine')drawCine(); else if(phase==='ending')drawEnding(); else { drawHud(); if(OH.onHud&&phase==='play')OH.onHud({hx,W,H,U,proj,txt,line,camera,P,S}); } /*[BSO]*/
}

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
toMenu();
requestAnimationFrame(loop);

})();
