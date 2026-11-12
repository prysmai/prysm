const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const salt = (s) => ethers.id(s);

async function deploy() {
  const [owner, alice, bob, carol, treasury] = await ethers.getSigners();
  const tok = await (await ethers.getContractFactory("MockToken")).deploy();
  const idr = await (await ethers.getContractFactory("MockIdentity")).deploy();
  const rep = await (await ethers.getContractFactory("MockReputation")).deploy();
  const pool = await (await ethers.getContractFactory("MockPool")).deploy();
  const book = await (await ethers.getContractFactory("SignalBook")).deploy(idr, rep, tok, treasury, E(100));
  await book.setAsset(0, pool, false, true, "NVDA");
  await idr.connect(alice)["register()"]();                  // agent 1, owned by alice
  await idr.connect(bob)["register()"]();                    // agent 2, owned by bob
  for (const s of [alice, bob]) { await tok.transfer(s, E(10000)); await tok.connect(s).approve(book, E(10000)); }
  return { owner, alice, bob, carol, treasury, tok, idr, rep, pool, book };
}

async function commitAs(book, signer, agentId, assetId, dir, horizon, tag) {
  const h = await book.hashSignal(agentId, assetId, dir, horizon, salt(tag));
  const tx = await book.connect(signer).commit(agentId, h);
  const ev = (await tx.wait()).logs.map((l) => book.interface.parseLog(l)).find((e) => e && e.name === "Committed");
  return ev.args.signalId;
}

describe("SignalBook", () => {
  it("enrolls an agent for the fee, only from its operator", async () => {
    const { book, alice, bob, tok, treasury } = await deploy();
    await expect(book.connect(bob).enroll(1)).to.be.revertedWithCustomError(book, "NotAgent");
    await book.connect(alice).enroll(1);
    expect(await book.enrolled(1)).to.equal(true);
    expect(await tok.balanceOf(treasury)).to.equal(E(100));
    await book.connect(alice).enroll(1);                     // second call is a no-op, not a second fee
    expect(await tok.balanceOf(treasury)).to.equal(E(100));
  });

  it("lets the agent wallet commit as well as the owner", async () => {
    const { book, idr, alice, carol } = await deploy();
    await book.connect(alice).enroll(1);
    await expect(book.connect(carol).commit(1, ethers.ZeroHash)).to.be.revertedWithCustomError(book, "NotAgent");
    await idr.connect(alice).setWallet(1, carol);
    await expect(book.connect(carol).commit(1, ethers.ZeroHash)).to.emit(book, "Committed");
  });

  it("scores a long call by the TWAP log-return and writes ERC-8004 feedback", async () => {
    const { book, pool, rep, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(1000, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 3600, "a");
    await pool.setPath(1000, 0);                            // flat through the entry window...
    await time.increase(600);
    await pool.setPath(1000, 0);
    await time.increase(3000);
    await pool.setPath(1150, 0);                            // ...then 150 ticks higher through the exit window
    await expect(book.connect(alice).reveal(id, 0, 1, 3600, salt("a"))).to.be.revertedWithCustomError(book, "TooEarly");
    await time.increase(300);
    await expect(book.reveal(id, 0, 1, 3600, salt("a"))).to.emit(book, "Settled");   // anyone may reveal with the plaintext
    const g = await book.signals(id);
    expect(g.status).to.equal(1);
    expect(g.scoreBps).to.be.within(140, 150);
    const s = await book.stats(1);
    expect(s.settled).to.equal(1); expect(s.wins).to.equal(1); expect(s.open).to.equal(0);
    expect(await rep.count()).to.equal(1);
    const f = await rep.feedback(0);
    expect(f.agentId).to.equal(1); expect(f.dec).to.equal(2); expect(f.tag1).to.equal("prysm/alpha"); expect(f.tag2).to.equal("NVDA");
  });

  it("flips the sign for a short call and for an inverted pool, and caps the score", async () => {
    const { book, pool, alice } = await deploy();
    await book.setAsset(1, pool, true, true, "INV");
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const s1 = await commitAs(book, alice, 1, 0, -1, 900, "s1");
    const s2 = await commitAs(book, alice, 1, 1, 1, 900, "s2");
    await pool.setPath(0, 10);                              // +10 ticks/s: about +3000 ticks by the exit window
    await time.increase(1300);
    await book.reveal(s1, 0, -1, 900, salt("s1"));
    await book.reveal(s2, 1, 1, 900, salt("s2"));
    expect((await book.signals(s1)).scoreBps).to.equal(-1000);  // short into a rally, capped
    expect((await book.signals(s2)).scoreBps).to.equal(-1000);  // long on the inverted quote, capped
  });

  it("rejects a reveal that does not match the commit", async () => {
    const { book, pool, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 900, "x");
    await time.increase(1300);
    await expect(book.reveal(id, 0, -1, 900, salt("x"))).to.be.revertedWithCustomError(book, "BadReveal");
    await expect(book.reveal(id, 0, 1, 3600, salt("x"))).to.be.revertedWithCustomError(book, "BadReveal");
  });

  it("forfeits an unrevealed call at the cap once every window has closed", async () => {
    const { book, pool, alice, bob } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 900, "f");
    await time.increase(4 * 3600 + 300 + 3600 - 5);
    await expect(book.connect(bob).forfeit(id)).to.be.revertedWithCustomError(book, "TooEarly");
    await time.increase(10);
    await expect(book.connect(bob).forfeit(id)).to.emit(book, "Forfeited");
    const s = await book.stats(1);
    expect(s.forfeits).to.equal(1); expect(s.sumBps).to.equal(-1000); expect(s.open).to.equal(0);
    await expect(book.reveal(id, 0, 1, 900, salt("f"))).to.be.revertedWithCustomError(book, "BadStatus");
  });

  it("refuses a reveal after its window", async () => {
    const { book, pool, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 900, "late");
    await time.increase(900 + 300 + 3600 + 5);
    await expect(book.reveal(id, 0, 1, 900, salt("late"))).to.be.revertedWithCustomError(book, "TooLate");
  });

  it("voids the call (no score) when the oracle history has rotated out", async () => {
    const { book, pool, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 3600, "v");
    await time.increase(3900);
    await pool.setMaxAge(600);
    await expect(book.reveal(id, 0, 1, 3600, salt("v"))).to.emit(book, "Voided");
    const s = await book.stats(1);
    expect(s.settled).to.equal(0); expect(s.open).to.equal(0); expect(s.voids).to.equal(1);
  });

  it("scores a late reveal that finds the oracle window gone as a forfeit, not a void", async () => {
    const { book, pool, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 3600, "lv");
    await time.increase(3900 + 601);                     // past the 10-minute grace
    await pool.setMaxAge(600);
    await expect(book.reveal(id, 0, 1, 3600, salt("lv"))).to.emit(book, "Forfeited");
    const s = await book.stats(1);
    expect(s.forfeits).to.equal(1); expect(s.voids).to.equal(0); expect(s.sumBps).to.equal(-1000);
  });

  it("voids open calls when the owner changes their asset or horizon, instead of stranding or re-scoring them", async () => {
    const { book, pool, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const a = await commitAs(book, alice, 1, 0, 1, 900, "ca");
    const h = await commitAs(book, alice, 1, 0, 1, 3600, "ch");
    await book.setAsset(0, pool, true, false, "NVDA");    // flipped and switched off after the commits
    await book.setHorizon(3600, false);
    await time.increase(3900);
    await expect(book.reveal(a, 0, 1, 900, salt("ca"))).to.emit(book, "Voided");
    await expect(book.reveal(h, 0, 1, 3600, salt("ch"))).to.emit(book, "Voided");
    const n = await commitAs(book, alice, 1, 0, 1, 900, "after");   // committed after the change: the agent's own mistake
    await time.increase(1200);
    await expect(book.reveal(n, 0, 1, 900, salt("after"))).to.be.revertedWithCustomError(book, "BadAsset");
  });

  it("refuses pools with a short oracle and horizons over a day", async () => {
    const { book, pool } = await deploy();
    await pool.setCardinality(100);
    await expect(book.setAsset(1, pool, false, true, "THIN")).to.be.revertedWithCustomError(book, "ThinOracle");
    await book.setAsset(1, pool, false, false, "THIN");   // listing it inactive is fine
    await expect(book.setHorizon(2 * 86400, true)).to.be.revertedWithCustomError(book, "BadHorizon");
  });

  it("voids, not forfeits, a call left open when the identity changed hands", async () => {
    const { book, pool, idr, alice, bob } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 900, "sold");
    await idr.connect(alice).transfer(1, bob);
    await time.increase(4 * 3600 + 300 + 3600 + 10);
    await expect(book.forfeit(id)).to.emit(book, "Voided");
    expect((await book.stats(1)).forfeits).to.equal(0);
  });

  it("makes a refused reputation write public", async () => {
    const { book, pool, rep, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 1, 900, "rf");
    await rep.setFail(true);
    await time.increase(1200);
    await expect(book.reveal(id, 0, 1, 900, salt("rf"))).to.emit(book, "FeedbackFailed").and.to.emit(book, "Settled");
  });

  it("caps open commits per agent", async () => {
    const { book, alice } = await deploy();
    await book.connect(alice).enroll(1);
    for (let i = 0; i < 24; i++) await book.connect(alice).commit(1, ethers.id("c" + i));
    await expect(book.connect(alice).commit(1, ethers.ZeroHash)).to.be.revertedWithCustomError(book, "TooManyOpen");
  });

  it("only accepts enabled horizons and +-1 directions", async () => {
    const { book, pool, alice } = await deploy();
    await book.connect(alice).enroll(1);
    await pool.setPath(0, 0);
    const id = await commitAs(book, alice, 1, 0, 2, 900, "d");
    await time.increase(1300);
    await expect(book.reveal(id, 0, 2, 900, salt("d"))).to.be.revertedWithCustomError(book, "BadHorizon");
  });
});

// sorted-pair Merkle tree, matching OpenZeppelin's MerkleProof
function tree(leaves) {
  const h = (a, b) => ethers.keccak256(ethers.concat(a < b ? [a, b] : [b, a]));
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const l = layers.at(-1), n = [];
    for (let i = 0; i < l.length; i += 2) n.push(i + 1 < l.length ? h(l[i], l[i + 1]) : l[i]);
    layers.push(n);
  }
  const proof = (i) => { const p = []; for (const l of layers.slice(0, -1)) { const j = i ^ 1; if (j < l.length) p.push(l[j]); i >>= 1; } return p; };
  return { root: layers.at(-1)[0], proof };
}

describe("League", () => {
  it("pays each agent's owner once against the season root", async () => {
    const { owner, alice, bob, tok, idr } = await deploy();
    const lg = await (await ethers.getContractFactory("League")).deploy(idr, tok);
    const rows = [[1n, E(700)], [2n, E(300)]];
    const leaves = await Promise.all(rows.map(([a, m]) => lg.leaf(0, a, m)));
    const t = tree(leaves);
    await tok.approve(lg, E(1000));
    await lg.openSeason(t.root, E(1000), "ipfs://season-0");
    const b0 = await tok.balanceOf(alice);
    await lg.connect(bob).claim(0, 1, E(700), t.proof(0));         // bob submits, alice (owner of agent 1) is paid
    expect((await tok.balanceOf(alice)) - b0).to.equal(E(700));
    await expect(lg.claim(0, 1, E(700), t.proof(0))).to.be.revertedWithCustomError(lg, "AlreadyClaimed");
    await expect(lg.claim(0, 2, E(999), t.proof(1))).to.be.revertedWithCustomError(lg, "BadProof");
    await lg.claim(0, 2, E(300), t.proof(1));
    await expect(lg.sweep(0)).to.be.revertedWithCustomError(lg, "TooSoon");
    expect(owner.address).to.be.a("string");
  });

  it("refuses claims after a sweep, so they cannot spend later seasons' funds", async () => {
    const { alice, tok, idr } = await deploy();
    const lg = await (await ethers.getContractFactory("League")).deploy(idr, tok);
    const mk = async (season, rows) => tree(await Promise.all(rows.map(([a, m]) => lg.leaf(season, a, m))));
    const t0 = await mk(0, [[1n, E(700)], [2n, E(300)]]), t1 = await mk(1, [[1n, E(500)], [2n, E(500)]]);
    await tok.approve(lg, E(2000));
    await lg.openSeason(t0.root, E(1000), "s0");
    await time.increase(91 * 86400);
    await lg.openSeason(t1.root, E(1000), "s1");
    await lg.sweep(0);                                              // nobody claimed season 0
    await expect(lg.claim(0, 1, E(700), t0.proof(0))).to.be.revertedWithCustomError(lg, "OverClaim");
    await lg.claim(1, 1, E(500), t1.proof(0)); await lg.claim(1, 2, E(500), t1.proof(1));   // season 1 still pays in full
    expect(await tok.balanceOf(lg)).to.equal(0n);
    expect(alice.address).to.be.a("string");
  });
});

describe("Subscriptions", () => {
  it("splits the payment and extends access", async () => {
    const { alice, bob, carol, treasury, tok, idr } = await deploy();
    const sub = await (await ethers.getContractFactory("Subscriptions")).deploy(idr, tok, treasury, 1000);
    await expect(sub.connect(bob).setPrice(1, E(50))).to.be.revertedWithCustomError(sub, "NotOwner");
    await sub.connect(alice).setPrice(1, E(50));
    await tok.transfer(carol, E(1000)); await tok.connect(carol).approve(sub, E(1000));
    const a0 = await tok.balanceOf(alice), t0 = await tok.balanceOf(treasury);
    await expect(sub.connect(carol).subscribe(1, 2, E(99))).to.be.revertedWithCustomError(sub, "PriceChanged");   // price over the cap
    await sub.connect(carol).subscribe(1, 2, E(100));
    expect((await tok.balanceOf(alice)) - a0).to.equal(E(90));
    expect((await tok.balanceOf(treasury)) - t0).to.equal(E(10));
    expect(await sub.isActive(1, carol)).to.equal(true);
    const u1 = await sub.activeUntil(1, carol);
    await sub.connect(carol).subscribe(1, 1, E(50));
    expect((await sub.activeUntil(1, carol)) - u1).to.equal(30n * 86400n);
    await expect(sub.connect(carol).subscribe(2, 1, E(50))).to.be.revertedWithCustomError(sub, "NotOffered");
    await time.increase(91 * 86400);
    expect(await sub.isActive(1, carol)).to.equal(false);
  });
});
