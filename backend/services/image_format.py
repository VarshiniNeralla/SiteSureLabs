"""Normalize uploaded image bytes into report-safe JPEGs."""

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
        from PIL import Image, ImageOps
    except ImportError as e:
        raise RuntimeError(
            "HEIC conversion requires Pillow. Install: pip install Pillow pillow-heif"
        ) from e
    # Decompression-bomb guard (raises DecompressionBombError on absurd dimensions).
    Image.MAX_IMAGE_PIXELS = 64_000_000
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError as e:
        raise RuntimeError(
            "HEIC conversion requires pillow-heif. Install: pip install pillow-heif"
        ) from e

    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im).convert("RGB")
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=88)
    return out.getvalue()


def _register_heif_opener_if_available() -> None:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError:
        return


def _image_to_oriented_jpeg(data: bytes) -> bytes:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 64_000_000
    _register_heif_opener_if_available()

    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        im = background
    else:
        im = im.convert("RGB")

    out = io.BytesIO()
    im.save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue()


def normalize_upload_image_bytes(
    data: bytes,
    content_type: Optional[str],
    filename: Optional[str],
) -> tuple[bytes, str]:
    """
    Return (bytes, mime_type).
    Decode the image, apply EXIF orientation exactly like phone/gallery viewers do,
    and store a JPEG with the corrected pixels. This avoids sideways exports later
    because Excel/PPT do not consistently honor EXIF metadata.
    """
    if not data:
        return data, content_type or "application/octet-stream"

    try:
        jpeg = _image_to_oriented_jpeg(data)
        logger.debug("Normalized upload image to oriented JPEG (%s bytes → %s bytes)", len(data), len(jpeg))
        return jpeg, "image/jpeg"
    except Exception as e:
        logger.warning("Image orientation normalization failed: %s", e)
        if not looks_like_heic(data, content_type, filename):
            return data, content_type or "application/octet-stream"
        raise RuntimeError(
            "Could not decode HEIC on the server. Export as JPEG from your device, "
            "or ensure pillow-heif is installed (pip install pillow-heif)."
        ) from e
