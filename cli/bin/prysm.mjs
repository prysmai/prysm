#!/usr/bin/env node
// prysm: the PRYSM agent league from a terminal. Same league code as prysm-mcp (lib/core.mjs), same Committee as the
// house agent (lib/committee-engine.mjs). It never trades and never holds anyone's funds.
// Settings live in $PRYSM_HOME (~/.prysm): config.json (api, rpc, agent id) and keystore.json (the agent wallet,
// encrypted with your password). PRYSM_AGENT_KEY overrides the keystore; PRYSM_PASSWORD unlocks it without a prompt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { ethers } from "ethers";
import { createPrysm, guardFromEnv, DEFAULT_API, HORIZON, TWAP, WINDOW } from "../lib/core.mjs";

const VERSION = "0.1.1";
const HOME = process.env.PRYSM_HOME || path.join(os.homedir(), ".prysm");
const CONFIG = path.join(HOME, "config.json"), KEYSTORE = path.join(HOME, "keystore.json");

// ---- look ----
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const acc = paint("38;2;180;166;255"), dim = paint("2"), bold = paint("1"), up = paint("38;2;155;227;192"), down = paint("38;2;255;154;154");
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const out = (...a) => console.log(...a);
const banner = () => out(`\n  ${acc("▽")} ${bold("P R Y S M")}  ${dim("agent league · Robinhood Chain")}\n`);
const ok = (s) => out(`  ${up("✔")} ${s}`), bad = (s) => out(`  ${down("✘")} ${s}`), note = (s) => out(`  ${dim(s)}`);
const bps = (v) => (v == null ? dim("–") : v > 0 ? up(`+${v} bp`) : v < 0 ? down(`${v} bp`) : `${v} bp`);
const dirTxt = (d) => (d > 0 || d === "long" ? up("long") : down("short"));
const hz = (s) => Object.keys(HORIZON).find((k) => HORIZON[k] === s) || `${s}s`;
const when = (t) => { const d = t - Date.now() / 1000, a = Math.abs(d), u = a < 90 ? `${Math.round(a)}s` : a < 5400 ? `${Math.round(a / 60)}m` : `${(a / 3600).toFixed(1)}h`; return d >= 0 ? `in ${u}` : `${u} ago`; };
function table(head, rows) {
  const w = head.map((h, i) => Math.max(strip(h).length, ...rows.map((r) => strip(r[i]).length)));
  const line = (r) => "  " + r.map((c, i) => { const pad = " ".repeat(w[i] - strip(c).length); return i === 0 || typeof c !== "string" || !/^[+\-–\d.]/.test(strip(c)) ? c + pad : pad + c; }).join("   ");
  out(dim(line(head))); out(dim("  " + w.map((n) => "─".repeat(n)).join("   "))); rows.forEach((r) => out(line(r)));
}
async function spin(label, fn) {
  if (!process.stderr.isTTY) return fn();
  const f = "◜◠◝◞◡◟"; let i = 0;
  const t = setInterval(() => process.stderr.write(`\r  ${acc(f[i++ % f.length])} ${label}`), 80);
  try { return await fn(); } finally { clearInterval(t); process.stderr.write("\r\x1b[2K"); }
}

// ---- config + wallet ----
const readCfg = () => { try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; } };
const writeCfg = (c) => { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 }); };
const cfg = readCfg();
const API = process.env.PRYSM_API || cfg.api || DEFAULT_API;

async function ask(q, def = "") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { const a = (await rl.question(`  ${q}${def ? dim(` (${def})`) : ""} `)).trim(); return a || def; } finally { rl.close(); }
}
// hidden input for passwords and keys: nothing is echoed
// (piped stdin, e.g. `echo $KEY | prysm init --import`, is read line by line instead)
let piped;
async function secret(q) {
  if (!process.stdin.isTTY) {
    piped ??= readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    const { value, done } = await piped.next(); if (done) throw new Error("no terminal to ask for a secret; set PRYSM_PASSWORD or PRYSM_AGENT_KEY"); return value;
  }
  return new Promise((resolve) => {
    process.stdout.write(`  ${q} `); const s = process.stdin; let v = "";
    s.setRawMode(true); s.resume(); s.setEncoding("utf8");
    const on = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { s.setRawMode(false); s.pause(); s.off("data", on); process.stdout.write("\n"); return resolve(v); }
        if (c === "\u0003") { s.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f") v = v.slice(0, -1); else v += c;
      }
    };
    s.on("data", on);
  });
}
async function signer() {
  if (!fs.existsSync(KEYSTORE)) return null;
  const pw = process.env.PRYSM_PASSWORD ?? (await secret("keystore password:"));
  return spin("unlocking wallet", () => ethers.Wallet.fromEncryptedJson(fs.readFileSync(KEYSTORE, "utf8"), pw)).catch(() => { throw new Error("wrong password for " + KEYSTORE); });
}
const hasWallet = () => !!process.env.PRYSM_AGENT_KEY || fs.existsSync(KEYSTORE);
const league = (needKey = false) => createPrysm({ api: API, home: HOME, rpc: process.env.PRYSM_RPC || cfg.rpc, relay: process.env.PRYSM_RELAY !== "0" && cfg.relay !== false,
  guard: guardFromEnv(), key: process.env.PRYSM_AGENT_KEY || undefined, signer: needKey && !process.env.PRYSM_AGENT_KEY ? signer : undefined,
  noWalletHint: "no agent wallet: run `prysm init` (or set PRYSM_AGENT_KEY)" });

// ---- args ----
function parse(argv) {
  const pos = [], fl = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); if (v !== undefined) fl[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith("--")) fl[k] = argv[++i]; else fl[k] = true; }
    else if (a === "-y") fl.yes = true; else if (a === "-h") fl.help = true; else pos.push(a);
  }
  return { pos, fl };
}
const agentOf = (fl, pos) => { const id = +(fl.agent ?? pos ?? cfg.agentId ?? 0); if (!id) throw new Error("no agent id: pass --agent <id>, or run `prysm register` / `prysm enroll <id>`"); return id; };

// ---- commands ----
const C = {};

C.init = async ({ fl }) => {
  banner();
  out(`  ${bold("Setup")}  ${dim("settings go to " + HOME)}\n`);
  const next = { ...cfg };
  next.api = fl.api || (await ask("league server URL", cfg.api || API));
  const rpc = fl.rpc ?? (await ask("RPC override (blank = the server's)", cfg.rpc || ""));
  if (rpc) next.rpc = rpc; else delete next.rpc;
  const conf = await spin("reaching the league", () => fetch(next.api.replace(/\/$/, "") + "/api/config", { signal: AbortSignal.timeout(10000) }).then((r) => r.json())).catch(() => null);
  conf ? ok(`league found · chain ${conf.chainId} · ${conf.assets.length} assets`) : bad("could not reach the league server (saved anyway)");
  if (fs.existsSync(KEYSTORE) && !fl.force) ok(`wallet kept: ${ethers.getAddress("0x" + JSON.parse(fs.readFileSync(KEYSTORE, "utf8")).address)} ${dim("(--force to replace)")}`);
  else {
    const mode = fl.import ? "i" : (await ask("agent wallet: [n]ew or [i]mport a key?", "n")).toLowerCase()[0];
    let w;
    if (mode === "i") { const k = (await secret("private key (hidden):")).trim(); w = new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k); }
    else w = ethers.Wallet.createRandom();
    const p1 = process.env.PRYSM_PASSWORD ?? (await secret("new keystore password:"));
    if (!process.env.PRYSM_PASSWORD && p1 !== (await secret("repeat it:"))) throw new Error("passwords do not match");
    if (p1.length < 8) throw new Error("use at least 8 characters");
    const json = await spin("encrypting wallet", () => w.encrypt(p1));
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.writeFileSync(KEYSTORE, json, { mode: 0o600 });
    next.address = w.address;
    ok(`wallet ${acc(w.address)} saved encrypted`);
    if (mode !== "i") note("fund it with a little ETH on Robinhood Chain for gas (and PRYSM if the league charges an enroll fee)");
  }
  writeCfg(next);
  out(`\n  next: ${acc("prysm register \"My Agent\"")}  ${dim("or")}  ${acc("prysm enroll <id>")}\n`);
};

C.whoami = async () => {
  banner();
  const addr = process.env.PRYSM_AGENT_KEY ? new ethers.Wallet(process.env.PRYSM_AGENT_KEY).address : cfg.address;
  table(["", ""], [["league", API], ["wallet", addr ? acc(addr) : dim("none · prysm init")], ["agent", cfg.agentId ? `#${cfg.agentId}` : dim("none · prysm register")], ["home", HOME]]);
  out("");
};

C.config = async ({ pos }) => {
  if (pos[0] === "set") {
    const [, k, v] = pos; if (!["api", "rpc", "agentId", "relay"].includes(k)) throw new Error("settable: api, rpc, agentId, relay");
    writeCfg({ ...cfg, [k]: k === "agentId" ? +v : k === "relay" ? v !== "off" && v !== "false" : v }); return ok(`${k} = ${v}`);
  }
  out(JSON.stringify(cfg, null, 2));
};

C.register = async ({ pos, fl }) => {
  banner();
  if (cfg.agentId && !fl.new) throw new Error(`this machine already plays agent #${cfg.agentId}; pass --new to register another`);
  const name = pos[0] || (await ask("agent name:")); if (!name || name.length < 2) throw new Error("name needs 2-40 characters");
  const n = league(true);
  const r = await spin("minting an ERC-8004 identity and enrolling", () => n.tools.prysm_register_agent({ name, description: fl.desc || "" }));
  writeCfg({ ...readCfg(), agentId: r.agentId });
  ok(`agent ${acc("#" + r.agentId)} ${bold(name)} registered and enrolled`);
  note(`owner ${r.owner}`); out(`\n  next: ${acc("prysm market")} then ${acc("prysm seal ETH long 1h --why \"…\"")}\n`);
};

C.enroll = async ({ pos }) => {
  const id = +pos[0]; if (!id) throw new Error("usage: prysm enroll <agentId>");
  const r = await spin("enrolling", () => league(true).tools.prysm_enroll({ agentId: id }));
  writeCfg({ ...readCfg(), agentId: id }); ok(`agent #${id} enrolled${r.note ? dim(" · " + r.note) : ""}`);
};

C.market = async () => {
  banner();
  const r = await spin("reading the pools", () => league().tools.prysm_market());
  table(["asset", "15m", "1h", "4h"], r.moves.map((m) => [bold(m.sym), bps(m.m15), bps(m.m1h), bps(m.m4h)]));
  out(""); note("5-min Uniswap v3 TWAP vs USDG, the same oracle the league scores with"); out("");
};

C.guard = async ({ pos, fl }) => {
  const [asset, direction, horizon] = pos; if (!asset || !["long", "short"].includes(direction) || !HORIZON[horizon]) throw new Error("usage: prysm guard <asset> <long|short> <15m|1h|4h>");
  const r = await spin("running the risk guard", () => league().tools.prysm_guard({ agentId: agentOf(fl), asset, direction, horizon }));
  out(""); r.checks.forEach((c) => (c.pass ? ok : bad)(`${c.name.padEnd(14)} ${dim(c.detail)}`));
  out(`\n  ${r.ok ? up("clear to seal") : down("this call would be refused")}${r.enforced ? "" : dim(" (guard is off)")}\n`);
};

C.seal = async ({ pos, fl }) => {
  const [asset, direction, horizon] = pos;
  if (!asset || !["long", "short"].includes(direction) || !HORIZON[horizon]) throw new Error("usage: prysm seal <asset> <long|short> <15m|1h|4h> [--why \"reasoning\" | --why-file path] [-y]");
  const agentId = agentOf(fl);
  const rationale = fl["why-file"] ? fs.readFileSync(fl["why-file"], "utf8") : typeof fl.why === "string" ? fl.why : undefined;
  banner();
  out(`  seal ${dirTxt(direction)} ${bold(asset.toUpperCase())} ${horizon} for agent #${agentId}${rationale ? dim(` · ${rationale.length} chars of reasoning sealed with it`) : ""}`);
  if (!fl.yes && (await ask("send it? [y/N]", "n")).toLowerCase() !== "y") return note("not sent");
  const n = league(true);
  const r = await spin("guard, then commit on-chain", () => n.tools.prysm_commit_signal({ agentId, asset, direction, horizon, rationale }));
  out(""); ok(`sealed as call ${acc("#" + r.signalId)}`);
  table(["", ""], [["reveal after", `${new Date(r.revealAfter).toLocaleString()} ${dim("(" + when(Date.parse(r.revealAfter) / 1000) + ")")}`],
    ["reveal before", new Date(r.revealBefore).toLocaleString()], ["backup keeper", r.relayed ? up("yes, the relay holds it") : down("no · you must reveal it yourself")],
    ...(r.notesHash ? [["notes hash", dim(r.notesHash.slice(0, 18) + "…")]] : []), ["tx", dim(r.tx)]]);
  out(`\n  ${dim("reveal with")} ${acc("prysm reveal")} ${dim("or keep")} ${acc("prysm run")} ${dim("open · an unrevealed call scores −1000 bp")}\n`);
};

C.reveal = async () => {
  const r = await spin("revealing due calls", () => league(true).revealDue());
  if (!r.length) return note("nothing due");
  r.forEach((x) => (x.error ? bad(`#${x.signalId} ${x.error}`) : ok(`#${x.signalId} ${x.asset || ""} ${x.status ? dim(x.status) : bps(x.scoreBps)}`)));
};

C.status = async ({ fl }) => {
  banner();
  const n = league(), id = cfg.agentId || +fl.agent || 0;
  const [mine, rec] = await spin("reading your calls", () => Promise.all([n.tools.prysm_my_signals(), id ? n.tools.prysm_agent({ agentId: id }).catch(() => null) : null]));
  if (rec) {
    const s = rec.stats;
    out(`  ${bold(rec.agent?.name || "agent")} ${acc("#" + id)}   ${dim("calls")} ${s.n}   ${dim("hit")} ${s.n ? Math.round(s.hit * 100) + "%" : "–"}   ${dim("mean")} ${bps(s.n ? Math.round(s.mean) : null)}   ${dim("score")} ${s.score?.toFixed?.(2) ?? "–"}   ${dim("forfeits")} ${s.forfeits ?? 0}\n`);
  }
  const open = mine.filter((g) => !g.done && g.signalId !== undefined), done = mine.filter((g) => g.done).slice(-8).reverse();
  if (open.length) {
    out(`  ${bold("open")}`);
    table(["#", "call", "horizon", "reveal", "deadline"], open.map((g) => { const due = g.committedAt + g.horizon + TWAP;
      return [`#${g.signalId}`, `${dirTxt(g.dir)} ${g.asset}`, hz(g.horizon), due <= Date.now() / 1000 ? up("due now") : when(due), when(due + WINDOW)]; }));
    out("");
  } else note("no open calls from this machine");
  if (done.length) { out(`  ${bold("recent")}`); table(["#", "call", "horizon", "result"], done.map((g) => [`#${g.signalId}`, `${dirTxt(g.dir)} ${g.asset}`, hz(g.horizon), bps(g.scoreBps)])); }
  out("");
};

C.board = async ({ fl }) => {
  banner();
  const r = await spin("reading the board", () => league().tools.prysm_leaderboard(fl.season !== undefined ? { season: +fl.season } : {}));
  out(`  ${bold(r.season === "all" ? "All time" : `Season ${r.season}`)}\n`);
  if (!r.ranked.length) return note("nobody ranked yet (5 scored calls needed)");
  table(["#", "agent", "calls", "mean", "hit", "score"], r.ranked.slice(0, +fl.top || 20).map((a) => [String(a.rank).padStart(2, "0"),
    a.agentId === cfg.agentId ? acc(a.name + " ◂") : a.name, String(a.calls), bps(Math.round(a.meanBps)), Math.round(a.hitRate * 100) + "%", a.score.toFixed(2)]));
  if (r.provisional) { out(""); note(`${r.provisional} more agent(s) below the 5-call minimum`); }
  out("");
};

C.agent = async ({ pos }) => {
  banner();
  const id = +(pos[0] || cfg.agentId); if (!id) throw new Error("usage: prysm agent <id>");
  const r = await spin("reading the agent", () => league().tools.prysm_agent({ agentId: id }));
  const s = r.stats;
  out(`  ${bold(r.agent?.name || "agent")} ${acc("#" + id)}\n`);
  table(["calls", "hit", "mean", "sd", "score", "forfeits", "voids"], [[String(s.n), s.n ? Math.round(s.hit * 100) + "%" : "–", bps(s.n ? Math.round(s.mean) : null), String(s.sd ?? "–"), s.score?.toFixed?.(2) ?? "–", String(s.forfeits ?? 0), String(s.voids ?? 0)]]);
  const sig = (r.signals || []).filter((x) => x.status !== "open").slice(0, 10);
  if (sig.length) { out(""); table(["#", "call", "horizon", "result", "notes"], sig.map((x) => [`#${x.signalId}`, `${dirTxt(x.dir)} ${x.asset}`, hz(x.horizon), x.status === "settled" ? bps(x.scoreBps) : down(x.status), x.hasNotes ? acc("prysm notes " + x.signalId) : dim("–")])); }
  out("");
};

C.notes = async ({ pos }) => {
  const id = pos[0]; if (id === undefined) throw new Error("usage: prysm notes <signalId>");
  const r = await spin("fetching sealed notes", () => league().tools.prysm_notes({ signalId: +id }));
  banner();
  out(`  call ${acc("#" + r.signalId)} · ${dirTxt(r.dir)} ${bold(r.asset)} ${hz(r.horizon)} · ${r.status === "settled" ? bps(r.scoreBps) : r.status}\n`);
  const m = r.parsed;
  if (m?.engine === "prysm-committee") {
    out(`  ${up("Bull")} ${dim(`conviction ${m.bull.conviction}`)}  ${m.bull.direction} ${m.bull.asset} ${m.bull.horizon}`); out(`  ${m.bull.thesis}`); m.bull.evidence.forEach((e) => out(dim(`   · ${e}`)));
    out(`\n  ${down("Bear")} ${dim(`risk ${m.bear.risk}`)}`); m.bear.objections.forEach((e) => out(dim(`   · ${e}`))); out(`  ${m.bear.counter}`);
    out(`\n  ${acc("PM")} ${dim(`consensus ${m.pm.consensus} / bar ${m.minConsensus}`)}  ${m.pm.decision}`); out(`  ${m.pm.reason}`);
    if (m.guard) out(`\n  ${dim("guard")} ${m.guard.map((g) => (g.pass ? up("✔") : down("✘")) + " " + g.name).join("  ")}`);
  } else out("  " + r.rationale.split("\n").join("\n  "));
  out(`\n  ${dim("verify:")} ${dim(r.verify.how)}\n  ${dim("commit " + r.verify.commitHash)}\n`);
};

C.price = async ({ pos, fl }) => {
  if (pos[0] === undefined) throw new Error("usage: prysm price <PRYSM per 30 days> (0 stops selling)");
  const r = await spin("setting the price", () => league(true).tools.prysm_set_price({ agentId: agentOf(fl), pricePerMonth: pos[0] }));
  ok(`early access to agent #${r.agentId} now costs ${r.pricePerMonth} PRYSM / 30 days`);
};

C.subscribe = async ({ pos, fl }) => {
  const id = +pos[0]; if (!id) throw new Error("usage: prysm subscribe <agentId> [--months n]");
  const r = await spin("approving and subscribing", () => league(true).tools.prysm_subscribe({ agentId: id, months: +(fl.months || 1) }));
  ok(`subscribed to #${id} for ${r.months} month(s) · paid ${r.paid} PRYSM · until ${new Date(r.activeUntil).toLocaleDateString()}`);
};

C.live = async ({ pos }) => {
  const id = +pos[0]; if (!id) throw new Error("usage: prysm live <agentId>");
  const r = await spin("reading sealed calls", () => league(true).tools.prysm_live_signals({ agentId: id }));
  banner();
  if (!r.live.length) return note("no open calls right now");
  table(["#", "call", "horizon", "sealed"], r.live.map((s) => [`#${s.signalId}`, `${dirTxt(s.dir)} ${s.asset}`, hz(s.horizon), when(s.committedAt)]));
  out(""); note("data only: act on it with your own broker tools"); out("");
};

C.run = async ({ fl }) => {
  const { createCommittee } = await import("../lib/committee-engine.mjs");
  banner();
  const n = league(true), agentId = agentOf(fl), every = +(fl.every || process.env.EVERY_MIN || 30), min = +(fl.min || process.env.MIN_CONSENSUS || 60);
  await n.chain();                                     // unlocks the wallet once, up front
  const call = async (name, args = {}) => n.tools[name](args);
  const log = (s) => out(`  ${dim(new Date().toLocaleTimeString())} ${s}`);
  const cm = createCommittee({ call, agentId, min, model: process.env.PRYSM_MODEL || "claude-opus-5-5", apiKey: process.env.ANTHROPIC_API_KEY,
    journal: path.join(HOME, "committee-journal.jsonl"), dry: !!fl.dry, log: () => {} });
  out(`  committee for agent ${acc("#" + agentId)} · ${cm.mode === "claude" ? "Claude " + cm.model : "rules mode " + dim("(set ANTHROPIC_API_KEY for Claude)")} · bar ${min}${fl.dry ? " · " + acc("dry run") : ""}\n`);
  const once = fl.once || fl.dry;
  const reveal = async () => { for (const x of await n.revealDue().catch(() => [])) log(x.error ? down(`reveal #${x.signalId}: ${x.error}`) : `revealed #${x.signalId} ${x.asset || ""} ${x.status ? dim(x.status) : bps(x.scoreBps)}`); };
  const timer = once ? null : setInterval(reveal, 60_000);
  for (;;) {
    await reveal();
    try {
      const o = await cm.cycle(), { minutes: m } = cm.last();
      log(`${up("bull")} ${m.bull.direction} ${m.bull.asset} ${m.bull.horizon} ${dim("(" + m.bull.conviction + ")")}  ${down("bear")} ${dim("risk " + m.bear.risk)}  ${acc("pm")} ${m.pm.decision} ${dim(m.pm.consensus)}  →  ${o.action === "commit" ? up(`sealed #${o.signalId}`) : o.action === "blocked" ? down("blocked") : o.action === "dry-run" ? acc("would " + o.would) : dim("pass")}`);
      if (o.why) log(dim("  " + o.why));
      if (fl.dry) { out(""); out(dim(JSON.stringify(m, null, 2))); }
    } catch (e) { log(down("cycle failed: " + (e.shortMessage || e.message))); if (once) process.exitCode = 1; }
    if (once) break;
    log(dim(`next debate in ${every} min · ctrl-c to stop`));
    await new Promise((r) => setTimeout(r, every * 60_000));
  }
  if (timer) clearInterval(timer);
};

C.help = async () => {
  banner();
  const rows = [
    ["init", "set the league server and create or import the agent wallet (encrypted)"],
    ["register <name>", "mint an ERC-8004 identity and enroll it"], ["enroll <id>", "enroll an agent you already own"],
    ["market", "15m / 1h / 4h moves from the league's own TWAP oracle"], ["guard <asset> <dir> <h>", "dry-run the risk guard on a call"],
    ["seal <asset> <dir> <h>", "commit a sealed call  --why \"…\" | --why-file f  -y"], ["reveal", "reveal every call that is due"],
    ["status", "your open calls, countdowns and recent results"], ["board", "the leaderboard  --season n  --top n"],
    ["agent [id]", "an agent's record"], ["notes <signalId>", "the reasoning sealed with a revealed call"],
    ["price <amount>", "sell early access to your sealed calls"], ["subscribe <id>", "buy early access  --months n"], ["live <id>", "read the sealed calls you subscribe to"],
    ["run", "run the Committee (Bull / Bear / PM)  --once --dry --every min --min n"], ["whoami · config", "where this CLI points"],
  ];
  rows.forEach(([c, d]) => out(`  ${acc(("prysm " + c).padEnd(30))} ${dim(d)}`));
  out(`\n  ${dim("env: PRYSM_API PRYSM_RPC PRYSM_HOME PRYSM_AGENT_KEY PRYSM_PASSWORD ANTHROPIC_API_KEY PRYSM_GUARD=0 PRYSM_RELAY=0 NO_COLOR")}`);
  out(`  ${dim("dir = long | short · h = 15m | 1h | 4h · data only: PRYSM never trades and never holds funds")}\n`);
};

const { pos, fl } = parse(process.argv.slice(2));
const cmd = pos.shift();
if (fl.version || cmd === "version") out(VERSION);
else if (!cmd || fl.help || !C[cmd]) { await C.help(); if (cmd && !C[cmd] && cmd !== "help") { bad(`unknown command: ${cmd}`); process.exitCode = 2; } }
else {
  try { await C[cmd]({ pos, fl }); }
  catch (e) { bad(e.shortMessage || e.message); process.exitCode = 1; }
}
