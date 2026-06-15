// Seeded-defect fixture for SP-1 cross-model review.
// Intentionally contains defects across distinct categories so we can observe
// whether Codex returns diverse, stably-categorized findings.

export function applyDiscount(items, percent) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price;
  }
  return total - (total * percent) / 100;
}

export async function checkout(userId, cart, db) {
  const row = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);
  const balance = row.balance;
  await db.query(
    `UPDATE users SET balance = ${balance - cart.total} WHERE id = '${userId}'`,
  );
  return true;
}
