import { useMemo } from "react";
import type { Event, Clip, Theme } from "~/lib/vantage";
import type { SoloVideoSync, SoloVideoRenderInfo } from "~/lib/vantage";

const MOOD_LABEL: Record<string, string> = {
  serious: "Serious",
  playful: "Playful",
  formal: "Formal",
  educational: "Educational",
};
const FILTER_LABEL: Record<string, string> = {
  none: "Natural",
  warm: "Warm",
  cool: "Cool",
  vintage: "Vintage",
  bw: "Black & white",
  cinematic: "Cinematic",
};

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-fuchsia-200 bg-fuchsia-50 px-3 py-1 text-xs font-semibold text-fuchsia-700">
      {children}
    </span>
  );
}

/**
 * The SOLO "your finished video" result. This is the auto-composed private
 * preview/timeline of the user's OWN media (aligned video + photos on the
 * timeline) styled by their chosen theme/mood/filter/toggles, plus the
 * persisted composition that Phase 3's render pipeline will turn into the
 * exported MP4. There is deliberately no share code / no public link here:
 * solo is private to the uploader.
 */
export default function SoloResult({
  event,
  clips,
  themes,
  render,
  onMakeAnother,
  onRedo,
}: {
  event: Event;
  clips: Clip[];
  sync: SoloVideoSync;
  themes: Theme[];
  render?: SoloVideoRenderInfo;
  onMakeAnother: () => void;
  onRedo: () => void;
}) {
  const finishedUrl = render?.status === "done" ? render.url : null;
  const themeName =
    themes.find((t) => t.id === event.theme_id)?.display_name ?? null;
  const prefs = useMemo(
    () => (event.prefs ?? {}) as Record<string, unknown>,
    [event.prefs]
  );
  const system = prefs.system_does_everything === true;
  const mood = String(prefs.story_mood ?? "").toLowerCase();
  const filter = String(prefs.filter ?? "none").toLowerCase();
  const subtitlesOn = prefs.subtitles_on === true;
  const musicOn = prefs.music_on === true;
  const stickersOn = prefs.stickers_on === true;
  const borderOn = prefs.border_on === true;

  const videos = useMemo(() => clips.filter((c) => c.media_type === "video"), [clips]);
  const photos = useMemo(() => clips.filter((c) => c.media_type === "photo"), [clips]);

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10">
      {/* Header */}
      <div className="text-center">
        <div className="text-5xl">✨</div>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-gray-900 sm:text-4xl">
          Your finished video
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-gray-600">
          Vantage auto-composed your {clips.length} upload{clips.length === 1 ? "" : "s"} into
          one styled video — no editing needed. It&apos;s private to you; there&apos;s no
          shared pool and no share link.
        </p>
      </div>

      {/* Back / Redo actions — two clear ways off the finished-video screen,
          no page reload required. */}
      <div className="mt-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-center">
          <button
            type="button"
            onClick={onMakeAnother}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-6 py-3.5 text-base font-bold text-white shadow-lg shadow-fuchsia-500/25 transition hover:opacity-90"
          >
            ← Back to start / Make another video
          </button>
          <button
            type="button"
            onClick={onRedo}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-6 py-3.5 text-base font-semibold text-gray-700 transition hover:border-fuchsia-300 hover:text-fuchsia-700"
          >
            🎨 Change style &amp; redo
          </button>
        </div>
        <p className="mt-2 text-center text-xs text-gray-400">
          Start a brand-new video, or redo this one with different choices — no reload, no getting stuck.
        </p>
      </div>

      {/* Style summary */}
      <div className="mt-8 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400">
          Your style
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {system ? (
            <>
              <Chip>✨ Vantage chose everything</Chip>
              <Chip>Auto theme + mood</Chip>
            </>
          ) : (
            <>
              {themeName && <Chip>🎨 {themeName}</Chip>}
              {MOOD_LABEL[mood] && <Chip>{MOOD_LABEL[mood]} mood</Chip>}
              <Chip>{FILTER_LABEL[filter] ?? filter} filter</Chip>
              <Chip>{subtitlesOn ? "Subtitles on" : "No subtitles"}</Chip>
              <Chip>{musicOn ? "Music on" : "No music"}</Chip>
              <Chip>{stickersOn ? "Stickers on" : "No stickers"}</Chip>
              <Chip>{borderOn ? "Border on" : "No border"}</Chip>
            </>
          )}
        </div>
        {themeName && (
          <p className="mt-3 text-xs text-gray-400">
            Styling (music track, captions, frames &amp; stickers matched to this theme) is
            applied when the video is rendered out — Phase 3 of the pipeline.
          </p>
        )}
      </div>

      {/* Finished video — the real rendered MP4 */}
      <div className="mt-8 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
        {finishedUrl ? (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">▶ Your finished video</h2>
              <a
                href={finishedUrl}
                download="vantage.mp4"
                className="rounded-full bg-fuchsia-600 px-4 py-1.5 text-xs font-bold text-white shadow transition hover:bg-fuchsia-700"
              >
                ⬇ Download
              </a>
            </div>
            <video
              key={finishedUrl}
              src={finishedUrl}
              controls
              autoPlay
              playsInline
              className="mt-4 aspect-video w-full rounded-xl bg-black object-contain"
              preload="auto"
            />
            <p className="mt-3 text-xs text-gray-400">
              Your {clips.length} upload{clips.length === 1 ? "" : "s"} baked into one
              playable video — Ken Burns motion, color filter, and sequential cut.
            </p>
          </>
        ) : render?.status === "error" ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4">
            <h2 className="text-base font-bold text-red-800">Your video couldn&apos;t be rendered</h2>
            <p className="mt-1 text-sm text-red-700">
              {render.error || "An error occurred while rendering. Please try again."}
            </p>
          </div>
        ) : render?.status === "pending" ? (
          <div className="flex items-center gap-4 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            <div>
              <h2 className="text-base font-bold text-amber-900">Your video is being rendered</h2>
              <p className="mt-0.5 text-sm text-amber-800">
                The finished MP4 is being baked in the background. Reload in a moment to see it.
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-500">
            This composition hasn&apos;t been rendered to a finished video yet.
          </div>
        )}
      </div>

      {/* Auto-composed preview */}
      <div className="mt-8 space-y-8">
        {videos.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-gray-900">Your video clips</h2>
            <p className="mt-1 text-sm text-gray-500">
              Your {videos.length} video{videos.length === 1 ? "" : "s"} are laid out
              one after another on your timeline, in the order you added them — no
              editing needed.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {videos.map((v, i) => (
                <div
                  key={v.id}
                  className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-50"
                >
                  <span className="px-3 pt-2 text-xs font-bold text-fuchsia-600">
                    Clip {i + 1} · {v.filename}
                  </span>
                  <video
                    src={`/${v.s3_or_storage_key}`}
                    controls
                    preload="metadata"
                    playsInline
                    className="mt-2 aspect-video w-full bg-black object-contain"
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Photos on the timeline */}
        {photos.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-gray-900">
              Your photos on the timeline ({photos.length})
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Each photo occupies a ~3s slot in your finished video, in upload order —
              rendered as a slideshow in the final export.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {photos.map((p) => (
                <div
                  key={p.id}
                  className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-50"
                >
                  <img
                    src={`/${p.s3_or_storage_key}`}
                    alt={p.filename}
                    onError={(e) => {
                      // Some phone photos (e.g. HEIC/HEIF from iPhones) can't be
                      // decoded by every browser — degrade to a labelled placeholder
                      // instead of a broken image, and never crash the result view.
                      const img = e.currentTarget;
                      img.style.background =
                        "linear-gradient(135deg,#e9d5ff,#818cf8)";
                      img.style.opacity = "0.9";
                      img.removeAttribute("src");
                      img.removeAttribute("srcset");
                    }}
                    className="aspect-square w-full bg-gray-900 object-cover"
                  />
                  <div className="truncate px-3 py-2 text-xs font-semibold text-gray-700">
                    {p.filename}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {videos.length === 0 && photos.length === 0 && (
          <p className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-500">
            Nothing to show yet.
          </p>
        )}
      </div>

      {/* Saved / render note */}
      <div className="mt-10 rounded-3xl border border-emerald-200 bg-emerald-50 p-6">
        <h2 className="text-base font-bold text-emerald-900">✓ Your finished video is saved</h2>
        <p className="mt-1.5 text-sm text-emerald-800">
          Your clips were baked into one playable video with directional motion and your
          chosen {finishedUrl ? "color filter" : "style"}. Reopen this private link anytime to
          watch it again — it&apos;s stored, not regenerated. (Music, subtitles, frames and
          stickers matched to a theme arrive with a licensed music library in a later phase.)
        </p>
        <p className="mt-3 text-xs text-emerald-700/80">
          🔒 Private &amp; solo — only you can open this via its private link. There is no
          event code and it never appears in the collaborative pool.
        </p>
      </div>
    </div>
  );
}
