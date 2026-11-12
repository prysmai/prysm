// CLI end-to-end on the local chain (run by ../e2e-local.sh): init (import, encrypted keystore) -> register -> market ->
// guard -> seal with notes -> status -> reveal -> notes -> board -> agent -> run --dry (Committee, rules mode)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

const RPC = "http://127.0.0.1:8545", API = "http://localhost:5610", here = path.dirname(new URL(import.meta.url).pathname);
const p = new ethers.JsonRpcProvider(RPC), rpc = (m, a) => p.send(m, a);
const dep = JSON.parse(fs.readFileSync(path.join(here, "../../contracts/deployments/localhost.json")));
const step = (s, v) => console.log("✔", s, v === undefined ? "" : JSON.stringify(v).slice(0, 160));
const fail = (s, o = "") => { console.error("✘", s, "\n" + o); process.exit(1); };

const w = ethers.Wallet.createRandom(), home = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-cli-"));
await rpc("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
await (await new ethers.Contract(dep.token, ["function transfer(address,uint256) returns (bool)"], await p.getSigner(0)).transfer(w.address, ethers.parseEther("100"))).wait();
const { ANTHROPIC_API_KEY, PRYSM_AGENT_KEY, ...env } = process.env;
const prysm = (args, input, soft = false) => {
  try { return execFileSync(process.execPath, [path.join(here, "../bin/prysm.mjs"), ...args], { env: { ...env, PRYSM_HOME: home, PRYSM_PASSWORD: "local-test-pw", NO_COLOR: "1" }, input, encoding: "utf8" }); }
  catch (e) { if (soft) return null; fail(`prysm ${args.join(" ")} exited ${e.status}`, (e.stdout || "") + (e.stderr || "")); }
};
const expect = (o, re, what) => { if (!re.test(o)) fail(what, o); };

let o = prysm(["init", "--api", API, "--rpc", RPC, "--import"], w.privateKey + "\n");
expect(o, new RegExp(w.address), "init should save the imported wallet");
const ks = JSON.parse(fs.readFileSync(path.join(home, "keystore.json"), "utf8"));
if (JSON.stringify(ks).includes(w.privateKey.slice(2))) fail("keystore holds the key in plain text");
if ((fs.statSync(path.join(home, "keystore.json")).mode & 0o777) !== 0o600) fail("keystore must be 0600");
step("init: imported wallet, encrypted keystore 0600");

o = prysm(["register", "CLI Agent", "--desc", "e2e"]); const id = +o.match(/agent #(\d+)/)[1];
if (JSON.parse(fs.readFileSync(path.join(home, "config.json"))).agentId !== id) fail("register should save the agent id");
step("register", id);

o = prysm(["market"]); expect(o, /ETH/, "market lists ETH"); step("market");
o = prysm(["guard", "NVDA", "long", "15m"]); expect(o, /clear to seal/, "guard should clear a fresh call"); step("guard clear");
o = prysm(["seal", "NVDA", "long", "15m", "--why", "e2e: sealed from the CLI", "-y"]); const sid = +o.match(/sealed as call #(\d+)/)[1]; step("seal", sid);
o = prysm(["guard", "NVDA", "short", "15m"]); expect(o, /no-self-hedge/, "guard should flag the self-hedge"); step("guard flags self-hedge");
o = prysm(["status"]); expect(o, new RegExp(`#${sid}\\s+long NVDA`), "status should list the open call"); step("status shows open call");

await rpc("evm_increaseTime", [900 + 300 + 5]); await rpc("evm_mine", []);
o = prysm(["reveal"]); expect(o, new RegExp(`#${sid}`), "reveal should handle the due call"); step("reveal", o.trim().split("\n").pop().trim());
// the server indexes the reveal a few seconds later; until then the notes stay sealed
for (let i = 0; i < 20 && !(o = prysm(["notes", String(sid)], undefined, true)); i++) await new Promise((r) => setTimeout(r, 1000));
if (!o) o = prysm(["notes", String(sid)]);
expect(o, /e2e: sealed from the CLI/, "notes should show the sealed reasoning"); step("notes published and readable");
o = prysm(["agent"]); expect(o, /CLI Agent/, "agent shows the record"); step("agent");
o = prysm(["board"]); expect(o, /All time/, "board renders"); step("board");
o = prysm(["run", "--dry"]); expect(o, /rules mode/, "run --dry uses rules mode without a key"); expect(o, /"engine": "prysm-committee"/, "run --dry prints the minutes"); step("run --dry (committee)");
o = prysm(["whoami"]); if (o.includes(w.privateKey.slice(2))) fail("whoami must never print the key"); step("whoami prints no secret");
console.log("CLI e2e passed");
