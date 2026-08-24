/**
 * features.ts — extracts a compact audio "loudness envelope" from a video file
 * using ffmpeg, so clip alignment never has to re-decode a video more than once.
 *
 * Pipeline (all server-side, via child_process):
 *   1. ffmpeg decodes the file's audio track, downmixes to mono, and resamples to
 *      a fixed low sample rate (default 8 kHz), emitting raw 16-bit little-endian
 *      PCM on stdout. We don't need tonal detail to align clips by *shared* sound —
 *      we need a robust, compact proxy for "what is audible when".
 *   2. We window that PCM into ~50 ms slices and compute the RMS (root mean
 *      square) amplitude of each slice. The result is a 1-D energy envelope over
 *      time: values[k] ≈ loudness in window k. Two clips that captured the same
 *      moment share the same loudness *pattern*, which is what the alignment step
 *      cross-correlates.
 *
 * The returned envelope is stored once (in the `audio_features` table), so
 * "Sync now" is idempotent and cheap.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AudioFeature {
  /** The resampled sample rate actually used to decode audio. */
  sampleRate: number;
  /** Window length in milliseconds each feature value summarises. */
  windowMs: number;
  /** RMS loudness envelope — one value per window, in order of time. */
  values: number[];
  /** Total audio duration in seconds. */
  durationS: number;
}

export interface ExtractOptions {
  /** Low-passed/resampled mono rate to decode at (Hz). */
  sampleRate?: number;
  /** Time window per feature value, in milliseconds. */
  windowMs?: number;
  /** Path to the ffmpeg binary (default "ffmpeg", from PATH). */
  ffmpegPath?: string;
}

const DEFAULT_SAMPLE_RATE = 8000;
const DEFAULT_WINDOW_MS = 50;

/**
 * Decode `filePath` to raw mono PCM and reduce it to an RMS envelope.
 *
 * @throws if ffmpeg is missing or the file has no decodable audio stream — the
 *         caller decides what to do with a photo / silent clip.
 */
export async function extractAudioFeatures(
  filePath: string,
  opts: ExtractOptions = {}
): Promise<AudioFeature> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";

  const { stdout } = await execFileAsync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      "-i", filePath,
      "-vn", // drop the video stream — we only want audio
      "-ac", "1", // downmix to mono
      "-ar", String(sampleRate), // resample to a low fixed rate
      "-f", "s16le", // raw little-endian 16-bit PCM out
      "-acodec", "pcm_s16le",
      "pipe:1", // to stdout
    ],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }
  );

  // Buffer of 16-bit signed little-endian samples.
  const pcm = new Int16Array(
    stdout.buffer,
    stdout.byteOffset,
    stdout.byteLength >> 1
  );

  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const nWindows = Math.max(1, Math.ceil(pcm.length / win));
  const values: number[] = new Array(nWindows);

  for (let w = 0; w < nWindows; w++) {
    const start = w * win;
    const end = Math.min(pcm.length, start + win);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = pcm[i];
      sumSq += s * s;
    }
    // RMS over the window; normalise fraction so short windows still compare well.
    values[w] = Math.sqrt(sumSq / (end - start));
  }

  return {
    sampleRate,
    windowMs,
    values,
    durationS: pcm.length / sampleRate,
  };
}
