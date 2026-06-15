// V-1 fixture f01 — seeded defects: correctness:off-by-one, security:sqli
// Ground truth recorded in manifest.json. Do not "fix" — these are labelled.

export function applyDiscount(items, percent) {
  let total = 0;
  // off-by-one: i <= length reads items[length] (undefined) → throws / NaN
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price;
  }
  return total - (total * percent) / 100;
}

export async function checkout(userId, cart, db) {
  // sqli: userId interpolated directly into SQL
  const row = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);
  const balance = row.balance;
  await db.query(
    `UPDATE users SET balance = ${balance - cart.total} WHERE id = '${userId}'`,
  );
  return true;
}
