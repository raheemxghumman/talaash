# Talaash

**A lost-child desk for crowded venues: malls, airports, stadiums, festivals.**

AI agents turn a frightened parent's report into a case, check it, match guard sightings and run the escalation clock. A human desk officer approves every broadcast, confirms uncertain matches and closes the case.

Built in about a day for Agentika 2.0 at NaSCon'26. Theme: *Human + AI: Better Together*. SDG 16.2.

**Live:** https://talaash-live-app.alternatefutures.ai (deployed on Alternate Clouds)

## How it works

| Step | Who | What happens |
|---|---|---|
| 1 | **Intake agent** (Groq `gpt-oss-120b`) | Reads the report in any language and fills only what was said. Unknowns stay empty. |
| 2 | **Verifier agent** (Gemini, a different model family, plus code checks) | Checks every field against the parent's exact words and quotes the evidence. |
| 3 | **Desk officer** | Fixes anything flagged and approves the broadcast. Nothing reaches guards before this. |
| 4 | **Sighting matcher** (Groq) | Scores each guard sighting. 75%+ alerts the officer to confirm; 45–75% goes to a human review queue. |
| 5 | **Watcher** | Widens the alert to every zone, then escalates to police, unless a sighting is confirmed. |
| 6 | **Desk officer → Closer** | Only a person can close a case. Every Discord alert is then edited to "RESOLVED" and the child's details removed. |
| – | **Report checks** (code, no model) | Before approval the officer sees warning signs no model can know: rejected reports from the same phone, repeat reports, a likely duplicate of an open case, a sudden burst of reports. The Verifier also flags reports that read like a joke or test, or mention a custody dispute. |
| – | **Guard assistant** (tool-using agent in Discord) | Guards chat with it; it lists cases, reads a case, files a sighting and tells a guard what the desk decided about their sightings. It remembers the last few messages, so a guard can give the zone in a follow-up. It has no tool to approve or close anything. |
| – | **MCP server** at `/mcp` | Any MCP client can use the same four tools, behind a bearer token. |

The desk has a 3D venue map with open cases, sightings and the search area. From the bigger view the officer can add, move, resize, rename or remove zones; the forms, the guard assistant and the MCP server use the new zone list straight away.

**Found a child?** Anyone who finds a child alone can tell the desk at `/found`. The matcher compares found children and parents' reports in both directions; the officer reunites them only after an identity check, and found children are never described in public, so nobody can claim one by repeating a description.

**Also at the desk:** an optional parent photo (location data stripped, read for clothing only, never faces, shown to guards only after approval, deleted on close), AI-drafted PA announcements the officer approves (never with the child's name), private notes, an incident report written from the log on close, and stats. Parents can speak instead of typing (Groq Whisper); they check the text before sending.

Parents get a private live status page that updates as the search moves on, with progress only and no details.

## Reliability

- Five Groq and five Gemini keys rotate; rate-limited keys rest and the next one is used.
- Each model call has a time budget. If the models are down, the case is still created and handed to the officer for manual entry.
- Discord sends retry and are logged. Every agent decision and human action goes into an audit log.
- Public forms are rate limited per network (warning first, then a block) and carry a hidden bot trap. IP addresses are never stored, only a keyed hash.
- `pytest` runs in CI before every image build (`tests/`).

## Stack

FastAPI · Postgres (Supabase) · Groq + Gemini (free tiers) · Discord webhooks + bot · MCP Python SDK · Three.js on the landing page · Docker image built by GitHub Actions and run on Alternate Clouds.

## Run locally

```
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
cp .env.example .env   # fill it in
.venv/Scripts/python -m uvicorn app.main:app --reload
```

`python scripts/reset_demo.py --yes` wipes all cases before a demo.
