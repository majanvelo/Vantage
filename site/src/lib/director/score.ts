/**
 * director/score.ts — per-candidate scoring for the auto-cut director.
 *
 * For every (slice, clip) candidate we compute THREE signals, each normalized to
 * 0..1, and fuse them into one score with configurable weights:
 *
 *   1. STABILITY  — is this camera steady right now?
 *      Metric: ONE low-resolution decode pass per clip (probeClipVisual: RGB24,
 *      96x54, 6 fps, capped at probeMaxSeconds). For the frames inside the
 *      candidate's source window we take consecutive-frame mean absolute pixel
 *      difference (d_i, 0..1) and express it PER SECOND of video (so the number
 *      does not depend on the probe frame rate):
 *          motionPerSec = mean(d_i) * fps      (how much the picture changes)
 *          jitterPerSec = stddev(d_i) * fps    (how ERRATIC that change is)
 *      A hand-held camera both moves fast and moves erratically, so stability is
 *          1 − (0.55·min(1, motion/motionRef) + 0.45·min(1, jitter/jitterRef))
 *      Calibration defaults (motionRef = 0.12, jitterRef = 0.10) were picked from
 *      real probes of the demo's steady/shaky clips. This is a *shake/instability*
 *      proxy, not true optical-flow stabilisation: a fast pan, a whip, or heavy
 *      sensor noise all read as "unsteady", and a perfectly static scene reads as
 *      perfectly steady. That is the right bias for a live switcher (prefer the
 *      locked-off camera) and it is cheap: one ffmpeg pass per clip, no per-slice
 *      seeking, no OpenCV.
 *
 *   2. AUDIO — does this camera have the good sound right now?
 *      Uses the CACHED RMS envelope already in the `audio_features` table
 *      (values[] at window_ms = 50 ms), so no decode at all on the normal path.
 *      Over the candidate's source window we take mean and p90 level, normalize
 *      by the loudest clip in the event (adaptive — real events are mixed loud),
 *      and blend in a cheap speech-likeness tiebreaker: the envelope's
 *      coefficient of variation inside the window (speech is syllabic, ~4 Hz,
 *      so its 50 ms envelope varies much more than a steady tone or room tone).
 *      Only if a clip has NO cached envelope and a file path do we decode once
 *      (features.extractAudioFeatures) as a fallback.
 *
 *   3. FACE-IN-FRAME (v1 heuristic — read this before trusting it)
 *      A pluggable FaceScorer interface, with the default implementation
 *      `skinToneSaliencyFaceScorer`: on up to 3 probe frames inside the window it
 *      measures the fraction of the CENTER-weighted area covered by a relaxed
 *      skin-tone mask, times a "concentration" factor (skin clustered in one
 *      region scores higher than skin smeared over the whole frame, which
 *      separates a face from a beige wall / wood panelling).
 *      HONEST LIMITATIONS: no face detection, no eyes/nose, no size or
 *      orientation check; ~5k downscaled pixels; false positives on wood, beige
 *      walls, warm-lit skin-toned surfaces; false negatives on very dark or very
 *      brightly backlit faces; it says "skin-toned content, clustered, centered",
 *      not "a person is looking at the camera". It is deliberately dependency-free
 *      (no opencv / no model download) so the phase ships. Swap in a real face
 *      detector by implementing the FaceScorer interface — nothing else changes.
 *
 * Coverage: a candidate that only partially overlaps a slice cannot fill it, so
 * the fused score is multiplied by coverageWeight + (1−coverageWeight)·coverage.
 * Sync confidence from Phase 1 damps the score by 0.85 + 0.15·confidence, because
 * a shaky alignment means the wrong moment might be shown.
 */

import type {
  AudioScorer,
  CandidateSignals,
  ClipSliceCandidate,
  DirectorClip,
  DirectorInput,
  DirectorOptions,
  FaceScorer,
  ScoreContext,
  ScoreWeights,
  ScoredCandidate,
  SliceWindow,
  StabilityScorer,
  VisualFrames,
} from "./types";

// ---------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}
/** p-th percentile of an unsorted array (p in 0..1). */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = clamp(Math.round(p * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/**
 * Signal weights. Rationale (not arbitrary):
 *   audio 0.45 — in multi-camera event footage audio is the FIRST thing that
 *     breaks the illusion: a cut to a camera with quiet/muffled sound is jarring
 *     and cannot be fixed later, while mild shake can. The Murch rule (cut on the
 *     sound, hide the picture) is why the loudest clear camera leads.
 *   stability 0.30 — picture quality: prefer the locked-off camera.
 *   face 0.25 — prefer shots that actually show the people (v1 proxy: centered
 *     skin-toned content). Enough to break ties toward the camera on the subject
 *     without letting the heuristic dominate the decision.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = { stability: 0.3, audio: 0.45, face: 0.25 };

/** Fully-resolved options (every field present) used internally. */
export interface ResolvedOptions {
  sliceMs: number;
  weights: ScoreWeights;
  coverageWeight: number;
  speechWeight: number;
  motionRefPerSec: number;
  jitterRefPerSec: number;
  probeFps: number;
  probeWidth: number;
  probeHeight: number;
  probeMaxSeconds: number;
  missingSignalScore: number;
  switchPenalty: number;
  returnCooldownSlices: number;
  minHoldSlices: number;
  violationPenalty: number;
  /** Audio normalization floor — avoids dividing by ~silence. */
  audioRefFloor: number;
  /** Skin-tone fraction of the center-weighted area that scores full marks. */
  skinRef: number;
  /** Fraction of the event's loudest level below which audio counts as silence
   *  (used to gate the speech-likeness term). */
  speechGateLevel: number;
  /** Reliability of the audio level anchor when only one clip exists. */
  singleClipAudioRef: number;
}

export function resolveOptions(opts: DirectorOptions = {}): ResolvedOptions {
  return {
    sliceMs: opts.sliceMs ?? 4000,
    weights: { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) },
    coverageWeight: opts.coverageWeight ?? 0.75,
    speechWeight: opts.speechWeight ?? 0.15,
    motionRefPerSec: opts.motionRefPerSec ?? 0.12,
    jitterRefPerSec: opts.jitterRefPerSec ?? 0.1,
    probeFps: opts.probeFps ?? 8,
    probeWidth: opts.probeWidth ?? 128,
    probeHeight: opts.probeHeight ?? 72,
    probeMaxSeconds: opts.probeMaxSeconds ?? 300,
    missingSignalScore: opts.missingSignalScore ?? 0.5,
    switchPenalty: opts.switchPenalty ?? 0.15,
    returnCooldownSlices: opts.returnCooldownSlices ?? 2,
    minHoldSlices: opts.minHoldSlices ?? 1,
    violationPenalty: opts.violationPenalty ?? 1,
    audioRefFloor: 200,
    skinRef: 0.18,
    speechGateLevel: 0.2,
    singleClipAudioRef: 6000,
  };
}

// ---------------------------------------------------------------------------
// 1) slices & candidates — partition the shared timeline
// ---------------------------------------------------------------------------

/**
 * Partition [0, timeline_ms) into fixed windows of `sliceMs`. The last slice is
 * clipped to the timeline end, so slices always exactly tile the timeline.
 */
export function planSlices(timelineMs: number, sliceMs: number): SliceWindow[] {
  const out: SliceWindow[] = [];
  const step = Math.max(1, Math.round(sliceMs));
  for (let start = 0; start < timelineMs; start += step) {
    out.push({ start_ms: start, end_ms: Math.min(timelineMs, start + step) });
  }
  return out;
}

/**
 * Every clip that overlaps a slice offers a candidate for it. The candidate's
 * source window is the slice mapped into the clip's own file time, clamped to
 * the clip's duration; clips whose clamped window would be empty are skipped.
 */
export function buildCandidates(
  clips: DirectorClip[],
  slices: SliceWindow[]
): ClipSliceCandidate[][] {
  return slices.map((window) => {
    const out: ClipSliceCandidate[] = [];
    for (const clip of clips) {
      const clipStart = clip.offset_ms;
      const clipEnd = clip.offset_ms + clip.duration_ms;
      const from = Math.max(window.start_ms, clipStart);
      const to = Math.min(window.end_ms, clipEnd);
      if (to - from <= 0) continue; // no overlap at all
      const source_start_ms = clamp(from - clipStart, 0, Math.max(0, clip.duration_ms - 1));
      const source_duration_ms = Math.min(to - from, clip.duration_ms - source_start_ms);
      if (source_duration_ms <= 0) continue;
      out.push({ clip_id: clip.clip_id, window, source_start_ms, source_duration_ms });
    }
    // Deterministic order (stable ties, reproducible output).
    out.sort((a, b) => (a.clip_id < b.clip_id ? -1 : a.clip_id > b.clip_id ? 1 : 0));
    return out;
  });
}

// ---------------------------------------------------------------------------
// 2) the visual probe — ONE low-res decode pass per clip
// ---------------------------------------------------------------------------

/** ffmpeg → Buffer, reading the pipes with the Bun stream API (required here:
 *  `on("data")` listeners never deliver bytes under Bun and silently deadlock). */
async function runFfmpegToBuffer(
  args: string[]
): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  const child = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { ok: code === 0, stdout: Buffer.from(out), stderr: err };
}

/**
 * Decode a clip ONCE at low resolution into RGB24 frames. This is the single
 * ffmpeg pass the stability and face scorers share.
 *
 * Cost: decoding the whole clip at 96x54 is still a full decode, so on a long
 * clip this is the expensive step (capped by probeMaxSeconds). A Phase-2b
 * optimisation is to seek per slice window (−ss before −i) and probe only the
 * windows that are actually candidates, which trades one pass for N seeks; v1
 * deliberately keeps ONE pass per clip so the probe cache is trivial.
 */
export async function probeClipVisual(
  filePath: string,
  opts: ResolvedOptions
): Promise<VisualFrames | undefined> {
  const { probeFps: fps, probeWidth: w, probeHeight: h, probeMaxSeconds } = opts;
  const { ok, stdout, stderr } = await runFfmpegToBuffer([
    "-i", filePath,
    "-t", String(probeMaxSeconds),
    "-an",
    "-vf", `fps=${fps},scale=${w}:${h}:flags=bilinear`,
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "pipe:1",
  ]);
  if (!ok) {
    // A corrupt/undecodable file is not fatal — the clip simply scores neutral.
    console.error(`director: probe failed for ${filePath}: ${stderr.trim().slice(0, 200)}`);
    return undefined;
  }
  const frameBytes = w * h * 3;
  const count = Math.floor(stdout.length / frameBytes);
  if (count === 0) return undefined;
  const frames: Uint8Array[] = new Array(count);
  for (let i = 0; i < count; i++) {
    frames[i] = stdout.subarray(i * frameBytes, (i + 1) * frameBytes);
  }
  return { width: w, height: h, fps, frames };
}

/** Frame indices covering [fromMs, toMs) of a probed clip (≥ 2 frames when the
 *  probe has them, so a diff always exists). */
function frameRange(frames: VisualFrames, fromMs: number, toMs: number): [number, number] {
  const msPerFrame = 1000 / frames.fps;
  let i0 = Math.floor(fromMs / msPerFrame);
  let i1 = Math.ceil(toMs / msPerFrame);
  i0 = clamp(i0, 0, Math.max(0, frames.frames.length - 1));
  i1 = clamp(i1, 0, frames.frames.length);
  if (i1 - i0 < 2) {
    if (i0 > 0) i0 = i0 - 1;
    else i1 = Math.min(frames.frames.length, i1 + 1);
  }
  return [i0, i1];
}

/** Mean absolute per-pixel difference of two RGB24 frames, normalized to 0..1. */
function frameDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
  return sum / (a.length * 255);
}

// ---------------------------------------------------------------------------
// 3) stability scorer (default implementation)
// ---------------------------------------------------------------------------

export interface StabilityStats {
  stability: number;
  motion_per_sec: number;
  jitter_per_sec: number;
  frames: number;
}

/**
 * Raw stability statistics for a window (also used by the demo for calibration).
 *
 * BOTH statistics are ROBUST (median-based), and that is deliberate. The first
 * implementation used mean + standard deviation and it read badly on real-shaped
 * footage: a single hard content change inside the window (a subject walking in, a
 * light switching on, the moment a recording starts) spiked both, so a perfectly
 * locked-off camera scored as shaky. A genuinely shaky camera has a CONSISTENTLY
 * large frame-to-frame change, which is exactly what the median captures; the
 * median absolute deviation (scaled by 1.4826, so it is comparable to a standard
 * deviation) captures how erratic that change is while ignoring one-off outliers.
 *
 *   motion_per_sec = median(frame diffs) × fps   — typical change per second
 *   jitter_per_sec = 1.4826 × MAD(frame diffs) × fps — how erratic it is
 *
 * Known limitation: a fast pan, a whip, heavy sensor noise or a strongly moving
 * subject all register as "motion", and this is a shake proxy, not optical-flow
 * stabilisation. The bias (prefer the calmest camera) is the right one for a live
 * switcher.
 */
export function stabilityStats(
  frames: VisualFrames,
  fromMs: number,
  toMs: number,
  opts: ResolvedOptions
): StabilityStats {
  const [i0, i1] = frameRange(frames, fromMs, toMs);
  const diffs: number[] = [];
  for (let i = i0 + 1; i < i1; i++) diffs.push(frameDiff(frames.frames[i - 1], frames.frames[i]));
  if (diffs.length === 0) {
    return { stability: 1, motion_per_sec: 0, jitter_per_sec: 0, frames: 0 };
  }
  const med = percentile(diffs, 0.5);
  const motion = med * frames.fps;
  const deviations = diffs.map((d) => Math.abs(d - med));
  const jitter = 1.4826 * percentile(deviations, 0.5) * frames.fps;
  const penalty =
    0.55 * clamp01(motion / opts.motionRefPerSec) + 0.45 * clamp01(jitter / opts.jitterRefPerSec);
  return {
    stability: clamp01(1 - penalty),
    motion_per_sec: motion,
    jitter_per_sec: jitter,
    frames: diffs.length + 1,
  };
}

// Standalone default implementation of the stability signal, for callers that
// inject their own scorer. It uses default calibration — the built-in path in
// scoreCandidates uses the caller's resolved options.
export const defaultStabilityScorer: StabilityScorer = (ctx) => {
  if (!ctx.frames) return 0;
  return stabilityStats(
    ctx.frames,
    ctx.candidate.source_start_ms,
    ctx.candidate.source_start_ms + ctx.candidate.source_duration_ms,
    resolveOptions()
  ).stability;
};

// ---------------------------------------------------------------------------
// 4) audio scorer (cached envelope first, decode only as a fallback)
// ---------------------------------------------------------------------------

/** The loudness anchor for the whole event: the loudest envelope sample seen.
 *  Adaptive because event audio is mixed — a quiet wedding-room clip should not
 *  be scored 0 just because nobody was clipping. */
export function envelopeReference(clips: DirectorClip[], opts: ResolvedOptions): number {
  let best = 0;
  for (const c of clips) {
    const vals = c.envelope?.values;
    if (!vals || vals.length === 0) continue;
    best = Math.max(best, percentile(vals, 0.99));
  }
  if (best <= 0) return opts.singleClipAudioRef;
  return Math.max(best, opts.audioRefFloor);
}

export interface AudioStats {
  audio: number;
  level_mean: number;
  level_p90: number;
  speechiness: number;
  windows: number;
}

/**
 * Score an RMS envelope over [fromMs, toMs) of the clip's own time.
 * `ref` is the event loudness anchor (envelopeReference).
 */
export function audioStats(
  values: number[],
  windowMs: number,
  fromMs: number,
  toMs: number,
  ref: number,
  opts: ResolvedOptions
): AudioStats {
  const i0 = clamp(Math.floor(fromMs / windowMs), 0, Math.max(0, values.length - 1));
  const i1 = clamp(Math.ceil(toMs / windowMs), i0 + 1, values.length);
  const win = values.slice(i0, i1);
  if (win.length === 0) {
    return { audio: 0, level_mean: 0, level_p90: 0, speechiness: 0, windows: 0 };
  }
  const m = mean(win);
  const p90 = percentile(win, 0.9);
  const level = 0.65 * clamp01(m / ref) + 0.35 * clamp01(p90 / ref);
  // Speech-likeness (cheap, honest heuristic — NOT a voice-activity detector):
  // speech is syllabic, so at 50 ms resolution the envelope jitters up and down
  // continuously (~4 Hz), while a steady tone, music pad or room tone does not.
  // We measure the MEDIAN absolute change between adjacent windows relative to
  // the mean level, not the variance: a median is immune to the one-off jump a
  // window can contain (a mic being unmuted, a door slamming), which a variance
  // would count as "lots of syllables" — the first implementation made that
  // mistake in the demo and it was visible in the score matrix.
  // The whole term is GATED BY LEVEL: CoV-style measures divide by the mean, so a
  // nearly silent window (a dead mic, a pocketed phone) would otherwise be
  // rewarded for "varying". Silence is not speech.
  const adj: number[] = [];
  for (let i = 1; i < win.length; i++) adj.push(Math.abs(win[i] - win[i - 1]));
  const syllabicRate = m > 1e-6 ? percentile(adj, 0.5) / m : 0;
  const speechGate = clamp01(m / (opts.speechGateLevel * ref));
  const speechiness = clamp01(syllabicRate / 0.35) * speechGate;
  const audio = clamp01((1 - opts.speechWeight) * level + opts.speechWeight * speechiness);
  return { audio, level_mean: m, level_p90: p90, speechiness, windows: win.length };
}

export const defaultAudioScorer: AudioScorer = (ctx) => {
  const env = ctx.clip.envelope;
  if (!env || env.values.length === 0) return 0;
  const opts = resolveOptions();
  // Single-clip reference: the scorer's own loudest sample. The caller should
  // pass an event-wide reference through scoreCandidates when available.
  const ref = Math.max(percentile(env.values, 0.99), opts.audioRefFloor);
  return audioStats(
    env.values,
    env.windowMs,
    ctx.candidate.source_start_ms,
    ctx.candidate.source_start_ms + ctx.candidate.source_duration_ms,
    ref,
    opts
  ).audio;
};

// ---------------------------------------------------------------------------
// 5) face scorer (v1 heuristic, pluggable)
// ---------------------------------------------------------------------------

/**
 * Relaxed skin-tone test in RGB. The classic rule (R>95, G>40, B>20,
 * max−min>15, |R−G|>15, R>G, R>B) fires on light skin; the second clause is a
 * deliberately looser one so mid/dark skin also registers. Both have the usual
 * false positives (wood, beige walls, sand, warm-lit fabric) — see the
 * concentration factor and the limitations note at the top of this file.
 */
function isSkinTone(r: number, g: number, b: number): boolean {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  if (r > 95 && g > 40 && b > 20 && maxc - minc > 15 && Math.abs(r - g) > 15 && r > g && r > b) {
    return true;
  }
  return r > 60 && g > 30 && r > g && r >= b && r - g >= 10 && maxc - minc > 12;
}

export interface FaceStats {
  face: number;
  /** Fraction of the center-weighted area that is skin-toned. */
  center_skin: number;
  /** 0..1 — how clustered the skin pixels are (one blob beats a smear). */
  concentration: number;
  frames: number;
}

/**
 * The v1 face heuristic on a single probe frame: center-weighted skin fraction ×
 * concentration. Center weighting is a Gaussian on normalized coordinates
 * (σ = 0.35), so a subject in the middle of frame scores far above skin-toned
 * clutter at the edges.
 */
export function faceStatsFromFrames(
  frames: VisualFrames,
  fromMs: number,
  toMs: number,
  opts: ResolvedOptions,
  maxSamples = 3
): FaceStats {
  const [i0, i1] = frameRange(frames, fromMs, toMs);
  const span = Math.max(1, i1 - i0);
  const idxs: number[] = [];
  for (let s = 0; s < Math.min(maxSamples, span); s++) {
    idxs.push(i0 + Math.floor((s * span) / Math.min(maxSamples, span)));
  }
  const samples: FaceStats[] = idxs.map((i) => singleFrameFaceStats(frames, i, opts));
  if (samples.length === 0) {
    return { face: 0, center_skin: 0, concentration: 0, frames: 0 };
  }
  return {
    face: clamp01(mean(samples.map((s) => s.face))),
    center_skin: mean(samples.map((s) => s.center_skin)),
    concentration: mean(samples.map((s) => s.concentration)),
    frames: samples.length,
  };
}

function singleFrameFaceStats(
  frames: VisualFrames,
  frameIndex: number,
  opts: ResolvedOptions
): FaceStats {
  const { width: w, height: h } = frames;
  const px = frames.frames[clamp(frameIndex, 0, frames.frames.length - 1)];
  if (!px) return { face: 0, center_skin: 0, concentration: 0, frames: 0 };
  let wSum = 0;
  let skinWSum = 0;
  let skinTotal = 0;
  const blocks = new Array(9).fill(0);
  for (let y = 0; y < h; y++) {
    const ny = (y + 0.5) / h - 0.5; // -0.5..0.5
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w - 0.5;
      const weight = Math.exp(-((nx * nx + ny * ny) / (2 * 0.175 * 0.175)));
      wSum += weight;
      const o = (y * w + x) * 3;
      if (isSkinTone(px[o], px[o + 1], px[o + 2])) {
        skinWSum += weight;
        skinTotal++;
        const bx = Math.min(2, Math.floor((x / w) * 3));
        const by = Math.min(2, Math.floor((y / h) * 3));
        blocks[by * 3 + bx]++;
      }
    }
  }
  const centerSkin = wSum > 0 ? skinWSum / wSum : 0;
  const maxBlock = skinTotal > 0 ? Math.max(...blocks) / skinTotal : 0;
  const concentration = clamp01((maxBlock - 0.2) / 0.5);
  const face = clamp01(centerSkin / opts.skinRef) * (0.55 + 0.45 * concentration);
  return { face: clamp01(face), center_skin: centerSkin, concentration, frames: 1 };
}

/**
 * The shipping v1 face scorer. Honest scope: it measures CLUSTERED,
 * CENTER-WEIGHTED SKIN-TONED CONTENT — a cheap proxy for "a person is probably
 * in frame", not face detection. See the limitations block at the top of this
 * file.
 */
export const skinToneSaliencyFaceScorer: FaceScorer = {
  name: "skin-tone-center-saliency-v1",
  description:
    "Center-weighted skin-tone fraction × spatial concentration over ≤3 downscaled probe frames. No face detection: false positives on wood/beige/warm-lit surfaces.",
  score(ctx) {
    if (!ctx.frames) return 0;
    const opts = resolveOptions();
    return faceStatsFromFrames(
      ctx.frames,
      ctx.candidate.source_start_ms,
      ctx.candidate.source_start_ms + ctx.candidate.source_duration_ms,
      opts
    ).face;
  },
};

// ---------------------------------------------------------------------------
// 6) candidate scoring
// ---------------------------------------------------------------------------

export interface ScoreDeps {
  faceScorer?: FaceScorer;
  stabilityScorer?: StabilityScorer;
  audioScorer?: AudioScorer;
  /** Override the visual probe (tests / pre-computed frames). */
  probe?: (clip: DirectorClip) => Promise<VisualFrames | undefined>;
  /** Pre-computed visual probes keyed by clip_id. */
  probes?: Map<string, VisualFrames>;
}

export interface ScoreMatrixResult {
  slices: SliceWindow[];
  scoreMatrix: ScoredCandidate[][];
  clips_probed: number;
  clips_used: string[];
  audio_ref: number;
}

/**
 * Slice the timeline, build candidates and score every one of them.
 * One ffmpeg probe per clip (cached), zero DB, deterministic output.
 */
export async function scoreCandidates(
  input: DirectorInput,
  deps: ScoreDeps = {}
): Promise<ScoreMatrixResult> {
  const opts = resolveOptions(input.options);
  const slices = planSlices(input.timeline_ms, opts.sliceMs);
  const raw = buildCandidates(input.clips, slices);
  const byId = new Map(input.clips.map((c) => [c.clip_id, c]));
  const audioRef = envelopeReference(input.clips, opts);
  const faceScorer = deps.faceScorer ?? skinToneSaliencyFaceScorer;

  // --- visual probes: one decode per clip, cached by clip_id ---
  const probes = deps.probes ?? new Map<string, VisualFrames>();
  let probed = 0;
  if (!deps.probes) {
    for (const clip of input.clips) {
      if (probes.has(clip.clip_id)) continue;
      const p = deps.probe
        ? await deps.probe(clip)
        : clip.file_path
          ? await probeClipVisual(clip.file_path, opts)
          : undefined;
      if (p) probes.set(clip.clip_id, p);
      probed++;
    }
  }

  // --- audio envelopes: use the cache; decode once only as a fallback ---
  await fillMissingEnvelopes(input.clips);

  const scoreMatrix: ScoredCandidate[][] = [];
  for (let s = 0; s < slices.length; s++) {
    const row: ScoredCandidate[] = [];
    for (const cand of raw[s]) {
      const clip = byId.get(cand.clip_id)!;
      const ctx: ScoreContext = { candidate: cand, clip, frames: probes.get(cand.clip_id) };
      row.push(
        await scoreOne(ctx, opts, {
          faceScorer,
          stabilityScorer: deps.stabilityScorer,
          audioScorer: deps.audioScorer,
          audioRef,
        })
      );
    }
    // Eligibility: a partial candidate can only own the slice when NOTHING
    // covers it fully (see ScoredCandidate.eligible). Computed per slice.
    const hasFull = row.some((c) => !c.signals.partial);
    for (const c of row) c.eligible = hasFull ? !c.signals.partial : true;
    row.sort((a, b) => b.score - a.score || (a.clip_id < b.clip_id ? -1 : 1));
    scoreMatrix.push(row);
  }

  return {
    slices,
    scoreMatrix,
    clips_probed: probed,
    clips_used: [...new Set(raw.flat().map((c) => c.clip_id))],
    audio_ref: audioRef,
  };
}

/** Score one candidate: the three signals, fused, then coverage + sync damping. */
async function scoreOne(
  ctx: ScoreContext,
  opts: ResolvedOptions,
  deps: {
    faceScorer: FaceScorer;
    stabilityScorer?: StabilityScorer;
    audioScorer?: AudioScorer;
    audioRef: number;
  }
): Promise<ScoredCandidate> {
  const cand = ctx.candidate;
  const hasFrames = !!ctx.frames;
  const env = ctx.clip.envelope;

  // --- stability (metric + calibration live in stabilityStats) ---
  let stability = opts.missingSignalScore;
  if (hasFrames) {
    stability = deps.stabilityScorer
      ? clamp01(await deps.stabilityScorer(ctx))
      : stabilityStats(
          ctx.frames!,
          cand.source_start_ms,
          cand.source_start_ms + cand.source_duration_ms,
          opts
        ).stability;
  }

  // --- audio (cached envelope; no decode on the normal path) ---
  let audio = opts.missingSignalScore;
  let speechiness = 0;
  if (env && env.values.length > 0) {
    if (deps.audioScorer) {
      audio = clamp01(await deps.audioScorer(ctx));
    } else {
      const st = audioStats(
        env.values,
        env.windowMs,
        cand.source_start_ms,
        cand.source_start_ms + cand.source_duration_ms,
        deps.audioRef,
        opts
      );
      audio = st.audio;
      speechiness = st.speechiness;
    }
  }

  // --- face (pluggable; v1 = skin-tone center saliency) ---
  let face = opts.missingSignalScore;
  if (hasFrames) face = clamp01(await deps.faceScorer.score(ctx));

  const sliceMs = cand.window.end_ms - cand.window.start_ms;
  const coverage = clamp01(cand.source_duration_ms / sliceMs);
  const partial = coverage < 0.999;
  const confidence = ctx.clip.sync_confidence ?? 1;
  const sync_factor = clamp(0.85 + 0.15 * confidence, 0.85, 1);

  const w = opts.weights;
  const wSum = Math.max(1e-6, w.stability + w.audio + w.face);
  const fused = (w.stability * stability + w.audio * audio + w.face * face) / wSum;
  const score = clamp01(fused * (opts.coverageWeight + (1 - opts.coverageWeight) * coverage) * sync_factor);

  const signals: CandidateSignals = {
    stability,
    audio,
    face,
    coverage,
    partial,
    speechiness,
    sync_factor,
  };
  return { ...cand, score, signals, eligible: true };
}

/**
 * Stability + face stats for a candidate — exported for demos/tests that want the
 * raw numbers behind a score rather than just the fused value.
 */
export function candidateStats(
  frames: VisualFrames,
  cand: ClipSliceCandidate,
  opts: ResolvedOptions = resolveOptions()
): { stability: StabilityStats; face: FaceStats } {
  return {
    stability: stabilityStats(
      frames,
      cand.source_start_ms,
      cand.source_start_ms + cand.source_duration_ms,
      opts
    ),
    face: faceStatsFromFrames(
      frames,
      cand.source_start_ms,
      cand.source_start_ms + cand.source_duration_ms,
      opts
    ),
  };
}

// ---------------------------------------------------------------------------
// 7) envelope fallback — decode once if the cache has nothing
// ---------------------------------------------------------------------------

/**
 * If a clip has no cached envelope (audio_features miss) but has a file, decode
 * it once here so the audio signal is real instead of neutral. Kept best-effort:
 * a clip with no audio track simply stays without an envelope.
 */
async function fillMissingEnvelopes(clips: DirectorClip[]): Promise<void> {
  for (const clip of clips) {
    if (clip.envelope && clip.envelope.values.length > 0) continue;
    if (!clip.file_path || clip.media_type === "photo") continue;
    try {
      const { extractAudioFeatures } = await import("../sync/features");
      const feats = await extractAudioFeatures(clip.file_path);
      clip.envelope = { values: feats.values, windowMs: feats.windowMs };
    } catch {
      /* silent / photo / undecodable — leave it neutral */
    }
  }
}
