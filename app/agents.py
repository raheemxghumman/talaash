"""The three model-backed agents. Each returns plain dicts and never raises:
when the models are unavailable the result says so and a person takes over."""

import json
import re

from app.llm import GROQ_OTHER_FAMILY, LLMError, gemini_json, groq_json

ZONES = ["Main Entrance", "Food Court", "Kids Play Area", "Cinema Level", "Gate 1", "Gate 2", "Gate 3", "Parking"]

INTAKE_SYSTEM = """You turn a frightened parent's report about a lost child into a case record for venue security.
The report may be in any language or mixed languages. Write every value in English.

Return JSON with exactly these keys:
{
  "child_name": string or null,
  "age_years": integer or null,
  "gender": "boy" | "girl" | null,
  "height": string or null,
  "clothing": [strings, one item each, e.g. "red t-shirt"],
  "features": [strings: hair, glasses, marks, what they carry],
  "last_seen_place": string or null,
  "minutes_ago": integer or null,
  "special_needs": string or null,
  "language": string
}

Rules:
- Only use what the report says. If something is not stated, use null or an empty list. Never guess.
- Do not add details for a fuller description. Missing is better than invented.
- Keep each value short."""

VERIFY_PROMPT = """You are checking another AI's work before a lost-child alert is broadcast to security staff.
A wrong detail sends guards looking for the wrong child, so be strict.

PARENT'S REPORT (the only source of truth):
<<<{report}>>>

EXTRACTED CASE:
{extracted}

Check every non-empty field against the report. Report a problem when:
- a value is not supported by the report (invented),
- a value contradicts the report,
- the report contradicts itself about something important (e.g. two different ages or shirt colours),
- an important detail in the report was left out.

Return JSON:
{{
  "verdict": "ok" | "problems",
  "issues": [
    {{"field": "<field name>", "problem": "<one short sentence>", "quote": "<exact words from the report, or empty>"}}
  ]
}}
If everything is supported and consistent, return {{"verdict": "ok", "issues": []}}."""

MATCH_SYSTEM = """You compare one sighting reported by venue staff with the open lost-child cases.
Decide which case, if any, the sighting most likely describes.

Score from 0 to 1:
- 0.85+ : clothing and age clearly match, nothing contradicts
- 0.5-0.85 : partly matches, or the description is vague
- below 0.5 : weak or no match
A contradiction (different shirt colour, clearly different age, different gender) should pull the score down a lot.

Return JSON: {"case_id": integer or null, "score": number, "reasons": [short strings, at most 3]}"""


def intake(report: str, zone: str) -> dict:
    try:
        data, model = groq_json(INTAKE_SYSTEM, f"Last seen zone selected on the form: {zone}\n\nReport:\n{report}")
    except LLMError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "model": model, "case": clean_case(data)}


def clean_case(data: dict) -> dict:
    def text(v):
        return str(v).strip()[:120] if v not in (None, "", []) else None

    def items(v):
        if isinstance(v, str):
            v = [v]
        return [str(x).strip()[:80] for x in (v or []) if str(x).strip()][:6]

    def number(v, lo, hi):
        try:
            n = int(v)
        except (TypeError, ValueError):
            return None
        return n if lo <= n <= hi else None

    gender = (data.get("gender") or "").lower()
    return {
        "child_name": text(data.get("child_name")),
        "age_years": number(data.get("age_years"), 0, 17),
        "gender": gender if gender in ("boy", "girl") else None,
        "height": text(data.get("height")),
        "clothing": items(data.get("clothing")),
        "features": items(data.get("features")),
        "last_seen_place": text(data.get("last_seen_place")),
        "minutes_ago": number(data.get("minutes_ago"), 0, 24 * 60),
        "special_needs": text(data.get("special_needs")),
        "language": text(data.get("language")) or "unknown",
    }


def code_checks(report: str, case: dict) -> list[dict]:
    """Checks that don't need a model."""
    issues = []
    ages = {int(n) for n in re.findall(r"\b(\d{1,2})\s*(?:years?|yrs?|y/o|saal|sal)\b", report, re.I)}
    if len(ages) > 1:
        issues.append({"field": "age_years", "problem": f"The report mentions more than one age: {', '.join(map(str, sorted(ages)))}.", "quote": ""})
    if case.get("age_years") is not None and ages and case["age_years"] not in ages:
        issues.append({"field": "age_years", "problem": "The extracted age is not one the report mentions.", "quote": ""})
    if not case.get("clothing"):
        issues.append({"field": "clothing", "problem": "No clothing in the case. Guards need it to search.", "quote": ""})
    return issues


def verify(report: str, case: dict) -> dict:
    prompt = VERIFY_PROMPT.format(report=report, extracted=json.dumps(case, indent=2))
    checker = "code only"
    issues = []
    try:
        data, checker = gemini_json(prompt)
    except LLMError:
        try:
            data, checker = groq_json("Return JSON only.", prompt, models=GROQ_OTHER_FAMILY)
        except LLMError as exc:
            data = None
            issues.append({"field": "-", "problem": f"The checking model was unavailable ({exc}). Check the details by hand.", "quote": ""})
    if data:
        for item in data.get("issues") or []:
            if isinstance(item, dict) and item.get("problem"):
                issues.append({
                    "field": str(item.get("field") or "-")[:40],
                    "problem": str(item["problem"])[:200],
                    "quote": str(item.get("quote") or "")[:160],
                })
    seen = {(i["field"], i["problem"]) for i in issues}
    issues += [i for i in code_checks(report, case) if (i["field"], i["problem"]) not in seen]
    return {"ok": not issues, "checker": checker, "issues": issues}


def match(sighting: str, zone: str, cases: list[dict]) -> dict:
    if not cases:
        return {"case_id": None, "score": 0.0, "reasons": ["No open cases."], "model": None}
    listing = [
        {
            "case_id": c["id"],
            "age_years": c["extracted"].get("age_years"),
            "gender": c["extracted"].get("gender"),
            "clothing": c["extracted"].get("clothing"),
            "features": c["extracted"].get("features"),
            "last_seen_zone": c["zone"],
        }
        for c in cases
    ]
    user = f"SIGHTING (zone: {zone}):\n{sighting}\n\nOPEN CASES:\n{json.dumps(listing, indent=2)}"
    try:
        data, model = groq_json(MATCH_SYSTEM, user)
    except LLMError as exc:
        return {"case_id": None, "score": None, "reasons": [f"Matcher unavailable: {exc}"], "model": None}
    ids = {c["id"] for c in cases}
    case_id = data.get("case_id") if data.get("case_id") in ids else None
    try:
        score = max(0.0, min(1.0, float(data.get("score") or 0)))
    except (TypeError, ValueError):
        score = 0.0
    reasons = [str(r)[:120] for r in (data.get("reasons") or [])][:3]
    return {"case_id": case_id, "score": score if case_id else min(score, 0.3), "reasons": reasons, "model": model}
