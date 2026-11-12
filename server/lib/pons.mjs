// Pons v2 on Robinhood Chain for the studio: contract addresses, ABIs, a pooled provider over the free public RPCs,
// retry / deadline helpers and the few reads the burn engine and the burn record need. Ported from XENON's pons.js.
// The league itself keeps its own provider (lib/chain.mjs); this one only serves $PRYSM and its Pons curve.
import { ethers } from "ethers";

export const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const FIRST_BLOCK = process.env.PONS_FIRST_BLOCK ? Number(process.env.PONS_FIRST_BLOCK) : 27_027_321; // the first TokenLaunched on Pons v2
export const LOG_WINDOW = 10_000_000; // the RPC caps a filtered log query at 10M blocks
export const ADDR = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  dead: "0x000000000000000000000000000000000000dEaD",
};

export const ABI = {
  factory: [
    "function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint256 initialLiquidity, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, bool exists))",
    "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  ],
  curve: [
    "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
    "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
    "function graduated() view returns (bool)",
    "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  ],
};

export const NETWORK = ethers.Network.from({ name: "robinhood", chainId: CHAIN_ID });

// ---------- RPC pool: free public endpoints, no API keys ----------
// Logs go to the official RPC (it takes wide ranges), plain reads rotate across the others and fall back to the
// official one, and a 429 cools only the endpoint that sent it. Extra endpoints: RPC_URLS=url1,url2.
// A local RPC_URL (anvil, a fork) is used alone, without the pool.
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(RPC);
const OFFICIAL_URL = "https://rpc.mainnet.chain.robinhood.com";
const POOL = LOCAL ? [RPC] : [...new Set([RPC, OFFICIAL_URL, ...(process.env.RPC_URLS || "").split(","), "https://robinhood.drpc.org",
  "https://4663.rpc.thirdweb.com", "https://robinhood-rpc.publicnode.com"].map((s) => s.trim()).filter(Boolean))];
const BATCH_CAP = (url) => (/drpc/.test(url) ? 3 : /thirdweb/.test(url) ? 25 : 40);
const ENDS = POOL.map((url) => ({ url, until: 0, cap: BATCH_CAP(url), official: url.includes("chain.robinhood.com"), archive: !/publicnode/.test(url) }));
const LOGS = [...ENDS.filter((e) => e.official), ...ENDS.filter((e) => !e.official && e.archive)];
const OTHERS = ENDS.filter((e) => !e.official), OFFICIALS = ENDS.filter((e) => e.official);
let turn = 0;
const readOrder = () => { const k = OTHERS.length ? turn++ % OTHERS.length : 0; return [...OTHERS.slice(k), ...OTHERS.slice(0, k), ...OFFICIALS]; };
const RATE_RX = /429|too many|rate.?limit|capacity|throttl/i;
/** ms until at least one endpoint is usable again (0 when any endpoint is free) */
export const cooldown = () => Math.max(0, Math.min(...ENDS.map((e) => e.until)) - Date.now());
const cool = (e, sec) => { e.until = Math.max(e.until, Date.now() + Math.min(120, Math.max(3, sec)) * 1000); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(e, payload) {
  if (Array.isArray(payload) && payload.length > e.cap) {
    const parts = []; for (let i = 0; i < payload.length; i += e.cap) parts.push(payload.slice(i, i + e.cap));
    return (await Promise.all(parts.map((part) => post(e, part)))).flat();
  }
  const r = await fetch(e.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  if (r.status === 429 || r.status >= 500) { cool(e, Number(r.headers.get("retry-after")) || 10); throw Object.assign(new Error(`server response ${r.status}`), { retryable: true }); }
  const j = await r.json(), arr = Array.isArray(j) ? j : [j];
  if (arr.some((x) => x?.error && RATE_RX.test(`${x.error.code} ${x.error.message}`))) { cool(e, 10); throw Object.assign(new Error("429 Too Many Requests"), { retryable: true }); }
  if (arr.some((x) => x?.error && /batch|free plan|keyless|upgrade|personal token|archive/i.test(x.error.message || ""))) throw Object.assign(new Error("endpoint plan limit"), { retryable: true });
  if (!Array.isArray(j) && j?.error && !("id" in j)) throw Object.assign(new Error(j.error.message || "endpoint error"), { retryable: true });
  return arr;
}
const transient = (err) => err.retryable || err.name === "TimeoutError" || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|aborted/i.test(err.message);
class PoolProvider extends ethers.JsonRpcProvider {
  async _send(payload) {
    const list = Array.isArray(payload) ? payload : [payload];
    const logs = list.some((p) => p.method === "eth_getLogs"), write = list.some((p) => p.method === "eth_sendRawTransaction");
    if (logs) {
      // the official RPC is the only free one that takes wide log ranges: wait for it (up to ~25 s) before falling back
      const off = LOGS[0];
      for (let i = 0; off?.official && i < 3; i++) {
        const wait = off.until - Date.now(); if (wait > 25_000) break; if (wait > 0) await sleep(wait + 50);
        try { return await post(off, payload); } catch (err) { if (!transient(err)) throw err; if (!err.retryable) cool(off, 5); }
      }
    }
    const order = logs ? LOGS.slice(1) : write ? LOGS : readOrder();
    const now = Date.now(), ready = order.filter((e) => e.until <= now), tryList = ready.length ? ready : order;
    let last;
    for (const e of tryList) {
      try { return await post(e, payload); }
      catch (err) { last = err; if (!transient(err)) throw err; if (!err.retryable) cool(e, 5); }
    }
    throw last || new Error("429 Too Many Requests");
  }
}
export const provider = LOCAL
  ? new ethers.JsonRpcProvider(RPC, NETWORK, { staticNetwork: NETWORK, batchMaxCount: 20 })
  : new PoolProvider(RPC, NETWORK, { staticNetwork: NETWORK, batchMaxCount: 20, batchStallTime: 30 });

// keep a few requests in flight, and none while every endpoint is cooling
let inflight = 0; const waiters = [];
export async function gate(fn) {
  while (cooldown() > 0) await sleep(Math.min(cooldown(), 2000) + 50);
  if (inflight >= 4) await new Promise((r) => waiters.push(r));
  inflight++; try { return await fn(); } finally { inflight--; const w = waiters.shift(); if (w) w(); }
}
export const BUSY = "Robinhood Chain's public RPC is not answering right now; this read was skipped. Try again in a minute.";
/** a hard time limit on any RPC-backed read, so a rate-limited RPC cannot hang a request */
export function deadline(promise, ms, message = BUSY) { let t; return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(message), { code: "rpc_busy" })), ms); })]).finally(() => clearTimeout(t)); }
export const isBusy = (e) => e?.code === "rpc_busy" || /429|Too Many|Rate Limit|server response 5\d\d|SERVER_ERROR|timeout|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(e?.shortMessage || e?.message || "");
export const rpcMessage = (e, fallback) => (isBusy(e) ? BUSY : (fallback || e?.message || "Read failed."));
export async function withRetry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await gate(fn); } catch (e) {
      last = e; const m = e.shortMessage || e.message || "";
      if (!/retry limit|429|coalesce|timeout|ECONNRESET|fetch failed|limit|Too Many|server response 5\d\d|SERVER_ERROR|bad response/i.test(m)) throw e;
      await sleep(Math.max(800 * 2 ** i, cooldown()));
    }
  }
  throw last;
}

export const factory = new ethers.Contract(ADDR.factory, ABI.factory, provider);
const factoryI = factory.interface;
const TOPIC_LAUNCHED = factoryI.getEvent("TokenLaunched").topicHash;
export const low = (a) => String(a || "").toLowerCase();
export const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim());

// ---------- logs, in chunks the RPC accepts ----------
const LIMIT_ERR = /coalesce|limit|too many|exceed|response size|timeout|10000|-32005|-32000/i;
/** getLogs that survives the RPC's size limits: splits the block range until it fits. */
export async function getLogs({ address, topics, fromBlock, toBlock }, depth = 0) {
  try { return await gate(() => provider.getLogs({ address, topics, fromBlock, toBlock })); }
  catch (e) {
    const msg = e.shortMessage || e.message || "", span = toBlock - fromBlock;
    if (/retry limit|429|Too Many/i.test(msg) && depth < 4) { await sleep(Math.max(2000 * (depth + 1), cooldown())); return getLogs({ address, topics, fromBlock, toBlock }, depth + 1); }
    if (depth > 12 || !LIMIT_ERR.test(msg) || span < 200) throw e;
    const mid = fromBlock + Math.floor(span / 2);
    return (await getLogs({ address, topics, fromBlock, toBlock: mid }, depth + 1)).concat(await getLogs({ address, topics, fromBlock: mid + 1, toBlock }, depth + 1));
  }
}
/** Windowed log scan over long ranges (10M blocks per call), newest-first when `backwards`. */
export async function scanLogs(filter, from, to, { backwards = false, stopWhen = null } = {}) {
  const out = [];
  if (backwards) { for (let hi = to; hi >= from; hi -= LOG_WINDOW) { const lo = Math.max(from, hi - LOG_WINDOW + 1); out.unshift(...(await getLogs({ ...filter, fromBlock: lo, toBlock: hi }))); if (stopWhen && stopWhen(out)) break; } }
  else { for (let lo = from; lo <= to; lo += LOG_WINDOW) { const hi = Math.min(to, lo + LOG_WINDOW - 1); out.push(...(await getLogs({ ...filter, fromBlock: lo, toBlock: hi }))); if (stopWhen && stopWhen(out)) break; } }
  return out;
}

// ---------- reads ----------
/** the factory's record of a Pons token, or null when the address was not launched on Pons */
export async function launched(token) {
  const r = await factory.getLaunchedToken(token);
  return r.exists ? { token: low(r.token), curve: low(r.curve), deployer: low(r.deployer), pairToken: low(r.pairToken), creatorTaxBps: Number(r.creatorTaxBps), phase: Number(r.phase) } : null;
}
/** The TokenLaunched log for one token: scans backwards from head and stops at the first hit. */
export async function findLaunch(token, head) {
  const l = await scanLogs({ address: ADDR.factory, topics: [TOPIC_LAUNCHED, ethers.zeroPadValue(token, 32)] }, FIRST_BLOCK, head, { backwards: true, stopWhen: (o) => o.length > 0 });
  return l.length ? { block: l[0].blockNumber, tx: l[0].transactionHash } : null;
}

let ethUsdCache = { at: 0, v: 0 };
/** ETH in dollars (Coinbase, then CoinGecko), cached two minutes. ETH_USD in the env pins it (local tests only). */
export async function ethUsd() {
  if (Number(process.env.ETH_USD) > 0) return Number(process.env.ETH_USD);
  if (Date.now() - ethUsdCache.at < 120_000 && ethUsdCache.v) return ethUsdCache.v;
  try { const j = await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(6000) })).json(); const v = Number(j.data.amount); if (v > 0) { ethUsdCache = { at: Date.now(), v }; return v; } } catch {}
  try { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(6000) })).json(); const v = Number(j.ethereum.usd); if (v > 0) { ethUsdCache = { at: Date.now(), v }; return v; } } catch {}
  return ethUsdCache.v || 0;
}
