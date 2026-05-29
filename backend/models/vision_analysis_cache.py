import os
from datetime import datetime, timezone

from beanie import Document, Indexed
from pydantic import Field
from pymongo import ASCENDING, IndexModel


def _ttl_seconds() -> int:
    try:
        days = int(os.getenv("VISION_CACHE_TTL_DAYS", "90"))
    except ValueError:
        days = 90
    return max(1, days) * 24 * 3600


class VisionAnalysisCache(Document):
    """Deterministic reuse of vision LLM outputs for identical image + prompt inputs."""

    cache_key: Indexed(str, unique=True)
    kind: str
    model: str
    prompt_version: str
    response_markdown: str = ""
    observation: str = ""
    recommendation: str = ""
    severity: str = ""
    defect: str = ""
    construction_relevant: bool | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_used_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "vision_analysis_cache"
        # TTL: entries expire VISION_CACHE_TTL_DAYS after last_used_at (refreshed on every cache hit),
        # so the collection self-evicts cold entries and cannot grow without bound.
        indexes = [
            IndexModel([("last_used_at", ASCENDING)], expireAfterSeconds=_ttl_seconds()),
        ]
