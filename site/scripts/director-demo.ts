/**
 * scripts/director-demo.ts — PROOF that the Phase-2a auto-cut director works.
 *
 * Run:  cd /home/team/shared/site && bun scripts/director-demo.ts
 *
 * What it does, top to bottom:
 *   1. Synthesizes THREE realistic phone-style clips with ffmpeg lavfi, each with
 *      a deliberately different weakness/strength (known ground truth):
 *        A  steady camera, quiet audio, subject (skin tones) in frame   — 4 s
 *        B  SHAKY handheld, LOUD audio, nothing skin-toned in frame     — 8 s
 *        C  steady camera, moderate clean audio, subject in frame, but its
 *           first 2 s are a dark/quiet lead-in (camera not on the subject yet)
 *                                                                      — 10 s
 *   2. Places them on a shared timeline with known offsets, exactly as Phase 1's
 *      audio alignment would (event_sync): A@0, B@2000, C@6000, timeline 16000 ms.
 *   3. Extracts each clip's RMS envelope with the SAME extractor that fills the
 *      `audio_features` cache, and hands it to the director as the cached
 *      envelope — so the audio signal is scored from cache, never re-decoded.
 *   4. Runs the real pipeline: planSlices → buildCandidates → scoreCandidates
 *      (stability via low-res frame diffs, audio via the cached envelope, face via
 *      the v1 skin-tone/center heuristic) → selectShots (Viterbi + switch penalty
 *      + no-jump-cut taboo).
 *   5. Prints the raw stability/audio/face numbers, the per-slice candidate score
 *      matrix, and the final shot list; then SELF-ASSERTS:
 *        - timeline fully covered, exactly once, no gaps where footage exists;
 *        - no jump-cut violations (cooldown respected, shots ≥ min hold);
 *        - the chosen camera per slice is the best-scoring camera there;
 *        - the deliberately-best clip wins its windows (A the opening, B the loud
 *          middle, C the steady finish) — i.e. the decision matches ground truth;
 *        - the raw metrics really do rank steady > shaky and loud > quiet;
 *        - four hand-built selector cases (flap trap, min-hold, gap, penalty)
 *          prove the DP's constraints independent of any video measurement.
 *   6. Writes the whole result (matrix + shots + diagnostics) to
 *      /home/team/shared/director-demo-output.json, reads it BACK and prints it,
 *      proving the artifact is well-formed for Phase 2b to consume.
 *
 * Exits non-zero on any failed assertion.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractAudioFeatures } from "../src/lib/sync/features";
import {
  buildCandidates,
  candidateStats,
  planSlices,
  probeClipVisual,
  resolveOptions,
  scoreCandidates,
} from "../src/lib/director/score";
import { greedyShots, selectShots, sequenceToString } from "../src/lib/director/select";
import type {
  DirectorClip,
  DirectorInput,
  ScoredCandidate,
  SliceWindow,
  VisualFrames,
} from "../src/lib/director/types";

const DIR = "/tmp/director-demo";
const OUT_JSON = "/home/team/shared/director-demo-output.json";
const FFMPEG = "ffmpeg";
const SLICE_MS = 4000;
const TIMELINE_MS = 16000;

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}
function f(v: number, digits = 3): string {
  return v.toFixed(digits);
}
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// ffmpeg helper — Bun stream API for pipe reading (child_process listeners
// silently deliver nothing under Bun; that bug cost us a render once already).
// ---------------------------------------------------------------------------
async function ffmpegOk(args: string[]): Promise<void> {
  const child = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`ffmpeg failed (${args.slice(-1)[0]}): ${err.trim()}`);
}

async function ffprobeDurationS(file: string): Promise<number> {
  const child = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-print_format", "json", file],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" }
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  return Number(JSON.parse(out)?.format?.duration ?? 0);
}

// ---------------------------------------------------------------------------
// 1) synthesize the three clips
// ---------------------------------------------------------------------------

/**
 * A — steady, quiet, subject centered.
 * The camera is locked off (only per-pixel sensor noise + one slowly drifting
 * object), audio is a quiet 300 Hz tone (~6% amplitude), and a skin-toned block
 * sits in the middle of frame.
 */
const CLIP_A_VIDEO =
  "color=c=#1b3a5c:s=640x360:r=24:d=4," +
  "drawbox=x=275:y=105:w=95:h=115:c=#e2b394:t=fill," +
  "drawbox=x='70+30*sin(0.45*t)':y=45:w=40:h=40:c=#dedede:t=fill," +
  "noise=alls=3:allf=t";

/**
 * B — hand-held, shaky, loud, nothing skin-toned.
 * The whole frame jitters: a slightly larger scene is cropped with an x/y that
 * swings on two incommensurate sinusoids plus random jitter (a real hand is not
 * periodic). Audio is a loud 620 Hz tone (~55% amplitude). Every visible patch is
 * blue/green/red — no skin tone — so the face signal cannot rescue it.
 */
const CLIP_B_VIDEO =
  "color=c=#2e6b4f:s=680x400:r=24:d=8," +
  "drawbox=x=120:y=70:w=130:h=130:c=#2b56a8:t=fill," +
  "drawbox=x='400+45*sin(1.1*t)':y=190:w=60:h=60:c=#bb4444:t=fill," +
  "crop=640:360:x='20+7*sin(37*t)+5*random(1)':y='20+7*cos(41*t)+5*random(2)'," +
  "noise=alls=8:allf=t";

/**
 * C — steady + clean, but a 2 s lead-in. For t<2 s a black box covers the frame
 * and the tone is a whisper (camera on, not yet on the subject); after 2 s the
 * skin-toned subject and a 440 Hz tone at ~22% appear. So C is the right camera
 * for the LAST part of the timeline and the wrong one for the START of its own
 * coverage — which is exactly the situation the director must get right.
 */
const CLIP_C_VIDEO =
  "color=c=#432a52:s=640x360:r=24:d=10," +
  "drawbox=x=0:y=0:w=640:h=360:c=black:t=fill:enable='lt(t,2)'," +
  "drawbox=x=250:y=100:w=110:h=130:c=#e7b99a:t=fill:enable='gte(t,2)'," +
  "drawbox=x='85+25*sin(0.4*t)':y=60:w=45:h=45:c=#e8e8e8:t=fill:enable='gte(t,2)'," +
  "noise=alls=3:allf=t";

interface ClipSpec {
  id: string;
  label: string;
  video: string;
  audio: string;
  offset_ms: number;
  declared_s: number;
  sync_confidence: number;
}

const SPECS: ClipSpec[] = [
  {
    id: "A",
    label: "A steady / quiet / subject",
    video: CLIP_A_VIDEO,
    audio: "sine=frequency=300:sample_rate=44100:duration=4,volume=0.05",
    offset_ms: 0,
    declared_s: 4,
    sync_confidence: 0.92,
  },
  {
    id: "B",
    label: "B shaky / loud / no subject",
    video: CLIP_B_VIDEO,
    audio: "sine=frequency=620:sample_rate=44100:duration=8,volume=0.55",
    offset_ms: 2000,
    declared_s: 8,
    sync_confidence: 0.71,
  },
  {
    id: "C",
    label: "C steady / clean / 2s lead-in",
    video: CLIP_C_VIDEO,
    audio:
      "sine=frequency=440:sample_rate=44100:duration=10," +
      "volume=volume='if(lt(t,2),0.02,0.22)':eval=frame",
    offset_ms: 6000,
    declared_s: 10,
    sync_confidence: 0.85,
  },
];

async function synthClips(): Promise<Map<string, string>> {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  const files = new Map<string, string>();
  for (const spec of SPECS) {
    const out = path.join(DIR, `clip${spec.id}.mp4`);
    await ffmpegOk([
      "-f", "lavfi", "-i", spec.video,
      "-f", "lavfi", "-i", spec.audio,
      "-shortest",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      out,
    ]);
    files.set(spec.id, out);
  }
  return files;
}

// ---------------------------------------------------------------------------
// hand-built selector cases (pure logic, no ffmpeg) — the constraints' own proof
// ---------------------------------------------------------------------------

function mkCandidate(clipId: string, slice: SliceWindow, score: number): ScoredCandidate {
  return {
    clip_id: clipId,
    window: slice,
    source_start_ms: 0,
    source_duration_ms: slice.end_ms - slice.start_ms,
    score,
    signals: {
      stability: score,
      audio: score,
      face: score,
      coverage: 1,
      speechiness: 0,
      sync_factor: 1,
    },
  };
}

function logicCases(): void {
  console.log("\n=== 5) SELECTOR LOGIC PROOF (hand-built scores, no video) ===");
  const slices = planSlices(16000, SLICE_MS); // 4 slices

  // (a) THE FLAP TRAP: A and B alternate as per-slice argmax. A naive switcher
  //     would cut A-B-A-B (every cut is a jump back). The DP must refuse.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.9), mkCandidate("B", slices[0], 0.4)],
      [mkCandidate("B", slices[1], 0.9), mkCandidate("A", slices[1], 0.4)],
      [mkCandidate("A", slices[2], 0.9), mkCandidate("B", slices[2], 0.4)],
      [mkCandidate("B", slices[3], 0.9), mkCandidate("A", slices[3], 0.4)],
    ];
    const greedy = greedyShots(matrix, slices);
    const sel = selectShots(matrix, slices, { returnCooldownSlices: 2, minHoldSlices: 1 });
    const seq = sel.camera_sequence;
    let flap = false;
    for (let i = 2; i < seq.length; i++) {
      if (seq[i] !== seq[i - 1] && seq[i] === seq[i - 2]) flap = true;
    }
    console.log(`   greedy argmax : ${sequenceToString(greedy)}`);
    console.log(`   Viterbi + taboo: ${sequenceToString(seq)}`);
    check("(a) greedy argmax really flaps A-B-A (the trap is real)", greedy.join("") === "ABAB");
    check("(a) Viterbi never returns to a camera within the cooldown (no A-B-A)", !flap);
    check("(a) no coverage lost while respecting the taboo", sel.violations.length === 0);
  }

  // (b) MIN HOLD: a camera that just cut in cannot be cut away from for
  //     minHoldSlices slices, even when another camera scores better.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.9), mkCandidate("B", slices[0], 0.3)],
      [mkCandidate("B", slices[1], 0.95), mkCandidate("A", slices[1], 0.5)],
      [mkCandidate("A", slices[2], 0.95), mkCandidate("B", slices[2], 0.5)],
      [mkCandidate("A", slices[3], 0.95), mkCandidate("B", slices[3], 0.5)],
    ];
    const sel = selectShots(matrix, slices, { minHoldSlices: 2, returnCooldownSlices: 2 });
    const runs = sel.shots.map((s) => s.slices ?? 0);
    console.log(`   minHold=2 shots : ${sel.shots.map((s) => `${s.clip_id}×${s.slices}`).join(" ")}`);
    check(
      "(b) every shot lasts at least minHoldSlices",
      runs.every((r) => r >= 2) && sel.violations.length === 0,
      `runs = ${runs.join(",")}`
    );
  }

  // (c) GAP: a slice nobody covered is skipped and reported, and the same camera
  //     before/after the hole does NOT get merged into one continuous shot.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.8)],
      [],
      [mkCandidate("A", slices[2], 0.8)],
      [mkCandidate("A", slices[3], 0.8)],
    ];
    const sel = selectShots(matrix, slices);
    console.log(
      `   gaps            : ${sel.gaps.map((g) => `[${g.start_ms},${g.end_ms})`).join(" ") || "none"}`
    );
    check(
      "(c) uncovered slice reported as a gap with its exact window",
      sel.gaps.length === 1 && sel.gaps[0].start_ms === 4000 && sel.gaps[0].end_ms === 8000
    );
    check(
      "(c) shots are not merged across the gap (A stops, A resumes)",
      sel.shots.length === 2 && sel.shots[0].end_ms === 4000 && sel.shots[1].start_ms === 8000
    );
  }

  // (d) SWITCH PENALTY: two cameras 0.05 apart, alternating, must NOT be cut
  //     between — the cut costs 0.15, more than the 0.05 it buys.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.70), mkCandidate("B", slices[0], 0.50)],
      [mkCandidate("B", slices[1], 0.75), mkCandidate("A", slices[1], 0.70)],
      [mkCandidate("A", slices[2], 0.75), mkCandidate("B", slices[2], 0.70)],
      [mkCandidate("B", slices[3], 0.75), mkCandidate("A", slices[3], 0.70)],
    ];
    const sel = selectShots(matrix, slices, { switchPenalty: 0.15 });
    const unique = new Set(sel.camera_sequence);
    console.log(`   near-equal case : ${sequenceToString(sel.camera_sequence)}`);
    check(
      "(d) switch penalty suppresses needless cuts (stays on one camera)",
      unique.size === 1 && sel.camera_sequence.length === 4
    );
    const sel0 = selectShots(matrix, slices, { switchPenalty: 0 });
    check(
      "(d) with switchPenalty=0 the same data does switch (penalty is what stopped it)",
      new Set(sel0.camera_sequence).size > 1
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log("=== PHASE 2a AUTO-CUT DIRECTOR DEMO ===");
  console.log(`slice = ${SLICE_MS} ms, shared timeline = ${TIMELINE_MS} ms\n`);

  console.log("=== 1) Synthesizing clips (ffmpeg lavfi, 640x360@24fps, known ground truth) ===");
  const files = await synthClips();
  for (const spec of SPECS) {
    const dur = await ffprobeDurationS(files.get(spec.id)!);
    console.log(
      `   clip ${spec.id}: ${f(spec.declared_s, 2)}s declared / ${f(dur, 2)}s file — ${spec.label}`
    );
  }

  console.log("\n=== 2) Audio envelopes via the real feature extractor (the cache path) ===");
  const envelopes = new Map<string, { values: number[]; windowMs: number }>();
  for (const spec of SPECS) {
    const feats = await extractAudioFeatures(files.get(spec.id)!, { sampleRate: 8000, windowMs: 50 });
    envelopes.set(spec.id, { values: feats.values, windowMs: feats.windowMs });
    const peak = Math.max(...feats.values);
    const mid = feats.values.slice(0, Math.ceil(feats.values.length / 2));
    const meanMid = mid.reduce((a, b) => a + b, 0) / Math.max(1, mid.length);
    console.log(
      `   clip ${spec.id}: ${feats.values.length} windows @${feats.windowMs}ms, peak RMS ${f(peak, 0)}, first-half mean RMS ${f(meanMid, 0)}`
    );
  }

  const clips: DirectorClip[] = [];
  for (const spec of SPECS) {
    const file = files.get(spec.id)!;
    const durMs = Math.round((await ffprobeDurationSafe(file)) * 1000);
    clips.push({
      clip_id: `clip${spec.id}`,
      label: spec.label,
      offset_ms: spec.offset_ms,
      // The director is given the FILE duration (what ffmpeg can actually read),
      // not the declared one — the two must agree or a shot would ask for
      // footage that does not exist.
      duration_ms: durMs,
      file_path: file,
      media_type: "video",
      envelope: envelopes.get(spec.id),
      sync_confidence: spec.sync_confidence,
    });
  }

  console.log("\n=== 3) Shared timeline (what Phase 1's alignment hands over) ===");
  for (const c of clips) {
    console.log(
      `   ${c.clip_id}: offset ${c.offset_ms} ms, duration ${c.duration_ms} ms → covers [${c.offset_ms}, ${c.offset_ms + c.duration_ms})  conf ${c.sync_confidence}`
    );
  }

  const opts = resolveOptions({ sliceMs: SLICE_MS });
  const slices = planSlices(TIMELINE_MS, SLICE_MS);
  const rawCandidates = buildCandidates(clips, slices);
  console.log("\n   slices and their candidates (source windows):");
  for (let t = 0; t < slices.length; t++) {
    const list = rawCandidates[t]
      .map((c) => `${c.clip_id}@src${c.source_start_ms}+${c.source_duration_ms}`)
      .join(", ");
    console.log(`     t${t} [${slices[t].start_ms},${slices[t].end_ms}) → ${list || "(no footage)"}`);
  }

  console.log("\n=== 4) Visual probe (one low-res decode per clip) ===");
  const probes = new Map<string, VisualFrames>();
  for (const c of clips) {
    const p = await probeClipVisual(c.file_path!, opts);
    if (p) probes.set(c.clip_id, p);
    console.log(
      `   ${c.clip_id}: ${p ? `${p.frames.length} frames @${p.width}x${p.height}, ${p.fps}fps` : "PROBE FAILED"}`
    );
  }

  console.log("\n   RAW SIGNAL MEASUREMENTS (before weighting) — this is what the metric sees:");
  console.log(
    `   ${pad("clip", 7)}${pad("window", 16)}${pad("stab", 8)}${pad("motion/s", 10)}${pad("jitter/s", 10)}${pad("face", 8)}${pad("skin%", 8)}`
  );
  const rawStats = new Map<string, { stability: number; face: number; motion: number; jitter: number }>();
  for (let t = 0; t < slices.length; t++) {
    for (const cand of rawCandidates[t]) {
      const frames = probes.get(cand.clip_id);
      if (!frames) continue;
      const st = candidateStats(frames, cand, opts);
      rawStats.set(`${cand.clip_id}@t${t}`, {
        stability: st.stability.stability,
        face: st.face.face,
        motion: st.stability.motion_per_sec,
        jitter: st.stability.jitter_per_sec,
      });
      console.log(
        `   ${pad(cand.clip_id, 7)}${pad(`[${cand.source_start_ms},${cand.source_start_ms + cand.source_duration_ms})`, 16)}` +
          `${pad(f(st.stability.stability), 8)}${pad(f(st.stability.motion_per_sec, 4), 10)}${pad(f(st.stability.jitter_per_sec, 4), 10)}` +
          `${pad(f(st.face.face), 8)}${pad(f(st.face.center_skin * 100, 1), 8)}`
      );
    }
  }

  const scored = await scoreCandidates(
    { clips, timeline_ms: TIMELINE_MS, options: { sliceMs: SLICE_MS } },
    { probes }
  );

  console.log("\n=== 6) SCORE MATRIX (stability / audio / face → fused; fused already) ===");
  console.log(
    `   ${pad("slice", 18)}${pad("clip", 8)}${pad("coverage", 10)}${pad("stab", 8)}${pad("audio", 8)}${pad("face", 8)}${pad("speech", 8)}${pad("FUSED", 8)}`
  );
  for (let t = 0; t < slices.length; t++) {
    const row = scored.scoreMatrix[t];
    if (row.length === 0) {
      console.log(`   ${pad(`t${t} [${slices[t].start_ms},${slices[t].end_ms})`, 18)}— no footage —`);
      continue;
    }
    for (const c of row) {
      console.log(
        `   ${pad(`t${t} [${c.window.start_ms},${c.window.end_ms})`, 18)}${pad(c.clip_id, 8)}` +
          `${pad(f(c.signals.coverage, 2), 10)}${pad(f(c.signals.stability), 8)}${pad(f(c.signals.audio), 8)}` +
          `${pad(f(c.signals.face), 8)}${pad(f(c.signals.speechiness), 8)}${pad(f(c.score), 8)}`
      );
    }
  }

  const selection = selectShots(scored.scoreMatrix, scored.slices, { sliceMs: SLICE_MS });
  console.log("\n=== 7) FINAL SHOT LIST (what Phase 2b renders) ===");
  console.log(`   camera per slice: ${sequenceToString(selection.camera_sequence)}`);
  console.log(`   greedy argmax   : ${sequenceToString(greedyShots(scored.scoreMatrix, scored.slices))}`);
  for (const s of selection.shots) {
    const clip = clips.find((c) => c.clip_id === s.clip_id)!;
    console.log(
      `   ${pad(s.clip_id, 7)} timeline [${pad(String(s.start_ms), 5)},${pad(String(s.end_ms), 5)}) ` +
        `${pad(((s.end_ms - s.start_ms) / 1000).toFixed(1) + "s", 7)} src [${s.start_ms - clip.offset_ms},${s.end_ms - clip.offset_ms}) ` +
        `${s.cut_in ? "CUT-IN" : "OPEN"}  mean score ${f(s.mean_score ?? 0)}`
    );
  }
  console.log(`   gaps: ${selection.gaps.length}, jump-cut violations: ${selection.violations.length}, switch penalty paid: ${f(selection.total_switch_penalty)}`);

  // -------------------------------------------------------------------------
  // assertions on the real pipeline
  // -------------------------------------------------------------------------
  console.log("\n=== 8) SELF-ASSERTIONS (real pipeline) ===");

  // (1) coverage: shots tile the timeline exactly, in order, no overlap.
  let cursor = 0;
  let tiled = true;
  for (const s of selection.shots) {
    if (s.start_ms !== cursor || s.end_ms <= s.start_ms) tiled = false;
    cursor = s.end_ms;
  }
  check("(1) shot list tiles the timeline with no gaps/overlaps", tiled && cursor === TIMELINE_MS, `covered 0→${cursor} of ${TIMELINE_MS}`);
  check("(1) no uncovered slices were reported", selection.gaps.length === 0);

  // (2) no jump cuts: recompute the taboo from the emitted shot list itself.
  let tabuOk = true;
  let holdOk = true;
  for (let i = 0; i < selection.camera_sequence.length; i++) {
    const cur = selection.camera_sequence[i];
    if (
      i >= 2 &&
      cur !== selection.camera_sequence[i - 1] &&
      cur === selection.camera_sequence[i - 2]
    ) {
      tabuOk = false; // A-B-A: returned to the camera we just cut away from
    }
  }
  for (const s of selection.shots) if ((s.slices ?? 0) < 1) holdOk = false;
  check("(2) no A-B-A flapping anywhere in the shot list", tabuOk);
  check("(2) selector recorded no taboo violations", selection.violations.length === 0);
  check("(2) every shot covers at least one full slice", holdOk);

  // (3) chosen == best-scoring candidate in every slice.
  let argmaxOk = true;
  for (let t = 0; t < slices.length; t++) {
    const row = scored.scoreMatrix[t];
    if (row.length === 0) continue;
    const best = row.reduce((a, b) => (b.score > a.score ? b : a));
    const chosen = selection.camera_sequence[t];
    if (best.clip_id !== chosen) {
      argmaxOk = false;
      console.log(`      slice t${t}: best is ${best.clip_id} (${f(best.score)}) but chose ${chosen}`);
    }
  }
  check("(3) the chosen camera is the best-scoring camera in every slice", argmaxOk);

  // (4) ground truth: A opens, B wins the loud middle, C owns the steady finish.
  const expected: Array<{ t: number; clips: string[]; why: string }> = [
    { t: 0, clips: ["clipA"], why: "only A is steady+on-subject here; B is shaky and covers half the slice" },
    { t: 1, clips: ["clipB"], why: "B is loud and covers the whole slice; C is still in its dark quiet lead-in" },
    { t: 2, clips: ["clipC"], why: "C is steady, on-subject and full-coverage; B is shaky and half-coverage here" },
    { t: 3, clips: ["clipC"], why: "only C has footage (forced) and it continues the shot" },
  ];
  let truthOk = true;
  for (const e of expected) {
    const got = selection.camera_sequence[e.t];
    const ok = e.clips.includes(got);
    if (!ok) truthOk = false;
    console.log(`      t${e.t} chose ${got}, expected ${e.clips.join("|")} — ${e.why}`);
  }
  check("(4) the deliberately-best clip wins each window (ground truth match)", truthOk);
  check(
    "(4) the result cuts exactly twice: A→B→C, a 3-shot film",
    selection.shots.length === 3 &&
      selection.shots.map((s) => s.clip_id).join(",") === "clipA,clipB,clipC"
  );

  // (5) the raw metrics rank what they claim to rank.
  const stabA0 = rawStats.get("clipA@t0")!.stability;
  const stabB0 = rawStats.get("clipB@t0")!.stability;
  const stabC2 = rawStats.get("clipC@t2")!.stability;
  check(
    "(5) stability ranks locked-off cameras above the hand-held one",
    stabA0 > stabB0 + 0.15 && stabC2 > stabB0 + 0.15,
    `A ${f(stabA0)} C ${f(stabC2)} vs B ${f(stabB0)} (motion/s B ${f(rawStats.get("clipB@t0")!.motion, 3)})`
  );
  const envB = envelopes.get("B")!;
  const envA = envelopes.get("A")!;
  const envC = envelopes.get("C")!;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const lvlB = mean(envB.values);
  const lvlC = mean(envC.values);
  const lvlA = mean(envA.values);
  check(
    "(5) audio envelope ranks loud > clean > quiet as synthesized",
    lvlB > lvlC && lvlC > lvlA,
    `RMS B ${f(lvlB, 0)} > C ${f(lvlC, 0)} > A ${f(lvlA, 0)}`
  );
  const faceA0 = rawStats.get("clipA@t0")!.face;
  const faceB0 = rawStats.get("clipB@t0")!.face;
  check(
    "(5) face heuristic fires on the centered skin-toned subject, not on blue/green",
    faceA0 > 0.4 && faceB0 < 0.15,
    `A ${f(faceA0)}, B ${f(faceB0)}`
  );
  const cLeadIn = rawStats.get("clipC@t1")!;
  const cSubject = rawStats.get("clipC@t2")!;
  check(
    "(5) C's detector sees the lead-in as empty and the later window as on-subject",
    cLeadIn.face < 0.05 && cSubject.face > 0.4,
    `lead-in face ${f(cLeadIn.face)}, subject face ${f(cSubject.face)}`
  );

  logicCases();

  // -------------------------------------------------------------------------
  // artifact + readback
  // -------------------------------------------------------------------------
  const artifact = {
    generated_by: "scripts/director-demo.ts (Phase 2a)",
    slice_ms: SLICE_MS,
    timeline_ms: TIMELINE_MS,
    clips: clips.map((c) => ({
      clip_id: c.clip_id,
      label: c.label,
      offset_ms: c.offset_ms,
      duration_ms: c.duration_ms,
      frame: `[${c.offset_ms}, ${c.offset_ms + c.duration_ms})`,
      sync_confidence: c.sync_confidence,
      file_path: c.file_path,
    })),
    slices: slices.map((s, t) => ({
      ...s,
      candidates: (scored.scoreMatrix[t] ?? []).map((c) => ({
        clip_id: c.clip_id,
        source_start_ms: c.source_start_ms,
        source_duration_ms: c.source_duration_ms,
        score: Number(c.score.toFixed(6)),
        signals: {
          stability: Number(c.signals.stability.toFixed(6)),
          audio: Number(c.signals.audio.toFixed(6)),
          face: Number(c.signals.face.toFixed(6)),
          coverage: Number(c.signals.coverage.toFixed(6)),
          speechiness: Number(c.signals.speechiness.toFixed(6)),
          sync_factor: Number(c.signals.sync_factor.toFixed(6)),
        },
      })),
    })),
    shots: selection.shots,
    gaps: selection.gaps,
    violations: selection.violations,
    camera_sequence: selection.camera_sequence,
    total_switch_penalty: Number(selection.total_switch_penalty.toFixed(6)),
    diagnostics: {
      ...scored,
      scoreMatrix: undefined,
      slices: undefined,
      weights: opts.weights,
      switch_penalty: opts.switchPenalty,
      return_cooldown_slices: opts.returnCooldownSlices,
      min_hold_slices: opts.minHoldSlices,
      face_scorer: "skin-tone-center-saliency-v1",
    },
    assertions: { failed: failures, passed: failures.length === 0 },
  };

  console.log("\n=== 9) ARTIFACT ===");
  await writeFile(OUT_JSON, JSON.stringify(artifact, null, 2), "utf8");
  // Read it back and verify it parses into the same shape the renderer will use.
  const back = (await Bun.file(OUT_JSON).json()) as typeof artifact;
  const backShots = back.shots
    .map((s) => `${s.clip_id}[${s.start_ms},${s.end_ms})`)
    .join(" ");
  console.log(`   wrote ${OUT_JSON}`);
  console.log(`   read back: ${back.shots.length} shots, ${back.slices.length} slices, ${back.clips.length} clips`);
  console.log(`   read-back shot list: ${backShots}`);
  console.log(`   read-back score for clipC@t2: ${back.slices[2]?.candidates?.find((c) => c.clip_id === "clipC")?.score}`);
  check(
    "(6) shot-list JSON round-trips unchanged",
    backShots === selection.shots.map((s) => `${s.clip_id}[${s.start_ms},${s.end_ms})`).join(" ") &&
      back.slices.length === slices.length &&
      back.slices.every((s) => s.candidates.length > 0 || s.start_ms === 4000)
  );
  check(
    "(6) every shot in the artifact carries clip_id + start_ms + end_ms (2b's contract)",
    back.shots.every(
      (s) => typeof s.clip_id === "string" && Number.isFinite(s.start_ms) && Number.isFinite(s.end_ms)
    )
  );

  console.log(
    failures.length === 0
      ? "\n✅ PHASE 2a DIRECTOR DEMO PASS — every assertion held"
      : `\n❌ PHASE 2a DIRECTOR DEMO FAIL — ${failures.length} assertion(s) failed:\n   - ${failures.join("\n   - ")}`
  );

  if (process.env.KEEP_DEMO_CLIPS !== "1") await rm(DIR, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

/** ffprobe guard used while assembling the clip list. */
async function ffprobeDurationSafe(file: string): Promise<number> {
  try {
    const d = await ffprobeDurationS(file);
    return d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("director-demo error:", err);
    process.exit(1);
  });
