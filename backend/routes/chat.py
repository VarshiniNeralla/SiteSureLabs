"""Chat routes — session management + streaming inspection assistant."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services import inspection_sessions
from services.inspection_chat_service import iter_inspection_chat_sse
from services.landing_assistant_service import iter_landing_assistant_sse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])


class LandingAssistantRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/session")
async def create_session():
    sess = await inspection_sessions.create_session()
    logger.info("chat session created: %s", sess.session_id)
    return {"session_id": sess.session_id}


@router.delete("/session/{session_id}")
async def delete_session(session_id: str):
    deleted = await inspection_sessions.delete_session(session_id)
    if not deleted:
        return {"deleted": False, "detail": "Session not found or already deleted."}
    logger.info("chat session deleted: %s", session_id)
    return {"deleted": True}


@router.post("/message/stream")
async def message_stream(
    session_id: str = Form(...),
    message: str = Form(""),
    site: str = Form(None),
    image: UploadFile | None = File(None),
):
    image_bytes: bytes | None = None
    image_mime: str | None = None

    if image and image.filename:
        image_bytes = await image.read()
        image_mime = image.content_type or "image/jpeg"

    return StreamingResponse(
        iter_inspection_chat_sse(
            session_id=session_id,
            message=message,
            site_json=site,
            image_bytes=image_bytes,
            image_mime=image_mime,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


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
