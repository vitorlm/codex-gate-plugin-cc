// V-1 fixture f05 — seeded defects: correctness:off-by-one, performance:n-plus-one
// Pagination slice drops the last item; per-row query in a loop.

export async function listPage(items, page, size, db) {
  const start = page * size;
  // off-by-one: end excludes the final element of the page (size - 1)
  const end = start + size - 1;
  const slice = items.slice(start, end);

  const enriched = [];
  for (const it of slice) {
    // performance:n-plus-one — one DB round-trip per row instead of a join/batch
    const detail = await db.query("SELECT * FROM details WHERE id = ?", [it.id]);
    enriched.push({ ...it, detail });
  }
  return enriched;
}
