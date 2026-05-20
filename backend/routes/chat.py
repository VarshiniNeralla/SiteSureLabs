"""Chat routes — session management + streaming inspection assistant."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from services import inspection_sessions
from services.inspection_chat_service import iter_inspection_chat_sse
from services.inspection_pdf_html import build_inspection_pdf_html
from services.inspection_pdf_puppeteer import render_html_to_pdf_bytes
from services.landing_assistant_service import iter_landing_assistant_sse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])


class LandingAssistantRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)


class InspectionPdfTurn(BaseModel):
    role: str
    text: str = ""
    image: str | None = None


class InspectionPdfRequest(BaseModel):
    session_id: str = ""
    transcript: list[InspectionPdfTurn] = Field(default_factory=list)


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


@router.post("/inspection-pdf")
async def inspection_pdf_export(payload: InspectionPdfRequest):
    """Render inspection chat transcript to a PDF (HTML → Puppeteer)."""
    rows = [t.model_dump() for t in payload.transcript]
    if not rows:
        raise HTTPException(status_code=400, detail="transcript is empty")

    sid = (payload.session_id or "").strip()
    html, _img = build_inspection_pdf_html(transcript=rows, session_id=sid)

    try:
        pdf_bytes = render_html_to_pdf_bytes(html)
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
