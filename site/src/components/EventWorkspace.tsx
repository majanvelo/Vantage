import { useRef, useState } from "react";
import {
  uploadClip,
  getEventByCode,
  joinEvent,
  type Clip,
  type Event,
  type Member,
} from "~/lib/vantage";
import AlignedPlayback from "~/components/AlignedPlayback";

export type EventLoad =
  | { ok: true; event: Event; members: Member[]; clips: Clip[] }
  | { ok: false; message: string };

function fmtSize(bytes: string | null): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MEDIA_ICON = { video: "🎬", photo: "🖼️" } as const;
const MOOD_LABEL: Record<string, string> = {
  serious: "Serious",
  playful: "Playful",
  formal: "Formal",
  educational: "Educational",
};

export default function EventWorkspace({
  initial,
  shareCode,
}: {
  initial: EventLoad;
  shareCode: string;
}) {
  const [data, setData] = useState<EventLoad>(initial);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const shareUrl = `${origin}/e/${shareCode}`;

  if (!data.ok) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl border border-gray-200 bg-white p-8 text-center shadow-xl">
          <div className="text-4xl">🕵️</div>
          <h1 className="mt-4 text-xl font-bold">Event not found</h1>
          <p className="mt-2 text-gray-600">{data.message}</p>
          <a
            href="/"
            className="mt-5 inline-block rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white"
          >
            Go home
          </a>
        </div>
      </div>
    );
  }

  const { event, members, clips } = data;
  const uploaders = new Set(clips.map((c) => c.uploader).filter(Boolean));
  const contributorCount = Math.max(members.length, uploaders.size);

  async function refresh() {
    const res = await getEventByCode({ data: { code: shareCode } });
    if (res.ok) setData(res);
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await joinEvent({ data: { code: shareCode, name } });
      if (!res.ok) setNote({ kind: "err", text: res.message });
      else {
        setNote({ kind: "ok", text: `You're in — contributing as ${res.member}.` });
        await refresh();
      }
    } catch {
      setNote({ kind: "err", text: "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !file) return;
    setBusy(true);
    setNote(null);
    try {
      // Read the real file bytes (base64) and push them to the server, which
      // materialises them to disk and pre-extracts audio features for sync.
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
      });
      const comma = dataUrl.indexOf(",");
      const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

      const res = await uploadClip({
        data: {
          event_id: event.id,
          uploader: name || "Guest",
          filename: file.name,
          content_type: file.type || undefined,
          size_bytes: file.size,
          data_base64: dataBase64,
        },
      });
      if (!res.ok) {
        setNote({ kind: "err", text: res.message ?? "Upload failed." });
      } else {
        setNote({
          kind: "ok",
          text: `Uploaded "${file.name}"${res.featuresOk ? " — audio analyzed for sync." : "."}`,
        });
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        await refresh();
      }
    } catch {
      setNote({ kind: "err", text: "Upload failed. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const prefs = (event.prefs ?? {}) as Record<string, unknown>;

  return (
    <div className="min-h-dvh bg-gradient-to-br from-fuchsia-50 via-white to-indigo-50">
      <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/80 backdrop-blur">
        <nav className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4">
          <a href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-fuchsia-500 text-sm">
              ▶
            </span>
            Vantage
          </a>
          <a
            href="/app/create"
            className="rounded-full border border-gray-300 px-4 py-1.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
          >
            Start my own event
          </a>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-4xl px-5 py-10">
        {/* Event header */}
        <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-fuchsia-100 px-3 py-1 text-xs font-semibold text-fuchsia-700">
                  {event.mode === "solo" ? "Solo" : "Collaborative"} · {event.status}
                </span>
                {prefs.system_does_everything && (
                  <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700">
                    ✨ Let the system do everything
                  </span>
                )}
              </div>
              <h1 className="mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl">
                {event.title}
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                {contributorCount} contributor{contributorCount === 1 ? "" : "s"} ·{" "}
                {clips.length} clip{clips.length === 1 ? "" : "s"} in the pool
              </p>
            </div>
            <div className="rounded-2xl bg-gray-50 px-4 py-3 text-sm">
              <span className="text-xs font-semibold uppercase tracking-widest text-gray-400">
                Share code
              </span>
              <div className="mt-0.5 font-mono text-lg font-bold tracking-widest text-fuchsia-600">
                {shareCode}
              </div>
            </div>
          </div>

          {typeof prefs.story_mood === "string" && (
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-600">
              <span className="rounded-full bg-gray-100 px-3 py-1">
                Mood: {MOOD_LABEL[prefs.story_mood as string] ?? prefs.story_mood}
              </span>
              {typeof prefs.filter === "string" && prefs.filter !== "none" && (
                <span className="rounded-full bg-gray-100 px-3 py-1 capitalize">
                  Filter: {prefs.filter}
                </span>
              )}
              {prefs.music_on && <span className="rounded-full bg-gray-100 px-3 py-1">♪ Music</span>}
              {prefs.subtitles_on && (
                <span className="rounded-full bg-gray-100 px-3 py-1">Subtitles</span>
              )}
              {prefs.stickers_on && (
                <span className="rounded-full bg-gray-100 px-3 py-1">Stickers</span>
              )}
              {prefs.border_on && (
                <span className="rounded-full bg-gray-100 px-3 py-1">Border</span>
              )}
            </div>
          )}

          <div className="mt-5 rounded-2xl border-2 border-dashed border-fuchsia-300 bg-fuchsia-50/50 p-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-fuchsia-600">
              Central share link — drop your clips here
            </div>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800"
              />
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(shareUrl)}
                className="shrink-0 rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-fuchsia-700"
              >
                Copy
              </button>
            </div>
          </div>
        </div>

        {/* Join / upload */}
        <div className="mt-6 grid gap-6 lg:grid-cols-5">
          <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-3">
            <h2 className="text-lg font-bold">Add your clips</h2>
            <p className="mt-1 text-sm text-gray-500">
              No account needed. Drop in your videos and photos — Vantage lines them all up.
            </p>
            <form onSubmit={handleJoin} className="mt-4">
              <label className="block text-sm font-semibold text-gray-900">Your name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Optional — e.g. Alex"
                className="mt-1.5 w-full rounded-xl border border-gray-300 px-4 py-2.5 text-gray-900 focus:border-fuchsia-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy}
                className="mt-2 rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Join event
              </button>
            </form>

            <form onSubmit={handleUpload} className="mt-5">
              <label className="block text-sm font-semibold text-gray-900">
                Add a clip to the pool
              </label>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="w-full flex-1 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-fuchsia-100 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-fuchsia-700 hover:file:bg-fuchsia-200"
                />
                <button
                  type="submit"
                  disabled={busy || !file}
                  className="shrink-0 rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-5 py-2.5 font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? "Uploading…" : "Upload clip"}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-gray-400">
                Real file upload — Vantage stores your video and analyzes its audio
                for automatic alignment.
              </p>
            </form>

            {note && (
              <div
                className={`mt-4 rounded-xl px-4 py-3 text-sm ${
                  note.kind === "ok"
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-red-50 text-red-700"
                }`}
              >
                {note.text}
              </div>
            )}
          </div>

          {/* Pool */}
          <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-2">
            <h2 className="text-lg font-bold">Clip pool ({clips.length})</h2>
            <div className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
              {clips.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-200 p-5 text-center text-sm text-gray-400">
                  No clips yet. Be the first to add one — or share the link so everyone can
                  chip in.
                </div>
              )}
              {clips.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-2.5"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-lg shadow-sm">
                    {MEDIA_ICON[c.media_type]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-gray-900">
                      {c.filename}
                    </div>
                    <div className="text-xs text-gray-500">
                      {c.uploader ?? "Guest"} · {fmtSize(c.size_bytes)} ·{" "}
                      {c.media_type}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Aligned multi-view playback — the visible proof of the sync engine. */}
        {clips.length > 0 && (
          <div className="mt-6">
            <AlignedPlayback clips={clips} eventId={event.id} />
          </div>
        )}
      </main>
    </div>
  );
}
