// House agents: simple, honest baselines that keep the board alive from day one. Each one runs through prysm-mcp
// exactly like an outside agent would (same tools, same rules, same forfeits).
//   momentum  - goes with the sign of the last hour's TWAP move on the asset that moved most
//   reversion - fades the same move
// env: PRYSM_API, HOUSE_KEYS="momentum:0xKEY:agentId,reversion:0xKEY:agentId", PRYSM_RPC (optional), EVERY_MIN (default 30)
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ethers } from "ethers";

const API = process.env.PRYSM_API || "http://localhost:5610", EVERY = +(process.env.EVERY_MIN || 30) * 60_000;
const MCP = path.join(path.dirname(new URL(import.meta.url).pathname), "../mcp/index.mjs");
const POOL = ["function observe(uint32[]) view returns (int56[], uint160[])"];
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

const cfg = await (await fetch(API + "/api/config")).json();
const provider = new ethers.JsonRpcProvider(process.env.PRYSM_RPC || cfg.rpc, cfg.chainId, { staticNetwork: true });
const assets = cfg.assets;   // pools as configured in the SignalBook

// last hour's move in ticks for every asset, sign-corrected so + means the asset rose against USDG
async function moves() {
  const out = [];
  for (const a of assets) {
    try {
      const [c] = await new ethers.Contract(a.pool, POOL, provider).observe([3900, 3600, 300, 0]);
      const t0 = Number(c[1] - c[0]) / 300, t1 = Number(c[3] - c[2]) / 300;
      out.push({ sym: a.sym, move: (a.invert ? -1 : 1) * (t1 - t0) });
    } catch {}
  }
  return out.sort((x, y) => Math.abs(y.move) - Math.abs(x.move));
}

async function agent(spec) {
  const [style, key, agentId] = spec.split(":");
  const c = new Client({ name: "prysm-house-" + style, version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, PRYSM_API: API, PRYSM_AGENT_KEY: key } }));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
  return { style, agentId: +agentId, call };
}

const specs = (process.env.HOUSE_KEYS || "").split(",").filter(Boolean);
if (!specs.length) { console.log("set HOUSE_KEYS=style:privateKey:agentId,..."); process.exit(1); }
const team = await Promise.all(specs.map(agent));
log(`house agents up: ${team.map((t) => `${t.style}#${t.agentId}`).join(", ")}`);
for (;;) {
  try {
    const m = await moves(), top = m[0];
    if (top && Math.abs(top.move) >= 3) {
      for (const t of team) {
        const up = top.move > 0, direction = (t.style === "reversion" ? !up : up) ? "long" : "short";
        try { const r = await t.call("prysm_commit_signal", { agentId: t.agentId, asset: top.sym, direction, horizon: "1h" }); log(`${t.style} ${direction} ${top.sym} (1h move ${top.move.toFixed(0)}t) -> #${r.signalId}`); }
        catch (e) { log(`${t.style} commit failed: ${e.message}`); }
      }
    } else log("market flat, no call");
  } catch (e) { log("cycle failed:", e.message); }
  await new Promise((r) => setTimeout(r, EVERY));
}
