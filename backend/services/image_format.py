"""HEIC/HEIF → JPEG when optional pillow-heif is installed (server-side fallback)."""

from __future__ import annotations

import io
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def _looks_like_heic_container(data: bytes) -> bool:
    if len(data) < 12:
        return False
    if data[4:8] != b"ftyp":
        return False
    brand = data[8:12]
    return brand in (
        b"heic",
        b"heix",
        b"hevc",
        b"hevx",
        b"mif1",
        b"msf1",
    )


def looks_like_heic(
    data: bytes,
    content_type: Optional[str],
    filename: Optional[str],
) -> bool:
    ct = (content_type or "").lower()
    if "heic" in ct or "heif" in ct:
        return True
    fn = (filename or "").lower()
    if fn.endswith(".heic") or fn.endswith(".heif"):
        return True
    return _looks_like_heic_container(data)


def heic_bytes_to_jpeg(data: bytes) -> bytes:
    try:
        from PIL import Image
    except ImportError as e:
        raise RuntimeError(
            "HEIC conversion requires Pillow. Install: pip install Pillow pillow-heif"
        ) from e
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError as e:
        raise RuntimeError(
            "HEIC conversion requires pillow-heif. Install: pip install pillow-heif"
        ) from e

    im = Image.open(io.BytesIO(data))
    im = im.convert("RGB")
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=88)
    return out.getvalue()


def normalize_upload_image_bytes(
    data: bytes,
    content_type: Optional[str],
    filename: Optional[str],
) -> tuple[bytes, str]:
    """
    Return (bytes, mime_type).
    HEIC/HEIF → JPEG when detected; otherwise pass through with declared type.
    """
    if not data:
        return data, content_type or "application/octet-stream"

    ct = content_type or "application/octet-stream"
    if not looks_like_heic(data, content_type, filename):
        return data, ct

    try:
        jpeg = heic_bytes_to_jpeg(data)
        logger.debug("Converted HEIC upload to JPEG (%s bytes → %s bytes)", len(data), len(jpeg))
        return jpeg, "image/jpeg"
    except Exception as e:
        logger.warning("HEIC server conversion failed: %s", e)
        raise RuntimeError(
            "Could not decode HEIC on the server. Export as JPEG from your device, "
            "or ensure pillow-heif is installed (pip install pillow-heif)."
        ) from e
