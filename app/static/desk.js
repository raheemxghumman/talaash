// Talaash desk: queue, detail views, venue map, activity feed, stats.
(() => {
  const STEPS = document.body.dataset.steps.split(",").map(Number);
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const AI = /agent|Watcher|Closer|Discord|matcher|assistant|Photo check/i;

  let data = null, offset = 0, tab = "needs", sel = null, feedFilter = "all";
  let rendered = { key: null, sig: null };
  let knownNeeds = null, speaking = null, statsData = null, statsPeriod = "day";
  const drafts = {};
  const seenNotes = {};

  // ---------- helpers ----------
  const now = () => Date.now() + offset;
  const hm = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const p = (n) => String(n).padStart(2, "0"); return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`; };
  const dur = (s) => s == null ? "–" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
  const ago = (iso) => { const m = Math.floor((now() - new Date(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };
  const who = (x = {}) => [x.child_name, x.age_years != null ? `${x.age_years} yrs` : null, x.gender].filter(Boolean).join(" · ") || "Child, details pending";
  const draft = (k) => (drafts[k] = drafts[k] || {});
  const icon = {
    ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/></svg>',
    human: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
    sys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 12h16"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.4-7-11a7 7 0 0 1 14 0c0 6.6-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    mega: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4h4l6 4V6L7 10H3Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  };
  const kindOf = (actor) => AI.test(actor) ? "ai" : ["Desk", "Parent", "Checks", "Finder"].includes(actor) ? "sys" : "human";

  function toast(text, bad) {
    const t = $("#toast");
    t.textContent = text; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4200);
  }

  function ask(title, text, value = "", okLabel = "Confirm", input = true) {
    const d = $("#ask");
    $("#ask-title").textContent = title; $("#ask-text").textContent = text;
    $("#ask-input").value = value; $("#ask-input").hidden = !input; $("#ask-ok").textContent = okLabel;
    d.showModal(); setTimeout(() => (input ? $("#ask-input") : $("#ask-ok")).focus(), 30);
    return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "ok" ? $("#ask-input").value : null), { once: true }));
  }

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (r.status === 401) location.href = "/login";
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(out.detail || "Something went wrong"); e.data = out; e.status = r.status; throw e; }
    return out;
  }

  // ---------- derived lists ----------
  const caseById = (id) => data.cases.find((c) => c.id === id);
  const isOpen = (c) => c && (c.status === "review" || c.status === "active");
  const pending = () => data.sightings.filter((s) => !s.decision && (s.route === "likely" || s.route === "review"));
  const matchById = (id) => (data.matches || []).find((m) => m.id === id);
  const openMatches = () => (data.matches || []).filter((m) => !m.decision && isOpen(caseById(m.missing_id)) && isOpen(caseById(m.found_id)));
  const matchesFor = (c) => (data.matches || []).filter((m) => m.missing_id === c.id || m.found_id === c.id);
  function lists() {
    const review = data.cases.filter((c) => c.status === "review");
    const needs = [
      ...review.filter((c) => c.kind === "found").map((c) => ({ key: `c:${c.id}`, c })),
      ...openMatches().map((m) => ({ key: `m:${m.id}`, m })),
      ...review.filter((c) => c.kind !== "found").map((c) => ({ key: `c:${c.id}`, c })),
      ...pending().map((s) => ({ key: `s:${s.id}`, s })),
    ];
    const active = data.cases.filter((c) => c.status === "active").map((c) => ({ key: `c:${c.id}`, c }));
    const closed = data.cases.filter((c) => c.status === "closed" || c.status === "rejected").map((c) => ({ key: `c:${c.id}`, c }));
    return { needs, active, closed };
  }

  // ---------- queue ----------
  function itemHtml(it) {
    if (it.m) {
      const m = it.m, a = caseById(m.missing_id), b = caseById(m.found_id);
      return `<li class="item k-match" data-key="${it.key}">
        <span class="t"><span class="tag tag-ink">Match</span>Missing #${m.missing_id} ${icon.link} Found #${m.found_id}</span>
        <span class="s">${esc(who(a.extracted))} · now at ${esc(b.zone)}</span>
        <span class="r">${m.score == null ? "hand" : Math.round(m.score * 100) + "%"}</span></li>`;
    }
    if (it.s) {
      const s = it.s, likely = s.route === "likely";
      return `<li class="item k-sighting" data-key="${it.key}">
        <span class="t"><span class="tag ${likely ? "tag-sky" : "tag-amber"}">${likely ? "Likely" : "Unsure"}</span>Sighting${s.case_id ? ` → #${s.case_id}` : ""}</span>
        <span class="s">${esc(s.zone)} · ${esc(s.text)}</span>
        <span class="r">${s.score == null ? "?" : Math.round(s.score * 100) + "%"}</span></li>`;
    }
    const c = it.c, x = c.extracted || {};
    if (c.kind === "found" && (c.status === "review" || c.status === "active")) {
      return `<li class="item k-found" data-key="${it.key}">
        <span class="t"><span class="tag tag-found">${c.status === "review" ? "Found child" : "Staff sent"}</span>#${c.id} ${esc(x.age_years != null || x.gender ? who({ ...x, child_name: null }) : "Child")}</span>
        <span class="s">${esc(c.zone)} · with ${esc((c.reporter_name || "a finder").split(" ")[0])}</span>
        <span class="r hot" data-since="${c.created_at}"></span></li>`;
    }
    if (c.status === "review") {
      const issues = (c.verification?.issues || []).length;
      return `<li class="item ${c.urgency === "high" ? "k-urgent" : "k-review"}" data-key="${it.key}">
        <span class="t"><span class="tag ${issues ? "tag-signal" : "tag-amber"}">${issues ? issues + " flag" + (issues > 1 ? "s" : "") : "Ready"}</span>#${c.id} ${esc(who(x))}${c.photo_id ? ' <i class="has-photo" title="Has a photo"></i>' : ""}</span>
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
    const found = c.kind === "found";
    return `<li class="item ${c.status === "closed" ? "k-closed" : "k-rejected"}" data-key="${it.key}">
      <span class="t"><span class="tag ${c.status === "closed" ? "tag-sage" : "tag-grey"}">${c.status === "closed" ? (found ? "Handed over" : "Found") : "Rejected"}</span>#${c.id} ${esc(found ? "Found child" : who(x))}</span>
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
    if (t === "m") return matchById(+id);
    return t === "c" ? caseById(+id) : data.sightings.find((s) => s.id === +id);
  }

  function select(key, focusTab = true) {
    sel = key;
    if (focusTab) {
      const [t, id] = key.split(":");
      const c = t === "c" ? caseById(+id) : null;
      const target = t === "s" || t === "m" || c?.status === "review" ? "needs" : c?.status === "active" ? "active" : "closed";
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

  // ---------- detail ----------
  function caseEvents(id) { return data.events.filter((e) => e.case_id === id).slice().reverse(); }
  function eventTime(id, re) { const e = caseEvents(id).find((e) => re.test(e.action)); return e?.at; }

  function signature() {
    const item = findSel();
    if (!item) return "none";
    if (sel.startsWith("m:")) {
      const a = caseById(item.missing_id), b = caseById(item.found_id);
      return JSON.stringify([sel, item.decision, a?.status, b?.status, a?.photo_id]);
    }
    if (sel.startsWith("s:") && !item.case_id) return JSON.stringify(item);
    const c = sel.startsWith("s:") ? caseById(item.case_id) : item;
    if (!c) return "gone";
    const sights = data.sightings.filter((s) => s.case_id === c.id).map((s) => [s.id, s.decision]);
    const ev = data.events.filter((e) => e.case_id === c.id);
    const quiet = ev.filter((e) => e.action === "Note" || e.action === "Approved a PA announcement").length;
    const matches = matchesFor(c).map((m) => [m.id, m.decision]);
    return JSON.stringify([sel, c.status, c.stage, c.sighted_at, c.alerts_sent, sights, c.status === "review" ? quiet : ev.length,
      c.photo_id, !!c.photo_analysis, c.report?.summary || !!c.report, matches]);
  }

  function renderDetail(force) {
    const sig = signature();
    if (!force && sig === rendered.sig) return;
    const keep = rendered.key === sel;
    rendered = { key: sel, sig };
    const el = $("#detail");
    const item = findSel();
    const scroll = keep ? el.scrollTop : 0;
    const ae = document.activeElement;
    const keepKey = ae && el.contains(ae) ? ae.dataset.keep : null;
    const caret = keepKey && "selectionStart" in ae ? ae.selectionStart : null;
    if (!item) {
      el.innerHTML = el.dataset.empty;
      return;
    }
    const [t] = sel.split(":");
    if (t === "m") el.innerHTML = matchView(item);
    else if (t === "s") {
      const c = item.case_id ? caseById(item.case_id) : null;
      el.innerHTML = c ? caseView(c, item.id) : sightingView(item);
    } else if (item.kind === "found") el.innerHTML = foundView(item);
    else el.innerHTML = item.status === "review" ? reviewView(item) : caseView(item);
    el.classList.remove("swap"); void el.offsetWidth; if (!keep) el.classList.add("swap");
    el.scrollTop = scroll;
    wireDetail();
    if (keepKey) {
      const n = el.querySelector(`[data-keep="${keepKey}"]`);
      if (n) { n.focus(); try { if (caret != null) n.setSelectionRange(caret, caret); } catch (e) {} }
    }
    countUp(el);
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

  function historyBox(signals) {
    const warns = signals.filter((sg) => sg.level === "warn");
    return `<div class="box"><h4>Report history <span class="by">phone, network, photo</span></h4>
      ${signals.length ? `<ul class="issues signals">${signals.map((sg) => `<li class="${sg.level}">${sg.level === "warn" ? icon.warn : icon.human}<div>${esc(sg.text)}</div></li>`).join("")}</ul>` : ""}
      ${!warns.length ? `<div class="ok-line">${icon.ok}No warning signs: no rejected, repeat or duplicate reports.</div>` : ""}
    </div>`;
  }

  function checkerBox(v, issues, okText) {
    return `<div class="box"><h4>Checker <span class="by">${esc(v.checker || "")}</span></h4>
      ${issues.length ? `<ul class="issues">${issues.map((i) => `<li class="${i.field === "photo" ? "photo-issue" : ""}">${icon.warn}<div><b>${esc(i.field)}</b> ${esc(i.problem)}${i.quote ? `<q>“${esc(i.quote)}”</q>` : ""}</div></li>`).join("")}</ul>`
        : `<div class="ok-line">${icon.ok}${okText}</div>`}
    </div>`;
  }

  function photoBox(c) {
    if (!c.photo_id) {
      return c.photo_today && c.status !== "review" && c.status !== "active"
        ? `<div class="box photo-box gone"><h4>Photo</h4><div class="ok-line">${icon.ok}Deleted when the case ${c.status === "rejected" ? "was rejected" : "closed"}.</div></div>` : "";
    }
    const a = c.photo_analysis || {}, s = a.seen || {};
    const today = { yes: "Taken today", no: "Not taken today", unsure: "Not sure when taken" }[c.photo_today] || "";
    const chips = [...(s.clothing || []).map((x) => `<span>${esc(x)}</span>`), s.hair ? `<span class="soft">${esc(s.hair)}</span>` : "",
      ...(s.carrying || []).map((x) => `<span class="soft">${esc(x)}</span>`)].join("");
    return `<div class="box photo-box"><h4>Photo <span class="by ${c.photo_today === "yes" ? "ok" : ""}">${esc(today)}</span></h4>
      <div class="ph">
        <button class="ph-img" data-act="photo" data-src="/api/photos/${c.photo_id}" aria-label="Open the photo"><img src="/api/photos/${c.photo_id}" alt="Photo from the parent" onload="this.classList.add('in')"><span class="zoom">Open</span></button>
        <div class="ph-seen">
          ${a.ok ? `<span class="lbl">${icon.ai} The AI saw</span><div class="chips">${chips || '<span class="soft">Nothing clear</span>'}</div>
            <div class="ph-facts"><span>${s.people === 1 ? "1 person" : `${s.people ?? "?"} people`}</span><span>${s.appears && s.appears !== "unclear" ? esc(s.appears) : "boy/girl unclear"}</span><span>${esc(s.quality || "")}</span></div>`
          : `<span class="lbl">Not checked by the AI</span><p class="ph-note">Compare it with the report by eye.</p>`}
          <p class="ph-note">Clothing only. Faces are never matched.${c.status === "review" ? " Guards see it only after you approve." : ""}</p>
        </div>
      </div></div>`;
  }

  function notesBox(c) {
    const notes = caseEvents(c.id).filter((e) => e.action === "Note");
    const before = seenNotes[c.id] ?? notes.length;
    seenNotes[c.id] = notes.length;
    return `<div class="box notes-box"><h4>${icon.note} Notes <span class="by">only the desk sees these</span></h4>
      ${notes.length ? `<ul class="notes">${notes.map((n, i) => `<li class="${i >= before ? "fresh" : ""}"><span class="av">${esc((n.actor || "?")[0].toUpperCase())}</span><div><b>${esc(n.actor)}</b><time>${hm(n.at)}</time><p>${esc(n.detail)}</p></div></li>`).join("")}</ul>`
        : `<p class="notes-empty">Nothing yet. Add what the next officer should know.</p>`}
      <form class="note-form" data-case="${c.id}" autocomplete="off"><input data-keep="note-${c.id}" maxlength="500" placeholder="e.g. Mother waiting at desk 2" value="${esc(draft(c.id).__note || "")}"><button class="btn sm" type="submit">Add</button></form>
    </div>`;
  }

  function scoreRing(score, size = 44) {
    const pct = score == null ? null : Math.round(score * 100);
    const r = 18, len = 2 * Math.PI * r;
    const color = pct == null ? "var(--ink-3)" : pct >= 75 ? "var(--sage)" : "var(--amber)";
    return `<svg class="ring-s" viewBox="0 0 44 44" width="${size}" height="${size}"><circle cx="22" cy="22" r="${r}" class="tr"/><circle cx="22" cy="22" r="${r}" class="ar" style="stroke:${color};--len:${len.toFixed(1)};--off:${pct == null ? 0 : (len * (1 - pct / 100)).toFixed(1)}"/><text x="22" y="26" text-anchor="middle">${pct == null ? "?" : pct}</text></svg>`;
  }

  function matchStrip(c) {
    const ms = matchesFor(c).filter((m) => !m.decision && isOpen(caseById(m.missing_id)) && isOpen(caseById(m.found_id)));
    if (!ms.length) return "";
    const found = c.kind === "found";
    return `<div class="box match-strip"><h4>${icon.link} ${found ? "This may be a missing child already reported" : "A found child may be this one"} <span class="by">matcher</span></h4>
      ${ms.map((m) => {
        const o = caseById(found ? m.missing_id : m.found_id);
        return `<button class="mrow" data-goto="m:${m.id}">${scoreRing(m.score)}<span class="mt"><b>${found ? "Missing" : "Found"} #${o.id} · ${esc(who(o.extracted))}</b><small>${found ? "Last seen" : "Now at"} ${esc(o.zone)} · ${hm(o.created_at)}${m.score == null ? " · linked by hand" : ""}</small></span><span class="go">Compare <span class="arrow">→</span></span></button>`;
      }).join("")}
    </div>`;
  }

  function linkBox(c) {
    const open = data.cases.filter((x) => x.kind !== "found" && isOpen(x));
    if (!open.length) return `<div class="box link-box"><h4>${icon.link} Find the parent</h4><p class="muted-line">No open missing-child reports yet. When a parent reports, the matcher compares them with this child straight away.</p></div>`;
    const d = draft(c.id);
    return `<div class="box link-box"><h4>${icon.link} Link to a missing report <span class="by">if the matcher missed it</span></h4>
      <div class="link-row"><select data-keep="link-${c.id}">${open.map((o) => `<option value="${o.id}" ${String(d.__link) === String(o.id) ? "selected" : ""}>#${o.id} · ${esc(who(o.extracted))} · ${esc(o.zone)}</option>`).join("")}</select>
      <button class="btn ghost" data-act="link">Compare side by side</button></div></div>`;
  }

  function paBox(c) {
    if (c.status !== "active") return "";
    const d = draft(c.id), pa = d.__pa;
    const found = c.kind === "found";
    const done = caseEvents(c.id).filter((e) => e.action === "Approved a PA announcement");
    const words = pa && pa.text ? pa.text.trim().split(/\s+/).length : 0;
    return `<div class="box pa-box ${speaking === c.id ? "speaking" : ""}" data-case="${c.id}"><h4>${icon.mega} PA announcement <span class="by">AI drafts · you approve</span></h4>
      ${!pa ? `<div class="pa-start"><div><b>${found ? "Ask the parent to come forward" : "Ask everyone in the venue to help"}</b>
          <p>${found ? "Found children are never described in public, so nobody can claim one by repeating the description." : "The child's name is never used: a stranger could call the child over with it."}</p></div>
          <button class="btn ghost" data-act="pa-draft">Draft announcement</button></div>`
      : pa.loading ? `<div class="pa-draft"><div class="sk"><i></i><i></i><i></i></div><p class="muted-line">Drafting…</p></div>`
      : `<div class="pa-draft">
          <textarea data-keep="pa-${c.id}" rows="3" ${found ? "readonly" : ""}>${esc(pa.text)}</textarea>
          <div class="pa-meta"><span class="src ${pa.source === "template" ? "tpl" : "ai"}">${pa.source === "template" ? "Standard wording" : "AI draft · " + esc(pa.source)}</span><span class="pa-count">${words} words</span>${pa.note ? `<span class="pa-note">${esc(pa.note)}</span>` : ""}</div>
          <div class="pa-acts">${found ? "" : '<button class="btn ghost sm" data-act="pa-draft">Redraft</button>'}<button class="btn ghost sm" data-act="pa-copy">Copy</button><span style="flex:1"></span><button class="btn signal" data-act="pa-approve">Approve and play</button></div>
        </div>`}
      <div class="pa-live"><div class="pa-wave" aria-hidden="true">${"<i></i>".repeat(32)}</div><span>Playing on this device</span><button class="btn ghost sm" data-act="pa-stop">Stop</button></div>
      ${done.length ? `<ol class="pa-log">${done.slice().reverse().map((e) => `<li><time>${hm(e.at)}</time><p>${esc(e.detail)}</p><button class="icon-btn" data-act="pa-play" data-text="${esc(e.detail)}" title="Play again" aria-label="Play again">${icon.play}</button></li>`).join("")}</ol>` : ""}
    </div>`;
  }

  function reportBox(c) {
    const r = c.report;
    if (!r) return `<div class="box report-box"><h4>Incident report</h4><div class="sk"><i></i><i></i></div><p class="muted-line">Writing the report…</p></div>`;
    const total = r.total_seconds || 0, appr = r.approval_seconds || 0, sight = r.to_sighting_seconds;
    const searching = sight != null ? sight : Math.max(0, total - appr);
    const after = sight != null ? Math.max(0, total - appr - sight) : 0;
    const segs = [["wait", "Waiting for the officer", appr], ["search", c.kind === "found" ? "Staff on the way" : "Searching", searching], ["after", "Sighting to found", after]]
      .filter(([, , s]) => s > 0);
    const sum = segs.reduce((a, [, , s]) => a + s, 0) || 1;
    return `<div class="box report-box print-me" data-case="${c.id}">
      <div class="print-head">Talaash · Incident report · ${c.kind === "found" ? "Found child" : "Case"} #${c.id} · ${new Date(c.created_at).toLocaleString()}</div>
      <h4>Incident report <span class="by">${r.summary_by === "AI" ? "summary written by AI from the log" : "from the log"}</span><button class="btn ghost sm no-print" data-act="print">Print</button></h4>
      <div class="kpis">
        <div><b>${dur(r.total_seconds)}</b><span>Report to ${c.kind === "found" ? "hand-over" : "found"}</span></div>
        <div><b>${dur(r.approval_seconds)}</b><span>Officer response</span></div>
        <div><b>${sight != null ? dur(sight) : "–"}</b><span>Approval to sighting</span></div>
        <div><b>${esc(r.stage_reached)}</b><span>Search reached</span></div>
      </div>
      <div class="tbar">${segs.map(([cls, label, s]) => `<i class="${cls}" style="--w:${(s / sum * 100).toFixed(1)}%" title="${label}: ${dur(s)}"></i>`).join("")}</div>
      <div class="tlegend">${segs.map(([cls, label, s]) => `<span><i class="${cls}"></i>${label} ${dur(s)}</span>`).join("")}</div>
      ${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : `<div class="sk"><i></i><i></i></div>`}
      <dl class="rep-facts"><dt>Outcome</dt><dd>${esc(r.how)}</dd><dt>Sightings</dt><dd>${r.sightings} (${r.confirmed_sightings} confirmed)</dd>
        <dt>Alerts</dt><dd>${r.alerts_sent} sent, ${r.alerts_withdrawn} withdrawn</dd><dt>Approved by</dt><dd>${esc(r.approved_by || "–")}</dd>
        <dt>Closed by</dt><dd>${esc(r.closed_by || "–")}</dd>${r.photo_used ? "<dt>Photo</dt><dd>Used, then deleted on close</dd>" : ""}</dl>
    </div>`;
  }

  function reviewView(c) {
    const x = c.extracted || {}, v = c.verification || { issues: [] }, issues = v.issues || [];
    const signals = v.signals || [], warns = signals.filter((sg) => sg.level === "warn");
    const needsAck = issues.length || warns.length;
    const flagged = new Set(issues.map((i) => i.field));
    const d = draft(c.id);
    const fields = FIELDS.map(([k, label, wide]) => {
      const orig = Array.isArray(x[k]) ? x[k].join(", ") : x[k] ?? "";
      const val = d[k] ?? orig;
      return `<label class="${wide ? "wide " : ""}${flagged.has(k) ? "flag " : ""}${d[k] != null && d[k] !== orig ? "edited" : ""}">${label}
        <input data-field="${k}" data-orig="${esc(orig)}" value="${esc(val)}"></label>`;
    }).join("");
    return `
      <div class="d-head"><div class="ttl">
        <div class="case-no">CASE #${c.id} · NEW REPORT</div>
        <h1>${esc(who(x))}</h1>
        <div class="meta"><span>Last seen <b>${esc(c.zone)}</b></span><span>Reported <b data-ago="${c.created_at}"></b></span>${c.urgency === "high" ? '<span style="color:var(--signal-deep);font-weight:600">Young child: priority</span>' : ""}${!c.ai_ok ? '<span style="color:var(--signal-deep);font-weight:600">AI unavailable, fill in by hand</span>' : ""}</div>
      </div></div>
      ${matchStrip(c)}
      <div class="grid2">
        <div class="box"><h4>Parent’s words</h4><p class="quote">${highlight(c.raw_report, issues.map((i) => i.quote))}</p>
          <div class="contact">${c.reporter_name ? `<span>${esc(c.reporter_name)}</span>` : ""}${c.reporter_phone ? `<span>${esc(c.reporter_phone)}</span>` : ""}${!c.reporter_name && !c.reporter_phone ? '<span>No contact given</span>' : ""}</div></div>
        <div class="box"><h4>Case details <span class="by">edit before approving</span></h4><div class="fields">${fields}</div></div>
      </div>
      ${c.photo_id ? `<div class="grid2">${photoBox(c)}${historyBox(signals)}</div>` : historyBox(signals)}
      ${checkerBox(v, issues, "Every detail matches the parent’s words.")}
      ${notesBox(c)}
      <div class="decide">
        ${needsAck ? `<label class="ack"><input type="checkbox" id="ack" ${d.__ack ? "checked" : ""}> I’ve checked the warnings${warns.length ? " and spoken to the reporter" : ""}</label>` : '<span style="margin-right:auto"></span>'}
        <button class="btn ghost" data-act="reject">Reject</button>
        <button class="btn signal" data-act="approve" ${needsAck && !d.__ack ? "disabled" : ""}>Approve broadcast <span class="k">A</span></button>
      </div>`;
  }

  function foundView(c) {
    const x = c.extracted || {}, v = c.verification || { issues: [] }, issues = v.issues || [], signals = v.signals || [];
    const state = { review: "WAITING FOR STAFF", active: "STAFF SENT", closed: "HANDED OVER", rejected: "REJECTED" }[c.status];
    const finder = c.reporter_name || "a member of the public";
    const live = isOpen(c);
    return `
      <div class="d-head"><div class="found-badge ${live ? "live" : ""}">${icon.pin}</div><div class="ttl">
        <div class="case-no">FOUND CHILD #${c.id} · ${state}</div>
        <h1>${esc(x.age_years != null || x.gender ? who({ ...x, child_name: null }) : "A child on their own")}</h1>
        <div class="meta"><span>With <b>${esc(finder)}</b> at <b>${esc(c.zone)}</b></span><span>Reported <b data-ago="${c.created_at}"></b></span>${c.reporter_phone ? `<span>${esc(c.reporter_phone)}</span>` : ""}</div>
      </div></div>
      ${live ? `<div class="safe-banner ${c.status}"><span class="sb-dot"></span><div><b>${c.status === "review" ? "A child is with a member of the public right now." : `Staff are on the way to ${esc(c.zone)}.`}</b>
        <span>${c.status === "review" ? "Send staff first, then look for the parent." : "Bring the child to the desk. Hand them over only after the identity check."}</span></div></div>` : ""}
      ${matchStrip(c)}
      <div class="grid2">
        <div class="box"><h4>Finder’s words</h4><p class="quote">${highlight(c.raw_report, issues.map((i) => i.quote))}</p></div>
        <div class="box"><h4>What the AI read</h4><dl class="desc-list">
          <dt>Age</dt><dd>${x.age_years != null ? esc(x.age_years) + " years" : "Not given"}</dd>
          <dt>Boy / girl</dt><dd>${esc(x.gender || "Not given")}</dd>
          <dt>Wearing</dt><dd>${esc((x.clothing || []).join(", ") || "Not given")}</dd>
          <dt>Look for</dt><dd>${esc((x.features || []).join(", ") || "Not given")}</dd>
          <dt>Name they say</dt><dd>${esc(x.child_name || "Not given")}</dd></dl></div>
      </div>
      ${live ? linkBox(c) : ""}
      ${paBox(c)}
      <div class="grid2">${historyBox(signals)}${checkerBox(v, issues, "Nothing odd in the finder’s message.")}</div>
      ${notesBox(c)}
      ${c.status === "closed" ? reportBox(c) : ""}
      ${c.status === "rejected" ? `<div class="box"><h4>Reason</h4><p class="quote">${esc(c.close_note || "No reason given")}</p></div>` : ""}
      <div class="box"><h4>Timeline</h4>${timelineHtml(c.id)}</div>
      ${c.status === "review" ? `<div class="decide"><span class="hint-l">Staff are told where to go. Nothing about the child is posted.</span><button class="btn ghost" data-act="reject">Reject</button><button class="btn sage" data-act="dispatch">Send staff <span class="k">A</span></button></div>`
        : c.status === "active" ? `<div class="decide"><span class="hint-l">Reunite through a match. Close here only if the child went to police or another service.</span><button class="btn ghost" data-act="found">Close without a match</button></div>` : ""}`;
  }

  const CHECKS = [["described", "The parent described the child in their own words before seeing them"],
    ["recognised", "The child clearly recognises the parent, or the parent showed ID"],
    ["details", "Age and clothing match what the parent said"]];

  function matchSide(c, kind) {
    const x = c.extracted || {};
    return `<div class="mside ${kind}">
      <div class="ms-top"><span class="tag ${kind === "found" ? "tag-found" : "tag-signal"}">${kind === "found" ? "Found child" : "Parent’s report"}</span><b>#${c.id}</b><time>${hm(c.created_at)}</time></div>
      ${kind === "missing" && c.photo_id ? `<button class="ms-photo" data-act="photo" data-src="/api/photos/${c.photo_id}"><img src="/api/photos/${c.photo_id}" alt="Parent's photo" onload="this.classList.add('in')"></button>` : ""}
      <h3>${esc(kind === "found" && !x.child_name ? who({ ...x, child_name: null }) : who(x))}</h3>
      <dl class="desc-list">
        <dt>Wearing</dt><dd>${esc((x.clothing || []).join(", ") || "Not given")}</dd>
        <dt>Look for</dt><dd>${esc((x.features || []).join(", ") || "Not given")}</dd>
        <dt>${kind === "found" ? "Now at" : "Last seen"}</dt><dd>${esc(c.zone)}</dd>
        <dt>${kind === "found" ? "Finder" : "Parent"}</dt><dd>${esc(c.reporter_name || "Not given")}</dd>
      </dl>
      <p class="ms-quote">“${esc(c.raw_report)}”</p>
    </div>`;
  }

  function matchView(m) {
    const a = caseById(m.missing_id), b = caseById(m.found_id);
    if (!a || !b) return `<div class="empty-state"><h2>This match is no longer open.</h2></div>`;
    const pct = m.score == null ? null : Math.round(m.score * 100);
    const d = draft("m" + m.id);
    const all = CHECKS.every(([k]) => d[k]);
    const open = !m.decision && isOpen(a) && isOpen(b);
    return `
      <div class="d-head"><div class="ttl"><div class="case-no">POSSIBLE MATCH${pct != null ? ` · ${pct}%` : " · LINKED BY HAND"}</div>
        <h1>Is this the same child?</h1>
        <div class="meta"><span>Missing <b>#${a.id}</b> · last seen <b>${esc(a.zone)}</b></span><span>Found <b>#${b.id}</b> · now at <b>${esc(b.zone)}</b></span></div></div></div>
      <div class="cmp">
        ${matchSide(a, "missing")}
        <div class="cmp-mid">
          <svg class="cmp-line" viewBox="0 0 40 200" preserveAspectRatio="none" aria-hidden="true"><path d="M20 0 V200"/></svg>
          <div class="cmp-score">${scoreRing(m.score, 76)}<span>${pct == null ? "linked by hand" : pct >= 75 ? "likely" : "unsure"}</span></div>
        </div>
        ${matchSide(b, "found")}
      </div>
      ${(m.reasons || []).length ? `<div class="box"><h4>${icon.ai} Why the matcher paired them</h4><ul class="reasons-l">${m.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      ${open ? `<div class="box id-check"><h4>Identity check <span class="by">all three before reuniting</span></h4>
        ${CHECKS.map(([k, l]) => `<label class="chk ${d[k] ? "on" : ""}"><input type="checkbox" data-check="${k}" ${d[k] ? "checked" : ""}><span class="cb">${icon.ok}</span><span>${esc(l)}</span></label>`).join("")}
        <p class="why">This is what stops someone claiming a child who isn’t theirs. The hand-over is logged with your name.</p></div>
      <div class="decide"><button class="btn ghost" data-act="m-dismiss">Not the same child</button><span style="margin-right:auto"></span><button class="btn sage" data-act="m-reunite" ${all ? "" : "disabled"}>Reunite and close both</button></div>`
      : `<div class="box"><div class="ok-line">${icon.ok}${m.decision === "confirmed" ? `Reunited by ${esc(m.decided_by)} at ${hm(m.decided_at)}.` : m.decision ? `Dismissed by ${esc(m.decided_by)}.` : "One of these cases is closed."}</div></div>`}`;
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
      const k = kindOf(e.actor), note = e.action === "Note";
      return `<li class="${note ? "is-note" : ""}"><span class="ic ${k}">${note ? icon.note : icon[k]}</span><time>${hm(e.at)}</time><div><b>${esc(e.actor)}</b> ${note ? "added a note" : esc(e.action)}${e.detail ? `<small>${esc(e.detail)}</small>` : ""}</div></li>`;
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
      ${matchStrip(c)}
      ${closed ? reportBox(c) : ""}
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
      ${photoBox(c)}
      ${paBox(c)}
      ${notesBox(c)}
      <div class="box"><h4>Timeline</h4>${timelineHtml(c.id)}</div>
      ${c.status === "active" ? `<div class="decide"><span style="margin-right:auto;color:var(--muted);font-size:13px">Closing withdraws every alert, deletes the photo and removes the child’s details.</span><button class="btn sage" data-act="found">Child found, close case <span class="k">F</span></button></div>` : ""}`;
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

  // ---------- wiring ----------
  function currentCase() {
    const item = findSel();
    if (!item || sel.startsWith("m:")) return null;
    return sel.startsWith("s:") ? caseById(item.case_id) : item;
  }

  function wireDetail() {
    const el = $("#detail");
    const c = currentCase();
    el.querySelectorAll("input[data-field]").forEach((inp) => inp.addEventListener("input", () => {
      draft(c.id)[inp.dataset.field] = inp.value;
      inp.parentElement.classList.toggle("edited", inp.value !== inp.dataset.orig);
    }));
    const ack = $("#ack", el);
    if (ack) ack.addEventListener("change", () => {
      draft(c.id).__ack = ack.checked;
      $('[data-act="approve"]', el).disabled = !ack.checked;
    });
    el.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); act(b.dataset.act, b.dataset.id ? +b.dataset.id : null, b); }));
    el.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => select(b.dataset.goto)));
    el.querySelectorAll(".note-form").forEach((f) => {
      const inp = $("input", f);
      inp.addEventListener("input", () => (draft(+f.dataset.case).__note = inp.value));
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = inp.value.trim();
        if (!text) return inp.focus();
        const btn = $("button", f); btn.disabled = true;
        try {
          await post(`/api/cases/${f.dataset.case}/notes`, { text });
          draft(+f.dataset.case).__note = "";
          await refresh();
          $(`#detail [data-keep="note-${f.dataset.case}"]`)?.focus();
        } catch (err) { toast(err.message, true); btn.disabled = false; }
      });
    });
    el.querySelectorAll("textarea[data-keep^='pa-']").forEach((t) => t.addEventListener("input", () => {
      const pa = draft(c.id).__pa; if (pa) pa.text = t.value;
      const n = el.querySelector(".pa-count"); if (n) n.textContent = `${t.value.trim().split(/\s+/).filter(Boolean).length} words`;
    }));
    el.querySelectorAll("select[data-keep^='link-']").forEach((s) => s.addEventListener("change", () => (draft(c.id).__link = s.value)));
    el.querySelectorAll("input[data-check]").forEach((cb) => cb.addEventListener("change", () => {
      const m = findSel(), d = draft("m" + m.id);
      d[cb.dataset.check] = cb.checked;
      cb.closest(".chk").classList.toggle("on", cb.checked);
      $('[data-act="m-reunite"]', el).disabled = !CHECKS.every(([k]) => d[k]);
    }));
    $("#focus-sight", el)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function speak(text, caseId) {
    if (!("speechSynthesis" in window)) { toast("This browser can’t read aloud. Copy the text for the PA.", true); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92;
    const voice = speechSynthesis.getVoices().find((v) => /^en[-_](GB|IN|US)/i.test(v.lang));
    if (voice) u.voice = voice;
    speaking = caseId;
    markSpeaking();
    u.onend = u.onerror = () => { speaking = null; markSpeaking(); };
    speechSynthesis.speak(u);
  }
  function markSpeaking() { document.querySelectorAll(".pa-box").forEach((b) => b.classList.toggle("speaking", speaking != null && +b.dataset.case === speaking)); }

  function reunitedFx() {
    const fx = document.createElement("div");
    fx.className = "reunite-fx";
    fx.innerHTML = '<div class="rf-stage"><i class="a"></i><i class="b"></i><span class="ring"></span></div><b>Reunited</b>';
    document.body.appendChild(fx);
    setTimeout(() => fx.classList.add("out"), 1700);
    setTimeout(() => fx.remove(), 2200);
  }

  async function act(what, sid, btn) {
    const item = findSel();
    const c = currentCase();
    try {
      if (what === "approve") {
        const d = draft(c.id);
        const edits = {}; Object.keys(d).filter((k) => !k.startsWith("__")).forEach((k) => (edits[k] = d[k]));
        btn.disabled = true; btn.textContent = "Broadcasting…";
        await post(`/api/cases/${c.id}/approve`, { edits });
        delete drafts[c.id];
        toast(`Case #${c.id} approved. Zone security has the alert${c.photo_id ? " and the photo" : ""}.`);
        await refresh(); select(`c:${c.id}`);
      } else if (what === "dispatch") {
        btn.disabled = true; btn.textContent = "Sending…";
        await post(`/api/cases/${c.id}/dispatch`);
        toast(`Staff sent to ${c.zone}. Nothing about the child was posted.`);
        await refresh(); select(`c:${c.id}`);
      } else if (what === "reject") {
        const reason = await ask("Reject this report?", c.kind === "found" ? "No staff will be sent. Say why, for the log." : "Nothing will be broadcast. Say why, for the log.", "", "Reject report");
        if (reason === null) return;
        await post(`/api/cases/${c.id}/reject`, { reason });
        toast(`Case #${c.id} rejected.${c.photo_id ? " The photo was deleted." : ""}`);
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
        const found = c.kind === "found";
        const note = await ask(`Close case #${c.id}?`, found ? "Use this only if the child was handed to police or another service. Staff alerts will be withdrawn." : "Every alert will be edited to resolved, the photo deleted and the child’s details removed.",
          found ? "Handed to the police liaison." : "Reunited with parent at the security desk.", "Close case");
        if (note === null) return;
        await post(`/api/cases/${c.id}/close`, { note });
        toast(`Case #${c.id} closed. Every alert withdrawn.`);
        await refresh(); setTab("closed"); select(`c:${c.id}`, false);
      } else if (what === "pa-draft") {
        draft(c.id).__pa = { loading: true };
        renderDetail(true);
        try { draft(c.id).__pa = await post(`/api/cases/${c.id}/pa/draft`); }
        catch (e) { delete draft(c.id).__pa; throw e; }
        finally { renderDetail(true); }
      } else if (what === "pa-approve") {
        const text = $("#detail textarea[data-keep^='pa-']").value;
        let out;
        try { out = await post(`/api/cases/${c.id}/pa/approve`, { text }); }
        catch (e) {
          if (!e.data?.confirm) throw e;
          const go = await ask("Approve anyway?", e.message + " Announcing a child’s name lets strangers call them over.", "", "Approve anyway", false);
          if (go === null) return;
          out = await post(`/api/cases/${c.id}/pa/approve`, { text, force: true });
        }
        delete draft(c.id).__pa;
        toast("Announcement approved and logged.");
        await refresh();
        speak(out.text, c.id);
      } else if (what === "pa-copy") {
        const text = $("#detail textarea[data-keep^='pa-']").value;
        await navigator.clipboard.writeText(text);
        toast("Copied. Not logged until you approve it.");
      } else if (what === "pa-play") {
        speak(btn.dataset.text, c.id);
      } else if (what === "pa-stop") {
        speechSynthesis.cancel(); speaking = null; markSpeaking();
      } else if (what === "link") {
        const missingId = +$("#detail select[data-keep^='link-']").value;
        const out = await post("/api/matches/link", { missing_id: missingId, found_id: c.id });
        await refresh(); select(`m:${out.id}`);
      } else if (what === "m-dismiss") {
        await post(`/api/matches/${item.id}/dismiss`);
        toast("Marked as not the same child.");
        const back = item.found_id;
        await refresh(); select(`c:${back}`);
      } else if (what === "m-reunite") {
        const note = await ask("Reunite and close both cases?", "Both cases close, every alert is withdrawn and the photo is deleted.", "Reunited with the parent at the security desk.", "Reunite");
        if (note === null) return;
        btn.disabled = true;
        await post(`/api/matches/${item.id}/reunite`, { note, identity_checked: true });
        reunitedFx();
        toast(`Reunited. Cases #${item.missing_id} and #${item.found_id} closed, every alert withdrawn.`);
        delete drafts["m" + item.id];
        await refresh(); setTab("closed"); select(`c:${item.missing_id}`, false);
      } else if (what === "photo") {
        const lb = $("#lightbox");
        $("#lightbox img").src = btn.dataset.src;
        lb.showModal();
      } else if (what === "print") {
        document.body.classList.add("printing");
        window.print();
        setTimeout(() => document.body.classList.remove("printing"), 500);
      }
    } catch (e) {
      toast(e.message, true);
      if (btn) btn.disabled = false;
      if (what === "approve" && btn) btn.innerHTML = 'Approve broadcast <span class="k">A</span>';
      if (what === "dispatch" && btn) btn.innerHTML = 'Send staff <span class="k">A</span>';
    }
  }

  // ---------- map (drawn in 3D by venuemap.js) ----------
  function renderMap() {
    if (!data) return;
    const it = findSel();
    const selCase = !it ? null : sel.startsWith("m:") ? it.missing_id : sel.startsWith("s:") ? it.case_id : it.id;
    document.dispatchEvent(new CustomEvent("desk:data", { detail: { data, selCase } }));
  }
  document.addEventListener("desk:map-ready", renderMap);
  document.addEventListener("desk:select", (e) => select(e.detail.key));
  document.addEventListener("desk:toast", (e) => toast(e.detail.text, e.detail.bad));
  document.addEventListener("desk:refresh", () => refresh());

  // ---------- feed ----------
  function renderFeed() {
    const rows = data.events.filter((e) => feedFilter === "all" || (feedFilter === "ai" ? kindOf(e.actor) === "ai" : kindOf(e.actor) === "human")).slice(0, 60);
    const html = rows.map((e) => { const k = kindOf(e.actor);
      return `<li><time>${hm(e.at)}</time><div><span class="who ${k}">${esc(e.actor)}</span> ${e.case_id ? `<span class="ref" data-case="${e.case_id}">#${e.case_id}</span> ` : ""}${e.action === "Note" ? "added a note" : esc(e.action)}${e.detail && e.action !== "Note" ? `<small>${esc(e.detail)}</small>` : ""}</div></li>`; }).join("")
      || '<li><span></span><div style="color:var(--muted)">No activity yet.</div></li>';
    const feed = $("#feed");
    if (feed.dataset.html !== html) { feed.innerHTML = html; feed.dataset.html = html; }
  }

  // ---------- header counts + timers ----------
  function renderStats() {
    const L = lists();
    const vals = { "st-needs": L.needs.length, "st-active": L.active.length, "st-sight": pending().length,
      "st-found": data.cases.filter((c) => c.status === "closed").length };
    Object.entries(vals).forEach(([id, v]) => { const b = document.getElementById(id); if (b.textContent !== String(v)) { b.textContent = v; b.parentElement.classList.remove("bump"); void b.offsetWidth; b.parentElement.classList.add("bump"); } });
    document.title = L.needs.length ? `(${L.needs.length}) Desk · Talaash` : "Desk · Talaash";
    const keys = new Set(L.needs.map((n) => n.key));
    if (knownNeeds) {
      L.needs.filter((n) => !knownNeeds.has(n.key)).forEach((n) => toast(
        n.m ? `Possible match: missing #${n.m.missing_id} and found #${n.m.found_id}`
          : n.c ? (n.c.kind === "found" ? `Found child at ${n.c.zone}. Send staff.` : `New report: case #${n.c.id} at ${n.c.zone}`)
          : `New sighting at ${n.s.zone}${n.s.case_id ? ` for case #${n.s.case_id}` : ""}`));
    }
    knownNeeds = keys;
  }

  function countUp(root) {
    root.querySelectorAll("[data-count]").forEach((el) => {
      const end = +el.dataset.count, t0 = performance.now();
      const step = (t) => { const k = Math.min((t - t0) / 700, 1); el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
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

  // ---------- stats dialog ----------
  function renderStatsDlg() {
    const box = $("#stats-body");
    if (!statsData) { box.innerHTML = '<div class="sk"><i></i><i></i><i></i></div>'; return; }
    const s = statsData[statsPeriod];
    const maxZone = Math.max(1, ...s.zones.map((z) => z.count));
    const tile = (v, label, sub, cls = "") => `<div class="kpi ${cls}"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
    box.innerHTML = `
      <div class="kpi-grid">
        ${tile(`<i data-count="${s.reports}">0</i>`, "Missing-child reports")}
        ${tile(`<i data-count="${s.found}">0</i>`, "Children found", s.reports ? `${Math.round(s.found / s.reports * 100)}% of reports` : "")}
        ${tile(dur(s.median_find_seconds), "Median time to find", "report to closed", "wide")}
        ${tile(dur(s.median_approval_seconds), "Median officer response", "report to approval", "wide")}
        ${tile(`<i data-count="${s.rejected}">0</i>`, "False reports stopped", "rejected, never broadcast", "warn")}
        ${tile(`<i data-count="${s.found_child_reports}">0</i>`, "Found-child reports")}
        ${tile(`<i data-count="${s.reunions}">0</i>`, "Reunited by matching", "", "good")}
        ${tile(`<i data-count="${statsData.open}">0</i>`, "Open right now")}
      </div>
      <h4>Where children went missing</h4>
      ${s.zones.length ? `<ul class="zone-bars">${s.zones.map((z) => `<li><span>${esc(z.zone)}</span><i style="--w:${(z.count / maxZone * 100).toFixed(0)}%"></i><b>${z.count}</b></li>`).join("")}</ul>` : '<p class="muted-line">No searches yet.</p>'}`;
    countUp(box);
  }
  async function openStats() {
    const dlg = $("#stats-dlg");
    statsData = null; renderStatsDlg();
    dlg.showModal();
    try { const r = await fetch("/api/stats"); if (r.status === 401) location.href = "/login"; statsData = await r.json(); }
    catch (e) { $("#stats-body").innerHTML = '<p class="muted-line">Could not load the numbers. Try again.</p>'; return; }
    renderStatsDlg();
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
  document.querySelectorAll(".feed-card .seg button").forEach((b) => b.addEventListener("click", () => {
    feedFilter = b.dataset.feed; document.querySelectorAll(".feed-card .seg button").forEach((x) => x.classList.toggle("on", x === b)); $("#feed").dataset.html = ""; renderFeed();
  }));
  $("#feed").addEventListener("click", (e) => { const r = e.target.closest(".ref"); if (r) select(`c:${r.dataset.case}`); });
  $("#stats-open").addEventListener("click", openStats);
  document.querySelectorAll("#stats-dlg [data-period]").forEach((b) => b.addEventListener("click", () => {
    statsPeriod = b.dataset.period;
    document.querySelectorAll("#stats-dlg [data-period]").forEach((x) => x.classList.toggle("on", x === b));
    renderStatsDlg();
  }));
  $("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox" || e.target.closest("[data-close]")) $("#lightbox").close(); });
  window.addEventListener("afterprint", () => document.body.classList.remove("printing"));
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    const items = [...document.querySelectorAll("#items .item")];
    const i = items.findIndex((li) => li.dataset.key === sel);
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); const n = items[Math.min(i + 1, items.length - 1)]; n && select(n.dataset.key, false); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); const n = items[Math.max(i - 1, 0)]; n && select(n.dataset.key, false); }
    else if (e.key === "a") $('#detail [data-act="approve"]:not(:disabled), #detail [data-act="dispatch"]:not(:disabled)')?.click();
    else if (e.key === "c") $('#detail [data-act="confirm"]')?.click();
    else if (e.key === "f") $('#detail [data-act="found"]')?.click();
  });

  refresh();
  setInterval(refresh, 3000);
  setInterval(tick, 1000);
})();
