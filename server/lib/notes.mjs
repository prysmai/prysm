// sealed reasoning ("notes") for calls: an agent may bind any text to a commit through the salt,
//   salt = keccak(abi.encode(nonce, keccak(utf8(rationale))))
// so the notes can only be accepted if they hash to the on-chain commit, and are only shown once the call is closed
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const MAX = 16000;
export const notesHash = (rationale) => ethers.keccak256(ethers.toUtf8Bytes(rationale));
export const saltFor = (nonce, rationale) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [nonce, notesHash(rationale)]));

export class Notes {
  constructor(chain, cfg, dataDir) {
    this.chain = chain;
    this.file = path.join(dataDir, `notes-${cfg.dep.chainId}-${cfg.dep.signalBook.toLowerCase()}.json`);
    this.notes = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) : {};
  }
  save() { fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.notes)); fs.renameSync(this.file + ".tmp", this.file); }

  async submit(b) {
    const id = BigInt(b.signalId), assetId = Number(b.assetId), dir = Number(b.dir), horizon = Number(b.horizon), nonce = String(b.nonce), rationale = String(b.rationale ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("nonce must be 32 bytes hex");
    if (!rationale || rationale.length > MAX) throw new Error(`rationale must be 1..${MAX} characters`);
    const g = await this.chain.book.signals(id);
    if (g.commitHash === ethers.ZeroHash) throw new Error("unknown signal");
    const salt = saltFor(nonce, rationale);
    if ((await this.chain.book.hashSignal(g.agentId, assetId, dir, horizon, salt)) !== g.commitHash) throw new Error("notes do not match the commit");
    this.notes[id.toString()] = { signalId: Number(id), agentId: Number(g.agentId), nonce, rationale, notesHash: notesHash(rationale), salt, commitHash: g.commitHash };
    this.save();
    return this.notes[id.toString()];
  }

  has(id) { return !!this.notes[String(id)]; }
  raw(id) { return this.notes[String(id)] || null; }

  // short line for lists: the committee's verdict if it is one, else the start of the text
  static summary(rationale) {
    try {
      const j = JSON.parse(rationale);
      if (j?.engine === "prysm-committee" && j.pm) return { engine: j.engine, mode: j.mode, consensus: j.pm.consensus, verdict: String(j.pm.reason || "").slice(0, 240) };
    } catch {}
    return { verdict: rationale.slice(0, 240) };
  }
}
