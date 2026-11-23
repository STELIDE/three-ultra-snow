import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { installUltraChunks, UltraSun, bakeHorizonShadow, withSnow, withSunVisibility, GlassReflections, UltraPost } from '../src/index.js';

// ---- options (?off=bloom,snow · ?sun=low) — every effect can be switched off to compare ----
const QS = new URLSearchParams(location.search);
const OFF = new Set((QS.get('off') || '').split(',').filter(Boolean));
const FX = { shadows: !OFF.has('shadows'), stable: !OFF.has('stable'), horizon: !OFF.has('horizon'), snow: !OFF.has('snow'), glass: !OFF.has('glass'), bloom: !OFF.has('bloom') };
const LOW_SUN = QS.get('sun') === 'low';
const MOBILE = matchMedia('(pointer: coarse)').matches;

installUltraChunks({ stableSoftShadows: FX.stable, dualSunShadow: true });

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 1.5, powerPreference: 'high-performance', preserveDrawingBuffer: QS.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = .85;
renderer.shadowMap.enabled = FX.shadows; renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const C = LOW_SUN
  ? { skyTop: '#4f78b8', skyHor: '#f3c9a8', sun: '#ffb486', sunW: .35, hemiSky: '#c3cfe6', dir: new THREE.Vector3(-90, 22, -30) }
  : { skyTop: '#3d7fd6', skyHor: '#d6e7f6', sun: '#fff1dc', sunW: .7, hemiSky: '#bcd6f2', dir: new THREE.Vector3(-80, 55, -45) };
scene.fog = new THREE.Fog(C.skyHor, 900, 5200);

// ---- terrain: a valley with a ridge to the west that throws a long afternoon shadow ----
function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z) { let s = 0, k = 1, f = 1 / 260; for (let i = 0; i < 5; i++) { s += (noise(x * f, z * f) - .5) * k; k *= .5; f *= 2.03; } return s; }
const LODGE = new THREE.Vector3(150, 0, 90);
function rawH(x, z) {
  const ridge = 470 * Math.exp(-(((x + 820) / 330) ** 2)) * (.7 + .3 * Math.sin(z / 310));
  const north = .32 * Math.max(0, 60 - z) + 380 * Math.exp(-(((z + 1500) / 500) ** 2));
  return ridge + north + fbm(x, z) * 70;
}
LODGE.y = rawH(LODGE.x, LODGE.z);
function H(x, z) { const d = Math.hypot(x - LODGE.x, z - LODGE.z), t = Math.min(1, Math.max(0, (d - 45) / 70)); const s = t * t * (3 - 2 * t); return LODGE.y + (rawH(x, z) - LODGE.y) * s; }

const SIZE = 4200, SEG = MOBILE ? 180 : 260;
function buildTerrain() {
  const n = SEG + 1, pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), idx = [];
  const snow = new THREE.Color('#f4f7fb'), rock = new THREE.Color('#6d6a66'), c = new THREE.Color();
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, x = -SIZE / 2 + SIZE * i / SEG, z = -SIZE / 2 + SIZE * j / SEG, y = H(x, z);
    pos.set([x, y, z], k * 3);
    const e = 4, slope = Math.hypot(H(x + e, z) - H(x - e, z), H(x, z + e) - H(x, z - e)) / (2 * e);
    const r = Math.min(1, Math.max(0, (slope - .75) / .35)) * (.6 + .4 * hash(i, j));
    c.copy(snow).lerp(rock, r); col.set([c.r, c.g, c.b], k * 3);
  }
  for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) { const a = j * n + i, b = a + 1, d = a + n, e = d + 1; idx.push(a, d, b, b, d, e); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (FX.horizon) g.setAttribute('sunVis', new THREE.BufferAttribute(bakeHorizonShadow(H, pos, C.dir), 1));
  if (FX.snow) withSnow(m, { ground: true, sunVisibility: FX.horizon });
  else if (FX.horizon) withSunVisibility(m);
  const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true;   // terrain never casts: ridges are covered by the baked shadow
  return mesh;
}

// ---- sky dome (excluded from everything) ----
function buildSky() {
  const m = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(C.skyTop) }, hor: { value: new THREE.Color(C.skyHor) }, sunDir: { value: C.dir.clone().normalize() }, sunCol: { value: new THREE.Color(C.sun).multiplyScalar(6) } },
    vertexShader: 'varying vec3 vD;\nvoid main() { vD = normalize( position ); gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
    fragmentShader: `uniform vec3 top, hor, sunDir, sunCol; varying vec3 vD;
void main() { float h = max( vD.y, 0.0 ); vec3 c = mix( hor, top, pow( h, .55 ) ); float s = max( dot( normalize( vD ), sunDir ), 0.0 );
  c += sunCol * ( pow( s, 2000.0 ) + .04 * pow( s, 24.0 ) ); gl_FragColor = vec4( c, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}` });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), m); sky.frustumCulled = false; return sky;
}

// ---- trees: instanced cones with snow caps ----
function buildTrees() {
  const N = MOBILE ? 1800 : 3600, trunk = new THREE.ConeGeometry(1, 1, 7), cap = new THREE.ConeGeometry(.82, .55, 7);
  trunk.translate(0, .5, 0); cap.translate(0, .78, 0);
  const green = new THREE.MeshLambertMaterial({ color: '#2b4434' }), white = new THREE.MeshLambertMaterial({ color: '#eef3f8' });
  if (FX.snow) withSnow(white);
  const A = new THREE.InstancedMesh(trunk, green, N), B = new THREE.InstancedMesh(cap, white, N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  let k = 0, tries = 0;
  while (k < N && tries++ < N * 20) {
    const x = (hash(tries, 1) - .5) * 2600, z = (hash(tries, 2) - .5) * 2600 - 150, y = H(x, z);
    if (Math.hypot(x - LODGE.x, z - LODGE.z) < 75 || Math.abs(x - runX(z)) < 45) continue;
    const slope = Math.hypot(H(x + 3, z) - H(x - 3, z), H(x, z + 3) - H(x, z - 3)) / 6; if (slope > .7) continue;
    const h = 7 + hash(tries, 3) * 9, r = h * (.28 + hash(tries, 4) * .06);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, hash(tries, 5) * 6.28); m4.compose(p.set(x, y - .5, z), q, s.set(r, h, r));
    A.setMatrixAt(k, m4); B.setMatrixAt(k, m4); k++;
  }
  A.count = B.count = k; A.receiveShadow = B.receiveShadow = true;
  const g = new THREE.Group(); g.add(A, B); return g;
}
function runX(z) { return 330 + 90 * Math.sin(z / 210); }

// ---- lodge: windows painted into the wall texture, glass detected by colour ----
function windowTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#6b4a33'; g.fillRect(0, 0, 512, 256);
  for (let y = 0; y < 256; y += 8) { g.fillStyle = y % 16 ? '#5f412c' : '#74503a'; g.fillRect(0, y, 512, 3); }
  for (let row = 0; row < 2; row++) for (let i = 0; i < 6; i++) {
    const x = 22 + i * 82, y = 34 + row * 112; g.fillStyle = '#e7e1d6'; g.fillRect(x - 5, y - 5, 66, 82);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) { g.fillStyle = (a + b) % 2 ? '#3c6fa8' : '#4679b2'; g.fillRect(x + a * 29, y + b * 37, 27, 35); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function buildLodge(glass) {
  const g = new THREE.Group(), wall = new THREE.MeshPhongMaterial({ map: windowTexture(), shininess: 10 });
  if (glass) glass.apply(wall);
  const body = new THREE.Mesh(new THREE.BoxGeometry(34, 14, 20), wall); body.position.y = 7;
  const roofM = new THREE.MeshLambertMaterial({ color: '#f1f5fa' }); if (FX.snow) withSnow(roofM);
  const roofG = new THREE.CylinderGeometry(.01, 14.5, 9, 4, 1); roofG.rotateY(Math.PI / 4); roofG.scale(1.75, 1, 1);
  const roof = new THREE.Mesh(roofG, roofM); roof.position.y = 18.5;
  const eaves = new THREE.Mesh(new THREE.BoxGeometry(36, .8, 22), new THREE.MeshLambertMaterial({ color: '#4c3424' })); eaves.position.y = 14.2;
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(2.4, 7, 2.4), new THREE.MeshLambertMaterial({ color: '#7d7670' })); chimney.position.set(9, 21, 3);
  g.add(body, roof, eaves, chimney);
  for (const o of g.children) o.receiveShadow = true;
  g.position.copy(LODGE); g.rotation.y = -.35; return g;
}

// ---- a skier going down the run: the dynamic shadow layer ----
function buildSkier() {
  const g = new THREE.Group(), suit = new THREE.MeshLambertMaterial({ color: '#c8352c' });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.32, .9, 4, 8), suit); body.position.y = 1.0; body.rotation.x = .35;
  const skis = new THREE.Mesh(new THREE.BoxGeometry(.5, .05, 1.8), new THREE.MeshLambertMaterial({ color: '#202631' })); skis.position.y = .03;
  g.add(body, skis); return g;
}

// ---- assemble ----
const t0 = performance.now();
scene.add(new THREE.HemisphereLight(C.hemiSky, '#e8eef5', Math.PI * .6));
const sun = new UltraSun(scene, { direction: C.dir, color: new THREE.Color(C.sun).lerp(new THREE.Color('#ffffff'), C.sunW), intensity: Math.PI * 1.5,
  staticLayer: MOBILE ? { mapSize: 2048, extent: 150 } : { mapSize: 4096, extent: 220 }, dynamicLayer: MOBILE ? { mapSize: 1024, extent: 60 } : { mapSize: 2048, extent: 90 } });
if (!FX.shadows) sun.sun.castShadow = sun.shadowOnly.castShadow = false;
const sky = buildSky(); scene.add(sky);
const terrain = buildTerrain(); scene.add(terrain);
const trees = buildTrees(); scene.add(trees); sun.addStatic(trees);
const glass = FX.glass ? new GlassReflections({ skyTop: C.skyTop, skyHorizon: C.skyHor }) : null;
const lodge = buildLodge(glass); scene.add(lodge); sun.addStatic(lodge);
const skier = buildSkier(); scene.add(skier); sun.addDynamic(skier);
for (const o of skier.children) o.receiveShadow = true;
const post = FX.bloom ? new UltraPost(renderer, { msaa: renderer.getContextAttributes().antialias ? 4 : 0 }) : null;
const buildMs = performance.now() - t0;

const camera = new THREE.PerspectiveCamera(55, 1, .5, 12000);
const view = (QS.get('view') || '').split(',').map(Number);
if (view.length === 6 && view.every(isFinite)) camera.position.set(view[0], view[1], view[2]);
else camera.position.set(LODGE.x + 70, LODGE.y + 16, LODGE.z + 62);
const controls = new OrbitControls(camera, canvas);
controls.target.copy(view.length === 6 ? new THREE.Vector3(view[3], view[4], view[5]) : new THREE.Vector3(LODGE.x - 40, LODGE.y + 22, LODGE.z - 60));
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * .495; controls.update();

if (glass) { sun.update(renderer, camera, { groundHeight: H }); glass.captureEnvironment(renderer, scene, LODGE.clone().add(new THREE.Vector3(0, 50, 0)), MOBILE ? 128 : 256); }

function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ---- loop ----
const timer = new THREE.Timer(), vel = new THREE.Vector3();
let runT = QS.has('t') ? +QS.get('t') : 0, frames = 0, fpsT = 0;
const fpsEl = document.getElementById('fps');
function skierAt(t) { const z = -700 + ((t * 14) % 1000); return new THREE.Vector3(runX(z), H(runX(z), z), z); }
function frame(now) {
  timer.update(now); const dt = Math.min(timer.getDelta(), .1);
  if (!QS.has('t')) runT += dt;
  const p = skierAt(runT), ahead = skierAt(runT + .1);
  skier.position.copy(p); skier.lookAt(ahead.x, p.y, ahead.z); vel.subVectors(ahead, p).multiplyScalar(10);
  sky.position.copy(camera.position);
  controls.update();
  if (FX.shadows) sun.update(renderer, camera, { groundHeight: H });
  if (post) post.render(scene, camera); else renderer.render(scene, camera);
  frames++; fpsT += dt; if (fpsT > .5) { fpsEl.textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__demo = { renderer, scene, camera, controls, sun, buildMs, FX };

// ---- panel ----
const LABELS = { shadows: 'Two-layer sun shadows', stable: 'Stable soft shadows', horizon: 'Baked mountain shadows', snow: 'Snow sheen & glints', glass: 'Window glass', bloom: 'HDR bloom' };
const panel = document.getElementById('fx');
for (const k of Object.keys(LABELS)) {
  const l = document.createElement('label'), c = document.createElement('input'); c.type = 'checkbox'; c.checked = FX[k];
  c.onchange = () => { const off = Object.keys(FX).filter(j => j === k ? !c.checked : !FX[j]); const u = new URLSearchParams(location.search); off.length ? u.set('off', off.join(',')) : u.delete('off'); location.search = u.toString(); };
  l.append(c, ' ' + LABELS[k]); panel.append(l);
}
document.getElementById('sun').onclick = () => { const u = new URLSearchParams(location.search); LOW_SUN ? u.delete('sun') : u.set('sun', 'low'); location.search = u.toString(); };
document.getElementById('sun').textContent = LOW_SUN ? 'Midday sun' : 'Low sun';
