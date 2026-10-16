"""The workflow: agents propose, the desk officer decides.

Two kinds of case share one table: "missing" (a parent's report) and "found" (a child
someone is holding). The matcher compares them both ways; only the officer can reunite."""

import os
import re
import secrets
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from statistics import median

from app import agents, db, notify, photos

LIKELY = 0.75
UNSURE = 0.45
STEPS = [float(m) for m in os.getenv("ESCALATION_MINUTES", "1,2").split(",")]
PA_GAP_SECONDS = 120


def _later(fn, *args):
    """Run slow follow-up work (matching, summaries) without making the user wait."""
    def run():
        try:
            fn(*args)
        except Exception as exc:
            print(f"background {fn.__name__} error:", type(exc).__name__, exc, flush=True)
    threading.Thread(target=run, daemon=True).start()


def new_case(report: str, zone: str, reporter_name: str, reporter_phone: str, *, kind: str = "missing",
             photo: bytes | None = None, photo_today: str | None = None, ip_key: str | None = None,
             flags: tuple = ()) -> tuple[int, str]:
    token = secrets.token_urlsafe(12)
    saved = photos.save(photo) if photo else None
    row = db.run(
        """insert into cases (kind, raw_report, zone, reporter_name, reporter_phone, public_token, photo_id, photo_today, ip_key)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning id""",
        kind, report, zone, reporter_name or None, reporter_phone or None, token,
        saved["id"] if saved else None, photo_today if saved else None, ip_key,
    )
    case_id = row["id"]
    reporter = "Parent" if kind == "missing" else "Finder"
    db.log(case_id, reporter, "Reported a missing child" if kind == "missing" else "Reported a child found on their own",
           f"Last seen: {zone}" if kind == "missing" else f"The child is with them at {zone}")
    if saved:
        db.log(case_id, reporter, "Attached a photo", {"yes": "Taken today", "no": "Not taken today"}.get(photo_today, "Not sure when it was taken"))

    seen = None
    result = agents.intake(report, zone)
    if result["ok"]:
        case = result["case"]
        db.log(case_id, "Intake agent", "Built the case record", result["model"])
        with ThreadPoolExecutor(2) as pool:
            verifying = pool.submit(agents.verify, report, case, zone)
            reading = pool.submit(photos.analyse, photo, report, photo_today) if photo else None
            check = verifying.result()
            seen = reading.result() if reading else None
        verdict = "No problems found" if check["ok"] else f"Flagged {len(check['issues'])} issue(s) for the officer"
        db.log(case_id, "Verifier agent", verdict, check["checker"])
    else:
        case = agents.clean_case({})
        check = {"ok": False, "checker": "none", "issues": [{
            "field": "-", "problem": "The AI was unavailable, so nothing was extracted. Fill in the details from the report.", "quote": "",
        }]}
        db.log(case_id, "Intake agent", "Unavailable, case passed to the officer as is", result["error"])
        seen = photos.analyse(photo, report, photo_today) if photo else None

    if seen:
        check["issues"] = check["issues"] + seen["issues"]
        check["ok"] = check["ok"] and not seen["issues"]
        check["photo_phash"] = saved["phash"]
        db.run("update photos set analysis = %s where id = %s", db.as_json(seen), saved["id"])
        what = "Read the clothing in the photo" if seen["ok"] else "Could not read the photo"
        db.log(case_id, "Photo check", what + (f", flagged {len(seen['issues'])} issue(s)" if seen["issues"] else ""), seen.get("model"))

    check["signals"] = report_signals(case_id, zone, reporter_name, reporter_phone, case, kind=kind, ip_key=ip_key,
                                      phash=saved["phash"] if saved else None, flags=flags)
    warns = sum(1 for sig in check["signals"] if sig["level"] == "warn")
    db.log(case_id, "Checks", f"{warns} warning sign(s) for the officer" if warns else "No warning signs in past reports",
           "; ".join(sig["text"] for sig in check["signals"])[:300] or None)

    x = case
    urgent = kind == "found" or (x.get("age_years") is not None and x["age_years"] < 8) or bool(x.get("special_needs"))
    db.run(
        "update cases set extracted = %s, verification = %s, urgency = %s, ai_ok = %s where id = %s",
        db.as_json(case), db.as_json(check), "high" if urgent else "normal", result["ok"], case_id,
    )
    db.log(case_id, "Desk", "Waiting for officer approval before any alert goes out" if kind == "missing"
           else "Waiting for the officer to send staff to the finder")
    _later(find_matches, case_id)
    return case_id, token


def phone_key(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return digits[-10:] if len(digits) >= 7 else ""


def report_signals(case_id: int, zone: str, name: str, phone: str, case: dict, *, kind: str = "missing",
                   ip_key: str | None = None, phash: str | None = None, flags: tuple = ()) -> list[dict]:
    """Warning signs from past reports that no model can see: repeat callers, rejected
    reports, duplicates, reused photos and bursts. They don't block anything; the officer decides."""
    signals = []
    if "bot" in flags:
        signals.append({"level": "warn", "text": "A hidden form field that only bots fill in was filled. This report is probably automated."})
    key = phone_key(phone)
    if key:
        mine = [r for r in db.all("""select id, status, created_at, reporter_phone from cases
                                     where id <> %s and reporter_phone is not null and created_at > now() - interval '30 days'
                                     order by id desc""", case_id) if phone_key(r["reporter_phone"]) == key]
        rejected = [r["id"] for r in mine if r["status"] == "rejected"]
        open_ = [r["id"] for r in mine if r["status"] in ("review", "active")]
        recent = [r for r in mine if (datetime.now(timezone.utc) - r["created_at"]).total_seconds() < 86400]
        if rejected:
            signals.append({"level": "warn", "text": f"This phone number had {len(rejected)} report(s) rejected in the last 30 days "
                            f"({', '.join(f'#{i}' for i in rejected[:3])})."})
        if open_:
            signals.append({"level": "warn", "text": f"This phone number already has open case {', '.join(f'#{i}' for i in open_[:3])}. "
                            "It may be a duplicate, or a second child."})
        if len(recent) >= 3:
            signals.append({"level": "warn", "text": f"{len(recent) + 1} reports from this phone number in 24 hours."})
    elif kind == "found":
        signals.append({"level": "info", "text": f"No phone number given. Staff will need to find the finder at {zone}."})
    else:
        signals.append({"level": "info", "text": "No phone number given. Meet the reporter at the desk before approving."})

    if ip_key:
        same_net = db.one("""select count(*) as n from cases where id <> %s and ip_key = %s
                             and created_at > now() - interval '10 minutes'""", case_id, ip_key)["n"]
        if same_net >= 2:
            signals.append({"level": "warn", "text": f"{same_net + 1} reports from the same network in 10 minutes. "
                            "Venue Wi-Fi is shared, so this can be innocent, but check."})

    if phash:
        reused = photos.reused_in(phash, case_id)
        if reused:
            signals.append({"level": "warn", "text": f"The same photo was used in report {', '.join(f'#{i}' for i in reused[:3])}. "
                            "A reused picture is a common sign of a prank."})

    x = case or {}
    words = lambda items: {w for item in items or [] for w in re.findall(r"[a-z]{3,}", item.lower())}
    mine_words = words(x.get("clothing"))
    for other in db.all("""select id, extracted from cases where id <> %s and kind = %s and status in ('review', 'active')
                           and created_at > now() - interval '3 hours'""", case_id, kind):
        o = other["extracted"] or {}
        same_name = x.get("child_name") and o.get("child_name") and x["child_name"].lower() == o["child_name"].lower()
        shared = mine_words & words(o.get("clothing"))
        same_kid = x.get("age_years") is not None and x.get("age_years") == o.get("age_years") and x.get("gender") == o.get("gender") and shared
        if same_name or same_kid:
            why = f"same name {x['child_name']}" if same_name else f"same age and {', '.join(sorted(shared))}"
            noun = "this child" if kind == "missing" else "this found child"
            signals.append({"level": "warn", "text": f"Looks like open case #{other['id']} ({why}). Someone may have reported {noun} already."})

    burst = db.one("select count(*) as n from cases where created_at > now() - interval '10 minutes'")["n"]
    if burst >= 5:
        signals.append({"level": "warn", "text": f"{burst} reports in the last 10 minutes across the venue. Check for a prank before approving."})
    return signals


# ---------- matching found children and missing reports ----------

def find_matches(case_id: int):
    """Compare a new report with open cases of the other kind and store the best pairing."""
    case = get_case(case_id)
    if not case or case["status"] not in ("review", "active") or not case["extracted"]:
        return None
    other = "found" if case["kind"] == "missing" else "missing"
    candidates = db.all("select * from cases where kind = %s and status in ('review', 'active') and id <> %s order by id", other, case_id)
    if not candidates:
        return None
    result = agents.match(case["raw_report"], case["zone"], candidates, mode=case["kind"])
    if result["score"] is None:
        db.log(case_id, "Matcher", f"Could not compare with {other} reports", "matcher unavailable")
        return None
    if not result["case_id"] or result["score"] < UNSURE:
        db.log(case_id, "Matcher", f"No likely match among {len(candidates)} open {other} report(s)", f"best score {result['score']:.2f}")
        return None
    missing_id, found_id = (case_id, result["case_id"]) if case["kind"] == "missing" else (result["case_id"], case_id)
    row = db.run("""insert into matches (missing_id, found_id, score, reasons) values (%s, %s, %s, %s)
                    on conflict (missing_id, found_id) do nothing returning id""",
                 missing_id, found_id, result["score"], db.as_json(result["reasons"]))
    if row:
        for cid in (missing_id, found_id):
            db.log(cid, "Matcher", f"Possible match: missing #{missing_id} and found #{found_id}", f"score {result['score']:.2f}")
    return row["id"] if row else None


def link(missing_id: int, found_id: int, officer: str) -> int | None:
    m, f = get_case(missing_id), get_case(found_id)
    if not m or not f or m["kind"] != "missing" or f["kind"] != "found":
        return None
    if m["status"] not in ("review", "active") or f["status"] not in ("review", "active"):
        return None
    row = db.run("""insert into matches (missing_id, found_id, score, reasons) values (%s, %s, null, %s)
                    on conflict (missing_id, found_id) do update set decision = null returning id""",
                 missing_id, found_id, db.as_json(["Linked by the officer"]))
    for cid in (missing_id, found_id):
        db.log(cid, officer, f"Linked missing #{missing_id} with found #{found_id} by hand")
    return row["id"]


def dismiss_match(match_id: int, officer: str) -> bool:
    m = db.one("select * from matches where id = %s", match_id)
    if not m or m["decision"]:
        return False
    db.run("update matches set decision = 'dismissed', decided_by = %s, decided_at = now() where id = %s", officer, match_id)
    for cid in (m["missing_id"], m["found_id"]):
        db.log(cid, officer, f"Dismissed the match between missing #{m['missing_id']} and found #{m['found_id']}")
    return True


def reunite(match_id: int, officer: str, note: str, identity_checked: bool) -> str | None:
    """Close both cases together. Returns an error message, or None when done."""
    if not identity_checked:
        return "Confirm the identity check first."
    m = db.one("select * from matches where id = %s", match_id)
    if not m or m["decision"]:
        return "This match was already decided."
    cases = [get_case(m["missing_id"]), get_case(m["found_id"])]
    if any(c is None or c["status"] not in ("review", "active") for c in cases):
        return "One of these cases is no longer open."
    db.run("update matches set decision = 'confirmed', decided_by = %s, decided_at = now() where id = %s", officer, match_id)
    db.run("""update matches set decision = 'dismissed', decided_by = %s, decided_at = now()
              where id <> %s and decision is null and (missing_id in (%s, %s) or found_id in (%s, %s))""",
           officer, match_id, m["missing_id"], m["found_id"], m["missing_id"], m["found_id"])
    note = note or "Reunited with family at the security desk."
    db.log(m["missing_id"], officer, f"Reunited the child with the parent (found report #{m['found_id']}) after an identity check", note)
    db.log(m["found_id"], officer, f"Handed the child to the parent from case #{m['missing_id']} after an identity check", note)
    for c in cases:
        _finish(c, officer, note)
    return None


# ---------- parent and finder status ----------

def public_status(token: str):
    """What a parent or finder may see about their own report: progress only, no details."""
    case = db.one("select id, kind, status, stage, zone, created_at, approved_at, sighted_at, closed_at, collected_at "
                  "from cases where public_token = %s", token)
    if not case:
        return None
    if case["kind"] == "found":
        step = {"review": "checking", "active": "collected" if case["collected_at"] else "dispatched",
                "closed": "reunited", "rejected": "rejected"}[case["status"]]
    elif case["status"] == "review":
        step = "checking"
    elif case["status"] == "rejected":
        step = "rejected"
    elif case["status"] == "closed":
        step = "found"
    elif case["sighted_at"]:
        step = "sighted"
    else:
        step = ["zone", "all_zones", "police"][case["stage"]]
    return {"case_id": case["id"], "kind": case["kind"], "step": step, "zone": case["zone"],
            "created_at": case["created_at"].isoformat(),
            "approved_at": case["approved_at"].isoformat() if case["approved_at"] else None,
            "closed_at": case["closed_at"].isoformat() if case["closed_at"] else None}


def get_case(case_id: int):
    return db.one("select * from cases where id = %s", case_id)


# ---------- officer decisions ----------

def approve(case_id: int, officer: str, edits: dict) -> bool:
    case = get_case(case_id)
    if not case or case["status"] != "review" or case["kind"] != "missing":
        return False
    x = dict(case["extracted"] or {})
    changed = []
    for key, value in edits.items():
        if key in ("clothing", "features"):
            value = [v.strip() for v in value.split(",") if v.strip()]
        elif key == "age_years":
            value = int(value) if str(value).strip().isdigit() else None
        else:
            value = value.strip() or None
        if value != x.get(key):
            changed.append(key)
            x[key] = value
    db.run(
        "update cases set extracted = %s, status = 'active', stage = 0, approved_at = now(), approved_by = %s where id = %s and status = 'review'",
        db.as_json(x), officer, case_id,
    )
    if changed:
        db.log(case_id, officer, "Corrected the case", ", ".join(changed))
    db.log(case_id, officer, "Approved the broadcast")
    case = get_case(case_id)
    notify.send(case, "desk", "alert", f"MISSING CHILD · Case #{case_id}",
                f"Search your zone. Last seen at **{case['zone']}**. If found, keep the child with you and report on the sighting form.")
    return True


def dispatch(case_id: int, officer: str) -> bool:
    """Found child: send staff to the finder. The child is never described on open channels."""
    case = get_case(case_id)
    if not case or case["status"] != "review" or case["kind"] != "found":
        return False
    db.run("update cases set status = 'active', approved_at = now(), approved_by = %s where id = %s and status = 'review'", officer, case_id)
    db.log(case_id, officer, "Sent staff to the finder")
    finder = (case["reporter_name"] or "").split()
    notify.send(case, "desk", "found", f"FOUND CHILD · Case #{case_id}",
                f"A child has been found and is with {'**' + finder[0] + '**' if finder else 'a member of the public'} at **{case['zone']}**. "
                "Nearest staff: go there now and bring the child to the security desk. Do not describe the child on open channels.",
                fields=[{"name": "Where", "value": case["zone"], "inline": True},
                        {"name": "Next", "value": "Bring the child to the security desk", "inline": True}])
    return True


def collect(case_id: int, who: str) -> str | None:
    """A member of staff has reached the finder and has the child. Returns an error, or None.
    Guards may report this; handing the child to a parent still needs the officer's identity check."""
    case = get_case(case_id)
    if not case or case["kind"] != "found":
        return f"Case #{case_id} is not a found child."
    if case["status"] == "review":
        return f"The officer hasn't sent staff for found child #{case_id} yet."
    if case["status"] != "active":
        return f"Found child #{case_id} is already {'closed' if case['status'] == 'closed' else case['status']}."
    if case["collected_at"]:
        return f"Staff already have found child #{case_id} ({case['collected_by']})."
    db.run("update cases set collected_at = now(), collected_by = %s where id = %s and collected_at is null", who[:80], case_id)
    db.log(case_id, who, "Has the child, the finder can go", f"at {case['zone']}")
    notify.send(case, "desk", "found", f"CHILD WITH STAFF · Found child #{case_id}",
                f"**{who}** has the found child from {case['zone']}. No one else needs to go. Bring the child to the security desk.",
                fields=[{"name": "Where", "value": case["zone"], "inline": True},
                        {"name": "Next", "value": "Security desk, then the identity check", "inline": True}])
    return None


def reject(case_id: int, officer: str, reason: str) -> bool:
    case = get_case(case_id)
    if not case or case["status"] != "review":
        return False
    db.run("update cases set status = 'rejected', closed_at = now(), closed_by = %s, close_note = %s, photo_id = null where id = %s",
           officer, reason or None, case_id)
    photos.delete(case["photo_id"])
    db.run("update matches set decision = 'dismissed', decided_by = %s, decided_at = now() where decision is null and (missing_id = %s or found_id = %s)",
           officer, case_id, case_id)
    what = "Rejected the report, nothing was broadcast" if case["kind"] == "missing" else "Rejected the found-child report"
    db.log(case_id, officer, what, reason or None)
    return True


def add_note(case_id: int, officer: str, text: str) -> bool:
    if not get_case(case_id):
        return False
    db.log(case_id, officer, "Note", text)
    return True


def route_for(case_id, score) -> str:
    """Where a sighting goes. Anything uncertain goes to a person."""
    if score is None:
        return "review"
    if case_id and score >= LIKELY:
        return "likely"
    if case_id and score >= UNSURE:
        return "review"
    return "unmatched"


def new_sighting(text: str, zone: str, reporter: str) -> dict:
    open_cases = db.all("select * from cases where status = 'active' and kind = 'missing' order by id")
    result = agents.match(text, zone, open_cases)
    score = result["score"]
    route = route_for(result["case_id"], score)
    row = db.run(
        "insert into sightings (case_id, text, zone, reporter, score, reasons, route) values (%s, %s, %s, %s, %s, %s, %s) returning id",
        result["case_id"], text, zone, reporter or None, score, db.as_json(result["reasons"]), route,
    )
    label = {"likely": "Likely match, officer alerted to confirm", "review": "Unsure, sent to the human review queue",
             "unmatched": "No match with an open case"}[route]
    detail = f"score {score:.2f}" if score is not None else "matcher unavailable"
    db.log(result["case_id"], "Sighting matcher", f"Sighting #{row['id']} at {zone}: {label}", detail)
    return {"id": row["id"], "route": route, **result}


def decide_sighting(sighting_id: int, officer: str, decision: str) -> bool:
    s = db.one("select * from sightings where id = %s", sighting_id)
    if not s or s["decision"]:
        return False
    db.run("update sightings set decision = %s, decided_by = %s, decided_at = now() where id = %s",
           decision, officer, sighting_id)
    if decision == "confirmed" and s["case_id"]:
        db.run("update cases set sighted_at = now() where id = %s", s["case_id"])
        db.log(s["case_id"], officer, f"Confirmed sighting #{sighting_id}, escalation paused")
        case = get_case(s["case_id"])
        notify.send(case, "desk", "sighting", f"CONFIRMED SIGHTING · Case #{case['id']}",
                    f"Seen at **{s['zone']}**: \"{s['text']}\"\nNearest guard: go now and stay with the child.")
    else:
        db.log(s["case_id"], officer, f"Dismissed sighting #{sighting_id}")
    return True


def close(case_id: int, officer: str, note: str) -> bool:
    case = get_case(case_id)
    if not case or case["status"] != "active":
        return False
    note = note or ("Child found and reunited." if case["kind"] == "missing" else "Child handed over.")
    db.log(case_id, officer, "Closed the case", note)
    _finish(case, officer, note)
    return True


def _finish(case: dict, officer: str, note: str):
    """Close one case: withdraw every alert, delete the photo, write the incident report."""
    db.run("""update cases set status = 'closed', closed_at = now(), closed_by = %s, close_note = %s, photo_id = null
              where id = %s and status in ('review', 'active')""", officer, note, case["id"])
    db.run("update matches set decision = 'dismissed', decided_by = %s, decided_at = now() where decision is null and (missing_id = %s or found_id = %s)",
           officer, case["id"], case["id"])
    notify.withdraw_all(case, note)
    if case.get("photo_id"):
        photos.delete(case["photo_id"])
        db.log(case["id"], "Closer", "Deleted the photo")
    _later(build_report, case["id"])


# ---------- PA announcements ----------

def pa_draft(case_id: int):
    case = get_case(case_id)
    if not case or case["status"] != "active":
        return None
    return agents.pa_draft(case)


def pa_approve(case_id: int, officer: str, text: str, force: bool) -> dict:
    case = get_case(case_id)
    if not case or case["status"] != "active":
        return {"error": "Announcements are only for approved, open cases.", "code": 409}
    text = " ".join(str(text or "").split())[:600]
    if len(text) < 20:
        return {"error": "The announcement is too short.", "code": 422}
    last = db.one("select at from events where case_id = %s and action = 'Approved a PA announcement' order by id desc limit 1", case_id)
    if last:
        wait = PA_GAP_SECONDS - (datetime.now(timezone.utc) - last["at"]).total_seconds()
        if wait > 0:
            return {"error": f"An announcement went out moments ago. Wait {int(wait) + 1} s before the next.", "code": 429}
    problems = agents.pa_problems(text, case)
    if problems and not force:
        return {"error": " ".join(problems), "code": 422, "confirm": True}
    db.log(case_id, officer, "Approved a PA announcement", text)
    if problems:
        db.log(case_id, officer, "Overrode a PA safety warning", " ".join(problems))
    return {"ok": True, "text": text}


# ---------- incident report and stats ----------

def _secs(a, b):
    return round((b - a).total_seconds()) if a and b else None


def _fmt(s):
    if s is None:
        return "-"
    m, s = divmod(int(s), 60)
    return f"{m} min {s:02d} s" if m else f"{s} s"


def build_report(case_id: int):
    c = get_case(case_id)
    if not c or c["status"] != "closed":
        return None
    sightings = db.all("select decision from sightings where case_id = %s", case_id)
    alerts = db.all("select withdrawn_at from alerts where case_id = %s and message_id is not null", case_id)
    match = db.one("select * from matches where (missing_id = %s or found_id = %s) and decision = 'confirmed'", case_id, case_id)
    if c["kind"] == "found":
        how = "Handed to the parent after a match and an identity check" if match else "Closed by the officer"
    else:
        how = ("Reunited through a found-child report" if match else
               "Found after a confirmed sighting" if c["sighted_at"] else "Closed by the officer")
    report = {
        "kind": c["kind"], "zone": c["zone"], "how": how, "match_id": match["id"] if match else None,
        "approval_seconds": _secs(c["created_at"], c["approved_at"]),
        "to_sighting_seconds": _secs(c["approved_at"], c["sighted_at"] or c.get("collected_at")),
        "total_seconds": _secs(c["created_at"], c["closed_at"]),
        "stage_reached": (["Zone", "All zones", "Police"][c["stage"]] if c["approved_at"] and c["kind"] == "missing"
                          else "Staff sent" if c["approved_at"] else "Not broadcast"),
        "sightings": len(sightings), "confirmed_sightings": sum(1 for s in sightings if s["decision"] == "confirmed"),
        "alerts_sent": len(alerts), "alerts_withdrawn": sum(1 for a in alerts if a["withdrawn_at"]),
        "approved_by": c["approved_by"], "closed_by": c["closed_by"], "photo_used": bool(c["photo_today"]),
        "summary": None, "summary_by": None,
    }
    db.run("update cases set report = %s where id = %s", db.as_json(report), case_id)
    lines = report_lines(c, report)
    summary = agents.incident_summary(lines)
    report.update(summary=summary or " ".join(lines), summary_by="AI" if summary else "template")
    db.run("update cases set report = %s where id = %s", db.as_json(report), case_id)
    return report


def report_lines(c: dict, r: dict) -> list[str]:
    """The facts of a closed case in plain sentences, worked out from the log, not by a model."""
    found = c["kind"] == "found"
    lines = [f"A member of the public reported a child found on their own at {c['zone']}." if found
             else f"A parent reported a missing child last seen at {c['zone']}."]
    if r["photo_used"]:
        lines.append("The parent attached a photo, which was deleted when the case closed.")
    if r["approval_seconds"] is not None:
        lines.append(f"The officer {'sent staff' if found else 'approved the broadcast'} {_fmt(r['approval_seconds'])} after the report.")
    else:
        lines.append("Nothing was broadcast to guards.")
    if found and r["to_sighting_seconds"] is not None:
        lines.append(f"Staff reached the child {_fmt(r['to_sighting_seconds'])} after being sent.")
    if not found and r["approval_seconds"] is not None:
        lines.append(f"The search reached this stage: {r['stage_reached']}.")
    if r["sightings"]:
        lines.append(f"Guards reported {r['sightings']} sighting(s), {r['confirmed_sightings']} confirmed by the officer.")
    lines.append(f"Outcome: {r['how']}, {_fmt(r['total_seconds'])} after the report.")
    if r["alerts_sent"]:
        lines.append(f"{r['alerts_sent']} alert(s) were sent and {r['alerts_withdrawn']} withdrawn when it closed.")
    return lines


def stats() -> dict:
    now = datetime.now(timezone.utc)
    rows = db.all("select id, kind, status, zone, created_at, approved_at, closed_at from cases where created_at > now() - interval '7 days'")
    reunions = db.all("select decided_at from matches where decision = 'confirmed' and decided_at > now() - interval '7 days'")

    def window(hours):
        since = now - timedelta(hours=hours)
        rs = [r for r in rows if r["created_at"] >= since]
        missing = [r for r in rs if r["kind"] == "missing"]
        found_times = [_secs(r["created_at"], r["closed_at"]) for r in missing if r["status"] == "closed"]
        approvals = [_secs(r["created_at"], r["approved_at"]) for r in missing if r["approved_at"]]
        zones = Counter(r["zone"] for r in missing if r["status"] != "rejected").most_common(5)
        return {
            "reports": len(missing),
            "found": len(found_times),
            "median_find_seconds": round(median(found_times)) if found_times else None,
            "median_approval_seconds": round(median(approvals)) if approvals else None,
            "rejected": sum(1 for r in rs if r["status"] == "rejected"),
            "found_child_reports": sum(1 for r in rs if r["kind"] == "found"),
            "reunions": sum(1 for m in reunions if m["decided_at"] >= since),
            "zones": [{"zone": z, "count": n} for z, n in zones],
        }

    return {"day": window(24), "week": window(24 * 7),
            "open": sum(1 for r in rows if r["status"] in ("review", "active"))}


# ---------- the Watcher ----------

def tick():
    """Widen the search, then escalate, unless a sighting was confirmed. Missing reports only."""
    now = datetime.now(timezone.utc)
    for case in db.all("select * from cases where status = 'active' and kind = 'missing' and sighted_at is null and stage < 2"):
        minutes = (now - case["approved_at"]).total_seconds() / 60
        if case["stage"] == 0 and minutes >= STEPS[0]:
            db.run("update cases set stage = 1 where id = %s and stage = 0", case["id"])
            db.log(case["id"], "Watcher", f"No confirmed sighting after {STEPS[0]:g} min: widened the alert to all zones")
            notify.send(case, "all_zones", "widen", f"MISSING CHILD · ALL ZONES · Case #{case['id']}",
                        f"Not found in {case['zone']} after {STEPS[0]:g} min. Every zone please search, and watch the exits.")
        elif case["stage"] == 1 and minutes >= STEPS[1]:
            db.run("update cases set stage = 2 where id = %s and stage = 1", case["id"])
            db.log(case["id"], "Watcher", f"Still no confirmed sighting after {STEPS[1]:g} min: escalated to police liaison")
            notify.send(case, "police", "police", f"ESCALATION · Missing child · Case #{case['id']}",
                        f"Missing for {STEPS[1]:g}+ min inside the venue. Venue search has not found the child. Requesting police support.")


def start_watcher():
    def loop():
        while True:
            try:
                tick()
            except Exception as exc:
                print("watcher error:", type(exc).__name__, exc, flush=True)
            time.sleep(10)
    threading.Thread(target=loop, daemon=True, name="watcher").start()
