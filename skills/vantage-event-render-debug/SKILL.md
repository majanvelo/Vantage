---
name: vantage-event-render-debug
description: "Debug and verify the Vantage collaborative event render (renderEventVideo / 'Make movie'): diagnose 'No shots could be rendered', drive the UI button, and prove the switcher with SSIM."
---

# Debug + verify the Vantage event render (`renderEventVideo`)

Use this when a collaborative event's "Make movie" fails, produces a wrong-length film, or when you
must prove the auto-switcher (not just that a file appeared).

## 0. The two silent-skip points (read these first)
`site/src/lib/render.ts`, the shot loop: a shot is dropped with **no error** when
1. `clipById.get(shot.clip_id)` misses (id mismatch), or
2. `durMs = sourceEnd - sourceStart < MIN_SHOT_MS (100)`.
Every shot dropped ⇒ `throw new Error("No shots could be rendered for this event.")`.
Both points now log why (clip_id, timeline window, clip offset/duration, resolved source window, durMs);
the step-6 preamble logs the director's clips/timeline/slices/shots/gaps. Read those lines before guessing.

## 1. Root cause found 2026-08-24 (the trap that produced it)
**Units.** `ffprobeVideoDuration()` in render.ts returns ffprobe's own **SECONDS**; the sync entry's
`duration_ms` is **MILLISECONDS**. The director-clip build did `Math.min(probed, declared)` on the raw
values, so a 12 s clip got a **12 ms** footprint; `coveredRangeFor` then clamped every 4000 ms slice to
12 ms, the director emitted one 12 ms shot, and skip (2) fired for it. Symptom to recognise:
`director → … dur=12`, `4 slice(s) | 1 shot(s) | 1 gap(s)`, shot `0→12ms`. **Any time a duration mixes a
probe (seconds) with a *_ms value, convert before comparing.** `ffprobeDuration()` and
`ffprobeVideoDuration()` are both seconds; `finalizeSoloVideo` uses them as seconds on purpose.

## 2. Reproduce without the browser (fastest loop)
```bash
cd /home/team/shared/site
export DATABASE_URL='postgresql://…neon…/neondb?sslmode=require&channel_binding=require'
timeout 300 bun run scripts/diag-event-render.ts <eventId>   # calls renderEventVideo directly
```
`renderEventVideo` awaits the run, so the script prints `RENDER {"ok":true} <ms>` and the log lines above.
Run it from `site/` — `uploadsRoot()` is `process.cwd()/uploads`. Fixture event 80567e10-cc64-47a7-b245-564bf61156cb
(share code B3CZNB85) already has 3 aligned clips; never rebuild it.

## 3. Read the artifacts
- `uploads/<eventId>/director.json` — the exact shot list (clip_id, timeline window, source window), gaps,
  violations, camera_sequence. This is the evidence for "what did the switcher do".
- `uploads/<eventId>/finished.mp4` — `ffprobe` it: expect h264+aac and a duration ≈ the **timeline**
  (12 s clip + 2 s spread ⇒ ~14 s), not one clip's length. `ffmpeg -i finished.mp4 -f null -` must exit 0.
- `GET /api/events/<id>/render-status` → `{"done":true,"url":"/uploads/<id>/finished.mp4"}`; `GET` that URL → 200.

## 4. Prove the switcher numerically (better than eyeballing burned-in labels)
The collab fixtures mark a camera by layout/hue, not legible text, so compare the film against **each**
camera at the *same timeline moment* (`source time = film time − clip offset_ms`), scaled to the same size:
```bash
ffmpeg -v error -y -ss T -i finished.mp4 -frames:v 1 -vf scale=1280:720 /tmp/f.png
ffmpeg -v error -y -ss $((T - off)) -i uploads/<id>/<clip>.mp4 -frames:v 1 -vf scale=1280:720 /tmp/c.png
ffmpeg -hide_banner -v info -i /tmp/f.png -i /tmp/c.png -lavfi ssim -f null - 2>&1 | grep -o 'All:[0-9.]*'
```
Gotcha: `-v error` on the outer ffmpeg **hides the ssim report** — use `-v info` (it prints `All:0.99…`).
The matching camera scores ≈0.999; others fall far below. Do this on both sides of a cut to show the switch.
A ready-made script: `/tmp/ssim-switcher-proof.sh` (recreate it; it is not committed).

## 5. Drive the real UI button (and the "agent-browser hang" myth)
The previous session's clicks "never took" because its helper built an invalid JS regex
(`find(x => /$1/i.test(x.textContent))` → `SyntaxError: Invalid regular expression flags`). Fix: match with
`String.includes` and pass the script via `eval --stdin` + heredoc:
```bash
agent-browser open "http://localhost:3000/e/B3CZNB85"; sleep 8
cat <<'EOF' | agent-browser eval --stdin
(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Make movie'));
  if(!b) return 'NOTFOUND'; if(b.disabled) return 'DISABLED'; b.click(); return 'clicked'; })()
EOF
```
To make the click a **fresh** render (the button is idempotent when `renders.status='done'` and the file
exists), reset the marker first: `bun run scripts/reset-event-render.ts` (sets `renders.status='error'`,
`finished_key=null`), note `finished.mp4`'s mtime, click, then confirm the mtime moved and `render-status`
reports Done. That is a genuine end-to-end UI render on the published build.

## 6. Order of operations that works
`bun run publish` (carries the fix into the served app) → reset the render marker → browser click →
status/mtime check → frames/SSIM → commit. Publishing with `DATABASE_URL` exported is required; the
server on port 3000 inherits the publish shell's env.
