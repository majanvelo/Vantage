# apps/worker

The **background worker** — processes a job queue and does the long-running CPU
work, never blocking the API (see SPEC.md §1.3).

What belongs here (per SPEC.md §4 and §6):
- **Audio-sync engine (§4) — Phase 1.** Per-clip ingestion: extract audio via
  `ffmpeg`, compute log-mel + onset + loudness features.
  Pairwise cross-correlation offsets, weighted-least-squares + RANSAC/IRLS
  global solve, graph consistency check. Writes `sync_groups` +
  `sync_placements`.
- **Later phases:** auto-cut decision list (§5), export/render pipeline (§6).

Phase 1 scope only for the first build — the audio-sync engine, nothing more.
