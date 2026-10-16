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
| – | **Guard assistant** (tool-using agent in Discord) | Guards chat with it; it lists cases, reads a case or files a sighting. It has no tool to approve or close anything. |
| – | **MCP server** at `/mcp` | Any MCP client can use the same four tools, behind a bearer token. |

Parents get a private live status page that updates as the search moves on, with progress only and no details.

## Reliability

- Five Groq and five Gemini keys rotate; rate-limited keys rest and the next one is used.
- Each model call has a time budget. If the models are down, the case is still created and handed to the officer for manual entry.
- Discord sends retry and are logged. Every agent decision and human action goes into an audit log.
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
