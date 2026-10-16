# Talaash

A lost-child desk for crowded venues: malls, airports, stadiums, festivals.

AI agents turn a parent's report into a case, check it, draft the alert, match incoming sightings and run the escalation clock. A human desk officer approves every broadcast, confirms uncertain matches and closes the case.

Built for Agentika 2.0 at NaSCon'26. Theme: Human + AI, Better Together.

## Run locally

```
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
cp .env.example .env   # then fill it in
.venv/Scripts/python -m uvicorn app.main:app --reload
```

## Deploy

Deployed on Alternate Clouds from this repo. Container port `8000`. Set the variables from `.env.example` on the service, then Rebuild and Deploy.
