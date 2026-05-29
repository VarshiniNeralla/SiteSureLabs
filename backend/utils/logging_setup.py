"""Structured logging + request-ID propagation.

Every log line carries the current request's ID (taken from an inbound ``X-Request-ID`` header or
generated), so all logs for one request can be correlated and the ID can be handed back to clients
for support. Set ``LOG_FORMAT=json`` for machine-parseable output (recommended in production); the
default is human-readable text. ``LOG_LEVEL`` overrides the level.
"""

from __future__ import annotations

import json
import logging
import os
from contextvars import ContextVar
from uuid import uuid4

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


def get_request_id() -> str:
    return request_id_var.get()


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        record.request_id = request_id_var.get()
        return True


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "request_id": getattr(record, "request_id", "-"),
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


_TEXT_FORMAT = "%(asctime)s  %(levelname)-8s  [%(request_id)s]  %(name)s  %(message)s"


def configure_logging() -> None:
    """Install a root handler with request-ID injection. Call once at startup."""
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    handler = logging.StreamHandler()
    handler.addFilter(_RequestIdFilter())
    if os.getenv("LOG_FORMAT", "").strip().lower() == "json":
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(_TEXT_FORMAT))

    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(level)


class RequestIdMiddleware:
    """Pure-ASGI middleware: bind a request ID to the context and echo it on the response.

    Implemented as raw ASGI (not BaseHTTPMiddleware) so the ContextVar set here is visible to the
    downstream handler — BaseHTTPMiddleware can run the endpoint in a different context.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        rid = ""
        for key, value in scope.get("headers") or []:
            if key == b"x-request-id":
                rid = value.decode("latin-1").strip()[:64]
                break
        if not rid:
            rid = uuid4().hex[:16]

        token = request_id_var.set(rid)
        rid_bytes = rid.encode("latin-1", "ignore")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", rid_bytes))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            request_id_var.reset(token)
