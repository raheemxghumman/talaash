// Landing-page 3D scene: a venue floor plan where a lost-child search plays out.
// Phase 0: report at the food court. 1: search widens to every zone.
// 2: sighting at Gate 3, guards converge. 3: found, everything stands down.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const stage = document.getElementById("stage");
const canvas = document.getElementById("venue");
const chips = [...document.querySelectorAll(".chip-float")];
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const C = {
  paper: new THREE.Color("#f3eee3"),
  block: new THREE.Color("#fbf8f1"),
  edge: new THREE.Color("#c9bfa9"),
  base: new THREE.Color("#e7e0d1"),
  ink: new THREE.Color("#13202f"),
  signal: new THREE.Color("#e2552d"),
  signalSoft: new THREE.Color("#f8ddd0"),
  sky: new THREE.Color("#356c9c"),
  sage: new THREE.Color("#2f7d6b"),
};

function showChips(phase) {
  chips.forEach((c) => c.classList.toggle("on", Number(c.dataset.phase) <= phase));
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (e) {
  stage.insertAdjacentHTML("beforeend", '<div class="stage-fallback">3D view needs WebGL.</div>');
  showChips(3);
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);

scene.add(new THREE.HemisphereLight(0xfffaf0, 0xb9ad96, 1.25));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-6, 14, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
sun.shadow.radius = 4;
scene.add(sun);

// base slab
const base = new THREE.Mesh(
  new RoundedBoxGeometry(14, 0.3, 11, 4, 0.25),
  new THREE.MeshStandardMaterial({ color: C.base, roughness: 0.95 })
);
base.position.y = -0.15;
base.receiveShadow = true;
scene.add(base);
const grid = new THREE.GridHelper(13, 26, 0xd2c8b4, 0xd8cfbd);
grid.position.y = 0.005;
grid.material.transparent = true;
grid.material.opacity = 0.45;
scene.add(grid);

// zones
const ZONES = [
  { name: "Parking", x: -4.4, z: 2.9, w: 3.6, d: 3.4, h: 0.16 },
  { name: "Main Entrance", x: -0.4, z: 3.6, w: 3.4, d: 1.9, h: 0.34 },
  { name: "Gate 1", x: 3.9, z: 3.6, w: 2.6, d: 1.7, h: 0.28 },
  { name: "Food Court", x: 0, z: 0.3, w: 4.2, d: 3.2, h: 0.5 },
  { name: "Gate 2", x: 4.5, z: 0.4, w: 2.2, d: 2.6, h: 0.28 },
  { name: "Kids Play Area", x: -4.3, z: -0.8, w: 3.4, d: 2.8, h: 0.42 },
  { name: "Cinema Level", x: 1.4, z: -3.4, w: 5.4, d: 2.2, h: 0.95 },
  { name: "Gate 3", x: -3.9, z: -3.7, w: 2.6, d: 1.6, h: 0.28 },
];
const zoneMeshes = {};
function label(text) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const g = c.getContext("2d");
  g.font = "600 44px Inter, system-ui, sans-serif";
  g.fillStyle = "rgba(19,32,47,0.78)";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text.toUpperCase(), 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(2.1, 0.4, 1);
  return s;
}
for (const z of ZONES) {
  const mat = new THREE.MeshStandardMaterial({ color: C.block.clone(), roughness: 0.85 });
  const m = new THREE.Mesh(new RoundedBoxGeometry(z.w, z.h, z.d, 3, 0.08), mat);
  m.position.set(z.x, z.h / 2, z.z);
  m.castShadow = true; m.receiveShadow = true;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(z.w, z.h, z.d)), new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.6 }));
  m.add(edges);
  scene.add(m);
  const l = label(z.name);
  l.position.set(z.x, z.h + 0.32, z.z + z.d / 2 - 0.35);
  scene.add(l);
  zoneMeshes[z.name] = { mesh: m, zone: z };
}

// the child: a beacon at the food court
const fc = zoneMeshes["Food Court"].zone;
const beacon = new THREE.Group();
const beaconMat = new THREE.MeshStandardMaterial({ color: C.signal, emissive: C.signal, emissiveIntensity: 0.35, roughness: 0.4 });
const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 16), beaconMat);
pin.position.y = 0.35;
const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), beaconMat);
head.position.y = 0.82;
pin.castShadow = head.castShadow = true;
beacon.add(pin, head);
beacon.position.set(fc.x - 0.6, fc.h, fc.z + 0.2);
scene.add(beacon);
const glow = new THREE.PointLight(C.signal, 2.5, 4, 2);
glow.position.set(beacon.position.x, fc.h + 0.9, beacon.position.z);
scene.add(glow);

// expanding search rings
const rings = Array.from({ length: 5 }, (_, i) => {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 96), new THREE.MeshBasicMaterial({ color: C.signal, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(beacon.position.x, 0.03, beacon.position.z);
  m.userData.offset = i / 5;
  scene.add(m);
  return m;
});

// sighting at Gate 3
const g3 = zoneMeshes["Gate 3"].zone;
const sightPos = new THREE.Vector3(g3.x + 0.4, g3.h, g3.z);
const sighting = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 16), new THREE.MeshStandardMaterial({ color: C.sky, emissive: C.sky, emissiveIntensity: 0.3 }));
sighting.position.copy(sightPos).add(new THREE.Vector3(0, 0.25, 0));
sighting.castShadow = true;
scene.add(sighting);
const sightRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), new THREE.MeshBasicMaterial({ color: C.sky, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
sightRing.rotation.x = -Math.PI / 2;
sightRing.position.set(sightPos.x, g3.h + 0.02, sightPos.z);
scene.add(sightRing);

// arc from the case to the sighting
const arcCurve = new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(beacon.position.x, fc.h + 0.85, beacon.position.z),
  new THREE.Vector3((beacon.position.x + sightPos.x) / 2, 3.2, (beacon.position.z + sightPos.z) / 2),
  new THREE.Vector3(sightPos.x, g3.h + 0.3, sightPos.z)
);
const arcGeo = new THREE.TubeGeometry(arcCurve, 80, 0.025, 8, false);
const arc = new THREE.Mesh(arcGeo, new THREE.MeshBasicMaterial({ color: C.sky, transparent: true, opacity: 0.9 }));
scene.add(arc);
const arcCount = arcGeo.index.count;

// guards walking the corridors
const loop = [[-2.2, 1.9], [2.6, 1.9], [2.6, -1.7], [-2.2, -1.7]].map(([x, z]) => new THREE.Vector3(x, 0, z));
const loopCurve = new THREE.CatmullRomCurve3(loop, true, "catmullrom", 0.1);
const guards = Array.from({ length: 6 }, (_, i) => {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.2, 4, 12), new THREE.MeshStandardMaterial({ color: C.ink, roughness: 0.6 }));
  body.position.y = 0.22;
  body.castShadow = true;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), new THREE.MeshBasicMaterial({ color: C.sky, transparent: true, opacity: 0.35 }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.01;
  g.add(body, disc);
  g.userData.t = i / 6;
  scene.add(g);
  return g;
});

// timeline
const LOOP = 16;
const phaseAt = (t) => (t < 4 ? 0 : t < 8.5 ? 1 : t < 12.5 ? 2 : 3);
const ease = (x) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);
const pointer = { x: 0, y: 0 };
stage.addEventListener("pointermove", (e) => {
  const r = stage.getBoundingClientRect();
  pointer.x = (e.clientX - r.left) / r.width - 0.5;
  pointer.y = (e.clientY - r.top) / r.height - 0.5;
});
stage.addEventListener("pointerleave", () => { pointer.x = 0; pointer.y = 0; });

let lastPhase = -1;
const tmp = new THREE.Color();
const chipTimer = document.querySelector(".chip-a .mono");

function frame(time) {
  const t = (time / 1000) % LOOP;
  const phase = phaseAt(t);
  if (phase !== lastPhase) { showChips(phase); lastPhase = phase; }
  if (chipTimer) {
    const s = Math.floor(t * 22);
    chipTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  // camera: slow orbit plus pointer parallax
  const a = 0.62 + Math.sin(time / 9000) * 0.1 + pointer.x * 0.18;
  const r = 22.5;
  camera.position.set(Math.sin(a) * r, 15 - pointer.y * 2, Math.cos(a) * r);
  camera.lookAt(-0.3, -0.6, 0);

  // rings: small in the zone first, then across the whole venue
  const reach = phase === 0 ? 2.4 : phase === 1 ? 2.4 + ease((t - 4) / 2.5) * 6.5 : phase === 2 ? 8.9 : 0;
  rings.forEach((m) => {
    const p = ((time / 2400) + m.userData.offset) % 1;
    const s = 0.3 + p * reach;
    m.scale.set(s, s, s);
    m.material.opacity = phase === 3 ? Math.max(0, m.material.opacity - 0.03) : (1 - p) * 0.75;
  });

  // zones tint as the search reaches them
  for (const { mesh, zone } of Object.values(zoneMeshes)) {
    const dist = Math.hypot(zone.x - beacon.position.x, zone.z - beacon.position.z);
    let target = C.block;
    if (phase === 0 && zone.name === "Food Court") target = C.signalSoft;
    if (phase === 1 && dist < reach + 1) target = C.signalSoft;
    if (phase === 2) target = zone.name === "Gate 3" ? tmp.copy(C.sky).lerp(C.block, 0.7) : C.signalSoft;
    mesh.material.color.lerp(target, 0.06);
  }

  // beacon colour and bob
  beaconMat.color.lerp(phase === 3 ? C.sage : C.signal, 0.08);
  beaconMat.emissive.lerp(phase === 3 ? C.sage : C.signal, 0.08);
  glow.color.copy(beaconMat.color);
  beacon.position.y = fc.h + Math.sin(time / 380) * 0.05;

  // sighting pop and arc draw
  const sp = phase === 2 ? ease((t - 8.5) / 0.6) : phase === 3 ? Math.max(0, 1 - (t - 12.5) / 0.8) : 0;
  sighting.scale.setScalar(Math.max(sp, 0.0001));
  const sr = ((time / 1200) % 1);
  sightRing.scale.setScalar(0.3 + sr * 1.4);
  sightRing.material.opacity = phase === 2 ? (1 - sr) * 0.8 : 0;
  const arcP = phase === 2 ? ease((t - 9) / 1.4) : phase === 3 ? 1 : 0;
  arc.geometry.setDrawRange(0, Math.floor(arcCount * arcP / 3) * 3);
  arc.material.opacity = phase === 3 ? Math.max(0, 0.9 - (t - 12.5)) : 0.9;

  // guards patrol, then converge on the sighting
  guards.forEach((g, i) => {
    const pos = loopCurve.getPointAt((g.userData.t + time / 40000) % 1);
    if (phase === 2 && i < 3) {
      const k = ease((t - 9.2) / 2.5);
      const target = new THREE.Vector3(sightPos.x + Math.cos(i * 2.1) * 0.55, 0, sightPos.z + Math.sin(i * 2.1) * 0.55);
      pos.lerp(target, k);
      pos.y = k > 0.6 ? g3.h : 0;
    }
    g.position.lerp(pos, 0.2);
  });

  renderer.render(scene, camera);
}

function resize() {
  const { width, height } = stage.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.fov = width < 520 ? 36 : 30;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

let visible = true;
new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(stage);

if (reduce) {
  frame(6200);
  showChips(3);
} else {
  renderer.setAnimationLoop((time) => { if (visible && !document.hidden) frame(time); });
}
