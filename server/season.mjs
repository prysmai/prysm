// node season.mjs build <season> <pool tokens>   -> data/seasons/<season>.json (ranking, payouts, Merkle root + proofs)
// node season.mjs open <season>                  -> League.openSeason(root, total, uri) from OWNER_KEY (approves the token first)
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { loadConfig, connect, ROOT, ABI } from "./lib/chain.mjs";
import { Indexer } from "./lib/indexer.mjs";
import { leaderboard, payouts, seasonOf } from "./lib/score.mjs";
import { leaf, build } from "./lib/merkle.mjs";

const [cmd, sArg, poolArg] = process.argv.slice(2), season = +sArg;
const cfg = loadConfig(), chain = connect(cfg), DATA = path.join(ROOT, "data"), f = path.join(DATA, "seasons", `${season}.json`);
fs.mkdirSync(path.dirname(f), { recursive: true });
const epochMs = Date.parse(cfg.seasonEpoch), days = cfg.seasonDays;

if (cmd === "build") {
  if (seasonOf(Date.now() / 1000, epochMs, days) <= season && !process.env.FORCE) throw new Error(`season ${season} has not ended yet (FORCE=1 to build anyway)`);
  const idx = new Indexer(chain, cfg, DATA); await idx.sync();
  const lb = leaderboard(idx.state.agents, idx.signals(), { minSignals: cfg.minSignals, season, epochMs, days });
  const pay = payouts(lb.ranked, ethers.parseEther(String(poolArg || 0)));
  const t = build(pay.map((p) => leaf(season, p.agentId, p.amount)));
  const total = pay.reduce((a, p) => a + BigInt(p.amount), 0n).toString();
  const out = { season, chainId: cfg.dep.chainId, league: cfg.dep.league, from: new Date(epochMs + season * days * 86400000).toISOString(),
    to: new Date(epochMs + (season + 1) * days * 86400000).toISOString(), builtAt: new Date().toISOString(), root: t.root, total,
    method: "score = sqrt(n)*mean/sqrt(sd^2+25^2) over calls settled in the season; top 20 positive scores split the pool pro rata",
    ranking: lb.ranked.map(({ id, name, n, mean, sd, hit, score, rank }) => ({ rank, agentId: id, name, n, mean, sd, hit, score })),
    payouts: pay.map((p, i) => ({ ...p, proof: t.proof(i) })) };
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`season ${season}: ${out.ranking.length} ranked, ${pay.length} paid, total ${ethers.formatEther(total)}, root ${t.root}`);
} else if (cmd === "open") {
  const s = JSON.parse(fs.readFileSync(f));
  if (!process.env.OWNER_KEY) throw new Error("set OWNER_KEY (the League owner) to send openSeason");
  const w = new ethers.Wallet(process.env.OWNER_KEY, chain.provider);
  const tok = new ethers.Contract(cfg.dep.token, ABI.ERC20, w), league = chain.league.connect(w);
  if ((await league.seasonCount()) !== BigInt(season)) throw new Error(`League expects season ${await league.seasonCount()} next`);
  if ((await tok.allowance(w.address, cfg.dep.league)) < BigInt(s.total)) await (await tok.approve(cfg.dep.league, s.total)).wait();
  const tx = await league.openSeason(s.root, s.total, `${cfg.publicUrl}/api/season/${season}`);
  console.log("openSeason", tx.hash); await tx.wait(); console.log("done");
} else console.log("usage: node season.mjs build <season> <pool tokens> | open <season>");
