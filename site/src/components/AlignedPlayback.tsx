import { useEffect, useMemo, useRef, useState } from "react";
import { getSync, runSync, type Clip, type SyncEntryDto } from "~/lib/vantage";

/**
 * AlignedPlayback — the visible proof the sync engine works.
 *
 * Renders every syncable video clip side by side in a grid, all locked to one
 * shared transport (play/pause + a single timeline). Each clip is placed at its
 * global start offset on the event timeline, so pressing play starts them all at
 * the same *moment* (each camera at the position where that moment falls in its
 * own recording). A requestAnimationFrame loop gently re-seeks any clip that
 * drifts from the master clock, keeping the angles aligned.
 *
 * "Sync now" runs the server-side alignment (feature extraction is cached); the
 * page otherwise only fetches already-computed offsets — no long jobs run in a
 * request.
 */

function fmtTime(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function AlignedPlayback({
  clips,
  eventId,
}: {
  clips: Clip[];
  eventId: string;
}) {
  const videoClips = useMemo(() => clips.filter((c) => c.media_type === "video"), [clips]);

  const [sync, setSync] = useState<{
    entries: SyncEntryDto[];
    dropped: string[];
    timelineMs: number;
  }>({ entries: [], dropped: [], timelineMs: 0 });
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const res = await getSync({ data: { event_id: eventId } });
    if (res.ok) {
      setSync({
        entries: res.entries ?? [],
        dropped: res.dropped ?? [],
        timelineMs: res.timeline_ms ?? 0,
      });
    }
    setLoaded(true);
  }

  useEffect(() => {
    load().catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    setNote(null);
    try {
      const res = await runSync({ data: { event_id: eventId } });
      if (!res.ok) setNote(res.message ?? "Alignment failed.");
      else {
        setSync({
          entries: res.entries ?? [],
          dropped: res.dropped ?? [],
          timelineMs: res.timeline_ms ?? 0,
        });
        setNote(
          res.entries && res.entries.length
            ? `Aligned ${res.entries.length} clip${res.entries.length === 1 ? "" : "s"} on one timeline.`
            : "No clips could be aligned yet — upload at least two videos that share audio."
        );
      }
    } finally {
      setSyncing(false);
    }
  }

  const byId = useMemo(() => {
    const m = new Map<string, Clip>();
    for (const c of videoClips) m.set(c.id, c);
    return m;
  }, [videoClips]);

  const aligned = sync.entries
    .map((e) => ({ entry: e, clip: byId.get(e.clip_id) }))
    .filter((x) => x.clip);

  const droppedNames = sync.dropped
    .map((id) => byId.get(id)?.filename)
    .filter(Boolean)
    .slice(0, 4);

  if (!loaded) {
    return <div className="py-6 text-sm text-gray-500">Loading sync state…</div>;
  }

  return (
    <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Aligned playback</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Clips that shared audio are matched by the sync engine and locked to
            one timeline.
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing || videoClips.length < 2}
          className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {note && <p className="mt-3 text-sm text-gray-600">{note}</p>}

      {aligned.length >= 2 && (
        <div className="mt-5">
          <SyncPlayer clips={aligned} timelineMs={sync.timelineMs} />
        </div>
      )}

      {aligned.length < 2 && videoClips.length >= 2 && (
        <p className="mt-4 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-500">
          Not enough overlap to align yet. Video clips are matched by the audio
          they share — try clips that captured the same moment or music.
        </p>
      )}

      {videoClips.length < 2 && (
        <p className="mt-4 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-500">
          Add at least two video clips with shared audio to see them play back
          aligned.
        </p>
      )}

      {droppedNames.length > 0 && (
        <p className="mt-3 text-xs text-gray-400">
          Skipped (no matching audio): {droppedNames.join(", ")}
        </p>
      )}
    </div>
  );
}

function SyncPlayer({
  clips,
  timelineMs,
}: {
  clips: { entry: SyncEntryDto; clip: Clip }[];
  timelineMs: number;
}) {
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const rafRef = useRef<number | null>(null);
  const clockRef = useRef<{ playing: boolean; global: number; startPerf: number }>({
    playing: false,
    global: 0,
    startPerf: 0,
  });
  const [playing, setPlaying] = useState(false);
  const [globalTime, setGlobalTime] = useState(0);
  const [muted, setMuted] = useState<Record<string, boolean>>({});

  const duration = Math.max(0.5, timelineMs / 1000 || 0.5);

  // Compute each clip's position (in the file) for a given global time.
  const positionFor = (entry: SyncEntryDto, g: number) =>
    g - entry.offset_ms / 1000;

  function applyPositions(globalSeconds: number) {
    for (const { entry } of clips) {
      const v = videoRefs.current[entry.clip_id];
      if (!v) continue;
      const target = positionFor(entry, globalSeconds);
      const len = Number.isFinite(v.duration) ? v.duration : entry.duration_ms / 1000;
      const clamped = Math.max(0, Math.min(target, Math.max(0, len - 0.03)));
      if (Math.abs(v.currentTime - clamped) > 0.12) {
        try {
          v.currentTime = clamped;
        } catch {
          /* not seekable yet — ignore */
        }
      }
    }
  }

  function tick() {
    const c = clockRef.current;
    if (c.playing) {
      const g = c.global + (performance.now() - c.startPerf) / 1000;
      if (g >= duration) {
        stopAll();
      } else {
        setGlobalTime(g);
        applyPositions(g);
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function stopAll() {
    const c = clockRef.current;
    c.playing = false;
    setPlaying(false);
    setGlobalTime(0);
    applyPositions(0);
  }

  function togglePlay() {
    const c = clockRef.current;
    if (c.playing) {
      // pause: remember where we are, stop the loop from writing positions
      c.playing = false;
      c.global = globalTime;
      setPlaying(false);
      for (const { entry } of clips) {
        videoRefs.current[entry.clip_id]?.pause();
      }
      return;
    }
    // start (or resume) playback
    c.playing = true;
    c.global = globalTime;
    c.startPerf = performance.now();
    setPlaying(true);
    applyPositions(globalTime);
    for (const { entry } of clips) {
      const v = videoRefs.current[entry.clip_id];
      if (!v) continue;
      v.muted = muted[entry.clip_id] ?? false;
      if (!v.muted) v.play().catch(() => {});
    }
  }

  function seek(seconds: number) {
    const c = clockRef.current;
    const g = Math.max(0, Math.min(seconds, duration));
    c.global = g;
    if (c.playing) c.startPerf = performance.now();
    setGlobalTime(g);
    applyPositions(g);
  }

  function toggleMute(clipId: string) {
    setMuted((prev) => {
      const next = { ...prev, [clipId]: !prev[clipId] };
      const v = videoRefs.current[clipId];
      if (v) v.muted = next[clipId];
      return next;
    });
  }

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* Shared transport */}
      <div className="mb-4 rounded-2xl bg-gray-900 px-4 py-3 text-white">
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-fuchsia-500 text-lg font-bold transition hover:bg-fuchsia-400"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="flex-1">
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={Math.min(globalTime, duration)}
              onChange={(e) => seek(Number(e.target.value))}
              className="w-full accent-fuchsia-500"
            />
          </div>
          <div className="w-20 text-right font-mono text-xs text-gray-300">
            {fmtTime(globalTime * 1000)} / {fmtTime(duration * 1000)}
          </div>
        </div>
        <p className="mt-1 text-center text-[11px] uppercase tracking-widest text-gray-400">
          Shared timeline — all clips locked to this clock
        </p>
      </div>

      {/* Grid of aligned angles */}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(${clips.length > 2 ? "220px" : "min(320px,100%)"}, 1fr))`,
        }}
      >
        {clips.map(({ clip, entry }) => (
          <div key={clip.id} className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-50">
            <video
              ref={(el) => {
                videoRefs.current[entry.clip_id] = el;
              }}
              src={`/${clip.s3_or_storage_key}`}
              preload="metadata"
              playsInline
              muted={muted[entry.clip_id] ?? false}
              className="aspect-video w-full bg-black object-contain"
            />
            <div className="flex items-center justify-between px-3 py-2 text-xs text-gray-600">
              <span className="truncate font-semibold">{clip.filename}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-gray-400">
                  +{fmtTime(entry.offset_ms)}
                </span>
                <button
                  onClick={() => toggleMute(entry.clip_id)}
                  className="text-sm"
                  aria-label={muted[entry.clip_id] ? "Unmute" : "Mute"}
                >
                  {muted[entry.clip_id] ? "🔇" : "🔊"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
