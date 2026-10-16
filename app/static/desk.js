// Talaash desk: queue, detail view with visualisers, venue map and activity feed.
(() => {
  const STEPS = document.body.dataset.steps.split(",").map(Number);
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const AI = /agent|Watcher|Closer|Discord|matcher|assistant/i;

  let data = null, offset = 0, tab = "needs", sel = null, feedFilter = "all";
  let rendered = { key: null, sig: null };
  let knownNeeds = null;
  const drafts = {};

  // ---------- helpers ----------
  const now = () => Date.now() + offset;
  const hm = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const hms = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : "";
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const p = (n) => String(n).padStart(2, "0"); return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`; };
  const ago = (iso) => { const m = Math.floor((now() - new Date(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };
  const who = (x = {}) => [x.child_name, x.age_years != null ? `${x.age_years} yrs` : null, x.gender].filter(Boolean).join(" · ") || "Child, details pending";
  const icon = {
    ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/></svg>',
    human: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
    sys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 12h16"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };
  const kindOf = (actor) => AI.test(actor) ? "ai" : actor === "Desk" || actor === "Parent" ? "sys" : "human";

  function toast(text, bad) {
    const t = $("#toast");
    t.textContent = text; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3800);
  }

  function ask(title, text, value = "", okLabel = "Confirm") {
    const d = $("#ask");
    $("#ask-title").textContent = title; $("#ask-text").textContent = text;
    $("#ask-input").value = value; $("#ask-ok").textContent = okLabel;
    d.showModal(); setTimeout(() => $("#ask-input").focus(), 30);
    return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "ok" ? $("#ask-input").value : null), { once: true }));
  }

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (r.status === 401) location.href = "/login";
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Something went wrong");
    return r.json();
  }

  // ---------- derived lists ----------
  const caseById = (id) => data.cases.find((c) => c.id === id);
  const pending = () => data.sightings.filter((s) => !s.decision && (s.route === "likely" || s.route === "review"));
  function lists() {
    const review = data.cases.filter((c) => c.status === "review");
    const needs = [
      ...review.map((c) => ({ key: `c:${c.id}`, c })),
      ...pending().map((s) => ({ key: `s:${s.id}`, s })),
    ];
    const active = data.cases.filter((c) => c.status === "active").map((c) => ({ key: `c:${c.id}`, c }));
    const closed = data.cases.filter((c) => c.status === "closed" || c.status === "rejected").map((c) => ({ key: `c:${c.id}`, c }));
    return { needs, active, closed };
  }

  // ---------- queue ----------
  function itemHtml(it) {
    if (it.s) {
      const s = it.s, likely = s.route === "likely";
      return `<li class="item k-sighting" data-key="${it.key}">
        <span class="t"><span class="tag ${likely ? "tag-sky" : "tag-amber"}">${likely ? "Likely" : "Unsure"}</span>Sighting${s.case_id ? ` → #${s.case_id}` : ""}</span>
        <span class="s">${esc(s.zone)} · ${esc(s.text)}</span>
        <span class="r">${s.score == null ? "?" : Math.round(s.score * 100) + "%"}</span></li>`;
    }
    const c = it.c, x = c.extracted || {};
    if (c.status === "review") {
      const issues = (c.verification?.issues || []).length;
      return `<li class="item ${c.urgency === "high" ? "k-urgent" : "k-review"}" data-key="${it.key}">
        <span class="t"><span class="tag ${issues ? "tag-signal" : "tag-amber"}">${issues ? issues + " flag" + (issues > 1 ? "s" : "") : "Ready"}</span>#${c.id} ${esc(who(x))}</span>
        <span class="s">${esc(c.zone)} · new report</span>
        <span class="r hot" data-since="${c.created_at}"></span></li>`;
    }
    if (c.status === "active") {
      const stage = c.sighted_at ? "Sighted" : ["Zone", "All zones", "Police"][c.stage];
      return `<li class="item k-active" data-key="${it.key}">
        <span class="t"><span class="tag ${c.sighted_at ? "tag-sky" : "tag-signal"}">${stage}</span>#${c.id} ${esc(who(x))}</span>
        <span class="s">${esc((x.clothing || []).join(", ") || c.zone)}</span>
        <span class="r hot" data-since="${c.approved_at}"></span></li>`;
    }
    return `<li class="item ${c.status === "closed" ? "k-closed" : "k-rejected"}" data-key="${it.key}">
      <span class="t"><span class="tag ${c.status === "closed" ? "tag-sage" : "tag-grey"}">${c.status === "closed" ? "Found" : "Rejected"}</span>#${c.id} ${esc(who(x))}</span>
      <span class="s">${esc(c.zone)} · ${hm(c.closed_at)}</span>
      <span class="r">${c.status === "closed" ? mmss(new Date(c.closed_at) - new Date(c.created_at)) : ""}</span></li>`;
  }

  function renderQueue() {
    const L = lists();
    $("#tab-needs").textContent = L.needs.length;
    $("#tab-active").textContent = L.active.length;
    $("#tab-closed").textContent = L.closed.length;
    const items = L[tab];
    const ul = $("#items");
    const html = items.length ? items.map(itemHtml).join("") :
      `<li class="none">${{ needs: "Nothing waiting for you.", active: "No active searches.", closed: "Nothing closed in the last 12 hours." }[tab]}</li>`;
    if (ul.dataset.html !== html) { ul.innerHTML = html; ul.dataset.html = html; }
    ul.querySelectorAll(".item").forEach((li) => li.classList.toggle("sel", li.dataset.key === sel));
    if (!sel || !findSel()) {
      const first = L.needs[0] || L.active[0];
      if (first && (tab === "needs" || tab === "active")) select(first.key, false);
    }
  }

  function findSel() {
    if (!sel) return null;
    const [t, id] = sel.split(":");
    return t === "c" ? caseById(+id) : data.sightings.find((s) => s.id === +id);
  }

  function select(key, focusTab = true) {
    sel = key;
    if (focusTab) {
      const [t, id] = key.split(":");
      const c = t === "c" ? caseById(+id) : null;
      const target = t === "s" || c?.status === "review" ? "needs" : c?.status === "active" ? "active" : "closed";
      if (target !== tab) { setTab(target, false); renderQueue(); }
    }
    $("#items").querySelectorAll(".item").forEach((li) => li.classList.toggle("sel", li.dataset.key === sel));
    renderDetail(true);
    renderMap();
  }

  function setTab(name, rerender = true) {
    tab = name;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    $("#items").dataset.html = "";
    if (rerender) renderQueue();
  }

  const pendingFor = (caseId) => pending().filter((s) => s.case_id === caseId);

  // ---------- detail ----------
  function caseEvents(id) { return data.events.filter((e) => e.case_id === id).slice().reverse(); }
  function eventTime(id, re) { const e = caseEvents(id).find((e) => re.test(e.action)); return e?.at; }

  function signature() {
    const item = findSel();
    if (!item) return "none";
    if (sel.startsWith("s:") && !item.case_id) return JSON.stringify(item);
    const c = sel.startsWith("s:") ? caseById(item.case_id) : item;
    if (!c) return "gone";
    const sights = data.sightings.filter((s) => s.case_id === c.id).map((s) => [s.id, s.decision]);
    const ev = data.events.filter((e) => e.case_id === c.id).length;
    return JSON.stringify([sel, c.status, c.stage, c.sighted_at, c.alerts_sent, sights, c.status === "review" ? 0 : ev]);
  }

  function renderDetail(force) {
    const sig = signature();
    if (!force && sig === rendered.sig) return;
    const keep = rendered.key === sel;
    rendered = { key: sel, sig };
    const el = $("#detail");
    const item = findSel();
    const scroll = keep ? el.scrollTop : 0;
    if (!item) {
      el.innerHTML = $("#detail").dataset.empty || el.innerHTML;
      return;
    }
    if (sel.startsWith("s:")) {
      const c = item.case_id ? caseById(item.case_id) : null;
      el.innerHTML = c ? caseView(c, item.id) : sightingView(item);
    } else {
      el.innerHTML = item.status === "review" ? reviewView(item) : caseView(item);
    }
    el.scrollTop = scroll;
    wireDetail();
    tick();
  }

  function highlight(text, quotes) {
    let html = esc(text);
    quotes.filter((q) => q && q.length > 2).forEach((q) => {
      const e = esc(q);
      const i = html.toLowerCase().indexOf(e.toLowerCase());
      if (i >= 0) html = html.slice(0, i) + "<mark>" + html.slice(i, i + e.length) + "</mark>" + html.slice(i + e.length);
    });
    return html;
  }

  const FIELDS = [["child_name", "Name"], ["age_years", "Age"], ["gender", "Boy / girl"], ["height", "Height"],
    ["clothing", "Wearing", true], ["features", "Look for", true], ["special_needs", "Needs", true]];

  function reviewView(c) {
    const x = c.extracted || {}, v = c.verification || { issues: [] }, issues = v.issues || [];
    const flagged = new Set(issues.map((i) => i.field));
    const draft = drafts[c.id] || {};
    const fields = FIELDS.map(([k, label, wide]) => {
      const orig = Array.isArray(x[k]) ? x[k].join(", ") : x[k] ?? "";
      const val = draft[k] ?? orig;
      return `<label class="${wide ? "wide " : ""}${flagged.has(k) ? "flag " : ""}${draft[k] != null && draft[k] !== orig ? "edited" : ""}">${label}
        <input data-field="${k}" data-orig="${esc(orig)}" value="${esc(val)}"></label>`;
    }).join("");
    return `
      <div class="d-head"><div class="ttl">
        <div class="case-no">CASE #${c.id} · NEW REPORT</div>
        <h1>${esc(who(x))}</h1>
        <div class="meta"><span>Last seen <b>${esc(c.zone)}</b></span><span>Reported <b data-ago="${c.created_at}"></b></span>${c.urgency === "high" ? '<span style="color:var(--signal-deep);font-weight:600">Young child: priority</span>' : ""}${!c.ai_ok ? '<span style="color:var(--signal-deep);font-weight:600">AI unavailable, fill in by hand</span>' : ""}</div>
      </div></div>
      <div class="grid2">
        <div class="box"><h4>Parent’s words</h4><p class="quote">${highlight(c.raw_report, issues.map((i) => i.quote))}</p>
          <div class="contact">${c.reporter_name ? `<span>${esc(c.reporter_name)}</span>` : ""}${c.reporter_phone ? `<span>${esc(c.reporter_phone)}</span>` : ""}${!c.reporter_name && !c.reporter_phone ? '<span>No contact given</span>' : ""}</div></div>
        <div class="box"><h4>Case details <span class="by">edit before approving</span></h4><div class="fields">${fields}</div></div>
      </div>
      <div class="box"><h4>Checker <span class="by">${esc(v.checker || "")}</span></h4>
        ${issues.length ? `<ul class="issues">${issues.map((i) => `<li>${icon.warn}<div><b>${esc(i.field)}</b> ${esc(i.problem)}${i.quote ? `<q>“${esc(i.quote)}”</q>` : ""}</div></li>`).join("")}</ul>`
          : `<div class="ok-line">${icon.ok}Every detail matches the parent’s words.</div>`}
      </div>
      <div class="decide">
        ${issues.length ? `<label class="ack"><input type="checkbox" id="ack" ${draft.__ack ? "checked" : ""}> I’ve checked the flagged details</label>` : '<span style="margin-right:auto"></span>'}
        <button class="btn ghost" data-act="reject">Reject</button>
        <button class="btn signal" data-act="approve" ${issues.length && !draft.__ack ? "disabled" : ""}>Approve broadcast <span class="k">A</span></button>
      </div>`;
  }

  function clockHtml(c) {
    return `<div class="clock" data-clock="${c.id}"><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="50"/><circle class="arc" cx="60" cy="60" r="50" stroke-dasharray="314.16" stroke-dashoffset="314.16"/></svg>
      <div class="mid"><b>0:00</b><span></span></div></div>`;
  }

  function stepperHtml(c) {
    const widened = eventTime(c.id, /widened/), police = eventTime(c.id, /escalated/);
    const steps = [
      ["Reported", c.created_at, true],
      ["Approved", c.approved_at, !!c.approved_at],
      ["Zone", c.approved_at, !!c.approved_at],
      ["All zones", widened, c.stage >= 1],
      ["Police", police, c.stage >= 2],
      ["Found", c.closed_at, c.status === "closed"],
    ];
    let current = c.status === "closed" ? 5 : c.stage === 0 ? 2 : c.stage === 1 ? 3 : 4;
    if (c.status === "rejected") current = 1;
    return `<div class="stepper">${steps.map(([label, at, done], i) => {
      const cls = c.status === "closed" ? (i === 5 ? "good" : done ? "done" : "") : i < current && done ? "done" : i === current ? "now" : "";
      return `<div class="${cls}">${label}<small>${at && (done || i === current) ? hm(at) : "&nbsp;"}</small></div>`;
    }).join("")}</div>`;
  }

  function sightHtml(s, highlightId) {
    const pct = s.score == null ? null : Math.round(s.score * 100);
    const color = s.route === "likely" ? "var(--sky)" : s.route === "review" ? "var(--amber)" : "var(--line-2)";
    const open = !s.decision && (s.route === "likely" || s.route === "review");
    return `<div class="sight ${open ? "pending" : ""} ${s.route === "review" ? "unsure" : ""}" ${s.id === highlightId ? 'id="focus-sight"' : ""}>
      <div class="top"><b>${esc(s.zone)}</b> · ${esc(s.reporter || "staff")} · ${hm(s.created_at)}</div>
      <p>“${esc(s.text)}”</p>
      ${pct != null ? `<div class="bar-meter"><div class="m"><i style="width:${pct}%;background:${color}"></i></div><span>${pct}%</span></div>` : '<div class="bar-meter"><span>Matcher unavailable</span></div>'}
      ${(s.reasons || []).length ? `<ul>${s.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${open ? `<div class="acts">${s.case_id ? `<button class="btn sky" data-act="confirm" data-id="${s.id}">Confirm sighting <span class="k">C</span></button>` : ""}<button class="btn ghost" data-act="dismiss" data-id="${s.id}">Not our child</button></div>`
        : s.decision ? `<div class="done-note" style="color:${s.decision === "confirmed" ? "var(--sage)" : "var(--muted)"}">${s.decision === "confirmed" ? "Confirmed" : "Dismissed"} by ${esc(s.decided_by)} · ${hm(s.decided_at)}</div>` : ""}
    </div>`;
  }

  function timelineHtml(id) {
    return `<ol class="timeline">${caseEvents(id).map((e) => {
      const k = kindOf(e.actor);
      return `<li><span class="ic ${k}">${icon[k]}</span><time>${hm(e.at)}</time><div><b>${esc(e.actor)}</b> ${esc(e.action)}${e.detail ? `<small>${esc(e.detail)}</small>` : ""}</div></li>`;
    }).join("")}</ol>`;
  }

  function caseView(c, highlightId) {
    const x = c.extracted || {};
    const sights = data.sightings.filter((s) => s.case_id === c.id)
      .sort((a, b) => (!a.decision && b.decision ? -1 : a.decision && !b.decision ? 1 : b.id - a.id));
    const closed = c.status === "closed", rejected = c.status === "rejected";
    const duration = closed ? mmss(new Date(c.closed_at) - new Date(c.created_at)) : null;
    return `
      <div class="d-head">
        ${!closed && !rejected ? clockHtml(c) : ""}
        <div class="ttl">
          <div class="case-no">CASE #${c.id} · ${closed ? "FOUND" : rejected ? "REJECTED" : c.sighted_at ? "SIGHTING CONFIRMED" : "SEARCHING"}</div>
          <h1>${esc(who(x))}</h1>
          <div class="meta"><span>Last seen <b>${esc(c.zone)}</b></span>${c.approved_at ? `<span>Approved by <b>${esc(c.approved_by)}</b> at ${hm(c.approved_at)}</span>` : ""}${closed ? `<span>Found in <b>${duration}</b></span>` : ""}</div>
        </div>
      </div>
      ${!rejected ? `<div class="box">${stepperHtml(c)}</div>` : `<div class="box"><h4>Reason</h4><p class="quote">${esc(c.close_note || "No reason given")}</p></div>`}
      <div class="grid2" style="margin-top:16px">
        <div class="box"><h4>Description</h4>
          <dl class="desc-list">
            <dt>Wearing</dt><dd>${esc((x.clothing || []).join(", ") || "Not given")}</dd>
            <dt>Look for</dt><dd>${esc((x.features || []).join(", ") || "Not given")}</dd>
            ${x.height ? `<dt>Height</dt><dd>${esc(x.height)}</dd>` : ""}
            ${x.special_needs ? `<dt>Needs</dt><dd>${esc(x.special_needs)}</dd>` : ""}
            <dt>Last seen</dt><dd>${esc(c.zone)}${x.last_seen_place && x.last_seen_place.toLowerCase() !== c.zone.toLowerCase() ? ` (${esc(x.last_seen_place)})` : ""}</dd>
            <dt>Parent</dt><dd>${esc(c.reporter_name || "Not given")}${c.reporter_phone ? ` · ${esc(c.reporter_phone)}` : ""}</dd>
          </dl>
          <h4 style="margin-top:16px">Alerts sent</h4>
          <div class="alerts-row">${c.alerts_sent ? alertsChips(c) : '<span>None</span>'}</div>
        </div>
        <div class="box"><h4>Sightings <span class="by">${sights.length}</span></h4>
          <div class="sights">${sights.length ? sights.map((s) => sightHtml(s, highlightId)).join("") : '<p style="margin:0;color:var(--muted)">No sightings yet. Guards report on the sighting form or in Discord.</p>'}</div>
        </div>
      </div>
      <div class="box"><h4>Timeline</h4>${timelineHtml(c.id)}</div>
      ${c.status === "active" ? `<div class="decide"><span style="margin-right:auto;color:var(--muted);font-size:13px">Closing withdraws every alert and removes the child’s details.</span><button class="btn sage" data-act="found">Child found, close case <span class="k">F</span></button></div>` : ""}`;
  }

  function alertsChips(c) {
    const ev = caseEvents(c.id).filter((e) => e.actor === "Discord" && /^Sent/.test(e.action));
    const withdrawn = caseEvents(c.id).some((e) => e.actor === "Closer");
    return ev.map((e) => `<span class="${withdrawn ? "withdrawn" : ""}">${esc(e.action.replace(/^Sent /, ""))}${withdrawn ? " · withdrawn" : ""}</span>`).join("") || `<span>${c.alerts_sent}</span>`;
  }

  function sightingView(s) {
    return `
      <div class="d-head"><div class="ttl"><div class="case-no">SIGHTING #${s.id}</div><h1>No case matched clearly</h1>
        <div class="meta"><span>At <b>${esc(s.zone)}</b></span><span>${esc(s.reporter || "staff")} · ${hm(s.created_at)}</span></div></div></div>
      <div class="box"><h4>What they saw</h4>${sightHtml(s)}</div>`;
  }

  function wireDetail() {
    const el = $("#detail");
    const [t, id] = (sel || ":").split(":");
    const c = t === "c" ? caseById(+id) : null;
    el.querySelectorAll("input[data-field]").forEach((inp) => inp.addEventListener("input", () => {
      drafts[c.id] = drafts[c.id] || {};
      drafts[c.id][inp.dataset.field] = inp.value;
      inp.parentElement.classList.toggle("edited", inp.value !== inp.dataset.orig);
    }));
    const ack = $("#ack", el);
    if (ack) ack.addEventListener("change", () => {
      drafts[c.id] = drafts[c.id] || {};
      drafts[c.id].__ack = ack.checked;
      $('[data-act="approve"]', el).disabled = !ack.checked;
    });
    el.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, b.dataset.id ? +b.dataset.id : null, b)));
    $("#focus-sight", el)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function act(what, sid, btn) {
    const item = findSel();
    try {
      if (what === "approve") {
        const c = item; const d = drafts[c.id] || {};
        const edits = {}; Object.keys(d).filter((k) => !k.startsWith("__")).forEach((k) => (edits[k] = d[k]));
        btn.disabled = true; btn.textContent = "Broadcasting…";
        await post(`/api/cases/${c.id}/approve`, { edits });
        delete drafts[c.id];
        toast(`Case #${c.id} approved. Zone security has the alert.`);
        await refresh(); select(`c:${c.id}`);
      } else if (what === "reject") {
        const reason = await ask("Reject this report?", "Nothing will be broadcast. Say why, for the log.", "", "Reject report");
        if (reason === null) return;
        await post(`/api/cases/${item.id}/reject`, { reason });
        toast(`Case #${item.id} rejected. Nothing was broadcast.`);
        sel = null; await refresh();
      } else if (what === "confirm" || what === "dismiss") {
        const id = sid ?? (sel.startsWith("s:") ? +sel.split(":")[1] : null);
        if (!id) return;
        await post(`/api/sightings/${id}/${what === "confirm" ? "confirmed" : "dismissed"}`);
        toast(what === "confirm" ? "Sighting confirmed. Nearest guard dispatched, escalation paused." : "Sighting dismissed.");
        const s = data.sightings.find((x) => x.id === id);
        await refresh();
        if (s?.case_id) select(`c:${s.case_id}`); else { sel = null; renderQueue(); }
      } else if (what === "found") {
        const c = sel.startsWith("s:") ? caseById(item.case_id) : item;
        const note = await ask(`Close case #${c.id}?`, "Every alert will be edited to resolved and the child’s details removed.", "Reunited with parent at the security desk.", "Close case");
        if (note === null) return;
        await post(`/api/cases/${c.id}/close`, { note });
        toast(`Case #${c.id} closed. Every alert withdrawn.`);
        await refresh(); setTab("closed"); select(`c:${c.id}`, false);
      }
    } catch (e) {
      toast(e.message, true);
      if (btn) { btn.disabled = false; }
    }
  }

  // ---------- map ----------
  const LAYOUT = {
    "Gate 3": [12, 12, 104, 60], "Cinema Level": [124, 12, 264, 60],
    "Kids Play Area": [12, 80, 104, 100], "Food Court": [124, 80, 180, 100], "Gate 2": [312, 80, 76, 100],
    "Parking": [12, 188, 104, 100], "Main Entrance": [124, 188, 150, 100], "Gate 1": [282, 188, 106, 100],
  };
  const center = (z) => { const r = LAYOUT[z]; return r ? [r[0] + r[2] / 2, r[1] + r[3] / 2 + 6] : [200, 150]; };
  const jitter = (id, spread) => [((id * 37) % 11 - 5) * spread, ((id * 53) % 9 - 4) * spread];

  function renderMap() {
    if (!data) return;
    const active = data.cases.filter((c) => c.status === "active");
    const selCase = (() => { const it = findSel(); if (!it) return null; return sel.startsWith("s:") ? caseById(it.case_id) : it; })();
    const wide = new Set();
    active.forEach((c) => { if (c.sighted_at) return; if (c.stage >= 1) Object.keys(LAYOUT).forEach((z) => wide.add(z)); else wide.add(c.zone); });
    let svg = Object.entries(LAYOUT).map(([z, [x, y, w, h]]) =>
      `<g class="zone ${wide.has(z) ? "wide" : ""} ${selCase && selCase.zone === z ? "sel" : ""}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/><text x="${x + 8}" y="${y + 15}">${z}</text></g>`).join("");
    const pins = {};
    active.forEach((c) => { const [cx, cy] = center(c.zone); const [jx, jy] = jitter(c.id, 3); pins[c.id] = [cx + jx, cy + jy]; });
    const shownSights = data.sightings.filter((s) => (!s.decision && s.route !== "unmatched") || (selCase && s.case_id === selCase.id));
    shownSights.forEach((s) => {
      const [cx, cy] = center(s.zone); const [jx, jy] = jitter(s.id + 7, 4);
      const p = [cx + jx, cy + jy];
      if (s.case_id && pins[s.case_id] && !s.decision) svg += `<path class="link" d="M${pins[s.case_id][0]},${pins[s.case_id][1]} Q${(p[0] + pins[s.case_id][0]) / 2},${Math.min(p[1], pins[s.case_id][1]) - 30} ${p[0]},${p[1]}"/>`;
      s._p = p;
    });
    shownSights.forEach((s) => (svg += `<circle class="spot ${s.decision ? "done" : s.route === "review" ? "unsure" : ""}" cx="${s._p[0]}" cy="${s._p[1]}" r="5"><title>Sighting #${s.id}: ${esc(s.text)}</title></circle>`));
    active.forEach((c) => {
      const [x, y] = pins[c.id];
      svg += `<g class="pin" data-case="${c.id}"><circle class="halo" cx="${x}" cy="${y}" r="11"/><circle class="core" cx="${x}" cy="${y}" r="11"/><text x="${x}" y="${y + 3}" text-anchor="middle">${c.id}</text></g>`;
    });
    $("#map").innerHTML = svg;
    $("#map").querySelectorAll(".pin").forEach((g) => g.addEventListener("click", () => select(`c:${g.dataset.case}`)));
  }

  // ---------- feed ----------
  function renderFeed() {
    const rows = data.events.filter((e) => feedFilter === "all" || (feedFilter === "ai" ? kindOf(e.actor) === "ai" : kindOf(e.actor) === "human")).slice(0, 60);
    const html = rows.map((e) => { const k = kindOf(e.actor);
      return `<li><time>${hm(e.at)}</time><div><span class="who ${k}">${esc(e.actor)}</span> ${e.case_id ? `<span class="ref" data-case="${e.case_id}">#${e.case_id}</span> ` : ""}${esc(e.action)}${e.detail ? `<small>${esc(e.detail)}</small>` : ""}</div></li>`; }).join("")
      || '<li><span></span><div style="color:var(--muted)">No activity yet.</div></li>';
    const feed = $("#feed");
    if (feed.dataset.html !== html) { feed.innerHTML = html; feed.dataset.html = html; }
  }

  // ---------- stats + timers ----------
  function renderStats() {
    const L = lists();
    const vals = { "st-needs": L.needs.length, "st-active": L.active.length, "st-sight": pending().length,
      "st-found": data.cases.filter((c) => c.status === "closed").length };
    Object.entries(vals).forEach(([id, v]) => { const b = document.getElementById(id); if (b.textContent !== String(v)) { b.textContent = v; b.parentElement.classList.remove("bump"); void b.offsetWidth; b.parentElement.classList.add("bump"); } });
    document.title = L.needs.length ? `(${L.needs.length}) Desk · Talaash` : "Desk · Talaash";
    const keys = new Set(L.needs.map((n) => n.key));
    if (knownNeeds) {
      L.needs.filter((n) => !knownNeeds.has(n.key)).forEach((n) => toast(n.c ? `New report: case #${n.c.id} at ${n.c.zone}` : `New sighting at ${n.s.zone}${n.s.case_id ? ` for case #${n.s.case_id}` : ""}`));
    }
    knownNeeds = keys;
  }

  function tick() {
    $("#clock").textContent = new Date(now()).toLocaleTimeString([], { hour12: false });
    document.querySelectorAll("[data-since]").forEach((el) => el.dataset.since !== "null" && (el.textContent = mmss(now() - new Date(el.dataset.since))));
    document.querySelectorAll("[data-ago]").forEach((el) => (el.textContent = ago(el.dataset.ago)));
    document.querySelectorAll("[data-clock]").forEach((el) => {
      const c = data && caseById(+el.dataset.clock); if (!c || !c.approved_at) return;
      const elapsed = now() - new Date(c.approved_at);
      const arc = el.querySelector(".arc"), b = el.querySelector("b"), span = el.querySelector("span");
      let frac, color, label;
      if (c.sighted_at) { frac = 1; color = "var(--sky)"; label = "sighting confirmed"; }
      else if (c.stage === 0) { frac = elapsed / (STEPS[0] * 60000); color = "var(--signal)"; label = `to all-zone alert (${STEPS[0]}m)`; }
      else if (c.stage === 1) { frac = (elapsed - STEPS[0] * 60000) / ((STEPS[1] - STEPS[0]) * 60000); color = "#c2401c"; label = `to police (${STEPS[1]}m)`; }
      else { frac = 1; color = "#7a2412"; label = "police called"; }
      frac = Math.min(Math.max(frac, 0), 1);
      arc.style.stroke = color;
      arc.style.strokeDashoffset = (314.16 * (1 - frac)).toFixed(1);
      b.textContent = mmss(elapsed);
      span.textContent = label;
    });
  }

  // ---------- loop ----------
  async function refresh() {
    try {
      const r = await fetch("/api/desk");
      if (r.status === 401) return (location.href = "/login");
      data = await r.json();
      offset = new Date(data.now) - Date.now();
      $("#live-dot").classList.remove("off");
      renderStats(); renderQueue(); renderDetail(false); renderMap(); renderFeed();
    } catch (e) { $("#live-dot").classList.add("off"); }
  }

  // ---------- events ----------
  $("#detail").dataset.empty = $("#detail").innerHTML;
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { setTab(b.dataset.tab); }));
  document.querySelectorAll(".stat").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.filter)));
  $("#items").addEventListener("click", (e) => { const li = e.target.closest(".item"); if (li) select(li.dataset.key, false); });
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    feedFilter = b.dataset.feed; document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b)); $("#feed").dataset.html = ""; renderFeed();
  }));
  $("#feed").addEventListener("click", (e) => { const r = e.target.closest(".ref"); if (r) select(`c:${r.dataset.case}`); });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    const items = [...document.querySelectorAll("#items .item")];
    const i = items.findIndex((li) => li.dataset.key === sel);
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); const n = items[Math.min(i + 1, items.length - 1)]; n && select(n.dataset.key, false); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); const n = items[Math.max(i - 1, 0)]; n && select(n.dataset.key, false); }
    else if (e.key === "a") $('#detail [data-act="approve"]:not(:disabled)')?.click();
    else if (e.key === "c") $('#detail [data-act="confirm"]')?.click();
    else if (e.key === "f") $('#detail [data-act="found"]')?.click();
  });

  refresh();
  setInterval(refresh, 3000);
  setInterval(tick, 1000);
})();
