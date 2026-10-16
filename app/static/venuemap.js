// Desk venue map in 3D. Listens for "desk:data" from desk.js, draws the zones,
// open cases, sightings and the search area, and lets the officer add, move,
// resize, rename and remove zones from the bigger view.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

const KIND = {
  area: { label: "Area", color: "#fbf8f1" },
  gate: { label: "Gate / exit", color: "#e8eef4" },
  entrance: { label: "Entrance", color: "#f3efe6" },
  play: { label: "Play area", color: "#f8eedc" },
  hall: { label: "Hall", color: "#efebe3" },
  parking: { label: "Parking", color: "#e9e4d9" },
};
const C = {
  signal: new THREE.Color("#e2552d"), signalDeep: new THREE.Color("#c2401c"), police: new THREE.Color("#7a2412"),
  wide: new THREE.Color("#f9d9cb"), sky: new THREE.Color("#356c9c"), skySoft: new THREE.Color("#d8e6f3"),
  amber: new THREE.Color("#b97d12"), grey: new THREE.Color("#9fb0c2"), ink: new THREE.Color("#13202f"),
  edge: new THREE.Color("#cfc5b1"), hover: new THREE.Color("#ffffff"),
};

const wrap = $("#map-wrap");
const canvas = $("#map3d");
const labelLayer = $("#map-labels");
const tip = $("#map-tip");
const homeSlot = wrap.parentElement;
const dlg = $("#venue-dlg");

const state = {
  data: null, selCase: null, zones: [], zoneSig: "", markSig: "", hover: null,
  editing: false, editSel: null, drag: null, fitted: false, view: "3d", bounds: null,
};

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (e) {
  wrap.classList.add("no-gl");
  wrap.insertAdjacentHTML("beforeend", '<p class="map-nogl">The 3D map needs WebGL. Cases and sightings are still listed on the left.</p>');
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.09, minPolarAngle: 0, maxPolarAngle: 1.25, screenSpacePanning: false, rotateSpeed: 0.7 });
controls.addEventListener("start", () => wrap.classList.add("moved"));

scene.add(new THREE.HemisphereLight(0xfffaf0, 0xbdb19b, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.radius = 4;
scene.add(sun, sun.target);

const floorGroup = new THREE.Group();
const zoneGroup = new THREE.Group();
const markGroup = new THREE.Group();
scene.add(floorGroup, zoneGroup, markGroup);

const zoneObjs = new Map();   // id -> { zone, mesh, edges, label }
let pinTags = [];             // { el, obj }
let animated = [];            // per-frame callbacks for markers

function disposeGroup(g) {
  g.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); });
  g.clear();
}

// ---------- zones ----------
function boundsOf(zones) {
  if (!zones.length) return { cx: 0, cz: 0, sx: 10, sz: 8 };
  const minX = Math.min(...zones.map((z) => z.x - z.w / 2)), maxX = Math.max(...zones.map((z) => z.x + z.w / 2));
  const minZ = Math.min(...zones.map((z) => z.z - z.d / 2)), maxZ = Math.max(...zones.map((z) => z.z + z.d / 2));
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, sx: maxX - minX, sz: maxZ - minZ };
}

function buildFloor(b) {
  disposeGroup(floorGroup);
  const w = b.sx + 2.6, d = b.sz + 2.6;
  const slab = new THREE.Mesh(new RoundedBoxGeometry(w, 0.3, d, 3, 0.2), new THREE.MeshStandardMaterial({ color: "#e9e2d3", roughness: 0.95 }));
  slab.position.set(b.cx, -0.15, b.cz);
  slab.receiveShadow = true;
  const size = Math.ceil(Math.max(w, d));
  const grid = new THREE.GridHelper(size, size * 2, 0xd6ccb8, 0xddd5c5);
  grid.position.set(b.cx, 0.004, b.cz);
  grid.material.transparent = true; grid.material.opacity = 0.5;
  floorGroup.add(slab, grid);
  const r = Math.max(w, d);
  sun.position.set(b.cx - r * 0.4, r * 1.2, b.cz + r * 0.6);
  sun.target.position.set(b.cx, 0, b.cz);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: r * 4 });
  sun.shadow.camera.updateProjectionMatrix();
}

function buildZones(zones) {
  disposeGroup(zoneGroup);
  zoneObjs.forEach((o) => o.label.remove());
  zoneObjs.clear();
  for (const z of zones) {
    const base = new THREE.Color(KIND[z.kind]?.color || KIND.area.color);
    const mat = new THREE.MeshStandardMaterial({ color: base.clone(), roughness: 0.82, emissive: new THREE.Color(0), transparent: true });
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(z.w, z.h, z.d, 2, Math.min(0.07, z.h / 2.5)), mat);
    mesh.position.set(z.x, z.h / 2, z.z);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.zoneId = z.id;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(z.w, z.h, z.d)), new THREE.LineBasicMaterial({ color: C.edge.clone(), transparent: true, opacity: 0.7 }));
    mesh.add(edges);
    if (z.kind === "gate") {
      // a doorway arch on top so gates read as exits
      const archMat = new THREE.MeshStandardMaterial({ color: "#8aa4bd", roughness: 0.6 });
      const span = Math.min(z.w, z.d) * 0.55;
      const postGeo = new THREE.BoxGeometry(0.08, 0.42, 0.08);
      const p1 = new THREE.Mesh(postGeo, archMat), p2 = new THREE.Mesh(postGeo, archMat);
      p1.position.set(-span / 2, z.h / 2 + 0.21, 0); p2.position.set(span / 2, z.h / 2 + 0.21, 0);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 0.08, 0.08, 0.08), archMat);
      beam.position.set(0, z.h / 2 + 0.44, 0);
      [p1, p2, beam].forEach((m) => { m.castShadow = true; mesh.add(m); });
    }
    zoneGroup.add(mesh);
    const label = document.createElement("div");
    label.className = `zl k-${z.kind}`;
    label.innerHTML = `<span class="zn">${esc(z.name)}</span><span class="zb"></span>`;
    labelLayer.appendChild(label);
    zoneObjs.set(z.id, { zone: z, mesh, edges, base, label });
  }
}

// ---------- camera ----------
const ANGLES = { "3d": [0.82, 0.2], top: [0.0001, 0] };
function fitDistance(b, view) {
  // Move the camera back until every corner of the plan fits the frame.
  const [polar, azim] = ANGLES[view];
  const target = new THREE.Vector3(b.cx, 0, b.cz);
  const hx = b.sx / 2 + 0.5, hz = b.sz / 2 + 0.5;
  const pts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 1.1]) pts.push(new THREE.Vector3(b.cx + sx * hx, y, b.cz + sz * hz));
  const saved = camera.position.clone(), savedQ = camera.quaternion.clone();
  let d = Math.max(b.sx, b.sz) * 2 + 6;
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    camera.position.setFromSpherical(new THREE.Spherical(d, polar, azim)).add(target);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    let m = 0;
    for (const q of pts) { p.copy(q).project(camera); m = Math.max(m, Math.abs(p.x), Math.abs(p.y)); }
    d *= m / (view === "top" ? 0.9 : 0.97);
  }
  camera.position.copy(saved); camera.quaternion.copy(savedQ);
  return d;
}
let fly = null;
function flyTo(view, instant) {
  state.view = view;
  const b = state.bounds || boundsOf(state.zones);
  const target = new THREE.Vector3(b.cx, 0, b.cz);
  const sph = new THREE.Spherical(fitDistance(b, view), ...ANGLES[view]);
  const endPos = new THREE.Vector3().setFromSpherical(sph).add(target);
  if (instant) { camera.position.copy(endPos); controls.target.copy(target); controls.update(); return; }
  fly = { t0: performance.now(), fromPos: camera.position.clone(), fromTarget: controls.target.clone(), endPos, target };
  document.querySelectorAll("[data-view]").forEach((b2) => b2.classList.toggle("on", b2.dataset.view === view));
}

// ---------- markers ----------
const jitter = (id, spread) => [(((id * 37) % 11) - 5) / 5 * spread, (((id * 53) % 9) - 4) / 4 * spread];
const zoneByName = (name) => [...zoneObjs.values()].find((o) => o.zone.name === name);
const stageColor = (c) => (c.sighted_at ? C.sky : [C.signal, C.signalDeep, C.police][c.stage] || C.signal);

function ring(color, radius, y) {
  const m = new THREE.Mesh(new THREE.RingGeometry(radius * 0.86, radius, 64), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
}

function buildMarkers() {
  disposeGroup(markGroup);
  pinTags.forEach((p) => p.el.remove());
  pinTags = []; animated = [];
  const d = state.data;
  if (!d) return;
  const active = d.cases.filter((c) => c.status === "active");
  const beaconTop = {};

  active.forEach((c) => {
    const o = zoneByName(c.zone);
    if (!o) return;
    const z = o.zone;
    const [jx, jz] = jitter(c.id, Math.min(z.w, z.d) * 0.22);
    const color = stageColor(c);
    const g = new THREE.Group();
    g.position.set(z.x + jx, z.h, z.z + jz);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.45 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 28, 18), mat);
    head.position.y = 0.95;
    const tipCone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 24), mat);
    tipCone.rotation.x = Math.PI; tipCone.position.y = 0.62;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), mat);
    stem.position.y = 0.2;
    [head, tipCone, stem].forEach((m) => (m.castShadow = true));
    const halo = new THREE.Mesh(new THREE.CircleGeometry(0.4, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.015;
    const pulse = ring(color, 0.5, 0.02);
    g.add(head, tipCone, stem, halo, pulse);
    markGroup.add(g);
    const phase = (c.id * 0.37) % 1;
    const selected = state.selCase === c.id;
    if (selected) g.scale.setScalar(1.25);
    animated.push((t) => {
      head.position.y = 0.95 + Math.sin(t / 420 + phase * 6) * 0.06;
      tipCone.position.y = head.position.y - 0.33;
      const p = (t / 1700 + phase) % 1;
      pulse.scale.setScalar(1 + p * (c.sighted_at ? 1.5 : 3.2));
      pulse.material.opacity = (1 - p) * 0.7;
    });
    beaconTop[c.id] = g.position.clone().add(new THREE.Vector3(0, 1.3, 0));
    const el = document.createElement("button");
    el.className = `pin-tag${selected ? " sel" : ""}${c.sighted_at ? " sighted" : ""} st${c.stage}`;
    el.dataset.case = c.id;
    el.title = `Case #${c.id} · ${c.zone}`;
    el.textContent = `#${c.id}`;
    el.addEventListener("click", () => emit("desk:select", { key: `c:${c.id}` }));
    labelLayer.appendChild(el);
    pinTags.push({ el, pos: beaconTop[c.id] });
  });

  const shown = d.sightings.filter((s) => (!s.decision && s.route !== "unmatched") || (state.selCase && s.case_id === state.selCase));
  shown.forEach((s) => {
    const o = zoneByName(s.zone);
    if (!o) return;
    const z = o.zone;
    const [jx, jz] = jitter(s.id + 7, Math.min(z.w, z.d) * 0.28);
    const color = s.decision === "confirmed" ? C.sky : s.decision ? C.grey : s.route === "review" ? C.amber : C.sky;
    const pos = new THREE.Vector3(z.x + jx, z.h, z.z + jz);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 }));
    dot.position.copy(pos).add(new THREE.Vector3(0, 0.45, 0));
    dot.castShadow = true;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 6), new THREE.MeshBasicMaterial({ color }));
    stem.position.copy(pos).add(new THREE.Vector3(0, 0.22, 0));
    const r = ring(color, 0.32, pos.y + 0.02);
    r.position.x = pos.x; r.position.z = pos.z;
    markGroup.add(dot, stem, r);
    const phase = (s.id * 0.29) % 1;
    animated.push((t) => { const p = (t / 1300 + phase) % 1; r.scale.setScalar(1 + p * 1.6); r.material.opacity = s.decision ? 0 : (1 - p) * 0.8; });
    if (s.case_id && beaconTop[s.case_id] && !s.decision) {
      const a = beaconTop[s.case_id].clone().add(new THREE.Vector3(0, -0.35, 0)), b = dot.position.clone();
      const mid = a.clone().lerp(b, 0.5); mid.y = Math.max(a.y, b.y) + 0.8 + a.distanceTo(b) * 0.18;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.03, 6, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75 }));
      const packet = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      markGroup.add(tube, packet);
      animated.push((t) => packet.position.copy(curve.getPointAt((t / 1400 + phase) % 1)));
    }
  });
}

// ---------- per-zone status ----------
function zoneStatus() {
  const d = state.data;
  const out = new Map();
  zoneObjs.forEach((o) => out.set(o.zone.name, { cases: [], sightings: 0, wide: false }));
  if (!d) return out;
  const active = d.cases.filter((c) => c.status === "active");
  active.forEach((c) => {
    out.get(c.zone)?.cases.push(c.id);
    if (c.sighted_at) return;
    if (c.stage >= 1) out.forEach((v) => (v.wide = true));
    else if (out.get(c.zone)) out.get(c.zone).wide = true;
  });
  d.sightings.filter((s) => !s.decision && s.route !== "unmatched").forEach((s) => { const v = out.get(s.zone); if (v) v.sightings++; });
  return out;
}
let status = new Map();

function updateLabels() {
  status = zoneStatus();
  const sel = state.selCase && state.data?.cases.find((c) => c.id === state.selCase);
  zoneObjs.forEach((o) => {
    const st = status.get(o.zone.name) || { cases: [], sightings: 0 };
    o.label.querySelector(".zb").innerHTML =
      (st.cases.length ? `<i class="b-case">${st.cases.length}</i>` : "") + (st.sightings ? `<i class="b-sight">${st.sightings}</i>` : "");
    o.label.classList.toggle("hot", !!(sel && sel.zone === o.zone.name));
    o.label.classList.toggle("edit-sel", state.editing && state.editSel === o.zone.id);
  });
}

// ---------- data in ----------
document.addEventListener("desk:data", (e) => {
  const { data, selCase } = e.detail;
  state.data = data;
  state.selCase = selCase;
  const zones = data.zones || [];
  const zsig = JSON.stringify(zones);
  if (zsig !== state.zoneSig && !state.drag) {
    const countChanged = state.zones.length !== zones.length;
    state.zoneSig = zsig;
    state.zones = zones;
    state.bounds = boundsOf(zones);
    buildFloor(state.bounds);
    buildZones(zones);
    state.markSig = "";
    if (!state.fitted) { resize(); flyTo("3d", true); state.fitted = true; }
    else if (countChanged) flyTo(state.view);
    if (state.editing) renderEditor();
  }
  const msig = JSON.stringify([selCase, data.cases.filter((c) => c.status === "active").map((c) => [c.id, c.zone, c.stage, c.sighted_at]),
    data.sightings.map((s) => [s.id, s.zone, s.decision, s.route, s.case_id])]);
  if (msig !== state.markSig) { state.markSig = msig; buildMarkers(); }
  updateLabels();
});

// ---------- pointer: hover, click, drag ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let down = null;

function pick(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects([...zoneObjs.values()].map((o) => o.mesh), false)[0];
  return hit ? hit.object.userData.zoneId : null;
}
function floorPoint() { const p = new THREE.Vector3(); return ray.ray.intersectPlane(plane, p) ? p : null; }

function showTip(id, e) {
  if (!id) { tip.hidden = true; return; }
  const o = zoneObjs.get(id);
  const st = status.get(o.zone.name) || { cases: [], sightings: 0, wide: false };
  const lines = [];
  lines.push(st.cases.length ? `<span class="t-case">${st.cases.length} open case${st.cases.length > 1 ? "s" : ""}: ${st.cases.map((n) => `#${n}`).join(", ")}</span>` : "No open case here");
  if (st.sightings) lines.push(`<span class="t-sight">${st.sightings} sighting${st.sightings > 1 ? "s" : ""} to check</span>`);
  if (st.wide) lines.push("Inside the search area");
  if (state.editing) lines.push('<span class="t-hint">Drag to move · edit size on the right</span>');
  else if (st.cases.length) lines.push('<span class="t-hint">Click to open the case</span>');
  tip.innerHTML = `<b>${esc(o.zone.name)}</b><small>${KIND[o.zone.kind]?.label || "Area"}</small>${lines.map((l) => `<div>${l}</div>`).join("")}`;
  const r = wrap.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  tip.hidden = false;
  tip.style.left = `${Math.min(x + 14, r.width - tip.offsetWidth - 6)}px`;
  tip.style.top = `${Math.max(6, y - tip.offsetHeight - 10)}px`;
}

canvas.addEventListener("pointerdown", (e) => {
  down = { x: e.clientX, y: e.clientY };
  if (!state.editing || e.button !== 0) return;
  const id = pick(e);
  if (!id) return;
  const p = floorPoint();
  const o = zoneObjs.get(id);
  state.drag = { id, dx: o.mesh.position.x - p.x, dz: o.mesh.position.z - p.z, moved: false };
  state.editSel = id;
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  renderEditor(); updateLabels();
});
canvas.addEventListener("pointermove", (e) => {
  const id = pick(e);
  if (state.drag) {
    const p = floorPoint();
    if (!p) return;
    const o = zoneObjs.get(state.drag.id);
    const snap = (v) => Math.round(v * 4) / 4;
    o.mesh.position.x = snap(p.x + state.drag.dx);
    o.mesh.position.z = snap(p.z + state.drag.dz);
    state.drag.moved = true;
    tip.hidden = true;
    return;
  }
  state.hover = id;
  canvas.style.cursor = id ? (state.editing ? "grab" : "pointer") : "";
  showTip(id, e);
});
canvas.addEventListener("pointerleave", () => { state.hover = null; tip.hidden = true; });
canvas.addEventListener("pointerup", async (e) => {
  const click = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
  down = null;
  if (state.drag) {
    const { id, moved } = state.drag;
    const o = zoneObjs.get(id);
    state.drag = null;
    controls.enabled = true;
    if (moved) await save(id, { x: o.mesh.position.x, z: o.mesh.position.z });
    return;
  }
  if (!click) return;
  const id = pick(e);
  if (!id) return;
  if (state.editing) { state.editSel = id; renderEditor(); updateLabels(); return; }
  const st = status.get(zoneObjs.get(id).zone.name);
  if (st && st.cases.length) emit("desk:select", { key: `c:${st.cases[0]}` });
});

// ---------- zone editing ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) location.href = "/login";
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.detail || "Could not save the change");
  return out;
}
async function save(id, changes) {
  try { await api("PATCH", `/api/zones/${id}`, changes); }
  catch (err) { emit("desk:toast", { text: err.message, bad: true }); }
  emit("desk:refresh");
}

function renderEditor() {
  const list = $("#zone-list");
  if (!list) return;
  const kinds = Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  list.innerHTML = state.zones.map((z) => `
    <li data-id="${z.id}" class="${state.editSel === z.id ? "sel" : ""}">
      <div class="zr1"><input class="z-name" value="${esc(z.name)}" aria-label="Zone name" maxlength="40"><button class="z-del" title="Remove ${esc(z.name)}" aria-label="Remove">×</button></div>
      <div class="zr2"><select class="z-kind" aria-label="Type">${kinds}</select>
        <label>W <input class="z-w" type="number" min="1" max="12" step="0.5" value="${z.w}"></label>
        <label>D <input class="z-d" type="number" min="1" max="12" step="0.5" value="${z.d}"></label></div>
    </li>`).join("");
  list.querySelectorAll("li").forEach((li) => { li.querySelector(".z-kind").value = state.zones.find((z) => z.id === +li.dataset.id).kind; });
  $("#zone-count").textContent = `${state.zones.length} zone${state.zones.length === 1 ? "" : "s"}`;
}

function wireEditor() {
  const list = $("#zone-list");
  list.addEventListener("focusin", (e) => { const li = e.target.closest("li"); if (li && state.editSel !== +li.dataset.id) { state.editSel = +li.dataset.id; list.querySelectorAll("li").forEach((x) => x.classList.toggle("sel", x === li)); updateLabels(); } });
  list.addEventListener("change", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    const id = +li.dataset.id;
    if (e.target.classList.contains("z-name")) save(id, { name: e.target.value });
    if (e.target.classList.contains("z-kind")) save(id, { kind: e.target.value });
    if (e.target.classList.contains("z-w")) save(id, { w: e.target.value });
    if (e.target.classList.contains("z-d")) save(id, { d: e.target.value });
  });
  list.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); e.target.blur(); } });
  list.addEventListener("click", async (e) => {
    const b = e.target.closest(".z-del"); if (!b) return;
    const li = b.closest("li"); const z = state.zones.find((x) => x.id === +li.dataset.id);
    if (!confirm(`Remove ${z.name} from the venue?`)) return;
    try { await api("DELETE", `/api/zones/${z.id}`); emit("desk:toast", { text: `${z.name} removed` }); }
    catch (err) { emit("desk:toast", { text: err.message, bad: true }); }
    emit("desk:refresh");
  });
  $("#zone-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const z = await api("POST", "/api/zones", { name: f.name.value, kind: f.kind.value });
      state.editSel = z.id;
      f.name.value = "";
      emit("desk:toast", { text: `${z.name} added. Drag it where it belongs.` });
    } catch (err) { emit("desk:toast", { text: err.message, bad: true }); }
    emit("desk:refresh");
  });
}

function openBig() {
  $("#dlg-map-slot").appendChild(wrap);
  state.editing = true;
  wrap.classList.add("editing");
  dlg.showModal();
  renderEditor(); updateLabels();
  requestAnimationFrame(() => { resize(); flyTo("top"); });
}
function closeBig() {
  homeSlot.insertBefore(wrap, homeSlot.querySelector(".map-legend"));
  state.editing = false; state.editSel = null; state.drag = null; controls.enabled = true;
  wrap.classList.remove("editing");
  updateLabels();
  requestAnimationFrame(() => { resize(); flyTo("3d"); });
}

document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => flyTo(b.dataset.view)));
document.querySelectorAll("[data-map-reset]").forEach((b) => b.addEventListener("click", () => flyTo(state.view)));
$("#map-expand").addEventListener("click", openBig);
$("#dlg-close").addEventListener("click", () => dlg.close());
dlg.addEventListener("close", closeBig);
wireEditor();

// ---------- loop ----------
const v = new THREE.Vector3();
function placeLabel(el, pos, w, h) {
  v.copy(pos).project(camera);
  if (v.z > 1) { el.style.display = "none"; return; }
  el.style.display = "";
  el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
}

const target = new THREE.Color();
function frame(t) {
  if (fly) {
    const k = Math.min((t - fly.t0) / 650, 1), e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(fly.fromPos, fly.endPos, e);
    controls.target.lerpVectors(fly.fromTarget, fly.target, e);
    if (k >= 1) fly = null;
  }
  controls.update();
  const sel = state.selCase && state.data?.cases.find((c) => c.id === state.selCase);
  const breathe = 0.5 + Math.sin(t / 520) * 0.5;
  zoneObjs.forEach((o) => {
    const st = status.get(o.zone.name);
    target.copy(o.base);
    if (st?.wide) target.lerp(C.wide, 0.55 + breathe * 0.45);
    if (state.editing && state.editSel === o.zone.id) target.copy(C.skySoft);
    if (state.hover === o.zone.id) target.lerp(C.hover, 0.5);
    o.mesh.material.color.lerp(target, 0.12);
    const hot = (sel && sel.zone === o.zone.name) || (state.editing && state.editSel === o.zone.id);
    o.edges.material.color.lerp(hot ? (state.editing ? C.sky : C.ink) : C.edge, 0.15);
    o.edges.material.opacity = hot ? 1 : 0.7;
    const lift = state.drag?.id === o.zone.id ? 0.25 : 0;
    o.mesh.position.y += (o.zone.h / 2 + lift - o.mesh.position.y) * 0.2;
  });
  animated.forEach((f) => f(t));
  renderer.render(scene, camera);
  const w = wrap.clientWidth, h = wrap.clientHeight;
  zoneObjs.forEach((o) => placeLabel(o.label, v.set(o.mesh.position.x, o.mesh.position.y + o.zone.h / 2 + 0.02, o.mesh.position.z + o.zone.d / 2 - 0.1).clone(), w, h));
  pinTags.forEach((p) => placeLabel(p.el, p.pos, w, h));
}

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap);
let visible = true;
new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(wrap);
renderer.setAnimationLoop((t) => { if ((visible || dlg.open) && !document.hidden) frame(t); });
emit("desk:map-ready");
