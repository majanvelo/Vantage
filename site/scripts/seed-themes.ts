/**
 * scripts/seed-themes.ts — seed the Vantage theme catalog into the database.
 *
 *   cd /home/team/shared/site && export DATABASE_URL='<postgres url>' && bun scripts/seed-themes.ts
 *
 * Idempotent: upserts on `slug`, so it is safe to run repeatedly (on a fresh
 * database, or to re-assert the catalog after manual edits). It never deletes
 * rows and never changes an existing theme's id — events.theme_id stays valid.
 *
 * This is deliberately NOT wired into server boot: `ensureSchema()` already
 * applies the same list (from src/lib/theme-catalog.ts) on first use, and this
 * script exists so a fresh database can be seeded on demand from the CLI.
 *
 * `--dry-run` prints what would change without writing.
 */
import { query, getPool } from "../src/db";
import { THEME_CATALOG, upsertThemeCatalog } from "../src/lib/theme-catalog";

type Row = { slug: string; display_name: string; is_plus: boolean; sort_order: number };

async function current(): Promise<Row[]> {
  return query<Row>(
    `select slug, display_name, is_plus, sort_order from themes order by sort_order, display_name`
  );
}

function show(label: string, rows: Row[]): void {
  console.log(`\n${label} (${rows.length} rows)`);
  console.log(
    "  " +
      ["slug", "display_name", "is_plus", "sort"].join(" | ") +
      "\n  " +
      "-".repeat(46)
  );
  for (const r of rows) {
    console.log(
      `  ${r.slug.padEnd(12)} | ${r.display_name.padEnd(16)} | ${String(r.is_plus).padEnd(5)} | ${r.sort_order}`
    );
  }
}

const dryRun = process.argv.includes("--dry-run");

const before = await current();
show("BEFORE", before);

if (dryRun) {
  const have = new Set(before.map((r) => r.slug));
  const missing = THEME_CATALOG.filter((t) => !have.has(t.slug));
  const updates = THEME_CATALOG.filter((t) => {
    const cur = before.find((b) => b.slug === t.slug);
    return cur && (cur.display_name !== t.display_name || cur.is_plus !== t.is_plus || cur.sort_order !== t.sort_order);
  });
  console.log(`\nDRY RUN — would insert ${missing.length}, update ${updates.length}, delete 0`);
  for (const t of missing) console.log(`  + ${t.slug} (${t.display_name}, is_plus=${t.is_plus}, sort=${t.sort_order})`);
  for (const t of updates) console.log(`  ~ ${t.slug}`);
} else {
  const written = await upsertThemeCatalog(query);
  show("AFTER", await current());
  console.log(`\nSeeded ${written} catalog rows (upsert on slug — no duplicates).`);
}

await getPool().end();
