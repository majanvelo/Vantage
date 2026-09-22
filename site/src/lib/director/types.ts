/**
 * director/types.ts — the data contract for the Phase-2a AUTO-CUT DIRECTOR.
 *
 * Mental model (the "live TV switcher"):
 *   Phase 1 aligned N clips onto ONE shared timeline (event_sync: per-clip
 *   offset_ms + the event's timeline_ms). The director's job is to decide, for
 *   every moment of that shared timeline, WHICH camera the finished film shows —
 *   steadiest camera, best audio, faces in frame, and never a jump cut.
 *
 *   The timeline is partitioned into fixed SLICES (default 4s). Each clip that
 *   overlaps a slice contributes one CANDIDATE for that slice: the slice mapped
 *   back into that clip's own file time (`source_start_ms`). Candidates are
 *   scored (stability / audio / face → one 0..1 score), then a Viterbi/DP
 *   selector picks one clip per slice under a switch penalty + no-jump-cut
 *   taboo, and the result is an ordered, gap-free DirectorShot[].
 *
 * Everything in this directory is PURE: no DB, no server routes, no UI. Feed it
 * plain objects (see DirectorInput) — the caller owns I/O. `adapters.ts` is the
 * one place that reads the DB, and it only reads.
 */

// ---------------------------------------------------------------------------
// Slices & candidates
// ---------------------------------------------------------------------------

/** A fixed window on the SHARED timeline (ms, half-open: [start_ms, end_ms)). */
export interface SliceWindow {
  start_ms: number;
  end_ms: number;
}

/**
 * One clip's offer to cover one slice: "show me from source_start_ms for
 * source_duration_ms". `source_start_ms` is the slice start mapped into THIS
 * clip's file time (slice.start_ms − clip.offset_ms), clamped to [0, file
 * duration]; `source_duration_ms` is the overlapping length, so a clip that only
 * partially covers a slice produces a partial candidate (the scorer penalises
 * that, since a partial source window cannot fill the whole slice).
 */
export interface ClipSliceCandidate {
  clip_id: string;
  /** The shared-timeline slice this candidate covers. */
  window: SliceWindow;
  /** Start of the window inside the clip's own file (ms, ≥ 0). */
  source_start_ms: number;
  /** Length of the window inside the clip's own file (ms, > 0). */
  source_duration_ms: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The raw, 0..1 signals behind a candidate's score. All are reported (not just
 * the fused score) so the demo can print the matrix and the lead can see WHY a
 * camera won.
 */
export interface CandidateSignals {
  /** 1 = rock-steady camera, 0 = handheld shake (see score.ts for the metric). */
  stability: number;
  /** 1 = loud/clear audio in the window, 0 = quiet.  */
  audio: number;
  /** 1 = lots of centered skin-toned content (v1 face proxy), 0 = none. */
  face: number;
  /** Fraction of the slice this clip can actually fill (0..1]. */
  coverage: number;
  /** Envelope variation inside the window — a cheap speech-likeness proxy. */
  speechiness: number;
  /** Alignment-confidence damping applied (0.85..1 by default). */
  sync_factor: number;
}

/** A candidate plus its fused score (0..1) and the signals that produced it. */
export interface ScoredCandidate extends ClipSliceCandidate {
  /** Fused, weighted score before penalties — comparable across candidates. */
  score: number;
  signals: CandidateSignals;
}

/** Per-candidate scoring context handed to pluggable scorers (e.g. FaceScorer). */
export interface ScoreContext {
  candidate: ClipSliceCandidate;
  clip: DirectorClip;
  /** Downscaled RGB frames for this clip, if the clip has a video probe. */
  frames?: VisualFrames;
}

// ---------------------------------------------------------------------------
// Visual probe (shared by the stability + face scorers)
// ---------------------------------------------------------------------------

/**
 * A clip decoded ONCE at low resolution into RGB24 frames — the cheap common
 * substrate for the stability and face scorers (one ffmpeg pass per clip, no
 * per-slice seeking). See score.ts `probeClipVisual`.
 */
export interface VisualFrames {
  width: number;
  height: number;
  /** Sampling rate of the probe in fps (frames are evenly spaced at 1/fps). */
  fps: number;
  /** frames[i] is a width*height*3 RGB24 buffer at time i/fps seconds. */
  frames: Uint8Array[];
}

/**
 * A pluggable face-in-frame scorer. Implementations must be dependency-light and
 * may be sync or async. Return a value in 0..1 (clamped by the caller).
 */
export interface FaceScorer {
  /** Stable identifier, reported in diagnostics. */
  name: string;
  /** One-line honest description of what it actually measures. */
  description: string;
  score(ctx: ScoreContext): number | Promise<number>;
}

/** Pluggable stability (shake) scorer — same contract as FaceScorer. */
export type StabilityScorer = (ctx: ScoreContext) => number | Promise<number>;

/** Pluggable audio scorer — same contract as FaceScorer. */
export type AudioScorer = (ctx: ScoreContext) => number | Promise<number>;

// ---------------------------------------------------------------------------
// Director input / output
// ---------------------------------------------------------------------------

/** A single clip's alignment + media facts, as the director sees them. */
export interface DirectorClip {
  clip_id: string;
  /** Clip's start on the shared timeline (ms). offset_ms from event_sync. */
  offset_ms: number;
  /** Clip's own duration (ms). */
  duration_ms: number;
  /** Absolute path to the media file (for the visual probe). Optional: a clip
   *  with no file still participates, scored on audio/neutral defaults. */
  file_path?: string;
  media_type?: "video" | "photo";
  /** Cached RMS loudness envelope (audio_features row), 50 ms windows. */
  envelope?: { values: number[]; windowMs: number };
  /** Audio-alignment confidence (0..1) from Phase 1. Defaults to 1. */
  sync_confidence?: number;
  mean_residual_ms?: number;
  /** Human label used by the demo/printing (e.g. "A"). */
  label?: string;
}

/** Everything the director needs: clips + the shared timeline length. */
export interface DirectorInput {
  clips: DirectorClip[];
  /** Total shared timeline length (ms) — event_sync.timeline_ms. */
  timeline_ms: number;
  options?: DirectorOptions;
}

/** Weights of the three scoring signals (documented in score.ts). */
export interface ScoreWeights {
  stability: number;
  audio: number;
  face: number;
}

export interface DirectorOptions {
  /** Slice length on the shared timeline (ms). Default 4000. */
  sliceMs?: number;
  /** Signal weights. Default { stability: 0.35, audio: 0.4, face: 0.25 }. */
  weights?: Partial<ScoreWeights>;
  /** Score multiplier floor for a candidate that covers only part of a slice.
   *  Default 0.75 (full coverage ⇒ no penalty, ~half coverage ⇒ ×0.875). */
  coverageWeight?: number;
  /** Weight of the speech-likeness tiebreaker inside the audio signal. 0 = off. */
  speechWeight?: number;
  /** Stability metric calibration: mean frame-diff-per-second (0..1 scale) that
   *  counts as "clearly moving". Default 0.12. */
  motionRefPerSec?: number;
  /** Stability metric calibration: temporal stddev that counts as "shaky". */
  jitterRefPerSec?: number;
  /** Probe sampling rate (fps) for the low-res visual pass. Default 6. */
  probeFps?: number;
  /** Probe frame size (px). Default 96x54 — enough for a coarse skin-tone pass. */
  probeWidth?: number;
  probeHeight?: number;
  /** Cap on how much of each clip the probe decodes (s). Default 300. */
  probeMaxSeconds?: number;
  /** Neutral score for a candidate whose signals are unknown (no file/no audio). */
  missingSignalScore?: number;

  // --- selector options (see select.ts) ---
  /** Cost of switching cameras between two slices. Default 0.15. */
  switchPenalty?: number;
  /** No-jump-cut taboo depth K: a camera that was cut away from cannot return
   *  for K slices (blocks A-B-A). Default 2. */
  returnCooldownSlices?: number;
  /** A shot must last at least this many slices. Default 1. */
  minHoldSlices?: number;
  /** Penalty applied when the taboo must be broken to keep coverage. Default 1. */
  violationPenalty?: number;
}

/** One output shot: show `clip_id` from shared-timeline start_ms to end_ms. */
export interface DirectorShot {
  clip_id: string;
  start_ms: number;
  end_ms: number;
  /** Diagnostics (not needed by a renderer, useful for logs/demos). */
  slices?: number;
  mean_score?: number;
  /** Switch happened at this shot's start (false for the opening shot). */
  cut_in?: boolean;
}

/** Slices where no clip had any footage — the film cannot cover them. */
export interface DirectorGap extends SliceWindow {
  slice_index: number;
}

/** A no-jump-cut taboo that had to be broken to keep the timeline covered. */
export interface DirectorViolation {
  slice_index: number;
  start_ms: number;
  clip_id: string;
  reason: string;
}

/** The director's full answer. */
export interface DirectorOutput {
  shots: DirectorShot[];
  gaps: DirectorGap[];
  /** Slices the selector could not cover without breaking a taboo (should be
   *  empty on well-covered timelines; non-empty means smoothness lost to
   *  coverage, which is the deliberate priority order). */
  violations: DirectorViolation[];
  /** scoreMatrix[sliceIndex] = scored candidates for that slice (may be []). */
  scoreMatrix: ScoredCandidate[][];
  slices: SliceWindow[];
  diagnostics: {
    slice_ms: number;
    weights: ScoreWeights;
    switch_penalty: number;
    return_cooldown_slices: number;
    min_hold_slices: number;
    face_scorer: string;
    probe_fps: number;
    probe_size: string;
    clips_probed: number;
    clips_used: string[];
    total_switch_penalty: number;
  };
}

/**
 * RENDER INTEGRATION POINT (Phase 2b — NOT built here).
 *
 * A renderer consumes `DirectorOutput.shots` — an ordered, non-overlapping
 * list of { clip_id, start_ms, end_ms } covering the shared timeline — and for
 * each shot trims the clip's own file at
 *     source = shot.start_ms − clip.offset_ms  … + (end_ms − start_ms)
 * then concatenates the shots in order (with a frame-accurate cut or a 3–6
 * frame dissolve) and lays the theme's music/text/frame/stickers on top. That is
 * exactly the same "many segments → one film" step render.ts already performs for
 * solo photos (see buildPhotosMotionFilm / finalizeSoloVideo), so 2b wires
 * director shots into the existing segment-and-finalize machinery rather than
 * writing a new ffmpeg pipeline.
 */
export interface DirectorRendererContract {
  /** Ordered shots, gap-free where footage exists. */
  shots: DirectorShot[];
  /** Clip geometry needed to map shared time → source time. */
  clips: Array<{ clip_id: string; offset_ms: number; duration_ms: number; file_path?: string }>;
}
