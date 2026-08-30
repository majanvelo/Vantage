import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  listThemes,
  createEvent,
  startSoloRender,
  getSoloVideo,
  type Theme,
  type Clip,
  type Event,
  type SoloVideoSync,
  type SoloVideoRenderInfo,
} from "~/lib/vantage";
import SoloResult from "~/components/SoloResult";

const MOODS = ["serious", "playful", "formal", "educational"];
const FILTERS = ["none", "warm", "cool", "vintage", "bw", "cinematic"];

/**
 * Upload a single file to the streaming multipart endpoint (`/api/upload`) —
 * raw bytes in the body, no base64, so large/long real-phone videos upload
 * reliably. Mirrors the `clip` shape `uploadClip` returned.
 *
 * Uses XMLHttpRequest (not fetch) so the browser reports real per-file byte
 * progress via `xhr.upload.onprogress` — the upload phase of the progress bar
 * reflects actual bytes sent, not a guess.
 */
type UploadResp = {
  ok: boolean;
  message?: string;
  clip?: Clip;
  featuresOk?: boolean;
};
function uploadClipMultipart(
  args: {
    event_id: string;
    file: File;
    mediaType: "photo" | "video";
  },
  onProgress: (loaded: number, total: number) => void
): Promise<UploadResp> {
  return new Promise((resolve) => {
    const fd = new FormData();
    fd.append("event_id", args.event_id);
    fd.append("media_type", args.mediaType);
    fd.append("filename", args.file.name);
    if (args.file.type) fd.append("content_type", args.file.type);
    fd.append("file", args.file, args.file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        resolve({ ok: false, message: "Upload failed — please retry." });
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as UploadResp);
      } catch {
        resolve({ ok: false, message: "Upload failed — please retry." });
      }
    };
    xhr.onerror = () =>
      resolve({ ok: false, message: "Upload failed — please retry." });
    xhr.send(fd);
  });
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-fuchsia-300"
    >
      <span>
        <span className="block text-sm font-semibold text-gray-900">{label}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
      <span
        className={`ml-4 inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? "bg-fuchsia-500" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

type Phase = "loading" | "setup" | "result";
type ResultData = {
  event: Event;
  clips: Clip[];
  sync: SoloVideoSync;
  render?: SoloVideoRenderInfo;
};

function SoloPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [result, setResult] = useState<ResultData | null>(null);

  const [themes, setThemes] = useState<Theme[]>([]);
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [themeId, setThemeId] = useState("");
  const [system, setSystem] = useState(false);
  const [mood, setMood] = useState("playful");
  const [filter, setFilter] = useState("none");
  const [subtitles, setSubtitles] = useState(true);
  const [music, setMusic] = useState(true);
  const [stickers, setStickers] = useState(false);
  const [border, setBorder] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Live progress for the "Get my video" flow. `percent` is the real mapped
   * progress (upload % is derived from actual bytes sent via XHR upload events;
   * later stages advance on actual completed steps) and `stage` is a human label.
   */
  const [progress, setProgress] = useState<{ stage: string; percent: number } | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    listThemes()
      .then((t) => setThemes(t))
      .catch(() => setThemes([]));
    const id =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("id")
        : null;
    if (id) {
      getSoloVideo({ data: { id } })
        .then((res) => {
          if (res.ok && res.event && res.clips && res.sync) {
            setResult({ event: res.event, clips: res.clips, sync: res.sync, render: res.render });
            setPhase("result");
            return;
          }
          setPhase("setup");
        })
        .catch(() => setPhase("setup"));
    } else {
      setPhase("setup");
    }
  }, []);

  const totalBytes = useMemo(
    () => files.reduce((acc, f) => acc + f.size, 0),
    [files]
  );

  function addFiles(list: FileList | null) {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => {
      const names = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [
        ...prev,
        ...incoming.filter((f) => !names.has(`${f.name}:${f.size}`)),
      ];
    });
  }

  /**
   * Poll the server's render-status endpoint while the ffmpeg render runs in
   * the background. Returns the live stage/% so the bar keeps climbing with real
   * work completed — it never sits frozen on one number. Resolves when the
   * render reports done (or an error).
   */
  function pollRenderStatus(
    eventId: string,
    onProgress: (p: { stage: string; percent: number }) => void
  ): Promise<{ ok: boolean; done: boolean; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const tick = async () => {
        if (settled) return;
        try {
          const res = await fetch(`/api/solo/render-status?event_id=${encodeURIComponent(eventId)}`);
          const data = await res.json();
          onProgress({ stage: data.stage ?? "Processing your clips…", percent: Number(data.percent ?? 68) });
          if (data.done) {
            settled = true;
            resolve({ ok: !data.error, done: true, error: data.error ?? undefined });
            return;
          }
        } catch {
          // transient poll failure — keep trying
        }
        if (!settled) setTimeout(tick, 700);
      };
      setTimeout(tick, 400);
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (files.length === 0) {
      setError("Add at least one photo or video to make your video.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const prefs = system
        ? { system_does_everything: true }
        : {
            story_mood: mood,
            filter,
            subtitles_on: subtitles,
            music_on: music,
            stickers_on: stickers,
            border_on: border,
          };
      setProgress({ stage: "Creating your private composition…", percent: 2 });
      const evRes = await createEvent({
        data: {
          title: title.trim() || "My video",
          mode: "solo",
          theme_id: themeId || undefined,
          prefs,
        },
      });
      if (!evRes.ok) {
        setError(evRes.message);
        return;
      }
      const ev = evRes.event;
      const totalBytes = files.reduce((a, f) => a + f.size, 0);

      // --- Upload phase (0 → 62%). Percent is real: it tracks actual bytes
      // sent across all multipart uploads via XHR's upload onprogress. ---
      const UP_START = 4;
      const UP_SPAN = 58;
      let bytesDone = 0;
      const clips: Clip[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const mediaType = f.type.startsWith("image/") ? "photo" : "video";
        setProgress({
          stage: `Uploading ${i + 1} of ${files.length}`,
          percent: UP_START + (bytesDone / totalBytes) * UP_SPAN,
        });
        const up = await uploadClipMultipart(
          { event_id: ev.id, file: f, mediaType },
          (loaded) => {
            // bytes we've completed on already-finished files + this file's part
            const sent = bytesDone + Math.min(loaded, f.size);
            const frac = totalBytes > 0 ? sent / totalBytes : (i + 1) / files.length;
            setProgress({
              stage: `Uploading ${i + 1} of ${files.length}`,
              percent: UP_START + frac * UP_SPAN,
            });
          }
        );
        if (!up.ok) {
          setError(up.message || "Something went wrong uploading a file.");
          return;
        }
        if (up.clip) clips.push(up.clip);
        bytesDone += f.size;
      }

      // --- Render phase. Start the real ffmpeg render (it runs in the
      // background server-side), then poll for live stage/% so the progress bar
      // advances continuously through "Processing → Rendering photo i of N →
      // Finalizing → Done" with no silent freeze. ---
      setProgress({ stage: "Processing your clips…", percent: 68 });
      const startRes = await startSoloRender({ data: { event_id: ev.id } });
      if (!startRes.ok) {
        setError(startRes.message || "Something went wrong rendering your video.");
        return;
      }
      const poll = await pollRenderStatus(ev.id, (p) => setProgress(p));
      if (!poll.ok || poll.error) {
        setError(poll.error || "Something went wrong rendering your video. Please try again.");
        return;
      }

      // --- Done: reload the persisted private composition (which now carries
      // the rendered finished-video marker). ---
      const full = await getSoloVideo({ data: { id: ev.id } });
      setResult(
        full.ok && full.event && full.clips && full.sync
          ? { event: full.event, clips: full.clips, sync: full.sync, render: full.render }
          : { event: ev, clips, sync: { entries: [], dropped: [], timelineMs: 0 } }
      );
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", `/solo?id=${ev.id}`);
      }
      setProgress({ stage: "Finished!", percent: 100 });
      setPhase("result");
    } catch (err) {
      console.error(err);
      setError("Something went wrong building your video. Please try again.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (phase === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-white text-gray-500">
        Loading…
      </div>
    );
  }

  if (phase === "result" && result) {
    return (
      <SoloResult
        event={result.event}
        clips={result.clips}
        sync={result.sync}
        themes={themes}
        render={result.render}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white">
        <nav className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-4">
          <a href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="text-2xl">📽️</span> Vantage
          </a>
          <div className="flex items-center gap-3 text-sm">
            <a href="/app/create" className="font-semibold text-gray-600 hover:text-gray-900">
              Shared event
            </a>
            <span className="rounded-full bg-fuchsia-100 px-3 py-1 text-xs font-bold text-fuchsia-700">
              Solo mode
            </span>
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 py-10">
        <div className="text-center">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            Make your own video — solo
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-gray-600">
            Add your photos &amp; videos, pick a theme (or let Vantage choose), and get one
            finished, styled video back. It&apos;s private to you — no shared pool, no event,
            no share link.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          {/* Upload */}
          <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold">1 · Add your photos &amp; videos</h2>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`mt-4 cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition ${
                dragging
                  ? "border-fuchsia-400 bg-fuchsia-50"
                  : "border-gray-200 bg-gray-50 hover:border-fuchsia-300"
              }`}
            >
              <div className="text-3xl">📤</div>
              <p className="mt-2 text-sm font-semibold text-gray-700">
                Drag &amp; drop your clips here, or click to choose
              </p>
              <p className="mt-1 text-xs text-gray-400">
                Videos (mp4, mov…) and photos (jpg, png…) — private to you
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="video/*,image/*"
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {files.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold text-gray-700">
                    {files.length} file{files.length === 1 ? "" : "s"} added
                  </span>
                  <span className="text-gray-400">{(totalBytes / 1048576).toFixed(1)} MB</span>
                </div>
                <div className="mt-2 grid max-h-48 gap-1.5 overflow-y-auto pr-1">
                  {files.map((f, i) => (
                    <div
                      key={`${f.name}:${f.size}`}
                      className="flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50/70 px-3 py-2 text-sm"
                    >
                      <span>{f.type.startsWith("image/") ? "🖼️" : "🎬"}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-gray-800">
                        {i + 1}. {f.name}
                      </span>
                      <span className="text-xs text-gray-400">
                        {(f.size / 1048576).toFixed(1)} MB
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setFiles((prev) => prev.filter((x) => x !== f))
                        }
                        className="text-gray-400 transition hover:text-red-500"
                        aria-label={`Remove ${f.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Theme */}
          <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold">2 · Pick a theme</h2>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {themes.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setThemeId(t.is_plus && themeId === t.id ? "" : t.id)}
                  disabled={system}
                  className={`rounded-xl border px-3 py-2.5 text-center text-sm font-semibold transition disabled:opacity-40 ${
                    themeId === t.id
                      ? "border-fuchsia-500 bg-fuchsia-50 text-fuchsia-700"
                      : "border-gray-200 text-gray-700 hover:border-fuchsia-300"
                  }`}
                >
                  {t.display_name}
                  {t.is_plus && (
                    <span className="ml-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-600">
                      PLUS
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* Style / toggles */}
          <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold">3 · Choose the look</h2>
            <button
              type="button"
              onClick={() => setSystem(!system)}
              className="mt-4 flex w-full items-center justify-between rounded-2xl border border-fuchsia-200 bg-fuchsia-50 px-4 py-3 text-left"
            >
              <span>
                <span className="block text-sm font-bold text-fuchsia-800">
                  Let the system do everything
                </span>
                <span className="block text-xs text-fuchsia-600">
                  Vantage picks the theme, mood and includes a tasteful set of music,
                  subtitles &amp; stickers — one tap.
                </span>
              </span>
              <span
                className={`ml-4 inline-flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition ${
                  system ? "bg-fuchsia-600" : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    system ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </span>
            </button>

            {!system && (
              <div className="mt-5 space-y-3">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <span className="text-sm font-semibold text-gray-900">Story mood</span>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {MOODS.map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setMood(m)}
                          className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition ${
                            mood === m
                              ? "bg-fuchsia-600 text-white"
                              : "border border-gray-300 text-gray-700 hover:border-fuchsia-300"
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-gray-900">Filter</span>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {FILTERS.map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setFilter(f)}
                          className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition ${
                            filter === f
                              ? "bg-fuchsia-600 text-white"
                              : "border border-gray-300 text-gray-700 hover:border-fuchsia-300"
                          }`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <Toggle label="Subtitles" hint="Auto-captions on the finished video" checked={subtitles} onChange={setSubtitles} />
                <Toggle label="Music" hint="Add a soundtrack matched to your theme" checked={music} onChange={setMusic} />
                <Toggle label="Stickers" hint="Playful stickers & emoji overlays" checked={stickers} onChange={setStickers} />
                <Toggle label="Border / frame" hint="A clean frame around the video" checked={border} onChange={setBorder} />
              </div>
            )}
          </section>

          {/* Title + submit */}
          <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold">4 · Get your video</h2>
            <label className="mt-4 block text-sm font-semibold text-gray-900">
              Video title{" "}
              <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My video"
              className="mt-1.5 w-full rounded-xl border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-fuchsia-500 focus:outline-none"
            />
            {error && (
              <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
            {busy && progress && (
              <div className="mt-4 rounded-2xl border border-fuchsia-100 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-semibold text-fuchsia-700">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-fuchsia-500" />
                    <span>{progress.stage}</span>
                  </span>
                  <span className="font-mono text-sm font-bold tabular-nums text-fuchsia-700">
                    {Math.round(progress.percent)}%
                  </span>
                </div>
                <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-fuchsia-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-indigo-500 transition-[width] duration-200 ease-out"
                    style={{ width: `${Math.max(2, Math.min(100, progress.percent))}%` }}
                  />
                </div>
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 py-3.5 text-base font-bold text-white shadow-lg shadow-fuchsia-500/25 transition hover:opacity-90 disabled:opacity-60"
            >
              🎬 {busy ? "Making your video…" : "Get my video"}
            </button>
          </section>

          <div className="pb-4 text-center text-xs text-gray-400">
            🔒 Private &amp; solo — your uploads live in your own private composition.
            Nothing is shared and there&apos;s no event code.
          </div>
        </form>
      </main>
    </div>
  );
}

export const Route = createFileRoute("/solo")({
  component: SoloRoute,
});

function SoloRoute() {
  return <SoloPage />;
}
