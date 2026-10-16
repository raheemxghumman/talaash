"""Fast checks that need no network: run with `pytest -q`."""

import pytest

from app import agents, desk, guard_bot, llm, mcp_server


def test_clean_case_drops_bad_values():
    case = agents.clean_case({"age_years": "45", "gender": "unknown", "clothing": "red shirt", "minutes_ago": -3})
    assert case["age_years"] is None
    assert case["gender"] is None
    assert case["clothing"] == ["red shirt"]
    assert case["minutes_ago"] is None


def test_code_checks_flag_two_ages_and_missing_clothing():
    report = "My son is 6 years old. He looks about 10 years old."
    issues = agents.code_checks(report, {"age_years": 6, "clothing": []})
    fields = [i["field"] for i in issues]
    assert "age_years" in fields
    assert "clothing" in fields


@pytest.mark.parametrize("case_id,score,route", [
    (1, 0.9, "likely"),
    (1, 0.75, "likely"),
    (1, 0.6, "review"),
    (1, 0.3, "unmatched"),
    (None, 0.95, "unmatched"),
    (None, None, "review"),
])
def test_uncertain_sightings_go_to_a_person(case_id, score, route):
    assert desk.route_for(case_id, score) == route


def test_intake_survives_model_outage(monkeypatch):
    def down(*a, **k):
        raise llm.LLMError("all keys rate limited")
    monkeypatch.setattr(agents, "groq_json", down)
    result = agents.intake("My daughter, 5, pink dress", "Food Court")
    assert result["ok"] is False and "rate limited" in result["error"]


def test_verifier_falls_back_and_says_so(monkeypatch):
    def down(*a, **k):
        raise llm.LLMError("busy")
    monkeypatch.setattr(agents, "gemini_json", down)
    monkeypatch.setattr(agents, "groq_json", down)
    check = agents.verify("Boy, 7, blue cap", {"age_years": 7, "clothing": ["blue cap"]})
    assert check["ok"] is False
    assert any("unavailable" in i["problem"] for i in check["issues"])


def test_parse_json_handles_code_fences():
    assert llm.parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm.parse_json('Sure: {"a": 2} done') == {"a": 2}


def test_keyring_skips_resting_keys():
    ring = llm.KeyRing(["a", "b", "c"])
    ring.rest("a", 60)
    ring.rest("b", 60)
    assert ring.ordered()[0] == "c"


def test_agents_outside_the_desk_cannot_approve_or_close():
    names = {t["function"]["name"] for t in guard_bot.TOOLS}
    assert names == {"list_open_cases", "get_case", "report_sighting"}
    mcp_tools = set(mcp_server.mcp._tool_manager._tools)
    assert not {n for n in mcp_tools if "approve" in n or "close" in n or "confirm" in n}
