/**
 * director/select.ts — the Viterbi / DP shot selector ("the switcher brain").
 *
 * Input : scoreMatrix[t] = the scored candidates for slice t (score.ts).
 * Output: an ordered, gap-free DirectorShot[] covering the whole timeline.
 *
 * THE PROBLEM. Picking the best-scoring camera independently per slice is a live
 * switcher that cuts every 4 seconds and, worse, flaps: the two best cameras
 * alternate slice after slice producing A-B-A-B jump-cut-pattern edits that look
 * broken. So shot selection is a constrained sequence problem, not a per-slice
 * argmax: we want the highest total emission (sum of chosen candidate scores)
 * minus the cost of the cuts we make, subject to rules that keep edits watchable.
 *
 * THE SOLVER. Viterbi over slices. The state carries just enough history to
 * decide whether the next slice may switch to a given camera:
 *
 *     state = { cur, runLen, recent[] }
 *
 *   cur     — the camera live in the previous slice; recent[0] === cur.
 *   runLen  — how many consecutive slices cur has been live (min-hold / no
 *             strobe cuts: a shot never restarts before minHoldSlices).
 *   recent  — the cameras used in the previous K slices, newest first
 *             (K = returnCooldownSlices). This is the NO-JUMP-CUT TABOO list:
 *             switching to a camera that is still in recent[1..] is forbidden,
 *             because that would return to a camera we only just cut away from —
 *             and with K = 2 that is exactly the A-B-A flap.
 *
 * Cost model per transition (a change of camera) = switchPenalty (default 0.15),
 * which is compared against emission differences in the same 0..1 units: a
 * switch happens only when holding costs more than 0.15 of score, i.e. when the
 * other camera is meaningfully better, not when it is 0.01 better.
 *
 * COVERAGE BEATS SMOOTHNESS, deliberately: if the taboo list would leave a slice
 * unreachable (the only candidate is a camera we just cut away from — common when
 * one phone covered a stretch on its own), the DP takes the least-bad transition
 * and records it in `violations`. A jump cut is a blemish; a missing moment is a
 * hole in the film.
 *
 * Edges: a slice with exactly one candidate is forced; a slice with NO candidates
 * (no clip has footage there) is skipped and reported as a gap. Nothing else can
 * change the timeline's absolute times.
 */

import type {
  DirectorClip,
  DirectorGap,
  DirectorOptions,
  DirectorShot,
  DirectorViolation,
  ScoredCandidate,
  SliceWindow,
} from "./types";
import { resolveOptions } from "./score";

export interface DirectorSelection {
  shots: DirectorShot[];
  gaps: DirectorGap[];
  violations: DirectorViolation[];
  /** Total switch penalty paid by the chosen path (diagnostics). */
  total_switch_penalty: number;
  /** Objective value of the chosen path: Σ emissions − penalties (diagnostics,
   *  and what the demo checks against a brute-force optimum). */
  total_score: number;
  /** Cameras used, in order (diagnostics). */
  camera_sequence: string[];
  /** Slice indices whose only candidates were partial (a clamped shot, + a gap). */
  partial_slices: number[];
}

interface State {
  key: string;
  cur: string;
  runLen: number;
  recent: string[];
  score: number;
  penalty: number;
  violations: DirectorViolation[];
  /** Chosen candidate for this slice (for mean_score reporting). */
  cand: ScoredCandidate;
  prev: State | null;
  sliceIndex: number;
}

function stateKey(cur: string, runLen: number, recent: string[]): string {
  return `${cur}|${runLen}|${recent.join(">")}`;
}

/**
 * Select the shot sequence. `scoreMatrix[t]` must correspond to `slices[t]`.
 *
 * `clips` is optional but strongly recommended: it carries the clip footprints
 * (offset_ms + duration_ms) that shots are clamped to, so a shot NEVER asks for
 * source time outside the clip's own file. Without it, clamping falls back to the
 * candidate's own source window (correct for the common cases, see
 * `coveredRangeFor`).
 */
export function selectShots(
  scoreMatrix: ScoredCandidate[][],
  slices: SliceWindow[],
  options: DirectorOptions = {},
  clips: DirectorClip[] = []
): DirectorSelection {
  const opts = resolveOptions(options);
  const K = Math.max(1, Math.round(opts.returnCooldownSlices));
  const minHold = Math.max(1, Math.round(opts.minHoldSlices));
  const clipById = new Map(clips.map((c) => [c.clip_id, c]));

  /** Best state per slice index (one entry per distinct history key). */
  let frontier: State[] = [];
  const chosen: State[] = []; // one surviving state per slice (backtrace anchor)
  const gaps: DirectorGap[] = [];
  const partialSlices: number[] = [];

  for (let t = 0; t < slices.length; t++) {
    const window = slices[t];
    // Only ELIGIBLE candidates may own the slice (a partial candidate is
    // ineligible when some other clip fills the slice completely).
    const candidates = (scoreMatrix[t] ?? []).filter((c) => c.eligible);
    if (candidates.length === 0) {
      // No footage at all in this window: a gap (recorded below from the final
      // shot union, so it is indexed here only for the reason).
      continue;
    }
    if (candidates.every((c) => c.signals.partial)) partialSlices.push(t);

    const next: State[] = [];
    const bestByKey = new Map<string, State>();

    const push = (s: State) => {
      const existing = bestByKey.get(s.key);
      if (!existing || s.score > existing.score) bestByKey.set(s.key, s);
    };

    if (frontier.length === 0) {
      // First covered slice: seed a state per candidate.
      for (const cand of candidates) {
        push({
          key: stateKey(cand.clip_id, 1, [cand.clip_id]),
          cur: cand.clip_id,
          runLen: 1,
          recent: [cand.clip_id],
          score: cand.score,
          penalty: 0,
          violations: [],
          cand,
          prev: null,
          sliceIndex: t,
        });
      }
    } else {
      for (const st of frontier) {
        for (const cand of candidates) {
          if (cand.clip_id === st.cur) {
            // Continuation: no cut, no cost, run gets longer.
            push({
              ...st,
              key: stateKey(st.cur, st.runLen + 1, st.recent),
              runLen: st.runLen + 1,
              score: st.score + cand.score,
              cand,
              prev: st,
              sliceIndex: t,
            });
            continue;
          }
          // A cut: allowed unless the taboo list or min-hold forbids it.
          const inCooldown = st.recent.slice(1).includes(cand.clip_id);
          const violatesHold = st.runLen < minHold;
          const legal = !inCooldown && !violatesHold;
          const penalty = opts.switchPenalty + (legal ? 0 : opts.violationPenalty);
          const recent = [cand.clip_id, ...st.recent].slice(0, K);
          const nextViolations = legal
            ? st.violations
            : [
                ...st.violations,
                {
                  slice_index: t,
                  start_ms: window.start_ms,
                  clip_id: cand.clip_id,
                  reason: inCooldown
                    ? `return to camera ${cand.clip_id} within ${K}-slice cooldown (would be a jump cut)`
                    : `cut away before min hold of ${minHold} slice(s)`,
                },
              ];
          push({
            key: stateKey(cand.clip_id, 1, recent),
            cur: cand.clip_id,
            runLen: 1,
            recent,
            score: st.score + cand.score - penalty,
            penalty: st.penalty + penalty,
            violations: nextViolations,
            cand,
            prev: st,
            sliceIndex: t,
          });
        }
      }
    }

    next.push(...bestByKey.values());
    next.sort((a, b) => b.score - a.score);
    // Keep the frontier bounded on big events: drop near-duplicate histories that
    // are dominated (same camera-run, worse score). The top 64 states are plenty
    // for realistic clip counts and keep the DP linear-ish.
    frontier = next.slice(0, 64);
    const best = frontier[0];
    chosen.push(best);
  }

  // --- backtrace: one camera decision per covered slice ---
  const sequence: Array<{ clip_id: string; cand: ScoredCandidate; sliceIndex: number }> = [];
  let node: State | null = chosen.length > 0 ? chosen[chosen.length - 1] : null;
  while (node) {
    sequence.push({ clip_id: node.cur, cand: node.cand, sliceIndex: node.sliceIndex });
    node = node.prev;
  }
  sequence.reverse();

  // --- merge consecutive same-camera slices into shots, clamped to footage ---
  const shots: DirectorShot[] = [];
  const steps: Array<{ cand: ScoredCandidate; from: number; to: number }> = sequence.map((s) => {
    const clipped = coveredRangeFor(s.cand, slices[s.sliceIndex], clipById.get(s.cand.clip_id));
    return { cand: s.cand, from: clipped[0], to: clipped[1] };
  });

  for (const step of steps) {
    if (step.to <= step.from) continue; // no real footage for this step (defensive)
    const last = shots[shots.length - 1];
    // Merge only when the camera is the same AND the footage is contiguous —
    // a clamp (partial coverage) or a gap breaks the shot, because the film
    // cannot be continuous across a stretch it has no footage for.
    if (last && last.clip_id === step.cand.clip_id && last.end_ms === step.from) {
      last.end_ms = step.to;
      last.slices = (last.slices ?? 1) + 1;
      last.mean_score = ((last.mean_score ?? 0) * (last.slices - 1) + step.cand.score) / last.slices;
      continue;
    }
    shots.push({
      clip_id: step.cand.clip_id,
      start_ms: step.from,
      end_ms: step.to,
      slices: 1,
      mean_score: step.cand.score,
      cut_in: shots.length > 0,
    });
  }

  // --- gaps = the timeline minus the union of the shots --------------------
  // This is the authoritative gap list: it covers BOTH slices with no footage at
  // all and the uncovered remainder of a slice whose only camera could not fill
  // it. Shots are non-overlapping and ascending by construction, so a single
  // sweep is enough.
  gaps.length = 0;
  const timelineEnd = slices.length > 0 ? slices[slices.length - 1].end_ms : 0;
  let cursor = 0;
  for (const shot of shots) {
    if (shot.start_ms > cursor) {
      gaps.push(makeGap(cursor, shot.start_ms, slices, partialSlices));
    }
    cursor = Math.max(cursor, shot.end_ms);
  }
  if (cursor < timelineEnd) gaps.push(makeGap(cursor, timelineEnd, slices, partialSlices));

  const finalState = chosen.length > 0 ? chosen[chosen.length - 1] : null;
  return {
    shots,
    gaps,
    violations: finalState?.violations ?? [],
    total_switch_penalty: finalState?.penalty ?? 0,
    total_score: finalState?.score ?? 0,
    camera_sequence: sequence.map((s) => s.clip_id),
    partial_slices: partialSlices,
  };
}

/** Classify a gap: nothing at all covered that slice, or only a partial camera. */
function makeGap(
  start_ms: number,
  end_ms: number,
  slices: SliceWindow[],
  partialSlices: number[]
): DirectorGap {
  const slice_index = slices.findIndex((s) => start_ms >= s.start_ms && start_ms < s.end_ms);
  const idx = slice_index >= 0 ? slice_index : 0;
  return {
    start_ms,
    end_ms,
    slice_index: idx,
    reason: partialSlices.includes(idx) ? "partial_coverage" : "no_footage",
  };
}

/**
 * The stretch of the shared timeline a chosen candidate can actually show.
 *
 * With the clip's footprint we simply intersect: [slice] ∩ [offset, offset+dur].
 * Without it we infer from the candidate's source window: a partial candidate
 * either starts at its file's beginning (so it covers the TAIL of the slice) or
 * ends at its file's end (so it covers the HEAD).
 */
function coveredRangeFor(
  cand: ScoredCandidate,
  slice: SliceWindow,
  clip: DirectorClip | undefined
): [number, number] {
  if (clip) {
    const from = Math.max(slice.start_ms, clip.offset_ms);
    const to = Math.min(slice.end_ms, clip.offset_ms + clip.duration_ms);
    return [from, Math.max(from, to)];
  }
  if (!cand.signals.partial) return [slice.start_ms, slice.end_ms];
  const len = cand.source_duration_ms;
  if (cand.source_start_ms === 0) return [slice.end_ms - len, slice.end_ms];
  return [slice.start_ms, slice.start_ms + len];
}

/**
 * The naive baseline: per-slice argmax, no constraints. Exported ONLY so the
 * demo can show what the switcher would do without the taboo list (it flaps
 * A-B-A on the hand-built proof case). Never use this to render.
 */
export function greedyShots(
  scoreMatrix: ScoredCandidate[][],
  slices: SliceWindow[]
): string[] {
  const out: string[] = [];
  for (let t = 0; t < slices.length; t++) {
    const candidates = (scoreMatrix[t] ?? []).filter((c) => c.eligible);
    if (candidates.length === 0) continue;
    let best = candidates[0];
    for (const c of candidates) if (c.score > best.score) best = c;
    out.push(best.clip_id);
  }
  return out;
}

/** Compact "A A B C" string for logs. */
export function sequenceToString(seq: string[]): string {
  return seq.join(" ");
}
