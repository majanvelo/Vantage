import { createServerFn } from "@tanstack/react-start";
import { ensureSchema, query } from "~/db";

/**
 * Phase-1 server functions for the Vantage event + upload + join flow.
 * Everything is metadata-first: an event, who joined, and the clip pool.
 * (Audio-sync, auto-cut and render are explicitly out of scope this slice.)
 */

export type Theme = {
  id: string;
  slug: string;
  display_name: string;
  is_plus: boolean;
};

export type Event = {
  id: string;
  title: string;
  mode: "solo" | "collaborative";
  status: string;
  theme_id: string | null;
  prefs: Record<string, unknown>;
  owner: string | null;
  share_code: string;
  created_at: string;
};

export type Member = { event_id: string; user_id: string; role: string };

export type Clip = {
  id: string;
  event_id: string;
  uploader: string | null;
  filename: string;
  content_type: string | null;
  size_bytes: string | null;
  media_type: "video" | "photo";
  captured_at: string | null;
  s3_or_storage_key: string | null;
  created_at: string;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeShareCode(length = 8): string {
  let code = "";
  const rand = new Uint32Array(length);
  if (typeof crypto !== "undefined" && crypto?.getRandomValues) {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < length; i++) rand[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[rand[i] % CODE_ALPHABET.length];
  }
  return code;
}

const error = (message: string) => ({ ok: false as const, message });

// ---------------------------------------------------------------------------
// Public GET: theme catalog (used to render the create-event picker).
// ---------------------------------------------------------------------------
export const listThemes = createServerFn({ method: "GET" }).handler(
  async (): Promise<Theme[]> => {
    await ensureSchema();
    const rows = await query<Theme>(
      `select id, slug, display_name, is_plus from themes order by sort_order, display_name`
    );
    return rows;
  }
);

// ---------------------------------------------------------------------------
// POST /api/events  → create an event, return it + its central share code.
// ---------------------------------------------------------------------------
export const createEvent = createServerFn({ method: "POST" }).handler(
  async ({
    data,
  }: {
    data: {
      title?: unknown;
      mode?: unknown;
      theme_id?: unknown;
      prefs?: unknown;
    };
  }) => {
    await ensureSchema();

    const title = typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "Untitled event";
    const mode = data?.mode === "solo" ? "solo" : "collaborative";
    const themeId = typeof data?.theme_id === "string" && data.theme_id ? data.theme_id : null;
    const prefs = data?.prefs && typeof data.prefs === "object" ? data.prefs : {};
    const owner = "owner";

    // Ensure the chosen theme actually exists in the catalog (light membership check).
    if (themeId) {
      const t = await query(`select 1 from themes where id = $1`, [themeId]);
      if (t.length === 0) return error("Unknown theme.");
    }

    // Find a fresh, unused share code.
    let shareCode = makeShareCode();
    for (let i = 0; i < 5; i++) {
      const existing = await query(`select 1 from events where share_code = $1`, [shareCode]);
      if (existing.length === 0) break;
      shareCode = makeShareCode();
    }

    const rows = await query<Event>(
      `insert into events (title, mode, theme_id, prefs, owner, share_code)
       values ($1, $2, $3, $4::jsonb, $5, $6)
       returning id, title, mode, status, theme_id, prefs, owner, share_code, created_at`,
      [title, mode, themeId, JSON.stringify(prefs), owner, shareCode]
    );
    const ev = rows[0];

    await query(
      `insert into event_members (event_id, user_id, role) values ($1, $2, 'owner') on conflict do nothing`,
      [ev.id, owner]
    );

    return { ok: true as const, event: ev };
  }
);

// ---------------------------------------------------------------------------
// GET /api/events/:id  → event detail + membership + clip pool.
// ---------------------------------------------------------------------------
export const getEvent = createServerFn({ method: "GET" }).handler(
  async ({ data }: { data: { id?: unknown } }) => {
    await ensureSchema();
    const id = typeof data?.id === "string" ? data.id : "";
    if (!id) return error("Missing event id.");
    const rows = await query<Event>(
      `select id, title, mode, status, theme_id, prefs, owner, share_code, created_at
         from events where id = $1`,
      [id]
    );
    if (rows.length === 0) return error("Event not found.");
    const ev = rows[0];
    const [members, clips] = await Promise.all([
      query<Member>(`select event_id, user_id, role from event_members where event_id = $1`, [id]),
      query<Clip>(
        `select id, event_id, uploader, filename, content_type, size_bytes::text as size_bytes,
                media_type, captured_at, s3_or_storage_key, created_at
           from clips where event_id = $1 order by created_at`,
        [id]
      ),
    ]);
    return { ok: true as const, event: ev, members, clips };
  }
);

// ---------------------------------------------------------------------------
// GET a SOLO video by its private id (no share code, mode = 'solo' only).
// Solo is the private single-user flow: the event id is a UUID and is never
// exposed on any share path. If the id doesn't belong to a solo event it is
// treated as not found, so solo compositions can never be reached through the
// collaborative /e/:code route (which is also filtered to mode='collaborative').
// ---------------------------------------------------------------------------
export type SoloVideoSync = {
  entries: SyncEntryDto[];
  dropped: string[];
  timelineMs: number;
};
export type SoloVideoRenderInfo = {
  status: "none" | "pending" | "done" | "error";
  url?: string; // /uploads/<eventId>/finished.mp4
  error?: string;
};
export type SoloVideoResult = {
  ok: boolean;
  message?: string;
  event?: Event;
  clips?: Clip[];
  sync?: SoloVideoSync;
  render?: SoloVideoRenderInfo;
};
export const getSoloVideo = createServerFn({ method: "GET" }).handler(
  async ({ data }: { data: { id?: unknown } }): Promise<SoloVideoResult> => {
    await ensureSchema();
    const id = typeof data?.id === "string" ? data.id : "";
    if (!id) return { ok: false as const, message: "Missing video id." };
    const rows = await query<Event>(
      `select id, title, mode, status, theme_id, prefs, owner, share_code, created_at
         from events where id = $1 and mode = 'solo'`,
      [id]
    );
    if (rows.length === 0) return { ok: false as const, message: "Solo video not found." };
    const ev = rows[0];
    const clips = await query<Clip>(
      `select id, event_id, uploader, filename, content_type, size_bytes::text as size_bytes,
              media_type, captured_at, s3_or_storage_key, created_at
         from clips where event_id = $1 order by created_at`,
      [id]
    );
    let sync: SoloVideoSync = { entries: [], dropped: [], timelineMs: 0 };
    const srows = await query<{ offsets: unknown; timeline_ms: number }>(
      `select offsets, timeline_ms from event_sync where event_id = $1`,
      [id]
    );
    if (srows.length) {
      const o = (srows[0].offsets ?? {}) as { entries?: SyncEntryDto[]; dropped?: string[] };
      sync = {
        entries: o.entries ?? [],
        dropped: o.dropped ?? [],
        timelineMs: srows[0].timeline_ms ?? 0,
      };
    }

    // Finished-render info: durable marker in the `renders` table (takes
    // precedence), plus any in-flight progress for a render in this process.
    let render: SoloVideoRenderInfo = { status: "none" };
    const rrows = await query<{ status: string; finished_key: string | null; error: string | null }>(
      `select status, finished_key, error from renders where event_id = $1`,
      [id]
    );
    if (rrows.length > 0) {
      const r = rrows[0];
      if (r.status === "done" && r.finished_key) {
        render = { status: "done", url: `/${r.finished_key}` };
      } else if (r.status === "error") {
        render = { status: "error", error: r.error ?? undefined };
      } else {
        render = { status: "pending" };
      }
    }
    // If a render is mid-flight in this process, reflect that as pending.
    const { getRenderProgress } = await import("./render");
    const inflight = getRenderProgress(id);
    if (inflight && render.status !== "done") {
      render = render.status === "error"
        ? render
        : { status: inflight.done ? render.status : "pending" };
    }

    return { ok: true as const, event: ev, clips, sync, render };
  }
);

// ---------------------------------------------------------------------------
// GET by central share code (the "open the link" path). Returns the event +
// pool so a visitor can drop clips with zero account.
// ---------------------------------------------------------------------------
export const getEventByCode = createServerFn({ method: "GET" }).handler(
  async ({ data }: { data: { code?: unknown } }) => {
    await ensureSchema();
    const code = typeof data?.code === "string" ? data.code.trim().toUpperCase() : "";
    if (!code) return error("Missing share code.");
    const rows = await query<Event>(
      `select id, title, mode, status, theme_id, prefs, owner, share_code, created_at
         from events where share_code = $1 and mode = 'collaborative'`,
      [code]
    );
    if (rows.length === 0) return error("That link isn't valid — no event found for it.");
    const ev = rows[0];
    const [members, clips] = await Promise.all([
      query<Member>(`select event_id, user_id, role from event_members where event_id = $1`, [ev.id]),
      query<Clip>(
        `select id, event_id, uploader, filename, content_type, size_bytes::text as size_bytes,
                media_type, captured_at, s3_or_storage_key, created_at
           from clips where event_id = $1 order by created_at`,
        [ev.id]
      ),
    ]);
    return { ok: true as const, event: ev, members, clips };
  }
);

// ---------------------------------------------------------------------------
// POST /api/events/:id/members  → join via share link (no account).
// ---------------------------------------------------------------------------
export const joinEvent = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data: { code?: unknown; name?: unknown } }) => {
    await ensureSchema();
    const code = typeof data?.code === "string" ? data.code.trim().toUpperCase() : "";
    if (!code) return error("Missing share code.");
    const evs = await query<Event>(
      `select id, title, mode, theme_id from events where share_code = $1 and mode = 'collaborative'`,
      [code]
    );
    if (evs.length === 0) return error("That link isn't valid — no event found for it.");
    const ev = evs[0];
    const name =
      typeof data?.name === "string" && data.name.trim()
        ? data.name.trim().slice(0, 60)
        : `Guest-${makeShareCode(5)}`;
    await query(
      `insert into event_members (event_id, user_id, role) values ($1, $2, 'member')
       on conflict (user_id, event_id) do nothing`,
      [ev.id, name]
    );
    return { ok: true as const, event: { id: ev.id, title: ev.title }, member: name };
  }
);

// ---------------------------------------------------------------------------
// POST /api/events/:id/clips  → record an uploaded clip (metadata-first).
// ---------------------------------------------------------------------------
export const addClip = createServerFn({ method: "POST" }).handler(
  async ({
    data,
  }: {
    data: {
      event_id?: unknown;
      uploader?: unknown;
      filename?: unknown;
      content_type?: unknown;
      size_bytes?: unknown;
      media_type?: unknown;
      captured_at?: unknown;
      storage_key?: unknown;
    };
  }) => {
    await ensureSchema();
    const eventId = typeof data?.event_id === "string" ? data.event_id : "";
    if (!eventId) return error("Missing event id.");
    const evs = await query(`select id from events where id = $1`, [eventId]);
    if (evs.length === 0) return error("Event not found.");

    const filename =
      typeof data?.filename === "string" && data.filename.trim() ? data.filename.trim() : "clip";
    const contentType = typeof data?.content_type === "string" ? data.content_type : null;
    const sizeBytes =
      typeof data?.size_bytes === "number" && Number.isFinite(data.size_bytes)
        ? Math.max(0, Math.round(data.size_bytes))
        : null;
    const uploader = typeof data?.uploader === "string" && data.uploader ? data.uploader : null;
    const mediaType: "video" | "photo" =
      data?.media_type === "photo"
        ? "photo"
        : data?.media_type === "video"
          ? "video"
          : contentType && contentType.startsWith("video/")
            ? "video"
            : contentType && contentType.startsWith("image/")
              ? "photo"
              : "video";
    const capturedAt =
      typeof data?.captured_at === "string" && data.captured_at ? data.captured_at : null;
    const storageKey = typeof data?.storage_key === "string" ? data.storage_key : null;

    const rows = await query<Clip>(
      `insert into clips (event_id, uploader, filename, content_type, size_bytes, media_type, captured_at, s3_or_storage_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, event_id, uploader, filename, content_type, size_bytes::text as size_bytes,
                 media_type, captured_at, s3_or_storage_key, created_at`,
      [eventId, uploader, filename, contentType, sizeBytes, mediaType, capturedAt, storageKey]
    );
    return { ok: true as const, clip: rows[0] };
  }
);

// ---------------------------------------------------------------------------
// POST /api/events/:id/clips/upload  → REAL file upload: materialise actual byte
// bytes to disk, persist a clip row pointing at them, and (best-effort) extract
// + cache audio features for later alignment.
//
// The file arrives base64-encoded in the server-function payload (simplest way to
// move binary through the JSON RPC without an extra multipart route). The server
// decodes it, writes it under uploads/<event>/<clipId>.<ext>, and stores the path
// in s3_or_storage_key. No external object store — fully self-hosted.
// ---------------------------------------------------------------------------
export type UploadResult = {
  ok: boolean;
  message?: string;
  clip?: Clip;
  featuresOk?: boolean;
};

export const uploadClip = createServerFn({ method: "POST" }).handler(
  async ({
    data,
  }: {
    data: {
      event_id?: unknown;
      uploader?: unknown;
      filename?: unknown;
      content_type?: unknown;
      media_type?: unknown;
      data_base64?: unknown;
    };
  }): Promise<UploadResult> => {
    await ensureSchema();
    const eventId = typeof data?.event_id === "string" ? data.event_id : "";
    if (!eventId) return error("Missing event id.");
    const evs = await query(`select id from events where id = $1`, [eventId]);
    if (evs.length === 0) return error("Event not found.");

    const filename =
      typeof data?.filename === "string" && data.filename.trim() ? data.filename.trim() : "clip";
    const contentType = typeof data?.content_type === "string" ? data.content_type : null;
    const uploader = typeof data?.uploader === "string" && data.uploader ? data.uploader : null;
    const mediaType: "video" | "photo" =
      data?.media_type === "photo"
        ? "photo"
        : data?.media_type === "video"
          ? "video"
          : contentType && contentType.startsWith("video/")
            ? "video"
            : contentType && contentType.startsWith("image/")
              ? "photo"
              : "video";

    const b64 = typeof data?.data_base64 === "string" ? data.data_base64 : "";
    if (!b64) return error("No file data received.");

    // Base64 decode → real bytes.
    let buffer: Buffer;
    try {
      buffer = Buffer.from(b64, "base64");
    } catch {
      return error("File data could not be decoded.");
    }
    if (buffer.length === 0) return error("Uploaded file is empty.");

    // Pure helper modules pulled in lazily so node/ffmpeg deps stay server-only.
    const { saveUpload, extFromFilename, extFromContentType } = await import("./storage");
    const { getClipFeatures } = await import("./sync/service");

    const clipId = (crypto as unknown as Crypto).randomUUID();
    const ext =
      extFromContentType(contentType) ??
      (filename !== "clip" ? extFromFilename(filename) : "bin");
    const storageKey = await saveUpload(eventId, clipId, ext, buffer);

    const rows = await query<Clip>(
      `insert into clips (id, event_id, uploader, filename, content_type, size_bytes, media_type, captured_at, s3_or_storage_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, event_id, uploader, filename, content_type, size_bytes::text as size_bytes,
                 media_type, captured_at, s3_or_storage_key, created_at`,
      [
        clipId,
        eventId,
        uploader,
        filename,
        contentType,
        buffer.length,
        mediaType,
        null,
        storageKey,
      ]
    );

    // Best-effort: precompute + cache audio features so "Sync now" is instant.
    let featuresOk = false;
    if (mediaType === "video") {
      try {
        const feats = await getClipFeatures(clipId, storageKey);
        featuresOk = feats !== null;
      } catch (e) {
        console.error("sync: feature extraction failed at upload", e);
      }
    }
    return { ok: true as const, clip: rows[0], featuresOk };
  }
);

// ---------------------------------------------------------------------------
// POST /api/events/:id/sync  → run the alignment and return the solved offsets.
// Heavy work happens server-side (ffmpeg feature extraction is cached); the page
// just POSTs and renders the returned offsets. Idempotent.
// ---------------------------------------------------------------------------
export type SyncEntryDto = {
  clip_id: string;
  offset_ms: number;
  duration_ms: number;
  confidence: number;
  mean_residual_ms: number;
};
export type SyncResult = {
  ok: boolean;
  message?: string;
  entries?: SyncEntryDto[];
  dropped?: string[];
  timeline_ms?: number;
};

export const runSync = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data: { event_id?: unknown } }): Promise<SyncResult> => {
    await ensureSchema();
    const eventId = typeof data?.event_id === "string" ? data.event_id : "";
    if (!eventId) return error("Missing event id.");
    const { solveEventSync } = await import("./sync/service");
    try {
      const out = await solveEventSync(eventId);
      return {
        ok: true as const,
        entries: out.entries,
        dropped: out.dropped,
        timeline_ms: out.timeline_ms,
      };
    } catch (e) {
      console.error("sync: runSync failed", e);
      return { ok: false as const, message: "Alignment failed — please retry." };
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/events/solo/compose  → lay a SOLO event's own clips out in upload
// order with NO audio alignment. Solo is one user's media in a sequence, so
// there is nothing to align; this always produces a successful composition
// (never an alignment-failed / dropped solve). Collaborative events keep true
// audio alignment via `runSync`.
// ---------------------------------------------------------------------------
export const composeSolo = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data: { event_id?: unknown } }): Promise<SyncResult> => {
    await ensureSchema();
    const eventId = typeof data?.event_id === "string" ? data.event_id : "";
    if (!eventId) return error("Missing event id.");
    // Only solo events are composed this way.
    const evs = await query(`select id from events where id = $1 and mode = 'solo'`, [eventId]);
    if (evs.length === 0) return error("Solo video not found.");
    const { composeSoloSync } = await import("./sync/service");
    try {
      const out = await composeSoloSync(eventId);
      return {
        ok: true as const,
        entries: out.entries,
        dropped: out.dropped,
        timeline_ms: out.timeline_ms,
      };
    } catch (e) {
      console.error("sync: solo compose failed", e);
      return { ok: false as const, message: "Something went wrong composing your video." };
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/events/solo/render  → START the real ffmpeg render that bakes a
// solo event's media into ONE playable finished MP4, then return immediately.
// The heavy render runs in the background in this same process; the client polls
// GET /api/solo/render-status (via serve.ts) for live stage/% so the progress
// bar never freezes on a silent awaited call. Idempotent: an already-rendered
// event returns the existing file without re-rendering.
// ---------------------------------------------------------------------------
export type StartRenderResult = { ok: boolean; message?: string };
export const startSoloRender = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data: { event_id?: unknown } }): Promise<StartRenderResult> => {
    await ensureSchema();
    const eventId = typeof data?.event_id === "string" ? data.event_id : "";
    if (!eventId) return error("Missing event id.");
    const evs = await query(`select id from events where id = $1 and mode = 'solo'`, [eventId]);
    if (evs.length === 0) return error("Solo video not found.");
    const { renderSoloVideo } = await import("./render");
    // Fire-and-forget: the render continues in the background; progress is read
    // via the status endpoint. We do NOT await the heavy work here.
    void renderSoloVideo(eventId);
    return { ok: true as const };
  }
);

// ---------------------------------------------------------------------------
// GET /api/events/:id/sync  → return the stored alignment (no heavy work). The
// page uses this to load existing offsets without re-solving.
// ---------------------------------------------------------------------------
export const getSync = createServerFn({ method: "GET" }).handler(
  async ({ data }: { data: { event_id?: unknown } }): Promise<SyncResult> => {
    await ensureSchema();
    const eventId = typeof data?.event_id === "string" ? data.event_id : "";
    if (!eventId) return error("Missing event id.");
    const rows = await query<{ offsets: unknown; timeline_ms: number }>(
      `select offsets, timeline_ms from event_sync where event_id = $1`,
      [eventId]
    );
    if (rows.length === 0) return { ok: true as const, entries: [], dropped: [], timeline_ms: 0 };
    const o = (rows[0].offsets ?? {}) as { entries?: SyncEntryDto[]; dropped?: string[] };
    return {
      ok: true as const,
      entries: o.entries ?? [],
      dropped: o.dropped ?? [],
      timeline_ms: rows[0].timeline_ms,
    };
  }
);
