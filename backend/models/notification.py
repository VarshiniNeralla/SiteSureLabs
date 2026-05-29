from datetime import datetime, timezone
from typing import Optional

from beanie import Document
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel


class Notification(Document):
    """An event surfaced to the developer dashboard inbox.

    Notifications are stored centrally (not per-recipient) because the Developer Portal is
    the only consumer today. If we add admin-scoped or user-scoped notifications later,
    add a `recipient_role` filter field and an index — the read/unread mechanism is already
    decoupled per-notification.
    """

    type: str  # e.g. "user_registered", "admin_created", "system_alert"
    title: str
    body: str = ""
    severity: str = "info"  # "info" | "success" | "warning" | "error"
    is_read: bool = False
    # Loose pointer to the entity this notification refers to (user_id, defect_id, ...).
    entity_id: Optional[str] = None
    entity_type: Optional[str] = None
    # Free-form metadata so we don't need a schema change every time a new notification
    # type wants to surface one extra field on the UI.
    meta: dict = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "notifications"
        indexes = [
            IndexModel([("created_at", DESCENDING)]),
            IndexModel([("is_read", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("type", ASCENDING), ("created_at", DESCENDING)]),
        ]
