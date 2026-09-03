/**
 * render.ts — server-side render of a SOLO event into ONE playable finished MP4.
 *
 * This is the piece that makes solo "upload → done" real: instead of a dead-end
 * result that only shows a thumbnail grid, the server uses ffmpeg to actually
 * bake the user's media into a single watchable video and writes it to
 * `uploads/<eventId>/finished.mp4` (served back at `/uploads/<eventId>/finished.mp4`).
 *
 * Composition:
 *   - Photos get a subtle Ken Burns pan/zoom (~3s each) via ffmpeg `zoompan`,
 *     joined in upload order → a real motion slideshow.
 *   - Video clips are re-encoded to a unified MP4 (same dimensions/codec) and
 *     concatenated in sequence, so photos + videos can share one finished file.
 *   - The color filter from event.prefs.filter (none/warm/cool/vintage/bw/
 *     cinematic) is mapped to ffmpeg color filters and applied at render time.
 *   - Music: only mixed in if a real bundled track EXISTS in the project. There
 *     is currently no licensed music library, so nothing is faked — pure-photo
 *     solo videos render silent (videos keep their own audio). A real licensed
 *     music library is a later Phase-3 piece.
 *
 * Progress is written to an in-memory store (read by the status endpoint) as the
 * render runs so the page's progress bar never freezes, and the durable marker is
 * persisted to the `renders` table so reopening the private link shows the
 * finished video without re-rendering.
 *
 * This module is imported lazily (dynamic import inside server functions) so the
 * node:child_process / ffmpeg deps never reach the client bundle.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { query } from "~/db";
import { absolutePath, uploadsRoot } from "~/lib/storage";

// ---------------------------------------------------------------------------
// Progress store — in-memory so the status endpoint can report real stage/%
// while the render is in flight in the same process.
// ---------------------------------------------------------------------------
export type RenderProgress = {
  stage: string;
  percent: number; // absolute overall % (aligned to the client bar)
  done: boolean;
  error?: string;
  startedAt: number;
};

const progressMap = new Map<string, RenderProgress>();
let renderLock = new Map<string, Promise<void>>();

export function getRenderProgress(eventId: string): RenderProgress | null {
  return progressMap.get(eventId) ?? null;
}

/**
 * Durable render state from the `renders` table — the authoritative source of
 * truth for whether an event's finished video exists (status=done + finished_key),
 * failed (status=error + error), or was never rendered (pending / no row).
 * Unlike the volatile in-memory `progressMap`, this survives restarts and
 * process races, so the status endpoint can stop reporting a frozen default and
 * instead reconcile against what actually happened.
 */
export type DurableRenderState = {
  status: "pending" | "done" | "error" | null;
  finished_key: string | null;
  error: string | null;
};

export async function getDurableRenderState(
  eventId: string
): Promise<DurableRenderState> {
  try {
    const rows = await query<{
      status: string;
      finished_key: string | null;
      error: string | null;
    }>(
      `select status, finished_key, error from renders where event_id = $1`,
      [eventId]
    );
    if (rows.length === 0) {
      return { status: null, finished_key: null, error: null };
    }
    const r = rows[0];
    return {
      status: (r.status as DurableRenderState["status"]) ?? null,
      finished_key: r.finished_key,
      error: r.error,
    };
  } catch (e) {
    // A DB hiccup must never turn into a misleading "done". Return "no durable
    // state" so the caller falls back to the not-started / keep-polling path.
    console.error("render: durable state lookup failed", e);
    return { status: null, finished_key: null, error: null };
  }
}

/** Seed the in-memory progress map to done for an already-rendered event, so a
 *  subsequent poll ("done") resolves instantly without re-rendering. */
export function seedRenderDone(eventId: string) {
  setProgress(eventId, { stage: "Done", percent: 100, done: true });
}

function setProgress(eventId: string, p: Partial<RenderProgress>) {
  const prev = progressMap.get(eventId) ?? {
    stage: "Processing your clips…",
    percent: 68,
    done: false,
    startedAt: Date.now(),
  };
  progressMap.set(eventId, { ...prev, ...p });
}

// ---------------------------------------------------------------------------
// ffmpeg helper — runs ffmpeg and resolves on success, rejects on failure.
// ---------------------------------------------------------------------------
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// ffprobe helpers — probe a rendered/concatenated file's duration + audio.
// ---------------------------------------------------------------------------
function ffprobeJson(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-print_format", "json", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("ffprobe returned no JSON"));
      }
    });
  });
}

/** Duration (seconds) of a media file, or null if it can't be read. */
async function ffprobeDuration(filePath: string): Promise<number | null> {
  try {
    const info = await ffprobeJson([
      "-show_entries", "format=duration",
      "-i", filePath,
    ]);
    const d = Number(info?.format?.duration);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

/** Whether a media file has at least one audio stream. */
async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const info = await ffprobeJson([
      "-show_streams",
      "-select_streams", "a",
      "-i", filePath,
    ]);
    return Array.isArray(info?.streams) && info.streams.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Generated ORIGINAL background music.
//
// The owner-approved decision is GENERATED, ORIGINAL, non-copyright music: we
// SYNTHESIZE a gentle ambient chord/pad bed with ffmpeg's `sine` source — a few
// soft sine tones stacked into a chord, low-passed into a pad, with a slow
// tremolo for gentle movement and fade in/out. This is produced programmatically
// from pure frequencies — no samples, no library, no license required. We never
// pull from an external source. The bed is mixed low UNDER the video's own audio
// when the video has any, or is the solo track for pure-photo videos.
//
// Chords vary a little by theme_id (deterministic hash) for variety, but stay
// simple/ambient so they read as a pleasant pad under the video.
// ---------------------------------------------------------------------------
const PAD_CHORDS: number[][] = [
  [220.0, 261.63, 329.63, 440.0], // A minor — calm
  [196.0, 246.94, 293.66, 392.0], // G major — warm
  [174.61, 220.0, 261.63, 349.23], // F major — soft
  [164.81, 207.65, 246.94, 329.63], // E minor — mellow
];

function chordFor(themeId: string | null | undefined): number[] {
  if (!themeId) return PAD_CHORDS[0];
  let h = 7;
  for (let i = 0; i < themeId.length; i++) h = (h * 31 + themeId.charCodeAt(i)) >>> 0;
  return PAD_CHORDS[h % PAD_CHORDS.length];
}

/**
 * Synthesize a soft ambient bed of `duration` seconds to `outPath`. Each chord
 * tone is a sine at ~1/n amplitude (kept low so the stacked chord never clips),
 * mixed with normalize=0, low-passed into a pad, given a slow tremolo, gentle
 * fade in/out, and an overall low "under-video" gain.
 */
async function generateMusicBed(
  outPath: string,
  duration: number,
  freqs: number[]
): Promise<void> {
  const n = freqs.length;
  const amp = Number((0.72 / n).toFixed(4)); // stacked chord stays well under clipping
  const inputs: string[] = [];
  const sourceLabels: string[] = [];
  freqs.forEach((f, i) => {
    inputs.push("-f", "lavfi", "-i", `sine=frequency=${f}:sample_rate=44100`);
    sourceLabels.push(`[${i}:a]volume=${amp}[t${i}]`);
  });
  const mix = freqs.map((_, i) => `[t${i}]`).join("") +
    `amix=inputs=${n}:normalize=0,` +
    `lowpass=f=850,` +
    `tremolo=f=0.15:d=0.3,` +
    `afade=t=in:st=0:d=1.5,` +
    `afade=t=out:st=${Math.max(0.2, duration - 1.6)}:d=1.6,` +
    `volume=2.0[bed]`;
  const fc = sourceLabels.join(";") + ";" + mix;
  await runFfmpeg([
    ...inputs,
    "-filter_complex", fc,
    "-map", "[bed]",
    "-t", String(duration),
    "-ar", "44100",
    "-ac", "2",
    outPath,
  ]);
}

/** Escape text for use inside an ffmpeg drawtext `text=` option value. */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

const CAPTION_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/**
 * The final "post style" pass: bake the user's locked look onto the concatenated
 * film — (a) BORDER, (b) typed-in CAPTION, (c) GENERATED MUSIC bed. Re-encodes
 * `concatPath` → `finishedPath` as one playable 1280x720@25 h264+aac MP4.
 * Handles both video-has-audio and silent (photo-only) inputs without error.
 */
type FinalizeOptions = {
  borderOn: boolean;
  caption: string | null; // non-empty typed caption to overlay, else null
  musicOn: boolean;
  themeId: string | null;
};

async function finalizeSoloVideo(
  concatPath: string,
  finishedPath: string,
  opts: FinalizeOptions
): Promise<void> {
  const videoParts: string[] = [];
  if (opts.borderOn) {
    // Thin white rounded-feel inset frame, kept tasteful (7px, inset 12px).
    videoParts.push(
      `drawbox=x=12:y=12:w=iw-24:h=ih-24:color=white@0.85:t=7`
    );
  }
  if (opts.caption) {
    videoParts.push(
      `drawtext=fontfile=${CAPTION_FONT}:` +
        `text='${escapeDrawtext(opts.caption)}':` +
        `fontsize=44:fontcolor=white:` +
        `x=(w-text_w)/2:y=h-116:` +
        `box=1:boxcolor=black@0.45:boxborderw=16:` +
        `shadowx=2:shadowy=2`
    );
  }

  // The video duration drives both the bed length and the final output cap.
  // Probe the concat FIRST (the video stream length is what matters for the
  // finished film), and fall back to a probe of the container/stream.
  const videoDur = await ffprobeDuration(concatPath);
  const hasAudio = await hasAudioStream(concatPath);
  const args = ["-i", concatPath];

  const graph: string[] = [
    videoParts.length ? `[0:v]${videoParts.join(",")}[vout]` : `[0:v]null[vout]`,
  ];
  let mapAudio: string | null = null;
  let outCap: number | null = null;

  if (opts.musicOn) {
    // Bed length = video length (safe: if the probe missed, default to 60 but
    // the output -t cap below still trims the mux to the video's real length).
    const dur = videoDur ?? (await ffprobeDuration(concatPath)) ?? 60;
    const bedPath = path.join(path.dirname(concatPath), "bed.wav");
    await generateMusicBed(bedPath, dur, chordFor(opts.themeId));
    args.push("-i", bedPath);
    if (hasAudio) {
      // Keep the video's own audio with the generated bed mixed low underneath.
      // duration=first keeps the (shorter) video audio as the mix length.
      graph.push(`[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    } else {
      // Silent (pure-photo) video → the generated bed is the only track. Trim
      // it to the video length so a stale/long bed never inflates the film.
      graph.push(`[1:a]atrim=duration=${dur},asetpts=N/SR/TB[aout]`);
    }
    mapAudio = "[aout]";
    if (videoDur) outCap = videoDur;
  } else if (hasAudio) {
    graph.push(`[0:a]anull[aout]`);
    mapAudio = "[aout]";
  }

  args.push("-filter_complex", graph.join(";"));
  args.push("-map", "[vout]");
  if (mapAudio) args.push("-map", mapAudio);
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-r", String(FPS),
  );
  if (mapAudio) args.push("-c:a", "aac", "-ar", "44100", "-b:a", "128k");
  if (opts.musicOn) {
    // IMPORTANT (ffmpeg 6.1 quirk): with filter_complex graphs, `-shortest`
    // does NOT reliably trim an over-long generated bed (the output audio can
    // outlast the video, inflating the file and the player's duration). Cap the
    // mux explicitly at the video duration — that trims both streams to the
    // film's true length. This is the fix that keeps photo-only films at their
    // real ~3s-per-photo length instead of a ~50s silent tail.
    args.push("-shortest");
    if (outCap !== null) args.push("-t", String(outCap));
  }
  args.push(finishedPath);

  await runFfmpeg(args);
}

/** Map a user-facing filter name to an ffmpeg video-filter chain (appended AFTER the Ken Burns/scale chain). */
export function filterChain(filter: string): string {
  switch (filter) {
    case "warm":
      return "colortemperature=temperature=6800";
    case "cool":
      return "colortemperature=temperature=4200";
    case "vintage":
      return "curves=vintage";
    case "bw":
      return "hue=s=0";
    case "cinematic":
      return "eq=contrast=1.12:saturation=1.08,unsharp=5:5:0.4:5:5:0.0";
    case "none":
    default:
      return "";
  }
}

export type SoloRenderOutcome = { ok: boolean; message?: string };

// Segment dimensions / fps — a unified 1280x720@25 h264 MP4 for clean concat.
const W = 1280;
const H = 720;
const FPS = 25;
const PHOTO_SECONDS = 3;
const FRAME_COUNT = FPS * PHOTO_SECONDS; // zoompan d (frames per photo)

/**
 * Render a solo event's clips into uploads/<eventId>/finished.mp4, persist the
 * marker, and report live progress. Best-effort idempotent: if a completed
 * render already exists it returns immediately.
 */
export async function renderSoloVideo(eventId: string): Promise<SoloRenderOutcome> {
  // Don't start / re-run if one is already in flight for this event.
  if (renderLock.has(eventId)) {
    await renderLock.get(eventId);
    return { ok: true };
  }

  // Skip if a durable done marker already exists.
  const existing = await query<{ status: string; finished_key: string | null }>(
    `select status, finished_key from renders where event_id = $1`,
    [eventId]
  );
  if (existing.length > 0 && existing[0].status === "done" && existing[0].finished_key) {
    const abs = absolutePath(existing[0].finished_key);
    const ok = await Bun.file(abs).exists().catch(() => false);
    if (ok) {
      setProgress(eventId, { stage: "Done", percent: 100, done: true });
      return { ok: true };
    }
  }

  const run = (async () => {
    setProgress(eventId, { stage: "Processing your clips…", percent: 68, done: false });
    try {
      // 1. Persist event composition metadata (existing behavior preserved).
      const { composeSoloSync } = await import("./sync/service");
      await composeSoloSync(eventId).catch(() => {});

      // 2. Load event + clips + prefs.
      const evs = await query<{ prefs: unknown; theme_id: string | null }>(
        `select prefs, theme_id from events where id = $1 and mode = 'solo'`,
        [eventId]
      );
      if (evs.length === 0) throw new Error("Solo video not found.");
      const evRow = evs[0];
      const prefs = (evRow.prefs ?? {}) as Record<string, unknown>;
      const themeId = evRow.theme_id;
      const filter = String(prefs.filter ?? "none").toLowerCase();
      const musicOn = prefs.music_on === true;
      const borderOn = prefs.border_on === true;
      const caption =
        typeof prefs.caption === "string" && prefs.caption.trim()
          ? prefs.caption.trim()
          : null;
      const colorChain = filterChain(filter);

      const clips = await query<{ id: string; media_type: string; s3_or_storage_key: string | null }>(
        `select id, media_type, s3_or_storage_key
           from clips where event_id = $1 order by created_at, id`,
        [eventId]
      );
      const usable = clips.filter((c) => c.s3_or_storage_key);

      const eventDir = path.join(uploadsRoot(), eventId);
      const renderDir = path.join(eventDir, "render");
      await mkdir(renderDir, { recursive: true });

      const segmentInputs: string[] = [];
      let segIndex = 0;
      const photos = usable.filter((c) => c.media_type === "photo");
      const videos = usable.filter((c) => c.media_type === "video");

      // 3. Render each photo → Ken Burns motion slide (3s).
      const photoSpan = photos.length > 0 ? 18 : 0; // 70 → 88
      for (let i = 0; i < photos.length; i++) {
        const c = photos[i];
        const pct = photos.length > 0 ? 70 + (i / photos.length) * photoSpan : 70;
        setProgress(eventId, {
          stage: `Rendering photo ${i + 1} of ${photos.length}…`,
          percent: Math.round(pct),
        });
        const out = path.join(renderDir, `seg_${segIndex++}.mp4`);
        const zoompan =
          i % 2 === 0 // alternate zoom-in / zoom-out for variety
            ? "min(zoom+0.0015,1.15)"
            : "max(1.0015,1.15-0.0015*(on))";
        // Blurred-background ("fit") treatment so the ENTIRE photo is always
        // visible regardless of its aspect ratio:
        //   - Split the input into two branches.
        //   - Background: scaled to COVER the full frame, then heavily blurred.
        //   - Foreground: scaled to FIT inside 1280x720 (force_original_aspect_ratio
        //     =decrease — the whole image stays, nothing is cropped away), centered
        //     on top of the blurred fill via overlay=(W-w)/2:(H-h)/2.
        //   - The Ken Burns pan/zoom + color filter are applied to the composited
        //     result so motion still works and tall/portrait photos keep their bars
        //     (no edge cropping).
        const filterComplex = [
          "[0:v]split=2[bg][fg]",
          `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bgblur]`,
          `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgfit]`,
          `[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2,` +
            `zoompan=z='${zoompan}':d=${FRAME_COUNT}:s=${W}x${H}:fps=${FPS}` +
            (colorChain ? `,${colorChain}` : "") +
            `,format=yuv420p,setdar=16/9[vout]`,
        ];
        await runFfmpeg([
          "-loop", "1",
          "-t", String(PHOTO_SECONDS + 1),
          "-i", absolutePath(c.s3_or_storage_key!),
          "-filter_complex", filterComplex.join(";"),
          "-map", "[vout]",
          "-r", String(FPS),
          "-t", String(PHOTO_SECONDS),
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "-an",
          out,
        ]);
        segmentInputs.push(out);
      }

      // 4. Re-encode each video to unified dimensions/codec (keeps its audio).
      const videoStart = photos.length > 0 ? 88 : 70;
      const videoSpan = videos.length > 0 ? 8 : 0;
      for (let i = 0; i < videos.length; i++) {
        const c = videos[i];
        const pct =
          videos.length > 0
            ? videoStart + (i / videos.length) * videoSpan
            : videoStart;
        setProgress(eventId, {
          stage: `Processing video ${i + 1} of ${videos.length}…`,
          percent: Math.round(pct),
        });
        const out = path.join(renderDir, `seg_${segIndex++}.mp4`);
        const vf = [
          `scale=${W}:${H}:force_original_aspect_ratio=increase`,
          `crop=${W}:${H}`,
        ];
        if (colorChain) vf.push(colorChain);
        vf.push("format=yuv420p");
        await runFfmpeg([
          "-i", absolutePath(c.s3_or_storage_key!),
          "-vf", vf.join(","),
          "-r", String(FPS),
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "44100",
          out,
        ]);
        segmentInputs.push(out);
      }

      if (segmentInputs.length === 0) {
        throw new Error("No usable clips to render.");
      }

      // 6. Concatenate all segments (lossless copy) into a temp, then bake the
      // owner-locked look — border / typed-in caption / generated music — onto
      // the finished MP4. If none of the three is on, the temp IS the finished
      // file (identical to the previous no-frills concat, so nothing regresses).
      setProgress(eventId, { stage: "Finalizing video…", percent: 96 });
      const listFile = path.join(renderDir, "list.txt");
      await writeFile(
        listFile,
        segmentInputs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
      );
      const concatPath = path.join(renderDir, "concat.mp4");
      await runFfmpeg([
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy",
        concatPath,
      ]);
      if (!(await Bun.file(concatPath).exists())) {
        throw new Error("Render produced no output file.");
      }

      const finishedPath = path.join(eventDir, "finished.mp4");
      const needsPostPass = borderOn || caption !== null || musicOn;
      if (needsPostPass) {
        // (a) BORDER + (b) CAPTION + (c) GENERATED MUSIC — baked in one pass.
        await finalizeSoloVideo(concatPath, finishedPath, {
          borderOn,
          caption,
          musicOn,
          themeId,
        });
      } else {
        await Bun.write(finishedPath, await Bun.file(concatPath).arrayBuffer());
      }

      if (!(await Bun.file(finishedPath).exists())) {
        throw new Error("Render produced no output file.");
      }

      // 7. Persist the durable done marker.
      const finishedKey = `uploads/${eventId}/finished.mp4`;
      await query(
        `insert into renders (event_id, status, finished_key, error)
         values ($1, 'done', $2, null)
         on conflict (event_id) do update
           set status = 'done', finished_key = excluded.finished_key, error = null, updated_at = now()`,
        [eventId, finishedKey]
      );
      // Clean up the intermediate segment dir.
      await rm(renderDir, { recursive: true, force: true }).catch(() => {});
      setProgress(eventId, { stage: "Done", percent: 100, done: true });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("render: solo render failed", e);
      setProgress(eventId, {
        stage: "Something went wrong rendering",
        percent: 90,
        done: true,
        error: msg,
      });
      await query(
        `insert into renders (event_id, status, error)
         values ($1, 'error', $2)
         on conflict (event_id) do update
           set status = 'error', error = excluded.error, updated_at = now()`,
        [eventId, msg]
      ).catch(() => {});
      return { ok: false, message: msg };
    } finally {
      renderLock.delete(eventId);
    }
  })();

  renderLock.set(eventId, run.then(() => undefined));
  return run;
}

/** Elapsed seconds for the status endpoint. */
export function elapsedSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}
