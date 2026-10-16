const steps = document.querySelector(".desk").dataset.steps.split(",").map(Number);
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let serverOffset = 0;
const reviewCards = new Map();

function time(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function since(iso) {
  const s = Math.max(0, Math.floor((Date.now() + serverOffset - new Date(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function toast(text, bad) {
  const t = $("#toast");
  t.textContent = text;
  t.className = "toast" + (bad ? " toast-bad" : "");
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (r.status === 401) location.href = "/login";
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.detail || "Something went wrong");
  }
  return r.json();
}

// ---------- review card (built once, so the officer's edits survive refreshes) ----------

const FIELDS = [
  ["child_name", "Name"], ["age_years", "Age"], ["gender", "Boy / girl"], ["height", "Height"],
  ["clothing", "Wearing"], ["features", "Look for"], ["special_needs", "Needs"],
];

function reviewCard(c) {
  const x = c.extracted || {};
  const v = c.verification || { issues: [] };
  const issues = v.issues || [];
  const flagged = new Set(issues.map((i) => i.field));
  const el = document.createElement("article");
  el.className = "card card-review" + (c.urgency === "high" ? " urgent" : "");
  el.innerHTML = `
    <header class="card-head">
      <span class="case-tag">Case #${c.id}</span>
      <span class="pill pill-review">Waiting for approval</span>
      ${c.urgency === "high" ? '<span class="pill pill-urgent">Young child</span>' : ""}
      <span class="age" data-since="${c.created_at}"></span>
    </header>
    <blockquote class="report">${esc(c.raw_report)}</blockquote>
    <p class="meta">Last seen: <b>${esc(c.zone)}</b>${c.reporter_name ? ` · Reported by ${esc(c.reporter_name)}` : ""}${c.reporter_phone ? ` · ${esc(c.reporter_phone)}` : ""}</p>
    <div class="fields">
      ${FIELDS.map(([k, label]) => {
        const val = Array.isArray(x[k]) ? x[k].join(", ") : x[k] ?? "";
        return `<label class="${flagged.has(k) ? "flag" : ""}"><span>${label}</span><input data-field="${k}" value="${esc(val)}" data-original="${esc(val)}"></label>`;
      }).join("")}
    </div>
    ${issues.length ? `
      <div class="issues">
        <p class="issues-title">Checker flagged ${issues.length} thing${issues.length > 1 ? "s" : ""} <span class="by">${esc(v.checker)}</span></p>
        <ul>${issues.map((i) => `<li><b>${esc(i.field)}</b> ${esc(i.problem)}${i.quote ? ` <q>${esc(i.quote)}</q>` : ""}</li>`).join("")}</ul>
        <label class="ack"><input type="checkbox" class="ack-box"> I’ve checked these against the report</label>
      </div>` : `<p class="checked">Checked against the parent’s words · <span class="by">${esc(v.checker)}</span></p>`}
    <div class="card-actions">
      <button class="btn btn-alert approve" ${issues.length ? "disabled" : ""}>Approve broadcast</button>
      <button class="btn btn-quiet reject">Reject</button>
    </div>`;
  const approveBtn = el.querySelector(".approve");
  const ack = el.querySelector(".ack-box");
  if (ack) ack.addEventListener("change", () => (approveBtn.disabled = !ack.checked));
  approveBtn.addEventListener("click", async () => {
    const edits = {};
    el.querySelectorAll("input[data-field]").forEach((i) => {
      if (i.value !== i.dataset.original) edits[i.dataset.field] = i.value;
    });
    approveBtn.disabled = true;
    approveBtn.textContent = "Broadcasting…";
    try {
      await post(`/api/cases/${c.id}/approve`, { edits });
      toast(`Case #${c.id} approved. Alert sent to zone security.`);
      refresh();
    } catch (e) {
      toast(e.message, true);
      approveBtn.disabled = false;
      approveBtn.textContent = "Approve broadcast";
    }
  });
  el.querySelector(".reject").addEventListener("click", async () => {
    const reason = prompt("Why are you rejecting this report? (e.g. prank, duplicate, child already found)");
    if (reason === null) return;
    try {
      await post(`/api/cases/${c.id}/reject`, { reason });
      toast(`Case #${c.id} rejected. Nothing was broadcast.`);
      refresh();
    } catch (e) { toast(e.message, true); }
  });
  return el;
}

function sightingCard(s) {
  const el = document.createElement("article");
  const likely = s.route === "likely";
  el.className = "card card-sighting" + (likely ? " likely" : "");
  const pct = s.score == null ? "?" : Math.round(s.score * 100) + "%";
  el.innerHTML = `
    <header class="card-head">
      <span class="case-tag">Sighting${s.case_id ? ` → Case #${s.case_id}` : ""}</span>
      <span class="pill ${likely ? "pill-likely" : "pill-review"}">${likely ? "Likely match" : "Unsure, needs you"}</span>
      <span class="score">${pct}</span>
    </header>
    <blockquote class="report">${esc(s.text)}</blockquote>
    <p class="meta">At <b>${esc(s.zone)}</b>${s.reporter ? ` · ${esc(s.reporter)}` : ""} · ${time(s.created_at)}</p>
    ${(s.reasons || []).length ? `<ul class="reasons">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    <div class="card-actions">
      ${s.case_id ? '<button class="btn btn-dark confirm">Confirm, send nearest guard</button>' : ""}
      <button class="btn btn-quiet dismiss">Not our child</button>
    </div>`;
  const decide = async (decision) => {
    try {
      await post(`/api/sightings/${s.id}/${decision}`);
      toast(decision === "confirmed" ? "Sighting confirmed. Guard dispatched, escalation paused." : "Sighting dismissed.");
      refresh();
    } catch (e) { toast(e.message, true); }
  };
  el.querySelector(".confirm")?.addEventListener("click", () => decide("confirmed"));
  el.querySelector(".dismiss").addEventListener("click", () => decide("dismissed"));
  return el;
}

function activeCard(c) {
  const x = c.extracted || {};
  const el = document.createElement("article");
  const closed = c.status === "closed" || c.status === "rejected";
  el.className = "card card-active" + (closed ? " closed" : "") + (c.sighted_at ? " sighted" : "");
  const stageLabel = closed ? (c.status === "rejected" ? "Rejected" : "Found · alerts withdrawn")
    : c.sighted_at ? "Sighting confirmed" : ["Zone search", "All zones", "Police called"][c.stage];
  const who = [x.child_name, x.age_years != null ? `${x.age_years} yrs` : null, x.gender].filter(Boolean).join(" · ");
  el.innerHTML = `
    <header class="card-head">
      <span class="case-tag">Case #${c.id}</span>
      <span class="pill ${closed ? "pill-done" : c.sighted_at ? "pill-likely" : "pill-stage" + c.stage}">${stageLabel}</span>
      ${!closed && c.approved_at ? `<span class="timer" data-since="${c.approved_at}"></span>` : ""}
    </header>
    <p class="who">${esc(who || "Child")}</p>
    <p class="meta">${esc((x.clothing || []).join(", ") || "No clothing given")}</p>
    <p class="meta">Last seen <b>${esc(c.zone)}</b> · ${c.alerts_sent} alert${c.alerts_sent == 1 ? "" : "s"} sent</p>
    ${!closed && c.approved_at ? `
      <div class="ladder">
        <span class="${c.stage >= 0 ? "on" : ""}">Zone</span>
        <span class="${c.stage >= 1 ? "on" : ""}">All zones · ${steps[0]}m</span>
        <span class="${c.stage >= 2 ? "on" : ""}">Police · ${steps[1]}m</span>
      </div>
      <div class="card-actions"><button class="btn btn-good found">Child found, close case</button></div>` : ""}
    ${closed && c.close_note ? `<p class="meta">${esc(c.close_note)}</p>` : ""}`;
  el.querySelector(".found")?.addEventListener("click", async (ev) => {
    const note = prompt("How was the child found?", "Reunited with parent at the security desk.");
    if (note === null) return;
    ev.target.disabled = true;
    try {
      await post(`/api/cases/${c.id}/close`, { note });
      toast(`Case #${c.id} closed. Every alert edited to RESOLVED.`);
      refresh();
    } catch (e) { toast(e.message, true); ev.target.disabled = false; }
  });
  return el;
}

function render(state) {
  serverOffset = new Date(state.now) - Date.now();
  const needs = $("#needs");
  const review = state.cases.filter((c) => c.status === "review");
  const reviewIds = new Set(review.map((c) => c.id));
  for (const [id, el] of reviewCards) if (!reviewIds.has(id)) { el.remove(); reviewCards.delete(id); }
  needs.querySelectorAll(".card-sighting, .empty").forEach((e) => e.remove());
  review.slice().reverse().forEach((c) => {
    if (!reviewCards.has(c.id)) {
      const card = reviewCard(c);
      reviewCards.set(c.id, card);
      needs.prepend(card);
    }
  });
  state.sightings.forEach((s) => needs.prepend(sightingCard(s)));
  const needCount = review.length + state.sightings.length;
  $("#needs-count").textContent = needCount;
  if (!needCount) needs.innerHTML = '<p class="empty">Nothing waiting.</p>';

  const active = $("#active");
  active.innerHTML = "";
  const open = state.cases.filter((c) => c.status !== "review");
  open.forEach((c) => active.append(activeCard(c)));
  $("#active-count").textContent = state.cases.filter((c) => c.status === "active").length;
  if (!open.length) active.innerHTML = '<p class="empty">No active searches.</p>';

  $("#log").innerHTML = state.events.map((e) => `
    <li><time>${time(e.at)}</time><span class="actor ${/agent|Watcher|Closer|Discord/.test(e.actor) ? "ai" : "human"}">${esc(e.actor)}</span>
    ${e.case_id ? `<span class="ref">#${e.case_id}</span>` : ""} ${esc(e.action)}${e.detail ? `<small>${esc(e.detail)}</small>` : ""}</li>`).join("");
  tickTimers();
}

function tickTimers() {
  $("#clock").textContent = new Date(Date.now() + serverOffset).toLocaleTimeString([], { hour12: false });
  document.querySelectorAll("[data-since]").forEach((el) => (el.textContent = since(el.dataset.since)));
}

async function refresh() {
  try {
    const r = await fetch("/api/desk");
    if (r.status === 401) return (location.href = "/login");
    render(await r.json());
  } catch (e) { /* keep last state on a network blip */ }
}

refresh();
setInterval(refresh, 3000);
setInterval(tickTimers, 1000);
