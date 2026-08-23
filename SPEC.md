# Vantage — Technical Specification

**Status:** Reference spec for a future handoff agent.
**Owner:** Vantage team (engineering).
**Version:** 1.0
**Read-first:** Section 7 (Phased Build Order) governs **what may be built now.** This document describes the full product for context; only Phase 1 is in scope for the first build. Phase 2 and Phase 3 features are explicitly marked with **[PHASE 2]** / **[PHASE 3]** tags so a handoff agent cannot accidentally build beyond Phase 1.

---

## 1. Overview

### 1.1 Product goals

Vantage lets a normal person make a polished video with **zero editing skill**. Two input modes:

- **Solo** — a single user uploads their own videos and photos from their phone and Vantage turns them into one finished, auto-cut video.
- **Collaborative** — everyone at an event (concert, wedding, party, sports game) uploads their own clips into one shared "event pool." Vantage lines every clip up in time by matching their audio against each other, then auto-cuts between the best angle at every moment as if a live TV director were switching cameras. It returns one finished video to the event organizer (and optionally to contributors).

Two hard technical problems define the product:

1. **Audio sync** — aligning dozens of independently-recorded clips onto one shared timeline even when they were shot on different phones at different distances with different microphone qualities.
2. **Auto-cut / live-switcher** — picking, at every moment, the single clip that best represents the action (steadiest, best audio, face-in-frame), while cutting like a pro (no jump-cuts, good pacing, cuts on beats).

The MVP business direction is a landing page; this SPEC describes the **full product** for the engineering build-out that follows validation.

### 1.2 Two modes

| Mode | Actor | Input | Output |
|------|-------|-------|--------|
| Solo | One user | Own videos + photos | One auto-cut film |
| Collaborative | Event organizer + contributors | Everyone's clips in shared pool | One auto-cut film from the union of all angles |

The solo case is a degenerate collaborative case with a single author and no cross-user pool. The first implementation can share ~100% of the pipeline; the solo path just skips pool/invite and has fewer source clips.

### 1.3 High-level system architecture

```
                                   ┌────────────────────────────┐
                                   │        Mobile App          │
                                   │  (iOS / Android / Expo RN) │
                                   └──────┬─────────────┬───────┘
                                          │             │ direct S3 PUT
                             REST/JSON    │             ▼ (presigned)
                                          │        ┌──────────┐
                                          ▼        │  S3      │
                                   ┌────────────┐  │  (object │
                                   │    API     │  │ storage) │
                                   │  (REST)    │  └────┬─────┘
                                   └─────┬──────┘       │
                                         │              │
                                         ▼              ▼
                                   ┌────────────────────────────┐
                                   │      Job Queue (worker)    │
                                   │  ingest · audio-sync ·     │
                                   │  switcher · export/render  │
                                   └─────────────┬──────────────┘
                                                 ▼
                                   ┌────────────────────────────┐
                                   │        Database (Postgres) │
                                   │  users, events, clips,     │
                                   │  sync_groups, jobs         │
                                   └────────────────────────────┘
```

- **Mobile app** — capture, upload (direct-to-storage via presigned URLs), event creation/invite, and playback of the synced multi-view + finished film.
- **API** — stateless REST service: auth, event/clip metadata CRUD, job triggers, status polling, webhook dispatch.
- **Background worker** — processes a job queue. Consumes S3 objects, runs FFmpeg-based extraction, the sync engine, the switcher, and the render pipeline. Long-running CPU work must never block the API.
- **Object storage (S3)** — raw uploaded media, derived audio/feature artifacts, intermediate video segments, final render.
- **Database (Postgres)** — relational state for all entities, job state, sync/switch results.

**Concurrency & scale:** target the MVP at ~event. The sync graph is probabilistic and gets harder with n-clips; design for a few hundred clips per event but keep the algorithm's time complexity in mind (see §4.5 pairwise pruning).

---

## 2. Data model

SQL-ish notation. `PK`, `FK`, `UQ` (unique), `IX` (index). All tables have `id`, `created_at`, `updated_at`.

### 2.1 User

```sql
CREATE TABLE users (
  id            UUID PK,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL
);
-- IX on email already via UNIQUE
```

### 2.2 Event (shared collaborative pool)

Solo mode is modeled as an Event with `mode='solo'` and exactly one member (the owner).

```sql
CREATE TABLE events (
  id           UUID PK,
  owner_id     UUID FK → users.id NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('solo','collaborative')),
  title        TEXT NOT NULL,
  description  TEXT,
  starts_at    TIMESTAMPTZ,          -- nominal event window (informational)
  ends_at      TIMESTAMPTZ,
  invite_code  TEXT UNIQUE NOT NULL, -- short join code for contributors
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','syncing','rendering','finished','closed')),
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE TABLE event_members (
  event_id   UUID FK → events.id NOT NULL,
  user_id    UUID FK → users.id NOT NULL,
  role       TEXT NOT NULL DEFAULT 'contributor'
             CHECK (role IN ('owner','contributor')),
  joined_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
-- IX: (invite_code), (owner_id)
```

### 2.3 Clip (uploaded video/photo + per-clip metadata)

One row per uploaded media file. For a photo, `media_type='photo'` and there is no audio/duration.

```sql
CREATE TABLE clips (
  id           UUID PK,
  event_id     UUID FK → events.id NOT NULL,
  uploader_id  UUID FK → users.id NOT NULL,
  media_type   TEXT NOT NULL CHECK (media_type IN ('video','photo')),
  object_key   TEXT NOT NULL,        -- S3 key of original file
  content_type TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  duration_ms  INT,                  -- NULL for photos
  width        INT, height INT,      -- video frame size
  fps          REAL,
  -- capture provenance
  captured_at  TIMESTAMPTZ,          -- on-device capture timestamp (opportunistic, may be absent/wrong)
  has_gyro     BOOLEAN DEFAULT FALSE,  -- gyro/stabilization track present?
  -- derived once ingestion completes
  ingest_status TEXT NOT NULL DEFAULT 'uploaded'
                CHECK (ingest_status IN ('uploaded','extracting','ready','failed')),
  audio_key     TEXT,                -- extracted mono PCM/WAV in S3
  feature_key   TEXT,                -- fingerprint/feature artifact in S3
  audio_levels  JSONB,               -- per-slice loudness curve (§4.2)
  stability_profile JSONB,           -- per-slice stability score curve (§5.2)
  face_profile  JSONB,               -- per-slice face-in-frame results (§5.2)
  sharpness_profile JSONB,           -- per-slice sharpness score curve
  thumbnail_key TEXT,                -- preview still in S3
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);
-- IX: (event_id), (uploader_id), (ingest_status)
```

### 2.4 SyncGroup / Timeline

The output of the audio-sync engine: per-clip **time offsets** onto a shared absolute timeline, plus per-slice per-clip availability (used by the switcher). Phase 1's concrete deliverable.

```sql
CREATE TABLE sync_groups (
  id         UUID PK,
  event_id   UUID FK → events.id NOT NULL,
  status     TEXT NOT NULL DEFAULT 'collecting'
             CHECK (status IN ('collecting','pending','syncing','aligned','failed')),
  timeline_start REAL,       -- absolute time in seconds of the shared timeline origin
  timeline_end   REAL,       -- absolute end in seconds
  ref_clip_id    UUID FK → clips.id,  -- the clip the timeline is anchored to (offset 0)
  confidence REAL,           -- 0..1 aggregate graph consistency (§4.5)
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- XML/J(son) per-clip placement on the timeline
CREATE TABLE sync_placements (
  sync_group_id UUID FK → sync_groups.id NOT NULL,
  clip_id       UUID FK → clips.id NOT NULL,
  offset_sec    REAL NOT NULL,  -- clip.local_time 0 maps to timeline time offset_sec
  confidence    REAL,           -- 0..1 for this clip's placement
  is_photo      BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (sync_group_id, clip_id)
);
-- IX: (sync_group_id)
```

**Timeline convention:** the shared timeline is in **absolute seconds** `t ∈ [timeline_start, timeline_end]`. A video clip `c` with local time `l` occupies absolute time `t = offset_sec(c) + l`. A photo is a **point placement** (see §4.6).

### 2.5 IngestionJob

Tracks per-clip asynchronous processing. One row per clip per pipeline stage (or per clip with a stage column — either is fine; per-stage rows give clean retry/queueing).

```sql
CREATE TABLE ingestion_jobs (
  id         UUID PK,
  clip_id    UUID FK → clips.id NOT NULL,
  stage      TEXT NOT NULL CHECK (stage IN ('extract_media','extract_audio','compute_features','done')),
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','succeeded','failed','retrying')),
  attempts   INT DEFAULT 0,
  last_error TEXT,
  result     JSONB,      -- links to audio_key/feature_key, computed stats
  queued_at  TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
-- IX: (status, queued_at)  -- worker queue scan
```

### 2.6 Export / Render job

[PHASE 3] The async render that turns the aligned+auto-cut timeline into one finished MP4.

```sql
CREATE TABLE export_jobs (
  id           UUID PK,
  event_id     UUID FK → events.id NOT NULL,
  sync_group_id UUID FK → sync_groups.id NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','succeeded','failed')),
  progress     REAL DEFAULT 0,          -- 0..1
  output_key   TEXT,                    -- S3 key of final MP4
  output_url   TEXT,                    -- expiring public URL when done
  params       JSONB,                   -- resolution, codec, etc.
  requested_by UUID FK → users.id,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);
```

### 2.7 Webhooks / notifications

```sql
CREATE TABLE webhook_subscriptions (
  id           UUID PK,
  event_id     UUID FK → events.id,
  user_id      UUID FK → users.id,
  url          TEXT NOT NULL,           -- must be owner-provided endpooint
  secret       TEXT NOT NULL,           -- HMAC signing secret
  events       TEXT[] NOT NULL          -- e.g. {'event.synced','export.ready','export.failed'}
);
-- IX: (user_id)
```

---

## 3. API endpoints

REST-ish, JSON over HTTPS, all under `/v1`. **Auth model:** mobile app clients authenticate with a bearer token (JWT) issued from an email/magic-link or device login at `/v1/auth/*`. Endpoints that act on other users' data check ownership/event-membership server-side before allowing the action. Contributor uploads require membership in the event; only the event owner may trigger render/export and read the finished film URL. Invite joins are the one user-initiated association endpoint.

### 3.1 Auth

| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/v1/auth/magic` | `{email}` | `202` — sends magic link (async). |
| POST | `/v1/auth/verify` | `{token}` | `{access_token, user}` — JWT. |

### 3.2 Events

| Method | Path | Req | Resp | Notes |
|--------|------|-----|------|-------|
| POST | `/v1/events` | `{title, mode, starts_at?, ends_at?}` | `201 Event` | Auth. Creates owner membership. `solo` events get one member. |
| GET | `/v1/events/{id}` | — | `Event + membership` | Membership-gated. |
| POST | `/v1/events/{id}/invite` | — | `{invite_code}` | Owner only. Regenerates code. |
| POST | `/v1/events/join` | `{invite_code}` | `200 Membership` | Any authed user may join a valid open code. |

### 3.3 Clip upload (presigned URL pattern)

The **client never streams media through the API.** The client asks for a presigned S3 PUT URL, uploads directly to S3, then notifies the API of metadata.

| Method | Path | Req | Resp | Notes |
|--------|------|-----|------|-------|
| POST | `/v1/events/{id}/clips/presign` | `{filename, content_type, size_bytes, media_type, captured_at?, has_gyro?}` | `201 {clip_id, upload_url, object_key, expires_at}` | Auth + membership. If `captured_at` provided and it conflicts (more than X sec from other clips), it's ignored by the sync engine anyway (§4.6). |
| PUT | `<upload_url>` | raw bytes | `200` | Direct to S3, no auth header (presigned). |
| POST | `/v1/events/{id}/clips/{clip_id}/complete` | — | `200 Clip, schedules ingestion` | Client confirms upload finished; server verifies object exists, enqueues IngestionJob. |
| GET | `/v1/events/{id}/clips` | — | `[Clip]` | List pool (membership-gated). |
| DELETE | `/v1/events/{id}/clips/{clip_id}` | — | `204` | Uploader or owner. Removes object. |

### 3.4 Sync engine trigger

| Method | Path | Req | Resp | Notes |
|--------|------|-----|------|-------|
| POST | `/v1/events/{id}/sync` | `{anchor_clip_id?}` | `202 {sync_group_id, status}` | Auth+membership. Runs when enough clips ready; idempotent (creates/reuses `sync_group`). Phase 1's trigger. |
| GET | `/v1/events/{id}/sync` | — | `{sync_group, placements[], status}` | Poll. Multi-view playback comes from placements (Phase 1). |

### 3.5 Render / export trigger + status polling

[PHASE 3]

| Method | Path | Req | Resp | Notes |
|--------|------|-----|------|-------|
| POST | `/v1/events/{id}/render` | `{resolution?, format?}` | `202 {export_job_id}` | Owner only. Uses the current auto-cut decision set (§5). |
| GET | `/v1/events/{id}/render/{job_id}` | — | `{status, progress, output_url}` | Poll until `succeeded`. `output_url` expiring signed URL. |

### 3.6 Webhooks

| Method | Path | Req | Resp | Notes |
|--------|------|-----|------|-------|
| POST | `/v1/webhooks` | `{url, events[]}` | `201 sub` | Owner creates. `secret` returned once. |
| DELETE | `/v1/webhooks/{id}` | — | `204` | Owner. |
| (outbound) | `POST <url>` | `{event_type, payload}` + `X-Vantage-Signature: HMAC` | expect `2xx` | Worker dispatches from queue with retry/backoff. Events: `event.synced`, `export.ready`, `export.failed`. |

---

## 4. Audio-sync engine  — *deep dive*

The engine answers one question: **for every clip, what absolute time offset places its content on the shared timeline?** It does this almost entirely from **audio content overlap**, because clips of the same event recorded at the same moment share the same ambient/performance audio regardless of camera angle. Photos have no audio and are placed via a separate rule (§4.6).

### 4.1 High-level pipeline

```
per clip:  extract_audio → compute_features(fingerprint)
   │
   ▼
pairwise:  for selected pairs → cross-correlate fingerprints → offset estimate (+confidence)
   │
   ▼
graph:     build offset graph → solve global placements → consistency check → refine
   │
   ▼
photos + no-audio clips: place by neighboring audio or timestamp rule
   │
   ▼
write sync_group + placements
```

### 4.2 Per-clip extraction & feature computation (IngestionJob stages)

1. **Extract audio.** Run `ffmpeg` on each video: `ffmpeg -i clip.mp4 -vn -ac 1 -ar 8000 -f s16le mono.pcm` (or a WAV). Downmix to **mono**, resample to a low rate (8 kHz is plenty for alignment and keeps features small/fast), and normalize gain. Store `mono.pcm` (audio_key).
2. **Compute a compact audio fingerprint per clip.** Store time-series descriptors at ~10–20 fps resolution (e.g. every 50–100 ms). Concretely, compute a **spectrogram** (STFT with e.g. 1024-sample window at 8 kHz → ~64 mel bands) and reduce to a **compact feature vector per frame**. Two concrete options:
   - **Chromaprint (AcoustID / libchroma)** — a perceptual audio fingerprint widely used for song identification. Chromaprint is *rotation-invariant* (great for matching where the same music is heard from the start) but it produces a *whole-recording* hash, not a per-time-frame offset, so it is not directly a time-aligner on its own.
   - **Onset envelope + spectral frame features (recommended primary)** — compute per-frame: `log-mel spectrogram` (e.g. 40–64 mel bands over 20–40 ms frames), plus an **onset strength envelope** (`librosa.onset.onset_strength` or FFmpeg `ebur128`/`astats` derived loudness), plus **loudness (EBU R128) per slice** for the audio-quality scoring in §5. Store a per-frame vector `f_c[l]` and a per-frame loudness `L_c[l]`.

   For alignment we primarily need a **monotonic, high-rate, content-bearing descriptor** — the log-mel frame sequence is the workhorse. Chromaprint may be used as a fast *pre-filter* in the pairwise stage (see §4.3) but not as the offset estimate.

3. **Store the feature artifact** (`feature_key`) on S3 next to the clip. This is computed exactly once and reused for all pairwise comparisons and (via the loudness curve) for the switcher.

### 4.3 Pairwise offset estimation (cross-correlation)

For a pair of clips `A` and `B` that overlap in time, their audio around the overlap is nearly identical (same event sound), differing only in gain/mic/filter, so their feature sequences are highly correlated at the true offset.

Steps to estimate the offset `δ = t_B − t_A` (i.e. `B`'s content is `δ` seconds later than `A`'s):

1. **Pre-filter candidate pairs (optional but scalable):** for large pools, cheaply compare Chromaprint hashes to find pairs that likely share audio, and skip obviously-none-overlapping pairs. This bounds the O(n²) cost (§4.5).
2. **Cross-correlate the feature sequences.** Take the per-frame log-mel sequences `X_A` and `X_B`. Compute normalized cross-correlation:
   - `C[k] = Σ_l ⟨X_A[l], X_B[l−k]⟩` over the overlap for each shift `k` (normalized by overlap length). Implement efficiently with FFT (`rfft` → multiply conjugated by each other → `irfft`) for O(N log N) per pair.
   - The offset `δ = k* · (frame_duration)` where `k* = argmax_k C[k]`.
3. **Sub-frame refinement:** around `k*` fit a parabola (or upsample the correlation peak) to get a fractional-frame offset.
4. **Confidence:** the peak confidence is the peak's height relative to the mean/standard deviation of the correlation function — a **peak-to-sidelobe ratio** (`PSR`). A clean, sharp peak far above the noise floor → high confidence. A broad, low peak or multiple comparable peaks → low confidence. Additionally verify with the **onset envelope** cross-correlation as an independent check; if both features agree on `δ`, the estimate is much more trustworthy.

   Optionally cross-validate by computing the actual audio-band cross-correlation of the raw mono at the proposed offset and requiring it exceed a threshold (e.g. normalized cross-correlation > 0.3).

**Why this works at an event:** phones capture the same room sound (music, PA, crowd noise, a shared clap) from different positions within ~1 s of acoustic delay + clock drift. Offsets are near-integer seconds; but we handle arbitrary real offsets because we search the full correlation lag range, not assuming alignment.

### 4.4 Building the global reference timeline (graph solve)

Pairwise offsets give *relative* shifts. We need *absolute* timeline positions.

1. **Anchor:** pick one "reference" clip `R` with the highest average pairwise confidence and correct clock (e.g. a clip whose on-device timestamp `captured_at` is sane, or simply the clip with the most reliable average PSR). Its offset is fixed at `offset_sec(R) = 0` (or exactly `captured_at(R) − baseline`).
2. **Relative-to-absolute:** for each clip `C`, the absolute offset is `offset_sec(C) = offset_sec(R) + δ_{C→R}` summed along a chosen path in the graph, e.g. `δ_RC = (mean over paths) δ` from the pairwise step (note sign convention: `δ_{A→B} = t_B − t_A`).
3. **Multi-way consistency / least squares:** collect all high-confidence pairwise offsets into a linear system. For `n` clips there are `n` unknown absolute offsets `τ_i` and up to `n(n−1)/2` pairwise constraint equations `τ_j − τ_i ≈ δ_{ij}` with weight `w_{ij}` = PSR confidence. Solve by **weighted least squares** (minimize `Σ w_{ij}(τ_j − τ_i − δ_{ij})²`), fixing `τ_R = 0` to remove the translation degeneracy. This is a sparse linear system solvable with gradient descent or a sparse solver; it naturally averages out pairwise noise across the whole graph. `scipy.linalg.lstsq` or `lsqr` handles it.
4. **Robustness to outliers:** a single wrong pairwise offset can drag every clip. Use **RANSAC or iteratively reweighted least squares (IRLS):** solve, compute per-constraint residuals, down-weight constraints whose residual exceeds a robust threshold (e.g. Huber loss or drop the worst 10% by residual), re-solve, iterate. A constraint is *ambiguous* if its best PSR < threshold or if the second-best correlation peak is within X% of the best — mark it low-weight or exclue it from the solve (but keep it for verification).
5. **Noisy non-overlapping clips:** clips with no shared audio have no valid pairwise offset and are excluded from the solve. They fall through to the placement fallback in §4.6.
6. **Global confidence:** after solving, recompute the residual of every used constraint. `sync_groups.confidence` = 1 − normalized mean residual, and each clip's `sync_placements.confidence` = its mean residual contribution. If too many clips are inconsistent, mark the group `failed` and surface which clips are suspect so the user can be told.

### 4.5 Handling non-overlapping / music vs ambient / silence gaps

Real event pools contain clips that **don't audibly overlap**:

- **Music-driven events (concerts, DJ sets):** nearly all clips contain the *same* music, for long stretches → strong, long correlations; the main risk is **periodic/self-similar music** producing multiple correlation peaks (repeated chorus). Guard: prefer the **global** peak but require it be unique within a guard band and validate across both log-mel and onset features; if the top two peaks are comparably high, mark the pair ambiguous and down-weight it (music self-similarity, not a real answer).
- **Ambient/no-audio events:** clips may overlap only in low-level room tone, crowd murmur, or a single clap. Onset-envelope cross-correlation is the discriminator here — a shared clap/impact yields a crisp onset spike that aligns. If nothing exceeds the confidence threshold, the pair contributes no edge.
- **Silence gaps:** a clip that is mostly silent has ~zero usable signal. Detect via loudness; if a clip's active-loudness fraction is below a floor, mark it "no-audio" and skip as a video sync source (may still be placed via timestamp rule or used for switcher audio if it has usable moments).
- **Isolated vs connected components:** after solving, some clips connect only indirectly or not at all. If clip `C` connects to the main component via a single moderate-confidence edge, accept but record low per-clip confidence. If `C` is in a *separate component* (no audio overlap with the main group at all), it cannot be audio-synced into the main timeline — see placement fallback §4.6.

### 4.6 Placing photos (and no-audio clips) on the timeline

Photos have no audio, so they cannot be audio-synced. Placement is heuristic and is strictly **[PHASE 3]** for photos (the requirement says photos come with Phase 3). The rule (concrete):

1. **Neighbor-anchored placement (preferred):** use the photo's `captured_at` timestamp **relative to** a reference video or another clip captured near it in time that *did* get audio-synced. Concretely: find the nearest-in-time audio-synced video `V` (by `captured_at`); compute `captured_at(photo) − captured_at(V)` as a relative offset; then `offset_sec(photo) = offset_sec(V) + that_delta` — **assuming clock accuracy within a few seconds.** If the relative delta is within a sanity window (e.g. < 60 s), accept; else fall back to rule 2.
2. **Timestamp-only placement (fallback):** if no trustworthy neighboring audio-synced clip exists, place the photo at `offset_sec = captured_at(photo) − timeline_epoch` where `timeline_epoch` is derived from the reference clip's clock. Mark confidence low.
3. **Photos as point placements:** a photo displays for a fixed dwell (e.g. 3 s) centered at its placement point, animated (Ken Burns) during that window. Stored as `sync_placements.is_photo=true` with `offset_sec` = center.

The same neighbor/timestamp fallback (§4.6.1–2) is applied to **video clips that had no overlapping audio** — they cannot be aligned by audio, so they are either tagged as photos-like on the timeline or excluded from the sync (still available as solo cuts).

---

## 5. Auto-cut / live-switcher logic — *deep dive*

Given the synchronized timeline (all clips with known absolute offsets), the switcher produces, for every moment `t`, a decision "show clip `c*` at `t`". It is a **temporal segmentation + selection** problem, not a per-frame max. This section is **[PHASE 2]**.

### 5.1 Time slicing

Discretize the timeline into **slices** (e.g. `S = 0.5 s`; the decision cadence). For each slice `i` covering absolute time `[t_i, t_i+S)`, the set of **active clips** is every clip whose placement covers that interval (clip start ≤ `t_i` and clip end ≥ `t_i+S`). Photos are active only at their dwell window.

### 5.2 Per-clip per-slice scoring

For each active clip `c` and slice `i`, compute scores, each in [0,1], using precomputed per-clip profiles (computed at ingestion, stored in `clips.*_profile` or `feature_key`):

1. **Stability (`stab`)** — how steady the shot is. Sources:
   - **Gyro** (if `has_gyro`): the magnitude of angular velocity integrated over the slice; lower roll/pitch/yaw rate → steadier. Model `stab = clamp(1 − Σ|gyro|/threshold, 0, 1)`.
   - **Optical flow** (no gyro): compute dense optical flow between frames in the slice; global camera-motion component (SVG/affine fit of flow) → penalize large translation/rotation; remaining residual flow → penalize. Lower camera motion → steadier.
   - Penalize sudden shakes heavily (a shake is not just "less steady"; it's a candidate to avoid at all costs).
2. **Audio quality (`audiоq`)** — loudness and clarity from the ingestion loudness curve `L_c[l]`:
   - Penalize **too quiet** (inaudible, below noise floor floor) and **too loud/clipped** (distorted).
   - Reward being in a comfortable "active" loudness band (e.g. −20 to −8 dBFS-ish R128), where the subject is clearly audible.
   - Optionally prefer the clip whose audio is *loudest while undistorted* when the source differs (mic distance).
3. **Face-in-frame (`face`)** — from the `face_profile` (face detection, e.g. MediaPipe/FaceNet/OpenCV DNN per slice):
   - 1.0 if ≥1 face detected clearly in-frame, framed well (centered, sufficiently large, not cut off).
   - Scale down if face is tiny, near edge, blurry, or multiple faces competing; 0 if no face (for non-portrait content like a stage performance, this is down-weighted — see §5.3).
4. **Quality / sharpness (`qual`)** — resolution and sharpness from `sharpness_profile` (e.g. Laplacian variance of the frame): penalize low-res, out-of-focus, or motion-blurred frames. Resolution normalization: upscale 720p is worse than native 1080p.

### 5.3 Combining scores into per-slice utility

`utility(c, i) = w_s·stab + w_a·(audiоq) + w_f·(face·f_mode) + w_q·qual`, weights chosen by content mode (e.g. `w_f` weighted higher in "people/portrait" events, lower for stage/concert where faces may be off-frame). Also multiply a **content-appropriateness** factor `g_c` in [0,1] that reduces utility when the clip is "not about the main action" (e.g. a clip of the floor during a performance — measurable as low face + low onset energy relative to the reference clip at that moment). Keep weights configurable; defaults tuned in Phase 2.

### 5.4 Cut rules (the "TV director" constraints)

Raw per-slice argmax would cut every 0.5 s — garbage. The switcher instead solves a constrained segmentation:

1. **Minimum shot length.** Two cuts closer than `min_hold` (e.g. **2.5 s**) are collapsed: once committed to a clip, it is held at least `min_hold` unless rules 3–4 force otherwise.
2. **No jump-cuts.** A jump-cut is cutting from clip A to clip **A again** (or to a near-identical angle of the same scene) after a brief interruption. Rules: (a) never cut to the same clip; (b) if you must return to a clip you just left, require the new attempt to be a *significantly different spatial region* OR an intervening clip played at least `min_sep` (e.g. 3 s) — otherwise it's a jump-cut and is prohibited. Also avoid cutting between clips that are near-identical duplicates (same phone/location, near-same framing → same effective content) unless no alternative.
3. **Don't cut during important moments unless justified.** "Important" = a peak in the **global action curve** (loudness spike, onset/beat energy, face event, or user-marked moment — e.g. goal, chorus, speech high point). During a peak, hold the current best clip; only cut if the *next* clip is substantially better (utility advantage > `justify_ratio`, e.g. 1.25×) AND the cut lands at a natural boundary (below). "Important" moments are also where you'd *make sure* the chosen clip captures it (a clip that is silent or off-action is never shown through a peak in the main action).
4. **Cut on a beat / section boundary.** Prefer to **align cuts with the audio**: compute a **beat/section (downbeat) track** from the reference clip's audio (e.g. `librosa.beat.beat_track` or `essentia` BeatTracker, or FFmpeg's `astats`/onset detection). A cut is only permitted inside a small window around a detected onset/beat (`±0.2 s`). This is what makes cuts feel musical and "directed" rather than random. Rule 3's "natural boundary" and this rule together define the *valid cut times*.
5. **TV pacing.** Vary, don't monotonize: prefer a shot length near a target `target_hold` (e.g. 4 s) but allow short punch-ins (2.5 s) during action peaks and longer holds (6–8 s) during a steady ambient/quiet moment or a single wonderful face. Cap max hold (e.g. 10 s) so a single clip doesn't dominate. Use a smoothness prior: a mild penalty for deviating from `target_hold` and for two adjacent shots both being "short". This is essentially a **trellis / dynamic-programming** optimization (below).

**Combined as DP / Viterbi:** define per-slice the best clip subject to all above by running a dynamic program over slices. State = (clip shown in previous slice, how long it has been held). Transition cost = 0 if same clip continues; = large if rules 1/2/4 violated; = small positive "cut cost" encouraging longer holds; score = Σ utility(clip, slice) − Σ transition costs. The Viterbi path is the shot list. Because holding a clip avoids cut-cost, and cutting only at valid times is enforced by the transition masks, the DP naturally yields a paced, TV-style result. This is a concrete, implementable formulation.

### 5.5 Solo case (single clip)

When a **single clip** is active for an interval (or the event has only one clip), there is nothing to switch between at those moments: the switcher simply **holds that clip** regardless of its absolute utility (its own score only governs photo dwell times and whether we'd ever edit it out for a photo). No cut is possible, so the shot list is that clip, continuous, for its whole duration. The solo experience = the *whole* single clip played as-is, interleaved with placed photos. (In a multi-clip solo event where clips don't overlap, the "only one active clip" rule applies per region.) This guarantees the solo user always gets their footage back; auto-cut only *adds* value where multiple angles overlap.

---

## 6. Export / render pipeline — *high level* **[PHASE 3]**

Turns the auto-cut shot list (timeline + decisions from §5) into one finished video, asynchronously via the worker:

1. **Segment preparation.** For each shot `(clip, start_local, end_local)`, `ffmpeg -ss <start> -t <dur> -i origin.mov -c:v libx264 -crf 18 -pix_fmt yuv420p seg_k.ts` to normalize codec/resolution/timing (also applies crop/rotation, denoise/color-grading lightly, and a Ken Burns crop for photos). Generated segments cached in S3.
2. **Concatenation.** Demux/concat video segments (file-list concat) into a single MP4 timeline at the chosen resolution (default 1080p) and frame rate (source fps or 30).
3. **Audio mixdown.** For each slice choose the **switched clip's** audio as the *primary* track, but add a gentle **audio ducking/auto-mix**: crossfade (e.g. 25 ms Xfade) at cuts; optionally blend a low-level ambient bed (room tone) from one clip so the video never has dead-silent gaps between clips; normalize final loudness to a target (−16 LUFS) with `EBU R128`. Photos carry no audio, so they sit over the ambient/continuation bed.
4. **Output:** `libx264`/`libx265`, AAC audio, MP4 container, 1080p default (configurable via `export_jobs.params`). Upload final MP4 to S3, set `output_key`, mark `succeeded`, emit signed URL, fire `export.ready` webhook + in-app notification. Progress reported as segments complete / total.
5. **Async execution:** triggered by `POST /render` (owner), tracked by `export_jobs`, polled via `GET /render/{job_id}`. Failures stored and retried with backoff.

---

## 7. Phased build order

**This section is authoritative for what gets built when.** A handoff agent must build **only Phase 1** right now. The phases are sequential; later phases depend on earlier ones.

### Phase 1 — Event + Upload + Audio Sync (only)

**Scope:** end-to-end ability to create an event, invite/join, upload clips, and have the **audio-sync engine align overlapping clips onto one shared timeline** that can be watched as a **multi-view** (or at minimum show the aligned timeline/offsets for verification). **No auto-cut, no export/render, no photos on the timeline.**

**Concrete deliverables:**
1. `events`, `event_members`, `clips`, `ingestion_jobs`, `sync_groups`, `sync_placements` tables (from §2, Phase-1 subset).
2. API: auth, event create/invite/join, clip presign + complete + list, `/sync` trigger + status (from §3, Phase-1 subset).
3. S3 presigned upload path.
4. Worker: per-clip ingestion (extract audio `ffmpeg`, compute log-mel + onset + loudness features), pairwise cross-correlation offsets, weighted-least-squares + RANSAC/IRLS global solve, graph consistency check (§4).
5. **Multi-view playback**: a UI (web or mobile-test view) that takes `sync_placements` and plays multiple aligned clips simultaneously (e.g. a 2×2 grid where each quadrant plays a different clip at its common timeline clock), so a human can *see* the sync worked. Phase 1 success = aligned multi-view.
6. Metrics/tests for sync quality: PSR distributions, solved-residual graphs, and a small labeled test set to validate alignment.

**Explicitly NOT in Phase 1:** auto-cut switching (§5), export/render (§6), photos on the timeline (§4.6 — photos may be *uploaded/stored* but not placed in alignment yet), webhook outbound delivery.

**Dependencies:**
- Depends on: object storage, Postgres, a worker, FFmpeg availability.
- Provides: all sync data (`sync_placements`) that Phase 2 reads.

**Definition of done:** ≥2 users can create/join an event, upload overlapping clips, trigger sync, and watch the aligned multi-view with correct time alignment (verified on a validation set, e.g. ≥90% of clips within <0.25 s of true offset).

### Phase 2 — Auto-cut switching

**Scope:** consume Phase 1's `sync_placements` and produce the TV-style **shot decision list** (§5).

**Concrete deliverables:**
1. Ingestion additions: gyro ingestion, optical-flow stability, face detection, sharpness profiles (extend `clips.*_profile`).
2. Per-slice scoring + utility combination (§5.2–5.3).
3. DP/Viterbi cut optimizer with min-hold, no-jump-cut, beat-aligned cut times, important-moment hold, pacing (§5.4).
4. Beat/section detection from the reference clip audio.
5. A **decision preview** UI: play the timeline with cuts applied (non-rendered, browser-side switch) so users/QA can judge pacing before paying for a render.
6. Solo single-clip path (holds the one clip; §5.5).

**Dependencies:** Phase 1 shared timeline + per-clip feature artifacts. Provides: a decision list artifact that Phase 3 consumes.

**Definition of done:** on a multi-angle validation event, decisions respect all cut rules (min shot length, no jump-cuts > threshold, cuts land on beats) with an acceptable quality score.

### Phase 3 — Export/render + photos + polish

**Scope:** turn Phase 2's decision list into a real finished MP4; add photo placement; product polish.

**Concrete deliverables:**
1. Render pipeline (§6): segment prep, concat, audio mixdown/ducking, EBR128 normalization, 1080p MP4 output; async job + polling + webhooks + notifications.
2. Photo placement on timeline (§4.6) with Ken Burns dwell.
3. Finished-film share/URL delivery; invitation → contribution → render full loop hardening; edge cases (failed renders, no-overlap components, retries); observability/metrics.

**Dependencies:** Phase 2 decision list. Provides: the shippable one-link finished video — the product's core promise.

**Definition of done:** upload a mixed real-world event, get a polished MP4 in reasonable wall-clock time with correct sync, sensible cuts, and photos in place.

---

## 8. Naming & legal

- The product is named **Vantage**.
- It was originally called "Reel" and was renamed for originality and legal/trademark-safety reasons.
- All user-facing copy, product references, and integration/identifiers (e.g. the webhook signature header `X-Vantage-Signature`) use **Vantage**.
- "Reel" appears only here in this historical-naming note as the prior name; no new code or copy should reintroduce it.

---

### Appendix — Stack assumptions (suggested; free to choose equivalents)

- **Storage:** AWS S3 (or MinIO for local dev) with presigned PUT/GET.
- **DB:** Postgres + a migration tool (e.g. Prisma/Drizzle/Alembic).
- **Worker:** queue (Redis/ElastiCache + a worker e.g. BullMQ, Celery, or plain SQS) processing `ingestion_jobs` / `export_jobs`.
- **Media/audio:** FFmpeg, `librosa` / `essentia` (Python) or equivalent for features, `numpy`/`scipy` for correlation + least squares, OpenCV/MediaPipe for face & flow.
- **API:** any clean REST framework (FastAPI, NestJS, Express) — stateless, JWT auth.
- **Mobile:** Expo/React Native (Target OS later; Phase 1 verification can be web-based multi-view).

*End of spec.*
