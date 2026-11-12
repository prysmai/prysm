// follows SignalBook events into a JSON state file: agents, signals and their outcomes
import fs from "node:fs";
import path from "node:path";
import { ASSETS, fetchCard } from "./chain.mjs";

const STATUS = ["open", "settled", "forfeited", "void"];
const STEP = 50_000;

export class Indexer {
  constructor(chain, cfg, dataDir) {
    this.chain = chain; this.cfg = cfg;
    this.file = path.join(dataDir, `state-${cfg.dep.chainId}-${cfg.dep.signalBook.toLowerCase()}.json`);
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file))
      : { lastBlock: cfg.dep.block - 1, agents: {}, signals: {} };
    this.blockTs = new Map();
  }
  save() { fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.state)); fs.renameSync(this.file + ".tmp", this.file); }

  async ts(blockNumber) {
    if (!this.blockTs.has(blockNumber)) this.blockTs.set(blockNumber, (await this.chain.provider.getBlock(blockNumber)).timestamp);
    return this.blockTs.get(blockNumber);
  }

  async agent(id) {
    const key = String(id);
    if (!this.state.agents[key]) {
      const a = { id: Number(id), owner: null, name: `Agent #${id}`, description: "", image: null, enrolledAt: null };
      try { a.owner = await this.chain.identity.ownerOf(id); } catch {}
      try {
        const card = await fetchCard(await this.chain.identity.tokenURI(id));
        if (card?.name) a.name = String(card.name).slice(0, 48);
        if (card?.description) a.description = String(card.description).slice(0, 280);
        if (typeof card?.image === "string" && /^https:\/\//.test(card.image)) a.image = card.image;
      } catch {}
      this.state.agents[key] = a;
    }
    return this.state.agents[key];
  }

  async sync() {
    const { book, provider } = this.chain;
    const head = await provider.getBlockNumber();
    let from = this.state.lastBlock + 1, changed = 0;
    while (from <= head) {
      const to = Math.min(head, from + STEP - 1);
      const logs = await provider.getLogs({ address: this.cfg.dep.signalBook, fromBlock: from, toBlock: to });
      for (const l of logs) {
        let e; try { e = book.interface.parseLog(l); } catch { continue; }
        if (!e) continue;
        changed++;
        const a = e.args;
        if (e.name === "FeedbackFailed") {
          // the reputation registry refused this score: shown on the agent so the gap in its ERC-8004 record is visible
          const ag = await this.agent(a.agentId); ag.feedbackFailed = (ag.feedbackFailed || 0) + 1;
        } else if (e.name === "Enrolled") {
          const ag = await this.agent(a.agentId); ag.enrolledAt = await this.ts(l.blockNumber);
        } else if (e.name === "Committed") {
          await this.agent(a.agentId);
          this.state.signals[a.signalId.toString()] = { id: Number(a.signalId), agentId: Number(a.agentId), commitHash: a.commitHash,
            committedAt: await this.ts(l.blockNumber), status: "open", commitTx: l.transactionHash };
        } else if (e.name === "Settled" || e.name === "Forfeited" || e.name === "Voided") {
          const s = this.state.signals[a.signalId.toString()]; if (!s) continue;
          s.status = e.name === "Settled" ? "settled" : e.name === "Forfeited" ? "forfeited" : "void";
          s.settledAt = await this.ts(l.blockNumber); s.settleTx = l.transactionHash;
          if (e.name === "Settled") {
            s.assetId = Number(a.assetId); s.asset = ASSETS[s.assetId]?.sym || String(s.assetId);
            s.dir = Number(a.dir); s.horizon = Number(a.horizon); s.scoreBps = Number(a.scoreBps);
            s.entryTick = Number(a.entryTick); s.exitTick = Number(a.exitTick);
          } else if (e.name === "Forfeited") s.scoreBps = -1000;
        }
      }
      this.state.lastBlock = to; from = to + 1;
    }
    if (changed) for (const a of Object.values(this.state.agents)) a.owner ??= await this.chain.identity.ownerOf(a.id).catch(() => null);
    this.save();
    return { head, changed };
  }

  signals() { return Object.values(this.state.signals); }
  static STATUS = STATUS;
}
