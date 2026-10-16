import os
from datetime import timedelta, timezone

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

MCP_TOKEN = os.getenv("MCP_TOKEN", "")
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
DISCORD_AGENT_CHANNEL_ID = int(os.getenv("DISCORD_AGENT_CHANNEL_ID", "0").strip() or 0)
# Only the deployed service runs the bot, so a laptop copy doesn't answer twice.
DISCORD_BOT_ENABLED = os.getenv("DISCORD_BOT_ENABLED", "") == "1"

# Times shown to guards in Discord are venue time, not UTC.
VENUE_TZ = timezone(timedelta(minutes=int(os.getenv("VENUE_UTC_OFFSET_MINUTES", "300"))))
