"""Cache vision analysis outputs by image bytes + prompt for deterministic repeats.

All reads/writes degrade gracefully: on any Mongo error a read behaves as a cache miss and a write
becomes a no-op, so a database blip never turns into a 500 for the user. Concurrent stores of the
same key are race-safe (the unique cache_key index is honoured via an upsert fallback).
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from pymongo.errors import DuplicateKeyError

from config import get_settings
from models import VisionAnalysisCache
from prompt import VISION_CACHE_VERSION

logger = logging.getLogger(__name__)

KIND_PMO_MARKDOWN = "pmo_markdown"
KIND_EXECUTIVE = "executive_defect"
KIND_CONSTRUCTION = "construction_relevance"


def cache_enabled() -> bool:
    import os

    return os.getenv("VISION_ANALYSIS_CACHE_ENABLED", "true").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def image_fingerprint(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


def prompt_fingerprint(prompt: str) -> str:
    return hashlib.sha256((prompt or "").encode("utf-8")).hexdigest()


def build_cache_key(*, kind: str, image_bytes: bytes, prompt: str, model: str) -> str:
    settings = get_settings()
    return ":".join(
        [
            VISION_CACHE_VERSION,
            kind,
            model or settings.vllm_model,
            image_fingerprint(image_bytes),
            prompt_fingerprint(prompt),
        ]
    )


async def _find_row(cache_key: str) -> VisionAnalysisCache | None:
    try:
        return await VisionAnalysisCache.find_one(VisionAnalysisCache.cache_key == cache_key)
    except Exception:
        logger.warning("vision cache read failed for %s", cache_key[:48], exc_info=True)
        return None


async def _touch(row: VisionAnalysisCache) -> None:
    """Best-effort refresh of last_used_at (drives the TTL); never raises."""
    try:
        row.last_used_at = datetime.now(timezone.utc)
        await row.save()
    except Exception:
        logger.warning("vision cache touch failed for %s", row.cache_key[:48], exc_info=True)


async def _upsert(cache_key: str, *, kind: str, model: str, fields: dict) -> None:
    """Create or update a cache row, tolerating a concurrent insert of the same unique key."""
    try:
        row = await VisionAnalysisCache.find_one(VisionAnalysisCache.cache_key == cache_key)
        if row:
            for k, v in fields.items():
                setattr(row, k, v)
            row.last_used_at = datetime.now(timezone.utc)
            await row.save()
            return
        try:
            await VisionAnalysisCache(
                cache_key=cache_key,
                kind=kind,
                model=model,
                prompt_version=VISION_CACHE_VERSION,
                **fields,
            ).insert()
        except DuplicateKeyError:
            # A concurrent request inserted this key first — update the existing row instead of 500.
            existing = await VisionAnalysisCache.find_one(VisionAnalysisCache.cache_key == cache_key)
            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
                existing.last_used_at = datetime.now(timezone.utc)
                await existing.save()
    except Exception:
        logger.warning("vision cache store failed for %s", cache_key[:48], exc_info=True)


async def get_pmo_markdown(cache_key: str) -> str | None:
    row = await _find_row(cache_key)
    if not row or not row.response_markdown.strip():
        return None
    await _touch(row)
    logger.info("vision cache hit: %s (pmo)", cache_key[:48])
    return row.response_markdown


async def store_pmo_markdown(*, cache_key: str, model: str, text: str) -> None:
    await _upsert(
        cache_key,
        kind=KIND_PMO_MARKDOWN,
        model=model,
        fields={"response_markdown": text},
    )


async def get_executive_fields(cache_key: str) -> tuple[str, str, str, str] | None:
    row = await _find_row(cache_key)
    if not row:
        return None
    if not row.observation.strip() and not row.recommendation.strip():
        return None
    await _touch(row)
    logger.info("vision cache hit: %s (executive)", cache_key[:48])
    return row.observation, row.recommendation, row.severity or "MEDIUM", row.defect or ""


async def store_executive_fields(
    *,
    cache_key: str,
    model: str,
    observation: str,
    recommendation: str,
    severity: str,
    defect: str = "",
) -> None:
    await _upsert(
        cache_key,
        kind=KIND_EXECUTIVE,
        model=model,
        fields={
            "observation": observation,
            "recommendation": recommendation,
            "severity": severity,
            "defect": defect,
        },
    )


async def get_construction_relevance(cache_key: str) -> bool | None:
    row = await _find_row(cache_key)
    if not row or row.construction_relevant is None:
        return None
    await _touch(row)
    logger.info("vision cache hit: %s (construction)", cache_key[:48])
    return row.construction_relevant


async def store_construction_relevance(*, cache_key: str, model: str, relevant: bool) -> None:
    await _upsert(
        cache_key,
        kind=KIND_CONSTRUCTION,
        model=model,
        fields={"construction_relevant": relevant},
    )
