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
 *   - Music: a 100% SYNTHESIZED, original, non-copyright bed (see ./music.ts)
 *     chosen by prefs.music_style (off | calm | upbeat | dreamy). It is a real
 *     four-chord composition with an arpeggio and percussion — never a drone.
 *     The bed is looped to the film's exact length and fade-in/out, then mixed
 *     UNDER the video's own audio (or is the only track for photo-only films).
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
import {
  DEFAULT_MUSIC_STYLE,
  autoMusicStyle,
  isMusicStyle,
  synthesizeMusicWav,
  type MusicStyle,
} from "./music";

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
      else {
        // Include the argv so a render failure can be reproduced by hand.
        const argv = args.join(" ");
        reject(
          new Error(
            `${err.trim() || `ffmpeg exited with code ${code}`}${
              process.env.FFMPEG_DEBUG ? `\nARGS: ${argv}` : ""
            }`
          )
        );
      }
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

/**
 * Duration of a file's FIRST VIDEO STREAM, or null. Preferred over the container
 * duration for the film: it is the picture length that the finished video (and
 * therefore its audio) must match exactly.
 */
async function ffprobeVideoDuration(filePath: string): Promise<number | null> {
  try {
    const info = await ffprobeJson([
      "-select_streams", "v:0",
      "-show_entries", "stream=duration",
      "-show_entries", "format=duration",
      "-i", filePath,
    ]);
    const d = Number(info?.streams?.[0]?.duration ?? info?.format?.duration);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
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
// Generated ORIGINAL background music (see ./music.ts for the composition).
//
// The bed is a genuine four-chord progression with an arpeggio/melody and a
// rhythm layer, synthesized from pure math — no samples, no library, no
// licensing, no copyright risk. We synthesize ONE seamless loop per style and
// let ffmpeg loop it to the film's exact duration (see finalizeSoloVideo), so
// even an hour-long film costs only a few seconds of synthesis.
// ---------------------------------------------------------------------------

/**
 * Resolve which music style to use from event prefs.
 *   - prefs.music_style wins ("off"/"none" → no music at all)
 *   - legacy prefs.music_on === false → no music (the old boolean toggle)
 *   - "let the system do everything" → a style derived from the theme
 *   - otherwise music is ON by default (Calm)
 */
function resolveMusicStyle(
  prefs: Record<string, unknown>,
  themeId: string | null
): MusicStyle | null {
  const raw = prefs.music_style;
  if (isMusicStyle(raw)) return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "off" || v === "none" || v === "no" || v === "false") return null;
  }
  if (prefs.music_on === false) return null;
  if (prefs.system_does_everything === true) {
    const seed = themeId ?? (typeof prefs.story_mood === "string" ? prefs.story_mood : null);
    return autoMusicStyle(seed);
  }
  return DEFAULT_MUSIC_STYLE;
}

/** Write a style's seamless loop WAV next to the render it belongs to. */
async function writeMusicLoop(outPath: string, style: MusicStyle): Promise<void> {
  await Bun.write(outPath, synthesizeMusicWav(style));
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
  musicStyle: MusicStyle | null; // null = no music
  themeId: string | null;
};

/**
 * The final "post style" pass: bake the user's locked look onto the concatenated
 * film — (a) BORDER, (b) typed-in CAPTION, (c) GENERATED MUSIC bed. Re-encodes
 * `concatPath` → `finishedPath` as one playable 1280x720@25 h264+aac MP4.
 *
 * LENGTH IS AUTHORITATIVE: the film's real video duration is probed first and
 * both the music bed and the muxed output are explicitly cut to it (`-t`), so
 * the finished container can never run on with a silent audio tail (the old bug
 * produced a 50s container for a 6s film). The bed also gets a fade-in/out sized
 * to the film, so short films still open and close gracefully.
 */
export async function finalizeSoloVideo(
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

  // The film's real length: probe the VIDEO stream of the concat (fall back to
  // the container duration). Everything below is cut to this number.
  const probed = (await ffprobeVideoDuration(concatPath)) ?? (await ffprobeDuration(concatPath));
  const durNum = probed && probed > 0.2 ? probed : null;
  const VID = durNum !== null ? durNum.toFixed(3) : null;
  const hasAudio = await hasAudioStream(concatPath);

  const args = ["-i", concatPath];
  const graph: string[] = [
    videoParts.length ? `[0:v]${videoParts.join(",")}[vout]` : `[0:v]null[vout]`,
  ];

  // Music bed: synthesize the style's seamless loop and let ffmpeg loop it for
  // exactly the film's length (the input-side -t stops it at VID; without a
  // probed length we fall back to -shortest on the output).
  let musicUsed = false;
  if (opts.musicStyle) {
    const loopPath = path.join(path.dirname(concatPath), `music_${opts.musicStyle}.wav`);
    await writeMusicLoop(loopPath, opts.musicStyle);
    if (VID !== null) args.push("-stream_loop", "-1", "-t", VID);
    else args.push("-stream_loop", "-1");
    args.push("-i", loopPath);
    musicUsed = true;
  }

  // Fades sized to the film so a 4s film still breathes instead of ducking flat.
  const fadeIn = Math.min(1.4, (durNum ?? 10) * 0.25);
  const fadeOut = Math.min(2.2, (durNum ?? 10) * 0.3);

  let mapAudio: string | null = null;
  if (musicUsed && VID !== null) {
    const music = `[1:a]afade=t=in:st=0:d=${fadeIn.toFixed(3)},` +
      `afade=t=out:st=${Math.max(0, (durNum as number) - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)},` +
      `atrim=0:${VID},asetpts=N/SR/TB`;
    if (hasAudio) {
      // Keep the film's own audio at full level and sit the bed underneath it.
      // BOTH inputs are trimmed to VID first and amix=longest then equals VID,
      // so the mix can never outlast the picture.
      graph.push(`${music},volume=0.38[m]`);
      graph.push(`[0:a]atrim=0:${VID},asetpts=N/SR/TB,volume=1.0[v0]`);
      graph.push(
        `[v0][m]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95,atrim=0:${VID}[aout]`
      );
    } else {
      graph.push(`${music}[aout]`);
    }
    mapAudio = "[aout]";
  } else if (musicUsed) {
    // Could not probe a length — mix the looped bed, capped with -shortest.
    if (hasAudio) {
      graph.push(`[1:a]volume=0.38[m]`);
      graph.push(`[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    } else {
      graph.push(`[1:a]anull[aout]`);
    }
    mapAudio = "[aout]";
  } else if (hasAudio) {
    // No music: keep the film's own audio, trimmed to the picture.
    graph.push(VID ? `[0:a]atrim=0:${VID},asetpts=N/SR/TB[aout]` : `[0:a]anull[aout]`);
    mapAudio = "[aout]";
  }

  args.push("-filter_complex", graph.join(";"));
  args.push("-map", "[vout]");
  if (mapAudio) args.push("-map", mapAudio);
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-r", String(FPS),
  );
  if (mapAudio) args.push("-c:a", "aac", "-ar", "44100", "-b:a", "160k");
  if (VID !== null) {
    // The silent-tail fix: hard-cap the whole mux at the film's true length so
    // neither stream (and therefore not the container) can run on past it.
    args.push("-t", VID);
  } else if (musicUsed) {
    // Probe failed: best available guarantee that audio cannot outlast video.
    args.push("-shortest");
  }
  args.push("-movflags", "+faststart");
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
      const musicStyle = resolveMusicStyle(prefs, themeId);
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
      const needsPostPass = borderOn || caption !== null || musicStyle !== null;
      if (needsPostPass) {
        // (a) BORDER + (b) CAPTION + (c) GENERATED MUSIC — baked in one pass.
        await finalizeSoloVideo(concatPath, finishedPath, {
          borderOn,
          caption,
          musicStyle,
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
