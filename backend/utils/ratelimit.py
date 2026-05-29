"""Lightweight in-process rate limiting (per-client fixed window).

Stop-gap for the current single-worker deployment. A multi-worker / horizontally-scaled setup needs
a shared store (e.g. Redis) — see PRODUCTION_AUDIT.md Phase 4. Keyed by best-effort client IP
(X-Forwarded-For aware) so a shared reverse proxy / ngrok tunnel does not throttle every user as one.
"""

from __future__ import annotations

import time
from collections import defaultdict

from fastapi import HTTPException, Request, status


def _client_key(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


class RateLimiter:
    """FastAPI dependency: allow at most ``limit`` requests per ``window_seconds`` per client."""

    def __init__(self, *, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, list[float]] = defaultdict(list)

    def _allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window
        bucket = self._hits[key]
        if bucket:
            keep_from = 0
            while keep_from < len(bucket) and bucket[keep_from] < cutoff:
                keep_from += 1
            if keep_from:
                del bucket[:keep_from]
        if len(bucket) >= self.limit:
            return False
        bucket.append(now)
        return True

    async def __call__(self, request: Request) -> None:
        if not self._allow(_client_key(request)):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests — please slow down and try again shortly.",
            )
