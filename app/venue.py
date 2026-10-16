"""The venue's zones, stored in Postgres so the desk can add, rename and arrange them.

Positions are floor-plan units (about 4 m each): x runs left to right, z front to
back, w and d are the footprint. Every form, the guard assistant and the MCP
server read the zone list from here."""

import math
import threading
import time

from app import db

KINDS = {
    "area": 0.6,      # shops, halls, food court
    "gate": 0.35,      # exits and gates: watched when the search widens
    "entrance": 0.45,
    "play": 0.5,
    "hall": 1.05,      # cinema, auditorium, stage
    "parking": 0.2,
}

DEFAULT = [
    ("Parking", "parking", -4.4, 2.9, 3.6, 3.4),
    ("Main Entrance", "entrance", -0.4, 3.6, 3.4, 1.9),
    ("Gate 1", "gate", 3.9, 3.6, 2.6, 1.7),
    ("Food Court", "area", 0.0, 0.3, 4.2, 3.2),
    ("Gate 2", "gate", 4.5, 0.4, 2.2, 2.6),
    ("Kids Play Area", "play", -4.3, -0.8, 3.4, 2.8),
    ("Cinema Level", "hall", 1.4, -3.4, 5.4, 2.2),
    ("Gate 3", "gate", -3.9, -3.7, 2.6, 1.6),
]

SCHEMA = """
create table if not exists zones (
    id serial primary key,
    name text not null unique,
    kind text not null default 'area',
    x real not null default 0,
    z real not null default 0,
    w real not null default 2.4,
    d real not null default 2,
    created_at timestamptz not null default now()
);
"""

_lock = threading.Lock()
_cache = {"at": 0.0, "rows": None}


class VenueError(ValueError):
    pass


def init():
    db.run(SCHEMA)
    if not db.one("select 1 as x from zones limit 1"):
        for name, kind, x, z, w, d in DEFAULT:
            db.run("insert into zones (name, kind, x, z, w, d) values (%s, %s, %s, %s, %s, %s) on conflict do nothing",
                   name, kind, x, z, w, d)
    _forget()


def _forget():
    with _lock:
        _cache["rows"] = None


def zones() -> list[dict]:
    with _lock:
        if _cache["rows"] is not None and time.time() - _cache["at"] < 30:
            return _cache["rows"]
    rows = [dict(r, h=KINDS.get(r["kind"], 0.45)) for r in db.all("select id, name, kind, x, z, w, d from zones order by id")]
    with _lock:
        _cache.update(rows=rows, at=time.time())
    return rows


def names() -> list[str]:
    return [z["name"] for z in zones()]


def _clean_name(name) -> str:
    name = " ".join(str(name or "").split())[:40]
    if len(name) < 2:
        raise VenueError("Give the zone a name.")
    return name


def _overlaps(a, b, gap=0.25) -> bool:
    return abs(a["x"] - b["x"]) * 2 < a["w"] + b["w"] + gap * 2 and abs(a["z"] - b["z"]) * 2 < a["d"] + b["d"] + gap * 2


def free_spot(w: float, d: float, taken: list[dict]) -> tuple[float, float]:
    """The free spot nearest the middle of the plan, on a half-unit grid."""
    if not taken:
        return 0.0, 0.0
    cx = sum(z["x"] for z in taken) / len(taken)
    cz = sum(z["z"] for z in taken) / len(taken)
    for radius in range(0, 60):
        ring = []
        for i in range(-radius, radius + 1):
            for j in (-radius, radius) if abs(i) != radius else range(-radius, radius + 1):
                ring.append((round(cx * 2) / 2 + i * 0.5, round(cz * 2) / 2 + j * 0.5))
        ring.sort(key=lambda p: math.hypot(p[0] - cx, p[1] - cz))
        for x, z in ring:
            if not any(_overlaps({"x": x, "z": z, "w": w, "d": d}, t) for t in taken):
                return x, z
    return cx, cz + 10


def add(name: str, kind: str = "area", w: float = 2.4, d: float = 2.0) -> dict:
    name = _clean_name(name)
    kind = kind if kind in KINDS else "area"
    w, d = _size(w), _size(d)
    if name.lower() in (n.lower() for n in names()):
        raise VenueError(f"There is already a zone called {name}.")
    x, z = free_spot(w, d, zones())
    row = db.run("insert into zones (name, kind, x, z, w, d) values (%s, %s, %s, %s, %s, %s) returning id", name, kind, x, z, w, d)
    _forget()
    return next(z for z in zones() if z["id"] == row["id"])


def _size(v) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise VenueError("Size must be a number.")
    return round(min(max(v, 1.0), 12.0) * 2) / 2


def _pos(v) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise VenueError("Position must be a number.")
    return round(min(max(v, -40.0), 40.0) * 4) / 4


def update(zone_id: int, changes: dict) -> tuple[dict, dict]:
    """Returns (old, new). Renaming also renames the zone on cases and sightings."""
    old = db.one("select * from zones where id = %s", zone_id)
    if not old:
        raise VenueError("That zone no longer exists.")
    new = {k: old[k] for k in ("name", "kind", "x", "z", "w", "d")}
    if "name" in changes:
        new["name"] = _clean_name(changes["name"])
        if new["name"].lower() != old["name"].lower() and new["name"].lower() in (n.lower() for n in names()):
            raise VenueError(f"There is already a zone called {new['name']}.")
    if changes.get("kind") in KINDS:
        new["kind"] = changes["kind"]
    for k in ("x", "z"):
        if k in changes:
            new[k] = _pos(changes[k])
    for k in ("w", "d"):
        if k in changes:
            new[k] = _size(changes[k])
    with db.conn() as c, c.transaction():
        c.execute("update zones set name = %s, kind = %s, x = %s, z = %s, w = %s, d = %s where id = %s",
                  (new["name"], new["kind"], new["x"], new["z"], new["w"], new["d"], zone_id))
        if new["name"] != old["name"]:
            c.execute("update cases set zone = %s where zone = %s", (new["name"], old["name"]))
            c.execute("update sightings set zone = %s where zone = %s", (new["name"], old["name"]))
    _forget()
    return dict(old), new


def remove(zone_id: int) -> dict:
    row = db.one("select * from zones where id = %s", zone_id)
    if not row:
        raise VenueError("That zone no longer exists.")
    if len(zones()) <= 1:
        raise VenueError("A venue needs at least one zone.")
    busy = db.one("select id from cases where zone = %s and status in ('review', 'active') limit 1", row["name"])
    if busy:
        raise VenueError(f"Case #{busy['id']} is open in {row['name']}. Close it before removing the zone.")
    db.run("delete from zones where id = %s", zone_id)
    _forget()
    return dict(row)


def match_name(text: str) -> str | None:
    """Exact zone name for loosely typed text ('gate 3', 'food court'), or None."""
    want = " ".join(str(text or "").lower().split())
    for n in names():
        if n.lower() == want:
            return n
    return None
