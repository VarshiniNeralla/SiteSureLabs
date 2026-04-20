"""Site marketing assistant — text-only Gemma stream (no inspection session)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from config import get_settings
from prompt import LANDING_ASSISTANT_SYSTEM
from services.generate_client import stream_text_chat_completion_deltas

MAX_MESSAGES = 28  # role pairs + buffer
MAX_CONTENT_LEN = 6000


def _sse(data: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def sanitize_landing_messages(raw: list[dict[str, Any]]) -> tuple[list[dict[str, str]], str | None]:
    """
    Keep only user/assistant turns, trim length, cap count.
    Returns (messages, error_detail) — error_detail set if invalid for a reply.
    """
    out: list[dict[str, str]] = []
    for m in raw[-MAX_MESSAGES:]:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if role not in ("user", "assistant"):
            continue
        if not isinstance(content, str):
            continue
        text = content.strip()
        if not text:
            continue
        if len(text) > MAX_CONTENT_LEN:
            text = text[:MAX_CONTENT_LEN]
        out.append({"role": str(role), "content": text})

    if not out:
        return [], "Send a message to start."
    if out[-1]["role"] != "user":
        return [], "The last message must be from the user."
    return out, None


async def iter_landing_assistant_sse(
    messages: list[dict[str, Any]],
) -> AsyncIterator[bytes]:
    cleaned, err = sanitize_landing_messages(messages)
    if err:
        yield _sse({"type": "error", "detail": err})
        yield b"data: [DONE]\n\n"
        return

    full: list[dict[str, Any]] = [
        {"role": "system", "content": LANDING_ASSISTANT_SYSTEM},
        *cleaned,
    ]
    buf: list[str] = []
    try:
        async for piece in stream_text_chat_completion_deltas(
            messages=full,
            temperature=get_settings().landing_assistant_temperature,
        ):
            buf.append(piece)
            yield _sse({"type": "chunk", "text": piece})
        yield _sse({"type": "done"})
    except Exception as e:
        yield _sse({"type": "error", "detail": str(e)})
    yield b"data: [DONE]\n\n"
