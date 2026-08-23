# Vantage — Handoff Package

This package hands the **Vantage product build** to a cto.new agent. Follow these
instructions in **exact order**. Do not skip ahead, do not improvise scope.

---

## Step 1 — Push this package to GitHub

1. Create **one** GitHub repository for Vantage (monorepo). Example name: `vantage`.
2. Push the entire contents of this directory to that repo's `main` branch —
   including `SPEC.md`, this `README.md`, and the `apps/` and `docs/` folders.

## Step 2 — Connect the repo in cto.new and run it from the spec

1. Connect that GitHub repo in cto.new.
2. Feed **`/home/team/shared/SPEC.md`** from this package as the task — or
   point cto.new at the repo's `SPEC.md`. The spec is the single source of
   truth for architecture, data model, API, and scope. Do not build from
   anything other than that spec.

## Step 3 — Build Phase 1 ONLY first

Build **Phase 1 first, and nothing more.** Read **Section 7 (Phased Build
Order)** of the spec for the exact scope.

**Phase 1 = Event creation + clip upload + audio-sync engine:**

- `events`, `event_members`, `clips`, `ingestion_jobs`, `sync_groups`,
  `sync_placements` tables (Phase-1 subset of §2).
- API: auth, event create/invite/join, clip presign + complete + list,
  `/sync` trigger + status (§3 Phase-1 subset).
- S3 presigned upload path.
- Worker: per-clip ingestion (extract audio via `ffmpeg`, compute log-mel +
  onset + loudness features), pairwise cross-correlation offsets,
  weighted-least-squares + RANSAC/IRLS global solve, graph consistency check (§4).
- **Multi-view playback** (web or mobile-test view) that plays aligned clips on a
  common timeline clock, to prove the sync worked. Phase 1 success = aligned multi-view.
- Sync-quality metrics/tests (PSR distributions, solved-residual graphs,
  small labeled validation set).

**Do NOT touch any of the following until Phase 1 is fully done:**

- ❌ Auto-cut / live-switcher switching (§5) — Phase 2.
- ❌ Export / render pipeline (§6) — Phase 3.
- ❌ Photos on the timeline (§4.6) — Phase 3. (Photos may be uploaded/stored,
  but not placed in alignment.)
- ❌ Webhook outbound delivery — Phase 3.

The spec tags all out-of-scope features with **[PHASE 2]** / **[PHASE 3]** so
they are easy to avoid. Ignore them for now.

**Definition of done for Phase 1** (per spec §7): ≥2 users can create/join an
event, upload overlapping clips, trigger sync, and watch the aligned multi-view
with correct time alignment (verified on the validation set, e.g. ≥90% of clips
within <0.25 s of true offset).

## Step 4 — Know where everything belongs

The monorepo is split into three apps (mirroring the spec's architecture in §1.3):

| Folder | What lives there |
|--------|------------------|
| `apps/mobile/`  | The phone app — Expo/React Native. Event creation UI, clip upload UI, collaborative pool/invite, and multi-view playback for Phase 1 verification. |
| `apps/api/`     | The backend REST API (§3) — auth, events, presigned clip uploads, clip metadata, sync trigger/poll; later render trigger/poll. |
| `apps/worker/`  | Background jobs (§4 & §6) — the audio-sync engine; later the auto-cut decision list and export/render pipeline. |

`docs/design-reference/` holds visual reference (HTML mockups) for the app UI —
for visual direction only, not functional code.

---

**Bottom line for the handoff agent:** Stand up the monorepo, build **only
Phase 1 end-to-end** (event → upload → audio sync → aligned multi-view), prove
it with the validation set, and report before building anything from Phase 2 or
Phase 3.
