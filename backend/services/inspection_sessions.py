"""In-memory inspection chat sessions (MVP; use Redis for multi-instance)."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, TypeVar

T = TypeVar("T")


@dataclass
class InspectionSession:
    session_id: str
    image_mime: str | None = None
    image_bytes: bytes | None = None
    analysis_markdown: str = ""
    structured: dict[str, Any] | None = None
    site_notes: dict[str, str] = field(default_factory=dict)
    conversation_after_analysis: list[dict[str, str]] = field(default_factory=list)


_store: dict[str, InspectionSession] = {}
_meta = asyncio.Lock()
_sid_locks: dict[str, asyncio.Lock] = {}


async def _lock_for(session_id: str) -> asyncio.Lock:
    async with _meta:
        if session_id not in _sid_locks:
            _sid_locks[session_id] = asyncio.Lock()
        return _sid_locks[session_id]


async def create_session() -> InspectionSession:
    sid = uuid.uuid4().hex
    sess = InspectionSession(session_id=sid)
    lk = await _lock_for(sid)
    async with lk:
        async with _meta:
            _store[sid] = sess
    return sess


async def get_session(session_id: str) -> InspectionSession | None:
    async with _meta:
        return _store.get(session_id)


async def delete_session(session_id: str) -> bool:
    lk = await _lock_for(session_id)
    async with lk:
        async with _meta:
            existed = session_id in _store
            _store.pop(session_id, None)
            _sid_locks.pop(session_id, None)
            return existed


class SessionNotFoundError(LookupError):
    """No inspection session exists for the given id."""


@asynccontextmanager
async def locked_session(session_id: str) -> AsyncIterator[InspectionSession]:
    """Exclusive per-session lock (same pattern as run_with_session)."""
    lk = await _lock_for(session_id)
    async with lk:
        async with _meta:
            sess = _store.get(session_id)
            if sess is None:
                raise SessionNotFoundError(session_id)
        yield sess


async def run_with_session(
    session_id: str,
    fn: Callable[[InspectionSession], Awaitable[T]],
) -> tuple[T | None, str | None]:
    lk = await _lock_for(session_id)
    async with lk:
        async with _meta:
            sess = _store.get(session_id)
            if sess is None:
                return None, "not_found"
        result = await fn(sess)
        return result, None
