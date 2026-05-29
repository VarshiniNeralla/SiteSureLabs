from datetime import datetime, timezone
from typing import Optional

from beanie import Document
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel


class UserLog(Document):
    """user_id is the actor (e.g. admin). For admin actions, target_* identify the subject."""

    user_id: str
    action: str
    target_user_id: Optional[str] = None
    target_email: Optional[str] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "user_logs"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("timestamp", DESCENDING)]),
            IndexModel([("timestamp", DESCENDING)]),
            IndexModel([("target_user_id", ASCENDING)]),
        ]
