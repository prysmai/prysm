// league maths, kept free of I/O so it can be tested and re-run by anyone from the published events
export const SHRINK_BPS = 25;      // prior volatility added to every agent's spread (stops a 2-for-2 lucky streak topping the board)

export const MAX_VOID_RATE = 0.1;  // an agent whose calls void this often is not paid (voids are no score either way)

// alpha score: sqrt(n) * mean / sqrt(sd^2 + 25^2), over settled and forfeited calls (voided ones don't count)
export function agentStats(signals) {
  const xs = signals.filter((s) => s.status === "settled" || s.status === "forfeited").map((s) => s.scoreBps);
  const n = xs.length, voids = signals.filter((s) => s.status === "void").length;
  if (!n) return { n: 0, wins: 0, forfeits: 0, voids, sum: 0, mean: 0, sd: 0, hit: 0, score: 0 };
  const sum = xs.reduce((a, b) => a + b, 0), mean = sum / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const wins = xs.filter((x) => x > 0).length, forfeits = signals.filter((s) => s.status === "forfeited").length;
  const score = (Math.sqrt(n) * mean) / Math.sqrt(sd * sd + SHRINK_BPS * SHRINK_BPS);
  return { n, wins, forfeits, voids, sum, mean: +mean.toFixed(2), sd: +sd.toFixed(2), hit: +(wins / n).toFixed(3), score: +score.toFixed(3) };
}

export function seasonOf(ts, epochMs, days) { return Math.floor((ts * 1000 - epochMs) / (days * 86400000)); }

export function leaderboard(agents, signals, { minSignals = 5, season = null, epochMs = 0, days = 7 } = {}) {
  const by = new Map();
  for (const s of signals) {
    if (season !== null && (s.settledAt == null || seasonOf(s.settledAt, epochMs, days) !== season)) continue;
    if (!by.has(s.agentId)) by.set(s.agentId, []);
    by.get(s.agentId).push(s);
  }
  const rows = Object.values(agents).map((a) => ({ ...a, ...agentStats(by.get(a.id) || []) }));
  const ranked = rows.filter((r) => r.n >= minSignals).sort((a, b) => b.score - a.score || b.n - a.n);
  const provisional = rows.filter((r) => r.n < minSignals).sort((a, b) => b.n - a.n);
  ranked.forEach((r, i) => (r.rank = i + 1));
  return { ranked, provisional };
}

// season payout: the pool splits over the top `top` positive scores in proportion to score (integers in wei, remainder to #1)
export function payouts(ranked, pool, top = 20) {
  // a high void rate is how an agent would hide losses (or have them hidden): it forfeits the payout, not the rank
  const elig = ranked.filter((r) => r.score > 0 && (r.voids || 0) <= MAX_VOID_RATE * ((r.n || 0) + (r.voids || 0))).slice(0, top);
  const tot = elig.reduce((a, r) => a + r.score, 0);
  if (!elig.length || tot <= 0) return [];
  const P = BigInt(pool), scale = 1_000_000n;
  const out = elig.map((r) => ({ agentId: r.id, score: r.score, amount: (P * BigInt(Math.round((r.score / tot) * 1e6))) / scale }));
  const used = out.reduce((a, r) => a + r.amount, 0n);
  out[0].amount += P - used;
  return out.map((r) => ({ ...r, amount: r.amount.toString() }));
}
