# Production-Grade Codebase Audit — Defectra / SiteSureLabs

> Forensic full-stack production-readiness review. Every CRITICAL finding below was verified by
> direct file reads (not just agent summaries). File references are clickable: `path:line`.
>
> **Stack:** FastAPI + Beanie/Motor (MongoDB) backend · vanilla-JS/Vite frontend · local `uploads/`
> file storage · vLLM (OpenAI-compatible) AI · single Uvicorn process · **no queue/worker layer**
> (uploads, AI analysis, and report/PDF generation all run inside request/stream handlers).
>
> _Audit date: 2026-05-27_

---

## 1. Executive Summary

**Overall production-readiness: NOT READY (≈ 4/10).**

The application is functionally complete and its **auth model is fundamentally sound** — bcrypt
password hashing, role-gated admin routes (`require_admin` on every `/api/admin/*` endpoint),
immediate enforcement of disabled users on each request, chunked + size-limited defect uploads, a
path-traversal guard on image serving, and `.env` correctly gitignored. Those are real strengths
and reduce the remediation surface.

But the system will not survive enterprise-scale load or hostile traffic in its current form. The
failure modes are concrete and verified, not theoretical.

**Biggest architectural risk** — Everything is synchronous and in-process. CPU-heavy report
generation (PPTX/XLSX/PIL) and a 120-second Chromium PDF subprocess run **on the async event loop**
inside a single worker. One report export freezes the entire application for every other user.

**Biggest scaling risk** — No database indexes exist except `User.email`. Every query that filters
by `user_id` or a date range is a full collection scan, and several admin endpoints load entire
collections into memory with `find_all().to_list()`. Latency grows linearly with data; the first
endpoints to fail will be the user upload list and the admin dashboard.

**Biggest operational risk** — "One-time" data migrations run on **every startup** and include a
full-collection scan plus a per-record N+1 query. As data grows, boot time grows and may block or
OOM, which directly harms deploys and rollbacks (the worst time to be slow).

**Biggest security risk** — Two items tie. (1) The JWT signing secret has a **publicly-known
hardcoded default**; if `JWT_SECRET` is unset in production, anyone can forge an admin token. (2)
The entire `/api/chat/*` surface (AI chat, landing assistant, PDF export) is **completely
unauthenticated** and there is **no rate limiting anywhere**, so any anonymous client can drive
unlimited vLLM inference (direct cost) and spawn unlimited Chromium subprocesses (resource-exhaustion DoS).

**Immediate blockers for production (must fix first):**
1. Add MongoDB indexes (C1).
2. Make collection submit atomic / retry-safe (C2).
3. Move blocking report/PDF generation off the event loop (C3).
4. Authenticate AI/PDF endpoints + add rate limiting (C4).
5. Fix the vision-cache insert race + add TTL + error guards (C5).
6. Refuse insecure default secrets in production (C6).
7. Stop running migrations on every boot (C7).
8. Bound profile/chat upload memory + use async writes (C8).

---

## 2. Risk Matrix

| # | Issue | Severity | Root cause | Impact | Likelihood | Detection difficulty | Fix complexity | Priority |
|---|-------|----------|-----------|--------|-----------|---------------------|----------------|----------|
| C1 | No indexes on `Defect`/`CollectionItem`/`UserLog` | CRITICAL | `Settings` defines only `name` | Full scans; O(N) latency → timeouts | Certain | Medium (fine at low volume) | Small | 1 |
| C2 | Collection submit non-atomic + non-idempotent | CRITICAL | insert-then-delete loop, no claim/idem key | Duplicate / orphaned defects | Med-High | High (silent) | Medium | 2 |
| C3 | Blocking PPTX/XLSX/PIL/PDF subprocess on event loop | CRITICAL | sync CPU/subprocess in async, no `to_thread` | One export freezes whole app ≤120s | Certain | Medium | Medium | 3 |
| C4 | `/api/chat/*` unauthenticated + no rate limiting | CRITICAL | no `Depends`, no limiter | Free AI spend + Chromium DoS | High | Low | Medium | 4 |
| C5 | Vision cache insert race + no TTL + no error guard | CRITICAL | find→insert vs unique idx; no expiry | 500s; unbounded growth; Mongo blip 500s users | Medium | High | Medium | 5 |
| C6 | Forgeable JWT via known default secret | CRITICAL | hardcoded fallback secret + weak admin pw | Admin token forgery | Medium | Low | Small | 6 |
| C7 | Migrations run every boot (full scan + N+1) | CRITICAL | unconditional in `lifespan` | Slow/blocked boot; bad rollbacks | Certain | Medium | Small | 7 |
| C8 | Profile/chat upload read fully into memory + blocking write | CRITICAL | `read()` before size check; `write_bytes` | OOM on large upload; loop stall | Medium | Medium | Small | 8 |
| H1 | Admin `find_all().to_list()` unbounded (×4) | HIGH | no pagination | OOM listing all users/uploads | Medium | Medium | Medium | 9 |
| H2 | `upload-batch` not idempotent | HIGH | whole-batch retry re-inserts | Duplicate defects + files | Medium | High | Medium | 10 |
| H3 | Frontend dup-submit gaps (clear/submitAll) | HIGH | no in-flight guard / no re-enable | Double-delete; locked button | Medium | Low | Small | 11 |
| H4 | 401 hard-redirect mid-request; JWT in localStorage | HIGH | `location='/'`; XSS-readable token | Stuck UX; token theft via XSS | Medium | Medium | Medium | 12 |
| H5 | No per-phase httpx timeout; retry in 1 fn; no pooling | HIGH | single 300s scalar; fresh client/call | Slow vLLM starves loop | Medium | High | Medium | 13 |
| H6 | Dashboard loads 30 days into memory then aggregates | HIGH | `.to_list()` + loops vs `$group` | Memory spike; slow dashboard | Medium | Medium | Medium | 14 |
| H7 | Report = N sequential per-item AI calls; 1 failure aborts | HIGH | no batching/partial-failure | 50-item report fails on 1 error | Medium | Medium | Medium | 15 |
| H8 | SSE disconnect undetected; partial output cached | HIGH | unconditional cache write; yield-before-validate | Incomplete analysis served as deterministic | Medium | High | Medium | 16 |
| M1 | Construction classifier fails open on vLLM down | MEDIUM | design choice | Wasted AI spend during outage | Medium | Medium | Small | 17 |
| M2 | No PIL decompression-bomb guard | MEDIUM | unguarded `Image.open` on untrusted input | Crafted image → memory exhaustion | Low | High | Small | 18 |
| M3 | HEIC/data-URL size-check after decode | MEDIUM | decode-then-check | Memory spike on large inputs | Low | Medium | Small | 19 |
| M4 | Email enumeration on register; weak pw (min 4) | MEDIUM | distinct 409 + weak policy | Account discovery + brute-force | Medium | Low | Small | 20 |
| M5 | "Disable last admin" TOCTOU | MEDIUM | count-then-save | Admin lockout (0 enabled) | Low | High | Small | 21 |
| M6 | Admin polling ignores tab visibility | MEDIUM | timers run while hidden | Battery/bandwidth/API waste | High | Low | Small | 22 |
| M7 | No streaming-read timeout (frontend) | MEDIUM | `reader.read()` unbounded | UI frozen if server stalls | Medium | Medium | Small | 23 |
| L1 | Name regex rejects accents/hyphens/apostrophes | LOW | ASCII-only regex | Valid users can't register | High | Low | Small | 24 |
| L2 | Object-URL / observer / listener leaks | LOW | missing revoke/disconnect | Slow memory growth | Medium | High | Small | 25 |
| L3 | Committed `.tmp-lighthouse-*.json`; dir/file duplication | LOW | repo hygiene | Confusion, dead code | Certain | Low | Small | 26 |

---

## 3. Detailed Findings (by domain)

### Authentication & Security
- **C6 — Forgeable JWT.** [config.py:71-74](backend/config.py#L71-L74) ships a hardcoded default
  `JWT_SECRET` and [security.py:14-17](backend/utils/security.py#L14-L17) uses it directly (≥32
  bytes). If the env var is unset in production, the signing key is public knowledge → any actor can
  mint a `{"sub": "<admin id>", "role": "admin"}` token. The default admin password `admin@123`
  ([config.py:79](backend/config.py#L79)) compounds it.
- **C4 — Unauthenticated AI surface.** [chat.py:38-125](backend/routes/chat.py#L38-L125):
  `/api/chat/session`, `/message/stream`, `/landing/stream`, `/inspection-pdf` have **no auth
  dependency**. Anyone can consume vLLM tokens and trigger Chromium PDF renders.
- **M4 — Account enumeration + weak policy.** Register returns a distinct `409 "Email already
  registered"` ([auth.py:72](backend/routes/auth.py#L72)) (login is correctly generic). Password
  minimum is 4 chars ([auth.py:53](backend/routes/auth.py#L53)). No login rate limiting → brute-force viable.
- **M5 — Disable-last-admin TOCTOU.** [admin.py:1146](backend/routes/admin.py#L1146) checks
  `_count_enabled_admins() <= 1` then saves; two concurrent disables can both pass → 0 enabled admins.
- **L1 — Name regex** `[A-Za-z]+(?: [A-Za-z]+)*` ([auth.py:60](backend/routes/auth.py#L60)) rejects
  `O'Brien`, `Jean-Pierre`, `José`.
- **Positives:** bcrypt hashing; `require_admin` on all admin routes; disabled-user enforced per
  request ([deps.py:29](backend/utils/deps.py#L29)); `decode_access_token` pins the algorithm;
  image-serving path-traversal guard (`_safe_image_abs_path`, admin.py ~522); `.env` gitignored.

### Database
- **C1 — No indexes.** [models/defect.py:20](backend/models/defect.py#L20),
  [collection_item.py:23](backend/models/collection_item.py#L23),
  [user_log.py:17](backend/models/user_log.py#L17) define only `name`. Only `User.email` is indexed.
  Every `Defect.find(user_id==...)`, `CollectionItem.find(user_id==...)`, `UserLog.find(...)`, and
  every `created_at`/`timestamp` sort is a collection scan.
- **H1 — Unbounded loads.** `find_all().to_list()` at [admin.py:1084](backend/routes/admin.py#L1084)
  (all users), [1279](backend/routes/admin.py#L1279) (all uploads),
  [1480](backend/routes/admin.py#L1480) (bulk delete "all"), [2149](backend/routes/admin.py#L2149)
  (debug). Also `get_logs` ([1439](backend/routes/admin.py#L1439)) with no limit.
- **H6 — In-memory dashboard.** [admin.py:1848-1849](backend/routes/admin.py#L1848-L1849) loads 30
  days of defects + logs into Python lists then aggregates in nested loops (`get_workspace_dashboard`
  ~290 lines). Should be MongoDB `$group` aggregation (the `/users` and `/stats` endpoints already
  do this correctly — inconsistent).
- **Connection tuning.** [db.py:12](backend/db.py#L12) creates `AsyncIOMotorClient` with no
  `maxPoolSize`/`serverSelectionTimeoutMS`/timeouts; no try/except around queries → Mongo errors
  surface as raw 500s.
- **Transactions** are unavailable on standalone Mongo (the Docker default), which is why C2 uses an
  atomic single-document claim instead of a multi-document transaction.

### Uploads & File/Media Processing
- **C8 — Unbounded read + blocking write.** [auth.py:231-245](backend/routes/auth.py#L231-L245):
  `photo.read()` loads the whole file before the 5MB check, then `out_path.write_bytes()` blocks the
  loop. Chat image [chat.py:65](backend/routes/chat.py#L65) also `read()`s fully with no limit. The
  defect path is correct (`_read_upload_with_limit` streams + aborts at the cap,
  [defect.py:29](backend/routes/defect.py#L29)) and should be reused.
- **M2 — No decompression-bomb guard.** `PILImage.open` on untrusted images (admin.py 384/544,
  [image_format.py](backend/services/image_format.py), [inspection_pdf_html.py:93](backend/services/inspection_pdf_html.py#L93))
  with no `Image.MAX_IMAGE_PIXELS`.
- **M3 — Size-check after decode.** Data-URL parse decodes base64 before the 30MB check
  ([inspection_pdf_html.py:56](backend/services/inspection_pdf_html.py#L56)); HEIC conversion loads
  the whole image ([image_format.py](backend/services/image_format.py)).
- **Content-type trust.** Uploads validate only the client-supplied `content_type` prefix
  (`image/`), not magic bytes — spoofable. (Files are stored under UUID names, which limits the risk.)

### Async Processing & Reporting Pipelines
- **C3 — Event-loop blocking.** PPTX (`Presentation()`, [admin.py:728](backend/routes/admin.py#L728)),
  XLSX (`Workbook()`, [admin.py:877](backend/routes/admin.py#L877)), PIL prep (admin.py 384/544), and
  the Chromium PDF `subprocess.run(...)` ([inspection_pdf_puppeteer.py:34](backend/services/inspection_pdf_puppeteer.py#L34),
  called sync from [chat.py:108](backend/routes/chat.py#L108)) all run synchronously in async
  handlers. No `run_in_executor`/`to_thread` anywhere. On one worker, any of these stalls **all**
  concurrent requests (PDF up to 120s).
- **H7 — N+1 report AI.** Report generation drives N sequential calls from the browser to
  `/api/admin/reports/analyze-item` ([admin.py:1297](backend/routes/admin.py#L1297)); a single
  transient vLLM failure aborts the whole report with no partial save.
- **H5 — Fragile external calls.** [generate_client.py](backend/services/generate_client.py) creates
  a fresh `httpx.AsyncClient` per call (lines 233/331/519/603/673), one 300s scalar timeout (no
  connect/read/write split), retry only in `generate_executive_defect_report` ([line 399](backend/services/generate_client.py#L399))
  with no backoff. No circuit breaker.
- **H8 — SSE correctness.** On stream paths (519+/603+), chunks are yielded before the error object
  is validated, and the assembled output is cached unconditionally if any text was collected — a
  client disconnect mid-stream can cache a **partial** analysis that is then served as the
  "deterministic" cached result.
- **M1 — Fail-open classifier.** `classify_construction_site_image` returns `True` on any vLLM
  error ([generate_client.py:238](backend/services/generate_client.py#L238)+) → during an outage,
  every image (even non-construction) is analyzed, wasting spend.

### Vision Analysis Cache
- **C5 — Insert race / no TTL / no guard.** All three `store_*` do `find_one` → `insert`
  ([vision_analysis_cache.py:62-140](backend/services/vision_analysis_cache.py#L62-L140)); the unique
  `cache_key` index ([model:10](backend/models/vision_analysis_cache.py#L10)) means two concurrent
  identical stores collide → the loser raises an **unhandled `DuplicateKeyError` → 500**. No TTL on
  the collection ([model Settings:22](backend/models/vision_analysis_cache.py#L22)) → unbounded
  growth. No try/except around reads/writes → any Mongo blip 500s the user request. Also a cache
  **stampede**: concurrent identical misses both call vLLM (no lock).

### Frontend
- **H3 — Duplicate-submit gaps.** `clearCollectionBtn` ([live.js ~1586](frontend/live.js#L1586)) is
  not disabled during its DELETE (double-click → double delete). `submitCollectionBatch`
  ([live.js ~1510](frontend/live.js#L1510)) disables the button but error paths can leave it disabled
  (relies on a later re-render to re-enable). _Good:_ single-upload `submitBtn` (re-validates in
  `finally`) and chat `sendBtn` (busy flag + `AbortController`) are correctly guarded.
- **H4 — 401 + token storage.** `apiFetch` ([auth.js:63-66](frontend/shared/auth.js#L63-L66)) hard-
  redirects on any 401, abandoning in-flight UI (spinner stuck) and forcing every caller to null-
  check `res`. JWT lives in `localStorage` ([auth.js:7](frontend/shared/auth.js#L7)) → readable by
  any injected script (admin page has ~4,000 lines of inline JS — large XSS surface).
- **M6 — Polling ignores visibility.** Admin background sync (28s/35s intervals) keeps running while
  the tab is hidden (no `visibilitychange` gate).
- **M7 — No stream-read timeout** in the AI chat reader → a stalled server hangs the UI until the
  user clicks Stop.
- **L2 — Minor leaks.** Some `URL.createObjectURL` (fly-to-collection animation) and a `ResizeObserver`
  are never revoked/disconnected.

### Infrastructure & Observability
- Single Uvicorn worker; local `uploads/` disk (not shareable across hosts); single Mongo; ngrok/nginx
  for sharing. **No structured logging, no request IDs, no metrics, no error tracking, no alerts.**
  `/api/health` exists ([main.py:224](backend/main.py#L224)) but only returns `{"status":"ok"}`
  (does not check Mongo/vLLM). No rate limiting / `TrustedHost` / GZip middleware.
- **C7 — Boot-time migrations.** `lifespan` ([main.py:190-196](backend/main.py#L190-L196)) runs
  `_migrate_image_paths` (`Defect.find_all()` + per-record `User.get()` — N+1, [main.py:120](backend/main.py#L120))
  and `_migrate_unverified_users` on every startup.

---

## 4. God Files & Massive Functions

| File | Lines | Dependencies / shape | Risk | Recommendation |
|------|------:|----------------------|------|----------------|
| [frontend/admin/index.html](frontend/admin/index.html) | 9,453 | ~4,000 lines inline `<script type=module>` + ~5,400 inline CSS | CRITICAL | Extract to Vite-bundled `admin/*.js` modules (stats, uploads, users, reports, logs); move CSS out. Shrinks XSS surface + payload. |
| [frontend/style.css](frontend/style.css) | 8,026 | global | MEDIUM | Split per page; purge unused. |
| [backend/routes/admin.py](backend/routes/admin.py) | 2,174 | PIL, pptx, openpyxl, Beanie, Motor | HIGH | Extract `services/report_xlsx.py`, `report_pptx.py`, `report_images.py`, `admin_analytics.py`. `get_workspace_dashboard` (~1823-2112, 290 lines) → aggregation. `_build_report_workbook` (~877-1042, 170 lines) and `_build_report_presentation` (~728-869, 140 lines) are the heaviest functions. |
| [frontend/live.js](frontend/live.js) | 1,862 | DOM, fetch | MEDIUM | Split capture / collection / past-uploads; centralize fetch + dup-guards. |
| [frontend/ai-analysis.js](frontend/ai-analysis.js) | 1,378 | fetch/SSE | MEDIUM | Extract reusable SSE client + chat state machine. |
| [backend/services/generate_client.py](backend/services/generate_client.py) | 696 | httpx | HIGH | One shared `AsyncClient` + a single resilient `_post`/`_stream` helper (per-phase timeout, retry+backoff); the 5 callers dedupe onto it. |

---

## 5. Failure Cascade Analysis

- **MongoDB slow/unavailable →** queries have no try/except → raw 500s to users; `lifespan` migration
  scan can **block startup** on a large/slow DB → failed deploy/rollback (worst possible timing).
- **vLLM slow/down →** 300s scalar timeout pins the request; combined with sync work elsewhere the
  single event loop starves → even healthy endpoints (and `/api/health`) time out. Classifier fails
  open → wasted spend. No circuit breaker to shed load.
- **One report/PDF export →** blocking PPTX/XLSX/PIL or a 120s Chromium subprocess freezes the lone
  worker → every concurrent user observes a hang. **Most likely "the whole app froze" incident.**
- **Retry storm →** non-idempotent submit & upload-batch + unauthenticated, unthrottled `/api/chat/*`
  → duplicated DB rows/files and amplified AI cost; a client retry loop becomes a self-inflicted DoS.
- **Single points of failure →** one process, one local disk for `uploads/`, one Mongo. No graceful
  degradation path anywhere; a dependency blip becomes a user-visible 500.

---

## 6. Scalability Analysis

- **First wall (arrives early):** unindexed `user_id`/date queries + `find_all()` → linear latency
  growth. `/api/defects/my` and the admin dashboard degrade first.
- **Concurrency wall:** single worker + blocking report/PDF/image work → effective concurrency ≈ 1
  whenever any heavy operation runs.
- **Memory wall:** whole-file uploads in memory, all report images held in memory simultaneously,
  30-day in-memory dashboard, and an unbounded cache collection.
- **Most expensive operations:** PDF render (Chromium subprocess, ≤120s), multi-image XLSX/PPTX
  build, per-item report AI calls, vLLM vision inference (max_tokens 20000, 300s timeout).
- **Horizontal-scaling blockers:** local file storage (needs S3/shared volume); in-process chat
  sessions ([inspection_sessions.py](backend/services/inspection_sessions.py)) and any in-process
  rate-limit/lock (need a shared store); no shared cache (needs Redis); Mongo must become a replica
  set before multi-document transactions are possible.

---

## 7. Refactoring Roadmap

### Phase 1 — Critical Stabilization (implemented now: C1–C8)
- **Objective:** remove OOM, data-corruption, event-loop-freeze, forged-token, and free-AI risks.
- **Modules:** `models/*`, `routes/defect.py`, `routes/auth.py`, `routes/chat.py`, `routes/admin.py`,
  `services/vision_analysis_cache.py`, `services/inspection_pdf_puppeteer.py`, `config.py`, `main.py`,
  new `utils/uploads.py` (+ frontend auth header for chat).
- **Tasks:** indexes (C1); atomic claim-based submit (C2); `to_thread` offload (C3); auth + rate
  limit on AI/PDF (C4); cache upsert + TTL + guards (C5); insecure-secret startup guard (C6); gate
  migrations (C7); bounded async uploads (C8).
- **Risk reduction:** eliminates the top failure-cascade triggers. **Regression risks:** C4 (frontend
  must send token), C3 (no async calls inside offloaded fns). **Validation:** §8 verification.

### Phase 2 — Scalability Hardening
- Admin + `/defects/my` pagination (H1); dashboard/analytics → aggregation (H6); shared resilient
  httpx client w/ per-phase timeouts + retry/backoff + circuit breaker (H5); batched, partial-failure
  report AI (H7); SSE disconnect detection + no-cache-on-partial (H8); `upload-batch` idempotency
  keys (H2); object storage for `uploads/`. Mongo connection-pool/timeout tuning + real `/health`.

### Phase 3 — Architecture Cleanup
- Decompose `admin.py` into report/analytics services; extract admin inline JS into Vite-bundled
  modules; remove `routers/` + `promptpy_original.py` duplication and committed `.tmp-lighthouse-*`
  (L3); centralize frontend fetch + duplicate-submit guards (H3/H4); fix object-URL/observer leaks (L2).

### Phase 4 — Production Optimization
- Redis (shared cache, locks, rate limiting); background worker (Celery/RQ/arq) for report & PDF;
  structured logging + request IDs + metrics + error tracking + alerts; decompression-bomb +
  magic-byte upload validation (M2/M3); httpOnly-cookie auth + CSP (H4); graceful Mongo/vLLM
  degradation; CI test suite (unit + integration against a real Mongo).

---

## 8. Production Readiness Checklist

**Reliability** — [x*] idempotent collection submit (C2) · [x²] idempotent upload/upload-batch (H2) · [x*] no event-loop blocking (C3) · [x²] report partial-failure resilience (H7) · [~] graceful degradation (vLLM via H5; Mongo: /health 503 + cache guard, query-level pending)
**Scalability** — [x*] indexes (C1) · [x²] pagination + memory caps (H1) · [x²] dashboard memory bounded — projected rows, redundant query removed (H6; full `$group` still pending) · [ ] object storage
**Security** — [x*] auth on expensive endpoints (C4) · [x*] rate limiting (C4) · [x*] secret validation (C6) · [x²] decompression-bomb guard + pre-decode size caps (M2/M3) · [x²] magic-byte upload validation (all upload paths) · [ ] no localStorage token (H4)
**Observability** — [x²] structured logs (LOG_FORMAT=json) · [x²] request IDs (X-Request-ID, correlated in every log line) · [ ] metrics · [ ] error tracking · [ ] alerts
**Fault tolerance** — [~] Mongo degradation pending / [x²] vLLM degradation (H5) · [x²] circuit breaker (H5) · [x²] retry+backoff (H5) · [x*] cache error guard (C5)
**Deployability** — [x*] gated migrations (C7) · [x*] config validation (C6) · [x²] real `/health` (Mongo ping → 503 + vLLM circuit state)
**Rollback safety** — [x*] no every-boot migrations (C7)
**Recovery readiness** — [ ] orphan cleanup · [x*] cache eviction/TTL (C5)
**Infra readiness** — [ ] multi-worker · [ ] shared storage · [ ] Redis · [ ] Mongo replica set (for transactions)

> `[x*]` = Phase 1 stabilization · `[x²]` = Phase 2 hardening (this change set) · `[~]` = partial · `[ ]` = remaining.
