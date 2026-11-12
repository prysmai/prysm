// PRYSM Committee engine: a Bull, a Bear and a Portfolio Manager debate the market as the league itself sees it (the
// Uniswap v3 TWAPs it scores with). A call goes out only if the PM's consensus clears the bar AND the deterministic risk
// guard passes. The minutes are sealed into the commit and published after the reveal.
// Transport-free: `call(tool, args)` returns the prysm-mcp tool's JSON, so the same engine runs behind the MCP server
// (agents/committee.mjs) and inside the prysm-agent CLI (`prysm run`). Claude mode with an API key, rules mode without.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const clip = (s, n) => String(s ?? "").slice(0, n);
const clamp = (x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0)));
const HORIZONS = ["15m", "1h", "4h"];

export function createCommittee({ call, agentId, min: MIN = 60, model: MODEL = "claude-opus-5-5", apiKey, journal, dry = false, log = console.log }) {
  // ---- what the committee sees ----
  async function brief() {
    const [m, rec, mine] = await Promise.all([call("prysm_market"), call("prysm_agent", { agentId }).catch(() => null), call("prysm_my_signals")]);
    return {
      at: m.at, horizons: HORIZONS,
      market: m.moves,                                  // bps vs USDG from the 5-min TWAP; null = not enough pool history
      record: rec ? { stats: rec.stats, recent: rec.signals.filter((s) => s.status !== "open").slice(0, 10).map(({ asset, dir, horizon, scoreBps }) => ({ asset, dir, horizon, scoreBps })) } : null,
      open: mine.filter((g) => !g.done && g.agentId === agentId).map(({ asset, dir, horizon, committedAt }) => ({ asset, direction: dir > 0 ? "long" : "short", horizon, committedAt })),
    };
  }

  const RULES = `League rules: a call is (asset, long|short, horizon 15m|1h|4h). It is scored by the log-return between the 5-minute Uniswap v3 TWAP right after the commit and right after the horizon, signed by direction, capped at +-1000 bps. Seasons rank by sqrt(n)*mean/sqrt(sd^2+25^2), so consistency beats single big wins; a bad call costs as much as a good one earns. Market data is in bps against USDG (m15, m1h, m4h = move over the last 15 min, 1 h, 4 h; null = not enough history). You have no news feed and no other data: argue only from what is given, and never invent facts.`;

  const Bull = z.object({ asset: z.string(), direction: z.enum(["long", "short"]), horizon: z.enum(["15m", "1h", "4h"]), conviction: z.number(), thesis: z.string(), evidence: z.array(z.string()) });
  const Bear = z.object({ risk: z.number(), objections: z.array(z.string()), counter: z.string(), recommendPass: z.boolean() });
  const Pm = z.object({ decision: z.enum(["commit", "pass"]), asset: z.string(), direction: z.enum(["long", "short"]), horizon: z.enum(["15m", "1h", "4h"]), consensus: z.number(), reason: z.string() });

  const SYS = {
    bull: `You are the Bull on a three-member investment committee for an AI agent competing in the PRYSM league. Propose the single best call you can defend from the data. Conviction 0-100 is how strongly the data supports it; if nothing is worth calling, still name your best idea and give it low conviction. Keep the thesis under 120 words and each evidence item to one line citing numbers from the brief.\n\n${RULES}`,
    bear: `You are the Bear on a three-member investment committee for an AI agent competing in the PRYSM league. Your job is to find what is wrong with the Bull's call: weak evidence, a move that already ran (chasing), noise mistaken for trend, a horizon that does not fit the move, clashes with the agent's open calls or recent losses. Risk 0-100 is how likely the call is to lose. Give the strongest counter-case (the opposite call, or passing) in under 100 words, objections one line each.\n\n${RULES}`,
    pm: `You are the Portfolio Manager and chair of a three-member investment committee for an AI agent competing in the PRYSM league. You read the brief, the Bull's proposal and the Bear's critique, and decide. Consensus 0-100 is how much the committee, weighing both sides honestly, supports the exact call you write down; a call is only sent if consensus is at least ${MIN}. You may keep the Bull's call, change its horizon, take the Bear's opposite call, or pass. Passing is a good outcome when the edge is unclear. The reason is under 80 words and names what decided it.\n\n${RULES}`,
  };

  // ---- Claude mode ----
  const claude = apiKey ? new Anthropic({ apiKey }) : null;
  async function ask(role, schema, content) {
    const msg = await claude.messages.stream({
      model: MODEL, max_tokens: 16000, thinking: { type: "adaptive" }, system: SYS[role],
      messages: [{ role: "user", content }], output_config: { format: zodOutputFormat(schema) },
    }).finalMessage();
    if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens" || !msg.parsed_output) throw new Error(`${role}: no usable answer (stop_reason ${msg.stop_reason})`);
    return msg.parsed_output;
  }
  async function debateClaude(b) {
    const B = JSON.stringify(b);
    const bull = await ask("bull", Bull, `Committee brief:\n${B}`);
    const bear = await ask("bear", Bear, `Committee brief:\n${B}\n\nThe Bull proposes:\n${JSON.stringify(bull)}`);
    const pm = await ask("pm", Pm, `Committee brief:\n${B}\n\nBull:\n${JSON.stringify(bull)}\n\nBear:\n${JSON.stringify(bear)}`);
    return { bull, bear, pm };
  }

  // ---- rules mode: the same three seats, as plain arithmetic (no key needed; also the baseline to beat) ----
  function debateRules(b) {
    const live = b.market.filter((m) => m.m1h !== null).sort((x, y) => Math.abs(y.m1h) - Math.abs(x.m1h));
    const top = live[0];
    if (!top) return { bull: { asset: b.market[0]?.sym || "ETH", direction: "long", horizon: "1h", conviction: 0, thesis: "No pool has an hour of TWAP history yet.", evidence: [] },
      bear: { risk: 100, objections: ["no data"], counter: "Pass.", recommendPass: true }, pm: { decision: "pass", asset: b.market[0]?.sym || "ETH", direction: "long", horizon: "1h", consensus: 0, reason: "No data to act on." } };
    const up = top.m1h > 0, agree = top.m15 !== null && Math.sign(top.m15) === Math.sign(top.m1h);
    const direction = agree ? (up ? "long" : "short") : (up ? "short" : "long");
    const sign = direction === "long" ? 1 : -1;
    const bull = { asset: top.sym, direction, horizon: "1h", conviction: clamp(20 + Math.abs(top.m1h) * 0.6),
      thesis: agree ? `${top.sym} moved ${top.m1h} bps in the last hour and the last 15 min confirm it: ride the momentum.` : `${top.sym} moved ${top.m1h} bps in the last hour but the last 15 min turned (${top.m15} bps): fade it.`,
      evidence: [`m1h ${top.m1h} bps`, `m15 ${top.m15} bps`, `m4h ${top.m4h ?? "n/a"} bps`] };
    const objections = []; let risk = 10;
    if (Math.abs(top.m1h) >= 150 && agree) { risk += 35; objections.push(`extended: ${top.m1h} bps in an hour is a lot to chase`); }
    if (top.m4h !== null && top.m4h * sign < 0) { risk += 15; objections.push(`against the 4h move (${top.m4h} bps)`); }
    if (Math.abs(top.m1h) < 20) { risk += 30; objections.push("the move is small enough to be noise"); }
    const recent = b.record?.recent?.slice(0, 3) || [];
    if (recent.length === 3 && recent.every((s) => s.scoreBps < 0)) { risk += 20; objections.push("three losses in a row"); }
    if (b.open.some((o) => o.asset === top.sym)) { risk += 25; objections.push(`already holding a call on ${top.sym}`); }
    const bear = { risk: clamp(risk), objections, counter: objections.length ? "Pass or take the other side." : "No strong objection.", recommendPass: risk >= 50 };
    const consensus = clamp(bull.conviction * (1 - bear.risk / 100) + 30);
    const pm = { decision: consensus >= MIN ? "commit" : "pass", asset: bull.asset, direction: bull.direction, horizon: bull.horizon, consensus,
      reason: consensus >= MIN ? `Bull's case outweighs ${objections.length} objection(s).` : `Not enough edge after the Bear's objections (${objections.join("; ") || "none"}).` };
    return { bull, bear, pm };
  }

  // ---- one cycle ----
  async function cycle() {
    const b = await brief();
    const mode = claude ? "claude" : "rules";
    const d = claude ? await debateClaude(b) : debateRules(b);
    const pm = { ...d.pm, consensus: clamp(d.pm.consensus) };
    const minutes = {
      v: 1, engine: "prysm-committee", mode, model: claude ? MODEL : null, at: b.at, minConsensus: MIN,
      market: b.market,
      bull: { asset: d.bull.asset, direction: d.bull.direction, horizon: d.bull.horizon, conviction: clamp(d.bull.conviction), thesis: clip(d.bull.thesis, 1500), evidence: d.bull.evidence.slice(0, 6).map((e) => clip(e, 300)) },
      bear: { risk: clamp(d.bear.risk), objections: d.bear.objections.slice(0, 6).map((e) => clip(e, 300)), counter: clip(d.bear.counter, 1000), recommendPass: !!d.bear.recommendPass },
      pm: { decision: pm.decision, asset: pm.asset, direction: pm.direction, horizon: pm.horizon, consensus: pm.consensus, reason: clip(pm.reason, 1000) },
    };
    let outcome;
    if (pm.decision !== "commit" || pm.consensus < MIN) outcome = { action: "pass", why: `consensus ${pm.consensus} < ${MIN}` };
    else {
      const g = await call("prysm_guard", { agentId, asset: pm.asset, direction: pm.direction, horizon: pm.horizon });
      minutes.guard = g.checks.map(({ name, pass }) => ({ name, pass }));
      if (!g.ok) outcome = { action: "blocked", why: g.checks.filter((x) => !x.pass).map((x) => `${x.name}: ${x.detail}`).join("; ") };
      else if (dry) outcome = { action: "dry-run", would: `${pm.direction} ${pm.asset} ${pm.horizon}` };
      else {
        const r = await call("prysm_commit_signal", { agentId, asset: pm.asset, direction: pm.direction, horizon: pm.horizon, rationale: JSON.stringify(minutes) });
        outcome = { action: "commit", signalId: r.signalId, notesHash: r.notesHash };
      }
    }
    fs.mkdirSync(path.dirname(journal), { recursive: true }); fs.appendFileSync(journal, JSON.stringify({ ...minutes, outcome }) + "\n");   // passes stay private
    log(`[${mode}] bull ${minutes.bull.direction} ${minutes.bull.asset} ${minutes.bull.horizon} (${minutes.bull.conviction}) · bear risk ${minutes.bear.risk} · pm ${pm.decision} ${pm.consensus} -> ${outcome.action}${outcome.signalId ? " #" + outcome.signalId : ""}${outcome.why ? " (" + outcome.why + ")" : ""}`);
    last = { minutes, outcome };
    return outcome;
  }

  let last = null;
  return { mode: claude ? "claude" : "rules", model: claude ? MODEL : null, cycle, brief, last: () => last };
}
