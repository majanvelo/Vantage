/**
 * scripts/sync-demo.ts — end-to-end proof the Phase-1 audio-sync engine works.
 *
 * Run with:  bun scripts/sync-demo.ts   (from /home/team/shared/site)
 *
 * It synthesizes 3 short video clips that share a common "performance" audio
 * track but were recorded starting at different times (as if three cameras each
 * pressed record mid-song), then runs the real pipeline:
 *
 *   synthesize → ffmpeg feature extraction → pairwise offsets → global solve
 *
 * and asserts the recovered per-clip start offsets match the ground truth we
 * baked in. Prints PASS/FAIL and exits non-zero on failure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractAudioFeatures } from "../src/lib/sync/features";
import { solveGlobalOffsets, type ClipInput } from "../src/lib/sync/align";

const execFileAsync = promisify(execFile);
const FFMPEG = "ffmpeg";
const DIR = "/tmp/syncdemo";

// Ground truth: { name, globalStartS, lengthS } — when each camera started
// recording (global seconds) and how long it recorded.
const PLAN = [
  { name: "camA", start: 0, len: 7 },
  { name: "camB", start: 4, len: 8 },
  { name: "camC", start: 1, len: 6 },
];
const MASTER_SECONDS = 12;
const MASTER_SR = 8000;

/** Deterministic LCG so the synthesized "song" is reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Build a distinctive, aperiodic "song": noise carrier with unique pulses. */
function masterPCM(): Buffer {
  const n = MASTER_SR * MASTER_SECONDS;
  const rand = lcg(12345);
  // Random noise carrier (deterministic).
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1;

  // Envelope = unique pattern of pulses at irregular times/lengths. Cross-
  // correlating two clips' RMS envelopes must have exactly ONE clear peak at the
  // true alignment, so the pattern is deliberately aperiodic (real event audio —
  // music, speech, applause — is never a clean repeating tone).
  const env = new Float32Array(n).fill(0.02); // low noise floor
  const pulses: Array<[number, number, number]> = [
    // [startS, lengthS, amplitude]
    [0.2, 0.9, 1.0],
    [0.9, 0.3, 0.5],
    [1.5, 1.2, 0.9],
    [2.0, 0.4, 0.6],
    [3.1, 1.0, 1.0],
    [3.6, 0.2, 0.4],
    [4.2, 0.8, 0.95],
    [5.1, 0.3, 0.7],
    [5.5, 1.1, 0.85],
    [6.3, 0.4, 0.55],
    [7.2, 1.4, 0.92],
    [8.0, 0.5, 0.65],
    [8.7, 0.7, 0.8],
    [9.6, 0.9, 0.9],
    [10.3, 0.5, 0.6],
    [11.0, 0.8, 0.85],
  ];
  for (const [startS, lenS, amp] of pulses) {
    const s0 = Math.floor(startS * MASTER_SR);
    const s1 = Math.min(n, Math.floor((startS + lenS) * MASTER_SR));
    for (let i = s0; i < s1; i++) {
      env[i] = Math.max(env[i], amp);
    }
  }

  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    // Slight tonal colour on top of the noise so the files audio is plausible.
    const tone = 0.15 * Math.sin(2 * Math.PI * 300 * (i / MASTER_SR));
    const v = Math.max(-1, Math.min(1, (noise[i] + tone) * env[i]));
    samples[i] = v * 32000;
  }
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + n * 2, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16); // PCM chunk size
  hdr.writeUInt16LE(1, 20); // PCM
  hdr.writeUInt16LE(1, 22); // mono
  hdr.writeUInt32LE(MASTER_SR, 24);
  hdr.writeUInt32LE(MASTER_SR * 2, 28); // byte rate
  hdr.writeUInt16LE(2, 32); // block align
  hdr.writeUInt16LE(16, 34); // bits
  hdr.write("data", 36);
  hdr.writeUInt32LE(n * 2, 40);
  return Buffer.concat([hdr, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

async function synthClip(segStart: number, segLen: number, color: string, out: string): Promise<void> {
  const segWav = path.join(DIR, "seg.wav");
  // Slice the master audio to this camera's segment.
  await execFileAsync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(segStart), "-t", String(segLen), "-i", path.join(DIR, "master.wav"),
    "-ac", "1", "-ar", "44100", segWav,
  ]);
  // Mux with a distinct solid-color video so each clip is visually identifiable.
  await execFileAsync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:size=320x240:rate=15:duration=${segLen}`,
    "-i", segWav,
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    out,
  ]);
}

async function main(): Promise<number> {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });

  // 1) Master audio + per-camera clips.
  await writeFile(path.join(DIR, "master.wav"), masterPCM());
  const colors = ["red", "blue", "green"];
  const clipFiles: string[] = [];
  for (let i = 0; i < PLAN.length; i++) {
    const p = PLAN[i];
    const out = path.join(DIR, `${p.name}.mp4`);
    await synthClip(p.start, p.len, colors[i], out);
    clipFiles.push(out);
  }

  // 2) Feature extraction (the real ffmpeg decode path used by the app).
  const inputs: ClipInput[] = [];
  for (let i = 0; i < PLAN.length; i++) {
    const feats = await extractAudioFeatures(clipFiles[i], { sampleRate: 8000, windowMs: 50 });
    inputs.push({ id: PLAN[i].name, envelope: { values: feats.values, windowMs: feats.windowMs } });
    console.log(
      `  ${PLAN[i].name}: ${feats.durationS.toFixed(2)}s audio, ${feats.values.length} envelope windows`
    );
  }

  // 3) Global solve.
  const res = solveGlobalOffsets(inputs, { maxLagMs: 30_000 });
  const got = new Map(res.clips.map((c) => [c.id, c.offsetMs]));

  // Expected: earliest clip (A, start 0) is the reference at 0; others are their
  // start minus the global minimum start.
  const minStart = Math.min(...PLAN.map((p) => p.start));
  const expected = new Map(PLAN.map((p) => [p.name, (p.start - minStart) * 1000]));

  console.log("\nRecovered offsets (ms):");
  let pass = res.dropped.length === 0;
  for (const p of PLAN) {
    const g = got.get(p.name);
    const e = expected.get(p.name)!;
    const ok = g !== undefined && Math.abs(g - e) < Math.max(150, e * 0.02);
    if (!ok) pass = false;
    console.log(
      `  ${p.name}: got ${g}ms, expected ${e}ms ${ok ? "✓" : "✗"} (conf ${(res.clips.find((c) => c.id === p.name)?.confidence ?? 0).toFixed(2)})`
    );
  }

  console.log(pass ? "\n✅ SYNC-DEMO PASS" : "\n❌ SYNC-DEMO FAIL");
  await rm(DIR, { recursive: true, force: true });
  return pass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("sync-demo error:", err);
    process.exit(1);
  });
// (keep)
