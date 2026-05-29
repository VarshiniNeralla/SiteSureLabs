from datetime import datetime, timezone
from typing import Optional

from beanie import Document
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel


class Defect(Document):
    user_id: str
    image_path: str
    project: str = ""
    tower: str
    floor: str
    flat: str
    room: str
    category: str = ""
    subcategory: str = ""
    description: str = ""
    # Optional client-supplied idempotency key: a retried upload with the same (user_id, key) is
    # deduplicated instead of creating a second Defect. None for normal/legacy uploads.
    client_dedupe_key: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "defects"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("created_at", DESCENDING)]),
            # Partial unique index: enforce idempotency only for docs that carry a string key,
            # so the many existing/legacy docs (null key) are unaffected.
            IndexModel(
                [("user_id", ASCENDING), ("client_dedupe_key", ASCENDING)],
                unique=True,
                partialFilterExpression={"client_dedupe_key": {"$type": "string"}},
            ),
        ]
