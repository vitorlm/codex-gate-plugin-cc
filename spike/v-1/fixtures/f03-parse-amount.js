// V-1 fixture f03 — seeded defects: data-integrity:unvalidated, correctness:float-money
// Monetary value parsed as float, no validation of NaN / negative.

export function chargeAccount(account, rawAmount) {
  // data-integrity:unvalidated — rawAmount never checked for NaN/negative/null
  // correctness:float-money — money handled as binary float, rounding drift
  const amount = parseFloat(rawAmount);
  account.balance = account.balance - amount;
  return account.balance;
}
