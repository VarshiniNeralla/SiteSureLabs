"""Application settings (override with environment variables)."""

from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")


_load_dotenv()

from dataclasses import dataclass

# Bundled insecure defaults — safe for local dev, must never be used in production.
DEFAULT_JWT_SECRET = "sitesurelabsjwtsecret"
DEFAULT_ADMIN_PASSWORD = "admin@123"
DEFAULT_DEVELOPER_PASSWORD = "dev1234"
_PRODUCTION_ENVS = {"prod", "production", "staging"}


def _parse_cors_origins(raw: str) -> tuple[str, ...]:
    s = (raw or "").strip()
    if s == "*":
        return ("*",)
    parts = tuple(x.strip().rstrip("/") for x in s.split(",") if x.strip())
    return parts if parts else ("*",)


@dataclass(frozen=True)
class Settings:
    # MongoDB
    mongodb_uri: str
    mongodb_db: str

    # JWT
    jwt_secret: str
    jwt_algorithm: str
    jwt_expiry_hours: int

    # Default admin (seeded on first startup)
    admin_email: str
    admin_password: str

    # Default developer (seeded on first startup; highest privilege)
    developer_email: str
    developer_password: str

    # vLLM (kept for existing AI services)
    vllm_base_url: str
    vllm_model: str
    vllm_api_key: str
    vllm_temperature: float
    vllm_max_tokens: int
    http_timeout_s: float
    max_image_upload_mb: int
    defect_upload_max_mb: int
    inspection_chat_temperature: float
    landing_assistant_temperature: float
    # CORS: comma-separated origins, or "*" for development only (never use * behind a public URL)
    cors_origins: tuple[str, ...]
    # Deployment environment (development | staging | production)
    env: str

    def chat_completions_url(self) -> str:
        base = self.vllm_base_url.rstrip("/")
        return f"{base}/v1/chat/completions"

    def is_production(self) -> bool:
        return self.env.strip().lower() in _PRODUCTION_ENVS

    def insecure_defaults(self) -> list[str]:
        """Return human-readable problems for insecure bundled defaults (empty if safe)."""
        problems: list[str] = []
        if self.jwt_secret == DEFAULT_JWT_SECRET:
            problems.append(
                "JWT_SECRET is the bundled dev default — tokens can be forged. "
                "Set JWT_SECRET to a strong unique value (>= 32 bytes)."
            )
        if self.admin_password == DEFAULT_ADMIN_PASSWORD:
            problems.append(
                "ADMIN_PASSWORD is the bundled dev default 'admin@123' — set a strong ADMIN_PASSWORD."
            )
        if self.developer_password == DEFAULT_DEVELOPER_PASSWORD:
            problems.append(
                "DEVELOPER_PASSWORD is the bundled dev default 'dev1234' — set a strong DEVELOPER_PASSWORD."
            )
        return problems

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            # MongoDB
            mongodb_uri=os.getenv("MONGODB_URI", "mongodb://localhost:27017"),
            mongodb_db=os.getenv("MONGODB_DB", "defectra"),
            # JWT
            jwt_secret=os.getenv("JWT_SECRET", DEFAULT_JWT_SECRET),
            jwt_algorithm=os.getenv("JWT_ALGORITHM", "HS256"),
            jwt_expiry_hours=int(os.getenv("JWT_EXPIRY_HOURS", "24")),
            # Bootstrap admin (synced to MongoDB on startup — see main._seed_admin)
            admin_email=os.getenv("ADMIN_EMAIL", "admin@gmail.com").strip().lower(),
            admin_password=os.getenv("ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD),
            # Bootstrap developer (synced to MongoDB on startup — see main._seed_developer)
            developer_email=os.getenv("DEVELOPER_EMAIL", "dev@gmail.com").strip().lower(),
            developer_password=os.getenv("DEVELOPER_PASSWORD", DEFAULT_DEVELOPER_PASSWORD),
            # vLLM
            vllm_base_url=os.getenv("VLLM_BASE_URL", "http://127.0.0.1:8000").rstrip("/"),
            vllm_model=os.getenv("VLLM_MODEL", "gemma4-31b"),
            vllm_api_key=os.getenv("VLLM_API_KEY", ""),
            vllm_temperature=float(os.getenv("VLLM_TEMPERATURE", "0.3")),
            vllm_max_tokens=int(os.getenv("VLLM_MAX_TOKENS", "20000")),
            http_timeout_s=float(os.getenv("VLLM_HTTP_TIMEOUT_S", "300")),
            max_image_upload_mb=max(1, min(512, int(os.getenv("INSPECTION_MAX_IMAGE_MB", "48")))),
            defect_upload_max_mb=max(8, min(200, int(os.getenv("DEFECT_UPLOAD_MAX_MB", "48")))),
            inspection_chat_temperature=float(os.getenv("INSPECTION_CHAT_TEMPERATURE", "0.35")),
            landing_assistant_temperature=float(os.getenv("LANDING_ASSISTANT_TEMPERATURE", "0.42")),
            cors_origins=_parse_cors_origins(os.getenv("CORS_ORIGINS", "*")),
            env=(os.getenv("ENV") or os.getenv("APP_ENV") or "development").strip(),
        )


def get_settings() -> Settings:
    return Settings.from_env()
