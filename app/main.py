import psycopg
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

from app import config

app = FastAPI(title="Talaash")


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


@app.get("/", response_class=HTMLResponse)
def home():
    return "<!doctype html><title>Talaash</title><h1>Talaash</h1><p>Lost-child desk. Coming online.</p>"
