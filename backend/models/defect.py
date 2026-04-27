from datetime import datetime, timezone

from beanie import Document
from pydantic import Field


class Defect(Document):
    user_id: str
    image_path: str
    tower: str
    floor: str
    flat: str
    room: str
    description: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "defects"
