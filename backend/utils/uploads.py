"""Shared upload helpers.

Bounded streaming reads avoid ``UploadFile.read()``, which loads the entire (possibly huge) body
into memory before any size check can run — a memory-exhaustion vector on large/malicious uploads.
"""

from __future__ import annotations

from fastapi import HTTPException, UploadFile, status

_CHUNK_SIZE = 1024 * 1024

# Brands that appear at bytes 8:12 of an ISO-BMFF (`ftyp`) container for HEIC/HEIF/AVIF images.
_HEIF_BRANDS = (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"avif", b"avis")


def sniff_image_mime(data: bytes) -> str | None:
    """Return the image MIME inferred from magic bytes, or None if it is not a known image.

    Trusting the client-supplied Content-Type lets an attacker upload an executable labelled
    ``image/jpeg``; this inspects the actual bytes instead.
    """
    if not data or len(data) < 12:
        return None
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:2] == b"BM":
        return "image/bmp"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    if data[4:8] == b"ftyp" and data[8:12] in _HEIF_BRANDS:
        return "image/heic"
    return None


def ensure_supported_image(data: bytes) -> str:
    """Validate by magic bytes; return the detected MIME or raise 400."""
    mime = sniff_image_mime(data)
    if mime is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is not a valid image.",
        )
    return mime


async def read_upload_with_limit(
    upload: UploadFile,
    max_bytes: int,
    *,
    detail: str | None = None,
) -> bytes:
    """Read a multipart file in chunks, aborting with 413 once it exceeds ``max_bytes``.

    Bytes are accumulated only up to the limit, so an oversized upload is rejected before the whole
    payload is buffered.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=detail or f"File exceeds the {max_bytes // (1024 * 1024)} MB limit.",
            )
        chunks.append(chunk)
    return b"".join(chunks)
