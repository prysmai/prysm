// committee end-to-end on the local chain (run by ../e2e-local.sh after the MCP e2e; rules mode, no API key)
//  1. ETH runs hard and is still running -> the committee wants to ride it -> the risk guard blocks it (anti-FOMO)
//  2. ETH turns over -> the committee fades it -> committed with its minutes sealed into the salt
//  3. the minutes stay sealed while open, are published and verifiable once the keeper reveals
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ethers } from "ethers";

const RPC = "http://127.0.0.1:8545", API = "http://localhost:5610", here = path.dirname(new URL(import.meta.url).pathname);
const p = new ethers.JsonRpcProvider(RPC), rpc = (m, a) => p.send(m, a);
const dep = JSON.parse(fs.readFileSync(path.join(here, "../../contracts/deployments/localhost.json")));
const d = await p.getSigner(0);
const step = (s, v) => console.log("✔", s, v === undefined ? "" : JSON.stringify(v).slice(0, 200));
const fail = (s) => { console.error("✘", s); process.exit(1); };
const { ANTHROPIC_API_KEY, ...env } = process.env;     // rules mode

const w = ethers.Wallet.createRandom(), home = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-committee-"));
await rpc("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
await (await new ethers.Contract(dep.token, ["function transfer(address,uint256) returns (bool)"], d).transfer(w.address, ethers.parseEther("100"))).wait();
const base = { ...env, PRYSM_API: API, PRYSM_RPC: RPC, PRYSM_AGENT_KEY: w.privateKey, PRYSM_HOME: home, MIN_CONSENSUS: "60" };
const run = (extra = {}) => JSON.parse(execFileSync(process.execPath, [path.join(here, "../committee.mjs")], { env: { ...base, ONCE: "1", ...extra }, encoding: "utf8" }).trim().split("\n").pop());

// register through the engine itself (no AGENT_ID)
const first = execFileSync(process.execPath, [path.join(here, "../committee.mjs")], { env: { ...base, ONCE: "1", MIN_CONSENSUS: "101" }, encoding: "utf8" });   // a bar nothing clears: register only
const agentId = +first.match(/registered committee agent #(\d+)/)[1];
step("committee registered", agentId);

const eth = new ethers.Contract(dep.mockPools.ETH, ["function setPath(int24,int256)", "function observe(uint32[]) view returns (int56[], uint160[])"], d);
const tickNow = async () => { const [c] = await eth.observe([1, 0]); return Number(c[1] - c[0]); };
const wait = async (s) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };
// the server checks open-call counts with wall-clock time; the chain clock is ahead, which only makes the tilt check stricter

// 1. a straight hourly run: momentum with no pullback
await (await eth.setPath(await tickNow(), 1)).wait(); await wait(3600);
const o1 = run({ AGENT_ID: String(agentId) });
if (o1.action !== "blocked" || !/anti-fomo/.test(o1.why)) fail("expected the guard to block the chase, got " + JSON.stringify(o1));
step("1 · chase blocked by the risk guard", o1);

// 2. it turns over: the last 15 min point down against the hour
await (await eth.setPath(await tickNow(), -1)).wait(); await wait(900);
const o2 = run({ AGENT_ID: String(agentId) });
if (o2.action !== "commit") fail("expected a commit, got " + JSON.stringify(o2));
step("2 · fade committed with sealed minutes", o2);

const id = o2.signalId;
let r = await fetch(`${API}/api/notes/${id}`);
if (r.status !== 403) fail(`notes should be sealed while open, got ${r.status}`);
step("3 · minutes sealed while the call is open", r.status);

// guard: the same machine may not take the other side of its own open call
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "../../mcp/index.mjs")], env: base }));
const g = JSON.parse((await c.callTool({ name: "prysm_guard", arguments: { agentId, asset: "ETH", direction: "long", horizon: "1h" } })).content[0].text);
if (g.ok || g.checks.find((x) => x.name === "no-self-hedge").pass) fail("guard should refuse a self-hedge: " + JSON.stringify(g.checks));
step("guard refuses a self-hedge", g.checks.filter((x) => !x.pass).map((x) => x.name));
await c.close();

// past expiry + TWAP: the server's keeper reveals it (the engine exited)
await wait(3600 + 300 + 5);
const t0 = Date.now();
for (;;) { r = await fetch(`${API}/api/notes/${id}`); if (r.status === 200 || Date.now() - t0 > 90000) break; await new Promise((x) => setTimeout(x, 3000)); }
if (r.status !== 200) fail(`notes not published after the reveal (${r.status})`);
const n = await r.json();
step("4 · revealed and published", { status: n.status, asset: n.asset, dir: n.dir, scoreBps: n.scoreBps, consensus: n.parsed?.pm?.consensus });

// anyone can check it: recompute the salt from the published text and compare with the on-chain commit
const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [n.verify.nonce, ethers.keccak256(ethers.toUtf8Bytes(n.rationale))]));
const book = new ethers.Contract(dep.signalBook, ["function hashSignal(uint256,uint16,int8,uint32,bytes32) view returns (bytes32)", "function signals(uint256) view returns (uint256 agentId, bytes32 commitHash, uint64 committedAt, uint8 status, uint16 assetId, int8 dir, uint32 horizon, int32 scoreBps)"], p);
const onchain = (await book.signals(id)).commitHash;
const asset = (await (await fetch(`${API}/api/config`)).json()).assets.find((a) => a.sym === n.asset);
if ((await book.hashSignal(agentId, asset.id, n.dir, n.horizon, salt)) !== onchain) fail("published minutes do not hash to the commit");
step("5 · minutes verified against the on-chain commit", onchain.slice(0, 18) + "…");
const a = await (await fetch(`${API}/api/agent/${agentId}`)).json();
step("agent page summary", a.signals.find((s) => s.id === id).notes);
process.exit(0);
