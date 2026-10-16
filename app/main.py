import hashlib
import hmac
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.routing import Route

from app import agents, config, db, desk, guard_bot, mcp_server

BASE = Path(__file__).parent
mcp_app = mcp_server.asgi_app()


@asynccontextmanager
async def lifespan(_app):
    db.init()
    desk.start_watcher()
    guard_bot.start()
    async with mcp_server.mcp.session_manager.run():
        yield


app = FastAPI(title="Talaash", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")


# ---------- desk login ----------

def _sign(name: str) -> str:
    mac = hmac.new(config.DESK_PASSWORD.encode(), name.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{name}|{mac}"


def officer(request: Request):
    token = request.cookies.get("desk", "")
    name, _, _mac = token.partition("|")
    if name and config.DESK_PASSWORD and hmac.compare_digest(_sign(name), token):
        return name
    return None


def require_officer(request: Request) -> str:
    name = officer(request)
    if not name:
        raise HTTPException(401, "Desk login required")
    return name


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request, error: str = ""):
    if officer(request):
        return RedirectResponse("/desk", status_code=303)
    return templates.TemplateResponse(request, "login.html", {"error": error})


@app.post("/login")
def login(name: str = Form(...), username: str = Form(...), password: str = Form(...)):
    ok = hmac.compare_digest(username.strip(), config.DESK_USER) and config.DESK_PASSWORD and \
        hmac.compare_digest(password, config.DESK_PASSWORD)
    if not ok:
        return RedirectResponse("/login?error=1", status_code=303)
    display = " ".join(name.split())[:40] or "Desk officer"
    response = RedirectResponse("/desk", status_code=303)
    response.set_cookie("desk", _sign(display), httponly=True, samesite="lax", max_age=60 * 60 * 24)
    return response


@app.get("/logout")
def logout():
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie("desk")
    return response


# ---------- public pages ----------

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse(request, "home.html", {})


@app.get("/report", response_class=HTMLResponse)
def report_page(request: Request):
    return templates.TemplateResponse(request, "report.html", {"zones": agents.ZONES})


@app.post("/report", response_class=HTMLResponse)
def report_submit(request: Request, description: str = Form(...), zone: str = Form(...),
                  reporter_name: str = Form(""), reporter_phone: str = Form("")):
    description = description.strip()[:2000]
    if len(description) < 15 or zone not in agents.ZONES:
        return templates.TemplateResponse(request, "report.html", {
            "zones": agents.ZONES, "error": "Please describe your child in a sentence or two and pick where you last saw them.",
            "description": description, "zone": zone,
        }, status_code=422)
    case_id, token = desk.new_case(description, zone, reporter_name.strip()[:80], reporter_phone.strip()[:30])
    return RedirectResponse(f"/status/{token}", status_code=303)


@app.get("/status/{token}", response_class=HTMLResponse)
def status_page(request: Request, token: str):
    status = desk.public_status(token)
    if not status:
        raise HTTPException(404)
    return templates.TemplateResponse(request, "status.html", {"status": status, "token": token})


@app.get("/api/status/{token}")
def status_api(token: str):
    status = desk.public_status(token)
    if not status:
        raise HTTPException(404, "Unknown report")
    return status


@app.get("/sighting", response_class=HTMLResponse)
def sighting_page(request: Request):
    return templates.TemplateResponse(request, "sighting.html", {"zones": agents.ZONES})


@app.post("/sighting", response_class=HTMLResponse)
def sighting_submit(request: Request, text: str = Form(...), zone: str = Form(...), reporter: str = Form("")):
    text = text.strip()[:600]
    if len(text) < 5 or zone not in agents.ZONES:
        return templates.TemplateResponse(request, "sighting.html", {
            "zones": agents.ZONES, "error": "Describe what you saw and pick your zone.", "text": text, "zone": zone,
        }, status_code=422)
    result = desk.new_sighting(text, zone, reporter.strip()[:60])
    return templates.TemplateResponse(request, "sighting_done.html", {"result": result, "zone": zone})


# ---------- desk ----------

@app.get("/desk", response_class=HTMLResponse)
def desk_page(request: Request):
    name = officer(request)
    if not name:
        return RedirectResponse("/login", status_code=303)
    return templates.TemplateResponse(request, "desk.html", {"officer": name, "steps": desk.STEPS, "zones": agents.ZONES})


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


@app.get("/api/desk")
def desk_state(request: Request):
    require_officer(request)
    with db.conn() as c:
        cases = c.execute("""
            select c.*, (select count(*) from alerts a where a.case_id = c.id and a.message_id is not null) as alerts_sent
            from cases c
            where c.status in ('review', 'active') or c.closed_at > now() - interval '12 hours'
            order by c.id desc limit 40""").fetchall()
        sightings = c.execute("""
            select * from sightings where created_at > now() - interval '12 hours'
            order by id desc limit 80""").fetchall()
        events = c.execute("select * from events order by id desc limit 120").fetchall()
    clean = lambda rows: [{k: _iso(v) for k, v in r.items()} for r in rows]
    return {
        "now": datetime.now(timezone.utc).isoformat(),
        "steps": desk.STEPS,
        "zones": agents.ZONES,
        "cases": clean(cases),
        "sightings": clean(sightings),
        "events": clean(events),
    }


@app.post("/api/cases/{case_id}/approve")
async def approve(case_id: int, request: Request):
    name = require_officer(request)
    body = await request.json()
    allowed = {"child_name", "age_years", "gender", "height", "clothing", "features", "special_needs"}
    edits = {k: str(v) for k, v in (body.get("edits") or {}).items() if k in allowed}
    if not desk.approve(case_id, name, edits):
        raise HTTPException(409, "This case is no longer waiting for approval")
    return {"ok": True}


@app.post("/api/cases/{case_id}/reject")
async def reject(case_id: int, request: Request):
    name = require_officer(request)
    body = await request.json()
    if not desk.reject(case_id, name, str(body.get("reason") or "")[:200]):
        raise HTTPException(409, "This case is no longer waiting for approval")
    return {"ok": True}


@app.post("/api/cases/{case_id}/close")
async def close(case_id: int, request: Request):
    name = require_officer(request)
    body = await request.json()
    if not desk.close(case_id, name, str(body.get("note") or "")[:200]):
        raise HTTPException(409, "This case is not open")
    return {"ok": True}


@app.post("/api/sightings/{sighting_id}/{decision}")
def decide(sighting_id: int, decision: str, request: Request):
    name = require_officer(request)
    if decision not in ("confirmed", "dismissed"):
        raise HTTPException(404)
    if not desk.decide_sighting(sighting_id, name, decision):
        raise HTTPException(409, "Already decided")
    return {"ok": True}


@app.exception_handler(404)
async def not_found(request: Request, exc):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": getattr(exc, "detail", "Not found")}, status_code=404)
    return templates.TemplateResponse(request, "404.html", {}, status_code=404)


# ---------- health ----------

@app.get("/healthz")
def healthz():
    checks = {
        "groq_keys": len(config.GROQ_API_KEYS),
        "gemini_keys": len(config.GEMINI_API_KEYS),
        "discord_webhooks": sum(1 for url in config.DISCORD_WEBHOOKS.values() if url),
    }
    try:
        with psycopg.connect(config.DATABASE_URL, connect_timeout=5) as conn:
            conn.execute("select 1")
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {type(exc).__name__}"
    healthy = checks["database"] == "ok"
    return JSONResponse({"ok": healthy, **checks}, status_code=200 if healthy else 503)


# MCP lives at exactly /mcp (all methods), so other unknown paths still get our 404 page.
app.router.routes.append(Route("/mcp", endpoint=mcp_app))
