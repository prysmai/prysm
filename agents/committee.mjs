// PRYSM Committee: an "investment committee" agent. Every cycle a Bull, a Bear and a Portfolio Manager debate the
// market as the league itself sees it (the Uniswap v3 TWAPs it scores with). A call goes out only if the PM's
// consensus clears the bar AND the deterministic risk guard passes. The minutes are sealed into the commit and
// published after the reveal, so the league scores the committee's reasoning, not just its picks.
// It plays through prysm-mcp exactly like an outside agent (same tools, same rules, same forfeits). It never trades.
// env: PRYSM_API, PRYSM_AGENT_KEY, AGENT_ID (omit to register a new agent), PRYSM_RPC, PRYSM_HOME,
//      ANTHROPIC_API_KEY (without it the committee runs in rules mode), PRYSM_MODEL (claude-opus-5-5),
//      EVERY_MIN (30), MIN_CONSENSUS (60), ONCE=1 (one cycle, then exit), DRY=1 (debate + guard, never commit; prints the minutes)
// `npm run committee` also reads agents/.env (keep the API key there, never in the repo)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCommittee } from "./committee-engine.mjs";

const API = process.env.PRYSM_API || "http://localhost:5610", EVERY = +(process.env.EVERY_MIN || 30) * 60_000;
const MCP = path.join(path.dirname(new URL(import.meta.url).pathname), "../mcp/index.mjs");
const HOME = process.env.PRYSM_HOME || path.join(os.homedir(), ".prysm");
const JOURNAL = path.join(HOME, "committee-journal.jsonl");
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// ---- the MCP session (the API key never reaches it) ----
const { ANTHROPIC_API_KEY, ...mcpEnv } = process.env;
const c = new Client({ name: "prysm-committee", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...mcpEnv, PRYSM_API: API } }));
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };

let agentId = +(process.env.AGENT_ID || 0);
if (!agentId) {
  const r = await call("prysm_register_agent", { name: "PRYSM Committee", description: "Bull, Bear and Portfolio Manager debate every call; minutes are sealed with the commit and published after the reveal." });
  agentId = r.agentId; log(`registered committee agent #${agentId} (set AGENT_ID=${agentId} next time)`);
}

const committee = createCommittee({ call, agentId, min: +(process.env.MIN_CONSENSUS || 60), model: process.env.PRYSM_MODEL || "claude-opus-5-5",
  apiKey: ANTHROPIC_API_KEY, journal: JOURNAL, dry: !!process.env.DRY, log });
log(`committee #${agentId} up · ${committee.mode === "claude" ? "claude " + committee.model : "rules mode (no ANTHROPIC_API_KEY)"} · bar ${+(process.env.MIN_CONSENSUS || 60)}`);
for (;;) {
  try { const o = await committee.cycle(); if (process.env.DRY) console.log(fs.readFileSync(JOURNAL, "utf8").trim().split("\n").pop()); if (process.env.ONCE || process.env.DRY) { console.log(JSON.stringify(o)); break; } }
  catch (e) { log("cycle failed:", e.message); if (process.env.ONCE) { process.exitCode = 1; break; } }
  await new Promise((r) => setTimeout(r, EVERY));
}
await c.close();
