"""Tools that outside agents may call: the Discord guard assistant and any MCP client.

They can look things up and file sightings. They cannot approve alerts, confirm
sightings or close cases: those stay with the human desk officer."""

from datetime import datetime, timezone

from app import agents, db, desk


def _summary(case: dict) -> dict:
    x = case["extracted"] or {}
    approved = case["approved_at"]
    return {
        "case_id": case["id"],
        "child": " · ".join(str(p) for p in [x.get("child_name"), f"{x['age_years']} years" if x.get("age_years") is not None else None, x.get("gender")] if p) or "not given",
        "wearing": x.get("clothing") or [],
        "look_for": x.get("features") or [],
        "last_seen_zone": case["zone"],
        "search_stage": "sighting confirmed" if case["sighted_at"] else ["zone search", "all zones", "police called"][case["stage"]],
        "minutes_since_alert": round((datetime.now(timezone.utc) - approved).total_seconds() / 60, 1) if approved else None,
    }


def list_zones() -> list[str]:
    return agents.ZONES


def list_open_cases(zone: str | None = None) -> list[dict]:
    """Active searches only. Reports still waiting for the officer are not shared."""
    rows = db.all("select * from cases where status = 'active' order by id desc")
    cases = [_summary(c) for c in rows]
    if zone:
        cases.sort(key=lambda c: c["last_seen_zone"] != zone)
    return cases


def get_case(case_id: int) -> dict:
    case = db.one("select * from cases where id = %s", case_id)
    if not case or case["status"] not in ("active", "closed"):
        return {"error": f"No active or closed case #{case_id}."}
    if case["status"] == "closed":
        return {"case_id": case_id, "status": "closed", "note": "The child was found. Stand down."}
    events = db.all("select actor, action, at from events where case_id = %s order by id desc limit 6", case_id)
    return {**_summary(case), "status": "active",
            "recent": [f"{e['at']:%H:%M} {e['actor']}: {e['action']}" for e in reversed(events)]}


def report_sighting(description: str, zone: str, reporter: str = "") -> dict:
    description = (description or "").strip()[:600]
    if len(description) < 5:
        return {"error": "Describe what you can see."}
    if zone not in agents.ZONES:
        return {"error": f"Unknown zone. Use one of: {', '.join(agents.ZONES)}."}
    result = desk.new_sighting(description, zone, reporter[:60])
    route = {
        "likely": "Likely match. The desk officer has been alerted and will confirm.",
        "review": "Possible match. Sent to the desk officer to decide.",
        "unmatched": "No open case matches. Logged.",
    }[result["route"]]
    return {"sighting_id": result["id"], "case_id": result["case_id"], "score": result["score"], "outcome": route}
