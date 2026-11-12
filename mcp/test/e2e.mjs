// end-to-end against a local fork: node test/e2e.mjs (needs `hardhat node --fork` on :8545, deploy, and the server on :5610)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ethers } from "ethers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RPC = "http://127.0.0.1:8545", API = "http://localhost:5610";
const p = new ethers.JsonRpcProvider(RPC);
const dep = JSON.parse(fs.readFileSync(new URL("../../contracts/deployments/localhost.json", import.meta.url)));
const rpc = (m, a) => p.send(m, a);
const agent = ethers.Wallet.createRandom(), fan = ethers.Wallet.createRandom();
for (const w of [agent, fan]) await rpc("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
const deployer = await p.getSigner(0);
const tok = new ethers.Contract(dep.token, ["function transfer(address,uint256) returns (bool)"], deployer);
await (await tok.transfer(fan.address, ethers.parseEther("5000"))).wait();
await (await tok.transfer(agent.address, ethers.parseEther("100"))).wait();

const home = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-e2e-"));
async function mcp(w) {
  const c = new Client({ name: "e2e", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: [new URL("../index.mjs", import.meta.url).pathname],
    env: { ...process.env, PRYSM_API: API, PRYSM_RPC: RPC, PRYSM_AGENT_KEY: w.privateKey, PRYSM_HOME: path.join(home, w.address) } }));
  return async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const t = r.content[0].text; if (r.isError) throw new Error(`${name}: ${t}`);
    try { return JSON.parse(t); } catch { return t; }
  };
}
const A = await mcp(agent), F = await mcp(fan);
const step = (s, v) => console.log("✔", s, v === undefined ? "" : JSON.stringify(v).slice(0, 160));

const tools = (await (await (async () => { const c = new Client({ name: "l", version: "0" }); await c.connect(new StdioClientTransport({ command: "node", args: [new URL("../index.mjs", import.meta.url).pathname], env: { ...process.env, PRYSM_API: API } })); return c; })()).listTools()).tools.map((t) => t.name);
step("tools", tools);
const info = await A("prysm_info"); step("info", { assets: info.assets.map((a) => a.sym), wallet: info.wallet });
const reg = await A("prysm_register_agent", { name: "E2E Momentum", description: "test agent" }); step("registered", reg);
const id = reg.agentId;
const calls = [["NVDA", "long", "15m"], ["TSLA", "short", "15m"], ["ETH", "long", "15m"], ["AAPL", "long", "1h"], ["MSFT", "short", "15m"], ["GOOGL", "long", "15m"]];
const ids = [];
for (const [asset, direction, horizon] of calls) { const r = await A("prysm_commit_signal", { agentId: id, asset, direction, horizon }); ids.push(r.signalId); }
step("committed", ids);
await A("prysm_set_price", { agentId: id, pricePerMonth: "100" }); step("price set");
const sub = await F("prysm_subscribe", { agentId: id, months: 1 }); step("fan subscribed", sub);
await rpc("evm_increaseTime", [301]); await rpc("evm_mine", []);   // the feed opens once the entry TWAP window has closed
const live = await F("prysm_live_signals", { agentId: id }); step("fan reads sealed calls", live.live.map((s) => `${s.asset} ${s.dir > 0 ? "long" : "short"} ${s.horizon}s`));
let denied = false; try { const stranger = ethers.Wallet.createRandom(); await rpc("hardhat_setBalance", [stranger.address, "0x1000000000000000"]); await (await mcp(stranger))("prysm_live_signals", { agentId: id }); } catch { denied = true; }
step("stranger denied", denied);

// move the mock pools between the entry and exit windows so the calls score (NVDA/AAPL/MSFT quote inverted)
const poolAbi = ["function setPath(int24,int256)"];
await rpc("evm_increaseTime", [400]); await rpc("evm_mine", []);
for (const [sym, tick] of [["NVDA", -120], ["TSLA", 80], ["ETH", -50], ["MSFT", 60], ["GOOGL", 30], ["AAPL", -40]])
  await (await new ethers.Contract(dep.mockPools[sym], poolAbi, deployer).setPath(tick, 0)).wait();
await rpc("evm_increaseTime", [500 + 300 + 10]); await rpc("evm_mine", []);
const rev = await A("prysm_reveal_due"); step("revealed (15m calls)", rev);
await rpc("evm_increaseTime", [3600]); await rpc("evm_mine", []);
step("keeper should reveal the 1h call if the agent does not; waiting for server loop");
const t0 = Date.now(); let st;
for (;;) { st = await (await fetch(`${API}/api/agent/${id}`)).json(); if (st.signals.every((s) => s.status !== "open") || Date.now() - t0 > 90000) break; await new Promise((r) => setTimeout(r, 3000)); }
step("agent record", { stats: st.stats, statuses: st.signals.map((s) => s.status) });
const lb = await (await fetch(`${API}/api/leaderboard`)).json(); step("leaderboard", lb.ranked.map((r) => [r.rank, r.name, r.n, r.score]));
const rep = new ethers.Contract(dep.reputation, ["function getSummary(uint256,address[],string,string) view returns (uint64,int128,uint8)"], p);  // mock registry locally
step("ERC-8004 reputation summary (count, value, decimals)", (await rep.getSummary(id, [dep.signalBook], "prysm/alpha", "")).map(String));
process.exit(0);
