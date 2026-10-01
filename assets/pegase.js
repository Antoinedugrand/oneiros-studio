// Pégase — on le pilote au-dessus du site, la page défile en suivant son vol.
// Mission : dissiper les cauchemars à coups de foudre. Chargé seulement au décollage (et pour l'icône du bouton).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MODEL_URL = 'assets/pegase.glb';
const GOLD = '#E8C77A';

/* ---------- modèle 3D (chargé une fois, partagé entre l'icône et le vol) ---------- */
let modelPromise;
function loadModel() {
  modelPromise ??= new GLTFLoader().loadAsync(MODEL_URL).then(g => {
    const m = g.scene;
    const box = new THREE.Box3().setFromObject(m), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    m.position.sub(c);                                   // centré
    const holder = new THREE.Group(); holder.add(m);
    holder.scale.setScalar(1 / Math.max(size.x, size.y, size.z)); // plus grande dimension = 1
    m.traverse(o => { if (o.isMesh) { o.material.envMapIntensity = 1.4; } });
    return holder;
  }).catch(() => null);
  return modelPromise;
}
function makeRenderer(canvas, w, h) {
  const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.setSize(w, h, false);
  r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping;
  return r;
}
function makeScene(renderer) {
  const s = new THREE.Scene();
  s.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), .04).texture;
  const key = new THREE.DirectionalLight(0xffe2b0, 2.2); key.position.set(-1, 2, 3); s.add(key);
  s.add(new THREE.AmbientLight(0x404050, .6));
  return s;
}
// Orientation du modèle : il regarde vers +X (comme sur l'image source), ailes vers +Y.
// FORWARD_YAW corrige si le fichier 3D sort dans un autre sens.
const FORWARD_YAW = -Math.PI / 2;

/* ---------- icône animée dans le bouton de décollage ---------- */
export async function mountIcon(canvas) {
  const W = canvas.clientWidth || 64, H = canvas.clientHeight || 64;
  const r = makeRenderer(canvas, W, H), s = makeScene(r);
  const cam = new THREE.PerspectiveCamera(30, W / H, .1, 10); cam.position.set(0, .25, 2.4); cam.lookAt(0, 0, 0);
  const model = await loadModel(); if (!model) return;
  const m = model.clone(); m.rotation.y = FORWARD_YAW; const spin = new THREE.Group(); spin.add(m); s.add(spin);
  (function loop(t) { spin.rotation.y = t / 1800; m.position.y = Math.sin(t / 500) * .03; r.render(s, cam); requestAnimationFrame(loop); })(0);
}

/* ---------- le vol ---------- */
let running = false;
export async function launch({ from, i18n, onEnd }) {
  if (running) return; running = true;
  const T = i18n;
  const doc = document.documentElement, prevBehavior = doc.style.scrollBehavior; doc.style.scrollBehavior = 'auto';
  const touch = matchMedia('(hover:none)').matches;

  // calques : WebGL (Pégase) + 2D (foudre, cauchemars, particules)
  const layer = document.createElement('div'); layer.className = 'peg-layer';
  layer.innerHTML = `<canvas class="peg-fx"></canvas><canvas class="peg-3d"></canvas>
    <div class="peg-panel" role="dialog" aria-label="${T.mission}">
      <button class="peg-x" aria-label="${T.land}">×</button>
      <p><b>${T.mission} :</b> ${T.missionText}</p>
      <div class="peg-keys">
        <span><kbd>↑</kbd> ${T.thrust}</span><span><kbd>↓</kbd> ${T.brake}</span>
        <span><kbd>←</kbd><kbd>→</kbd> ${T.turn}</span><span><kbd>${T.space}</kbd> ${T.bolt}</span>
        <span><kbd>Échap</kbd> ${T.land}</span>
      </div>
      <p class="peg-tip">${T.scrollHint}</p>
    </div>
    <div class="peg-hud"><span class="peg-count"></span><span class="peg-time">00:00.0</span></div>
    ${touch ? `<div class="peg-pad"><button data-k="ArrowLeft">◀</button><button data-k="ArrowUp">▲</button><button data-k="ArrowRight">▶</button><button data-k=" ">ϟ</button></div>` : ''}`;
  document.body.appendChild(layer);
  const fx = layer.querySelector('.peg-fx'), gl = layer.querySelector('.peg-3d'), ctx = fx.getContext('2d');
  const hudCount = layer.querySelector('.peg-count'), hudTime = layer.querySelector('.peg-time'), panel = layer.querySelector('.peg-panel');

  let W = innerWidth, H = innerHeight, DPR = Math.min(devicePixelRatio || 1, 2);
  const renderer = makeRenderer(gl, W, H), scene = makeScene(renderer);
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, -2000, 2000); cam.position.z = 1000;
  function resize() {
    W = innerWidth; H = innerHeight; fx.width = W * DPR; fx.height = H * DPR; renderer.setSize(W, H, false);
    Object.assign(cam, { left: -W / 2, right: W / 2, top: H / 2, bottom: -H / 2 }); cam.updateProjectionMatrix();
  }
  resize(); addEventListener('resize', resize);

  // Pégase : yaw (cap) > roll (on le voit de dessus, il penche dans les virages)
  const yawG = new THREE.Group(), rollG = new THREE.Group(); yawG.add(rollG); scene.add(yawG);
  const SIZE = Math.min(150, Math.max(96, W * .1));
  loadModel().then(m => { if (m) { const c = m.clone(); c.rotation.y = FORWARD_YAW; rollG.add(c); rollG.scale.setScalar(SIZE); } });

  // état du vol (coordonnées du document, en px)
  const r0 = from.getBoundingClientRect();
  const ship = { x: r0.left + r0.width / 2, y: scrollY + r0.top + r0.height / 2, vx: 0, vy: 0, a: Math.PI / 2, bank: 0, alive: true };
  const keys = new Set(); let cooldown = 0;
  const bolts = [], parts = [];
  const docH = () => doc.scrollHeight;

  // cauchemars répartis sur toute la page, sous le point de départ
  const nightmares = [];
  const N = Math.max(10, Math.min(18, Math.round(docH() / 650)));
  for (let i = 0; i < N; i++) {
    const r = 26 + Math.random() * 22;
    nightmares.push({ x: W * (.12 + Math.random() * .76), y: ship.y + 260 + (docH() - ship.y - 500) * (i + Math.random() * .8) / N,
      r, hp: r > 38 ? 2 : 1, vx: (Math.random() - .5) * 30, vy: (Math.random() - .5) * 20, ph: Math.random() * 6.28, hit: 0 });
  }
  const total = nightmares.length; let killed = 0, t0 = 0, tEnd = 0;
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  const updHud = () => { hudCount.textContent = `${T.nightmares} ${killed}/${total}`; };
  updHud();

  // clavier
  // La page ne suit Pégase que tant qu'on le pilote : molette, trackpad, barre de défilement
  // ou doigt reprennent la main ; une commande de vol relance le suivi.
  let follow = true, ourScroll = scrollY;
  const maxScroll = () => doc.scrollHeight - innerHeight;
  const setScroll = y => { ourScroll = Math.round(Math.max(0, Math.min(maxScroll(), y))); scrollTo(0, ourScroll); };
  const release = () => { follow = false; };
  const onScroll = () => { if (Math.abs(scrollY - ourScroll) > 3) follow = false; };
  addEventListener('wheel', release, { passive: true }); addEventListener('touchmove', release, { passive: true }); addEventListener('scroll', onScroll, { passive: true });
  function resume() {
    if (follow) return; follow = true;
    const top = scrollY + H * .2, bottom = scrollY + H * .8;
    if (ship.y < top || ship.y > bottom) {            // Pégase réapparaît au bord de l'écran où l'on se trouve
      ship.y = ship.y < top ? top : bottom; ship.vx = ship.vy = 0; burst(ship.x, ship.y, 26, GOLD);
    }
    ourScroll = scrollY;
  }
  const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar']);
  const kd = e => { if (e.key === 'Escape') return end(); if (GAME_KEYS.has(e.key)) { e.preventDefault(); resume(); keys.add(e.key === 'Spacebar' ? ' ' : e.key); panel.classList.add('dim'); } };
  const ku = e => { keys.delete(e.key === 'Spacebar' ? ' ' : e.key); };
  addEventListener('keydown', kd); addEventListener('keyup', ku);
  layer.querySelector('.peg-x').onclick = end;
  layer.querySelectorAll('.peg-pad button').forEach(b => {
    const k = b.dataset.k;
    b.addEventListener('pointerdown', e => { e.preventDefault(); resume(); keys.add(k); panel.classList.add('dim'); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => keys.delete(k)));
  });

  function boltShape(len) { const p = [[0, 0]]; for (let i = 1; i <= 5; i++) p.push([len * i / 5, (i % 2 ? 1 : -1) * (2 + Math.random() * 4)]); p[5][1] = 0; return p; }
  function burst(x, y, n, col) { for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, s = 60 + Math.random() * 260; parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: .5 + Math.random() * .6, t: 0, col }); } }

  let last = performance.now(), raf = 0;
  function frame(now) {
    const dt = Math.min(.033, (now - last) / 1000); last = now;
    // pilotage
    const turn = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
    ship.a += turn * 3.4 * dt;
    ship.bank += ((-turn * .55) - ship.bank) * Math.min(1, dt * 6);
    const dx = Math.cos(ship.a), dy = Math.sin(ship.a);
    if (keys.has('ArrowUp')) { ship.vx += dx * 950 * dt; ship.vy += dy * 950 * dt; }
    const drag = keys.has('ArrowDown') ? 3.2 : .55;
    ship.vx *= 1 - drag * dt; ship.vy *= 1 - drag * dt;
    const sp = Math.hypot(ship.vx, ship.vy), MAX = 760; if (sp > MAX) { ship.vx *= MAX / sp; ship.vy *= MAX / sp; }
    ship.x += ship.vx * dt; ship.y += ship.vy * dt;
    if (ship.x < 30) { ship.x = 30; ship.vx = Math.abs(ship.vx) * .5; } if (ship.x > W - 30) { ship.x = W - 30; ship.vx = -Math.abs(ship.vx) * .5; }
    ship.y = Math.max(40, Math.min(docH() - 40, ship.y));
    // la page suit le vol
    if (follow) {
      const sy = ship.y - scrollY;
      if (sy > H * .62) setScroll(ship.y - H * .62); else if (sy < H * .38) setScroll(ship.y - H * .38);
    }
    // foudre
    cooldown -= dt;
    if (keys.has(' ') && cooldown <= 0) {
      cooldown = .17;
      const nose = SIZE * .5;
      bolts.push({ x: ship.x + dx * nose, y: ship.y + dy * nose, vx: dx * 1250 + ship.vx * .4, vy: dy * 1250 + ship.vy * .4, a: ship.a, t: 0, shape: boltShape(38) });
    }
    for (const b of bolts) { b.t += dt; b.x += b.vx * dt; b.y += b.vy * dt; }
    // cauchemars
    for (const n of nightmares) {
      n.ph += dt; n.x += (n.vx + Math.sin(n.ph * .7) * 14) * dt; n.y += (n.vy + Math.cos(n.ph * .5) * 10) * dt;
      if (n.x < n.r || n.x > W - n.r) n.vx *= -1; n.hit = Math.max(0, n.hit - dt * 4);
      for (const b of bolts) if (!b.dead && Math.hypot(b.x - n.x, b.y - n.y) < n.r + 8) {
        b.dead = true; n.hp--; n.hit = 1; burst(b.x, b.y, 8, GOLD);
        if (!t0) t0 = now;
        if (n.hp <= 0) { n.dead = true; killed++; burst(n.x, n.y, 34, '#EFEBE3'); burst(n.x, n.y, 18, GOLD); updHud(); }
      }
    }
    for (let i = nightmares.length - 1; i >= 0; i--) if (nightmares[i].dead) nightmares.splice(i, 1);
    for (let i = bolts.length - 1; i >= 0; i--) if (bolts[i].dead || bolts[i].t > .9) bolts.splice(i, 1);
    for (const p of parts) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - 2 * dt; p.vy *= 1 - 2 * dt; }
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].t > parts[i].life) parts.splice(i, 1);
    if (t0 && !tEnd) hudTime.textContent = fmt((now - t0) / 1000);
    if (killed === total && !tEnd) { tEnd = now; win((now - t0) / 1000); }

    draw(now);
    raf = requestAnimationFrame(frame);
  }

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, -scrollY * DPR); ctx.clearRect(0, scrollY, W, H);
    // cauchemars : nuées d'encre avec deux yeux pâles
    for (const n of nightmares) {
      if (n.y < scrollY - 80 || n.y > scrollY + H + 80) continue;
      for (let k = 0; k < 5; k++) {
        const ox = Math.cos(n.ph * 1.3 + k * 1.26) * n.r * .38, oy = Math.sin(n.ph * 1.1 + k * 1.26) * n.r * .3;
        const g = ctx.createRadialGradient(n.x + ox, n.y + oy, 0, n.x + ox, n.y + oy, n.r * .95);
        g.addColorStop(0, `rgba(${n.hit ? '90,70,60' : '12,11,16'},.9)`); g.addColorStop(.6, 'rgba(12,11,16,.55)'); g.addColorStop(1, 'rgba(12,11,16,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x + ox, n.y + oy, n.r * .95, 0, 6.28); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(239,235,227,.12)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 1.05, 0, 6.28); ctx.stroke();
      const blink = Math.sin(n.ph * 2.3) > .96 ? .15 : 1;
      ctx.fillStyle = `rgba(239,235,227,${.85 * blink})`; ctx.shadowColor = '#EFEBE3'; ctx.shadowBlur = 8;
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(n.x + s * n.r * .22, n.y - n.r * .05, n.r * .07, n.r * .035 * blink + .5, 0, 0, 6.28); ctx.fill(); }
      ctx.shadowBlur = 0;
    }
    // foudre de Zeus
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const b of bolts) {
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.shadowColor = GOLD; ctx.shadowBlur = 14;
      ctx.strokeStyle = GOLD; ctx.lineWidth = 3; ctx.beginPath(); b.shape.forEach(([x, y], i) => i ? ctx.lineTo(-x, y) : ctx.moveTo(-x, y)); ctx.stroke();
      ctx.strokeStyle = '#FFF6DE'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore();
    }
    for (const p of parts) { ctx.globalAlpha = 1 - p.t / p.life; ctx.fillStyle = p.col; ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }
    ctx.globalAlpha = 1;
    // traînée dorée derrière Pégase
    const sp = Math.hypot(ship.vx, ship.vy);
    if (sp > 80) { for (let i = 0; i < 2; i++) parts.push({ x: ship.x - Math.cos(ship.a) * SIZE * .35 + (Math.random() - .5) * 10, y: ship.y - Math.sin(ship.a) * SIZE * .35 + (Math.random() - .5) * 10, vx: -ship.vx * .1, vy: -ship.vy * .1, life: .5, t: 0, col: 'rgba(232,199,122,.8)' }); }
    // Pégase (WebGL)
    yawG.position.set(ship.x - W / 2, H / 2 - (ship.y - scrollY), 0);
    yawG.rotation.z = -ship.a;
    rollG.rotation.x = Math.PI / 2 - .5 + ship.bank;                 // vu de dessus, légèrement de trois quarts
    rollG.position.z = Math.sin(now / 260) * 4;
    renderer.render(scene, cam);
  }

  function win(sec) {
    const box = document.createElement('div'); box.className = 'peg-win';
    box.innerHTML = `<p class="peg-eyebrow">ΝΙΚΗ</p><h3>${T.winTitle}</h3><p>${T.winText.replace('{t}', fmt(sec))}</p>
      <div><button class="peg-again">${T.again}</button><button class="peg-land">${T.land}</button></div>`;
    layer.appendChild(box);
    box.querySelector('.peg-again').onclick = () => { end(); setTimeout(() => launch({ from, i18n, onEnd }), 50); };
    box.querySelector('.peg-land').onclick = end;
  }

  function end() {
    if (!running) return; running = false;
    cancelAnimationFrame(raf); removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('resize', resize); removeEventListener('wheel', release); removeEventListener('touchmove', release); removeEventListener('scroll', onScroll);
    renderer.dispose(); layer.remove(); doc.style.scrollBehavior = prevBehavior; onEnd && onEnd();
  }
  raf = requestAnimationFrame(frame);
  return end;
}
