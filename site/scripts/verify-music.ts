/**
 * verify-music.ts — repeatable evidence harness for the generated music bed.
 *
 * Run from the site dir:  bun scripts/verify-music.ts
 *
 * It does two things:
 *   1. Synthesizes each style's seamless loop and writes the WAVs plus a
 *      spectrogram PNG into /home/team/shared/music-evidence/.
 *   2. Builds a synthetic 6s film (3s clip WITH audio + 3s silent photo slide),
 *      runs the real finalizeSoloVideo post-pass with each style and with music
 *      OFF, then ffprobes every output.
 *
 * The printed tables are the non-drone proof (RMS + spectral centroid move) and
 * the no-silent-tail proof (audio duration == video duration).
 */
import { MUSIC_STYLES, loopSecondsFor, synthesizeMusicWav } from "~/lib/music";
import { finalizeSoloVideo } from "~/lib/render";
import { mkdir } from "node:fs/promises";

const EVIDENCE = "/home/team/shared/music-evidence";
const WORK = `${EVIDENCE}/_work`;
await mkdir(WORK, { recursive: true });

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  await p.exited;
  return out + err;
}

// ---------------------------------------------------------------- 1. loops ---
console.log("\n=== synthesized beds (seamless 4-chord loops) ===");
for (const style of MUSIC_STYLES) {
  const t0 = Date.now();
  await Bun.write(`${EVIDENCE}/${style}-bed.wav`, synthesizeMusicWav(style));
  const secs = (Date.now() - t0) / 1000;
  await sh([
    "ffmpeg", "-y", "-v", "error", "-i", `${EVIDENCE}/${style}-bed.wav`,
    "-lavfi", "showspectrumpic=s=1400x600:legend=1",
    `${EVIDENCE}/${style}-spectrogram.png`,
  ]);
  const vol = await sh([
    "ffmpeg", "-hide_banner", "-i", `${EVIDENCE}/${style}-bed.wav`,
    "-af", "volumedetect", "-f", "null", "-",
  ]);
  const mean = vol.match(/mean_volume: ([-\d.]+)/)?.[1];
  const max = vol.match(/max_volume: ([-\d.]+)/)?.[1];
  console.log(
    `${style.padEnd(7)} loop=${loopSecondsFor(style).toFixed(2)}s synth=${secs.toFixed(2)}s mean=${mean}dB max=${max}dB`
  );
}

// ------------------------------------------------- 2. movement per second ---
console.log("\n=== movement check: per-second RMS level + spectral centroid ===");
for (const style of MUSIC_STYLES) {
  const wav = `${EVIDENCE}/${style}-bed.wav`;
  const dur = Math.floor(Number((await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav])).trim()));
  const rms: number[] = [];
  const cen: number[] = [];
  for (let i = 0; i < dur; i++) {
    const a = await sh([
      "ffmpeg", "-hide_banner", "-ss", String(i), "-t", "1", "-i", wav,
      "-af", "astats", "-f", "null", "-",
    ]);
    rms.push(Number(a.match(/RMS level dB: ([-\d.]+)/)?.[1] ?? NaN));
    const c = await sh([
      "ffmpeg", "-hide_banner", "-ss", String(i), "-t", "1", "-i", wav,
      "-af", "aspectralstats=measure=centroid,ametadata=print:key=lavfi.aspectralstats.1.centroid:file=-",
      "-f", "null", "-",
    ]);
    cen.push(Number(c.match(/centroid=([\d.]+)/)?.[1] ?? NaN));
  }
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  console.log(
    `${style.padEnd(7)} RMS ${rms.map((v) => v.toFixed(1)).join(" ")}  (spread ${spread(rms).toFixed(1)}dB)`
  );
  console.log(
    `${"".padEnd(7)} centroid ${cen.map((v) => Math.round(v)).join(" ")} Hz (spread ${Math.round(spread(cen))}Hz)`
  );
}

// -------------------------------------------- 3. real finalize (length) ---
console.log("\n=== finished-video length check (silent-tail bug) ===");
await sh(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", `${WORK}/clip.mp4`]);
await sh(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=800x600", "-frames:v", "1", `${WORK}/photo.png`]);
await sh(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", "4", "-i", `${WORK}/photo.png`, "-vf", "scale=1280:720", "-r", "25", "-t", "3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", `${WORK}/slide.mp4`]);
await Bun.write(`${WORK}/list.txt`, `file '${WORK}/clip.mp4'\nfile '${WORK}/slide.mp4'\n`);
await sh(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", `${WORK}/list.txt`, "-c", "copy", `${WORK}/concat.mp4`]);

const cProbe = await sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", `${WORK}/concat.mp4`]);
console.log(`source film (concat) video duration: ${cProbe.trim()}s  [clip 3s + photo 3s]`);

for (const style of [...MUSIC_STYLES, null] as const) {
  const out = `${EVIDENCE}/finished-music-${style ?? "off"}.mp4`;
  const label = style ?? "off";
  try {
    await finalizeSoloVideo(`${WORK}/concat.mp4`, out, {
      borderOn: true,
      caption: "Hello Vantage",
      musicStyle: style,
      themeId: "travel",
    });
    const probe = await sh([
      "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,duration",
      "-show_entries", "format=duration", "-of", "default=nw=1", out,
    ]);
    const vol = await sh(["ffmpeg", "-hide_banner", "-i", out, "-af", "volumedetect", "-f", "null", "-"]);
    const mean = vol.match(/mean_volume: ([-\d.]+)/)?.[1] ?? "n/a";
    const max = vol.match(/max_volume: ([-\d.]+)/)?.[1] ?? "n/a";
    console.log(`\n--- music=${label} → ${out.split("/").pop()}`);
    console.log(probe.trim().split("\n").map((l) => "    " + l).join("\n"));
    console.log(`    mean_volume=${mean}dB max_volume=${max}dB`);
  } catch (e) {
    console.log(`\n--- music=${label} FAILED: ${e instanceof Error ? e.message.slice(0, 500) : e}`);
  }
}
