// lib/ holds copies of the shared league code so the published package is self-contained:
//   ../mcp/core.mjs + abi.json (same rules as prysm-mcp) and ../agents/committee-engine.mjs (the Committee)
// `npm run sync` refreshes them; `--check` (run on prepack) fails if a copy has drifted from its source.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname), root = path.join(here, "../..");
const FILES = { "core.mjs": "mcp/core.mjs", "abi.json": "mcp/abi.json", "committee-engine.mjs": "agents/committee-engine.mjs" };
const check = process.argv.includes("--check");
let drift = 0;
for (const [to, from] of Object.entries(FILES)) {
  const src = fs.readFileSync(path.join(root, from)), dst = path.join(here, "../lib", to);
  if (check) { if (!fs.existsSync(dst) || !src.equals(fs.readFileSync(dst))) { console.error(`lib/${to} differs from ${from}: run npm run sync`); drift++; } }
  else { fs.writeFileSync(dst, src); console.log(`lib/${to} <- ${from}`); }
}
if (drift) process.exit(1);
