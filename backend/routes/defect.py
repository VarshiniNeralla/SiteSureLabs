"""Live inspection upload endpoints."""

import logging
import os
import re
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from models import Defect, User, UserLog
from utils.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/defects", tags=["defects"])

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_defect(
    tower: str = Form(...),
    floor: str = Form(...),
    flat: str = Form(...),
    room: str = Form(...),
    description: str = Form(""),
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    if not tower.strip() or not floor.strip() or not flat.strip() or not room.strip():
        raise HTTPException(status_code=400, detail="All metadata fields are required")

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    user_id = str(user.id)

    email_prefix = user.email.split("@")[0]
    folder_name = re.sub(r"[^\w.\-]", "_", email_prefix)

    user_dir = UPLOADS_DIR / folder_name
    user_dir.mkdir(parents=True, exist_ok=True)

    ext = os.path.splitext(image.filename or "img.jpg")[1] or ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    file_path = user_dir / filename

    async with aiofiles.open(file_path, "wb") as f:
        content = await image.read()
        await f.write(content)

    if not file_path.exists() or file_path.stat().st_size == 0:
        logger.error("upload: file write failed for user %s → %s", user.email, file_path)
        raise HTTPException(status_code=500, detail="File storage failed — please retry")

    relative_path = f"uploads/{folder_name}/{filename}"

    defect = Defect(
        user_id=user_id,
        image_path=relative_path,
        tower=tower.strip(),
        floor=floor.strip(),
        flat=flat.strip(),
        room=room.strip(),
        description=description.strip(),
    )
    await defect.insert()

    await UserLog(user_id=user_id, action="upload").insert()

    logger.info(
        "upload: user=%s defect=%s path=%s size=%d bytes",
        user.email, defect.id, relative_path, file_path.stat().st_size,
    )

    return {
        "defect_id": str(defect.id),
        "image_path": relative_path,
    }


@router.get("/my")
async def my_defects(user: User = Depends(get_current_user)):
    defects = await Defect.find(Defect.user_id == str(user.id)).sort("-created_at").to_list()
    return [
        {
            "id": str(d.id),
            "image_path": d.image_path,
            "tower": d.tower,
            "floor": d.floor,
            "flat": d.flat,
            "room": d.room,
            "description": d.description,
            "created_at": d.created_at.isoformat(),
        }
        for d in defects
    ]
