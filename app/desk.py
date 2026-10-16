"""The workflow: agents propose, the desk officer decides."""

import os
import secrets
import threading
import time
from datetime import datetime, timezone

from app import agents, db, notify

LIKELY = 0.75
UNSURE = 0.45
STEPS = [float(m) for m in os.getenv("ESCALATION_MINUTES", "1,2").split(",")]


def new_case(report: str, zone: str, reporter_name: str, reporter_phone: str) -> tuple[int, str]:
    token = secrets.token_urlsafe(12)
    row = db.run(
        "insert into cases (raw_report, zone, reporter_name, reporter_phone, public_token) values (%s, %s, %s, %s, %s) returning id",
        report, zone, reporter_name or None, reporter_phone or None, token,
    )
    case_id = row["id"]
    db.log(case_id, "Parent", "Reported a missing child", f"Last seen: {zone}")

    result = agents.intake(report, zone)
    if result["ok"]:
        case = result["case"]
        db.log(case_id, "Intake agent", "Built the case record", result["model"])
        check = agents.verify(report, case)
        verdict = "No problems found" if check["ok"] else f"Flagged {len(check['issues'])} issue(s) for the officer"
        db.log(case_id, "Verifier agent", verdict, check["checker"])
    else:
        case = agents.clean_case({})
        check = {"ok": False, "checker": "none", "issues": [{
            "field": "-", "problem": "The AI was unavailable, so nothing was extracted. Fill in the details from the report.", "quote": "",
        }]}
        db.log(case_id, "Intake agent", "Unavailable, case passed to the officer as is", result["error"])

    x = case
    urgent = (x.get("age_years") is not None and x["age_years"] < 8) or bool(x.get("special_needs"))
    db.run(
        "update cases set extracted = %s, verification = %s, urgency = %s, ai_ok = %s where id = %s",
        db.as_json(case), db.as_json(check), "high" if urgent else "normal", result["ok"], case_id,
    )
    db.log(case_id, "Desk", "Waiting for officer approval before any alert goes out")
    return case_id, token


def public_status(token: str):
    """What a parent may see about their own report: progress only, no details."""
    case = db.one("select id, status, stage, zone, created_at, approved_at, sighted_at, closed_at, close_note "
                  "from cases where public_token = %s", token)
    if not case:
        return None
    if case["status"] == "review":
        step = "checking"
    elif case["status"] == "rejected":
        step = "rejected"
    elif case["status"] == "closed":
        step = "found"
    elif case["sighted_at"]:
        step = "sighted"
    else:
        step = ["zone", "all_zones", "police"][case["stage"]]
    return {"case_id": case["id"], "step": step, "zone": case["zone"],
            "created_at": case["created_at"].isoformat(),
            "approved_at": case["approved_at"].isoformat() if case["approved_at"] else None,
            "closed_at": case["closed_at"].isoformat() if case["closed_at"] else None}


def get_case(case_id: int):
    return db.one("select * from cases where id = %s", case_id)


def approve(case_id: int, officer: str, edits: dict) -> bool:
    case = get_case(case_id)
    if not case or case["status"] != "review":
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
        "update cases set extracted = %s, status = 'active', stage = 0, approved_at = now(), approved_by = %s where id = %s",
        db.as_json(x), officer, case_id,
    )
    if changed:
        db.log(case_id, officer, "Corrected the case", ", ".join(changed))
    db.log(case_id, officer, "Approved the broadcast")
    case = get_case(case_id)
    notify.send(case, "desk", "alert", f"MISSING CHILD · Case #{case_id}",
                f"Search your zone. Last seen at **{case['zone']}**. If found, keep the child with you and report on the sighting form.")
    return True


def reject(case_id: int, officer: str, reason: str) -> bool:
    case = get_case(case_id)
    if not case or case["status"] != "review":
        return False
    db.run("update cases set status = 'rejected', closed_at = now(), closed_by = %s, close_note = %s where id = %s",
           officer, reason or None, case_id)
    db.log(case_id, officer, "Rejected the report, nothing was broadcast", reason or None)
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
    open_cases = db.all("select * from cases where status = 'active' order by id")
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
    db.run("update cases set status = 'closed', closed_at = now(), closed_by = %s, close_note = %s where id = %s",
           officer, note or "Child found and reunited.", case_id)
    db.log(case_id, officer, "Closed the case", note or "Child found and reunited.")
    notify.withdraw_all(case, note or "Child found and reunited.")
    return True


def tick():
    """The Watcher: widen the search, then escalate, unless a sighting was confirmed."""
    now = datetime.now(timezone.utc)
    for case in db.all("select * from cases where status = 'active' and sighted_at is null and stage < 2"):
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
