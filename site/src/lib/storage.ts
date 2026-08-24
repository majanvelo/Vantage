/**
 * storage.ts — self-hosted file storage for uploaded clips.
 *
 * This phase keeps everything simple and local: no external object store. Real
 * video/photo bytes are written under `<site>/uploads/<eventId>/<clipId>.<ext>`,
 * and the clip row's `s3_or_storage_key` is set to the path relative to the site
 * root (e.g. `uploads/<eventId>/<clipId>.mp4`) so it can be:
 *   - resolved to an absolute path for ffmpeg feature extraction, and
 *   - served to the browser at `/uploads/...` (see serve.ts).
 *
 * The upload dir is created on demand. Only safe, filesystem-friendly names are
 * used (hex UUIDs), never user-supplied filenames, so path traversal is a
 * non-issue.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** The uploads directory relative to the site root. */
export const UPLOADS_DIR = "uploads";

/** Absolute path to the uploads directory (site root + uploads). */
export function uploadsRoot(): string {
  return path.join(process.cwd(), UPLOADS_DIR);
}

/**
 * Persist raw clip bytes to disk.
 * @returns the relative storage key (`uploads/<event>/<clip>.<ext>`).
 */
export async function saveUpload(
  eventId: string,
  clipId: string,
  ext: string,
  buffer: Buffer
): Promise<string> {
  const dir = path.join(uploadsRoot(), eventId);
  await mkdir(dir, { recursive: true });
  const fname = `${clipId}.${ext}`;
  const abs = path.join(dir, fname);
  await writeFile(abs, buffer);
  return `${UPLOADS_DIR}/${eventId}/${fname}`;
}

/** Resolve a stored relative storage key to an absolute file path. */
export function absolutePath(storageKey: string): string {
  // Guard against keys trying to escape the uploads dir.
  const safe = path
    .normalize(storageKey)
    .replace(/^([./\\])+/, "")
    .replace(/^(\.\.(\/|\\))+/, "");
  return path.join(process.cwd(), safe);
}

/** Extension for a filename (lowercased, no dot) or "bin" fallback. */
export function extFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot > 0 && dot < filename.length - 1) {
    return filename.slice(dot + 1).toLowerCase();
  }
  return "bin";
}

/** Map a content type to a safe file extension. */
export function extFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  const map: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "video/x-msvideo": "avi",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[ct.toLowerCase()] ?? null;
}
