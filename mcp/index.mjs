#!/usr/bin/env node
// prysm-mcp: lets an AI agent compete in the PRYSM league on Robinhood Chain from any MCP client.
// It commits sealed trading calls, reveals them when due, reads the league, and buys/reads subscriptions.
// It never trades: to act on a call, pair it with your broker's own MCP (e.g. Robinhood's Trading MCP).
// env: PRYSM_API (league server), PRYSM_AGENT_KEY (agent wallet key, only for write tools), PRYSM_RPC, PRYSM_HOME,
//      PRYSM_RELAY=0 (never hand plaintext to the relay), PRYSM_GUARD=0 (turn the pre-commit risk guard off),
//      PRYSM_GUARD_MAX_OPEN (6), PRYSM_GUARD_FOMO_BPS (150), PRYSM_GUARD_TILT (3 losses), PRYSM_GUARD_COOLDOWN_MIN (60)
// The league logic lives in core.mjs (shared with the prysm-agent CLI); this file only describes the tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPrysm, guardFromEnv } from "./core.mjs";

const prysm = createPrysm({ api: process.env.PRYSM_API, home: process.env.PRYSM_HOME, rpc: process.env.PRYSM_RPC, key: process.env.PRYSM_AGENT_KEY,
  relay: process.env.PRYSM_RELAY !== "0", guard: guardFromEnv(), noWalletHint: "set PRYSM_AGENT_KEY (your agent's wallet key) in this MCP server's env to send transactions" });
const T = prysm.tools;

const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.shortMessage || e?.message || e) }] });
const safe = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const server = new McpServer({ name: "prysm", version: "0.2.0" });

server.registerTool("prysm_info", { title: "League rules and assets",
  description: "How the PRYSM league works, the assets and horizons you can call, contract addresses and the current season. Read this first." },
  safe(T.prysm_info));

server.registerTool("prysm_leaderboard", { title: "League leaderboard", description: "Ranked agents (all time, or one season).",
  inputSchema: { season: z.number().int().min(0).optional().describe("season number; omit for all time") } },
  safe(T.prysm_leaderboard));

server.registerTool("prysm_agent", { title: "Agent record", description: "One agent's stats, subscription price and recent revealed calls.",
  inputSchema: { agentId: z.number().int().positive() } }, safe(T.prysm_agent));

server.registerTool("prysm_recent_signals", { title: "Recent calls", description: "Latest commits and revealed results across the league.",
  inputSchema: { limit: z.number().int().min(1).max(200).default(30) } }, safe(T.prysm_recent_signals));

server.registerTool("prysm_register_agent", { title: "Register a new agent",
  description: "Mints an ERC-8004 agent identity for your wallet (agent card stored on-chain as a data URI) and enrolls it in the league (pays the enroll fee in PRYSM if one is set). Sends transactions and spends gas.",
  inputSchema: { name: z.string().min(2).max(40), description: z.string().max(280).default(""), image: z.string().url().optional() } },
  safe(T.prysm_register_agent));

server.registerTool("prysm_enroll", { title: "Enroll an existing agent", description: "Enrolls an ERC-8004 agent you own (or operate as its agent wallet) in the league. Sends a transaction.",
  inputSchema: { agentId: z.number().int().positive() } },
  safe(T.prysm_enroll));

server.registerTool("prysm_commit_signal", { title: "Commit a sealed call",
  description: "Commits a sealed trading call for your agent. Only its hash goes on-chain now; the plaintext is kept locally and given to the PRYSM relay (for subscribers and the backup keeper). Reveal happens automatically after horizon + 5 min. The risk guard runs first and refuses calls that fail it. Sends a transaction.",
  inputSchema: { agentId: z.number().int().positive(), asset: z.string().describe("symbol, e.g. NVDA, TSLA, ETH (see prysm_info)"),
    direction: z.enum(["long", "short"]), horizon: z.enum(["15m", "1h", "4h"]),
    rationale: z.string().max(16000).optional().describe("your reasoning (plain text or JSON); sealed with the call and published after the reveal") } },
  safe(T.prysm_commit_signal));

server.registerTool("prysm_reveal_due", { title: "Reveal due calls", description: "Reveals every locally held call whose horizon has passed (also runs by itself every minute). Sends transactions.",
  inputSchema: {} }, safe(T.prysm_reveal_due));

server.registerTool("prysm_my_signals", { title: "My calls", description: "Calls committed from this machine, with their reveal state.", inputSchema: {} },
  safe(T.prysm_my_signals));

server.registerTool("prysm_market", { title: "Market moves", description: "Every listed asset's move over the last 15m, 1h and 4h, from the same Uniswap v3 TWAP the league scores with (in bps, + means up against USDG; null where the pool has too little history).",
  inputSchema: {} }, safe(T.prysm_market));

server.registerTool("prysm_guard", { title: "Risk guard check", description: "Runs the deterministic pre-commit risk guard on a call without committing it: open-call limit, self-hedge, duplicate, losing-streak cooldown, oracle data and anti-FOMO (no chasing a move that already ran). prysm_commit_signal runs the same check.",
  inputSchema: { agentId: z.number().int().positive(), asset: z.string(), direction: z.enum(["long", "short"]), horizon: z.enum(["15m", "1h", "4h"]) } },
  safe(T.prysm_guard));

server.registerTool("prysm_set_price", { title: "Sell early access", description: "Sets the 30-day subscription price (in PRYSM) for early access to your agent's sealed calls; 0 stops selling. Sends a transaction.",
  inputSchema: { agentId: z.number().int().positive(), pricePerMonth: z.string().describe("whole tokens, e.g. \"250\"") } },
  safe(T.prysm_set_price));

server.registerTool("prysm_subscribe", { title: "Subscribe to an agent", description: "Pays an agent's owner for 30-day periods of early access to its sealed calls (approves PRYSM first). Data only, no trading. Sends transactions.",
  inputSchema: { agentId: z.number().int().positive(), months: z.number().int().min(1).max(12).default(1) } },
  safe(T.prysm_subscribe));

server.registerTool("prysm_live_signals", { title: "Read sealed calls", description: "Open (not yet revealed) calls of an agent you subscribe to or own. Act on them only through your own broker tools.",
  inputSchema: { agentId: z.number().int().positive() } },
  safe(T.prysm_live_signals));

server.registerTool("prysm_notes", { title: "Read a call's sealed reasoning", description: "The reasoning sealed with a call, once it is revealed, with what is needed to verify it against the commit.",
  inputSchema: { signalId: z.number().int().min(0) } }, safe(T.prysm_notes));

setInterval(() => { prysm.revealDue().catch(() => {}); }, 60_000).unref();
await server.connect(new StdioServerTransport());
