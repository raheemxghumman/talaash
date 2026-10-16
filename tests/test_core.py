"""Fast checks that need no network: run with `pytest -q`."""

import pytest

from app import agents, desk, guard_bot, llm, mcp_server, venue


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


def test_agents_outside_the_desk_cannot_approve_or_close(monkeypatch):
    monkeypatch.setattr(venue, "names", lambda: ["Food Court", "Gate 3"])
    names = {t["function"]["name"] for t in guard_bot.tool_specs()}
    assert names == {"list_open_cases", "get_case", "report_sighting", "my_sightings", "list_zones"}
    mcp_tools = set(mcp_server.mcp._tool_manager._tools)
    assert not {n for n in mcp_tools if "approve" in n or "close" in n or "confirm" in n}


def test_guard_sighting_falls_back_to_what_the_guard_wrote():
    said = ["I can see a small boy in a red shirt crying", "gate 3"]
    assert guard_bot.sighting_text("RaheemXD", "RaheemXD", said) == "I can see a small boy in a red shirt crying gate 3"
    assert guard_bot.sighting_text("boy, red shirt, crying", "RaheemXD", said) == "boy, red shirt, crying"


def test_new_zones_never_overlap_existing_ones():
    taken = [dict(x=x, z=z, w=w, d=d) for _, _, x, z, w, d in venue.DEFAULT]
    for _ in range(4):
        x, z = venue.free_spot(2.4, 2.0, taken)
        new = dict(x=x, z=z, w=2.4, d=2.0)
        assert not any(venue._overlaps(new, t) for t in taken)
        taken.append(new)


def test_phone_numbers_match_however_they_are_typed():
    assert desk.phone_key("0300-123 4567") == desk.phone_key("+92 300 1234567")
    assert desk.phone_key("12") == ""
