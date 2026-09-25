import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSync, startEventRender, type Clip } from "~/lib/vantage";

/**
 * EventMovie — the organizer's "Make movie" panel for a COLLABORATIVE event.
 *
 * This is the FINISHED FILM: the auto-cut director picks a camera for every
 * moment of the shared timeline (steadiest shot, best audio, faces in frame, no
 * jump cuts) and the server bakes that shot list into ONE MP4, which is shown
 * here. It mirrors the solo result flow (SoloResult + solo.tsx): a button, a
 * real progress bar driven by the server's live stage/%, then the finished
 * video with a download link.
 *
 * The button only makes sense once clips are aligned to one timeline, so:
 *   - fewer than two syncable video clips  → a clear empty-state message, no button
 *   - clips uploaded but not synced yet    → a "sync first" message, no button
 *   - aligned → the button, the progress bar, and then the film.
 */

type MovieState = {
  stage: string;
  percent: number;
  done: boolean;
  url: string | null;
  error: string | null;
};

const POLL_MS = 900;
/** Renders are real ffmpeg work; give a long edit plenty of room. */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

export default function EventMovie({ eventId, clips }: { eventId: string; clips: Clip[] }) {
  const syncable = useMemo(
    () => clips.filter((c) => c.media_type === "video" && !!c.s3_or_storage_key),
    [clips]
  );
  const [alignCount, setAlignCount] = useState<number | null>(null);
  const [timelineMs, setTimelineMs] = useState(0);
  const [movie, setMovie] = useState<MovieState | null>(null);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const polling = useRef(false);

  /** Poll the server's live render state until the film is done (or errored). */
  const pollUntilDone = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    try {
      for (;;) {
        try {
          const res = await fetch(
            `/api/events/${encodeURIComponent(eventId)}/render-status`,
            { cache: "no-store" }
          );
          const data = await res.json();
          const next: MovieState = {
            stage: String(data.stage ?? "Rendering…"),
            percent: Number(data.percent ?? 0),
            done: !!data.done,
            url: typeof data.url === "string" ? data.url : null,
            error: typeof data.error === "string" ? data.error : null,
          };
          setMovie(next);
          if (next.done) return;
        } catch {
          // transient poll failure — keep trying
        }
        if (Date.now() >= deadline) return;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } finally {
      polling.current = false;
    }
  }, [eventId]);

  /** Read the stored alignment + whatever durable render state exists. */
  const load = useCallback(async () => {
    const s = await getSync({ data: { event_id: eventId } }).catch(() => null);
    if (s && s.ok) {
      setAlignCount((s.entries ?? []).length);
      setTimelineMs(s.timeline_ms ?? 0);
    } else {
      setAlignCount(null);
    }
    // Durable/past render: show the finished film if one exists, and re-attach
    // to a render that is still running (e.g. after a page reload).
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/render-status`, {
        cache: "no-store",
      });
      const data = await res.json();
      const state: MovieState = {
        stage: String(data.stage ?? ""),
        percent: Number(data.percent ?? 0),
        done: !!data.done,
        url: typeof data.url === "string" ? data.url : null,
        error: typeof data.error === "string" ? data.error : null,
      };
      if (state.done || state.percent > 0) setMovie(state);
      if (!state.done && state.percent > 0) void pollUntilDone();
    } catch {
      /* status endpoint unreachable — the button still works */
    }
  }, [eventId, pollUntilDone]);

  useEffect(() => {
    void load();
  }, [load, clips.length]);

  async function handleMakeMovie() {
    if (busy) return;
    setBusy(true);
    setStartError(null);
    try {
      const res = await startEventRender({ data: { event_id: eventId } });
      if (!res.ok) {
        setStartError(res.message ?? "Could not start the movie.");
        return;
      }
      setMovie({ stage: "Getting the cut ready…", percent: 1, done: false, url: null, error: null });
      await pollUntilDone();
    } catch {
      setStartError("Something went wrong starting the movie. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const finishedUrl = movie?.done && movie.url ? movie.url : null;
  const rendering = busy || (movie !== null && !movie.done);
  const aligned = (alignCount ?? 0) >= 2;

  return (
    <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">🎬 Make the movie</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Vantage cuts between the cameras by itself — steadiest shot, best
            audio, faces in frame, no jump cuts — and hands back one finished
            film with the event&apos;s own soundtrack.
          </p>
        </div>
        {aligned && !finishedUrl && (
          <button
            type="button"
            onClick={handleMakeMovie}
            disabled={rendering}
            className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rendering ? "Making your movie…" : "Make movie"}
          </button>
        )}
      </div>

      {/* Empty states — a clear message INSTEAD of a button that cannot work. */}
      {syncable.length < 2 && (
        <p className="mt-4 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-500">
          Add at least two video clips that captured the same moment — then Vantage
          can cut the movie for you.
        </p>
      )}
      {syncable.length >= 2 && alignCount !== null && alignCount < 2 && (
        <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          These clips aren&apos;t lined up yet. Tap <strong>Sync now</strong> above to
          match them on one timeline — the Make movie button appears as soon as
          they&apos;re aligned.
        </p>
      )}

      {startError && (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{startError}</p>
      )}

      {/* Live progress — real stage/% from the server while ffmpeg works. */}
      {rendering && !finishedUrl && (
        <div className="mt-5">
          <div className="flex items-center justify-between text-sm font-semibold text-gray-700">
            <span>{movie?.stage || "Getting the cut ready…"}</span>
            <span className="font-mono text-xs text-gray-400">
              {Math.round(movie?.percent ?? 0)}%
            </span>
          </div>
          <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-indigo-500 transition-all duration-500"
              style={{ width: `${Math.max(3, Math.min(100, movie?.percent ?? 3))}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Picking cameras, cutting the shots and stitching them into one film — you
            can leave this page open.
          </p>
        </div>
      )}

      {/* Done / error */}
      {movie?.done && movie.error && !finishedUrl && (
        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-5 py-4">
          <h3 className="text-base font-bold text-red-800">The movie couldn&apos;t be made</h3>
          <p className="mt-1 text-sm text-red-700">{movie.error}</p>
        </div>
      )}

      {finishedUrl && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold text-gray-900">
              ▶ Your event film — {Math.round((timelineMs || 0) / 1000)}s,{" "}
              {alignCount} camera{alignCount === 1 ? "" : "s"}
            </h3>
            <a
              href={finishedUrl}
              download="vantage-event.mp4"
              className="rounded-full bg-fuchsia-600 px-4 py-1.5 text-xs font-bold text-white shadow transition hover:bg-fuchsia-700"
            >
              ⬇ Download
            </a>
          </div>
          <video
            key={finishedUrl}
            src={finishedUrl}
            controls
            playsInline
            preload="metadata"
            className="mt-4 aspect-video w-full rounded-xl bg-black object-contain"
          />
          <p className="mt-3 text-xs text-gray-400">
            One finished film, cut from every angle by the automatic director — no
            editing timeline, no manual cuts.
          </p>
        </div>
      )}
    </div>
  );
}
