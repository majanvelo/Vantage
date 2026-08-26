/**
 * uploadHandler.ts — streaming multipart file upload for the solo flow.
 *
 * The original upload path moved each file as a *base64 string inside a
 * JSON server-function payload* (`uploadClip` in vantage.ts). That works for
 * tiny synthetic clips but is fragile for real phone media: a 50–100 MB video
 * becomes a ~70–135 MB base64 JSON body that must be fully decoded in memory
 * and parsed by `request.json()` inside the server-function RPC — the exact
 * step that stalled/errored for the owner's real phone files while tiny clips
 * passed.
 *
 * This replaces that path for the solo flow with a standard `multipart/form-data`
 * POST. The browser streams the raw file bytes in the body; the server reads the
 * form, writes bytes straight to disk (`saveUpload`), records the clip row, and
 * (best-effort) precomputes audio features for videos. No base64 re-encoding, no
 * giant JSON string in memory. Photos (including HEIC/HEIF from iPhones) are
 * classified by mime and simply placed on the timeline.
 */
import { query } from "~/db";
import {
  saveUpload,
  extFromFilename,
  extFromContentType,
} from "~/lib/storage";

export type UploadOutcome = {
  ok: boolean;
  message?: string;
  clip?: {
    id: string;
    event_id: string;
    filename: string;
    content_type: string | null;
    size_bytes: string | null;
    media_type: "video" | "photo";
    s3_or_storage_key: string | null;
  };
  featuresOk?: boolean;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Handle a `multipart/form-data` upload request.
 */
export async function handleUploadRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ ok: false, message: "Method not allowed." }, 405);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    console.error("upload: form parse failed", e);
    return json({ ok: false, message: "Upload could not be read." });
  }

  const eventId = String(form.get("event_id") ?? "");
  const filename = String(form.get("filename") ?? "clip").slice(0, 255);
  const contentTypeRaw = form.get("content_type");
  const contentType =
    typeof contentTypeRaw === "string" && contentTypeRaw
      ? contentTypeRaw
      : null;
  const mediaType: "video" | "photo" =
    form.get("media_type") === "photo"
      ? "photo"
      : contentType && contentType.toLowerCase().startsWith("image/")
        ? "photo"
        : "video";

  if (!eventId) return json({ ok: false, message: "Missing event id." });

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ ok: false, message: "No file data received." });
  }

  // Verify the event exists (solo events are private by UUID — same check the
  // base64 path performed).
  const evs = await query<{ id: string }>(`select id from events where id = $1`, [
    eventId,
  ]);
  if (evs.length === 0) return json({ ok: false, message: "Event not found." });

  // Read raw bytes (Bun streams multipart into a File; buffer it for write).
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) return json({ ok: false, message: "Uploaded file is empty." });

  const clipId = (crypto as unknown as Crypto).randomUUID();
  const ext =
    extFromContentType(contentType) ??
    (filename !== "clip" ? extFromFilename(filename) : "bin");
  const s3_or_storage_key = await saveUpload(eventId, clipId, ext, buffer);

  const rows = await query<{
    id: string;
    event_id: string;
    filename: string;
    content_type: string | null;
    size_bytes: string | null;
    media_type: "video" | "photo";
    s3_or_storage_key: string | null;
  }>(
    `insert into clips
       (id, event_id, uploader, filename, content_type, size_bytes, media_type, s3_or_storage_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, event_id, filename, content_type, size_bytes::text as size_bytes,
               media_type, s3_or_storage_key`,
    [
      clipId,
      eventId,
      "You",
      filename,
      contentType,
      buffer.length,
      mediaType,
      s3_or_storage_key,
    ]
  );
  const clip = rows[0];

  // Best-effort: precompute + cache audio features so alignment is instant and
  // a silent/no-audio clip (or photo) never crashes the pipeline.
  let featuresOk = false;
  if (mediaType === "video") {
    try {
      const { getClipFeatures } = await import("./sync/service");
      const feats = await getClipFeatures(clipId, s3_or_storage_key);
      featuresOk = feats !== null;
    } catch (e) {
      console.error("upload: feature extraction failed", e);
    }
  }
  return json({ ok: true, clip, featuresOk });
}
