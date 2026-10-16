"""Limits on the public forms, so a prankster or a bot can't flood the desk or burn
through our free model keys.

We never store an IP address. Each sender gets a keyed hash instead, which is enough
to notice "many reports from the same network" and nothing more. Venue Wi-Fi puts
many honest people behind one address, so the first limit only adds a warning sign
for the officer; the hard limit, much higher, blocks."""

import hashlib
import hmac
import threading
import time
from collections import defaultdict, deque

from app import config

# bucket: (window seconds, warn after, block after)
LIMITS = {
    "report": (600, 3, 8),
    "found": (600, 3, 8),
    "sighting": (600, 20, 40),
    "voice": (600, 8, 8),
}

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_lock = threading.Lock()
_salt = (config.DESK_PASSWORD or config.MCP_TOKEN or "talaash").encode()


def client_key(request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    return hmac.new(_salt, ip.encode(), hashlib.sha256).hexdigest()[:16]


def check(bucket: str, key: str) -> str:
    """Record one hit. Returns "ok", "warn" or "block"."""
    window, warn, block = LIMITS[bucket]
    now = time.time()
    with _lock:
        q = _hits[(bucket, key)]
        while q and q[0] < now - window:
            q.popleft()
        if len(q) >= block:
            return "block"
        q.append(now)
        return "warn" if len(q) > warn else "ok"


def reset():
    with _lock:
        _hits.clear()
