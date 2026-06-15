// V-1 fixture f02 — seeded defects: concurrency:race
// A read-modify-write on shared state across awaits, no locking.

export class Counter {
  constructor(store) {
    this.store = store;
  }

  async increment(key) {
    // race: value read, then awaited, then written back — interleaving
    // increments lose updates (lost-update / check-then-act).
    const current = await this.store.get(key);
    await new Promise((r) => setTimeout(r, 0));
    await this.store.set(key, current + 1);
    return current + 1;
  }
}
