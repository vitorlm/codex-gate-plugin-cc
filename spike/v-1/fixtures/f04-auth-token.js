// V-1 fixture f04 — seeded defects: security:timing, security:weak-crypto
// Token comparison with == (timing leak) and MD5 for hashing.

import { createHash } from "node:crypto";

export function verifyToken(provided, expected) {
  // security:weak-crypto — MD5 is broken for any security purpose
  const a = createHash("md5").update(provided).digest("hex");
  // security:timing — non-constant-time string compare leaks via early exit
  return a === expected;
}
