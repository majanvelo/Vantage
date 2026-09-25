/**
 * scripts/director-demo.ts — PROOF that the Phase-2a auto-cut director works.
 *
 * Run:  cd /home/team/shared/site && bun scripts/director-demo.ts
 *
 * The demo synthesizes three realistic phone-style clips with ffmpeg lavfi, each
 * with a deliberately different weakness/strength (known ground truth), puts them
 * on a shared timeline with known offsets (exactly what Phase 1's audio alignment
 * produces), and runs the REAL pipeline: slices → candidates → per-candidate
 * scoring (stability / audio / face) → Viterbi selection with a switch penalty and
 * a no-jump-cut taboo. Then it asserts — hard — on the result.
 *
 * GROUND TRUTH (what the director SHOULD produce, and why):
 *
 *   timeline 0s ──────── 4s ──────── 8s ──────── 12s ──────── 16s
 *   clip A   [========================]                 steady, subject in frame,
 *                                                      decent audio … then the
 *                                                      phone is picked up at 4s
 *                                                      (violent shake + muffled)
 *   clip B   [========================================] hand-held and shaking the
 *                                                      whole time, LOUDEST audio,
 *                                                      nothing skin-toned in frame
 *   clip C                   [========================] 2s dark+quiet lead-in, then
 *                                                      steady + subject + clean audio
 *
 *   Expected: slice 0 → A  (steady, on the subject, audio good enough; B shakes
 *                            and has nobody in frame)
 *             slice 1 → B  (A went to pieces at 4s; B is loud and covers it fully)
 *             slice 2 → C  (steady, on the subject, clean audio; B still shakes)
 *             slice 3 → C  (only C has footage; continuation needs no cut)
 *   ⇒ shots: A[0,4000) B[4000,8000) C[8000,16000) — a 3-shot film, 2 cuts.
 *
 * Every assertion is printed with its inputs so a reviewer can see WHY it held.
 * Exits non-zero on any failure. Writes /home/team/shared/director-demo-output.json
 * and reads it back to prove the artifact is consumable by Phase 2b.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
// ffmpeg / ffprobe helpers (Bun stream API — child_process listeners deliver
// nothing under Bun, which once cost us a silent unbounded render)
// ---------------------------------------------------------------------------
/** Same minimal local shape as score.ts — avoids depending on the Bun global
 *  types being present in tsconfig (they are not). */
interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}
const BUN = (globalThis as unknown as {
  Bun: { spawn: (cmd: string[], opts?: Record<string, unknown>) => SpawnedProcess };
}).Bun;

async function ffmpegOk(args: string[]): Promise<void> {
  const child = BUN.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`ffmpeg failed (${args.slice(-1)[0]}): ${err.trim()}`);
}

async function ffprobeDurationS(file: string): Promise<number> {
  const child = BUN.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-print_format", "json", file],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" }
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  const d = Number(JSON.parse(out)?.format?.duration ?? 0);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

// ---------------------------------------------------------------------------
// 1) the three clips (640x360@24fps, ~realistic for a downscaled phone clip)
// ---------------------------------------------------------------------------

/**
 * A — locked off and pointed at the subject for the first 4 s, then the phone is
 * PICKED UP: from t=4 s the whole frame jitters hard (two incommensurate
 * sinusoids + random jitter, the shape of a real hand) and the mic goes dead
 * (the phone is in a pocket). A very slowly drifting marker box + light sensor
 * noise keep the first 4 s from being a frozen test pattern.
 */
const CLIP_A_VIDEO =
  "color=c=#1b3a5c:s=760x480:r=24:d=8," +
  "drawbox=x=330:y=150:w=110:h=140:c=#e2b394:t=fill," +
  "drawbox=x='110+30*sin(0.45*t)':y=80:w=50:h=50:c=#dedede:t=fill," +
  "noise=alls=3:allf=t," +
  "crop=640:360:x='60+if(lt(t,4),0,35*sin(29*t)+20*random(1))':" +
  "y='60+if(lt(t,4),0,32*cos(31*t)+18*random(2))'";

/**
 * B — hand-held for its entire 16 s: the whole frame shakes continuously, the
 * audio is the LOUDEST of the three (it is closest to the action), and every
 * visible patch is blue/green — nothing skin-toned, so the face signal cannot
 * rescue it.
 */
const CLIP_B_VIDEO =
  "color=c=#2e6b4f:s=760x480:r=24:d=16," +
  "drawbox=x=150:y=90:w=140:h=140:c=#2b56a8:t=fill," +
  "drawbox=x='470+50*sin(1.1*t)':y=230:w=70:h=70:c=#44cc88:t=fill," +
  "noise=alls=8:allf=t," +
  "crop=640:360:x='60+35*sin(27*t)+20*random(1)':y='60+34*cos(33*t)+18*random(2)'";

/**
 * C — steady and on the subject with clean audio, BUT its first 1.5 s are a
 * dark, whispered lead-in (camera rolling, not yet on the subject). It is
 * therefore the right camera for the END of the timeline and the wrong one for
 * the start of its own coverage.
 */
const CLIP_C_VIDEO =
  "color=c=#432a52:s=640x360:r=24:d=8," +
  "drawbox=x=0:y=0:w=640:h=360:c=black:t=fill:enable='lt(t,1.5)'," +
  "drawbox=x=250:y=100:w=110:h=130:c=#e7b99a:t=fill:enable='gte(t,1.5)'," +
  "drawbox=x='85+25*sin(0.4*t)':y=60:w=45:h=45:c=#e8e8e8:t=fill:enable='gte(t,1.5)'," +
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
    label: "A locked-off then picked up; subject; audio OK then muffled",
    video: CLIP_A_VIDEO,
    audio:
      "sine=frequency=300:sample_rate=44100:duration=8," +
      "volume=volume='if(lt(t,4),0.20,0.002)':eval=frame",
    offset_ms: 0,
    declared_s: 8,
    sync_confidence: 0.92,
  },
  {
    id: "B",
    label: "B hand-held shaking throughout; loudest audio; nobody in frame",
    video: CLIP_B_VIDEO,
    audio: "sine=frequency=620:sample_rate=44100:duration=16,volume=0.60",
    offset_ms: 0,
    declared_s: 16,
    sync_confidence: 0.72,
  },
  {
    id: "C",
    label: "C steady + subject + clean audio, but a 1.5s dark quiet lead-in",
    video: CLIP_C_VIDEO,
    audio:
      "sine=frequency=440:sample_rate=44100:duration=8," +
      "volume=volume='if(lt(t,1.5),0.02,0.22)':eval=frame",
    offset_ms: 8000,
    declared_s: 8,
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
// hand-built cases (pure logic, no video) — the constraints' own proof
// ---------------------------------------------------------------------------

function mkCandidate(
  clipId: string,
  slice: SliceWindow,
  score: number,
  partial = false,
  eligible = !partial
): ScoredCandidate {
  return {
    clip_id: clipId,
    window: slice,
    source_start_ms: 0,
    source_duration_ms: partial ? (slice.end_ms - slice.start_ms) / 2 : slice.end_ms - slice.start_ms,
    score,
    signals: {
      stability: score,
      audio: score,
      face: score,
      coverage: partial ? 0.5 : 1,
      partial,
      speechiness: 0,
      sync_factor: 1,
    },
    eligible,
  };
}

/** Clips that cover the whole timeline, so nothing is clamped in the logic cases. */
function fullClips(ids: string[], timelineMs = TIMELINE_MS): DirectorClip[] {
  return ids.map((clip_id) => ({
    clip_id,
    offset_ms: 0,
    duration_ms: timelineMs,
    media_type: "video" as const,
  }));
}

function logicCases(): void {
  console.log("\n=== 7) SELECTOR LOGIC PROOF (hand-built scores, no video involved) ===");
  const slices = planSlices(TIMELINE_MS, SLICE_MS); // 4 slices
  const abc = fullClips(["A", "B", "C"]);

  // (a) THE FLAP TRAP: A and B alternate as per-slice argmax. A naive switcher
  //     cuts A-B-A-B — every cut jumps back to a camera it just left. The DP must
  //     refuse, which is only provable because the greedy baseline does flap.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.9), mkCandidate("B", slices[0], 0.4)],
      [mkCandidate("B", slices[1], 0.9), mkCandidate("A", slices[1], 0.4)],
      [mkCandidate("A", slices[2], 0.9), mkCandidate("B", slices[2], 0.4)],
      [mkCandidate("B", slices[3], 0.9), mkCandidate("A", slices[3], 0.4)],
    ];
    const greedy = greedyShots(matrix, slices);
    const sel = selectShots(matrix, slices, { returnCooldownSlices: 2, minHoldSlices: 1 }, abc);
    const seq = sel.camera_sequence;
    let flap = false;
    for (let i = 2; i < seq.length; i++) {
      if (seq[i] !== seq[i - 1] && seq[i] === seq[i - 2]) flap = true;
    }
    console.log(`     greedy argmax   : ${sequenceToString(greedy)}`);
    console.log(`     Viterbi + taboo : ${sequenceToString(seq)}`);
    check("(a) the greedy baseline really does flap A-B-A (the trap is real)", greedy.join("") === "ABAB");
    check("(a) Viterbi never returns to a camera inside the cooldown", !flap);
    check("(a) nothing was lost to respect the taboo", sel.violations.length === 0);
  }

  // (b) MIN HOLD: once cut to, a camera must stay for minHoldSlices slices.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.9), mkCandidate("B", slices[0], 0.3)],
      [mkCandidate("B", slices[1], 0.99), mkCandidate("A", slices[1], 0.5)],
      [mkCandidate("A", slices[2], 0.99), mkCandidate("B", slices[2], 0.5)],
      [mkCandidate("A", slices[3], 0.99), mkCandidate("B", slices[3], 0.5)],
    ];
    const sel = selectShots(matrix, slices, { minHoldSlices: 2, returnCooldownSlices: 2 }, abc);
    const runs = sel.shots.map((s) => s.slices ?? 0);
    console.log(`     minHold=2 shots : ${sel.shots.map((s) => `${s.clip_id}×${s.slices}`).join(" ")}`);
    check(
      "(b) every shot lasts at least minHoldSlices",
      runs.every((r) => r >= 2) && sel.violations.length === 0,
      `runs = ${runs.join(",")}`
    );
  }

  // (c) GAP: a slice nobody covered is reported, and the same camera on either
  //     side of the hole is NOT merged into one continuous shot.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.8)],
      [],
      [mkCandidate("A", slices[2], 0.8)],
      [mkCandidate("A", slices[3], 0.8)],
    ];
    const sel = selectShots(matrix, slices, {}, abc);
    console.log(
      `     gaps            : ${sel.gaps.map((g) => `[${g.start_ms},${g.end_ms}) ${g.reason}`).join(" ") || "none"}`
    );
    check(
      "(c) uncovered slice reported as a gap with its exact window",
      sel.gaps.length === 1 &&
        sel.gaps[0].start_ms === 4000 &&
        sel.gaps[0].end_ms === 8000 &&
        sel.gaps[0].reason === "no_footage"
    );
    check(
      "(c) no merge across the gap (A stops, A resumes)",
      sel.shots.length === 2 && sel.shots[0].end_ms === 4000 && sel.shots[1].start_ms === 8000
    );
  }

  // (d) SWITCH PENALTY: two cameras 0.05 apart, alternating. Cutting costs 0.15,
  //     which is more than the 0.05 it buys — so there is no cut at all.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("A", slices[0], 0.7), mkCandidate("B", slices[0], 0.5)],
      [mkCandidate("B", slices[1], 0.75), mkCandidate("A", slices[1], 0.7)],
      [mkCandidate("A", slices[2], 0.75), mkCandidate("B", slices[2], 0.7)],
      [mkCandidate("B", slices[3], 0.75), mkCandidate("A", slices[3], 0.7)],
    ];
    const sel = selectShots(matrix, slices, { switchPenalty: 0.15 }, abc);
    const sel0 = selectShots(matrix, slices, { switchPenalty: 0 }, abc);
    console.log(`     penalty 0.15    : ${sequenceToString(sel.camera_sequence)}`);
    console.log(`     penalty 0       : ${sequenceToString(sel0.camera_sequence)}`);
    check(
      "(d) switch penalty suppresses a cut that buys only 0.05",
      new Set(sel.camera_sequence).size === 1 && sel.camera_sequence.length === 4
    );
    check(
      "(d) with penalty 0 the same data does switch — the penalty is what stopped it",
      new Set(sel0.camera_sequence).size > 1
    );
  }

  // (e) PARTIAL vs FULL: a camera that only overlaps part of a slice cannot own
  //     it while another can fill it.
  {
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("B", slices[0], 0.99, true), mkCandidate("A", slices[0], 0.60)],
      [mkCandidate("A", slices[1], 0.60)],
    ];
    const partialClip: DirectorClip = { clip_id: "B", offset_ms: 1000, duration_ms: 3000 };
    const mergeable = fullClips(["A"]);
    mergeable.push(partialClip);
    const sel = selectShots(matrix, slices.slice(0, 2), {}, mergeable);
    console.log(`     partial-only-if-forced: chose ${sequenceToString(sel.camera_sequence)}`);
    check(
      "(e) a higher-scoring PARTIAL camera does not steal a slice a full camera can fill",
      sel.camera_sequence[0] === "A"
    );
  }

  // (f) CLAMP: when the only footage for a slice is partial, the shot is clamped
  //     to the real footage and the rest of the slice is a reported gap — no shot
  //     ever asks for source time outside the clip's file.
  {
    const slices2 = planSlices(8000, SLICE_MS); // [0,4000) [4000,8000)
    const matrix: ScoredCandidate[][] = [
      [mkCandidate("C", slices2[0], 0.8, true, true)], // partial, but the ONLY footage
      [], // nothing at all covers the second slice
    ];
    // C's file is only 3000 ms long and it starts 1000 ms into the timeline, so
    // its real footage covers [1000, 4000): it overlaps slice 0 only partially.
    const clipC: DirectorClip = { clip_id: "C", offset_ms: 1000, duration_ms: 3000 };
    const sel = selectShots(matrix, slices2, {}, [clipC]);
    for (const s of sel.shots) {
      console.log(
        `     clamped shot    : ${s.clip_id} [${s.start_ms},${s.end_ms}) src [${s.start_ms - clipC.offset_ms},${s.end_ms - clipC.offset_ms})`
      );
    }
    console.log(
      `     gaps            : ${sel.gaps.map((g) => `[${g.start_ms},${g.end_ms}) ${g.reason}`).join(" ") || "none"}`
    );
    check(
      "(f) a shot is clamped to the clip's real footage (never negative or overflowing source time)",
      sel.shots.length === 1 &&
        sel.shots[0].start_ms === 1000 &&
        sel.shots[0].end_ms === 4000 &&
        sel.shots[0].start_ms - clipC.offset_ms >= 0 &&
        sel.shots[0].end_ms - clipC.offset_ms <= clipC.duration_ms
    );
    check(
      "(f) both uncovered remainders are reported, with the right reason each",
      sel.gaps.length === 2 &&
        sel.gaps[0].start_ms === 0 &&
        sel.gaps[0].end_ms === 1000 &&
        sel.gaps[0].reason === "partial_coverage" &&
        sel.gaps[1].start_ms === 4000 &&
        sel.gaps[1].end_ms === 8000 &&
        sel.gaps[1].reason === "no_footage"
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log("=== PHASE 2a AUTO-CUT DIRECTOR DEMO ===");
  console.log(`slice = ${SLICE_MS} ms, shared timeline = ${TIMELINE_MS} ms`);
  const opts = resolveOptions({ sliceMs: SLICE_MS });
  console.log(
    `weights: stability ${opts.weights.stability} / audio ${opts.weights.audio} / face ${opts.weights.face}; ` +
      `switch penalty ${opts.switchPenalty}; cooldown K=${opts.returnCooldownSlices}; minHold ${opts.minHoldSlices}\n`
  );

  console.log("=== 1) Synthesizing clips (ffmpeg lavfi, 640x360@24fps, known ground truth) ===");
  const files = await synthClips();
  for (const spec of SPECS) {
    const dur = await ffprobeDurationS(files.get(spec.id)!);
    console.log(
      `   clip ${spec.id}: ${f(spec.declared_s, 2)}s declared / ${f(dur, 2)}s file — ${spec.label}`
    );
  }

  console.log("\n=== 2) Audio envelopes via the real extractor (the audio_features cache path) ===");
  const envelopes = new Map<string, { values: number[]; windowMs: number }>();
  for (const spec of SPECS) {
    const feats = await extractAudioFeatures(files.get(spec.id)!, { sampleRate: 8000, windowMs: 50 });
    envelopes.set(spec.id, { values: feats.values, windowMs: feats.windowMs });
    const half = feats.values.slice(0, Math.ceil(feats.values.length / 2));
    const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    console.log(
      `   clip ${spec.id}: ${feats.values.length} windows @${feats.windowMs}ms, peak RMS ${f(Math.max(...feats.values), 0)}, ` +
        `mean RMS first half ${f(meanOf(half), 0)} / overall ${f(meanOf(feats.values), 0)}`
    );
  }

  const clips: DirectorClip[] = [];
  for (const spec of SPECS) {
    const file = files.get(spec.id)!;
    clips.push({
      clip_id: `clip${spec.id}`,
      label: spec.label,
      offset_ms: spec.offset_ms,
      // FILE duration (what ffmpeg can really read), not the declared one.
      duration_ms: Math.round((await ffprobeDurationS(file)) * 1000),
      file_path: file,
      media_type: "video",
      envelope: envelopes.get(spec.id),
      sync_confidence: spec.sync_confidence,
    });
  }

  console.log("\n=== 3) Shared timeline (what Phase 1's alignment hands over) ===");
  for (const c of clips) {
    console.log(
      `   ${c.clip_id}: offset ${c.offset_ms}, duration ${c.duration_ms} → covers [${c.offset_ms}, ${c.offset_ms + c.duration_ms})  sync conf ${c.sync_confidence}`
    );
  }
  const slices = planSlices(TIMELINE_MS, SLICE_MS);
  const rawCandidates = buildCandidates(clips, slices);
  console.log("   slices and their candidates (source windows in the clip's own file):");
  for (let t = 0; t < slices.length; t++) {
    const list = rawCandidates[t]
      .map((c) => `${c.clip_id}@src${c.source_start_ms}+${c.source_duration_ms}`)
      .join(", ");
    console.log(`     t${t} [${slices[t].start_ms},${slices[t].end_ms}) → ${list || "(no footage)"}`);
  }

  console.log("\n=== 4) Visual probe: ONE low-res decode per clip, shared by stability + face ===");
  const probes = new Map<string, VisualFrames>();
  for (const c of clips) {
    const p = await probeClipVisual(c.file_path!, opts);
    if (p) probes.set(c.clip_id, p);
    console.log(
      `   ${c.clip_id}: ${p ? `${p.frames.length} frames @ ${p.width}x${p.height}, ${p.fps} fps` : "PROBE FAILED"}`
    );
  }

  console.log("\n   RAW SIGNAL MEASUREMENTS (before weighting) — what the metrics actually see:");
  console.log(
    `   ${pad("clip", 7)}${pad("src window", 16)}${pad("stab", 8)}${pad("motion/s", 10)}${pad("jitter/s", 10)}${pad("face", 8)}${pad("skin%", 8)}`
  );
  const rawStats = new Map<
    string,
    { stability: number; face: number; motion: number; jitter: number; centerSkin: number }
  >();
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
        centerSkin: st.face.center_skin,
      });
      console.log(
        `   ${pad(cand.clip_id, 7)}${pad(`[${cand.source_start_ms},${cand.source_start_ms + cand.source_duration_ms})`, 16)}` +
          `${pad(f(st.stability.stability), 8)}${pad(f(st.stability.motion_per_sec, 4), 10)}${pad(f(st.stability.jitter_per_sec, 4), 10)}` +
          `${pad(f(st.face.face), 8)}${pad(f(st.face.center_skin * 100, 1), 8)}`
      );
    }
  }

  console.log("\n=== 5) SCORE MATRIX (per slice × clip) ===");
  const scored = await scoreCandidates(
    { clips, timeline_ms: TIMELINE_MS, options: { sliceMs: SLICE_MS } },
    { probes }
  );
  console.log(
    `   ${pad("slice", 18)}${pad("clip", 8)}${pad("cover", 7)}${pad("stab", 8)}${pad("audio", 8)}${pad("face", 8)}${pad("elig", 6)}${pad("FUSED", 8)}`
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
          `${pad(f(c.signals.coverage, 2), 7)}${pad(f(c.signals.stability), 8)}${pad(f(c.signals.audio), 8)}` +
          `${pad(f(c.signals.face), 8)}${pad(c.eligible ? "yes" : "NO", 6)}${pad(f(c.score), 8)}`
      );
    }
  }

  const selection = selectShots(scored.scoreMatrix, scored.slices, { sliceMs: SLICE_MS }, clips);
  console.log("\n=== 6) FINAL SHOT LIST (exactly what Phase 2b renders) ===");
  console.log(`   camera per slice: ${sequenceToString(selection.camera_sequence)}`);
  console.log(`   greedy argmax   : ${sequenceToString(greedyShots(scored.scoreMatrix, scored.slices))}`);
  for (const s of selection.shots) {
    const clip = clips.find((c) => c.clip_id === s.clip_id)!;
    console.log(
      `   ${pad(s.clip_id, 7)} timeline [${pad(String(s.start_ms), 5)},${pad(String(s.end_ms), 5)}) ` +
        `${pad(((s.end_ms - s.start_ms) / 1000).toFixed(1) + "s", 7)} ` +
        `source [${pad(String(s.start_ms - clip.offset_ms), 5)},${pad(String(s.end_ms - clip.offset_ms), 5)}) ` +
        `${s.cut_in ? "CUT-IN" : "OPEN  "} mean score ${f(s.mean_score ?? 0)}`
    );
  }
  console.log(
    `   gaps: ${selection.gaps.length}, jump-cut violations: ${selection.violations.length}, total switch penalty paid: ${f(selection.total_switch_penalty)}`
  );

  // -------------------------------------------------------------------------
  // assertions on the real pipeline
  // -------------------------------------------------------------------------
  console.log("\n=== 8) SELF-ASSERTIONS (real pipeline, real clips) ===");

  // (1) coverage: the shots plus the gaps tile the timeline exactly, once each.
  let cursor = 0;
  let tiled = true;
  for (const s of selection.shots) {
    if (s.start_ms !== cursor || s.end_ms <= s.start_ms) tiled = false;
    cursor = s.end_ms;
  }
  check(
    "(1) shots + gaps tile the whole timeline exactly once",
    tiled && cursor === TIMELINE_MS && selection.gaps.length === 0,
    `covered 0→${cursor} of ${TIMELINE_MS}, gaps ${selection.gaps.length}`
  );
  check("(1) no slice went uncovered", selection.gaps.length === 0);

  // (2) no jump cuts, recomputed from the emitted shot list itself.
  let tabuOk = true;
  for (let i = 2; i < selection.camera_sequence.length; i++) {
    const cur = selection.camera_sequence[i];
    if (cur !== selection.camera_sequence[i - 1] && cur === selection.camera_sequence[i - 2]) {
      tabuOk = false;
    }
  }
  check("(2) no A-B-A flapping anywhere in the shot list", tabuOk);
  check("(2) the selector recorded no taboo violations", selection.violations.length === 0);
  check(
    "(2) every shot covers at least one full slice",
    selection.shots.every((s) => (s.slices ?? 0) >= 1)
  );
  // (2b) every shot stays inside its clip's real file — the renderer's contract.
  const inFile = selection.shots.every((s) => {
    const clip = clips.find((c) => c.clip_id === s.clip_id)!;
    return s.start_ms >= clip.offset_ms && s.end_ms <= clip.offset_ms + clip.duration_ms;
  });
  check("(2) every shot maps to real source time inside its clip's file", inFile);

  // (3) the chosen camera is never more than the switch penalty worse than the
  //     best available one — that is exactly what the penalty promises: the DP
  //     only declines the per-slice best when keeping the current camera is worth
  //     more than the cut.
  let withinPenalty = true;
  for (let t = 0; t < slices.length; t++) {
    const row = (scored.scoreMatrix[t] ?? []).filter((c) => c.eligible);
    if (row.length === 0) continue;
    const best = row.reduce((a, b) => (b.score > a.score ? b : a));
    const chosen = row.find((c) => c.clip_id === selection.camera_sequence[t]);
    if (!chosen) {
      withinPenalty = false;
      continue;
    }
    const gap = best.score - chosen.score;
    if (gap > opts.switchPenalty + 1e-9) {
      withinPenalty = false;
      console.log(`      slice t${t}: chose ${chosen.clip_id} ${f(chosen.score)} vs best ${best.clip_id} ${f(best.score)}`);
    } else if (gap > 1e-9) {
      console.log(
        `      slice t${t}: kept ${chosen.clip_id} (${f(chosen.score)}) over ${best.clip_id} (${f(best.score)}) — the cut costs ${f(opts.switchPenalty)}, the gain is only ${f(gap)}`
      );
    }
  }
  check(
    "(3) the chosen camera is never more than the switch penalty worse than the best one",
    withinPenalty
  );

  // (3b) PROVABLE OPTIMALITY: brute-force every path over the real score matrix
  //      (4 slices × 2 eligible candidates = 16 paths) with the same cost model
  //      and check the Viterbi answer is the optimum. At this scale the DP's
  //      64-state frontier cannot bind, so this is an exact check.
  const bf = bruteForceBest(scored.scoreMatrix, scored.slices, {
    switchPenalty: opts.switchPenalty,
    returnCooldownSlices: opts.returnCooldownSlices,
    minHoldSlices: opts.minHoldSlices,
    violationPenalty: opts.violationPenalty,
  });
  console.log(
    `      DP total ${f(selection.total_score, 6)} (${selection.camera_sequence.join(" ")}) vs brute force ${f(bf.score, 6)} (${bf.seq.join(" ")}) over ${bf.paths} paths`
  );
  check(
    "(3b) the Viterbi path is provably optimal (matches brute force over all paths)",
    Math.abs(bf.score - selection.total_score) < 1e-9 && bf.seq.join(" ") === selection.camera_sequence.join(" ")
  );

  // (4) ground truth: A opens, B takes the loud shaky middle, C owns the finish.
  const expected: Array<{ t: number; clips: string[]; why: string }> = [
    { t: 0, clips: ["clipA"], why: "A is steady and on the subject with fine audio; B shakes and shows nobody" },
    { t: 1, clips: ["clipB"], why: "A is picked up and its mic dies at 4s; B is loud and covers the slice" },
    { t: 2, clips: ["clipC"], why: "C is steady, on the subject and clean — worth the cut, unlike B" },
    { t: 3, clips: ["clipC"], why: "continuing C needs no cut, and B is the shakier camera" },
  ];
  let truthOk = true;
  for (const e of expected) {
    const got = selection.camera_sequence[e.t];
    if (!e.clips.includes(got)) truthOk = false;
    console.log(`      t${e.t} chose ${pad(got ?? "-", 6)} expected ${pad(e.clips.join("|"), 6)} — ${e.why}`);
  }
  check("(4) the deliberately-best clip wins every window (ground truth match)", truthOk);
  check(
    "(4) the result is a 3-shot film A[0,4000) B[4000,8000) C[8000,16000)",
    selection.shots.length === 3 &&
      selection.shots.map((s) => `${s.clip_id}[${s.start_ms},${s.end_ms})`).join(" ") ===
        "clipA[0,4000) clipB[4000,8000) clipC[8000,16000)"
  );
  check(
    "(4) exactly two cuts were made (not one per slice)",
    selection.shots.filter((s) => s.cut_in).length === 2
  );

  // (5) the raw metrics rank what they claim to rank.
  const stabA0 = rawStats.get("clipA@t0")!;
  const stabA1 = rawStats.get("clipA@t1")!;
  const stabB0 = rawStats.get("clipB@t0")!;
  const stabC3 = rawStats.get("clipC@t3")!;
  check(
    "(5) stability ranks locked-off cameras far above hand-held ones",
    stabA0.stability > stabB0.stability + 0.3 && stabC3.stability > stabB0.stability + 0.3,
    `A(t0) ${f(stabA0.stability)} C(t3) ${f(stabC3.stability)} vs B ${f(stabB0.stability)} — B motion/s ${f(stabB0.motion, 3)}, jitter/s ${f(stabB0.jitter, 3)}`
  );
  check(
    "(5) stability also catches the moment A gets picked up (same clip, later window)",
    stabA0.stability > stabA1.stability + 0.3,
    `A t0 ${f(stabA0.stability)} (motion/s ${f(stabA0.motion, 3)}) vs A t1 ${f(stabA1.stability)} (motion/s ${f(stabA1.motion, 3)})`
  );
  const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const lvl = (id: string) => meanOf(envelopes.get(id)!.values);
  check(
    "(5) the audio envelope ranks loud > clean > quiet exactly as synthesized",
    lvl("B") > lvl("C") && lvl("C") > lvl("A"),
    `mean RMS B ${f(lvl("B"), 0)} > C ${f(lvl("C"), 0)} > A ${f(lvl("A"), 0)}`
  );
  const faceA0 = rawStats.get("clipA@t0")!;
  const faceB0 = rawStats.get("clipB@t0")!;
  const faceC3 = rawStats.get("clipC@t3")!;
  check(
    "(5) the face heuristic fires on the centered subject and nowhere else",
    faceA0.face > 0.5 && faceB0.face < 0.1 && faceC3.face > 0.5,
    `A(t0) ${f(faceA0.face)} (center skin ${f(faceA0.centerSkin * 100, 1)}%), B ${f(faceB0.face)}, C(t3) ${f(faceC3.face)}`
  );
  const cT2 = scored.scoreMatrix[2].find((c) => c.clip_id === "clipC")!;
  const cT3 = scored.scoreMatrix[3].find((c) => c.clip_id === "clipC")!;
  const bT2 = scored.scoreMatrix[2].find((c) => c.clip_id === "clipB")!;
  check(
    "(5) C's lead-in measurably dilutes C's own first window — which still beats B",
    cT2.signals.face < cT3.signals.face &&
      cT2.score < cT3.score &&
      cT2.score > bT2.score,
    `C t2: face ${f(cT2.signals.face)} audio ${f(cT2.signals.audio)} score ${f(cT2.score)} | C t3: face ${f(cT3.signals.face)} audio ${f(cT3.signals.audio)} score ${f(cT3.score)} | B t2 ${f(bT2.score)}`
  );

  logicCases();

  // -------------------------------------------------------------------------
  // artifact + readback
  // -------------------------------------------------------------------------
  const artifact = {
    generated_by: "scripts/director-demo.ts (Phase 2a auto-cut director)",
    slice_ms: SLICE_MS,
    timeline_ms: TIMELINE_MS,
    options: {
      weights: opts.weights,
      switch_penalty: opts.switchPenalty,
      return_cooldown_slices: opts.returnCooldownSlices,
      min_hold_slices: opts.minHoldSlices,
      probe_fps: opts.probeFps,
      probe_size: `${opts.probeWidth}x${opts.probeHeight}`,
      face_scorer: "skin-tone-center-saliency-v1",
    },
    clips: clips.map((c) => ({
      clip_id: c.clip_id,
      label: c.label,
      offset_ms: c.offset_ms,
      duration_ms: c.duration_ms,
      footprint: `[${c.offset_ms}, ${c.offset_ms + c.duration_ms})`,
      sync_confidence: c.sync_confidence,
      file_path: c.file_path,
    })),
    slices: slices.map((s, t) => ({
      ...s,
      candidates: (scored.scoreMatrix[t] ?? []).map((c) => ({
        clip_id: c.clip_id,
        source_start_ms: c.source_start_ms,
        source_duration_ms: c.source_duration_ms,
        eligible: c.eligible,
        score: Number(c.score.toFixed(6)),
        signals: {
          stability: Number(c.signals.stability.toFixed(6)),
          audio: Number(c.signals.audio.toFixed(6)),
          face: Number(c.signals.face.toFixed(6)),
          coverage: Number(c.signals.coverage.toFixed(6)),
          partial: c.signals.partial,
          speechiness: Number(c.signals.speechiness.toFixed(6)),
          sync_factor: Number(c.signals.sync_factor.toFixed(6)),
        },
      })),
    })),
    shots: selection.shots.map((s) => {
      const clip = clips.find((c) => c.clip_id === s.clip_id)!;
      return {
        clip_id: s.clip_id,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        source_start_ms: s.start_ms - clip.offset_ms,
        source_end_ms: s.end_ms - clip.offset_ms,
        slices: s.slices,
        mean_score: s.mean_score === undefined ? undefined : Number(s.mean_score.toFixed(6)),
        cut_in: s.cut_in,
      };
    }),
    gaps: selection.gaps,
    violations: selection.violations,
    camera_sequence: selection.camera_sequence,
    total_switch_penalty: Number(selection.total_switch_penalty.toFixed(6)),
    assertions: { failed: failures, passed: failures.length === 0 },
    // The contract Phase 2b consumes: ordered {clip_id, start_ms, end_ms}.
    render_contract: {
      shots: selection.shots.map((s) => ({
        clip_id: s.clip_id,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
      })),
      clips: clips.map((c) => ({
        clip_id: c.clip_id,
        offset_ms: c.offset_ms,
        duration_ms: c.duration_ms,
        file_path: c.file_path,
      })),
    },
  };

  console.log("\n=== 9) ARTIFACT ===");
  await writeFile(OUT_JSON, JSON.stringify(artifact, null, 2), "utf8");
  const back = JSON.parse(await readFile(OUT_JSON, "utf8")) as typeof artifact;
  const backShots = back.shots.map((s) => `${s.clip_id}[${s.start_ms},${s.end_ms})`).join(" ");
  const memShots = selection.shots.map((s) => `${s.clip_id}[${s.start_ms},${s.end_ms})`).join(" ");
  console.log(`   wrote ${OUT_JSON} (${JSON.stringify(artifact).length} bytes)`);
  console.log(`   read back: ${back.clips.length} clips, ${back.slices.length} slices, ${back.shots.length} shots`);
  console.log(`   read-back shot list: ${backShots}`);
  for (const s of back.render_contract.shots) {
    console.log(
      `   contract shot: ${pad(s.clip_id, 7)} [${s.start_ms},${s.end_ms}) → renderer trims source [${s.start_ms - back.render_contract.clips.find((c) => c.clip_id === s.clip_id)!.offset_ms},${s.end_ms - back.render_contract.clips.find((c) => c.clip_id === s.clip_id)!.offset_ms})`
    );
  }
  check(
    "(6) the shot-list JSON round-trips unchanged",
    backShots === memShots && back.slices.length === slices.length && back.clips.length === clips.length
  );
  check(
    "(6) every shot carries clip_id + start_ms + end_ms (2b's contract) and sane source times",
    back.shots.every(
      (s) =>
        typeof s.clip_id === "string" &&
        Number.isFinite(s.start_ms) &&
        Number.isFinite(s.end_ms) &&
        s.source_start_ms >= 0 &&
        s.source_end_ms <= (back.clips.find((c) => c.clip_id === s.clip_id)?.duration_ms ?? Infinity)
    )
  );

  console.log(
    failures.length === 0
      ? "\n✅ PHASE 2a DIRECTOR DEMO PASS — all assertions held"
      : `\n❌ PHASE 2a DIRECTOR DEMO FAIL — ${failures.length} assertion(s) failed:\n   - ${failures.join("\n   - ")}`
  );

  if (process.env.KEEP_DEMO_CLIPS !== "1") await rm(DIR, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

/**
 * Brute-force optimum over every possible camera path with the SAME cost model as
 * the DP (Σ emissions − switch penalties − violation penalties). Used only as an
 * oracle: with N slices and k candidates it enumerates k^N paths, which is fine for
 * the demo's 4×2=16 and impossible for a real event — that is what the DP is for.
 */
function bruteForceBest(
  matrix: ScoredCandidate[][],
  slices: SliceWindow[],
  o: { switchPenalty: number; returnCooldownSlices: number; minHoldSlices: number; violationPenalty: number }
): { score: number; seq: string[]; paths: number } {
  const K = Math.max(1, o.returnCooldownSlices);
  const minHold = Math.max(1, o.minHoldSlices);
  let best = -Infinity;
  let bestSeq: string[] = [];
  let paths = 0;
  const walk = (
    t: number,
    cur: string | null,
    runLen: number,
    recent: string[],
    total: number,
    seq: string[]
  ): void => {
    if (t === slices.length) {
      paths++;
      if (total > best) {
        best = total;
        bestSeq = [...seq];
      }
      return;
    }
    const eligible = (matrix[t] ?? []).filter((c) => c.eligible);
    if (eligible.length === 0) return walk(t + 1, cur, runLen, recent, total, seq);
    for (const c of eligible) {
      if (cur === null) {
        walk(t + 1, c.clip_id, 1, [c.clip_id], total + c.score, [...seq, c.clip_id]);
        continue;
      }
      if (c.clip_id === cur) {
        walk(t + 1, cur, runLen + 1, recent, total + c.score, [...seq, c.clip_id]);
        continue;
      }
      const legal = !recent.slice(1).includes(c.clip_id) && runLen >= minHold;
      const penalty = o.switchPenalty + (legal ? 0 : o.violationPenalty);
      walk(
        t + 1,
        c.clip_id,
        1,
        [c.clip_id, ...recent].slice(0, K),
        total + c.score - penalty,
        [...seq, c.clip_id]
      );
    }
  };
  walk(0, null, 0, [], 0, []);
  return { score: best, seq: bestSeq, paths };
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("director-demo error:", err);
    process.exit(1);
  });
