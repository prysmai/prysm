import test from "node:test";
import assert from "node:assert/strict";
import { agentStats, leaderboard, payouts } from "../lib/score.mjs";
import { leaf, build } from "../lib/merkle.mjs";
import { ethers } from "ethers";

const sig = (agentId, scoreBps, status = "settled", settledAt = 1000) => ({ agentId, scoreBps, status, settledAt });

test("the same edge scores higher with more calls behind it", () => {
  const rec = (n) => agentStats(Array.from({ length: n }, (_, i) => sig(1, i % 3 ? 40 : -20)));
  assert.ok(rec(60).score > rec(15).score && rec(15).score > 0);
  assert.equal(rec(60).n, 60);
});

test("forfeits count as -1000 losses, voids are ignored", () => {
  const s = agentStats([sig(1, 100), sig(1, -1000, "forfeited"), sig(1, 0, "void")]);
  assert.equal(s.n, 2); assert.equal(s.forfeits, 1); assert.equal(s.sum, -900);
});

test("leaderboard needs minSignals and filters by season", () => {
  const agents = { 1: { id: 1, name: "a" }, 2: { id: 2, name: "b" } };
  const sigs = [...Array.from({ length: 6 }, () => sig(1, 50)), sig(2, 900), ...Array.from({ length: 6 }, () => sig(2, 10, "settled", 10 * 86400))];
  const all = leaderboard(agents, sigs, { minSignals: 5 });
  assert.deepEqual(all.ranked.map((r) => r.id).sort(), [1, 2]);
  const s0 = leaderboard(agents, sigs, { minSignals: 5, season: 0, epochMs: 0, days: 7 });
  assert.deepEqual(s0.ranked.map((r) => r.id), [1]);
  assert.deepEqual(s0.provisional.map((r) => r.id), [2]);
});

test("payouts sum exactly to the pool and skip non-positive scores", () => {
  const ranked = [{ id: 1, score: 3 }, { id: 2, score: 1 }, { id: 3, score: -1 }];
  const p = payouts(ranked, ethers.parseEther("1000"));
  assert.equal(p.length, 2);
  assert.equal(p.reduce((a, r) => a + BigInt(r.amount), 0n), ethers.parseEther("1000"));
  assert.equal(p[0].agentId, 1);
});

test("merkle proofs verify against the root", () => {
  const leaves = [1, 2, 3, 4, 5].map((i) => leaf(0, i, 10n * BigInt(i)));
  const t = build(leaves);
  const pair = (a, b) => ethers.keccak256(ethers.concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));
  leaves.forEach((l, i) => assert.equal(t.proof(i).reduce(pair, l), t.root));
});

test("an agent whose calls void too often is ranked but not paid", () => {
  const agents = { 1: { id: 1, name: "clean" }, 2: { id: 2, name: "voider" } };
  const sigs = [...Array.from({ length: 10 }, () => sig(1, 40)), ...Array.from({ length: 10 }, () => sig(2, 60)), sig(2, 0, "void"), sig(2, 0, "void")];
  const lb = leaderboard(agents, sigs, { minSignals: 5 });
  assert.equal(lb.ranked.find((r) => r.id === 2).voids, 2);
  assert.deepEqual(payouts(lb.ranked, "1000").map((p) => p.agentId), [1]);
});
