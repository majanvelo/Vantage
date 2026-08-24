/**
 * service.ts — server-side orchestration: extract & cache audio features for a
 * clip, then run the global alignment for an event and persist it.
 *
 * This module is imported lazily by the server functions (dynamic import inside
 * a createServerFn handler) so the heavy node/ffmpeg deps it pulls in never leak
 * into the client bundle — the browser only ever fetches precomputed offsets.
 */

import { query } from "~/db";
import { absolutePath } from "~/lib/storage";
import { extractAudioFeatures } from "./features";
import {
  solveGlobalOffsets,
  type ClipInput,
} from "./align";

export interface ClipFeatures {
  values: number[];
  windowMs: number;
  durationMs: number;
}

export interface SyncEntry {
  clip_id: string;
  offset_ms: number;
  duration_ms: number;
  confidence: number;
  mean_residual_ms: number;
}

export interface SolveOutput {
  entries: SyncEntry[];
  dropped: string[];
  timeline_ms: number;
}

/** Load a clip's envelope, computing + caching it from the video if needed. */
export async function getClipFeatures(
  clipId: string,
  storageKey: string
): Promise<ClipFeatures | null> {
  const cached = await query<{ values: unknown; window_ms: number; duration_ms: number }>(
    `select values, window_ms, duration_ms from audio_features where clip_id = $1`,
    [clipId]
  );
  if (cached.length > 0 && Array.isArray(cached[0].values)) {
    return {
      values: (cached[0].values as number[]).map(Number),
      windowMs: cached[0].window_ms,
      durationMs: cached[0].duration_ms,
    };
  }

  // No cached features — decode the file now (this is the one-time cost; the
  // result is stored so "Sync now" stays cheap).
  let feats;
  try {
    feats = await extractAudioFeatures(absolutePath(storageKey));
  } catch {
    return null; // no decodable audio (e.g. a photo or a silent clip)
  }
  const values = feats.values.map((v) => Math.round(v * 1e4) / 1e4);
  try {
    await query(
      `insert into audio_features (clip_id, sample_rate, window_ms, duration_ms, values)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (clip_id) do update
         set sample_rate = excluded.sample_rate, window_ms = excluded.window_ms,
             duration_ms = excluded.duration_ms, values = excluded.values,
             computed_at = now()`,
      [
        clipId,
        feats.sampleRate,
        feats.windowMs,
        Math.round(feats.durationS * 1000),
        JSON.stringify(values),
      ]
    );
  } catch (e) {
    console.error("sync: failed to persist features", e);
  }
  return { values, windowMs: feats.windowMs, durationMs: Math.round(feats.durationS * 1000) };
}

/**
 * Align every video clip in an event to a shared timeline and persist the result.
 * Photo clips and clips with no audio are skipped (photos can't carry audio).
 */
export async function solveEventSync(eventId: string): Promise<SolveOutput> {
  const clips = await query<{ id: string; s3_or_storage_key: string | null }>(
    `select id, s3_or_storage_key from clips
      where event_id = $1 and media_type = 'video' and s3_or_storage_key is not null`,
    [eventId]
  );

  const inputs: ClipInput[] = [];
  const durationByClip: Record<string, number> = {};
  for (const c of clips) {
    if (!c.s3_or_storage_key) continue;
    const feats = await getClipFeatures(c.id, c.s3_or_storage_key);
    if (!feats) continue; // no audio → can't be aligned by audio
    inputs.push({ id: c.id, envelope: { values: feats.values, windowMs: feats.windowMs } });
    durationByClip[c.id] = feats.durationMs;
  }

  const empty: SolveOutput = { entries: [], dropped: clips.map((c) => c.id), timeline_ms: 0 };
  if (inputs.length < 2) {
    // Fewer than two audible clips can't be aligned to each other.
    await persist(eventId, empty);
    return empty;
  }

  const res = solveGlobalOffsets(inputs);
  const entries: SyncEntry[] = res.clips.map((c) => ({
    clip_id: c.id,
    offset_ms: Math.round(c.offsetMs),
    duration_ms: durationByClip[c.id] ?? c.durationMs,
    confidence: c.confidence,
    mean_residual_ms: c.meanResidualMs,
  }));

  const out: SolveOutput = { entries, dropped: res.dropped, timeline_ms: Math.round(res.timelineMs) };
  await persist(eventId, out);
  return out;
}

async function persist(eventId: string, out: SolveOutput): Promise<void> {
  await query(
    `insert into event_sync (event_id, offsets, timeline_ms)
     values ($1, $2::jsonb, $3)
     on conflict (event_id) do update
       set offsets = excluded.offsets, timeline_ms = excluded.timeline_ms,
           computed_at = now()`,
    [eventId, JSON.stringify({ dropped: out.dropped }), out.timeline_ms]
  );
  // entries stored separately (cleaner than nesting in the same jsonb)
  await query(
    `update event_sync set offsets = jsonb_set(offsets, '{entries}', $2::jsonb) where event_id = $1`,
    [eventId, JSON.stringify(out.entries)]
  );
}
