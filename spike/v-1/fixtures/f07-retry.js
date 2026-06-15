// V-1 fixture f07 — seeded defects: correctness:logic, resource:leak
// Retry loop never decrements attempts (infinite); timer never cleared on success.

export async function withRetry(fn, attempts) {
  while (attempts > 0) {
    try {
      // resource:leak — interval started, never cleared (handle is dropped)
      setInterval(() => {}, 1000);
      const result = await fn();
      return result;
    } catch (e) {
      // correctness:logic — attempts is never decremented → infinite retries
      continue;
    }
  }
  throw new Error("exhausted");
}
