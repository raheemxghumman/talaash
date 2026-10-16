"""Parent photos: checked, cleaned, read for clothing only, and deleted when the case ends.

A photo is opened and saved again as a fresh JPEG, which drops location data and
anything hidden in the file. A small fingerprint (average hash) lets us notice the
same picture being reused in another report, even after resizing."""

import io

from PIL import Image, ImageOps, UnidentifiedImageError

from app import db
from app.llm import LLMError, gemini_vision_json

MAX_BYTES = 3 * 1024 * 1024
MAX_SIDE = 1024
REUSE_DISTANCE = 6


class PhotoError(ValueError):
    pass


def clean(raw: bytes) -> bytes:
    """A re-encoded JPEG, or PhotoError if the upload isn't a usable image."""
    if not raw:
        raise PhotoError("The photo was empty.")
    if len(raw) > MAX_BYTES:
        raise PhotoError("The photo is too large. Please choose one under 3 MB.")
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            if probe.format not in ("JPEG", "PNG", "WEBP", "MPO"):
                raise PhotoError("Please choose a JPEG, PNG or WebP photo.")
            probe.verify()
        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img)
            if img.width < 64 or img.height < 64:
                raise PhotoError("The photo is too small to be useful.")
            img = img.convert("RGB")
            img.thumbnail((MAX_SIDE, MAX_SIDE))
            out = io.BytesIO()
            img.save(out, "JPEG", quality=82, optimize=True)
            return out.getvalue()
    except PhotoError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise PhotoError("That file isn't a photo we can open.")


def fingerprint(jpeg: bytes) -> str:
    with Image.open(io.BytesIO(jpeg)) as img:
        small = img.convert("L").resize((8, 8), Image.Resampling.LANCZOS)
        px = list(small.getdata())
    avg = sum(px) / len(px)
    bits = "".join("1" if p > avg else "0" for p in px)
    return f"{int(bits, 2):016x}"


def distance(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def save(jpeg: bytes) -> dict:
    fp = fingerprint(jpeg)
    row = db.run("insert into photos (data, mime, phash) values (%s, 'image/jpeg', %s) returning id", jpeg, fp)
    return {"id": row["id"], "phash": fp}


def get(photo_id: int):
    return db.one("select id, data, mime from photos where id = %s", photo_id)


def delete(photo_id):
    if photo_id:
        db.run("delete from photos where id = %s", photo_id)


def reused_in(phash: str, case_id: int) -> list[int]:
    """Other recent reports that used (nearly) the same picture."""
    rows = db.all("""select c.id, p.phash from cases c join photos p on p.id = c.photo_id
                     where c.id <> %s and c.created_at > now() - interval '30 days'""", case_id)
    rows += db.all("""select c.id, (c.verification->>'photo_phash') as phash from cases c
                      where c.id <> %s and c.photo_id is null and c.verification ? 'photo_phash'
                      and c.created_at > now() - interval '30 days'""", case_id)
    return sorted({r["id"] for r in rows if r["phash"] and distance(r["phash"], phash) <= REUSE_DISTANCE})


PROMPT = """A parent at a busy venue has reported a missing child and attached this photo.
Help venue security, who need to recognise the child by what they are wearing.

Rules: do not describe or identify the face. Do not guess who the person is.
Describe only clothing, colours, hair, and things the child is carrying.

The parent wrote: <<<{report}>>>
The parent says the photo was taken today: {today}

Return JSON:
{{
  "people": integer (how many people are clearly visible),
  "child_visible": true/false (is there a child, roughly under 16, clearly visible),
  "real_photo": true/false (false for drawings, cartoons, memes, screenshots of text, stock-style graphics),
  "quality": "good" | "blurry" | "dark",
  "appears": "boy" | "girl" | "unclear",
  "clothing": [short strings, e.g. "red t-shirt"],
  "hair": string or null,
  "carrying": [short strings],
  "conflicts": [short sentences where the photo clearly contradicts the parent's words about clothing colour,
                clothing type or boy/girl. Empty if none or if unsure.]
}}"""


def analyse(jpeg: bytes, report: str, today: str) -> dict:
    """What the AI sees in the photo, and issues for the Verifier box."""
    try:
        data, model = gemini_vision_json(PROMPT.format(report=report[:1500], today=today or "not sure"), jpeg)
    except LLMError as exc:
        return {"ok": False, "model": None, "error": str(exc),
                "issues": [{"field": "photo", "problem": "The photo could not be checked by the AI. Compare it with the report by eye.", "quote": ""}]}

    def items(v, size=60):
        return [str(x)[:size] for x in (v if isinstance(v, list) else [v] if v else [])][:6]

    seen = {
        "people": int(data.get("people") or 0) if str(data.get("people") or "0").isdigit() else 0,
        "child_visible": bool(data.get("child_visible")),
        "real_photo": data.get("real_photo") is not False,
        "quality": data.get("quality") if data.get("quality") in ("good", "blurry", "dark") else "good",
        "appears": data.get("appears") if data.get("appears") in ("boy", "girl") else "unclear",
        "clothing": items(data.get("clothing")),
        "hair": str(data["hair"])[:60] if data.get("hair") else None,
        "carrying": items(data.get("carrying")),
        "conflicts": items(data.get("conflicts"), 160),
    }
    issues = []
    if not seen["real_photo"]:
        issues.append({"field": "photo", "problem": "This doesn't look like a real photo (drawing, cartoon or screenshot). Possible fake report.", "quote": ""})
    elif not seen["child_visible"]:
        issues.append({"field": "photo", "problem": "No child is clearly visible in the photo. Possible fake report, or the wrong photo.", "quote": ""})
    if seen["people"] > 1:
        issues.append({"field": "photo", "problem": f"The photo shows {seen['people']} people. Ask the parent which one is their child.", "quote": ""})
    if seen["quality"] != "good":
        issues.append({"field": "photo", "problem": f"The photo is {seen['quality']}, so it may not help much.", "quote": ""})
    if today == "yes":
        for c in seen["conflicts"][:2]:
            issues.append({"field": "photo", "problem": f"Photo vs words: {c}", "quote": ""})
    return {"ok": True, "model": model, "seen": seen, "issues": issues}
