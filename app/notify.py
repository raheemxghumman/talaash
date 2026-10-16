"""Discord alerts. Every message is sent with ?wait=true so we keep its id,
which lets the Closer edit it later and remove the child's details."""

import time

import httpx

from app import config, db

COLORS = {"alert": 0xC0392B, "widen": 0xD35400, "police": 0x7B241C, "sighting": 0x1F6F8B, "resolved": 0x2E7D32}
CHANNEL_LABEL = {"desk": "Zone security", "all_zones": "All zones", "police": "Police liaison"}


def describe(case: dict) -> list[dict]:
    x = case["extracted"] or {}
    who = " · ".join(p for p in [
        x.get("child_name"),
        f"{x['age_years']} years" if x.get("age_years") is not None else None,
        x.get("gender"),
        x.get("height"),
    ] if p) or "Not given"
    fields = [
        {"name": "Child", "value": who, "inline": False},
        {"name": "Wearing", "value": ", ".join(x.get("clothing") or []) or "Not given", "inline": False},
    ]
    if x.get("features"):
        fields.append({"name": "Look for", "value": ", ".join(x["features"]), "inline": False})
    fields.append({"name": "Last seen", "value": f"{case['zone']}" + (f" ({x['last_seen_place']})" if x.get("last_seen_place") else ""), "inline": True})
    if x.get("special_needs"):
        fields.append({"name": "Needs", "value": x["special_needs"], "inline": True})
    return fields


def _post(channel: str, payload: dict):
    url = config.DISCORD_WEBHOOKS.get(channel)
    if not url:
        return None, "webhook not configured"
    error = "rate limited"
    for attempt in range(3):
        try:
            r = httpx.post(url, params={"wait": "true"}, json=payload, timeout=10)
            if r.status_code == 429:
                time.sleep(float(r.json().get("retry_after", 1)))
                continue
            r.raise_for_status()
            return r.json()["id"], None
        except httpx.HTTPError as exc:
            error = f"{type(exc).__name__}"
            time.sleep(0.5 * (attempt + 1))
    return None, error


def send(case: dict, channel: str, kind: str, title: str, note: str, fields=None) -> bool:
    payload = {
        "username": "Talaash",
        "embeds": [{
            "title": title,
            "description": note,
            "color": COLORS.get(kind, COLORS["alert"]),
            "fields": fields if fields is not None else describe(case),
            "footer": {"text": f"Case #{case['id']} · Talaash · approved by the desk officer"},
        }],
    }
    message_id, error = _post(channel, payload)
    db.run(
        "insert into alerts (case_id, channel, message_id, kind, error) values (%s, %s, %s, %s, %s)",
        case["id"], channel, message_id, kind, error,
    )
    db.log(case["id"], "Discord", f"{'Sent' if message_id else 'Failed to send'} {kind} to {CHANNEL_LABEL.get(channel, channel)}", error)
    return message_id is not None


def withdraw_all(case: dict, note: str) -> int:
    """Edit every alert for this case so no child details stay in the channels."""
    edited = 0
    for alert in db.all("select * from alerts where case_id = %s and message_id is not null and withdrawn_at is null", case["id"]):
        url = config.DISCORD_WEBHOOKS.get(alert["channel"])
        if not url:
            continue
        payload = {"embeds": [{
            "title": f"RESOLVED · Case #{case['id']}",
            "description": f"{note}\nDetails removed. Stand down.",
            "color": COLORS["resolved"],
            "footer": {"text": "Talaash"},
        }]}
        try:
            httpx.patch(f"{url}/messages/{alert['message_id']}", json=payload, timeout=10).raise_for_status()
            db.run("update alerts set withdrawn_at = now() where id = %s", alert["id"])
            edited += 1
        except httpx.HTTPError as exc:
            db.log(case["id"], "Discord", "Could not withdraw an alert", type(exc).__name__)
    db.log(case["id"], "Closer", f"Withdrew {edited} alert(s) and removed the child's details")
    return edited
