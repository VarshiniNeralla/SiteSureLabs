from datetime import datetime, timezone

from beanie import Document
from pydantic import Field


class UserLog(Document):
    user_id: str
    action: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "user_logs"
