"""MongoDB connection and Beanie ODM initialisation."""

from motor.motor_asyncio import AsyncIOMotorClient
from beanie import init_beanie

from config import get_settings
from models import (
    CollectionItem,
    Defect,
    Notification,
    User,
    UserLog,
    VisionAnalysisCache,
)


async def init_db() -> None:
    settings = get_settings()
    client = AsyncIOMotorClient(settings.mongodb_uri)
    await init_beanie(
        database=client[settings.mongodb_db],
        document_models=[
            User,
            Defect,
            UserLog,
            CollectionItem,
            VisionAnalysisCache,
            Notification,
        ],
    )
