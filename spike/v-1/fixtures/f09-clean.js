// V-1 fixture f09 — CONTROL: no seeded defects (truthClasses = []).
// Used to measure false-positive behaviour: any class reported here is an FP.

/** Sum positive numbers; validates input and avoids float-money pitfalls. */
export function sumPositive(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("values must be an array");
  }
  let total = 0;
  for (const v of values) {
    if (typeof v !== "number" || Number.isNaN(v) || v < 0) {
      throw new RangeError("values must be non-negative numbers");
    }
    total += v;
  }
  return total;
}
