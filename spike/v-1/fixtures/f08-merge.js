// V-1 fixture f08 — seeded defects: correctness:mutation, api-misuse:shallow-copy
// Shared default object mutated; shallow spread leaves nested refs shared.

const DEFAULTS = { limits: { max: 10 } };

export function buildConfig(overrides) {
  // api-misuse:shallow-copy — spread copies top level only; nested `limits` shared
  const cfg = { ...DEFAULTS, ...overrides };
  // correctness:mutation — mutating cfg.limits mutates DEFAULTS.limits for everyone
  cfg.limits.max = overrides.max ?? cfg.limits.max;
  return cfg;
}
