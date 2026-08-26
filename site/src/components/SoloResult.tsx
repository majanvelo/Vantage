import { useMemo } from "react";
import AlignedPlayback from "./AlignedPlayback";
import type { Event, Clip, Theme } from "~/lib/vantage";
import type { SoloVideoSync } from "~/lib/vantage";

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
  sync,
  themes,
}: {
  event: Event;
  clips: Clip[];
  sync: SoloVideoSync;
  themes: Theme[];
}) {
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
  const hasVideos = videos.length > 0;

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

      {/* Auto-composed preview */}
      <div className="mt-8 space-y-8">
        <section>
          <h2 className="text-lg font-bold text-gray-900">Auto-composed preview</h2>
          <p className="mt-1 text-sm text-gray-500">
            {hasVideos
              ? "Your videos are locked to one timeline below; photos are placed as slideshow slots after them."
              : "Everything below is your composition's timeline, shown private to you."}
          </p>
          {hasVideos ? (
            <div className="mt-4">
              <AlignedPlayback clips={videos} eventId={event.id} />
            </div>
          ) : (
            <p className="mt-4 rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-500">
              Add a video clip to get aligned playback here. Your photos still form the
              timeline below.
            </p>
          )}
        </section>

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
      </div>

      {/* Saved / render note */}
      <div className="mt-10 rounded-3xl border border-emerald-200 bg-emerald-50 p-6">
        <h2 className="text-base font-bold text-emerald-900">✓ Your video is being made</h2>
        <p className="mt-1.5 text-sm text-emerald-800">
          Your composition (uploads + theme/style) is saved. The preview above is your
          auto-composed result. When the render pipeline goes live, this exact composition
          is turned into the downloadable MP4 with your theme&apos;s music, subtitles,
          frames and stickers baked in.
        </p>
        <p className="mt-3 text-xs text-emerald-700/80">
          🔒 Private &amp; solo — only you can open this via its private link. There is no
          event code and it never appears in the collaborative pool.
        </p>
      </div>
    </div>
  );
}
