// chain access: provider, contracts and small helpers shared by the server, the season builder and tests
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const here = path.dirname(new URL(import.meta.url).pathname);
export const ROOT = path.join(here, "..");
export const ABI = JSON.parse(fs.readFileSync(path.join(ROOT, "../shared/abi.json")));
export const ASSETS = JSON.parse(fs.readFileSync(path.join(ROOT, "../shared/assets.json"))).assets;

export function loadConfig() {
  const file = process.env.PRYSM_CONFIG || path.join(ROOT, "config.json");
  const cfg = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : path.join(ROOT, "config.example.json")));
  if (process.env.RPC) cfg.rpc = process.env.RPC;
  if (process.env.DEPLOYMENT) cfg.deployment = process.env.DEPLOYMENT;
  if (process.env.PORT) cfg.port = +process.env.PORT;
  if (process.env.SEASON_EPOCH) cfg.seasonEpoch = process.env.SEASON_EPOCH;
  if (process.env.KEEPER_INTERVAL) cfg.keeperIntervalSec = +process.env.KEEPER_INTERVAL;
  // no deployment file yet (the league contracts are not on mainnet): the server runs the studio and the burn record only
  const dep = path.resolve(ROOT, cfg.deployment);
  cfg.dep = fs.existsSync(dep) ? JSON.parse(fs.readFileSync(dep)) : null;
  return cfg;
}

export function connect(cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { staticNetwork: true, batchMaxCount: 20 });
  const d = cfg.dep;
  const c = (addr, abi, runner = provider) => new ethers.Contract(addr, abi, runner);
  return {
    provider,
    book: c(d.signalBook, ABI.SignalBook), league: c(d.league, ABI.League), subs: c(d.subscriptions, ABI.Subscriptions),
    identity: c(d.identity, ABI.Identity), c,
  };
}

// agent card (ERC-8004 registration file) behind tokenURI: data:, ipfs:// or https://
export async function fetchCard(uri) {
  try {
    if (!uri) return null;
    if (uri.startsWith("data:")) {
      const [meta, body] = uri.split(",", 2);
      return JSON.parse(meta.includes("base64") ? Buffer.from(body, "base64").toString() : decodeURIComponent(body));
    }
    const url = uri.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + uri.slice(7) : uri;
    if (!/^https:\/\//.test(url)) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
