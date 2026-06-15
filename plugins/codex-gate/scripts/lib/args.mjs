/**
 * Parse companion subcommand flags (everything after the subcommand).
 * @param {string[]} argv
 * @returns {{ files: string[], session: boolean, base: string|null, text: string|null, model: string|null, focus: string|null, background: boolean, json: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const files = [];
  const out = {
    files,
    session: false,
    base: /** @type {string|null} */ (null),
    text: /** @type {string|null} */ (null),
    model: /** @type {string|null} */ (null),
    focus: /** @type {string|null} */ (null),
    background: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    /** Consume and return the next token as a flag value. */
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${token} requires a value`);
      return v;
    };
    switch (token) {
      case "--session":
        out.session = true;
        break;
      case "--background":
        out.background = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--base":
        out.base = value();
        break;
      case "--model":
        out.model = value();
        break;
      case "--focus":
        out.focus = value();
        break;
      case "--text":
        out.text = value();
        break;
      default:
        if (token.startsWith("--")) throw new Error(`unknown flag: ${token}`);
        files.push(token);
    }
  }

  return out;
}
