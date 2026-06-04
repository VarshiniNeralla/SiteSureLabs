"""Live inspection upload endpoints."""

import hashlib
import io
import json
import logging
import os
import re
import uuid
from pathlib import Path

import aiofiles
from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from config import get_settings
from models import CollectionItem, Defect, User, UserLog
from services.image_format import normalize_upload_image_bytes
from utils.deps import get_current_user
from utils.uploads import ensure_supported_image, read_upload_with_limit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/defects", tags=["defects"])

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"


async def _read_upload_with_limit(upload: UploadFile, max_bytes: int) -> bytes:
    """Read multipart file in chunks; abort above max_bytes (413)."""
    return await read_upload_with_limit(
        upload,
        max_bytes,
        detail=(
            f"Image exceeds server limit ({max_bytes // (1024 * 1024)} MB). "
            "The app should optimize before upload — try again or contact support."
        ),
    )


async def _store_defect_upload(
    *,
    user: User,
    image: UploadFile,
    project: str,
    tower: str,
    floor: str,
    flat: str,
    room: str,
    category: str,
    subcategory: str = "",
    description: str = "",
    dedupe_key: str = "",
) -> dict[str, str]:
    if not project.strip() or not tower.strip() or not floor.strip() or not flat.strip() or not room.strip():
        raise HTTPException(status_code=400, detail="All metadata fields are required")

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    user_id = str(user.id)

    # Idempotency: if this (user, key) was already uploaded, return the existing record without
    # reading the body or writing a second file. Makes retries on timeout safe.
    dk = (dedupe_key or "").strip()
    if dk:
        existing = await Defect.find_one(
            Defect.user_id == user_id,
            Defect.client_dedupe_key == dk,
        )
        if existing:
            logger.info("upload: dedup hit user=%s key=%s → defect=%s", user.email, dk, existing.id)
            return {
                "defect_id": str(existing.id),
                "image_path": existing.image_path,
                "deduped": True,
            }

    email_prefix = user.email.split("@")[0]
    folder_name = re.sub(r"[^\w.\-]", "_", email_prefix)

    user_dir = UPLOADS_DIR / folder_name
    user_dir.mkdir(parents=True, exist_ok=True)

    settings = get_settings()
    max_bytes = settings.defect_upload_max_mb * 1024 * 1024

    content = await _read_upload_with_limit(image, max_bytes)
    detected_mime = ensure_supported_image(content)  # magic-byte check (not just client Content-Type)
    try:
        content, stored_mime = normalize_upload_image_bytes(content, detected_mime, image.filename)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    ext = ".jpg" if stored_mime == "image/jpeg" else (os.path.splitext(image.filename or "img.jpg")[1] or ".jpg")
    filename = f"{uuid.uuid4()}{ext}"
    file_path = user_dir / filename

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    if not file_path.exists() or file_path.stat().st_size == 0:
        logger.error("upload: file write failed for user %s → %s", user.email, file_path)
        raise HTTPException(status_code=500, detail="File storage failed — please retry")

    relative_path = f"uploads/{folder_name}/{filename}"

    defect = Defect(
        user_id=user_id,
        image_path=relative_path,
        project=project.strip(),
        tower=tower.strip(),
        floor=floor.strip(),
        flat=flat.strip(),
        room=room.strip(),
        category=category.strip(),
        subcategory=subcategory.strip(),
        description=description.strip(),
        client_dedupe_key=dk or None,
    )
    try:
        await defect.insert()
    except DuplicateKeyError:
        # Concurrent retry with the same (user, key) won the race. Drop the file we just wrote
        # and return the winner so the caller still gets a consistent, non-duplicated result.
        await _delete_upload_file(relative_path)
        existing = await Defect.find_one(
            Defect.user_id == user_id,
            Defect.client_dedupe_key == dk,
        )
        if existing:
            logger.info("upload: dedup race user=%s key=%s → defect=%s", user.email, dk, existing.id)
            return {
                "defect_id": str(existing.id),
                "image_path": existing.image_path,
                "deduped": True,
            }
        raise
    await UserLog(user_id=user_id, action="upload").insert()

    logger.info(
        "upload: user=%s defect=%s path=%s size=%d bytes",
        user.email,
        defect.id,
        relative_path,
        file_path.stat().st_size,
    )

    return {"defect_id": str(defect.id), "image_path": relative_path}


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_defect(
    project: str = Form(...),
    tower: str = Form(...),
    floor: str = Form(...),
    flat: str = Form(...),
    room: str = Form(...),
    category: str = Form(""),
    subcategory: str = Form(""),
    description: str = Form(""),
    dedupe_key: str = Form(""),
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    return await _store_defect_upload(
        user=user,
        image=image,
        project=project,
        tower=tower,
        floor=floor,
        flat=flat,
        room=room,
        category=category,
        subcategory=subcategory,
        description=description,
        dedupe_key=dedupe_key,
    )


@router.post("/upload-batch", status_code=status.HTTP_201_CREATED)
async def upload_defects_batch(
    items_json: str = Form(...),
    images: list[UploadFile] = File(...),
    user: User = Depends(get_current_user),
):
    try:
        items = json.loads(items_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid items_json payload: {exc.msg}") from exc

    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="items_json must be a non-empty array")

    if len(items) != len(images):
        raise HTTPException(
            status_code=400,
            detail="items_json and images length mismatch",
        )

    results: list[dict[str, object]] = []
    success_count = 0

    for idx, (item, image) in enumerate(zip(items, images)):
        if not isinstance(item, dict):
            results.append({"index": idx, "ok": False, "error": "Invalid item object"})
            continue
        try:
            saved = await _store_defect_upload(
                user=user,
                image=image,
                project=str(item.get("project", "")),
                tower=str(item.get("tower", "")),
                floor=str(item.get("floor", "")),
                flat=str(item.get("flat", "")),
                room=str(item.get("room", "")),
                category=str(item.get("category", "")),
                subcategory=str(item.get("subcategory", "")),
                description=str(item.get("description", "")),
                dedupe_key=str(item.get("dedupe_key", "") or item.get("client_id", "")),
            )
            success_count += 1
            results.append({"index": idx, "ok": True, **saved})
        except HTTPException as exc:
            results.append({"index": idx, "ok": False, "error": exc.detail})
        except Exception as exc:
            logger.exception("upload-batch: unexpected error at index=%d", idx)
            results.append({"index": idx, "ok": False, "error": str(exc)})

    return {
        "total": len(items),
        "success_count": success_count,
        "failure_count": len(items) - success_count,
        "results": results,
    }


@router.get("/my")
async def my_defects(
    response: Response,
    page: int = Query(1, ge=1),
    limit: int = Query(200, ge=1, le=500),
    user: User = Depends(get_current_user),
):
    uid = str(user.id)
    total = await Defect.find(Defect.user_id == uid).count()
    defects = (
        await Defect.find(Defect.user_id == uid)
        .sort("-created_at")
        .skip((page - 1) * limit)
        .limit(limit)
        .to_list()
    )
    visible_defects = []
    missing_images = 0
    for defect in defects:
        image_path = str(defect.image_path or "").replace("\\", "/")
        if image_path.startswith("missing/"):
            missing_images += 1
            continue
        if not image_path or not (REPO_ROOT / image_path).exists():
            missing_images += 1
            continue
        visible_defects.append(defect)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Limit"] = str(limit)
    response.headers["X-Visible-Image-Count"] = str(len(visible_defects))
    response.headers["X-Missing-Image-Count"] = str(missing_images)
    return [
        {
            "id": str(d.id),
            "image_path": d.image_path,
            "project": getattr(d, "project", "") or "",
            "tower": d.tower,
            "floor": d.floor,
            "flat": d.flat,
            "room": d.room,
            "category": d.category,
            "description": d.description,
            "created_at": d.created_at.isoformat(),
        }
        for d in visible_defects
    ]


def _user_upload_dir(user: User) -> Path:
    email_prefix = user.email.split("@")[0]
    folder_name = re.sub(r"[^\w.\-]", "_", email_prefix)
    user_dir = UPLOADS_DIR / folder_name
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def _collection_item_dict(item: CollectionItem) -> dict[str, str]:
    return {
        "id": str(item.id),
        "image_path": item.image_path,
        # Always return the canonical (v2) hash so the client's dedup check
        # treats new uploads and legacy items consistently. Legacy SHA-256
        # values are recomputed from disk lazily inside the helper.
        "image_hash": _collection_item_image_hash(item),
        "project": item.project or "",
        "tower": item.tower,
        "floor": item.floor,
        "flat": item.flat,
        "room": item.room,
        "category": item.category,
        "subcategory": getattr(item, "subcategory", "") or "",
        "description": item.description,
        "file_name": item.file_name or "",
        "created_at": item.created_at.isoformat(),
    }


async def _delete_upload_file(image_path: str) -> None:
    if not image_path or image_path.startswith("missing/"):
        return
    file_path = REPO_ROOT / image_path
    try:
        file_path.unlink(missing_ok=True)
    except OSError:
        logger.warning("collection: failed to delete file %s", file_path)


# ────────────────────────────────────────────────────────────────────────
# Perceptual image hashing for duplicate detection.
#
# Byte-level SHA-256 of the normalized JPEG is too brittle: identical
# captures can produce slightly different encoded bytes when they take
# different code paths (camera capture vs file picker, optimizer re-encode
# vs pass-through, sensor noise on successive captures, EXIF stripping
# order). The result is that "5 identical uploads" can yield 4 matching
# hashes + 1 different one — exactly the user-reported false negative.
#
# dhash hashes the rank order of pixel brightness across an 17x16 grid,
# producing a 256-bit fingerprint that is invariant to compression noise
# and small encoding differences while remaining distinct between visually
# different photos. Stored with a "v2:" prefix so legacy SHA-256 hashes
# can be recognized and recomputed on the fly.
# ────────────────────────────────────────────────────────────────────────
_PIXEL_HASH_VERSION = "v2"
_DHASH_SIZE = 16  # 16x17 grid → 256 bits → 64 hex chars


def _dhash_pixels(image_bytes: bytes) -> str:
    """Compute a difference hash over the decoded grayscale pixels."""
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(image_bytes)) as raw:
        im = ImageOps.exif_transpose(raw)
        # Compare neighbouring columns → grid is (size+1) wide × size tall.
        im = im.convert("L").resize(
            (_DHASH_SIZE + 1, _DHASH_SIZE), Image.Resampling.LANCZOS
        )
        pixels = im.tobytes()

    stride = _DHASH_SIZE + 1
    bits = 0
    for row in range(_DHASH_SIZE):
        base = row * stride
        for col in range(_DHASH_SIZE):
            if pixels[base + col] > pixels[base + col + 1]:
                bits = (bits << 1) | 1
            else:
                bits <<= 1
    width = (_DHASH_SIZE * _DHASH_SIZE + 3) // 4
    return f"{_PIXEL_HASH_VERSION}:{bits:0{width}x}"


def _compute_image_hash(image_bytes: bytes) -> str:
    """Hash an upload's pixel content, with a SHA-256 fallback on decode failure."""
    try:
        return _dhash_pixels(image_bytes)
    except Exception as exc:  # noqa: BLE001 — Pillow can raise many decode errors
        logger.warning("collection: dhash failed, falling back to sha256: %s", exc)
        return hashlib.sha256(image_bytes).hexdigest()


def _collection_item_image_hash(item: CollectionItem) -> str:
    """
    Return the perceptual hash for a collection item, recomputing from
    disk when the stored value is legacy (pre-v2 SHA-256) or missing.
    """
    stored = (item.image_hash or "").strip()
    if stored.startswith(f"{_PIXEL_HASH_VERSION}:"):
        return stored
    if not item.image_path:
        return ""
    file_path = REPO_ROOT / item.image_path
    try:
        with file_path.open("rb") as f:
            return _compute_image_hash(f.read())
    except OSError:
        logger.warning("collection: failed to hash image %s", item.image_path)
        return ""


def _duplicate_collection_indexes(items: list[CollectionItem]) -> list[int]:
    seen: dict[str, int] = {}
    duplicates: list[int] = []
    for idx, item in enumerate(items):
        image_hash = _collection_item_image_hash(item)
        if not image_hash:
            continue
        if image_hash in seen:
            if seen[image_hash] not in duplicates:
                duplicates.append(seen[image_hash])
            duplicates.append(idx)
            continue
        seen[image_hash] = idx
    return duplicates


async def _store_collection_upload(
    *,
    user: User,
    image: UploadFile,
    project: str,
    tower: str,
    floor: str,
    flat: str,
    room: str,
    category: str,
    description: str,
    subcategory: str = "",
    file_name: str = "",
) -> CollectionItem:
    if not project.strip() or not tower.strip() or not floor.strip() or not flat.strip() or not room.strip():
        raise HTTPException(status_code=400, detail="All metadata fields are required")

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    settings = get_settings()
    max_bytes = settings.defect_upload_max_mb * 1024 * 1024
    content = await _read_upload_with_limit(image, max_bytes)
    detected_mime = ensure_supported_image(content)  # magic-byte check (not just client Content-Type)
    try:
        content, stored_mime = normalize_upload_image_bytes(content, detected_mime, image.filename or file_name)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    image_hash = _compute_image_hash(content)

    user_dir = _user_upload_dir(user)
    ext = ".jpg" if stored_mime == "image/jpeg" else (os.path.splitext(image.filename or file_name or "img.jpg")[1] or ".jpg")
    filename = f"col_{uuid.uuid4()}{ext}"
    file_path = user_dir / filename

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    if not file_path.exists() or file_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="File storage failed — please retry")

    folder_name = user_dir.name
    relative_path = f"uploads/{folder_name}/{filename}"
    user_id = str(user.id)

    item = CollectionItem(
        user_id=user_id,
        image_path=relative_path,
        image_hash=image_hash,
        project=project.strip(),
        tower=tower.strip(),
        floor=floor.strip(),
        flat=flat.strip(),
        room=room.strip(),
        category=category.strip(),
        subcategory=subcategory.strip(),
        description=description.strip(),
        file_name=(file_name or image.filename or filename).strip(),
    )
    await item.insert()
    return item


async def _get_owned_collection_item(item_id: str, user: User) -> CollectionItem:
    try:
        oid = PydanticObjectId(item_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid collection item id") from exc

    item = await CollectionItem.get(oid)
    if not item or item.user_id != str(user.id):
        raise HTTPException(status_code=404, detail="Collection item not found")
    return item


class CollectionItemUpdate(BaseModel):
    project: str = ""
    tower: str = ""
    floor: str = ""
    flat: str = ""
    room: str = ""
    category: str = ""
    subcategory: str = ""
    description: str = Field(default="")


@router.get("/collection")
async def list_collection(user: User = Depends(get_current_user)):
    items = await CollectionItem.find(CollectionItem.user_id == str(user.id)).sort("-created_at").to_list()
    return [_collection_item_dict(item) for item in items]


@router.post("/collection", status_code=status.HTTP_201_CREATED)
async def add_collection_item(
    project: str = Form(...),
    tower: str = Form(...),
    floor: str = Form(...),
    flat: str = Form(...),
    room: str = Form(...),
    category: str = Form(""),
    subcategory: str = Form(""),
    description: str = Form(""),
    file_name: str = Form(""),
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    item = await _store_collection_upload(
        user=user,
        image=image,
        project=project,
        tower=tower,
        floor=floor,
        flat=flat,
        room=room,
        category=category,
        subcategory=subcategory,
        description=description,
        file_name=file_name,
    )
    return _collection_item_dict(item)


@router.patch("/collection/{item_id}")
async def update_collection_item(
    item_id: str,
    body: CollectionItemUpdate,
    user: User = Depends(get_current_user),
):
    item = await _get_owned_collection_item(item_id, user)
    if not body.tower.strip() or not body.floor.strip() or not body.flat.strip() or not body.room.strip():
        raise HTTPException(status_code=400, detail="Tower, floor, flat, and room are required")

    item.project = body.project.strip()
    item.tower = body.tower.strip()
    item.floor = body.floor.strip()
    item.flat = body.flat.strip()
    item.room = body.room.strip()
    item.category = body.category.strip()
    item.subcategory = body.subcategory.strip()
    item.description = body.description.strip()
    await item.save()
    return _collection_item_dict(item)


@router.delete("/collection/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_collection_item(item_id: str, user: User = Depends(get_current_user)):
    item = await _get_owned_collection_item(item_id, user)
    await _delete_upload_file(item.image_path)
    await item.delete()


@router.delete("/collection")
async def clear_collection(user: User = Depends(get_current_user)):
    items = await CollectionItem.find(CollectionItem.user_id == str(user.id)).to_list()
    for item in items:
        await _delete_upload_file(item.image_path)
        await item.delete()
    return {"deleted": len(items)}


@router.post("/collection/submit", status_code=status.HTTP_201_CREATED)
async def submit_collection(
    allow_duplicates: bool = Query(False),
    user: User = Depends(get_current_user),
):
    user_id = str(user.id)
    items = await CollectionItem.find(CollectionItem.user_id == user_id).sort("created_at").to_list()
    if not items:
        raise HTTPException(status_code=400, detail="Collection is empty")
    duplicate_indexes = _duplicate_collection_indexes(items)
    if duplicate_indexes and not allow_duplicates:
        duplicate_list = ", ".join(str(i + 1) for i in duplicate_indexes[:8])
        raise HTTPException(
            status_code=400,
            detail=(
                "Duplicate images are not allowed. Remove duplicate image(s) "
                f"from the collection before submitting. Duplicate item(s): {duplicate_list}."
            ),
        )

    coll = CollectionItem.get_motor_collection()
    success_count = 0
    results: list[dict[str, object]] = []

    for idx, item in enumerate(items):
        # Atomically claim (delete) the item before creating its Defect. find_one_and_delete is a
        # single-document atomic op, so a concurrent or retried submit cannot process the same item
        # twice — eliminating the duplicate-defect race without needing multi-doc transactions.
        claimed = await coll.find_one_and_delete({"_id": item.id, "user_id": user_id})
        if not claimed:
            # Another concurrent/previous submit already claimed it — skip, don't duplicate.
            results.append({"index": idx, "ok": False, "error": "already submitted"})
            continue
        try:
            defect = Defect(
                user_id=user_id,
                image_path=claimed.get("image_path", ""),
                project=claimed.get("project", "") or "",
                tower=claimed.get("tower", ""),
                floor=claimed.get("floor", ""),
                flat=claimed.get("flat", ""),
                room=claimed.get("room", ""),
                category=claimed.get("category", "") or "",
                subcategory=claimed.get("subcategory", "") or "",
                description=claimed.get("description", "") or "",
            )
            await defect.insert()
            success_count += 1
            results.append(
                {"index": idx, "ok": True, "defect_id": str(defect.id), "image_path": defect.image_path}
            )
        except Exception as exc:
            logger.exception("collection submit failed at index=%d", idx)
            # Compensate: restore the claimed item so the user's upload is not silently lost.
            try:
                await coll.insert_one(claimed)
            except Exception:
                logger.exception(
                    "collection submit: failed to restore claimed item %s", claimed.get("_id")
                )
            results.append({"index": idx, "ok": False, "error": str(exc)})

    if success_count:
        await UserLog(user_id=user_id, action="upload").insert()

    return {
        "total": len(items),
        "success_count": success_count,
        "failure_count": len(items) - success_count,
        "results": results,
    }
