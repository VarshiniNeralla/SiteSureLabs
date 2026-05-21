"""Password hashing (bcrypt) and JWT token helpers."""

import hashlib
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from config import get_settings


def _jwt_signing_key() -> bytes:
    """HMAC-SHA256 needs >= 32 bytes; derive a stable key from short dev secrets."""
    raw = get_settings().jwt_secret.encode("utf-8")
    if len(raw) >= 32:
        return raw
    return hashlib.sha256(raw).digest()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def create_access_token(data: dict) -> str:
    settings = get_settings()
    payload = data.copy()
    payload["exp"] = datetime.now(timezone.utc) + timedelta(hours=settings.jwt_expiry_hours)
    return jwt.encode(payload, _jwt_signing_key(), algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    settings = get_settings()
    return jwt.decode(token, _jwt_signing_key(), algorithms=[settings.jwt_algorithm])
