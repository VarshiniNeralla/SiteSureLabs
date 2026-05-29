"""Shared HTTP client + resilience helpers for outbound vLLM calls.

A single pooled ``httpx.AsyncClient`` is reused across requests (connection reuse instead of a fresh
client + TCP handshake per call), configured with PER-PHASE timeouts so a stuck connect fails fast
(~10s) instead of holding the full read budget (which can be minutes for token generation).

``post_json_with_retry`` adds bounded exponential backoff for transient connectivity failures, and a
lightweight circuit breaker sheds load when vLLM is unreachable so requests fail fast instead of
piling up on the event loop. Tunables are read from the environment with safe defaults.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

import httpx

from config import get_settings

logger = logging.getLogger(__name__)


class VLLMUnavailable(RuntimeError):
    """Raised when the circuit breaker is open (vLLM repeatedly unreachable)."""


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


def _build_timeout() -> httpx.Timeout:
    # read = full generation budget (existing setting); connect/write/pool fail fast.
    return httpx.Timeout(
        connect=_env_float("VLLM_CONNECT_TIMEOUT_S", 10.0),
        read=get_settings().http_timeout_s,
        write=_env_float("VLLM_WRITE_TIMEOUT_S", 60.0),
        pool=_env_float("VLLM_POOL_TIMEOUT_S", 10.0),
    )


async def get_client() -> httpx.AsyncClient:
    """Return the process-wide pooled client, creating it on first use."""
    global _client
    if _client is not None and not _client.is_closed:
        return _client
    async with _client_lock:
        if _client is None or _client.is_closed:
            limits = httpx.Limits(
                max_connections=_env_int("VLLM_MAX_CONNECTIONS", 50),
                max_keepalive_connections=_env_int("VLLM_MAX_KEEPALIVE", 20),
            )
            _client = httpx.AsyncClient(timeout=_build_timeout(), limits=limits)
    return _client


async def aclose_client() -> None:
    """Close the shared client (call on app shutdown)."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


class CircuitBreaker:
    """Open after N consecutive connectivity failures; stay open for a cooldown window."""

    def __init__(self, *, fail_threshold: int, cooldown_s: float):
        self.fail_threshold = fail_threshold
        self.cooldown_s = cooldown_s
        self._consecutive_failures = 0
        self._open_until = 0.0

    def is_open(self) -> bool:
        return bool(self._open_until) and time.monotonic() < self._open_until

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._open_until = 0.0

    def record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.fail_threshold:
            self._open_until = time.monotonic() + self.cooldown_s
            logger.warning(
                "vLLM circuit OPEN for %.0fs after %d consecutive failures",
                self.cooldown_s,
                self._consecutive_failures,
            )


vllm_breaker = CircuitBreaker(
    fail_threshold=_env_int("VLLM_CB_FAIL_THRESHOLD", 5),
    cooldown_s=_env_float("VLLM_CB_COOLDOWN_S", 30.0),
)


def ensure_circuit_closed() -> None:
    if vllm_breaker.is_open():
        raise VLLMUnavailable(
            "vLLM is temporarily unavailable (too many recent failures). Please try again shortly."
        )


async def post_json_with_retry(
    url: str,
    *,
    json: dict,
    headers: dict,
    timeout: httpx.Timeout | float | None = None,
) -> httpx.Response:
    """POST with bounded exponential backoff on transient failures + circuit breaking.

    Retries on connect/read timeouts, transport errors, and 5xx responses. Raises VLLMUnavailable
    fast when the breaker is open. The breaker records one failure per fully-failed call.
    """
    ensure_circuit_closed()
    client = await get_client()
    retries = max(0, _env_int("VLLM_MAX_RETRIES", 2))
    backoff = _env_float("VLLM_RETRY_BACKOFF_S", 0.5)

    for attempt in range(retries + 1):
        try:
            kwargs = {"json": json, "headers": headers}
            if timeout is not None:
                kwargs["timeout"] = timeout
            resp = await client.post(url, **kwargs)
            if resp.status_code >= 500 and attempt < retries:
                logger.warning(
                    "vLLM HTTP %s (attempt %d/%d) — retrying",
                    resp.status_code,
                    attempt + 1,
                    retries + 1,
                )
                await asyncio.sleep(backoff * (2**attempt))
                continue
            vllm_breaker.record_success()
            return resp
        except (httpx.TimeoutException, httpx.TransportError) as e:
            if attempt < retries:
                logger.warning(
                    "vLLM transport error (attempt %d/%d): %s — retrying",
                    attempt + 1,
                    retries + 1,
                    e,
                )
                await asyncio.sleep(backoff * (2**attempt))
                continue
            vllm_breaker.record_failure()
            raise

    # Unreachable, but keeps type-checkers happy.
    raise RuntimeError("post_json_with_retry exhausted without returning")
