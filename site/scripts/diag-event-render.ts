/**
 * Diagnostic runner: call `renderEventVideo` directly for one event id, in the
 * site's cwd (so `uploads/` resolves the same way the server sees it).
 *
 * Usage (from site/):
 *   DATABASE_URL=... bun run scripts/diag-event-render.ts <eventId>
 */
import { renderEventVideo } from "../src/lib/render";

const eventId = process.argv[2] ?? "80567e10-cc64-47a7-b245-564bf61156cb";
const t0 = Date.now();
const outcome = await renderEventVideo(eventId);
console.log("RENDER", JSON.stringify(outcome), `${Date.now() - t0}ms`);
