"""Landing assistant routes (public site widget)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.landing_assistant_service import iter_landing_assistant_sse

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class LandingAssistantRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/landing/stream")
async def landing_stream(payload: LandingAssistantRequest):
    return StreamingResponse(
        iter_landing_assistant_sse(payload.messages),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

