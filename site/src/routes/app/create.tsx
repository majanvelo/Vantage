import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createEvent, listThemes, type Theme } from "~/lib/vantage";

export const Route = createFileRoute("/app/create")({
  component: CreateEvent,
});

function VantageMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" className="fill-fuchsia-500" />
      <path d="M9 9.5v5l4.5-2.5L9 9.5Z" className="fill-white" />
      <circle cx="12" cy="12" r="2.4" className="fill-white/90" />
    </svg>
  );
}

const MOODS = ["serious", "playful", "formal", "educational"];
const FILTERS = ["none", "warm", "cool", "vintage", "bw", "cinematic"];

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

function CreateEvent() {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"solo" | "collaborative">("collaborative");
  const [themeId, setThemeId] = useState("");
  const [systemDoesEverything, setSystemDoesEverything] = useState(false);
  const [mood, setMood] = useState("playful");
  const [filter, setFilter] = useState("none");
  const [subtitles, setSubtitles] = useState(true);
  const [stickers, setStickers] = useState(false);
  const [border, setBorder] = useState(false);
  const [music, setMusic] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ code: string; id: string } | null>(null);

  useEffect(() => {
    listThemes()
      .then((t) => setThemes(t))
      .catch(() => setThemes([]));
  }, []);

  const prefs = {
    story_mood: mood,
    filter,
    subtitles_on: subtitles,
    stickers_on: stickers,
    border_on: border,
    music_on: music,
    system_does_everything: systemDoesEverything,
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await createEvent({
        data: {
          title,
          mode,
          theme_id: themeId || undefined,
          prefs: systemDoesEverything ? { system_does_everything: true } : prefs,
        },
      });
      if (!res.ok) {
        setError(res.message);
      } else {
        setCreated({ code: res.event.share_code, id: res.event.id });
      }
    } catch (err) {
      console.error(err);
      setError("Something went wrong creating the event. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const share = `${origin}/e/${created.code}`;
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-fuchsia-50 via-white to-indigo-50 p-6">
        <div className="w-full max-w-lg rounded-3xl border border-gray-200 bg-white p-8 shadow-xl">
          <div className="flex items-center gap-2 text-lg font-bold">
            <VantageMark className="h-7 w-7" /> Vantage
          </div>
          <div className="mt-6 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl">
              🎉
            </div>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Event created</h1>
            <p className="mt-2 text-gray-600">
              Share this link — everyone at the event opens it and drops in their clips. No
              account needed.
            </p>
          </div>

          <div className="mt-6 rounded-2xl border-2 border-dashed border-fuchsia-300 bg-fuchsia-50/50 p-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-fuchsia-600">
              Your central share link
            </div>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={share}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800"
              />
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(share)}
                className="shrink-0 rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-fuchsia-700"
              >
                Copy
              </button>
            </div>
            <div className="mt-3 text-center text-sm text-gray-500">
              or share the code <span className="font-mono font-bold">{created.code}</span>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-2">
            <a
              href={`/event/${created.id}`}
              className="w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 py-3 text-center font-semibold text-white transition hover:opacity-90"
            >
              Open my event
            </a>
            <a
              href="/app/create"
              className="w-full rounded-xl border border-gray-300 py-3 text-center font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Create another
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-gradient-to-br from-fuchsia-50 via-white to-indigo-50">
      <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/80 backdrop-blur">
        <nav className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <a href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <VantageMark className="h-7 w-7" /> Vantage
          </a>
          <a
            href="/"
            className="rounded-full border border-gray-300 px-4 py-1.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
          >
            Home
          </a>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 py-10">
        <div className="text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-fuchsia-100 px-3 py-1 text-xs font-semibold text-fuchsia-700">
            Start a new event
          </span>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">
            Upload once. Get a finished video.
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-gray-600">
            Create an event, share one link, and let everyone drop in their clips. Vantage
            handles the rest — no editing, no timeline.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="mt-10 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8"
        >
          {/* Title */}
          <label className="block">
            <span className="text-sm font-semibold text-gray-900">Event title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Mia & Jordan's wedding"
              className="mt-1.5 w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 focus:border-fuchsia-500 focus:outline-none"
            />
          </label>

          {/* Mode */}
          <div className="mt-6">
            <span className="text-sm font-semibold text-gray-900">Mode</span>
            <div className="mt-1.5 grid grid-cols-2 gap-3">
              {(
                [
                  ["collaborative", "🎉", "Everyone contributes to one shared pool"],
                  ["solo", "🎬", "Just my own photos & videos"],
                ] as const
              ).map(([m, icon, desc]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-xl border p-4 text-left transition ${
                    mode === m
                      ? "border-fuchsia-500 bg-fuchsia-50 ring-1 ring-fuchsia-500"
                      : "border-gray-200 hover:border-fuchsia-200"
                  }`}
                >
                  <div className="text-xl">{icon}</div>
                  <div className="mt-1 text-sm font-bold capitalize text-gray-900">{m}</div>
                  <div className="mt-0.5 text-xs text-gray-500">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Theme */}
          <div className="mt-6">
            <span className="text-sm font-semibold text-gray-900">Theme</span>
            <span className="ml-2 text-xs text-gray-400">(optional — or let Vantage pick)</span>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setThemeId("")}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  themeId === ""
                    ? "bg-gray-900 text-white"
                    : "border border-gray-300 text-gray-700 hover:border-gray-400"
                }`}
              >
                None
              </button>
              {themes.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setThemeId(t.id)}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    themeId === t.id
                      ? "bg-fuchsia-600 text-white"
                      : "border border-gray-300 text-gray-700 hover:border-fuchsia-300"
                  }${t.is_plus ? " ring-1 ring-inset ring-amber-300" : ""}`}
                  title={t.is_plus ? "Vantage Plus theme" : "Free theme"}
                >
                  {t.display_name}
                  {t.is_plus ? " ✨" : ""}
                </button>
              ))}
            </div>
          </div>

          {/* Include toggles / system does everything */}
          <div className="mt-6">
            <button
              type="button"
              onClick={() => setSystemDoesEverything(!systemDoesEverything)}
              className={`flex w-full items-center justify-between rounded-2xl p-4 text-left transition ${
                systemDoesEverything
                  ? "bg-gradient-to-r from-fuchsia-600 to-indigo-600 text-white ring-2 ring-fuchsia-400"
                  : "border-2 border-dashed border-fuchsia-300 bg-fuchsia-50/50 hover:border-fuchsia-400"
              }`}
            >
              <span>
                <span className="block text-base font-bold">
                  ✨ Let the system do everything
                </span>
                <span
                  className={`block text-sm ${
                    systemDoesEverything ? "text-white/80" : "text-gray-500"
                  }`}
                >
                  Vantage picks the theme, mood, filter, music and extras for you.
                </span>
              </span>
              <span
                className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${
                  systemDoesEverything ? "bg-white/80" : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    systemDoesEverything
                      ? "translate-x-5 bg-fuchsia-600"
                      : "translate-x-0"
                  }`}
                />
              </span>
            </button>
          </div>

          {!systemDoesEverything && (
            <div className="mt-5 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {/* Mood */}
                <div className="sm:col-span-1">
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
                {/* Filter */}
                <div className="sm:col-span-1">
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

              <Toggle
                label="Subtitles"
                hint="Auto-captions on the finished video"
                checked={subtitles}
                onChange={setSubtitles}
              />
              <Toggle
                label="Music"
                hint="Add a soundtrack matched to your theme"
                checked={music}
                onChange={setMusic}
              />
              <Toggle
                label="Stickers"
                hint="Playful stickers & emoji overlays"
                checked={stickers}
                onChange={setStickers}
              />
              <Toggle
                label="Border / frame"
                hint="A clean frame around the video"
                checked={border}
                onChange={setBorder}
              />
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-6 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 py-3.5 text-base font-bold text-white shadow-lg shadow-fuchsia-500/25 transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create event & get share link"}
          </button>
        </form>
      </main>
    </div>
  );
}
