"""Model calls with key rotation and fallbacks.

Every free key has a rate limit, so each provider keeps a list of keys and moves to
the next one when a key is rate limited or rejected. Callers get parsed JSON back,
or LLMError if every key and model failed.
"""

import itertools
import json
import re
import threading
import time

import httpx

from app import config

TIMEOUT = 25
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

GROQ_MAIN = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
GROQ_OTHER_FAMILY = ["qwen/qwen3.8-27b"]


class LLMError(Exception):
    pass


class KeyRing:
    def __init__(self, keys):
        self.keys = list(keys)
        self.cooldown = {}
        self.lock = threading.Lock()
        self.cycle = itertools.cycle(range(len(self.keys))) if self.keys else None

    def ordered(self):
        """All keys, starting from the next in rotation, skipping ones cooling down."""
        if not self.keys:
            return []
        with self.lock:
            start = next(self.cycle)
        now = time.time()
        order = [self.keys[(start + i) % len(self.keys)] for i in range(len(self.keys))]
        ready = [k for k in order if self.cooldown.get(k, 0) <= now]
        return ready or order

    def rest(self, key, seconds):
        self.cooldown[key] = time.time() + seconds


groq_keys = KeyRing(config.GROQ_API_KEYS)
gemini_keys = KeyRing(config.GEMINI_API_KEYS)


def parse_json(text: str):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if match:
            return json.loads(match.group(0))
        raise


def groq_json(system: str, user: str, models=None, budget=45):
    errors = []
    end = time.time() + budget
    for model in models or GROQ_MAIN:
        for key in groq_keys.ordered():
            if time.time() > end:
                raise LLMError("; ".join(errors[-4:] + ["out of time"]))
            try:
                r = httpx.post(
                    GROQ_URL,
                    headers={"Authorization": f"Bearer {key}"},
                    json={
                        "model": model,
                        "temperature": 0.1,
                        "response_format": {"type": "json_object"},
                        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                    },
                    timeout=TIMEOUT,
                )
                if r.status_code == 429:
                    groq_keys.rest(key, 30)
                    errors.append(f"{model}: rate limited")
                    continue
                if r.status_code in (401, 403):
                    groq_keys.rest(key, 3600)
                    errors.append(f"{model}: key rejected")
                    continue
                if r.status_code == 404:
                    errors.append(f"{model}: model unavailable")
                    break
                r.raise_for_status()
                return parse_json(r.json()["choices"][0]["message"]["content"]), model
            except (httpx.HTTPError, json.JSONDecodeError, KeyError) as exc:
                errors.append(f"{model}: {type(exc).__name__}")
    raise LLMError("; ".join(errors[-4:]) or "no Groq keys configured")


def gemini_json(prompt: str, budget=40):
    errors = []
    end = time.time() + budget
    for model in config.GEMINI_MODELS:
        for key in gemini_keys.ordered():
            if time.time() > end:
                raise LLMError("; ".join(errors[-4:] + ["out of time"]))
            try:
                r = httpx.post(
                    GEMINI_URL.format(model=model),
                    headers={"x-goog-api-key": key},
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
                    },
                    timeout=TIMEOUT,
                )
                if r.status_code == 429:
                    gemini_keys.rest(key, 60)
                    errors.append(f"{model}: rate limited")
                    continue
                if r.status_code == 503:
                    errors.append(f"{model}: busy")
                    continue
                if r.status_code in (401, 403):
                    gemini_keys.rest(key, 3600)
                    errors.append(f"{model}: key rejected")
                    continue
                if r.status_code == 404:
                    errors.append(f"{model}: model unavailable")
                    break
                r.raise_for_status()
                text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
                return parse_json(text), model
            except (httpx.HTTPError, json.JSONDecodeError, KeyError, IndexError) as exc:
                errors.append(f"{model}: {type(exc).__name__}")
    raise LLMError("; ".join(errors[-4:]) or "no Gemini keys configured")
