import hashlib
import hmac
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool
from starlette.routing import Route

from app import abuse, config, db, desk, guard_bot, mcp_server, photos, venue
from app.llm import LLMError, transcribe

BASE = Path(__file__).parent
mcp_app = mcp_server.asgi_app()


@asynccontextmanager
async def lifespan(_app):
    db.init()
    venue.init()
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
    return templates.TemplateResponse(request, "report.html", {"zones": venue.names()})


BUSY = "Too many reports from this connection just now. Please go to the nearest staff member or the security desk."


async def _read_photo(photo: UploadFile | None):
    """(cleaned jpeg, None) or (None, reason). A bad photo never blocks the report."""
    if not photo or not photo.filename:
        return None, None
    raw = await photo.read(photos.MAX_BYTES + 1)
    try:
        return photos.clean(raw), None
    except photos.PhotoError as exc:
        return None, str(exc)


@app.post("/report", response_class=HTMLResponse)
async def report_submit(request: Request):
    # Parsed by hand so the form works both as a plain post and as an upload with a photo.
    f = await request.form()
    field = lambda k: str(f.get(k) or "") if not hasattr(f.get(k), "read") else ""
    description, zone = field("description").strip()[:2000], field("zone")
    reporter_name, reporter_phone, website, photo_today = field("reporter_name"), field("reporter_phone"), field("website"), field("photo_today")
    photo = f.get("photo") if hasattr(f.get("photo"), "read") else None
    form = {"zones": venue.names(), "description": description, "zone": zone,
            "reporter_name": reporter_name, "reporter_phone": reporter_phone}
    if len(description) < 15 or zone not in venue.names():
        return templates.TemplateResponse(request, "report.html", {
            **form, "error": "Please describe your child in a sentence or two and pick where you last saw them."}, status_code=422)
    key = abuse.client_key(request)
    if abuse.check("report", key) == "block":
        return templates.TemplateResponse(request, "report.html", {**form, "error": BUSY}, status_code=429)
    image, photo_problem = await _read_photo(photo)
    case_id, token = await run_in_threadpool(
        lambda: desk.new_case(description, zone, reporter_name.strip()[:80], reporter_phone.strip()[:30],
                              photo=image, photo_today=photo_today if photo_today in ("yes", "no", "unsure") else "unsure",
                              ip_key=key, flags=("bot",) if website.strip() else ()))
    if photo_problem:
        db.log(case_id, "Desk", "The photo could not be used", photo_problem)
    return RedirectResponse(f"/status/{token}", status_code=303)


@app.get("/found", response_class=HTMLResponse)
def found_page(request: Request):
    return templates.TemplateResponse(request, "found.html", {"zones": venue.names()})


@app.post("/found", response_class=HTMLResponse)
async def found_submit(request: Request, description: str = Form(...), zone: str = Form(...),
                       reporter_name: str = Form(""), reporter_phone: str = Form(""), website: str = Form("")):
    description = description.strip()[:1500]
    form = {"zones": venue.names(), "description": description, "zone": zone,
            "reporter_name": reporter_name, "reporter_phone": reporter_phone}
    if len(description) < 10 or zone not in venue.names():
        return templates.TemplateResponse(request, "found.html", {
            **form, "error": "Please describe the child and pick where you are now."}, status_code=422)
    key = abuse.client_key(request)
    if abuse.check("found", key) == "block":
        return templates.TemplateResponse(request, "found.html", {**form, "error": BUSY}, status_code=429)
    case_id, token = await run_in_threadpool(
        lambda: desk.new_case(description, zone, reporter_name.strip()[:80], reporter_phone.strip()[:30],
                              kind="found", ip_key=key, flags=("bot",) if website.strip() else ()))
    return RedirectResponse(f"/status/{token}", status_code=303)


PHANTOMS = {"thank you", "thank you.", "thanks for watching", "thanks for watching.", "thank you for watching",
            "thank you for watching.", "you", "bye", "bye.", "music", "[music]", "subscribe", ".", "okay.", "ok."}


@app.post("/api/transcribe")
async def transcribe_audio(request: Request, audio: UploadFile = File(...)):
    if abuse.check("voice", abuse.client_key(request)) == "block":
        raise HTTPException(429, "Voice is busy for this connection. Please type instead.")
    data = await audio.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(413, "That recording is too long. Keep it under a minute.")
    if len(data) < 2000:
        raise HTTPException(422, "I didn't catch that. Try again, or type it.")
    mime = (audio.content_type or "audio/webm").split(";")[0]
    ext = {"audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav",
           "audio/x-m4a": "m4a", "audio/aac": "m4a"}.get(mime, "webm")
    try:
        text = await run_in_threadpool(transcribe, data, f"voice.{ext}", mime)
    except LLMError as exc:
        if str(exc).startswith("The recording"):
            raise HTTPException(422, "That recording couldn't be read. Try again, or type it.")
        raise HTTPException(503, "Voice isn't available right now. Please type instead.")
    clean = " ".join(text.split())
    if len(clean) < 3 or clean.lower().strip(" !") in PHANTOMS:
        raise HTTPException(422, "I didn't catch that. Try again, or type it.")
    return {"text": clean[:1500]}


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
    return templates.TemplateResponse(request, "sighting.html", {"zones": venue.names()})


@app.post("/sighting", response_class=HTMLResponse)
def sighting_submit(request: Request, text: str = Form(...), zone: str = Form(...), reporter: str = Form("")):
    text = text.strip()[:600]
    if len(text) < 5 or zone not in venue.names():
        return templates.TemplateResponse(request, "sighting.html", {
            "zones": venue.names(), "error": "Describe what you saw and pick your zone.", "text": text, "zone": zone,
        }, status_code=422)
    if abuse.check("sighting", abuse.client_key(request)) == "block":
        return templates.TemplateResponse(request, "sighting.html", {
            "zones": venue.names(), "error": "Too many sightings from this connection. Please radio the desk.", "text": text, "zone": zone,
        }, status_code=429)
    result = desk.new_sighting(text, zone, reporter.strip()[:60])
    return templates.TemplateResponse(request, "sighting_done.html", {"result": result, "zone": zone})


# ---------- desk ----------

@app.get("/desk", response_class=HTMLResponse)
def desk_page(request: Request):
    name = officer(request)
    if not name:
        return RedirectResponse("/login", status_code=303)
    return templates.TemplateResponse(request, "desk.html", {"officer": name, "steps": desk.STEPS})


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


@app.get("/api/desk")
def desk_state(request: Request):
    require_officer(request)
    with db.conn() as c:
        cases = c.execute("""
            select c.*, (select count(*) from alerts a where a.case_id = c.id and a.message_id is not null) as alerts_sent,
                   (select p.analysis from photos p where p.id = c.photo_id) as photo_analysis
            from cases c
            where c.status in ('review', 'active') or c.closed_at > now() - interval '12 hours'
            order by c.id desc limit 40""").fetchall()
        sightings = c.execute("""
            select * from sightings where created_at > now() - interval '12 hours'
            order by id desc limit 80""").fetchall()
        events = c.execute("select * from events order by id desc limit 160").fetchall()
        matches = c.execute("""select * from matches where created_at > now() - interval '12 hours' or decision is null
                               order by id desc limit 40""").fetchall()
    clean = lambda rows: [{k: _iso(v) for k, v in r.items() if k not in ("ip_key", "public_token")} for r in rows]
    return {
        "now": datetime.now(timezone.utc).isoformat(),
        "steps": desk.STEPS,
        "zones": venue.zones(),
        "kinds": list(venue.KINDS),
        "cases": clean(cases),
        "sightings": clean(sightings),
        "events": clean(events),
        "matches": clean(matches),
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


@app.post("/api/cases/{case_id}/dispatch")
def dispatch(case_id: int, request: Request):
    name = require_officer(request)
    if not desk.dispatch(case_id, name):
        raise HTTPException(409, "This found-child report is no longer waiting")
    return {"ok": True}


@app.post("/api/cases/{case_id}/collect")
def collect(case_id: int, request: Request):
    name = require_officer(request)
    error = desk.collect(case_id, name)
    if error:
        raise HTTPException(409, error)
    return {"ok": True}


@app.post("/api/cases/{case_id}/notes")
async def add_note(case_id: int, request: Request):
    name = require_officer(request)
    body = await request.json()
    text = " ".join(str(body.get("text") or "").split())[:500]
    if not text:
        raise HTTPException(422, "Write something first")
    if not desk.add_note(case_id, name, text):
        raise HTTPException(404, "No such case")
    return {"ok": True}


@app.post("/api/cases/{case_id}/pa/draft")
async def pa_draft(case_id: int, request: Request):
    require_officer(request)
    draft = await run_in_threadpool(desk.pa_draft, case_id)
    if not draft:
        raise HTTPException(409, "Announcements are only for approved, open cases")
    return draft


@app.post("/api/cases/{case_id}/pa/approve")
async def pa_approve(case_id: int, request: Request):
    name = require_officer(request)
    body = await request.json()
    out = desk.pa_approve(case_id, name, body.get("text"), bool(body.get("force")))
    if "error" in out:
        return JSONResponse({"detail": out["error"], "confirm": out.get("confirm", False)}, status_code=out["code"])
    return out


@app.post("/api/matches/link")
async def match_link(request: Request):
    name = require_officer(request)
    body = await request.json()
    try:
        mid = desk.link(int(body.get("missing_id")), int(body.get("found_id")), name)
    except (TypeError, ValueError):
        mid = None
    if not mid:
        raise HTTPException(409, "Both cases must be open: one missing report and one found child")
    return {"ok": True, "id": mid}


@app.post("/api/matches/{match_id}/reunite")
async def match_reunite(match_id: int, request: Request):
    name = require_officer(request)
    body = await request.json()
    error = desk.reunite(match_id, name, str(body.get("note") or "")[:200], body.get("identity_checked") is True)
    if error:
        raise HTTPException(409, error)
    return {"ok": True}


@app.post("/api/matches/{match_id}/dismiss")
def match_dismiss(match_id: int, request: Request):
    name = require_officer(request)
    if not desk.dismiss_match(match_id, name):
        raise HTTPException(409, "Already decided")
    return {"ok": True}


@app.get("/api/photos/{photo_id}")
def photo(photo_id: int, request: Request):
    require_officer(request)
    row = photos.get(photo_id)
    if not row:
        raise HTTPException(404, "Photo deleted")
    return Response(bytes(row["data"]), media_type=row["mime"], headers={"Cache-Control": "private, no-store"})


@app.get("/api/stats")
def stats(request: Request):
    require_officer(request)
    return desk.stats()


# ---------- venue zones ----------

def _venue_call(fn, *args):
    try:
        return fn(*args)
    except venue.VenueError as exc:
        raise HTTPException(422, str(exc))


@app.post("/api/zones")
async def zone_add(request: Request):
    name = require_officer(request)
    body = await request.json()
    zone = _venue_call(venue.add, body.get("name"), body.get("kind") or "area", body.get("w") or 2.4, body.get("d") or 2)
    db.log(None, name, f"Added {zone['name']} to the venue map")
    return zone


@app.patch("/api/zones/{zone_id}")
async def zone_edit(zone_id: int, request: Request):
    name = require_officer(request)
    body = await request.json()
    old, new = _venue_call(venue.update, zone_id, body)
    if old["name"] != new["name"]:
        db.log(None, name, f"Renamed zone {old['name']} to {new['name']}")
    elif old["kind"] != new["kind"] or old["w"] != new["w"] or old["d"] != new["d"]:
        db.log(None, name, f"Changed zone {new['name']}")
    return new


@app.delete("/api/zones/{zone_id}")
def zone_remove(zone_id: int, request: Request):
    name = require_officer(request)
    row = _venue_call(venue.remove, zone_id)
    db.log(None, name, f"Removed {row['name']} from the venue map")
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
