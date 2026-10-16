"""Guard assistant: a tool-using agent in the guards' Discord channel.

Guards write in plain words. The agent decides which tool to call (look up cases,
read one, file a sighting, check what happened to their sightings) and answers
briefly. It remembers the last few messages from each guard, so "near gate 3"
can follow "I see a boy in a red shirt". It has no tool to approve, confirm or
close anything, so those decisions stay with the desk officer."""

import asyncio
import json
import threading
import time

import discord

from app import config, db, tools
from app.llm import LLMError, groq_chat

MEMORY_SECONDS = 10 * 60
MEMORY_MESSAGES = 8

HELP = """Here's what I can do:
- "What are we looking for?" or "Any kids missing near Gate 2?" - open searches, nearest first
- "Tell me about case 3" - description, search stage and latest updates
- "I can see a small girl in a pink dress crying by the cinema" - I file it as a sighting for the desk
- "I've got a lost boy with me at Gate 2" - I tell the desk you're holding a found child
- "Did the desk check my sighting?" - what happened to the sightings you filed
- "Which zones are there?"
I can't approve alerts, confirm sightings or close cases. The desk officer does that."""


def system_prompt(guard: str) -> str:
    return f"""You are the Talaash guard assistant in the security team's Discord channel at a busy venue.
You are talking to the guard "{guard}". Guards message you about lost children. Use the tools; never make up cases or details.

- If a guard describes a child they can see, call report_sighting. Put what they saw about the child
  (age, clothes, hair, what the child is doing) in description, in their own words. Never put the guard's name there.
  Zones: {", ".join(tools.list_zones())}. Map what they say to one of these (e.g. "near gate 3" is "Gate 3").
  If you can't tell the zone, ask for it instead of guessing. Once they answer, file the sighting using the
  description from their earlier message.
- If the guard says a lost child is WITH them now (they are holding or standing with the child), call
  report_found_child instead of report_sighting, with the description and zone. Tell them to stay with the child and
  that the desk officer has it and will send staff. Never say staff are already on the way.
- If they ask what to look for, call list_open_cases (pass their zone if they mention one).
- If they ask about one case, call get_case.
- If they ask what happened to their sighting, call my_sightings.
- If they ask which zones exist, call list_zones.
- Only if they literally say "help", or ask what you (the assistant) can do, reply with exactly this text.
  A question about children or cases, like "what are we looking for?", is NOT a help request: call list_open_cases.
{HELP}
- You cannot approve alerts, confirm sightings or close cases. The desk officer does that. Say so if asked.
- Never share a parent's name or phone number.
- Reply in plain English, 1 to 3 short sentences. Mention case numbers like "case #4"."""


def tool_specs() -> list[dict]:
    return [
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
                "description": {"type": "string", "description": "What the guard saw about the child, in their own words"},
                "zone": {"type": "string", "enum": tools.list_zones()},
            }, "required": ["description", "zone"]},
        }},
        {"type": "function", "function": {
            "name": "report_found_child",
            "description": "The guard has a lost child with them right now. The desk officer sends staff and looks for the parent.",
            "parameters": {"type": "object", "properties": {
                "description": {"type": "string", "description": "What the child looks like and anything they said, in the guard's words"},
                "zone": {"type": "string", "enum": tools.list_zones()},
            }, "required": ["description", "zone"]},
        }},
        {"type": "function", "function": {
            "name": "my_sightings",
            "description": "What the desk decided about the sightings this guard filed recently.",
            "parameters": {"type": "object", "properties": {}},
        }},
        {"type": "function", "function": {
            "name": "list_zones",
            "description": "The zones of this venue.",
            "parameters": {"type": "object", "properties": {}},
        }},
    ]


_memory: dict[int, list[tuple[float, dict]]] = {}
_memory_lock = threading.Lock()


def _history(guard_id: int) -> list[dict]:
    cutoff = time.time() - MEMORY_SECONDS
    with _memory_lock:
        kept = [(t, m) for t, m in _memory.get(guard_id, []) if t > cutoff][-MEMORY_MESSAGES:]
        _memory[guard_id] = kept
        return [m for _, m in kept]


def _remember(guard_id: int, *messages: dict):
    with _memory_lock:
        _memory.setdefault(guard_id, []).extend((time.time(), m) for m in messages)


def respond(text: str, guard: str, guard_id: int = 0) -> str:
    history = _history(guard_id)
    said = [m["content"] for m in history if m["role"] == "user"] + [text]
    messages = [{"role": "system", "content": system_prompt(guard)}, *history, {"role": "user", "content": text}]
    specs = tool_specs()
    answer = None
    try:
        for _ in range(4):
            reply = groq_chat(messages, specs)
            calls = reply.get("tool_calls") or []
            if not calls:
                answer = (reply.get("content") or "").strip()[:1500] or "Sorry, I didn't catch that."
                break
            messages.append({"role": "assistant", "content": reply.get("content") or "", "tool_calls": calls})
            for call in calls:
                result = run_tool(call["function"]["name"], call["function"].get("arguments") or "{}", guard, said)
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, default=str)})
        else:
            answer = "I couldn't finish that. Please radio the desk."
    except LLMError:
        return "I'm not available right now. Please use the sighting form or radio the desk."
    _remember(guard_id, {"role": "user", "content": text}, {"role": "assistant", "content": answer})
    return answer


def sighting_text(description: str, guard: str, said: list[str]) -> str:
    """The model sometimes passes a stub or the guard's own name. Fall back to what the guard wrote."""
    description = (description or "").strip()
    if len(description) >= 12 and description.lower() != guard.lower():
        return description
    return " ".join(s.strip() for s in said[-3:] if s.strip())


def run_tool(name: str, raw_args: str, guard: str, said: list[str] | None = None):
    try:
        args = json.loads(raw_args or "{}") or {}
    except json.JSONDecodeError:
        return {"error": "bad arguments"}
    reporter = f"{guard} (Discord)"
    if name == "list_open_cases":
        return tools.list_open_cases(args.get("zone"))
    if name == "get_case":
        try:
            return tools.get_case(int(args.get("case_id", 0)))
        except (TypeError, ValueError):
            return {"error": "Which case number?"}
    if name == "report_sighting":
        text = sighting_text(args.get("description", ""), guard, said or [])
        result = tools.report_sighting(text, args.get("zone", ""), reporter)
        if "error" not in result:
            db.log(result.get("case_id"), "Guard assistant", f"Filed sighting #{result['sighting_id']} from Discord for {guard}")
        return result
    if name == "report_found_child":
        text = sighting_text(args.get("description", ""), guard, said or [])
        result = tools.report_found_child(text, args.get("zone", ""), reporter)
        if "error" not in result:
            db.log(result["case_id"], "Guard assistant", f"Filed a found-child report from Discord for {guard}")
        return result
    if name == "my_sightings":
        return tools.sighting_status(reporter) or {"note": "You haven't filed any sightings yet."}
    if name == "list_zones":
        return tools.list_zones()
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
            answer = await asyncio.to_thread(respond, text, message.author.display_name, message.author.id)
        await message.reply(answer, mention_author=False)

    threading.Thread(target=lambda: client.run(config.DISCORD_BOT_TOKEN, log_handler=None), daemon=True, name="guard-bot").start()
