/**
 * The Vantage theme catalog — ONE canonical list, so the DB rows can never drift
 * apart from the seed script. Two callers:
 *
 *   - `src/db.ts` → `ensureSchema()` bootstraps/refreshes the rows on first use
 *     (idempotent upsert on `slug`, so re-running never duplicates).
 *   - `scripts/seed-themes.ts` → seeds a fresh database on demand:
 *     `bun scripts/seed-themes.ts`
 *
 * `is_plus` is METADATA ONLY for now: it marks which packs belong to Vantage Plus
 * and the pickers show a ✨ / amber ring for those, but no gating is enforced yet
 * (monetization gating lands with the Phase-3 render pipeline).
 *
 * Ordering: free themes first (grouped so related themes sit together), Plus
 * themes last. `sort_order` drives `listThemes()`'s `order by sort_order, display_name`.
 *
 * Never edit a `slug`: events.theme_id references themes(id), and the slug is the
 * upsert key. Renaming one would insert a second row instead of updating in place.
 */
export type ThemeSeed = {
  slug: string;
  display_name: string;
  is_plus: boolean;
  sort_order: number;
};

export const THEME_CATALOG: readonly ThemeSeed[] = [
  // ── Free themes ────────────────────────────────────────────────────────────
  { slug: "vacation", display_name: "Vacation", is_plus: false, sort_order: 1 },
  { slug: "travel", display_name: "Travel", is_plus: false, sort_order: 2 },
  { slug: "romantic", display_name: "Romantic / Love", is_plus: false, sort_order: 3 },
  { slug: "birthday", display_name: "Birthday", is_plus: false, sort_order: 4 },
  { slug: "school", display_name: "School / Study", is_plus: false, sort_order: 5 },
  { slug: "youthful", display_name: "Youthful", is_plus: false, sort_order: 6 },
  { slug: "fashion", display_name: "Fashion", is_plus: false, sort_order: 7 },
  { slug: "art", display_name: "Art", is_plus: false, sort_order: 8 },
  { slug: "food", display_name: "Food", is_plus: false, sort_order: 9 },
  { slug: "vlog", display_name: "Vlog", is_plus: false, sort_order: 10 },

  // ── Vantage Plus themes (is_plus = true; ✨ in the pickers, no gating yet) ──
  { slug: "hiphop", display_name: "Hip-Hop", is_plus: true, sort_order: 11 },
  { slug: "wedding", display_name: "Wedding", is_plus: true, sort_order: 12 },
  { slug: "anniversary", display_name: "Anniversary", is_plus: true, sort_order: 13 },
];

/** Minimal shape of the parameterised query function we need (see src/db.ts). */
type QueryFn = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
) => Promise<T[]>;

/**
 * Upsert every catalog row, keyed on `slug`. Safe to run any number of times:
 * existing ids are preserved (so events keep their theme) and no duplicate rows
 * are ever created. Returns the number of rows written.
 */
export async function upsertThemeCatalog(query: QueryFn): Promise<number> {
  for (const t of THEME_CATALOG) {
    await query(
      `insert into themes (slug, display_name, is_plus, sort_order)
       values ($1, $2, $3, $4)
       on conflict (slug) do update set display_name = excluded.display_name, is_plus = excluded.is_plus, sort_order = excluded.sort_order`,
      [t.slug, t.display_name, t.is_plus, t.sort_order]
    );
  }
  return THEME_CATALOG.length;
}
