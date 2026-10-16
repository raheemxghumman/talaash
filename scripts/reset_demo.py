"""Wipe all cases, sightings, alerts and logs so a demo starts from case #1.

Run from the project folder:  python scripts/reset_demo.py --yes
"""
import sys

sys.path.insert(0, ".")
from app import db  # noqa: E402

if "--yes" not in sys.argv:
    sys.exit("This deletes every case. Run again with --yes to confirm.")
db.pool.open(wait=True)
db.init()
db.run("truncate events, alerts, sightings, cases restart identity cascade")
print("Demo data wiped. Next case will be #1.")
db.pool.close()
