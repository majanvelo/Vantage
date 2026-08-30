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
      const evs = await query<{ prefs: unknown }>(
        `select prefs from events where id = $1 and mode = 'solo'`,
        [eventId]
      );
      if (evs.length === 0) throw new Error("Solo video not found.");
      const prefs = (evs[0].prefs ?? {}) as Record<string, unknown>;
      const filter = String(prefs.filter ?? "none").toLowerCase();
      const musicOn = prefs.music_on === true;
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
        const vf = [
          `scale=${W}:${H}:force_original_aspect_ratio=increase`,
          `crop=${W}:${H}`,
          `zoompan=z='${zoompan}':d=${FRAME_COUNT}:s=${W}x${H}:fps=${FPS}`,
        ];
        if (colorChain) vf.push(colorChain);
        vf.push("format=yuv420p");
        await runFfmpeg([
          "-i", absolutePath(c.s3_or_storage_key!),
          "-vf", vf.join(","),
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

      // 5. Check for a real bundled music track (currently none in the project).
      // If one ever exists, it would be mixed here at low volume. We never
      // invent/fake a track — pure-photo solo videos render silent.
      if (musicOn) {
        await findMusicTrack(eventId).catch(() => null);
        // Future Phase-3: mix the resolved licensed track under the finished
        // video at low volume. None exists in the project today, so nothing is
        // invented — pure-photo solo videos render silent.
      }

      // 6. Concatenate all segments into the finished MP4.
      setProgress(eventId, { stage: "Finalizing video…", percent: 96 });
      const listFile = path.join(renderDir, "list.txt");
      await writeFile(
        listFile,
        segmentInputs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
      );
      const finishedPath = path.join(eventDir, "finished.mp4");
      await runFfmpeg([
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy",
        finishedPath,
      ]);

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

/** Look for a real bundled music track in the project (currently none — returns null). */
async function findMusicTrack(_eventId: string): Promise<string | null> {
  // No licensed music library ships with this phase; return null and document.
  // Future: resolve a per-theme track path and verify it exists before mixing.
  return null;
}

/** Elapsed seconds for the status endpoint. */
export function elapsedSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}
