# Capacity, Concurrency & Bottleneck Analysis — SiteSureLabs / Defectra

> Hardware-aware, code-grounded capacity model. Estimates are **conservative** and tied to
> file/line evidence. Every assumption is stated. Stack analyzed as it exists in the repo on
> branch `feature-ai-analysis`, audit date 2026-05-27.
>
> Companion to `PRODUCTION_AUDIT.md` (code-correctness review). This document is the
> **capacity/throughput** view.

---

## 0. Critical reality check (read this first)

Three premises in the request do **not** match the code, and they change the math:

1. **There is no Docker.** No `Dockerfile`, no `docker-compose.yml`, no `.dockerignore` are tracked
   anywhere (`git ls-files` confirms). The real deployment is **native Windows**:
   - `start-share.ps1:32-37` launches `uvicorn main:app --host 127.0.0.1 --port 8010` — **no
     `--workers` flag → exactly ONE worker process / ONE event loop / ONE GIL.**
   - `nginx.exe` (WinGet build 1.29.8) reverse-proxies `127.0.0.1:8080` → `127.0.0.1:8010`.
   - `ngrok.exe http http://127.0.0.1:8080` is the public tunnel.
   - MongoDB is reached at `mongodb://localhost:27017` (`config.py:92`, default — `.env` doesn't
     even override it).
   - vLLM is a **separate external process** at `http://127.0.0.1:8000` (`.env:2`). It is NOT
     started or managed by this repo; there is no launch script, so its flags
     (quantization, `--gpu-memory-utilization`, `--max-num-seqs`, `--max-model-len`) are **unknown**
     and are the single biggest source of estimate variance.

   → "Docker resource allocation" and "Docker networking overhead" are **non-issues** as written.
   The real overhead is the **Windows loopback + ngrok edge hop**, analyzed in §16–17. If you *do*
   run Mongo/vLLM in Docker Desktop (WSL2) on this same box, that adds a WSL2 memory balloon and a
   NAT hop — see §27.

2. **"Gemma 4 31B" is not a real published model.** Google's largest Gemma 3 is **27B** (multimodal:
   27B LM + SigLIP vision tower). `VLLM_MODEL=gemma4-31b` (`.env:3`) is a local `--served-model-name`
   label. Whatever it is, it is a **~27–31B vision-language model**, and **it cannot run unquantized
   on a 32 GB RTX 5090** (BF16 weights alone = 54–62 GB). So it is necessarily **quantized**, and
   *which* quantization is the dominant capacity variable (§3).

3. **"Local desktop machine hosting everything"** means the GPU box is *also* running MongoDB, nginx,
   the Python worker, and **Chromium PDF subprocesses** (`inspection_pdf_puppeteer.py:34`). These
   compete with vLLM for CPU, RAM, and PCIe — they do not get a clean GPU. This is a co-tenancy
   penalty most cloud-style estimates ignore.

**One-line answer:** in its current single-worker, single-GPU, ngrok-fronted form, this system
realistically serves **~15–25 concurrently active users**, of whom only **~4–6 can be doing AI
inference at the same instant** before latency and queueing degrade the experience for everyone.

---

## 1. System architecture (as built)

```
                       Public internet
                             │  TLS
                             ▼
                    ngrok edge (tunnel)            ← bandwidth + connection caps, +30–120ms RTT
                             │  HTTP (outbound tunnel to agent)
                             ▼
                 nginx.exe  127.0.0.1:8080         ← rate-limit zones, 52m body cap, SSE buffering off
              ┌──────────────┴───────────────┐
              ▼                               ▼
   static  frontend/dist               API  uvicorn 127.0.0.1:8010
   (Vite build, vanilla JS)            ── SINGLE worker, 1 event loop, 1 GIL ──
                                           │            │                 │
                                           ▼            ▼                 ▼
                                   MongoDB 27017   vLLM 127.0.0.1:8000   Node/Chromium
                                   (Motor/Beanie)  (OpenAI-compat)       (Puppeteer PDF subprocess)
                                                        │
                                                        ▼
                                                   RTX 5090 32GB  (the real ceiling)
```

- **Frontend:** static Vite build (`frontend/dist`), vanilla JS. `admin/index.html` is 9,453 lines
  (~4k inline JS). Streaming via **SSE, not WebSockets** (`ENTERPRISE-DEPLOY.md:113`).
- **Backend:** FastAPI + Beanie/Motor. Fully `async`. CPU-bound work (XLSX/PPTX/PIL/PDF) is offloaded
  with `asyncio.to_thread` (`admin.py:1445,1469`; `chat.py:124`) — good, but see §4 (GIL) and §24.
- **AI:** vLLM OpenAI-compatible `/v1/chat/completions`, pooled `httpx.AsyncClient`
  (`http_client.py:58-70`), circuit breaker + retry/backoff (`http_client.py:81-169`).
- **Storage:** images on **local disk** `./uploads/<email-prefix>/<uuid>.<ext>` (`defect.py:95`),
  served via `StaticFiles` (`main.py:244`). Not shareable across hosts → horizontal-scaling blocker.
- **State:** chat sessions are **in-process dicts holding raw image bytes** (`inspection_sessions.py:26`,
  `InspectionSession.image_bytes`) — no eviction/TTL (§19).

---

## 2. The workload, costed per action

| User action | Path | GPU cost | CPU/IO cost | Notes |
|---|---|---|---|---|
| Login / register | `auth.py` | none | bcrypt hash (~50–100 ms, CPU) | bcrypt is deliberately slow |
| Live upload (1 img) | `defect.py:148` | none | chunked read + async disk write + 2 Mongo inserts | cheap |
| Batch upload (N img) | `defect.py:177` | none | **sequential** loop of N single uploads | one request, N×IO |
| Collection submit | `defect.py:459` | none | N × (`find_one_and_delete` + insert) | atomic per item |
| **AI Analysis (image)** | `chat.py:66` → `inspection_chat_service.py:244` | **classify (≤128 tok) + full vision stream (≤20000 tok)** | image held in session RAM | **2 vision inferences/photo** |
| AI follow-up (text) | `inspection_chat_service.py:301` | 1 text generation, context = system+analysis+last 20 turns | none | context grows with chat |
| **Report item analyze** | `admin.py:1341` | **classify + executive vision (≤20000 tok)** per defect | image read in thread | driven **sequentially** ×N from browser |
| Report XLSX/PPTX build | `admin.py:1437/1461` | none | openpyxl/pptx + PIL, in `to_thread` | GIL-bound, holds all imgs in RAM |
| Inspection PDF | `chat.py:111` | none | **Chromium subprocess ≤120 s** | 1 process per request |
| Dashboard / lists | `admin.py` | none | Mongo aggregations / paginated finds | indexed now |

**The decisive fact:** the two core workflows (AI Analysis and Report generation) both spend almost
all their wall-clock inside **vLLM vision inference**, and `max_tokens=20000` (`.env:10`,
`config.py:106`) caps each generation absurdly high. A single GPU is the throughput governor.

---

## 3. GPU / VRAM / CUDA — the binding constraint

**RTX 5090 (Blackwell GB202):** 32 GB GDDR7, **~1.79 TB/s** memory bandwidth, 21,760 CUDA cores,
~575 W TDP, **consumer card** (no NVLink, single GPU, no ECC). Decode throughput for LLMs is
**memory-bandwidth bound**, so 1.79 TB/s and 32 GB are the numbers that matter, not the FLOPs.

A 27–31B VLM **does not fit in BF16** (54–62 GB). It must be quantized. Three realistic scenarios —
**you must confirm which one you actually run, because capacity changes ~6×:**

| Scenario | Weights | Free for KV (gpu_util 0.9, ~2GB CUDA ctx, ~1–2GB vision/activations) | KV tokens @ ~0.5 MB/tok (FP16 KV)¹ | Concurrent vision seqs² | Verdict |
|---|---|---|---|---|---|
| **A — INT4 / AWQ / GPTQ** | ~13.5–15.5 GB | **~12–14 GB** | ~24k–28k | **~6–8** | the only sane config for 32 GB; assume this |
| **B — FP8 / W8A8** | ~27–31 GB | ~1–3 GB (31B: ~0 → won't load with KV) | ~2k–6k | **~1–2** | near-serial; 31B-FP8 likely OOM at start |
| **C — BF16/FP16** | 54–62 GB | — | — | **0** | does not load on 32 GB |

¹ KV/token for a Gemma-3-27B-shaped model (≈62 layers, 16 KV heads, head_dim 128, FP16 KV):
`2 × 62 × 16 × 128 × 2 B ≈ 0.5 MB/token`. FP8 KV cache halves this (~0.25 MB/tok), roughly doubling
seat count. ² "Concurrent sequences" = how many generations vLLM can keep in its running batch before
KV pressure forces queueing/preemption — **not** a config flag.

**Vision prefill:** each image is encoded to a fixed token block (Gemma-3 ≈ 256 tokens/image, more
with pan-and-scan crops) + the PMO/executive prompt (~0.8–2k tokens). Prefill is fast (tens to ~150 ms);
the **decode** of the answer dominates wall-clock.

**Single-stream decode rate (assume Scenario A, INT4 27B):** memory-bound ceiling ≈
`1790 GB/s ÷ ~14 GB ≈ 128 tok/s` theoretical; realistically **~30–55 tok/s** after dequant + vision
overhead. **Aggregate** across a full continuous-batch: **~250–500 tok/s**, but per-stream rate falls
as the batch grows (8 streams → maybe ~15–25 tok/s each).

**End-to-end latency for one "AI Analysis" photo** (classify ~128 tok + inspection ~600–1500 tok):
- **Idle GPU:** ~12–35 s.
- **GPU at 6–8 concurrent:** ~45 s–2 min (queue + slower per-stream decode).
- **Pathological** (model emits toward the 20000-token cap, or context bloated): **multiple minutes**,
  and the 300 s httpx read timeout (`config.py:107`) is the only backstop.

**CUDA utilization:** during a report batch or several simultaneous analyses, the GPU pins at ~95–100%
SM utilization and high VRAM occupancy. There is **no GPU left** for anything else — a second model,
a re-rank, or an OCR pass would not fit.

**GPU saturation point:** **~6–8 concurrent vision generations (Scenario A); ~1–2 (Scenario B).**
Beyond that, vLLM queues; users see latency climb, not errors (until the 300 s/600 s timeouts trip).

---

## 4. CPU bottlenecks & the single-worker / GIL ceiling

- **One uvicorn worker** (`start-share.ps1`). The `ENTERPRISE-DEPLOY.md:10` comment *suggests*
  `--workers 2`, but the actual launch script omits it → **1 process**. Even with 2, each is a
  separate process with its **own** in-memory chat-session store and rate-limiter (state divergence —
  see §15, §19).
- **GIL:** openpyxl and python-pptx are pure-Python and **GIL-bound**. Offloading them to
  `to_thread` keeps the event loop responsive for I/O, but **two report builds cannot use two cores
  simultaneously** — they serialize on the GIL. PIL releases the GIL for C ops (resize/encode), so
  image steps do parallelize somewhat. Chromium PDF is a real subprocess → genuinely parallel but
  heavy.
- **`asyncio.to_thread` pool size** (CPython default) = `min(32, os.cpu_count() + 4)`. Plenty of
  threads, but GIL contention — not thread count — is the limiter for report builds.
- **bcrypt** on login (`security.py`) is CPU-heavy by design (~50–100 ms). A login storm (or a
  brute-force past the nginx `5 r/m` login zone) burns CPU; minor vs. report/PDF.
- **Co-tenancy:** Chromium (each render spikes 1–2 cores + 150–400 MB), nginx, and mongod all share
  the host CPU with the worker and with whatever feeds the GPU. On a typical 8–16 core desktop this
  is fine at low concurrency but compounds under report bursts.

**CPU verdict:** not the *first* wall (the GPU is), but the **single worker + GIL** makes report/PDF
generation a serialization point and removes any CPU parallelism for the Python-heavy build steps.

---

## 5. RAM consumption & memory-exhaustion thresholds

| Consumer | Per-unit | Risk |
|---|---|---|
| **In-process chat sessions** | up to **20 MB image bytes** each (`INSPECTION_MAX_IMAGE_MB=20`) + history, **never evicted** (`inspection_sessions.py` has no TTL/cleanup) | **slow leak → OOM.** 1,000 abandoned sessions ≈ **20 GB**. This is the most likely long-uptime OOM. |
| **Report build** | holds **all selected images in memory at once**; a 12 MP JPEG decodes to ~36 MB RGB in PIL. 50 images ≈ **~1.5–2 GB** transient per report | concurrent reports multiply it |
| **Upload buffering** | bounded — `read_upload_with_limit` streams and aborts at the cap (`uploads.py:53`); good | low |
| **Mongo client** | Motor pool default `maxPoolSize=100`, each conn cheap | low |
| **Base** worker + Python | ~150–400 MB | baseline |

**Memory exhaustion threshold (host with, say, 32 GB RAM, ~24 GB usable after OS + Mongo cache):**
- Steady leak: reached after **~hundreds–~1,000 abandoned AI-analysis sessions** (days–weeks of use
  with no restart).
- Acute: **~8–12 concurrent large (50-image) report builds** would approach it immediately, but the
  GPU bottleneck means you can't actually get that many running — the AI calls gate them first. The
  realistic acute risk is **2–4 concurrent big reports + an accumulated session backlog.**

**Fix priority:** add session TTL/LRU eviction; cap total cached session bytes. (Not currently done.)

---

## 6. MongoDB throughput

- **Connection pool:** `AsyncIOMotorClient(uri)` with **no `maxPoolSize`/timeout tuning**
  (`db.py:12`) → Motor default pool of 100. Fine for one worker; with 100 it will never starve at
  this scale.
- **Indexes now exist** (good, vs. the original audit): `Defect` has
  `(user_id, created_at)`, `(created_at)`, and a partial-unique dedupe index (`defect.py:27-37`);
  `VisionAnalysisCache` has a TTL index on `last_used_at` (`vision_analysis_cache.py:36-38`).
- **Remaining unbounded reads** (full result sets into memory/Python):
  `get_user_uploads` (`admin.py:1299`, no pagination), `list_collection` (`defect.py:387`),
  `clear_collection` (`defect.py:452`). For a power user with thousands of uploads these get slow and
  memory-heavy, but they are not the system-wide ceiling.
- **No try/except around queries** → a Mongo blip surfaces as a raw 500 (health check does ping
  Mongo and returns 503, `main.py:259`).

**Mongo verdict:** **not a bottleneck at the relevant scale.** A local mongod on NVMe handles
thousands of these small indexed ops/sec; you will hit the GPU wall and the single-worker wall long
before Mongo. Throughput ceiling here is effectively **>1,000 simple ops/s**, far above demand.

---

## 7. Disk I/O

- Uploads written async via `aiofiles` (`defect.py:95`), images ≤ 48 MB (`DEFECT_UPLOAD_MAX_MB`,
  capped 8–200 in `config.py:109`); chat images ≤ 20 MB.
- Local NVMe on a desktop: ~1–5 GB/s sequential, tens of thousands of IOPS. Writing even a few
  hundred images/minute is trivial for the disk.
- **The real ingress limiter is the ngrok tunnel bandwidth, not the SSD** (§16).
- `uploads/` is a **single local directory** — fine for one host, but it is a hard
  **horizontal-scaling blocker** (a second worker on another machine can't see the files).

**Disk verdict:** not a bottleneck. Storage *throughput* ≈ disk's native rate; storage *architecture*
is the problem (local, non-shared, no object store).

---

## 8. API concurrency, threads/processes, timeouts

- **Async ceiling:** one event loop can hold **hundreds–thousands** of concurrent awaited connections
  (SSE streams, DB waits) cheaply. So "connections" is not the limit; "concurrent *work*" is.
- **httpx pool to vLLM:** `max_connections=50`, `max_keepalive=20` (`http_client.py:65-68`). So up to
  50 simultaneous outbound vLLM calls are *possible* from the app — but vLLM itself only profitably
  runs ~6–8 (Scenario A); the rest queue inside vLLM.
- **Timeouts:** per-phase now — connect 10 s, read = `http_timeout_s` (**300 s**), write 60 s, pool
  10 s (`http_client.py:48-55`). nginx gives SSE/chat/defect paths **600 s** read/send
  (`defectra.conf:79-92`). So a stuck generation can hold a slot for up to **5 minutes** before the
  app gives up. **Timeout risk:** a few slow/runaway generations (toward the 20000-token cap) can
  occupy all vLLM seats for minutes → everyone queues.
- **Thread/process exhaustion:** to_thread pool ~`cpu+4..32`; the real exhaustion vector is
  **concurrent Chromium PDF subprocesses** — each is a full browser. The `_pdf_rate_limit` is
  **10/min per IP** (`chat.py:31`), so a handful of distinct clients can spawn many Chromium
  processes and exhaust CPU/RAM. (PDF is off the event loop, so it won't *freeze* the app — but it
  will starve CPU.)

---

## 9–12. vLLM queue, token throughput, latency under load, simultaneous inference

Covered quantitatively in §3. Summary table (Scenario A, INT4 27B; **halve seats / double latency for
Scenario B**):

| In-flight vision requests | Behavior | Per-request latency (≈600–1500 out tok) |
|---|---|---|
| 1–2 | runs immediately, near-peak per-stream | 12–35 s |
| 3–6 | continuous batching, healthy | 25–70 s |
| 7–8 | KV nearly full, per-stream slows | 60–120 s |
| 9–16 | queueing; new requests wait for a seat | 1.5–4 min |
| >16 | deep queue; 300 s app timeout / 600 s nginx timeout start tripping → user-visible failures | timeouts |

**vLLM queue behavior:** continuous batching admits requests up to KV capacity, then queues FIFO.
There is **no app-side admission control / concurrency cap on vLLM** beyond the circuit breaker (which
only trips on *connectivity* failures, not on slowness/queue depth). So overload manifests as
**latency creep**, then **timeout cliffs**, not graceful 429s. The nginx `defectra_api` zone
(60 r/s/IP) and the in-app `_ai_rate_limit` (20/min/IP, `chat.py:30`) are the only throttles, and they
are **per-IP** — they do not bound *global* vLLM concurrency.

---

## 13. Long-context impact

- AI follow-up chat resends **system prompt + full prior analysis + last 20 turns**
  (`inspection_chat_service.py:303-315`). Each turn's prefill grows; KV per follow-up sequence climbs,
  reducing how many sequences fit. A long Q&A thread can use 4–8k context tokens → ~2–4 MB KV each →
  fewer concurrent seats.
- Report executive calls and PMO analysis re-send the image each time (256+ image tokens) — fixed,
  not cumulative, but still consumes a prefill + KV block per call.
- `max_tokens=20000` means a single misbehaving generation can monopolize a KV block and a decode
  slot for minutes. **Recommend dropping to ~1,024–2,048** for inspection and ~256 for the executive
  JSON (§roadmap).

---

## 14. Simultaneous inference requests

Two distinct fan-out patterns make "simultaneous" worse than it looks:

1. **Each AI Analysis = 2 GPU calls** (classify + inspection). The classifier is cheap (≤128 tok) but
   still occupies a seat and a prefill.
2. **Report generation = N items × (classify + executive)**, i.e. up to **2N vision inferences** for
   an N-defect report, driven **one-at-a-time from the browser** (`admin.py:1341` per item). A 50-item
   first-pass report = **up to 100 vision inferences**. At ~10–20 s each (cache-cold, serialized by
   the browser): **~8–28 minutes** for one report. The **VisionAnalysisCache** (`vision_analysis_cache.py`)
   makes *repeat* runs of the same images nearly free (Mongo hit, no GPU) — a major mitigation — but
   the first pass is brutal, and **two admins generating different reports at once** double the GPU
   contention and roughly double everyone's latency.

---

## 15. SSE / WebSocket stability

- **No WebSockets** — chat/assistant use **SSE** over plain HTTP streaming (`chat.py:82`,
  `ENTERPRISE-DEPLOY.md:113`). nginx is configured correctly for it: `proxy_buffering off`,
  `proxy_read_timeout 600s`, `X-Accel-Buffering: no` (`defectra.conf:69-81`, `chat.py:92-94`).
- **Disconnect handling:** stream caches only on `[DONE]` (`generate_client.py:530,584`) — partial
  outputs are not cached as if complete. Good.
- **Stability risks:**
  - **ngrok** can drop long-idle streams; a slow first token (cold GPU/queued) can exceed ngrok's
    idle tolerance before any byte flows.
  - **In-memory sessions are per-process.** With `--workers 2`, a stream for a session created on
    worker A but routed to worker B → `404 Unknown session` (`inspection_chat_service.py:189`). The
    current single worker hides this, but it is a **landmine** the moment you scale workers without a
    shared session store.
  - No server→client heartbeat/keepalive comments during long pre-first-token waits → intermediaries
    may consider the connection idle.

---

## 16. Network bottlenecks (ngrok tunnel)

This is an **underrated hard limit** for an image-heavy app:

- All traffic egresses through the **ngrok agent → ngrok edge → client**. Free/personal ngrok plans
  impose **bandwidth throttling and concurrent-connection caps**; even paid plans add **30–120 ms RTT**
  and a shared edge.
- Uploads up to 48 MB and PDF/XLSX/PPTX downloads (multi-MB) all traverse the tunnel. **Concurrent
  large uploads will saturate the tunnel's uplink long before the SSD or Mongo notice.** On a typical
  residential upload link (say 20–50 Mbit/s), a single 48 MB upload takes ~8–20 s and **monopolizes
  egress** for other users.
- **Single tunnel = single point of failure** and a single shared rate bucket.

**Network verdict:** for a handful of office users on good bandwidth, ngrok is acceptable. For
"multiple users uploading simultaneously" over the public internet, **tunnel bandwidth is a top-3
real-world bottleneck**, alongside the GPU and the single worker.

---

## 17. Reverse-proxy / "Docker networking" overhead

- **No Docker networking exists** (§0). The only hops are Windows **loopback** (negligible, ~tens of
  µs) and the ngrok edge (§16).
- nginx is lightweight here; its rate-limit zones are the meaningful behavior:
  - `defectra_login` 5 r/m, `defectra_api` 60 r/s, `defectra_upload` 10 r/m, **per real client IP**
    (`http-context-snippet.conf:13-15`), keyed off `X-Forwarded-For` so all users don't share one
    bucket.
  - `client_max_body_size 52m` (`defectra.conf:31`) ≥ app's 48 MB cap. OK.
- **If you later containerize on this box with Docker Desktop/WSL2:** expect a WSL2 vmmem memory
  balloon (can hold GBs), a NAT/9p filesystem hop for bind mounts (slow for `uploads/`), and GPU
  passthrough caveats (WSL2 CUDA works but adds a layer). Net: containerizing on the *same* desktop
  **adds** overhead and contention; it does not help capacity here.

---

## 18–21. Failure points, leaks, exhaustion, timeouts (consolidated)

**Critical failure points under stress (in the order they bite):**
1. **GPU/vLLM saturation** → latency creep → 300 s/600 s timeout cliffs. *(First and hardest wall.)*
2. **Single worker event-loop pressure** — not from CPU (offloaded) but from **dozens of concurrent
   300 s SSE awaits** plus per-request Python overhead. The loop stays responsive but every await
   competes; tail latency rises.
3. **ngrok tunnel bandwidth** during concurrent uploads/downloads.
4. **RAM** — session-bytes leak (slow) and report image buffers (acute).
5. **Chromium subprocess pile-up** under PDF bursts (CPU/RAM starvation).

**Memory leaks:** in-process sessions retain image bytes with **no eviction** (`inspection_sessions.py`)
— confirmed unbounded. `_sid_locks` dict also grows per session (small). Frontend object-URL/observer
leaks (per `PRODUCTION_AUDIT.md` L2) are minor.

**Thread/process exhaustion:** Chromium PDF subprocesses are the real vector (10/min/IP cap is loose).
to_thread pool is bounded and fine.

**Timeout risks:** `max_tokens=20000` + 300 s read + 600 s nginx = a few runaway generations can hold
GPU seats for minutes; the breaker does **not** shed load on slowness (only on connect failures).

---

## 22. Reverse-proxy limits — see §17. Net: nginx is not the limiter; ngrok is.

## 23. Upload-handling scalability

- Per-file path is solid: streamed read with hard cap (`uploads.py:53`), magic-byte validation
  (`uploads.py:42`), async write, idempotency dedupe key + partial-unique index (`defect.py:115`,
  `defect.py:32`).
- **Batch upload is sequential** (`defect.py:200` loops items one by one in a single request). A
  20-image batch = 20 sequential reads+writes+2 inserts each within one request; with the nginx
  `defectra_upload` 10 r/m cap and 600 s timeout it works but is slow and ties up a connection.
- **No decompression-bomb guard on the main image-decode paths** except HEIC
  (`image_format.py:50` sets `MAX_IMAGE_PIXELS=64M`); report/PPTX PIL opens (`admin.py` build fns) and
  inspection PDF image embeds rely on prior size caps, not pixel caps — a crafted small-but-huge-pixel
  image could spike memory (per `PRODUCTION_AUDIT.md` M2/M3).

**Upload verdict:** functionally scalable per-request; the ceiling is tunnel bandwidth + single-worker
connection-holding, not the app logic.

## 24. PPT/report-generation bottleneck

- XLSX (`_build_report_workbook`) and PPTX (`_build_report_presentation`) are **GIL-bound** Python,
  offloaded to threads (`admin.py:1445,1469`) so they don't freeze the loop, but they **don't
  parallelize across cores**. PIL image embedding releases the GIL partially.
- Memory: all images held at once (§5) → ~1.5–2 GB transient for 50 images.
- **The dominant cost is upstream**: the **2N vision inferences** to produce observations
  (§14), not the file assembly. File build for 50 items ≈ seconds–tens of seconds; the AI fan-out is
  minutes.

**Max simultaneous report generations (safe):** **1** cold/first-pass without disturbing interactive
users; **2** tolerable but everyone's AI latency ~doubles; **≥3** → GPU thrash + RAM pressure. Repeat
(fully cached) reports: ~3–4 concurrent are fine since they skip the GPU.

## 25. Image-processing bottleneck

- HEIC→JPEG conversion (`image_format.py`) is CPU + memory (full decode); only triggered for HEIC
  uploads. PIL resize/encode in report build. None of this is the system ceiling; it's a second-order
  CPU/RAM cost behind the GPU.

## 26. GPU thermal throttling

- RTX 5090 at ~575 W sustained (report batches, multi-user analysis) in a **desktop chassis** with
  consumer cooling. If airflow is inadequate, expect **thermal/power throttling**: clocks drop, and
  **decode throughput falls ~10–30%** during long sustained runs. A multi-minute 50-item report batch
  is exactly the sustained load that triggers this. Also watch the **12VHPWR connector** and PSU
  headroom — a desktop also feeding CPU/Chromium under load needs ~850–1000 W PSU margin.
- **Mitigation:** cap power (`nvidia-smi -pl`), ensure case airflow, and monitor `nvidia-smi`
  temperature/`clocks_throttle_reasons` (§monitoring).

## 27. Windows / Linux host limitations

- **Windows-native** is what's deployed. Implications:
  - uvicorn `--workers` on Windows uses **spawn** (no fork) → each worker re-imports everything, more
    RAM, slower start, and **no shared memory** → the in-process session/rate-limit state diverges per
    worker (§15). This is why staying at 1 worker "works" today and why scaling workers is a trap
    without Redis.
  - Default Proactor event loop is fine for I/O.
  - Chromium subprocess startup is slower on Windows.
- **Linux would help** modestly (fork workers, better NVIDIA tooling, gunicorn) but the GPU ceiling is
  identical. The OS is **not** the primary constraint; the **single GPU + single worker** is.
- If vLLM/Mongo are in **WSL2 Docker** on this box (your premise), add WSL2 memory balloon + 9p mount
  slowness for any bind-mounted `uploads/` and a NAT hop (§17).

## 28. Production uptime risks

- **Single everything:** one GPU, one worker, one Mongo (standalone — no replica set, so **no
  multi-doc transactions** and no failover), one local disk, one ngrok tunnel. **Any one dying =
  full outage.**
- No process supervisor shown (started via PowerShell `Start-Process`); a worker crash is not
  auto-restarted. ngrok URL changes on restart unless a reserved domain is used.
- No metrics/alerts (only `/api/health`, `main.py:259`). You'll learn about saturation from user
  complaints, not dashboards.
- **Realistic uptime expectation as-is: a demo/pilot-grade service**, not 24/7 production. Expect
  user-visible degradation under bursts and an OOM/restart need every few days under steady AI use
  (session leak).

---

## CAPACITY ESTIMATES (conservative; Scenario A = INT4 27B assumed)

> If you are running **FP8 (Scenario B)**, divide AI-concurrency numbers by ~3–4 (≈1–2 concurrent
> generations, near-serial). If BF16, the model won't load.

| Metric | Conservative estimate | Hard ceiling / notes |
|---|---|---|
| **Safe concurrent users (mixed, no degradation)** | **15–25 active** | of these, only ~4–6 doing AI at once |
| **— concurrent users if AI-heavy** | **8–12** | each AI action ties a GPU seat ~15–90 s |
| **— concurrent users if browse/upload-only** | **40–80** | gated by single worker + tunnel, not GPU |
| **Peak concurrent AI inferences (healthy)** | **4–6** | GPU saturates at ~6–8 |
| **Peak concurrent AI inferences (hard cap)** | **~8** | then queueing + timeout risk |
| **AI requests/min (sustained)** | **~10–20 analyses/min** | = ~6 seats ÷ ~20–35 s each |
| **Lightweight API requests/min** | **~6,000–18,000/min** (100–300 req/s) when GPU idle | nginx caps 60 r/s/IP; collapses while reports run |
| **Max simultaneous report generations** | **1 cold / 2 degraded** | cached repeats: ~3–4 |
| **GPU saturation point** | **6–8 concurrent vision seqs (A)**, 1–2 (B) | KV-cache bound |
| **VRAM exhaustion** | model + KV must fit 32 GB; **A leaves ~12–14 GB KV (~24–28k tok)**, B leaves ~1–3 GB | OOM if max_num_seqs/max_model_len set too high |
| **RAM exhaustion (host 32 GB)** | ~hundreds–1,000 leaked sessions (~20 GB), or ~8–12 concurrent 50-img reports | session leak is the realistic one |
| **Storage throughput** | disk not limiting (NVMe GB/s); **ngrok uplink is** (≈ link Mbit/s) | 48 MB/upload over the tunnel |

**Plain-language bottom line:** comfortably supports a **single inspection team / pilot (≈10–20
people, a few AI users at a time)**. It will **not** survive an org-wide rollout of hundreds of
simultaneous users, large parallel report runs, or public-internet upload bursts without the redesign
in the roadmap below.

---

## CLASSIFICATION

### Critical bottlenecks (fix first; they cap throughput)
- **C-B1 — Single GPU, single 27–31B VLM.** Hard ceiling ~6–8 concurrent inferences. Everything
  expensive funnels here.
- **C-B2 — Single uvicorn worker.** No CPU parallelism for report builds; one process for all SSE
  streams. (`start-share.ps1`.)
- **C-B3 — `max_tokens=20000`** lets a single generation hog a seat for minutes. (`.env:10`.)
- **C-B4 — Report fan-out = 2N sequential vision calls** from the browser. (`admin.py:1341`.)

### High-risk architectural flaws
- **H-A1 — In-process session store holding image bytes, no eviction** → memory leak + breaks the
  moment you add a 2nd worker. (`inspection_sessions.py`.)
- **H-A2 — In-process rate limiter** → per-worker, not global; doesn't bound *global* vLLM
  concurrency. (`ratelimit.py`.)
- **H-A3 — Local-disk `uploads/`** → can't scale horizontally. (`defect.py:95`.)
- **H-A4 — Standalone Mongo** → no transactions, no failover. (`db.py`.)
- **H-A5 — No global admission control / concurrency cap on vLLM** → overload = latency cliff, not
  graceful shedding.

### Scaling blockers (prevent horizontal scale-out)
- Local file storage (need object store / shared volume).
- In-memory sessions + in-memory rate limit + in-memory circuit breaker (need Redis).
- Windows spawn workers with divergent state.
- Single GPU (need a second GPU or a remote inference pool to scale AI at all).

### Immediate production risks (could cause an incident this week)
- **OOM from session leak** under steady AI use → restart needed.
- **GPU thermal throttling** during a big report batch on desktop cooling.
- **ngrok tunnel saturation / drop** during concurrent uploads → failed uploads, dropped SSE.
- **Two admins generating reports at once** → minutes-long latency for all interactive users.
- **vLLM quantization unknown:** if it's actually FP8/BF16, capacity is far lower than the headline
  numbers — **confirm before any rollout.**

---

## RECOMMENDED LOAD-TESTING STRATEGY

Test in **four escalating tiers**, measuring the GPU first because it's the ceiling. Run the
load generator from a **different machine** so you measure the real ngrok path (or hit
`127.0.0.1:8080`/`:8010` locally to isolate the app from the tunnel — do both and compare).

1. **Tier 0 — Isolate vLLM (no app).** Benchmark the model directly to find the true GPU ceiling and
   confirm quantization/KV headroom.
2. **Tier 1 — App, GPU-free endpoints.** Auth, `/api/defects/my`, dashboard, uploads — find the
   single-worker HTTP ceiling and Mongo behavior.
3. **Tier 2 — AI path under concurrency.** Ramp concurrent `/api/chat/message/stream` with a real
   image; find the latency knee (expect ~4–6) and the timeout cliff.
4. **Tier 3 — Mixed + reports + PDF.** Realistic blend: browsers + uploads + 1–2 report runs + PDF
   exports simultaneously; watch RAM, GPU temp, tunnel.

**Always capture in parallel:** `nvidia-smi` (util/VRAM/temp/throttle), host CPU/RAM, vLLM `/metrics`,
nginx logs, app latency. Record the **knee** (latency starts rising) and the **cliff** (timeouts/5xx).

---

## EXACT BENCHMARKING COMMANDS / SCRIPTS

### A. GPU ceiling — vLLM's own serving benchmark (Tier 0)
```bash
# From the vLLM env. Use a vision dataset since the real workload is multimodal.
# Sweep concurrency to find the knee; watch throughput plateau + TTFT/E2E climb.
for C in 1 2 4 6 8 12 16; do
  python -m vllm.entrypoints.openai.api_server  # (already running on :8000)
  vllm bench serve \
    --backend openai-chat \
    --base-url http://127.0.0.1:8000 \
    --model gemma4-31b \
    --endpoint /v1/chat/completions \
    --dataset-name hf --dataset-path lmarena-ai/VisionArena-Chat \
    --max-concurrency $C --num-prompts $((C*10)) \
    --save-result --result-filename bench_c${C}.json
done
# Key outputs: output tok/s (aggregate), median/p99 TTFT, median/p99 E2E latency per concurrency.
```

### B. Raw token throughput + KV headroom sanity (Tier 0)
```bash
# Confirm VRAM split: weights vs KV. Run while a generation is in flight.
nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,clocks_throttle_reasons.active --format=csv -l 1
# vLLM exposes Prometheus metrics: num_requests_running / _waiting, gpu_cache_usage_perc, TTFT, TPOT
curl -s http://127.0.0.1:8000/metrics | grep -E 'vllm:(num_requests|gpu_cache_usage|time_to_first_token|time_per_output_token)'
```

### C. GPU-free app endpoints with k6 (Tier 1)
```javascript
// k6 run --vus 100 --duration 2m app_light.js   (set BASE + TOKEN)
import http from 'k6/http'; import { check, sleep } from 'k6';
const BASE = __ENV.BASE || 'http://127.0.0.1:8080';
const TOKEN = __ENV.TOKEN; // a real JWT from /api/auth/login
export const options = { stages: [
  { duration: '30s', target: 20 }, { duration: '1m', target: 100 },
  { duration: '30s', target: 0 } ] };
export default function () {
  const h = { headers: { Authorization: `Bearer ${TOKEN}` } };
  check(http.get(`${BASE}/api/defects/my?limit=50`, h), { '200': r => r.status === 200 });
  check(http.get(`${BASE}/api/health`), { 'health': r => r.status === 200 });
  sleep(1);
}
```

### D. AI concurrency sweep — find the knee (Tier 2)
```bash
# Bash + curl: fire N concurrent streaming analyses of the SAME image and time them.
# NOTE: identical image hits the VisionAnalysisCache after the first — to test the GPU,
# use N DIFFERENT images (cache key = sha of bytes+prompt+model) so every request hits vLLM.
TOKEN=...; BASE=http://127.0.0.1:8080
run_one () { local img=$1; local t0=$(date +%s.%N)
  curl -s -N -X POST "$BASE/api/chat/message/stream" \
    -H "Authorization: Bearer $TOKEN" \
    -F "session_id=$(curl -s -X POST $BASE/api/chat/session -H "Authorization: Bearer $TOKEN" | jq -r .session_id)" \
    -F "message=Analyze this defect" -F "image=@$img" > /dev/null
  echo "done $img in $(echo "$(date +%s.%N) - $t0" | bc)s"; }
for N in 1 2 4 6 8; do
  echo "=== concurrency $N ==="; t0=$(date +%s.%N)
  for i in $(seq 1 $N); do run_one "imgs/img_${i}.jpg" & done; wait
  echo "batch $N wall: $(echo "$(date +%s.%N) - $t0" | bc)s"
done
```
(Locust equivalent if you prefer Python — model each user as: create session → stream image → 2–3
text follow-ups → idle.)

### E. PDF / report stress (Tier 3)
```bash
# Hammer the Chromium path (watch process count + RAM): hey, 30 reqs, 5 concurrent.
hey -n 30 -c 5 -m POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"session_id":"x","transcript":[{"role":"assistant","text":"..."}]}' \
  $BASE/api/chat/inspection-pdf
# In another terminal on the host: count Chromium children + memory
#   (PowerShell) Get-Process chrome,node -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum
```

### F. Mongo under load (Tier 1/3)
```bash
mongostat --host 127.0.0.1:27017 1     # ops/s, queues, faults
mongotop  --host 127.0.0.1:27017 1     # hot collections
```

---

## RECOMMENDED MONITORING STACK (local, no cloud, Windows-host-aware)

| Layer | Tool | What it tells you |
|---|---|---|
| **GPU** | **NVIDIA DCGM-Exporter** (or `nvidia_gpu_exporter` for Windows) → Prometheus | VRAM, SM util, temp, **throttle reasons**, power |
| **vLLM** | built-in **Prometheus `/metrics`** | `num_requests_running/waiting`, `gpu_cache_usage_perc`, TTFT, TPOT — *this is your queue depth* |
| **Host (Windows)** | **windows_exporter** → Prometheus | CPU, RAM, disk, per-process (uvicorn/node/mongod) |
| **App** | structured logs already emit request IDs (`logging_setup.py`); add a **/metrics** via `prometheus-fastapi-instrumentator` | request rate, latency histograms, in-flight |
| **Mongo** | **mongodb_exporter** → Prometheus | ops, connections, slow queries |
| **Dashboards/alerts** | **Grafana + Alertmanager** (all local) | alert on: GPU temp > 83°C, gpu_cache_usage > 90%, vllm waiting > 0 for 60s, host RAM > 85%, worker restart |
| **Logs** | **Loki** (or just rotate the JSON logs) | correlate by request ID |
| **Tunnel** | ngrok dashboard / agent metrics | tunnel bandwidth, connection count, errors |

Minimum viable (1 hour to stand up): `nvidia-smi dmon` logging + vLLM `/metrics` scraped into a
1-panel Grafana + an alert on `gpu_cache_usage_perc` and host RAM.

---

## RECOMMENDED STRESS-TESTING TOOLS

- **HTTP / API:** **k6** (best DX, scriptable stages), **Locust** (Python, models stateful user
  journeys incl. SSE), **vegeta** (constant-rate), **hey**/**wrk** (quick smoke), **bombardier**.
- **LLM-specific:** **vLLM `vllm bench serve`** (the authoritative GPU ceiling), **NVIDIA GenAI-Perf**,
  **llmperf**. These understand TTFT/TPOT and streaming.
- **GPU thermal/power soak:** **`gpu-burn`** or a sustained `vllm bench` run while logging
  `clocks_throttle_reasons.active` — confirms whether your chassis throttles under multi-minute load.
- **Memory-leak hunt:** drive Tier-2 AI traffic for an hour, graph host RAM + Python RSS; the session
  store should be the line that only goes up.
- **Soak/endurance:** k6 at ~50% of the knee for 4–8 h to catch leaks, fd exhaustion, ngrok drops.

---

## CAPACITY-IMPROVEMENT ROADMAP (cheapest → structural)

**Tier 1 — config-only, do today (hours, big wins):**
1. **Lower `VLLM_MAX_TOKENS`** to ~1,024–2,048 (inspection) and ~256 (executive JSON). Removes the
   multi-minute runaway risk; frees KV. (`.env:10`.)
2. **Confirm + pin quantization**: run INT4/AWQ (or FP8 only if you accept ~1–2 concurrency). Set
   `--gpu-memory-utilization 0.92`, an explicit `--max-model-len` (e.g. 8k–16k, not 32k+), and
   `--max-num-seqs` to match measured KV headroom (start 8). Enable `--kv-cache-dtype fp8` to ~2× KV
   seats.
3. **Add session eviction**: TTL/LRU + a global byte cap in `inspection_sessions.py`. Kills the OOM
   leak.
4. **Add a global vLLM concurrency gate** (an `asyncio.Semaphore(N)` around vLLM calls, N≈6) so
   overload returns a fast 429/"busy" instead of a 5-minute queue.

**Tier 2 — small code/infra (days):**
5. **Batch + parallelize report AI** server-side with bounded concurrency (replace the browser's
   sequential `analyze-item` loop with one endpoint that fans out ≤N at a time, partial-failure safe).
6. **Move sessions + rate limit + circuit breaker to Redis** so you can run **multiple uvicorn
   workers** (or move to Linux + gunicorn) without state divergence. *Then* raise workers to ~CPU/2.
7. **Replace ngrok with a stable reverse proxy + real domain/TLS** (Cloudflare Tunnel or a VPS nginx)
   for upload bandwidth and a stable URL; keep nginx limits.
8. **Object storage for `uploads/`** (MinIO locally, or S3) to unblock multi-host.

**Tier 3 — structural (weeks):**
9. **Background worker queue** (arq/Celery/RQ on Redis) for report and PDF jobs → async "your report
   is ready" instead of holding a connection for minutes; smooths GPU load.
10. **Mongo replica set** (3 nodes, even on one box for dev) → transactions + failover.
11. **Scale AI**: second GPU (or a dedicated inference box) running vLLM with tensor/pipeline
    parallel, or a smaller/faster model for the *classifier* and follow-ups so the big VLM is reserved
    for the heavy inspection. Consider a 7–12B VLM at INT4 — it may be "good enough" at 3–5× the
    throughput.

---

## PRODUCTION-GRADE DEPLOYMENT ARCHITECTURE (hardware-aware, no cloud assumed)

Two viable targets depending on budget; both keep your JWT/RBAC as the identity layer.

### Option 1 — "Harden the desktop" (single box, pilot → small prod)
```
Internet ─TLS→ Cloudflare Tunnel / VPS-nginx (stable domain, WAF, real rate limits)
                     │
                     ▼
        nginx (Linux or Windows)  ──static dist
                     │
            ┌────────┴─────────┐
            ▼                  ▼
   uvicorn ×2–4 (Redis-backed) │   ← workers only after sessions/limits move to Redis
            │        │         │
            ▼        ▼         ▼
        Redis    MongoDB RS   MinIO (uploads)
            │
            ▼  (semaphore-gated, queued)
        arq worker(s) ──► vLLM :8000 (INT4, fp8 KV, max_num_seqs tuned) ──► RTX 5090
                          (+ optional small VLM for classify/follow-ups)
```
- Move report/PDF to the arq worker (background jobs).
- Add Prometheus + Grafana + DCGM/windows exporters + alerts.
- Power-cap + cool the GPU; PSU headroom for sustained 575 W.
- **Realistic capacity after this: ~40–80 mixed users, ~6–8 concurrent AI, reports as background
  jobs without freezing interactive users.** GPU is still the AI ceiling.

### Option 2 — "Split the tiers" (small prod → growth)
```
Edge:    domain + TLS + WAF + rate limit  (Cloudflare or nginx on a small VPS)
App tier: 2+ Linux hosts, gunicorn+uvicorn, Redis (shared), MinIO/S3 (shared uploads), Mongo replica set
AI tier:  dedicated GPU host(s) running vLLM behind a queue/load-balancer
          - scale AI by adding GPUs / replicas (this is the only way to raise the 6–8 ceiling)
Jobs:     arq/Celery workers for reports, PDF, batch AI
Observability: Prometheus + Grafana + Loki + Alertmanager + DCGM
```
- This is the only path to **hundreds of concurrent users**: the app tier scales horizontally once
  state is in Redis/Mongo/S3, and the **AI tier scales by adding GPUs** (a single 5090 will never
  serve hundreds of simultaneous 27B-VLM inferences — physics, not code).

---

## Assumptions (so you can challenge the numbers)

1. **vLLM runs the VLM at INT4/AWQ** (Scenario A). If FP8 → AI concurrency ≈ 1–2 and all AI numbers
   drop ~3–4×. If BF16 → it doesn't load. **This is the #1 thing to verify.**
2. Model shape ≈ Gemma-3-27B (62 layers, 16 KV heads, head_dim 128) for the 0.5 MB/token KV figure.
3. Typical inspection output ≈ 600–1,500 tokens; executive JSON ≈ 200–500; classifier ≤128.
4. Host has a modern desktop CPU (8–16 cores) and 32–64 GB RAM; NVMe SSD.
5. ngrok on a personal/paid plan over a typical business/residential uplink; users mostly office-based.
6. Single uvicorn worker (per `start-share.ps1`), single standalone Mongo, single local `uploads/`.
7. Estimates are **conservative** — designed so reality is more likely to *beat* them than miss them.

*Generated 2026-05-27 against branch `feature-ai-analysis`.*
