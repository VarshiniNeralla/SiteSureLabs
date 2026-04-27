# Defectra — Defect Inspection System

A defect inspection MVP with FastAPI + MongoDB (Beanie ODM) backend and a vanilla JS frontend.

## Prerequisites

- **Python 3.12+** (managed via [uv](https://docs.astral.sh/uv/))
- **Node.js 22** (for the Vite frontend dev server)
- **MongoDB** running on `localhost:27017`

### Start MongoDB via Docker

```bash
docker run -d --name defectra-mongo -p 27017:27017 mongo:7
```

## Quick Start

### 1. Environment

```bash
cp .env.example .env
```

### 2. Backend

```bash
uv pip install -r backend/requirements.txt
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8010
```

On first startup a default admin is seeded:

| Email                  | Password   |
|------------------------|------------|
| `admin@defectra.com`   | `admin123` |

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173/login/** in a browser.

## Pages

| URL               | Description                        |
|--------------------|------------------------------------|
| `/login/`          | Login (email + password)           |
| `/register/`       | Register a new user account        |
| `/inspect/`        | User dashboard — Live Inspection   |
| `/admin/`          | Admin dashboard (admin role only)  |

## API Endpoints

### Auth

| Method | Path                  | Description          |
|--------|-----------------------|----------------------|
| POST   | `/api/auth/register`  | Register a new user  |
| POST   | `/api/auth/login`     | Login, get JWT token |

### Defects (requires Bearer token)

| Method | Path                  | Description                        |
|--------|-----------------------|------------------------------------|
| POST   | `/api/defects/upload` | Upload defect image + metadata     |
| GET    | `/api/defects/my`     | List current user's defects        |

### Admin (requires admin token)

| Method | Path                              | Description              |
|--------|-----------------------------------|--------------------------|
| GET    | `/api/admin/users`                | List all users           |
| GET    | `/api/admin/users/{id}`           | Get user detail          |
| GET    | `/api/admin/users/{id}/uploads`   | List user's uploads      |
| GET    | `/api/admin/logs`                 | Activity logs (optional date filter) |
| GET    | `/api/admin/stats`                | Dashboard stats          |

### Health

| Method | Path          | Description   |
|--------|---------------|---------------|
| GET    | `/api/health` | Health check  |

## Project Structure

```
backend/
├── main.py            # FastAPI app, lifespan, routers
├── db.py              # MongoDB / Beanie init
├── config.py          # Settings from .env
├── models/
│   ├── user.py        # User document
│   ├── defect.py      # Defect document
│   └── user_log.py    # UserLog document
├── routes/
│   ├── auth.py        # Register + Login
│   ├── defect.py      # Upload + list defects
│   └── admin.py       # Admin-only endpoints
└── utils/
    ├── security.py    # bcrypt + JWT helpers
    └── deps.py        # Auth dependencies

frontend/
├── login/             # Login page
├── register/          # Registration page
├── inspect/           # User dashboard (Live Inspection)
├── admin/             # Admin dashboard
└── shared/
    ├── styles.css     # Shared CSS
    └── auth.js        # Auth token helpers

uploads/               # Local image storage (auto-created)
```
