"""Chat routes — session management + streaming inspection assistant."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from config import get_settings
from services import inspection_sessions
from services.inspection_chat_service import iter_inspection_chat_sse
from services.inspection_pdf_html import build_inspection_pdf_html
from services.inspection_pdf_puppeteer import render_html_to_pdf_bytes
from services.landing_assistant_service import iter_landing_assistant_sse
from utils.deps import get_current_user
from utils.ratelimit import RateLimiter
from utils.uploads import ensure_supported_image, read_upload_with_limit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])

# In-process throttles (per client) on the expensive AI / PDF endpoints. These call out to vLLM and
# spawn Chromium subprocesses, so unauthenticated or unbounded access is a cost + DoS vector.
_session_rate_limit = RateLimiter(limit=30, window_seconds=60)
_ai_rate_limit = RateLimiter(limit=20, window_seconds=60)
_pdf_rate_limit = RateLimiter(limit=10, window_seconds=60)
_landing_rate_limit = RateLimiter(limit=15, window_seconds=60)


class LandingAssistantRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)


class InspectionPdfTurn(BaseModel):
    role: str
    text: str = ""
    image: str | None = None


class InspectionPdfRequest(BaseModel):
    session_id: str = ""
    transcript: list[InspectionPdfTurn] = Field(default_factory=list)


@router.post("/session", dependencies=[Depends(get_current_user), Depends(_session_rate_limit)])
async def create_session():
    sess = await inspection_sessions.create_session()
    logger.info("chat session created: %s", sess.session_id)
    return {"session_id": sess.session_id}


@router.delete("/session/{session_id}", dependencies=[Depends(get_current_user), Depends(_session_rate_limit)])
async def delete_session(session_id: str):
    deleted = await inspection_sessions.delete_session(session_id)
    if not deleted:
        return {"deleted": False, "detail": "Session not found or already deleted."}
    logger.info("chat session deleted: %s", session_id)
    return {"deleted": True}


@router.post("/message/stream", dependencies=[Depends(get_current_user), Depends(_ai_rate_limit)])
async def message_stream(
    session_id: str = Form(...),
    message: str = Form(""),
    site: str = Form(None),
    image: UploadFile | None = File(None),
):
    image_bytes: bytes | None = None
    image_mime: str | None = None

    if image and image.filename:
        max_bytes = get_settings().max_image_upload_mb * 1024 * 1024
        image_bytes = await read_upload_with_limit(image, max_bytes)
        # Trust the actual bytes, not the client Content-Type; also fixes a spoofed/mismatched mime.
        image_mime = ensure_supported_image(image_bytes)

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


@router.post("/landing/stream", dependencies=[Depends(_landing_rate_limit)])
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


@router.post("/inspection-pdf", dependencies=[Depends(get_current_user), Depends(_pdf_rate_limit)])
async def inspection_pdf_export(payload: InspectionPdfRequest):
    """Render inspection chat transcript to a PDF (HTML → Puppeteer)."""
    rows = [t.model_dump() for t in payload.transcript]
    if not rows:
        raise HTTPException(status_code=400, detail="transcript is empty")

    sid = (payload.session_id or "").strip()
    html, _img = build_inspection_pdf_html(transcript=rows, session_id=sid)

    try:
        # Chromium PDF render is a blocking subprocess (up to 120s) — run it off the event loop
        # so it doesn't freeze every other request on this single worker.
        pdf_bytes = await asyncio.to_thread(render_html_to_pdf_bytes, html)
    except RuntimeError as e:
        logger.exception("inspection_pdf: render failed")
        raise HTTPException(
            status_code=503,
            detail=str(e) or "PDF rendering is not available on this server.",
        ) from e

    slug = sid[:16] if sid else "export"
    safe_slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in slug) or "export"
    filename = f"SiteSureLabs-Inspection-{safe_slug}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
