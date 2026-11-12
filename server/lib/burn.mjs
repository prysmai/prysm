// Buyback & burn, run by hand from /studio. Ported from XENON. The owner saves a SEPARATE burn wallet's key once; it is
// encrypted at rest with PRYSM_SECRET from server/.env and never leaves the server. The only things this code does
// with it: buy $PRYSM on its Pons curve with the dead address as recipient (every token bought is burned in the same
// transaction), and send $PRYSM the wallet already holds to the dead address (supply burn). Capped per run and per day.
import { ethers } from "ethers";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { provider, ADDR, ABI, ethUsd, deadline } from "./pons.mjs";

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function transfer(address to, uint256 amount) returns (bool)"];
const err = (code, message) => Object.assign(new Error(message), { code });
const READ_MS = 9000;   // the studio view never waits longer than this on one RPC read

export function createBurn({ dir, token }) {
  const KEY_FILE = path.join(dir, "burn-wallet.json"), LOG_FILE = path.join(dir, "burn-log.json");
  const maxUsd = () => Number(process.env.BURN_MAX_USD || 100), dayUsd = () => Number(process.env.BURN_DAY_USD || 300);
  const secret = () => { const k = process.env.PRYSM_SECRET || ""; if (k.length < 32) throw err(500, "PRYSM_SECRET (32+ characters) is missing in server/.env."); return createHash("sha256").update(k).digest(); };
  const seal = (txt) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", secret(), iv), d = Buffer.concat([c.update(txt, "utf8"), c.final()]); return [iv, c.getAuthTag(), d].map((b) => b.toString("base64")).join("."); };
  const unseal = (s) => { const [iv, tag, d] = s.split(".").map((x) => Buffer.from(x, "base64")), c = createDecipheriv("aes-256-gcm", secret(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString("utf8"); };
  async function save(file, v) { await mkdir(dir, { recursive: true }); await writeFile(file + ".tmp", JSON.stringify(v, null, 1), { mode: 0o600 }); await rename(file + ".tmp", file); }
  let saved = null, log = [], loaded = false, busy = false;
  async function load() { if (loaded) return; try { saved = JSON.parse(await readFile(KEY_FILE, "utf8")); } catch {} try { log = JSON.parse(await readFile(LOG_FILE, "utf8")) || []; } catch {} loaded = true; }
  // the next nonce: never below one this process already used (a lagging RPC endpoint can report a stale count)
  const used = new Map();
  async function nextNonce(addr) { const n = Math.max(await provider.getTransactionCount(addr, "pending"), (used.get(addr) ?? -1) + 1); used.set(addr, n); return n; }
  const wallet = () => { try { return new ethers.Wallet(unseal(saved.key), provider); } catch { throw err(500, "The saved burn key cannot be decrypted (PRYSM_SECRET changed?). Save the key again."); } };

  // entries: buybacks (no kind) and supply burns (kind "supply"); a pending entry is written before each wait
  const done = () => log.filter((x) => !x.status || x.status === "done");
  const spentToday = () => log.filter((x) => x.kind !== "supply" && x.status !== "failed" && Date.now() - x.at < 86_400_000).reduce((a, x) => a + x.usd, 0);
  /** dollars per whole token, from the curve's reserves */
  async function priceUsd(t) {
    const rec = await new ethers.Contract(ADDR.factory, ABI.factory, provider).getLaunchedToken(t);
    if (!rec.exists) throw err(400, "That address is not a Pons token.");
    const curve = new ethers.Contract(rec.curve, ABI.curve, provider);
    if (await curve.graduated()) throw err(400, "The token has graduated; its curve price is closed. Use Max to burn everything held.");
    const [qr, tr] = await curve.getReserves(), eu = await ethUsd();
    if (!eu) throw err(503, "Could not read the ETH price. Try again.");
    return (Number(ethers.formatEther(qr)) / Number(ethers.formatUnits(tr, 18))) * eu;
  }
  const sum = (xs, k) => xs.reduce((a, x) => a + Number(x[k] || 0), 0);
  const tryRead = async (fn) => { try { return await deadline(fn(), READ_MS); } catch { return undefined; } };

  return {
    async view() {
      await load();
      const t = token() || null;
      const v = { address: saved?.address || null, maxUsd: maxUsd(), dayUsd: dayUsd(), token: t, log: log.slice(-30).reverse(),
        secretOk: (process.env.PRYSM_SECRET || "").length >= 32, today: +spentToday().toFixed(2), supplyBurned: sum(done().filter((x) => x.kind === "supply"), "tokens") };
      const [eth, eu, px] = await Promise.all([
        v.address ? tryRead(async () => ethers.formatEther(await provider.getBalance(v.address))) : undefined,
        tryRead(ethUsd),
        t ? tryRead(() => priceUsd(t)) : undefined,
      ]);
      if (eth !== undefined) v.eth = eth; if (eu) v.ethUsd = eu; if (px) v.priceUsd = px;
      if (t) {
        const dead = await tryRead(async () => ethers.formatUnits(await new ethers.Contract(t, ERC20, provider).balanceOf(ADDR.dead), 18));
        if (dead !== undefined) v.burned = dead;
        if (v.address) {
          const bal = await tryRead(async () => ethers.formatUnits(await new ethers.Contract(t, ERC20, provider).balanceOf(v.address), 18));
          if (bal !== undefined) { v.tokenBal = bal; if (v.priceUsd) v.tokenBalUsd = +(Number(bal) * v.priceUsd).toFixed(2); }
        }
      }
      v.rpc = eth !== undefined || eu !== undefined || px !== undefined;
      return v;
    },
    async setKey(raw) {
      await load();
      const k = String(raw || "").trim();
      if (!k) { saved = null; await save(KEY_FILE, null); return; }
      let w; try { w = new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k); } catch { throw err(400, "That is not a valid private key."); }
      saved = { address: w.address, key: seal(w.privateKey), at: Date.now() }; await save(KEY_FILE, saved);
    },
    /** buys $PRYSM on its curve for `usd` dollars of ETH, with the dead address as recipient */
    async run(usdIn) {
      await load();
      const usd = Number(String(usdIn).replace(/^\$/, ""));
      if (!(usd > 0)) throw err(400, "Enter an amount in dollars.");
      if (usd > maxUsd()) throw err(400, `One burn is capped at $${maxUsd()} (BURN_MAX_USD).`);
      const today = spentToday();
      if (today + usd > dayUsd()) throw err(400, `Daily cap is $${dayUsd()}; $${today.toFixed(2)} already burned in the last 24 h.`);
      if (!saved) throw err(400, "Save the burn wallet key first.");
      const t = token(); if (!t) throw err(400, "Set the $PRYSM contract address first.");
      if (busy) throw err(409, "A burn is already running.");
      busy = true;
      try {
        const w = wallet();
        const rec = await new ethers.Contract(ADDR.factory, ABI.factory, provider).getLaunchedToken(t);
        if (!rec.exists) throw err(400, "That address is not a Pons token.");
        if (BigInt(rec.pairToken) !== 0n) throw err(400, "The token does not trade against ETH on its curve.");
        const curve = new ethers.Contract(rec.curve, ABI.curve, w);
        if (await curve.graduated()) throw err(400, "The token has graduated to the DEX; curve buybacks are closed.");
        if ((await curve.currentSnipeTaxBps(ADDR.dead)) > 0n) throw err(400, "Snipe tax is still on. Try again in a few minutes.");
        const price = await ethUsd(); if (!price) throw err(503, "Could not read the ETH price. Try again.");
        const wei = ethers.parseEther((usd / price).toFixed(18));
        const bal = await provider.getBalance(w.address);
        if (bal < wei + ethers.parseEther("0.0003")) throw err(400, `The burn wallet has ${ethers.formatEther(bal)} ETH; it needs ${ethers.formatEther(wei)} ETH plus gas.`);
        const erc = new ethers.Contract(t, ERC20, provider), before = await erc.balanceOf(ADDR.dead);
        const quote = await curve.buy.staticCall(wei, 0n, ADDR.dead, { value: wei });
        const tx = await curve.buy(wei, (quote * 97n) / 100n, ADDR.dead, { value: wei, nonce: await nextNonce(w.address) });
        // on disk before the wait, so a restart leaves the hash on record
        const entry = { at: Date.now(), usd, eth: ethers.formatEther(wei), ethUsd: price, tokens: ethers.formatUnits(quote, 18), tx: tx.hash, status: "pending" };
        log.push(entry); await save(LOG_FILE, log);
        const rc = await tx.wait();
        if (rc.status !== 1) { entry.status = "failed"; await save(LOG_FILE, log); throw err(502, "The buy reverted."); }
        const got = (await erc.balanceOf(ADDR.dead)) - before;
        entry.tokens = ethers.formatUnits(got > 0n ? got : quote, 18); entry.status = "done"; await save(LOG_FILE, log);
        return entry;
      } finally { busy = false; }
    },
    /** burns $PRYSM the burn wallet already holds (send it there first), sized in dollars at the curve price; "max" burns all of it */
    async supply(usdIn) {
      await load();
      if (!saved) throw err(400, "Save the burn wallet key first.");
      const t = token(); if (!t) throw err(400, "Set the $PRYSM contract address first.");
      if (busy) throw err(409, "A burn is already running.");
      busy = true;
      try {
        const w = wallet(), erc = new ethers.Contract(t, ERC20, w);
        const bal = await erc.balanceOf(w.address);
        if (bal === 0n) throw err(400, `The burn wallet holds no $PRYSM. Send the supply you want to burn to ${w.address} first.`);
        const max = String(usdIn).trim().toLowerCase() === "max";
        let amount, usd = null, px = null;
        try { px = await priceUsd(t); } catch (e) { if (!max) throw e; }
        if (max) { amount = bal; usd = px ? Number(ethers.formatUnits(bal, 18)) * px : null; }
        else {
          usd = Number(String(usdIn).replace(/^\$/, "").replace(",", "."));
          if (!(usd > 0)) throw err(400, "Enter an amount in dollars, or press Max.");
          amount = ethers.parseUnits((usd / px).toFixed(6), 18);
          if (amount > bal) throw err(400, `$${usd} is ${Math.round(usd / px).toLocaleString("en-US")} $PRYSM, but the burn wallet holds ${Math.round(Number(ethers.formatUnits(bal, 18))).toLocaleString("en-US")} (about $${(Number(ethers.formatUnits(bal, 18)) * px).toFixed(2)}).`);
        }
        const tx = await erc.transfer(ADDR.dead, amount, { nonce: await nextNonce(w.address) });
        const entry = { at: Date.now(), kind: "supply", usd: usd == null ? null : +usd.toFixed(2), eth: "0", tokens: ethers.formatUnits(amount, 18), tx: tx.hash, status: "pending" };
        log.push(entry); await save(LOG_FILE, log);
        const rc = await tx.wait();
        if (rc.status !== 1) { entry.status = "failed"; await save(LOG_FILE, log); throw err(502, "The burn reverted."); }
        entry.status = "done"; await save(LOG_FILE, log);
        return entry;
      } finally { busy = false; }
    },
  };
}
