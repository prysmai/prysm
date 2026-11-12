// Burns, read from the chain: every transfer of a token to the dead address or the zero address since its launch,
// with the amount, the sender, the block and the time, plus the total burned and its share of the supply.
// Scanned once from the launch block, then only the new blocks. Each burn is matched against the studio's burn log,
// so a buyback shows what it cost and a manual burn (the dev supply, say) shows as a plain transfer. Ported from XENON.
import { ethers } from "ethers";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { provider, withRetry, scanLogs, findLaunch, ADDR, FIRST_BLOCK, low } from "./pons.mjs";

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const SINKS = [ADDR.dead, ethers.ZeroAddress];
const ERC20 = ["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)"];
const FRESH_MS = 10 * 60_000;

export function createBurns({ dir }) {
  const FILE = path.join(dir, "burns.json"), LOG_FILE = path.join(dir, "burn-log.json");
  let book; try { book = JSON.parse(readFileSync(FILE, "utf8")); } catch { book = {}; }   // token -> { from, lastBlock, items, meta, at }
  const save = () => { mkdirSync(dir, { recursive: true }); writeFileSync(FILE + ".tmp", JSON.stringify(book)); renameSync(FILE + ".tmp", FILE); };
  const running = new Map(), gens = new Map();

  // the studio's own burns, by tx hash: buybacks carry what they cost
  const studioLog = () => { try { return new Map((JSON.parse(readFileSync(LOG_FILE, "utf8")) || []).filter((x) => x.tx).map((x) => [low(x.tx), x])); } catch { return new Map(); } };

  async function refresh(key) {
    const b = (book[key] ||= { from: 0, lastBlock: 0, items: [], meta: null, at: 0 }), gen = gens.get(key) || 0;
    // eth_blockNumber raw: ethers caches getBlockNumber() briefly, which can miss a burn sent a moment ago
    const head = Number(await withRetry(() => provider.send("eth_blockNumber", [])));
    if (!b.from) { const l = await findLaunch(key, head).catch(() => null); b.from = l?.block || FIRST_BLOCK; b.lastBlock = b.from - 1; }
    const c = new ethers.Contract(key, ERC20, provider);
    const [dec, sym, supply, dead, zero] = await Promise.all([
      withRetry(() => c.decimals()), withRetry(() => c.symbol()), withRetry(() => c.totalSupply()),
      withRetry(() => c.balanceOf(ADDR.dead)), withRetry(() => c.balanceOf(ethers.ZeroAddress)).catch(() => 0n),
    ]);
    if (head > b.lastBlock) {
      for (const sink of SINKS) {
        const logs = await scanLogs({ address: key, topics: [TRANSFER, null, ethers.zeroPadValue(sink, 32)] }, b.lastBlock + 1, head);
        for (const l of logs) {
          if (b.items.some((x) => x.tx === l.transactionHash && x.log === l.index)) continue;
          const blk = await withRetry(() => provider.getBlock(l.blockNumber)).catch(() => null);
          b.items.push({ tx: l.transactionHash, log: l.index, block: l.blockNumber, at: blk ? blk.timestamp * 1000 : null, from: "0x" + l.topics[1].slice(26), to: low(sink), raw: BigInt(l.data).toString() });
        }
      }
      b.items.sort((x, y) => y.block - x.block || y.log - x.log); b.lastBlock = head;
    }
    const burnedRaw = BigInt(dead) + BigInt(zero), sup = BigInt(supply);
    b.meta = { symbol: sym, decimals: Number(dec), supply: Number(ethers.formatUnits(sup, dec)), supplyRaw: sup.toString(), burned: Number(ethers.formatUnits(burnedRaw, dec)), burnedPct: sup ? Number((burnedRaw * 10n ** 8n) / sup) / 1e6 : null };
    // a burn landed while this scan ran (invalidate was called): leave the cache stale so the next read scans again
    b.at = (gens.get(key) || 0) === gen ? Date.now() : 0; save(); return view(key);
  }

  function view(key) {
    const b = book[key]; if (!b?.meta) return null;
    const m = b.meta, sup = BigInt(m.supplyRaw || 0), log = studioLog();
    const amount = (raw) => Number(ethers.formatUnits(raw, m.decimals)), pct = (raw) => (sup ? Number((BigInt(raw) * 10n ** 8n) / sup) / 1e6 : null);
    const items = b.items.map(({ tx, block, at, from, to, raw }) => {
      const s = log.get(low(tx)), kind = s ? (s.kind === "supply" ? "supply" : "buyback") : "transfer";
      return { tx, block, at, from, to, amount: amount(raw), pct: pct(raw), kind, usd: s?.usd ?? null, eth: s && s.kind !== "supply" ? Number(s.eth) : null };
    });
    const bought = items.filter((x) => x.kind === "buyback");
    return { token: key, symbol: m.symbol, supply: m.supply, burned: m.burned, burnedPct: m.burnedPct, count: items.length,
      buybacks: bought.length, buybackUsd: +bought.reduce((a, x) => a + (Number(x.usd) || 0), 0).toFixed(2), buybackEth: +bought.reduce((a, x) => a + (x.eth || 0), 0).toFixed(6),
      scannedTo: b.lastBlock, at: b.at, items };
  }

  return {
    /** the burns of a token: cached, refreshed in the background when older than ten minutes */
    async get(token, { wait = false } = {}) {
      const key = low(token), b = book[key], fresh = b?.at && Date.now() - b.at < FRESH_MS;
      if (!fresh && !running.has(key)) {
        const p = refresh(key).finally(() => running.delete(key));
        p.catch(() => {});   // a background refresh that fails must not crash the server; the next read retries
        running.set(key, p);
      }
      if (b?.meta && !wait) return { ...view(key), refreshing: !fresh };
      return running.get(key) || view(key);
    },
    /** after a studio burn: the next read scans the new blocks at once */
    invalidate(token) { const key = low(token), b = book[key]; gens.set(key, (gens.get(key) || 0) + 1); if (b) b.at = 0; },
  };
}
