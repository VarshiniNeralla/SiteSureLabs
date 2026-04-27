"""Admin-only dashboard endpoints."""

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, status

from models import Defect, User, UserLog
from utils.deps import require_admin

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _defect_to_dict(d: Defect, *, email: str | None = None, name: str | None = None) -> dict:
    out = {
        "id": str(d.id),
        "user_id": d.user_id,
        "image_path": d.image_path,
        "tower": d.tower,
        "floor": d.floor,
        "flat": d.flat,
        "room": d.room,
        "description": d.description,
        "created_at": d.created_at.isoformat(),
    }
    if email is not None:
        out["email"] = email
    if name is not None:
        out["name"] = name
    return out


@router.get("/users")
async def get_all_users(_: User = Depends(require_admin)):
    users = await User.find_all().sort("-created_at").to_list()

    user_ids = [str(u.id) for u in users]

    pipeline = [
        {"$match": {"user_id": {"$in": user_ids}}},
        {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
    ]
    upload_counts: dict[str, int] = {}
    async for doc in Defect.get_motor_collection().aggregate(pipeline):
        upload_counts[doc["_id"]] = doc["count"]

    log_pipeline = [
        {"$match": {"user_id": {"$in": user_ids}}},
        {"$group": {"_id": "$user_id", "last": {"$max": "$timestamp"}}},
    ]
    last_activity: dict[str, str] = {}
    async for doc in UserLog.get_motor_collection().aggregate(log_pipeline):
        last_activity[doc["_id"]] = doc["last"].isoformat() if doc["last"] else None

    logger.info("admin: fetched %d users", len(users))
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "upload_count": upload_counts.get(str(u.id), 0),
            "last_activity": last_activity.get(str(u.id)),
            "created_at": u.created_at.isoformat(),
        }
        for u in users
    ]


@router.get("/users/{user_id}")
async def get_user_detail(user_id: str, _: User = Depends(require_admin)):
    try:
        user = await User.get(PydanticObjectId(user_id))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID")
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "id": str(user.id),
        "email": user.email,
        "role": user.role,
        "created_at": user.created_at.isoformat(),
    }


@router.get("/users/{user_id}/uploads")
async def get_user_uploads(user_id: str, _: User = Depends(require_admin)):
    defects = await Defect.find(Defect.user_id == user_id).sort("-created_at").to_list()
    logger.info("admin: fetched %d uploads for user %s", len(defects), user_id)
    return [_defect_to_dict(d) for d in defects]


@router.get("/uploads")
async def get_all_uploads(_: User = Depends(require_admin)):
    """Return every upload across all users, enriched with uploader identity."""
    defects = await Defect.find_all().sort("-created_at").to_list()
    user_ids = list({d.user_id for d in defects})
    users = await User.find(
        {"_id": {"$in": [PydanticObjectId(uid) for uid in user_ids]}}
    ).to_list()
    email_map = {str(u.id): u.email for u in users}
    name_map = {str(u.id): u.name for u in users}
    logger.info("admin: fetched all uploads (%d total)", len(defects))
    return [
        _defect_to_dict(
            d,
            email=email_map.get(d.user_id, "unknown"),
            name=name_map.get(d.user_id),
        )
        for d in defects
    ]


@router.get("/logs")
async def get_logs(
    date_from: Optional[str] = Query(None, description="ISO date, e.g. 2025-01-01"),
    date_to: Optional[str] = Query(None, description="ISO date, e.g. 2025-12-31"),
    _: User = Depends(require_admin),
):
    query = {}

    if date_from or date_to:
        ts_filter = {}
        if date_from:
            try:
                ts_filter["$gte"] = datetime.fromisoformat(date_from).replace(tzinfo=timezone.utc)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date_from format")
        if date_to:
            try:
                end = datetime.fromisoformat(date_to).replace(
                    hour=23, minute=59, second=59, tzinfo=timezone.utc,
                )
                ts_filter["$lte"] = end
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date_to format")
        query["timestamp"] = ts_filter

    logs = await UserLog.find(query).sort("-timestamp").to_list()

    user_ids = list({log.user_id for log in logs})
    users = await User.find({"_id": {"$in": [PydanticObjectId(uid) for uid in user_ids]}}).to_list()
    email_map = {str(u.id): u.email for u in users}
    name_map = {str(u.id): u.name for u in users}

    logger.info("admin: fetched %d log entries", len(logs))
    return [
        {
            "id": str(log.id),
            "user_id": log.user_id,
            "email": email_map.get(log.user_id, "unknown"),
            "name": name_map.get(log.user_id),
            "action": log.action,
            "timestamp": log.timestamp.isoformat(),
        }
        for log in logs
    ]


@router.delete("/uploads/{upload_id}")
async def delete_upload(upload_id: str, admin: User = Depends(require_admin)):
    try:
        defect = await Defect.get(PydanticObjectId(upload_id))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid upload ID")
    if not defect:
        raise HTTPException(status_code=404, detail="Upload not found")

    file_path = REPO_ROOT / defect.image_path
    file_deleted = False

    if file_path.exists():
        try:
            file_path.unlink()
            file_deleted = True
        except OSError as e:
            logger.error(
                "admin: failed to delete file %s for upload %s: %s",
                file_path, upload_id, e,
            )
            raise HTTPException(
                status_code=500,
                detail="Failed to delete file from storage. Database record preserved.",
            )
    else:
        file_deleted = True

    await defect.delete()

    await UserLog(
        user_id=str(admin.id),
        action=f"delete_upload:{upload_id}",
    ).insert()

    logger.info(
        "admin: deleted upload %s (file_deleted=%s, by=%s)",
        upload_id, file_deleted, admin.email,
    )
    return {"deleted": True, "id": upload_id}


def _start_of_utc_today() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


@router.get("/stats")
async def get_stats(_: User = Depends(require_admin)):
    total_users = await User.count()
    total_uploads = await Defect.count()
    total_logs = await UserLog.count()

    start_today = _start_of_utc_today()
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)

    users_today = await User.find(User.created_at >= start_today).count()
    users_week = await User.find(User.created_at >= week_ago).count()
    uploads_today = await Defect.find(Defect.created_at >= start_today).count()
    uploads_week = await Defect.find(Defect.created_at >= week_ago).count()
    logs_today = await UserLog.find(UserLog.timestamp >= start_today).count()
    logs_week = await UserLog.find(UserLog.timestamp >= week_ago).count()

    return {
        "total_users": total_users,
        "total_uploads": total_uploads,
        "total_logs": total_logs,
        "users_today": users_today,
        "users_week": users_week,
        "uploads_today": uploads_today,
        "uploads_week": uploads_week,
        "logs_today": logs_today,
        "logs_week": logs_week,
    }


@router.get("/debug/uploads")
async def debug_uploads(_: User = Depends(require_admin)):
    """Temporary debug endpoint: returns every Defect with file-existence check."""
    defects = await Defect.find_all().sort("-created_at").to_list()
    result = []
    for d in defects:
        file_abs = UPLOADS_DIR.parent / d.image_path
        result.append({
            "id": str(d.id),
            "user_id": d.user_id,
            "image_path": d.image_path,
            "file_exists": file_abs.exists(),
            "file_size": file_abs.stat().st_size if file_abs.exists() else None,
            "created_at": d.created_at.isoformat(),
        })
    return result


@router.get("/debug/storage")
async def debug_storage(_: User = Depends(require_admin)):
    """Temporary debug endpoint: lists physical files on disk under uploads/."""
    files = []
    for p in sorted(UPLOADS_DIR.rglob("*")):
        if p.is_file():
            files.append({
                "path": str(p.relative_to(UPLOADS_DIR.parent)),
                "size": p.stat().st_size,
            })
    return {"upload_dir": str(UPLOADS_DIR), "file_count": len(files), "files": files}
