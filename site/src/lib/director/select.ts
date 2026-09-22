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
  /** Cameras used, in order (diagnostics). */
  camera_sequence: string[];
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
 */
export function selectShots(
  scoreMatrix: ScoredCandidate[][],
  slices: SliceWindow[],
  options: DirectorOptions = {}
): DirectorSelection {
  const opts = resolveOptions(options);
  const K = Math.max(1, Math.round(opts.returnCooldownSlices));
  const minHold = Math.max(1, Math.round(opts.minHoldSlices));

  /** Best state per slice index (one entry per distinct history key). */
  let frontier: State[] = [];
  const chosen: State[] = []; // one surviving state per slice (backtrace anchor)
  const gaps: DirectorGap[] = [];
  const violations: DirectorViolation[] = [];

  for (let t = 0; t < slices.length; t++) {
    const window = slices[t];
    const candidates = scoreMatrix[t] ?? [];
    if (candidates.length === 0) {
      // No footage at all in this window: a gap. History is carried through
      // unchanged — the film simply has nothing to show here.
      gaps.push({ ...window, slice_index: t });
      continue;
    }

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

  // --- merge consecutive same-camera slices into shots; gaps break shots ---
  const shots: DirectorShot[] = [];
  const coveredSlices = new Set(sequence.map((s) => s.sliceIndex));
  let current: {
    clip_id: string;
    start_ms: number;
    end_ms: number;
    count: number;
    scoreSum: number;
  } | null = null;

  for (let t = 0; t < slices.length; t++) {
    if (!coveredSlices.has(t)) {
      // Gap: close the open shot; a later same-camera run does NOT merge across
      // the hole (the footage is missing, the shots are not continuous).
      if (current) {
        shots.push(finishShot(current, shots.length > 0));
        current = null;
      }
      continue;
    }
    const pick = sequence.find((s) => s.sliceIndex === t)!;
    if (current && current.clip_id === pick.clip_id) {
      current.end_ms = slices[t].end_ms;
      current.count++;
      current.scoreSum += pick.cand.score;
    } else {
      if (current) shots.push(finishShot(current, shots.length > 0));
      current = {
        clip_id: pick.clip_id,
        start_ms: slices[t].start_ms,
        end_ms: slices[t].end_ms,
        count: 1,
        scoreSum: pick.cand.score,
      };
    }
  }
  if (current) shots.push(finishShot(current, shots.length > 0));

  const finalState = chosen.length > 0 ? chosen[chosen.length - 1] : null;
  return {
    shots,
    gaps,
    violations: finalState?.violations ?? [],
    total_switch_penalty: finalState?.penalty ?? 0,
    camera_sequence: sequence.map((s) => s.clip_id),
  };
}

function finishShot(
  cur: { clip_id: string; start_ms: number; end_ms: number; count: number; scoreSum: number },
  cutIn: boolean
): DirectorShot {
  return {
    clip_id: cur.clip_id,
    start_ms: cur.start_ms,
    end_ms: cur.end_ms,
    slices: cur.count,
    mean_score: cur.scoreSum / cur.count,
    cut_in: cutIn,
  };
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
    const candidates = scoreMatrix[t] ?? [];
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
