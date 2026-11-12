// sealed-signal relay: agents hand over the plaintext of a commit; subscribers read it before the reveal; the keeper
// reveals on the agent's behalf when it is due, so an offline agent is never forfeited for a call the relay holds
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { ASSETS } from "./chain.mjs";

const TWAP = 300, WINDOW = 3600, KEEPER_GRACE = +(process.env.KEEPER_GRACE ?? 150);

export class Relay {
  constructor(chain, cfg, dataDir) {
    this.chain = chain; this.cfg = cfg;
    this.file = path.join(dataDir, `sealed-${cfg.dep.chainId}-${cfg.dep.signalBook.toLowerCase()}.json`);
    this.sealed = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) : {};
  }
  save() { fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.sealed)); fs.renameSync(this.file + ".tmp", this.file); }

  // accepted only if it hashes to the on-chain commit of an open signal
  async submit(b) {
    const id = BigInt(b.signalId), assetId = Number(b.assetId), dir = Number(b.dir), horizon = Number(b.horizon), salt = String(b.salt);
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("salt must be 32 bytes hex");
    if (![1, -1].includes(dir) || !ASSETS[assetId]) throw new Error("bad asset or direction");
    const g = await this.chain.book.signals(id);
    if (Number(g.status) !== 0) throw new Error("signal is not open");
    const h = await this.chain.book.hashSignal(g.agentId, assetId, dir, horizon, salt);
    if (h !== g.commitHash) throw new Error("plaintext does not match the commit");
    this.sealed[id.toString()] = { signalId: Number(id), agentId: Number(g.agentId), assetId, asset: ASSETS[assetId].sym, dir, horizon, salt,
      committedAt: Number(g.committedAt), receivedAt: Math.floor(Date.now() / 1000) };
    this.save();
    return this.sealed[id.toString()];
  }

  // live feed for an agent: open sealed calls without the salt (a subscriber can trade on it but cannot reveal early).
  // A call shows up only once its 5-minute entry TWAP window has closed, so subscribers' own trades cannot move the
  // entry price against the agent.
  async live(agentId) {
    const now = (await this.chain.provider.getBlock("latest")).timestamp;
    return Object.values(this.sealed).filter((s) => s.agentId === Number(agentId) && now >= s.committedAt + TWAP)
      .map(({ salt, ...s }) => ({ ...s, expiry: s.committedAt + s.horizon, revealableAt: s.committedAt + s.horizon + TWAP }));
  }

  async canRead(agentId, addr, ts, sig) {
    const now = Math.floor(Date.now() / 1000);
    if (!addr || !sig || Math.abs(now - Number(ts)) > 300) return false;
    let who; try { who = ethers.verifyMessage(`PRYSM live ${agentId} ${ts}`, sig); } catch { return false; }
    if (who.toLowerCase() !== String(addr).toLowerCase()) return false;
    const owner = await this.chain.identity.ownerOf(agentId).catch(() => null);
    if (owner && owner.toLowerCase() === who.toLowerCase()) return true;
    return await this.chain.subs.isActive(agentId, who).catch(() => false);
  }

  // keeper: reveal every held signal inside its window; drop the ones that settled or can no longer be revealed
  async keep(wallet, log = console.log) {
    const now = (await this.chain.provider.getBlock("latest")).timestamp;
    const book = this.chain.book.connect(wallet);
    let changed = false;
    for (const s of Object.values(this.sealed)) {
      const g = await this.chain.book.signals(s.signalId);
      if (Number(g.status) !== 0) { delete this.sealed[s.signalId]; changed = true; continue; }
      const due = s.committedAt + s.horizon + TWAP;
      if (now > due + WINDOW) { delete this.sealed[s.signalId]; changed = true; continue; }
      // give the agent's own MCP a head start (it reveals within a minute while running); the keeper is the fallback
      if (now >= due + KEEPER_GRACE && wallet) {
        try {
          const tx = await book.reveal(s.signalId, s.assetId, s.dir, s.horizon, s.salt);
          await tx.wait(); log(`keeper revealed #${s.signalId} (${tx.hash})`);
          delete this.sealed[s.signalId]; changed = true;
        } catch (e) { log(`keeper reveal #${s.signalId} failed: ${e.shortMessage || e.message}`); }
      }
    }
    if (changed) this.save();
  }
}
