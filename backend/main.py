"""Defectra API — FastAPI entry-point.

Start from repo root:
    uvicorn main:app --reload --host 0.0.0.0 --port 8010
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sys
from contextlib import asynccontextmanager
from pathlib import Path

_backend_dir = str(Path(__file__).resolve().parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from beanie import PydanticObjectId
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from config import get_settings

from db import init_db
from models import Defect, User
from utils.logging_setup import RequestIdMiddleware, configure_logging
from utils.security import hash_password, verify_password

configure_logging()
logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

_HEX_RE = re.compile(r"^[0-9a-f]{24}$")

_settings = get_settings()
_cors_origins = list(_settings.cors_origins)
_cors_allow_credentials = "*" not in _cors_origins


async def _seed_developer() -> None:
    """Sync bootstrap developer from DEVELOPER_EMAIL / DEVELOPER_PASSWORD into MongoDB on startup.

    The developer role sits above admin in the hierarchy (Developer → Admin → Standard User)
    and has full system-level access via /api/dev/* endpoints.
    """
    cfg = get_settings()
    email = cfg.developer_email
    password = cfg.developer_password
    if not email:
        logger.warning("DEVELOPER_EMAIL is empty; skipping bootstrap developer sync")
        return
    if not password:
        logger.warning("DEVELOPER_PASSWORD is empty; skipping bootstrap developer sync")
        return

    existing = await User.find_one(User.email == email)
    if existing:
        changed = False
        if existing.role != "developer":
            existing.role = "developer"
            changed = True
        if existing.is_disabled:
            existing.is_disabled = False
            changed = True
        if not verify_password(password, existing.password):
            existing.password = hash_password(password)
            changed = True
            logger.info("Bootstrap developer password synced from DEVELOPER_PASSWORD for %s", email)
        if changed:
            await existing.save()
        return

    user = User(
        email=email,
        password=hash_password(password),
        role="developer",
    )
    await user.insert()
    logger.info("Bootstrap developer created → %s", email)


async def _seed_admin() -> None:
    """Sync bootstrap admin from ADMIN_EMAIL / ADMIN_PASSWORD into MongoDB on startup."""
    cfg = get_settings()
    email = cfg.admin_email
    password = cfg.admin_password
    if not email:
        logger.warning("ADMIN_EMAIL is empty; skipping bootstrap admin sync")
        return
    if not password:
        logger.warning("ADMIN_PASSWORD is empty; skipping bootstrap admin sync")
        return

    existing = await User.find_one(User.email == email)
    if existing:
        changed = False
        if existing.role != "admin":
            existing.role = "admin"
            changed = True
        if existing.is_disabled:
            existing.is_disabled = False
            changed = True
        if not verify_password(password, existing.password):
            existing.password = hash_password(password)
            changed = True
            logger.info("Bootstrap admin password synced from ADMIN_PASSWORD for %s", email)
        if changed:
            await existing.save()
        return

    admins = await User.find(User.role == "admin").to_list()
    if len(admins) == 1 and admins[0].email != email:
        legacy = admins[0]
        if await User.find_one(User.email == email):
            logger.error(
                "Cannot migrate bootstrap admin to %s: that email is already registered.",
                email,
            )
            return
        logger.info(
            "Bootstrap admin email migrated from %s to %s (ADMIN_EMAIL)",
            legacy.email,
            email,
        )
        legacy.email = email
        legacy.password = hash_password(password)
        legacy.is_disabled = False
        await legacy.save()
        return

    user = User(
        email=email,
        password=hash_password(password),
        role="admin",
    )
    await user.insert()
    logger.info("Bootstrap admin created → %s", email)


async def _migrate_image_paths() -> None:
    """One-time migration: fix Defect records whose image_path uses
    a raw MongoDB ObjectId as the folder instead of the email prefix.

    For each affected record the function:
      1. Looks up the owning User to derive the correct email-prefix folder.
      2. If the file exists in the OLD (ObjectId) directory, moves it to the
         correct email-prefix directory and updates the DB record.
      3. If the file already exists at the CORRECT path (moved manually), just
         updates the DB record.
      4. If the file is truly missing at both locations, marks the record with
         image_path = "missing/<original>" so the UI can show a placeholder
         instead of a broken image.
    """
    all_defects = await Defect.find_all().to_list()
    fixed = 0
    missing = 0

    for defect in all_defects:
        parts = defect.image_path.split("/")
        if len(parts) < 3 or parts[0] != "uploads":
            continue
        folder = parts[1]
        if not _HEX_RE.match(folder):
            continue

        try:
            owner = await User.get(PydanticObjectId(defect.user_id))
        except Exception:
            owner = None

        if not owner:
            logger.warning(
                "migration: defect %s references unknown user %s — skipping",
                defect.id, defect.user_id,
            )
            continue

        email_prefix = owner.email.split("@")[0]
        safe_folder = re.sub(r"[^\w.\-]", "_", email_prefix)
        filename = parts[-1]
        correct_path = f"uploads/{safe_folder}/{filename}"

        old_file = UPLOADS_DIR / folder / filename
        new_dir = UPLOADS_DIR / safe_folder
        new_file = new_dir / filename

        if new_file.exists():
            defect.image_path = correct_path
            await defect.save()
            fixed += 1
            logger.info("migration: updated path for defect %s → %s", defect.id, correct_path)
        elif old_file.exists():
            new_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old_file), str(new_file))
            defect.image_path = correct_path
            await defect.save()
            fixed += 1
            logger.info("migration: moved file and updated defect %s → %s", defect.id, correct_path)
        else:
            defect.image_path = f"missing/{folder}/{filename}"
            await defect.save()
            missing += 1
            logger.warning(
                "migration: file missing for defect %s (old path: %s)", defect.id, defect.image_path,
            )

    if fixed or missing:
        logger.info("migration complete: %d fixed, %d marked missing", fixed, missing)
    else:
        logger.info("migration: no orphaned image paths found")


async def _migrate_unverified_users() -> None:
    """One-time migration: mark pre-existing users as verified.
    Targets users who have is_verified=false but no verification_code
    (i.e. they registered before the OTP feature existed)."""
    result = await User.find(
        {"is_verified": False, "verification_code": None}
    ).update_many({"$set": {"is_verified": True}})
    if result.modified_count:
        logger.info("migration: marked %d pre-existing users as verified", result.modified_count)


def _migrations_enabled() -> bool:
    return os.getenv("RUN_MIGRATIONS", "").strip().lower() in ("1", "true", "yes", "on")


def _enforce_secure_secrets() -> None:
    """Abort startup in production if insecure bundled defaults are still in use."""
    cfg = get_settings()
    problems = cfg.insecure_defaults()
    if not problems:
        return
    if cfg.is_production():
        for p in problems:
            logger.critical("INSECURE CONFIG (env=%s): %s", cfg.env, p)
        raise RuntimeError(
            "Refusing to start in a production environment with insecure default secrets: "
            + " | ".join(problems)
        )
    for p in problems:
        logger.warning("INSECURE CONFIG (env=%s, dev only): %s", cfg.env, p)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _enforce_secure_secrets()
    await init_db()
    await _seed_developer()
    await _seed_admin()
    # One-time data migrations do a full-collection scan + per-record lookups (N+1). Running them on
    # every boot makes startup scale with data size and can block/OOM deploys and rollbacks. Gate
    # them behind RUN_MIGRATIONS=1 so they run only when explicitly requested.
    if _migrations_enabled():
        logger.info("RUN_MIGRATIONS enabled — running one-time data migrations")
        await _migrate_image_paths()
        await _migrate_unverified_users()
    else:
        logger.info("RUN_MIGRATIONS not set — skipping one-time data migrations")
    yield
    # Shutdown: release the shared outbound HTTP client / connection pool.
    from services.http_client import aclose_client

    await aclose_client()


app = FastAPI(title="Defectra API", version="1.0.0", lifespan=lifespan)

app.add_middleware(RequestIdMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_allow_credentials,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

from routes.auth import router as auth_router
from routes.defect import router as defect_router
from routes.admin import router as admin_router
from routes.chat import router as chat_router
from routes.assistant import router as assistant_router
from routes.dev import router as dev_router

app.include_router(auth_router)
app.include_router(defect_router)
app.include_router(admin_router)
app.include_router(chat_router)
app.include_router(assistant_router)
app.include_router(dev_router)


@app.get("/api/health")
async def health():
    """Liveness + dependency check: 503 if MongoDB is unreachable so load balancers can react."""
    import asyncio

    from services.http_client import vllm_breaker

    mongo_ok = True
    try:
        await asyncio.wait_for(
            User.get_motor_collection().database.command("ping"), timeout=2.0
        )
    except Exception:
        mongo_ok = False
        logger.warning("health: MongoDB ping failed", exc_info=True)

    payload = {
        "status": "ok" if mongo_ok else "degraded",
        "mongo": "ok" if mongo_ok else "down",
        "vllm_circuit": "open" if vllm_breaker.is_open() else "closed",
    }
    return payload if mongo_ok else JSONResponse(payload, status_code=503)
