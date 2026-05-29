"""Developer Portal endpoints (highest privilege, /api/dev/*).

Role hierarchy: Developer → Admin → Standard User.

Every endpoint in this module requires `require_developer`. Developers can manage admins,
manage users, view platform-wide metrics, and read audit/error logs.

All write actions are persisted as audit entries in `user_logs` with `dev_*` action prefixes.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, EmailStr, Field

from models import CollectionItem, Defect, Notification, User, UserLog
from utils.deps import require_developer
from utils.security import hash_password

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"

router = APIRouter(prefix="/api/dev", tags=["developer"])

_LIST_PAGE_MAX = 500
_DEFAULT_PAGE = 100

_VALID_ROLES = ("user", "admin", "developer")

# Active-session window: a user is considered "active" if they logged in or uploaded
# something within this window. Tuned for inspection workloads where sessions are short
# but not chat-style.
_ACTIVE_SESSION_MINUTES = 30

# Server-process start time — used for /system-health uptime.
_PROCESS_START_TS = time.time()


def _as_utc_aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso_utc(dt: datetime | None) -> str | None:
    d = _as_utc_aware(dt)
    return d.isoformat(timespec="milliseconds") if d else None


def _normalize_email(value: EmailStr | str) -> str:
    return str(value).strip().lower()


async def _get_user_or_404(user_id: str) -> User:
    try:
        user = await User.get(PydanticObjectId(user_id))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID") from None
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def _audit(
    actor: User,
    action: str,
    *,
    target: Optional[User] = None,
    target_email: Optional[str] = None,
) -> None:
    """Record a developer action in user_logs. Never raises into the request path."""
    try:
        await UserLog(
            user_id=str(actor.id),
            action=action,
            target_user_id=str(target.id) if target else None,
            target_email=target_email or (target.email if target else None),
        ).insert()
    except Exception:
        logger.exception("dev audit log insert failed for action=%s", action)


# ---------- Models ----------


class CreateAdminBody(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    name: Optional[str] = None
    mobile: Optional[str] = None
    role: Literal["admin", "developer"] = "admin"


class EditUserBody(BaseModel):
    name: Optional[str] = None
    mobile: Optional[str] = None
    email: Optional[EmailStr] = None
    role: Optional[Literal["user", "admin", "developer"]] = None


class ResetPasswordBody(BaseModel):
    new_password: str = Field(..., min_length=8, max_length=128)


class SetStatusBody(BaseModel):
    is_disabled: bool


# ---------- Overview / Stats ----------


@router.get("/overview")
async def get_overview(_: User = Depends(require_developer)):
    """Aggregate counts for the Overview cards on the developer dashboard."""
    now = datetime.now(timezone.utc)
    active_window_start = now - timedelta(minutes=_ACTIVE_SESSION_MINUTES)

    total_users_task = User.find(User.role == "user").count()
    total_admins_task = User.find(User.role == "admin").count()
    total_devs_task = User.find(User.role == "developer").count()
    total_uploads_task = Defect.find_all().count()
    disabled_users_task = User.find(User.is_disabled == True).count()  # noqa: E712

    (
        total_users,
        total_admins,
        total_devs,
        total_uploads,
        disabled_users,
    ) = await asyncio.gather(
        total_users_task,
        total_admins_task,
        total_devs_task,
        total_uploads_task,
        disabled_users_task,
    )

    # Active users: anyone with a UserLog row inside the window OR an upload inside it.
    active_actor_ids: set[str] = set()
    async for doc in UserLog.get_motor_collection().aggregate([
        {"$match": {"timestamp": {"$gte": active_window_start}}},
        {"$group": {"_id": "$user_id"}},
    ]):
        active_actor_ids.add(str(doc["_id"]))
    async for doc in Defect.get_motor_collection().aggregate([
        {"$match": {"created_at": {"$gte": active_window_start}}},
        {"$group": {"_id": "$user_id"}},
    ]):
        active_actor_ids.add(str(doc["_id"]))

    storage_bytes = 0
    try:
        if UPLOADS_DIR.exists():
            for p in UPLOADS_DIR.rglob("*"):
                if p.is_file():
                    try:
                        storage_bytes += p.stat().st_size
                    except OSError:
                        continue
    except Exception:
        logger.exception("dev: failed to walk uploads dir for storage usage")

    return {
        "total_users": total_users,
        "total_admins": total_admins,
        "total_developers": total_devs,
        "total_uploads": total_uploads,
        "active_users": len(active_actor_ids),
        "disabled_accounts": disabled_users,
        "storage_bytes": storage_bytes,
        "storage_human": _human_bytes(storage_bytes),
        "system_status": "ok",
        "generated_at": _iso_utc(now),
    }


def _human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    units = ("KB", "MB", "GB", "TB")
    size = float(n) / 1024.0
    for unit in units:
        if size < 1024.0:
            return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} PB"


# ---------- Admin management ----------


@router.get("/admins")
async def list_admins(
    response: Response,
    page: int = Query(1, ge=1),
    limit: int = Query(_DEFAULT_PAGE, ge=1, le=_LIST_PAGE_MAX),
    search: str = Query("", max_length=200),
    _: User = Depends(require_developer),
):
    """All accounts with role admin or developer."""
    query: dict = {"role": {"$in": ["admin", "developer"]}}
    if search.strip():
        rx = {"$regex": re.escape(search.strip()), "$options": "i"}
        query["$or"] = [{"email": rx}, {"name": rx}]

    total = await User.find(query).count()
    admins = (
        await User.find(query)
        .sort("-created_at")
        .skip((page - 1) * limit)
        .limit(limit)
        .to_list()
    )
    response.headers["X-Total-Count"] = str(total)

    actor_ids = [str(u.id) for u in admins]
    last_seen = await _last_activity_map(actor_ids)

    return [
        {
            "id": str(u.id),
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "is_disabled": bool(u.is_disabled),
            "mobile": u.mobile,
            "profile_photo": u.profile_photo,
            "created_at": _iso_utc(u.created_at),
            "last_active": _iso_utc(last_seen.get(str(u.id))),
        }
        for u in admins
    ]


async def _last_activity_map(user_ids: list[str]) -> dict[str, datetime]:
    if not user_ids:
        return {}
    last: dict[str, datetime] = {}
    async for doc in UserLog.get_motor_collection().aggregate([
        {"$match": {"user_id": {"$in": user_ids}}},
        {"$group": {"_id": "$user_id", "last": {"$max": "$timestamp"}}},
    ]):
        ts = _as_utc_aware(doc.get("last"))
        if ts:
            last[str(doc["_id"])] = ts
    async for doc in Defect.get_motor_collection().aggregate([
        {"$match": {"user_id": {"$in": user_ids}}},
        {"$group": {"_id": "$user_id", "last": {"$max": "$created_at"}}},
    ]):
        ts = _as_utc_aware(doc.get("last"))
        if ts:
            uid = str(doc["_id"])
            prev = last.get(uid)
            if prev is None or ts > prev:
                last[uid] = ts
    return last


@router.post("/admins", status_code=status.HTTP_201_CREATED)
async def create_admin(body: CreateAdminBody, actor: User = Depends(require_developer)):
    email_key = _normalize_email(body.email)
    if await User.find_one(User.email == email_key):
        raise HTTPException(status_code=409, detail="Email already registered")

    name = (body.name or "").strip() or None
    mobile = (body.mobile or "").strip() or None
    user = User(
        email=email_key,
        password=hash_password(body.password),
        name=name,
        mobile=mobile,
        role=body.role,
    )
    await user.insert()
    await _audit(actor, f"dev_create_{body.role}", target=user)
    logger.info("dev: %s created %s account %s", actor.email, body.role, user.email)
    return {
        "id": str(user.id),
        "email": user.email,
        "role": user.role,
        "name": user.name,
        "created_at": _iso_utc(user.created_at),
    }


@router.patch("/admins/{user_id}")
async def edit_admin(user_id: str, body: EditUserBody, actor: User = Depends(require_developer)):
    target = await _get_user_or_404(user_id)

    if body.email is not None:
        new_email = _normalize_email(body.email)
        if new_email != target.email:
            clash = await User.find_one(User.email == new_email)
            if clash:
                raise HTTPException(status_code=409, detail="Email already in use")
            target.email = new_email
    if body.name is not None:
        target.name = body.name.strip() or None
    if body.mobile is not None:
        target.mobile = body.mobile.strip() or None
    if body.role is not None and body.role != target.role:
        # Prevent demoting the only developer from the system.
        if target.role == "developer" and body.role != "developer":
            total_devs = await User.find(User.role == "developer").count()
            if total_devs <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot demote the only developer account.",
                )
        # Developers cannot demote themselves to a non-developer role here.
        if str(actor.id) == str(target.id) and body.role != "developer":
            raise HTTPException(status_code=400, detail="You cannot change your own role.")
        target.role = body.role

    await target.save()
    await _audit(actor, "dev_edit_account", target=target)
    return {"ok": True, "id": str(target.id)}


@router.post("/admins/{user_id}/disable")
async def disable_admin(user_id: str, actor: User = Depends(require_developer)):
    target = await _get_user_or_404(user_id)
    if str(actor.id) == str(target.id):
        raise HTTPException(status_code=400, detail="You cannot disable your own account.")
    if target.is_disabled:
        return {"ok": True, "is_disabled": True}
    if target.role == "developer":
        enabled_devs = await User.find(
            {"role": "developer", "is_disabled": {"$ne": True}}
        ).count()
        if enabled_devs <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot disable the last active developer.",
            )
    target.is_disabled = True
    await target.save()
    await _audit(actor, "dev_disable_account", target=target)
    return {"ok": True, "is_disabled": True}


@router.post("/admins/{user_id}/enable")
async def enable_admin(user_id: str, actor: User = Depends(require_developer)):
    target = await _get_user_or_404(user_id)
    if not target.is_disabled:
        return {"ok": True, "is_disabled": False}
    target.is_disabled = False
    await target.save()
    await _audit(actor, "dev_enable_account", target=target)
    return {"ok": True, "is_disabled": False}


@router.delete("/admins/{user_id}")
async def delete_admin(user_id: str, actor: User = Depends(require_developer)):
    target = await _get_user_or_404(user_id)
    if str(actor.id) == str(target.id):
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    if target.role == "developer":
        total_devs = await User.find(User.role == "developer").count()
        if total_devs <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete the only developer account.",
            )

    await _audit(actor, "dev_delete_account", target=target)

    # Best-effort cleanup of owned data — mirrors admin delete path.
    defects = await Defect.find(Defect.user_id == user_id).to_list()
    for d in defects:
        fpath = REPO_ROOT / d.image_path
        if fpath.exists():
            try:
                fpath.unlink()
            except OSError:
                logger.warning("dev: could not unlink %s", fpath)
        await d.delete()

    await CollectionItem.find(CollectionItem.user_id == user_id).delete()
    await UserLog.get_motor_collection().delete_many({"user_id": user_id})
    await target.delete()
    return {"ok": True, "deleted_id": user_id, "defects_removed": len(defects)}


@router.post("/admins/{user_id}/reset-password")
async def reset_admin_password(
    user_id: str,
    body: ResetPasswordBody,
    actor: User = Depends(require_developer),
):
    target = await _get_user_or_404(user_id)
    target.password = hash_password(body.new_password)
    await target.save()
    await _audit(actor, "dev_reset_password", target=target)
    return {"ok": True}


# ---------- User management ----------


@router.get("/users")
async def list_users(
    response: Response,
    page: int = Query(1, ge=1),
    limit: int = Query(_DEFAULT_PAGE, ge=1, le=_LIST_PAGE_MAX),
    search: str = Query("", max_length=200),
    role: str = Query("", max_length=20),
    status_filter: str = Query("", alias="status", max_length=20),
    _: User = Depends(require_developer),
):
    """Paginated user list with upload counts + last activity."""
    query: dict = {}
    if role and role in _VALID_ROLES:
        query["role"] = role
    if status_filter == "active":
        query["is_disabled"] = {"$ne": True}
    elif status_filter == "disabled":
        query["is_disabled"] = True
    if search.strip():
        rx = {"$regex": re.escape(search.strip()), "$options": "i"}
        query["$or"] = [{"email": rx}, {"name": rx}]

    total = await User.find(query).count()
    users = (
        await User.find(query)
        .sort("-created_at")
        .skip((page - 1) * limit)
        .limit(limit)
        .to_list()
    )
    response.headers["X-Total-Count"] = str(total)

    user_ids = [str(u.id) for u in users]
    upload_counts: dict[str, int] = {}
    if user_ids:
        async for doc in Defect.get_motor_collection().aggregate([
            {"$match": {"user_id": {"$in": user_ids}}},
            {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
        ]):
            upload_counts[str(doc["_id"])] = doc["count"]
    last_seen = await _last_activity_map(user_ids)

    return [
        {
            "id": str(u.id),
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "is_disabled": bool(u.is_disabled),
            "mobile": u.mobile,
            "site": u.site,
            "location": u.location,
            "profile_photo": u.profile_photo,
            "upload_count": upload_counts.get(str(u.id), 0),
            "created_at": _iso_utc(u.created_at),
            "last_active": _iso_utc(last_seen.get(str(u.id))),
        }
        for u in users
    ]


@router.get("/users/{user_id}")
async def get_user_detail(user_id: str, _: User = Depends(require_developer)):
    user = await _get_user_or_404(user_id)
    upload_count = await Defect.find(Defect.user_id == user_id).count()
    last_log = (
        await UserLog.find(UserLog.user_id == user_id).sort("-timestamp").limit(1).to_list()
    )
    last_active = last_log[0].timestamp if last_log else None
    return {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "is_disabled": bool(user.is_disabled),
        "mobile": user.mobile,
        "gender": user.gender,
        "age": user.age,
        "site": user.site,
        "location": user.location,
        "profile_photo": user.profile_photo,
        "created_at": _iso_utc(user.created_at),
        "last_active": _iso_utc(last_active),
        "upload_count": upload_count,
    }


@router.get("/users/{user_id}/activity")
async def user_activity(
    user_id: str,
    limit: int = Query(50, ge=1, le=200),
    _: User = Depends(require_developer),
):
    await _get_user_or_404(user_id)
    logs = (
        await UserLog.find(UserLog.user_id == user_id)
        .sort("-timestamp")
        .limit(limit)
        .to_list()
    )
    return [
        {
            "id": str(log.id),
            "action": log.action,
            "target_user_id": log.target_user_id,
            "target_email": log.target_email,
            "timestamp": _iso_utc(log.timestamp),
        }
        for log in logs
    ]


@router.post("/users/{user_id}/suspend")
async def suspend_user(user_id: str, actor: User = Depends(require_developer)):
    target = await _get_user_or_404(user_id)
    if str(actor.id) == str(target.id):
        raise HTTPException(status_code=400, detail="You cannot suspend your own account.")
    if target.is_disabled:
        return {"ok": True, "is_disabled": True}
    target.is_disabled = True
    await target.save()
    await _audit(actor, "dev_suspend_user", target=target)
    return {"ok": True, "is_disabled": True}


@router.post("/users/{user_id}/activate")
async def activate_user(user_id: str, actor: User = Depends(require_developer)):
    target = await _get_user_or_404(user_id)
    if not target.is_disabled:
        return {"ok": True, "is_disabled": False}
    target.is_disabled = False
    await target.save()
    await _audit(actor, "dev_activate_user", target=target)
    return {"ok": True, "is_disabled": False}


# ---------- Uploads ----------


@router.get("/uploads")
async def list_uploads(
    response: Response,
    page: int = Query(1, ge=1),
    limit: int = Query(_DEFAULT_PAGE, ge=1, le=_LIST_PAGE_MAX),
    user_id: str = Query("", max_length=64),
    _: User = Depends(require_developer),
):
    """Platform-wide uploads (paginated), with uploader email."""
    query: dict = {}
    if user_id:
        query["user_id"] = user_id

    total = await Defect.find(query).count()
    defects = (
        await Defect.find(query)
        .sort("-created_at")
        .skip((page - 1) * limit)
        .limit(limit)
        .to_list()
    )
    response.headers["X-Total-Count"] = str(total)

    uploader_ids = list({d.user_id for d in defects})
    email_map: dict[str, str] = {}
    name_map: dict[str, Optional[str]] = {}
    if uploader_ids:
        try:
            object_ids = [PydanticObjectId(uid) for uid in uploader_ids]
        except Exception:
            object_ids = []
        if object_ids:
            users = await User.find({"_id": {"$in": object_ids}}).to_list()
            for u in users:
                email_map[str(u.id)] = u.email
                name_map[str(u.id)] = u.name

    return [
        {
            "id": str(d.id),
            "user_id": d.user_id,
            "email": email_map.get(d.user_id, "unknown"),
            "name": name_map.get(d.user_id),
            "image_path": d.image_path,
            "project": getattr(d, "project", "") or "",
            "tower": d.tower,
            "floor": d.floor,
            "flat": d.flat,
            "room": d.room,
            "category": d.category,
            "description": d.description,
            "created_at": _iso_utc(d.created_at),
        }
        for d in defects
    ]


# ---------- Analytics ----------


@router.get("/analytics")
async def analytics(
    days: int = Query(30, ge=1, le=180),
    _: User = Depends(require_developer),
):
    """Day-bucketed counts for uploads + new users + logins, over the last N days."""
    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start = end - timedelta(days=days)

    uploads_by_day: dict[str, int] = {}
    async for doc in Defect.get_motor_collection().aggregate([
        {"$match": {"created_at": {"$gte": start, "$lt": end}}},
        {
            "$group": {
                "_id": {
                    "$dateToString": {"format": "%Y-%m-%d", "date": "$created_at"}
                },
                "count": {"$sum": 1},
            }
        },
    ]):
        uploads_by_day[doc["_id"]] = doc["count"]

    users_by_day: dict[str, int] = {}
    async for doc in User.get_motor_collection().aggregate([
        {"$match": {"created_at": {"$gte": start, "$lt": end}}},
        {
            "$group": {
                "_id": {
                    "$dateToString": {"format": "%Y-%m-%d", "date": "$created_at"}
                },
                "count": {"$sum": 1},
            }
        },
    ]):
        users_by_day[doc["_id"]] = doc["count"]

    logins_by_day: dict[str, int] = {}
    async for doc in UserLog.get_motor_collection().aggregate([
        {
            "$match": {
                "timestamp": {"$gte": start, "$lt": end},
                "action": {"$in": ["login", "admin_login", "dev_login"]},
            }
        },
        {
            "$group": {
                "_id": {
                    "$dateToString": {"format": "%Y-%m-%d", "date": "$timestamp"}
                },
                "count": {"$sum": 1},
            }
        },
    ]):
        logins_by_day[doc["_id"]] = doc["count"]

    series: list[dict] = []
    cursor = start
    while cursor < end:
        key = cursor.strftime("%Y-%m-%d")
        series.append(
            {
                "date": key,
                "uploads": uploads_by_day.get(key, 0),
                "new_users": users_by_day.get(key, 0),
                "logins": logins_by_day.get(key, 0),
            }
        )
        cursor += timedelta(days=1)

    # Category breakdown for uploads in the window.
    category_breakdown: list[dict] = []
    async for doc in Defect.get_motor_collection().aggregate([
        {"$match": {"created_at": {"$gte": start, "$lt": end}}},
        {"$group": {"_id": {"$ifNull": ["$category", "Other"]}, "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 12},
    ]):
        category_breakdown.append(
            {"category": doc["_id"] or "Other", "count": doc["count"]}
        )

    return {
        "range_days": days,
        "from": _iso_utc(start),
        "to": _iso_utc(end),
        "series": series,
        "category_breakdown": category_breakdown,
    }


# ---------- Audit / activity ----------


@router.get("/audit-logs")
async def audit_logs(
    response: Response,
    page: int = Query(1, ge=1),
    limit: int = Query(_DEFAULT_PAGE, ge=1, le=_LIST_PAGE_MAX),
    action: str = Query("", max_length=80),
    actor_id: str = Query("", max_length=64),
    _: User = Depends(require_developer),
):
    query: dict = {}
    if action.strip():
        query["action"] = {"$regex": re.escape(action.strip()), "$options": "i"}
    if actor_id.strip():
        query["user_id"] = actor_id.strip()

    total = await UserLog.find(query).count()
    logs = (
        await UserLog.find(query)
        .sort("-timestamp")
        .skip((page - 1) * limit)
        .limit(limit)
        .to_list()
    )
    response.headers["X-Total-Count"] = str(total)

    actor_ids = list({log.user_id for log in logs})
    actor_map: dict[str, str] = {}
    if actor_ids:
        try:
            object_ids = [PydanticObjectId(uid) for uid in actor_ids]
        except Exception:
            object_ids = []
        if object_ids:
            actors = await User.find({"_id": {"$in": object_ids}}).to_list()
            for u in actors:
                actor_map[str(u.id)] = u.email

    return [
        {
            "id": str(log.id),
            "actor_id": log.user_id,
            "actor_email": actor_map.get(log.user_id, "unknown"),
            "action": log.action,
            "target_user_id": log.target_user_id,
            "target_email": log.target_email,
            "timestamp": _iso_utc(log.timestamp),
        }
        for log in logs
    ]


@router.get("/recent-activity")
async def recent_activity(
    limit: int = Query(25, ge=1, le=200),
    _: User = Depends(require_developer),
):
    """Mixed feed: latest logs + latest uploads + latest registrations."""
    logs = await UserLog.find_all().sort("-timestamp").limit(limit).to_list()
    actor_ids = list({log.user_id for log in logs})
    actor_map: dict[str, str] = {}
    if actor_ids:
        try:
            obj_ids = [PydanticObjectId(uid) for uid in actor_ids]
        except Exception:
            obj_ids = []
        if obj_ids:
            users = await User.find({"_id": {"$in": obj_ids}}).to_list()
            actor_map = {str(u.id): u.email for u in users}

    return [
        {
            "id": str(log.id),
            "actor_id": log.user_id,
            "actor_email": actor_map.get(log.user_id, "unknown"),
            "action": log.action,
            "target_email": log.target_email,
            "timestamp": _iso_utc(log.timestamp),
        }
        for log in logs
    ]


# ---------- System health ----------


@router.get("/system-health")
async def system_health(_: User = Depends(require_developer)):
    """Component-level liveness checks for the developer dashboard System Health panel."""
    from services.http_client import vllm_breaker

    checks: dict[str, dict] = {}

    # Mongo ping
    mongo_status = "down"
    mongo_latency_ms: Optional[float] = None
    try:
        t0 = time.perf_counter()
        await asyncio.wait_for(
            User.get_motor_collection().database.command("ping"), timeout=2.0
        )
        mongo_latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        mongo_status = "ok"
    except Exception:
        logger.warning("dev: mongo ping failed", exc_info=True)
    checks["database"] = {"status": mongo_status, "latency_ms": mongo_latency_ms}

    # AI service (vLLM) — derive status from circuit breaker state.
    if vllm_breaker.is_open():
        checks["ai_service"] = {"status": "degraded", "note": "circuit open"}
    else:
        checks["ai_service"] = {"status": "ok"}

    # API service itself — if we are answering, it's up.
    checks["api"] = {"status": "ok"}

    # Storage — verify writable + report free space.
    storage_status = "ok"
    free_bytes: Optional[int] = None
    try:
        if not UPLOADS_DIR.exists():
            storage_status = "degraded"
        else:
            free_bytes = shutil.disk_usage(str(UPLOADS_DIR)).free
            probe = UPLOADS_DIR / ".write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
    except Exception:
        storage_status = "down"
        logger.exception("dev: storage write probe failed")
    checks["storage"] = {
        "status": storage_status,
        "free_bytes": free_bytes,
        "free_human": _human_bytes(free_bytes) if free_bytes is not None else None,
    }

    # Background jobs / queue — placeholder until a worker is wired up.
    checks["queue"] = {"status": "n/a", "note": "no background queue configured"}

    overall = "ok"
    for c in checks.values():
        s = c.get("status")
        if s == "down":
            overall = "down"
            break
        if s == "degraded" and overall == "ok":
            overall = "degraded"

    return {
        "status": overall,
        "uptime_seconds": round(time.time() - _PROCESS_START_TS, 1),
        "checks": checks,
        "generated_at": _iso_utc(datetime.now(timezone.utc)),
    }


@router.get("/error-logs")
async def error_logs(
    limit: int = Query(100, ge=1, le=500),
    _: User = Depends(require_developer),
):
    """Surface persisted error events. We don't currently store app errors in Mongo, so we
    derive a best-effort feed from audit actions that imply failure semantics. The endpoint
    exists so the dashboard has a stable place to display future structured error logs."""
    error_actions = {
        "register_failed",
        "login_failed",
        "admin_login_failed",
        "dev_login_failed",
    }
    logs = (
        await UserLog.find({"action": {"$in": list(error_actions)}})
        .sort("-timestamp")
        .limit(limit)
        .to_list()
    )
    return [
        {
            "id": str(log.id),
            "action": log.action,
            "actor_id": log.user_id,
            "target_email": log.target_email,
            "timestamp": _iso_utc(log.timestamp),
        }
        for log in logs
    ]


# ---------- Notifications / Inbox ----------


def _notification_to_dict(n: Notification) -> dict:
    return {
        "id": str(n.id),
        "type": n.type,
        "title": n.title,
        "body": n.body,
        "severity": n.severity,
        "is_read": bool(n.is_read),
        "entity_id": n.entity_id,
        "entity_type": n.entity_type,
        "meta": n.meta or {},
        "created_at": _iso_utc(n.created_at),
    }


@router.get("/notifications")
async def list_notifications(
    response: Response,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    unread_only: bool = Query(False),
    _: User = Depends(require_developer),
):
    query: dict = {}
    if unread_only:
        query["is_read"] = False

    total = await Notification.find(query).count()
    unread = await Notification.find(Notification.is_read == False).count()  # noqa: E712
    items = (
        await Notification.find(query)
        .sort("-created_at")
        .skip((page - 1) * limit)
        .limit(limit)
        .to_list()
    )
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Unread-Count"] = str(unread)
    return {
        "items": [_notification_to_dict(n) for n in items],
        "total": total,
        "unread": unread,
    }


@router.get("/notifications/unread-count")
async def unread_count(_: User = Depends(require_developer)):
    """Cheap polling endpoint — only returns the unread count, used to drive the bell badge."""
    unread = await Notification.find(Notification.is_read == False).count()  # noqa: E712
    total = await Notification.find_all().count()
    latest = (
        await Notification.find_all().sort("-created_at").limit(1).to_list()
    )
    latest_id = str(latest[0].id) if latest else None
    return {"unread": unread, "total": total, "latest_id": latest_id}


@router.post("/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: str, _: User = Depends(require_developer)):
    try:
        n = await Notification.get(PydanticObjectId(notification_id))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid notification ID") from None
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")
    if not n.is_read:
        n.is_read = True
        await n.save()
    return {"ok": True, "is_read": True}


@router.post("/notifications/read-all")
async def mark_all_read(_: User = Depends(require_developer)):
    result = await Notification.get_motor_collection().update_many(
        {"is_read": False},
        {"$set": {"is_read": True}},
    )
    return {"ok": True, "modified": result.modified_count}


@router.delete("/notifications/{notification_id}")
async def delete_notification(notification_id: str, _: User = Depends(require_developer)):
    try:
        n = await Notification.get(PydanticObjectId(notification_id))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid notification ID") from None
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")
    await n.delete()
    return {"ok": True, "deleted_id": notification_id}


@router.delete("/notifications")
async def clear_notifications(
    only_read: bool = Query(True),
    _: User = Depends(require_developer),
):
    """Bulk-clear notifications. `only_read=true` keeps unread items in place."""
    query = {"is_read": True} if only_read else {}
    result = await Notification.get_motor_collection().delete_many(query)
    return {"ok": True, "deleted": result.deleted_count}


# ---------- Identity ----------


@router.get("/me")
async def me(actor: User = Depends(require_developer)):
    """Echo back the developer identity — useful for /dev frontend bootstrapping + RBAC checks."""
    return {
        "id": str(actor.id),
        "email": actor.email,
        "name": actor.name,
        "role": actor.role,
        "profile_photo": actor.profile_photo,
        "created_at": _iso_utc(actor.created_at),
    }
