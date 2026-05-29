"""Executive defect report: structured LLM JSON → validated bullets → export fields."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

MAX_BULLETS = 4
MAX_BULLET_CHARS = 220
MAX_SENTENCES_PER_BULLET = 1
MAX_DEFECT_LABELS = 4

# What we render when the model is not confident or has explicitly abstained.
# This is the *correct* answer for low-quality / ambiguous images — much better
# than letting the model (or our keyword fallback) hallucinate a wrong label.
UNCLEAR_DEFECT_LABEL = "Needs review"

# Phrases the model uses when it is hedging — we treat any of these as "Unclear".
# Matched case-insensitively against the *whole normalized* label.
_UNCERTAINTY_MARKER_RE = re.compile(
    r"^(?:unclear|uncertain|unknown|indeterminate|ambiguous|"
    r"not\s+(?:sure|clear|visible|identifiable|determinable)|"
    r"cannot\s+(?:determine|identify|tell|confirm)|"
    r"can(?:no|')t\s+(?:determine|identify|tell|confirm)|"
    r"no(?:t)?\s+confident|low\s+confidence|"
    r"need[s]?\s+review|to\s+be\s+confirmed|tbc|tbd|n/?a)\b",
    re.IGNORECASE,
)

INVALID_IMAGE_OBSERVATION = (
    "Invalid image detected. Please upload a relevant construction/site inspection image "
    "to proceed with analysis."
)

_DEFAULT_RECOMMENDATIONS = (
    "Verify condition on site",
    "Rectify visible defects",
    "Re-inspect after repair",
)

_NOISE_PREFIX_RE = re.compile(
    r"^(?:immediate|can[- ]?wait|verification|verify(?:\s+on\s+site)?|priority|"
    r"action|step|recommended|note)\s*[:\-–]\s*",
    re.IGNORECASE,
)

_DANGLING_END_RE = re.compile(
    r"\b(?:and|or|but|because|due|to|for|with|at|in|on|of|the|a|an|as|by|from|"
    r"into|through|during|before|after|above|below|between|among|upon|about|"
    r"against|without|within|along|across|toward|towards|via|per|than|that|which|"
    r"when|while|although|though|unless|until|since|whether|either|neither|both|"
    r"each|every|all|any|some|such|this|these|those|its|their|your|our|is|are|was|"
    r"were|be|been|being|has|have|had|will|would|should|could|may|might|must|"
    r"shall|can|do|does|did|not|no|nor|yet|so|if)\s*[,:]?\s*$",
    re.IGNORECASE,
)

_INCOMPLETE_END_RE = re.compile(r"(?:\.\.\.|…|--|—)\s*$")

_MIDWORD_TRUNC_RE = re.compile(r"[A-Za-z]{2,}-$")

_OBSERVATION_META_RE = re.compile(
    r"^(?:evidence|where|significance|check\s+on[- ]?site|photo\s*/\s*scope|"
    r"scope\s+limitation|limitations)\s*:",
    re.IGNORECASE,
)

_DEFECT_KEYWORDS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("honeycomb", "honeycombing"), "Honeycomb"),
    (("crack", "cracks", "cracking", "fissure"), "Cracks"),
    (("seepage", "leakage", "leak", "damp", "moisture", "water ingress"), "Seepage"),
    (("spalling", "spall", "delamination"), "Spalling"),
    (("corrosion", "corroded", "rust", "rusting"), "Corrosion"),
    (("exposed rebar", "exposed reinforcement", "exposed steel", "reinforcement exposed"), "Exposed rebar"),
    (("debris", "waste", "scrap", "housekeeping", "rubbish", "garbage"), "Housekeeping"),
    (("loose plastic", "plastic sheeting", "packaging"), "Housekeeping"),
    (("misalignment", "misaligned", "out of alignment"), "Misalignment"),
    (("stain", "staining", "efflorescence"), "Staining"),
    (("void", "gap", "gaps", "opening"), "Gaps"),
    (("plaster", "render"), "Plaster defect"),
    (("tile", "tiling"), "Tile defect"),
    (("paint", "painting"), "Paint defect"),
    (("waterproofing",), "Waterproofing"),
)


def _strip_bullet_prefix(line: str) -> str:
    t = str(line or "").strip()
    t = re.sub(r"^\s*\d+[\.\)]\s*", "", t)
    t = t.lstrip("•*-").strip()
    for _ in range(3):
        nxt = _NOISE_PREFIX_RE.sub("", t).strip()
        if nxt == t:
            break
        t = nxt
    return re.sub(r"\s+", " ", t).strip()


def _sentence_count(text: str) -> int:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return len([p for p in parts if p.strip()])


def is_semantically_complete_bullet(text: str) -> bool:
    """Reject incomplete, dangling, or mid-word-truncated bullets."""
    t = _strip_bullet_prefix(text)
    if not t or len(t) < 3:
        return False
    if len(t) > MAX_BULLET_CHARS:
        return False
    if _MIDWORD_TRUNC_RE.search(t):
        return False
    if _INCOMPLETE_END_RE.search(t):
        return False
    if _DANGLING_END_RE.search(t):
        return False
    if _sentence_count(t) > MAX_SENTENCES_PER_BULLET:
        return False
    # Single sentence should end cleanly or be a short label-style phrase.
    if _sentence_count(t) == 1 and t[-1] not in ".!?":
        words = t.split()
        if len(words) >= 8 and words[-1].lower() in {
            "and",
            "or",
            "with",
            "for",
            "to",
            "of",
            "in",
            "on",
            "at",
            "by",
            "from",
            "as",
            "that",
            "which",
            "when",
            "where",
            "while",
            "because",
            "due",
        }:
            return False
    return True


def normalize_bullet_list(
    items: Any,
    *,
    max_items: int = MAX_BULLETS,
    observation: bool = False,
) -> list[str]:
    if not isinstance(items, list):
        return []

    seen: set[str] = set()
    out: list[str] = []
    for raw in items:
        t = _strip_bullet_prefix(str(raw))
        if not t:
            continue
        if observation and _OBSERVATION_META_RE.match(t):
            continue
        if observation and any(
            x in t.lower() for x in ("evidence:", "where:", "significance:")
        ):
            continue
        key = t.lower()
        if key in seen:
            continue
        if not is_semantically_complete_bullet(t):
            logger.debug("report_defect_extract: rejected bullet %r", t[:80])
            continue
        seen.add(key)
        out.append(t)
        if len(out) >= max_items:
            break
    return out


def normalize_severity(raw: Any) -> str:
    """Map LLM severity to LOW | MEDIUM | HIGH."""
    t = str(raw or "").strip().upper()
    if t in ("LOW", "MEDIUM", "HIGH"):
        return t
    if t.startswith("LOW"):
        return "LOW"
    if t.startswith("HIGH") or "CRITICAL" in t or "URGENT" in t:
        return "HIGH"
    if t.startswith("MED"):
        return "MEDIUM"
    return "MEDIUM"


def normalize_confidence(raw: Any) -> str:
    """
    Map the model's self-reported defect confidence to HIGH | MEDIUM | LOW.

    Default is HIGH when the field is missing — older cached responses pre-date
    this signal and were not necessarily uncertain. Anything that mentions low /
    poor / uncertain is treated as LOW so the report degrades safely.
    """
    t = str(raw or "").strip().upper()
    if not t:
        return "HIGH"
    if t in ("LOW", "MEDIUM", "HIGH"):
        return t
    if t.startswith("HIGH"):
        return "HIGH"
    if t.startswith("MED"):
        return "MEDIUM"
    if (
        t.startswith("LOW")
        or "POOR" in t
        or "UNSURE" in t
        or "UNCLEAR" in t
        or "UNCERTAIN" in t
    ):
        return "LOW"
    return "MEDIUM"


def is_uncertain_label(label: Any) -> bool:
    """True when the defect string is one of the model's hedging phrases."""
    text = str(label or "").strip()
    if not text:
        return False
    return bool(_UNCERTAINTY_MARKER_RE.match(text))


def normalize_defect_label(raw: Any) -> str:
    """Keep the report defect field short and label-like."""
    text = str(raw or "").strip()
    if not text:
        return ""
    text = re.sub(r"^[\s•*\-\d\.\)]+", "", text)
    text = re.sub(r"\s+", " ", text).strip(" .;:-")
    if not text:
        return ""

    labels: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[,/|;&+]|\band\b", text, flags=re.IGNORECASE):
        label = part.strip(" .;:-")
        if not label:
            continue
        # If a sentence slipped through, keep the first meaningful phrase.
        label = re.split(r"[.!?]", label, maxsplit=1)[0].strip()
        words = label.split()
        if len(words) > 4:
            label = " ".join(words[:4])
        label = label[:1].upper() + label[1:]
        key = label.lower()
        if key not in seen:
            seen.add(key)
            labels.append(label)
        if len(labels) >= MAX_DEFECT_LABELS:
            break
    return ", ".join(labels)


def infer_defect_label(*values: Any) -> str:
    """Infer a short defect label from category/description/observation fallback text."""
    haystack = " ".join(str(v or "") for v in values).lower()
    labels: list[str] = []
    seen: set[str] = set()
    for keywords, label in _DEFECT_KEYWORDS:
        if any(keyword in haystack for keyword in keywords):
            key = label.lower()
            if key not in seen:
                seen.add(key)
                labels.append(label)
        if len(labels) >= MAX_DEFECT_LABELS:
            break
    if labels:
        return ", ".join(labels)

    for value in values:
        label = normalize_defect_label(value)
        if label and label.lower() not in {"others", "other", "uncategorized", "to be confirmed"}:
            return label
    return "To be confirmed"


def parse_executive_defect_json(raw: str) -> dict[str, Any] | None:
    t = (raw or "").strip()
    if not t:
        return None
    if "```" in t:
        t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.IGNORECASE)
        t = re.sub(r"\s*```\s*$", "", t)
        t = t.strip()
    start = t.find("{")
    end = t.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj: Any = json.loads(t[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None

    obs_raw = obj.get("observations")
    if obs_raw is None:
        obs_raw = obj.get("observation")
    rec_raw = obj.get("recommendations")
    if rec_raw is None:
        rec_raw = obj.get("recommendation")

    if obs_raw is None and rec_raw is None:
        return None

    raw_defect = obj.get("defect") or obj.get("defect_name") or obj.get("issue")
    raw_confidence = (
        obj.get("defect_confidence")
        or obj.get("confidence")
        or obj.get("defect_certainty")
    )
    return {
        "observations": normalize_bullet_list(obs_raw, observation=True),
        "recommendations": normalize_bullet_list(rec_raw, observation=False),
        "severity": normalize_severity(obj.get("severity")),
        "defect": normalize_defect_label(raw_defect),
        "defect_raw": str(raw_defect or "").strip(),
        "defect_confidence": normalize_confidence(raw_confidence),
    }


def format_bulleted_field(lines: list[str], *, empty_observation: bool = False) -> str:
    if not lines:
        if empty_observation:
            return "• No defect observed"
        return ""
    return "\n".join(f"• {ln}" for ln in lines)


def default_recommendation_lines() -> list[str]:
    return list(_DEFAULT_RECOMMENDATIONS)


def fields_from_parsed(parsed: dict[str, Any]) -> tuple[str, str, str, str]:
    observations = parsed.get("observations") or []
    recommendations = parsed.get("recommendations") or []
    severity = normalize_severity(parsed.get("severity"))

    # Resolve the defect label with explicit uncertainty handling.
    # Order matters here — we want to TRUST the model's "I am not sure" signal
    # rather than override it with a keyword-matched guess from observations.
    confidence = normalize_confidence(parsed.get("defect_confidence"))
    raw_label = parsed.get("defect_raw") or parsed.get("defect") or ""
    normalized = normalize_defect_label(parsed.get("defect"))

    if confidence == "LOW" or is_uncertain_label(raw_label) or is_uncertain_label(normalized):
        # The model said it can't tell, or quality is poor.
        # Honor that — do NOT fall back to keyword inference from observations.
        defect = UNCLEAR_DEFECT_LABEL
    elif normalized:
        defect = normalized
    else:
        # Model gave an empty defect but didn't explicitly say unclear.
        # Try keyword inference from observations as a last resort, but cap at
        # "Needs review" if nothing matches — never invent.
        inferred = infer_defect_label(*observations)
        defect = inferred if inferred and inferred.lower() != "to be confirmed" else UNCLEAR_DEFECT_LABEL

    if not observations:
        observation_field = format_bulleted_field([], empty_observation=True)
    else:
        observation_field = format_bulleted_field(observations)

    if not recommendations:
        recommendation_field = format_bulleted_field(default_recommendation_lines())
    else:
        recommendation_field = format_bulleted_field(recommendations)

    return observation_field, recommendation_field, severity, defect


def invalid_image_fields() -> tuple[str, str, str, str]:
    return INVALID_IMAGE_OBSERVATION, "", "LOW", "Invalid image"

def estimate_wrapped_line_count(text: str, *, chars_per_line: int = 62) -> int:
    if not text:
        return 1
    total = 0
    for raw in str(text).splitlines():
        line = raw.strip()
        if not line:
            total += 1
            continue
        total += max(1, (len(line) + chars_per_line - 1) // chars_per_line)
    return max(total, 1)
