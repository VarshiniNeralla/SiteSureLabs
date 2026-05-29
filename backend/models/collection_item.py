from datetime import datetime, timezone

from beanie import Document
from pydantic import Field
from pymongo import ASCENDING, IndexModel


class CollectionItem(Document):
    """Pending live-inspection photos awaiting batch submit."""

    user_id: str
    image_path: str
    image_hash: str = ""
    project: str = ""
    tower: str
    floor: str
    flat: str
    room: str
    category: str = ""
    subcategory: str = ""
    description: str = ""
    file_name: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "inspection_collection"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("created_at", ASCENDING)]),
        ]
