/**
 * align.ts — estimates the relative time offset between every pair of clips from
 * their audio envelopes, then resolves those pairwise offsets into one consistent
 * global time origin per clip on the shared event timeline.
 *
 * This is the mathematical core of Phase 1. It is deliberately pure (no I/O): it
 * takes float envelopes and returns offsets, so it is unit-testable and reusable
 * by Phase 2's auto-switcher, which asks "for this moment on the shared timeline,
 * which clips are currently live / have the best audio?".
 *
 * ── Pairwise offset ──────────────────────────────────────────────────────────
 * For two clips A and B we decode loudness envelopes a[·] and b[·] (aligned to
 * each clip's OWN clock, both starting at 0). If B's device began recording τ
 * seconds after A's device, then global time g corresponds to A's index g and to
 * B's index (g − τ). A performance event that A hears at its index n therefore
 * shows up in B at index (n − τ).
 *
 * We maximise the cross-correlation
 *     C[k] = Σ_n a[n] · b[n + k]
 * The peak lands at k where shifting B by k best superposes it onto A. With the
 * example above the peak is at k = −τ, i.e. B must shift *left* (earlier) to line
 * up with A because B started late. So:
 *
 *     offsetMs(B relative to A)  =  start_ms(B) − start_ms(A)  =  −k_peak · windowMs
 *
 * A positive result means B's recording began AFTER A's — B should be placed that
 * many ms later on the shared timeline.
 *
 * We compute C[·] exactly via the convolution theorem (FFT + zero padding), then
 * scan only the ±maxLag window for the peak, which both bounds search cost and
 * rejects nonsense alignments far outside a plausible range.
 *
 * ── Global solve ─────────────────────────────────────────────────────────────
 * Each pair measurement gives an equation   x_j − x_i = d_ij   where x_i is clip
 * i's start on the shared timeline (an unknown) and d_ij is the measured offset.
 * With N clips and up to N(N−1)/2 measurements this is an over-determined linear
 * system (redundant equations reduce noise). We solve it as a *weighted* least-
 * squares fit (weights = correlation confidence) by forming the normal equations
 *
 *     (Aᵀ W A) x = Aᵀ W b
 *
 * and solving the resulting small symmetric system with Gaussian elimination.
 * One clip is pinned to 0 as the reference; the rest fall into place.
 *
 * Confidence: a clip that has no shared audio with the others (e.g. a silent room
 * or a completely different song) produces consistently low peak correlations, so
 * its measurements disagree with the global fit. We detect those by looking at
 * each clip's average residual and *un-match* the worst offender, then re-solve —
 * the surviving set is the one that plays back time-aligned.
 */

import { fft, ifft, nextPow2 } from "./fft";

export interface Envelope {
  /** RMS loudness per window, time-ordered. */
  values: ArrayLike<number>;
  /** Window length in ms (1000 / windowMs = windows per second). */
  windowMs: number;
}

export interface PairwiseResult {
  /** offsetMs of clip j relative to clip i (start_j − start_i). */
  offsetMs: number;
  /** Peak normalised cross-correlation in [0,1]; higher = more confident. */
  confidence: number;
  /** Number of windows over which the two envelopes overlapped at the peak. */
  overlapSamples: number;
}

export interface ClipInput {
  id: string;
  envelope: Envelope;
}

export interface SolvedClip {
  id: string;
  /** Global timeline offset in ms (always >= 0 after shifting min to 0). */
  offsetMs: number;
  /** Envelope duration in ms — lets the player know when this clip ends. */
  durationMs: number;
  /** Mean |residual| of this clip's measurements after the final solve. */
  meanResidualMs: number;
  /** Average correlation confidence across this clip's measurements. */
  confidence: number;
}

export interface SolveResult {
  clips: SolvedClip[];
  /** Clips that were dropped because their audio didn't align. */
  dropped: string[];
  /** Shared timeline length in ms (max offset + max duration). */
  timelineMs: number;
}

/** Upper bound (in ms) of how far apart two cameras can legitimately start. */
const DEFAULT_MAX_LAG_MS = 30_000;
/** Min overlap (windows) required to trust a pairwise measurement. */
const MIN_OVERLAP = 4;

/**
 * Full linear cross-correlation of two real signals via FFT.
 * Returns C where C[k] = Σ_n a[n]·b[n+k], k ranging over [-(lenB-1), lenA-1].
 * Access negative lags via `corr[L + k]`.
 */
export function crossCorrelate(
  a: ArrayLike<number>,
  b: ArrayLike<number>
): Float64Array {
  const nA = a.length;
  const nB = b.length;
  const L = nextPow2(nA + nB - 1);

  // Zero-pad both inputs to length L.
  const are = new Float64Array(L);
  const aim = new Float64Array(L);
  const bre = new Float64Array(L);
  const bim = new Float64Array(L);
  for (let i = 0; i < nA; i++) are[i] = a[i];
  for (let i = 0; i < nB; i++) bre[i] = b[i];

  fft(are, aim);
  fft(bre, bim);

  // Correlation theorem: IFFT( FFT(a) · conj(FFT(b)) ).
  // Pointwise multiply then conjugate bin-by-bin.
  for (let k = 0; k < L; k++) {
    // (are + i·aim) · (bre − i·bim)
    const re = are[k] * bre[k] + aim[k] * bim[k];
    const im = aim[k] * bre[k] - are[k] * bim[k];
    are[k] = re;
    aim[k] = im;
  }
  ifft(are, aim);
  return are; // real part of the inverse transform is our correlation
}

/**
 * Estimate the relative offset between clip A (reference) and clip B.
 * @returns offsetMs of B relative to A (positive ⇒ B started later) + confidence.
 */
export function estimatePairwiseOffset(
  a: Envelope,
  b: Envelope,
  opts: { maxLagMs?: number; minOverlap?: number } = {}
): PairwiseResult {
  const windowMs = a.windowMs; // both envelopes share the same windowMs by construction
  const maxLagMs = opts.maxLagMs ?? DEFAULT_MAX_LAG_MS;
  const minOverlap = opts.minOverlap ?? MIN_OVERLAP;
  const maxLag = Math.round(maxLagMs / windowMs);

  const va = a.values;
  const vb = b.values;

  // Lag-wise *normalized* cross-correlation (Pearson correlation computed over
  // the actual overlapping windows at each candidate lag). This is the key to
  // robust audio alignment:
  //   - mean-centering per overlap removes the DC bias, and
  //   - normalising by the overlapping regions' own norms makes the score
  //     independent of how much of the two clips overlap.
  // A plain (non-normalised) correlation is dominated by lag 0 simply because
  // full overlap accumulates the most energy, even when the true alignment is
  // elsewhere. This per-lag normalisation fixes that.
  const minK = Math.max(-maxLag, -(vb.length - 1));
  const maxK = Math.min(maxLag, va.length - 1);
  let bestK = 0;
  let bestConf = -Infinity;
  let bestOverlap = 0;

  for (let k = minK; k <= maxK; k++) {
    const s = Math.max(0, -k);
    const e = Math.min(va.length, vb.length - k);
    const n = e - s;
    if (n < minOverlap) continue;

    // Means over the overlapping region.
    let mA = 0;
    let mB = 0;
    for (let i = s; i < e; i++) {
      mA += va[i];
      mB += vb[i + k];
    }
    mA /= n;
    mB /= n;

    // Pearson correlation of the overlapping slices.
    let num = 0;
    let nA = 0;
    let nB = 0;
    for (let i = s; i < e; i++) {
      const da = va[i] - mA;
      const db = vb[i + k] - mB;
      num += da * db;
      nA += da * da;
      nB += db * db;
    }
    const denom = Math.sqrt(nA) * Math.sqrt(nB);
    const c = denom > 0 ? num / denom : 0;
    if (c > bestConf) {
      bestConf = c;
      bestK = k;
      bestOverlap = n;
    }
  }

  const confident = bestOverlap >= minOverlap && Number.isFinite(bestConf);
  return {
    offsetMs: -bestK * windowMs, // see derivation at top of file
    confidence: confident ? Math.max(0, Math.min(1, bestConf)) : 0,
    overlapSamples: bestOverlap,
  };
}

/**
 * Resolve a consistent global offset for every clip from the pairwise offsets.
 *
 * `clips` provides each clip's envelope; pairs are measured between all clips that
 * actually have audio. Returns the solved timeline with unmatched clips dropped.
 */
export function solveGlobalOffsets(
  clips: ClipInput[],
  opts: {
    maxLagMs?: number;
    minConfidence?: number;
    maxResidualMs?: number;
  } = {}
): SolveResult {
  const maxLagMs = opts.maxLagMs ?? DEFAULT_MAX_LAG_MS;
  const minConfidence = opts.minConfidence ?? 0.25;
  const maxResidualMs = opts.maxResidualMs ?? Math.max(250, maxLagMs * 0.02);
  const windowMs = clips[0]?.envelope.windowMs ?? 50;

  // 1) Measure every ordered pair (i, j), i≠j.
  const measurements: Array<{
    i: number;
    j: number;
    d: number; // offsetMs of j relative to i
    w: number; // weight = confidence
  }> = [];
  for (let i = 0; i < clips.length; i++) {
    for (let j = 0; j < clips.length; j++) {
      if (i === j) continue;
      const r = estimatePairwiseOffset(clips[i].envelope, clips[j].envelope, {
        maxLagMs,
      });
      if (r.confidence >= minConfidence && r.overlapSamples >= MIN_OVERLAP) {
        measurements.push({ i, j, d: r.offsetMs, w: r.confidence });
      }
    }
  }

  // 2) Weighted least-squares solve; drop badly-fitting clips and re-solve until
  //    the residual budget is met or nothing is left to drop.
  let active = clips.map((_, n) => n);
  let solved: number[] = [];
  for (let round = 0; round < 10; round++) {
    const idxSet = new Set(active);
    const local = measurements.filter((m) => idxSet.has(m.i) && idxSet.has(m.j));
    if (local.length === 0) break;
    const { x, residuals } = solveWeightedLS(active, local, clips.length);
    solved = x;

    // Per-clip mean absolute residual.
    const resSum = new Float64Array(clips.length);
    const resCnt = new Float64Array(clips.length);
    for (let m = 0; m < local.length; m++) {
      const r = residuals[m];
      resSum[local[m].i] += r;
      resCnt[local[m].i] += 1;
      resSum[local[m].j] += r;
      resCnt[local[m].j] += 1;
    }
    // Worst offender among active clips; reference clip (index 0) is kept pinned.
    let worstIdx = -1;
    let worstRes = -Infinity;
    for (const idx of active) {
      if (idx === active[0]) continue; // never drop the reference
      const meanRes = resCnt[idx] > 0 ? resSum[idx] / resCnt[idx] : 0;
      if (meanRes > worstRes) {
        worstRes = meanRes;
        worstIdx = idx;
      }
    }
    if (worstIdx === -1 || worstRes <= maxResidualMs || active.length <= 2) break;
    active = active.filter((n) => n !== worstIdx);
  }

  // 3) Shift the solution so the earliest clip starts at 0 on the shared timeline.
  let minX = Infinity;
  for (const idx of active) minX = Math.min(minX, solved[idx]);
  if (!Number.isFinite(minX)) minX = 0;

  const matched: SolvedClip[] = [];
  const dropped: string[] = [];
  const activeSet = new Set(active);
  for (let n = 0; n < clips.length; n++) {
    const clip = clips[n];
    if (!activeSet.has(n)) {
      dropped.push(clip.id);
      continue;
    }
    matched.push({
      id: clip.id,
      offsetMs: solved[n] - minX,
      durationMs: Math.round(clip.envelope.values.length * windowMs),
      meanResidualMs: Math.round(meanResidual(clips, solved, measurements, n)),
      confidence: meanConfidence(clips, measurements, n, activeSet),
    });
  }
  matched.sort((m1, m2) => m1.offsetMs - m2.offsetMs);

  let timelineMs = 0;
  for (const m of matched) timelineMs = Math.max(timelineMs, m.offsetMs + m.durationMs);

  return { clips: matched, dropped, timelineMs };

  // ----------------------------------------------------------------- helpers
  function meanResidual(
    _clips: ClipInput[],
    x: number[],
    meas: typeof measurements,
    n: number
  ): number {
    let s = 0;
    let c = 0;
    for (const m of meas) {
      if (m.i === n) {
        s += Math.abs(x[m.j] - x[m.i] - m.d);
        c++;
      } else if (m.j === n) {
        s += Math.abs(x[m.j] - x[m.i] - m.d);
        c++;
      }
    }
    return c ? s / c : 0;
  }
}

function meanConfidence(
  _clips: ClipInput[],
  meas: { i: number; j: number; d: number; w: number }[],
  n: number,
  activeSet: Set<number>
): number {
  let s = 0;
  let c = 0;
  for (const m of meas) {
    if ((m.i === n || m.j === n) && activeSet.has(m.i) && activeSet.has(m.j)) {
      s += m.w;
      c++;
    }
  }
  return c ? s / c : 0;
}

/**
 * Solve the over-constrained system  x_j − x_i = d (weighted) for free variables.
 * `indices` is the ordered list of clip indices in play; index `indices[0]` is the
 * pinned reference (x = 0). Returns solved x over ALL original clip slots (0 for
 * inactive) plus per-measurement residuals.
 */
function solveWeightedLS(
  indices: number[],
  measurements: { i: number; j: number; d: number; w: number }[],
  total: number
): { x: number[]; residuals: number[] } {
  // Unknowns are x for indices[1..] (indices[0] is fixed at 0 = the reference).
  const nFree = indices.length - 1;
  // Map original clip slot -> free-variable column (or -1 if pinned/inactive).
  const colOf = new Int32Array(total).fill(-1);
  for (let c = 0; c < nFree; c++) colOf[indices[c + 1]] = c;

  // Normal equations: N = Aᵀ·W·A (nFree×nFree), rhs = Aᵀ·W·b (nFree).
  // Each measurement encodes row  A̲:  +1 at ref-j column, −1 at ref-i column
  // (pinned reference contributes nothing). For weight w and reading d:
  //   N[p][q] += w · A[p]·A[q]
  //   rhs[p]  += w · A[p]·d
  const N = Array.from({ length: nFree }, () => new Float64Array(nFree));
  const rhs = new Float64Array(nFree);

  const freeCol = (idx: number): number => (idx === indices[0] ? -1 : colOf[idx]);

  for (const m of measurements) {
    const iFree = freeCol(m.i);
    const jFree = freeCol(m.j);
    if (iFree === -1 && jFree === -1) continue; // both are the pinned reference
    const w = m.w;
    const d = m.d;
    // diagonal + off-diagonal from each present coefficient
    const cols: number[] = [];
    if (jFree >= 0) cols.push(jFree);
    if (iFree >= 0) cols.push(iFree);
    const signs: number[] = [];
    if (jFree >= 0) signs.push(1);
    if (iFree >= 0) signs.push(-1);

    for (let p = 0; p < cols.length; p++) {
      rhs[cols[p]] += w * signs[p] * d;
      for (let q = 0; q < cols.length; q++) {
        N[cols[p]][cols[q]] += w * signs[p] * signs[q];
      }
    }
  }

  const xFree = solveLinear(N, rhs, nFree);
  const x = new Array(total).fill(0);
  for (let c = 0; c < nFree; c++) x[indices[c + 1]] = xFree[c];

  const residuals = measurements.map((m) => {
    const pred = (m.j === indices[0] ? 0 : x[m.j]) - (m.i === indices[0] ? 0 : x[m.i]);
    return Math.abs(pred - m.d);
  });

  return { x: Array.from(x), residuals };
}

/** Solve a small symmetric positive-(semi)definite system via Gaussian elim. */
function solveLinear(A: Float64Array[], b: Float64Array, n: number): number[] {
  const M = A.map((row) => Float64Array.from(row));
  const B = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    // Partial pivot.
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col) {
      [M[col], M[piv]] = [M[piv], M[col]];
      [B[col], B[piv]] = [B[piv], B[col]];
    }
    const p = M[col][col];
    if (Math.abs(p) < 1e-12) continue; // degenerate column — leave as-is
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
      B[r] -= f * B[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) x[i] = M[i][i] !== 0 ? B[i] / M[i][i] : 0;
  return x;
}
