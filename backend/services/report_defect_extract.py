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

    return {
        "observations": normalize_bullet_list(obs_raw, observation=True),
        "recommendations": normalize_bullet_list(rec_raw, observation=False),
        "severity": normalize_severity(obj.get("severity")),
    }


def format_bulleted_field(lines: list[str], *, empty_observation: bool = False) -> str:
    if not lines:
        if empty_observation:
            return "• No defect observed"
        return ""
    return "\n".join(f"• {ln}" for ln in lines)


def default_recommendation_lines() -> list[str]:
    return list(_DEFAULT_RECOMMENDATIONS)


def fields_from_parsed(parsed: dict[str, Any]) -> tuple[str, str, str]:
    observations = parsed.get("observations") or []
    recommendations = parsed.get("recommendations") or []
    severity = normalize_severity(parsed.get("severity"))

    if not observations:
        observation_field = format_bulleted_field([], empty_observation=True)
    else:
        observation_field = format_bulleted_field(observations)

    if not recommendations:
        recommendation_field = format_bulleted_field(default_recommendation_lines())
    else:
        recommendation_field = format_bulleted_field(recommendations)

    return observation_field, recommendation_field, severity


def invalid_image_fields() -> tuple[str, str, str]:
    return INVALID_IMAGE_OBSERVATION, "", "LOW"

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
