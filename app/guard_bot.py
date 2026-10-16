"""Guard assistant: a tool-using agent in the guards' Discord channel.

Guards write in plain words. The agent decides which tool to call (look up cases,
read one, file a sighting) and answers briefly. It has no tool to approve, confirm
or close anything, so those decisions stay with the desk officer."""

import asyncio
import json
import threading

import discord

from app import config, db, tools
from app.llm import LLMError, groq_chat

SYSTEM = f"""You are the Talaash guard assistant in the security team's Discord channel at a busy venue.
Guards message you about lost children. Use the tools; never make up cases or details.

- If a guard describes a child they can see, call report_sighting with their own words and the zone.
  Zones: {", ".join(tools.list_zones())}. Map what they say to one of these (e.g. "near gate 3" is "Gate 3").
  If you can't tell the zone, ask for it instead of guessing.
- If they ask what to look for, call list_open_cases (pass their zone if they mention one).
- If they ask about one case, call get_case.
- You cannot approve alerts, confirm sightings or close cases. The desk officer does that. Say so if asked.
- Never share a parent's name or phone number.
- Reply in plain English, 1 to 3 short sentences. Mention case numbers like "case #4"."""

TOOLS = [
    {"type": "function", "function": {
        "name": "list_open_cases",
        "description": "Active lost-child searches. Cases last seen in the given zone come first.",
        "parameters": {"type": "object", "properties": {"zone": {"type": "string"}}},
    }},
    {"type": "function", "function": {
        "name": "get_case",
        "description": "Description, search stage and recent timeline of one case.",
        "parameters": {"type": "object", "properties": {"case_id": {"type": "integer"}}, "required": ["case_id"]},
    }},
    {"type": "function", "function": {
        "name": "report_sighting",
        "description": "File what the guard can see. The desk officer decides if it is the child.",
        "parameters": {"type": "object", "properties": {
            "description": {"type": "string", "description": "The guard's own words about the child"},
            "zone": {"type": "string", "enum": tools.list_zones()},
        }, "required": ["description", "zone"]},
    }},
]


def respond(text: str, guard: str) -> str:
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": f"{guard}: {text}"}]
    try:
        for _ in range(4):
            reply = groq_chat(messages, TOOLS)
            calls = reply.get("tool_calls") or []
            if not calls:
                return (reply.get("content") or "").strip()[:1500] or "Sorry, I didn't catch that."
            messages.append({"role": "assistant", "content": reply.get("content") or "", "tool_calls": calls})
            for call in calls:
                result = run_tool(call["function"]["name"], call["function"].get("arguments") or "{}", guard)
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, default=str)})
        return "I couldn't finish that. Please radio the desk."
    except LLMError:
        return "I'm not available right now. Please use the sighting form or radio the desk."


def run_tool(name: str, raw_args: str, guard: str):
    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError:
        return {"error": "bad arguments"}
    if name == "list_open_cases":
        return tools.list_open_cases(args.get("zone"))
    if name == "get_case":
        return tools.get_case(int(args.get("case_id", 0)))
    if name == "report_sighting":
        db.log(None, "Guard assistant", f"Filed a sighting from Discord for {guard}")
        return tools.report_sighting(args.get("description", ""), args.get("zone", ""), f"{guard} (Discord)")
    return {"error": f"unknown tool {name}"}


def start():
    if not (config.DISCORD_BOT_ENABLED and config.DISCORD_BOT_TOKEN and config.DISCORD_AGENT_CHANNEL_ID):
        return

    intents = discord.Intents.default()
    intents.message_content = True
    client = discord.Client(intents=intents)

    @client.event
    async def on_message(message: discord.Message):
        if message.author.bot or message.channel.id != config.DISCORD_AGENT_CHANNEL_ID:
            return
        text = message.content.replace(f"<@{client.user.id}>", "").strip()
        if not text:
            return
        async with message.channel.typing():
            answer = await asyncio.to_thread(respond, text, message.author.display_name)
        await message.reply(answer, mention_author=False)

    threading.Thread(target=lambda: client.run(config.DISCORD_BOT_TOKEN, log_handler=None), daemon=True, name="guard-bot").start()
