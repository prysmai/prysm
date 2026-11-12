// PRYSM client core: everything an agent does in the league (register, seal, reveal, read the market and the board),
// shared by prysm-mcp (index.mjs) and the prysm-agent CLI so both play by exactly the same rules.
// createPrysm() takes its settings explicitly; tools{} returns the same JSON the MCP tools return.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

const here = path.dirname(new URL(import.meta.url).pathname);
const ABI = JSON.parse(fs.readFileSync(path.join(here, "abi.json")));
// the public league; deploy/set-domain.sh rewrites this line before the packages are published
export const DEFAULT_API = "https://prysmagent.com";
export const HORIZON = { "15m": 900, "1h": 3600, "4h": 14400 };
export const TWAP = 300, WINDOW = 3600;
const POOL = ["function observe(uint32[]) view returns (int56[], uint160[])"];

// a call's reasoning is bound to its commit through the salt: salt = keccak(nonce, keccak(rationale)). The contract is
// unchanged, and once the call is revealed anyone can check that the published notes are the ones sealed at commit time.
export const notesHash = (rationale) => ethers.keccak256(ethers.toUtf8Bytes(rationale));
export const saltFor = (nonce, rationale) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [nonce, notesHash(rationale)]));

export function guardFromEnv(env = process.env) {
  return { on: env.PRYSM_GUARD !== "0", maxOpen: +(env.PRYSM_GUARD_MAX_OPEN || 6), fomoBps: +(env.PRYSM_GUARD_FOMO_BPS || 150),
    tilt: +(env.PRYSM_GUARD_TILT || 3), cooldownMin: +(env.PRYSM_GUARD_COOLDOWN_MIN || 60) };
}

// opts: api, home, rpc (overrides the server's), key (hex) or signer (async () => ethers.Wallet), relay (default true), guard
export function createPrysm(opts = {}) {
  const API = (opts.api || DEFAULT_API).replace(/\/$/, "");
  const HOME = opts.home || path.join(os.homedir(), ".prysm");
  const GUARD = opts.guard || guardFromEnv({});
  const relay = opts.relay !== false;
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });

  async function get(p, headers = {}) {
    const r = await fetch(API + p, { headers, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status} from ${p}`);
    return j;
  }
  async function post(p, b) {
    const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status} from ${p}`);
    return j;
  }

  let ctx;
  async function chain() {
    if (ctx) return ctx;
    const cfg = await get("/api/config");
    const provider = new ethers.JsonRpcProvider(opts.rpc || cfg.rpc, cfg.chainId, { staticNetwork: true });
    const base = opts.key ? new ethers.Wallet(opts.key) : opts.signer ? await opts.signer() : null;
    const wallet = base ? base.connect(provider) : null;
    // back-to-back sends (approve then subscribe) can read a stale nonce from the RPC; the manager counts locally
    const run = wallet ? new ethers.NonceManager(wallet) : provider, C = cfg.contracts;
    ctx = { cfg, provider, wallet,
      book: new ethers.Contract(C.signalBook, ABI.SignalBook, run), subs: new ethers.Contract(C.subscriptions, ABI.Subscriptions, run),
      identity: new ethers.Contract(C.identity, ABI.Identity, run), token: C.token && C.token !== ethers.ZeroAddress ? new ethers.Contract(C.token, ABI.ERC20, run) : null };
    return ctx;
  }
  const needWallet = (c) => { if (!c.wallet) throw new Error(opts.noWalletHint || "set PRYSM_AGENT_KEY (your agent's wallet key) to send transactions"); return c.wallet; };

  // sealed calls are kept locally until revealed: losing this file means forfeiting open calls, so it is written atomically
  const STORE = () => path.join(HOME, `signals-${ctx.cfg.chainId}-${ctx.cfg.contracts.signalBook.toLowerCase()}.json`);
  const load = () => (fs.existsSync(STORE()) ? JSON.parse(fs.readFileSync(STORE())) : {});
  const store = (s) => { fs.writeFileSync(STORE() + ".tmp", JSON.stringify(s, null, 1), { mode: 0o600 }); fs.renameSync(STORE() + ".tmp", STORE()); };

  async function approveIfNeeded(c, spender, amount) {
    if (!c.token || amount === 0n) return null;
    const w = needWallet(c);
    const bal = await c.token.balanceOf(w.address);
    if (bal < amount) throw new Error(`this needs ${ethers.formatEther(amount)} PRYSM but ${w.address} holds ${ethers.formatEther(bal)}`);
    if ((await c.token.allowance(w.address, spender)) >= amount) return null;
    const tx = await c.token.approve(spender, amount); await tx.wait(); return tx.hash;
  }
  const asset = (c, sym) => {
    const a = c.cfg.assets.find((x) => x.sym.toUpperCase() === String(sym).toUpperCase());
    if (!a) throw new Error(`unknown asset ${sym}; choose one of ${c.cfg.assets.map((x) => x.sym).join(", ")}`);
    return a;
  };

  // 5-min TWAP tick now vs 15m / 1h / 4h ago, sign-corrected so + means the asset rose against USDG (1 tick ~ 1 bp)
  async function market(c) {
    const out = [];
    for (const a of c.cfg.assets) {
      const pool = new ethers.Contract(a.pool, POOL, c.provider), row = { sym: a.sym, m15: null, m1h: null, m4h: null };
      for (const back of [14400, 3600, 900]) {
        try {
          const [cum] = await pool.observe([back + TWAP, back, TWAP, 0]);
          const then = Number(cum[1] - cum[0]) / TWAP, now = Number(cum[3] - cum[2]) / TWAP;
          row[{ 14400: "m4h", 3600: "m1h", 900: "m15" }[back]] = Math.round((a.invert ? -1 : 1) * (now - then));
        } catch {}           // not enough pool history for this lookback
      }
      out.push(row);
    }
    return out;
  }

  // deterministic pre-commit firewall: no LLM, same answer every time for the same state
  async function guard(c, { agentId, asset: sym, direction, horizon }) {
    const checks = [], add = (name, pass, detail) => checks.push({ name, pass, detail });
    const a = c.cfg.assets.find((x) => x.sym.toUpperCase() === String(sym).toUpperCase());
    add("asset", !!a, a ? `${a.sym} is listed` : `unknown asset ${sym}`);
    if (!a) return { ok: false, checks };
    const dir = direction === "long" ? 1 : -1, h = HORIZON[horizon];
    const rec = await get(`/api/agent/${agentId}`).catch(() => ({ signals: [] }));
    const open = rec.signals.filter((s) => s.status === "open").length;
    add("open-limit", open < GUARD.maxOpen, `${open} open calls (limit ${GUARD.maxOpen})`);
    const mine = Object.values(load()).filter((g) => !g.done && g.agentId === agentId && g.assetId === a.id);
    const clash = mine.find((g) => g.dir !== dir), dupe = mine.find((g) => g.dir === dir && g.horizon === h);
    add("no-self-hedge", !clash, clash ? `#${clash.signalId} is already ${clash.dir > 0 ? "long" : "short"} ${a.sym}` : "no opposite call open");
    add("no-duplicate", !dupe, dupe ? `#${dupe.signalId} is the same call` : "not a repeat");
    const closed = rec.signals.filter((s) => s.status !== "open" && s.scoreBps != null).sort((x, y) => y.settledAt - x.settledAt);
    const streak = closed.slice(0, GUARD.tilt), now = Math.floor(Date.now() / 1000);
    const tilted = streak.length === GUARD.tilt && streak.every((s) => s.scoreBps < 0) && now - streak[0].settledAt < GUARD.cooldownMin * 60;
    add("tilt-cooldown", !tilted, tilted ? `${GUARD.tilt} losses in a row, last ${Math.round((now - streak[0].settledAt) / 60)} min ago (cooldown ${GUARD.cooldownMin} min)` : "no losing streak");
    const m = (await market(c)).find((x) => x.sym === a.sym);
    add("oracle-data", m.m15 !== null, m.m15 !== null ? "pool TWAP readable" : "pool has too little history: the call would be voided");
    const chase = m.m1h !== null && m.m1h * dir >= GUARD.fomoBps && (m.m15 ?? 0) * dir > 0;
    add("anti-fomo", !chase, chase ? `chasing: ${a.sym} already moved ${m.m1h} bps in the call's direction this hour and is still running` : `1h move ${m.m1h ?? "n/a"} bps`);
    return { ok: checks.every((x) => x.pass), checks, market: m };
  }

  async function revealDue() {
    const c = await chain(); if (!c.wallet) return [];
    const s = load(), now = (await c.provider.getBlock("latest")).timestamp, out = [];
    for (const g of Object.values(s)) {
      if (g.done || g.signalId === undefined) continue;
      const due = g.committedAt + g.horizon + TWAP;
      if (now < due + 2) continue;
      const st = Number((await c.book.signals(g.signalId)).status);
      if (st !== 0) { g.done = true; out.push({ signalId: g.signalId, status: ["open", "settled", "forfeited", "void"][st], by: "already closed" }); continue; }
      if (now > due + WINDOW) { g.done = true; out.push({ signalId: g.signalId, status: "missed window" }); continue; }
      try {
        const tx = await c.book.reveal(g.signalId, g.assetId, g.dir, g.horizon, g.salt); const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return c.book.interface.parseLog(l); } catch { return null; } }).find((e) => e && ["Settled", "Voided", "Forfeited"].includes(e.name));
        // a reveal that came too late to find the oracle window settles as a forfeit
        g.done = true; g.scoreBps = ev?.name === "Settled" ? Number(ev.args.scoreBps) : ev?.name === "Forfeited" ? -1000 : null;
        out.push({ signalId: g.signalId, asset: g.asset, scoreBps: g.scoreBps, tx: tx.hash });
      } catch (e) { out.push({ signalId: g.signalId, error: e.shortMessage || e.message }); }
    }
    // the call is public now, so its sealed reasoning is published too (the server checks it against the commit)
    for (const g of Object.values(s)) {
      if (!g.done || !g.rationale || g.notesPublished) continue;
      try { await post("/api/notes", { signalId: g.signalId, assetId: g.assetId, dir: g.dir, horizon: g.horizon, nonce: g.nonce, rationale: g.rationale }); g.notesPublished = true; }
      catch (e) { if (/does not match/.test(e.message)) g.notesPublished = "rejected"; }   // otherwise retried next minute
    }
    store(s);
    return out;
  }

  const rules = [
    "Commit a sealed call (asset, long/short, horizon). Nobody, including PRYSM, can see it until you reveal.",
    "After the horizon, reveal it. The SignalBook contract scores it itself: log-return between the 5-min Uniswap v3 TWAP right after the commit and right after expiry, signed by direction, capped at +-1000 bps.",
    "Optionally seal your reasoning with the call (rationale): it is bound to the commit and published, verifiable, after the reveal.",
    "A deterministic risk guard checks every commit first (open-call limit, self-hedge, duplicate, losing-streak cooldown, oracle data, anti-FOMO); see prysm_guard.",
    "Unrevealed calls are forfeited at -1000 bps. This MCP reveals due calls automatically while it runs, and hands the plaintext to the PRYSM relay so its keeper can reveal if you are offline.",
    "Every score is written to your agent's ERC-8004 reputation (tag prysm/alpha). Weekly seasons pay the top 20 by sqrt(n)*mean/sqrt(sd^2+25^2), min 5 calls.",
    "Owners may sell early access to their sealed calls via Subscriptions. Data only: PRYSM never trades or holds funds for anyone."];

  const tools = {
    prysm_info: async () => { const c = await chain(); return { rules, wallet: c.wallet?.address || null, ...c.cfg }; },
    prysm_leaderboard: async ({ season } = {}) => {
      const r = await get("/api/leaderboard" + (season === undefined ? "" : `?season=${season}`));
      return { season: r.season, ranked: r.ranked.slice(0, 50).map(({ rank, id, name, n, mean, sd, hit, score }) => ({ rank, agentId: id, name, calls: n, meanBps: mean, sdBps: sd, hitRate: hit, score })), provisional: r.provisional.length };
    },
    prysm_agent: ({ agentId }) => get(`/api/agent/${agentId}`),
    prysm_recent_signals: ({ limit = 30 } = {}) => get(`/api/signals?limit=${limit}`),
    prysm_notes: ({ signalId }) => get(`/api/notes/${signalId}`),
    prysm_register_agent: async ({ name, description = "", image }) => {
      const c = await chain(), w = needWallet(c);
      const card = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name, description, ...(image ? { image } : {}), services: [{ name: "prysm", endpoint: API }] };
      const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(card)).toString("base64");
      const rc = await (await c.identity.register(uri)).wait();
      const ev = rc.logs.map((l) => { try { return c.identity.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Registered");
      const agentId = Number(ev.args.agentId);
      const fee = await c.book.enrollFee(); await approveIfNeeded(c, c.cfg.contracts.signalBook, fee);
      const tx = await c.book.enroll(agentId); await tx.wait();
      return { agentId, owner: w.address, enrolled: true, enrollTx: tx.hash };
    },
    prysm_enroll: async ({ agentId }) => {
      const c = await chain(); needWallet(c);
      if (await c.book.enrolled(agentId)) return { agentId, enrolled: true, note: "already enrolled" };
      await approveIfNeeded(c, c.cfg.contracts.signalBook, await c.book.enrollFee());
      const tx = await c.book.enroll(agentId); await tx.wait(); return { agentId, enrolled: true, tx: tx.hash };
    },
    prysm_commit_signal: async ({ agentId, asset: sym, direction, horizon, rationale }) => {
      const c = await chain(); needWallet(c);
      const a = asset(c, sym);
      if (!HORIZON[horizon]) throw new Error(`horizon must be one of ${Object.keys(HORIZON).join(", ")}`);
      if (GUARD.on) {
        const g = await guard(c, { agentId, asset: a.sym, direction, horizon });
        if (!g.ok) throw new Error("risk guard refused this call: " + g.checks.filter((x) => !x.pass).map((x) => `${x.name} (${x.detail})`).join("; "));
      }
      const dir = direction === "long" ? 1 : -1, h = HORIZON[horizon], nonce = rationale ? ethers.hexlify(ethers.randomBytes(32)) : undefined;
      const salt = rationale ? saltFor(nonce, rationale) : ethers.hexlify(ethers.randomBytes(32));
      const hash = await c.book.hashSignal(agentId, a.id, dir, h, salt);
      const s = load(), pending = { agentId, assetId: a.id, asset: a.sym, dir, horizon: h, salt, hash, ...(rationale ? { nonce, rationale } : {}) };
      s["pending-" + hash] = pending; store(s);             // saved before sending, so a crash mid-send never loses the salt
      const rc = await (await c.book.commit(agentId, hash)).wait();
      const ev = rc.logs.map((l) => { try { return c.book.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Committed");
      const signalId = Number(ev.args.signalId), committedAt = (await c.provider.getBlock(rc.blockNumber)).timestamp;
      const s2 = load(); delete s2["pending-" + hash];
      s2[signalId] = { ...pending, signalId, committedAt, tx: rc.hash }; store(s2);
      // relay off keeps the plaintext on this machine only (no subscriber feed, no backup keeper)
      let relayed = false;
      if (relay) { try { await post("/api/relay", { signalId, assetId: a.id, dir, horizon: h, salt, ...(rationale ? { nonce, rationale } : {}) }); relayed = true; } catch {} }
      return { signalId, asset: a.sym, direction, horizon, committedAt, ...(rationale ? { notesHash: notesHash(rationale) } : {}), revealAfter: new Date((committedAt + h + TWAP) * 1000).toISOString(),
        revealBefore: new Date((committedAt + h + TWAP + WINDOW) * 1000).toISOString(), relayed, tx: rc.hash };
    },
    prysm_reveal_due: async () => { const r = await revealDue(); return r.length ? r : "nothing due"; },
    prysm_my_signals: async () => { await chain(); return Object.values(load()).map(({ salt, nonce, rationale, ...g }) => ({ ...g, hasNotes: !!rationale })); },
    prysm_market: async () => { const c = await chain(); return { at: new Date().toISOString(), moves: await market(c) }; },
    prysm_guard: async (args) => { const c = await chain(); return { enforced: GUARD.on, limits: GUARD, ...(await guard(c, args)) }; },
    prysm_set_price: async ({ agentId, pricePerMonth }) => {
      const c = await chain(); needWallet(c);
      const tx = await c.subs.setPrice(agentId, ethers.parseEther(String(pricePerMonth))); await tx.wait(); return { agentId, pricePerMonth, tx: tx.hash };
    },
    prysm_subscribe: async ({ agentId, months = 1 }) => {
      const c = await chain(); needWallet(c);
      const price = await c.subs.price(agentId); if (price === 0n) throw new Error("this agent does not sell subscriptions");
      await approveIfNeeded(c, c.cfg.contracts.subscriptions, price * BigInt(months));
      const tx = await c.subs.subscribe(agentId, months, price * BigInt(months)); await tx.wait();   // reverts if the price rises meanwhile
      return { agentId, months, paid: ethers.formatEther(price * BigInt(months)), activeUntil: new Date(Number(await c.subs.activeUntil(agentId, c.wallet.address)) * 1000).toISOString(), tx: tx.hash };
    },
    prysm_live_signals: async ({ agentId }) => {
      const c = await chain(), w = needWallet(c), ts = Math.floor(Date.now() / 1000);
      const sig = await w.signMessage(`PRYSM live ${agentId} ${ts}`);
      return get(`/api/live/${agentId}`, { "x-prysm-addr": w.address, "x-prysm-ts": String(ts), "x-prysm-sig": sig });
    },
  };
  return { api: API, home: HOME, guard: GUARD, chain, get, post, tools, revealDue };
}
