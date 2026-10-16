// Landing hero: a living miniature of a mall. A crowd walks the corridors while one
// search plays out: a child slips away from a parent at the food court, the officer
// approves, the alert widens to every zone and the exits are watched, a guard spots
// the child by Gate 3, and the guard walks the child back.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const stage = document.getElementById("stage");
const canvas = document.getElementById("venue");
const chips = [...document.querySelectorAll(".chip-float")];
const storySteps = [...document.querySelectorAll(".story li")];
const storyFill = document.querySelector(".story-fill");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = innerWidth < 760;

const COL = {
  paper: 0xf5f1e8, slab: 0xe6dece, floor: 0xf1ebdf, plaza: 0xf7f1e4, wall: 0xfbf8f1, wallTop: 0xd9cfbb,
  signal: new THREE.Color("#e2552d"), signalSoft: new THREE.Color("#f6d2c3"), sky: new THREE.Color("#356c9c"),
  sage: new THREE.Color("#2f7d6b"), amber: new THREE.Color("#c98a1b"), ink: new THREE.Color("#13202f"),
};

// ---------- timeline ----------
const LOOP = 23;
const T = { lost: 3, report: 4, approve: 6, wide: 9, sight: 12.5, found: 16.5, home: 21 };
const STORY = [T.report, T.approve, T.wide, T.sight, T.found];
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const ease = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const phaseAt = (t) => STORY.filter((s) => t >= s).length - 1;   // -1 before the report

function showStory(phase, t) {
  chips.forEach((c) => c.classList.toggle("on", Number(c.dataset.phase) <= phase));
  storySteps.forEach((li, i) => { li.classList.toggle("done", i < phase); li.classList.toggle("now", i === phase); });
  if (storyFill) storyFill.style.transform = `scaleX(${clamp01((t - T.report) / (T.home - T.report))})`;
}

// ---------- renderer ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (e) {
  stage.insertAdjacentHTML("beforeend", '<div class="stage-fallback">The 3D view needs WebGL.</div>');
  showStory(4, LOOP);
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(COL.paper, 46, 80);
const camera = new THREE.PerspectiveCamera(27, 1, 0.1, 200);

scene.add(new THREE.HemisphereLight(0xfff7ea, 0xc8bca4, 1.05));
const sun = new THREE.DirectionalLight(0xfff0da, 2.1);
sun.position.set(-9, 18, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 50 });
sun.shadow.radius = 5;
sun.shadow.bias = -0.0004;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xdfe8f2, 0.35);
fill.position.set(10, 6, -8);
scene.add(fill);

const std = (color, rough = 0.85) => new THREE.MeshStandardMaterial({ color, roughness: rough });
function add(mesh, { cast = true, receive = true } = {}) { mesh.castShadow = cast; mesh.receiveShadow = receive; scene.add(mesh); return mesh; }

// ---------- floor ----------
const slab = add(new THREE.Mesh(new RoundedBoxGeometry(17.2, 0.6, 13.2, 4, 0.28), std(COL.slab, 0.95)), { cast: false });
slab.position.y = -0.3;

function tileTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#f1ebdf"; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "rgba(170,155,128,.22)"; g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(16, 12); tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(16.4, 12.4), new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.9 })), { cast: false });
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0.002;

// ---------- rooms ----------
// [name, x0, x1, z0, z1, wall height, openings {side, from, to}, floor colour]
const wallMat = std(COL.wall, 0.8);
const wallTopMat = std(COL.wallTop, 0.8);
const rooms = [];
function room(name, x0, x1, z0, z1, h, openings, floorColor) {
  const f = add(new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), std(floorColor, 0.9)), { cast: false });
  f.rotation.x = -Math.PI / 2;
  f.position.set((x0 + x1) / 2, 0.006, (z0 + z1) / 2);
  const t = 0.09;
  const side = (s, a0, a1, fixed) => {
    const gaps = openings.filter((o) => o.side === s).sort((p, q) => p.from - q.from);
    let cur = a0;
    const segs = [];
    gaps.forEach((gp) => { if (gp.from > cur) segs.push([cur, gp.from]); cur = Math.max(cur, gp.to); });
    if (cur < a1) segs.push([cur, a1]);
    segs.forEach(([p, q]) => {
      const len = q - p;
      const horiz = s === "n" || s === "s";
      const w = add(new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : t, h, horiz ? t : len), wallMat));
      w.position.set(horiz ? (p + q) / 2 : fixed, h / 2, horiz ? fixed : (p + q) / 2);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : t + 0.01, 0.02, horiz ? t + 0.01 : len), wallTopMat);
      cap.position.y = h / 2 + 0.01;
      w.add(cap);
    });
  };
  if (h > 0) {
    side("n", x0, x1, z0); side("s", x0, x1, z1);
    side("w", z0, z1, x0); side("e", z0, z1, x1);
  }
  const r = { name, x: (x0 + x1) / 2, z: (z0 + z1) / 2, floor: f, base: new THREE.Color(floorColor), tint: 0 };
  rooms.push(r);
  return r;
}

const plaza = room("Food Court", -2.4, 2.4, -1.6, 1.8, 0, [], 0xf6efe2);
room("Kids Play Area", -7.6, -4.0, -1.5, 1.8, 0.32, [{ side: "e", from: -0.6, to: 0.9 }], 0xf3ead8);
room("Cinema", -1.4, 5.6, -5.8, -3.3, 1.05, [{ side: "s", from: 1.4, to: 2.8 }], 0xece6dc);
room("Shop", -7.6, -4.6, -5.8, -3.3, 0.42, [{ side: "s", from: -6.6, to: -5.6 }], 0xf2ede3);
room("Shop", -4.4, -2.2, -5.8, -3.3, 0.42, [{ side: "s", from: -3.8, to: -2.9 }], 0xf2ede3);
room("Shop", 4.0, 7.6, -1.5, 1.6, 0.42, [{ side: "w", from: -0.5, to: 0.6 }], 0xf2ede3);
room("Shop", -7.6, -3.0, 3.4, 5.8, 0.42, [{ side: "n", from: -5.8, to: -4.6 }], 0xf2ede3);
room("Shop", -0.4, 3.6, 3.4, 5.8, 0.42, [{ side: "n", from: 1.0, to: 2.2 }], 0xf2ede3);
room("Shop", 5.8, 7.6, 3.4, 5.8, 0.42, [{ side: "n", from: 6.2, to: 7.2 }], 0xf2ede3);

// outer wall with the exits left open
const outer = [
  ["n", -8.2, 8.2, -6.2, []], ["s", -8.2, 8.2, 6.2, [[-2.4, -0.6], [4.0, 5.6]]],
  ["w", -6.2, 6.2, -8.2, [[-3.1, -1.7]]], ["e", -6.2, 6.2, 8.2, [[1.9, 3.3]]],
];
outer.forEach(([s, a0, a1, fixed, gaps]) => {
  let cur = a0; const segs = [];
  gaps.forEach(([p, q]) => { segs.push([cur, p]); cur = q; });
  segs.push([cur, a1]);
  segs.forEach(([p, q]) => {
    const horiz = s === "n" || s === "s";
    const w = add(new THREE.Mesh(new THREE.BoxGeometry(horiz ? q - p : 0.14, 0.5, horiz ? 0.14 : q - p), wallMat));
    w.position.set(horiz ? (p + q) / 2 : fixed, 0.25, horiz ? fixed : (p + q) / 2);
  });
});

// gates: arches over the exits, they glow amber while the exits are watched
const archMat = new THREE.MeshStandardMaterial({ color: 0x8d9fb2, roughness: 0.5, emissive: COL.amber.clone(), emissiveIntensity: 0 });
const GATES = { "Gate 3": [-8.2, -2.4, "x"], "Gate 2": [8.2, 2.6, "x"], "Gate 1": [4.8, 6.2, "z"], "Main Entrance": [-1.5, 6.2, "z"] };
Object.entries(GATES).forEach(([name, [x, z, axis]]) => {
  const span = name === "Main Entrance" ? 1.8 : 1.4;
  const g = new THREE.Group();
  const post = new THREE.BoxGeometry(0.14, 0.95, 0.14);
  const a = new THREE.Mesh(post, archMat), b = new THREE.Mesh(post, archMat);
  a.position.set(-span / 2, 0.475, 0); b.position.set(span / 2, 0.475, 0);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 0.14, 0.14, 0.14), archMat);
  beam.position.y = 0.95;
  [a, b, beam].forEach((m) => { m.castShadow = true; g.add(m); });
  g.position.set(x, 0, z);
  if (axis === "x") g.rotation.y = Math.PI / 2;
  scene.add(g);
});

// ---------- furniture ----------
function instanced(geo, mat, list, { cast = true } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, list.length);
  const o = new THREE.Object3D();
  list.forEach(([x, y, z, sx = 1, sy = 1, sz = 1, ry = 0], i) => { o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.rotation.set(0, ry, 0); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
  m.castShadow = cast; m.receiveShadow = true;
  scene.add(m);
  return m;
}
// food court tables and umbrellas
const tables = [];
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tables.push([-1.5 + i * 1.5 + (j % 2) * 0.35, 0, -0.9 + j * 1.1]);
instanced(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 20), std(0xfffdf8, 0.6), tables.map(([x, , z]) => [x, 0.2, z]));
instanced(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 6), std(0x9a8f7d), tables.map(([x, , z]) => [x, 0.1, z]));
instanced(new THREE.ConeGeometry(0.42, 0.16, 18), std(0xe9a48a, 0.7), tables.filter((_, i) => i % 2 === 0).map(([x, , z]) => [x, 0.62, z]));
instanced(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 5), std(0x9a8f7d), tables.filter((_, i) => i % 2 === 0).map(([x, , z]) => [x, 0.4, z]));
// cinema seats and screen
const seats = [];
for (let r = 0; r < 4; r++) for (let s = 0; s < 12; s++) seats.push([0.0 + s * 0.42, 0.06, -4.1 - r * 0.38]);
instanced(new THREE.BoxGeometry(0.3, 0.12, 0.24), std(0xb98a78, 0.8), seats);
add(new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.6, 0.05), std(0x2a3646, 0.4))).position.set(2.1, 0.55, -5.72);
// shelves in the shops
const shelves = [[-6.1, -5.6, 2.2], [-3.3, -5.6, 1.6], [7.4, 0.05, 2.6, true], [-5.3, 5.6, 3.6], [1.6, 5.6, 3.2], [6.7, 5.6, 1.4]];
instanced(new THREE.BoxGeometry(1, 0.34, 0.22), std(0xd8cbb3), shelves.map(([x, z, len, rot]) => [x, 0.17, z, len, 1, 1, rot ? Math.PI / 2 : 0]));
// play area
instanced(new THREE.SphereGeometry(0.12, 14, 10), std(0xe7b9a0, 0.7), [[-6.8, 0.12, 1.1], [-6.5, 0.12, 1.3], [-6.9, 0.12, 1.45], [-5.0, 0.12, -1.0], [-4.7, 0.12, -0.8]]);
instanced(new THREE.BoxGeometry(0.9, 0.06, 0.4), std(0x9fb7c9, 0.6), [[-5.7, 0.28, 0.1, 1, 1, 1, 0.5]]).rotation.z = 0;
instanced(new THREE.BoxGeometry(0.5, 0.5, 0.5), std(0xe9d8b4, 0.8), [[-6.6, 0.25, -0.8]]);
// planters along the corridors
const planters = [[-3.9, -2.4], [-0.2, -2.4], [3.6, -2.4], [6.6, -2.4], [-6.4, 2.6], [-3.9, 2.6], [0.2, 2.6], [3.8, 2.6], [6.6, 2.6]];
instanced(new THREE.CylinderGeometry(0.16, 0.13, 0.22, 12), std(0xcbbfa8), planters.map(([x, z]) => [x, 0.11, z + (z < 0 ? -0.5 : 0.5)]));
instanced(new THREE.IcosahedronGeometry(0.24, 1), std(0x8fa98c, 0.9), planters.map(([x, z]) => [x, 0.38, z + (z < 0 ? -0.5 : 0.5)]));

// labels
function label(text, x, z, y = 0.05) {
  const c = document.createElement("canvas"); c.width = 512; c.height = 80;
  const g = c.getContext("2d");
  g.font = "700 38px Inter, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(19,32,47,0.72)";
  g.fillText(text.toUpperCase().split("").join(String.fromCharCode(8202)), 256, 42);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
  scene.add(m);
}
label("Food Court", 0, 1.45, 0.012);
label("Kids Play Area", -5.8, 1.45, 0.012);
label("Cinema", 4.4, -3.6, 0.012);
label("Gate 3", -6.6, -1.75, 0.012);
label("Gate 2", 7.25, 3.4, 0.012);
label("Gate 1", 4.8, 5.4, 0.012);
label("Main Entrance", -1.5, 5.4, 0.012);

// ---------- people ----------
const LANES = [
  [[-7.9, -2.4], [7.9, -2.4]], [[-7.9, 2.6], [7.9, 2.6]], [[-3.2, -2.4], [-3.2, 2.6]], [[3.2, -2.4], [3.2, 2.6]],
  [[-1.5, 2.6], [-1.5, 6.6]], [[4.8, 2.6], [4.8, 6.6]], [[-8.6, -2.4], [-3.2, -2.4]], [[3.2, 0.0], [4.1, 0.0]],
].map(([a, b]) => ({ a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) }));
const PALETTE = ["#3b4a5c", "#6b7a8c", "#8c7b6b", "#a39382", "#5d6d5a", "#7f6a5a", "#c4b8a6", "#4d5b6b", "#9a8a9e", "#b7a37f", "#6f7f72"].map((c) => new THREE.Color(c));
const SKIN = ["#e8c6a8", "#c99a78", "#a7765a", "#f0d5bd", "#8a5d44"].map((c) => new THREE.Color(c));
const N = small ? 90 : 190;
const bodyGeo = new THREE.CapsuleGeometry(0.075, 0.17, 3, 8);
bodyGeo.translate(0, 0.16, 0);
const headGeo = new THREE.SphereGeometry(0.065, 12, 10);
headGeo.translate(0, 0.37, 0);
const bodies = new THREE.InstancedMesh(bodyGeo, std(0xffffff, 0.75), N);
const heads = new THREE.InstancedMesh(headGeo, std(0xffffff, 0.6), N);
bodies.castShadow = heads.castShadow = true;
scene.add(bodies, heads);

const people = [];
const rnd = (a, b) => a + Math.random() * (b - a);
for (let i = 0; i < N; i++) {
  const inPlaza = i < N * 0.22;
  const p = { lane: inPlaza ? -1 : i % LANES.length, u: Math.random(), dir: Math.random() < 0.5 ? 1 : -1, speed: rnd(0.35, 0.62),
    off: rnd(-0.38, 0.38), x: 0, z: 0, tx: 0, tz: 0, step: Math.random() * 6, scale: rnd(0.9, 1.08) };
  if (inPlaza) { p.x = p.tx = rnd(-2.1, 2.1); p.z = p.tz = rnd(-1.3, 1.5); p.speed = rnd(0.12, 0.3); }
  bodies.setColorAt(i, PALETTE[i % PALETTE.length]);
  heads.setColorAt(i, SKIN[(i * 7) % SKIN.length]);
  people.push(p);
}
const dummy = new THREE.Object3D();
function stepPeople(dt, time) {
  for (let i = 0; i < N; i++) {
    const p = people[i];
    let heading;
    if (p.lane < 0) {
      const dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz);
      if (d < 0.05) { p.tx = rnd(-2.1, 2.1); p.tz = rnd(-1.3, 1.5); continue; }
      const s = Math.min(d, p.speed * dt);
      p.x += (dx / d) * s; p.z += (dz / d) * s;
      heading = Math.atan2(dx, dz);
    } else {
      const L = LANES[p.lane];
      p.u += (p.dir * p.speed * dt) / L.len;
      if (p.u > 1 || p.u < 0) { p.dir *= -1; p.u = clamp01(p.u); if (Math.random() < 0.3) p.lane = Math.floor(Math.random() * LANES.length); }
      const ax = L.b[0] - L.a[0], az = L.b[1] - L.a[1];
      p.x = L.a[0] + ax * p.u + (-az / L.len) * p.off;
      p.z = L.a[1] + az * p.u + (ax / L.len) * p.off;
      heading = Math.atan2(ax * p.dir, az * p.dir);
    }
    p.step += dt * 9;
    dummy.position.set(p.x, Math.abs(Math.sin(p.step)) * 0.025, p.z);
    dummy.rotation.set(0, heading, Math.sin(p.step) * 0.06);
    dummy.scale.setScalar(p.scale);
    dummy.updateMatrix();
    bodies.setMatrixAt(i, dummy.matrix);
    heads.setMatrixAt(i, dummy.matrix);
  }
  bodies.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
}

// ---------- the parent, the child, the guards ----------
function figure(color, scale, ring) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.55, emissive: color, emissiveIntensity: 0.12 }));
  const h = new THREE.Mesh(headGeo, std(0xe8c6a8, 0.6));
  b.castShadow = h.castShadow = true;
  g.add(b, h);
  g.scale.setScalar(scale);
  if (ring) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 40), new THREE.MeshBasicMaterial({ color: ring, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    r.rotation.x = -Math.PI / 2; r.position.y = 0.01;
    g.add(r); g.userData.ring = r;
  }
  scene.add(g);
  return g;
}
const PARENT = new THREE.Vector3(0.95, 0, 0.55);
const parent = figure(COL.ink, 1.05, COL.signal);
parent.position.copy(PARENT);
const child = figure(COL.signal, 0.82, COL.signal);
const marker = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 4), new THREE.MeshStandardMaterial({ color: COL.signal, emissive: COL.signal, emissiveIntensity: 0.35, roughness: 0.4 }));
marker.rotation.x = Math.PI;
marker.castShadow = true;
scene.add(marker);
const CHILD_PATH = new THREE.CatmullRomCurve3([[0.62, 0.4], [-0.6, 0.2], [-2.0, 0.35], [-3.2, -0.4], [-3.25, -2.2], [-4.8, -2.45], [-6.7, -2.3]]
  .map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");

const GUARD_POSTS = {
  approve: [[-2.7, -1.9], [2.7, -1.9], [2.7, 2.2], [-2.7, 2.2], [0, 2.3]],
  wide: [[-7.5, -2.4], [7.5, 2.6], [4.8, 5.5], [-1.5, 5.5], [0.2, -2.6]],
};
const guards = [0, 2, 3, 1, 4].map((lane, i) => {
  const g = figure(COL.sky, 1.0, null);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), new THREE.MeshBasicMaterial({ color: COL.sky, transparent: true, opacity: 0.16, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.012;
  g.add(disc);
  const L = LANES[lane];
  g.userData = { ...g.userData, lane, u: 0.2 + i * 0.15, dir: 1, disc };
  g.position.set(L.a[0], 0, L.a[1]);
  return g;
});

// effects
function ringMesh(color, r0, r1) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.02;
  scene.add(m);
  return m;
}
const reportRings = [0, 1, 2].map(() => ringMesh(COL.signal, 0.9, 1));
const wave = ringMesh(COL.signal, 0.97, 1);
const sightRings = [0, 1].map(() => ringMesh(COL.sky, 0.88, 1));
const foundRing = ringMesh(COL.sage, 0.85, 1);
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 4, 24, 1, true),
  new THREE.MeshBasicMaterial({ color: COL.sky, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
scene.add(beam);
let arc = null;

// ---------- frame ----------
const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
stage.addEventListener("pointermove", (e) => {
  const r = stage.getBoundingClientRect();
  pointer.x = (e.clientX - r.left) / r.width - 0.5;
  pointer.y = (e.clientY - r.top) / r.height - 0.5;
});
stage.addEventListener("pointerleave", () => { pointer.x = 0; pointer.y = 0; });

const look = new THREE.Vector3(0, 0, 0.3);
const tmpV = new THREE.Vector3();
const chipTimer = document.querySelector(".chip-a .mono");
let lastPhase = -2, lastT = 0, lastTime = 0;

function moveToward(obj, x, z, speed, dt) {
  const dx = x - obj.position.x, dz = z - obj.position.z, d = Math.hypot(dx, dz);
  if (d < 0.01) return false;
  const s = Math.min(d, speed * dt);
  obj.position.x += (dx / d) * s; obj.position.z += (dz / d) * s;
  obj.rotation.y = Math.atan2(dx, dz);
  return true;
}

function frame(time) {
  const dt = Math.min((time - lastTime) / 1000, 0.05) || 0.016;
  lastTime = time;
  const t = (time / 1000) % LOOP;
  if (t < lastT) { arc && (scene.remove(arc), arc.geometry.dispose()); arc = null; }
  lastT = t;
  const phase = phaseAt(t);
  if (phase !== lastPhase) lastPhase = phase;
  showStory(phase, t);
  if (chipTimer) {
    const s = Math.max(0, Math.floor((t - T.report) * 26));
    chipTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  stepPeople(dt, time);

  // child: by the parent, slips away, waits near Gate 3, then walks back with a guard
  let cp;
  if (t < T.lost) cp = CHILD_PATH.getPointAt(0).clone().add(tmpV.set(Math.sin(time / 700) * 0.08, 0, Math.cos(time / 900) * 0.06));
  else if (t < T.sight) cp = CHILD_PATH.getPointAt(ease((t - T.lost) / (T.sight - 1 - T.lost)) * 0.999);
  else if (t < T.found) cp = CHILD_PATH.getPointAt(0.999);
  else cp = CHILD_PATH.getPointAt(Math.max(0, 1 - ease((t - T.found) / (T.home - T.found))) * 0.999);
  const prev = child.position.clone();
  child.position.set(cp.x, Math.abs(Math.sin(time / 120)) * 0.02, cp.z);
  if (prev.distanceTo(child.position) > 0.002) child.rotation.y = Math.atan2(child.position.x - prev.x, child.position.z - prev.z);
  child.userData.ring.material.opacity = t > T.report && t < T.home ? 0.9 : 0;
  marker.position.set(child.position.x, 0.78 + Math.sin(time / 260) * 0.06, child.position.z);
  marker.rotation.y = time / 700;
  const markerOn = t > T.lost - 0.5 && t < T.home;
  marker.scale.setScalar(THREE.MathUtils.lerp(marker.scale.x, markerOn ? 1 : 0.001, 0.1));
  marker.material.color.copy(t >= T.found ? COL.sage : t >= T.sight ? COL.sky : COL.signal);
  marker.material.emissive.copy(marker.material.color);
  child.userData.ring.material.color.copy(t >= T.found ? COL.sage : t >= T.sight ? COL.sky : COL.signal);

  // parent turns to look around once the child is gone
  parent.rotation.y = t > T.report && t < T.found ? Math.sin(time / 600) * 1.2 : -2.4;
  parent.userData.ring.material.opacity = t > T.report && t < T.home ? 0.8 : 0;
  parent.userData.ring.material.color.copy(t >= T.found ? COL.sage : COL.signal);

  // guards: patrol, gather round the food court, watch the exits, converge, escort
  guards.forEach((g, i) => {
    const d = g.userData;
    const L = LANES[d.lane];
    d.u += (d.dir * 0.35 * dt) / L.len;
    if (d.u > 1 || d.u < 0) { d.dir *= -1; d.u = clamp01(d.u); }
    let tx = L.a[0] + (L.b[0] - L.a[0]) * d.u, tz = L.a[1] + (L.b[1] - L.a[1]) * d.u, speed = 0.5;
    if (t >= T.approve && t < T.wide) { [tx, tz] = GUARD_POSTS.approve[i]; speed = 2.2; }
    if (t >= T.wide && t < T.found) { [tx, tz] = GUARD_POSTS.wide[i]; speed = 2.4; }
    if (t >= T.sight + 0.6 && t < T.found && (i === 0 || i === 2)) { tx = child.position.x + (i ? -0.3 : 0.35); tz = child.position.z + (i ? 0.35 : 0.1); speed = 2.4; }
    if (t >= T.found && t < T.home && i === 0) { tx = child.position.x + 0.28; tz = child.position.z + 0.12; speed = 3; }
    else if (t >= T.found) speed = 1.6;
    moveToward(g, tx, tz, speed, dt);
    g.position.y = Math.abs(Math.sin(time / 140 + i)) * 0.02;
    const r = t >= T.wide && t < T.found ? 0.9 + Math.sin(time / 300 + i) * 0.08 : 0.5;
    d.disc.scale.setScalar(THREE.MathUtils.lerp(d.disc.scale.x, r, 0.08));
    d.disc.material.opacity = t >= T.wide && t < T.found ? 0.22 : 0.14;
  });

  // report ripples at the parent
  reportRings.forEach((m, i) => {
    const on = t >= T.report && t < T.sight;
    const p = ((time / 1800) + i / 3) % 1;
    m.position.set(PARENT.x, 0.02, PARENT.z);
    m.scale.setScalar(0.3 + p * (t >= T.approve ? 3.2 : 1.6));
    m.material.opacity = on ? (1 - p) * 0.6 : Math.max(0, m.material.opacity - 0.02);
  });

  // the widening wave and zone tint
  const waveR = t >= T.wide && t < T.wide + 2.6 ? ease((t - T.wide) / 2.6) * 13 : t >= T.wide + 2.6 && t < T.found ? 14 : 0;
  wave.position.set(PARENT.x, 0.025, PARENT.z);
  wave.scale.setScalar(Math.max(waveR, 0.001));
  wave.material.opacity = t >= T.wide && t < T.wide + 2.6 ? 0.55 * (1 - (t - T.wide) / 2.6) : 0;
  rooms.forEach((r) => {
    let k = 0;
    if (t >= T.approve && t < T.found && r === plaza) k = 0.75;
    if (t >= T.wide && t < T.found && Math.hypot(r.x - PARENT.x, r.z - PARENT.z) < waveR) k = r === plaza ? 0.75 : 0.55;
    r.tint += (k - r.tint) * 0.05;
    r.floor.material.color.copy(r.base).lerp(COL.signalSoft, r.tint);
  });
  archMat.emissiveIntensity += ((t >= T.wide && t < T.found ? 0.55 + Math.sin(time / 260) * 0.2 : 0) - archMat.emissiveIntensity) * 0.08;

  // sighting: beam, rings and the arc back to the parent
  const sightOn = t >= T.sight && t < T.found + 1;
  beam.position.set(child.position.x, 2, child.position.z);
  beam.material.opacity += ((sightOn ? 0.22 : 0) - beam.material.opacity) * 0.1;
  sightRings.forEach((m, i) => {
    const p = ((time / 1100) + i / 2) % 1;
    m.position.set(child.position.x, 0.03, child.position.z);
    m.scale.setScalar(0.25 + p * 1.3);
    m.material.opacity = t >= T.sight && t < T.found ? (1 - p) * 0.8 : 0;
  });
  if (t >= T.sight + 0.3 && !arc) {
    const a = new THREE.Vector3(PARENT.x, 0.55, PARENT.z), b = new THREE.Vector3(child.position.x, 0.4, child.position.z);
    const mid = a.clone().lerp(b, 0.5); mid.y = 3.2;
    arc = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 90, 0.035, 8, false),
      new THREE.MeshBasicMaterial({ color: COL.sky, transparent: true, opacity: 0.85 }));
    scene.add(arc);
  }
  if (arc) {
    const n = arc.geometry.index.count;
    arc.geometry.setDrawRange(0, Math.floor((n * ease((t - T.sight - 0.3) / 1.2)) / 3) * 3);
    arc.material.opacity = t < T.found ? 0.85 : Math.max(0, 0.85 - (t - T.found) * 0.6);
  }

  // reunion
  const fp = t >= T.home - 0.6 ? (t - T.home + 0.6) / 1.8 : -1;
  foundRing.position.set(PARENT.x, 0.03, PARENT.z);
  foundRing.scale.setScalar(0.3 + clamp01(fp) * 2.2);
  foundRing.material.opacity = fp >= 0 && fp <= 1 ? (1 - fp) * 0.9 : 0;

  // camera: slow drift, pointer parallax, and a gentle push in during the sighting
  pointer.sx += (pointer.x - pointer.sx) * 0.05; pointer.sy += (pointer.y - pointer.sy) * 0.05;
  const focus = t >= T.sight - 0.5 && t < T.found + 1.5 ? 0.3 : 0;
  look.lerp(tmpV.set(child.position.x * focus, 0, 0.3 + (child.position.z - 0.3) * focus), 0.02);
  const az = 0.38 + Math.sin(time / 12000) * 0.1 + pointer.sx * 0.2;
  const dist = baseDist * (1 - focus * 0.08);
  const el = 0.72 - pointer.sy * 0.08;
  camera.position.set(look.x + Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, look.z + Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(look);

  renderer.render(scene, camera);
}

let baseDist = 38;
function resize() {
  const { width, height } = stage.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.fov = 27;
  camera.updateProjectionMatrix();
  // keep the whole mall in frame: about 21 units wide once turned, plus a margin
  const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
  baseDist = Math.max(30, (camera.aspect < 1.3 ? 23.5 : 20.5) / (2 * halfW));
}
new ResizeObserver(resize).observe(stage);
resize();

let visible = true;
new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(stage);

if (reduce) {
  for (let i = 0; i < 60; i++) frame(T.sight * 1000 + 1500 + i * 16);
  showStory(3, T.sight + 1);
} else {
  renderer.setAnimationLoop((time) => { if (visible && !document.hidden) frame(time); });
}
