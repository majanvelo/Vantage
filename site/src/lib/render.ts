/**
 * render.ts — server-side render of a SOLO event into ONE playable finished MP4.
 *
 * This is the piece that makes solo "upload → done" real: instead of a dead-end
 * result that only shows a thumbnail grid, the server uses ffmpeg to actually
 * bake the user's media into a single watchable video and writes it to
 * `uploads/<eventId>/finished.mp4` (served back at `/uploads/<eventId>/finished.mp4`).
 *
 * Composition:
 *   - PHOTOS-ONLY uploads (no clips at all) get the CINEMATIC MOTION path
 *     (buildPhotosMotionFilm): every photo becomes a motion shot — an
 *     alternating Ken Burns move (zoom-in / pan L→R / zoom-out / pan R→L) with
 *     eased (smoothstep) motion, a real crossfade DISSOLVE between shots, and
 *     shot lengths cut on the music bed's beat grid. When a story line is
 *     present it also opens with a title card (blurred, darkened, slow zoom,
 *     big centered story text, fade-in). The result is a film, not a slideshow.
 *   - Photos mixed with clips (and clip-only uploads) keep the original
 *     segment path: each photo gets a Ken Burns pan/zoom, clips are re-encoded
 *     to a unified MP4 and everything is concatenated in upload order.
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

import { mkdir, writeFile, rm, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import { query } from "~/db";
import { absolutePath, uploadsRoot } from "~/lib/storage";
// The auto-cut director (Phase 2a). renderEventVideo consumes its shot list —
// it never re-implements the scoring or the switcher (see director/types.ts,
// "RENDER INTEGRATION POINT").
import { scoreCandidates } from "./director/score";
import { selectShots } from "./director/select";
import type { DirectorClip } from "./director/types";
import {
  DEFAULT_MUSIC_STYLE,
  autoMusicStyle,
  isMusicStyle,
  secondsPerBeat,
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
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch (e) {
      return reject(e);
    }
    // NOTE: read the pipe with the Bun stream API. An `on("data")` listener on
    // the child's stream does NOT deliver bytes here, which used to leave the
    // captured output empty and hid real ffmpeg failures.
    new Response(child.stderr)
      .text()
      .then(async (err) => {
        const code = await child.exited;
        if (code === 0) return resolve();
        const argv = args.join(" ");
        reject(
          new Error(
            `${err.trim() || `ffmpeg exited with code ${code}`}${
              process.env.FFMPEG_DEBUG ? `\nARGS: ${argv}` : ""
            }`
          )
        );
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// ffprobe helpers — probe a rendered/concatenated file's duration + audio.
// ---------------------------------------------------------------------------
function ffprobeJson(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(
        ["ffprobe", "-v", "error", "-print_format", "json", ...args],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" }
      );
    } catch (e) {
      return reject(e);
    }
    new Response(child.stdout)
      .text()
      .then(async (out) => {
        const code = await child.exited;
        if (code !== 0) return reject(new Error("ffprobe failed"));
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error("ffprobe returned no JSON"));
        }
      })
      .catch(reject);
  });
}

/**
 * Duration of a file's FIRST VIDEO STREAM, or null. Preferred over the container
 * duration for the film: it is the picture length that the finished video (and
 * therefore its audio) must match exactly.
 *
 * UNIT: SECONDS — this is ffprobe's own unit (see ffprobeDuration below). Callers
 * that work in milliseconds (e.g. the director's clip footprints) MUST scale by
 * 1000; mixing the two silently truncates a 12-second clip to a 12-millisecond
 * one and the render then drops every shot as a "clamped-away sliver".
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

// ---------------------------------------------------------------------------
// PHOTOS-ONLY CINEMATIC MOTION FILM
//
// A photos-only upload must not come back as a static slideshow. This path
// renders each photo as a MOTION SHOT and then dissolves between shots:
//
//   * MOTION — each shot gets one of four alternating Ken Burns moves
//     (zoom-in / pan L→R / zoom-out / pan R→L, cycling) driven by a smoothstep
//     eased progress expression, so the move starts and lands softly instead of
//     moving at a constant mechanical rate. `x`/`y` are always set, so the zoom
//     is anchored where the move wants it (centre / travelling), never the
//     zoompan default top-left corner.
//   * TRANSITIONS — shots are chained with ffmpeg `xfade` (a real dissolve
//     crossfade), never a hard cut.
//   * BEAT-SYNCED PACING — a shot lasts one musical BAR (4 beats) of the bed
//     chosen in music.ts (calm 72 BPM ≈ 3.33s, dreamy 60 BPM = 4.0s, upbeat
//     118 BPM ≈ 2.03s), so every cut lands on a downbeat and a slow bed gets
//     longer shots while an upbeat bed gets snappier ones. With no bed, shots
//     fall back to a neutral ~3.2s.
//   * STORY SHAPING — when the user typed "What's your video about?", the film
//     opens with a TITLE CARD: the first photo blurred, darkened and slowly
//     pushed in, with the story line in big centered white type, fading up from
//     black and dissolving into the first motion shot.
//
// All zoompan expressions are written COMMA-FREE (no if()/min() with commas) so
// they survive filtergraph parsing untouched.
// ---------------------------------------------------------------------------

/** One musical bar per photo: 4 beats of the chosen bed. */
const BEATS_PER_SHOT = 4;
/** Shot length when there is no music bed to sync to. */
const DEFAULT_SHOT_SECONDS = 3.2;
const SHOT_SECONDS_MIN = 1.8;
const SHOT_SECONDS_MAX = 4.5;
/** Dissolve length bounds — subtle, never a wipe. */
const CROSSFADE_MIN = 0.45;
const CROSSFADE_MAX = 0.8;
/** Title-card length bounds. */
const TITLE_MIN_SECONDS = 2.4;
const TITLE_MAX_SECONDS = 4.0;
/** Story line is capped like the caption field is (UI caps at the same number). */
const STORY_MAX_CHARS = 80;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Shot length derived from the music bed's tempo (see music.ts). */
export function photoShotSeconds(musicStyle: MusicStyle | null): number {
  if (!musicStyle) return DEFAULT_SHOT_SECONDS;
  return clampNum(
    secondsPerBeat(musicStyle) * BEATS_PER_SHOT,
    SHOT_SECONDS_MIN,
    SHOT_SECONDS_MAX
  );
}

/** Dissolve length: a constant fraction of the shot, kept subtle. */
export function crossfadeSeconds(shotSeconds: number): number {
  return clampNum(Number((shotSeconds * 0.22).toFixed(2)), CROSSFADE_MIN, CROSSFADE_MAX);
}

/** How long the story title card holds (one bar, clamped). */
export function storyTitleSeconds(shotSeconds: number): number {
  return clampNum(shotSeconds, TITLE_MIN_SECONDS, TITLE_MAX_SECONDS);
}

/** Big, centered, but never wider than the frame: shrink for long story lines. */
export function storyFontSize(text: string): number {
  const maxWidth = W - 140;
  const est = maxWidth / Math.max(1, text.length * 0.66);
  return Math.round(clampNum(est, 22, 68));
}

type ShotMove = "zoom-in" | "pan-right" | "zoom-out" | "pan-left";
/** Alternating moves so consecutive shots never feel like the same shot twice. */
const SHOT_MOVES: ShotMove[] = ["zoom-in", "pan-right", "zoom-out", "pan-left"];

/** Eased 0→1 progress within a shot, comma-free for the filtergraph parser. */
function smoothstepExpr(frames: number): string {
  const n = Math.max(1, frames - 1);
  const p = `(on/${n})`;
  return `(${p}*${p}*(3-2*${p}))`;
}

/** Blurred-background "fit" composite: the whole photo stays visible, bars filled. */
function fitCompositeHead(): string[] {
  return [
    "[0:v]split=2[bg][fg]",
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bgblur]`,
    `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgfit]`,
    "[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2",
  ];
}

type MotionPhotoShot = {
  imagePath: string;
  outPath: string;
  seconds: number;
  move: ShotMove;
  colorChain: string;
};

/** Encode ONE photo as a cinematic motion shot (silent video; audio comes later). */
async function renderMotionPhotoShot(shot: MotionPhotoShot): Promise<void> {
  const frames = Math.max(2, Math.round(shot.seconds * FPS));
  const t = smoothstepExpr(frames);
  let z: string;
  let x: string;
  let y: string;
  switch (shot.move) {
    case "zoom-in":
      z = `1.04+0.12*${t}`;
      x = "(iw-iw/zoom)/2";
      y = "(ih-ih/zoom)/2";
      break;
    case "pan-right":
      z = `1.10+0.05*${t}`;
      x = `(iw-iw/zoom)*${t}`;
      y = `(ih-ih/zoom)*(0.5-0.12*${t})`;
      break;
    case "zoom-out":
      z = `1.16-0.12*${t}`;
      x = "(iw-iw/zoom)/2";
      y = "(ih-ih/zoom)/2";
      break;
    case "pan-left":
    default:
      z = `1.06+0.09*${t}`;
      x = `(iw-iw/zoom)*(1-${t})`;
      y = `(ih-ih/zoom)*(0.5+0.12*${t})`;
      break;
  }
  const cast = [
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${FPS}`,
    ...(shot.colorChain ? [shot.colorChain] : []),
    "format=yuv420p",
    "setdar=16/9",
  ].join(",");
  const filterComplex = `${fitCompositeHead().join(";")},${cast}[vout]`;
  await runFfmpeg([
    "-loop", "1", "-t", (shot.seconds + 0.3).toFixed(3),
    "-i", shot.imagePath,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-r", String(FPS),
    "-t", (frames / FPS).toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    shot.outPath,
  ]);
}

/** Encode the story TITLE CARD: blurred/darkened first photo + big centered story line. */
async function renderStoryTitleShot(args: {
  imagePath: string;
  outPath: string;
  seconds: number;
  story: string;
  colorChain: string;
}): Promise<void> {
  const frames = Math.max(2, Math.round(args.seconds * FPS));
  const t = smoothstepExpr(frames);
  const head =
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
    `crop=${W}:${H},boxblur=40:3,gblur=sigma=10,eq=brightness=-0.16:saturation=0.9`;
  const cast = [
    `zoompan=z='1.02+0.08*${t}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${frames}:s=${W}x${H}:fps=${FPS}`,
    ...(args.colorChain ? [args.colorChain] : []),
    `drawtext=fontfile=${CAPTION_FONT}:` +
      `text='${escapeDrawtext(args.story)}':` +
      `fontsize=${storyFontSize(args.story)}:fontcolor=white:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:` +
      `shadowx=3:shadowy=3:shadowcolor=black@0.55`,
    "fade=t=in:st=0:d=0.6",
    "format=yuv420p",
    "setdar=16/9",
  ].join(",");
  await runFfmpeg([
    "-loop", "1", "-t", (args.seconds + 0.3).toFixed(3),
    "-i", args.imagePath,
    "-filter_complex", `${head},${cast}[vout]`,
    "-map", "[vout]",
    "-r", String(FPS),
    "-t", (frames / FPS).toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    args.outPath,
  ]);
}

type MotionFilmInput = {
  /** Storage keys (absolute paths) of the photos, in upload order. */
  photos: { key: string }[];
  renderDir: string;
  colorChain: string;
  /** Trimmed story line, or null. */
  story: string | null;
  shotSeconds: number;
  musicStyle: MusicStyle | null;
  onStage: (stage: string, percent: number) => void;
};

/**
 * Build the photos-only motion film: N motion shots (plus an optional title
 * card) dissolved into each other on the music's beat grid, with a silent audio
 * track of exactly the film's length (the music bed is mixed on top later by
 * finalizeSoloVideo). Returns the path of the film.
 */
export async function buildPhotosMotionFilm(
  input: MotionFilmInput
): Promise<string> {
  const dissolve = crossfadeSeconds(input.shotSeconds);
  const story = input.story ? input.story.slice(0, STORY_MAX_CHARS).trim() : null;

  const shots: { key: string; seconds: number; move: ShotMove; title: boolean }[] = [];
  if (story) {
    shots.push({
      key: input.photos[0].key,
      seconds: storyTitleSeconds(input.shotSeconds),
      move: "zoom-in",
      title: true,
    });
  }
  input.photos.forEach((p, i) => {
    shots.push({
      key: p.key,
      seconds: input.shotSeconds,
      move: SHOT_MOVES[i % SHOT_MOVES.length],
      title: false,
    });
  });

  // Encode each shot. Every shot but the last carries the dissolve overlap, so
  // the finished film is exactly sum(shot lengths) — the overlap is absorbed by
  // the crossfades rather than added to the runtime.
  const segPaths: string[] = [];
  const encodeSeconds: number[] = [];
  for (let j = 0; j < shots.length; j++) {
    const s = shots[j];
    const isLast = j === shots.length - 1;
    const enc = s.seconds + (isLast ? 0 : dissolve);
    encodeSeconds.push(enc);
    const out = path.join(input.renderDir, `motion_${j}.mp4`);
    const photoNo = s.title ? 0 : j - (story ? 1 : 0);
    input.onStage(
      s.title
        ? "Designing your title card…"
        : `Filming photo ${photoNo + 1} of ${input.photos.length}…`,
      Math.round(70 + ((j + 1) / (shots.length + 1)) * 16)
    );
    if (s.title && story) {
      await renderStoryTitleShot({
        imagePath: absolutePath(s.key),
        outPath: out,
        seconds: enc,
        story,
        colorChain: input.colorChain,
      });
    } else {
      await renderMotionPhotoShot({
        imagePath: absolutePath(s.key),
        outPath: out,
        seconds: enc,
        move: s.move,
        colorChain: input.colorChain,
      });
    }
    segPaths.push(out);
  }

  const total = shots.reduce((a, s) => a + s.seconds, 0);
  input.onStage("Cutting it to the music…", 89);
  const filmPath = path.join(input.renderDir, "motion.mp4");
  const encodeOut = [
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-r", String(FPS),
  ];

  if (segPaths.length === 1) {
    // One shot: no dissolve to make, just give the film a real audio track.
    await runFfmpeg([
      "-i", segPaths[0],
      "-f", "lavfi", "-i", SILENT_AUDIO_INPUT,
      "-map", "0:v", "-map", "1:a",
      "-t", total.toFixed(3),
      "-c:v", "copy",
      "-c:a", "aac", "-ar", "44100", "-b:a", "160k",
      "-movflags", "+faststart",
      filmPath,
    ]);
    return filmPath;
  }

  // Chain the shots with real crossfades (xfade), each transition starting on a
  // bar line: offset(k) = sum(shot lengths so far) — i.e. exactly the beat grid.
  const args: string[] = [];
  for (const p of segPaths) args.push("-i", p);
  args.push("-f", "lavfi", "-i", SILENT_AUDIO_INPUT);
  const chain: string[] = [];
  let offset = 0;
  let prev = "[0:v]";
  for (let j = 1; j < segPaths.length; j++) {
    offset += encodeSeconds[j - 1] - dissolve;
    const isLast = j === segPaths.length - 1;
    const label = isLast ? "[vfilm]" : `[vx${j}]`;
    chain.push(
      `${prev}[${j}:v]xfade=transition=fade:duration=${dissolve.toFixed(3)}` +
        `:offset=${offset.toFixed(3)}${label}`
    );
    prev = label;
  }
  args.push(
    "-filter_complex", chain.join(";"),
    "-map", "[vfilm]",
    "-map", `${segPaths.length}:a`,
    "-t", total.toFixed(3),
    ...encodeOut,
    "-c:a", "aac", "-ar", "44100", "-b:a", "160k",
    "-movflags", "+faststart",
    filmPath
  );
  await runFfmpeg(args);
  return filmPath;
}

export type SoloRenderOutcome = { ok: boolean; message?: string };

// Segment dimensions / fps — a unified 1280x720@25 h264 MP4 for clean concat.
const W = 1280;
const H = 720;
const FPS = 25;
const PHOTO_SECONDS = 3;
const FRAME_COUNT = FPS * PHOTO_SECONDS; // zoompan d (frames per photo)
/** Lavfi source of silence, used to give soundless segments a real audio track. */
const SILENT_AUDIO_INPUT = "anullsrc=channel_layout=stereo:sample_rate=44100";

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

      // PHOTOS-ONLY uploads take the cinematic motion path (motion shots +
      // dissolves + story title card, cut to the music's beat). Photos mixed
      // with clips and clip-only uploads keep the original segment path.
      const photosOnly = photos.length > 0 && videos.length === 0;
      const shotSeconds = photoShotSeconds(musicStyle);
      const story =
        typeof prefs.story === "string" && prefs.story.trim()
          ? prefs.story.trim().slice(0, 80)
          : null;
      // Both paths converge on one silent "source film" that the shared tail
      // below gives its finishing pass (music bed / border / caption) and turns
      // into finished.mp4: photos-only = the motion film, everything else = the
      // concatenated segments.
      let filmPath: string | null = null;
      if (photosOnly) {
        setProgress(eventId, {
          stage: "Adding cinematic motion…",
          percent: 70,
        });
        filmPath = await buildPhotosMotionFilm({
          photos: photos.map((p) => ({ key: p.s3_or_storage_key! })),
          renderDir,
          colorChain,
          story,
          shotSeconds,
          musicStyle,
          onStage: (stage, percent) => setProgress(eventId, { stage, percent }),
        });
      } else {
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
          // Every segment MUST carry an audio stream, or the concat below drops
          // audio for the WHOLE film (a photo-only first segment made the entire
          // finished video silent). A photo has no sound, so give it silence.
          "-f", "lavfi",
          "-i", SILENT_AUDIO_INPUT,
          "-filter_complex", filterComplex.join(";"),
          "-map", "[vout]",
          "-map", "1:a",
          "-r", String(FPS),
          "-t", String(PHOTO_SECONDS),
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2",
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
        // A clip with no sound of its own (screen recording, muted export) still
        // gets an audio track, so EVERY segment has the same v+a layout and the
        // concat can never silently drop the film's own audio.
        const clipHasAudio = await hasAudioStream(absolutePath(c.s3_or_storage_key!));
        const clipArgs = ["-i", absolutePath(c.s3_or_storage_key!)];
        if (!clipHasAudio) clipArgs.push("-f", "lavfi", "-i", SILENT_AUDIO_INPUT);
        await runFfmpeg([
          ...clipArgs,
          "-vf", vf.join(","),
          "-r", String(FPS),
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2",
          ...(clipHasAudio ? [] : ["-shortest"]),
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
      filmPath = concatPath;
      } // end else (segments path)

      if (filmPath === null) throw new Error("No usable clips to render.");
      const finishedPath = path.join(eventDir, "finished.mp4");
      const needsPostPass = borderOn || caption !== null || musicStyle !== null;
      if (needsPostPass) {
        // (a) BORDER + (b) CAPTION + (c) GENERATED MUSIC — baked in one pass.
        await finalizeSoloVideo(filmPath, finishedPath, {
          borderOn,
          caption,
          musicStyle,
          themeId,
        });
      } else {
        await Bun.write(finishedPath, await Bun.file(filmPath).arrayBuffer());
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

// ---------------------------------------------------------------------------
// COLLABORATIVE EVENT RENDER (Phase 2b) — the auto-cut director's shot list,
// baked into ONE finished MP4.
//
// Unlike solo (which lays its own clips back-to-back, no alignment), a
// collaborative event has ONE shared timeline: every phone recorded the same
// moment from a different angle. So the film is not the clips in upload order —
// it is the DIRECTOR's shot list: for each 4 s slice of the shared timeline the
// scored candidates (steadiest camera, best audio, faces in frame) are fed to
// the Viterbi switcher, which returns an ordered, non-overlapping, gap-free
// list of shots with no jump cuts (A→B→A flap is a taboo).
//
// This function is the RENDERER half of that contract. It does not re-implement
// any of it: it imports src/lib/director/{score,select} and consumes
// `selectShots`' DirectorShot[] exactly as documented in director/types.ts
// (DirectorRendererContract). Per shot it cuts the clip's OWN file at
//     source = shot.start_ms − clip.offset_ms
// with the same trim/scale/encode pattern renderSoloVideo uses for its segments,
// then losslessly concatenates the shots in order. The audio bed is therefore
// the shot's own ALIGNED audio: because every shot is cut at its aligned position
// on the shared timeline, playing the shots in order reproduces the event's real
// soundtrack, with the picture switching between cameras on top of it.
// ---------------------------------------------------------------------------

/** The director's default slice length on the shared timeline (4 s). */
const DIRECTOR_SLICE_MS = 4000;
/** Shots shorter than this are slivers (a clamped clip tail), not shots. */
const MIN_SHOT_MS = 100;

/** Does this path exist on disk? (node:fs based — no Bun global needed.) */
async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Shape of the persisted `event_sync.offsets` jsonb (see sync/service.ts). */
type StoredSyncEntry = {
  clip_id: string;
  offset_ms: number;
  duration_ms: number;
  confidence?: number;
  mean_residual_ms?: number;
};

/**
 * Render a COLLABORATIVE event into uploads/<eventId>/finished.mp4 using the
 * auto-cut director, persist the durable marker, and report live progress.
 * Best-effort idempotent: a completed render returns immediately.
 */
export async function renderEventVideo(eventId: string): Promise<SoloRenderOutcome> {
  // One render at a time per event (same in-process lock solo uses).
  if (renderLock.has(eventId)) {
    await renderLock.get(eventId);
    return { ok: true };
  }

  // Skip if a durable done marker + real file already exist.
  const existing = await query<{ status: string; finished_key: string | null }>(
    `select status, finished_key from renders where event_id = $1`,
    [eventId]
  );
  if (existing.length > 0 && existing[0].status === "done" && existing[0].finished_key) {
    const ok = await fileExists(absolutePath(existing[0].finished_key));
    if (ok) {
      setProgress(eventId, { stage: "Done", percent: 100, done: true });
      return { ok: true };
    }
  }

  const run = (async () => {
    setProgress(eventId, { stage: "Loading the clip pool…", percent: 6, done: false });
    try {
      // --- 1. Event + prefs -------------------------------------------------
      const evs = await query<{ prefs: unknown; theme_id: string | null; title: string }>(
        `select prefs, theme_id, title from events where id = $1 and mode = 'collaborative'`,
        [eventId]
      );
      if (evs.length === 0) throw new Error("Event not found.");
      const prefs = (evs[0].prefs ?? {}) as Record<string, unknown>;
      const colorChain = filterChain(String(prefs.filter ?? "none").toLowerCase());

      // --- 2. The pool: only syncable VIDEO clips can be cut ---------------- 
      const allClips = await query<{
        id: string;
        media_type: string;
        s3_or_storage_key: string | null;
      }>(
        `select id, media_type, s3_or_storage_key
           from clips where event_id = $1 order by created_at, id`,
        [eventId]
      );
      const videos = allClips.filter(
        (c) => c.media_type === "video" && c.s3_or_storage_key
      );
      if (videos.length === 0) {
        if (allClips.some((c) => c.media_type === "photo")) {
          throw new Error(
            "This event only has photos so far. Photos on the timeline arrive in Phase 3 — add video clips that share audio to cut a movie."
          );
        }
        throw new Error("This event has no clips to render yet.");
      }
      const videoById = new Map(videos.map((v) => [v.id, v]));

      // Durable in-flight marker. NOTE: the renders table's CHECK constraint
      // allows ('pending','done','error') only, so the in-flight state is
      // 'pending' (exactly what solo uses) rather than adding a new enum value
      // in this milestone; the status endpoint reads live progress separately.
      await query(
        `insert into renders (event_id, status, error) values ($1, 'pending', null)
         on conflict (event_id) do update
           set status = 'pending', error = null, updated_at = now()`,
        [eventId]
      );

      // --- 3. The stored alignment (run it only if there is none) -----------
      let entries: StoredSyncEntry[] = [];
      let timelineMs = 0;
      const srows = await query<{ offsets: unknown; timeline_ms: number }>(
        `select offsets, timeline_ms from event_sync where event_id = $1`,
        [eventId]
      );
      if (srows.length > 0) {
        const o = (srows[0].offsets ?? {}) as { entries?: StoredSyncEntry[] };
        entries = Array.isArray(o.entries) ? o.entries : [];
        timelineMs = Number(srows[0].timeline_ms ?? 0);
      }
      if (entries.length < 2 || !(timelineMs > 0)) {
        setProgress(eventId, { stage: "Aligning the cameras…", percent: 12 });
        const { solveEventSync } = await import("./sync/service");
        const solved = await solveEventSync(eventId);
        entries = solved.entries;
        timelineMs = solved.timeline_ms;
      }
      if (entries.length < 2 || !(timelineMs > 0)) {
        throw new Error(
          "Vantage needs at least two clips that share audio before it can cut a movie. Add another clip that captured the same moment."
        );
      }

      // --- 4. Director clips: aligned geometry + the cached audio envelope --
      const participants = entries.filter((e) => videoById.has(e.clip_id));
      if (participants.length < 2) {
        throw new Error(
          "Vantage needs at least two clips that share audio before it can cut a movie. Add another clip that captured the same moment."
        );
      }
      const featRows = await query<{ clip_id: string; values: unknown; window_ms: number }>(
        `select clip_id, values, window_ms from audio_features where clip_id = any($1::uuid[])`,
        [participants.map((p) => p.clip_id)]
      );
      const featById = new Map(featRows.map((f) => [f.clip_id, f]));

      const directorClips: DirectorClip[] = [];
      for (const e of participants) {
        const row = videoById.get(e.clip_id)!;
        const abs = absolutePath(row.s3_or_storage_key!);
        // Trust whichever duration is SHORTER (the decoded audio length or the
        // file's real video length) so a shot can never ask for source time past
        // the end of the file.
        //
        // UNITS: ffprobeVideoDuration returns ffprobe's own SECONDS; the sync
        // entry's duration_ms is MILLISECONDS. Comparing the two raw (as this
        // did) put a 12005 ms clip's footprint at `min(12.005, 12005) = 12`
        // milliseconds, so `coveredRangeFor` clamped every slice to a 12 ms
        // window, the director emitted a single 12 ms shot, the renderer dropped
        // it (durMs < MIN_SHOT_MS) and the whole film died as "No shots could be
        // rendered for this event." Convert BEFORE the min.
        const probedSeconds = await ffprobeVideoDuration(abs);
        const probed = probedSeconds && probedSeconds > 0 ? Math.round(probedSeconds * 1000) : 0;
        const declared = Number(e.duration_ms) > 0 ? Number(e.duration_ms) : 0;
        const durationMs = Math.round(
          probed && declared ? Math.min(probed, declared) : probed || declared || 0
        );
        if (durationMs <= 0) continue;
        const feats = featById.get(e.clip_id);
        directorClips.push({
          clip_id: e.clip_id,
          offset_ms: Math.round(e.offset_ms),
          duration_ms: durationMs,
          file_path: abs,
          media_type: "video",
          envelope:
            feats && Array.isArray(feats.values)
              ? { values: (feats.values as number[]).map(Number), windowMs: feats.window_ms }
              : undefined,
          sync_confidence: typeof e.confidence === "number" ? e.confidence : 1,
          mean_residual_ms: e.mean_residual_ms,
        });
      }
      if (directorClips.length < 2) {
        throw new Error("Not enough usable video clips to cut a movie.");
      }

      // --- 5. The director: score every candidate, then select shots --------
      // No re-implementation here — scoreCandidates/selectShots are imported
      // from src/lib/director and driven with the event's real timeline.
      setProgress(eventId, {
        stage: "Choosing the best camera for every moment…",
        percent: 22,
      });
      const scored = await scoreCandidates({
        clips: directorClips,
        timeline_ms: timelineMs,
        options: { sliceMs: DIRECTOR_SLICE_MS },
      });
      setProgress(eventId, {
        stage: "Cutting the film — picking shots…",
        percent: 44,
      });
      const selection = selectShots(
        scored.scoreMatrix,
        scored.slices,
        { sliceMs: DIRECTOR_SLICE_MS },
        directorClips
      );
      if (selection.shots.length === 0) {
        throw new Error("No footage could be cut into shots for this event.");
      }

      // --- 6. Render every shot from its clip's own source window -----------
      const eventDir = path.join(uploadsRoot(), eventId);
      const renderDir = path.join(eventDir, "render");
      await mkdir(renderDir, { recursive: true });

      const clipById = new Map(directorClips.map((c) => [c.clip_id, c]));
      // Shot-loop audit trail: the director's geometry and the ids it hands the
      // renderer, so a future "no shots" failure names its own cause instead of
      // dying as one generic throw (see the two skip logs below).
      console.log(
        `render: event ${eventId} director → ${directorClips.length} clip(s) ${directorClips
          .map(
            (c) =>
              `${c.clip_id.slice(0, 8)}(offset=${c.offset_ms},dur=${c.duration_ms}${c.file_path ? "" : ",NO_FILE"})`
          )
          .join(" ")} | timeline ${timelineMs}ms | ${scored.slices.length} slice(s) | ${selection.shots.length} shot(s) | ${selection.gaps.length} gap(s)`
      );
      console.log(`render: event ${eventId} first shots ${JSON.stringify(selection.shots.slice(0, 5))}`);
      const segmentInputs: string[] = [];
      const renderedShots: Array<{
        clip_id: string;
        start_ms: number;
        end_ms: number;
        source_start_ms: number;
        source_end_ms: number;
      }> = [];
      const shotTotal = selection.shots.length;
      for (let i = 0; i < shotTotal; i++) {
        const shot = selection.shots[i];
        const clip = clipById.get(shot.clip_id);
        if (!clip) {
          console.log(
            `render: skip shot ${i}/${shotTotal} — clip_id ${JSON.stringify(shot.clip_id)} is NOT one of the ${clipById.size} director clip id(s) [${[...clipById.keys()].map((k) => k.slice(0, 8)).join(", ")}]; shot ${shot.start_ms}→${shot.end_ms}ms`
          );
          continue;
        }
        // shared-timeline time → this clip's own file time
        const sourceStart = Math.max(0, Math.round(shot.start_ms - clip.offset_ms));
        const sourceEnd = Math.min(
          clip.duration_ms,
          Math.round(shot.end_ms - clip.offset_ms)
        );
        const durMs = sourceEnd - sourceStart;
        if (durMs < MIN_SHOT_MS) {
          console.log(
            `render: skip shot ${i}/${shotTotal} — ${shot.clip_id.slice(0, 8)} timeline ${shot.start_ms}→${shot.end_ms}ms, clip offset ${clip.offset_ms}ms dur ${clip.duration_ms}ms ⇒ source ${sourceStart}→${sourceEnd}ms = ${durMs}ms (< MIN_SHOT_MS ${MIN_SHOT_MS})`
          );
          continue; // clamped-away sliver, not a shot
        }

        setProgress(eventId, {
          stage: `Cutting shot ${i + 1} of ${shotTotal}…`,
          percent: Math.round(44 + ((i + 1) / shotTotal) * 44),
        });

        const out = path.join(renderDir, `shot_${String(i).padStart(3, "0")}.mp4`);
        const vf = [
          `scale=${W}:${H}:force_original_aspect_ratio=increase`,
          `crop=${W}:${H}`,
        ];
        if (colorChain) vf.push(colorChain);
        vf.push("format=yuv420p");
        // Both -ss (accurate seek) and -t (source window length) are put on the
        // INPUT so ffmpeg reads only the shot's own window of the file — the
        // picture is cut where the director said, and the audio that comes with
        // it is that same moment's audio from that camera.
        const durS = (durMs / 1000).toFixed(3);
        const shotHasAudio = await hasAudioStream(absolutePath(videoById.get(shot.clip_id)!.s3_or_storage_key!));
        const args: string[] = [
          "-ss", (sourceStart / 1000).toFixed(3),
          "-t", durS,
          "-i", clip.file_path!,
        ];
        // An audio-less window still gets a silent track so every segment has the
        // same v+a layout and concat never silently drops the film's audio.
        if (!shotHasAudio) {
          args.push("-f", "lavfi", "-t", durS, "-i", SILENT_AUDIO_INPUT);
        }
        args.push(
          "-vf", vf.join(","),
          "-r", String(FPS),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2",
          "-t", durS,
          out
        );
        await runFfmpeg(args);
        segmentInputs.push(out);
        renderedShots.push({
          clip_id: shot.clip_id,
          start_ms: shot.start_ms,
          end_ms: shot.end_ms,
          source_start_ms: sourceStart,
          source_end_ms: sourceEnd,
        });
      }
      if (segmentInputs.length === 0) {
        throw new Error("No shots could be rendered for this event.");
      }

      // --- 7. Lossless concat in shot order = the switched film -------------
      setProgress(eventId, { stage: "Stitching the cuts together…", percent: 92 });
      const listFile = path.join(renderDir, "list.txt");
      await writeFile(
        listFile,
        segmentInputs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
      );
      const concatPath = path.join(renderDir, "concat.mp4");
      await runFfmpeg([
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy", concatPath,
      ]);
      if (!(await fileExists(concatPath))) {
        throw new Error("Render produced no output file.");
      }

      // Shot list written next to the film: the director's decisions, kept as
      // evidence for this render and as the input Phase 3's theme pass builds on.
      const cameraSequence: string[] = [];
      for (const s of renderedShots) {
        if (cameraSequence[cameraSequence.length - 1] !== s.clip_id) cameraSequence.push(s.clip_id);
      }
      await writeFile(
        path.join(eventDir, "director.json"),
        JSON.stringify(
          {
            event_id: eventId,
            generated_by: "renderEventVideo (Phase 2b)",
            slice_ms: DIRECTOR_SLICE_MS,
            timeline_ms: timelineMs,
            clips: directorClips.map((c) => ({
              clip_id: c.clip_id,
              offset_ms: c.offset_ms,
              duration_ms: c.duration_ms,
              sync_confidence: c.sync_confidence,
            })),
            shots: renderedShots,
            gaps: selection.gaps,
            violations: selection.violations,
            camera_sequence: cameraSequence,
            total_switch_penalty: selection.total_switch_penalty,
          },
          null,
          1
        )
      );
      console.log(
        `[event-render] ${eventId}: ${renderedShots.length} shots over ${timelineMs}ms, cameras ${cameraSequence
          .map((c) => c.slice(0, 8))
          .join(" → ")}`
      );

      const finishedPath = path.join(eventDir, "finished.mp4");
      // Style pass only when the organizer actually chose one (border / caption).
      // The AUDIO BED IS THE SHOTS' OWN AUDIO — no synthesized music bed in this
      // milestone (music layering is Phase 3, see the report).
      const borderOn = prefs.border_on === true;
      const caption =
        typeof prefs.caption === "string" && prefs.caption.trim()
          ? prefs.caption.trim()
          : null;
      if (borderOn || caption !== null) {
        await finalizeSoloVideo(concatPath, finishedPath, {
          borderOn,
          caption,
          musicStyle: null,
          themeId: evs[0].theme_id,
        });
      } else {
        await copyFile(concatPath, finishedPath);
      }
      if (!(await fileExists(finishedPath))) {
        throw new Error("Render produced no output file.");
      }

      // --- 8. Durable done marker (status polling reads this) ---------------
      const finishedKey = `uploads/${eventId}/finished.mp4`;
      await query(
        `insert into renders (event_id, status, finished_key, error)
         values ($1, 'done', $2, null)
         on conflict (event_id) do update
           set status = 'done', finished_key = excluded.finished_key, error = null, updated_at = now()`,
        [eventId, finishedKey]
      );
      await rm(renderDir, { recursive: true, force: true }).catch(() => {});
      setProgress(eventId, { stage: "Done", percent: 100, done: true });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("render: event render failed", e);
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
