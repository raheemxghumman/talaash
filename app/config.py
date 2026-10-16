import os

from dotenv import load_dotenv

load_dotenv()


def _list(name: str) -> list[str]:
    return [v.strip() for v in os.getenv(name, "").split(",") if v.strip()]


GROQ_API_KEYS = _list("GROQ_API_KEYS")
GEMINI_API_KEYS = _list("GEMINI_API_KEYS")
GEMINI_MODELS = _list("GEMINI_MODELS") or ["gemini-3.5-flash-lite", "gemini-flash-latest"]
DATABASE_URL = os.getenv("DATABASE_URL", "")

DISCORD_WEBHOOKS = {
    "desk": os.getenv("DISCORD_WEBHOOK_DESK", ""),
    "all_zones": os.getenv("DISCORD_WEBHOOK_ALL_ZONES", ""),
    "police": os.getenv("DISCORD_WEBHOOK_POLICE", ""),
}

DESK_USER = os.getenv("DESK_USER", "desk")
DESK_PASSWORD = os.getenv("DESK_PASSWORD", "")
