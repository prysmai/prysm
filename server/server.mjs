// PRYSM server: indexes the SignalBook, serves the league API and the site, relays sealed signals, runs the reveal keeper.
// Before the league contracts are deployed (no deployment file) it runs the studio, /api/token and /api/burns only.
// env: RPC, DEPLOYMENT, PORT, PRYSM_CONFIG, KEEPER_KEY (optional: a funded hot wallet that only ever calls reveal)
// studio env (server/.env): STUDIO_KEY, PRYSM_SECRET (both generated when missing), RPC_URL, BURN_MAX_USD, BURN_DAY_USD
import "./lib/env.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { ethers } from "ethers";
import { loadConfig, connect, ROOT, ASSETS } from "./lib/chain.mjs";
import { Indexer } from "./lib/indexer.mjs";
import { Relay } from "./lib/relay.mjs";
import { Notes } from "./lib/notes.mjs";
import { leaderboard, agentStats, seasonOf } from "./lib/score.mjs";
import { keyMatches, createSettings } from "./lib/studio.mjs";
import { createBurn } from "./lib/burn.mjs";
import { createBurns } from "./lib/burns.mjs";
import * as P from "./lib/pons.mjs";

const cfg = loadConfig(), LEAGUE = !!cfg.dep, chain = LEAGUE ? connect(cfg) : null, DATA = process.env.PRYSM_DATA ? path.resolve(process.env.PRYSM_DATA) : path.join(ROOT, "data");
fs.mkdirSync(path.join(DATA, "seasons"), { recursive: true });
const idx = LEAGUE && new Indexer(chain, cfg, DATA), relay = LEAGUE && new Relay(chain, cfg, DATA), notes = LEAGUE && new Notes(chain, cfg, DATA);
const keeper = LEAGUE && process.env.KEEPER_KEY ? new ethers.Wallet(process.env.KEEPER_KEY, chain.provider) : null;
const epochMs = Date.parse(cfg.seasonEpoch), days = cfg.seasonDays, SITE = path.resolve(ROOT, cfg.site);
// the oracle pools as the SignalBook actually has them (the source of truth, not the shared list)
let BOOK_ASSETS = ASSETS.map(({ id, sym, pool, invert }) => ({ id, sym, pool, invert }));
async function loadBookAssets() {
  const n = Number(await chain.book.assetCount()), out = [];
  for (let i = 0; i < n; i++) { const a = await chain.book.assets(i); if (a.active) out.push({ id: i, sym: a.symbol, pool: a.pool, invert: a.invert }); }
  BOOK_ASSETS = out;
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8" };

function serveStatic(req, res, p) {
  let f = path.normalize(path.join(SITE, decodeURIComponent(p)));
  if (!f.startsWith(SITE)) return json(res, 403, { error: "forbidden" });
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f) && fs.existsSync(f + ".html")) f += ".html";
  if (!fs.existsSync(f)) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
  const st = fs.statSync(f), type = MIME[path.extname(f)] || "application/octet-stream", range = req.headers.range;
  const cache = /\/media\//.test(f) ? "public, max-age=604800" : "no-cache";
  if (range && /^bytes=/.test(range)) {    // video needs byte ranges (Safari refuses to play without them)
    const [a, b] = range.slice(6).split("-"), start = +a || 0, end = b ? Math.min(+b, st.size - 1) : st.size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${st.size}`, "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": cache });
    return fs.createReadStream(f, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes", "cache-control": cache });
  fs.createReadStream(f).pipe(res);
}

const body = (req) => new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 40000) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { no(e); } }); });
// behind nginx every request comes from loopback: trust its X-Real-IP only then
const ip = (req) => { const a = req.socket.remoteAddress || ""; return /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(a) && req.headers["x-real-ip"] ? String(req.headers["x-real-ip"]) : a; };
const hits = new Map();
const limited = (req, n = 60) => { const k = ip(req), now = Date.now(), h = (hits.get(k) || []).filter((t) => now - t < 60000); h.push(now); hits.set(k, h); return h.length > n; };

// sealed notes stay sealed while the call is open; afterwards the list shows a one-line summary (full text at /api/notes/:id)
function publicSignal(s) {
  const n = s.status !== "open" && notes.raw(s.id);
  return { ...s, hasNotes: notes.has(s.id), ...(n ? { notes: Notes.summary(n.rationale) } : {}) };
}
const currentSeason = () => seasonOf(Date.now() / 1000, epochMs, days);

// ---------- studio: $PRYSM CA, buyback & burn, supply burn (owner only, x-studio-key) ----------
const settings = createSettings(DATA, { token: "" });
const burn = createBurn({ dir: DATA, token: () => settings.data.token });
const burns = createBurns({ dir: DATA });
const isStudio = (req) => keyMatches(req.headers["x-studio-key"], process.env.STUDIO_KEY);
const studioState = async () => ({ token: settings.data.token || null, burn: await burn.view(), explorer: P.EXPLORER });
const burnHits = new Map();
async function studioApi(req, res, p) {
  if (!isStudio(req)) { if (limited(req, 20)) return json(res, 429, { error: "slow down" }); return json(res, 401, { error: "Studio key required." }); }
  if (p === "/api/studio/state" && req.method === "GET") return json(res, 200, await studioState());
  if (p === "/api/studio/token" && req.method === "POST") {
    const t = String((await body(req)).token || "").trim();
    if (t && !ethers.isAddress(t)) return json(res, 400, { error: "That is not a contract address." });
    if (t) {
      let rec; try { rec = await P.deadline(P.withRetry(() => P.launched(t)), 25_000); }
      catch (e) { return json(res, 503, { error: P.rpcMessage(e, "Could not read the Pons factory right now. Try again in a minute.") }); }
      if (!rec) return json(res, 400, { error: "That address is not a Pons token on Robinhood Chain." });
    }
    settings.data.token = t ? ethers.getAddress(t) : ""; settings.save();
    return json(res, 200, await studioState());
  }
  if (p === "/api/studio/burn" && req.method === "POST") {
    try {
      const b = await body(req);
      if ("privateKey" in b) await burn.setKey(b.privateKey);
      else if (b.usd !== undefined) { const done = await burn.run(b.usd); burns.invalidate(settings.data.token); return json(res, 200, { ...(await studioState()), done }); }
      else if (b.supplyUsd !== undefined) { const done = await burn.supply(b.supplyUsd); burns.invalidate(settings.data.token); return json(res, 200, { ...(await studioState()), done }); }
      return json(res, 200, await studioState());
    } catch (e) {
      if (typeof e.code === "number" && e.code >= 400 && e.code < 600) return json(res, e.code, { error: e.message });
      return json(res, 502, { error: P.isBusy(e) ? P.BUSY : e.shortMessage || e.message || "The burn failed." });
    }
  }
  return json(res, 404, { error: "no such studio endpoint" });
}
// public: the CA once it is set, and every burn of it read from the chain (?token= previews another one, rate limited)
async function tokenApi(req, res, p, url) {
  if (p === "/api/token") return json(res, 200, { token: settings.data.token || null, symbol: "PRYSM", chainId: P.CHAIN_ID, explorer: P.EXPLORER });
  const q = String(url.searchParams.get("token") || "").trim(), t = q || settings.data.token;
  if (!t) return json(res, 200, { token: null, items: [], count: 0 });
  if (!P.isAddr(t)) return json(res, 400, { error: "That is not a contract address." });
  if (q) { const k = ip(req), a = (burnHits.get(k) || []).filter((x) => Date.now() - x < 60_000); if (a.length >= 6) return json(res, 429, { error: "Six checks a minute." }); burnHits.set(k, [...a, Date.now()]); }
  try {
    const v = await Promise.race([burns.get(t), new Promise((r) => setTimeout(() => r(null), 25_000))]);
    return json(res, 200, v || { token: t.toLowerCase(), scanning: true, items: [], count: 0, note: "Reading the chain from the launch block. This takes a minute the first time." });
  } catch (e) { return json(res, 502, { error: P.rpcMessage(e, "Could not read the burns from Robinhood Chain.") }); }
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p.startsWith("/api/studio/")) return studioApi(req, res, p);
  if (p === "/api/token" || p === "/api/burns") return tokenApi(req, res, p, url);
  if (!LEAGUE) return json(res, 503, { error: "The league opens at launch.", league: false });
  const sigs = idx.signals(), agents = idx.state.agents;
  if (p === "/api/config") return json(res, 200, { chainId: cfg.dep.chainId, rpc: cfg.rpc, contracts: { signalBook: cfg.dep.signalBook, league: cfg.dep.league, subscriptions: cfg.dep.subscriptions, identity: cfg.dep.identity, reputation: cfg.dep.reputation, token: cfg.dep.token },
    assets: BOOK_ASSETS, horizons: [900, 3600, 14400], season: { current: currentSeason(), epoch: cfg.seasonEpoch, days }, minSignals: cfg.minSignals, keeper: !!keeper });
  if (p === "/api/stats") {
    const settled = sigs.filter((s) => s.status === "settled");
    return json(res, 200, { agents: Object.keys(agents).length, signals: sigs.length, open: sigs.filter((s) => s.status === "open").length, settled: settled.length,
      forfeited: sigs.filter((s) => s.status === "forfeited").length, lastBlock: idx.state.lastBlock, season: currentSeason() });
  }
  if (p === "/api/leaderboard") {
    const season = url.searchParams.get("season");
    const lb = leaderboard(agents, sigs, { minSignals: cfg.minSignals, season: season === null ? null : +season, epochMs, days });
    return json(res, 200, { season: season === null ? "all" : +season, ...lb });
  }
  let m;
  if ((m = p.match(/^\/api\/agent\/(\d+)$/))) {
    const a = agents[m[1]]; if (!a) return json(res, 404, { error: "unknown agent" });
    const mine = sigs.filter((s) => s.agentId === a.id).sort((x, y) => y.id - x.id);
    const price = await chain.subs.price(a.id).catch(() => 0n);
    return json(res, 200, { agent: a, stats: agentStats(mine), seasonStats: agentStats(mine.filter((s) => s.settledAt && seasonOf(s.settledAt, epochMs, days) === currentSeason())),
      subscriptionPrice: price.toString(), signals: mine.slice(0, 200).map(publicSignal) });
  }
  if (p === "/api/signals") {
    const n = Math.min(200, +(url.searchParams.get("limit") || 50));
    return json(res, 200, sigs.sort((x, y) => (y.settledAt || y.committedAt) - (x.settledAt || x.committedAt)).slice(0, n).map((s) => ({ ...publicSignal(s), agentName: agents[s.agentId]?.name })));
  }
  if ((m = p.match(/^\/api\/season\/(\d+)$/))) {
    const f = path.join(DATA, "seasons", `${m[1]}.json`);
    return fs.existsSync(f) ? json(res, 200, JSON.parse(fs.readFileSync(f))) : json(res, 404, { error: "season not built yet" });
  }
  if (p === "/api/relay" && req.method === "POST") {
    if (limited(req, 30)) return json(res, 429, { error: "slow down" });
    try {
      const b = await body(req), s = await relay.submit(b);
      if (b.rationale) await notes.submit(b);
      return json(res, 200, { ok: true, signalId: s.signalId, keeper: !!keeper, notes: !!b.rationale });
    } catch (e) { return json(res, 400, { error: e.shortMessage || e.message }); }
  }
  if (p === "/api/notes" && req.method === "POST") {
    if (limited(req, 30)) return json(res, 429, { error: "slow down" });
    try { const n = await notes.submit(await body(req)); return json(res, 200, { ok: true, signalId: n.signalId, notesHash: n.notesHash }); }
    catch (e) { return json(res, 400, { error: e.shortMessage || e.message }); }
  }
  if ((m = p.match(/^\/api\/notes\/(\d+)$/))) {
    const n = notes.raw(m[1]), s = idx.state.signals[m[1]];
    if (!n) return json(res, 404, { error: "no notes for this call" });
    if (!s || s.status === "open") return json(res, 403, { error: "sealed until the call is revealed" });
    let parsed = null; try { parsed = JSON.parse(n.rationale); } catch {}
    return json(res, 200, { signalId: n.signalId, agentId: n.agentId, status: s.status, asset: s.asset, dir: s.dir, horizon: s.horizon, scoreBps: s.scoreBps,
      rationale: n.rationale, parsed, verify: { nonce: n.nonce, notesHash: n.notesHash, salt: n.salt, commitHash: n.commitHash,
        how: "salt = keccak256(abi.encode(nonce, keccak256(utf8(rationale)))); SignalBook.hashSignal(agentId, assetId, dir, horizon, salt) == commitHash" } });
  }
  if ((m = p.match(/^\/api\/live\/(\d+)$/))) {
    if (limited(req)) return json(res, 429, { error: "slow down" });
    const h = req.headers;
    if (!(await relay.canRead(+m[1], h["x-prysm-addr"], h["x-prysm-ts"], h["x-prysm-sig"]))) return json(res, 402, { error: "subscription required (sign 'PRYSM live <agentId> <unix ts>' with a subscribed wallet)" });
    return json(res, 200, { agentId: +m[1], live: (await relay.live(+m[1])).map((s) => ({ ...s, rationale: notes.raw(s.signalId)?.rationale ?? null })) });
  }
  return json(res, 404, { error: "no such endpoint" });
}

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-prysm-addr,x-prysm-ts,x-prysm-sig", "access-control-allow-methods": "GET,POST" }); return res.end(); }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname === "/agent" || url.pathname.startsWith("/agent/")) return serveStatic(req, res, "/agent.html");
    if (url.pathname === "/studio" || url.pathname === "/studio/") return serveStatic(req, res, "/studio.html");
    return serveStatic(req, res, url.pathname);
  } catch (e) { log("error", url.pathname, e.message); json(res, 500, { error: "internal" }); }
});

async function loop() {
  for (;;) {
    try { const r = await idx.sync(); if (r.changed) log(`indexed to ${r.head} (+${r.changed} events)`); } catch (e) { log("sync failed:", e.shortMessage || e.message); }
    try { await relay.keep(keeper, log); } catch (e) { log("keeper failed:", e.shortMessage || e.message); }
    await new Promise((r) => setTimeout(r, cfg.keeperIntervalSec * 1000));
  }
}

if (LEAGUE) await loadBookAssets().catch((e) => log("could not read assets from the SignalBook:", e.shortMessage || e.message));
srv.listen(cfg.port, () => {
  if (!LEAGUE) return log(`PRYSM on :${cfg.port} · studio and burn record only (no deployment file at ${cfg.deployment}: the league opens at launch)`);
  log(`PRYSM on :${cfg.port} · chain ${cfg.dep.chainId} · book ${cfg.dep.signalBook} · keeper ${keeper ? keeper.address : "off"}`); loop();
});
