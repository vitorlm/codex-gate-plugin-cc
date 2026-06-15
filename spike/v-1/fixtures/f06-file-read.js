// V-1 fixture f06 — seeded defects: security:path-traversal, error-handling:unhandled
// User-supplied name joined into a path; no try/catch on async read.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadDoc(name) {
  // security:path-traversal — name like "../../etc/passwd" escapes baseDir
  const path = join("/var/data/docs", name);
  // error-handling:unhandled — a missing file rejects with no handling/context
  const buf = await readFile(path);
  return buf.toString("utf8");
}
