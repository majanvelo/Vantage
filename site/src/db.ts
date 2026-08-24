import { Pool } from "pg";

/**
 * Server-only handle to the team's Postgres database.
 *
 * The connection string comes from `DATABASE_URL`. In this workspace the platform
 * injects a placeholder (`npx neonctl@latest init`) until a real database is
 * connected — the real value (a standard `postgresql://` URL that works with Neon
 * over TCP) must be exported into the shell that runs `bun run publish`. The pool
 * is resolved lazily (per call, not at module load) so the site still builds and
 * serves before a database is reachable; the error only surfaces if a query runs
 * without `DATABASE_URL`.
 *
 * Use it only inside a `createServerFn()` handler (never client code):
 *
 *   const getEvents = createServerFn().handler(async () => {
 *     const rows = await query(`select id, title from events order by created_at desc`);
 *     return rows.map((r) => ({ ...r, created_at: String(r.created_at) }));
 *   });
 */

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url || url === "npx neonctl@latest init" || url.includes("npx ")) {
      throw new Error(
        "DATABASE_URL is not set to a real postgres connection string — connect a database before running queries."
      );
    }
    // SSL: enabled for Neon-style cloud hosts, disabled for local/loopback Postgres.
    // Not a security control here — it just matches what each host expects so the
    // same code works against a local server and a cloud one.
    const isCloud = /neon\.tech|aws|azure|supabase|fly\.io|vercel/i.test(url);
    pool = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: isCloud ? { rejectUnauthorized: false } : false,
    });
    pool.on("error", (err) => {
      // Keep the process alive on idle backend errors.
      console.error("vantage db pool error:", err.message);
    });
  }
  return pool;
}

/** Run a parameterized query and return the rows. */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    const res = await client.query({ text, values: params });
    return res.rows as T[];
  } finally {
    client.release();
  }
}

/** Tagged-template helper matching the historic `db\`...\`` call sites. */
export function sql<T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    text += `$${i + 1}` + (strings[i + 1] ?? "");
  }
  return query<T>(text, values);
}

/**
 * Schema + seed, run idempotently (CREATE TABLE IF NOT EXISTS). This is the Phase-1
 * data model for the event + upload + join flow. Theme *selection* is stored here;
 * theme *styling* at render is out of scope (Phase 3).
 */
export async function ensureSchema(): Promise<void> {
  await query(`
    create table if not exists themes (
      id           uuid primary key default gen_random_uuid(),
      slug         text not null unique,
      display_name text not null,
      is_plus      boolean not null default false,
      sort_order   integer not null default 0
    )
  `);

  await query(`
    create table if not exists events (
      id         uuid primary key default gen_random_uuid(),
      title      text not null,
      mode       text not null default 'collaborative' check (mode in ('solo','collaborative')),
      status     text not null default 'open' check (status in ('open','collecting','rendering','done')),
      theme_id   uuid references themes(id),
      prefs      jsonb not null default '{}'::jsonb,
      owner      text,
      share_code text not null unique,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await query(`create index if not exists events_share_code_idx on events (share_code)`);

  await query(`
    create table if not exists event_members (
      event_id  uuid not null references events(id) on delete cascade,
      user_id   text not null,
      role      text not null default 'member' check (role in ('owner','member')),
      joined_at timestamptz not null default now(),
      primary key (event_id, user_id)
    )
  `);

  await query(`
    create table if not exists clips (
      id                uuid primary key default gen_random_uuid(),
      event_id          uuid not null references events(id) on delete cascade,
      uploader          text,
      filename          text not null,
      content_type      text,
      size_bytes        bigint,
      media_type        text not null check (media_type in ('video','photo')),
      captured_at       timestamptz,
      s3_or_storage_key text,
      created_at        timestamptz not null default now()
    )
  `);
  await query(`create index if not exists clips_event_idx on clips (event_id)`);

  // Audio features extracted from each clip (cached so "Sync now" never
  // re-decodes a video). `values` is the RMS loudness envelope (one entry per
  // `window_ms` window), already reduced server-side by ffmpeg.
  await query(`
    create table if not exists audio_features (
      clip_id     uuid primary key references clips(id) on delete cascade,
      sample_rate integer not null,
      window_ms   integer not null,
      duration_ms integer not null,
      values      jsonb not null,
      computed_at timestamptz not null default now()
    )
  `);

  // Result of the last global solve for an event: each clip's start offset (ms)
  // on the shared timeline, plus which clips were dropped as un-syncable.
  await query(`
    create table if not exists event_sync (
      event_id    uuid primary key references events(id) on delete cascade,
      offsets     jsonb not null,
      timeline_ms integer not null default 0,
      computed_at timestamptz not null default now()
    )
  `);

  // Starter theme catalog (Phase-1 selection; is_plus marks the Plus-tier packs).
  const themes: Array<[string, string, boolean, number]> = [
    ["vacation", "Vacation", false, 1],
    ["travel", "Travel", false, 2],
    ["romantic", "Romantic / Love", false, 3],
    ["school", "School / Study", false, 4],
    ["fashion", "Fashion", false, 5],
    ["hiphop", "Hip-Hop", true, 6],
    ["food", "Food", false, 7],
    ["vlog", "Vlog", false, 8],
  ];
  for (const [slug, name, plus, sort] of themes) {
    await query(
      `insert into themes (slug, display_name, is_plus, sort_order)
       values ($1, $2, $3, $4)
       on conflict (slug) do update set display_name = excluded.display_name, is_plus = excluded.is_plus, sort_order = excluded.sort_order`,
      [slug, name, plus, sort]
    );
  }
}
